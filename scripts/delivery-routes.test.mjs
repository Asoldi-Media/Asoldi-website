// Delivery admin routes, batch 0: automation settings (WS8.10), delivery snapshots (WS8.44) and the
// test-client flag (WS8.56). Runs the real data modules on a temp data dir behind a fake adminAuth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-delivery-routes-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.WORKSHOP_DESK_EMAIL_AUTOSEND;

const express = (await import('express')).default;
const { registerDeliveryRoutes } = await import('../lib/routes/delivery-routes.js');
const store = await import('../data/automation-settings.js');
const snapshots = await import('../lib/delivery-snapshots.js');
const sales = await import('../data/sales.js');
const hub = await import('../data/hub.js');
const salesOffers = await import('../data/sales-offers.js');

const baseClients = [
  { id: 'c1', product: 'asoldi', businessName: 'Alpha AS', status: 'active' },
  { id: 'c2', product: 'asoldi', businessName: 'Beta AS', status: 'active' },
];
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify(baseClients, null, 2));
writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify([{ id: 's1', site_key: 'k1', name: 'Site one' }], null, 2));

let restoredNotes = 0;
const app = express();
app.use(express.json());
const adminAuth = (req, res, next) => {
  if (req.get('authorization') !== 'Bearer admin') return res.status(401).json({ message: 'Unauthorized' });
  req.admin = { username: 'superadmin' };
  next();
};
registerDeliveryRoutes(app, {
  adminAuth,
  sales: { ...sales, noteSalesStoreReplaced: () => { restoredNotes += 1; return sales.noteSalesStoreReplaced(); } },
  hub,
  salesOffers,
});
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function call(method, path, body, auth = 'Bearer admin') {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('every route is superadmin only', async () => {
  for (const [method, path] of [
    ['GET', '/api/admin/automation-settings'],
    ['PUT', '/api/admin/automation-settings'],
    ['GET', '/api/admin/system/delivery-snapshots'],
    ['POST', '/api/admin/system/delivery-snapshots'],
    ['POST', '/api/admin/system/delivery-snapshots/x-1/restore'],
    ['PATCH', '/api/admin/sales/c1/test-flag'],
    ['PATCH', '/api/hub/sites/s1/test-flag'],
  ]) {
    assert.equal((await call(method, path, method === 'GET' ? undefined : {}, '')).status, 401, `${method} ${path}`);
    assert.equal((await call(method, path, method === 'GET' ? undefined : {}, 'Bearer staff')).status, 401, `${method} ${path}`);
  }
});

test('automation settings: an invalid mailbox gives 400; a valid partial PUT is applied and audited', async () => {
  const got = await (await call('GET', '/api/admin/automation-settings')).json();
  assert.equal(got.settings.version, 2);
  assert.deepEqual(got.mailboxAllowlist, store.INBOX_MAILBOX_ALLOWLIST);
  assert.equal(got.effective.development.autoQueue, false);

  const invalid = await call('PUT', '/api/admin/automation-settings', { inbox: { mailboxes: ['intruder@example.com'] } });
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).errors.some((error) => error.path === 'inbox.mailboxes'));

  const gated = await call('PUT', '/api/admin/automation-settings', { emails: { siteLive: { mode: 'auto' } } });
  assert.equal(gated.status, 400, 'no auto before the pre-release suite passed');

  const ok = await call('PUT', '/api/admin/automation-settings', { settings: { development: { previewJobs: true } }, reason: 'try preview jobs' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body.changes, [{ path: 'development.previewJobs', from: false, to: true }]);
  assert.equal(body.audit.at(-1).by, 'superadmin');
  assert.equal(body.audit.at(-1).reason, 'try preview jobs');
  assert.equal(store.getAutomationSettings({ fresh: true }).development.previewJobs, true);
});

test('automation settings: a mailbox added through PUT can be removed through PUT', async () => {
  const both = ['alexander@asoldi.com', 'damian@asoldi.com'];
  const added = await call('PUT', '/api/admin/automation-settings', {
    inbox: { mailboxes: both, autoActions: { 'alexander@asoldi.com': true, 'damian@asoldi.com': true }, autoReply: { 'damian@asoldi.com': false } },
  });
  assert.equal(added.status, 200, JSON.stringify(await added.clone().json()));
  assert.deepEqual(
    (await added.json()).settings.inbox.autoReply,
    { 'alexander@asoldi.com': true, 'damian@asoldi.com': false },
    'a partial map keeps the mailbox it does not name',
  );

  const partial = await call('PUT', '/api/admin/automation-settings', { inbox: { autoReply: { 'damian@asoldi.com': true } } });
  assert.equal(partial.status, 200, JSON.stringify(await partial.clone().json()));
  assert.deepEqual((await partial.json()).settings.inbox.autoReply, { 'alexander@asoldi.com': true, 'damian@asoldi.com': true });

  const removed = await call('PUT', '/api/admin/automation-settings', { inbox: { mailboxes: ['alexander@asoldi.com'] } });
  assert.equal(removed.status, 200, JSON.stringify(await removed.clone().json()));
  const inbox = (await removed.json()).settings.inbox;
  assert.deepEqual(inbox.mailboxes, ['alexander@asoldi.com']);
  assert.deepEqual(inbox.autoActions, { 'alexander@asoldi.com': true });
  assert.deepEqual(inbox.autoReply, { 'alexander@asoldi.com': true });
  const restored = await call('PUT', '/api/admin/automation-settings', { inbox: { autoReply: { 'alexander@asoldi.com': false } } });
  assert.equal(restored.status, 200);
  assert.deepEqual((await restored.json()).settings.inbox.autoReply, { 'alexander@asoldi.com': false });
});

