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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';

const MIN_SECRET_LENGTH = 32;

export function readOrCreateDiskSecret(dataDir, name, bytes = 48) {
  if (!dataDir || !name || /[\\/]/.test(name)) throw new Error('readOrCreateDiskSecret: bad dataDir or name');
  const dir = join(dataDir, 'secrets');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= MIN_SECRET_LENGTH) return existing;
  }
  const value = randomBytes(bytes).toString('hex');
  try {
    // wx: two processes booting at once must not overwrite each other's secret.
    writeFileSync(file, `${value}\n`, { flag: existsSync(file) ? 'w' : 'wx', mode: 0o600 });
    return value;
  } catch (error) {
    if (error?.code === 'EEXIST') return readFileSync(file, 'utf8').trim();
    throw error;
  }
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

export function clientIpFromRequest(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req?.socket?.remoteAddress || req?.ip || '').trim();
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
