// Personal-data registry: export covers every store, an erase dry run lists the files and deletes
// nothing, legal holds keep the signed contract, the erase route answers 403 while privacy.purge is
// off, and the retention purge deletes nothing unless privacy.purge is on in auto mode.
// Synthetic clients only (example.com addresses), on a temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-personal-data-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;

function put(rel, value) {
  const path = join(DATA_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return path;
}

function emailHash(email) {
  return `sha256:${createHash('sha256').update(email).digest('hex')}`;
}

const LEAD = {
  id: 'pd-lead',
  product: 'asoldi',
  businessName: 'Testbakeriet AS',
  contactPerson: 'Kari Testesen',
  contactEmail: 'kari@example.com',
  portalUserId: 'u-lead',
  portalBusinessId: 'b-lead',
  status: 'active',
  progression: { meetingHeld: true },
  meetings: [{ meetingId: 'ff-lead-1', title: 'Salgsmøte', startedAt: iso(NOW - 5 * DAY), linkedBy: 'meet-link', purpose: 'sales' }],
  ext: { mediaRights: { 'u-lead/logo.png': { confirmed: true, at: iso(NOW) } } },
};
const SIGNED = {
  id: 'pd-signed',
  product: 'asoldi',
  businessName: 'Testfrisøren AS',
  contactEmail: 'ola@example.com',
  status: 'active',
  progression: { meetingHeld: true, offerSent: true, contractSigned: true },
  contractSignedAt: iso(NOW - 20 * DAY),
};
const OTHER = { id: 'pd-other', product: 'asoldi', businessName: 'Annen Kunde AS', contactEmail: 'other@example.com', status: 'active' };

put('sales-clients.json', [LEAD, SIGNED, OTHER]);
put('sales-offers.json', [
  { id: 'offer-lead', salesClientId: 'pd-lead', status: 'draft', tierId: 'tier-1-standard', email: { subject: 'Tilbud', html: '<p>x</p>' }, products: [] },
  { id: 'offer-signed', salesClientId: 'pd-signed', status: 'sent', sentAt: iso(NOW - 25 * DAY), tierId: 'tier-1-standard', email: { subject: 'Tilbud', html: '<p>x</p>' }, products: [] },
  { id: 'offer-other', salesClientId: 'pd-other', status: 'draft', tierId: 'tier-1-standard', email: { subject: 'Tilbud', html: '<p>x</p>' }, products: [] },
]);
put('client-offers.json', [
  { id: 'portal-signed', code: 'QK74', salesClientId: 'pd-signed', acceptance: { acceptedAt: iso(NOW - 21 * DAY), email: 'ola@example.com', ip: '192.0.2.10' } },
  { id: 'portal-lead', code: 'QK75', salesClientId: 'pd-lead' },
]);
put('inbox-bot.json', {
  processed: {},
  sources: {},
  baselines: {},
  items: [
    { id: 'inbox-lead-1', kind: 'client_elements', mailbox: 'inbox@example.com', salesClientId: 'pd-lead', from: 'kari@example.com', subject: 'Bilder', summary: 'Bilder fra kunden', text: 'Hei, her er bildene', status: 'staged' },
    { id: 'inbox-signed-1', kind: 'signed_contract', mailbox: 'inbox@example.com', salesClientId: 'pd-signed', from: 'ola@example.com', subject: 'Signert', summary: 'Signert kontrakt', fileName: 'kontrakt.pdf', status: 'accepted' },
  ],
});
put('inbox-contracts/pd-signed/kontrakt.pdf', '%PDF-1.4 test');
put('inbox-bot-staging/pd-lead/123-bilde.jpg', 'jpeg-bytes');
put('fireflies-meetings.json', {
  'ff-lead-1': { meetingId: 'ff-lead-1', title: 'Salgsmøte', startedAt: iso(NOW - 5 * DAY), transcript: 'Kari: Hei\nSelger: Hei', at: iso(NOW), match: { clientId: 'pd-lead', linkedBy: 'meet-link' } },
  'ff-other': { meetingId: 'ff-other', title: 'Annet', transcript: 'X: y', at: iso(NOW), match: { clientId: 'pd-other' } },
});
put('fireflies-media/ff-lead-1/transcript.txt', 'Kari: Hei');
put('transcript-archive/pd-lead/' + 'a'.repeat(64) + '.json', { meetingId: 'ff-lead-1', sha256: 'a'.repeat(64), transcript: 'Kari: Hei', archivedAt: iso(NOW), retainUntil: iso(NOW + 300 * DAY) });
put('delivery-briefs/pd-lead/v1.json', { facts: { identity: { brandName: 'Testbakeriet' } } });
put('media-manifest/pd-lead.json', { kind: 'asoldi.media-manifest/1', clientId: 'pd-lead', items: [] });
put('client-uploads/u-lead/logo.png', 'png-bytes');
put('client-portal-profiles.json', [{ userId: 'u-lead', ownerUserId: 'u-lead', businessId: 'b-lead', businessName: 'Testbakeriet AS', email: 'kari@example.com' }]);
put('workshop-needs.json', { clients: { 'pd-lead': { needs: ['Nettbutikk'] }, 'pd-other': { needs: [] } } });
put('admin-dev-requests.json', { threads: { 'pd-lead': { salesClientId: 'pd-lead', messages: [{ text: 'Bytt logo' }] } } });
put('admin-dev-request-files/pd-lead/f-1-skisse.png', 'png');
put('seo-ops/clients/pd-lead.json', { salesClientId: 'pd-lead', agreedKeywords: ['bakeri oslo'] });
put('delivery-audit/2026-10.jsonl', `${JSON.stringify({ at: iso(NOW), kind: 'stage', clientId: 'pd-lead', to: 'lead' })}\n`);
put('maker-access-log/2026-10.jsonl', `${JSON.stringify({ at: iso(NOW), hostId: 'mh_1', clientId: 'pd-lead', kind: 'brief', allowed: true })}\n`);
put('fireflies-link-audit/2026-10.jsonl', `${JSON.stringify({ at: iso(NOW), action: 'link', meetingId: 'ff-lead-1', clientId: 'pd-lead', by: 'meet-link' })}\n`);
put('migrations/delivery-backfill-1-dry-run.json', { stages: [{ clientId: 'pd-lead', stage: 'lead' }] });
put('email-log/messages-202610.jsonl', `${JSON.stringify({ id: 'em_1', kind: 'offer', toHash: emailHash('kari@example.com'), toMasked: 'k***@example.com', status: 'accepted', createdAt: iso(NOW) })}\n`);
const snapshotClients = JSON.stringify([LEAD, SIGNED, OTHER], null, 2);
put('snapshots/batch-2-test/sales-clients.json', snapshotClients);
put('snapshots/batch-2-test/manifest.json', { kind: 'delivery-snapshot', id: 'batch-2-test', files: [{ name: 'sales-clients.json', bytes: snapshotClients.length, sha256: 'old', records: 3 }] });
put('backups/sales-clients.json.latest.json', snapshotClients);

const personalData = await import('../lib/personal-data.js');
const settingsStore = await import('../data/automation-settings.js');
const retention = await import('../lib/delivery-retention.js');
const sales = await import('../data/sales.js');
await import('../lib/transcript-archive.js');

const FILLED = [
  'sales-clients', 'sales-offers', 'portal-offers', 'inbox-items', 'inbox-attachments',
  'fireflies-meetings', 'transcript-archive', 'delivery-briefs', 'media-manifest', 'client-uploads', 'client-portal',
  'workshop-needs', 'dev-requests', 'dev-request-files', 'seo-client', 'media-rights', 'delivery-audit',
  'maker-access-log', 'fireflies-link-audit', 'migrations', 'email-log',
];

test('the registry has the built-in stores, each with a retention text', async () => {
  const stores = await personalData.loadStoreModules();
  const ids = stores.map((store) => store.id);
  for (const id of [...FILLED, 'signed-contracts', 'snapshots', 'data-backups', 'hub-sites']) assert.ok(ids.includes(id), id);
  for (const store of stores) assert.ok(personalData.retentionText(store.id).length > 20, `${store.id} retention text`);
  assert.match(personalData.retentionText('transcript-archive'), /12 måneder/);
  assert.match(personalData.retentionText('transcript-archive', { lang: 'en', settings: { retention: { leadMonths: 6, afterContractMonths: 18 } } }), /6 months.*18 months/s);
  assert.throws(() => personalData.registerStore({ id: 'Bad Id', export() {}, erase() {} }), /bad id/);
});

test('the export covers every store and finds the client in each store that holds it', async () => {
  const bundle = await personalData.exportClient('pd-lead');
  const stores = await personalData.loadStoreModules();
  assert.equal(bundle.kind, 'asoldi.personal-data-export');
  assert.equal(bundle.found, true);
  assert.deepEqual(bundle.stores.map((row) => row.id).sort(), stores.map((store) => store.id).sort());
  const byId = Object.fromEntries(bundle.stores.map((row) => [row.id, row]));
  for (const id of FILLED) {
    assert.ok(byId[id].records.length + byId[id].files.length > 0, `${id} has the client's data`);
    assert.equal(byId[id].error, undefined, `${id} exported without error`);
  }
  assert.equal(byId['sales-clients'].records[0].contactEmail, 'kari@example.com');
  assert.ok(byId['fireflies-meetings'].records.every((row) => row.meetingId === 'ff-lead-1'), 'only the client\'s recordings');
  assert.equal(byId['workshop-needs'].records.length, 1);
  const text = JSON.stringify(bundle);
  assert.doesNotMatch(text, /other@example\.com|Annen Kunde/, 'no other client in the bundle');
});

test('an erase dry run lists the files and deletes nothing', async () => {
  const before = readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8');
  const plan = await personalData.eraseClient('pd-lead');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.erased, false);
  const byId = Object.fromEntries(plan.stores.map((row) => [row.id, row]));
  assert.equal(byId['sales-clients'].action, 'delete');
  assert.ok(byId['transcript-archive'].files.some((file) => file.startsWith('transcript-archive/pd-lead/')));
  assert.ok(byId['client-uploads'].files.includes('client-uploads/u-lead/logo.png'));
  assert.equal(byId['inbox-items'].action, 'redact');
  assert.equal(byId['delivery-audit'].action, 'retain');
  assert.ok(byId.snapshots.files.includes('snapshots/batch-2-test/sales-clients.json'));
  assert.ok(byId['data-backups'].files.includes('backups/sales-clients.json.latest.json'));
  assert.equal(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8'), before, 'nothing written');
  for (const rel of ['transcript-archive/pd-lead', 'client-uploads/u-lead/logo.png', 'inbox-bot-staging/pd-lead', 'seo-ops/clients/pd-lead.json']) {
    assert.ok(existsSync(join(DATA_DIR, rel)), `${rel} still there`);
  }
  assert.equal(existsSync(join(DATA_DIR, 'delivery-audit', `${new Date().toISOString().slice(0, 7)}.jsonl`)) && readFileSync(join(DATA_DIR, 'delivery-audit', `${new Date().toISOString().slice(0, 7)}.jsonl`), 'utf8').includes('privacy-erase'), false, 'no erase audit for a dry run');
});

test('a running contract blocks the erase unless it is confirmed; legal holds keep the contract', async () => {
  const blocked = await personalData.eraseClient('pd-signed', { dryRun: false });
  assert.equal(blocked.blocked, 'active-contract');
  assert.equal(blocked.erased, false);
  assert.ok(sales.getSalesClientById('pd-signed'), 'nothing erased while blocked');

  const result = await personalData.eraseClient('pd-signed', { dryRun: false, allowActiveContract: true, by: 'superadmin' });
  assert.equal(result.erased, true);
  const byId = Object.fromEntries(result.stores.map((row) => [row.id, row]));
  assert.equal(byId['signed-contracts'].action, 'hold');
  assert.equal(byId['signed-contracts'].reason, 'bookkeeping-law');
  assert.ok(existsSync(join(DATA_DIR, 'inbox-contracts/pd-signed/kontrakt.pdf')), 'the signed contract file stays');
  assert.equal(byId['sales-offers'].action, 'hold', 'the sent offer of a signed client is the contract');
  assert.deepEqual(byId['sales-offers'].held, ['offer-signed']);
  assert.equal(byId['portal-offers'].action, 'hold', 'accepted portal offer is acceptance evidence');
  const offers = JSON.parse(readFileSync(join(DATA_DIR, 'sales-offers.json'), 'utf8'));
  assert.ok(offers.some((offer) => offer.id === 'offer-signed'));
  const inbox = JSON.parse(readFileSync(join(DATA_DIR, 'inbox-bot.json'), 'utf8'));
  assert.equal(inbox.items.find((item) => item.id === 'inbox-signed-1').from, 'ola@example.com', 'the contract inbox item stays');
  assert.equal(sales.getSalesClientById('pd-signed'), null, 'the client card is erased');
  assert.ok(result.held.includes('signed-contracts'));
});

test('an erase removes the client from every deletable store, the copies and the backups, and audits ids only', async () => {
  const result = await personalData.eraseClient('pd-lead', { dryRun: false, by: 'superadmin' });
  assert.equal(result.erased, true);
  assert.equal(sales.getSalesClientById('pd-lead'), null);
  assert.ok(sales.getSalesClientById('pd-other'), 'other clients stay');
  for (const rel of ['transcript-archive/pd-lead', 'delivery-briefs/pd-lead', 'media-manifest/pd-lead.json', 'inbox-bot-staging/pd-lead', 'client-uploads/u-lead', 'admin-dev-request-files/pd-lead', 'seo-ops/clients/pd-lead.json', 'fireflies-media/ff-lead-1']) {
    assert.equal(existsSync(join(DATA_DIR, rel)), false, `${rel} removed`);
  }
  const meetings = JSON.parse(readFileSync(join(DATA_DIR, 'fireflies-meetings.json'), 'utf8'));
  assert.equal(meetings['ff-lead-1'], undefined);
  assert.ok(meetings['ff-other'], 'other recordings stay');
  const needs = JSON.parse(readFileSync(join(DATA_DIR, 'workshop-needs.json'), 'utf8'));
  assert.deepEqual(Object.keys(needs.clients), ['pd-other']);
  const offers = JSON.parse(readFileSync(join(DATA_DIR, 'sales-offers.json'), 'utf8'));
  assert.equal(offers.some((offer) => offer.salesClientId === 'pd-lead'), false);
  const inbox = JSON.parse(readFileSync(join(DATA_DIR, 'inbox-bot.json'), 'utf8'));
  const redacted = inbox.items.find((item) => item.id === 'inbox-lead-1');
  assert.equal(redacted.from, '');
  assert.equal(redacted.text, '');
  assert.equal(redacted.salesClientId, '');

  const snapshot = JSON.parse(readFileSync(join(DATA_DIR, 'snapshots/batch-2-test/sales-clients.json'), 'utf8'));
  assert.deepEqual(snapshot.map((row) => row.id), ['pd-other'], 'both erased clients are out of the snapshot');
  const manifest = JSON.parse(readFileSync(join(DATA_DIR, 'snapshots/batch-2-test/manifest.json'), 'utf8'));
  const raw = readFileSync(join(DATA_DIR, 'snapshots/batch-2-test/sales-clients.json'));
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(raw).digest('hex'), 'the snapshot manifest follows the scrubbed copy');
  assert.equal(manifest.files[0].records, 1);
  for (const name of readdirSync(join(DATA_DIR, 'backups')).filter((entry) => entry.startsWith('sales-clients.json.'))) {
    assert.doesNotMatch(readFileSync(join(DATA_DIR, 'backups', name), 'utf8'), /kari@example\.com/, `${name} scrubbed`);
  }
  const month = new Date().toISOString().slice(0, 7);
  const audit = readFileSync(join(DATA_DIR, 'delivery-audit', `${month}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const erase = audit.filter((row) => row.kind === 'privacy-erase');
  assert.equal(erase.length, 2);
  assert.doesNotMatch(JSON.stringify(erase), /example\.com|Testbakeriet|Kari/, 'the erase audit holds ids only');
});

test('clientRetention follows retention.* for leads, deferred leads, not-sold and signed clients', () => {
  const settings = { retention: { leadMonths: 12, afterContractMonths: 12 } };
  const at = '2026-01-10T10:00:00.000Z';
  const lead = personalData.clientRetention({ status: 'active', updatedAt: at, createdAt: at }, { settings });
  assert.equal(lead.basis, 'lead');
  assert.ok(Math.abs(Date.parse(lead.until) - (Date.parse(at) + 365.25 * DAY)) < 2 * DAY);
  assert.equal(personalData.clientRetention({ status: 'secondary', updatedAt: at }, { settings }).basis, 'deferred');
  assert.equal(personalData.clientRetention({ status: 'not-sold', updatedAt: at, archive: { archivedAt: at } }, { settings }).basis, 'not-sold');
  assert.deepEqual(personalData.clientRetention({ progression: { contractSigned: true }, updatedAt: at }, { settings }), { basis: 'contract-active', until: '' });
  const ended = personalData.clientRetention({ progression: { contractSigned: true }, updatedAt: at, delivery: { overlay: 'cancelled', cancelledAt: at } }, { settings });
  assert.equal(ended.basis, 'contract-ended');
  assert.ok(Date.parse(ended.until) > Date.parse(at) + 360 * DAY);
});

test('the retention purge deletes nothing while privacy.purge is off, only reports in shadow, deletes in auto', async () => {
  const expired = put('transcript-archive/pd-other/' + 'b'.repeat(64) + '.json', { meetingId: 'ff-other', sha256: 'b'.repeat(64), transcript: 'X: y', archivedAt: iso(NOW - 900 * DAY), retainUntil: iso(NOW - 10 * DAY) });
  // pd-other is a lead whose last activity is far in the past: its archive is expired.
  const clients = JSON.parse(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8'));
  for (const client of clients) if (client.id === 'pd-other') Object.assign(client, { createdAt: iso(NOW - 900 * DAY), updatedAt: iso(NOW - 900 * DAY) });
  writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify(clients, null, 2));

  settingsStore.invalidateAutomationSettingsCache();
  const off = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }) });
  assert.deepEqual(off, { ran: false, reason: 'disabled' });
  assert.ok(existsSync(expired), 'negative control: nothing deleted while off');
  assert.equal(existsSync(join(DATA_DIR, 'privacy')), false, 'no report while off');

  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: true } } }).ok, true);
  const shadow = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }) });
  assert.equal(shadow.ran, true);
  assert.equal(shadow.dryRun, true);
  assert.equal(shadow.counts['transcript-archive'], 1);
  assert.ok(existsSync(expired), 'shadow deletes nothing even when data is expired');
  const report = JSON.parse(readFileSync(join(DATA_DIR, 'privacy', 'purge-reports', shadow.report), 'utf8'));
  const row = report.stores.find((store) => store.id === 'transcript-archive');
  assert.equal(row.wouldPurge[0].clientId, 'pd-other');
  assert.doesNotMatch(JSON.stringify(report), /X: y|example\.com/, 'the report holds ids only');

  const again = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }) });
  assert.equal(again.reason, 'not-due', 'once a day');

  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { mode: 'auto' } } }).ok, true);
  const auto = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }), force: true });
  assert.equal(auto.dryRun, false);
  assert.equal(existsSync(expired), false, 'auto deletes the expired file');

  const step = retention.tickSteps.find((entry) => entry.name === 'retention-purge');
  assert.equal(step.scope, 'global');
  assert.equal(step.everyMs, 86_400_000);
  assert.deepEqual(await step.run({ mode: 'off' }), { wrote: false });
});

test('routes: export is superadmin only; erase answers 403 while privacy.purge is off and is a dry run by default', async () => {
  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: false, mode: 'shadow' } } }).ok, true);
  const express = (await import('express')).default;
  const { register } = await import('../lib/routes/privacy-routes.js');
  const app = express();
  app.use(express.json());
  const adminAuth = (req, res, next) => (req.get('authorization') === 'Bearer admin' ? (req.admin = { username: 'superadmin' }, next()) : res.status(401).json({ message: 'Unauthorized' }));
  const salesAuth = (req, res, next) => (req.get('authorization') === 'Bearer staff' ? (req.salesUser = { isAdmin: false }, next()) : res.status(401).json({}));
  await register(app, { adminAuth, salesAuth, clientAuth: (_req, res) => res.status(401).json({}), sales, getDataDir: () => DATA_DIR });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, auth, body) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await call('GET', '/api/admin/sales/pd-other/personal-data-export')).status, 401);
    assert.equal((await call('GET', '/api/admin/sales/pd-other/personal-data-export', 'Bearer staff')).status, 401);
    const exported = await call('GET', '/api/admin/sales/pd-other/personal-data-export', 'Bearer admin');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /personal-data-pd-other\.json/);
    assert.equal((await exported.json()).clientId, 'pd-other');
    assert.equal((await call('GET', '/api/admin/sales/nobody/personal-data-export', 'Bearer admin')).status, 404);

    const refused = await call('POST', '/api/admin/sales/pd-other/erase', 'Bearer admin', { dryRun: false });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, 'purge-disabled');
    assert.ok(sales.getSalesClientById('pd-other'), 'nothing erased while the switch is off');

    assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: true } } }).ok, true);
    const dry = await call('POST', '/api/admin/sales/pd-other/erase', 'Bearer admin', {});
    assert.equal(dry.status, 200);
    assert.equal((await dry.json()).dryRun, true);
    assert.ok(sales.getSalesClientById('pd-other'), 'a dry run by default');
    assert.equal((await call('POST', '/api/admin/sales/pd-other/erase', undefined, {})).status, 401);
    const stores = await call('GET', '/api/admin/system/personal-data-stores', 'Bearer admin');
    assert.ok((await stores.json()).stores.length >= 20);
  } finally {
    server.close();
  }
});

test('an erase and a purge run one at a time across processes (a held lease means busy)', async () => {
  const { acquireLease } = await import('../data/email-store.js');
  const held = await acquireLease('privacy-erase', 60_000);
  try {
    const busy = await personalData.eraseClient('pd-other', { dryRun: false });
    assert.equal(busy.blocked, 'busy');
    assert.equal(busy.erased, false);
    assert.ok(sales.getSalesClientById('pd-other'), 'nothing erased while another erase runs');
    const plan = await personalData.eraseClient('pd-other');
    assert.equal(plan.dryRun, true, 'a plan needs no lease');
    assert.ok(plan.stores.length > 10);
  } finally {
    await held.release();
  }
  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: true } } }).ok, true);
  const purgeLease = await acquireLease('retention-purge', 60_000);
  try {
    const busy = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }), force: true });
    assert.deepEqual(busy, { ran: false, reason: 'busy' });
  } finally {
    await purgeLease.release();
  }
  assert.equal(settingsStore.saveAutomationSettings({ privacy: { purge: { enabled: false } } }).ok, true);
});
