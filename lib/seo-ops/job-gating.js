/**
 * SEO job gating. Each gated job has an old gate (the decision the hub made before the SEO feature
 * keys) and the feature-key gate seoJobAllowed (lib/seo-ops/features.js). The switch
 * seo.jobGating ({enabled, mode}) picks which one decides:
 *
 *   off     (enabled false, the default) the old gate decides; the feature-key gate is not computed
 *   shadow  the old gate decides; a site where the feature-key gate would decide differently is
 *           written to <dataDir>/seo-ops/decision-diff.json (one row per job and site)
 *   auto    the feature-key gate decides
 *
 * Gated jobs: 'blog-scheduler' (key blog.autoPosts, older name blog.localPosts, and the site's blog
 * module on; the automatic local posts a client CMS asks the hub for) and 'rank-tracker.maps' (key
 * seo.tracking.maps; the Maps loop, and in auto every paid Maps refresh: ensureMapsRanking in
 * lib/client-analytics-service.js). scripts/seo-gating-diff.mjs prints both decisions per site for
 * a copy of a data dir, so they can be compared before the switch moves to auto.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAutomationSettings } from '../../data/automation-settings.js';
import { getPersistentDataDir, writeDataJson } from '../../data/storage-path.js';
import { SEO_JOB_FEATURES, seoJobAllowed } from './features.js';
import { withFileLock } from '../../data/email-store.js';
import { SEO_OPS_DIR } from './store.js';

export const SEO_GATED_JOBS = Object.freeze(['blog-scheduler', 'rank-tracker.maps']);
export const SEO_GATING_MODES = Object.freeze(['off', 'shadow', 'auto']);
export const DECISION_DIFF_FILE = 'decision-diff.json';
export const DECISION_DIFF_MAX_ROWS = 2000;
// A row that keeps differing is stamped again at most once a day.
const RESTAMP_MS = 24 * 60 * 60 * 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** off | shadow | auto for seo.jobGating (a paused or missing switch is off). */
export function seoJobGatingMode({ settings = null } = {}) {
  let resolved = settings;
  if (!resolved) {
    try {
      resolved = getAutomationSettings();
    } catch {
      return 'off';
    }
  }
  const node = resolved?.seo?.jobGating;
  if (!isPlainObject(node) || node.enabled !== true || node.paused) return 'off';
  return node.mode === 'auto' ? 'auto' : 'shadow';
}

/**
 * The site as seoJobAllowed reads it. Agency overrides may be stored under site.ext (the site keys a
 * release keeps): { 'blog.autoPosts': false } there counts like site.seoFeatureOverrides.
 */
export function gatingSite(site) {
  const base = isPlainObject(site) ? site : {};
  const fromExt = isPlainObject(base.ext?.seoFeatureOverrides) ? base.ext.seoFeatureOverrides : null;
  if (!fromExt || isPlainObject(base.seoFeatureOverrides)) return base;
  return { ...base, seoFeatureOverrides: fromExt };
}

/**
 * Jobs that also need a CMS module the site has switched on (site.features), whatever the feature
 * keys say: automatic posts are published through the client CMS's blog module, so a site whose blog
 * flag is off never gets them, in auto as before.
 */
export const SEO_JOB_SITE_MODULES = Object.freeze({ 'blog-scheduler': 'blog' });

/** The feature-key decision: { allowed, key, reason }. */
export function featureKeyDecision(site, job) {
  let decision;
  try {
    decision = seoJobAllowed(gatingSite(site), job);
  } catch (error) {
    return { allowed: false, key: SEO_JOB_FEATURES[job] || null, reason: `feature check failed: ${error?.message || error}` };
  }
  const siteModule = SEO_JOB_SITE_MODULES[job];
  if (siteModule && decision.allowed && site?.features?.[siteModule] !== true) {
    return { ...decision, allowed: false, reason: `the site's ${siteModule} module is off (features.${siteModule})` };
  }
  return decision;
}

// ---------------------------------------------------------------- the decision-diff file

const diffState = { loaded: false, path: '', rows: new Map(), pending: Promise.resolve() };

function diffPath() {
  return join(getPersistentDataDir(), SEO_OPS_DIR, DECISION_DIFF_FILE);
}

function readDiffFile(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return isPlainObject(parsed?.rows) ? parsed.rows : {};
  } catch {
    return {};
  }
}

function loadDiffState() {
  const path = diffPath();
  if (diffState.loaded && diffState.path === path) return;
  diffState.loaded = true;
  diffState.path = path;
  diffState.rows = new Map(Object.entries(readDiffFile(path)));
}

