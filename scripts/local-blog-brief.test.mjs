import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSite, publicLocalBlog } from '../data/hub-model.js';
import {
  buildLocalBlogBrief,
  salesClientForSite,
} from '../lib/local-blog-brief.js';
import { hashLocalBlogToken, localBlogTokensMatch } from '../lib/local-blog-token.js';

test('the service brief keeps services and the town, and drops private fields', () => {
  const brief = buildLocalBlogBrief({
    site: { name: 'Kafe', site_key: 'site-1', features: { blog: true } },
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
