/**
 * seo-ops store (WS9.48): one JSON file per site and per client under <dataDir>/seo-ops/, plus the
 * global files. Every SEO ops job (ranks, reports, blog queue, local pack, audits, the DataForSEO
 * ledger) reads and writes through here.
 *
 *   seo-ops/sites/<siteKey>.json          per-site ops data (ranks, reports, blog queue, ...)
 *   seo-ops/clients/<salesClientId>.json  the SEO client record (agreed keywords, plan summary, ...)
 *   seo-ops/settings.json                 superadmin settings, defaults in code (no env)
 *   seo-ops/link-network.json             the client link network
 *   seo-ops/health.json                   derived health, rebuilt by its job (no backups)
 *   seo-ops/dfs-ledger-YYYY-MM.json       DataForSEO spend per month, kept 13 months
 *
 * Writes: a per-key lock inside this process, a lock file against other processes, an atomic
 * replace, and backups under a path-qualified name (seo-ops__sites__<key>.json) so files with the
 * same basename never share backups. Retention runs on every write, so a file never grows without
 * bound: rank snapshots older than 12 months become monthly aggregates and go after 24 months,
 * the last 26 reports, the open blog queue plus the last 50 finished items, 12 months of AI
 * visibility checks, a site file under 2 MB, client history capped at 200 rows.
 *
 * Safe mode: the store only touches the local data dir. seoOpsSafeModeGate(siteKey) tells a job
 * whether it may run for a site: always with safe mode off; with safe mode on only for sites in
 * settings.safeMode.allowSites, with settings.safeMode.live saying whether paid calls may be real.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from '../../data/atomic-json.js';
import {
  getDataBackupDir,
  getPersistentDataDir,
  pruneDataBackupsForFile,
  resolveDataBackupKeep,
  writeDataJson,
} from '../../data/storage-path.js';
import { isSafeModeActive } from '../safe-mode.js';

export const SEO_OPS_DIR = 'seo-ops';
export const SEO_OPS_VERSION = 1;
export const MAX_SITE_FILE_BYTES = 2 * 1024 * 1024;
export const RETENTION = Object.freeze({
  rankFullMonths: 12,
  rankAggregateMonths: 24,
  reports: 26,
  blogTerminal: 50,
  aiVisibilityMonths: 12,
  ledgerMonths: 13,
  clientHistory: 200,
  planCandidates: 50,
});
export const BLOG_TERMINAL_STATUSES = Object.freeze(['delivered', 'published', 'expired', 'failed']);
const GLOBAL_FILES = Object.freeze({ settings: 'settings.json', linkNetwork: 'link-network.json', health: 'health.json' });
const GLOBAL_BACKUP_KEEP = 2;
const KEY_RE = /^[a-z0-9_-]{1,80}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export class SeoOpsStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SeoOpsStoreError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A file-safe key: [a-z0-9_-]. A key that already has that form is used as it is; anything else is
 * cleaned and gets a short hash of the original, so two different keys never share a file.
 */
export function sanitizeSeoOpsKey(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new SeoOpsStoreError('invalid-key', 'An seo-ops key is required');
  if (KEY_RE.test(text)) return text;
  const cleaned = text.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'key';
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 10);
  return `${cleaned}-${hash}`;
}

// ---------------------------------------------------------------- defaults

export function emptySiteDoc(siteKey) {
  return {
    siteKey,
    version: SEO_OPS_VERSION,
    ranks: { snapshots: [], monthly: [] },
    aiVisibility: { checks: [] },
    reports: [],
    blogQueue: [],
    localPack: null,
    backlinkTargets: [],
    liveAudit: null,
    pagespeed: [],
    health: {},
  };
}

export function emptyClientDoc(salesClientId) {
  return {
    salesClientId,
    version: SEO_OPS_VERSION,
    agreedKeywords: [],
    proposals: [],
    planSummary: null,
    showcase: { optIn: false, at: null, source: null },
    compliance: { regulated: false, signoffs: [] },
    history: [],
    historyArchivedCount: 0,
  };
}

