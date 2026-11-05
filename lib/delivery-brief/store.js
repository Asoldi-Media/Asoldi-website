/**
 * Versioned brief store under the hub data dir:
 *   <dataDir>/delivery-briefs/<clientId>/v<N>.json     one file per version (written once)
 *   <dataDir>/delivery-briefs/<clientId>/latest.json   a copy of the newest version
 *   <dataDir>/delivery-briefs/<clientId>/reviews.json  directive and fact reviews (survive rebuilds)
 *   <dataDir>/delivery-briefs/<clientId>/extraction.json  the reduced items of the last complete extraction
 *   <dataDir>/delivery-briefs/<clientId>/state.json    rebuild bookkeeping (input hash, debounce)
 *   <dataDir>/delivery-briefs/<clientId>/chunks/       cached map results per chunk
 *   <dataDir>/delivery-briefs/.erased/<clientId>.json  written by a privacy erase before it deletes
 *
 * A brief's hash covers its canonical JSON without version, hash, generatedAt, stats and URL
 * signatures, so an unchanged input gives the same hash and saveBrief writes nothing. At most
 * MAX_VERSIONS versions and MAX_CLIENT_BYTES per client are kept, the chunk cache counted in the bytes
 * (the oldest versions go first; the newest always stays). Writes are atomic and serialized per client
 * with the shared file lock.
 *
 * Once a client's brief is erased, every writer here (versions, reviews, extraction, state, and the
 * chunk cache through assertBriefNotErased) refuses with code brief-erased, checked right before it
 * writes, so a rebuild or a review that was running during the erase never creates the folder again.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPersistentDataDir } from '../../data/storage-path.js';
import { readJsonFresh, withFileLock, writeJsonAtomic } from '../../data/atomic-json.js';
import { acquireLease } from '../../data/email-store.js';
import { SINGLE_FACT_PATHS } from './extract.js';
import { CLIENT_ID_RE, canonicalJson, isPlainObject, sha256, text } from './text.js';

export const BRIEFS_DIR = 'delivery-briefs';
export const MAX_VERSIONS = 10;
export const MAX_CLIENT_BYTES = 2 * 1024 * 1024;
export const MAX_BRIEF_BYTES = 300 * 1024;
export const DIRECTIVE_STATUSES = Object.freeze(['open', 'accepted', 'rejected', 'done']);
export const FACT_REVIEW_STATUSES = Object.freeze(['proposed', 'accepted', 'client-confirmed', 'rejected']);
const VERSION_RE = /^v(\d{1,6})\.json$/;
const SIGNED_QUERY_RE = /([?&](?:sig|signature|exp|expires|token|X-Amz-[A-Za-z-]+)=)[^&#"\s]*/g;

export function briefsRoot(dataDir) {
  return join(dataDir || getPersistentDataDir(), BRIEFS_DIR);
}

export function assertClientId(clientId) {
  const id = text(clientId);
  if (!CLIENT_ID_RE.test(id)) {
    const error = new Error('Not a client id.');
    error.code = 'bad-client-id';
    throw error;
  }
  return id;
}

export function clientBriefDir(clientId, { dataDir } = {}) {
  return join(briefsRoot(dataDir), assertClientId(clientId));
}

// ---------------------------------------------------------------- erased clients

/** Not a client id (CLIENT_ID_RE has no dot), so it never collides with a client's folder. */
export const ERASED_DIR = '.erased';
/** A marker older than this is removed when the next erase writes one; a running write has long ended. */
export const ERASED_MARKER_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export function erasedMarkerPath(clientId, { dataDir } = {}) {
  return join(briefsRoot(dataDir), ERASED_DIR, `${assertClientId(clientId)}.json`);
}

/** True once a privacy erase removed (or is removing) this client's brief. */
export function briefErased(clientId, { dataDir } = {}) {
  return existsSync(erasedMarkerPath(clientId, { dataDir }));
}

export function briefErasedError() {
  const error = new Error('This client\'s brief was erased.');
  error.code = 'brief-erased';
  return error;
}

/** Throws code brief-erased after a privacy erase of the client; every brief writer calls it right before it writes. */
export function assertBriefNotErased(clientId, { dataDir } = {}) {
  if (briefErased(clientId, { dataDir })) throw briefErasedError();
}

function pruneErasedMarkers(dir, keepName, nowMs) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keepName || !name.endsWith('.json')) continue;
    try {
      if (nowMs - statSync(join(dir, name)).mtimeMs > ERASED_MARKER_KEEP_MS) unlinkSync(join(dir, name));
    } catch {
      // The next erase tries again.
    }
  }
}

