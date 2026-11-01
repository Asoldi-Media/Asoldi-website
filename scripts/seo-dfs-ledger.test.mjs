// The hub's DataForSEO ledger (lib/seo-ops/dfs-ledger.js): soft caps per month, purpose and site
// and the balance floor alert and never stop; months roll over; a refused booking is an error; with
// seo.dfsLedger off nothing is booked; the Maps lifetime env cap still stops a call. No request
// leaves the process: every DataForSEO answer comes from a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-dfs-ledger-'));
process.env.APP_DATA_DIR = dataDir;

const { createSeoOpsStore, defaultSeoOpsSettings } = await import('../lib/seo-ops/store.js');
const ledgerMod = await import('../lib/seo-ops/dfs-ledger.js');
const { createDfsLedger, bookDfsSpendIfEnabled, dfsLedgerErrors, resetDfsLedgerErrorsForTests, setSharedDfsLedgerForTests } = ledgerMod;
const { saveAutomationSettings, invalidateAutomationSettingsCache } = await import('../data/automation-settings.js');
const { fetchGoogleMapsSerp } = await import('../lib/dataforseo-maps.js');
const { noteSerpSpend } = await import('../lib/dataforseo-serp.js');

const quiet = { warn() {}, error() {}, log() {} };

function settingsWith(budgets = {}, extra = {}) {
  const base = defaultSeoOpsSettings();
  return { ...base, ...extra, budgets: { ...base.budgets, ...budgets, byPurpose: { ...base.budgets.byPurpose, ...(budgets.byPurpose || {}) }, perSiteMonthlyUsd: { ...base.budgets.perSiteMonthlyUsd, ...(budgets.perSiteMonthlyUsd || {}) } } };
}

function clockAt(iso) {
  const state = { now: new Date(iso) };
  return { state, now: () => state.now };
}

function fixtureLedger({ iso = '2025-10-15T12:00:00.000Z', settings = settingsWith(), alerts = [] } = {}) {
  const clock = clockAt(iso);
  const store = createSeoOpsStore({ now: clock.now, backupKeep: 0 });
  const ledger = createDfsLedger({ store, now: clock.now, settings, onAlert: (alert) => alerts.push(alert), log: quiet });
  return { ledger, store, clock, alerts };
}

function setLedgerSwitch(enabled) {
  const saved = saveAutomationSettings({ seo: { dfsLedger: { enabled } } }, { by: 'test' });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  invalidateAutomationSettingsCache();
}

test('reaching the monthly cap alerts once and every booking still goes through', async () => {
  const alerts = [];
  const { ledger, store } = fixtureLedger({ settings: settingsWith({ monthlyUsd: 0.01 }), alerts });
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(await ledger.book({ purpose: 'maps', costUsd: 0.004, endpoint: 'serp/google/maps/live/advanced' }));
  assert.ok(results.every((row) => row.ok));
  assert.deepEqual(alerts.map((alert) => alert.key), ['monthly'], 'one alert, at the booking that reached 100 %');
  assert.equal(results[2].alerts.length, 1);
  const doc = store.readLedger('2025-10');
  assert.equal(doc.totals.usd, 0.02);
  assert.equal(doc.totals.calls, 5);
  assert.equal(doc.entries.length, 5);
  const reserve = ledger.reserve({ purpose: 'maps', estUsd: 0.004 });
  assert.equal(reserve.allowed, true, 'the ledger never refuses');
  assert.ok(reserve.over.includes('monthly'));
});

test('a purpose at its cap alerts for that purpose only', async () => {
  const alerts = [];
  const { ledger } = fixtureLedger({ iso: '2025-09-10T08:00:00.000Z', settings: settingsWith({ monthlyUsd: 100, byPurpose: { maps: 0.005, infokort: 1 } }), alerts });
  await ledger.book({ purpose: 'maps', costUsd: 0.003 });
  await ledger.book({ purpose: 'infokort', costUsd: 0.003 });
  await ledger.book({ purpose: 'maps', costUsd: 0.003 });
  assert.deepEqual(alerts.map((alert) => alert.key), ['purpose:maps']);
  assert.deepEqual(ledger.reserve({ purpose: 'infokort', estUsd: 0.002 }).over, []);
  assert.deepEqual(ledger.reserve({ purpose: 'maps', estUsd: 0.002 }).over, ['purpose:maps']);
});

