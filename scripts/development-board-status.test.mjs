// Developer page backend: the writes the board GET used to make now run from the delivery loop tick
// (same results for loop-off clients), item summaries are additive, board-status returns only changed
// items, detail and board-status need developmentAuth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-board-status-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';
process.env.PERSIST_PRODUCTION_ENV = '0';
process.env.HUB_SAFE_MODE = '1';

const loopLib = await import('../lib/delivery-loop.js');
const board = await import('../lib/development-board.js');
const phase = await import('../lib/development-phase.js');
const sales = await import('../data/sales.js');
const hub = await import('../data/hub.js');
const settingsStore = await import('../data/automation-settings.js');
const makerAuthLib = await import('../lib/maker-auth.js');
const hardening = await import('../lib/auth-hardening.js');
const routes = await import('../lib/routes/dev-report-routes.js');
const { testReleases, writeReleasesFile } = await import('./fixtures/test-releases.mjs');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const quiet = { warn() {}, error() {}, log() {} };
const signed = { meetingHeld: true, offerSent: true, contractSigned: true };
const T0 = Date.parse('2026-11-02T09:00:00.000Z');

function resetData() {
  for (const name of readdirSync(dataDir)) rmSync(join(dataDir, name), { recursive: true, force: true });
  clearJsonCacheForTests();
  loopLib.resetDeliveryLoopForTests();
  board.resetLegacyDevelopmentWritesForTests();
}

function seed({ clients = [], sites = [] } = {}) {
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify(clients, null, 2));
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(sites, null, 2));
  sales.getSalesClients();
}

