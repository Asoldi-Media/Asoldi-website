/**
 * The Fireflies files on the data disk: fireflies-meetings.json (every transcript the hub has
 * seen), fireflies-notified.json (which recording e-mails went out) and
 * fireflies-ingest-state.json (where the pull ingest left off).
 *
 * The archive feeds offers, workshop documents and the client card, so it has to survive a
 * process killed mid-write, a full disk and two hub processes at once:
 *   - reads are cached by mtime and size, so hot paths do not re-parse megabytes per call;
 *   - writes are a locked read-modify-write with temp file + rename (data/atomic-json.js),
 *     and happen only when the mutation reports a change;
 *   - a file that does not parse is never treated as empty. Reads fall back to the newest
 *     readable backup without writing anything; the next write starts from that backup and
 *     keeps the unreadable file next to the backups. With no readable backup the write is
 *     refused (FirefliesStoreUnreadableError), loudly; only the ingest state, which the next
 *     scan works out again, starts over from empty instead.
 *   - backups/<name>.latest.json follows every write, and a timestamped copy is kept at most
 *     hourly, so DATA_BACKUP_KEEP copies span hours instead of the last few seconds.
 */
import { copyFileSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { basename, join } from 'path';
import { updateJsonLocked } from '../data/atomic-json.js';
import { getDataBackupDir, getDataFilePath, pruneDataBackupsForFile, resolveDataBackupKeep } from '../data/storage-path.js';

export const FIREFLIES_STORE_FILES = Object.freeze({
  meetings: 'fireflies-meetings.json',
  notified: 'fireflies-notified.json',
  ingest: 'fireflies-ingest-state.json',
});

/** Timestamped backups at most this often per file. */
export const FIREFLIES_BACKUP_EVERY_MS = 60 * 60 * 1000;
// Another process's write shows up here within this long; this process's writes at once.
const STAT_TTL_MS = 1000;
const READ_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const STAMPED_RE = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/;

export class FirefliesStoreUnreadableError extends Error {
  constructor(name, reason = '') {
    super(`Fireflies store ${name} is unreadable and has no readable backup; the write was refused.`);
    this.name = 'FirefliesStoreUnreadableError';
    this.code = 'FIREFLIES_STORE_UNREADABLE';
    this.file = name;
    this.reason = reason;
  }
}

const cache = new Map();
const paths = new Map();
const stats = { writes: {}, restored: {}, refused: {} };
const alerted = new Map();

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function pause(ms) {
  Atomics.wait(sleeper, 0, 0, ms);
}

function fileFor(name) {
  const file = FIREFLIES_STORE_FILES[name];
  if (!file) throw new Error(`Unknown Fireflies store "${name}".`);
  return file;
}

export function firefliesStorePath(name) {
  if (!paths.has(name)) paths.set(name, getDataFilePath(fileFor(name)));
  return paths.get(name);
}

function statOf(path) {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
  } catch {
    return null;
  }
}

/** { value } for a JSON object, { missing: true }, or { error } for anything that is not one. */
function readObjectFile(path) {
  let text;
  for (let attempt = 0; ; attempt += 1) {
    try {
      text = readFileSync(path, 'utf8');
      break;
    } catch (error) {
      if (error?.code === 'ENOENT') return { missing: true };
      // Windows reports these for a few milliseconds while another process renames the file.
      if (!READ_RETRY_CODES.has(error?.code) || attempt >= 5) return { error: error?.code || 'read-failed' };
      pause(5 + attempt * 5);
    }
  }
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { value };
    return { error: 'not-an-object' };
  } catch {
    // Only a code: a parse message would quote file content.
    return { error: text.trim() ? 'invalid-json' : 'empty-file' };
  }
}

