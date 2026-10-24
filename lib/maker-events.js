// Maker delivery events on the hub (WS8.28): run.materials.updated and run.autopilot.updated on
// the existing status callback (same callback auth), stored on client.makerRun. Pure helpers here;
// the writer is data/sales.js setSalesMakerRunOwned.
//
// - Payloads are normalized and capped. URLs anywhere in them are dropped: the hub keeps counts,
//   page routes, page kinds and QA status, never addresses of the Maker or of uploaded files.
// - With development.makerEvents off (the default) the callback handles these events exactly as
//   before (a plain step-status update), so nothing changes until the switch is on.
// - A materials snapshot of the linked run, younger than 24 h, stands in for the live Maker run
//   fetch of the material dots when that fetch fails (the live run also carries the answers).
import {
  MATERIALS_SNAPSHOT_MAX_AGE_MS,
  MATERIALS_SUMMARY_MAX_BYTES,
  isBlockingCode,
  isMakerDeliveryEvent,
} from '../packages/suite/core/delivery/vocab.js';

export { isMakerDeliveryEvent };

const MAX_UPLOAD_FIELDS = 40;
const MAX_PAGE_KINDS = 100;
const MAX_NEEDS_ITEMS = 100;
const MAX_NEEDS_ITEM_BYTES = 1024;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const KIND_RE = /^[a-z][a-z0-9-]{0,40}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function iso(value) {
  const raw = text(value, 40);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : '';
}

function count(value, max = 100_000) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= 0 ? Math.min(number, max) : 0;
}

// Schemes that address something (also without slashes: https:example.no, mailto:x, data:...).
const ADDRESS_SCHEME_RE = /^(?:https?|ftps?|sftp|wss?|file|data|mailto|javascript|vbscript|blob|ssh|git|s3|gs):/i;
// Any other scheme followed by a slash (custom:/x, C:/x).
const SCHEME_SLASH_RE = /^[a-z][a-z0-9+.-]*:\//i;
// A host name with a port or a path, query or fragment, anywhere in the string (cdn.example.no/x,
// example.com/path, host.example:3000). A bare dotted word (contact.email, logo.png) is not one.
const HOST_RE = /(?:^|[^\w@.-])[\w-]+(?:\.[\w-]+)*\.[a-z][a-z0-9-]*(?::\d+|(?::\d+)?[/?#])/i;
const IPV4_RE = /(?:^|[^\d.])(?:\d{1,3}\.){3}\d{1,3}(?:$|[^\d.])/;
const IPV6_RE = /\[[0-9a-f:.]*:[0-9a-f:.]*\]|(?:^|[^\w:])[0-9a-f]{0,4}::(?:[0-9a-f]{0,4}:?)*|(?:^|[^\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}/i;
const LOOPBACK_RE = /\b(?:localhost|host\.docker\.internal)\b/i;
// Paths that address Maker or upload files rather than a page of the site: /api/..., /uploads/...,
// /runs/..., or a path ending in a file extension other than a page's (.html, .htm, .php).
const FILE_PATH_RE = /^\/(?:.*\/)?(?:api|uploads|runs)\/|^\/\S*\.(?!html?$|php$)[a-z0-9]{2,5}$/i;

/**
 * True for strings that are or contain an address: a scheme (http://, https:x, HTTPS:/x, data:,
 * mailto:, C:/x), //host, a host name with a port or path (cdn.example.no/x, host.example:3000), an
 * IPv4 or IPv6 literal, localhost, backslash and UNC paths (C:\x, \\server\x), www.*, and Maker or
 * upload file paths (/api/..., /uploads/..., /x.png).
 */
export function looksLikeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  if (raw.includes('://') || raw.startsWith('//') || raw.includes('\\')) return true;
  if (ADDRESS_SCHEME_RE.test(raw) || SCHEME_SLASH_RE.test(raw)) return true;
  if (/^www\./i.test(raw) || HOST_RE.test(raw)) return true;
  if (IPV4_RE.test(raw) || IPV6_RE.test(raw) || LOOPBACK_RE.test(raw)) return true;
  return FILE_PATH_RE.test(raw);
}

/** A copy of `value` without URL strings or URL-shaped keys (and without keys whose value was one). Depth-limited. */
export function withoutUrls(value, depth = 0) {
  if (depth > 6) return undefined;
  if (typeof value === 'string') return looksLikeUrl(value) ? undefined : value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((entry) => withoutUrls(entry, depth + 1)).filter((entry) => entry !== undefined);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 200)) {
      if (looksLikeUrl(key)) continue;
      const clean = withoutUrls(entry, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return undefined;
}

/** A page route of the site (/, /meny, /om-oss/team), or '' for anything that addresses something else. */
function route(value) {
  const raw = text(value, 300);
  if (!raw.startsWith('/') || raw.startsWith('//') || looksLikeUrl(raw)) return '';
  return raw;
}

function normalizeUploads(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [field, value] of Object.entries(raw).slice(0, MAX_UPLOAD_FIELDS)) {
    if (!FIELD_RE.test(field)) continue;
    const number = Array.isArray(value) ? value.filter(Boolean).length : count(value, 10_000);
    if (number > 0) out[field] = number;
  }
  return out;
}

function normalizePageKinds(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!isPlainObject(entry)) continue;
    const path = route(entry.route);
    const kind = text(entry.kind, 41).toLowerCase();
    if (!path || !KIND_RE.test(kind)) continue;
    if (!out.some((row) => row.route === path)) out.push({ route: path, kind });
    if (out.length >= MAX_PAGE_KINDS) break;
  }
  return out;
}

