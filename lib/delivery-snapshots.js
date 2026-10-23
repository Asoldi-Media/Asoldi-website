// Delivery snapshots and restore (WS8.44, batch 0).
//
// A snapshot copies the delivery stores (sales clients, hub sites, offers and the delivery stores
// later batches add) into <dataDir>/snapshots/<label>-<timestamp>/ with a manifest. The newest 3
// are kept. A startup hook takes one automatically when this code's DELIVERY_SCHEMA_VERSION is
// higher than the version stored in <dataDir>/delivery-schema.json, so every batch deploy on
// Hostinger snapshots the data before the new code writes to it.
//
// Restore always shows its diff first (dry run is the default), snapshots the current state as
// `pre-restore`, then writes each file through writeDataJson (so the usual backups exist too).
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPersistentDataDir, writeDataJson } from '../data/storage-path.js';

// Bump by one in every batch that adds or reshapes delivery data.
export const DELIVERY_SCHEMA_VERSION = 1;
export const DELIVERY_SCHEMA_FILE = 'delivery-schema.json';
export const SNAPSHOTS_DIR = 'snapshots';
export const SNAPSHOT_MANIFEST = 'manifest.json';
export const SNAPSHOT_KIND = 'delivery-snapshot';
export const SNAPSHOT_KEEP = 3;

// Append-only. Secrets, Maker host tokens and rebuildable caches are never snapshotted.
export const DELIVERY_SNAPSHOT_FILES = Object.freeze([
  'sales-clients.json',
  'sites.json',
  'sales-offers.json',
  'automation-settings.json',
  'change-requests.json',
  'testimonials.json',
  'delivery-jobs.json',
]);

const SNAPSHOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const MAX_LISTED_IDS = 200;
const MAX_KEY_DIFFS = 50;

function resolveDataDir(dataDir) {
  return dataDir || getPersistentDataDir();
}

export function snapshotsRoot(dataDir) {
  return join(resolveDataDir(dataDir), SNAPSHOTS_DIR);
}

export function isValidSnapshotId(id) {
  const value = String(id ?? '');
  return SNAPSHOT_ID_RE.test(value) && !value.includes('--');
}

function sanitizeLabel(label) {
  const value = String(label || 'manual').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (value || 'manual').slice(0, 40);
}

function stampFor(now) {
  return now.toISOString().replace(/[:.]/g, '').replace(/[^0-9tz]/gi, '').toLowerCase();
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function recordCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function describeFile(file) {
  const buffer = readFileSync(file);
  const parsed = parseJson(buffer.toString('utf8'));
  return { bytes: buffer.length, sha256: sha256(buffer), records: parsed.ok ? recordCount(parsed.value) : null, json: parsed.ok };
}

function readManifest(dir) {
  const file = join(dir, SNAPSHOT_MANIFEST);
  if (!existsSync(file)) return null;
  const parsed = parseJson(readFileSync(file, 'utf8'));
  if (!parsed.ok || parsed.value?.kind !== SNAPSHOT_KIND) return null;
  return parsed.value;
}

export function listDeliverySnapshots({ dataDir } = {}) {
  const root = snapshotsRoot(dataDir);
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSnapshotId(entry.name)) continue;
    const manifest = readManifest(join(root, entry.name));
    if (!manifest) continue;
    out.push({ ...manifest, id: entry.name });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id));
}

/** Keeps the newest `keep` delivery snapshots; ids in `protect` are never removed and use a slot. */
export function pruneDeliverySnapshots({ dataDir, keep = SNAPSHOT_KEEP, protect = [] } = {}) {
  const keepSet = new Set(protect);
  const removed = [];
  const list = listDeliverySnapshots({ dataDir });
  let kept = list.filter((snapshot) => keepSet.has(snapshot.id)).length;
  for (const snapshot of list) {
    if (keepSet.has(snapshot.id)) continue;
    if (kept < keep) {
      kept += 1;
      continue;
    }
    rmSync(join(snapshotsRoot(dataDir), snapshot.id), { recursive: true, force: true });
    removed.push(snapshot.id);
  }
  return removed;
}

