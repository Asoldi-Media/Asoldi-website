/**
 * Hub token policy kept on the data disk (no env change needed):
 *
 * <dataDir>/security-settings.json
 *   { version, maxTokenAgeDays, revokedBefore: { all, admin, staff, client }, migrations, updatedAt, updatedBy }
 *   revokedBefore.<scope>: tokens of that class issued before this ISO time are refused.
 *   migrations.<name>: when a one-time boot migration ran (see runSecurityBootMigrations).
 *
 * <dataDir>/token-revocations.json
 *   { version, subjects: { "u:<userId>" | "admin:<username>": { tokenVersion, revokedAt, reason } } }
 *   A token carries `tv` (the subject's tokenVersion when it was signed). Bumping the
 *   version logs that user out everywhere.
 *
 * Neither file holds a secret. They are written atomically, without the
 * data/backups snapshots, so a restore of old JSON cannot undo a revocation. Every
 * change is a locked read-modify-write on a fresh read, so a change made by another
 * hub process a moment earlier is never lost.
 */
import { join } from 'path';
import { readJsonCached, readJsonFresh, updateJsonLocked } from './atomic-json.js';
import { getPersistentDataDir } from './storage-path.js';

export const DEFAULT_MAX_TOKEN_AGE_DAYS = 30;
export const REVOKE_SCOPES = ['all', 'admin', 'staff', 'client'];
const MAX_TOKEN_AGE_DAYS_LIMIT = 365;

/**
 * One-time migrations run at hub boot. adminSessionReset2026_10 resets admin and staff sessions
 * once: tokens of those classes issued before the first boot of this code are refused, so admin
 * and staff sign in again once after the deploy, with no owner step.
 */
export const ADMIN_SESSION_RESET_MIGRATION = 'adminSessionReset2026_10';

/**
 * Disk secrets the Security card can rotate. secretRotations.<name> = { at, by } is the latest
 * rotation; secretRotationHistory keeps the last SECRET_ROTATION_HISTORY_LIMIT rotations of
 * either, newest first, as { name, at, by }. Never a value.
 */
export const SECRET_ROTATION_NAMES = Object.freeze(['admin-secret', 'maker-callback-token']);
export const SECRET_ROTATION_HISTORY_LIMIT = 50;
const BOOT_MIGRATIONS = [{ name: ADMIN_SESSION_RESET_MIGRATION, revokeScopes: ['admin', 'staff'] }];

// The data dir is fixed for the life of the process; resolve it once (this runs on every token check).
let defaultDataDir = '';
function dirOf(dataDir) {
  if (dataDir) return dataDir;
  if (!defaultDataDir) defaultDataDir = getPersistentDataDir();
  return defaultDataDir;
}

export function securitySettingsPath(dataDir) {
  return join(dirOf(dataDir), 'security-settings.json');
}

export function tokenRevocationsPath(dataDir) {
  return join(dirOf(dataDir), 'token-revocations.json');
}

function cleanDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return null;
  return Math.min(Math.round(days * 100) / 100, MAX_TOKEN_AGE_DAYS_LIMIT);
}

