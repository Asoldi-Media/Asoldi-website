/**
 * Hub auth hardening that needs no Hostinger env change.
 *
 * - Secrets: when an env secret is unset, a random value is generated once in
 *   <dataDir>/secrets/<name> and reused across deploys (the data dir survives
 *   git deploys). Never fall back to a literal default.
 * - Tokens: signatures compare in constant time, and tokens expire.
 * - Logins: failed attempts are limited per account and client address, per account and per
 *   client address (createLoginLimiter).
 * - Staff media: recordings are served only to signed-in staff.
 */
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { performance } from 'perf_hooks';
import { ensurePrivateDir } from '../data/private-dir.js';
import { withFileLock, writeTextAtomic } from '../data/atomic-json.js';
import { noteSecurityEvent } from './security-counters.js';

const MIN_SECRET_LENGTH = 32;

/** Milliseconds from a clock that never steps backwards (wall-clock changes do not move it). */
export const monotonicMs = () => performance.now();

function readSecretFile(file) {
  try {
    const value = readFileSync(file, 'utf8').trim();
    return value.length >= MIN_SECRET_LENGTH ? value : '';
  } catch {
    return '';
  }
}

/**
 * The file appears with its full content in one step (temp file + hard link), so a
 * second process booting at the same time either sees no file or the finished
 * secret, never a half-written one that it would then replace.
 */
export function readOrCreateDiskSecret(dataDir, name, bytes = 48) {
  if (!dataDir || !name || /[\\/]/.test(name)) throw new Error('readOrCreateDiskSecret: bad dataDir or name');
  const dir = join(dataDir, 'secrets');
  // 0700 on POSIX; on Windows an ACL for this account only, inherited by every secret file.
  ensurePrivateDir(dir);
  const file = join(dir, name);
  const existing = readSecretFile(file);
  if (existing) return existing;
  const value = randomBytes(bytes).toString('hex');
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
  try {
    try {
      linkSync(tmp, file);
      return value;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        // Another process won (its file is complete), or the file is truncated/hand-edited.
        const current = readSecretFile(file);
        if (current) return current;
        renameSync(tmp, file);
        return readSecretFile(file) || value;
      }
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error?.code)) throw error;
    }
    // File systems without hard links: exclusive create still keeps the first writer.
    try {
      writeFileSync(file, `${value}\n`, { flag: existsSync(file) ? 'w' : 'wx', mode: 0o600 });
      return value;
    } catch (inner) {
      if (inner?.code === 'EEXIST') return readSecretFile(file) || value;
      throw inner;
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or already gone */ }
  }
}

/** Values that were public defaults or are too guessable to sign tokens with. */
export const KNOWN_DEFAULT_SECRETS = new Set([
  'change-me',
  'changeme',
  'change-me-in-production',
  'changeme-in-production',
  'secret',
  'admin',
  'password',
  'default',
]);
export const MIN_ENV_SECRET_LENGTH = 16;

/**
 * Env wins when it is set, at least 16 characters and not a known default.
 * Otherwise the secret generated once in <dataDir>/secrets/<name> is used.
 * Returns the source only for status pages; never log `secret`.
 */
export function resolveHubSecret({ envValue, dataDir, name, bytes = 48 } = {}) {
  const fromEnv = String(envValue ?? '').trim();
  let envRejected = '';
  if (fromEnv) {
    if (KNOWN_DEFAULT_SECRETS.has(fromEnv.toLowerCase())) envRejected = 'known-default';
    else if (fromEnv.length < MIN_ENV_SECRET_LENGTH) envRejected = 'too-short';
    else return { secret: fromEnv, source: 'env', envRejected: '' };
  }
  return { secret: readOrCreateDiskSecret(dataDir, name, bytes), source: 'disk', envRejected };
}

function secretFilePath(dataDir, name) {
  if (!dataDir || !name || /[\\/]/.test(name)) throw new Error('disk secret: bad dataDir or name');
  return join(ensurePrivateDir(join(dataDir, 'secrets')), name);
}

/**
 * Replaces <dataDir>/secrets/<name> with a new random value: under the file's lock (the same
 * lock file the JSON stores use), written to a temp file and renamed over the old one, so a
 * reader in any hub process sees the old or the new value, never a partial one. Returns the
 * new value; the caller must never log it.
 */
