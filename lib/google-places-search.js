import {
  listSerpApiKeys,
  runWithSerpApiFailover,
  serpApiErrorMeansNoCredits,
} from './serpapi-keys.js';
import {
  foldProfileText,
  mapsUrlFromPlace,
  profileNameMatchesQuery,
  rankPublicProfiles,
} from './google-place-match.js';

export { foldProfileText, mapsUrlFromPlace, profileNameMatchesQuery };

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function mapGoogleMapsSearchResults(payload = {}) {
  const local = Array.isArray(payload?.local_results) ? payload.local_results : [];
  const place = payload?.place_results && typeof payload.place_results === 'object'
    ? [payload.place_results]
    : [];
  const rows = [...local, ...place];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const name = compact(row?.title || row?.name);
    if (!name) continue;
    const placeId = compact(row?.place_id || row?.data_id);
    const address = compact(row?.address);
    const key = placeId || `${name}|${address}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      placeId,
      name,
      address,
      rating: Number(row?.rating) || 0,
      reviews: Number(row?.reviews) || 0,
      type: compact(row?.type || row?.types?.[0] || ''),
      phone: compact(row?.phone),
      website: compact(row?.website),
      mapsUrl: compact(row?.links?.place || row?.gps_coordinates?.link) || mapsUrlFromPlace({
        placeId,
        name,
        address,
      }),
    });
    if (out.length >= 8) break;
  }
  return out;
}

export async function fetchGoogleMapsPlaces(query = '', { apiKey = '', apiKeys, fetchImpl = fetch } = {}) {
  const q = compact(query);
  const envKeys = [];
  const push = (value) => {
    const key = compact(value);
    if (key && !envKeys.includes(key)) envKeys.push(key);
  };
  (Array.isArray(apiKeys) ? apiKeys : []).forEach(push);
  push(apiKey);
  if (!envKeys.length) listSerpApiKeys().forEach(push);
  if (!q || !envKeys.length) return [];

  const env = {
    SERPAPI_API_KEY: envKeys[0] || '',
    SERPAPI_API_KEY_2: envKeys[1] || '',
    SERPAPI_API_KEYS: envKeys.slice(2).join(','),
  };

  const failover = await runWithSerpApiFailover(async (key) => {
    const params = new URLSearchParams({
      engine: 'google_maps',
      type: 'search',
      q,
      api_key: key,
      hl: 'no',
      gl: 'no',
    });
    const response = await fetchImpl(`https://serpapi.com/search.json?${params}`, {
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (serpApiErrorMeansNoCredits(response.status, payload)) return { status: 'no-credits' };
      if (response.status === 429) return { status: 'throttled', retryAfterMs: 30_000 };
      return {
        status: 'error',
        error: Object.assign(new Error('Kunne ikke søke i Google-profiler.'), { status: response.status }),
      };
    }
    if (serpApiErrorMeansNoCredits(200, payload)) return { status: 'no-credits' };
    return { status: 'ok', value: mapGoogleMapsSearchResults(payload) };
  }, { env: envKeys.length ? env : process.env });

  if (failover.ok) return Array.isArray(failover.value) ? failover.value : [];
  if (failover.error) throw failover.error;
  return [];
}

const placesApiState = { newDisabled: false, legacyDisabled: false };

export function resetPlacesApiState() {
  placesApiState.newDisabled = false;
  placesApiState.legacyDisabled = false;
}

export function googleMapsApiKey(env = process.env) {
  return compact(env.GOOGLE_MAPS_API_KEY || env.GOOGLE_PLACES_API_KEY || env.VITE_GOOGLE_MAPS_API_KEY);
}

function rankProfiles(rows, query) {
  return rankPublicProfiles(rows, query);
}

function matchedProfiles(rows, query) {
  return rankProfiles(
    (Array.isArray(rows) ? rows : []).filter((row) => profileNameMatchesQuery(row?.name, query)),
    query,
  );
}