/** Marks the client's brief as erased (before anything is deleted), so no brief writer writes for it again. */
export function markBriefErased(clientId, { dataDir, now = new Date() } = {}) {
  const id = assertClientId(clientId);
  const markerPath = erasedMarkerPath(id, { dataDir });
  writeJsonAtomic(markerPath, { kind: 'asoldi.brief-erased/1', clientId: id, erasedAt: now.toISOString() });
  pruneErasedMarkers(join(briefsRoot(dataDir), ERASED_DIR), `${id}.json`, now.getTime());
  return markerPath;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Replaces signed query values (sig, exp, ...) in every URL string so they never affect the hash. */
export function stripUrlSignatures(value) {
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value.replace(SIGNED_QUERY_RE, '$1') : value;
  if (Array.isArray(value)) return value.map(stripUrlSignatures);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = stripUrlSignatures(child);
  return out;
}

/** Bytes of a brief as written to disk (pretty JSON, as data/atomic-json.js writes it). */
export function storedBytes(brief) {
  return Buffer.byteLength(`${JSON.stringify(brief, null, 2)}\n`);
}

/** 'sha256:<hex>' over the brief without version, hash, generatedAt, stats and URL signatures. */
export function computeBriefHash(brief) {
  const { version: _version, hash: _hash, generatedAt: _generatedAt, stats: _stats, ...rest } = isPlainObject(brief) ? brief : {};
  return `sha256:${sha256(canonicalJson(stripUrlSignatures(rest)))}`;
}

function lockPath(clientId, dataDir) {
  return join(clientBriefDir(clientId, { dataDir }), 'latest.json');
}

function versionFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, match: VERSION_RE.exec(name) }))
    .filter((row) => row.match)
    .map((row) => {
      let bytes = 0;
      try {
        bytes = statSync(join(dir, row.name)).size;
      } catch {
        bytes = 0;
      }
      return { name: row.name, version: Number(row.match[1]), bytes };
    })
    .sort((a, b) => a.version - b.version);
}

/** Bytes of a client folder's chunk cache (cached map answers). */
function chunkCacheBytes(dir) {
  const chunks = join(dir, 'chunks');
  if (!existsSync(chunks)) return 0;
  let total = 0;
  for (const name of readdirSync(chunks)) {
    try {
      total += statSync(join(chunks, name)).size;
    } catch {
      // Removed meanwhile.
    }
  }
  return total;
}

/**
 * Drops the oldest versions (never keepVersion) until the client has at most MAX_VERSIONS versions and
 * at most MAX_CLIENT_BYTES on disk, the chunk cache counted, so a large cache makes old versions go first.
 */
function prune(dir, keepVersion) {
  const files = versionFiles(dir);
  const removed = [];
  let total = files.reduce((sum, file) => sum + file.bytes, 0) + chunkCacheBytes(dir);
  let count = files.length;
  for (const file of files) {
    if (file.version === keepVersion) continue;
    if (count <= MAX_VERSIONS && total <= MAX_CLIENT_BYTES) break;
    try {
      unlinkSync(join(dir, file.name));
      removed.push(file.version);
      count -= 1;
      total -= file.bytes;
    } catch {
      // The next save tries again.
    }
  }
  return removed;
}

/**
 * Applies the per-client caps without saving a version: after a rebuild has pruned or grown the chunk
 * cache, old versions go until the folder fits MAX_CLIENT_BYTES again. The newest version always stays.
 * Returns the removed version numbers; nothing happens for a client without a folder or after an erase.
 */
export function enforceClientCaps(clientId, { dataDir } = {}) {
  const dir = clientBriefDir(clientId, { dataDir });
  if (!existsSync(dir) || briefErased(clientId, { dataDir })) return [];
  return withFileLock(lockPath(clientId, dataDir), () => {
    const files = versionFiles(dir);
    return files.length ? prune(dir, files[files.length - 1].version) : [];
  });
}

/** The newest brief (latest.json), or null. */
export function readLatestBrief(clientId, { dataDir } = {}) {
  return readJson(join(clientBriefDir(clientId, { dataDir }), 'latest.json'));
}

/** One stored version, or null. */
export function readBriefVersion(clientId, version, { dataDir } = {}) {
  const n = Number(version);
  if (!Number.isInteger(n) || n < 1) return null;
  return readJson(join(clientBriefDir(clientId, { dataDir }), `v${n}.json`));
}

