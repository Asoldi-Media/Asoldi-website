// The developer board answers with one read of the sales store, and the delivery loop tick skips the
// legacy board writes when nothing they depend on changed. Nothing here depends on wall-clock timing:
// the tests count reads and writes of the stores. This file patches fs for the whole process, so it
// runs on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-board-reads-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';
process.env.PERSIST_PRODUCTION_ENV = '0';
process.env.HUB_SAFE_MODE = '1';

const loopLib = await import('../lib/delivery-loop.js');
const board = await import('../lib/development-board.js');
const phase = await import('../lib/development-phase.js');
const sales = await import('../data/sales.js');
const hub = await import('../data/hub.js');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const quiet = { warn() {}, error() {}, log() {} };
const signed = { meetingHeld: true, offerSent: true, contractSigned: true };
const NOW = Date.parse('2026-11-02T09:00:00.000Z');
const CLIENTS = 200;
const SIGNED = 80;

// ---------------------------------------------------------------- counting the stores

const original = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
const counts = { salesReads: 0, writes: 0 };

fs.readFileSync = function counted(path, ...rest) {
  if (/sales-clients\.json$/.test(String(path))) counts.salesReads += 1;
  return original.readFileSync.call(this, path, ...rest);
};
fs.writeFileSync = function counted(path, ...rest) {
  if (String(path).startsWith(dataDir)) counts.writes += 1;
  return original.writeFileSync.call(this, path, ...rest);
};
fs.renameSync = function counted(from, to, ...rest) {
  if (String(to).startsWith(dataDir)) counts.writes += 1;
  return original.renameSync.call(this, from, to, ...rest);
};
syncBuiltinESMExports();
test.after(() => {
  Object.assign(fs, original);
  syncBuiltinESMExports();
});

function measure(fn) {
  counts.salesReads = 0;
  counts.writes = 0;
  const value = fn();
  return value instanceof Promise ? value.then((out) => ({ out, ...counts })) : { out: value, ...counts };
}

// ---------------------------------------------------------------- data

function clientRows({ ownerFilled = false } = {}) {
  const rows = [];
  for (let i = 0; i < CLIENTS; i += 1) {
    const id = `c${String(i).padStart(3, '0')}`;
    const isSigned = i < SIGNED;
    const row = {
      id,
      product: 'asoldi',
      status: 'active',
      businessName: `Synthetic ${i} AS`,
      createdAt: new Date(NOW - i * 3_600_000).toISOString(),
      progression: isSigned ? signed : { meetingHeld: true },
      developerOwnerId: ownerFilled ? 'admin' : '',
    };
    if (isSigned) {
      row.contractSignedAt = '2026-10-01T10:00:00.000Z';
      row.development = { nettsideFerdig: false };
      row.hubSite = { id: `site-${i}`, siteKey: `key-${i}`, domain: `s${i}.example` };
      if (i % 3 === 0) row.makerRun = { runId: `run-${String(i).padStart(4, '0')}`, aiSpend: { totalUsd: i / 10, calls: i, receivedAt: '2026-11-01T10:00:00.000Z' }, autopilot: { status: 'running', step: '2', at: '2026-11-01T10:00:00.000Z' }, goLive: { needsImport: i % 2 === 0, status: 'x' } };
      if (i % 4 === 0) row.delivery = { stage: 'developing', stageAt: '2026-10-02T10:00:00.000Z', gate: { status: 'open', lines: [{ id: 'l1', status: 'missing', blocking: true }, { id: 'l2', status: 'ok' }] }, job: { id: `job_${i}`, kind: 'preview', status: 'running', warnings: [] } };
    }
    rows.push(row);
  }
  return rows;
}

function siteRows() {
  const rows = [];
  for (let i = 0; i < SIGNED; i += 1) rows.push({ id: `site-${i}`, site_key: `key-${i}`, name: `Site ${i}`, domain: `s${i}.example`, deliveryPhase: 'development', createdAt: '2026-09-01T10:00:00.000Z' });
  return rows;
}

