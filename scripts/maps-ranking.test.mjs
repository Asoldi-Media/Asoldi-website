import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsLevelForPlan, ANALYTICS_LEVEL_NONE, ANALYTICS_LEVEL_BASIC, ANALYTICS_LEVEL_ADVANCED } from '../lib/website-tiers.js';
import { buildMapsKeywords, pickBusinessFromMapsItems, scoreMapsItem } from '../lib/maps-ranking.js';
import { fetchGoogleMapsSerp, MAPS_ENDPOINT } from '../lib/dataforseo-maps.js';
import { summarizeTrafficEvents, rangeFromPreset } from '../lib/analytics-traffic.js';
import { summarizeCta, summarizeEcommerceFunnel, summarizeShopifyCommerce } from '../lib/analytics-insights.js';

test('tier 1 has no analytics, SEO is basic, ecommerce is advanced', () => {
  assert.equal(analyticsLevelForPlan('tier-1-standard'), ANALYTICS_LEVEL_NONE);
  assert.equal(analyticsLevelForPlan('tier-2-seo'), ANALYTICS_LEVEL_BASIC);
  assert.equal(analyticsLevelForPlan('tier-3-ecommerce'), ANALYTICS_LEVEL_ADVANCED);
  assert.equal(analyticsLevelForPlan('seo'), ANALYTICS_LEVEL_BASIC);
});

test('maps keywords come from the client card, max three', () => {
  const keywords = buildMapsKeywords({
    name: 'Mong Sushi',
    industry: 'restaurant',
    town: 'Trondheim',
    keywords: ['sushi trondheim', 'restaurant midtbyen', 'takeaway', 'extra'],
  });
  assert.equal(keywords.length, 3);
  assert.equal(keywords[0], 'sushi trondheim');
});

test('maps keywords prefer the Website Maker DataForSEO keyword plan', () => {
  const keywords = buildMapsKeywords({
    name: 'Mong Sushi',
    industry: 'restaurant',
    town: 'Trondheim',
    keywords: ['old listed phrase'],
    keywordPlan: {
      primary: [{ keyword: 'sushi takeaway trondheim' }, { keyword: 'sushi restaurant trondheim' }],
      secondary: [{ keyword: 'bestill sushi' }],
    },
  });
  assert.equal(keywords[0], 'sushi takeaway trondheim');
  assert.equal(keywords[1], 'sushi restaurant trondheim');
  assert.ok(!keywords.includes('old listed phrase'));
});

test('ranking uses DataForSEO Google Maps SERP live/advanced, not Labs', async () => {
  assert.equal(MAPS_ENDPOINT, 'serp/google/maps/live/advanced');
  let url = '';
  let payload = [];
  const result = await fetchGoogleMapsSerp({
    keyword: 'sushi trondheim',
    location_coordinate: '63.4305000,10.3950000,15z',
  }, {
    persist: false,
    env: { DATAFORSEO_AUTH: Buffer.from('login:password').toString('base64'), DATAFORSEO_MAPS_BUDGET_USD: '10' },
    fetchImpl: async (href, opts) => {
      url = href;
      payload = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          status_code: 20000,
          tasks: [{
            status_code: 20000,
            cost: 0.002,
            result: [{ items: [], datetime: '2026-09-28 00:00:00 +00:00', check_url: 'https://google.com/maps' }],
          }],
        }),
      };
    },
  });
  assert.match(url, /https:\/\/api\.dataforseo\.com\/v3\/serp\/google\/maps\/live\/advanced$/);
  assert.equal(payload[0].keyword, 'sushi trondheim');
  assert.equal(payload[0].location_coordinate, '63.4305000,10.3950000,15z');
  assert.ok(!url.includes('dataforseo_labs'));
  assert.equal(result.cached, false);
});

test('maps SERP matcher prefers place id then name/domain', () => {
  const items = [
    { type: 'maps_search', title: 'Other Sushi', place_id: 'a', rank_absolute: 1, domain: 'other.no' },
    { type: 'maps_search', title: 'Mong Sushi', place_id: 'ChIJ123', rank_absolute: 3, domain: 'mongsushi.no', rating: { value: 4.6, votes_count: 88 } },
  ];
  const match = pickBusinessFromMapsItems(items, {
    name: 'Mong Sushi',
    placeId: 'ChIJ123',
    website: 'https://mongsushi.no',
  });
  assert.equal(match.found, true);
  assert.equal(match.position, 3);
  assert.ok(scoreMapsItem(items[1], { name: 'Mong Sushi', placeId: 'ChIJ123' }) > 80);
});