function normalizeStep1Qa(raw) {
  if (!isPlainObject(raw)) return null;
  const status = ['pass', 'warn', 'fail'].includes(raw.status) ? raw.status : '';
  const score = raw.score === null || raw.score === undefined || raw.score === '' ? NaN : Number(raw.score);
  if (!status && !Number.isFinite(score)) return null;
  return { status, score: Number.isFinite(score) ? Math.max(0, Math.min(1, Math.round(score * 1000) / 1000)) : null };
}

function normalizeSummary(raw) {
  if (!isPlainObject(raw)) return null;
  const clean = withoutUrls(raw);
  if (!isPlainObject(clean)) return null;
  const body = JSON.stringify(clean);
  return body.length <= MATERIALS_SUMMARY_MAX_BYTES ? clean : null;
}

function normalizeNeeds(raw) {
  if (!isPlainObject(raw)) return null;
  const items = [];
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    const clean = withoutUrls(item);
    if (!isPlainObject(clean) || JSON.stringify(clean).length > MAX_NEEDS_ITEM_BYTES) continue;
    items.push(clean);
    if (items.length >= MAX_NEEDS_ITEMS) break;
  }
  return { schema: text(raw.schema, 60), items };
}

function runIdOf(value) {
  const raw = text(value, 80);
  return looksLikeUrl(raw) ? '' : raw;
}

/** True when a normalized snapshot carries no material at all (an empty or partial payload). */
function materialsEmpty(materials) {
  return !materials.logo.present
    && !materials.logo.source
    && !Object.keys(materials.uploads).length
    && !materials.uploadsTotal
    && !materials.products
    && !materials.productCatalogs
    && !materials.domain
    && !materials.latestReadyStep
    && !materials.customSiteEdits
    && !materials.pageKinds.length
    && !materials.step1Qa
    && !(materials.siteIntelSummary && Object.keys(materials.siteIntelSummary).length)
    && !(materials.needs && materials.needs.items.length);
}

/**
 * run.materials.updated payload, normalized (counts, routes and kinds only), or null when it is not
 * an object or carries no material field (so `materials: {}` never replaces a stored snapshot).
 */
export function normalizeMakerMaterials(raw) {
  if (!isPlainObject(raw)) return null;
  const logo = isPlainObject(raw.logo) ? raw.logo : {};
  const domain = text(raw.domain, 253).toLowerCase();
  const uploads = normalizeUploads(raw.uploads);
  const materials = {
    runId: runIdOf(raw.runId),
    logo: { present: logo.present === true, source: looksLikeUrl(logo.source) ? '' : text(logo.source, 40) },
    uploads,
    uploadsTotal: count(raw.uploadsTotal) || Object.values(uploads).reduce((sum, value) => sum + value, 0),
    products: count(raw.products),
    productCatalogs: count(raw.productCatalogs),
    domain: DOMAIN_RE.test(domain) && !looksLikeUrl(domain) ? domain : '',
    latestReadyStep: text(raw.latestReadyStep, 20),
    customSiteEdits: count(raw.customSiteEdits),
    pageKinds: normalizePageKinds(raw.pageKinds),
    step1Qa: normalizeStep1Qa(raw.step1Qa),
    siteIntelSummary: normalizeSummary(raw.siteIntelSummary),
    needs: normalizeNeeds(raw.needs),
    at: iso(raw.at),
    receivedAt: iso(raw.receivedAt),
  };
  return materialsEmpty(materials) ? null : materials;
}

