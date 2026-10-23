// client.sitePlan shape and normalizer (WS8.3). Pure: no Node imports, so the browser bundle and
// the data layer can both use it.
//
// Once a client has a sitePlan it is the only source of that client's plan. It is written by the
// signing and plan-change functions (later batches) and by the backfill (WS8.41), never from a
// request body. Unknown top-level keys are kept, so a later batch's additions survive this code.
import {
  CATALOG_TYPES,
  SITE_PLAN_EVIDENCE,
  SITE_PLAN_SOURCES,
  SITE_PLAN_STATUSES,
  SITE_PLAN_VERSION,
  TIER_IDS,
  changesPerMonthForTier,
  expandServices,
  normalizeOneTimeAddOns,
} from '../packages/suite/core/delivery/vocab.js';

export const SITE_PLAN_HISTORY_MAX = 50;
export const SITE_PLAN_CONFLICTS_MAX = 20;
export const SITE_PLAN_CONFLICT_STATUSES = Object.freeze(['open', 'accepted', 'dismissed']);
const MAX_PAGES = 500;
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function iso(value) {
  const raw = text(value, 40);
  if (!raw) return '';
  return Number.isFinite(Date.parse(raw)) ? raw : '';
}

function intIn(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  return rounded >= min && rounded <= max ? rounded : fallback;
}

export function normalizeTierIdStrict(value) {
  const raw = text(value, 40);
  return TIER_IDS.includes(raw) ? raw : '';
}

export function normalizeLanguages(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const code = text(entry, 20).toLowerCase();
    if (LANGUAGE_RE.test(code) && !out.includes(code)) out.push(code);
  }
  return out.length ? out.slice(0, 12) : ['nb'];
}

function normalizePlanRef(raw) {
  if (!isPlainObject(raw)) return null;
  const tierId = normalizeTierIdStrict(raw.tierId);
  if (!tierId) return null;
  const out = { tierId };
  if (Array.isArray(raw.services)) out.services = expandServices(raw.services);
  if (raw.billing === 'once' || raw.billing === 'month') out.billing = raw.billing;
  return out;
}

function normalizeHistoryEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const to = normalizePlanRef(raw.to);
  const reason = text(raw.reason, 120);
  if (!to && !reason) return null;
  return {
    at: iso(raw.at),
    by: text(raw.by, 120),
    from: normalizePlanRef(raw.from),
    to,
    reason,
  };
}

function normalizeConflict(raw) {
  if (!isPlainObject(raw)) return null;
  const tierId = normalizeTierIdStrict(raw.tierId);
  const source = text(raw.source, 40);
  if (!tierId || !source) return null;
  return {
    source,
    tierId,
    at: iso(raw.at),
    status: SITE_PLAN_CONFLICT_STATUSES.includes(raw.status) ? raw.status : 'open',
  };
}

function normalizeServiceTerms(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const unlimited = isPlainObject(input.unlimited) && iso(input.unlimited.until) ? { until: iso(input.unlimited.until) } : null;
  return { unlimited };
}

/**
 * The stored plan, normalized, or null when `raw` is not a plan (no known tier or no service).
 * Idempotent: normalizeSitePlan(normalizeSitePlan(x)) deep-equals normalizeSitePlan(x).
 */
export function normalizeSitePlan(raw) {
  if (!isPlainObject(raw)) return null;
  const tierId = normalizeTierIdStrict(raw.tierId);
  const services = expandServices(Array.isArray(raw.services) ? raw.services : []);
  if (!tierId || !services.length) return null;
  const alternativeIndex = raw.alternativeIndex === 0 || raw.alternativeIndex === 1 ? raw.alternativeIndex : null;
  const plan = {
    version: SITE_PLAN_VERSION,
    status: SITE_PLAN_STATUSES.includes(raw.status) ? raw.status : 'active',
    tierId,
    services,
    pages: intIn(raw.pages, 0, MAX_PAGES, 0),
    oneTimeAddOns: normalizeOneTimeAddOns(raw.oneTimeAddOns),
    billing: raw.billing === 'once' ? 'once' : 'month',
    priceExMva: intIn(raw.priceExMva, 0, 10_000_000, 0),
    catalogType: CATALOG_TYPES.includes(raw.catalogType) ? raw.catalogType : null,
    languages: normalizeLanguages(raw.languages),
    changesPerMonth: intIn(raw.changesPerMonth, 0, 1000, changesPerMonthForTier(tierId)),
    serviceTerms: normalizeServiceTerms(raw.serviceTerms),
    source: SITE_PLAN_SOURCES.includes(raw.source) ? raw.source : '',
    evidence: SITE_PLAN_EVIDENCE.includes(raw.evidence) ? raw.evidence : '',
    offerId: text(raw.offerId, 120),
    alternativeIndex,
    offerHash: text(raw.offerHash, 80),
    dpaVersion: text(raw.dpaVersion, 80),
    signedAt: iso(raw.signedAt),
    appliedAt: iso(raw.appliedAt),
    appliedSiteId: text(raw.appliedSiteId, 80),
    derived: raw.derived === true,
    needsConfirmation: raw.needsConfirmation === true,
    confirmedBy: text(raw.confirmedBy, 120),
    confirmedAt: iso(raw.confirmedAt),
    conflicts: (Array.isArray(raw.conflicts) ? raw.conflicts : [])
      .map(normalizeConflict)
      .filter(Boolean)
      .slice(-SITE_PLAN_CONFLICTS_MAX),
    history: (Array.isArray(raw.history) ? raw.history : [])
      .map(normalizeHistoryEntry)
      .filter(Boolean)
      .slice(-SITE_PLAN_HISTORY_MAX),
  };
  // Forward compatibility: keys a later batch adds to the plan are kept as they are.
  const extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(plan, key) && value !== undefined) extra[key] = value;
  }
  return { ...extra, ...plan };
}

/** The client's plan in force (status `active`), or null. */
export function activeSitePlan(client) {
  const plan = normalizeSitePlan(client?.sitePlan);
  return plan && plan.status === 'active' ? plan : null;
}

/** A short view for boards and cards. */
export function sitePlanSummary(client) {
  const plan = normalizeSitePlan(client?.sitePlan);
  if (!plan) return null;
  return {
    status: plan.status,
    tierId: plan.tierId,
    services: plan.services,
    billing: plan.billing,
    source: plan.source,
    signedAt: plan.signedAt,
    needsConfirmation: plan.needsConfirmation && !plan.confirmedAt,
    openConflicts: plan.conflicts.filter((conflict) => conflict.status === 'open').length,
  };
}

/**
 * The plan with one history entry appended when its tier, services or billing differ from
 * `previous` (or when there is no previous plan). Returns a new normalized plan.
 */
export function withPlanHistory(next, previous, { at = '', by = '', reason = '' } = {}) {
  const plan = normalizeSitePlan(next);
  if (!plan) return null;
  const before = normalizeSitePlan(previous);
  const same = before
    && before.tierId === plan.tierId
    && before.billing === plan.billing
    && before.status === plan.status
    && JSON.stringify(before.services) === JSON.stringify(plan.services);
  if (same) return normalizeSitePlan({ ...plan, history: before.history });
  const history = [...(before?.history || plan.history || [])];
  history.push({
    at: iso(at) || new Date().toISOString(),
    by: text(by, 120),
    from: before ? { tierId: before.tierId, services: before.services, billing: before.billing } : null,
    to: { tierId: plan.tierId, services: plan.services, billing: plan.billing },
    reason: text(reason, 120) || plan.source,
  });
  return normalizeSitePlan({ ...plan, history });
}