/** Places API (New) text search and legacy Text Search, same picker shape. */
export function mapPlacesApiResults(payload = {}) {
  const places = Array.isArray(payload?.places) ? payload.places : [];
  const legacy = Array.isArray(payload?.results) ? payload.results : [];
  const seen = new Set();
  const out = [];
  const push = (row) => {
    const name = compact(row.name);
    const placeId = compact(row.placeId);
    if (!name) return;
    const address = compact(row.address);
    const key = placeId || `${name}|${address}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      placeId,
      name,
      address,
      rating: Number(row.rating) || 0,
      reviews: Number(row.reviews) || 0,
      type: compact(row.type),
      mapsUrl: compact(row.mapsUrl) || mapsUrlFromPlace({ placeId, name, address }),
    });
  };
  for (const place of places) {
    push({
      placeId: place?.id,
      name: place?.displayName?.text || place?.displayName,
      address: place?.formattedAddress,
      rating: place?.rating,
      reviews: place?.userRatingCount,
      type: place?.primaryTypeDisplayName?.text || place?.primaryTypeDisplayName,
      mapsUrl: place?.googleMapsUri,
    });
  }
  for (const place of legacy) {
    push({
      placeId: place?.place_id,
      name: place?.name,
      address: place?.formatted_address,
      rating: place?.rating,
      reviews: place?.user_ratings_total,
      type: Array.isArray(place?.types) ? place.types[0] : '',
      mapsUrl: '',
    });
  }
  return out.slice(0, 8);
}

const PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.googleMapsUri',
  'places.rating',
  'places.userRatingCount',
  'places.primaryTypeDisplayName',
].join(',');

async function fetchPlacesNewTextSearch(query, apiKey, fetchImpl) {
  const response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': PLACES_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: query,
      languageCode: 'no',
      regionCode: 'NO',
      pageSize: 8,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(compact(payload?.error?.status) || 'places-new-failed');
    error.status = response.status;
    throw error;
  }
  return mapPlacesApiResults(payload);
}

async function fetchPlacesLegacyTextSearch(query, apiKey, fetchImpl) {
  const params = new URLSearchParams({
    query,
    language: 'no',
    region: 'no',
    key: apiKey,
  });
  const response = await fetchImpl(`https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`);
  const payload = await response.json().catch(() => ({}));
  const placesStatus = compact(payload?.status);
  if (!response.ok || (placesStatus && placesStatus !== 'OK' && placesStatus !== 'ZERO_RESULTS')) {
    const error = new Error(placesStatus || 'places-legacy-failed');
    error.status = response.status;
    error.placesStatus = placesStatus;
    throw error;
  }
  return mapPlacesApiResults(payload);
}

/**
 * Public Google profile for onboarding.
 * Place ID (not the owner-only Business Profile location id) is what Maps URLs,
 * the public name, and later reviews/hours hang off.
 * Text Search biased to Norway, then SerpAPI Maps. Autocomplete is not used:
 * it token-matches worldwide ("asoldi" → Soldier / ASOL).
 */
export async function searchPublicGoogleProfiles(query = '', options = {}) {
  const q = compact(query);
  if (q.length < 3) return [];
  const apiKey = compact(options.apiKey) || googleMapsApiKey(options.env || process.env);
  const fetchImpl = options.fetchImpl || fetch;
  const state = options.state || placesApiState;
  let googleRows = [];

  if (apiKey && !state.newDisabled) {
    try {
      googleRows = await fetchPlacesNewTextSearch(q, apiKey, fetchImpl);
    } catch (error) {
      const status = Number(error?.status) || 0;
      if (status === 400 || status === 403 || status === 404) state.newDisabled = true;
      googleRows = [];
    }
  }

  if (apiKey && !googleRows.length && !state.legacyDisabled) {
    try {
      googleRows = await fetchPlacesLegacyTextSearch(q, apiKey, fetchImpl);
    } catch (error) {
      const placesStatus = compact(error?.placesStatus);
      const status = Number(error?.status) || 0;
      if (placesStatus === 'REQUEST_DENIED' || status === 403) state.legacyDisabled = true;
      googleRows = [];
    }
  }

  const googleMatched = matchedProfiles(googleRows, q);
  if (googleMatched.length) return googleMatched;

  let serpRows = [];
  try {
    serpRows = await fetchGoogleMapsPlaces(q, options);
  } catch {
    serpRows = [];
  }
  return matchedProfiles(serpRows, q);
}