/** [{ version, hash, generatedAt, bytes }], newest first. */
export function listBriefVersions(clientId, { dataDir } = {}) {
  const dir = clientBriefDir(clientId, { dataDir });
  return versionFiles(dir)
    .reverse()
    .map((file) => {
      const brief = readJson(join(dir, file.name));
      return { version: file.version, hash: text(brief?.hash), generatedAt: text(brief?.generatedAt), bytes: file.bytes };
    });
}

/**
 * Saves `brief` as the next version unless the newest one has the same hash.
 * `brief` may be a function: it runs inside the client's save lock and returns the brief, so a writer
 * that assembles there (from the reviews and extraction as they are at that moment) never overwrites a
 * newer review with an older assembly.
 * Returns { changed, version, hash, bytes, pruned, brief }. Throws code 'brief-too-large' above
 * MAX_BRIEF_BYTES and code 'brief-erased' after a privacy erase; whatever the function throws is
 * passed on and nothing is written.
 */
export function saveBrief(clientId, briefOrBuild, { dataDir, now = new Date() } = {}) {
  const dir = clientBriefDir(clientId, { dataDir });
  // Checked before the lock (which would create the folder) and again inside it.
  assertBriefNotErased(clientId, { dataDir });
  return withFileLock(lockPath(clientId, dataDir), () => {
    assertBriefNotErased(clientId, { dataDir });
    const brief = typeof briefOrBuild === 'function' ? briefOrBuild() : briefOrBuild;
    const hash = computeBriefHash(brief);
    const latest = readJsonFresh(join(dir, 'latest.json'));
    if (latest && latest.hash === hash) {
      return { changed: false, version: Number(latest.version) || 0, hash, bytes: 0, pruned: [], brief };
    }
    const files = versionFiles(dir);
    const version = Math.max(Number(latest?.version) || 0, files.length ? files[files.length - 1].version : 0) + 1;
    const record = { ...brief, version, hash, generatedAt: brief.generatedAt || now.toISOString() };
    const bytes = storedBytes(record);
    if (bytes > MAX_BRIEF_BYTES) {
      const error = new Error(`The brief is ${bytes} bytes; the limit is ${MAX_BRIEF_BYTES}.`);
      error.code = 'brief-too-large';
      throw error;
    }
    writeJsonAtomic(join(dir, `v${version}.json`), record);
    writeJsonAtomic(join(dir, 'latest.json'), record);
    const pruned = prune(dir, version);
    return { changed: true, version, hash, bytes, pruned, brief };
  });
}

// ---------------------------------------------------------------- reviews

function emptyReviews() {
  return { version: 1, revision: 0, directives: {}, facts: {} };
}

export function readReviews(clientId, { dataDir } = {}) {
  const raw = readJson(join(clientBriefDir(clientId, { dataDir }), 'reviews.json'));
  if (!raw) return emptyReviews();
  return {
    version: 1,
    revision: Number(raw.revision) || 0,
    directives: isPlainObject(raw.directives) ? raw.directives : {},
    facts: isPlainObject(raw.facts) ? raw.facts : {},
  };
}

function updateReviews(clientId, { dataDir }, mutate) {
  const dir = clientBriefDir(clientId, { dataDir });
  const path = join(dir, 'reviews.json');
  assertBriefNotErased(clientId, { dataDir });
  return withFileLock(path, () => {
    assertBriefNotErased(clientId, { dataDir });
    const current = readReviews(clientId, { dataDir });
    const next = mutate(structuredClone(current));
    if (!next) return current;
    next.revision = current.revision + 1;
    writeJsonAtomic(path, next);
    return next;
  });
}

function reviewError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Records a directive's status (open, accepted, rejected, done) and, optionally, the job that applied
 * it. Reviews are keyed by directive id and survive rebuilds.
 */
