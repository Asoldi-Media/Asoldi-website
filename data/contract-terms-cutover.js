// The time from which the current contract-period wording applies.
// Missing file: written once. Unreadable file: left in place; this process uses its modification time.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPersistentDataDir } from './storage-path.js';

const FILE_NAME = 'contract-terms-cutover.json';
const VERSION_KEY = '2';
const UNREADABLE = '[contract-terms] contract-terms-cutover.json is unreadable; using the time the file was last written. Repair or remove the file.';

/** dir path -> cut-over ms. A value with no file is the in-memory fallback for this process. */
const byDir = new Map();
/** Dirs whose unreadable file was already logged in this process. */
const loggedUnreadable = new Set();

export function resetContractTermsCutoverCache() {
  byDir.clear();
  loggedUnreadable.clear();
}

function cutoverFile(dir) {
  return join(dir, FILE_NAME);
}

function readCutover(dir) {
  const file = cutoverFile(dir);
  let present = false;
  try {
    present = existsSync(file);
  } catch {
    return { status: 'missing' };
  }
  if (!present) return { status: 'missing' };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const from = parsed?.durationTerms?.[VERSION_KEY]?.from;
    if (typeof from !== 'string' || !from.trim()) return { status: 'bad' };
    const ms = Date.parse(from);
    return Number.isFinite(ms) ? { status: 'ok', ms } : { status: 'bad' };
  } catch {
    return { status: 'bad' };
  }
}

function writeCutoverMs(dir, ms) {
  const body = JSON.stringify({ durationTerms: { [VERSION_KEY]: { from: new Date(ms).toISOString() } } }, null, 2);
  const file = cutoverFile(dir);
  const tmp = join(dir, `${FILE_NAME}.tmp`);
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

function unreadableCutover(dir, now, logger) {
  if (!loggedUnreadable.has(dir)) {
    loggedUnreadable.add(dir);
    try {
      logger?.error?.(UNREADABLE);
    } catch {
      // Logging must not change the cut-over.
    }
  }
  try {
    const mtime = Math.floor(statSync(cutoverFile(dir)).mtimeMs);
    if (Number.isFinite(mtime)) {
      byDir.set(dir, mtime);
      return mtime;
    }
  } catch {
    // The file's modification time could not be read.
  }
  if (!byDir.has(dir)) byDir.set(dir, now);
  return byDir.get(dir);
}

/** The stored cut-over, or `now` written once. Never throws and never replaces a valid stored time. */
export function recordContractTermsCutover({ now = Date.now(), logger = console } = {}) {
  const ms = Number.isFinite(now) ? now : Date.now();
  let dir = '';
  try {
    dir = getPersistentDataDir();
  } catch {
    if (!byDir.has('')) byDir.set('', ms);
    return byDir.get('');
  }
  const read = readCutover(dir);
  if (read.status === 'ok') {
    byDir.set(dir, read.ms);
    return read.ms;
  }
  if (read.status === 'bad') return unreadableCutover(dir, ms, logger);
  try {
    writeCutoverMs(dir, ms);
    const written = readCutover(dir);
    if (written.status === 'ok') {
      byDir.set(dir, written.ms);
      return written.ms;
    }
  } catch {
    // The file could not be written. The time stays in memory for this process.
  }
  if (!byDir.has(dir)) byDir.set(dir, ms);
  return byDir.get(dir);
}

/** The stored cut-over in ms, read once per process. Records `now` when nothing valid is stored yet. */
export function contractTermsCutoverMs({ now = Date.now(), logger = console } = {}) {
  try {
    const dir = getPersistentDataDir();
    if (byDir.has(dir)) return byDir.get(dir);
  } catch {
    // recordContractTermsCutover handles a missing data dir.
  }
  return recordContractTermsCutover({ now, logger });
}
