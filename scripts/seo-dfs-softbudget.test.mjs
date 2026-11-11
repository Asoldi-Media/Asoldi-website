// Soft-budget mode on the DataForSEO ledger. Off (the default) matches a ledger with no
// softBudget. On, a site can be refused for one purpose, or for a loop, and the monthly cap
// still only alerts. Invented site keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-softbudget-'));
process.env.APP_DATA_DIR = dataDir;

const { createSeoOpsStore, defaultSeoOpsSettings } = await import('../lib/seo-ops/store.js');
const { createDfsLedger } = await import('../lib/seo-ops/dfs-ledger.js');

const quiet = { warn() {}, error() {}, log() {} };

function settingsWith(extra = {}) {
  const base = defaultSeoOpsSettings();
  return {
    ...base,
    ...extra,
    budgets: { ...base.budgets, ...(extra.budgets || {}) },
    softBudget: extra.softBudget === undefined ? base.softBudget : extra.softBudget,
  };
}

function clockAt(iso) {
  const state = { now: new Date(iso) };
  return { state, now: () => state.now };
}

function fixtureLedger({ iso = '2026-04-15T12:00:00.000Z', settings = settingsWith() } = {}) {
  const clock = clockAt(iso);
  const alerts = [];
  const store = createSeoOpsStore({ now: clock.now, backupKeep: 0 });
  const ledger = createDfsLedger({ store, now: clock.now, settings, onAlert: (alert) => alerts.push(alert), log: quiet });
  return { ledger, store, clock, alerts };
}

const SHAPE = ['allowed', 'month', 'over', 'projected'];
const reserveArgs = { purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 0.01 };

test('the default soft budget is off', () => {
  assert.equal(defaultSeoOpsSettings().softBudget.enabled, false);
  assert.equal(defaultSeoOpsSettings().softBudget.refuseMultiple, 5);
});