export function rotateDiskSecret(dataDir, name, bytes = 48) {
  const file = secretFilePath(dataDir, name);
  return withFileLock(file, () => {
    const value = randomBytes(bytes).toString('hex');
    writeTextAtomic(file, `${value}\n`, { mode: 0o600 });
    const stored = readSecretFile(file);
    if (stored !== value) throw Object.assign(new Error(`could not store the new ${name}`), { code: 'EROTATE' });
    return value;
  });
}

export const SECRET_FROM_ENV = 'ESECRET_FROM_ENV';

export const DEFAULT_SECRET_REFRESH_MS = 1000;

/**
 * How often each hub process re-reads a rotatable secret file: HUB_SECRET_REFRESH_MS between
 * 100 ms and one hour, else 1000. Only tests set it (to prove the re-read on a mismatch).
 */
export function secretRefreshMs(env = process.env) {
  const ms = Number(env.HUB_SECRET_REFRESH_MS);
  return Number.isFinite(ms) && ms >= 100 && ms <= 3_600_000 ? Math.round(ms) : DEFAULT_SECRET_REFRESH_MS;
}

/**
 * A hub secret that can be rotated while the hub runs.
 *
 * envRule 'strict' (signing secrets): resolveHubSecret, so env wins unless it is a known default
 * or shorter than 16 characters. envRule 'any' (shared tokens): any non-empty env value wins.
 * When env wins, get() always returns it and rotate() throws code SECRET_FROM_ENV.
 *
 * Otherwise the value lives in <dataDir>/secrets/<name>. rotate() replaces it and this process
 * uses the new value at once; other hub processes re-read the file at most `refreshMs` later
 * (get() checks it at most once per refreshMs), so every process follows a rotation. A missing
 * or damaged file never replaces the value in memory: only a valid secret does.
 * get({ fresh: true }) re-reads the file now (at most once per `freshMs`, so junk tokens cannot
 * turn every request into a disk read). Verifiers call it once when a signature does not match,
 * so a token another process signed with a just-rotated secret is accepted here at once.
 * lazy: the file is created on the first get() instead of now.
 * now: the clock for both intervals; monotonic by default, so a wall-clock step backwards never
 * pauses the re-reads. A clock that does go back (an injected one) counts as a re-read being due.
 */
export function createHubSecretHolder({
  envValue,
  dataDir,
  name,
  bytes = 48,
  envRule = 'strict',
  lazy = false,
  refreshMs = 1000,
  freshMs = 100,
  now = monotonicMs,
} = {}) {
  const file = secretFilePath(dataDir, name);
  const fromEnv = String(envValue ?? '').trim();
  let source = 'disk';
  let envRejected = '';
  let value = '';
  let checkedAt = 0;
  let freshAt = -Infinity;

  if (envRule === 'any') {
    if (fromEnv) {
      source = 'env';
      value = fromEnv;
    }
  } else {
    if (fromEnv && KNOWN_DEFAULT_SECRETS.has(fromEnv.toLowerCase())) envRejected = 'known-default';
    else if (fromEnv && fromEnv.length < MIN_ENV_SECRET_LENGTH) envRejected = 'too-short';
    else if (fromEnv) {
      source = 'env';
      value = fromEnv;
    }
  }

  function load() {
    value = readOrCreateDiskSecret(dataDir, name, bytes);
    checkedAt = now();
  }
  if (source === 'disk' && !lazy) load();

  return {
    get source() {
      return source;
    },
    get envRejected() {
      return envRejected;
    },
    file,
    get({ fresh = false } = {}) {
      if (source === 'env') return value;
      if (!value) {
        load();
        return value;
      }
      const t = now();
      const due = t < checkedAt || t - checkedAt >= refreshMs;
      const forced = fresh && (t < freshAt || t - freshAt >= freshMs);
      if (due || forced) {
        checkedAt = t;
        if (forced) freshAt = t;
        const onDisk = readSecretFile(file);
        if (onDisk && onDisk !== value) value = onDisk;
      }
      return value;
    },
    rotate() {
      if (source === 'env') {
        throw Object.assign(new Error(`${name} comes from the env, so it cannot be rotated here`), { code: SECRET_FROM_ENV });
      }
      value = rotateDiskSecret(dataDir, name, bytes);
      checkedAt = now();
      return value;
    },
  };
}

