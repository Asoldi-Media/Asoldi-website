import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getDataFilePath, getPersistentDataDir, writeDataJson } from './storage-path.js';

const SNAPSHOTS_FILE = 'client-maps-ranking.json';
const GBP_FILE = 'client-google-business.json';
const TRAFFIC_DIR = 'client-analytics-traffic';
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

function subjectKey({ businessId = '', siteKey = '' } = {}) {
  return compact(businessId) || compact(siteKey);
}

export function getMapsRankingRecord(id) {
  const key = compact(id);
  if (!key) return null;
  const map = readJson(snapshotsPath(), {});
  const row = map[key];
  return row && typeof row === 'object' ? row : null;
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
  const row = map[key];
  return row && typeof row === 'object' ? row : null;
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
  const row = map[key];
  return row && typeof row === 'object' ? row : null;
}

export { subjectKey };
