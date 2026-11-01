// seo-ops schedulers in hub safe mode (lib/seo-ops/schedulers.js): no DataForSEO request leaves the
// process. Sites that are not allow-listed do not run; allow-listed ones replay recorded fixtures;
// live calls stop at the spend cap; with safe mode off the Maps loop runs as before. A fetch spy
// replaces the global fetch and fails the test on any outbound call. Every business is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-schedulers-'));
process.env.APP_DATA_DIR = dataDir;
// Not a credential: only makes the Maps code think DataForSEO is configured. Nothing is sent.
process.env.DATAFORSEO_AUTH = Buffer.from('test-only:not-a-credential').toString('base64');
process.env.DATAFORSEO_MAPS_BUDGET_USD = '10';

const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  outbound.push(String(typeof input === 'string' ? input : input?.url || input));
  throw new Error('outbound call in a safe-mode test');
};
test.after(() => {
  globalThis.fetch = realFetch;
});

const SITES = [
  { id: 'id-a', site_key: 'site-a', name: 'Eksempel Verksted AS', domain: 'verksted.example.com', websitePlan: 'tier-2-seo' },
  { id: 'id-b', site_key: 'site-b', name: 'Testbakeriet', domain: 'bakeri.example.com', websitePlan: 'tier-3-ecommerce' },
  { id: 'id-c', site_key: 'site-c', name: 'Demo Frisør', domain: 'frisor.example.com', websitePlan: 'tier-2-seo' },
];
const profile = (n, site, address) => ({
  businessId: `biz-${n}`,
  userId: `user-${n}`,
  email: `post${n}@example.com`,
  businessName: site.name,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: `2026-10-0${n}T10:00:00.000Z`,
  clientDataBank: {
    generalInfo: { companyName: site.name, websiteUrl: `https://${site.domain}/`, companyAddress: address },
    websiteCreatorQuestions: { town: 'Eksempelby', importantKeywords: ['verksted eksempelby'] },
  },
});
writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(SITES));
writeFileSync(join(dataDir, 'client-portal-profiles.json'), JSON.stringify([
  profile(1, SITES[0], 'Eksempelveien 1, 0001 Eksempelby'),
  profile(2, SITES[1], 'Prøvegata 2, 0002 Eksempelby'),
  profile(3, SITES[2], 'Demogata 3, 0003 Eksempelby'),
]));

const safeMode = await import('../lib/safe-mode.js');
const { createSeoOpsStore } = await import('../lib/seo-ops/store.js');
const { createSeoSchedulerRegistry, seoScheduler, dfsFixtureName } = await import('../lib/seo-ops/schedulers.js');
const { runDueMapsRankingJobs } = await import('../lib/maps-ranking-scheduler.js');

const store = createSeoOpsStore();
async function allow(sites, extra = {}) {
  await store.updateGlobal('settings', (draft) => {
    draft.safeMode = { ...draft.safeMode, allowSites: sites, live: false, ...extra };
  });
}
function rankedIds() {
  try {
    return Object.keys(JSON.parse(readFileSync(join(dataDir, 'client-maps-ranking.json'), 'utf8'))).sort();
  } catch {
    return [];
  }
}

safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: 'mapsRanking' }, dataDir, log: null, egress: false });

test('safe mode with nothing allow-listed: the Maps loop ranks no site and makes no call', async () => {
  assert.equal(safeMode.isSafeModeActive(), true);
  await allow([]);
  const result = await runDueMapsRankingJobs({ limit: 100 });
  assert.equal(result.ran, 0);
  assert.deepEqual(outbound, []);
  assert.deepEqual(rankedIds(), []);
});

test('an allow-listed site replays the recorded fixture; the others do not run; 0 DataForSEO calls', async () => {
  await allow(['site-a']);
  const replayed = [];
  const result = await runDueMapsRankingJobs({ limit: 100, scheduler: seoScheduler('rank-tracker.maps', { onCall: (call) => replayed.push(call.url) }) });
  assert.equal(result.ran, 1);
  assert.deepEqual(outbound, [], 'nothing left the process');
  assert.ok(replayed.some((url) => url.includes('api.dataforseo.com/v3/serp/google/maps/live/advanced')));
  assert.deepEqual(rankedIds(), ['biz-1']);
  const record = JSON.parse(readFileSync(join(dataDir, 'client-maps-ranking.json'), 'utf8'))['biz-1'];
  const snapshot = record.snapshots.at(-1);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.queries[0].found, true, 'the fixture holds the site');
  assert.equal(snapshot.queries[0].position, 1);
  assert.equal(snapshot.queries[0].costUsd, 0, 'a replay costs nothing');
});