/**
 * Runs check(secret) with the holder's current value. When it fails, the holder re-reads its file
 * once (get({ fresh: true })) and, only if the value changed, check runs again with the new one.
 * Every verifier of a rotatable secret uses this, so a token or callback signed with a secret
 * another hub process has just rotated is accepted here at once instead of up to a second later.
 */
export function checkWithFreshSecret(holder, check) {
  const current = holder.get();
  if (check(current)) return true;
  const fresher = holder.get({ fresh: true });
  return fresher !== current && check(fresher);
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const DEFAULT_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function tokenMaxAgeMs(env = process.env) {
  const days = Number(env.AUTH_TOKEN_MAX_AGE_DAYS);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : DEFAULT_TOKEN_MAX_AGE_MS;
}

/** Every token the hub signs carries `at` (issued, ms). Tokens without it are refused. */
export function isTokenFresh(payload, { now = Date.now(), maxAgeMs = tokenMaxAgeMs() } = {}) {
  const issued = Number(payload?.at);
  if (!Number.isFinite(issued) || issued <= 0) return false;
  if (issued > now + CLOCK_SKEW_MS) return false;
  return now - issued <= maxAgeMs;
}

/** Loopback, private, link-local and shared (CGNAT) addresses: proxies inside the hosting network. */
export function isInternalAddress(ip) {
  const value = String(ip || '').trim().toLowerCase().replace(/^::ffff:/, '');
  if (!value || value === '::1' || value === 'localhost' || value === 'unknown') return true;
  if (/^(?:10|127)\.|^192\.168\.|^169\.254\./.test(value)) return true;
  const second = Number((value.match(/^172\.(\d+)\./) || [])[1]);
  if (second >= 16 && second <= 31) return true;
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value)) return true;
  return /^f[cd][0-9a-f]{2}:|^fe80:/.test(value);
}

/** Most public proxies (a CDN in front of the hosting proxy, say) that can be set as trusted. */
export const MAX_TRUSTED_HOPS = 5;

/** A trusted-hop count: a whole number from 1 to MAX_TRUSTED_HOPS, else null (the default, 1). */
export function cleanTrustedHops(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(text)) return null;
  const hops = Number(text);
  return hops >= 1 && hops <= MAX_TRUSTED_HOPS ? hops : null;
}

/**
 * The client address for the login limits, and where it came from. Every proxy appends the
 * address it saw to X-Forwarded-For, so the left entries are whatever the client sent; the
 * entries the proxies wrote are on the right.
 *   mode 'forwarded'           the trustedHops-th entry from the right that is not an internal
 *                              proxy address (default 1: the right-most such entry, the one the
 *                              hosting proxy saw). With fewer such entries, the left-most of them.
 *   mode 'forwarded-internal'  the header holds only internal addresses: the last one
 *   mode 'socket'              no header (local dev, direct connection): the socket address
 * hopFromRight is the position of the entry used (1 = last), peer whether the connection itself
 * came from an internal address (a proxy on the hosting network) or a public one.
 */
export function readClientAddress(req, { trustedHops = null } = {}) {
  const socket = String(req?.socket?.remoteAddress || req?.ip || '').trim();
  const peer = isInternalAddress(socket) ? 'internal' : 'public';
  const entries = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) return { address: socket, mode: 'socket', hopFromRight: 0, peer };
  const wanted = cleanTrustedHops(trustedHops) || 1;
  let seen = 0;
  let leftmost = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isInternalAddress(entries[i])) continue;
    seen += 1;
    leftmost = i;
    if (seen === wanted) break;
  }
  if (leftmost >= 0) return { address: entries[leftmost], mode: 'forwarded', hopFromRight: entries.length - leftmost, peer };
  return { address: entries[entries.length - 1], mode: 'forwarded-internal', hopFromRight: 1, peer };
}

