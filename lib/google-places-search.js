import {
  listSerpApiKeys,
  runWithSerpApiFailover,
  serpApiErrorMeansNoCredits,
} from './serpapi-keys.js';

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Official Maps search URL from a stored Google Place ID. */
export function mapsUrlFromPlace({ placeId = '', name = '', address = '' } = {}) {
  const id = compact(placeId);
  const query = compact(name) || compact(address);
  if (id) {
    const params = new URLSearchParams({ api: '1', query_place_id: id });
    if (query) params.set('query', query);
    return `https://www.google.com/maps/search/?${params.toString()}`;
  }
  if (!query) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
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
