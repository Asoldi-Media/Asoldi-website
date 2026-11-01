// Delivery loop: switch, scope, per-client modes, step contract, leases, restart safety, the
// development GET split and tick cost. Temp data dirs only; nothing leaves the machine.
//
// Run: node --test scripts/delivery-loop.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-delivery-loop-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';
process.env.PERSIST_PRODUCTION_ENV = '0';

const loopLib = await import('../lib/delivery-loop.js');
const stepsLib = await import('../lib/delivery-steps.js');
const sales = await import('../data/sales.js');
const hub = await import('../data/hub.js');
const settingsStore = await import('../data/automation-settings.js');
const { readDeliveryAudit } = await import('../lib/delivery-audit.js');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');

const temps = [dataDir];
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const quiet = { warn() {}, error() {}, log() {} };
const signed = { meetingHeld: true, offerSent: true, contractSigned: true };
const T0 = Date.parse('2026-11-02T09:00:00.000Z');

function setSettings(patch) {
  rmSync(join(dataDir, 'automation-settings.json'), { force: true });
  settingsStore.invalidateAutomationSettingsCache();
  const result = settingsStore.saveAutomationSettings(patch, { by: 'test' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  settingsStore.invalidateAutomationSettingsCache();
}

function resetData() {
  for (const name of readdirSync(dataDir)) rmSync(join(dataDir, name), { recursive: true, force: true });
  clearJsonCacheForTests();
  loopLib.resetDeliveryLoopForTests();
}

function seed({ clients = [], sites = [] } = {}) {
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify(clients, null, 2));
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(sites, null, 2));
  sales.getSalesClients(); // the store's own one-time migrations write here, before any tick
}

/** { relativePath: mtimeMs } for every file under dir (the lease lock folder left out). */
function fileTimes(dir, { skip = ['email-locks'] } = {}) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(dir, path).replace(/\\/g, '/');
      if (skip.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      if (entry.isDirectory()) walk(path);
      else out[rel] = statSync(path).mtimeMs;
    }
  };
  walk(dir);
  return out;
}

function makeLoop(extra = {}) {
  return loopLib.createDeliveryLoop({ sales, hub, log: quiet, listDeveloperOwnerOptions: async () => [{ accountKey: 'admin' }], ...extra });
}