/** Copies the delivery stores that exist into a new snapshot directory. */
export function createDeliverySnapshot({
  dataDir,
  label = 'manual',
  reason = '',
  now = new Date(),
  files = DELIVERY_SNAPSHOT_FILES,
  keep = SNAPSHOT_KEEP,
  protect = [],
  schemaVersion = DELIVERY_SCHEMA_VERSION,
} = {}) {
  const base = resolveDataDir(dataDir);
  const root = snapshotsRoot(base);
  mkdirSync(root, { recursive: true });
  const prefix = `${sanitizeLabel(label)}-${stampFor(now)}`;
  let id = prefix;
  for (let n = 2; existsSync(join(root, id)); n += 1) id = `${prefix}-${n}`;
  const dir = join(root, id);
  const tmp = join(root, `.tmp-${id}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const copied = [];
  for (const name of files) {
    if (!DELIVERY_SNAPSHOT_FILES.includes(name)) continue;
    const source = join(base, name);
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    copyFileSync(source, join(tmp, name));
    copied.push({ name, ...describeFile(join(tmp, name)) });
  }
  const manifest = {
    kind: SNAPSHOT_KIND,
    id,
    label: sanitizeLabel(label),
    reason: String(reason || '').slice(0, 300),
    createdAt: now.toISOString(),
    schemaVersion,
    files: copied.map(({ name, bytes, sha256: hash, records }) => ({ name, bytes, sha256: hash, records })),
  };
  writeFileSync(join(tmp, SNAPSHOT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tmp, dir);
  const pruned = pruneDeliverySnapshots({ dataDir: base, keep, protect: [id, ...protect] });
  return { ...manifest, dir, pruned };
}

// ---------------------------------------------------------------- schema version

export function readStoredSchemaVersion({ dataDir } = {}) {
  const file = join(resolveDataDir(dataDir), DELIVERY_SCHEMA_FILE);
  if (!existsSync(file)) return { version: 0 };
  const parsed = parseJson(readFileSync(file, 'utf8'));
  const version = Number(parsed.ok ? parsed.value?.version : 0);
  return { ...(parsed.ok && parsed.value && typeof parsed.value === 'object' ? parsed.value : {}), version: Number.isInteger(version) && version > 0 ? version : 0 };
}

function writeStoredSchemaVersion({ dataDir, record }) {
  const file = join(resolveDataDir(dataDir), DELIVERY_SCHEMA_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * Startup hook. When this code's schema version is higher than the stored one, it snapshots the
 * delivery stores (when any exist) and then stores the new version, so it runs once per batch.
 * Older code on newer data (a revert) takes no snapshot and never lowers the stored version.
 */
export function runDeliverySchemaStartupSnapshot({ dataDir, codeVersion = DELIVERY_SCHEMA_VERSION, now = new Date(), log = console } = {}) {
  const base = resolveDataDir(dataDir);
  const stored = readStoredSchemaVersion({ dataDir: base });
  if (stored.version === codeVersion) return { action: 'none', storedVersion: stored.version, codeVersion };
  if (stored.version > codeVersion) {
    log?.warn?.(`[delivery] data schema v${stored.version} is newer than this code (v${codeVersion}); forward-compatible normalizers keep the newer keys.`);
    return { action: 'newer-data', storedVersion: stored.version, codeVersion };
  }
  const hasData = DELIVERY_SNAPSHOT_FILES.some((name) => existsSync(join(base, name)));
  let snapshot = null;
  if (hasData) {
    snapshot = createDeliverySnapshot({
      dataDir: base,
      label: `batch-${codeVersion}`,
      reason: `schema v${stored.version} -> v${codeVersion} on startup`,
      now,
      schemaVersion: stored.version,
    });
    log?.log?.(`[delivery] schema v${stored.version} -> v${codeVersion}: snapshot ${snapshot.id} (${snapshot.files.length} files)`);
  }
  writeStoredSchemaVersion({
    dataDir: base,
    record: { version: codeVersion, previousVersion: stored.version, at: now.toISOString(), snapshotId: snapshot?.id || '' },
  });
  return { action: snapshot ? 'snapshot' : 'fresh', storedVersion: stored.version, codeVersion, snapshotId: snapshot?.id || '' };
}

// ---------------------------------------------------------------- diff and restore

function recordKey(record, index) {
  if (record && typeof record === 'object' && typeof record.id === 'string' && record.id) return record.id;
  return `#${index}`;
}

function changedTopKeys(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter((key) => JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key])).sort();
}

function diffJson(snapshotValue, currentValue) {
  if (Array.isArray(snapshotValue) && Array.isArray(currentValue)) {
    const snap = new Map(snapshotValue.map((record, index) => [recordKey(record, index), record]));
    const cur = new Map(currentValue.map((record, index) => [recordKey(record, index), record]));
    const added = [...snap.keys()].filter((key) => !cur.has(key));
    const removed = [...cur.keys()].filter((key) => !snap.has(key));
    const changedIds = [...snap.keys()].filter((key) => cur.has(key) && JSON.stringify(snap.get(key)) !== JSON.stringify(cur.get(key)));
    return {
      added: added.slice(0, MAX_LISTED_IDS),
      removed: removed.slice(0, MAX_LISTED_IDS),
      changed: changedIds.slice(0, MAX_LISTED_IDS).map((key, index) => (
        index < MAX_KEY_DIFFS ? { id: key, keys: changedTopKeys(snap.get(key), cur.get(key)) } : { id: key }
      )),
      counts: { added: added.length, removed: removed.length, changed: changedIds.length },
    };
  }
  const keys = changedTopKeys(snapshotValue, currentValue);
  return { added: [], removed: [], changed: keys.length ? [{ id: '(file)', keys }] : [], counts: { added: 0, removed: 0, changed: keys.length ? 1 : 0 } };
}

