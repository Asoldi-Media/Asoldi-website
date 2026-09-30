function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'med', 'og', 'av', 'en', 'et', 'ei', 'i', 'pa', 'paa', 'til',
  'as', 'asa', 'norge', 'norway', 'oslo', 'cafe', 'kafe', 'restaurant', 'bar',
  'www', 'http', 'https', 'com', 'no',
]);

const NEWS_HOST_SUFFIXES = [
  'nrk.no',
  'vg.no',
  'dagbladet.no',
  'aftenposten.no',
  'adressa.no',
  'e24.no',
  'dn.no',
  'tu.no',
  'finansavisen.no',
  'abcnyheter.no',
  'nettavisen.no',
  'tv2.no',
  'bt.no',
  'aftenbladet.no',
  'rbnett.no',
  'gd.no',
  'oa.no',
  'oblad.no',
  'nordlys.no',
  'itromso.no',
  'fosna-folket.no',
  'tronderbladet.no',
  'innherred.no',
  'steinkjeravisa.no',
  'steinkjer-avisa.no',
  'banett.no',
  'midtnorskdebatt.no',
  'kommunal-rapport.no',
  'nationen.no',
  'khrono.no',
  'utdanningsnytt.no',
];

export function hostFromUrl(value = '') {
  try {
    return new URL(value).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function classifyContextLinkKind(url = '') {
  const host = hostFromUrl(url);
  if (!host) return '';
  if (host.includes('trustpilot.')) return 'trustpilot';
  if (NEWS_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return 'news';
  return '';
}

export function contextTokens(value = '') {
  return sanitizeText(value)
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'o')
    .replace(/[åÅ]/g, 'a')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function distinctiveTokens(value = '') {
  return contextTokens(value).filter((token) => token.length >= 4);
}

export function locationHintFromClient(client = {}) {
  const place = sanitizeText(client.meetingPlace || client.businessAddress);
  if (!place) return '';
  const parts = place.split(',').map((entry) => sanitizeText(entry)).filter(Boolean);
  return parts[parts.length - 1] || place;
}

export function buildContextSearchQueries(client = {}) {
  const name = sanitizeText(client.businessName);
  if (!name) return [];
  const quoted = `"${name}"`;
  const city = locationHintFromClient(client);
  const queries = [
    `${quoted} Trustpilot`,
    city ? `${quoted} ${city} nyheter` : `${quoted} nyheter Norge`,
  ];
  return [...new Set(queries.map((query) => query.replace(/\s+/g, ' ').trim()))];
}

export function scoreContextLink(result = {}, client = {}) {
  const url = sanitizeText(result.url);
  const title = sanitizeText(result.title);
  const snippet = sanitizeText(result.snippet);
  const kind = classifyContextLinkKind(url);
  if (!kind) {
    return { keep: false, kind: '', score: 0, reason: 'not-trustpilot-or-news' };
  }
  const nameTokens = distinctiveTokens(client.businessName);
  if (!nameTokens.length) {
    return { keep: false, kind, score: 0, reason: 'weak-business-name' };
  }
  const haystack = contextTokens([title, snippet, url].join(' '));
  const matched = nameTokens.filter((token) => haystack.includes(token));
  if (!matched.length) {
    return { keep: false, kind, score: 0, reason: 'name-not-in-result' };
  }
  const score = matched.length * 3 + (kind === 'trustpilot' ? 2 : 1);
  return {
    keep: true,
    kind,
    score,
    reason: kind,
    matchedTokens: matched,
  };
}

export function pickContextLinks(results = [], client = {}, { maxKeep = 6 } = {}) {
  const judged = [];
  const seen = new Set();
  for (const result of Array.isArray(results) ? results : []) {
    const url = sanitizeText(result?.url);
    if (!url) continue;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const verdict = scoreContextLink(result, client);
    judged.push({
      url,
      title: sanitizeText(result.title),
      snippet: sanitizeText(result.snippet),
      query: sanitizeText(result.query),
      ...verdict,
    });
  }
  const kept = judged
    .filter((entry) => entry.keep)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, maxKeep));
  const rejected = judged.filter((entry) => !entry.keep).slice(0, 12);
  return { kept, rejected };
}

export async function researchClientContextLinks(client = {}, { search } = {}) {
  const queries = buildContextSearchQueries(client);
  if (!queries.length) {
    return {
      clientId: sanitizeText(client.id),
      businessName: sanitizeText(client.businessName),
      locationHint: locationHintFromClient(client),
      queries: [],
      kept: [],
      rejected: [],
      reason: 'missing-business-name',
    };
  }
  const searchFn = typeof search === 'function' ? search : async () => [];
  const pooled = [];
  for (const query of queries) {
    const rows = await searchFn(query);
    for (const row of Array.isArray(rows) ? rows : []) {
      pooled.push({ ...row, query });
    }
  }
  const picked = pickContextLinks(pooled, client);
  return {
    clientId: sanitizeText(client.id),
    businessName: sanitizeText(client.businessName),
    locationHint: locationHintFromClient(client),
    queries,
    ...picked,
  };
}
