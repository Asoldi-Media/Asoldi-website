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

export function foldProfileText(value = '') {
  return compact(value)
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Keep a Maps hit when the public name actually contains what was typed.
 * Autocomplete-style token hits ("asoldi" → "Soldier", "ASOL") are dropped.
 * A shorter public name still matches a longer search ("Asoldi" for "asoldi media").
 */
export function profileNameMatchesQuery(name = '', query = '') {
  const foldedName = foldProfileText(name);
  const foldedQuery = foldProfileText(query);
  if (!foldedName || !foldedQuery) return false;
  const tokens = foldedQuery.split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
  if (!tokens.length) return true;
  const longest = tokens.reduce((best, token) => (token.length > best.length ? token : best), '');
  if (foldedName.includes(longest)) return true;
  if (foldedName.length >= 4 && foldedQuery.includes(foldedName)) return true;
  return false;
}

export function rankPublicProfiles(rows = [], query = '') {
  const foldedQuery = foldProfileText(query);
  const score = (row) => {
    const name = foldProfileText(row?.name);
    if (name === foldedQuery) return 3;
    if (name.startsWith(foldedQuery) || foldedQuery.startsWith(name)) return 2;
    return 1;
  };
  return rows.slice().sort((a, b) => score(b) - score(a));
}
