/**
 * Hub email data store (WS7.1).
 *
 * Files live in the persistent data dir (never in Git):
 * - email-settings.json, email-sites.json, email-suppressions.json: low churn,
 *   written through writeDataJson so a backup snapshot exists.
 * - email-ledger.json and other high-churn files: writeJsonAtomic (tmp + rename,
 *   no backup churn; Hostinger caps the file count).
 * - Secrets: the disk secret store (<dataDir>/secrets/, readOrCreateDiskSecret).
 *   They are never returned by an API and never logged.
 *
 * Cross-process safety: withFileLock = in-process promise chain + an O_EXCL
 * lockfile ({pid, at, nonce}, 10 s stale timeout), so two hub workers sharing
 * the data dir serialize too. acquireLease adds a TTL lease with a monotonically
 * increasing fencing token.
 *
 * Sync file calls never block the event loop for long: only Windows EPERM/EBUSY
 * is retried, within READ_BUDGET_MS per file; every other error fails at once,
 * and callers fail closed (marketing) or keep today's behaviour (routing).
 * Reads never write; only locked writes repair a live file from its backup.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { getDataBackupDir, getPersistentDataDir, writeDataJson } from './storage-path.js';
import { readOrCreateDiskSecret } from '../lib/auth-hardening.js';

export const EMAIL_FILES = Object.freeze({
  settings: 'email-settings.json',
  sites: 'email-sites.json',
  suppressions: 'email-suppressions.json',
  ledger: 'email-ledger.json',
  brandCache: 'email-brand-cache.json',
  campaigns: 'email-campaigns.json',
});

/** Names inside <dataDir>/secrets/ (the disk secret store). */
export const EMAIL_SECRET_NAMES = Object.freeze({
  unsubKey: 'email-unsub-key',
  webhookToken: 'email-webhook-token',
  json: 'email-secrets.json',
});

const LOCK_DIR = 'email-locks';
export const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;
/**
 * Sync file calls block the event loop, so every retry has a hard time budget.
 * A read of one file never blocks for more than READ_BUDGET_MS; a backed-up read
 * (live file, then its backup) stays under about 2 x READ_BUDGET_MS.
 */
export const READ_BUDGET_MS = 50;
const WRITE_BUDGET_MS = 150;
const IS_WINDOWS = process.platform === 'win32';
const OWNER_ROUTING_MODES = new Set(['', 'owner', 'owner+asoldi-bcc']);
/** Marker in the disk secret store: once present, a missing opt-out record is an incident, not a fresh install. */
export const SUPPRESSIONS_MARKER = 'email-suppressions-created';

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, Math.max(1, Math.floor(ms)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Windows reports EPERM/EBUSY while another process holds or renames the file.
 * Everything else (EACCES, EMFILE, EIO, ...) is a hard error: callers fail
 * closed or fall back at once instead of stalling the hub.
 */
function isTransientFsError(error) {
  return IS_WINDOWS && (error?.code === 'EPERM' || error?.code === 'EBUSY');
}

function retrySync(fn, budgetMs = READ_BUDGET_MS) {
  const deadline = Date.now() + budgetMs;
  for (let i = 0; ; i += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isTransientFsError(error)) throw error;
      const left = deadline - Date.now();
      if (left <= 0) throw error;
      sleepSync(Math.min(left, 2 + i * 3, 15));
    }
  }
}

function unlinkQuiet(path) {
  try {
    retrySync(() => unlinkSync(path));
    return true;
  } catch {
    return false;
  }
}

