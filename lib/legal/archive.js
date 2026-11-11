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

/**
 * Tests only: use `value` as the archive of `version` (a version from 1 to the current one) until
 * clearArchiveCache(). Nothing is written to disk.
 */
export function useArchivedCatalogForTests(version, value) {
  const number = Number(version);
  if (!Number.isInteger(number) || number < 1 || number > CATALOG_VERSION) throw new Error(`No catalog version ${version}`);
  cache.set(number, value);
}

/**
 * The settings-derived values (lib/legal/texts.js VERSIONED_PARAMS) a version was published with,
 * from its archive, or null when the archive has none (the code values then apply). A contract
 * bound to a version renders these, so a later change to a code default or a stored setting does
 * not change the text of a contract that was already sent.
 */
export function publishedParamsForVersion(version) {
  const params = loadArchivedCatalog(version)?.published?.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'pages' && key !== 'dpaVersion' && value !== undefined && value !== null) out[key] = value;
  }
  return out;
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

/**
 * The introduction and Section 4 a catalog contract adds around the clauses, from that version's
 * archive, or null for the current version (the caller renders those from the current code, which
 * is what the archive is checked against). `currentVersion` is for tests that pretend a later
 * catalog exists.
 */
export function archivedContractWording(version, language, currentVersion = CATALOG_VERSION) {
  const number = Number(version);
  const current = Number(currentVersion);
  if (!Number.isInteger(number) || number < 1 || number === current) return null;
  const frame = loadArchivedCatalog(number)?.contract?.[language === 'en' ? 'en' : 'nb'];
  if (!frame || typeof frame.introLegal !== 'string' || !Array.isArray(frame.section4)) return null;
  return { introLegal: frame.introLegal, section4: [...frame.section4] };
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
