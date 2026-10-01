import {
  looksLikeEmailLink,
  looksLikeMapsOrGoogleBusinessLink,
} from './sales-client-links.js';

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'med', 'og', 'av', 'en', 'et', 'ei', 'i', 'pa', 'paa', 'til',
  'as', 'asa', 'norge', 'norway', 'www', 'http', 'https', 'com', 'no',
]);

const DIRECTORY_HOST_PARTS = [
  'proff.no',
  'gulesider.no',
  '1881.no',
  'cylex.',
  'infobel.',
  'yelono.',
  'brreg.no',
  'purehelp.no',
  'forvalt.no',
  'bisnode.',
  'restaurantguru.',
  'regnskapstall.no',
  'hitta.se',
  'eniro.',
  'krak.dk',
];

const REVIEW_HOST_PARTS = [
  'trustpilot.',
  'thefork.',
  'tripadvisor.',
  'bookatable.',
  'yelp.',
];

const NEWS_HOST_SUFFIXES = [
  'nrk.no', 'vg.no', 'dagbladet.no', 'aftenposten.no', 'adressa.no', 'e24.no',
  'dn.no', 'nettavisen.no', 'tv2.no', 'bt.no', 'aftenbladet.no', 'rbnett.no',
  'gd.no', 'oa.no', 'oblad.no', 'nordlys.no', 'fosna-folket.no', 'tronderbladet.no',
  'innherred.no', 'avisagaula.no', 'nidaros.no', 'nationen.no', 'abcnyheter.no',
];

const ENCYCLOPEDIA_HOST_PARTS = ['wikipedia.org', 'snl.no', 'britannica.'];

