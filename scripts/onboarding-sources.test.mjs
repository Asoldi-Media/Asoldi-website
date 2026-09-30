import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fetchGoogleMapsPlaces, mapGoogleMapsSearchResults, mapsUrlFromPlace } from '../lib/google-places-search.js';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-onboarding-sources-'));
process.env.APP_DATA_DIR = dataDir;
const portal = await import('../data/client-portal.js');

test('maps URL prefers a Google place id so the client can pick a profile', () => {
  const url = mapsUrlFromPlace({
    placeId: 'ChIJ123',
    name: 'Bydelskafe',
    address: 'Trondheim',
  });
  assert.match(url, /query_place_id=ChIJ123/);
  assert.match(url, /query=Bydelskafe/);
});

test('SerpAPI local results map to pickable Google profiles', () => {
  const rows = mapGoogleMapsSearchResults({
    local_results: [
      {
        title: 'Bydelskafe',
        place_id: 'ChIJ999',
        address: 'Bynesveien 1, Trondheim',
        rating: 4.7,
        reviews: 88,
      },
    ],
  });
  assert.equal(rows[0].name, 'Bydelskafe');
  assert.equal(rows[0].placeId, 'ChIJ999');
  assert.match(rows[0].mapsUrl, /ChIJ999/);
});

test('onboarding sources land in kundedata for later website intake', () => {
  const bank = portal.applyIntakeSourcesToBank({}, {
    websiteUrl: 'https://cafeen.no',
    instagramUrl: 'https://instagram.com/cafeen',
    facebookUrl: 'https://facebook.com/cafeen',
    googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query_place_id=ChIJ1',
    googlePlaceId: 'ChIJ1',
    googlePlaceName: 'Cafeen',
  }, {
    phone: '40000000',
    email: 'hei@cafeen.no',
  });
  assert.equal(bank.generalInfo.websiteUrl, 'https://cafeen.no');
  assert.equal(bank.generalInfo.instagramUrl, 'https://instagram.com/cafeen');
  assert.equal(bank.generalInfo.googlePlaceId, 'ChIJ1');
  assert.equal(bank.openingHours.googleBusinessSyncUrl.includes('ChIJ1'), true);
  assert.equal(bank.websiteCreatorQuestions.websiteDomain, 'https://cafeen.no');
  assert.match(bank.websiteCreatorQuestions.relevantLinks, /instagram.com\/cafeen/);
  assert.equal(bank.generalInfo.companyPhone, '40000000');
});

test('Place ID alone builds the official Maps URL for later buttons', () => {
  const bank = portal.applyIntakeSourcesToBank({}, {
    googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
    googlePlaceName: "Joe's Pizza",
  });
  assert.equal(bank.generalInfo.googlePlaceId, 'ChIJN1t_tDeuEmsRUsoyG83frY4');
  assert.match(bank.generalInfo.googleMapsUrl, /query_place_id=ChIJN1t_tDeuEmsRUsoyG83frY4/);
  assert.match(bank.openingHours.googleBusinessSyncUrl, /query_place_id=ChIJN1t_tDeuEmsRUsoyG83frY4/);
});

test('Maps profile search continues on the backup SerpAPI key in the same request', async () => {
  const seen = [];
  const rows = await fetchGoogleMapsPlaces('Bydelskafe Trondheim', {
    apiKeys: ['maps-empty-key', 'maps-full-key'],
    fetchImpl: async (url) => {
      const key = new URL(url).searchParams.get('api_key');
      seen.push(key);
      if (key === 'maps-empty-key') {
        return {
          ok: false,
          status: 429,
          json: async () => ({ error: 'Your account has run out of searches.' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          local_results: [{ title: 'Bydelskafe', place_id: 'ChIJ-live', address: 'Trondheim' }],
        }),
      };
    },
  });
  assert.deepEqual(seen, ['maps-empty-key', 'maps-full-key']);
  assert.equal(rows[0].placeId, 'ChIJ-live');
});
