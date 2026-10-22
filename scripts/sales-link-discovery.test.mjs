import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dataForSeoMapsToPlaces,
  dataForSeoOrganicToResults,
  searchDataForSeoOrganic,
  searchGoogle,
  discoverSalesLinks,
  distinctiveNameTokens,
  isUpcomingSalesClient,
  nameMatchesText,
  pickNamedCandidate,
  serpPayloadToResults,
} from '../lib/sales-link-discovery.js';
import {
  resetSerpSpendForTests,
  shouldRefuseSerpCall,
  stripPaidSearchOperators,
} from '../lib/dataforseo-serp.js';

const cafePage = {
  ok: true,
  blocked: false,
  error: false,
  title: 'Byneset Cafe',
  text: 'Byneset Cafe server lunsj i Trondheim. Velkommen innom for kaffe og kaker hver dag i uken.',
  finalUrl: 'https://bynesetcafe.no',
};

function pageFor(url) {
  if (String(url).includes('instagram.com/bynesetcafe')) {
    return { ...cafePage, title: 'Byneset Cafe (@bynesetcafe)', finalUrl: url };
  }
  if (String(url).includes('wrongplace')) {
    return {
      ok: true,
      blocked: false,
      error: false,
      title: 'Annen Bedrift',
      text: 'Annen Bedrift selger sykler i Bergen og har ingen tilknytning til kafeen i Trondheim.',
      finalUrl: url,
    };
  }
  if (String(url).includes('instagram.com') || String(url).includes('facebook.com')) {
    return { ok: false, blocked: true, error: false, title: 'Login', text: '', finalUrl: url };
  }
  if (String(url).includes('bynesetcafe.no')) return { ...cafePage, finalUrl: url };
  return { ok: false, blocked: false, error: true, title: '', text: '', finalUrl: url };
}

test('a short business name matches when every distinctive word is present', () => {
  assert.deepEqual(distinctiveNameTokens('Byneset Cafe AS'), ['byneset', 'cafe']);
  assert.equal(nameMatchesText('Byneset Cafe AS', 'Byneset Cafe på Instagram'), true);
  assert.equal(nameMatchesText('Byneset Cafe AS', 'Cafe Oslo'), false);
});

test('SerpAPI local pack becomes a website and a Maps link', () => {
  const rows = serpPayloadToResults({
    organic_results: [{ link: 'https://www.instagram.com/bynesetcafe/', title: 'Byneset Cafe', snippet: 'Trondheim' }],
    local_results: {
      places: [{
        title: 'Byneset Cafe',
        address: 'Trondheim',
        place_id: 'abc',
        links: { website: 'https://bynesetcafe.no' },
      }],
    },
  });
  assert.equal(rows.some((row) => row.url.includes('instagram.com/bynesetcafe')), true);
  assert.equal(rows.some((row) => row.url.includes('bynesetcafe.no')), true);
  assert.equal(rows.some((row) => row.url.includes('query_place_id=abc')), true);
});

test('DataForSEO organic and local pack become the same result rows', () => {
  const rows = dataForSeoOrganicToResults({
    tasks: [{
      result: [{
        items: [
          { type: 'organic', url: 'https://www.instagram.com/bynesetcafe/', title: 'Byneset Cafe', description: 'Trondheim', rank_group: 1 },
          {
            type: 'local_pack',
            items: [{ title: 'Byneset Cafe', url: 'https://maps.google.com/?cid=9', domain: 'bynesetcafe.no', description: 'Trondheim' }],
          },
        ],
      }],
    }],
  });
  assert.equal(rows.some((row) => row.url.includes('instagram.com/bynesetcafe')), true);
  assert.equal(rows.some((row) => row.url.includes('cid=9')), true);
  assert.equal(rows.some((row) => row.url.includes('bynesetcafe.no')), true);
});

test('paid Google operators are stripped so site: cannot 5x the SERP bill', () => {
  assert.equal(stripPaidSearchOperators('site:instagram.com "TASS" Trondheim'), 'instagram.com TASS Trondheim');
  assert.equal(stripPaidSearchOperators('intitle:bakkes inurl:om-oss'), 'bakkes om-oss');
  assert.equal(
    shouldRefuseSerpCall({ spentUsd: 4.999, dailyUsd: 0, budgetUsd: 5, dailyBudgetUsd: 0.4 }, { worstCase: 0.002 }),
    true
  );
  assert.equal(
    shouldRefuseSerpCall({ spentUsd: 0.1, dailyUsd: 0.399, budgetUsd: 5, dailyBudgetUsd: 0.4 }, { worstCase: 0.002 }),
    true
  );
  assert.equal(
    shouldRefuseSerpCall({ spentUsd: 0.1, dailyUsd: 0.1, budgetUsd: 5, dailyBudgetUsd: 0.4 }, { worstCase: 0.002 }),
    false
  );
});