function stampMs(entry, fileName) {
  const match = entry.slice(fileName.length + 1).match(STAMPED_RE);
  if (!match) return NaN;
  return Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`);
}

/** Timestamped backups of one file, oldest first. */
function stampedBackups(dir, fileName) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.startsWith(`${fileName}.`) && Number.isFinite(stampMs(entry, fileName)))
    .sort((a, b) => stampMs(a, fileName) - stampMs(b, fileName));
}

/** The newest backup that parses: backups/<file>.latest.json first, then timestamped copies, newest first. */
function readNewestBackup(fileName) {
  let dir;
  try {
    dir = getDataBackupDir();
  } catch {
    return null;
  }
  const candidates = [`${fileName}.latest.json`, ...stampedBackups(dir, fileName).reverse()];
  for (const entry of candidates) {
    const read = readObjectFile(join(dir, entry));
    if (read.value) return { value: read.value, file: entry };
  }
  return null;
}

function alertOnce(key, message) {
  if (alerted.get(key)) return;
  alerted.set(key, true);
  console.error(`[fireflies] STORE ALERT ${message}`);
}

function load(name) {
  const path = firefliesStorePath(name);
  const main = readObjectFile(path);
  if (main.value) return { map: main.value, source: 'file', error: '' };
  if (main.missing) return { map: {}, source: 'missing', error: '' };
  const backup = readNewestBackup(basename(path));
  const stat = statOf(path);
  const key = `${name}:${stat?.mtimeMs || 0}:${stat?.size || 0}`;
  if (backup) {
    alertOnce(key, `${fileFor(name)} is unreadable (${main.error}); reading backups/${backup.file} until the next write repairs it.`);
    return { map: backup.value, source: 'backup', backupFile: backup.file, error: main.error };
  }
  alertOnce(key, `${fileFor(name)} is unreadable (${main.error}) and no backup parses. Writes are refused until it is repaired by hand.`);
  return { map: {}, source: 'unreadable', error: main.error };
}

/**
 * The parsed map (an empty object when the file does not exist). Never throws. The object is
 * shared with the cache: callers copy before changing anything.
 */
export function readFirefliesStore(name) {
  const now = Date.now();
  const hit = cache.get(name);
  if (hit && now - hit.checkedAt < STAT_TTL_MS) return hit.map;
  const stat = statOf(firefliesStorePath(name));
  if (hit && ((!stat && hit.source === 'missing') || (stat && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size))) {
    hit.checkedAt = now;
    return hit.map;
  }
  const loaded = load(name);
  cache.set(name, { ...loaded, mtimeMs: stat?.mtimeMs ?? -1, size: stat?.size ?? -1, checkedAt: now });
  return loaded.map;
}

function stampFor(nowMs) {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-');
}

function copyAtomic(from, to) {
  const tmp = `${to}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  copyFileSync(from, tmp);
  try {
    renameSync(tmp, to);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

/** latest.json after every write; a timestamped copy when the newest one is an hour old. */
function writeBackups(path, nowMs) {
  try {
    const dir = getDataBackupDir();
    const fileName = basename(path);
    copyAtomic(path, join(dir, `${fileName}.latest.json`));
    const keep = resolveDataBackupKeep();
    if (keep <= 0) return;
    const newest = stampedBackups(dir, fileName).at(-1);
    if (newest && nowMs - stampMs(newest, fileName) < FIREFLIES_BACKUP_EVERY_MS) return;
    copyAtomic(path, join(dir, `${fileName}.${stampFor(nowMs)}.json`));
    pruneDataBackupsForFile(fileName, { keep, backupDir: dir });
  } catch (error) {
    console.warn(`[fireflies] backup of ${basename(path)} failed: ${error?.code || error?.message || error}`);
  }
}

/** Kept for a human: never pruned, never read back automatically. */
function keepUnreadableCopy(path, nowMs) {
  try {
    copyFileSync(path, join(getDataBackupDir(), `${basename(path)}.unreadable-${stampFor(nowMs)}`));
  } catch (error) {
    console.warn(`[fireflies] could not keep a copy of unreadable ${basename(path)}: ${error?.code || error}`);
  }
}

/**
 * Locked read-modify-write. `mutate(map)` changes the fresh map in place and returns true when
 * it changed something; nothing is written otherwise (except to repair a file that had to be
 * read from its backup). Returns { map, changed, restored }. Throws FirefliesStoreUnreadableError
 * when the file does not parse and no backup does, unless `rebuildUnreadable` (state the hub can
 * work out again, like where the ingest left off): then it starts from {} and keeps the bad file.
 */
export function updateFirefliesStore(name, mutate, { backups = true, nowMs = Date.now(), rebuildUnreadable = false } = {}) {
  const path = firefliesStorePath(name);
  let changed = false;
  let restored = false;
  let map = null;
  try {
    updateJsonLocked(path, (current) => {
      let base = current;
      if (!base) {
        const main = readObjectFile(path);
        if (main.value) {
          base = main.value;
        } else if (main.missing) {
          base = {};
        } else {
          const backup = readNewestBackup(basename(path));
          if (!backup && !rebuildUnreadable) throw new FirefliesStoreUnreadableError(fileFor(name), main.error);
          keepUnreadableCopy(path, nowMs);
          console.error(backup
            ? `[fireflies] STORE ALERT ${fileFor(name)} was unreadable (${main.error}); rewriting it from backups/${backup.file}.`
            : `[fireflies] STORE ALERT ${fileFor(name)} was unreadable (${main.error}) with no backup; starting it again from empty.`);
          base = backup ? backup.value : {};
          restored = true;
        }
      }
      changed = mutate(base) === true;
      map = base;
      if (!changed && !restored) return undefined;
      return base;
    });
  } catch (error) {
    if (error instanceof FirefliesStoreUnreadableError) {
      stats.refused[name] = (stats.refused[name] || 0) + 1;
      console.error(`[fireflies] STORE ALERT ${error.message}`);
    }
    throw error;
  }
  if (changed || restored) {
    stats.writes[name] = (stats.writes[name] || 0) + 1;
    if (restored) stats.restored[name] = (stats.restored[name] || 0) + 1;
    const stat = statOf(path);
    cache.set(name, { map, source: 'file', error: '', mtimeMs: stat?.mtimeMs ?? -1, size: stat?.size ?? -1, checkedAt: Date.now() });
    if (backups) writeBackups(path, nowMs);
  }
  return { map, changed: changed || restored, restored };
}

/** Where this file is read from now: 'file', 'missing', 'backup' or 'unreadable' (no backup parses either). */
export function firefliesStoreSource(name) {
  readFirefliesStore(name);
  return cache.get(name)?.source || 'missing';
}

/** Where each file was last read from ('file', 'missing', 'backup', 'unreadable') and write counts. */
export function firefliesStoreHealth() {
  const out = {};
  for (const name of Object.keys(FIREFLIES_STORE_FILES)) {
    readFirefliesStore(name);
    const hit = cache.get(name) || {};
    out[name] = {
      source: hit.source || 'missing',
      error: hit.error || '',
      backupFile: hit.backupFile || '',
      writes: stats.writes[name] || 0,
      restored: stats.restored[name] || 0,
      refused: stats.refused[name] || 0,
    };
  }
  return out;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = stable(value[key]);
  }
  return out;
}

/** True when two records differ in anything but the given bookkeeping fields. */
export function storeRecordsDiffer(a, b, ignore = ['at', 'updatedAt']) {
  const strip = (row) => {
    if (!row || typeof row !== 'object') return row ?? null;
    const copy = { ...row };
    for (const key of ignore) delete copy[key];
    return copy;
  };
  return JSON.stringify(stable(strip(a))) !== JSON.stringify(stable(strip(b)));
}

export function resetFirefliesStoreForTests() {
  cache.clear();
  alerted.clear();
  stats.writes = {};
  stats.restored = {};
  stats.refused = {};
}