/** The client address for the login limits (readClientAddress). */
export function clientIpFromRequest(req, options) {
  return readClientAddress(req, options).address;
}

const MAX_ADDRESS_LENGTH = 64;
const MAX_ACCOUNT_LENGTH = 1024;

function normalizeAddress(value) {
  let address = String(value || '').trim();
  if (address.toLowerCase().startsWith('::ffff:')) address = address.slice(7);
  return address.slice(0, MAX_ADDRESS_LENGTH);
}

const shortHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32);
const accountName = (account) => String(account || '').slice(0, MAX_ACCOUNT_LENGTH).trim().toLowerCase();

/**
 * Failed sign-ins in a sliding window (15 minutes by default), counted under three keys:
 *   p:  one account from one client address    maxPerPair     (10)
 *   a:  one account from every address          maxPerAccount  (100)
 *   i:  one client address, every account       maxPerIp       (50)
 * check() refuses while any of the three is full. So a right password from an address that is not
 * blocked by its own p: or i: key gets in while the account's a: key is under its limit: failures
 * from other addresses cannot lock an account out until they reach that much higher limit.
 * succeed() clears only the p: key of that account and address; a: and i: keep counting.
 *
 * Memory stays bounded: accounts are kept as short hashes, addresses are cut at 64 characters,
 * every key keeps at most its limit of times, and the table holds at most `maxKeys` keys. When it
 * is full, keys of accounts that do not exist (`isKnownAccount` false) go first, then address keys,
 * oldest first. Keys of real accounts are never dropped while inside the window, so a flood of
 * made-up names cannot reset the count of a real account.
 *
 * addressOf(req) reads the client address of a sign-in (readClientAddress with `trustedHops()`),
 * logs once per process for each kind of source which X-Forwarded-For position it used (never an
 * address), and keeps last-hour figures for addressStats(): how many different addresses and
 * attempts were seen, by source. If every client shows up as one address, the proxy in front
 * of the hub is not the one the address rule expects.
 */