function clientsFixture(count, { prefix = 'c', signedEvery = 1 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${String(index).padStart(3, '0')}`,
    product: 'asoldi',
    businessName: `Eksempel ${index} AS`,
    status: 'active',
    progression: index % signedEvery === 0 ? signed : { meetingHeld: true },
    contractSignedAt: '2026-10-01T10:00:00.000Z',
    hubSite: { id: `site-${index}`, siteKey: `key-${index}` },
    createdAt: '2026-09-01T10:00:00.000Z',
  }));
}

function sitesFixture(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `site-${index}`, site_key: `key-${index}`, name: `Site ${index}`, domain: `site-${index}.example`, createdAt: '2026-09-01T10:00:00.000Z' }));
}

// ── switch off ───────────────────────────────────────────────────────────────

test('switch off: a tick returns at once, takes no lease and writes nothing; markDirty is a no-op', async () => {
  resetData();
  seed({ clients: clientsFixture(5), sites: sitesFixture(5) });
  const before = fileTimes(dataDir, { skip: [] });
  const loop = makeLoop();
  const result = await loop.tick({ now: T0 });
  assert.deepEqual(result, { ran: false, reason: 'disabled' });
  assert.equal(loopLib.markDirty('c001', { now: T0 }), false);
  assert.deepEqual(fileTimes(dataDir, { skip: [] }), before, 'no file was created or touched (no lease, no health, no dirty mark)');
  assert.equal(existsSync(join(dataDir, 'email-locks')), false);
  assert.equal(existsSync(join(dataDir, 'delivery-hot')), false);
  const scope = loopLib.developmentGetLoopScope(() => assert.fail('the client list is not read while the loop is off'));
  assert.equal(scope.reconcile, undefined);
  assert.equal(scope.owners, undefined);
});

// ── scope and modes ──────────────────────────────────────────────────────────

test('clientInLoopScope: signed, dirty and nurtured website clients only', () => {
  assert.equal(loopLib.clientInLoopScope({ id: 'a', progression: signed }), 'signed');
  assert.equal(loopLib.clientInLoopScope({ id: 'a', sitePlan: { status: 'active' } }), 'signed');
  assert.equal(loopLib.clientInLoopScope({ id: 'a', product: 'ssu', progression: signed }), '');
  assert.equal(loopLib.clientInLoopScope({ id: 'b' }, { b: '2026-11-01T00:00:00.000Z' }), 'dirty');
  assert.equal(loopLib.clientInLoopScope({ id: 'c', nurture: { state: 'deferred' } }), 'nurture');
  assert.equal(loopLib.clientInLoopScope({ id: 'c', nurture: { state: 'deferred', stopReason: 'replied' } }), '');
  assert.equal(loopLib.clientInLoopScope({ id: 'd', progression: { meetingHeld: true } }), '');
});

test('a non-pilot in auto writes nothing; the pilot gets its stage, site phase and owner', async () => {
  resetData();
  const clients = [
    { id: 'pilot-1', product: 'asoldi', businessName: 'Pilot AS', status: 'active', progression: signed, development: { nettsideFerdig: true }, hubSite: { id: 'site-p', siteKey: 'key-p' } },
    { id: 'other-1', product: 'asoldi', businessName: 'Annen AS', status: 'active', progression: signed, development: { nettsideFerdig: true }, hubSite: { id: 'site-o', siteKey: 'key-o' } },
  ];
  const sites = [
    { id: 'site-p', site_key: 'key-p', name: 'Pilot', domain: 'pilot.example', deliveryPhase: 'development', createdAt: '2026-09-01T10:00:00.000Z' },
    { id: 'site-o', site_key: 'key-o', name: 'Annen', domain: 'annen.example', deliveryPhase: 'development', createdAt: '2026-09-01T10:00:00.000Z' },
  ];
  seed({ clients, sites });
  setSettings({ pilotClientIds: ['pilot-1'], delivery: { loop: { enabled: true, mode: 'auto' } } });
  // One store write first, so the comparison is between two normalized records.
  sales.updateSalesClient('pilot-1', {});
  const otherBefore = JSON.stringify(sales.getSalesClientById('other-1'));
  const siteOtherBefore = JSON.stringify(hub.getAllSites().find((site) => site.id === 'site-o'));
  const loop = makeLoop();
  const result = await loop.tick({ now: T0 });
  assert.equal(result.ran, true);
  assert.equal(result.mode, 'auto');
  const pilot = sales.getSalesClientById('pilot-1');
  assert.equal(pilot.delivery.stage, 'signed');
  assert.equal(pilot.developerOwnerId, 'admin');
  assert.equal(hub.getAllSites().find((site) => site.id === 'site-p').deliveryPhase, 'client', 'the pilot site was reconciled');
  assert.equal(JSON.stringify(sales.getSalesClientById('other-1')), otherBefore, 'the non-pilot record is unchanged');
  assert.equal(JSON.stringify(hub.getAllSites().find((site) => site.id === 'site-o')), siteOtherBefore, 'the non-pilot site is untouched');
  const shadow = readDeliveryAudit({ month: '2026-11' }).filter((row) => row.kind === 'loop-shadow');
  assert.deepEqual(shadow.map((row) => [row.clientId, row.step, row.to]), [['other-1', 'stage', 'signed']]);
  await loop.tick({ now: T0 + 60_000 });
  assert.equal(readDeliveryAudit({ month: '2026-11' }).filter((row) => row.kind === 'loop-shadow').length, 1, 'an unchanged shadow outcome is recorded once');
});

test('auto with an empty pilot list runs everyone in shadow: no client is written', async () => {
  resetData();
  seed({ clients: clientsFixture(4), sites: sitesFixture(4) });
  // Validation refuses this, so write the file the way an older build or a hand edit could.
  writeFileSync(join(dataDir, 'automation-settings.json'), JSON.stringify({ version: 2, pilotClientIds: [], delivery: { loop: { enabled: true, mode: 'auto', paused: null } } }));
  settingsStore.invalidateAutomationSettingsCache();
  const before = readFileSync(join(dataDir, 'sales-clients.json'), 'utf8');
  const result = await makeLoop().tick({ now: T0 });
  assert.equal(result.mode, 'shadow');
  assert.equal(readFileSync(join(dataDir, 'sales-clients.json'), 'utf8'), before);
  assert.equal(readDeliveryAudit({ month: '2026-11' }).filter((row) => row.kind === 'loop-shadow').length, 4);
});

test('settings refuse delivery.loop auto without pilots', () => {
  const refused = settingsStore.validateAutomationSettings({ delivery: { loop: { enabled: true, mode: 'auto' } } });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.errors.map((error) => error.path), ['delivery.loop.mode']);
  assert.equal(settingsStore.validateAutomationSettings({ delivery: { loop: { enabled: true, mode: 'shadow' } } }).ok, true);
  assert.equal(settingsStore.validateAutomationSettings({ pilotClientIds: ['p1'], delivery: { loop: { enabled: true, mode: 'auto' } } }).ok, true);
  assert.equal(settingsStore.validateAutomationSettings({ delivery: { loop: { mode: 'sometimes' } } }).ok, false);
  assert.equal(settingsStore.defaultAutomationSettings().delivery.loop.enabled, false, 'off by default');
});

// ── tick cost and quiet ticks ────────────────────────────────────────────────

test('a 200-client tick takes under 2 s, and an unchanged tick touches no file', async () => {
  resetData();
  seed({ clients: clientsFixture(200, { signedEvery: 2 }), sites: sitesFixture(200) });
  const pilots = Array.from({ length: 100 }, (_, index) => `c${String(index * 2).padStart(3, '0')}`);
  setSettings({ pilotClientIds: pilots, delivery: { loop: { enabled: true, mode: 'auto' } } });
  const loop = makeLoop();
  const first = await loop.tick({ now: T0 });
  assert.equal(first.ran, true);
  assert.equal(first.clients, 100, 'the 100 signed clients are in scope');
  assert.ok(first.durationMs < 2000, `first tick took ${first.durationMs} ms`);
  const before = fileTimes(dataDir);
  const second = await loop.tick({ now: T0 + 60_000 });
  assert.ok(second.durationMs < 2000, `second tick took ${second.durationMs} ms`);
  assert.equal(second.wrote, false);
  assert.deepEqual(fileTimes(dataDir), before, 'only the lease lock files change on a quiet tick');
  assert.ok(existsSync(join(dataDir, 'delivery-hot', 'loop-health.json')), 'the first tick wrote loop health');
});

test('loop health is written at most every 5 minutes and feeds hubLoopLastTickAt', async () => {
  resetData();
  seed({ clients: clientsFixture(2) });
  setSettings({ delivery: { loop: { enabled: true, mode: 'shadow' } } });
  const meta = await import('../lib/maker-host-meta.js');
  let clock = T0;
  const loop = makeLoop({ now: () => clock });
  await loop.tick({ now: T0 });
  clearJsonCacheForTests();
  assert.equal(meta.readHubLoopLastTickAt({ dataDir }), new Date(T0).toISOString());
  const path = join(dataDir, 'delivery-hot', 'loop-health.json');
  const firstWrite = statSync(path).mtimeMs;
  clock = T0 + 2 * 60_000;
  await loop.tick({ now: clock });
  assert.equal(statSync(path).mtimeMs, firstWrite, 'not again within 5 minutes');
  clock = T0 + 6 * 60_000;
  await new Promise((r) => setTimeout(r, 20));
  await loop.tick({ now: clock });
  clearJsonCacheForTests();
  assert.equal(meta.readHubLoopLastTickAt({ dataDir }), new Date(clock).toISOString());
  assert.equal(loop.health().ticks, 3);
});

// ── leases and restarts ──────────────────────────────────────────────────────

test('two loop processes on one data dir never tick at the same time', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'asoldi-delivery-race-'));
  temps.push(shared);
  writeFileSync(join(shared, 'automation-settings.json'), JSON.stringify({ version: 2, delivery: { loop: { enabled: true, mode: 'shadow', paused: null } } }));
  const run = promisify(execFile);
  const child = join(root, 'scripts', 'fixtures', 'delivery-loop-race-child.mjs');
  const env = { ...process.env, APP_DATA_DIR: shared, DATA_DIR: '', PERSIST_PRODUCTION_ENV: '0' };
  const outputs = await Promise.all([run(process.execPath, [child, '8'], { env, cwd: root }), run(process.execPath, [child, '8'], { env, cwd: root })]);
  const reports = outputs.map(({ stdout }) => JSON.parse(stdout.trim().split('\n').at(-1)));
  const ran = reports.flatMap((report) => report.results).filter((value) => value === 'ran').length;
  const skipped = reports.flatMap((report) => report.results).filter((value) => value === 'lease-held').length;
  assert.ok(ran >= 2, `ticks ran: ${ran}`);
  assert.ok(skipped >= 1, 'the processes did contend for the lease');
  const edges = readFileSync(join(shared, 'race-log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).sort((a, b) => a.at - b.at);
  let open = null;
  for (const edge of edges) {
    if (edge.edge === 'start') {
      assert.equal(open, null, 'a tick started while another one was running');
      open = edge.pid;
    } else {
      assert.equal(edge.pid, open);
      open = null;
    }
  }
  assert.equal(edges.filter((edge) => edge.edge === 'start').length, ran);
});

test('a restart loses no work: dirty marks and step schedules survive, failed clients stay dirty', async () => {
  resetData();
  seed({ clients: [{ id: 'lead-1', product: 'asoldi', businessName: 'Lead AS', status: 'active', progression: { meetingHeld: true } }] });
  setSettings({ delivery: { loop: { enabled: true, mode: 'shadow' } } });
  assert.equal(loopLib.markDirty('lead-1', { now: T0 }), true);
  assert.equal(loopLib.markDirty('lead-1', { now: T0 + 1 }), true, 'marking again keeps the first mark');
  const seen = [];
  let failing = true;
  let daily = 0;
  const steps = [
    { name: 'flaky', scope: 'client', run: async (_ctx, client) => { seen.push(client.id); if (failing) throw new Error('step crashed'); return { wrote: false }; } },
    { name: 'daily', scope: 'global', everyMs: 24 * 60 * 60 * 1000, run: async () => { daily += 1; return { wrote: false }; } },
  ];
  const first = await makeLoop({ steps }).tick({ now: T0 });
  assert.equal(first.errors, 1);
  assert.deepEqual(Object.keys(loopLib.readDirtyMarks({ fresh: true })), ['lead-1'], 'the mark stays after a failed step');
  assert.equal(daily, 1);
  // "Restart": a new loop with no memory of the first one.
  failing = false;
  const second = await makeLoop({ steps }).tick({ now: T0 + 60_000 });
  assert.equal(second.errors, 0);
  assert.deepEqual(seen, ['lead-1', 'lead-1'], 'the dirty client was picked up again after the restart');
  assert.deepEqual(loopLib.readDirtyMarks({ fresh: true }), {}, 'cleared once the work succeeded');
  assert.equal(daily, 1, 'the daily step does not run twice in a day across a restart');
  await makeLoop({ steps }).tick({ now: T0 + 25 * 60 * 60 * 1000 });
  assert.equal(daily, 2);
  await makeLoop({ steps }).tick({ now: T0 + 26 * 60 * 60 * 1000 });
  assert.deepEqual(seen, ['lead-1', 'lead-1'], 'an unmarked lead is not in scope');
});

test('paused: only steps marked whenPaused run', async () => {
  resetData();
  seed({ clients: clientsFixture(2) });
  setSettings({ delivery: { loop: { enabled: true, mode: 'shadow', paused: { reason: 'maintenance' } } } });
  const ran = [];
  const steps = [
    { name: 'normal', scope: 'global', run: async () => { ran.push('normal'); return {}; } },
    { name: 'per-client', scope: 'client', run: async () => { ran.push('client'); return {}; } },
    { name: 'watch', scope: 'global', whenPaused: true, run: async (ctx) => { ran.push(`watch:${ctx.mode}`); return {}; } },
  ];
  const result = await makeLoop({ steps }).tick({ now: T0 });
  assert.equal(result.mode, 'paused');
  assert.deepEqual(ran, ['watch:paused']);
});

// ── step contract ────────────────────────────────────────────────────────────

test('step contract: bad steps are refused; missing modules are simply absent', async () => {
  assert.throws(() => stepsLib.assertTickStep({ name: 'Bad Name', scope: 'global', run() {} }), /name/);
  assert.throws(() => stepsLib.assertTickStep({ name: 'x', scope: 'site', run() {} }), /scope/);
  assert.throws(() => stepsLib.assertTickStep({ name: 'x', scope: 'client' }), /run/);
  assert.throws(() => stepsLib.assertTickStep({ name: 'x', scope: 'client', everyMs: -1, run() {} }), /everyMs/);
  assert.deepEqual(stepsLib.TICK_STEP_MODULES, [
    './delivery-gate.js',
    './delivery-brief/index.js',
    './delivery-retention.js',
    './delivery-jobs.js',
    './delivery-emails.js',
    './delivery-alerts.js',
    './seo-ops/record.js',
  ]);
  const loaded = await stepsLib.loadTickSteps();
  assert.ok(loaded.loaded.includes('./delivery-jobs.js'));
  assert.ok(loaded.loaded.includes('./delivery-alerts.js'));
  for (const name of loaded.loaded) assert.ok(existsSync(new URL(name, new URL('../lib/', import.meta.url))));
  const fakeDir = mkdtempSync(join(tmpdir(), 'asoldi-steps-'));
  temps.push(fakeDir);
  writeFileSync(join(fakeDir, 'good.mjs'), "export const tickSteps = [{ name: 'good', scope: 'global', order: 5, run: async () => ({ wrote: false }) }];\n");
  writeFileSync(join(fakeDir, 'bad.mjs'), "export const tickSteps = [{ name: 'bad', scope: 'nowhere', run: async () => ({}) }];\n");
  const custom = await stepsLib.loadTickSteps({ modules: ['./good.mjs', './bad.mjs', './missing.mjs'], base: new URL(`file:///${fakeDir.replace(/\\/g, '/')}/`).href });
  assert.deepEqual(custom.steps.map((step) => step.name), ['good']);
  assert.deepEqual(custom.loaded, ['./good.mjs']);
  assert.equal(custom.errors.length, 1);
  assert.equal(custom.errors[0].module, './bad.mjs');
});

