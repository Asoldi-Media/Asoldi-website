import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  fetchGoogleMapsPlaces,
  mapGoogleMapsSearchResults,
  mapPlacesApiResults,
  mapsUrlFromPlace,
  profileNameMatchesQuery,
  resetPlacesApiState,
  searchPublicGoogleProfiles,
} from '../lib/google-places-search.js';

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
  assert.equal(bank.websiteCreatorQuestions.websiteDomain, 'cafeen.no');
  assert.match(bank.websiteCreatorQuestions.relevantLinks, /instagram.com\/cafeen/);
  assert.equal(bank.generalInfo.companyPhone, '40000000');
  assert.equal(bank.staff.length, 0);
});

test('onboarding contact person is added as the first Ansatte employee', () => {
  const bank = portal.applyIntakeSourcesToBank({}, {}, {
    name: 'Kari Nordmann',
    title: 'Daglig leder',
    phone: '400 00 000',
    email: 'kari@cafeen.no',
  });
  assert.equal(bank.staff.length, 1);
  assert.equal(bank.staff[0].id, portal.SIGNER_STAFF_ID);
  assert.equal(bank.staff[0].title, 'Daglig leder');
  assert.equal(bank.staff[0].name, 'Kari Nordmann');
  assert.equal(bank.staff[0].phone, '400 00 000');
  assert.equal(bank.staff[0].email, 'kari@cafeen.no');
});

test('onboarding signer is not duplicated when already in Ansatte', () => {
  const first = portal.applyIntakeSourcesToBank({}, {}, {
    name: 'Kari Nordmann',
    title: 'Daglig leder',
    phone: '40000000',
    email: 'kari@cafeen.no',
  });
  const again = portal.applyIntakeSourcesToBank(first, {}, {
    name: 'Kari Nordmann',
    title: 'Daglig leder',
    phone: '40000000',
    email: 'kari@cafeen.no',
  });
  assert.equal(again.staff.length, 1);
  assert.equal(again.staff[0].email, 'kari@cafeen.no');
});

test('name-only signup does not create an empty employee', () => {
  const bank = portal.applyIntakeSourcesToBank({}, {}, { name: 'Kari' });
  assert.equal(bank.staff.length, 0);
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

test('places text search maps the public profile name, place id, and maps url', () => {
  const rows = mapPlacesApiResults({
    places: [{
      id: 'ChIJasoldi',
      displayName: { text: 'Asoldi' },
      formattedAddress: 'Trondheim, Norge',
      googleMapsUri: 'https://maps.google.com/?cid=99',
      rating: 5,
      userRatingCount: 3,
      primaryTypeDisplayName: { text: 'Markedsføringsbyrå' },
    }],
  });
  assert.equal(rows[0].name, 'Asoldi');
  assert.equal(rows[0].placeId, 'ChIJasoldi');
  assert.equal(rows[0].mapsUrl, 'https://maps.google.com/?cid=99');
  assert.equal(rows[0].address, 'Trondheim, Norge');
  assert.equal(rows[0].type, 'Markedsføringsbyrå');
});

test('unrelated autocomplete hits are not a match for the typed profile name', () => {
  assert.equal(profileNameMatchesQuery("A Soldier's Child Foundation", 'asoldi'), false);
  assert.equal(profileNameMatchesQuery('Amryn Soldier Photography', 'asoldi media'), false);
  assert.equal(profileNameMatchesQuery('ASOL Digital', 'asoldi'), false);
  assert.equal(profileNameMatchesQuery('Asoldi', 'asoldi media'), true);
  assert.equal(profileNameMatchesQuery('Asoldi Media', 'asoldi'), true);
});

test('public profile search keeps the real place and skips unrelated hits', async () => {
  resetPlacesApiState();
  const urls = [];
  const rows = await searchPublicGoogleProfiles('asoldi media', {
    apiKey: 'test-key',
    state: { newDisabled: false, legacyDisabled: false },
    fetchImpl: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: 'ChIJwrong',
              displayName: { text: "A Soldier's Child Foundation" },
              formattedAddress: 'Smyrna, Tennessee, USA',
            },
            {
              id: 'ChIJright',
              displayName: { text: 'Asoldi' },
              formattedAddress: 'Trondheim, Norge',
              googleMapsUri: 'https://maps.google.com/?cid=99',
            },
          ],
        }),
      };
    },
  });
  assert.equal(urls.length, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Asoldi');
  assert.equal(rows[0].placeId, 'ChIJright');
});

test('profile search uses Norway Maps results when Places rejects the key', async () => {
  resetPlacesApiState();
  const rows = await searchPublicGoogleProfiles('Asoldi', {
    apiKey: 'browser-key',
    apiKeys: ['serp-key'],
    state: { newDisabled: false, legacyDisabled: false },
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes('places:searchText')) {
        return { ok: false, status: 403, json: async () => ({ error: { status: 'PERMISSION_DENIED' } }) };
      }
      if (href.includes('textsearch')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'REQUEST_DENIED', error_message: 'referer restrictions' }),
        };
      }
      if (href.includes('serpapi.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            local_results: [{ title: 'Asoldi', place_id: 'ChIJserp', address: 'Trondheim, Norge' }],
          }),
        };
      }
      throw new Error(href);
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].placeId, 'ChIJserp');
  assert.equal(rows[0].name, 'Asoldi');
});