/** run.autopilot.updated payload {runId, phase, status, blocked, at}, or null. */
export function normalizeMakerAutopilot(raw) {
  if (!isPlainObject(raw)) return null;
  const phase = text(raw.phase, 40);
  const status = text(raw.status, 40);
  if (!phase && !status) return null;
  return {
    runId: runIdOf(raw.runId),
    phase: looksLikeUrl(phase) ? '' : phase,
    status: looksLikeUrl(status) ? '' : status,
    blocked: isBlockingCode(raw.blocked) ? text(raw.blocked, 80) : '',
    at: iso(raw.at),
  };
}

/** makerRun.previewPush {at, sha256, sourceStep, runId, sessionId} (written by WS8.17), or null. */
export function normalizePreviewPush(raw) {
  if (!isPlainObject(raw)) return null;
  const at = iso(raw.at);
  if (!at) return null;
  const sha = text(raw.sha256, 64).toLowerCase();
  return {
    at,
    sha256: HEX64_RE.test(sha) ? sha : '',
    sourceStep: text(raw.sourceStep, 20),
    runId: text(raw.runId, 80),
    sessionId: text(raw.sessionId, 80),
  };
}

/**
 * The makerRun patch for a delivery event body, or null when the body carries nothing usable.
 * `now` stamps a snapshot that came without its own time; `runId` (the run the callback was checked
 * against) is stored on it, so a snapshot of an earlier run is never used for a newly linked one.
 */
export function makerRunPatchForEvent(event, body = {}, { now = new Date().toISOString(), runId = '' } = {}) {
  const run = runIdOf(runId || body?.runId);
  if (event === 'run.materials.updated') {
    const materials = normalizeMakerMaterials(body?.materials);
    if (!materials) return null;
    return { materials: { ...materials, runId: run || materials.runId, at: materials.at || now, receivedAt: now } };
  }
  if (event === 'run.autopilot.updated') {
    const autopilot = normalizeMakerAutopilot(body?.autopilot || body);
    if (!autopilot) return null;
    return { autopilot: { ...autopilot, runId: run || autopilot.runId, at: autopilot.at || now } };
  }
  return null;
}

/**
 * The stored snapshot when it belongs to the run linked now (same runId) and is younger than 24 h,
 * else null.
 */
export function freshMakerMaterials(makerRun = {}, nowMs = Date.now()) {
  const materials = isPlainObject(makerRun?.materials) ? makerRun.materials : null;
  if (!materials) return null;
  const linked = text(makerRun?.runId, 80);
  if (!linked || text(materials.runId, 80) !== linked) return null;
  const at = Date.parse(materials.receivedAt || materials.at || '');
  if (!Number.isFinite(at) || nowMs - at > MATERIALS_SNAPSHOT_MAX_AGE_MS || at - nowMs > 5 * 60 * 1000) return null;
  return materials;
}

/**
 * A Maker run record shaped like GET /api/runs/<id> for the material dots, built from a materials
 * snapshot: upload counts per field, the logo and the domain. It has no answers; it is used only
 * when the live run fetch fails (see makerRunFetchWithMaterials), so text points then fall back to
 * Kundedata as they did without it.
 */
export function makerRunFromMaterials(materials = {}) {
  const uploads = {};
  for (const [field, number] of Object.entries(isPlainObject(materials?.uploads) ? materials.uploads : {})) {
    uploads[field] = Array.from({ length: Math.min(count(number, 1000), 1000) }, () => 'snapshot');
  }
  if (materials?.logo?.present === true && !uploads.logo) uploads.logo = ['snapshot'];
  return {
    answers: {},
    metadata: { productionDomain: text(materials?.domain, 253) },
    uploads,
    productCatalogs: [],
    products: [],
    quickFillLinks: {},
    fromMaterialsSnapshot: true,
  };
}

/** Page kinds from the run's page plan (for the page-kind gate lines, WS8.51). */
export function materialsPageKinds(makerRun = {}) {
  return Array.isArray(makerRun?.materials?.pageKinds) ? makerRun.materials.pageKinds : [];
}

/** WS3 needs items that are not yet satisfied (placeholder slots for the missing-info emails). */
export function materialsOpenNeeds(makerRun = {}) {
  const items = Array.isArray(makerRun?.materials?.needs?.items) ? makerRun.materials.needs.items : [];
  return items.filter((item) => !['have', 'done', 'ok'].includes(String(item?.status || '').toLowerCase()));
}
