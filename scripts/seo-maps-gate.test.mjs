// Paid Maps refreshes outside the hourly loop follow seo.jobGating too (ensureMapsRanking in
// lib/client-analytics-service.js): in auto, a site whose 'seo.tracking.maps' is off (here an agency
// override) makes no geocoding or DataForSEO request on a dashboard refresh or a forced refresh, and
// the dashboard still shows the stored ranking; off, shadow and a paused switch call as before.
// A fetch spy answers every request inside the process. Every business is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-maps-gate-'));
process.env.APP_DATA_DIR = dataDir;
// Not a credential: only makes the Maps code think DataForSEO is configured. Nothing is sent.
process.env.DATAFORSEO_AUTH = Buffer.from('test-only:not-a-credential').toString('base64');
process.env.DATAFORSEO_MAPS_BUDGET_USD = '10';

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  calls.push(String(typeof input === 'string' ? input : input?.url || input));
  throw new Error('no network in this test');
};
test.after(() => {
  globalThis.fetch = realFetch;
});

const features = { users: true, analytics: true, ecommerce: false, blog: true, socialSync: false, emailMarketing: false, general: true };
const SITES = [
  { id: 'id-open', site_key: 'maps-open', name: 'Eksempel Verksted AS', domain: 'verksted.example.com', websitePlan: 'tier-2-seo', features },
  { id: 'id-off', site_key: 'maps-off', name: 'Eksempel Bakeri AS', domain: 'bakeri.example.com', websitePlan: 'tier-2-seo', features, ext: { seoFeatureOverrides: { 'seo.tracking.maps': false } } },
];
const profile = (n, site) => ({
  businessId: `biz-${n}`,
  userId: `user-${n}`,
  ownerUserId: `user-${n}`,
  email: `post${n}@example.com`,
  businessName: site.name,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  clientDataBank: {
    generalInfo: { companyName: site.name, websiteUrl: `https://${site.domain}/`, companyAddress: `Eksempelveien ${n}, 0001 Eksempelby` },
    websiteCreatorQuestions: { town: 'Eksempelby', importantKeywords: ['verksted eksempelby'] },
  },
});
writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(SITES));
writeFileSync(join(dataDir, 'client-portal-profiles.json'), JSON.stringify([profile(1, SITES[0]), profile(2, SITES[1])]));

const { saveAutomationSettings, recordReleasePass, invalidateAutomationSettingsCache } = await import('../data/automation-settings.js');
const { buildAnalyticsDashboard, ensureMapsRanking, mapsRankingGate } = await import('../lib/client-analytics-service.js');
const scheduler = await import('../lib/maps-ranking-scheduler.js');
const { getSiteByKey } = await import('../data/hub.js');
const clientPortal = await import('../data/client-portal.js');

function setGating(patch) {
  if (patch?.mode === 'auto' && patch?.enabled !== false) {
    const passed = recordReleasePass('seo.jobGating', { suite: 'gating-diff', evidence: 'scripts/seo-gating-diff.mjs' });
    assert.equal(passed.ok, true, passed.error || '');
  }
  const saved = saveAutomationSettings({ seo: { jobGating: patch } }, { by: 'test' });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  invalidateAutomationSettingsCache();
}

const PROFILE_OF = { 'maps-open': 'biz-1', 'maps-off': 'biz-2' };
const subjectOf = (key) => ({ profile: clientPortal.getClientProfileByBusinessId(PROFILE_OF[key]), site: getSiteByKey(key) });
async function callsFor(fn) {
  const before = calls.length;
  await fn();
  return calls.length - before;
}
// The dashboard refresh with the default runner (refresh=1 on the portal and site-credential routes).
const refresh = (key) => {
  const { profile: p, site } = subjectOf(key);
  return buildAnalyticsDashboard({ profile: p, hubSite: site, includeMapsRun: true });
};
// The portal's "update Maps ranking" button and the loop call it forced.
const forced = (key) => {
  const { profile: p, site } = subjectOf(key);
  return ensureMapsRanking(p, site, { force: true });
};

test('the scheduler module still exports the Maps gate', () => {
  assert.equal(scheduler.mapsRankingGate, mapsRankingGate);
  assert.equal(typeof scheduler.mapsRankingGateInput, 'function');
});

test('off (default): a refresh calls out for the overridden site as before', async () => {
  assert.ok((await callsFor(() => refresh('maps-off'))) > 0);
  assert.ok((await callsFor(() => forced('maps-off'))) > 0);
});

test('shadow: the old gate decides, so the overridden site still calls out', async () => {
  setGating({ enabled: true, mode: 'shadow' });
  assert.ok((await callsFor(() => refresh('maps-off'))) > 0);
  assert.ok((await callsFor(() => forced('maps-off'))) > 0);
});

test('auto: the overridden site makes no request on any refresh path; the other site still does', async () => {
  setGating({ enabled: true, mode: 'auto' });
  assert.equal(mapsRankingGate(subjectOf('maps-off').profile, subjectOf('maps-off').site).allowed, false);
  assert.equal(await callsFor(() => refresh('maps-off')), 0, 'dashboard refresh');
  assert.equal(await callsFor(() => forced('maps-off')), 0, 'forced refresh');
  const dashboard = await refresh('maps-off');
  assert.equal(dashboard.access.allowed, true, 'the dashboard itself is still shown');
  assert.ok((await callsFor(() => forced('maps-open'))) > 0, 'a site without the override still ranks');
  assert.ok((await callsFor(() => refresh('maps-open'))) > 0);
});

test('a paused switch counts as off: the overridden site calls out again', async () => {
  setGating({ enabled: true, mode: 'auto', paused: { reason: 'test' } });
  assert.ok((await callsFor(() => forced('maps-off'))) > 0);
  setGating({ enabled: false, mode: 'shadow', paused: null });
  assert.ok((await callsFor(() => forced('maps-off'))) > 0);
});
