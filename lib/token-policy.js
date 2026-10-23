/**
 * Which signed hub tokens are still accepted, beyond the signature:
 * - age: AUTH_TOKEN_MAX_AGE_DAYS (env, optional) > security-settings.json maxTokenAgeDays > 30 days;
 * - revokedBefore per class (all, admin, staff, client) from security-settings.json;
 * - per-user tokenVersion ("log out everywhere"): tokens carry `tv`, and a token whose
 *   `tv` is below the user's current version is refused.
 *
 * Tokens signed before tokenVersion existed have no `tv`; they count as version 0 and keep
 * working until the user is revoked once.
 */
import { DEFAULT_TOKEN_MAX_AGE_MS, isTokenFresh } from './auth-hardening.js';
import {
  adminSubject,
  bumpSubjectTokenVersion,
  readSecuritySettings,
  runSecurityBootMigrations,
  subjectTokenVersion,
} from '../data/security-settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function tokenRoleClass(payload) {
  const role = String(payload?.role || '').trim().toLowerCase();
  if (role === 'admin') return 'admin';
  if (role === 'client') return 'client';
  return 'staff';
}

/** "u:<userId>" for users, "admin:<username>" for the single hub admin, '' when unknown. */
export function tokenSubject(payload) {
  const userId = String(payload?.userId ?? '').trim();
  if (userId) return `u:${userId}`;
  const role = String(payload?.role || '').trim().toLowerCase();
  if (role === 'admin') return adminSubject(payload?.username);
  return '';
}

export function effectiveTokenMaxAge({ env = process.env, dataDir } = {}) {
  const envDays = Number(env.AUTH_TOKEN_MAX_AGE_DAYS);
  if (Number.isFinite(envDays) && envDays > 0) return { maxAgeMs: envDays * DAY_MS, source: 'env' };
  const settings = readSecuritySettings({ dataDir });
  if (settings.maxTokenAgeDaysStored) return { maxAgeMs: settings.maxTokenAgeDaysStored * DAY_MS, source: 'data' };
  return { maxAgeMs: DEFAULT_TOKEN_MAX_AGE_MS, source: 'default' };
}

/**
 * Adds `tv` when the subject has been revoked before; payloads of never-revoked users stay
 * unchanged. Reads the revocations fresh (signing is rare), so a token signed right after a
 * revocation in another hub process is not refused a second later.
 */
export function stampTokenVersion(payload, { dataDir } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const version = subjectTokenVersion(tokenSubject(payload), { dataDir, fresh: true });
  if (version > 0) return { ...payload, tv: version };
  if (Object.prototype.hasOwnProperty.call(payload, 'tv')) {
    const { tv: _ignored, ...rest } = payload;
    return rest;
  }
  return payload;
}

export function tokenRevocationReason(payload, { dataDir } = {}) {
  const issued = Number(payload?.at);
  const settings = readSecuritySettings({ dataDir });
  for (const scope of ['all', tokenRoleClass(payload)]) {
    const cutoff = Date.parse(settings.revokedBefore[scope] || '');
    if (Number.isFinite(cutoff) && !(issued >= cutoff)) return `revoked-${scope}`;
  }
  const version = subjectTokenVersion(tokenSubject(payload), { dataDir });
  if (version > 0) {
    const tv = Number(payload?.tv);
    if (!(Number.isInteger(tv) && tv >= version)) return 'revoked-user';
  }
  return '';
}

export function isTokenRevoked(payload, options = {}) {
  return Boolean(tokenRevocationReason(payload, options));
}

/** Freshness and revocation; the caller has already checked the signature. */
export function isTokenAccepted(payload, { now = Date.now(), env = process.env, dataDir } = {}) {
  const { maxAgeMs } = effectiveTokenMaxAge({ env, dataDir });
  if (!isTokenFresh(payload, { now, maxAgeMs })) return false;
  return !isTokenRevoked(payload, { dataDir });
}

/** Log a user (or the admin) out on every device. Returns the new token version. */
export function logoutSubjectEverywhere(payloadOrSubject, { dataDir, reason = 'logout-everywhere', now } = {}) {
  const subject = typeof payloadOrSubject === 'string' ? payloadOrSubject : tokenSubject(payloadOrSubject);
  if (!subject) throw new Error('Token has no user to log out.');
  return bumpSubjectTokenVersion(subject, { dataDir, reason, now });
}

/**
 * Called once at hub boot. Runs the one-time revocations in data/security-settings.js (today:
 * a reset of admin and staff sessions issued before this code first booted). Never throws: a
 * read-only data dir must not stop the hub.
 */
export function runTokenPolicyBootMigrations({ dataDir, now, log = console } = {}) {
  try {
    const ran = runSecurityBootMigrations({ dataDir, now });
    for (const name of ran) {
      log.log(`[security] one-time migration ${name}: admin and staff tokens issued before now are refused; sign in again.`);
    }
    return ran;
  } catch (error) {
    log.warn(`[security] boot migration failed: ${error?.code || error?.message || error}`);
    return [];
  }
}

export function tokenPolicyStatus({ env = process.env, dataDir } = {}) {
  const settings = readSecuritySettings({ dataDir });
  const { maxAgeMs, source } = effectiveTokenMaxAge({ env, dataDir });
  return {
    maxTokenAgeDays: Math.round((maxAgeMs / DAY_MS) * 100) / 100,
    maxTokenAgeSource: source,
    revokedBefore: settings.revokedBefore,
    updatedAt: settings.updatedAt,
  };
}