/** Settings defaults (WS9 §3.3 r). Everything that costs money or reaches clients starts off. */
export function defaultSeoOpsSettings() {
  return {
    enabled: true,
    balanceFloorUsd: 5,
    budgets: {
      monthlyUsd: 20,
      byPurpose: { tracking: 5, maps: 5, infokort: 5, aiVisibility: 3, audits: 1.5, local: 0.5 },
      perSiteMonthlyUsd: { 'tier-2-seo': 0.15, 'tier-3-ecommerce': 0.25 },
    },
    rankCadenceDays: { 'tier-2-seo': 14, 'tier-3-ecommerce': 7 },
    serpQueue: 'standard',
    serpDepth: { default: 10, agreed: 20 },
    aiOverview: true,
    aiVisibility: { enabled: false, engines: ['chatgpt'], cadenceDays: 30 },
    blog: {
      defaultPostsPerWeek: 1, maxPostsPerWeek: 3, approvalDefault: 'auto', regulatedApproval: 'compliance+client',
      remindAfterDays: 3, expireAfterDays: 14, similarityMax: { site: 0.5, network: 0.6 }, maxPostsPerClusterPer90d: 2,
    },
    linkNetwork: { enabled: false },
    backlinksApi: { enabled: false },
    searchConsole: { enabled: false },
    safeMode: { allowSites: [], spendCapUsd: 1, live: false },
  };
}

function mergeDefaults(defaults, stored) {
  if (!isPlainObject(defaults)) return stored === undefined ? defaults : stored;
  const out = { ...defaults };
  if (!isPlainObject(stored)) return out;
  for (const [key, value] of Object.entries(stored)) {
    out[key] = isPlainObject(defaults[key]) && isPlainObject(value) ? mergeDefaults(defaults[key], value) : value;
  }
  return out;
}

// ---------------------------------------------------------------- retention