function cleanIso(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isoAt(now) {
  return new Date(now ?? Date.now()).toISOString();
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const revoked = source.revokedBefore && typeof source.revokedBefore === 'object' ? source.revokedBefore : {};
  const migrationsRaw = source.migrations && typeof source.migrations === 'object' && !Array.isArray(source.migrations)
    ? source.migrations
    : {};
  const migrations = {};
  for (const [name, at] of Object.entries(migrationsRaw)) {
    const iso = cleanIso(at);
    if (iso) migrations[name] = iso;
  }
  const rotationsRaw = source.secretRotations && typeof source.secretRotations === 'object' && !Array.isArray(source.secretRotations)
    ? source.secretRotations
    : {};
  const secretRotations = {};
  for (const name of SECRET_ROTATION_NAMES) {
    const row = rotationsRaw[name];
    const at = cleanIso(row?.at);
    if (at) secretRotations[name] = { at, by: typeof row.by === 'string' ? row.by.slice(0, 80) : null };
  }
  const historyRaw = Array.isArray(source.secretRotationHistory) ? source.secretRotationHistory : [];
  const secretRotationHistory = [];
  for (const row of historyRaw) {
    const at = cleanIso(row?.at);
    if (!at || !SECRET_ROTATION_NAMES.includes(row?.name)) continue;
    secretRotationHistory.push({ name: row.name, at, by: typeof row.by === 'string' ? row.by.slice(0, 80) : null });
    if (secretRotationHistory.length >= SECRET_ROTATION_HISTORY_LIMIT) break;
  }
  return {
    version: 1,
    maxTokenAgeDays: cleanDays(source.maxTokenAgeDays) || DEFAULT_MAX_TOKEN_AGE_DAYS,
    maxTokenAgeDaysStored: cleanDays(source.maxTokenAgeDays),
    revokedBefore: Object.fromEntries(REVOKE_SCOPES.map((scope) => [scope, cleanIso(revoked[scope])])),
    migrations,
    secretRotations,
    secretRotationHistory,
    updatedAt: cleanIso(source.updatedAt),
    updatedBy: typeof source.updatedBy === 'string' ? source.updatedBy : null,
  };
}

export function readSecuritySettings({ dataDir } = {}) {
  return normalizeSettings(readJsonCached(securitySettingsPath(dataDir)));
}

function serializeSettings(next, { by, now }) {
  const { maxTokenAgeDaysStored, maxTokenAgeDays: _effective, ...rest } = next;
  return {
    ...rest,
    maxTokenAgeDays: maxTokenAgeDaysStored ?? null,
    updatedAt: isoAt(now),
    updatedBy: String(by || 'admin').slice(0, 80),
  };
}

/** change(current) returns the next normalized settings, or undefined to keep the file as it is. */
function changeSettings(change, { dataDir, by, now }) {
  updateJsonLocked(
    securitySettingsPath(dataDir),
    (raw) => {
      const next = change(normalizeSettings(raw));
      return next === undefined ? undefined : serializeSettings(next, { by, now });
    },
    { mode: 0o600 }
  );
  return readSecuritySettings({ dataDir });
}

/** maxTokenAgeDays: a number of days (0 < d ≤ 365), or null to go back to the default. */
export function updateSecuritySettings(patch = {}, { dataDir, by, now } = {}) {
  let stored;
  if (Object.prototype.hasOwnProperty.call(patch, 'maxTokenAgeDays')) {
    if (patch.maxTokenAgeDays === null || patch.maxTokenAgeDays === '') {
      stored = null;
    } else {
      stored = cleanDays(patch.maxTokenAgeDays);
      if (!stored) throw new Error('maxTokenAgeDays must be a number of days between 0 and 365.');
    }
  }
  return changeSettings(
    (current) => (stored === undefined ? current : { ...current, maxTokenAgeDaysStored: stored }),
    { dataDir, by, now }
  );
}

/** Records when and by whom a disk secret was rotated (the audit trail on the Security card). */
export function recordSecretRotation(name, { dataDir, by, now } = {}) {
  if (!SECRET_ROTATION_NAMES.includes(name)) throw new Error(`unknown secret ${name}`);
  const at = isoAt(now);
  const who = String(by || 'admin').slice(0, 80);
  return changeSettings(
    (current) => ({
      ...current,
      secretRotations: { ...current.secretRotations, [name]: { at, by: who } },
      secretRotationHistory: [{ name, at, by: who }, ...current.secretRotationHistory].slice(0, SECRET_ROTATION_HISTORY_LIMIT),
    }),
    { dataDir, by: who, now }
  );
}

/** Every token of `scope` issued before now stops working. */
export function revokeTokensBefore(scope, { dataDir, by, now } = {}) {
  if (!REVOKE_SCOPES.includes(scope)) throw new Error(`scope must be one of ${REVOKE_SCOPES.join(', ')}`);
  const at = isoAt(now);
  return changeSettings(
    (current) => ({ ...current, revokedBefore: { ...current.revokedBefore, [scope]: at } }),
    { dataDir, by, now }
  );
}

/**
 * Runs each one-time boot migration that has not run on this data dir yet: exactly once,
 * also when several hub processes boot together. Returns the names that ran now.
 */
export function runSecurityBootMigrations({ dataDir, now } = {}) {
  const ran = [];
  const at = isoAt(now);
  changeSettings(
    (current) => {
      const pending = BOOT_MIGRATIONS.filter((migration) => !current.migrations[migration.name]);
      if (!pending.length) return undefined;
      const revokedBefore = { ...current.revokedBefore };
      const migrations = { ...current.migrations };
      for (const migration of pending) {
        for (const scope of migration.revokeScopes) {
          // Never move an existing cutoff backwards.
          if (!revokedBefore[scope] || Date.parse(revokedBefore[scope]) < Date.parse(at)) revokedBefore[scope] = at;
        }
        migrations[migration.name] = at;
        ran.push(migration.name);
      }
      return { ...current, revokedBefore, migrations };
    },
    { dataDir, by: 'boot-migration', now }
  );
  return ran;
}

/** Revocation subject of the single hub admin (admin.json), the same key token-policy derives. */
export function adminSubject(username) {
  const name = String(username || '').trim().toLowerCase();
  return name ? `admin:${name}` : '';
}

function subjectsOf(raw) {
  return raw?.subjects && typeof raw.subjects === 'object' && !Array.isArray(raw.subjects) ? raw.subjects : {};
}

function versionOf(row) {
  const version = Number(row?.tokenVersion);
  return Number.isInteger(version) && version > 0 ? version : 0;
}

/**
 * fresh: read the file now instead of through the 1-second cache. Signing uses it, so a login
 * served by one hub process right after a "log out everywhere" in another gets the new version.
 */
export function subjectTokenVersion(subject, { dataDir, fresh = false } = {}) {
  if (!subject) return 0;
  const path = tokenRevocationsPath(dataDir);
  return versionOf(subjectsOf(fresh ? readJsonFresh(path) : readJsonCached(path))[subject]);
}

/** Logs the subject out everywhere: tokens signed before this call are refused. Returns the new version. */
export function bumpSubjectTokenVersion(subject, { dataDir, reason = 'logout-everywhere', now } = {}) {
  const key = String(subject || '').trim();
  if (!key) throw new Error('subject required');
  let tokenVersion = 0;
  updateJsonLocked(
    tokenRevocationsPath(dataDir),
    (raw) => {
      const subjects = { ...subjectsOf(raw) };
      tokenVersion = versionOf(subjects[key]) + 1;
      subjects[key] = { tokenVersion, revokedAt: isoAt(now), reason: String(reason || '').slice(0, 80) };
      return { version: 1, subjects };
    },
    { mode: 0o600 }
  );
  return tokenVersion;
}

export function countRevokedSubjects({ dataDir } = {}) {
  return Object.keys(subjectsOf(readJsonCached(tokenRevocationsPath(dataDir)))).length;
}
