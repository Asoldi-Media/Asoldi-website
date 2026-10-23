import test from 'node:test';
import assert from 'node:assert/strict';
import { featuresFromPlan, normalizeSite, publicLocalBlog } from '../data/hub-model.js';
import {
  buildLocalBlogBrief,
  localBlogAutoPostsEnabled,
  salesClientForSite,
  siteServices,
} from '../lib/local-blog-brief.js';
import { hashLocalBlogToken, localBlogTokensMatch } from '../lib/local-blog-token.js';
import { legacyFlagsForServices, servicesForTier } from '../packages/suite/core/delivery/vocab.js';

test('the service brief keeps services and the town, and drops private fields', () => {
  const brief = buildLocalBlogBrief({
    site: { name: 'Kafe', site_key: 'site-1', websitePlan: 'tier-2-seo', features: { blog: true } },
    salesClient: {
      businessName: 'Kafe',
      businessAddress: 'Østre berg 10, 7014 Trondheim',
      clientEmail: 'secret@example.com',
      hubSite: { siteKey: 'site-1' },
    },
    profile: {
      businessName: 'Kafe',
      email: 'owner@example.com',
      clientDataBank: {
        generalInfo: {
          companyName: 'Kafe',
          companyAddress: 'Østre berg 10, 7014 Trondheim',
          companyEmail: 'owner@example.com',
          companyPhone: '+47 90000000',
          websiteLanguage: 'Norsk (Norge)',
        },
        businessCard: { industry: 'Kafé' },
        websiteCreatorQuestions: {
          businessWhat: 'Vi lager lunsj og monterer enkle serveringsløp for bedrifter som vil ha mat på huset.',
          town: 'Trondheim',
          country: 'Norge',
          mainCtaUrl: '/kontakt',
        },
        openingHours: {
          status: 'set',
          days: [{ day: 'Mandag', opensAt: '08:00', closesAt: '16:00', closed: false }],
        },
        products: [{
          categoryName: 'Mat',
          items: [{ title: 'Lunsj', description: 'Dagens tallerken', price: '199', imageUrl: '/secret.jpg' }],
        }],
      },
    },
  });
  const blob = JSON.stringify(brief);
  assert.equal(blob.includes('secret@'), false);
  assert.equal(blob.includes('owner@'), false);
  assert.equal(blob.includes('90000000'), false);
  assert.equal(blob.includes('199'), false);
  assert.equal(blob.includes('/secret.jpg'), false);
  assert.equal(brief.blogEnabled, true);
  assert.equal(brief.hasSubject, true);
  assert.equal(brief.services[0].name, 'Lunsj');
  assert.equal(brief.services[0].description, 'Dagens tallerken');
  assert.deepEqual(brief.places, ['Trondheim']);
  assert.equal(brief.contactPath, '/kontakt');
  assert.match(brief.hours, /Mandag/);
  assert.equal(brief.monthlyQuota, 10);
});

test('a site token matches only its own hash and the public site hides that hash', () => {
  const token = 'local-blog-token';
  const hash = hashLocalBlogToken(token);
  assert.equal(localBlogTokensMatch(hash, token), true);
  assert.equal(localBlogTokensMatch(hash, 'other'), false);
  assert.equal(localBlogTokensMatch('', token), false);
  const site = normalizeSite({
    id: '1',
    site_key: 'abc',
    name: 'Kafe',
    localBlog: { tokenHash: hash, issuedAt: '2026-10-02T00:00:00.000Z' },
  });
  assert.equal(site.localBlog.tokenHash, hash);
  const pub = publicLocalBlog(site.localBlog);
  assert.equal(pub.tokenSet, true);
  assert.equal(pub.issuedAt, '2026-10-02T00:00:00.000Z');
  assert.equal('tokenHash' in pub, false);
});

test('sales client lookup uses the hub site key', () => {
  const site = { id: '9', site_key: 'site-1' };
  const match = salesClientForSite(site, [
    { businessName: 'Annen', hubSite: { siteKey: 'nope' } },
    { businessName: 'Kafe', hubSite: { siteKey: 'site-1' } },
  ]);
  assert.equal(match.businessName, 'Kafe');
});

// Owner decision Q19: the blog is on every tier, automatic posts only with the seo service (tier 2+).
test('automatic posts need the seo service, not only the legacy blog flag', () => {
  const brief = (site) => buildLocalBlogBrief({ site: normalizeSite({ id: 's', site_key: 'k', name: 'Kafe', ...site }) }).blogEnabled;

  // Today's tier 2 and tier 3 sites keep their automatic posts.
  assert.equal(brief({ websitePlan: 'tier-2-seo' }), true);
  assert.equal(brief({ websitePlan: 'tier-3-ecommerce' }), true);
  assert.equal(brief({ websitePlan: 'tier-2-seo', features: { ...featuresFromPlan('tier-2-seo'), blog: false } }), false, 'blog switched off');

  // The reviewer's case: a tier-1 site with the blog flag on gets no automatic posts.
  assert.equal(brief({ websitePlan: 'tier-1-standard', features: { blog: true } }), false);
  assert.equal(brief({ features: { blog: true } }), false, 'no plan reads as tier 1');

  // Custom plans: the seo service maps to the analytics flag.
  assert.equal(brief({ websitePlan: 'custom', features: { blog: true } }), false);
  assert.equal(brief({ websitePlan: 'custom', features: { blog: true, analytics: true } }), true);

  // planSource.services (WS8.4) wins over the plan id when it lists services.
  assert.equal(localBlogAutoPostsEnabled({ websitePlan: 'tier-2-seo', features: { blog: true }, planSource: { kind: 'offer', services: ['site'] } }), false);
  assert.equal(localBlogAutoPostsEnabled({ websitePlan: 'tier-1-standard', features: { blog: true }, planSource: { kind: 'offer', services: ['site', 'seo'] } }), true);
  assert.equal(localBlogAutoPostsEnabled({ websitePlan: 'tier-2-seo', features: { blog: true }, planSource: { kind: 'backfill', derivedFeatures: {} } }), true, 'backfill has no services: the plan decides');
  assert.deepEqual(siteServices({ websitePlan: 'tier-1-standard' }), ['site', 'changes', 'blog']);
});

test('flags derived from the vocabulary (WS8.1) never turn on automatic posts for tier 1 or a site-only custom plan', () => {
  // legacyFlagsForServices turns the blog flag on for every tier (site brings blog). The gate must
  // still say no until the seo service is there.
  for (const tierId of ['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce']) {
    const services = servicesForTier(tierId);
    const features = legacyFlagsForServices(services);
    assert.equal(features.blog, true, `${tierId}: the client-written blog is on`);
    const site = { websitePlan: tierId, features, planSource: { kind: 'offer', tierId, services } };
    assert.equal(localBlogAutoPostsEnabled(site), services.includes('seo'), tierId);
  }
  const siteOnly = { websitePlan: 'custom', features: legacyFlagsForServices(['site']), planSource: { kind: 'offer', services: ['site'] } };
  assert.equal(siteOnly.features.blog, true);
  assert.equal(localBlogAutoPostsEnabled(siteOnly), false);
  assert.equal(localBlogAutoPostsEnabled({ ...siteOnly, planSource: undefined }), false, 'without planSource the custom flags decide');
});