test('a simulated day of hourly ticks in safe mode makes 0 DataForSEO calls', async () => {
  await allow(['site-a', 'site-c']);
  const replayed = [];
  for (let hour = 0; hour < 24; hour += 1) {
    await runDueMapsRankingJobs({ limit: 1, scheduler: seoScheduler('rank-tracker.maps', { onCall: (call) => replayed.push(call.url) }) });
  }
  assert.deepEqual(outbound, []);
  assert.deepEqual(rankedIds(), ['biz-1', 'biz-3'], 'site-b is never allow-listed');
  const spend = JSON.parse(readFileSync(join(dataDir, 'dataforseo-maps-spend.json'), 'utf8'));
  assert.equal(spend.totalUsd, 0);
});

test('live calls in safe mode stop at the spend cap', async () => {
  const calls = [];
  const dfs = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.002, result: [{ items: [] }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const settings = { safeMode: { allowSites: ['site-a'], live: true, spendCapUsd: 0.003 } };
  const registry = createSeoSchedulerRegistry({ settings, safeMode: true, fetchImpl: dfs });
  const plan = registry.planFor('rank-tracker.maps', 'site-a');
  assert.equal(plan.live, true);
  const url = 'https://api.dataforseo.com/v3/serp/google/maps/live/advanced';
  await plan.fetchImpl(url, { method: 'POST', body: '[]' });
  await plan.fetchImpl(url, { method: 'POST', body: '[]' });
  await assert.rejects(plan.fetchImpl(url, { method: 'POST', body: '[]' }), (error) => error.code === 'safe-mode-cap');
  assert.equal(calls.length, 2);
  assert.equal(registry.spentUsd('rank-tracker.maps'), 0.004);
  assert.equal(registry.planFor('rank-tracker.maps', 'site-b').run, false);
  assert.deepEqual(outbound, []);
});

test('per-scheduler lists and caps override the shared ones', () => {
  const registry = createSeoSchedulerRegistry({
    safeMode: true,
    settings: { safeMode: { allowSites: ['site-a'], spendCapUsd: 1, schedulers: { 'rank-tracker.maps': { allowSites: ['site-b'], spendCapUsd: 0.5 } } } },
  });
  assert.deepEqual(registry.get('rank-tracker.maps').allowSites, ['site-b']);
  assert.equal(registry.get('rank-tracker.maps').spendCapUsd, 0.5);
  assert.deepEqual(registry.get('report').allowSites, ['site-a']);
  assert.equal(registry.planFor('rank-tracker.maps', 'site-a').run, false);
  assert.equal(registry.planFor('rank-tracker.maps', 'site-b').replay, true);
  assert.equal(registry.planFor('no-such-loop', 'site-b').run, false);
  assert.ok(registry.list().length >= 8);
  assert.equal(dfsFixtureName('/v3/serp/google/maps/live/advanced'), 'serp__google__maps__live__advanced.json');
});

test('with safe mode off every site runs as before and no seo-ops settings are read', () => {
  mkdirSync(join(dataDir, 'seo-ops'), { recursive: true });
  writeFileSync(join(dataDir, 'seo-ops', 'settings.json'), '{ broken');
  const off = createSeoSchedulerRegistry({ safeMode: false });
  const plan = off.planFor('rank-tracker.maps', 'any-site');
  assert.equal(plan.run, true);
  assert.equal(plan.live, true);
  assert.equal(plan.fetchImpl, undefined, 'the loop keeps the default fetch');
  const on = createSeoSchedulerRegistry({ safeMode: true });
  assert.equal(on.planFor('rank-tracker.maps', 'site-a').run, false, 'an unreadable settings file allows nothing');
});
