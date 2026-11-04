/**
 * The SEO record of one sales client, kept in seo-ops/clients/<salesClientId>.json through
 * lib/seo-ops/store.js (locks, atomic writes, backups, bounded history):
 *
 *   agreedKeywords  [{ phrase, status: proposed | approved | blocked, source, quoteRef?, flags?, at, by }]
 *                   at most 3 approved, 1-6 words each, never a prescription-only substance; the
 *                   business's own name is approved only with allowBrand (400 'brand' otherwise)
 *   planSummary     the Maker's summary of its keyword plan: counts, primaries, candidates, locale.
 *                   Never a raw DataForSEO response.
 *   pageMap         optional [{ route, kind, primary, indexable }] from the Maker
 *
 * Writers:
 *  - recordPlanSummaryFromPush: the Maker's client-bundle push, on both ingest routes, before the
 *    portal sync, so a client without a portal user still gets its plan summary.
 *  - updateClientSeo / approveAgreedKeyword / blockAgreedKeyword: the admin routes
 *    (lib/routes/seo-record-routes.js).
 *  - freezeAgreedKeywords: signing, which keeps the agreed keywords as they were at that moment.
 *
 * Readers: agreedKeywordsFor, seoRecordForProfile and the consumers in lib/analytics-insights.js and
 * lib/maps-ranking.js. A record guides those consumers only once a developer has approved or blocked
 * a keyword (recordGuidesConsumers); before that their output is what it is without a record.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { salesDataRevision } from '../../data/sales.js';
import { getDataFilePath } from '../../data/storage-path.js';
import { createSeoOpsStore, SeoOpsStoreError } from './store.js';
import {
  AGREED_KEYWORD_SOURCES,
  AGREED_KEYWORD_STATUSES,
  MAX_AGREED_KEYWORD_ROWS,
  MAX_APPROVED_AGREED_KEYWORDS,
} from './agreed-limits.js';
import {
  isBrandPhrase,
  isExactBrandPhrase,
  normalizeSeoPhrase,
  regulatedTermIn,
  SEO_PHRASE_MAX_WORDS,
  seoPhraseKey,
  seoPhraseWordCount,
} from './phrase-filters.js';
import { agreedKeywordsContractText, approvedAgreedPhrases } from './contract-text.js';
import { recordGuidesConsumers } from './record-consumers.js';

/** True once a developer has approved or blocked a keyword: only then do consumers use the record. */
export { recordGuidesConsumers };

export {
  AGREED_KEYWORD_SOURCES,
  AGREED_KEYWORD_STATUSES,
  MAX_AGREED_KEYWORD_ROWS,
  MAX_APPROVED_AGREED_KEYWORDS,
} from './agreed-limits.js';

export const PLAN_SUMMARY_VERSION = 1;
export const PLAN_SUMMARY_LIMITS = Object.freeze({ primaries: 10, candidates: 50, brand: 10, pageMap: 100 });

/** Steps a delivery loop may tick from this record. None yet; the name is kept for the loop. */
export const tickSteps = Object.freeze([]);

const STATUS_RANK = { proposed: 0, approved: 1, blocked: 2 };