describe('kundekort DataForSEO SERP spend', { concurrency: false }, () => {
test('searchGoogle uses DataForSEO first when auth is set', async () => {
  const previous = process.env.DATAFORSEO_AUTH;
  process.env.DATAFORSEO_AUTH = Buffer.from('x:y').toString('base64');
  resetSerpSpendForTests();
  try {
    const rows = await searchGoogle('tass instagram', {
      persist: false,
      fetchImpl: async (url) => {
        assert.match(String(url), /dataforseo\.com/);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tasks: [{
              status_code: 20000,
              cost: 0,
              result: [{
                items: [
                  { type: 'organic', url: 'https://www.instagram.com/tass.norge/', title: 'TASS Norge', description: 'tass.no', rank_group: 1 },
                ],
              }],
            }],
          }),
        };
      },
    });
    assert.equal(rows[0].url, 'https://www.instagram.com/tass.norge/');
  } finally {
    if (previous == null) delete process.env.DATAFORSEO_AUTH;
    else process.env.DATAFORSEO_AUTH = previous;
  }
});

test('a spent lifetime or daily SERP budget refuses the live call', async () => {
  const previousAuth = process.env.DATAFORSEO_AUTH;
  const previousBudget = process.env.SALES_LINK_DATAFORSEO_BUDGET_USD;
  const previousDaily = process.env.SALES_LINK_DATAFORSEO_DAILY_USD;
  process.env.DATAFORSEO_AUTH = Buffer.from('x:y').toString('base64');
  process.env.SALES_LINK_DATAFORSEO_BUDGET_USD = '5';
  process.env.SALES_LINK_DATAFORSEO_DAILY_USD = '0.40';
  resetSerpSpendForTests({ totalUsd: 5, dailyUsd: 0.4 });
  let fetched = 0;
  try {
    const rows = await searchDataForSeoOrganic('tass instagram', {
      persist: false,
      fetchImpl: async () => {
        fetched += 1;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    assert.deepEqual(rows, []);
    assert.equal(fetched, 0);
  } finally {
    resetSerpSpendForTests();
    if (previousAuth == null) delete process.env.DATAFORSEO_AUTH;
    else process.env.DATAFORSEO_AUTH = previousAuth;
    if (previousBudget == null) delete process.env.SALES_LINK_DATAFORSEO_BUDGET_USD;
    else process.env.SALES_LINK_DATAFORSEO_BUDGET_USD = previousBudget;
    if (previousDaily == null) delete process.env.SALES_LINK_DATAFORSEO_DAILY_USD;
    else process.env.SALES_LINK_DATAFORSEO_DAILY_USD = previousDaily;
  }
});

test('live organic search strips site: from the paid keyword', async () => {
  const previous = process.env.DATAFORSEO_AUTH;
  process.env.DATAFORSEO_AUTH = Buffer.from('x:y').toString('base64');
  resetSerpSpendForTests();
  let keyword = '';
  try {
    await searchDataForSeoOrganic('site:instagram.com tass', {
      persist: false,
      fetchImpl: async (_url, init) => {
        keyword = JSON.parse(init.body)[0].keyword;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tasks: [{
              status_code: 20000,
              cost: 0.002,
              result: [{ items: [] }],
            }],
          }),
        };
      },
    });
    assert.equal(keyword.includes('site:'), false);
    assert.match(keyword, /instagram.com/);
  } finally {
    resetSerpSpendForTests();
    if (previous == null) delete process.env.DATAFORSEO_AUTH;
    else process.env.DATAFORSEO_AUTH = previous;
  }
});
});

test('DataForSEO Maps items become cid places', () => {
  const rows = dataForSeoMapsToPlaces({
    tasks: [{
      result: [{
        items: [{
          title: 'TASS',
          address: 'Vasøyveien 103, 7167 Vallersund',
          phone: '47 13 13 80',
          cid: '5208062932965149043',
          url: 'https://tass.no',
        }],
      }],
    }],
  });
  assert.equal(rows[0].mapsUrl, 'https://maps.google.com/?cid=5208062932965149043');
  assert.equal(rows[0].title, 'TASS');
});

test('two equal name matches are left empty', () => {
  const picked = pickNamedCandidate([
    { url: 'https://www.instagram.com/bynesetcafe/', title: 'Byneset Cafe', snippet: 'Trondheim', position: 0 },
    { url: 'https://www.instagram.com/bynesetcafeoslo/', title: 'Byneset Cafe', snippet: 'Oslo', position: 1 },
  ], { businessName: 'Byneset Cafe', city: '' }, 'instagram');
  assert.equal(picked.url, '');
  assert.equal(picked.reason, 'ambiguous');
});