test('off, or a missing softBudget, matches today: allowed, and the same fields', async () => {
  const absentSettings = settingsWith();
  delete absentSettings.softBudget;
  const off = fixtureLedger({ iso: '2026-01-15T12:00:00.000Z', settings: settingsWith() });
  const absent = fixtureLedger({ iso: '2026-01-15T12:00:00.000Z', settings: absentSettings });
  const before = off.ledger.reserve(reserveArgs);
  assert.deepEqual(before, absent.ledger.reserve(reserveArgs));
  assert.deepEqual(Object.keys(before).sort(), SHAPE);
  assert.equal(before.allowed, true);
  await off.ledger.book({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', costUsd: 50 });
  const after = off.ledger.reserve({ ...reserveArgs, estUsd: 1 });
  assert.equal(after.allowed, true);
  assert.ok(after.over.includes('monthly'));
  assert.deepEqual(after, absent.ledger.reserve({ ...reserveArgs, estUsd: 1 }));
  assert.deepEqual(Object.keys(after).sort(), SHAPE);
});

function enabledSettings(overrides = {}) {
  return settingsWith({
    budgets: { monthlyUsd: 100, byPurpose: { maps: 100 } },
    softBudget: {
      enabled: true,
      refuseMultiple: 5,
      expectedUsd: { perSiteMonthlyUsd: { 'tier-2-seo': 1 }, purposeShare: { maps: 1 } },
      loopWindowMinutes: 60,
      loopRepeats: 3,
      ...overrides,
    },
  });
}

test('from 100% up to just under 5x: one alert and still allowed; at 5x refused', async () => {
  const { ledger, store, alerts } = fixtureLedger({ iso: '2026-02-15T12:00:00.000Z', settings: enabledSettings() });
  const under = ledger.reserve({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 0.99 });
  assert.equal(under.allowed, true);
  assert.equal(under.softAlert, undefined);
  assert.deepEqual(Object.keys(under).sort(), SHAPE);

  const atCap = ledger.reserve({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 1 });
  assert.equal(atCap.allowed, true);
  assert.equal(atCap.softAlert, true);
  const near = ledger.reserve({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 4.99 });
  assert.equal(near.allowed, true);
  assert.equal(near.softAlert, true);

  const recorded = await ledger.reserveChecked({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 1 });
  assert.equal(recorded.softAlert, true);
  const again = await ledger.reserveChecked({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 4.99 });
  assert.equal(again.allowed, true);
  assert.equal(again.softAlert, undefined);
  const softAlerts = store.readLedger('2026-02').alerts.filter((alert) => alert.key === 'soft:site-a:maps');
  assert.equal(softAlerts.length, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, 'soft:site-a:maps');

  const refused = ledger.reserve({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 5 });
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, 'soft-budget-exceeded');

  // Another site is its own budget. A tier with no expected amount is left alone.
  const other = ledger.reserve({ purpose: 'maps', siteKey: 'site-b', tierId: 'tier-2-seo', estUsd: 1 });
  assert.equal(other.softAlert, true);
  const unknown = ledger.reserve({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-1-standard', estUsd: 50 });
  assert.equal(unknown.allowed, true);
  assert.equal(unknown.reason, undefined);
  assert.equal(unknown.softAlert, undefined);
});

test('a purpose share scales the expected amount', () => {
  const { ledger } = fixtureLedger({
    iso: '2026-03-15T12:00:00.000Z',
    settings: enabledSettings({ expectedUsd: { perSiteMonthlyUsd: { 'tier-2-seo': 10 }, purposeShare: { maps: 0.1 } } }),
  });
  const under = ledger.reserve({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 0.99 });
  assert.equal(under.softAlert, undefined);
  const at = ledger.reserve({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 1 });
  assert.equal(at.softAlert, true);
  assert.equal(at.allowed, true);
});

test('the same task with no progress change is refused on the third call; a new progress key resets', () => {
  const { ledger, clock } = fixtureLedger({ iso: '2026-04-15T12:00:00.000Z', settings: enabledSettings() });
  const call = (progressKey) => ledger.reserve({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 0.01, taskKey: 'rank-maps', progressKey });
  assert.equal(call('step-1').allowed, true);
  assert.equal(call('step-1').allowed, true);
  const third = call('step-1');
  assert.equal(third.allowed, false);
  assert.equal(third.reason, 'loop-detected');
  const moved = call('step-2');
  assert.equal(moved.allowed, true);
  assert.equal(moved.reason, undefined);
  clock.state.now = new Date('2026-04-15T13:01:00.000Z');
  assert.equal(call('step-2').allowed, true, 'outside the window the count starts again');
});

test('the monthly cap still only alerts when the soft budget is on', async () => {
  const { ledger } = fixtureLedger({
    iso: '2026-05-15T12:00:00.000Z',
    settings: enabledSettings({
      expectedUsd: { perSiteMonthlyUsd: { 'tier-2-seo': 100 }, purposeShare: { maps: 1 } },
    }),
  });
  const tight = fixtureLedger({
    iso: '2026-06-15T12:00:00.000Z',
    settings: settingsWith({
      budgets: { monthlyUsd: 0.01, byPurpose: { maps: 0.01 } },
      softBudget: {
        enabled: true,
        refuseMultiple: 5,
        expectedUsd: { perSiteMonthlyUsd: { 'tier-2-seo': 100 }, purposeShare: {} },
        loopWindowMinutes: 60,
        loopRepeats: 3,
      },
    }),
  });
  await tight.ledger.book({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', costUsd: 0.02 });
  const reserve = tight.ledger.reserve({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 0.01 });
  assert.equal(reserve.allowed, true);
  assert.equal(reserve.reason, undefined);
  assert.ok(reserve.over.includes('monthly'));
  assert.ok(reserve.over.includes('purpose:maps'));
  assert.equal(ledger.reserve({ purpose: 'maps', siteKey: 'site-a', tierId: 'tier-2-seo', estUsd: 0.01 }).allowed, true);
});
