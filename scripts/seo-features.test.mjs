// WS9.46 — SEO feature keys and tier mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  seoFeaturesForSite,
  seoKeysForTier,
  seoKeysForServices,
  seoJobAllowed,
  hasSeoFeature,
  SEO_FEATURE_KEYS,
  SEO_JOB_FEATURES,
  HUB_SERVICE_SEO_KEYS,
} from '../lib/seo-ops/features.js';
import { normalizeSite, featuresFromPlan } from '../data/hub-model.js';

// Hand-authored from WS9.46 + owner decisions Q19/Q52 (not generated from code).
const EXPECTED = {
  'tier-1-standard': ['blog', 'blog.posts', 'seo', 'seo.contentHead', 'seo.keywords', 'seo.onPage', 'seo.sitemap'],
  'tier-2-seo': [
    'blog', 'blog.autoPosts', 'blog.posts', 'seo', 'seo.agreedKeywords', 'seo.backlinkTargets', 'seo.contentHead', 'seo.keywords',
    'seo.linkNetwork', 'seo.liveAudit', 'seo.localPack', 'seo.onPage', 'seo.reports', 'seo.reports.basic', 'seo.searchConsole',
    'seo.sitemap', 'seo.tracking', 'seo.tracking.aiAssistants', 'seo.tracking.aiOverview', 'seo.tracking.maps', 'seo.tracking.organic',
  ],
  'tier-3-ecommerce': [
    'blog', 'blog.autoPosts', 'blog.posts', 'seo', 'seo.agreedKeywords', 'seo.backlinkTargets', 'seo.contentHead', 'seo.keywords',
    'seo.linkNetwork', 'seo.liveAudit', 'seo.localPack', 'seo.multilingual', 'seo.onPage', 'seo.productFeed', 'seo.reports',
    'seo.reports.advanced', 'seo.searchConsole', 'seo.sitemap', 'seo.tracking', 'seo.tracking.aiAssistants', 'seo.tracking.aiOverview',
    'seo.tracking.maps', 'seo.tracking.organic',
  ],
};

function site(plan, extra = {}) {
  return normalizeSite({ id: `s-${plan}`, site_key: 'k', name: 'Test', websitePlan: plan, ...extra });
}

test('tier 2 has the listed keys; tier 1 has no tracking; tier 3 has advanced reports only', () => {
  const t1 = seoFeaturesForSite(site('tier-1-standard'));
  const t2 = seoFeaturesForSite(site('tier-2-seo'));
  const t3 = seoFeaturesForSite(site('tier-3-ecommerce'));
  assert.deepEqual(t1.list, EXPECTED['tier-1-standard']);
  assert.deepEqual(t2.list, EXPECTED['tier-2-seo']);
  assert.deepEqual(t3.list, EXPECTED['tier-3-ecommerce']);
  assert.equal(t1.list.some((k) => k.startsWith('seo.tracking')), false);
  assert.equal(t1.reports, null);
  assert.equal(t2.reports, 'basic');
  assert.equal(t3.reports, 'advanced');
  assert.equal(t3.has('seo.reports.basic'), false);
  for (const s of [t1, t2, t3]) assert.equal(s.source, 'tier-fallback');
});

test('owner decisions: blog on every tier, auto posts and the backlink network Tier 2+', () => {
  for (const plan of ['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce']) {
    const f = seoFeaturesForSite(site(plan));
    assert.equal(f.has('blog'), true, plan);
    assert.equal(f.has('blog.posts'), true, plan);
  }
  assert.equal(seoFeaturesForSite(site('tier-1-standard')).has('blog.autoPosts'), false);
  assert.equal(seoFeaturesForSite(site('tier-1-standard')).has('seo.linkNetwork'), false);
  assert.equal(seoFeaturesForSite(site('tier-2-seo')).has('blog.autoPosts'), true);
  assert.equal(seoFeaturesForSite(site('tier-2-seo')).has('seo.linkNetwork'), true);
  assert.equal(seoFeaturesForSite(site('tier-2-seo')).has('blog.localPosts'), true, 'legacy name is an alias');
});

test('the tier fallback gives the same result as a resolved tree for the 3 tiers', () => {
  for (const [tier, keys] of Object.entries(EXPECTED)) {
    const fromTier = seoFeaturesForSite(site(tier));
    // A WS6-shaped effective tree carrying unrelated keys too.
    const tree = { effective: [...keys, 'shop', 'shop.checkout', 'users'] };
    const fromTree = seoFeaturesForSite(site(tier), { featureTree: tree });
    assert.equal(fromTree.source, 'tree');
    assert.deepEqual(fromTree.list, fromTier.list, tier);
    const objectTree = Object.fromEntries(SEO_FEATURE_KEYS.map((k) => [k, keys.includes(k)]));
    assert.deepEqual(seoFeaturesForSite(site(tier), { featureTree: objectTree }).list, fromTier.list, `${tier} (object tree)`);
  }
  assert.deepEqual([...seoKeysForTier('tier-2-seo')].sort(), EXPECTED['tier-2-seo']);
});

