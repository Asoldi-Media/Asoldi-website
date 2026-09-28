/**
 * DataForSEO Google Maps SERP (live/advanced) only.
 * Ranking snapshots for client analytics — not Labs keyword research.
 *
 * POST https://api.dataforseo.com/v3/serp/google/maps/live/advanced
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDataFilePath, getPersistentDataDir, writeDataJson } from '../data/storage-path.js';

const API_BASE = 'https://api.dataforseo.com/v3';
export const MAPS_ENDPOINT = 'serp/google/maps/live/advanced';
const SPEND_FILE = 'dataforseo-maps-spend.json';

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function dataForSeoAuth(env = process.env) {
  const raw = compact(env.DATAFORSEO_AUTH);
  if (raw) return raw;
  const login = compact(env.DATAFORSEO_LOGIN);
  const password = compact(env.DATAFORSEO_PASSWORD);
  if (login && password) return Buffer.from(`${login}:${password}`, 'utf8').toString('base64');
  return '';
}

export function isDataForSeoMapsConfigured(env = process.env) {
  return Boolean(dataForSeoAuth(env));
}

export function mapsRankingBudgetUsd(env = process.env) {
  const n = Number(env.DATAFORSEO_MAPS_BUDGET_USD);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

export function mapsRankingDepth(env = process.env) {
  const n = Number(env.DATAFORSEO_MAPS_DEPTH);
  if (!Number.isFinite(n) || n < 10) return 20;
  return Math.min(100, Math.floor(n));
}

function cacheDir() {
  const dir = join(getPersistentDataDir(), 'dataforseo-maps-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function spendPath() {
  return getDataFilePath(SPEND_FILE);
}

export function readMapsSpendLedger() {
  const file = spendPath();
  if (!existsSync(file)) return { totalUsd: 0, calls: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      totalUsd: Number(parsed?.totalUsd) || 0,
      calls: Array.isArray(parsed?.calls) ? parsed.calls : [],
    };
  } catch {
    return { totalUsd: 0, calls: [] };
  }
}

function appendSpend(entry) {
  const ledger = readMapsSpendLedger();
  ledger.calls.push(entry);
  if (ledger.calls.length > 4000) ledger.calls = ledger.calls.slice(-4000);
  ledger.totalUsd = Math.round((ledger.totalUsd + (Number(entry.costUsd) || 0)) * 1e6) / 1e6;
  writeDataJson(spendPath(), ledger);
  return ledger;
}

export function mapsSpendSummary(env = process.env) {
  const ledger = readMapsSpendLedger();
  const budget = mapsRankingBudgetUsd(env);
  return {
    configured: isDataForSeoMapsConfigured(env),
    endpoint: MAPS_ENDPOINT,
    budgetUsd: budget,
    spentUsd: ledger.totalUsd,
    remainingUsd: Math.max(0, Math.round((budget - ledger.totalUsd) * 1e6) / 1e6),
    calls: ledger.calls.length,
  };
}

function cacheFile(payload) {
  const key = createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  return join(cacheDir(), `${key}.json`);
}

function readCache(payload, maxAgeMs) {
  const file = cacheFile(payload);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const at = Date.parse(parsed?.cachedAt || '');
    if (!Number.isFinite(at) || Date.now() - at > maxAgeMs) return null;
    return parsed.payload;
  } catch {
    return null;
  }
}

function writeCache(payload, response) {
  writeFileSync(cacheFile(payload), JSON.stringify({ cachedAt: new Date().toISOString(), payload: response }), 'utf8');
}

export function locationCoordinate({ lat, lng, zoom = 15 } = {}) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
  const z = Number(zoom);
  const zoomPart = Number.isFinite(z) ? Math.min(21, Math.max(3, Math.round(z))) : 15;
  return `${latitude.toFixed(7)},${longitude.toFixed(7)},${zoomPart}z`;
}

/**
 * One Maps SERP live/advanced call. Cached 13 days so a 14-day cadence never
 * double-bills the same keyword+coordinate pair.
 */
export async function fetchGoogleMapsSerp(task = {}, {
  env = process.env,
  fetchImpl = fetch,
  cacheMs = 13 * 24 * 60 * 60 * 1000,
  persist = true,
} = {}) {
  const auth = dataForSeoAuth(env);
  if (!auth) {
    const err = new Error('DATAFORSEO_AUTH is not set.');
    err.code = 'not-configured';
    throw err;
  }
  const keyword = compact(task.keyword);
  if (!keyword) {
    const err = new Error('Maps SERP requires a keyword.');
    err.code = 'bad-request';
    throw err;
  }
  const coordinate = compact(task.location_coordinate);
  const locationName = compact(task.location_name);
  const locationCode = Number(task.location_code);
  if (!coordinate && !locationName && !Number.isFinite(locationCode)) {
    const err = new Error('Maps SERP needs location_coordinate, location_name, or location_code.');
    err.code = 'bad-request';
    throw err;
  }

  const bodyTask = {
    keyword,
    language_code: compact(task.language_code) || 'no',
    device: compact(task.device) || 'mobile',
    depth: Number.isFinite(Number(task.depth)) ? Number(task.depth) : mapsRankingDepth(env),
    search_this_area: task.search_this_area !== false,
    se_domain: compact(task.se_domain) || 'google.no',
  };
  if (coordinate) bodyTask.location_coordinate = coordinate;
  else if (locationName) bodyTask.location_name = locationName;
  else bodyTask.location_code = locationCode;

  const cached = persist ? readCache(bodyTask, cacheMs) : null;
  if (cached) return { ...cached, cached: true };

  if (persist) {
    const summary = mapsSpendSummary(env);
    const worstCase = 0.004;
    if (summary.spentUsd + worstCase > summary.budgetUsd) {
      const err = new Error(
        `DataForSEO Maps budget: spent $${summary.spentUsd.toFixed(3)} of $${summary.budgetUsd.toFixed(2)}.`
      );
      err.code = 'budget';
      throw err;
    }
  }

  const response = await fetchImpl(`${API_BASE}/${MAPS_ENDPOINT}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([bodyTask]),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(json?.status_message || `DataForSEO Maps HTTP ${response.status}`);
    err.code = 'http';
    err.status = response.status;
    throw err;
  }
  const taskRow = Array.isArray(json?.tasks) ? json.tasks[0] : null;
  const costUsd = Number(taskRow?.cost ?? json?.cost) || 0;
  if (persist) {
    appendSpend({
      at: new Date().toISOString(),
      endpoint: MAPS_ENDPOINT,
      keyword,
      costUsd,
      status: taskRow?.status_code || json?.status_code,
    });
  }
  if (taskRow && taskRow.status_code !== 20000) {
    const err = new Error(taskRow.status_message || 'DataForSEO Maps task failed.');
    err.code = 'task';
    err.statusCode = taskRow.status_code;
    throw err;
  }
  const result = {
    costUsd,
    keyword,
    checkUrl: taskRow?.result?.[0]?.check_url || '',
    datetime: taskRow?.result?.[0]?.datetime || new Date().toISOString(),
    items: Array.isArray(taskRow?.result?.[0]?.items) ? taskRow.result[0].items : [],
    seResultsCount: Number(taskRow?.result?.[0]?.se_results_count) || 0,
    rawStatus: taskRow?.status_code,
  };
  if (persist) writeCache(bodyTask, result);
  return { ...result, cached: false };
}