test('a name match is kept and a page about another business is deleted', async () => {
  const queries = [];
  const result = await discoverSalesLinks({
    businessName: 'Byneset Cafe',
    city: 'Trondheim',
    instagramUrl: 'https://www.instagram.com/wrongplace/',
    facebookUrl: '',
    websiteDomain: 'https://wrongplace.no',
    googleBusinessProfile: '',
  }, {
    search: async (query) => {
      queries.push(query);
      if (query.includes('instagram')) {
        return [{ url: 'https://www.instagram.com/bynesetcafe/', title: 'Byneset Cafe', snippet: 'Trondheim', position: 0 }];
      }
      if (query.includes('facebook')) return [];
      return [{ url: 'https://bynesetcafe.no', title: 'Byneset Cafe', snippet: 'Trondheim', position: 0 }];
    },
    readPage: async (url) => pageFor(url),
    askGemini: null,
  });
  assert.equal(result.instagramUrl, 'https://www.instagram.com/bynesetcafe/');
  assert.equal(result.websiteDomain, 'bynesetcafe.no');
  assert.equal(result.facebookUrl, '');
  assert.equal(queries.some((query) => query.includes('site:instagram.com')), false);
});

test('Gemini can fill a missing Facebook link only from a cited URL', async () => {
  const result = await discoverSalesLinks({
    businessName: 'Byneset Cafe',
    city: 'Trondheim',
    instagramUrl: 'https://www.instagram.com/bynesetcafe/',
    facebookUrl: '',
    websiteDomain: 'bynesetcafe.no',
    googleBusinessProfile: '',
  }, {
    search: async (query) => {
      if (query.includes('instagram')) {
        return [{ url: 'https://www.instagram.com/bynesetcafe/', title: 'Byneset Cafe', snippet: 'Trondheim', position: 0 }];
      }
      if (query.includes('facebook')) return [];
      if (query.includes('Norge')) return [];
      return [{ url: 'https://bynesetcafe.no', title: 'Byneset Cafe', snippet: 'Trondheim', position: 0 }];
    },
    readPage: async (url) => pageFor(url),
    askGemini: async () => ({
      reason: 'gemini',
      urls: {
        facebookUrl: 'https://www.facebook.com/bynesetcafe/',
        instagramUrl: 'https://www.instagram.com/invented/',
        websiteUrl: '',
        googleMapsUrl: 'https://maps.google.com/?cid=1',
      },
      chunks: [
        { url: 'https://www.facebook.com/bynesetcafe/', title: 'Byneset Cafe' },
        { url: 'https://maps.google.com/?cid=1', title: 'Byneset Cafe Trondheim' },
      ],
    }),
  });
  assert.equal(result.facebookUrl, 'https://www.facebook.com/bynesetcafe/');
  assert.equal(result.instagramUrl, 'https://www.instagram.com/bynesetcafe/');
  assert.equal(result.googleBusinessProfile, 'https://maps.google.com/?cid=1');
});

test('a dead search keeps the link already on the card', async () => {
  const result = await discoverSalesLinks({
    businessName: 'Byneset Cafe',
    instagramUrl: 'https://www.instagram.com/bynesetcafe/',
    facebookUrl: '',
    websiteDomain: 'bynesetcafe.no',
    googleBusinessProfile: 'https://maps.google.com/?cid=1',
  }, {
    search: async () => {
      const error = new Error('payment');
      error.code = 'search-unavailable';
      throw error;
    },
    readPage: async () => ({ ok: false, blocked: false, error: true, title: '', text: '', finalUrl: '' }),
    askGemini: null,
  });
  assert.equal(result.instagramUrl, 'https://www.instagram.com/bynesetcafe/');
  assert.equal(result.websiteDomain, 'bynesetcafe.no');
  assert.equal(result.googleBusinessProfile, 'https://maps.google.com/?cid=1');
  assert.equal(result.diagnostics.instagram.reason, 'search-unavailable');
});

test('a future unsigned client is included and a held meeting is not', () => {
  const now = Date.parse('2026-10-04T12:00:00.000Z');
  assert.equal(isUpcomingSalesClient({
    businessName: 'Byneset Cafe',
    status: 'active',
    product: 'asoldi',
    meetingAt: '2026-10-20T10:00:00.000Z',
    progression: {},
  }, now), true);
  assert.equal(isUpcomingSalesClient({
    businessName: 'Byneset Cafe',
    status: 'active',
    product: 'asoldi',
    meetingAt: '2026-09-01T10:00:00.000Z',
    progression: {},
  }, now), false);
  assert.equal(isUpcomingSalesClient({
    businessName: 'Byneset Cafe',
    status: 'active',
    product: 'asoldi',
    meetingAt: '2026-10-20T10:00:00.000Z',
    progression: { meetingHeld: true },
  }, now), false);
});