export function createLoginLimiter({
  windowMs = 15 * 60 * 1000,
  maxPerPair = 10,
  maxPerAccount = 100,
  maxPerIp = 50,
  maxKeys = 10_000,
  sweepEveryMs = 60 * 1000,
  now = () => Date.now(),
  isKnownAccount = () => false,
  trustedHops = () => null,
  log = (line) => console.log(line),
} = {}) {
  /** key → ascending failure times, at most the limit of that kind of key; newest keys last. */
  const failures = new Map();
  /** p: and a: keys of accounts that exist: never dropped for room while inside the window. */
  const kept = new Set();
  let lastSweep = now();

  const pairKey = (account, ip) => `p:${shortHash(`${accountName(account)}\n${normalizeAddress(ip)}`)}`;
  const accountKey = (account) => `a:${shortHash(accountName(account))}`;
  const ipKey = (ip) => `i:${normalizeAddress(ip)}`;
  const limitOf = (key) => (key[0] === 'p' ? maxPerPair : key[0] === 'a' ? maxPerAccount : maxPerIp);

  function forget(key) {
    failures.delete(key);
    kept.delete(key);
  }

  function knownAccount(account) {
    if (!account) return false;
    try {
      return Boolean(isKnownAccount(account));
    } catch {
      return false;
    }
  }

  function recent(key) {
    const list = failures.get(key);
    if (!list) return [];
    const t = now();
    while (list.length && t - list[0] >= windowMs) list.shift();
    if (!list.length) forget(key);
    return list;
  }

  /** Drops expired keys, at most once per sweepEveryMs, so a failure never scans the table. */
  function sweep() {
    const t = now();
    if (t >= lastSweep && t - lastSweep < sweepEveryMs) return;
    lastSweep = t;
    for (const [key, list] of failures) {
      if (!list.length || t - list[list.length - 1] >= windowMs) forget(key);
    }
  }

  function record(key, t, keep) {
    const list = recent(key);
    list.push(t);
    const limit = limitOf(key);
    if (list.length > limit) list.splice(0, list.length - limit);
    failures.delete(key);
    failures.set(key, list);
    if (keep && key[0] !== 'i') kept.add(key);
  }

  /** Makes room: keys of unknown accounts first, then addresses, then real accounts whose window has passed. */
  function capKeys() {
    if (failures.size <= maxKeys) return;
    const passes = [(key) => key[0] !== 'i' && !kept.has(key), (key) => key[0] === 'i'];
    for (const evictable of passes) {
      for (const key of failures.keys()) {
        if (failures.size <= maxKeys) return;
        if (evictable(key)) forget(key);
      }
    }
    for (const key of [...failures.keys()]) {
      if (failures.size <= maxKeys) return;
      recent(key);
    }
  }

  function blocked(key) {
    const list = recent(key);
    if (list.length < limitOf(key)) return null;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000)) };
  }

  function keysFor(account, ip) {
    const keys = [];
    if (account) keys.push(pairKey(account, ip), accountKey(account));
    if (normalizeAddress(ip)) keys.push(ipKey(ip));
    return keys;
  }

  // Address sources, for the Security card. Addresses are kept only as short hashes, for an hour.
  const HOUR_MS = 60 * 60 * 1000;
  const MINUTE_MS = 60 * 1000;
  /** short hash of an address → last time it was seen; oldest first. */
  const seenAddresses = new Map();
  /** minute number → { [mode]: attempts }. */
  const minutes = new Map();
  const loggedSources = new Set();
  let latest = null;

  function configuredHops() {
    try {
      return cleanTrustedHops(trustedHops());
    } catch {
      return null;
    }
  }

  function pruneSeen(t) {
    for (const [hash, at] of seenAddresses) {
      if (t >= at && t - at < HOUR_MS) break;
      seenAddresses.delete(hash);
    }
    const oldest = Math.floor((t - HOUR_MS) / MINUTE_MS);
    for (const minute of minutes.keys()) if (minute <= oldest) minutes.delete(minute);
  }

  function describeSource({ mode, hopFromRight, peer }, hops) {
    const from = peer === 'internal' ? 'an internal' : 'a public';
    if (mode === 'socket') return `the connecting address (no X-Forwarded-For header; the connection comes from ${from} address)`;
    if (mode === 'forwarded-internal') {
      return 'the last X-Forwarded-For entry, an internal address (the header has no public entry), so every client behind that proxy shares one count';
    }
    return `X-Forwarded-For entry ${hopFromRight} from the right (public entry ${hops || 1} from the right; the connection comes from ${from} address)`;
  }

  function noteSource(read, hops) {
    const t = now();
    const hash = createHash('sha256').update(normalizeAddress(read.address)).digest('hex').slice(0, 16);
    seenAddresses.delete(hash);
    seenAddresses.set(hash, t);
    while (seenAddresses.size > maxKeys) seenAddresses.delete(seenAddresses.keys().next().value);
    const minute = Math.floor(t / MINUTE_MS);
    const row = minutes.get(minute) || {};
    row[read.mode] = (row[read.mode] || 0) + 1;
    minutes.set(minute, row);
    pruneSeen(t);
    latest = { mode: read.mode, hopFromRight: read.hopFromRight, peer: read.peer };
    const shape = `${read.mode}|${read.hopFromRight}|${hops || 1}|${read.peer}`;
    if (!loggedSources.has(shape) && loggedSources.size < 8) {
      loggedSources.add(shape);
      try {
        log(`[security] login limits count each client by ${describeSource(read, hops)}. Logged once per kind of source.`);
      } catch {
        // Logging is best effort.
      }
    }
  }

  return {
    check(account, ip) {
      for (const key of keysFor(account, ip)) {
        const verdict = blocked(key);
        if (verdict) return verdict;
      }
      return { ok: true };
    },
    fail(account, ip) {
      sweep();
      const t = now();
      const keep = knownAccount(account);
      for (const key of keysFor(account, ip)) record(key, t, keep);
      capKeys();
    },
    /** Clears the account's count for this address; the per-account and per-address counts keep running. */
    succeed(account, ip) {
      if (account) forget(pairKey(account, ip));
    },
    /** The client address the login routes count for this request (noted for addressStats). */
    addressOf(req) {
      const hops = configuredHops();
      const read = readClientAddress(req, { trustedHops: hops });
      noteSource(read, hops);
      return read.address;
    },
    /**
     * Last-hour figures, never an address: mode is the most common source of the hour ('none'
     * without sign-ins), modesLastHour the attempts per source, hopFromRight and peer those of the
     * latest attempt, trustedHops the setting (null = the default, 1).
     */
    addressStats() {
      const t = now();
      pruneSeen(t);
      const modesLastHour = {};
      for (const row of minutes.values()) {
        for (const [mode, count] of Object.entries(row)) modesLastHour[mode] = (modesLastHour[mode] || 0) + count;
      }
      const ranked = Object.entries(modesLastHour).sort((a, b) => b[1] - a[1]);
      return {
        mode: ranked.length ? ranked[0][0] : 'none',
        modesLastHour,
        attemptsLastHour: ranked.reduce((sum, [, count]) => sum + count, 0),
        distinctLastHour: seenAddresses.size,
        hopFromRight: latest ? latest.hopFromRight : null,
        peer: latest ? latest.peer : null,
        trustedHops: configuredHops(),
      };
    },
    /** Keys now held (tests and diagnostics). */
    keys() {
      return [...failures.keys()];
    },
  };
}