function reset(rows = clientRows(), sites = siteRows()) {
  for (const name of readdirSync(dataDir)) rmSync(join(dataDir, name), { recursive: true, force: true });
  clearJsonCacheForTests();
  loopLib.resetDeliveryLoopForTests();
  board.resetLegacyDevelopmentWritesForTests();
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify(rows, null, 2));
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(sites, null, 2));
}

function boardItems(list, sites) {
  return [...phase.buildDevelopmentItems(list, sites), ...phase.buildPreviewItems(list, sites)];
}

// ---------------------------------------------------------------- the board

test('decorateBoardItems with one read gives the byte-identical items of the read-per-item path', () => {
  const rows = clientRows({ ownerFilled: true });
  // The same id twice, the later one newer: the list puts it first, the lookup keeps the file order.
  rows.push({ ...rows[5], businessName: 'Repeated id, newer', createdAt: new Date(NOW + 86_400_000).toISOString() });
  reset(rows);
  const sites = hub.getAllSites();
  const { clients: list, byId } = sales.getSalesClientsWithIndex();
  assert.equal(list.length, CLIENTS + 1);
  assert.equal(list[0].businessName, 'Repeated id, newer', 'the list is sorted newest first');
  assert.equal(byId.get('c005').businessName, sales.getSalesClientById('c005').businessName, 'the index answers like getSalesClientById');
  assert.notEqual(byId.get('c005').businessName, 'Repeated id, newer');
  assert.deepEqual(list.map((c) => c.id), sales.getSalesClients().map((c) => c.id), 'the list is what getSalesClients returns');

  const reference = board.decorateBoardItems(boardItems(list, sites), { salesClientById: (id) => sales.getSalesClientById(id), dataDir, now: NOW });
  const viaIndex = board.decorateBoardItems(boardItems(list, sites), { clientsById: byId, dataDir, now: NOW });
  assert.ok(reference.length >= SIGNED, `${reference.length} board items`);
  assert.ok(reference.every((item) => Object.hasOwn(item, 'delivery') && Object.hasOwn(item, 'goLiveSummary')), 'every item was decorated');
  assert.equal(JSON.stringify(viaIndex), JSON.stringify(reference), 'same fields, same order, same values');
  // Control: the comparison sees a changed value and a changed key order.
  const planted = structuredClone(viaIndex);
  planted[3].aiSpendSummary = { totalUsd: 999, calls: 0, receivedAt: '' };
  assert.notEqual(JSON.stringify(planted), JSON.stringify(reference));
  const reordered = structuredClone(viaIndex);
  reordered[0] = Object.fromEntries(Object.entries(reordered[0]).reverse());
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(reference));
  // An item whose client is not in the index is left as it was.
  const orphan = [{ id: 'sales:gone', salesClientId: 'gone' }];
  assert.deepEqual(board.decorateBoardItems(structuredClone(orphan), { clientsById: byId, dataDir, now: NOW }), orphan);
});

test('the board needs one read of the sales store; the read-per-item path reads once per item (control)', () => {
  reset(clientRows({ ownerFilled: true }));
  const sites = hub.getAllSites();
  const old = measure(() => {
    const list = sales.getSalesClients();
    return board.decorateBoardItems(boardItems(list, sites), { salesClientById: (id) => sales.getSalesClientById(id), dataDir, now: NOW });
  });
  assert.ok(old.out.length >= SIGNED);
  assert.ok(old.salesReads > old.out.length, `the old path reads the store per item (${old.salesReads} reads for ${old.out.length} items)`);
  const fresh = measure(() => {
    const { clients, byId } = sales.getSalesClientsWithIndex();
    return board.decorateBoardItems(boardItems(clients, sites), { clientsById: byId, dataDir, now: NOW });
  });
  assert.equal(fresh.out.length, old.out.length);
  assert.equal(fresh.salesReads, 1, 'one read of the sales store for the whole board');
  assert.equal(fresh.writes, 0, 'the board writes nothing');
});