test('client steps get the client and its mode; global steps get the in-scope list', async () => {
  resetData();
  seed({ clients: [
    { id: 'p1', product: 'asoldi', businessName: 'P AS', status: 'active', progression: signed },
    { id: 's1', product: 'asoldi', businessName: 'S AS', status: 'active', progression: signed },
    { id: 't1', product: 'asoldi', businessName: 'T AS', status: 'active', progression: signed, isTest: true },
  ] });
  setSettings({ pilotClientIds: ['p1'], delivery: { loop: { enabled: true, mode: 'auto' } } });
  const calls = [];
  const steps = [
    { name: 'per-client', order: 10, scope: 'client', run: async (ctx, client) => { calls.push([client.id, ctx.mode]); return {}; } },
    { name: 'overview', order: 20, scope: 'global', run: async (ctx) => { calls.push(['global', ctx.clients.map((row) => `${row.client.id}:${row.mode}`).sort().join(',')]); return {}; } },
  ];
  await makeLoop({ steps }).tick({ now: T0 });
  const perClient = calls.filter((row) => row[0] !== 'global').sort();
  assert.deepEqual(perClient, [['p1', 'auto'], ['s1', 'shadow']], 'a test client that is not a pilot is skipped');
  assert.deepEqual(calls.at(-1), ['global', 'p1:auto,s1:shadow,t1:off'], 'the global step runs after the client step (order)');
});

