// Site rekey: hub.rekeySite keeps the old key as an alias for 90 days, every lookup by site key
// follows the alias, a key another site holds is refused, and the staff route is dark by default.
//
// Run: node --test scripts/hub-rekey.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-rekey-'));
process.env.APP_DATA_DIR = dataDir;
process.env.PERSIST_PRODUCTION_ENV = '0';
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const hub = await import('../data/hub.js');
const analytics = await import('../data/client-analytics.js');
const { findSiteByKeyConstantTime } = await import('../lib/cms-sso.js');
const { salesClientForSite } = await import('../lib/local-blog-brief.js');
const { saveAutomationSettings, getAutomationSettings, invalidateAutomationSettingsCache } = await import('../data/automation-settings.js');
const { createMakerHost } = await import('../data/maker-hosts.js');
const { createMakerAuth } = await import('../lib/maker-auth.js');
const routes = await import('../lib/routes/site-rekey-routes.js');

const OLD_A = 'oldkey-aaaaaaaaaaaaaaaa';
const KEY_B = 'otherkey-bbbbbbbbbbbbbbbb';
const NEW_A = 'newkey-cccccccccccccccc';
const DAY = 86_400_000;

function fresh() {
  writeFileSync(join(dataDir, 'sites.json'), '[]');
  const a = hub.createSite({ name: 'Rekey Testbedrift', domain: 'rekey-a.example.com', site_key: OLD_A });
  const b = hub.createSite({ name: 'Annen Testbedrift', domain: 'rekey-b.example.com', site_key: KEY_B });
  return { a, b };
}

test('without any alias every lookup is a plain key match', () => {
  const { a } = fresh();
  assert.equal(hub.getSiteByKey(OLD_A).id, a.id);
  assert.equal(hub.getSiteByKey('nobody-key-xxxxxxxx'), null);
  assert.equal(hub.getSiteByKey(''), null);
  assert.deepEqual(hub.siteKeysFor(OLD_A), [OLD_A]);
  assert.deepEqual(hub.siteKeysFor('nobody-key-xxxxxxxx'), ['nobody-key-xxxxxxxx']);
  assert.deepEqual(hub.liveSiteKeys(hub.getSiteByKey(OLD_A)), [OLD_A]);
  const stored = JSON.parse(readFileSync(join(dataDir, 'sites.json'), 'utf8'));
  assert.equal(stored.some((site) => 'keyAliases' in site), false, 'nothing is stored for a site never rekeyed');
});

test('rekeySite swaps the key, keeps the old one as a 90 day alias and logs fingerprints', () => {
  const { a } = fresh();
  const now = Date.parse('2026-11-01T10:00:00.000Z');
  const result = hub.rekeySite(a.id, NEW_A, { by: 'admin:test', reason: 'adopt', now });
  assert.equal(result.ok, true);
  assert.equal(result.previousKey, OLD_A);
  assert.equal(result.site.site_key, NEW_A);
  const stored = JSON.parse(readFileSync(join(dataDir, 'sites.json'), 'utf8')).find((site) => site.id === a.id);
  assert.equal(stored.site_key, NEW_A);
  assert.equal(stored.keyAliases.length, 1);
  assert.equal(stored.keyAliases[0].key, OLD_A);
  assert.equal(Date.parse(stored.keyAliases[0].until) - now, 90 * DAY);
  assert.equal(stored.ext.keyHistory.length, 1);
  assert.equal(stored.ext.keyHistory[0].by, 'admin:test');
  assert.equal(JSON.stringify(stored.ext.keyHistory).includes(OLD_A), false, 'the history keeps fingerprints, not keys');
});

test('the old key resolves through the alias, in config and in key lists', () => {
  const { a } = fresh();
  hub.rekeySite(a.id, NEW_A);
  assert.equal(hub.getSiteByKey(NEW_A).id, a.id);
  assert.equal(hub.getSiteByKey(OLD_A).id, a.id);
  assert.deepEqual(hub.siteKeysFor(OLD_A), [OLD_A, NEW_A]);
  assert.deepEqual(hub.siteKeysFor(NEW_A), [NEW_A, OLD_A]);
  assert.equal(hub.getSiteConfig(OLD_A).id, a.id);
  assert.equal(hub.getSiteConfig(NEW_A).id, a.id);
});

test('an expired alias stops resolving and its key can go to another site', () => {
  const { a } = fresh();
  hub.rekeySite(a.id, NEW_A, { now: Date.now() - 91 * DAY });
  assert.equal(hub.getSiteByKey(OLD_A), null);
  assert.deepEqual(hub.siteKeysFor(NEW_A), [NEW_A]);
  const other = hub.getSiteByKey(KEY_B);
  assert.equal(hub.rekeySite(other.id, OLD_A).ok, true);
});

