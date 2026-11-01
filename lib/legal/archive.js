/**
 * Archived catalog versions: lib/legal/archive/catalog-v<N>.json, written by
 * node scripts/legal-render.mjs --write. Each holds the declared clauses and the rendered
 * documents of that version, so a client bound to an older version still sees the text they
 * signed. The current version's archive must equal what the current code renders (legal-render
 * --check), so a text change without a version bump fails.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { CATALOG, CATALOG_VERSION, catalogFromDeclared } from './catalog.js';

export const ARCHIVE_DIR = new URL('./archive/', import.meta.url);
export const ARCHIVE_FORMAT = 1;

const cache = new Map();

export function archiveUrl(version) {
  return new URL(`catalog-v${Number(version)}.json`, ARCHIVE_DIR);
}

/**
 * The archived version, or null when there is none. A version above the current one never exists,
 * so it is refused without touching the disk, and only versions that were found are cached (a
 * public request with any number cannot grow the cache).
 */
export function loadArchivedCatalog(version) {
  const number = Number(version);
  if (!Number.isInteger(number) || number < 1 || number > CATALOG_VERSION) return null;
  if (cache.has(number)) return cache.get(number);
  const url = archiveUrl(number);
  if (!existsSync(url)) return null;
  let value = null;
  try {
    value = JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    return null;
  }
  cache.set(number, value);
  return value;
}

/** Number of cached archive versions (for tests). */
export function archiveCacheSize() {
  return cache.size;
}

/** Archived version numbers, ascending. */
export function archivedVersions() {
  if (!existsSync(ARCHIVE_DIR)) return [];
  return readdirSync(ARCHIVE_DIR)
    .map((name) => /^catalog-v(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}

/** True for the current version and for every archived one. */
export function isKnownCatalogVersion(version) {
  const number = Number(version);
  return number === CATALOG_VERSION || Boolean(loadArchivedCatalog(number));
}

/** The clause catalog of a version: the current one, or one built from the archive (null when unknown). */
export function catalogForVersion(version) {
  const number = Number(version);
  if (number === CATALOG_VERSION) return CATALOG;
  const archived = loadArchivedCatalog(number);
  return archived?.clauses ? catalogFromDeclared(archived.clauses) : null;
}

/** The DPA version an archived (or the current) catalog version was published with. */
export function dpaVersionForCatalog(version, currentDpaVersion) {
  const number = Number(version);
  if (number === CATALOG_VERSION) return currentDpaVersion;
  return String(loadArchivedCatalog(number)?.dpaVersion || '');
}

export function clearArchiveCache() {
  cache.clear();
}