// ── development GET split ────────────────────────────────────────────────────

test('developmentGetLoopScope: with auto pilots the GET leaves their sites and owners to the loop', () => {
  resetData();
  const clients = [
    { id: 'pilot-1', product: 'asoldi', businessName: 'Pilot AS', status: 'active', progression: signed, hubSite: { id: 'site-p', siteKey: 'key-p' } },
    { id: 'other-1', product: 'asoldi', businessName: 'Annen AS', status: 'active', progression: signed, hubSite: { id: 'site-o', siteKey: 'key-o' } },
  ];
  seed({ clients });
  setSettings({ pilotClientIds: ['pilot-1'], delivery: { loop: { enabled: true, mode: 'shadow' } } });
  const shadowScope = loopLib.developmentGetLoopScope(() => sales.getSalesClients());
  assert.equal(shadowScope.owners, undefined, 'in shadow the GET keeps doing everything');
  setSettings({ pilotClientIds: ['pilot-1'], delivery: { loop: { enabled: true, mode: 'auto' } } });
  const scope = loopLib.developmentGetLoopScope(() => sales.getSalesClients());
  assert.deepEqual([...scope.owned], ['pilot-1']);
  assert.equal(scope.owners.include({ id: 'pilot-1' }), false);
  assert.equal(scope.owners.include({ id: 'other-1' }), true);
  assert.equal(scope.reconcile.siteFilter({ id: 'site-p', site_key: 'key-p' }), false);
  assert.equal(scope.reconcile.siteFilter({ id: 'site-o', site_key: 'key-o' }), true);
  setSettings({ pilotClientIds: ['pilot-1'], delivery: { loop: { enabled: true, mode: 'auto', paused: { reason: 'checking' } } } });
  assert.equal(loopLib.developmentGetLoopScope(() => sales.getSalesClients()).owners, undefined, 'a paused loop hands everything back to the GET');
});

