// The time from which the current contract-period wording applies. Written once.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPersistentDataDir } from './storage-path.js';

const FILE_NAME = 'contract-terms-cutover.json';
const VERSION_KEY = '2';

/** dir path -> cut-over ms. A value with no file is the in-memory fallback for this process. */
const byDir = new Map();

export function resetContractTermsCutoverCache() {
  byDir.clear();
}

function cutoverFile(dir) {
  return join(dir, FILE_NAME);
}

function readCutoverMs(dir) {
  const file = cutoverFile(dir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const from = parsed?.durationTerms?.[VERSION_KEY]?.from;
    if (typeof from !== 'string' || !from.trim()) return null;
    const ms = Date.parse(from);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function writeCutoverMs(dir, ms) {
  const body = { durationTerms: { [VERSION_KEY]: { from: new Date(ms).toISOString() } } };
  writeFileSync(cutoverFile(dir), JSON.stringify(body, null, 2));
}

/** The stored cut-over, or `now` written once. Never throws and never replaces a valid stored time. */
export function recordContractTermsCutover({ now = Date.now() } = {}) {
  const ms = Number.isFinite(now) ? now : Date.now();
  let dir = '';
  try {
    dir = getPersistentDataDir();
  } catch {
    if (!byDir.has('')) byDir.set('', ms);
    return byDir.get('');
  }
  const stored = readCutoverMs(dir);
  if (stored !== null) {
    byDir.set(dir, stored);
    return stored;
  }
  try {
    writeCutoverMs(dir, ms);
    const written = readCutoverMs(dir);
    if (written !== null) {
      byDir.set(dir, written);
      return written;
    }
  } catch {
    // The file could not be written. The time stays in memory for this process.
  }
  if (!byDir.has(dir)) byDir.set(dir, ms);
  return byDir.get(dir);
}

/** The stored cut-over in ms, read once per process. Records `now` when nothing valid is stored yet. */
export function contractTermsCutoverMs({ now = Date.now() } = {}) {
  try {
    const dir = getPersistentDataDir();
    if (byDir.has(dir)) return byDir.get(dir);
  } catch {
    // recordContractTermsCutover handles a missing data dir.
  }
  return recordContractTermsCutover({ now });
}
