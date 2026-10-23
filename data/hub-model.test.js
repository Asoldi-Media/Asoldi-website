import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeatures, publicClientAdmin, normalizeSite } from './hub-model.js';
import { seoFeaturesForSite } from '../lib/seo-ops/features.js';

test('hub features include email marketing and general', () => {
  const features = normalizeFeatures({ emailMarketing: 1, general: true, users: false });
  assert.equal(features.emailMarketing, true);
  assert.equal(features.general, true);
  assert.equal(features.users, false);
});

test('public client admin never returns the password hash', () => {
  const site = normalizeSite({
    id: '1',
    site_key: 'abc',
    name: 'Mong',
    clientAdmin: { name: 'Mong', email: 'a@b.no', passwordHash: 'secret-hash', pendingSync: true },
  });
  const pub = publicClientAdmin(site.clientAdmin);
  assert.equal(pub.passwordSet, true);
  assert.equal(pub.name, 'Mong');
  assert.equal('passwordHash' in pub, false);
});

test('SEO features derive from the site tier until the feature tree lands (WS9.46)', () => {
  const byPlan = (websitePlan) => seoFeaturesForSite(normalizeSite({ id: websitePlan, site_key: 'k', name: 'S', websitePlan }));
  const t1 = byPlan('tier-1-standard');
  const t2 = byPlan('tier-2-seo');
  const t3 = byPlan('tier-3-ecommerce');
  assert.equal(t1.has('blog.posts'), true);
  assert.equal(t1.has('blog.autoPosts'), false);
  assert.equal(t1.has('seo.tracking.organic'), false);
  assert.equal(t2.has('blog.autoPosts'), true);
  assert.equal(t2.has('seo.linkNetwork'), true);
  assert.equal(t2.reports, 'basic');
  assert.equal(t3.reports, 'advanced');
  assert.equal(t3.has('seo.reports.basic'), false);
  // An unknown plan normalizes to tier 1, like featuresFromPlan.
  assert.deepEqual(byPlan('nonsense').list, t1.list);
});