// ---------------------------------------------------------------- the tick

const adminOnly = async () => [{ accountKey: 'admin' }];
const legacy = (options = adminOnly) => board.runLegacyDevelopmentWrites({ sales, hub, listDeveloperOwnerOptions: options });
const storeText = () => ({ clients: readFileSync(join(dataDir, 'sales-clients.json'), 'utf8'), sites: readFileSync(join(dataDir, 'sites.json'), 'utf8') });
const owners = () => sales.getSalesClients().map((c) => c.developerOwnerId);

test('a tick with nothing to do reads no store and writes nothing; the first tick still fills the owners', async () => {
  reset(clientRows());
  assert.ok(owners().every((owner) => owner === ''));
  const loop = loopLib.createDeliveryLoop({
    sales, hub, log: quiet, listDeveloperOwnerOptions: adminOnly,
    legacyDevelopmentWrites: ({ settings }) => board.runLegacyDevelopmentWrites({ sales, hub, listDeveloperOwnerOptions: adminOnly, settings }),
  });
  const first = await measure(() => loop.tick({ now: NOW }));
  assert.deepEqual(first.out, { ran: false, reason: 'disabled' });
  assert.ok(first.writes > 0, 'the first tick writes the owners');
  assert.ok(owners().every((owner) => owner === 'admin'), 'the owner fill at the first tick happened');
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'developer-owner-seed.json'), 'utf8')).assignedCount, CLIENTS);

  // The next tick looks again (its inputs are new); after that the inputs repeat.
  await loop.tick({ now: NOW + 60_000 });
  const before = storeText();
  const quietTick = await measure(() => loop.tick({ now: NOW + 120_000 }));
  assert.equal(quietTick.writes, 0, 'no writes');
  assert.equal(quietTick.salesReads, 0, 'no read of the sales store');
  assert.deepEqual(storeText(), before);
  for (let i = 3; i < 8; i += 1) {
    const again = await measure(() => loop.tick({ now: NOW + i * 60_000 }));
    assert.equal(again.writes, 0);
    assert.equal(again.salesReads, 0);
  }
});

test('the skipped run is the run the old tick made: same stores after the same changes', async () => {
  // Reference: every tick runs in full (stores without a stamp are never skipped).
  const full = { ...sales, salesStoreStamp: undefined };
  const stepsOf = async (salesApi, withSkip) => {
    reset(clientRows());
    const run = () => board.runLegacyDevelopmentWrites({ sales: salesApi, hub: withSkip ? hub : { ...hub, sitesStoreStamp: undefined }, listDeveloperOwnerOptions: adminOnly });
    const seen = [];
    seen.push((await run()).skipped || 'ran');
    seen.push((await run()).skipped || 'ran');
    seen.push((await run()).skipped || 'ran');
    // A new client without an owner and a site whose phase must change.
    const rows = JSON.parse(readFileSync(join(dataDir, 'sales-clients.json'), 'utf8'));
    rows.push({ id: 'late', product: 'asoldi', status: 'active', businessName: 'Late AS', createdAt: new Date(NOW).toISOString(), progression: signed, developmentNote: 'x'.repeat(40) });
    writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify(rows, null, 2));
    const sites = JSON.parse(readFileSync(join(dataDir, 'sites.json'), 'utf8'));
    sites[0].development = { nettsideFerdig: true };
    writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(sites, null, 2));
    seen.push((await run()).skipped || 'ran');
    seen.push((await run()).skipped || 'ran');
    seen.push((await run()).skipped || 'ran');
    return { seen, stores: storeText(), seed: readFileSync(join(dataDir, 'developer-owner-seed.json'), 'utf8').replace(/"existingAssignedToAdminAt": "[^"]*"/, '"at"') };
  };
  const reference = await stepsOf(full, false);
  assert.deepEqual(reference.seen, ['ran', 'ran', 'ran', 'ran', 'ran', 'ran'], 'without stamps every run is in full');
  const skipping = await stepsOf(sales, true);
  assert.deepEqual(skipping.seen, ['ran', 'ran', 'unchanged', 'ran', 'ran', 'unchanged'], 'runs after a change, skips when the inputs repeat');
  const strip = (text) => text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, 'T');
  assert.equal(strip(skipping.stores.clients), strip(reference.stores.clients), 'sales store identical');
  assert.equal(strip(skipping.stores.sites), strip(reference.stores.sites), 'sites store identical');
  assert.equal(strip(skipping.seed), strip(reference.seed));
  assert.equal(sales.getSalesClientById('late').developerOwnerId, 'admin', 'the late client was filled');
});