test('server.js wires the loop into the background plan and the development GET', () => {
  const source = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /^ {4}delivery: \(\) => startDeliveryLoop\(\{ sales, hub, listDeveloperOwnerOptions: /m);
  assert.match(source, /const loopScope = developmentGetLoopScope\(\(\) => sales\.getSalesClients\(\)\);/);
  assert.match(source, /hub\.reconcileDeliveryPhases\(sales\.getSalesClients\(\), loopScope\.reconcile\);/);
  assert.match(source, /sales\.seedExistingDeveloperOwnersToAdmin\(loopScope\.owners\);/);
  assert.match(source, /if \(onlyAdmin\) sales\.assignOpenDeveloperClientsToAdmin\(loopScope\.owners\);/);
  assert.match(source, /createMakerAuth\(\{ legacyHolder: MAKER_CALLBACK_TOKEN_HOLDER, dataDir: getPersistentDataDir\(\), onAlert: noteMakerAuthAlert \}\)/);
});

test('reconcile and owner writers keep their old behaviour without options', () => {
  resetData();
  const clients = [
    { id: 'a1', product: 'asoldi', businessName: 'A AS', status: 'active', progression: signed, development: { nettsideFerdig: true }, hubSite: { id: 'site-a', siteKey: 'key-a' } },
    { id: 'b1', product: 'asoldi', businessName: 'B AS', status: 'active', progression: signed, development: { nettsideFerdig: true }, hubSite: { id: 'site-b', siteKey: 'key-b' } },
  ];
  seed({ clients, sites: [
    { id: 'site-a', site_key: 'key-a', name: 'A', domain: 'a.example', deliveryPhase: 'development', createdAt: '2026-09-01T10:00:00.000Z' },
    { id: 'site-b', site_key: 'key-b', name: 'B', domain: 'b.example', deliveryPhase: 'development', createdAt: '2026-09-01T10:00:00.000Z' },
  ] });
  assert.equal(hub.reconcileDeliveryPhases(sales.getSalesClients(), { siteFilter: (site) => site.id === 'site-a' }).changed, 1);
  assert.equal(hub.reconcileDeliveryPhases(sales.getSalesClients()).changed, 1, 'without a filter the rest follows');
  assert.equal(sales.assignOpenDeveloperClientsToAdmin({ include: (client) => client.id === 'a1' }).assignedCount, 1);
  assert.equal(sales.getSalesClientById('b1').developerOwnerId, '');
  assert.equal(sales.assignOpenDeveloperClientsToAdmin().assignedCount, 1);
  assert.equal(sales.getSalesClientById('b1').developerOwnerId, 'admin');
});