/** The rows of the decision-diff file: { '<job>|<siteKey>': { job, siteKey, legacy, next, ... } }. */
export function readDecisionDiff() {
  return readDiffFile(diffPath());
}

/** Waits for the decision-diff writes started so far (tests, scripts). */
export function flushDecisionDiff() {
  return diffState.pending;
}

/** Tests: forget what this process knows about the file. */
export function resetDecisionDiffStateForTests() {
  diffState.loaded = false;
  diffState.path = '';
  diffState.rows = new Map();
  diffState.pending = Promise.resolve();
}

function queueWrite(mutate) {
  const path = diffState.path;
  diffState.pending = diffState.pending.then(() => withFileLock('seo-ops-decision-diff', () => {
    mkdirSync(dirname(path), { recursive: true });
    const rows = readDiffFile(path);
    if (mutate(rows) === false) return;
    const keys = Object.keys(rows);
    if (keys.length > DECISION_DIFF_MAX_ROWS) {
      keys
        .sort((a, b) => String(rows[a]?.lastAt || '').localeCompare(String(rows[b]?.lastAt || '')))
        .slice(0, keys.length - DECISION_DIFF_MAX_ROWS)
        .forEach((key) => delete rows[key]);
    }
    writeDataJson(path, { version: 1, updatedAt: new Date().toISOString(), rows }, { backupName: `${SEO_OPS_DIR}__${DECISION_DIFF_FILE}`, latest: false, atomic: true, keep: 1 });
  })).catch((error) => {
    console.warn(`[seo-gating] decision diff not written: ${error?.code || error?.message || error}`);
  });
  return diffState.pending;
}

/**
 * Shadow mode: keeps the decision-diff file in step with one decision. A differing site gets (or
 * refreshes) its row; a site whose decisions agree again loses it. Writes only on a change, and
 * at most once a day for a row that keeps differing.
 */
export function noteShadowDecision({ job, siteKey, legacy, next, tierId = '', now = new Date() }) {
  try {
    loadDiffState();
  } catch {
    return diffState.pending;
  }
  const key = `${job}|${siteKey}`;
  const known = diffState.rows.get(key);
  const differs = Boolean(legacy) !== Boolean(next?.allowed);
  const at = now.toISOString();
  if (!differs) {
    if (!known) return diffState.pending;
    diffState.rows.delete(key);
    return queueWrite((rows) => {
      if (!rows[key]) return false;
      delete rows[key];
      return true;
    });
  }
  const row = {
    job,
    siteKey,
    tierId: String(tierId || ''),
    legacy: Boolean(legacy),
    next: Boolean(next?.allowed),
    key: next?.key || null,
    reason: String(next?.reason || '').slice(0, 200),
  };
  const same = known && known.legacy === row.legacy && known.next === row.next && known.reason === row.reason;
  if (same && now.getTime() - Date.parse(known.lastAt || 0) < RESTAMP_MS) return diffState.pending;
  const merged = { ...row, firstAt: known?.firstAt || at, lastAt: at, count: (Number(known?.count) || 0) + 1 };
  diffState.rows.set(key, merged);
  if (!known) console.log(`[seo-gating] shadow: ${job} for ${siteKey} would be ${row.next ? 'on' : 'off'} (now ${row.legacy ? 'on' : 'off'})`);
  return queueWrite((rows) => {
    rows[key] = { ...merged, firstAt: rows[key]?.firstAt || merged.firstAt, count: (Number(rows[key]?.count) || 0) + 1 };
    return true;
  });
}

// ---------------------------------------------------------------- the decision

/**
 * Decides one gated job for one site. `legacy` is the old gate's answer (a boolean), `site` a hub
 * site (or the stand-in a caller builds), `siteKey` names the site in the diff file.
 * Returns { allowed, mode, legacy, next? }.
 */
export function decideSeoJob({ job, site, legacy, siteKey = '', settings = null, now = new Date() }) {
  const old = Boolean(legacy);
  const mode = seoJobGatingMode({ settings });
  if (mode === 'off') return { allowed: old, mode, legacy: old };
  const next = featureKeyDecision(site, job);
  if (mode === 'auto') return { allowed: Boolean(next.allowed), mode, legacy: old, next };
  const key = String(siteKey || site?.site_key || site?.id || '').trim();
  if (key) noteShadowDecision({ job, siteKey: key, legacy: old, next, tierId: site?.sitePlan?.tierId || site?.websitePlan || '', now });
  return { allowed: old, mode, legacy: old, next };
}