export class SeoRecordError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SeoRecordError';
    this.code = code;
    this.status = status;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function isoOrNull(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---------------------------------------------------------------- the store

/**
 * How long the Maker's bundle push waits for a client file another writer holds (an admin change, or
 * a lock a stopped process left behind until it goes stale). The Maker gives up on a push after 12 s,
 * so the push answers seoReason 'busy' well before that instead of waiting the store's 60 s.
 */
export const PUSH_LOCK_TIMEOUT_MS = 3_000;

let storeInstance = null;
let pushStoreInstance = null;
let storeFromTests = false;
let clock = () => new Date();

function seoStore() {
  if (!storeInstance) storeInstance = createSeoOpsStore({ now: () => clock() });
  return storeInstance;
}

/** The store the bundle push writes through: the same files and file lock, a shorter wait. */
function pushStore() {
  if (storeFromTests) return seoStore();
  if (!pushStoreInstance) pushStoreInstance = createSeoOpsStore({ now: () => clock(), lock: { timeoutMs: PUSH_LOCK_TIMEOUT_MS } });
  return pushStoreInstance;
}

/** Tests: a store (and clock) of their own, used for every write. Passing nothing goes back to the defaults. */
export function setSeoRecordStoreForTests({ store = null, now = null } = {}) {
  storeInstance = store;
  storeFromTests = Boolean(store);
  pushStoreInstance = null;
  clock = typeof now === 'function' ? now : () => new Date();
}

function nowIso() {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function cleanId(salesClientId) {
  return text(salesClientId, 120);
}

export function seoRecordExists(salesClientId) {
  const id = cleanId(salesClientId);
  if (!id) return false;
  try {
    return existsSync(seoStore().clientPath(id));
  } catch {
    return false;
  }
}

/**
 * The stored record, or null when the client has none. Never throws: a file that cannot be read is
 * reported on the console and reads as no record, so a consumer falls back to its old behaviour.
 */
export function readSeoRecord(salesClientId) {
  const id = cleanId(salesClientId);
  if (!id || !seoRecordExists(id)) return null;
  try {
    return seoStore().readClient(id);
  } catch (error) {
    console.warn(`[seo-record] record for ${id} cannot be read: ${error?.code || error?.message || error}`);
    return null;
  }
}

/**
 * True when the hub links this sales client to this portal profile: its portalBusinessId is the
 * profile's business, or, for a sales client stored without a business id, its portalUserId is the
 * profile's owner. The Maker bundle push sets both (lib/maker-bundle-sync.js).
 */
export function salesClientLinkedToProfile(client, profile) {
  if (!isPlainObject(client) || !isPlainObject(profile)) return false;
  const linkedBusiness = text(client.portalBusinessId, 200);
  if (linkedBusiness) return linkedBusiness === text(profile.businessId || profile.userId, 200);
  const linkedUser = text(client.portalUserId, 200);
  return Boolean(linkedUser) && linkedUser === text(profile.ownerUserId || profile.userId, 200);
}

/**
 * True when this portal profile is one whose consumers use the sales client's record: its data bank
 * names the sales client and the hub links the sales client back to it (salesClientLinkedToProfile).
 */
export function profileUsesSalesClientRecord(client, profile) {
  const id = cleanId(client?.id);
  return Boolean(id) && cleanId(profile?.clientDataBank?.makerLink?.salesClientId) === id && salesClientLinkedToProfile(client, profile);
}

/** True when some portal profile uses this sales client's record; the admin view calls it `linked`. */
export function seoRecordPortalLinked(client, profiles = []) {
  return (Array.isArray(profiles) ? profiles : []).some((profile) => profileUsesSalesClientRecord(client, profile));
}

// ---------------------------------------------------------------- sales-client links

// seoRecordForProfile runs on the public site config, the analytics dashboard and every Maps refresh,
// so it never reads the sales list per call. It keeps one index, sales client id -> its portal link,
// and rebuilds it only when the sales file changes: the key is the sales store's in-process revision
// (every hub write) plus the file's mtime and size (a file replaced from outside this process).
let salesFilePathValue = '';
let salesLinkCache = { key: '', reader: null, links: null };
let salesReaderFromTests = null;

function salesFilePath() {
  if (!salesFilePathValue) salesFilePathValue = getDataFilePath('sales-clients.json');
  return salesFilePathValue;
}

function salesFileKey() {
  let stamp = 'none';
  try {
    const stat = statSync(salesFilePath());
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // No sales file yet: the revision alone keys the (empty) index.
  }
  return `${salesDataRevision()}|${stamp}`;
}

/**
 * The sales clients as stored in sales-clients.json, without the sales store's normalisation: the
 * link index needs only id, portalBusinessId and portalUserId, which the store keeps as they are,
 * trimmed. Throws when the file cannot be parsed (seoRecordForProfile then answers null).
 */
export function readStoredSalesClients() {
  const file = salesFilePath();
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed : [];
}

function salesClientLinks(reader) {
  // The key is taken before the read: a write during it changes the key, so the next call reads again.
  const key = salesFileKey();
  if (salesLinkCache.links && salesLinkCache.key === key && salesLinkCache.reader === reader) return salesLinkCache.links;
  const rows = reader();
  const links = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = cleanId(row?.id);
    if (!id || links.has(id)) continue;
    links.set(id, Object.freeze({ id, portalBusinessId: text(row.portalBusinessId, 200), portalUserId: text(row.portalUserId, 200) }));
  }
  salesLinkCache = { key, reader, links };
  return links;
}

/**
 * Tests: the reader the link index uses instead of the sales file (a function returning the sales
 * clients). Passing nothing goes back to the file. Either way the index is dropped.
 */
export function setSeoRecordSalesReaderForTests(reader = null) {
  salesReaderFromTests = typeof reader === 'function' ? reader : null;
  salesLinkCache = { key: '', reader: null, links: null };
}

/**
 * The SEO record for a portal profile, or null. The profile's data bank names its sales client
 * (bank.makerLink.salesClientId), but a client can edit its own bank, so that name is only a hint:
 * the record is used only when the hub's sales client points back at this profile
 * (salesClientLinkedToProfile). Otherwise the answer is null, which gives every consumer its output
 * without a record.
 *
 * Cost: a record that does not guide consumers (no keyword approved or blocked) answers null after
 * reading only the record, which is what the consumers do with such a record anyway. For one that
 * does, the link comes from the index above, so the sales file is read at most once per change of it.
 * `readSalesClients` replaces the sales file as the index's source (tests).
 */
export function seoRecordForProfile(profile, { readSalesClients = null } = {}) {
  const id = cleanId(profile?.clientDataBank?.makerLink?.salesClientId);
  if (!id) return null;
  const record = readSeoRecord(id);
  if (!recordGuidesConsumers(record)) return null;
  let client = null;
  try {
    client = salesClientLinks(readSalesClients || salesReaderFromTests || readStoredSalesClients).get(id) || null;
  } catch (error) {
    console.warn(`[seo-record] sales clients cannot be read: ${error?.code || error?.message || error}`);
    return null;
  }
  return salesClientLinkedToProfile(client, profile) ? record : null;
}


// ---------------------------------------------------------------- plan summary

function phraseRow(row) {
  const raw = typeof row === 'string' ? row : (row?.phrase ?? row?.keyword);
  const phrase = normalizeSeoPhrase(raw);
  if (!phrase) return null;
  const out = { phrase };
  if (isPlainObject(row)) {
    const volume = finiteOrNull(row.volume);
    if (volume !== null) out.volume = Math.max(0, Math.round(volume));
    const intent = text(row.intent, 20);
    if (intent) out.intent = intent;
    const role = text(row.role, 40);
    if (role) out.role = role;
    const difficulty = finiteOrNull(row.difficulty);
    if (difficulty !== null) out.difficulty = Math.max(0, Math.min(100, Math.round(difficulty)));
    const qa = text(row.qa, 20);
    if (qa) out.qa = qa;
  }
  return out;
}

function phraseRows(list, limit) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(list) ? list : []) {
    const clean = phraseRow(row);
    if (!clean) continue;
    const key = seoPhraseKey(clean.phrase);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanRoute(value) {
  const route = text(value, 200);
  if (!route.startsWith('/') || route.startsWith('//') || /[\s"'<>\\]/.test(route)) return '';
  return route;
}

export function sanitizePageMap(list) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(list) ? list : []) {
    if (!isPlainObject(row)) continue;
    const route = cleanRoute(row.route);
    if (!route || seen.has(route)) continue;
    seen.add(route);
    const entry = { route, kind: text(row.kind, 40), primary: normalizeSeoPhrase(row.primary), indexable: row.indexable !== false };
    out.push(entry);
    if (out.length >= PLAN_SUMMARY_LIMITS.pageMap) break;
  }
  return out;
}

/**
 * The plan summary as stored: known fields only, bounded, phrases normalised. Null for anything
 * that is not an object. Raw provider payloads have no field here, so they are never kept.
 */
export function sanitizePlanSummary(summary) {
  if (!isPlainObject(summary)) return null;
  const counts = isPlainObject(summary.counts) ? summary.counts : {};
  const language = isPlainObject(summary.language) ? summary.language : null;
  const locale = isPlainObject(summary.locale) ? summary.locale : null;
  const qa = isPlainObject(summary.qa) ? summary.qa : null;
  const spend = finiteOrNull(summary.spendUsd);
  const planVersion = finiteOrNull(summary.planVersion ?? summary.version);
  return {
    version: PLAN_SUMMARY_VERSION,
    planVersion: planVersion === null ? null : Math.floor(planVersion),
    mode: text(summary.mode, 20) || null,
    builtAt: isoOrNull(summary.builtAt),
    language: language ? { code: text(language.code, 10), name: text(language.name, 40) } : null,
    locale: locale
      ? {
        locationCode: finiteOrNull(locale.locationCode),
        languageCode: text(locale.languageCode, 10),
        country: text(locale.country || locale.locationName, 60),
      }
      : null,
    town: text(summary.town, 80),
    counts: {
      primary: count(counts.primary),
      secondary: count(counts.secondary),
      local: count(counts.local),
      questions: count(counts.questions),
      brand: count(counts.brand),
      rejected: count(counts.rejected),
      candidates: count(counts.candidates ?? counts.totalCandidates),
    },
    primaries: phraseRows(summary.primaries, PLAN_SUMMARY_LIMITS.primaries),
    candidates: phraseRows(summary.candidates, PLAN_SUMMARY_LIMITS.candidates),
    brand: phraseRows(summary.brand, PLAN_SUMMARY_LIMITS.brand).map((row) => row.phrase),
    qa: qa ? { status: text(qa.status, 20), score: finiteOrNull(qa.score) } : null,
    spendUsd: spend === null ? null : Math.max(0, Math.round(spend * 1e6) / 1e6),
  };
}

async function defaultSalesClientExists(id) {
  const sales = await import('../../data/sales.js');
  return Boolean(sales.getSalesClientById(id));
}

/**
 * Stores the Maker's plan summary for a sales client. Runs before the portal sync and needs no
 * portal user. Returns null when the push carries no summary (the response stays as before), else
 * { seoRecorded: true } or { seoRecorded: false, seoReason }. Never throws.
 * An unchanged summary writes nothing; agreed keywords are never touched.
 */
export async function recordPlanSummaryFromPush(salesClientId, summary, { salesClientExists = defaultSalesClientExists, sales = null } = {}) {
  if (summary === undefined || summary === null) return null;
  const id = cleanId(salesClientId);
  if (!id) return { seoRecorded: false, seoReason: 'no-sales-client' };
  const clean = sanitizePlanSummary(summary);
  if (!clean) return { seoRecorded: false, seoReason: 'invalid-summary' };
  const pageMap = Array.isArray(summary.pageMap) ? sanitizePageMap(summary.pageMap) : null;
  try {
    const exists = sales && typeof sales.getSalesClientById === 'function'
      ? Boolean(sales.getSalesClientById(id))
      : await salesClientExists(id);
    if (!exists) return { seoRecorded: false, seoReason: 'unknown-sales-client' };
    await pushStore().updateClient(id, (draft) => {
      const samePlan = JSON.stringify(draft.planSummary ?? null) === JSON.stringify(clean);
      const samePageMap = pageMap === null || JSON.stringify(draft.pageMap ?? null) === JSON.stringify(pageMap);
      if (samePlan && samePageMap) return null;
      draft.planSummary = clean;
      if (pageMap !== null) draft.pageMap = pageMap;
      draft.updatedAt = nowIso();
      draft.history = [...(Array.isArray(draft.history) ? draft.history : []), {
        at: draft.updatedAt,
        by: 'maker',
        action: 'plan-summary',
        builtAt: clean.builtAt,
        counts: clean.counts,
        ...(pageMap !== null ? { pageMapRoutes: pageMap.length } : {}),
      }];
      return undefined;
    });
    return { seoRecorded: true };
  } catch (error) {
    const code = error instanceof SeoOpsStoreError ? error.code : 'error';
    console.warn(`[seo-record] plan summary for ${id} not recorded: ${code}`);
    return { seoRecorded: false, seoReason: code === 'busy' || code === 'conflict' ? 'busy' : 'error' };
  }
}

/** The response fields a bundle push gets: {} when the push carried no summary (as before). */
export function seoPushResponseFields(result) {
  if (!result) return {};
  return result.seoRecorded ? { seoRecorded: true } : { seoRecorded: false, seoReason: result.seoReason || 'error' };
}

// ---------------------------------------------------------------- agreed keywords

function regulatedError(term) {
  return new SeoRecordError('regulated', `«${term}» er et reseptpliktig legemiddel og kan ikke brukes som søkeord.`);
}

/**
 * A checked agreed-keyword phrase; throws SeoRecordError for an unusable one. With
 * `regulated: false` a prescription-only substance passes (the caller decides: assertNotRegulated).
 */
export function checkAgreedPhrase(value, { regulated = true } = {}) {
  const phrase = normalizeSeoPhrase(value);
  if (!phrase || !/[\p{L}\p{N}]/u.test(phrase)) throw new SeoRecordError('empty-phrase', 'Søkeordet er tomt.');
  const words = seoPhraseWordCount(phrase);
  if (words > SEO_PHRASE_MAX_WORDS) {
    throw new SeoRecordError('too-many-words', `Et søkeord kan ha høyst ${SEO_PHRASE_MAX_WORDS} ord.`);
  }
  const term = regulated ? regulatedTermIn(phrase) : '';
  if (term) throw regulatedError(term);
  return phrase;
}

/**
 * A prescription-only substance never becomes a new proposal or a new approval (400 'regulated').
 * Blocking one is always allowed, and a stored row keeps its place (an approved row stays approved,
 * any stored row may go back to proposed), so a term added to the list later never locks a client's
 * list: the row can still be removed or blocked. Consumers and the contract line leave such a phrase
 * out anyway (approvedAgreedPhrases, recordPhraseFilter).
 */
function assertNotRegulated(phrase, { status, current }) {
  if (status === 'blocked') return;
  if (status === 'approved' && current?.status === 'approved') return;
  if (status === 'proposed' && current) return;
  const term = regulatedTermIn(phrase);
  if (term) throw regulatedError(term);
}

/** ['brand'] for the business's own name or one of the plan's brand searches, else []. */
function flagsFor(phrase, record, brandName) {
  return isBrandPhrase(phrase, text(brandName, 160), record?.planSummary?.brand) ? ['brand'] : [];
}

/**
 * Approving the business's own name (exactly a listed brand search or the name without its legal
 * form) needs allowBrand: own-name searches rank by themselves, so such a phrase is rarely worth one
 * of the three agreed keywords. A row that is already approved stays approved without it.
 */
function assertBrandAllowed(phrase, { status, current, record, brandName, allowBrand }) {
  if (status !== 'approved' || current?.status === 'approved' || allowBrand === true) return;
  if (!isExactBrandPhrase(phrase, text(brandName, 160), record?.planSummary?.brand)) return;
  throw new SeoRecordError('brand', `«${phrase}» er firmanavnet. Søk på eget navn rangerer som regel av seg selv; bekreft hvis det likevel skal være et avtalt søkeord.`);
}

function normalizeRow(input, { current, by, at, record, brandName, allowBrand = false }) {
  if (!isPlainObject(input) && typeof input !== 'string') throw new SeoRecordError('invalid-row', 'Hvert søkeord må være tekst eller et objekt.');
  const row = typeof input === 'string' ? { phrase: input } : input;
  const phrase = checkAgreedPhrase(row.phrase, { regulated: false });
  const status = row.status === undefined ? 'proposed' : String(row.status);
  if (!AGREED_KEYWORD_STATUSES.includes(status)) {
    throw new SeoRecordError('invalid-status', `Status må være ${AGREED_KEYWORD_STATUSES.join(', ')}.`);
  }
  assertNotRegulated(phrase, { status, current });
  const source = row.source === undefined ? (current?.source || 'developer') : String(row.source);
  if (!AGREED_KEYWORD_SOURCES.includes(source)) {
    throw new SeoRecordError('invalid-source', `Kilde må være ${AGREED_KEYWORD_SOURCES.join(', ')}.`);
  }
  assertBrandAllowed(phrase, { status, current, record, brandName, allowBrand: allowBrand === true || row.allowBrand === true });
  const quoteRef = text(row.quoteRef ?? current?.quoteRef ?? '', 120);
  const unchanged = current && current.status === status && current.phrase === phrase;
  const out = {
    phrase,
    status,
    source,
    at: unchanged ? current.at : at,
    by: unchanged ? current.by : by,
  };
  if (quoteRef) out.quoteRef = quoteRef;
  const flags = flagsFor(phrase, record, brandName);
  if (flags.length) out.flags = flags;
  return out;
}

function approvedCount(rows) {
  return rows.filter((row) => row.status === 'approved').length;
}

function assertLimits(rows) {
  if (approvedCount(rows) > MAX_APPROVED_AGREED_KEYWORDS) {
    throw new SeoRecordError('too-many-approved', `Høyst ${MAX_APPROVED_AGREED_KEYWORDS} avtalte søkeord kan være godkjent.`);
  }
  if (rows.length > MAX_AGREED_KEYWORD_ROWS) {
    throw new SeoRecordError('too-many-rows', `Høyst ${MAX_AGREED_KEYWORD_ROWS} søkeord kan lagres.`);
  }
}

function historyRow(at, by, action, extra = {}) {
  return { at, by: text(by, 120) || 'admin', action, ...extra };
}

async function changeRecord(salesClientId, mutate) {
  const id = cleanId(salesClientId);
  if (!id) throw new SeoRecordError('no-sales-client', 'Mangler salgskunde.', 404);
  return seoStore().updateClient(id, mutate);
}

/**
 * Replaces the agreed keywords (PUT). Duplicates (same phrase, any case) collapse to one row, the
 * strongest status winning (blocked, approved, proposed). Rows that keep their status keep their
 * time and author. Throws SeoRecordError (400) for a bad row, a regulated phrase, more than 3
 * approved keywords or a newly approved own-name phrase without allowBrand on its row; nothing is
 * written then.
 */
export async function updateClientSeo(salesClientId, { agreedKeywords } = {}, { by = '', brandName = '' } = {}) {
  if (!Array.isArray(agreedKeywords)) throw new SeoRecordError('invalid-body', 'agreedKeywords må være en liste.');
  const at = nowIso();
  return changeRecord(salesClientId, (draft) => {
    const before = Array.isArray(draft.agreedKeywords) ? draft.agreedKeywords : [];
    const byKey = new Map(before.map((row) => [seoPhraseKey(row.phrase), row]));
    const next = new Map();
    for (const input of agreedKeywords) {
      const phrase = typeof input === 'string' ? input : input?.phrase;
      const key = seoPhraseKey(phrase);
      const row = normalizeRow(input, { current: byKey.get(key), by, at, record: draft, brandName });
      const kept = next.get(key);
      if (!kept || STATUS_RANK[row.status] > STATUS_RANK[kept.status]) next.set(key, row);
    }
    const rows = [...next.values()];
    assertLimits(rows);
    if (JSON.stringify(rows) === JSON.stringify(before)) return null;
    draft.agreedKeywords = rows;
    draft.updatedAt = at;
    draft.history = [...(Array.isArray(draft.history) ? draft.history : []), historyRow(at, by, 'agreed-put', {
      approved: approvedCount(rows),
      blocked: rows.filter((row) => row.status === 'blocked').length,
      proposed: rows.filter((row) => row.status === 'proposed').length,
    })];
    return undefined;
  });
}

async function setStatus(salesClientId, phraseInput, status, { by = '', source = '', quoteRef = '', reason = '', brandName = '', allowBrand = false } = {}) {
  const phrase = checkAgreedPhrase(phraseInput, { regulated: false });
  const key = seoPhraseKey(phrase);
  const at = nowIso();
  return changeRecord(salesClientId, (draft) => {
    const rows = Array.isArray(draft.agreedKeywords) ? draft.agreedKeywords.map((row) => ({ ...row })) : [];
    const index = rows.findIndex((row) => seoPhraseKey(row.phrase) === key);
    const current = index === -1 ? null : rows[index];
    if (current?.status === status) return null;
    const row = normalizeRow({
      phrase,
      status,
      source: source || current?.source || 'developer',
      quoteRef: quoteRef || current?.quoteRef || '',
    }, { current: null, by, at, record: draft, brandName, allowBrand });
    if (index === -1) rows.push(row);
    else rows[index] = row;
    assertLimits(rows);
    draft.agreedKeywords = rows;
    draft.updatedAt = at;
    draft.history = [...(Array.isArray(draft.history) ? draft.history : []), historyRow(at, by, status === 'approved' ? 'approve' : 'block', {
      phrase,
      from: current?.status || null,
      ...(reason ? { reason: text(reason, 200) } : {}),
    })];
    return undefined;
  });
}

export function approveAgreedKeyword(salesClientId, phrase, options = {}) {
  return setStatus(salesClientId, phrase, 'approved', options);
}

export function blockAgreedKeyword(salesClientId, phrase, options = {}) {
  return setStatus(salesClientId, phrase, 'blocked', options);
}

/**
 * Agreed keyword phrases of a client (an id or a record already read), by status. Approved ones by
 * default, in approval order; never a regulated phrase.
 */
export function agreedKeywordsFor(salesClientIdOrRecord, { status = 'approved' } = {}) {
  const record = isPlainObject(salesClientIdOrRecord) ? salesClientIdOrRecord : readSeoRecord(salesClientIdOrRecord);
  if (!record) return [];
  if (status === 'approved') return approvedAgreedPhrases(record);
  const rows = Array.isArray(record.agreedKeywords) ? record.agreedKeywords : [];
  return rows.filter((row) => row?.status === status).map((row) => normalizeSeoPhrase(row.phrase)).filter(Boolean);
}

/**
 * The agreed keywords as they stand now, for signing: { salesClientId, phrases, contractText,
 * frozenAt, ref }, frozen. With `record: true` (default) a history row notes the freeze.
 */
export async function freezeAgreedKeywords(salesClientId, { by = 'signing', ref = '', record = true } = {}) {
  const id = cleanId(salesClientId);
  const current = readSeoRecord(id);
  const phrases = current ? approvedAgreedPhrases(current) : [];
  const frozenAt = nowIso();
  if (record && current && phrases.length) {
    await changeRecord(id, (draft) => {
      draft.history = [...(Array.isArray(draft.history) ? draft.history : []), historyRow(frozenAt, by, 'freeze', {
        phrases,
        ...(ref ? { ref: text(ref, 120) } : {}),
      })];
      return undefined;
    });
  }
  return Object.freeze({
    salesClientId: id,
    phrases: Object.freeze([...phrases]),
    contractText: current ? agreedKeywordsContractText(current) : null,
    frozenAt,
    ref: text(ref, 120),
  });
}

// ---------------------------------------------------------------- views

/**
 * What the admin routes return for a record (null when the client has none). `linked` is whether a
 * portal profile uses the record (seoRecordPortalLinked, computed by the caller): until one does, the
 * site config, the Maps keywords and the dashboard ignore it, even when guidesConsumers is true.
 */
export function seoRecordView(record, { historyRows = 20, linked = false } = {}) {
  if (!record) return null;
  return {
    salesClientId: record.salesClientId,
    agreedKeywords: Array.isArray(record.agreedKeywords) ? record.agreedKeywords : [],
    planSummary: record.planSummary || null,
    pageMap: Array.isArray(record.pageMap) ? record.pageMap : [],
    compliance: record.compliance || null,
    updatedAt: record.updatedAt || null,
    guidesConsumers: recordGuidesConsumers(record),
    linked: linked === true,
    contractText: agreedKeywordsContractText(record),
    history: (Array.isArray(record.history) ? record.history : []).slice(-historyRows),
  };
}

/** What the Maker may read: decided keywords, the page map and which plan the hub holds. */
export function makerSeoRecordView(record) {
  if (!record) return null;
  const rows = Array.isArray(record.agreedKeywords) ? record.agreedKeywords : [];
  return {
    salesClientId: record.salesClientId,
    agreedKeywords: rows
      .filter((row) => row?.status === 'approved' || row?.status === 'blocked')
      .map((row) => ({ phrase: row.phrase, status: row.status, source: row.source })),
    pageMap: Array.isArray(record.pageMap) ? record.pageMap : [],
    planBuiltAt: record.planSummary?.builtAt || null,
    updatedAt: record.updatedAt || null,
  };
}
