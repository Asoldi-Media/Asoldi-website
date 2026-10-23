// Shape normalizers for the CMS feature tree fields on a hub site (WS6.7, WS6.8).
//
// site.featureSpec        agency spec: grant/revoke services and keys, defaults, values, locks, rev
// site.cmsSpec            settings sections for the CMS, rev, force list
// site.cmsSpecHistory     the last 20 spec changes
// site.featureEnforcement 'off' | 'log' | 'on' (readers default to 'log')
// site.cms.*              what the CMS reports in its heartbeat
//
// These check structure and size only. Keys, services and section contents are validated against the
// synced registry when a spec is written (lib/cms-spec.js). Every field is stored only when present,
// so sites that never had one keep their exact shape.
//
// Pure module: no Node imports.

export const FEATURE_ENFORCEMENT_MODES = Object.freeze(['off', 'log', 'on']);
export const DEFAULT_FEATURE_ENFORCEMENT = 'log';
export const CMS_SPEC_HISTORY_MAX = 20;
export const BLOCK_HISTORY_DAYS = 14;

const LIST_FIELDS = ['grantServices', 'revokeServices', 'grant', 'revoke', 'locks'];
const MAX_LIST = 200;
const MAX_KEY_LENGTH = 80;
const MAX_TEXT = 300;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = MAX_TEXT) {
  return String(value ?? '').trim().slice(0, max);
}

function wholeNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function keyList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const key = text(entry, MAX_KEY_LENGTH);
    if (key && !out.includes(key)) out.push(key);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/**
 * A JSON-safe copy with bounded size: strings up to 300 characters, lists and objects up to 40
 * entries, 4 levels deep. Used for CMS-reported data that arrives without a schema.
 */
export function boundedClone(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, MAX_TEXT);
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((entry) => boundedClone(entry, depth + 1)).filter((entry) => entry !== undefined);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 40)) {
      const copy = boundedClone(entry, depth + 1);
      if (copy !== undefined) out[String(key).slice(0, 60)] = copy;
    }
    return out;
  }
  return undefined;
}

/** featureSpec structure: lists of keys, defaults {key: boolean}, values {key: text}, rev, who and when. */
export function normalizeFeatureSpec(raw) {
  if (!isPlainObject(raw)) return null;
  const out = { rev: wholeNumber(raw.rev) ?? 0 };
  for (const field of LIST_FIELDS) {
    if (raw[field] !== undefined) out[field] = keyList(raw[field]);
  }
  if (raw.defaults !== undefined) {
    out.defaults = {};
    for (const [key, value] of Object.entries(isPlainObject(raw.defaults) ? raw.defaults : {}).slice(0, MAX_LIST)) {
      if (typeof value === 'boolean') out.defaults[text(key, MAX_KEY_LENGTH)] = value;
    }
  }
  if (raw.values !== undefined) {
    out.values = {};
    for (const [key, value] of Object.entries(isPlainObject(raw.values) ? raw.values : {}).slice(0, MAX_LIST)) {
      if (typeof value === 'string' && value.trim()) out.values[text(key, MAX_KEY_LENGTH)] = text(value, 60);
    }
  }
  if (raw.updatedAt) out.updatedAt = text(raw.updatedAt, 40);
  if (raw.updatedBy) out.updatedBy = text(raw.updatedBy, 120);
  return out;
}

/** cmsSpec structure: { rev, sections: {name: object|list}, force: [section], updatedAt, updatedBy }. */
export function normalizeCmsSpec(raw) {
  if (!isPlainObject(raw)) return null;
  const sections = {};
  for (const [name, value] of Object.entries(isPlainObject(raw.sections) ? raw.sections : {})) {
    if (isPlainObject(value) || Array.isArray(value)) sections[text(name, MAX_KEY_LENGTH)] = value;
  }
  const out = { rev: wholeNumber(raw.rev) ?? 0, sections, force: keyList(raw.force) };
  if (raw.updatedAt) out.updatedAt = text(raw.updatedAt, 40);
  if (raw.updatedBy) out.updatedBy = text(raw.updatedBy, 120);
  return out;
}

export function normalizeCmsSpecHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlainObject).slice(-CMS_SPEC_HISTORY_MAX);
}

/** 'off' | 'log' | 'on', or null when the value is missing or unknown (readers then use 'log'). */
export function normalizeFeatureEnforcement(raw) {
  const mode = text(raw, 10).toLowerCase();
  return FEATURE_ENFORCEMENT_MODES.includes(mode) ? mode : null;
}

export function featureEnforcementOf(site) {
  return normalizeFeatureEnforcement(site?.featureEnforcement) || DEFAULT_FEATURE_ENFORCEMENT;
}

function normalizeBlockDay(raw) {
  if (!isPlainObject(raw)) return null;
  const date = text(raw.date, 10);
  const count = wholeNumber(raw.count);
  if (!DATE_RE.test(date) || count === null) return null;
  const top = Array.isArray(raw.top) ? boundedClone(raw.top.slice(0, 10)) : [];
  return { date, count, top };
}