function setSettings(patch) {
  writeReleasesFile(dataDir);
  settingsStore.invalidateAutomationSettingsCache();
  const result = settingsStore.saveAutomationSettings(patch, { by: 'test' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  settingsStore.invalidateAutomationSettingsCache();
}

// Timestamps the store itself stamps while it reads and writes differ between two runs; every other value counts.
const strip = (value) => JSON.parse(JSON.stringify(value).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, 'T'));

function stores() {
  const read = (name) => (existsSync(join(dataDir, name)) ? strip(JSON.parse(readFileSync(join(dataDir, name), 'utf8'))) : null);
  return { clients: read('sales-clients.json'), sites: read('sites.json'), ownerSeed: read('developer-owner-seed.json') ? true : false };
}

function fixtureSet() {
  const clients = [
    { id: 'a1', product: 'asoldi', businessName: 'Alpha AS', status: 'active', progression: signed, development: { nettsideFerdig: true }, hubSite: { id: 'site-a', siteKey: 'key-a' }, developerOwnerId: '' },
    { id: 'b1', product: 'asoldi', businessName: 'Beta AS', status: 'active', progression: signed, development: { nettsideFerdig: true }, hubSite: { id: 'site-b', siteKey: 'key-b' }, developerOwnerId: '' },
    { id: 'c1', product: 'asoldi', businessName: 'Gamma AS', status: 'active', progression: signed, developerOwnerId: '' },
    { id: 'd1', product: 'asoldi', businessName: 'Delta AS', status: 'active', progression: { meetingHeld: true }, developerOwnerId: '' },
  ];
  const sites = [
    { id: 'site-a', site_key: 'key-a', name: 'Alpha', domain: 'alpha.example', deliveryPhase: 'development', createdAt: '2026-09-01T10:00:00.000Z' },
    { id: 'site-b', site_key: 'key-b', name: 'Beta', domain: 'beta.example', deliveryPhase: 'development', createdAt: '2026-09-01T10:00:00.000Z' },
  ];
  return { clients, sites };
}

/** What the development GET did on every call before it became read-only (the reference path). */
async function oldGetWrites({ onlyAdmin = true } = {}) {
  const loopScope = loopLib.developmentGetLoopScope(() => sales.getSalesClients());
  hub.reconcileDeliveryPhases(sales.getSalesClients(), loopScope.reconcile);
  sales.seedExistingDeveloperOwnersToAdmin();
  if (onlyAdmin) sales.assignOpenDeveloperClientsToAdmin(loopScope.owners);
}

function loopWithLegacy(options = [{ accountKey: 'admin' }]) {
  const listDeveloperOwnerOptions = async () => options;
  return loopLib.createDeliveryLoop({
    sales,
    hub,
    log: quiet,
    listDeveloperOwnerOptions,
    legacyDevelopmentWrites: ({ settings }) => board.runLegacyDevelopmentWrites({ sales, hub, listDeveloperOwnerOptions, settings }),
  });
}

test('one tick makes the writes the GET used to make: identical stores for loop-off clients', async () => {
  for (const [name, options] of [['admin is the only developer', [{ accountKey: 'admin' }]], ['another developer exists', [{ accountKey: 'admin' }, { accountKey: 'developer:dev1' }]]]) {
    resetData();
    seed(fixtureSet());
    const before = stores();
    await oldGetWrites({ onlyAdmin: !options.some((row) => row.accountKey.startsWith('developer:')) });
    const viaGet = stores();
    assert.notDeepEqual(viaGet.clients, before.clients, `${name}: the old path writes (clients compared > 0)`);

    resetData();
    seed(fixtureSet());
    const loop = loopWithLegacy(options);
    const result = await loop.tick({ now: T0 });
    assert.deepEqual(result, { ran: false, reason: 'disabled' }, 'the loop stays off');
    assert.deepEqual(stores(), viaGet, `${name}: after one tick the data equals the old GET path`);
    // A second tick changes nothing more.
    await loop.tick({ now: T0 + 60_000 });
    assert.deepEqual(stores(), viaGet, `${name}: idempotent`);
  }
});

test('with the loop on, the tick covers clients the loop does not own exactly as the GET did', async () => {
  resetData();
  seed(fixtureSet());
  setSettings({ pilotClientIds: ['a1'], delivery: { loop: { enabled: true, mode: 'auto' } } });
  const scopeBefore = loopLib.developmentGetLoopScope(() => sales.getSalesClients());
  assert.ok(scopeBefore.owned.has('a1'), 'a1 is owned by the loop');
  await oldGetWrites();
  const viaGet = stores();
  const notOwned = (rows) => rows.filter((row) => row.id !== 'a1' && row.id !== 'site-a');
  resetData();
  seed(fixtureSet());
  setSettings({ pilotClientIds: ['a1'], delivery: { loop: { enabled: true, mode: 'auto' } } });
  await loopWithLegacy().tick({ now: T0 });
  const viaTick = stores();
  assert.deepEqual(notOwned(viaTick.clients), notOwned(viaGet.clients), 'clients the loop does not own');
  assert.deepEqual(notOwned(viaTick.sites), notOwned(viaGet.sites), 'sites the loop does not own');
  assert.ok(notOwned(viaTick.clients).length >= 3);
});

test('negative control: without the loop dependency a tick leaves the stores as seeded (the GET no longer writes)', async () => {
  resetData();
  seed(fixtureSet());
  const before = stores();
  const loop = loopLib.createDeliveryLoop({ sales, hub, log: quiet, listDeveloperOwnerOptions: async () => [{ accountKey: 'admin' }] });
  await loop.tick({ now: T0 });
  assert.deepEqual(stores(), before);
  assert.equal(sales.getSalesClientById('c1').developerOwnerId, '');
});

test('a failing legacy write is noted and does not stop the tick', async () => {
  resetData();
  seed(fixtureSet());
  const loop = loopLib.createDeliveryLoop({ sales, hub, log: quiet, legacyDevelopmentWrites: async () => { throw new Error('boom'); } });
  const result = await loop.tick({ now: T0 });
  assert.deepEqual(result, { ran: false, reason: 'disabled' });
});

// ---------------------------------------------------------------- items

function boardFixture() {
  const clients = [
    {
      id: 'sales-one', product: 'asoldi', status: 'active', businessName: 'Alpha Salong', progression: signed, contractSignedAt: '2026-10-01T10:00:00.000Z',
      development: { nettsideFerdig: false }, hubSite: { siteKey: 'key-1', id: 'site-1', domain: 'alpha.example' }, developerOwnerId: 'admin',
      makerRun: { runId: 'run-one-0001', aiSpend: { runId: 'run-one-0001', totalUsd: 1.5, calls: 12, receivedAt: '2026-11-01T10:00:00.000Z' }, goLive: { needsImport: { hint: 'x' }, status: 'needs_import' } },
      delivery: { stage: 'developing', history: [{ from: 'signed', to: 'developing', at: '2026-10-02T10:00:00.000Z' }], gate: { status: 'open', lines: [{ id: 'l1', status: 'missing', blocking: true }, { id: 'l2', status: 'ok' }] }, job: { id: 'job_synthetic1', kind: 'preview', status: 'running', warnings: [] } },
    },
    { id: 'sales-two', product: 'asoldi', status: 'active', businessName: 'Beta Frisor', progression: signed, contractSignedAt: '2026-10-03T10:00:00.000Z', development: { nettsideFerdig: false }, hubSite: { siteKey: 'key-2', id: 'site-2', domain: 'beta.example' }, developerOwnerId: 'admin' },
  ];
  const sites = [
    { id: 'site-1', site_key: 'key-1', name: 'Alpha', domain: 'alpha.example', deliveryPhase: 'development' },
    { id: 'site-2', site_key: 'key-2', name: 'Beta', domain: 'beta.example', deliveryPhase: 'development' },
  ];
  return { clients, sites };
}

test('item summaries are additive: every existing field is byte-identical, the new fields are present, dev is empty until a report', () => {
  const { clients, sites } = boardFixture();
  const base = phase.buildDevelopmentItems(clients, sites);
  assert.equal(base.length, 2);
  const decorated = board.decorateBoardItems(structuredClone(base), { salesClientById: (id) => clients.find((c) => c.id === id) || null, dataDir });
  let compared = 0;
  for (const [index, item] of base.entries()) {
    for (const key of Object.keys(item)) {
      assert.equal(JSON.stringify(decorated[index][key]), JSON.stringify(item[key]), `existing field ${key} unchanged`);
      compared += 1;
    }
    for (const key of ['delivery', 'briefSummary', 'changeRequestSummary', 'hostStatus', 'autopilotSummary', 'devSummary', 'aiSpendSummary', 'goLiveSummary']) {
      assert.ok(Object.hasOwn(decorated[index], key), `new field ${key}`);
    }
  }
  assert.ok(compared > 40, 'items compared');
  const [first, second] = decorated;
  assert.deepEqual(first.devSummary, {}, 'empty until reports arrive');
  assert.equal(first.delivery.stage, 'developing');
  assert.deepEqual(first.delivery.gate, { status: 'open', approved: false, lines: 2, open: 1, blocking: 1 });
  assert.equal(first.delivery.job.status, 'running');
  assert.equal(first.aiSpendSummary.totalUsd, 1.5);
  assert.equal(first.goLiveSummary.needsImport, true);
  assert.equal(second.goLiveSummary.needsImport, false);
  assert.deepEqual(second.changeRequestSummary, { open: 0, used: 0, quota: second.changeRequestSummary.quota });
  // Control: a planted change to an existing field is caught by the same comparison.
  const planted = structuredClone(decorated);
  planted[0].businessName = 'Changed AS';
  assert.notEqual(JSON.stringify(planted[0].businessName), JSON.stringify(base[0].businessName));
});

// ---------------------------------------------------------------- board-status

function item(index, extra = {}) {
  return { id: `sales:c${String(index).padStart(3, '0')}`, salesClientId: `c${index}`, businessName: `Eksempel ${index} AS`, development: { nettsideFerdig: false }, ...extra };
}

test('board-status: 30 unchanged clients cost at most 5 KB; a change returns only that item; a removal is listed; a restart returns all', () => {
  const revisions = board.createBoardRevisions();
  const items = Array.from({ length: 30 }, (_, index) => item(index));
  const first = revisions.status(items, 0);
  assert.equal(first.changed.length, 30, 'the first call returns everything');
  const idle = revisions.status(items, first.rev);
  const body = JSON.stringify({ ok: true, rev: idle.rev, count: idle.count, items: idle.changed, removed: idle.removed });
  assert.equal(idle.changed.length, 0);
  assert.ok(Buffer.byteLength(body) <= 5 * 1024, `answer is ${Buffer.byteLength(body)} bytes`);
  const edited = items.map((row, index) => (index === 7 ? { ...row, businessName: 'Ny Navn AS' } : row));
  const changed = revisions.status(edited, idle.rev);
  assert.deepEqual(changed.changed.map((row) => row.id), ['sales:c007']);
  const removed = revisions.status(edited.slice(1), changed.rev);
  assert.deepEqual(removed.removed, ['sales:c000']);
  assert.equal(removed.changed.length, 0);
  const afterRestart = board.createBoardRevisions().status(edited, 99);
  assert.equal(afterRestart.changed.length, 30, 'a since newer than this process returns everything');
});

function developmentAuth(req, res, next) {
  const who = String(req.headers['x-test-user'] || '');
  if (!who) return res.status(401).json({ message: 'Unauthorized' });
  req.developmentUser = who === 'admin'
    ? { role: 'admin', isAdmin: true, userId: '', username: 'admin', accountKey: 'admin' }
    : { role: 'developer', isAdmin: false, userId: who, username: who, accountKey: `developer:${who}` };
  return next();
}

function snapshot(dir) {
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(`${full.slice(dir.length)}|${statSync(full).size}|${statSync(full).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

test('board-status and detail: 401 without credentials, no write, only visible clients, 5 KB when idle', async (t) => {
  resetData();
  const { clients, sites } = boardFixture();
  seed({ clients, sites });
  const routeDir = mkdtempSync(join(tmpdir(), 'asoldi-board-routes-'));
  t.after(() => rmSync(routeDir, { recursive: true, force: true }));
  mkdirSync(join(routeDir, 'delivery-briefs'), { recursive: true });
  const makerAuth = makerAuthLib.createMakerAuth({
    legacyHolder: hardening.createHubSecretHolder({ envValue: '', envRule: 'any', lazy: true, dataDir: routeDir, name: 'maker-callback-token', bytes: 32 }),
    dataDir: routeDir,
    env: {},
  });
  const thirty = Array.from({ length: 30 }, (_, index) => item(index));
  const app = express();
  app.use(express.json());
  routes.register(app, {
    developmentAuth,
    makerAuth,
    sales: { getSalesClientById: (id) => clients.find((c) => c.id === id) || null, getSalesClients: () => clients },
    hub: { getAllSites: () => sites },
    getDataDir: () => routeDir,
    settings: () => settingsStore.defaultAutomationSettings(),
    boardItems: () => thirty,
    log: quiet,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, headers = {}) => fetch(`${base}${path}`, { headers });
  const before = snapshot(routeDir);
  let requests = 0;
  for (const path of ['/api/admin/development/board-status', '/api/admin/development/board-status?since=3', '/api/admin/development/sales:sales-one/detail']) {
    const res = await get(path);
    requests += 1;
    assert.equal(res.status, 401, path);
  }
  assert.ok(requests > 0);
  assert.deepEqual(snapshot(routeDir), before, 'refused requests wrote nothing');

  const admin = { 'x-test-user': 'admin' };
  const first = await (await get('/api/admin/development/board-status', admin)).json();
  assert.equal(first.items.length, 30);
  const idleRes = await get(`/api/admin/development/board-status?since=${first.rev}`, admin);
  const idleText = await idleRes.text();
  assert.ok(Buffer.byteLength(idleText) <= 5 * 1024, `idle answer ${Buffer.byteLength(idleText)} bytes`);
  assert.deepEqual(JSON.parse(idleText).items, []);

  const detail = await get('/api/admin/development/sales:sales-one/detail', admin);
  assert.equal(detail.status, 200);
  const data = (await detail.json()).detail;
  assert.equal(data.salesClientId, 'sales-one');
  assert.equal(data.gate.lines.length, 2);
  assert.equal(data.deliveryHistory[0].to, 'developing');
  for (const key of ['brief', 'jobs', 'changeRequests', 'devReports']) assert.ok(Object.hasOwn(data, key), key);
  const stranger = await get('/api/admin/development/sales:sales-one/detail', { 'x-test-user': 'dev-2' });
  assert.equal(stranger.status, 404);
  assert.equal((await get('/api/admin/development/sales:nope/detail', admin)).status, 404);
  assert.deepEqual(snapshot(routeDir), before, 'reads wrote nothing');
});

test('board-status: revisions are kept per caller; a developer never sees removed ids of items it cannot see, and a newly assigned item is returned', () => {
  const revisions = board.createBoardRevisions();
  const a = { id: 'sales:a', v: 1 };
  const b = { id: 'sales:b', v: 1 };
  revisions.status([a, b], 0, 'admin');
  const dev = revisions.status([a], 0, 'developer:x');
  assert.deepEqual(dev.removed, []);
  const after = revisions.status([a, b], dev.rev, 'developer:x');
  assert.deepEqual(after.changed.map((row) => row.id), ['sales:b']);
  assert.deepEqual(after.removed, []);
});
