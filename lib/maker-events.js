// Maker delivery events on the hub (WS8.28): run.materials.updated and run.autopilot.updated on
// the existing status callback (same callback auth), stored on client.makerRun. Pure helpers here;
// the writer is data/sales.js setSalesMakerRunOwned.
//
// - Payloads are normalized and capped. URLs anywhere in them are dropped: the hub keeps counts,
//   page routes, page kinds and QA status, never addresses of the Maker or of uploaded files.
// - With development.makerEvents off (the default) the callback handles these events exactly as
//   before (a plain step-status update), so nothing changes until the switch is on.
// - A materials snapshot younger than 24 h replaces the live Maker run fetch for the material dots.
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

/** True for strings that are or contain an address (scheme://, //host, data:, mailto:, localhost, loopback). */
export function looksLikeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes('://')) return true;
  if (raw.startsWith('//')) return true;
  if (/^(?:data|mailto|javascript|file|blob):/i.test(raw)) return true;
  if (/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)\b/i.test(raw)) return true;
  return /^www\./i.test(raw);
}

/** A copy of `value` without URL strings (and without keys whose value was one). Depth-limited. */
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
      const clean = withoutUrls(entry, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return undefined;
}

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

/** run.materials.updated payload, normalized (counts, routes and kinds only), or null. */
export function normalizeMakerMaterials(raw) {
  if (!isPlainObject(raw)) return null;
  const logo = isPlainObject(raw.logo) ? raw.logo : {};
  const domain = text(raw.domain, 253).toLowerCase();
  const uploads = normalizeUploads(raw.uploads);
  return {
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
}

/** run.autopilot.updated payload {phase, status, blocked, at}, or null. */
export function normalizeMakerAutopilot(raw) {
  if (!isPlainObject(raw)) return null;
  const phase = text(raw.phase, 40);
  const status = text(raw.status, 40);
  if (!phase && !status) return null;
  return {
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
 * `now` stamps a snapshot that came without its own time.
 */
export function makerRunPatchForEvent(event, body = {}, { now = new Date().toISOString() } = {}) {
  if (event === 'run.materials.updated') {
    const materials = normalizeMakerMaterials(body?.materials);
    if (!materials) return null;
    return { materials: { ...materials, at: materials.at || now, receivedAt: now } };
  }
  if (event === 'run.autopilot.updated') {
    const autopilot = normalizeMakerAutopilot(body?.autopilot || body);
    if (!autopilot) return null;
    return { autopilot: { ...autopilot, at: autopilot.at || now } };
  }
  return null;
}

/** The stored snapshot when it is younger than 24 h (by its time on the Maker), else null. */
export function freshMakerMaterials(makerRun = {}, nowMs = Date.now()) {
  const materials = isPlainObject(makerRun?.materials) ? makerRun.materials : null;
  if (!materials) return null;
  const at = Date.parse(materials.receivedAt || materials.at || '');
  if (!Number.isFinite(at) || nowMs - at > MATERIALS_SNAPSHOT_MAX_AGE_MS || at - nowMs > 5 * 60 * 1000) return null;
  return materials;
}

/**
 * A Maker run record shaped like GET /api/runs/<id> for the material dots, built from a materials
 * snapshot: upload counts per field, the logo and the domain. It has no answers, so text points
 * fall back to Kundedata.
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