export function setDirectiveStatus(clientId, directiveId, { status, by = '', note = '', jobId = '', now = new Date() } = {}, { dataDir } = {}) {
  const id = text(directiveId, 80);
  if (!/^dir-[a-z0-9]{6,40}$/.test(id)) throw reviewError('Not a directive id.', 'bad-directive-id');
  const value = text(status);
  if (!DIRECTIVE_STATUSES.includes(value)) throw reviewError(`status must be one of ${DIRECTIVE_STATUSES.join(', ')}.`, 'bad-status');
  return updateReviews(clientId, { dataDir }, (reviews) => {
    const previous = isPlainObject(reviews.directives[id]) ? reviews.directives[id] : {};
    const applied = new Set(Array.isArray(previous.appliedInJobs) ? previous.appliedInJobs : []);
    const job = text(jobId, 120);
    if (job) applied.add(job);
    reviews.directives[id] = {
      status: value,
      by: text(by, 120),
      at: now.toISOString(),
      ...(text(note) ? { note: text(note, 500) } : {}),
      ...(applied.size ? { appliedInJobs: [...applied].slice(-20) } : {}),
    };
    return reviews;
  });
}

const REVIEWABLE_FACT_PATHS = new Set(SINGLE_FACT_PATHS);
export const FACT_ID_RE = /^f-[0-9a-f]{12}$/;

/**
 * A review key is a single-valued fact path (`contact.phone`, `identity.brandName`) or the id of one
 * transcript fact (`f-…`, derived from its content, so it stays on the same fact when a rebuild changes
 * the order of a list). List positions (`claims.stats[0]`) and other paths are refused.
 */
export function isReviewableFactKey(key) {
  const value = text(key, 120);
  return REVIEWABLE_FACT_PATHS.has(value) || FACT_ID_RE.test(value);
}

/** The stored review entry for one fact, checked. Throws code bad-fact-path, bad-status or bad-value. */
export function factReviewEntry(path, { status, value, by = '', note = '', now = new Date() } = {}) {
  const factPath = text(path, 120);
  if (!isReviewableFactKey(factPath)) throw reviewError('Not a reviewable fact: use a single fact path (for example contact.phone) or a transcript fact id (f-…).', 'bad-fact-path');
  const next = text(status);
  if (!FACT_REVIEW_STATUSES.includes(next)) throw reviewError(`status must be one of ${FACT_REVIEW_STATUSES.join(', ')}.`, 'bad-status');
  if (value !== undefined && !['string', 'number', 'boolean'].includes(typeof value)) throw reviewError('value must be text, a number or true/false.', 'bad-value');
  if (value !== undefined && FACT_ID_RE.test(factPath)) throw reviewError('A transcript fact id takes a status only; correct a value on its fact path.', 'bad-value');
  return {
    key: factPath,
    entry: {
      status: next,
      by: text(by, 120),
      at: now.toISOString(),
      ...(value !== undefined ? { value: typeof value === 'string' ? text(value, 500) : value } : {}),
      ...(text(note) ? { note: text(note, 500) } : {}),
    },
  };
}

/** `reviews` with one more fact review, as the next revision (nothing is written). */
export function withFactReview(reviews, path, review = {}) {
  const { key, entry } = factReviewEntry(path, review);
  const next = structuredClone(isPlainObject(reviews) ? reviews : emptyReviews());
  next.facts = isPlainObject(next.facts) ? next.facts : {};
  next.facts[key] = entry;
  next.revision = (Number(next.revision) || 0) + 1;
  return next;
}

/**
 * Records a review of one fact (status proposed, accepted, client-confirmed or rejected; an optional
 * corrected value on a fact path). Reviews survive rebuilds.
 */
export function reviewFact(clientId, path, review = {}, { dataDir } = {}) {
  const { key, entry } = factReviewEntry(path, review);
  return updateReviews(clientId, { dataDir }, (reviews) => {
    reviews.facts[key] = entry;
    return reviews;
  });
}

// ---------------------------------------------------------------- extraction and state

export function readExtraction(clientId, { dataDir } = {}) {
  return readJson(join(clientBriefDir(clientId, { dataDir }), 'extraction.json'));
}

export function writeExtraction(clientId, extraction, { dataDir } = {}) {
  assertBriefNotErased(clientId, { dataDir });
  writeJsonAtomic(join(clientBriefDir(clientId, { dataDir }), 'extraction.json'), extraction);
}

export function readBriefState(clientId, { dataDir } = {}) {
  return readJson(join(clientBriefDir(clientId, { dataDir }), 'state.json')) || {};
}

/** Writes state.json only when the merged value differs (an unchanged tick touches nothing). */
export function updateBriefState(clientId, patch, { dataDir } = {}) {
  const path = join(clientBriefDir(clientId, { dataDir }), 'state.json');
  assertBriefNotErased(clientId, { dataDir });
  return withFileLock(path, () => {
    assertBriefNotErased(clientId, { dataDir });
    const current = readJson(path) || {};
    const next = { ...current, ...patch };
    if (canonicalJson(next) === canonicalJson(current)) return current;
    writeJsonAtomic(path, next);
    return next;
  });
}