function loadSnapshot(dataDir, id) {
  if (!isValidSnapshotId(id)) return { ok: false, status: 400, error: 'Invalid snapshot id.' };
  const dir = join(snapshotsRoot(dataDir), id);
  const manifest = existsSync(dir) ? readManifest(dir) : null;
  if (!manifest) return { ok: false, status: 404, error: 'Snapshot not found.' };
  return { ok: true, dir, manifest };
}

/** What a restore of snapshot `id` would change, file by file. */
export function diffDeliverySnapshot({ dataDir, id } = {}) {
  const base = resolveDataDir(dataDir);
  const loaded = loadSnapshot(base, id);
  if (!loaded.ok) return loaded;
  const files = [];
  const errors = [];
  for (const entry of loaded.manifest.files || []) {
    const name = String(entry?.name || '');
    if (!DELIVERY_SNAPSHOT_FILES.includes(name)) {
      errors.push(`${name}: not a delivery store`);
      continue;
    }
    const snapFile = join(loaded.dir, name);
    if (!existsSync(snapFile)) {
      errors.push(`${name}: missing from the snapshot`);
      continue;
    }
    const snapBuffer = readFileSync(snapFile);
    if (entry.sha256 && sha256(snapBuffer) !== entry.sha256) {
      errors.push(`${name}: checksum does not match the manifest`);
      continue;
    }
    const snapParsed = parseJson(snapBuffer.toString('utf8'));
    if (!snapParsed.ok) {
      errors.push(`${name}: snapshot copy is not valid JSON`);
      continue;
    }
    const currentFile = join(base, name);
    const currentExists = existsSync(currentFile);
    const currentBuffer = currentExists ? readFileSync(currentFile) : null;
    const currentParsed = currentBuffer ? parseJson(currentBuffer.toString('utf8')) : { ok: true, value: null };
    const identical = Boolean(currentBuffer) && sha256(currentBuffer) === sha256(snapBuffer);
    files.push({
      name,
      action: identical ? 'unchanged' : currentExists ? 'replace' : 'create',
      snapshot: { bytes: snapBuffer.length, records: recordCount(snapParsed.value) },
      current: currentExists ? { bytes: currentBuffer.length, records: currentParsed.ok ? recordCount(currentParsed.value) : null } : null,
      ...(identical ? { counts: { added: 0, removed: 0, changed: 0 } } : diffJson(snapParsed.value, currentParsed.ok ? currentParsed.value : null)),
    });
  }
  const notInSnapshot = DELIVERY_SNAPSHOT_FILES
    .filter((name) => existsSync(join(base, name)) && !files.some((file) => file.name === name) && !errors.some((err) => err.startsWith(`${name}:`)))
    .map((name) => ({ name, action: 'keep' }));
  return { ok: errors.length === 0, id: loaded.manifest.id || id, manifest: loaded.manifest, files, notInSnapshot, errors };
}

/**
 * Restores snapshot `id`. dryRun (the default) only returns the diff. A real restore first
 * snapshots the current state (`pre-restore`), then writes every changed file through
 * writeDataJson. Files the snapshot does not hold are left as they are.
 */
export function restoreDeliverySnapshot({ dataDir, id, dryRun = true, now = new Date(), by = '' } = {}) {
  const base = resolveDataDir(dataDir);
  const diff = diffDeliverySnapshot({ dataDir: base, id });
  if (diff.status) return { ok: false, status: diff.status, error: diff.error, dryRun: Boolean(dryRun) };
  if (!diff.ok) return { ok: false, status: 409, error: 'Snapshot failed verification.', errors: diff.errors, dryRun: Boolean(dryRun), diff };
  if (dryRun) return { ok: true, dryRun: true, diff, restored: [] };
  const preRestore = createDeliverySnapshot({
    dataDir: base,
    label: 'pre-restore',
    reason: `before restoring ${id}${by ? ` (by ${String(by).slice(0, 80)})` : ''}`,
    now,
    protect: [id],
  });
  const loaded = loadSnapshot(base, id);
  if (!loaded.ok) return { ok: false, status: loaded.status, error: loaded.error, dryRun: false, preRestoreSnapshotId: preRestore.id };
  const restored = [];
  for (const file of diff.files) {
    if (file.action === 'unchanged') continue;
    const text = readFileSync(join(loaded.dir, file.name), 'utf8');
    writeDataJson(join(base, file.name), text);
    restored.push(file.name);
  }
  return { ok: true, dryRun: false, diff, restored, preRestoreSnapshotId: preRestore.id };
}