function monthOf(iso) {
  const ms = Date.parse(String(iso || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 7) : '';
}

function monthsBefore(now, months) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

function average(list) {
  const nums = list.filter((n) => Number.isFinite(n));
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
}

/** Monthly aggregate of rank snapshots: per keyword the average and best organic and maps positions. */
function aggregateMonth(month, snapshots, existing = null) {
  const byKeyword = new Map();
  const seed = existing && Array.isArray(existing.keywords) ? existing.keywords : [];
  for (const row of seed) byKeyword.set(row.keyword, { ...row, _organic: [], _maps: [] });
  for (const snap of snapshots) {
    for (const kw of Array.isArray(snap.keywords) ? snap.keywords : []) {
      const key = String(kw.keyword || '');
      if (!key) continue;
      const row = byKeyword.get(key) || { keyword: key, runs: 0, avgOrganic: null, bestOrganic: null, avgMaps: null, aiOverviewCited: 0, _organic: [], _maps: [] };
      row.runs = (row.runs || 0) + 1;
      if (Number.isFinite(kw.organic?.position)) row._organic.push(kw.organic.position);
      if (Number.isFinite(kw.maps?.position)) row._maps.push(kw.maps.position);
      if (kw.aiOverview?.cited) row.aiOverviewCited = (row.aiOverviewCited || 0) + 1;
      byKeyword.set(key, row);
    }
  }
  const keywords = [...byKeyword.values()].map(({ _organic, _maps, ...row }) => {
    const organic = [..._organic, ...(Number.isFinite(row.avgOrganic) ? [row.avgOrganic] : [])];
    const maps = [..._maps, ...(Number.isFinite(row.avgMaps) ? [row.avgMaps] : [])];
    const best = [..._organic, ...(Number.isFinite(row.bestOrganic) ? [row.bestOrganic] : [])];
    return { ...row, avgOrganic: average(organic), bestOrganic: best.length ? Math.min(...best) : null, avgMaps: average(maps) };
  });
  return { month, runs: (existing?.runs || 0) + snapshots.length, keywords };
}

/** Applies the per-site retention rules to a site document (in place) and returns it. */
export function applySiteRetention(doc, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  doc.ranks = isPlainObject(doc.ranks) ? doc.ranks : { snapshots: [], monthly: [] };
  const snapshots = Array.isArray(doc.ranks.snapshots) ? doc.ranks.snapshots : [];
  const monthly = new Map((Array.isArray(doc.ranks.monthly) ? doc.ranks.monthly : []).map((row) => [row.month, row]));
  const fullFrom = monthsBefore(nowMs, RETENTION.rankFullMonths);
  const dropBefore = monthsBefore(nowMs, RETENTION.rankAggregateMonths);
  const keep = [];
  const toAggregate = new Map();
  for (const snap of snapshots) {
    const at = Date.parse(snap?.ranAt || '');
    if (!Number.isFinite(at) || at >= fullFrom) keep.push(snap);
    else if (at >= dropBefore) {
      const month = monthOf(snap.ranAt);
      toAggregate.set(month, [...(toAggregate.get(month) || []), snap]);
    }
  }
  for (const [month, list] of toAggregate) monthly.set(month, aggregateMonth(month, list, monthly.get(month)));
  const dropMonth = new Date(dropBefore).toISOString().slice(0, 7);
  doc.ranks.snapshots = keep.sort((a, b) => String(a.ranAt).localeCompare(String(b.ranAt)));
  doc.ranks.monthly = [...monthly.values()].filter((row) => MONTH_RE.test(row.month) && row.month >= dropMonth).sort((a, b) => a.month.localeCompare(b.month));

  doc.reports = (Array.isArray(doc.reports) ? doc.reports : []).slice(-RETENTION.reports);

  const queue = Array.isArray(doc.blogQueue) ? doc.blogQueue : [];
  const open = queue.filter((item) => !BLOG_TERMINAL_STATUSES.includes(item?.status));
  const done = queue.filter((item) => BLOG_TERMINAL_STATUSES.includes(item?.status))
    .sort((a, b) => String(a.updatedAt || a.createdAt || '').localeCompare(String(b.updatedAt || b.createdAt || '')))
    .slice(-RETENTION.blogTerminal);
  const keepIds = new Set([...open, ...done]);
  doc.blogQueue = queue.filter((item) => keepIds.has(item));

  doc.aiVisibility = isPlainObject(doc.aiVisibility) ? doc.aiVisibility : { checks: [] };
  const aiFrom = monthsBefore(nowMs, RETENTION.aiVisibilityMonths);
  doc.aiVisibility.checks = (Array.isArray(doc.aiVisibility.checks) ? doc.aiVisibility.checks : [])
    .filter((check) => {
      const at = Date.parse(check?.at || '');
      return !Number.isFinite(at) || at >= aiFrom;
    });
  return doc;
}

/** Last resort for the 2 MB cap: drop the oldest full snapshots, then reports, then finished posts. */
function trimToSize(doc, serialize) {
  let text = serialize(doc);
  const steps = [
    () => doc.ranks.snapshots.length > 4 && doc.ranks.snapshots.shift(),
    () => doc.reports.length > 4 && doc.reports.shift(),
    () => {
      const i = doc.blogQueue.findIndex((item) => BLOG_TERMINAL_STATUSES.includes(item?.status));
      return i !== -1 && doc.blogQueue.splice(i, 1);
    },
  ];
  for (const step of steps) {
    while (Buffer.byteLength(text, 'utf8') > MAX_SITE_FILE_BYTES && step()) text = serialize(doc);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_SITE_FILE_BYTES) {
    throw new SeoOpsStoreError('too-large', `seo-ops site file for ${doc.siteKey} is over ${MAX_SITE_FILE_BYTES} bytes`);
  }
  return text;
}

/** Client record bounds: history keeps the last 200 rows (older ones are counted), 50 plan candidates. */
export function applyClientRetention(doc) {
  const history = Array.isArray(doc.history) ? doc.history : [];
  if (history.length > RETENTION.clientHistory) {
    doc.historyArchivedCount = (Number(doc.historyArchivedCount) || 0) + (history.length - RETENTION.clientHistory);
    doc.history = history.slice(-RETENTION.clientHistory);
  } else doc.history = history;
  if (isPlainObject(doc.planSummary) && Array.isArray(doc.planSummary.candidates)) {
    doc.planSummary.candidates = doc.planSummary.candidates.slice(0, RETENTION.planCandidates);
  }
  return doc;
}

// ---------------------------------------------------------------- the store

// Compact JSON: these files are read by code, and a site file can hold a year of data.
function serialize(doc) {
  return `${JSON.stringify(doc)}\n`;
}

function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch (error) {
    throw new SeoOpsStoreError('unreadable', `seo-ops file cannot be read: ${path} (${error.code || error.message})`);
  }
}