test('traffic summary counts bounce and unique visitors', () => {
  const events = [
    { type: 'pageview', visitorId: 'v1', sessionId: 's1', path: '/', at: '2026-09-01T10:00:00.000Z' },
    { type: 'pageview', visitorId: 'v2', sessionId: 's2', path: '/', at: '2026-09-01T10:01:00.000Z' },
    { type: 'pageview', visitorId: 'v2', sessionId: 's2', path: '/meny', at: '2026-09-01T10:02:00.000Z' },
  ];
  const stats = summarizeTrafficEvents(events, rangeFromPreset('30d', '', '', Date.parse('2026-09-02T00:00:00.000Z')));
  assert.equal(stats.visits, 2);
  assert.equal(stats.uniqueVisitors, 2);
  assert.equal(stats.pageviews, 3);
  assert.equal(stats.bounceRate, 50);
});

test('CTA summary counts destination views and clicks to the Maker URL', () => {
  const from = new Date('2026-09-01T00:00:00.000Z');
  const to = new Date('2026-09-02T00:00:00.000Z');
  const stats = summarizeCta([
    { type: 'pageview', visitorId: 'v1', sessionId: 's1', path: '/', at: '2026-09-01T10:00:00.000Z' },
    { type: 'cta', visitorId: 'v1', sessionId: 's1', path: '/', href: '/bestill', at: '2026-09-01T10:00:02.000Z' },
    { type: 'pageview', visitorId: 'v1', sessionId: 's1', path: '/bestill', at: '2026-09-01T10:00:04.000Z' },
    { type: 'pageview', visitorId: 'v2', sessionId: 's2', path: '/bestill?utm=ad', at: '2026-09-01T10:05:00.000Z' },
  ], '/bestill', { from, to, visits: 10 });
  assert.equal(stats.configured, true);
  assert.equal(stats.pageviews, 2);
  assert.equal(stats.clicks, 1);
  assert.equal(stats.visitors, 2);
  assert.equal(stats.rate, 20);
});

test('store funnel dropoff and Shopify commerce exclude cancelled orders', () => {
  const from = new Date('2026-09-01T00:00:00.000Z');
  const to = new Date('2026-09-02T00:00:00.000Z');
  const events = [
    { type: 'pageview', sessionId: 'a', path: '/', at: '2026-09-01T10:00:00.000Z' },
    { type: 'pageview', sessionId: 'a', path: '/product/roll', at: '2026-09-01T10:00:10.000Z' },
    { type: 'add_to_cart', sessionId: 'a', path: '/product/roll', at: '2026-09-01T10:00:12.000Z' },
    { type: 'pageview', sessionId: 'a', path: '/cart', at: '2026-09-01T10:00:20.000Z' },
    { type: 'pageview', sessionId: 'a', path: '/checkout', at: '2026-09-01T10:00:30.000Z' },
    { type: 'pageview', sessionId: 'b', path: '/product/maki', at: '2026-09-01T11:00:00.000Z' },
  ];
  const funnel = summarizeEcommerceFunnel(events, [
    { status: 'new', amount: 400, quantity: 2, productName: 'Roll', customerEmail: 'a@x.no', purchasedAt: '2026-09-01T10:01:00.000Z' },
    { status: 'cancelled', amount: 50, quantity: 1, productName: 'Maki', customerEmail: 'b@x.no', purchasedAt: '2026-09-01T11:01:00.000Z' },
  ], { from, to });
  assert.equal(funnel.counts.sessions, 2);
  assert.equal(funnel.counts.product, 2);
  assert.equal(funnel.counts.cart, 1);
  assert.equal(funnel.counts.checkout, 1);
  assert.equal(funnel.counts.purchase, 1);
  assert.equal(funnel.abandonment.checkout, 0);
  const shop = summarizeShopifyCommerce([
    { status: 'new', amount: 400, quantity: 2, productName: 'Roll', customerEmail: 'a@x.no', purchasedAt: '2026-09-01T10:01:00.000Z' },
    { status: 'cancelled', amount: 50, quantity: 1, productName: 'Maki', customerEmail: 'b@x.no', purchasedAt: '2026-09-01T11:01:00.000Z' },
  ], 10);
  assert.equal(shop.orders, 1);
  assert.equal(shop.cancelled, 1);
  assert.equal(shop.revenue, 400);
  assert.equal(shop.unitsSold, 2);
  assert.equal(shop.conversionRate, 10);
});
