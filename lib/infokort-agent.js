/**
 * Infokort finder: Claude Haiku 5.5 tool loop. Same bar as the Cursor /infokort skill.
 * Finds and proves links. Writes only 100% matches. Empty is valid.
 * Also writes clientBrief.short / full from the proven pack. No DeepSeek.
 */

import { persistClientBrief } from './sales-kundekort.js';
import {
  canonicalizeFacebookUrl,
  canonicalizeInstagramUrl,
  cityFromSalesClient,
  distinctiveNameTokens,
  nameMatchesText,
  readPublicPage,
  searchDataForSeoMaps,
  searchGoogle,
} from './sales-link-discovery.js';
import { looksLikeMapsOrGoogleBusinessLink, websiteUrlFromDomain } from './sales-client-links.js';
import { getSalesClientById, updateSalesClient } from '../data/sales.js';
import {
  claudeMessages,
  isAnthropicConfigured,
  toolResultMessage,
  toolUseBlocks,
} from './claude-messages.js';
import { runWithSerpApiFailover, serpApiErrorMeansNoCredits } from './serpapi-keys.js';

const MAX_ROUNDS = 14;
const PAGE_TEXT_LIMIT = 4000;
const SEARCH_ROW_LIMIT = 8;

function text(value = '') {
  return String(value ?? '').trim();
}

function digits(value = '') {
  return text(value).replace(/\D+/g, '');
}

