import { looksLikeMapsOrGoogleBusinessLink, websiteUrlFromDomain } from './sales-client-links.js';
import {
  runWithSerpApiFailover,
  serpApiErrorMeansNoCredits,
} from './serpapi-keys.js';

const STOP_WORDS = new Set([
  'as', 'asa', 'ans', 'enk', 'da', 'nuf', 'og', 'the', 'and', 'for', 'med', 'til',
  'av', 'i', 'norge', 'norway', 'holding', 'gruppen', 'group',
]);

const DIRECTORY_HOSTS = [
  'proff.no', 'gulesider.no', '1881.no', 'brreg.no', 'purehelp.no', 'forvalt.no',
  'cylex.', 'infobel.', 'yelono.', 'tripadvisor.', 'yelp.', 'facebook.com',
  'instagram.com', 'fb.com', 'linkedin.com', 'tiktok.com', 'wikipedia.org', 'snl.no',
];

function text(value = '') {
  return String(value ?? '').trim();
}

function fold(value = '') {
  return text(value)
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'o')
    .replace(/[åÅ]/g, 'a')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function stripLegalSuffix(value = '') {
  let name = text(value).replace(/["']/g, '');
  for (let i = 0; i < 4; i += 1) {
    const next = name.replace(/\s+(?:A\/S|A\.S\.|ASA|ANS|NUF|ENK|DA|AS)\.?$/i, '').trim();
    if (next === name) break;
    name = next;
  }
  return name;
}

export function distinctiveNameTokens(value = '') {
  const tokens = fold(stripLegalSuffix(value))
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  const unique = [...new Set(tokens)];
  const long = unique.filter((token) => token.length >= 4);
  return long.length ? long : unique;
}

export function nameMatchesText(businessName = '', evidence = '') {
  const tokens = distinctiveNameTokens(businessName);
  if (!tokens.length) return false;
  const haystack = fold(evidence);
  if (!haystack) return false;
  const compactName = fold(stripLegalSuffix(businessName)).replace(/[^a-z0-9]+/g, '');
  const compactHaystack = haystack.replace(/[^a-z0-9]+/g, '');
  if (compactName.length >= 4 && compactHaystack.includes(compactName)) return true;
  return tokens.every((token) => haystack.includes(token));
}

function hostOf(value = '') {
  try {
    return new URL(value).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function coerceUrl(value = '') {
  const raw = text(value);
  if (!raw) return '';
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function canonicalizeInstagramUrl(value = '') {
  const normalized = coerceUrl(value);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    if (!parsed.host.toLowerCase().includes('instagram.com')) return '';
    const segments = parsed.pathname.split('/').map((entry) => text(entry)).filter(Boolean);
    const first = text(segments[0]).toLowerCase();
    const blocked = new Set([
      'p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'developer', 'legal',
      'about', 'popular', 'directory', 'web', 'tags',
    ]);
    if (!first || blocked.has(first)) return '';
    return `https://www.instagram.com/${segments[0]}/`;
  } catch {
    return '';
  }
}

export function canonicalizeFacebookUrl(value = '') {
  const normalized = coerceUrl(value);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const host = parsed.host.toLowerCase();
    if (!(host.includes('facebook.com') || host.includes('fb.com'))) return '';
    const segments = parsed.pathname.split('/').map((entry) => text(entry)).filter(Boolean);
    if (!segments.length) return '';
    const first = text(segments[0]).toLowerCase();
    if (first === 'profile.php') {
      const id = text(parsed.searchParams.get('id'));
      return id ? `https://www.facebook.com/profile.php?id=${encodeURIComponent(id)}` : '';
    }
    const blocked = new Set([
      'share', 'sharer', 'photos', 'photo', 'events', 'groups', 'watch', 'reel', 'reels',
      'story.php', 'permalink.php', 'marketplace', 'search', 'plugins', 'dialog', 'login',
    ]);
    if (blocked.has(first)) return '';
    if ((first === 'pages' || first === 'people' || first === 'p') && segments[1]) {
      return `https://www.facebook.com/${segments[0]}/${segments[1]}/`;
    }
    return `https://www.facebook.com/${segments[0]}/`;
  } catch {
    return '';
  }
}

function canonicalizeMapsUrl(value = '') {
  const normalized = coerceUrl(value);
  if (!normalized || !looksLikeMapsOrGoogleBusinessLink(normalized)) return '';
  return normalized;
}

function profileUrl(provider, value) {
  if (provider === 'instagram') return canonicalizeInstagramUrl(value);
  if (provider === 'facebook') return canonicalizeFacebookUrl(value);
  if (provider === 'maps') return canonicalizeMapsUrl(value);
  return '';
}

function isDirectoryHost(url = '') {
  const host = hostOf(url);
  if (!host) return true;
  return DIRECTORY_HOSTS.some((part) => host === part || host.includes(part));
}

export function serpPayloadToResults(payload = {}) {
  const rows = [];
  const organic = Array.isArray(payload?.organic_results) ? payload.organic_results : [];
  organic.forEach((entry, index) => {
    const url = coerceUrl(entry?.link || entry?.redirect_link || '');
    if (!url) return;
    rows.push({
      url,
      title: text(entry?.title),
      snippet: text(entry?.snippet || (Array.isArray(entry?.snippet_highlighted_words) ? entry.snippet_highlighted_words.join(' ') : '')),
      position: index,
    });
  });
  const places = Array.isArray(payload?.local_results)
    ? payload.local_results
    : (Array.isArray(payload?.local_results?.places) ? payload.local_results.places : []);
  places.forEach((place, index) => {
    const title = text(place?.title || place?.name);
    const snippet = text([place?.address, place?.type, place?.description].filter(Boolean).join(' '));
    const website = coerceUrl(place?.links?.website || place?.website || '');
    if (website) rows.push({ url: website, title, snippet, position: index, kind: 'website' });
    const placeId = text(place?.place_id || place?.placeId);
    const maps = coerceUrl(
      place?.link
      || place?.links?.directions
      || (placeId ? `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(placeId)}` : '')
    );
    if (maps) rows.push({ url: maps, title, snippet, position: index, kind: 'maps' });
  });
  const graph = payload?.knowledge_graph;
  const graphSite = coerceUrl(graph?.website || '');
  if (graphSite) {
    rows.push({
      url: graphSite,
      title: text(graph?.title),
      snippet: text(graph?.description),
      position: 0,
      kind: 'website',
    });
  }
  return rows.slice(0, 30);
}

export function dataForSeoOrganicToResults(payload = {}) {
  const items = payload?.tasks?.[0]?.result?.[0]?.items;
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.type === 'organic' && item.url) {
      rows.push({
        url: item.url,
        title: text(item.title),
        snippet: text(item.description),
        position: Number.isFinite(Number(item.rank_group)) ? Number(item.rank_group) - 1 : rows.length,
      });
    }
    const places = item?.type === 'local_pack' ? item.items : null;
    for (const place of Array.isArray(places) ? places : []) {
      const title = text(place?.title);
      const snippet = text(place?.description || place?.address);
      if (place?.url) rows.push({ url: place.url, title, snippet, position: 0, kind: 'maps' });
      if (place?.domain) {
        const website = coerceUrl(place.domain);
        if (website) rows.push({ url: website, title, snippet, position: 0, kind: 'website' });
      }
    }
  }
  return rows.slice(0, 30);
}

let dataForSeoSpendUsd = 0;

async function searchDataForSeoOrganic(query, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const auth = text(process.env.DATAFORSEO_AUTH)
    || (text(process.env.DATAFORSEO_LOGIN) && text(process.env.DATAFORSEO_PASSWORD)
      ? Buffer.from(`${text(process.env.DATAFORSEO_LOGIN)}:${text(process.env.DATAFORSEO_PASSWORD)}`).toString('base64')
      : '');
  if (!auth) return [];
  const cap = Number(process.env.SALES_LINK_DATAFORSEO_BUDGET_USD || 2);
  if (dataForSeoSpendUsd >= cap) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify([{
        keyword: query,
        location_code: 2578,
        language_code: 'no',
        depth: 10,
      }]),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    const cost = Number(payload?.tasks?.[0]?.cost) || Number(payload?.cost) || 0;
    if (cost) dataForSeoSpendUsd += cost;
    if (!response.ok) {
      const error = new Error(payload?.status_message || `DataForSEO HTTP ${response.status}`);
      if (response.status === 401 || response.status === 402 || response.status === 403) error.code = 'search-unavailable';
      if (error.code === 'search-unavailable') throw error;
      return [];
    }
    return dataForSeoOrganicToResults(payload);
  } catch (error) {
    if (error?.code === 'search-unavailable') throw error;
    if (process.env.SALES_LINK_DEBUG) {
      console.warn('dfs-search', error?.name || '', String(error?.message || '').slice(0, 160));
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function searchGoogle(query, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const q = text(query);
  if (!q) return [];
  const failover = await runWithSerpApiFailover(async (apiKey) => {
    const params = new URLSearchParams({
      engine: 'google',
      q,
      api_key: apiKey,
      num: '10',
      hl: 'no',
      gl: 'no',
      google_domain: 'google.no',
      location: 'Norway',
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://serpapi.com/search.json?${params}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (serpApiErrorMeansNoCredits(response.status, payload)) return { status: 'no-credits' };
      if (!response.ok) {
        if (response.status === 429) return { status: 'throttled', retryAfterMs: 30_000 };
        return { status: 'error', error: new Error(payload?.error || `SerpAPI HTTP ${response.status}`) };
      }
      if (serpApiErrorMeansNoCredits(200, payload)) return { status: 'no-credits' };
      return { status: 'ok', value: serpPayloadToResults(payload) };
    } catch (error) {
      return { status: 'error', error };
    } finally {
      clearTimeout(timer);
    }
  });
  if (failover.ok && Array.isArray(failover.value)) return failover.value;
  if (failover.reason === 'no-credits' || failover.reason === 'missing-key') {
    return searchDataForSeoOrganic(q, { fetchImpl, timeoutMs: Math.max(timeoutMs, 20000) });
  }
  return [];
}

const POST_PATH_PARTS = new Set(['videos', 'video', 'posts', 'photos', 'photo', 'reel', 'reels', 'watch']);

function isPostOrMediaUrl(value = '') {
  try {
    const parts = new URL(coerceUrl(value) || value).pathname.split('/').filter(Boolean);
    return parts.some((part) => POST_PATH_PARTS.has(part.toLowerCase()));
  } catch {
    return false;
  }
}

function profileHandle(provider, url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (provider === 'instagram') return parts[0] || '';
    if (provider === 'facebook') {
      const first = (parts[0] || '').toLowerCase();
      if (first === 'profile.php') return '';
      if ((first === 'pages' || first === 'people' || first === 'p') && parts[1]) return parts[1];
      return parts[0] || '';
    }
  } catch {
    return '';
  }
  return '';
}

function handleMatchesName(businessName, handle) {
  const compactHandle = fold(handle).replace(/[^a-z0-9]+/g, '');
  if (!compactHandle) return false;
  const compactName = fold(stripLegalSuffix(businessName)).replace(/[^a-z0-9]+/g, '');
  if (compactName.length >= 4 && compactHandle.includes(compactName)) return true;
  const tokens = distinctiveNameTokens(businessName);
  return tokens.length === 1 && compactHandle.includes(tokens[0]);
}

function scoreCandidate(result, client, provider) {
  const url = profileUrl(provider, result?.url || '');
  if (!url) return null;
  const handle = profileHandle(provider, url);
  const fromPost = isPostOrMediaUrl(result?.url || '');
  const titleHit = !fromPost && nameMatchesText(client.businessName, result?.title || '');
  const handleHit = handleMatchesName(client.businessName, handle);
  if (!titleHit && !handleHit) return null;
  const evidence = `${result?.title || ''} ${handle} ${result?.snippet || ''}`;
  const tokens = distinctiveNameTokens(client.businessName);
  const compactHandle = fold(handle).replace(/[^a-z0-9]+/g, '');
  let score = 0;
  for (const token of tokens) {
    if (fold(result?.title || '').includes(token)) score += 2;
    if (compactHandle.includes(token)) score += 3;
  }
  const compact = fold(stripLegalSuffix(client.businessName)).replace(/[^a-z0-9]+/g, '');
  if (compact.length >= 4 && compactHandle.includes(compact)) score += 4;
  if (client.city && fold(evidence).includes(fold(client.city))) score += 2;
  const position = Number.isFinite(Number(result?.position)) ? Number(result.position) : 10;
  if (position === 0) score += 1;
  return {
    url,
    score,
    evidence,
    title: text(result?.title),
    snippet: text(result?.snippet),
  };
}

export function pickNamedCandidate(results = [], client = {}, provider = 'instagram') {
  const byUrl = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const scored = scoreCandidate(result, client, provider);
    if (!scored) continue;
    const current = byUrl.get(scored.url);
    if (!current || scored.score > current.score) byUrl.set(scored.url, scored);
  }
  const ranked = [...byUrl.values()].sort((a, b) => b.score - a.score);
  if (!ranked.length) return { url: '', reason: 'no-name-match', score: 0, evidence: '' };
  const top = ranked[0];
  const second = ranked[1];
  if (second && top.score - second.score < 2) {
    return { url: '', reason: 'ambiguous', score: top.score, evidence: top.evidence, runnerUp: second.url };
  }
  return { url: top.url, reason: 'name-match', score: top.score, evidence: top.evidence, title: top.title };
}

async function runSearch(search, query) {
  try {
    const rows = await search(query);
    return { rows: Array.isArray(rows) ? rows : [], down: false };
  } catch (error) {
    if (error?.code === 'search-unavailable') return { rows: [], down: true };
    throw error;
  }
}

function socialQueries(provider, client) {
  const name = stripLegalSuffix(client.businessName);
  if (!name) return [];
  const city = text(client.city);
  const site = provider === 'facebook' ? 'facebook.com' : 'instagram.com';
  const label = provider === 'facebook' ? 'facebook' : 'instagram';
  return [
    [name, label, city, 'Norge'].filter(Boolean).join(' '),
    [`"${name}"`, `site:${site}`, city].filter(Boolean).join(' '),
  ];
}

function pageBlob(page) {
  return `${page?.title || ''} ${page?.text || ''}`;
}

function pageIsReadable(page) {
  return Boolean(page && !page.blocked && !page.error && text(page.text).length >= 180);
}

async function gateByPage(url, evidence, client, readPage, canonicalize) {
  if (!url) return { url: '', reason: 'empty' };
  const page = typeof readPage === 'function' ? await readPage(url) : { blocked: true };
  if (pageIsReadable(page)) {
    if (!nameMatchesText(client.businessName, pageBlob(page))) {
      return { url: '', reason: 'page-name-mismatch' };
    }
    const finalUrl = canonicalize(page.finalUrl || url) || url;
    return { url: finalUrl, reason: 'page-name-match' };
  }
  if (nameMatchesText(client.businessName, evidence)) {
    return { url, reason: 'name-match' };
  }
  return { url: '', reason: 'unconfirmed' };
}

async function resolveSocial(provider, client, { search, readPage }) {
  const existing = profileUrl(provider, client[provider === 'instagram' ? 'instagramUrl' : 'facebookUrl']);
  const canonicalize = (value) => profileUrl(provider, value);
  const pooled = [];
  let picked = { url: '', reason: 'no-query', evidence: '' };
  const queries = socialQueries(provider, client);
  let searchDown = false;
  for (const query of queries) {
    const outcome = await runSearch(search, query);
    if (outcome.down) {
      searchDown = true;
      break;
    }
    outcome.rows.forEach((row, index) => {
      pooled.push({ ...row, position: Number.isFinite(Number(row?.position)) ? Number(row.position) : index, query });
    });
    picked = pickNamedCandidate(pooled, client, provider);
    if (picked.url) break;
  }
  if (!queries.length) picked = { url: '', reason: 'missing-name', evidence: '' };
  if (searchDown && !picked.url) {
    return { url: existing, reason: 'search-unavailable', queries: queries.length };
  }
  const gated = await gateByPage(picked.url, picked.evidence || '', client, readPage, canonicalize);
  if (existing && existing === gated.url) {
    return { ...gated, queries: queries.length };
  }
  if (existing) {
    const existingPage = typeof readPage === 'function' ? await readPage(existing) : { blocked: true };
    if (pageIsReadable(existingPage) && nameMatchesText(client.businessName, pageBlob(existingPage))) {
      return { url: existing, reason: 'existing-page-name-match', queries: queries.length };
    }
    if (pageIsReadable(existingPage)) {
      return { ...gated, replaced: existing, reason: gated.url ? gated.reason : 'existing-page-rejected', queries: queries.length };
    }
  }
  if (gated.url) return { ...gated, queries: queries.length };
  if (existing) return { url: '', reason: 'existing-unconfirmed', queries: queries.length };
  return { url: '', reason: picked.reason || 'empty', queries: queries.length };
}

function homepageCandidate(result, client) {
  const url = websiteUrlFromDomain(result?.url || '');
  if (!url || isDirectoryHost(result?.url || '') || looksLikeMapsOrGoogleBusinessLink(result?.url || '')) return null;
  const evidence = `${result?.title || ''} ${hostOf(result?.url || '')}`;
  if (!nameMatchesText(client.businessName, evidence)) return null;
  try {
    const parsed = new URL(coerceUrl(result.url) || url);
    const depth = parsed.pathname.split('/').filter(Boolean).length;
    if (depth > 2) return null;
  } catch {
    return null;
  }
  return { url, evidence, domain: hostOf(url) };
}

async function resolveWebsite(client, { search, readPage }) {
  const existingDomain = websiteUrlFromDomain(client.websiteDomain || '');
  const existingHost = hostOf(existingDomain);
  if (existingDomain) {
    const page = typeof readPage === 'function' ? await readPage(existingDomain) : { error: true };
    if (pageIsReadable(page)) {
      if (!nameMatchesText(client.businessName, pageBlob(page))) {
        // fall through and search for a replacement
      } else {
        return { domain: existingHost, url: existingDomain, reason: 'existing-page-name-match' };
      }
    } else if (page?.error || page?.blocked) {
      return { domain: existingHost, url: existingDomain, reason: 'existing-unread' };
    }
  }
  const name = stripLegalSuffix(client.businessName);
  if (!name) return { domain: '', url: '', reason: 'missing-name' };
  const outcome = await runSearch(search, [name, text(client.city)].filter(Boolean).join(' '));
  if (outcome.down) {
    return existingHost
      ? { domain: existingHost, url: existingDomain, reason: 'search-unavailable' }
      : { domain: '', url: '', reason: 'search-unavailable' };
  }
  for (const row of outcome.rows) {
    const candidate = homepageCandidate(row, client);
    if (!candidate) continue;
    const gated = await gateByPage(candidate.url, candidate.evidence, client, readPage, (value) => websiteUrlFromDomain(value));
    if (!gated.url) continue;
    const domain = hostOf(gated.url);
    if (!domain) continue;
    return { domain, url: `https://${domain}`, reason: gated.reason };
  }
  if (existingHost) return { domain: '', url: '', reason: 'existing-page-rejected' };
  return { domain: '', url: '', reason: 'no-name-match' };
}

async function resolveMaps(client, { search, readPage }) {
  const existing = canonicalizeMapsUrl(client.googleBusinessProfile || '');
  if (existing) {
    const page = typeof readPage === 'function' ? await readPage(existing) : { error: true };
    if (pageIsReadable(page) && nameMatchesText(client.businessName, pageBlob(page))) {
      return { url: existing, reason: 'existing-page-name-match' };
    }
    if (pageIsReadable(page)) {
      // searchable replacement below
    } else if (page?.error || page?.blocked) {
      return { url: existing, reason: 'existing-unread' };
    }
  }
  const name = stripLegalSuffix(client.businessName);
  if (!name) return { url: '', reason: 'missing-name' };
  const outcome = await runSearch(search, [name, text(client.city), 'Norge'].filter(Boolean).join(' '));
  if (outcome.down) {
    return { url: existing, reason: 'search-unavailable' };
  }
  const picked = pickNamedCandidate(outcome.rows, client, 'maps');
  const gated = await gateByPage(picked.url, picked.evidence || '', client, readPage, canonicalizeMapsUrl);
  if (gated.url) return gated;
  if (existing) return { url: '', reason: 'existing-unconfirmed' };
  return { url: '', reason: picked.reason || 'empty' };
}

function extractJsonObject(value = '') {
  const raw = text(value);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function resolveCitation(uri, fetchImpl) {
  const url = coerceUrl(uri);
  if (!url) return '';
  if (!/vertexaisearch|grounding-api-redirect|google\.com\/url/i.test(url)) return url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    return coerceUrl(response.url || '') || '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function sameDestination(left, right, provider) {
  const a = provider ? profileUrl(provider, left) : websiteUrlFromDomain(left);
  const b = provider ? profileUrl(provider, right) : websiteUrlFromDomain(right);
  if (provider === 'maps') return Boolean(a && b && a === b);
  return Boolean(a && b && a === b);
}

export async function askGeminiForLinks(client = {}, missing = [], { fetchImpl = fetch } = {}) {
  const apiKey = text(process.env.GEMINI_API_KEY);
  if (!apiKey || !missing.length) return { urls: {}, chunks: [], reason: apiKey ? 'nothing-missing' : 'no-gemini-key' };
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const prompt = [
    'Find the real public links for this one Norwegian business.',
    'Use Google Search. Return JSON only, no markdown:',
    '{"instagramUrl":"","facebookUrl":"","websiteUrl":"","googleMapsUrl":""}',
    'Use an empty string when you are not sure, or when no page is clearly this business.',
    'Copy only URLs that appeared in the search results. Do not invent a handle.',
    'A similar name in another city is not a match.',
    `Missing fields: ${missing.join(', ')}.`,
    `Business name: ${text(client.businessName)}`,
    client.city ? `City: ${text(client.city)}` : '',
    client.phone ? `Phone: ${text(client.phone)}` : '',
    client.orgNumber ? `Organisation number: ${text(client.orgNumber)}` : '',
    client.address ? `Address: ${text(client.address)}` : '',
  ].filter(Boolean).join('\n');
  const request = {
    model: text(process.env.SALES_LINK_GEMINI_MODEL) || 'gemini-2.5-flash',
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0.1,
    },
  };
  let response;
  try {
    response = await ai.models.generateContent({
      ...request,
      config: { ...request.config, thinkingConfig: { thinkingBudget: 0 } },
    });
  } catch {
    response = await ai.models.generateContent(request);
  }
  const body = text(response?.text || response?.candidates?.[0]?.content?.parts?.map((part) => part.text).filter(Boolean).join('\n'));
  const parsed = extractJsonObject(body) || {};
  const metadata = response?.candidates?.[0]?.groundingMetadata || {};
  const chunks = [];
  for (const chunk of Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : []) {
    const web = chunk?.web || {};
    const resolved = await resolveCitation(web.uri || '', fetchImpl);
    if (!resolved) continue;
    chunks.push({ url: resolved, title: text(web.title) });
  }
  return {
    urls: {
      instagramUrl: text(parsed.instagramUrl),
      facebookUrl: text(parsed.facebookUrl),
      websiteUrl: text(parsed.websiteUrl),
      googleMapsUrl: text(parsed.googleMapsUrl),
    },
    chunks,
    reason: 'gemini',
  };
}

async function acceptGeminiUrl(rawUrl, provider, chunks, client, readPage) {
  const canonicalize = provider === 'website'
    ? (value) => websiteUrlFromDomain(value)
    : (value) => profileUrl(provider, value);
  const url = canonicalize(rawUrl);
  if (!url) return '';
  const cited = (Array.isArray(chunks) ? chunks : []).find((chunk) => sameDestination(chunk.url, url, provider === 'website' ? '' : provider));
  if (!cited) return '';
  const evidence = `${cited.title || ''} ${url}`;
  const gated = await gateByPage(url, evidence, client, readPage, canonicalize);
  if (!gated.url) return '';
  if (provider === 'website') return hostOf(gated.url);
  return gated.url;
}

export function cityFromSalesClient(client = {}) {
  const place = text(client.meetingPlace || client.businessAddress || client.address || '');
  if (!place) return '';
  const parts = place.split(',').map((entry) => text(entry)).filter(Boolean);
  const last = parts[parts.length - 1] || place;
  const tokens = last.split(/\s+/).filter((token) => token.length >= 3 && !/^\d{4}$/.test(token));
  return tokens[tokens.length - 1] || '';
}

export function isUpcomingSalesClient(client = {}, now = Date.now()) {
  const status = text(client.status || 'active');
  if (status === 'not-sold' || status === 'secondary') return false;
  if (text(client.product).toLowerCase() === 'ssu') return false;
  if (client.progression?.meetingHeld || client.progression?.contractSigned || client.progression?.live) return false;
  const meetingAt = Date.parse(client.meetingAt || '');
  if (Number.isFinite(meetingAt) && meetingAt <= now) return false;
  return Boolean(text(client.businessName));
}

export async function discoverSalesLinks(client = {}, deps = {}) {
  const search = deps.search || searchGoogle;
  const readPage = deps.readPage || readPublicPage;
  const askGemini = deps.askGemini === null ? null : (deps.askGemini || askGeminiForLinks);
  const input = {
    businessName: text(client.businessName),
    city: text(client.city),
    phone: text(client.phone),
    orgNumber: text(client.orgNumber),
    address: text(client.address),
    websiteDomain: text(client.websiteDomain),
    instagramUrl: text(client.instagramUrl),
    facebookUrl: text(client.facebookUrl),
    googleBusinessProfile: text(client.googleBusinessProfile),
  };
  const instagram = await resolveSocial('instagram', input, { search, readPage });
  const facebook = await resolveSocial('facebook', input, { search, readPage });
  const website = await resolveWebsite(input, { search, readPage });
  const maps = await resolveMaps(input, { search, readPage });
  const found = {
    instagramUrl: text(instagram.url),
    facebookUrl: text(facebook.url),
    websiteDomain: text(website.domain),
    googleBusinessProfile: text(maps.url),
  };
  const diagnostics = { instagram, facebook, website, maps, gemini: { reason: 'not-needed' } };
  const missing = ['instagramUrl', 'facebookUrl', 'websiteDomain', 'googleBusinessProfile'].filter((field) => !found[field]);
  if (missing.length && typeof askGemini === 'function') {
    try {
      const gemini = await askGemini(input, missing);
      diagnostics.gemini = { reason: gemini?.reason || 'gemini', missing };
      const chunks = Array.isArray(gemini?.chunks) ? gemini.chunks : [];
      if (!found.instagramUrl) {
        found.instagramUrl = await acceptGeminiUrl(gemini?.urls?.instagramUrl, 'instagram', chunks, input, readPage);
      }
      if (!found.facebookUrl) {
        found.facebookUrl = await acceptGeminiUrl(gemini?.urls?.facebookUrl, 'facebook', chunks, input, readPage);
      }
      if (!found.websiteDomain) {
        found.websiteDomain = await acceptGeminiUrl(gemini?.urls?.websiteUrl, 'website', chunks, input, readPage);
      }
      if (!found.googleBusinessProfile) {
        found.googleBusinessProfile = await acceptGeminiUrl(gemini?.urls?.googleMapsUrl, 'maps', chunks, input, readPage);
      }
    } catch (error) {
      diagnostics.gemini = { reason: 'gemini-error', message: text(error?.message) };
    }
  }
  return { ...found, diagnostics };
}

export async function readPublicPage(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const target = coerceUrl(url);
  if (!target) return { ok: false, title: '', text: '', finalUrl: '', blocked: false, error: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    const html = await response.text();
    const titleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = text(titleMatch?.[1]).replace(/\s+/g, ' ');
    const textBody = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000);
    const blocked = /logg inn|log in|login|sign up/i.test(`${title} ${textBody.slice(0, 400)}`)
      && textBody.length < 1500;
    return {
      ok: response.ok,
      title,
      text: blocked ? '' : textBody,
      finalUrl: coerceUrl(response.url || target) || target,
      blocked,
      error: false,
    };
  } catch {
    return { ok: false, title: '', text: '', finalUrl: target, blocked: false, error: true };
  } finally {
    clearTimeout(timer);
  }
}
