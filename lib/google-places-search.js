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

export async function fetchGoogleMapsPlaces(query = '', { apiKey = '', fetchImpl = fetch } = {}) {
  const q = compact(query);
  if (!q || !apiKey) return [];
  const params = new URLSearchParams({
    engine: 'google_maps',
    type: 'search',
    q,
    api_key: apiKey,
    hl: 'no',
    gl: 'no',
  });
  const response = await fetchImpl(`https://serpapi.com/search.json?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw Object.assign(new Error('Kunne ikke søke i Google-profiler.'), { status: response.status });
  }
  const payload = await response.json().catch(() => ({}));
  return mapGoogleMapsSearchResults(payload);
}
