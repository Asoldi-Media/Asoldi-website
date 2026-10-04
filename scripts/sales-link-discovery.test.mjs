import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dataForSeoOrganicToResults,
  discoverSalesLinks,
  distinctiveNameTokens,
  isUpcomingSalesClient,
  nameMatchesText,
  pickNamedCandidate,
  serpPayloadToResults,
} from '../lib/sales-link-discovery.js';

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