/** Block history: one row per day, newest last, at most 14 days. */
export function normalizeBlockHistory(raw) {
  const byDate = new Map();
  for (const row of Array.isArray(raw) ? raw : []) {
    const day = normalizeBlockDay(row);
    if (day) byDate.set(day.date, day);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-BLOCK_HISTORY_DAYS);
}

/**
 * The CMS-reported fields of site.cms, typed. Each is returned only when `cms` has it, so a site whose
 * CMS never reported one keeps its shape.
 */
export function normalizeCmsReportedFields(cms) {
  const out = {};
  if (!isPlainObject(cms)) return out;
  for (const key of ['featuresRev', 'clientFeaturesRev', 'settingsRevApplied']) {
    if (cms[key] !== undefined && wholeNumber(cms[key]) !== null) out[key] = wholeNumber(cms[key]);
  }
  if (cms.settingsConflicts !== undefined) out.settingsConflicts = keyList(cms.settingsConflicts).slice(0, 30);
  // The effective key list as one comma-separated text; a list is joined, anything else is dropped.
  if (Array.isArray(cms.effective) || typeof cms.effective === 'string') {
    const list = Array.isArray(cms.effective) ? keyList(cms.effective) : keyList(cms.effective.split(','));
    out.effective = list.join(',').slice(0, 8000);
  }
  if (cms.effectiveHash !== undefined) out.effectiveHash = text(cms.effectiveHash, 100);
  if (cms.blockHistory !== undefined) out.blockHistory = normalizeBlockHistory(cms.blockHistory);
  if (cms.migrations !== undefined) {
    const copy = boundedClone(cms.migrations);
    if (copy !== undefined && copy !== null) out.migrations = copy;
  }
  if (cms.lastHeartbeatAt !== undefined) out.lastHeartbeatAt = text(cms.lastHeartbeatAt, 40);
  if (cms.packageBuild !== undefined) out.packageBuild = text(cms.packageBuild, 80);
  if (cms.initialAdminPending !== undefined) out.initialAdminPending = cms.initialAdminPending === true;
  if (cms.loginAddressMode !== undefined) out.loginAddressMode = text(cms.loginAddressMode, 40);
  if (cms.loginForwardedFor !== undefined) out.loginForwardedFor = cms.loginForwardedFor === true;
  if (cms.loginAddressFrom !== undefined) out.loginAddressFrom = text(cms.loginAddressFrom, 40);
  return out;
}

/** Every site.cms field that only a heartbeat may set (never a site update from a request). */
export const CMS_REPORTED_KEYS = Object.freeze([
  'featuresRev', 'clientFeaturesRev', 'settingsRevApplied', 'settingsConflicts', 'effective', 'effectiveHash',
  'blockHistory', 'migrations', 'lastHeartbeatAt', 'packageBuild', 'initialAdminPending', 'loginAddressMode',
  'loginForwardedFor', 'loginAddressFrom',
]);

/** Heartbeat body fields the hub keeps (besides packageVersion, adminUrl, name and adminApplied). */
export const HEARTBEAT_REPORT_FIELDS = Object.freeze([
  'featuresRev',
  'clientFeaturesRev',
  'settingsRevApplied',
  'settingsConflicts',
  'effective',
  'effectiveHash',
  'migrations',
  'packageBuild',
  'initialAdminPending',
  'loginAddressMode',
  'loginForwardedFor',
  'loginAddressFrom',
]);

function blockDaysFromReport(raw) {
  // featureBlocksDaily: {date, count, top} | [{date, count, top}] | {'YYYY-MM-DD': count}
  if (Array.isArray(raw)) return raw;
  if (!isPlainObject(raw)) return [];
  if (raw.date !== undefined) return [raw];
  return Object.entries(raw).map(([date, count]) => ({ date, count }));
}

/**
 * Picks the reported fields out of a heartbeat body (unknown fields are ignored) and returns the
 * site.cms patch: the typed fields, the day rows merged into blockHistory (a day reported again
 * replaces its row; 14 days kept) and lastHeartbeatAt when anything was reported.
 */
export function cmsPatchFromHeartbeat(currentCms, body, nowIso = new Date().toISOString()) {
  if (!isPlainObject(body)) return {};
  const picked = {};
  for (const field of HEARTBEAT_REPORT_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) picked[field] = body[field];
  }
  const patch = normalizeCmsReportedFields(picked);
  const days = blockDaysFromReport(body.featureBlocksDaily);
  if (days.length) {
    const current = normalizeBlockHistory(isPlainObject(currentCms) ? currentCms.blockHistory : []);
    patch.blockHistory = normalizeBlockHistory([...current, ...days]);
  }
  if (Object.keys(patch).length) patch.lastHeartbeatAt = text(nowIso, 40);
  return patch;
}
