// Owner-routing default: the preview is a dry run over every site, the migration touches only
// listed sites with a verified owner address, never a site whose routing someone set, and with the
// default off nothing is written at boot or daily.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-owner-default-'));
process.env.APP_DATA_DIR = dataDir;
process.env.SALES_CONTACT_EMAIL = 'salg@asoldi.com';

const store = await import('../data/email-store.js');
const owners = await import('../lib/owner-recipients.js');
const { registerEmailHubRoutes } = await import('../lib/routes/email-hub-routes.js');

const NOW = Date.parse('2026-11-03T08:00:00Z');
const SITES = [
  { id: 's_admin', site_key: 'k1', name: 'Admin-eier', domain: 'a.example.com', clientAdmin: { email: 'eier-a@example.com' } },
  { id: 's_confirmed', site_key: 'k2', name: 'Bekreftet', domain: 'b.example.com', clientAdmin: { email: '' } },
  { id: 's_sales_only', site_key: 'k3', name: 'Bare salg', domain: 'c.example.com', clientAdmin: { email: '' } },
  { id: 's_already', site_key: 'k4', name: 'Allerede satt', domain: 'd.example.com', clientAdmin: { email: 'eier-d@example.com' } },
  { id: 's_by_hand', site_key: 'k5', name: 'Satt for hånd', domain: 'e.example.com', clientAdmin: { email: 'eier-e@example.com' } },
  { id: 's_unlisted', site_key: 'k6', name: 'Ikke på listen', domain: 'f.example.com', clientAdmin: { email: 'eier-f@example.com' } },
];
const salesClients = [{ id: 'c3', contactEmail: 'salg-kontakt@example.com', hubSite: { siteKey: 'k3' } }];
const hub = { getSiteByKey: (k) => SITES.find((s) => s.site_key === k) || null, getSiteById: (id) => SITES.find((s) => s.id === id) || null, getAllSites: () => SITES };
const deps = { adminAuth: (_req, _res, next) => next(), hub, sales: { getSalesClients: () => salesClients } };
const LISTED = ['s_admin', 's_confirmed', 's_sales_only', 's_already', 's_by_hand', 's_missing'];