test('snapshots: list, create, restore as a dry run unless dryRun is false', async () => {
  const created = await call('POST', '/api/admin/system/delivery-snapshots', { label: 'route' });
  assert.equal(created.status, 201);
  const snap = await created.json();
  assert.equal(snap.dir, undefined, 'the disk path is not returned');
  const listed = await (await call('GET', '/api/admin/system/delivery-snapshots')).json();
  assert.equal(listed.codeSchemaVersion, snapshots.DELIVERY_SCHEMA_VERSION);
  assert.ok(listed.snapshots.some((entry) => entry.id === snap.id));

  writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([{ id: 'c9', businessName: 'Later' }]));
  const dry = await (await call('POST', `/api/admin/system/delivery-snapshots/${snap.id}/restore`, {})).json();
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.diff.files.find((file) => file.name === 'sales-clients.json').removed, ['c9']);
  assert.deepEqual(JSON.parse(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8')), [{ id: 'c9', businessName: 'Later' }]);
  assert.equal(restoredNotes, 0);

  const real = await (await call('POST', `/api/admin/system/delivery-snapshots/${snap.id}/restore`, { dryRun: false })).json();
  assert.equal(real.dryRun, false);
  assert.ok(real.restored.includes('sales-clients.json'));
  assert.deepEqual(sales.getSalesClients().map((client) => client.id).sort(), ['c1', 'c2']);
  assert.equal(restoredNotes, 1, 'the sales list cache key moves on');
  assert.ok(real.preRestoreSnapshotId.startsWith('pre-restore-'));

  assert.equal((await call('POST', '/api/admin/system/delivery-snapshots/..%2Fx/restore', {})).status, 400);
  assert.equal((await call('POST', '/api/admin/system/delivery-snapshots/missing-1/restore', {})).status, 404);
});

test('test-client flag: set and cleared from Superadmin on sales clients and hub sites', async () => {
  assert.equal((await call('PATCH', '/api/admin/sales/c1/test-flag', { isTest: 'yes' })).status, 400);
  assert.equal((await call('PATCH', '/api/admin/sales/nope/test-flag', { isTest: true })).status, 404);
  const on = await call('PATCH', '/api/admin/sales/c1/test-flag', { isTest: true });
  assert.deepEqual(await on.json(), { id: 'c1', isTest: true });
  assert.equal(sales.getSalesClientById('c1').isTest, true);
  assert.equal(sales.getSalesClientById('c2').isTest, undefined, 'other clients keep their shape');
  // Ordinary writes keep the flag.
  sales.updateSalesClient('c1', { notes: 'still a test client' });
  assert.equal(sales.getSalesClientById('c1').isTest, true);
  const off = await call('PATCH', '/api/admin/sales/c1/test-flag', { isTest: false });
  assert.deepEqual(await off.json(), { id: 'c1', isTest: false });
  assert.equal(Object.prototype.hasOwnProperty.call(sales.getSalesClientById('c1'), 'isTest'), false);

  const siteOn = await call('PATCH', '/api/hub/sites/s1/test-flag', { isTest: true });
  assert.deepEqual(await siteOn.json(), { id: 's1', isTest: true });
  assert.equal(hub.getSiteById('s1').isTest, true);
  hub.updateSite('s1', { name: 'Renamed' });
  assert.equal(hub.getSiteById('s1').isTest, true);
  // The public site-config never carries the flag.
  assert.equal(Object.prototype.hasOwnProperty.call(hub.getSiteConfig('k1'), 'isTest'), false);
  await call('PATCH', '/api/hub/sites/s1/test-flag', { isTest: false });
  assert.equal(Object.prototype.hasOwnProperty.call(hub.getSiteById('s1'), 'isTest'), false);
  assert.equal((await call('PATCH', '/api/hub/sites/nope/test-flag', { isTest: true })).status, 404);
});
