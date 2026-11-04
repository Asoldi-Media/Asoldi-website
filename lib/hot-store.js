// Hot store: small JSON files on the data disk that change often (job queue, loop health,
// heartbeats, alert state). Each write replaces the file in one step (temp file + rename) and
// keeps no stamped backups, so a busy file never fills the backup folder. Read-modify-write runs
// under the file lock shared with data/atomic-json.js, so writers in other hub processes are never
// lost. A mutate that returns undefined leaves the file untouched (no write, mtime unchanged).
import { join } from 'node:path';
import { readJsonCached, readJsonFresh, updateJsonLocked, writeJsonAtomic } from '../data/atomic-json.js';
import { getPersistentDataDir } from '../data/storage-path.js';

export const HOT_DIR = 'delivery-hot';

/** <dataDir>/<name> (name may hold a sub folder, e.g. delivery-hot/loop-health.json). */
export function hotPath(name, { dataDir } = {}) {
  return join(dataDir || getPersistentDataDir(), name);
}

/** Replaces the file (temp file + rename, no backups). Returns the value. */
export function writeHotJson(path, value) {
  return writeJsonAtomic(path, value);
}

/** Parsed object or null. `fresh` bypasses the one-second stat cache. */
export function readHotJson(path, { fresh = false } = {}) {
  return fresh ? readJsonFresh(path) : readJsonCached(path);
}

/**
 * Locked read-modify-write: mutate(current) returns the next object, or undefined for no write.
 * Returns what the file holds afterwards.
 */
export function updateHotJson(path, mutate) {
  return updateJsonLocked(path, mutate);
}