test('a key another site holds, as its key or as a live alias, is refused', () => {
  const { a, b } = fresh();
  assert.deepEqual(hub.rekeySite(a.id, KEY_B), { ok: false, code: 'site-key-held' });
  assert.equal(hub.getSiteByKey(OLD_A).id, a.id, 'nothing changed');
  assert.equal(hub.getSiteByKey(KEY_B).id, b.id);
  hub.rekeySite(b.id, NEW_A);
  assert.equal(hub.rekeySite(a.id, KEY_B).code, 'site-key-held', 'the alias of another site is held too');
  assert.equal(hub.rekeySite(a.id, 'short').code, 'bad-key');
  assert.equal(hub.rekeySite('no-such-site', NEW_A).code, 'not-found');
  assert.equal(hub.rekeySite(a.id, OLD_A).unchanged, true);
});

test('heartbeats under the old key reach the rekeyed site', () => {
  const { a } = fresh();
  hub.rekeySite(a.id, NEW_A);
  const beat = hub.recordHeartbeat(OLD_A, { packageVersion: '2.2.0' }, { verified: true });
  assert.equal(beat.ok, true);
  assert.equal(beat.site.id, a.id);
  assert.equal(hub.getSiteById(a.id).cms.packageVersion, '2.2.0');
});

test('traffic, commerce rows and the sign-in key check follow the alias', () => {
  const { a } = fresh();
  const at = '2026-11-02T09:00:00.000Z';
  analytics.appendTrafficEvents(OLD_A, [{ type: 'pageview', path: '/old', at }]);
  analytics.saveCommerceSnapshot(OLD_A, { orders: 3 });
  hub.rekeySite(a.id, NEW_A);
  analytics.appendTrafficEvents(NEW_A, [{ type: 'pageview', path: '/new', at: '2026-11-03T09:00:00.000Z' }]);
  const from = Date.parse('2026-11-01T00:00:00Z');
  const to = Date.parse('2026-11-30T00:00:00Z');
  assert.deepEqual(analytics.readTrafficEvents(NEW_A, from, to).map((row) => row.path), ['/old', '/new']);
  assert.deepEqual(analytics.readTrafficEvents(OLD_A, from, to).map((row) => row.path), ['/old', '/new']);
  assert.equal(analytics.getCommerceSnapshot(NEW_A).orders, 3);
  assert.equal(analytics.getCommerceSnapshot(OLD_A).orders, 3);
  const sites = hub.getAllSites();
  assert.equal(findSiteByKeyConstantTime(sites, OLD_A).id, a.id);
  assert.equal(findSiteByKeyConstantTime(sites, NEW_A).id, a.id);
  assert.equal(findSiteByKeyConstantTime(sites, KEY_B).name, 'Annen Testbedrift');
  assert.equal(findSiteByKeyConstantTime(sites, 'nobody-key-xxxxxxxx'), null);
  const site = hub.getSiteByKey(NEW_A);
  assert.equal(salesClientForSite(site, [{ id: 'sc-1', hubSite: { siteKey: OLD_A } }])?.id, 'sc-1', 'a sales client still holding the old key matches');
  assert.equal(salesClientForSite(site, [{ id: 'sc-2', hubSite: { siteKey: 'zzz' } }]), null);
});

// ---- the staff route ----