test('toggling blog.localPosts (or blog.autoPosts) off stops the blog scheduler', () => {
  const tier2 = site('tier-2-seo');
  assert.equal(seoJobAllowed(tier2, 'blog-scheduler').allowed, true);
  const treeOff = Object.fromEntries(EXPECTED['tier-2-seo'].map((k) => [k, true]));
  treeOff['blog.localPosts'] = false;
  const gate = seoJobAllowed(tier2, 'blog-scheduler', { featureTree: treeOff });
  assert.equal(gate.allowed, false);
  assert.equal(gate.key, 'blog.autoPosts');
  // Agency override on the site record (data, no env) works without the tree.
  assert.equal(seoJobAllowed({ ...tier2, seoFeatureOverrides: { 'blog.autoPosts': false } }, 'blog-scheduler').allowed, false);
  assert.equal(seoJobAllowed(site('tier-1-standard'), 'blog-scheduler').allowed, false);
  assert.equal(seoJobAllowed(site('tier-1-standard'), 'rank-tracker.organic').allowed, false);
  assert.equal(seoJobAllowed(site('tier-2-seo'), 'rank-tracker.organic').allowed, true);
  assert.equal(seoJobAllowed(site('tier-2-seo'), 'nope').allowed, false);
  for (const key of Object.values(SEO_JOB_FEATURES)) assert.ok(SEO_FEATURE_KEYS.includes(key), key);
});

test('a parent switched off removes its children (tree semantics)', () => {
  const f = seoFeaturesForSite({ ...site('tier-3-ecommerce'), seoFeatureOverrides: { 'seo.tracking': false } });
  assert.equal(f.has('seo.tracking.organic'), false);
  assert.equal(f.has('seo.tracking.maps'), false);
  assert.equal(f.has('seo.reports.advanced'), true);
});

test('cancellation stops hub services but keeps the client blog, head and sitemap (Q58)', () => {
  const f = seoFeaturesForSite(site('tier-3-ecommerce'), { hubServicesActive: false });
  for (const key of HUB_SERVICE_SEO_KEYS) assert.equal(f.has(key), false, key);
  for (const key of ['blog', 'blog.posts', 'seo.contentHead', 'seo.sitemap', 'seo.productFeed']) assert.equal(f.has(key), true, key);
  assert.equal(seoJobAllowed({ ...site('tier-2-seo'), hubServicesActive: false }, 'link-network').allowed, false);
});

test('custom plans map legacy flags like WS6 (analytics → seo, blog → blog, ecommerce → ecom); self-hosted package', () => {
  const custom = site('custom', { features: { analytics: true, blog: false, ecommerce: true } });
  const f = seoFeaturesForSite(custom);
  assert.equal(f.source, 'legacy-fallback');
  assert.equal(f.has('seo.tracking.organic'), true);
  assert.equal(f.has('blog.autoPosts'), false);
  assert.equal(f.has('seo.productFeed'), true);
  assert.equal(f.has('blog.posts'), true);
  const self = seoFeaturesForSite({ ...site('tier-2-seo'), seoPackage: 'self-hosted' });
  assert.deepEqual(self.list, ['seo', 'seo.backlinkTargets', 'seo.keywords', 'seo.linkNetwork', 'seo.onPage']);
  assert.equal(hasSeoFeature(site('tier-2-seo'), 'seo.tracking.maps'), true);
});

test('feature keys never reuse CMS feeler names (feelers carry no seo. prefix)', () => {
  const feelers = ['contentHead', 'sitemap', 'robots', 'hostGuard', 'redirects', 'productFeed', 'blogQueuePull', 'indexNow'];
  for (const feeler of feelers) assert.equal(SEO_FEATURE_KEYS.includes(feeler), false, feeler);
  assert.ok(SEO_FEATURE_KEYS.every((k) => k === 'seo' || k === 'blog' || k.startsWith('seo.') || k.startsWith('blog.')));
  // featuresFromPlan is still the legacy 7-flag source the fallback reads by tier.
  assert.equal(featuresFromPlan('tier-2-seo').blog, true);
  assert.deepEqual([...seoKeysForServices(['site', 'dashboard'])].includes('seo.reports.advanced'), false, 'dashboard alone has no report parent');
});
