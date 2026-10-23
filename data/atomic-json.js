/**
 * Small JSON files on the data disk that are read on hot paths (token checks,
 * webhook auth): an mtime-checked cache, atomic replace on write, an exclusive
 * create so two booting processes cannot write two different values, and a
 * locked read-modify-write so concurrent writers in other processes are not lost.
 */
import { randomBytes } from 'crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { dirname } from 'path';

const cache = new Map();

// Synchronous short sleep for lock and rename retries (these paths are synchronous by design).
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function pause(ms) {
  Atomics.wait(sleeper, 0, 0, ms);
}

function parse(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Another process's write shows up here within this long; writes from this process at once.
const STAT_TTL_MS = 1000;

/** Parsed object, or null when the file is missing or not a JSON object. */
export function readJsonCached(path) {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && now - hit.checkedAt < STAT_TTL_MS) return hit.value;
  let mtimeMs = -1;
  try {
    // Called on every token check: a missing file must not cost an exception.
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat) mtimeMs = stat.mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (mtimeMs < 0) {
    cache.set(path, { mtimeMs, value: null, checkedAt: now });
    return null;
  }
  if (hit && hit.mtimeMs === mtimeMs) {
    hit.checkedAt = now;
    return hit.value;
  }
  const value = parse(path);
  cache.set(path, { mtimeMs, value, checkedAt: now });
  return value;
}

function remember(path, value) {
  try {
    cache.set(path, { mtimeMs: statSync(path).mtimeMs, value, checkedAt: Date.now() });
  } catch {
    cache.delete(path);
  }
  return value;
}

function tmpPathFor(path) {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Windows refuses a rename onto a file that another process is replacing or holds open
 * without delete sharing (EPERM/EACCES/EBUSY) for a few milliseconds; retry for up to ~1 s.
 */
function renameWithRetry(from, to) {
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (!RENAME_RETRY_CODES.has(error?.code) || Date.now() - started > 1000) throw error;
      pause(Math.min(5 * (attempt + 1), 50));
    }
  }
}

export function writeJsonAtomic(path, value, { mode = 0o600, dirMode = 0o700 } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: dirMode });
  const tmp = tmpPathFor(path);
  writeFileSync(tmp, serialize(value), { mode });
  try {
    renameWithRetry(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  return remember(path, value);
}

/** Writes `value` only when the file does not exist; returns whatever the file holds afterwards. */
export function createJsonOnce(path, value, { mode = 0o600, dirMode = 0o700 } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: dirMode });
  const tmp = tmpPathFor(path);
  writeFileSync(tmp, serialize(value), { mode });
  try {
    linkSync(tmp, path);
    return remember(path, value);
  } catch (error) {
    if (error?.code === 'EEXIST') return remember(path, parse(path));
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error?.code)) throw error;
    // File systems without hard links: exclusive create still keeps the first writer.
    try {
      writeFileSync(path, serialize(value), { flag: 'wx', mode });
      return remember(path, value);
    } catch (inner) {
      if (inner?.code === 'EEXIST') return remember(path, parse(path));
      throw inner;
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Fresh parse that bypasses the cache (for read-modify-write); the cache is refreshed too. */
export function readJsonFresh(path) {
  if (!existsSync(path)) {
    cache.set(path, { mtimeMs: -1, value: null, checkedAt: Date.now() });
    return null;
  }
  return remember(path, parse(path));
}

// EPERM with no lock file to wait for: a folder this process may not write to (fails at once
// after these retries), or Windows still deleting a released lock (gone within milliseconds).
const MAX_EPERM_WITHOUT_LOCK = 20;

/**
 * Exclusive lock file next to `path` ('wx' create). Writers hold it for a few milliseconds;
 * a lock older than `staleMs` belongs to a crashed process and is broken. Never spins: every
 * retry pauses, and a folder that refuses the lock file makes this throw instead of waiting.
 */
function acquireLock(path, { timeoutMs = 5000, staleMs = 2000 } = {}) {
  const lockPath = `${path}.lock`;
  const started = Date.now();
  let permWithoutLock = 0;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      } finally {
        closeSync(fd);
      }
      return () => {
        try { unlinkSync(lockPath); } catch { /* already broken as stale */ }
      };
    } catch (error) {
      // Windows reports EPERM while another process is deleting the lock file.
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
      if (error.code === 'EPERM' && !existsSync(lockPath)) {
        permWithoutLock += 1;
        if (permWithoutLock > MAX_EPERM_WITHOUT_LOCK || Date.now() - started > timeoutMs) throw error;
        pause(5 + Math.floor(Math.random() * 10));
        continue;
      }
    }
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch (error) {
      // Released between our attempt and the stat; try again after a short pause.
      if (Date.now() - started > timeoutMs) {
        throw Object.assign(new Error(`could not lock ${lockPath}`), { code: error?.code || 'ELOCKED' });
      }
      pause(2);
      continue;
    }
    if (ageMs > staleMs || Date.now() - started > timeoutMs) {
      try { unlinkSync(lockPath); } catch { /* another waiter broke it first */ }
      continue;
    }
    pause(5 + Math.floor(Math.random() * 10));
  }
}

/**
 * Runs fn() while holding the same `<path>.lock` file updateJsonLocked uses, so a change to a
 * non-JSON file (a secret) is serialized with other hub processes. Returns fn's result.
 */
export function withFileLock(path, fn, { dirMode = 0o700 } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: dirMode });
  const release = acquireLock(path);
  try {
    return fn();
  } finally {
    release();
  }
}

/** Replaces a text file in one step (temp file + rename): readers see the old or the new text. */
export function writeTextAtomic(path, text, { mode = 0o600, dirMode = 0o700 } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: dirMode });
  const tmp = tmpPathFor(path);
  writeFileSync(tmp, String(text), { mode });
  try {
    renameWithRetry(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Read-modify-write under a lock, so writers in other processes are never lost:
 * `mutate(current)` gets a fresh parse (null when missing) and returns the next object,
 * or undefined to leave the file as it is. Returns what the file holds afterwards.
 */
export function updateJsonLocked(path, mutate, { mode = 0o600, dirMode = 0o700 } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: dirMode });
  const release = acquireLock(path);
  try {
    const current = readJsonFresh(path);
    const next = mutate(current);
    if (next === undefined) return current;
    return writeJsonAtomic(path, next, { mode, dirMode });
  } finally {
    release();
  }
}

export function clearJsonCacheForTests() {
  cache.clear();
}