async function serve(options = {}) {
  const app = express();
  app.use(express.json());
  const handle = registerEmailHubRoutes(app, deps, { now: () => NOW, startJobs: false, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { handle, server, base: `http://127.0.0.1:${server.address().port}` };
}

const sitesFile = join(dataDir, 'email-sites.json');
const snapshot = () => (existsSync(sitesFile) ? `${statSync(sitesFile).mtimeMs}|${readFileSync(sitesFile, 'utf8')}` : 'none');

test.before(async () => {
  await store.patchEmailSite('s_confirmed', { ownerRecipients: [{ email: 'eier-b@example.com', status: 'confirmed', source: 'superadmin' }] });
  await store.patchEmailSite('s_already', { ownerRouting: 'owner', ownerRoutingSetAt: '2026-10-20T10:00:00.000Z', ownerRoutingSetBy: 'superadmin' });
  await store.patchEmailSite('s_by_hand', { ownerRouting: '', ownerRoutingSetAt: '2026-10-21T10:00:00.000Z', ownerRoutingSetBy: 'superadmin' });
});

test('defaults: the owner-routing default is off with no sites', () => {
  assert.deepEqual(store.readEmailSettings().ownerRoutingDefault, { enabled: false, siteIds: [] });
});

test('off: the boot and daily job write nothing, and form routing stays as it was', async () => {
  const before = snapshot();
  const routingBefore = SITES.map((site) => JSON.stringify(owners.resolveFormRouting(site, { getSalesClients: () => salesClients, now: NOW })));
  const { handle, server } = await serve({ startJobs: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await handle.runOwnerRoutingDefault(), { ran: false, changed: [], skipped: 0 });
  } finally {
    handle.stop();
    server.close();
  }
  assert.equal(snapshot(), before, 'email-sites.json untouched');
  assert.equal(existsSync(join(dataDir, 'email-locks', 'email-owner-routing.lease')), false, 'not even a lease');
  const routingAfter = SITES.map((site) => JSON.stringify(owners.resolveFormRouting(site, { getSalesClients: () => salesClients, now: NOW })));
  assert.deepEqual(routingAfter, routingBefore);
  assert.equal(owners.resolveFormRouting(SITES[0], { now: NOW }).mode, '', 'unset routing means today\'s behaviour');
});

test('the preview is a dry run over every site and explains each decision', async () => {
  await store.saveEmailSettings({ ownerRoutingDefault: { enabled: false, siteIds: LISTED } });
  const before = snapshot();
  const { server, base } = await serve();
  try {
    const res = await fetch(`${base}/api/admin/email/owner-routing/preview`);
    assert.equal(res.status, 200);
    const preview = await res.json();
    assert.equal(snapshot(), before, 'the preview writes nothing');
    const by = Object.fromEntries(preview.sites.map((row) => [row.siteId, row]));
    assert.equal(preview.sites.length, SITES.length, 'every site is shown');
    assert.deepEqual([by.s_admin.action, by.s_admin.reason, by.s_admin.proposedMode, by.s_admin.owner], ['set', 'listed', 'owner+asoldi-bcc', ['eier-a@example.com']]);
    assert.deepEqual([by.s_confirmed.action, by.s_confirmed.ownerSource], ['set', 'ownerRecipients']);
    assert.deepEqual([by.s_sales_only.action, by.s_sales_only.reason], ['skip', 'no-verified-owner'], 'a sales-card address is not verified');
    assert.deepEqual([by.s_already.action, by.s_already.reason, by.s_already.proposedMode], ['skip', 'already-set', 'owner']);
    assert.deepEqual([by.s_by_hand.action, by.s_by_hand.reason], ['skip', 'changed-by-hand']);
    assert.deepEqual([by.s_unlisted.action, by.s_unlisted.reason], ['skip', 'not-listed']);
    assert.equal(by.s_admin.wouldChange, false, 'nothing changes while the default is off');
    assert.deepEqual(preview.unknownSiteIds, ['s_missing']);
    assert.deepEqual(preview.summary, { sites: 6, listed: 5, wouldSet: 2, wouldChangeNow: 0, eligibleNotListed: 1 });
  } finally {
    server.close();
  }
});

test('enabled: the migration changes only listed sites with a verified owner, once, with a 30-day BCC', async () => {
  const { server, base } = await serve();
  try {
    const res = await fetch(`${base}/api/admin/email/owner-routing/default`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, siteIds: LISTED }) });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.deepEqual(out.result.changed.sort(), ['s_admin', 's_confirmed']);
  } finally {
    server.close();
  }
  const rows = store.readEmailSites();
  assert.equal(rows.s_admin.ownerRouting, 'owner+asoldi-bcc');
  assert.equal(rows.s_admin.ownerRoutingSetAt, new Date(NOW).toISOString());
  assert.equal(rows.s_admin.ownerRoutingSetBy, owners.OWNER_ROUTING_DEFAULT_ACTOR);
  assert.equal(rows.s_confirmed.ownerRouting, 'owner+asoldi-bcc');
  assert.equal(rows.s_sales_only?.ownerRouting || '', '');
  assert.equal(rows.s_already.ownerRouting, 'owner', 'an existing choice stays');
  assert.equal(rows.s_by_hand.ownerRouting, '', 'a site set back by hand stays unset');
  assert.equal(rows.s_unlisted?.ownerRouting || '', '', 'an unlisted site is never touched');
  const routing = owners.resolveFormRouting(SITES[0], { now: NOW + 24 * 60 * 60_000 });
  assert.deepEqual([routing.to, routing.bcc], ['eier-a@example.com', 'salg@asoldi.com']);
  assert.equal(owners.resolveFormRouting(SITES[0], { now: NOW + 31 * 24 * 60 * 60_000 }).bcc, false, 'after 30 days only the owner');
  const before = snapshot();
  const again = await owners.applyOwnerRoutingDefault({ getAllSites: hub.getAllSites, getSalesClients: () => salesClients, now: NOW + 24 * 60 * 60_000 });
  assert.deepEqual(again.changed, [], 'the daily run changes nothing twice (the BCC window is not restarted)');
  assert.equal(snapshot(), before);
});

test('the boot job applies a newly listed site while enabled', async () => {
  await store.saveEmailSettings({ ownerRoutingDefault: { enabled: true, siteIds: [...LISTED, 's_unlisted'] } });
  const { handle, server } = await serve({ startJobs: true });
  try {
    for (let i = 0; i < 50 && store.readEmailSite('s_unlisted').ownerRouting !== 'owner+asoldi-bcc'; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    handle.stop();
    server.close();
  }
  assert.equal(store.readEmailSite('s_unlisted').ownerRouting, 'owner+asoldi-bcc');
});

test('switching the default off stops further changes; already-moved sites keep their routing', async () => {
  await store.saveEmailSettings({ ownerRoutingDefault: { enabled: false, siteIds: LISTED } });
  const before = snapshot();
  const result = await owners.applyOwnerRoutingDefault({ getAllSites: hub.getAllSites, now: NOW });
  assert.deepEqual(result, { ran: false, changed: [], skipped: 0 });
  assert.equal(snapshot(), before);
});