function parseDoc(text, path) {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // fall through
  }
  // A broken file is never overwritten silently: the job stops and the file stays for a person.
  throw new SeoOpsStoreError('corrupt', `seo-ops file is not a JSON object: ${path}`);
}

/**
 * The store. `now` drives retention (tests pass a clock); `backupKeep` is how many stamped backups
 * each site and client file keeps (default: DATA_BACKUP_KEEP, at most 3, since site files can be large).
 */
export function createSeoOpsStore({ now = () => new Date(), backupKeep } = {}) {
  const keep = Number.isFinite(backupKeep) ? resolveDataBackupKeep(backupKeep) : Math.min(resolveDataBackupKeep(), 3);
  const chains = new Map();

  const root = () => join(getPersistentDataDir(), SEO_OPS_DIR);
  const sitePath = (key) => join(root(), 'sites', `${key}.json`);
  const clientPath = (key) => join(root(), 'clients', `${key}.json`);
  const ledgerName = (month) => `dfs-ledger-${month}.json`;

  /** One writer per key at a time inside this process; callers may be async. */
  function serialized(lockKey, task) {
    const previous = chains.get(lockKey) || Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => {});
    chains.set(lockKey, tail);
    tail.then(() => {
      if (chains.get(lockKey) === tail) chains.delete(lockKey);
    });
    return run;
  }

  /**
   * Read-modify-write. `fn(draft)` may change the draft or return a new document (undefined keeps the
   * draft, null skips the write). Another process writing the same file meanwhile makes this retry
   * with the fresh file (up to 4 times).
   */
  function update({ lockKey, path, fresh, retention, backupName, backupKeep: fileKeep, maxBytes }, fn) {
    return serialized(lockKey, async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        mkdirSync(join(path, '..'), { recursive: true });
        const before = readText(path);
        const current = parseDoc(before, path) || fresh();
        const draft = structuredClone(current);
        const returned = await fn(draft);
        if (returned === null) return current;
        const next = returned === undefined ? draft : returned;
        if (!isPlainObject(next)) throw new SeoOpsStoreError('invalid-doc', 'An seo-ops update must leave an object');
        retention(next);
        const text = maxBytes ? trimToSize(next, serialize) : serialize(next);
        const written = withFileLock(path, () => {
          if (readText(path) !== before) return false;
          if (text === before) return true;
          writeDataJson(path, text, { backupName, latest: false, atomic: true, keep: fileKeep, previous: before ?? '' });
          return true;
        });
        if (written) return next;
      }
      throw new SeoOpsStoreError('conflict', `seo-ops file kept changing while it was updated: ${path}`);
    });
  }

  function siteKeyOf(siteKey) {
    return sanitizeSeoOpsKey(siteKey);
  }

  const store = {
    root,
    keep,
    sanitizeKey: sanitizeSeoOpsKey,
    sitePath: (siteKey) => sitePath(siteKeyOf(siteKey)),
    clientPath: (id) => clientPath(sanitizeSeoOpsKey(id)),
    backupNameForSite: (siteKey) => `${SEO_OPS_DIR}__sites__${siteKeyOf(siteKey)}.json`,
    backupNameForClient: (id) => `${SEO_OPS_DIR}__clients__${sanitizeSeoOpsKey(id)}.json`,

    /** The site document, or a fresh empty one when the site has none yet (nothing is written). */
    readSite(siteKey) {
      const key = siteKeyOf(siteKey);
      const path = sitePath(key);
      return parseDoc(readText(path), path) || emptySiteDoc(key);
    },

    updateSite(siteKey, fn) {
      const key = siteKeyOf(siteKey);
      return update({
        lockKey: `site:${key}`,
        path: sitePath(key),
        fresh: () => emptySiteDoc(key),
        retention: (doc) => {
          doc.siteKey = key;
          doc.version = SEO_OPS_VERSION;
          applySiteRetention(doc, now());
        },
        backupName: store.backupNameForSite(key),
        backupKeep: keep,
        maxBytes: MAX_SITE_FILE_BYTES,
      }, fn);
    },

    readClient(salesClientId) {
      const key = sanitizeSeoOpsKey(salesClientId);
      const path = clientPath(key);
      return parseDoc(readText(path), path) || emptyClientDoc(String(salesClientId));
    },

    updateClient(salesClientId, fn) {
      const key = sanitizeSeoOpsKey(salesClientId);
      return update({
        lockKey: `client:${key}`,
        path: clientPath(key),
        fresh: () => emptyClientDoc(String(salesClientId)),
        retention: (doc) => {
          doc.salesClientId = doc.salesClientId || String(salesClientId);
          doc.version = SEO_OPS_VERSION;
          applyClientRetention(doc);
        },
        backupName: store.backupNameForClient(key),
        backupKeep: keep,
      }, fn);
    },

    /** settings.json merged over the defaults in code. */
    readSettings() {
      const path = join(root(), GLOBAL_FILES.settings);
      return mergeDefaults(defaultSeoOpsSettings(), parseDoc(readText(path), path));
    },

    /** A global file ('settings' | 'linkNetwork' | 'health'); null when missing. */
    readGlobal(name) {
      const file = GLOBAL_FILES[name];
      if (!file) throw new SeoOpsStoreError('invalid-key', `Unknown seo-ops global file: ${name}`);
      const path = join(root(), file);
      return parseDoc(readText(path), path);
    },

    updateGlobal(name, fn) {
      const file = GLOBAL_FILES[name];
      if (!file) return Promise.reject(new SeoOpsStoreError('invalid-key', `Unknown seo-ops global file: ${name}`));
      return update({
        lockKey: `global:${name}`,
        path: join(root(), file),
        fresh: () => (name === 'settings' ? defaultSeoOpsSettings() : {}),
        retention: () => {},
        backupName: `${SEO_OPS_DIR}__${file}`,
        // health.json is derived state: no backups.
        backupKeep: name === 'health' ? 0 : GLOBAL_BACKUP_KEEP,
      }, fn);
    },

    readLedger(month) {
      if (!MONTH_RE.test(String(month))) throw new SeoOpsStoreError('invalid-key', `Ledger month must be YYYY-MM: ${month}`);
      const path = join(root(), ledgerName(month));
      return parseDoc(readText(path), path);
    },

    /**
     * Month ledger (WS9.50 books into it). Only the current month keeps backups; closing a month
     * removes the backups of older months, and months older than 13 are deleted with theirs.
     */
    async updateLedger(month, fn) {
      if (!MONTH_RE.test(String(month))) throw new SeoOpsStoreError('invalid-key', `Ledger month must be YYYY-MM: ${month}`);
      const result = await update({
        lockKey: `ledger:${month}`,
        path: join(root(), ledgerName(month)),
        fresh: () => ({ month, version: SEO_OPS_VERSION, entries: [], totals: {} }),
        retention: () => {},
        backupName: `${SEO_OPS_DIR}__${ledgerName(month)}`,
        backupKeep: GLOBAL_BACKUP_KEEP,
      }, fn);
      store.pruneLedgers(month);
      return result;
    },

    /** Deletes ledger months older than 13 months and the backups of every month but `currentMonth`. */
    pruneLedgers(currentMonth = now().toISOString().slice(0, 7)) {
      const dir = root();
      if (!existsSync(dir)) return { removed: [] };
      const oldest = new Date(`${currentMonth}-01T00:00:00.000Z`);
      oldest.setUTCMonth(oldest.getUTCMonth() - (RETENTION.ledgerMonths - 1));
      const cutoff = oldest.toISOString().slice(0, 7);
      const removed = [];
      for (const name of readdirSync(dir)) {
        const match = /^dfs-ledger-(\d{4}-\d{2})\.json$/.exec(name);
        if (!match) continue;
        if (match[1] !== currentMonth) pruneDataBackupsForFile(`${SEO_OPS_DIR}__${name}`, { keep: 0 });
        if (match[1] < cutoff) {
          try {
            unlinkSync(join(dir, name));
            removed.push(match[1]);
          } catch {
            // left for the next prune
          }
        }
      }
      return { removed };
    },

    listSites() {
      const dir = join(root(), 'sites');
      return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort() : [];
    },

    listClients() {
      const dir = join(root(), 'clients');
      return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort() : [];
    },

    /** Removes a site's file and every backup of it (WS9.57 deletion, erasure). */
    deleteSite(siteKey) {
      const key = siteKeyOf(siteKey);
      return serialized(`site:${key}`, async () => removeWithBackups(sitePath(key), store.backupNameForSite(key)));
    },

    deleteClient(salesClientId) {
      const key = sanitizeSeoOpsKey(salesClientId);
      return serialized(`client:${key}`, async () => removeWithBackups(clientPath(key), store.backupNameForClient(key)));
    },

    /** Whether a job may run for this site now (see the file comment). */
    safeModeGate(siteKey, { settings = null } = {}) {
      return seoOpsSafeModeGate(siteKey, { settings: settings || store.readSettings() });
    },
  };
  return store;
}

