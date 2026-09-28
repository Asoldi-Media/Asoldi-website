import test from 'node:test';
import assert from 'node:assert/strict';
import {
  featuresFromPlan,
  normalizeSite,
  resolveCatalogTypeForSite,
} from '../data/hub-model.js';

test('tier 3 plan enables ecommerce, analytics, blog, and social sync', () => {
  assert.deepEqual(featuresFromPlan('tier-3-ecommerce'), {
    users: true,
    analytics: true,
    ecommerce: true,
    blog: true,
    socialSync: true,
    emailMarketing: true,
    general: true,
  });
});

test('tier 2 plan enables blog, social sync and analytics but not ecommerce', () => {
  assert.equal(featuresFromPlan('tier-2-seo').socialSync, true);
  assert.equal(featuresFromPlan('tier-2-seo').analytics, true);
  assert.equal(featuresFromPlan('tier-2-seo').ecommerce, false);
});

test('catalog type is null unless ecommerce is on', () => {
  assert.equal(resolveCatalogTypeForSite({ features: { ecommerce: false }, ecommerceCatalogType: 'menu' }), null);
  assert.equal(resolveCatalogTypeForSite({ features: { ecommerce: true }, ecommerceCatalogType: 'menu' }), 'menu');
  assert.equal(resolveCatalogTypeForSite({ features: { ecommerce: true }, ecommerceCatalogType: null }), 'normal');
});

test('normalizeSite fills new hub fields on old records', () => {
  const site = normalizeSite({
    id: '1',
    site_key: 'abc',
    domain: 'mongsushi.no',
    name: 'Mong Sushi',
    features: { users: true, ecommerce: true },
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(site.websitePlan, 'tier-1-standard');
  assert.equal(site.features.blog, false);
  assert.equal(site.features.ecommerce, true);
  assert.equal(site.ecommerceCatalogType, 'normal');
  assert.equal(site.cms.githubRepo, '');
});