test('another developer, a changed client list and a failing owner list are handled in full', async () => {
  reset(clientRows());
  await legacy();
  await legacy();
  assert.equal((await legacy()).skipped, 'unchanged');
  // A developer account appears: the open-client assignment stops, so the inputs differ and the run is in full.
  const rows = JSON.parse(readFileSync(join(dataDir, 'sales-clients.json'), 'utf8'));
  rows.push({ id: 'open', product: 'asoldi', status: 'active', businessName: 'Open AS', createdAt: new Date(NOW).toISOString(), progression: signed });
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify(rows, null, 2));
  const withDeveloper = async () => [{ accountKey: 'admin' }, { accountKey: 'developer:dev1' }];
  const result = await legacy(withDeveloper);
  assert.equal(result.skipped, undefined);
  assert.equal(result.assigned, false);
  assert.equal(sales.getSalesClientById('open').developerOwnerId, '', 'not assigned while another developer exists');
  // The failing owner list: the reconcile and the seed ran, the error is raised, nothing is remembered.
  const failing = async () => { throw new Error('owner list failed'); };
  await assert.rejects(legacy(failing), /owner list failed/);
  await assert.rejects(legacy(failing), /owner list failed/);
  // Back to the admin alone: the open client is filled.
  const back = await legacy();
  assert.equal(back.skipped, undefined);
  assert.equal(sales.getSalesClientById('open').developerOwnerId, 'admin');
});

test('with the loop on, the tick makes the same writes and skips when the clients it owns are the same', async () => {
  reset(clientRows());
  // The one-time seed is done, so only the open-client assignment (which the loop scope limits) fills owners.
  writeFileSync(join(dataDir, 'developer-owner-seed.json'), JSON.stringify({ existingAssignedToAdminAt: '2026-01-01T00:00:00.000Z', assignedCount: 0 }));
  const settingsStore = await import('../data/automation-settings.js');
  const { testReleases, writeReleasesFile } = await import('./fixtures/test-releases.mjs');
  void testReleases;
  writeReleasesFile(dataDir);
  settingsStore.invalidateAutomationSettingsCache();
  const saved = settingsStore.saveAutomationSettings({ pilotClientIds: ['c000'], delivery: { loop: { enabled: true, mode: 'auto' } } }, { by: 'test' });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  settingsStore.invalidateAutomationSettingsCache();
  const settings = settingsStore.getAutomationSettings({ dataDir, fresh: true });
  const scope = loopLib.developmentGetLoopScope(() => sales.getSalesClients(), { dataDir, settings });
  assert.ok(scope.owned.has('c000'), 'the loop owns c000');
  const run = () => board.runLegacyDevelopmentWrites({ sales, hub, listDeveloperOwnerOptions: adminOnly, dataDir, settings });
  await run();
  assert.equal(sales.getSalesClientById('c000').developerOwnerId, '', 'a client the loop owns is left to the loop');
  assert.equal(sales.getSalesClientById('c001').developerOwnerId, 'admin');
  await run();
  const quietRun = await measure(run);
  assert.equal(quietRun.out.skipped, 'unchanged');
  assert.equal(quietRun.writes, 0);
});