function makeApp() {
  const makerAuth = createMakerAuth({ dataDir, legacyHolder: null });
  const adminAuth = (req, res, next) => {
    if (req.headers.authorization === 'Bearer staff') {
      req.admin = { username: 'tester' };
      return next();
    }
    return res.status(401).json({ message: 'Unauthorized' });
  };
  const sales = { getSalesClientById: (id) => (id === 'sc-link' ? { id, hubSite: { id: hub.getSiteByKey(OLD_A)?.id } } : null) };
  const app = express();
  app.use(express.json());
  routes.register(app, { adminAuth, makerAuth, hub, sales, getDataDir: () => dataDir });
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, body, headers = {}) => fetch(`${base}/api/admin/sites/rekey`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

function setSwitch(enabled, paused = null) {
  const result = saveAutomationSettings({ siteRekey: { enabled, paused } }, { dataDir, by: 'test' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  invalidateAutomationSettingsCache();
}

test('the route answers 404 disabled before any sign-in check while the switch is off', async () => {
  const { a } = fresh();
  assert.equal(getAutomationSettings({ dataDir, fresh: true }).siteRekey.enabled, false);
  await withServer(async (base) => {
    const body = { event: 'run.sitekey.adopt', runId: 'r1', siteId: a.id, siteKey: NEW_A };
    for (const headers of [{}, { authorization: 'Bearer staff' }, { authorization: 'Bearer wrong' }]) {
      const res = await post(base, body, headers);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { code: 'disabled' });
    }
    assert.equal(hub.getSiteById(a.id).site_key, OLD_A, 'nothing written');
    setSwitch(true, { reason: 'paused for test' });
    assert.equal((await post(base, body, { authorization: 'Bearer staff' })).status, 404, 'a paused switch counts as off');
    setSwitch(false);
  });
});

test('with the switch on: staff and host tokens rekey, anyone else gets 401', async () => {
  const { a, b } = fresh();
  setSwitch(true);
  const host = createMakerHost({ label: 'Rekey test Maker', createdBy: 'test' }, { dataDir });
  const narrow = createMakerHost({ label: 'Narrow', scopes: ['jobs'], createdBy: 'test' }, { dataDir });
  await withServer(async (base) => {
    const body = { event: 'run.sitekey.adopt', runId: 'r1', siteId: a.id, salesClientId: 'sc-link', previousSiteKey: OLD_A, siteKey: NEW_A };
    assert.equal((await post(base, body)).status, 401);
    assert.equal((await post(base, body, { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await post(base, body, { 'x-maker-host-token': narrow.token })).status, 403, 'a host without the callback scope');
    assert.equal((await post(base, body, { 'x-sales-callback-token': 'legacy-token-value' })).status, 401);
    assert.equal(hub.getSiteById(a.id).site_key, OLD_A);

    const held = await post(base, { ...body, siteKey: KEY_B }, { authorization: 'Bearer staff' });
    assert.equal(held.status, 409);
    assert.deepEqual(await held.json(), { code: 'site-key-held' });

    const ok = await post(base, body, { 'x-maker-host-token': host.token });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.equal(hub.getSiteById(a.id).site_key, NEW_A);
    assert.equal(hub.getSiteByKey(OLD_A).id, a.id);
    assert.match(hub.getSiteById(a.id).ext.keyHistory[0].by, /^maker:mh_/);

    // Without a site id the site is found by its previous key, then by its sales client.
    const byKey = await post(base, { event: 'run.sitekey.adopt', previousSiteKey: KEY_B, siteKey: 'third-key-dddddddddddd' }, { authorization: 'Bearer staff' });
    assert.equal(byKey.status, 200);
    assert.equal(hub.getSiteById(b.id).site_key, 'third-key-dddddddddddd');
    const byClient = await post(base, { event: 'run.sitekey.adopt', salesClientId: 'sc-link', siteKey: 'fourth-key-eeeeeeeeeee' }, { authorization: 'Bearer staff' });
    assert.equal(byClient.status, 200);
    assert.equal(hub.getSiteById(a.id).site_key, 'fourth-key-eeeeeeeeeee');

    const missing = await post(base, { event: 'run.sitekey.adopt', siteId: 'nope', siteKey: NEW_A }, { authorization: 'Bearer staff' });
    assert.equal(missing.status, 422, 'an unknown site is not a 404, which the Maker reads as unavailable');
    assert.equal((await post(base, { siteId: a.id, siteKey: 'x' }, { authorization: 'Bearer staff' })).status, 400);
    assert.equal((await post(base, { event: 'other', siteId: a.id, siteKey: NEW_A }, { authorization: 'Bearer staff' })).status, 400);
  });
  setSwitch(false);
});

test('a key another site holds as a live alias cannot be adopted, and a current key beats an alias', () => {
  const { a, b } = fresh();
  assert.equal(hub.rekeySite(a.id, NEW_A).ok, true);
  const adopted = hub.adoptSiteKey(b.id, { from: KEY_B, to: OLD_A });
  assert.equal(adopted.ok, false);
  assert.equal(adopted.reason, 'key-taken');
  // Even if a stored file already has the clash, the current key wins in the constant-time lookup.
  const clash = [
    { ...hub.getSiteById(a.id) },
    { ...hub.getSiteById(b.id), site_key: OLD_A },
  ];
  assert.equal(findSiteByKeyConstantTime(clash, OLD_A).id, b.id);
});

test('the rekey route moves the linked sales client to the new key', async () => {
  const { a } = fresh();
  setSwitch(true);
  const updates = [];
  const sales = {
    getSalesClientById: (id) => (id === 'sc-link' ? { id, hubSite: { id: a.id, siteKey: OLD_A } } : null),
    updateSalesClient: (id, patch) => updates.push({ id, patch }),
  };
  const app = express();
  app.use(express.json());
  routes.register(app, { adminAuth: (req, res, next) => next(), makerAuth: createMakerAuth({ dataDir }), hub, sales, getDataDir: () => dataDir });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/admin/sites/rekey`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ siteId: a.id, salesClientId: 'sc-link', siteKey: NEW_A }) });
    assert.equal(res.status, 200);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].patch.hubSite.siteKey, NEW_A);
  } finally {
    server.close();
    setSwitch(false);
  }
});

test('sites made in the same millisecond get different ids, in the digits-only time form', () => {
  writeFileSync(join(dataDir, 'sites.json'), '[]');
  const realNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    const made = [];
    for (let i = 0; i < 5; i += 1) made.push(hub.createSite({ name: `Samtidig ${i}`, domain: `same-ms-${i}.example.com` }));
    const ids = made.map((site) => site.id);
    assert.equal(new Set(ids).size, 5, 'every site has its own id');
    assert.ok(ids.every((id) => /^\d+$/.test(id)), 'ids stay digits only');
    assert.equal(ids[0], '1800000000000');
    assert.deepEqual(ids, [...ids].sort((a, b) => Number(a) - Number(b)), 'ids rise in creation order');
    assert.equal(hub.getAllSites().length, 5);
    // an id already in the store (from another process) is skipped
    assert.equal(hub.nextSiteId([{ id: '1800000000005' }, { id: '1800000000006' }]), '1800000000007');
  } finally {
    Date.now = realNow;
  }
});