const THROTTLED_MESSAGE = 'For mange innloggingsforsøk. Prøv igjen om litt.';

/**
 * Express guard for one login attempt, called before the password check. When a limit is full it
 * answers 429 with Retry-After and returns null. Otherwise it returns the attempt, bound to the
 * account and to the client address read once from this request:
 *   attempt.fail()     wrong password: counts toward the limits
 *   attempt.succeed()  right password: clears the account's count for this address
 * Only the first settle counts.
 */
export function beginLogin(limiter, req, res, account) {
  const ip = typeof limiter.addressOf === 'function' ? limiter.addressOf(req) : clientIpFromRequest(req);
  const verdict = limiter.check(account, ip);
  if (!verdict.ok) {
    noteSecurityEvent('login-throttled');
    res.setHeader('Retry-After', String(verdict.retryAfterSec));
    res.status(429).json({ message: THROTTLED_MESSAGE });
    return null;
  }
  let settled = false;
  return {
    fail() {
      if (settled) return;
      settled = true;
      limiter.fail(account, ip);
    },
    succeed() {
      if (settled) return;
      settled = true;
      limiter.succeed(account, ip);
    },
  };
}

/** beginLogin for a caller that settles with limiter.fail / succeed itself: true when the request may go on. */
export function guardLogin(limiter, req, res, account) {
  return beginLogin(limiter, req, res, account) !== null;
}

/**
 * Re-checks a signed-in user's password before a sensitive action (secret rotation).
 * Wrong passwords count toward the login limits for that account (429 above them); the right one
 * clears the account's count for this address, the same as a successful sign-in. When the
 * returned promise resolves to false, the response has already been sent.
 *   limiter          createLoginLimiter() (shared with the sign-in route)
 *   accountFor(req)  the limiter account, e.g. 'admin:<username>'
 *   verifyPassword(req, password) → Promise<boolean>
 */
export function createPasswordConfirmer({ limiter, accountFor, verifyPassword }) {
  if (!limiter || typeof accountFor !== 'function' || typeof verifyPassword !== 'function') {
    throw new Error('createPasswordConfirmer: limiter, accountFor and verifyPassword are required');
  }
  return async function confirmPassword(req, res, password) {
    const attempt = beginLogin(limiter, req, res, accountFor(req));
    if (!attempt) return false;
    const valid = typeof password === 'string' && password.length > 0 && (await verifyPassword(req, password));
    if (!valid) {
      attempt.fail();
      res.status(401).json({ code: 'wrong-password', message: 'Feil passord.' });
      return false;
    }
    attempt.succeed();
    return true;
  };
}

const STAFF_ROLES = new Set(['admin', 'sales', 'developer', 'employee']);

export function createStaffMediaGate(verifyToken) {
  return function staffMediaGate(req, res, next) {
    const auth = String(req.headers?.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const payload = token ? verifyToken(token) : null;
    if (!payload || !STAFF_ROLES.has(String(payload.role || '').toLowerCase())) {
      return res.status(401).type('text/plain').send('Unauthorized');
    }
    return next();
  };
}
