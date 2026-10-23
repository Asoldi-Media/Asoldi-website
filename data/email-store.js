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
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE']);
const OWNER_ROUTING_MODES = new Set(['', 'owner', 'owner+asoldi-bcc']);

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, Math.max(1, Math.floor(ms)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Windows reports EPERM/EBUSY while another process has the file open; retry briefly. */
function retrySync(fn, attempts = 80) {
  for (let i = 0; ; i += 1) {
    try {
      return fn();
    } catch (error) {
      if (!TRANSIENT_FS_CODES.has(error?.code) || i >= attempts) throw error;
      sleepSync(Math.min(40, 2 + i));
    }
  }
}

function unlinkQuiet(path) {
  try {
    retrySync(() => unlinkSync(path), 20);
    return true;
  } catch {
    return false;
  }
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
  if (cause) error.cause = cause;
  return error;
}

function readJsonAbs(path, fallback, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!existsSync(path)) return clone(fallback);
    try {
      const text = retrySync(() => readFileSync(path, 'utf8'));
      return JSON.parse(text);
    } catch (error) {
      if (error?.code === 'ENOENT') return clone(fallback);
      lastError = error;
      // A writer may be between truncate and write (writeDataJson writes in place); ~70 ms in total.
      if (attempt < 5) sleepSync(2 + attempt * 4);
    }
  }
  throw unreadableError(label || path, lastError);
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
    retrySync(() => renameSync(tmp, path));
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

/** Low-churn files: writeDataJson keeps a backup snapshot under <dataDir>/backups. */
function writeBackedUpJson(name, value) {
  const path = emailDataPath(name);
  retrySync(() => writeDataJson(path, value));
}

/**
 * Read a backed-up file. If the live file is missing or corrupt but the latest
 * backup is readable, the backup is restored. Both bad → throws (callers fail closed).
 */
export function readBackedUpJson(name, fallback = null) {
  let live;
  let liveError = null;
  const path = emailDataPath(name);
  try {
    live = readJsonAbs(path, undefined, name);
  } catch (error) {
    liveError = error;
  }
  if (live !== undefined && live !== null) return live;
  const backupPath = join(getDataBackupDir(), `${name.split('/').pop()}.latest.json`);
  if (existsSync(backupPath)) {
    let restored;
    try {
      restored = readJsonAbs(backupPath, undefined, `${name} backup`);
    } catch (error) {
      if (liveError) throw unreadableError(name, error);
    }
    if (restored !== undefined && restored !== null) {
      try {
        writeAtomicAbs(path, restored);
      } catch {
        // Reading from the backup still works; the next write repairs the live file.
      }
      return restored;
    }
  }
  if (liveError) throw liveError;
  return clone(fallback);
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
      if (error?.code !== 'EEXIST' && !TRANSIENT_FS_CODES.has(error?.code)) throw error;
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
  // Only remove our own lock; a stale-reaped lock may now belong to someone else.
  if (info && (info.nonce === handle.nonce || !info.nonce)) unlinkQuiet(handle.path);
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

/** The highest fencing token issued for a lease name (0 when none). */
export function currentFence(name) {
  try {
    const value = Number.parseInt(readFileSync(fencePath(name), 'utf8').trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function bumpFence(name) {
  const next = currentFence(name) + 1;
  writeAtomicAbs(fencePath(name), String(next));
  return next;
}

function readLease(name) {
  try {
    const lease = JSON.parse(readFileSync(leasePath(name), 'utf8'));
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
      /** True while this lease is the newest one and has not expired. */
      isCurrent() {
        const onDisk = readLease(name);
        return held && Boolean(onDisk && onDisk.nonce === nonce && Number(onDisk.expiresAt) > now()) && currentFence(name) === token;
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

/**
 * The legal opt-out record, keyed per site id, plus "*" (global) and "asoldi"
 * (Asoldi's own marketing). Throws EMAIL_STORE_UNREADABLE when neither the file
 * nor its backup can be read, so callers fail closed.
 */
export function readEmailSuppressions() {
  const stored = readBackedUpJson(EMAIL_FILES.suppressions, {});
  if (!isPlainObject(stored)) throw unreadableError(EMAIL_FILES.suppressions);
  return stored;
}

/** Read-modify-write under the cross-process lock. mutate(rows) edits rows in place. */
export async function updateEmailSuppressions(mutate) {
  return withFileLock(EMAIL_FILES.suppressions, async () => {
    const rows = readEmailSuppressions();
    const result = await mutate(rows);
    writeBackedUpJson(EMAIL_FILES.suppressions, rows);
    return result;
  });
}

/* ------------------------------------------------------------------ secrets */

function secretsJsonPath() {
  return join(emailDataDir(), 'secrets', EMAIL_SECRET_NAMES.json);
}

function readSecretsJson() {
  try {
    const raw = JSON.parse(readFileSync(secretsJsonPath(), 'utf8'));
    return {
      brevoApiKey: typeof raw?.brevoApiKey === 'string' ? raw.brevoApiKey : '',
      siteKeys: isPlainObject(raw?.siteKeys) ? raw.siteKeys : {},
    };
  } catch {
    return { brevoApiKey: '', siteKeys: {} };
  }
}

/**
 * Email secrets. unsubKey (32 bytes) and webhookToken (24 bytes) are created
 * on first use in the disk secret store and reused afterwards. Never return
 * this object from an API or log it.
 */
export function readEmailSecrets() {
  const dir = emailDataDir();
  const unsubKey = readOrCreateDiskSecret(dir, EMAIL_SECRET_NAMES.unsubKey, 32);
  const webhookToken = readOrCreateDiskSecret(dir, EMAIL_SECRET_NAMES.webhookToken, 24);
  const extra = readSecretsJson();
  return { unsubKey, webhookToken, brevoApiKey: extra.brevoApiKey, siteKeys: extra.siteKeys };
}

/** Superadmin Brevo key paste (fallback when env has none) and per-site emailKeys (WS7.34). */
export async function patchEmailSecrets(patch = {}) {
  return withFileLock('email-secrets', () => {
    const current = readSecretsJson();
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