function hostOf(value = '') {
  try {
    const raw = text(value);
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function websiteHost(value = '') {
  const url = websiteUrlFromDomain(value);
  return hostOf(url);
}

function mapsCidUrl(value = '') {
  const raw = text(value);
  const cid = raw.match(/(?:[?&]cid=|!1s)(\d{6,})/i)?.[1] || digits(raw.match(/cid=(\d+)/i)?.[1] || '');
  if (/^\d{6,}$/.test(cid)) return `https://maps.google.com/?cid=${cid}`;
  if (looksLikeMapsOrGoogleBusinessLink(raw) && raw.includes('cid=')) {
    try {
      const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      const found = text(parsed.searchParams.get('cid'));
      if (/^\d{6,}$/.test(found)) return `https://maps.google.com/?cid=${found}`;
    } catch {
      // ignore
    }
  }
  return '';
}

function proffUrlFromOrg(orgNumber = '') {
  const org = digits(orgNumber);
  if (org.length !== 9) return '';
  return `https://www.proff.no/selskap/x/x/x/${org}`;
}

const REGISTRY_BRIEF_RE = /br[oø]nn[oø]ysund|org\.?\s*nr|enkeltpersonforetak|aksjeselskap|næringskode|registrert i/i;

export function isRegistryBrief(value = '') {
  return REGISTRY_BRIEF_RE.test(text(value));
}

export function composeIdentityBrief({ businessName = '', industry = '', meetingPlace = '', extra = '' } = {}) {
  const name = text(businessName);
  const trade = text(industry);
  const town = cityFromSalesClient({ meetingPlace });
  const extraLine = isRegistryBrief(extra) ? '' : text(extra);
  const who = name && trade
    ? (town ? `${name} er ${trade} i ${town}.` : `${name} er ${trade}.`)
    : (name && town ? `${name} holder til i ${town}.` : name);
  const short = [who, extraLine && extraLine !== who ? extraLine : ''].filter(Boolean).join(' ').slice(0, 400);
  return persistClientBrief({
    short,
    full: short,
    generatedAt: new Date().toISOString(),
    source: 'infokort-haiku',
  });
}

function finalizeIdentityBrief(input, client, fields) {
  const rawShort = text(input.briefShort);
  const rawFull = text(input.briefFull);
  if (rawShort && !isRegistryBrief(rawShort)) {
    return persistClientBrief({
      short: rawShort.slice(0, 400),
      full: (rawFull && !isRegistryBrief(rawFull) ? rawFull : rawShort).slice(0, 8000),
      generatedAt: new Date().toISOString(),
      source: 'infokort-haiku',
    });
  }
  return composeIdentityBrief({
    businessName: client.businessName,
    industry: fields.industry,
    meetingPlace: fields.meetingPlace,
    extra: rawShort,
  });
}

function keepFilled(next, prev) {
  return text(next) || text(prev);
}

export function isInfokortAgentConfigured() {
  return isAnthropicConfigured();
}

export const INFOKORT_TOOLS = [
  {
    name: 'brreg_get',
    description: 'Look up a Norwegian company in Brønnøysund by 9-digit org.nr. Ignore naeringskode as industry.',
    input_schema: {
      type: 'object',
      properties: { orgNumber: { type: 'string' } },
      required: ['orgNumber'],
    },
  },
  {
    name: 'brreg_search',
    description: 'Search Brønnøysund by business name. Returns candidates with org.nr and address.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'google_search',
    description: 'Google web search (SerpAPI). Use name + town + org.nr. Open candidates with open_page. Do not trust a snippet alone.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'maps_search',
    description: 'Google Maps search. Returns place name, address, phone, category, cid. Keep cid only when name plus address or phone match this company.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'open_page',
    description: 'Open a URL and read title plus visible text. Use this to prove Proff, the website, Instagram, Facebook, or Maps.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'submit_card',
    description: 'Finish. Write only proven fields. Empty string means leave empty. briefShort is what the business is and what they do, including the industry word.',
    input_schema: {
      type: 'object',
      properties: {
        industry: { type: 'string' },
        meetingPlace: { type: 'string' },
        orgNumber: { type: 'string' },
        websiteDomain: { type: 'string' },
        instagramUrl: { type: 'string' },
        facebookUrl: { type: 'string' },
        proffUrl: { type: 'string' },
        googleBusinessProfile: { type: 'string' },
        otherLinks: { type: 'string' },
        briefShort: { type: 'string' },
        briefFull: { type: 'string' },
        proof: { type: 'array', items: { type: 'string' } },
      },
      required: ['industry', 'meetingPlace', 'orgNumber', 'websiteDomain', 'instagramUrl', 'facebookUrl', 'proffUrl', 'googleBusinessProfile'],
    },
  },
];

export const INFOKORT_SYSTEM = `You fill a Norwegian sales client card. You FIND links, then PROVE them. You do not only check URLs already on the card.

Certainty bar (same as Asoldi /infokort):
- Write a value only when the opened page is THIS company: same legal or trading name AND the same address OR the same phone (or org.nr on Proff / Brønnøysund / the site).
- Instagram / Facebook: profile name + bio/About + address or phone or official website. A login wall is not a missing page. If Google shows one official profile whose handle is the proven website brand (tass.norge for tass.no) or the title names this company, write that URL.
- Google Maps: place name + address or phone. Store https://maps.google.com/?cid=<digits> only for that place. A pin for a different shop stays off.
- Website: the page names this company (about / footer / org.nr). Store the host only (tass.no), never https://.
- Proff: https://www.proff.no/selskap/x/x/x/<9-digit-orgnr>. The page must be this org.nr.
- Exclude when the page does not exist, the match is another business, you are more unsure than sure, or you only have a similar name in the same town.
- Empty is a valid result. Bakkes with only Proff is correct if no public socials or Maps exist.

Industry is what they sell or do, one short Norwegian word or phrase (dagligvare, motorsykkelverksted, markedsplass, bilverksted, arkitekt). Use their site, Instagram, Facebook, and the live Maps category. Do NOT copy Brønnøysund naeringskode / Proff bransje when that code is leftover or wrong. Deles Are Terjesen is markedsplass (TASS), not reklamebyrå.

Address is the current business address. Prefer the street that Maps + Facebook + the site + Brønnøysund forretningsadresse agree on. An old Google place with the same phone and a different street is not the card address.

Research order:
1. brreg_get when org.nr exists. Read name, forretningsadresse, hjemmeside. Ignore NACE.
2. Open the canonical Proff URL.
3. google_search name + town + org.nr. open_page candidates.
4. maps_search name + street. Keep cid only for that place.
5. Open homepage and about when a domain exists.
6. Search Instagram and Facebook, then open_page the profile. A login wall is not proof the page is missing — leave empty if you cannot prove it. A 404 plus no search hit is enough to leave empty / clear.
7. otherLinks: extra URLs that are 100% theirs and are not Instagram, Facebook, Proff, Maps, email, or the website host.

Facts you put in the brief must also be written to the matching card field. Brønnøysund forretningsadresse and hjemmeside for this org.nr are proven — write the address and the website host. After you learn a trading name (TASS from tass.no), search that name for Instagram, Facebook, and Maps, not only the legal name.

If the legal name itself states the trade and no public pages exist (Bakkes Bilpleie, Lied Arkitektur), write that trade as industry (bilpleie, arkitekt). Do not leave industry empty when the name is the trade.

Then write briefShort for the developer card (the line next to Ingen domene / Workshop ikke holdt): 2–3 Norwegian sentences that say what kind of business this is and what they do. Include the industry word in the sentence. Example: "Bakkes Bilpleie er bilpleie i Kristiansand. De vasker og pleier biler." Not a Brønnøysund dump — no org.nr, no enkeltpersonforetak, no NACE, no "registrert i". briefFull is the same summary plus at most two extra sentences from proven pages. If you only have the name and industry, one sentence is enough. Never invent a link to make the prose nicer.

Stored card values are hints only. Re-prove them. Clear a stored link that fails proof.

Do not change contact person, emails, phone, meeting time, notes, product, owner.

Finish with submit_card.`;

function cardSnapshot(client = {}) {
  const details = client.details && typeof client.details === 'object' ? client.details : {};
  return {
    id: text(client.id),
    businessName: text(client.businessName),
    orgNumber: digits(client.orgNumber),
    industry: text(client.industry),
    meetingPlace: text(client.meetingPlace || client.businessAddress),
    businessAddress: text(client.businessAddress),
    websiteDomain: websiteHost(client.websiteDomain),
    contactPhone: text(client.contactPhone),
    instagramUrl: text(details.instagramUrl),
    facebookUrl: text(details.facebookUrl),
    proffUrl: text(details.proffUrl),
    googleBusinessProfile: text(details.googleBusinessProfile),
    otherLinks: text(details.otherLinks),
  };
}

async function brregGet(orgNumber, fetchImpl = fetch) {
  const org = digits(orgNumber);
  if (org.length !== 9) return { ok: false, error: 'org-number-must-be-9-digits' };
  const response = await fetchImpl(`https://data.brreg.no/enhetsregisteret/api/enheter/${org}`, {
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) {
    const under = await fetchImpl(`https://data.brreg.no/enhetsregisteret/api/underenheter/${org}`, {
      headers: { Accept: 'application/json' },
    });
    if (!under.ok) return { ok: false, error: `brreg-${under.status}` };
    const row = await under.json();
    return {
      ok: true,
      kind: 'underenhet',
      name: text(row.navn),
      orgNumber: digits(row.organisasjonsnummer),
      parentOrgNumber: digits(row.overordnetEnhet),
      address: formatBrregAddress(row.forretningsadresse || row.beliggenhetsadresse),
      website: text(row.hjemmeside),
      nace: text(row.naeringskode1?.beskrivelse),
    };
  }
  if (!response.ok) return { ok: false, error: `brreg-${response.status}` };
  const row = await response.json();
  return {
    ok: true,
    kind: 'enhet',
    name: text(row.navn),
    orgNumber: digits(row.organisasjonsnummer),
    address: formatBrregAddress(row.forretningsadresse || row.beliggenhetsadresse),
    website: text(row.hjemmeside),
    nace: text(row.naeringskode1?.beskrivelse),
    note: 'Ignore nace when choosing industry.',
  };
}

function formatBrregAddress(addr = {}) {
  const row = addr && typeof addr === 'object' ? addr : {};
  return [text(row.adresse?.[0] || row.adresse), text(row.postnummer), text(row.poststed)]
    .filter(Boolean)
    .join(' ');
}

async function brregSearch(name, fetchImpl = fetch) {
  const query = text(name);
  if (query.length < 2) return { ok: false, error: 'name-too-short' };
  const response = await fetchImpl(
    `https://data.brreg.no/enhetsregisteret/api/enheter?navn=${encodeURIComponent(query)}&size=8`,
    { headers: { Accept: 'application/json' } }
  );
  if (!response.ok) return { ok: false, error: `brreg-${response.status}` };
  const payload = await response.json().catch(() => ({}));
  const rows = Array.isArray(payload?._embedded?.enheter) ? payload._embedded.enheter : [];
  return {
    ok: true,
    results: rows.map((row) => ({
      name: text(row.navn),
      orgNumber: digits(row.organisasjonsnummer),
      address: formatBrregAddress(row.forretningsadresse || row.beliggenhetsadresse),
      website: text(row.hjemmeside),
    })),
  };
}

async function mapsSearch(query, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const q = text(query);
  if (!q) return { ok: false, error: 'empty-query' };
  const fromDfs = await searchDataForSeoMaps(q, { fetchImpl, timeoutMs: Math.max(timeoutMs, 20000) });
  if (fromDfs.ok && Array.isArray(fromDfs.results) && fromDfs.results.length) return fromDfs;
  const failover = await runWithSerpApiFailover(async (apiKey) => {
    const params = new URLSearchParams({
      engine: 'google_maps',
      q,
      api_key: apiKey,
      hl: 'no',
      gl: 'no',
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
      const places = Array.isArray(payload?.local_results) ? payload.local_results : [];
      const value = places.slice(0, 6).map((place) => {
        const cid = text(place?.data_cid || place?.dataCid || place?.cid);
        return {
          title: text(place?.title),
          address: text(place?.address),
          phone: text(place?.phone),
          type: text(place?.type),
          website: text(place?.website),
          cid,
          mapsUrl: /^\d{6,}$/.test(cid) ? `https://maps.google.com/?cid=${cid}` : '',
        };
      });
      return { status: 'ok', value };
    } catch (error) {
      return { status: 'error', error };
    } finally {
      clearTimeout(timer);
    }
  });
  if (failover.ok) return { ok: true, results: failover.value };
  return { ok: false, error: failover.reason || 'maps-search-failed' };
}

async function runTool(name, input, deps) {
  const fetchImpl = deps.fetchImpl || fetch;
  if (name === 'brreg_get') return brregGet(input.orgNumber, fetchImpl);
  if (name === 'brreg_search') return brregSearch(input.name, fetchImpl);
  if (name === 'google_search') {
    const rows = await (deps.search || searchGoogle)(text(input.query), { fetchImpl });
    return {
      ok: true,
      results: (Array.isArray(rows) ? rows : []).slice(0, SEARCH_ROW_LIMIT).map((row) => ({
        url: text(row.url),
        title: text(row.title),
        snippet: text(row.snippet).slice(0, 280),
        kind: text(row.kind),
      })),
    };
  }
  if (name === 'maps_search') return mapsSearch(input.query, { fetchImpl });
  if (name === 'open_page') {
    const page = await (deps.readPage || readPublicPage)(text(input.url), { fetchImpl });
    return {
      ok: Boolean(page?.ok),
      url: text(page?.finalUrl || input.url),
      title: text(page?.title),
      blocked: Boolean(page?.blocked),
      text: text(page?.text).slice(0, PAGE_TEXT_LIMIT),
    };
  }
  if (name === 'submit_card') return { ok: true, submitted: true };
  return { ok: false, error: `unknown-tool:${name}` };
}

const NAME_INDUSTRY = [
  [/bilpleie/i, 'bilpleie'],
  [/motorsykkel/i, 'motorsykkelverksted'],
  [/bilverksted|\bverksted\b/i, 'bilverksted'],
  [/arkitekt/i, 'arkitekt'],
  [/dagligvare|matbutikk/i, 'dagligvare'],
];

function industryFromName(businessName = '') {
  const name = text(businessName);
  for (const [pattern, industry] of NAME_INDUSTRY) {
    if (pattern.test(name)) return industry;
  }
  return '';
}

export async function attachRegistryDefaults(submission, client = {}, fetchImpl = fetch) {
  const next = submission && typeof submission === 'object' ? { ...submission, details: { ...(submission.details || {}) } } : null;
  if (!next) return submission;
  const org = digits(next.orgNumber || client.orgNumber);
  if (!org) return next;
  const reg = await brregGet(org, fetchImpl);
  if (!reg.ok) return next;
  let company = reg;
  if (reg.kind === 'underenhet' && digits(reg.parentOrgNumber)) {
    const parent = await brregGet(reg.parentOrgNumber, fetchImpl);
    if (parent.ok && parent.kind === 'enhet') {
      company = parent;
      next.orgNumber = parent.orgNumber;
    }
  }
  const brregAddr = text(company.address);
  if (brregAddr) {
    const currentKey = streetKey(next.meetingPlace);
    const storedKey = streetKey(client.meetingPlace || client.businessAddress);
    if (!currentKey || currentKey === storedKey) {
      next.meetingPlace = brregAddr;
      next.businessAddress = brregAddr;
    }
  }
  if (!text(next.websiteDomain) && text(company.website)) {
    next.websiteDomain = websiteHost(company.website);
  }
  if (!text(next.details.proffUrl) && digits(next.orgNumber).length === 9) {
    next.details.proffUrl = proffUrlFromOrg(next.orgNumber);
  }
  if (!text(next.industry)) {
    next.industry = industryFromName(client.businessName || company.name);
  }
  return next;
}

export function normalizeInfokortSubmission(raw = {}, client = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const orgNumber = digits(input.orgNumber || client.orgNumber);
  const meetingPlace = text(input.meetingPlace);
  const websiteDomain = websiteHost(input.websiteDomain);
  const instagramUrl = canonicalizeInstagramUrl(input.instagramUrl);
  const facebookUrl = canonicalizeFacebookUrl(input.facebookUrl);
  const googleBusinessProfile = mapsCidUrl(input.googleBusinessProfile);
  const proffUrl = text(input.proffUrl).includes(orgNumber) && orgNumber.length === 9
    ? `https://www.proff.no/selskap/x/x/x/${orgNumber}`
    : (proffUrlFromOrg(orgNumber) || text(input.proffUrl));
  const industry = text(input.industry) || industryFromName(client.businessName);
  const brief = finalizeIdentityBrief(input, client, { industry, meetingPlace });
  return {
    industry,
    meetingPlace,
    businessAddress: meetingPlace,
    orgNumber,
    websiteDomain,
    details: {
      instagramUrl,
      facebookUrl,
      proffUrl,
      googleBusinessProfile,
      otherLinks: text(input.otherLinks),
    },
    clientBrief: brief,
    proof: Array.isArray(input.proof) ? input.proof.map((line) => text(line)).filter(Boolean) : [],
  };
}

function brandToken(host = '') {
  const first = websiteHost(host).split('.')[0];
  return first.length >= 3 ? fold(first) : '';
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

function handleFitsBrand(handle, brand) {
  const compact = fold(handle).replace(/[^a-z0-9]+/g, '');
  const token = fold(brand).replace(/[^a-z0-9]+/g, '');
  if (!token || token.length < 3 || !compact) return false;
  if (compact === token || compact === `${token}norge` || compact === `${token}norway` || compact === `${token}no`) {
    return 'exact';
  }
  if (compact.startsWith(token) && compact.length <= token.length + 10) return 'prefix';
  return '';
}

function companyEvidence(evidence, client, submission) {
  if (nameMatchesText(client.businessName, evidence)) return true;
  const host = websiteHost(submission.websiteDomain);
  if (host && fold(evidence).includes(fold(host))) return true;
  const phone = digits(client.contactPhone);
  if (phone.length >= 8 && digits(evidence).includes(phone.slice(-8))) return true;
  const street = streetKey(submission.meetingPlace).split(' ').find((part) => part.length >= 6);
  return Boolean(street && fold(evidence).includes(street));
}

function townFromAddress(value = '') {
  const parts = text(value).split(/[,\s]+/).filter((part) => /[a-zA-ZæøåÆØÅ]{3,}/.test(part));
  return parts[parts.length - 1] || '';
}

function pickTradeProfile(rows, provider, client, submission) {
  const canon = provider === 'instagram' ? canonicalizeInstagramUrl : canonicalizeFacebookUrl;
  const brand = brandToken(submission.websiteDomain);
  const ranked = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = canon(row?.url);
    if (!url) continue;
    const handle = profileHandle(provider, url);
    const evidence = `${text(row?.title)} ${text(row?.snippet)} ${handle}`;
    const brandFit = brand ? handleFitsBrand(handle, brand) : '';
    const nameHit = nameMatchesText(client.businessName, `${row?.title || ''} ${handle}`)
      || nameMatchesText(client.businessName, row?.snippet || '');
    const proven = companyEvidence(evidence, client, submission);
    if (!brandFit && !nameHit) continue;
    if (!proven && brandFit !== 'exact') continue;
    let score = 0;
    if (brandFit === 'exact') score += 5;
    if (brandFit === 'prefix') score += 2;
    if (nameHit) score += 3;
    if (proven) score += 4;
    ranked.push({ url, score });
  }
  ranked.sort((left, right) => right.score - left.score);
  if (!ranked.length) return '';
  if (ranked[1] && ranked[0].score - ranked[1].score < 2 && ranked[0].url !== ranked[1].url) return '';
  return ranked[0].url;
}

function pickTradeMapsPlace(places, client, submission) {
  const brand = brandToken(submission.websiteDomain);
  const legal = distinctiveNameTokens(client.businessName);
  const phone = digits(client.contactPhone);
  const street = streetKey(submission.meetingPlace);
  const ranked = [];
  for (const place of Array.isArray(places) ? places : []) {
    const cid = mapsCidUrl(place?.mapsUrl || place?.cid);
    if (!cid) continue;
    const title = fold(place?.title);
    const address = fold(place?.address);
    const nameHit = (brand && title.includes(brand)) || legal.some((token) => token.length >= 4 && title.includes(token));
    if (!nameHit) continue;
    const addressHit = street && streetKey(place?.address).includes(street.split(' ')[0] || '___');
    const phoneHit = phone.length >= 8 && digits(place?.phone).includes(phone.slice(-8));
    const siteHit = websiteHost(submission.websiteDomain)
      && hostOf(place?.website) === websiteHost(submission.websiteDomain);
    if (!addressHit && !phoneHit && !siteHit) continue;
    ranked.push({ url: cid, score: (addressHit ? 3 : 0) + (phoneHit ? 3 : 0) + (siteHit ? 2 : 0) });
  }
  ranked.sort((left, right) => right.score - left.score);
  return ranked[0]?.url || '';
}

async function readWebsiteLinkRows(host, fetchImpl = fetch) {
  const site = websiteHost(host);
  if (!site) return [];
  try {
    const response = await fetchImpl(`https://${site}`, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    if (!response.ok) return [];
    const html = String(await response.text()).slice(0, 3_000_000);
    const hrefs = [...html.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map((row) => row[0].replace(/[.,);]+$/, ''));
    return [...new Set(hrefs)].map((url) => ({ url, title: site, snippet: site }));
  } catch {
    return [];
  }
}

export async function fillProvenPublicLinks(submission, client = {}, deps = {}) {
  const next = submission && typeof submission === 'object'
    ? { ...submission, details: { ...(submission.details || {}) } }
    : null;
  if (!next) return submission;
  next.details.instagramUrl = text(next.details.instagramUrl);
  next.details.facebookUrl = text(next.details.facebookUrl);
  next.details.googleBusinessProfile = mapsCidUrl(next.details.googleBusinessProfile);
  const needIg = !next.details.instagramUrl;
  const needFb = !next.details.facebookUrl;
  const needMaps = !next.details.googleBusinessProfile;
  if (!needIg && !needFb && !needMaps) return next;
  const search = deps.search || searchGoogle;
  const fetchImpl = deps.fetchImpl || fetch;
  const brand = brandToken(next.websiteDomain);
  const name = text(client.businessName);
  const town = townFromAddress(next.meetingPlace || client.meetingPlace);
  const siteRows = next.websiteDomain
    ? await (deps.readWebsite ? deps.readWebsite(next.websiteDomain) : readWebsiteLinkRows(next.websiteDomain, fetchImpl))
    : [];
  const byField = {
    instagram: siteRows.filter((row) => canonicalizeInstagramUrl(row.url)),
    facebook: siteRows.filter((row) => canonicalizeFacebookUrl(row.url)),
  };
  const queries = [];
  if (needIg && !byField.instagram.length) {
    if (brand) queries.push({ field: 'instagram', query: `${brand} instagram` });
    if (name) queries.push({ field: 'instagram', query: `${name} instagram ${town}`.trim() });
  }
  if (needFb && !byField.facebook.length) {
    if (brand) queries.push({ field: 'facebook', query: `${brand} facebook` });
    if (name) queries.push({ field: 'facebook', query: `${name} facebook ${town}`.trim() });
  }
  for (const row of queries.slice(0, 4)) {
    try {
      const hits = await search(row.query, { fetchImpl });
      byField[row.field].push(...(Array.isArray(hits) ? hits : []));
    } catch {
      // Search miss stays empty.
    }
  }
  if (needIg) next.details.instagramUrl = pickTradeProfile(byField.instagram, 'instagram', client, next);
  if (needFb) next.details.facebookUrl = pickTradeProfile(byField.facebook, 'facebook', client, next);
  if (needMaps) {
    const fromSite = siteRows
      .map((row) => mapsCidUrl(row.url))
      .find(Boolean);
    if (fromSite) {
      next.details.googleBusinessProfile = fromSite;
    } else {
      const searchMaps = deps.mapsSearch || ((query) => mapsSearch(query, { fetchImpl }));
      const mapsQueries = [brand && town ? `${brand} ${town}` : '', name && town ? `${name} ${town}` : '']
        .map((query) => text(query))
        .filter(Boolean)
        .slice(0, 2);
      for (const query of mapsQueries) {
        const found = await searchMaps(query);
        if (!found?.ok) continue;
        const cid = pickTradeMapsPlace(found.results, client, next);
        if (cid) {
          next.details.googleBusinessProfile = cid;
          break;
        }
      }
    }
  }
  return next;
}

export function applyInfokortResult(clientId, submission, { persist = true, update = updateSalesClient, current = null } = {}) {
  const id = text(clientId);
  if (!id) return null;
  const existing = current && typeof current === 'object' ? current : (getSalesClientById(id) || {});
  const prev = existing.details && typeof existing.details === 'object' ? existing.details : {};
  const next = submission.details && typeof submission.details === 'object' ? submission.details : {};
  const existingOrg = digits(existing.orgNumber);
  const patch = {
    industry: text(submission.industry) || text(existing.industry),
    meetingPlace: text(submission.meetingPlace) || text(existing.meetingPlace),
    businessAddress: text(submission.businessAddress) || text(existing.businessAddress)
      || text(submission.meetingPlace) || text(existing.meetingPlace),
    orgNumber: existingOrg.length === 9 ? existingOrg : text(submission.orgNumber),
    websiteDomain: text(submission.websiteDomain) || text(existing.websiteDomain),
    details: {
      instagramUrl: keepFilled(next.instagramUrl, prev.instagramUrl),
      facebookUrl: keepFilled(next.facebookUrl, prev.facebookUrl),
      proffUrl: keepFilled(next.proffUrl, prev.proffUrl),
      googleBusinessProfile: keepFilled(next.googleBusinessProfile, prev.googleBusinessProfile),
      otherLinks: keepFilled(next.otherLinks, prev.otherLinks),
    },
    clientBrief: submission.clientBrief || existing.clientBrief,
  };
  if (!persist) return { id, ...patch };
  return update(id, patch);
}

function extractJson(raw = '') {
  const source = text(raw);
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export async function runInfokortAgent(client = {}, deps = {}) {
  if (!isInfokortAgentConfigured() && !deps.chat) {
    return { ok: false, skipped: 'not-configured', submission: null };
  }
  const snapshot = cardSnapshot(client);
  const chat = deps.chat || claudeMessages;
  const messages = [
    {
      role: 'user',
      content: `Fill and check this sales card. Stored links are hints only.\n${JSON.stringify(snapshot, null, 2)}`,
    },
  ];
  let submission = null;
  let rounds = 0;
  let askedTradeSearch = false;
  let usage = { input_tokens: 0, output_tokens: 0 };
  while (rounds < MAX_ROUNDS) {
    rounds += 1;
    const reply = await chat({
      system: INFOKORT_SYSTEM,
      tools: INFOKORT_TOOLS,
      messages,
      maxTokens: 4096,
    });
    usage.input_tokens += Number(reply.usage?.input_tokens || 0);
    usage.output_tokens += Number(reply.usage?.output_tokens || 0);
    messages.push({ role: 'assistant', content: reply.content });
    const uses = toolUseBlocks(reply.content);
    if (!uses.length) {
      const textBlock = (reply.content || []).find((block) => block.type === 'text');
      const guessed = extractJson(textBlock?.text);
      if (guessed && (guessed.industry != null || guessed.orgNumber)) {
        submission = normalizeInfokortSubmission(guessed, snapshot);
        break;
      }
      messages.push({
        role: 'user',
        content: 'Finish now with submit_card. Empty fields are allowed.',
      });
      continue;
    }
    const results = [];
    for (const block of uses) {
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      if (block.name === 'submit_card') {
        submission = normalizeInfokortSubmission(input, snapshot);
        results.push({ toolUseId: block.id, content: { ok: true, submitted: true } });
        continue;
      }
      try {
        const output = await runTool(block.name, input, deps);
        results.push({ toolUseId: block.id, content: output });
      } catch (error) {
        results.push({
          toolUseId: block.id,
          content: { ok: false, error: text(error?.message) || 'tool-failed' },
          isError: true,
        });
      }
    }
    messages.push(toolResultMessage(results));
    if (submission) {
      const needsTradeSearch = !askedTradeSearch
        && !text(submission.details?.instagramUrl)
        && !text(submission.details?.facebookUrl)
        && !mapsCidUrl(submission.details?.googleBusinessProfile)
        && text(submission.websiteDomain)
        && rounds < MAX_ROUNDS;
      if (needsTradeSearch) {
        askedTradeSearch = true;
        messages.push({
          role: 'user',
          content: `Socials and Maps are still empty. Search the trading name on ${submission.websiteDomain} (not only the legal name) for Instagram, Facebook, and Maps. Then submit_card again. Leave those fields empty if still unproven.`,
        });
        submission = null;
        continue;
      }
      break;
    }
  }
  if (!submission) return { ok: false, skipped: 'no-submit', submission: null, rounds, usage };
  submission = await attachRegistryDefaults(submission, snapshot, deps.fetchImpl || fetch);
  submission = await fillProvenPublicLinks(submission, snapshot, deps);
  return { ok: true, submission, rounds, usage };
}

export function scoreInfokortMatch(expected = {}, actual = {}) {
  const exp = expected && typeof expected === 'object' ? expected : {};
  const got = actual && typeof actual === 'object' ? actual : {};
  const details = got.details || {};
  const checks = {
    industry: fold(exp.industry) === fold(got.industry) || industryAlias(exp.industry, got.industry),
    websiteDomain: websiteHost(exp.websiteDomain) === websiteHost(got.websiteDomain),
    orgNumber: digits(exp.orgNumber) === digits(got.orgNumber),
    instagramUrl: canonicalizeInstagramUrl(exp.instagramUrl) === canonicalizeInstagramUrl(details.instagramUrl || got.instagramUrl),
    facebookUrl: canonicalizeFacebookUrl(exp.facebookUrl) === canonicalizeFacebookUrl(details.facebookUrl || got.facebookUrl),
    proffOrg: digits(exp.orgNumber) === digits(got.orgNumber)
      && (digits(details.proffUrl || got.proffUrl).endsWith(digits(exp.orgNumber)) || !digits(exp.orgNumber)),
    googleCid: mapsCidUrl(exp.googleBusinessProfile) === mapsCidUrl(details.googleBusinessProfile || got.googleBusinessProfile),
    addressStreet: streetKey(exp.meetingPlace) === streetKey(got.meetingPlace) || !text(exp.meetingPlace),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return { ok: failed.length === 0, failed, checks };
}

function fold(value = '') {
  return text(value)
    .toLowerCase()
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'o')
    .replace(/[å]/g, 'a');
}

function industryAlias(expected = '', actual = '') {
  const a = fold(expected);
  const b = fold(actual);
  const aliases = [
    ['markedsplass', 'markedsplass'],
    ['bilverksted', 'bilpleie'],
    ['bilpleie', 'bilverksted'],
    ['arkitekt', 'arkitekttjenester'],
  ];
  return aliases.some(([left, right]) => (a === left && b === right) || (a === right && b === left) || (a && a === b));
}

function streetKey(value = '') {
  return fold(value).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