function removeWithBackups(path, backupName) {
  let removed = false;
  withFileLock(path, () => {
    if (existsSync(path)) {
      unlinkSync(path);
      removed = true;
    }
  });
  pruneDataBackupsForFile(backupName, { keep: 0 });
  const latest = join(getDataBackupDir(), `${backupName}.latest.json`);
  if (existsSync(latest)) unlinkSync(latest);
  return { removed };
}

/**
 * { allowed, safeMode, live, spendCapUsd, reason } for one site. With hub safe mode off every site
 * is allowed and calls are live. With it on, only sites in settings.safeMode.allowSites run, paid
 * calls replay fixtures unless settings.safeMode.live, and spending is capped at spendCapUsd.
 */
export function seoOpsSafeModeGate(siteKey, { settings = defaultSeoOpsSettings(), safeMode = isSafeModeActive() } = {}) {
  if (!safeMode) return { allowed: true, safeMode: false, live: true, spendCapUsd: null, reason: 'safe mode is off' };
  const config = mergeDefaults(defaultSeoOpsSettings().safeMode, settings?.safeMode);
  const allowSites = Array.isArray(config.allowSites) ? config.allowSites.map(String) : [];
  const allowed = allowSites.includes(String(siteKey));
  return {
    allowed,
    safeMode: true,
    live: allowed && config.live === true,
    spendCapUsd: Number(config.spendCapUsd) || 0,
    reason: allowed ? 'allow-listed for safe mode' : 'hub safe mode: the site is not in settings.safeMode.allowSites',
  };
}

let defaultStore = null;
function shared() {
  if (!defaultStore) defaultStore = createSeoOpsStore();
  return defaultStore;
}

export const readSite = (siteKey) => shared().readSite(siteKey);
export const updateSite = (siteKey, fn) => shared().updateSite(siteKey, fn);
export const readClient = (id) => shared().readClient(id);
export const updateClient = (id, fn) => shared().updateClient(id, fn);
export const readSeoOpsSettings = () => shared().readSettings();
export const readGlobal = (name) => shared().readGlobal(name);
export const updateGlobal = (name, fn) => shared().updateGlobal(name, fn);
export const readLedger = (month) => shared().readLedger(month);
export const updateLedger = (month, fn) => shared().updateLedger(month, fn);
