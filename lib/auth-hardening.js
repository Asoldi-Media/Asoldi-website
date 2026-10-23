/**
 * Hub auth hardening that needs no Hostinger env change.
 *
 * - Secrets: when an env secret is unset, a random value is generated once in
 *   <dataDir>/secrets/<name> and reused across deploys (the data dir survives
 *   git deploys). Never fall back to a literal default.
 * - Tokens: signatures compare in constant time, and tokens expire.
 * - Logins: failed attempts are limited per account and per client IP.
 * - Staff media: recordings are served only to signed-in staff.
 */
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { ensurePrivateDir } from '../data/private-dir.js';
import { noteSecurityEvent } from './security-counters.js';

const MIN_SECRET_LENGTH = 32;

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

/**
 * The client address for the per-IP login limit. Every proxy appends the address it saw to
 * X-Forwarded-For, so the left entries are whatever the client sent and can be forged. The
 * right-most entry that is not an internal proxy address is the one the hosting proxy saw.
 * Without the header (local dev, direct connection) the socket address is used.
 */
export function clientIpFromRequest(req) {
  const entries = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (!isInternalAddress(entries[i])) return entries[i];
  }
  return entries[entries.length - 1] || String(req?.socket?.remoteAddress || req?.ip || '').trim();
}

export function createLoginLimiter({
  windowMs = 15 * 60 * 1000,
  maxPerAccount = 10,
  maxPerIp = 50,
  now = () => Date.now(),
} = {}) {
  const failures = new Map();

  function recent(key) {
    const t = now();
    const list = (failures.get(key) || []).filter((ts) => t - ts < windowMs);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  }

  function sweep() {
    if (failures.size < 5000) return;
    for (const key of [...failures.keys()]) recent(key);
  }

  const accountKey = (account) => `a:${String(account || '').trim().toLowerCase()}`;
  const ipKey = (ip) => `i:${String(ip || '').trim()}`;

  function retryAfterSec(list) {
    const oldest = Math.min(...list);
    return Math.max(1, Math.ceil((oldest + windowMs - now()) / 1000));
  }

  return {
    check(account, ip) {
      if (account) {
        const list = recent(accountKey(account));
        if (list.length >= maxPerAccount) return { ok: false, retryAfterSec: retryAfterSec(list) };
      }
      if (ip) {
        const list = recent(ipKey(ip));
        if (list.length >= maxPerIp) return { ok: false, retryAfterSec: retryAfterSec(list) };
      }
      return { ok: true };
    },
    fail(account, ip) {
      sweep();
      const t = now();
      for (const key of [account ? accountKey(account) : '', ip ? ipKey(ip) : ''].filter(Boolean)) {
        failures.set(key, [...recent(key), t]);
      }
    },
    succeed(account) {
      if (account) failures.delete(accountKey(account));
    },
  };
}

/** Express guard for a login route body field. Returns true when the request may proceed. */
export function guardLogin(limiter, req, res, account) {
  const verdict = limiter.check(account, clientIpFromRequest(req));
  if (verdict.ok) return true;
  noteSecurityEvent('login-throttled');
  res.setHeader('Retry-After', String(verdict.retryAfterSec));
  res.status(429).json({ message: 'For mange innloggingsforsøk. Prøv igjen om litt.' });
  return false;
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
