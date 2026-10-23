/**
 * The hub's login limiter (lib/auth-hardening.js createLoginLimiter) with the hub's own wiring:
 * which limiter accounts are real, so a full table never drops their counts first.
 *
 * Limiter accounts are 'admin:<username>' (the hub admin in admin.json), 'staff:<username>' and
 * 'client:<email>' (users in users.json). Each file is stat-checked at most once a second and
 * parsed again only when its modification time changes, so a burst of failed sign-ins costs no
 * extra file reads.
 *
 * This module takes the data dir as an argument (server.js passes getPersistentDataDir()), so
 * importing it never fixes the data dir of a test process.
 */
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createLoginLimiter, monotonicMs } from './auth-hardening.js';

function cachedNames(path, extract, { ttlMs, now }) {
  let checkedAt = -Infinity;
  let mtimeMs = Number.NaN;
  let names = new Set();
  return function current() {
    const t = now();
    if (t >= checkedAt && t - checkedAt < ttlMs) return names;
    checkedAt = t;
    let stat = null;
    try {
      stat = path ? statSync(path, { throwIfNoEntry: false }) || null : null;
    } catch {
      stat = null;
    }
    const nextMtime = stat ? stat.mtimeMs : -1;
    if (nextMtime === mtimeMs) return names;
    mtimeMs = nextMtime;
    const next = new Set();
    if (stat) {
      try {
        for (const name of extract(JSON.parse(readFileSync(path, 'utf8')))) {
          const clean = String(name ?? '').trim().toLowerCase();
          if (clean) next.add(clean);
        }
      } catch {
        // An unreadable file names nobody; the limiter then treats those accounts as unknown.
      }
    }
    names = next;
    return names;
  };
}

/**
 * isKnownAccount(account) for createLoginLimiter: true when the account names the hub admin
 * ('admin:<username>') or a users.json user ('staff:<username>', 'client:<email>').
 */
export function createKnownAccountCheck({
  dataDir = '',
  adminPath = dataDir ? join(dataDir, 'admin.json') : '',
  usersPath = dataDir ? join(dataDir, 'users.json') : '',
  ttlMs = 1000,
  now = monotonicMs,
} = {}) {
  const admins = cachedNames(adminPath, (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? [raw.username] : []), { ttlMs, now });
  const users = cachedNames(usersPath, (raw) => (Array.isArray(raw) ? raw.map((user) => user?.username) : []), { ttlMs, now });
  return function isKnownAccount(account) {
    const text = String(account ?? '').trim().toLowerCase();
    const colon = text.indexOf(':');
    if (colon <= 0) return false;
    const kind = text.slice(0, colon);
    const name = text.slice(colon + 1).trim();
    if (!name) return false;
    if (kind === 'admin') return admins().has(name);
    if (kind === 'staff' || kind === 'client') return users().has(name);
    return false;
  };
}

/** The limiter the hub's sign-in routes and the rotation password check share (one per process). */
export function createHubLoginLimiter({ dataDir, ...options } = {}) {
  return createLoginLimiter({ isKnownAccount: createKnownAccountCheck({ dataDir }), ...options });
}