export function hostFromUrl(value = '') {
  try {
    return new URL(value).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
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

function tokenAliases(token = '') {
  const value = sanitizeText(token);
  if (!value) return [];
  const aliases = new Set([value]);
  if (value.includes('kafe')) aliases.add(value.replace(/kafe/g, 'cafe'));
  if (value.includes('cafe')) aliases.add(value.replace(/cafe/g, 'kafe'));
  return [...aliases];
}

function haystackHasToken(haystack, token) {
  return tokenAliases(token).some((alias) => haystack.includes(alias));
}

function hostMatchesAny(host, parts) {
  return parts.some((part) => host === part || host.includes(part) || host.endsWith(part));
}

export const CONTEXT_SEARCH_SERP_PARAMS = {
  hl: 'no',
  gl: 'no',
  google_domain: 'google.no',
  location: 'Norway',
};

const LEGAL_SUFFIX_PATTERN = /\s+(?:A\/S|A\.S\.|ASA|ANS|NUF|AS|DA)\.?$/i;
const SHORT_NAME_MAX_LENGTH = 6;

export function stripLegalEntitySuffixes(value = '') {
  let name = sanitizeText(value).replace(/"/g, '');
  for (let i = 0; i < 4; i += 1) {
    const next = name.replace(LEGAL_SUFFIX_PATTERN, '').trim();
    if (next === name) break;
    name = next;
  }
  return name;
}

export function industryQueryToken(value = '') {
  const words = sanitizeText(value)
    .replace(/["']/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  const token = words.join(' ');
  if (!token || token.length > 24) return '';
  return token;
}

export function locationHintFromClient(client = {}) {
  const place = sanitizeText(client.meetingPlace || client.businessAddress || client.place);
  if (!place) return '';
  const parts = place.split(',').map((entry) => sanitizeText(entry)).filter(Boolean);
  return parts[parts.length - 1] || place;
}

export function buildContextSearchQueries(client = {}) {
  const name = stripLegalEntitySuffixes(client.businessName);
  if (!name) return [];
  const industry = industryQueryToken(client.industry);
  const alreadyHasIndustry = industry && name.toLowerCase().includes(industry.toLowerCase());
  if (name.length <= SHORT_NAME_MAX_LENGTH && industry && !alreadyHasIndustry) {
    return [`${name} ${industry}`];
  }
  return [name];
}

function isDedicatedSalesFieldHost(url = '') {
  const host = hostFromUrl(url);
  if (!host) return false;
  if (host.includes('instagram.com')) return true;
  if (host.includes('facebook.com') || host.includes('fb.com') || host.includes('m.me')) return true;
  if (host.includes('proff.no')) return true;
  return looksLikeMapsOrGoogleBusinessLink(url);
}

function isKnownWebsiteHost(url = '', client = {}) {
  const host = hostFromUrl(url);
  const known = hostFromUrl(client.websiteUrl || client.websiteDomain || '');
  return Boolean(host && known && (host === known || host.endsWith(`.${known}`) || known.endsWith(`.${host}`)));
}

function isSearchEngineJunk(url = '') {
  const host = hostFromUrl(url);
  if (!host) return true;
  if (host === 'google.com' || host.endsWith('.google.com') || host === 'google.no' || host.endsWith('.google.no')) {
    return !looksLikeMapsOrGoogleBusinessLink(url);
  }
  if (host.includes('webcache.googleusercontent.')) return true;
  if (host === 'bing.com' || host.endsWith('.bing.com')) return true;
  return false;
}

function isDirectoryHost(url = '') {
  return hostMatchesAny(hostFromUrl(url), DIRECTORY_HOST_PARTS);
}

function isEncyclopediaHost(url = '') {
  return hostMatchesAny(hostFromUrl(url), ENCYCLOPEDIA_HOST_PARTS);
}

export function classifyExtraLinkKind(url = '') {
  const host = hostFromUrl(url);
  if (!host) return '';
  if (hostMatchesAny(host, REVIEW_HOST_PARTS) || host.includes('trustpilot')) return 'reviews';
  if (NEWS_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return 'news';
  if (host.includes('avis') || /\/nyheter\//i.test(url)) return 'news';
  return '';
}

function resultLooksNorwegian(result = {}, client = {}) {
  const host = hostFromUrl(result.url);
  if (host.endsWith('.no')) return true;
  const blob = `${result.title || ''} ${result.snippet || ''} ${result.url || ''}`;
  if (/\.no(?:\/|$|\?|#|-)/i.test(blob)) return true;
  if (/\b(?:norge|norway)\b/i.test(blob)) return true;
  if (/\b(?:oslo|bergen|trondheim|stavanger|tromso|tromsø|kristiansand|drammen)\b/i.test(blob)) return true;
  const hint = locationHintFromClient(client);
  if (hint && blob.toLowerCase().includes(hint.toLowerCase())) return true;
  return false;
}

export function scoreContextLink(result = {}, client = {}) {
  const url = sanitizeText(result.url);
  const title = sanitizeText(result.title);
  const snippet = sanitizeText(result.snippet);
  if (!url) return { keep: false, kind: '', score: 0, reason: 'empty-url' };
  if (isSearchEngineJunk(url)) return { keep: false, kind: '', score: 0, reason: 'search-engine' };
  if (isDedicatedSalesFieldHost(url) || isKnownWebsiteHost(url, client)) {
    return { keep: false, kind: '', score: 0, reason: 'already-have' };
  }
  if (looksLikeEmailLink(url) || looksLikeEmailLink(title)) {
    return { keep: false, kind: '', score: 0, reason: 'email' };
  }
  if (isDirectoryHost(url)) return { keep: false, kind: '', score: 0, reason: 'directory-duplicate' };
  if (isEncyclopediaHost(url)) return { keep: false, kind: '', score: 0, reason: 'encyclopedia' };
  const nameTokens = distinctiveTokens(stripLegalEntitySuffixes(client.businessName) || client.businessName);
  if (!nameTokens.length) return { keep: false, kind: '', score: 0, reason: 'weak-business-name' };
  const haystack = contextTokens([title, snippet, url].join(' '));
  const missing = nameTokens.filter((token) => !haystackHasToken(haystack, token));
  if (missing.length) {
    return { keep: false, kind: '', score: 0, reason: 'name-not-in-result', missingTokens: missing };
  }
  if (!resultLooksNorwegian(result, client)) {
    return { keep: false, kind: '', score: 0, reason: 'not-norway' };
  }
  const kind = classifyExtraLinkKind(url);
  if (kind !== 'news' && kind !== 'reviews') {
    return { keep: false, kind: '', score: 0, reason: 'not-article-or-review' };
  }
  const position = Number.isFinite(Number(result.position)) ? Number(result.position) : 20;
  return {
    keep: true,
    kind,
    score: nameTokens.length * 3 + (kind === 'news' ? 2 : 1) + Math.max(0, 6 - position),
    reason: kind,
    matchedTokens: nameTokens,
  };
}

export function pickContextLinks(results = [], client = {}, { maxKeep = 3 } = {}) {
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
    .slice(0, Math.max(0, maxKeep));
  const rejected = judged.filter((entry) => !entry.keep).slice(0, 16);
  return { kept, rejected };
}

function limitKept(kept = [], maxKeep = 3) {
  return (Array.isArray(kept) ? kept : []).slice(0, Math.max(0, maxKeep));
}

export async function selectNovelContextLinks(candidates = [], client = {}, { judge, maxKeep = 3 } = {}) {
  const shortlist = limitKept(candidates, 8);
  if (!shortlist.length) return [];
  if (typeof judge !== 'function') return limitKept(shortlist, maxKeep);
  try {
    const picked = await judge(shortlist, client);
    if (!Array.isArray(picked)) return limitKept(shortlist, maxKeep);
    const byUrl = new Map(shortlist.map((entry) => [entry.url.replace(/\/+$/, '').toLowerCase(), entry]));
    const chosen = [];
    for (const item of picked) {
      const url = sanitizeText(item?.url || item);
      const match = byUrl.get(url.replace(/\/+$/, '').toLowerCase());
      if (match) chosen.push(match);
      if (chosen.length >= maxKeep) break;
    }
    return chosen;
  } catch {
    return limitKept(shortlist, maxKeep);
  }
}

export async function researchClientContextLinks(client = {}, { search, judge } = {}) {
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
  const engines = ['google', 'google_news'];
  for (const query of queries) {
    for (const engine of engines) {
      const rows = await searchFn(query, { engine });
      (Array.isArray(rows) ? rows : []).forEach((row, index) => {
        pooled.push({
          ...row,
          query,
          engine,
          position: Number.isFinite(Number(row?.position)) ? Number(row.position) : index,
        });
      });
    }
  }
  const picked = pickContextLinks(pooled, client, { maxKeep: 8 });
  const kept = await selectNovelContextLinks(picked.kept, client, { judge, maxKeep: 3 });
  return {
    clientId: sanitizeText(client.id),
    businessName: sanitizeText(client.businessName),
    locationHint: locationHintFromClient(client),
    queries,
    kept,
    rejected: picked.rejected,
  };
}