export function chunkCacheDir(clientId, { dataDir } = {}) {
  return join(clientBriefDir(clientId, { dataDir }), 'chunks');
}

// ---------------------------------------------------------------- personal data (export and erase)

/**
 * Every file under the client's folder (versions, latest, reviews, extraction, state, chunks):
 * [{ name (inside the folder), path (inside the data dir, '/'-separated), full, bytes }].
 */
export function listClientBriefFiles(clientId, { dataDir } = {}) {
  const dir = clientBriefDir(clientId, { dataDir });
  if (!existsSync(dir)) return [];
  const root = dataDir || getPersistentDataDir();
  const files = [];
  const walk = (path, rel) => {
    let names = [];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const full = join(path, name);
      const inside = rel ? `${rel}/${name}` : name;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, inside);
      else if (stat.isFile()) files.push({ name: inside, path: relative(root, full).split(sep).join('/'), full, bytes: stat.size });
    }
  };
  walk(dir, '');
  return files;
}

/** Everything stored for one client: versions, reviews, extraction, state, and the list of every file. */
export function exportClientBriefs(clientId, { dataDir } = {}) {
  const dir = clientBriefDir(clientId, { dataDir });
  if (!existsSync(dir)) return { clientId, versions: [], reviews: null, extraction: null, state: null, files: [] };
  return {
    clientId,
    versions: versionFiles(dir).map((file) => readJson(join(dir, file.name))).filter(Boolean),
    reviews: readJson(join(dir, 'reviews.json')),
    extraction: readJson(join(dir, 'extraction.json')),
    state: readJson(join(dir, 'state.json')),
    files: listClientBriefFiles(clientId, { dataDir }).map(({ name, bytes }) => ({ name, bytes })),
  };
}

/**
 * Removes the client's brief folder. dryRun lists what would go. A real erase first marks the brief
 * as erased (markBriefErased), so a rebuild or review still running never writes the folder again.
 */
export function eraseClientBriefs(clientId, { dataDir, dryRun = true, now = new Date() } = {}) {
  const dir = clientBriefDir(clientId, { dataDir });
  if (!dryRun) markBriefErased(clientId, { dataDir, now });
  if (!existsSync(dir)) return { clientId, files: [], erased: false };
  const files = listClientBriefFiles(clientId, { dataDir }).map((file) => file.name);
  if (!dryRun) rmSync(dir, { recursive: true, force: true });
  return { clientId, files, erased: !dryRun };
}

export const ERASE_LEASE_WAIT_MS = 15_000;
const ERASE_LEASE_TTL_MS = 60_000;
const INLINE_JSON_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Every JSON write helper target of the brief, as the personal-data writer scan names them
 * ('<file>:<first argument>'): the chunk cache, the versions and latest copy, reviews and rebuild
 * state (both `path`), the extraction, and the erase marker.
 */
export const BRIEF_STORE_WRITERS = Object.freeze([
  'lib/delivery-brief/extract.js:pathFor(key)',
  'lib/delivery-brief/store.js:join(dir, `v${version}.json`)',
  "lib/delivery-brief/store.js:join(dir, 'latest.json')",
  'lib/delivery-brief/store.js:path',
  "lib/delivery-brief/store.js:join(clientBriefDir(clientId, { dataDir }), 'extraction.json')",
  'lib/delivery-brief/store.js:markerPath',
]);

/**
 * The lease brief:<clientId>, waiting up to `waitMs` for a running rebuild to stop; null when it does
 * not. The wait timer keeps the process alive: an erase in a process with nothing else to keep it
 * running (a script) must still finish.
 */
async function leaseWithin(clientId, waitMs) {
  const until = Date.now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    const lease = await acquireLease(`brief:${clientId}`, ERASE_LEASE_TTL_MS);
    if (lease || Date.now() >= until) return lease;
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
}

/**
 * The store as the personal-data registry describes it (the same row the registry itself lists for
 * `delivery-briefs`), with handlers that follow the registry's contract:
 *   export(clientId, ctx) → { files: [{ path, bytes, content? }] }: every file under the client's
 *     folder, JSON files inline;
 *   erase(clientId, ctx) → { action: 'delete' | 'none', records, files }: ctx.dryRun (true unless it is
 *     false) only lists. A real erase first marks the brief as erased (markBriefErased), so from then
 *     on no rebuild, re-assembly, review or loop step writes for the client, and a running rebuild
 *     stops at its next call or write. It then waits up to ERASE_LEASE_WAIT_MS for the lease
 *     brief:<clientId> and deletes the folder, also when a rebuild still holds the lease (the marker
 *     keeps that rebuild from writing).
 *   writers: BRIEF_STORE_WRITERS.
 * ctx.dataDir is the data dir (the hub's own when absent).
 */