/** File text, or null when the file does not exist. Other errors throw (no swallowing). */
function readTextOrNull(path) {
  try {
    return retrySync(() => readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const alertedAt = new Map();
/** Ops alert on the console, at most once per 10 minutes per key and process. Never include data. */
function opsAlert(key, message) {
  const t = Date.now();
  if (t - (alertedAt.get(key) || 0) < 10 * 60 * 1000) return;
  alertedAt.set(key, t);
  console.error(`[email-store] ALERT ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Deep merge for settings-like objects: plain objects merge, arrays and scalars replace. */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return clone(patch);
  const out = isPlainObject(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

function assertSafeName(name) {
  const text = String(name || '');
  if (!text || text.startsWith('/') || text.includes('\\') || text.split('/').some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error(`email store: bad file name "${text}"`);
  }
  return text;
}

export function emailDataDir() {
  return getPersistentDataDir();
}

export function emailDataPath(name) {
  return join(emailDataDir(), ...assertSafeName(name).split('/'));
}

function unreadableError(name, cause) {
  const error = new Error(`email store: ${name} is unreadable`);
  error.code = 'EMAIL_STORE_UNREADABLE';
  error.file = name;
  // Only the code: a JSON parse message quotes file content (addresses, keys).
  if (cause?.code) error.causeCode = cause.code;
  return error;
}

/**
 * One JSON file within one READ_BUDGET_MS deadline. Missing → fallback.
 * A torn read (writeDataJson writes in place) and Windows EPERM/EBUSY are retried
 * until the deadline; any other error (EACCES, ...) throws at once.
 */
function readJsonAbs(path, fallback, label) {
  const deadline = Date.now() + READ_BUDGET_MS;
  for (let attempt = 0; ; attempt += 1) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return clone(fallback);
      if (!isTransientFsError(error) || Date.now() >= deadline) throw unreadableError(label || path, error);
      sleepSync(Math.min(Math.max(1, deadline - Date.now()), 2 + attempt * 3, 15));
      continue;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      if (Date.now() >= deadline) throw unreadableError(label || path, error);
      sleepSync(Math.min(Math.max(1, deadline - Date.now()), 2 + attempt * 3, 15));
    }
  }
}

/** Read a JSON file from the data dir. Missing → fallback. Persistently corrupt → throws EMAIL_STORE_UNREADABLE. */
export function readJson(name, fallback = null) {
  return readJsonAbs(emailDataPath(name), fallback, name);
}

function writeAtomicAbs(path, value, { mode } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, mode ? { encoding: 'utf8', mode } : 'utf8');
  try {
    retrySync(() => renameSync(tmp, path), WRITE_BUDGET_MS);
  } catch (error) {
    unlinkQuiet(tmp);
    throw error;
  }
}

/** tmp + rename in the data dir. No backup snapshot (for high-churn files). */
export function writeJsonAtomic(name, value) {
  writeAtomicAbs(emailDataPath(name), value);
}

/** Same as writeJsonAtomic for an absolute path (email-log keeps files in its own dir). */
export function writeJsonFileAtomic(path, value) {
  writeAtomicAbs(path, value);
}

export function readJsonFile(path, fallback = null) {
  return readJsonAbs(path, fallback, path);
}

/**
 * Low-churn files: writeDataJson keeps a backup snapshot under <dataDir>/backups.
 * Only called inside withFileLock, so a write never races another writer.
 */
function writeBackedUpJson(name, value) {
  const path = emailDataPath(name);
  retrySync(() => writeDataJson(path, value), WRITE_BUDGET_MS);
}

/**
 * Read a backed-up file: { value, source } with source 'live', 'backup' or 'none'.
 * A missing or corrupt live file falls back to backups/<name>.latest.json, which is
 * returned as is. The read path never writes: a reader in another process could
 * otherwise put an older backup over a write in progress. The next locked write
 * repairs the live file. Both unreadable → throws EMAIL_STORE_UNREADABLE.
 */
function readBackedUpJsonMeta(name) {
  let liveError = null;
  const path = emailDataPath(name);
  try {
    const live = readJsonAbs(path, undefined, name);
    if (live !== undefined && live !== null) return { value: live, source: 'live' };
  } catch (error) {
    liveError = error;
  }
  const backupPath = join(getDataBackupDir(), `${name.split('/').pop()}.latest.json`);
  let backupError = null;
  try {
    const backup = readJsonAbs(backupPath, undefined, `${name} backup`);
    if (backup !== undefined && backup !== null) return { value: backup, source: 'backup' };
  } catch (error) {
    backupError = error;
  }
  if (liveError) throw unreadableError(name, liveError);
  // Live file missing: a corrupt backup alone is not fatal, but it is worth an alert.
  if (backupError) opsAlert(`backup-${name}`, `${name} is missing and its backup is unreadable.`);
  return { value: undefined, source: 'none' };
}

/** Value of a backed-up file (see readBackedUpJsonMeta), or the fallback when neither file exists. */
export function readBackedUpJson(name, fallback = null) {
  const { value } = readBackedUpJsonMeta(name);
  return value === undefined ? clone(fallback) : value;
}

/* ------------------------------------------------------------------ locks */

const lockChains = new Map();

function lockKeyFor(name) {
  return String(name || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'default';
}

function lockDir() {
  const dir = join(emailDataDir(), LOCK_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function lockFilePath(key) {
  return join(lockDir(), `${key}.lock`);
}

function readLockInfo(path) {
  let text = '';
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (!mtimeMs) return null;
  }
  try {
    const info = JSON.parse(text);
    const at = Number(info?.at);
    return { at: Number.isFinite(at) && at > 0 ? at : mtimeMs, nonce: String(info?.nonce || ''), pid: Number(info?.pid) || 0 };
  } catch {
    // Created with O_EXCL but not written yet (or torn): age by mtime.
    return { at: mtimeMs, nonce: '', pid: 0 };
  }
}

/** Remove a lockfile whose holder died. A short reaper lock keeps two waiters from both reaping. */
function reapStaleLock(path, staleMs) {
  const info = readLockInfo(path);
  if (!info || Date.now() - info.at < staleMs) return false;
  const reaper = `${path}.reap`;
  try {
    closeSync(openSync(reaper, 'wx', 0o600));
  } catch (error) {
    if (error?.code === 'EEXIST') {
      try {
        if (Date.now() - statSync(reaper).mtimeMs > staleMs) unlinkQuiet(reaper);
      } catch {
        // gone already
      }
    }
    return false;
  }
  try {
    const again = readLockInfo(path);
    if (again && again.nonce === info.nonce && again.at === info.at && Date.now() - again.at >= staleMs) {
      return unlinkQuiet(path);
    }
    return false;
  } finally {
    unlinkQuiet(reaper);
  }
}

async function acquireLockFile(key, { staleMs, timeoutMs }) {
  const path = lockFilePath(key);
  const nonce = randomBytes(8).toString('hex');
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    let fd = null;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      // Windows: EPERM while the previous holder's lockfile is still being deleted.
      if (error?.code !== 'EEXIST' && !isTransientFsError(error)) throw error;
      if (error?.code === 'EEXIST') reapStaleLock(path, staleMs);
    }
    if (fd !== null) {
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), nonce }));
      } finally {
        closeSync(fd);
      }
      return { path, nonce };
    }
    if (Date.now() - started > timeoutMs) {
      const error = new Error(`email store: lock "${key}" timed out`);
      error.code = 'EMAIL_LOCK_TIMEOUT';
      throw error;
    }
    await delay(Math.min(25, 1 + attempt) + Math.random() * 4);
  }
}

function releaseLockFile(handle) {
  if (!handle) return;
  const info = readLockInfo(handle.path);
  // Only remove our own lock. After a stale reap the file may be another process's
  // brand-new lock, created with O_EXCL but not written yet (empty nonce): leave it.
  if (info && info.nonce && info.nonce === handle.nonce) unlinkQuiet(handle.path);
}

/**
 * Run fn while holding the named lock, in this process and across processes.
 * The lock is released when fn settles. Returns fn's result.
 */
export function withFileLock(name, fn, { staleMs = LOCK_STALE_MS, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const key = lockKeyFor(name);
  const previous = lockChains.get(key) || Promise.resolve();
  const run = previous.then(async () => {
    const handle = await acquireLockFile(key, { staleMs, timeoutMs });
    try {
      return await fn();
    } finally {
      releaseLockFile(handle);
    }
  });
  const tail = run.then(() => undefined, () => undefined);
  lockChains.set(key, tail);
  tail.then(() => {
    if (lockChains.get(key) === tail) lockChains.delete(key);
  });
  return run;
}

/* ------------------------------------------------------------------ leases and fencing */

function fencePath(name) {
  return join(lockDir(), `${lockKeyFor(name)}.fence`);
}

function leasePath(name) {
  return join(lockDir(), `${lockKeyFor(name)}.lease`);
}

function fenceError(name, cause) {
  const error = new Error(`email store: fencing token for "${name}" is unreadable`);
  error.code = 'EMAIL_FENCE_UNREADABLE';
  if (cause?.code) error.causeCode = cause.code;
  return error;
}

/**
 * The highest fencing token issued for a lease name. 0 only when no token was
 * ever issued (no file). A read error or a damaged file throws, so the token can
 * never go backwards (fence files are written tmp + rename, so they are never torn).
 */
export function currentFence(name) {
  let text;
  try {
    text = readTextOrNull(fencePath(name));
  } catch (error) {
    throw fenceError(name, error);
  }
  if (text === null) return 0;
  const trimmed = text.trim();
  const value = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  if (!Number.isSafeInteger(value)) throw fenceError(name);
  return value;
}

function bumpFence(name) {
  const next = currentFence(name) + 1;
  writeAtomicAbs(fencePath(name), String(next));
  return next;
}

/**
 * The lease on disk, or null when there is none. A read error throws (the lease may
 * be live, so nobody may take it). A damaged lease file counts as none: the next
 * holder gets a higher fencing token, which the old holder's isCurrent() rejects.
 */
function readLease(name) {
  const text = readTextOrNull(leasePath(name));
  if (text === null) return null;
  try {
    const lease = JSON.parse(text);
    return isPlainObject(lease) ? lease : null;
  } catch {
    return null;
  }
}

/**
 * Try to take the named lease for ttlMs. Returns null when another live holder
 * has it (a second hub worker skips its tick). A lease whose holder died is
 * taken over once it expires, with a higher fencing token.
 */
export async function acquireLease(name, ttlMs = 60_000, { now = () => Date.now() } = {}) {
  const ttl = Math.max(100, Number(ttlMs) || 60_000);
  return withFileLock(`lease-${lockKeyFor(name)}`, () => {
    const current = readLease(name);
    const t = now();
    if (current && Number(current.expiresAt) > t) return null;
    const token = bumpFence(name);
    const nonce = randomBytes(8).toString('hex');
    const lease = { name: String(name), pid: process.pid, host: hostname(), token, nonce, at: t, expiresAt: t + ttl };
    writeAtomicAbs(leasePath(name), lease);
    let held = true;
    return {
      token,
      get expiresAt() {
        return lease.expiresAt;
      },
      /** True while this lease is the newest one and has not expired. A read error counts as not current. */
      isCurrent() {
        if (!held) return false;
        try {
          const onDisk = readLease(name);
          return Boolean(onDisk && onDisk.nonce === nonce && Number(onDisk.expiresAt) > now()) && currentFence(name) === token;
        } catch {
          return false;
        }
      },
      async renew(nextTtlMs = ttl) {
        return withFileLock(`lease-${lockKeyFor(name)}`, () => {
          const onDisk = readLease(name);
          if (!held || !onDisk || onDisk.nonce !== nonce || currentFence(name) !== token) return false;
          lease.expiresAt = now() + Math.max(100, Number(nextTtlMs) || ttl);
          writeAtomicAbs(leasePath(name), lease);
          return true;
        });
      },
      async release() {
        if (!held) return false;
        held = false;
        return withFileLock(`lease-${lockKeyFor(name)}`, () => {
          const onDisk = readLease(name);
          if (onDisk && onDisk.nonce === nonce) return unlinkQuiet(leasePath(name));
          return false;
        });
      },
    };
  });
}

/* ------------------------------------------------------------------ settings */

export function defaultEmailSettings() {
  return {
    version: 1,
    // Dark by default: nothing sends until Superadmin adds sites to the allowlist.
    rollout: { mode: 'off', siteIds: [] },
    killSwitch: false,
    brevo: {
      sandbox: false,
      syncContacts: false,
      folderId: null,
      webhookId: null,
      lastAccountSyncAt: '',
      // Filled by the Brevo account sync (WS7.37); the owner reports a paid Starter plan.
      planTier: 'unknown',
      campaignsOnFree: false,
      termsConfirmedAt: '',
      termsNote: '',
    },
    quota: {
      mode: 'daily',
      limit: 300,
      resetTz: 'Europe/Oslo',
      safety: 15,
      asoldiReserve: 0,
      p1Reserve: 75,
      p1ReserveUntilHour: 20,
      perSiteP1Max: 40,
      perSiteSignupMax: 10,
      signupPoolMax: 40,
      perSiteMin: 10,
      perSiteCampaignMax: 100,
      borrowAfterHour: 16,
      perRecipientMarketingPerDay: 2,
      perRecipientCampaignEveryDays: 3,
    },
    sender: { defaultAddress: 'kunder@asoldi.com', nameSuffix: '' },
    links: {
      rules: [
        { host: 'search.google.com', paths: ['/local/writereview'] },
        { host: 'g.page', paths: ['/r/*'] },
        { host: 'www.facebook.com', paths: ['/*'], deny: ['/l.php', '/sharer*', '/dialog/*', '/plugins/*'] },
        { host: 'www.instagram.com', paths: ['/*'], deny: ['/accounts/*'] },
        { host: 'www.linkedin.com', paths: ['/company/*', '/in/*'] },
        { host: 'www.youtube.com', paths: ['/@*', '/channel/*', '/watch', '/shorts/*'] },
        { host: 'www.tiktok.com', paths: ['/@*'] },
        { host: 'vimeo.com', paths: ['/[0-9]*'] },
      ],
      denyHosts: ['l.facebook.com', 'lm.facebook.com', 'l.instagram.com', 't.co', 'bit.ly', 'goo.gl', 'tinyurl.com'],
      denyPaths: ['google.com/url', 'www.google.com/url', 'linkedin.com/redir', 'www.youtube.com/redirect'],
      imageHosts: [],
    },
    testRecipients: ['damian@asoldi.com', 'alexander@asoldi.com'],
    alerts: { recipients: ['damian@asoldi.com'], dailyAt: '08:30', quotaWarnRatio: 0.7, webhookSilenceHours: 24, staleTickMinutes: 30 },
    health: { maxBounceRate: 0.05, maxComplaintRate: 0.003, window: 100 },
  };
}

function readStoredSettings() {
  const stored = readBackedUpJson(EMAIL_FILES.settings, {});
  return isPlainObject(stored) ? stored : {};
}

/** Defaults merged with the stored file. A corrupt file with no backup gives defaults (rollout off). */
export function readEmailSettings() {
  let stored = {};
  try {
    stored = readStoredSettings();
  } catch {
    stored = {};
  }
  return deepMerge(defaultEmailSettings(), stored);
}

const SETTINGS_KEYS = new Set(Object.keys(defaultEmailSettings()));

export async function saveEmailSettings(patch = {}) {
  if (!isPlainObject(patch)) throw new Error('saveEmailSettings: patch must be an object');
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SETTINGS_KEYS.has(key) && key !== 'version') clean[key] = value;
  }
  return withFileLock(EMAIL_FILES.settings, () => {
    const next = deepMerge(readStoredSettings(), clean);
    next.version = 1;
    writeBackedUpJson(EMAIL_FILES.settings, next);
    return deepMerge(defaultEmailSettings(), next);
  });
}

/* ------------------------------------------------------------------ per-site state */

export function normalizeOwnerRouting(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return OWNER_ROUTING_MODES.has(text) ? text : '';
}

export function defaultEmailSite() {
  return {
    brevoListId: null,
    auth: { keyId: '', provisionedAt: '', confirmedAt: '', target: '' },
    sender: { mode: 'asoldi', domain: '', address: '', brevoDomainVerifiedAt: '', warmupStartedAt: '' },
    ownerRecipients: [],
    ownerRouting: '',
    ownerRoutingSetAt: '',
    ownerRoutingSetBy: '',
    allowHosts: [],
    allowImageHosts: [],
    regulatedClaims: false,
    suspended: null,
    quotaOverride: null,
    dpa: { acceptedAt: '', version: '', attestedBy: '' },
    cmsHealth: null,
  };
}

function normalizeOwnerRecipientRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(isPlainObject)
    .map((row) => ({
      email: String(row.email || '').trim().toLowerCase(),
      status: row.status === 'confirmed' ? 'confirmed' : 'pending',
      confirmedAt: String(row.confirmedAt || ''),
      source: String(row.source || ''),
    }))
    .filter((row) => row.email);
}

function normalizeEmailSiteRow(row) {
  const merged = deepMerge(defaultEmailSite(), isPlainObject(row) ? row : {});
  merged.ownerRouting = normalizeOwnerRouting(merged.ownerRouting);
  merged.ownerRoutingSetAt = String(merged.ownerRoutingSetAt || '');
  merged.ownerRecipients = normalizeOwnerRecipientRows(merged.ownerRecipients);
  return merged;
}

function readStoredSites() {
  const stored = readBackedUpJson(EMAIL_FILES.sites, {});
  return isPlainObject(stored) ? stored : {};
}

export function readEmailSites() {
  const stored = readStoredSites();
  return Object.fromEntries(Object.entries(stored).map(([id, row]) => [id, normalizeEmailSiteRow(row)]));
}

/** One site's row with defaults. Unknown site → defaults (nothing configured). */
export function readEmailSite(siteId) {
  const id = String(siteId || '').trim();
  if (!id) return normalizeEmailSiteRow({});
  return normalizeEmailSiteRow(readStoredSites()[id]);
}

export async function patchEmailSite(siteId, patch = {}) {
  const id = String(siteId || '').trim();
  if (!id) throw new Error('patchEmailSite: siteId required');
  if (!isPlainObject(patch)) throw new Error('patchEmailSite: patch must be an object');
  return withFileLock(EMAIL_FILES.sites, () => {
    const all = readStoredSites();
    const next = normalizeEmailSiteRow(deepMerge(all[id] || {}, patch));
    all[id] = next;
    writeBackedUpJson(EMAIL_FILES.sites, all);
    return next;
  });
}

/* ------------------------------------------------------------------ suppressions */

function suppressionsMarkerPath() {
  return join(emailDataDir(), 'secrets', SUPPRESSIONS_MARKER);
}

const markersSeen = new Set();
/** Written once the opt-out record exists (on the first write, or the first read of an existing file). */
function ensureSuppressionsMarker() {
  const path = suppressionsMarkerPath();
  if (markersSeen.has(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return; // retried on the next read or write
  }
  markersSeen.add(path);
}

function suppressionsLostError() {
  const error = unreadableError(EMAIL_FILES.suppressions);
  error.missing = true;
  opsAlert(
    'suppressions-lost',
    `${EMAIL_FILES.suppressions} and its backup are gone, but the opt-out record existed (secrets/${SUPPRESSIONS_MARKER}). `
      + 'All marketing that checks it is blocked until the file is restored from backups/ (or the marker is removed on purpose).',
  );
  return error;
}

function readSuppressionsMeta() {
  const meta = readBackedUpJsonMeta(EMAIL_FILES.suppressions);
  if (meta.source === 'none') {
    // Both files missing. Before the first opt-out that is a fresh install; after it, the record was lost.
    if (existsSync(suppressionsMarkerPath())) throw suppressionsLostError();
    return { rows: {}, source: 'none' };
  }
  if (!isPlainObject(meta.value)) throw unreadableError(EMAIL_FILES.suppressions);
  ensureSuppressionsMarker();
  return { rows: meta.value, source: meta.source };
}

/**
 * The legal opt-out record, keyed per site id, plus "*" (global) and "asoldi"
 * (Asoldi's own marketing). Throws EMAIL_STORE_UNREADABLE when neither the file
 * nor its backup can be read, or when both are gone after the record existed,
 * so callers fail closed.
 */
export function readEmailSuppressions() {
  return readSuppressionsMeta().rows;
}

/**
 * Read-modify-write under the cross-process lock. mutate(rows) edits rows in place.
 * Nothing is written when mutate changed nothing (an idempotent repost costs one read),
 * unless the live file had to come from the backup: then the locked write repairs it.
 */
export async function updateEmailSuppressions(mutate) {
  return withFileLock(EMAIL_FILES.suppressions, async () => {
    const { rows, source } = readSuppressionsMeta();
    const before = JSON.stringify(rows);
    const result = await mutate(rows);
    if (source === 'backup' || JSON.stringify(rows) !== before) {
      writeBackedUpJson(EMAIL_FILES.suppressions, rows);
      ensureSuppressionsMarker();
    }
    return result;
  });
}

/* ------------------------------------------------------------------ secrets */

function secretsJsonPath() {
  return join(emailDataDir(), 'secrets', EMAIL_SECRET_NAMES.json);
}

function secretsUnreadableError(cause) {
  // Never attach the parse error: its message quotes the file, i.e. the secrets.
  const error = new Error(`email store: secrets/${EMAIL_SECRET_NAMES.json} is unreadable; nothing was written`);
  error.code = 'EMAIL_SECRETS_UNREADABLE';
  if (cause?.code) error.causeCode = cause.code;
  return error;
}

/**
 * secrets/email-secrets.json. Missing → empty. With strict, any other read error or
 * a damaged file throws EMAIL_SECRETS_UNREADABLE (patches must not write over it);
 * without strict (key lookups) it reads as empty.
 */
function readSecretsJson({ strict = false } = {}) {
  const empty = { brevoApiKey: '', siteKeys: {} };
  let raw;
  try {
    const text = readTextOrNull(secretsJsonPath());
    if (text === null) return empty;
    raw = JSON.parse(text);
  } catch (error) {
    if (strict) throw secretsUnreadableError(error);
    return empty;
  }
  if (!isPlainObject(raw)) {
    if (strict) throw secretsUnreadableError();
    return empty;
  }
  return {
    brevoApiKey: typeof raw.brevoApiKey === 'string' ? raw.brevoApiKey : '',
    siteKeys: isPlainObject(raw.siteKeys) ? raw.siteKeys : {},
  };
}

/** Only the unsubscribe HMAC key (created on first use). Rendering a link needs nothing else. */
export function readEmailUnsubKey() {
  return readOrCreateDiskSecret(emailDataDir(), EMAIL_SECRET_NAMES.unsubKey, 32);
}

/**
 * Email secrets. unsubKey (32 bytes) and webhookToken (24 bytes) are created
 * on first use in the disk secret store and reused afterwards. Never return
 * this object from an API or log it.
 */
export function readEmailSecrets() {
  const dir = emailDataDir();
  const unsubKey = readEmailUnsubKey();
  const webhookToken = readOrCreateDiskSecret(dir, EMAIL_SECRET_NAMES.webhookToken, 24);
  const extra = readSecretsJson();
  return { unsubKey, webhookToken, brevoApiKey: extra.brevoApiKey, siteKeys: extra.siteKeys };
}

/**
 * Superadmin Brevo key paste (fallback when env has none) and per-site emailKeys (WS7.34).
 * Rejects with EMAIL_SECRETS_UNREADABLE, writing nothing, when the current file cannot be
 * read: a paste must never wipe the per-site keys.
 */
export async function patchEmailSecrets(patch = {}) {
  return withFileLock('email-secrets', () => {
    const current = readSecretsJson({ strict: true });
    if (typeof patch.brevoApiKey === 'string') current.brevoApiKey = patch.brevoApiKey.trim();
    if (isPlainObject(patch.siteKeys)) current.siteKeys = deepMerge(current.siteKeys, patch.siteKeys);
    mkdirSync(dirname(secretsJsonPath()), { recursive: true, mode: 0o700 });
    writeAtomicAbs(secretsJsonPath(), current, { mode: 0o600 });
    return true;
  });
}

function isMaskedSecret(value) {
  return /^\*+$/.test(value);
}

/** Brevo key: env (non-empty, not masked) → secrets paste → null. */
export function resolveBrevoKey({ env = process.env } = {}) {
  const fromEnv = String(env?.BREVO_API_KEY ?? '').trim();
  if (fromEnv && !isMaskedSecret(fromEnv)) return fromEnv;
  const stored = readSecretsJson().brevoApiKey.trim();
  if (stored && !isMaskedSecret(stored)) return stored;
  return null;
}

/** Where the Brevo key comes from, without the value. */
export function brevoKeySource({ env = process.env } = {}) {
  const fromEnv = String(env?.BREVO_API_KEY ?? '').trim();
  if (fromEnv && !isMaskedSecret(fromEnv)) return 'env';
  const stored = readSecretsJson().brevoApiKey.trim();
  if (stored && !isMaskedSecret(stored)) return 'secrets';
  return null;
}

/** Safe status for Superadmin and logs: no secret values, only presence. */
export function emailStoreStatus({ env = process.env } = {}) {
  const dir = emailDataDir();
  const exists = (name) => existsSync(join(dir, name));
  const secretExists = (name) => existsSync(join(dir, 'secrets', name));
  return {
    files: Object.fromEntries(Object.entries(EMAIL_FILES).map(([key, name]) => [key, exists(name)])),
    secrets: {
      unsubKey: secretExists(EMAIL_SECRET_NAMES.unsubKey),
      webhookToken: secretExists(EMAIL_SECRET_NAMES.webhookToken),
    },
    brevo: { configured: Boolean(resolveBrevoKey({ env })), source: brevoKeySource({ env }) },
  };
}