test('per-site caps follow the tier', async () => {
  const alerts = [];
  const { ledger, store } = fixtureLedger({ iso: '2025-08-10T08:00:00.000Z', settings: settingsWith({ monthlyUsd: 100, byPurpose: { maps: 100 }, perSiteMonthlyUsd: { 'tier-2-seo': 0.15 } }), alerts });
  await ledger.book({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', costUsd: 0.1 });
  await ledger.book({ purpose: 'maps', siteKey: 'site-b', tierId: 'tier-2-seo', costUsd: 0.1 });
  assert.deepEqual(alerts, []);
  await ledger.book({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', costUsd: 0.06 });
  assert.deepEqual(alerts.map((alert) => alert.key), ['site:site-a']);
  // A site without a known tier has no per-site cap.
  await ledger.book({ purpose: 'maps', siteKey: 'site-c', costUsd: 5 });
  assert.deepEqual(alerts.map((alert) => alert.key), ['site:site-a']);
  assert.deepEqual(store.readLedger('2025-08').totals.bySite, { 'site-a': 0.16, 'site-b': 0.1, 'site-c': 5 });
});

test('months roll over: a new month starts at zero and alerts again', async () => {
  const alerts = [];
  const { ledger, store, clock } = fixtureLedger({ iso: '2025-05-31T23:59:00.000Z', settings: settingsWith({ monthlyUsd: 0.005 }), alerts });
  await ledger.book({ purpose: 'tracking', costUsd: 0.006 });
  clock.state.now = new Date('2025-06-01T00:01:00.000Z');
  const reserve = ledger.reserve({ purpose: 'tracking', estUsd: 0.001 });
  assert.deepEqual(reserve.over, [], 'June starts empty');
  await ledger.book({ purpose: 'tracking', costUsd: 0.006 });
  assert.equal(store.readLedger('2025-06').totals.usd, 0.006);
  assert.deepEqual(alerts.map((alert) => [alert.key, alert.at.slice(0, 7)]), [['monthly', '2025-05'], ['monthly', '2025-06']]);
});

test('the shared balance floor alerts when the known balance drops below it', async () => {
  const alerts = [];
  const { ledger } = fixtureLedger({ iso: '2025-07-05T08:00:00.000Z', settings: settingsWith({ monthlyUsd: 100, byPurpose: { maps: 100 } }, { balanceFloorUsd: 5 }), alerts });
  assert.deepEqual(await ledger.noteBalance(5.03), { ok: true });
  await ledger.book({ purpose: 'maps', costUsd: 0.02 });
  assert.deepEqual(alerts, []);
  assert.ok(ledger.reserve({ purpose: 'maps', estUsd: 0.02 }).over.includes('balance-floor'));
  await ledger.book({ purpose: 'maps', costUsd: 0.02 });
  assert.deepEqual(alerts.map((alert) => alert.key), ['balance-floor']);
  assert.equal(ledger.summary('2025-07').balance.usd, 4.99);
});

test('refused bookings are reported as errors, never dropped silently', async () => {
  resetDfsLedgerErrorsForTests();
  const errors = [];
  const clock = clockAt('2025-10-15T12:00:00.000Z');
  const ledger = createDfsLedger({ store: createSeoOpsStore({ now: clock.now, backupKeep: 0 }), now: clock.now, settings: settingsWith(), log: { warn() {}, error: (line) => errors.push(line) } });
  const old = await ledger.book({ purpose: 'maps', costUsd: 0.002, at: '2024-01-15T00:00:00.000Z' });
  assert.equal(old.ok, false);
  assert.equal(old.error, 'invalid-key');
  const future = await ledger.book({ purpose: 'maps', costUsd: 0.002, at: '2027-06-01T00:00:00.000Z' });
  assert.equal(future.error, 'invalid-key');
  const purpose = await ledger.book({ purpose: 'nonsense', costUsd: 0.002 });
  assert.equal(purpose.error, 'invalid-purpose');
  assert.deepEqual(dfsLedgerErrors(), { 'invalid-key': 2, 'invalid-purpose': 1 });
  assert.equal(errors.length, 3);
  assert.ok(errors.every((line) => line.includes('booking error')));
});

function dfsStub(calls, cost = 0.002) {
  return async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      status: 200,
      json: async () => ({ status_code: 20000, cost, tasks: [{ status_code: 20000, cost, result: [{ items: [], check_url: '', datetime: '2026-10-15 12:00:00 +00:00' }] }] }),
    };
  };
}

const ENV = { DATAFORSEO_AUTH: Buffer.from('test-only:not-a-credential').toString('base64') };

test('negative control: with seo.dfsLedger off a Maps call books nothing in the seo-ops ledger', async () => {
  setLedgerSwitch(false);
  setSharedDfsLedgerForTests(null);
  const calls = [];
  await fetchGoogleMapsSerp({ keyword: 'switch off keyword', location_name: 'Eksempelby,Norway' }, { env: { ...ENV, DATAFORSEO_MAPS_BUDGET_USD: '10' }, fetchImpl: dfsStub(calls), ledger: { siteKey: 'site-off' } });
  assert.equal(calls.length, 1);
  assert.equal(bookDfsSpendIfEnabled({ purpose: 'maps', costUsd: 1 }), null);
  const month = new Date().toISOString().slice(0, 7);
  const doc = existsSync(join(dataDir, 'seo-ops', `dfs-ledger-${month}.json`)) ? createSeoOpsStore().readLedger(month) : null;
  assert.equal((doc?.entries || []).some((row) => row.siteKey === 'site-off'), false, 'nothing booked for the call');
});

test('with seo.dfsLedger on, Maps ranking and Infokort spend are booked by purpose and site', async () => {
  setLedgerSwitch(true);
  setSharedDfsLedgerForTests(null);
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify([{ id: 'site-id-a', site_key: 'site-on', name: 'Eksempel Verksted', domain: 'verksted.example.com', websitePlan: 'tier-2-seo' }]));
  const calls = [];
  await fetchGoogleMapsSerp({ keyword: 'switch on keyword', location_name: 'Eksempelby,Norway' }, { env: { ...ENV, DATAFORSEO_MAPS_BUDGET_USD: '10' }, fetchImpl: dfsStub(calls, 0.0021), ledger: { siteKey: 'site-on' } });
  const booking = bookDfsSpendIfEnabled({ purpose: 'infokort', costUsd: 0.002, endpoint: 'serp/google/organic' });
  assert.ok(booking, 'the switch is on');
  assert.equal((await booking).ok, true);
  // noteSerpSpend books the Infokort search itself when it persists.
  noteSerpSpend({ at: new Date().toISOString(), endpoint: 'maps', query: 'eksempel', costUsd: 0.002 }, { persist: true });
  let summary = null;
  for (let i = 0; i < 60; i += 1) {
    summary = createDfsLedger({ log: quiet }).summary();
    if (summary.totals.byPurpose.infokort === 0.004 && summary.totals.byPurpose.maps) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(summary.totals.byPurpose.maps, 0.0021);
  assert.equal(summary.totals.byPurpose.infokort, 0.004);
  assert.equal(summary.totals.bySite['site-on'], 0.0021);
  const entry = createSeoOpsStore().readLedger(summary.month).entries.find((row) => row.purpose === 'maps');
  assert.equal(entry.tierId, 'tier-2-seo', 'the tier comes from the hub site');
  setLedgerSwitch(false);
});

test('the Maps lifetime env cap is still the stop, with the ledger on or off', async () => {
  writeFileSync(join(dataDir, 'dataforseo-maps-spend.json'), JSON.stringify({ totalUsd: 0.0285, calls: [] }));
  for (const enabled of [false, true]) {
    setLedgerSwitch(enabled);
    const calls = [];
    await assert.rejects(
      fetchGoogleMapsSerp({ keyword: `cap keyword ${enabled}`, location_name: 'Eksempelby,Norway' }, { env: { ...ENV, DATAFORSEO_MAPS_BUDGET_USD: '0.03' }, fetchImpl: dfsStub(calls) }),
      (error) => error.code === 'budget',
    );
    assert.equal(calls.length, 0, 'no call past the lifetime cap');
  }
  // Under the env cap the ledger's own caps never stop a call, even far past 100 %.
  setLedgerSwitch(true);
  const tiny = createSeoOpsStore();
  await tiny.updateGlobal('settings', (draft) => { draft.budgets = { ...draft.budgets, monthlyUsd: 0, byPurpose: { ...draft.budgets.byPurpose, maps: 0 } }; });
  setSharedDfsLedgerForTests(null);
  const calls = [];
  const result = await fetchGoogleMapsSerp({ keyword: 'over soft cap', location_name: 'Eksempelby,Norway' }, { env: { ...ENV, DATAFORSEO_MAPS_BUDGET_USD: '10' }, fetchImpl: dfsStub(calls) });
  assert.equal(calls.length, 1);
  assert.equal(result.cached, false);
  setLedgerSwitch(false);
});