export function briefStoreDescriptor({ waitMs = ERASE_LEASE_WAIT_MS } = {}) {
  return {
    id: BRIEFS_DIR,
    label: 'Leveransebrief',
    dir: BRIEFS_DIR,
    clientKey: 'path',
    retention: { rule: 'brief' },
    personalData: 'Facts about the client and short quotes from meetings',
    purpose: 'The brief the website is built from',
    legalBasis: 'Contract',
    processors: ['Anthropic'],
    writers: [...BRIEF_STORE_WRITERS],
    export(clientId, ctx = {}) {
      let files = [];
      try {
        files = listClientBriefFiles(clientId, { dataDir: ctx.dataDir || undefined });
      } catch {
        return { files: [] };
      }
      return {
        files: files.map(({ path, full, bytes }) => (path.endsWith('.json') && bytes <= INLINE_JSON_MAX_BYTES
          ? { path, bytes, content: readJson(full) }
          : { path, bytes })),
      };
    },
    async erase(clientId, ctx = {}) {
      const dataDir = ctx.dataDir || undefined;
      let files = [];
      try {
        files = listClientBriefFiles(clientId, { dataDir });
      } catch {
        return { action: 'none', records: 0, files: [] };
      }
      const paths = files.map((file) => file.path);
      if (ctx.dryRun !== false) return { action: paths.length ? 'delete' : 'none', records: 0, files: paths };
      const id = assertClientId(clientId);
      // Marked first, also while the client has no folder: a rebuild or review that starts later writes nothing.
      let markError = '';
      try {
        markBriefErased(id, { dataDir, now: ctx.now instanceof Date ? ctx.now : new Date() });
      } catch (error) {
        markError = `The brief could not be marked as erased (${error?.code || 'error'}); a rebuild running now could write it again.`;
      }
      if (!paths.length) return { action: 'none', records: 0, files: [], ...(markError ? { error: markError } : {}) };
      const lease = await leaseWithin(id, waitMs);
      try {
        rmSync(clientBriefDir(id, { dataDir }), { recursive: true, force: true });
      } finally {
        if (lease) await lease.release();
      }
      return { action: 'delete', records: 0, files: paths, ...(markError ? { error: markError } : {}) };
    },
  };
}

let registered = false;

/**
 * Registers this store's handlers with the personal-data registry when the build has one
 * (lib/personal-data.js), once per process. When the registry already lists `delivery-briefs` (its
 * own row), that row's description and retention rule are kept as they are, its writers are kept
 * together with the brief's own (BRIEF_STORE_WRITERS), and the export and erase handlers are the
 * brief's, the way the registry's other modules add theirs; otherwise the whole
 * briefStoreDescriptor() is registered. A build without the registry is fine; a failing registry
 * never stops a brief. `registry` replaces the module (tests).
 */
export async function registerBriefStore({ log = console, registry = null } = {}) {
  if (registered) return false;
  registered = true;
  const url = new URL('../personal-data.js', import.meta.url);
  if (!registry && !existsSync(fileURLToPath(url))) return false;
  try {
    const mod = registry || (await import(url.href));
    const register = mod?.registerStore || mod?.registerPersonalDataStore;
    if (typeof register !== 'function') return false;
    const own = briefStoreDescriptor();
    const existing = typeof mod.getStore === 'function' ? mod.getStore(BRIEFS_DIR) : null;
    if (existing && typeof existing === 'object') {
      const writers = [...new Set([...(Array.isArray(existing.writers) ? existing.writers : []), ...own.writers])];
      register({ ...existing, id: BRIEFS_DIR, writers, export: own.export, erase: own.erase });
    } else {
      register(own);
    }
    return true;
  } catch (error) {
    if (!/already|duplicate|exists/i.test(String(error?.message || error?.code || ''))) {
      log?.warn?.(`[delivery-brief] could not register the brief store: ${error?.code || error?.message || 'error'}`);
    }
    return false;
  }
}

export function resetBriefStoreRegistrationForTests() {
  registered = false;
}
