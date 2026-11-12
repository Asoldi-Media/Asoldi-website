import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, lstatSync, unlinkSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { getDataFilePath, getPersistentDataDir, writeDataJson } from './storage-path.js';
import { siteKeysFor } from './hub.js';

const SNAPSHOTS_FILE = 'client-maps-ranking.json';
const GBP_FILE = 'client-google-business.json';
const TRAFFIC_DIR = 'client-analytics-traffic';
const TRAFFIC_RETENTION_REPORT = 'client-analytics-traffic-retention.json';
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const COMMERCE_FILE = 'client-commerce-snapshots.json';

function nowIso() {
  return new Date().toISOString();
}

function compact(value = '') {
  return String(value ?? '').trim();
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  writeDataJson(file, value);
}

function snapshotsPath() {
  return getDataFilePath(SNAPSHOTS_FILE);
}

function gbpPath() {
  return getDataFilePath(GBP_FILE);
}

function trafficDir() {
  const dir = join(getPersistentDataDir(), TRAFFIC_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** The traffic folder path. Does not create it. */
function trafficRoot() {
  return join(getPersistentDataDir(), TRAFFIC_DIR);
}

/** True when the traffic folder is a real directory. A symbolic link or junction does not count. */
function isRealDirectory(path) {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether the traffic folder exists. Does not create it. */
export function trafficFolderExists() {
  return isRealDirectory(trafficRoot());
}

/**
 * The row for a key in a map keyed by business id or site key. When the key has no row of its own and
 * it is a site key that was replaced (or replaced another), the rows under the site's other keys are
 * tried. A key with a row, or a site never rekeyed, behaves as a plain lookup.
 */
function rowForKey(map, key) {
  const own = map[key];
  if (own && typeof own === 'object') return own;
  for (const other of siteKeysFor(key).slice(1)) {
    const row = map[other];
    if (row && typeof row === 'object') return row;
  }
  return null;
}

function subjectKey({ businessId = '', siteKey = '' } = {}) {
  return compact(businessId) || compact(siteKey);
}

export function getMapsRankingRecord(id) {
  const key = compact(id);
  if (!key) return null;
  const map = readJson(snapshotsPath(), {});
  return rowForKey(map, key);
}

export function listMapsRankingDue(intervalMs, now = Date.now()) {
  const map = readJson(snapshotsPath(), {});
  return Object.entries(map).map(([id, row]) => {
    const last = Date.parse(row?.lastRunAt || '');
    const due = !Number.isFinite(last) || now - last >= intervalMs;
    return { id, due, lastRunAt: row?.lastRunAt || '', nextRunAt: Number.isFinite(last) ? new Date(last + intervalMs).toISOString() : nowIso() };
  });
}

export function saveMapsRankingSnapshot(id, snapshot, { intervalMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
  const key = compact(id);
  if (!key || !snapshot) return null;
  const map = readJson(snapshotsPath(), {});
  const current = map[key] && typeof map[key] === 'object' ? map[key] : { snapshots: [] };
  const snapshots = Array.isArray(current.snapshots) ? current.snapshots.slice() : [];
  snapshots.push(snapshot);
  if (snapshots.length > 36) snapshots.splice(0, snapshots.length - 36);
  const lastRunAt = snapshot.ranAt || nowIso();
  map[key] = {
    businessId: compact(snapshot.businessId || current.businessId || key),
    siteKey: compact(snapshot.siteKey || current.siteKey),
    lastRunAt,
    nextRunAt: new Date(Date.parse(lastRunAt) + intervalMs).toISOString(),
    lastError: snapshot.ok === false ? compact(snapshot.error) : '',
    snapshots,
    updatedAt: nowIso(),
  };
  writeJson(snapshotsPath(), map);
  return map[key];
}

export function markMapsRankingError(id, error) {
  const key = compact(id);
  if (!key) return null;
  const map = readJson(snapshotsPath(), {});
  const current = map[key] && typeof map[key] === 'object' ? map[key] : { snapshots: [] };
  map[key] = {
    ...current,
    lastError: compact(error),
    updatedAt: nowIso(),
  };
  writeJson(snapshotsPath(), map);
  return map[key];
}

export function getGoogleBusinessConnection(businessId) {
  const key = compact(businessId);
  if (!key) return null;
  const map = readJson(gbpPath(), {});
  return rowForKey(map, key);
}

export function listGoogleBusinessConnections() {
  const map = readJson(gbpPath(), {});
  return Object.entries(map).map(([businessId, row]) => ({ businessId, ...(row || {}) }));
}

export function saveGoogleBusinessConnection(businessId, patch = {}) {
  const key = compact(businessId);
  if (!key) return null;
  const map = readJson(gbpPath(), {});
  const current = map[key] && typeof map[key] === 'object' ? map[key] : {};
  map[key] = {
    ...current,
    ...patch,
    businessId: key,
    updatedAt: nowIso(),
  };
  writeJson(gbpPath(), map);
  return map[key];
}

export function clearGoogleBusinessConnection(businessId) {
  const key = compact(businessId);
  if (!key) return false;
  const map = readJson(gbpPath(), {});
  if (!map[key]) return false;
  delete map[key];
  writeJson(gbpPath(), map);
  return true;
}

function dayFile(siteKey, day) {
  const safe = compact(siteKey).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'unknown';
  const dir = join(trafficDir(), safe);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${day}.jsonl`);
}

export function appendTrafficEvents(siteKey, events = []) {
  const key = compact(siteKey);
  if (!key || !Array.isArray(events) || !events.length) return 0;
  const groups = new Map();
  for (const event of events) {
    const at = Date.parse(event?.at || event?.timestamp || '') || Date.now();
    const day = new Date(at).toISOString().slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push({ ...event, at: new Date(at).toISOString(), siteKey: key });
  }
  let count = 0;
  for (const [day, rows] of groups) {
    const line = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    appendFileSync(dayFile(key, day), line, 'utf8');
    count += rows.length;
  }
  return count;
}

export function readTrafficEvents(siteKey, fromMs, toMs) {
  const key = compact(siteKey);
  if (!key) return [];
  const keys = siteKeysFor(key);
  if (keys.length === 1) return readTrafficEventsForKey(key, fromMs, toMs);
  // A rekeyed site: rows written under the old key and under the new one, oldest first.
  return keys
    .flatMap((each) => readTrafficEventsForKey(compact(each), fromMs, toMs))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function readTrafficEventsForKey(key, fromMs, toMs) {
  const dir = join(trafficDir(), key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'unknown');
  if (!existsSync(dir)) return [];
  const fromDay = new Date(fromMs).toISOString().slice(0, 10);
  const toDay = new Date(toMs).toISOString().slice(0, 10);
  const files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  const out = [];
  for (const file of files) {
    const day = file.slice(0, 10);
    if (day < fromDay || day > toDay) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const at = Date.parse(row?.at || '');
        if (!Number.isFinite(at) || at < fromMs || at > toMs) continue;
        out.push(row);
      } catch {
        // skip bad lines
      }
    }
  }
  return out;
}

/**
 * Every day file directly inside a site folder. Does not create the traffic folder, and does not
 * follow a symbolic link or junction (lstat): anything that is not a real directory or a regular
 * file is skipped, and every other file name is ignored.
 */
export function listTrafficDayFiles() {
  const root = trafficRoot();
  if (!isRealDirectory(root)) return [];
  const out = [];
  for (const site of readdirSync(root)) {
    const siteDir = join(root, site);
    if (!isRealDirectory(siteDir)) continue;
    for (const name of readdirSync(siteDir)) {
      const match = DAY_FILE_RE.exec(name);
      if (!match) continue;
      const path = join(siteDir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (!st.isFile() || st.isSymbolicLink()) continue;
      out.push({ siteDir, day: match[1], path, bytes: st.size });
    }
  }
  return out;
}

/**
 * Deletes one day file. The resolved path must sit inside the traffic folder, two levels down,
 * and the name must be a UTC day. Anything else, including a directory or a link, is left in place.
 */
export function removeTrafficDayFile(entry) {
  const raw = entry && typeof entry.path === 'string' ? entry.path : '';
  if (!raw) return false;
  const root = resolve(trafficRoot());
  if (!isRealDirectory(root)) return false;
  const file = resolve(raw);
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  if (parts.length !== 2 || parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  if (!DAY_FILE_RE.test(parts[1])) return false;
  let walked = root;
  for (let i = 0; i < parts.length; i += 1) {
    walked = join(walked, parts[i]);
    let st;
    try {
      st = lstatSync(walked);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) return false;
    const last = i === parts.length - 1;
    if (!last && !st.isDirectory()) return false;
    if (last && !st.isFile()) return false;
  }
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Counts from the visit-statistics retention job. The path is `file` so the writer scan stays on the existing row. */
export function writeTrafficRetentionReport(report) {
  const file = join(getPersistentDataDir(), TRAFFIC_RETENTION_REPORT);
  writeJson(file, report);
}

export function readTrafficRetentionReport() {
  const file = join(getPersistentDataDir(), TRAFFIC_RETENTION_REPORT);
  return readJson(file, null);
}

export function publicGbpStatus(row) {
  if (!row) {
    return { connected: false, googleEmail: '', locationTitle: '', accountName: '', locations: [] };
  }
  return {
    connected: Boolean(row.refreshToken || row.accessToken),
    googleEmail: compact(row.googleEmail),
    locationTitle: compact(row.locationTitle),
    locationName: compact(row.locationName),
    accountName: compact(row.accountName),
    placeId: compact(row.placeId),
    connectedAt: compact(row.connectedAt),
    lastInsightsAt: compact(row.lastInsightsAt),
    lastError: compact(row.lastError),
    locations: Array.isArray(row.locations) ? row.locations : [],
  };
}

function commercePath() {
  return getDataFilePath(COMMERCE_FILE);
}

export function saveCommerceSnapshot(siteKey, payload = {}) {
  const key = compact(siteKey);
  if (!key) return null;
  const map = readJson(commercePath(), {});
  map[key] = {
    ...(payload && typeof payload === 'object' ? payload : {}),
    siteKey: key,
    savedAt: nowIso(),
  };
  writeJson(commercePath(), map);
  return map[key];
}

export function getCommerceSnapshot(siteKey) {
  const key = compact(siteKey);
  if (!key) return null;
  const map = readJson(commercePath(), {});
  return rowForKey(map, key);
}

export { subjectKey };
