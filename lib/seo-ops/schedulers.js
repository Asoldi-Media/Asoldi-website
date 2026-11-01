/**
 * Registry of the seo-ops schedulers: { id, purpose, allowSites, spendCapUsd } each.
 *
 * With hub safe mode off (asoldi.com) every site runs and calls are live, exactly as before.
 * With safe mode on (a local hub, possibly on a copy of production data):
 *   - a scheduler runs only for the sites in its allowSites (settings.safeMode.schedulers[id].allowSites,
 *     else settings.safeMode.allowSites, in seo-ops/settings.json; empty by default, so nothing runs);
 *   - its DataForSEO calls replay recorded fixtures (scripts/fixtures/seo-ops/dfs, or
 *     settings.safeMode.fixturesDir) and any other outbound call gets an empty answer, so no request
 *     leaves the process and nothing is spent;
 *   - only with settings.safeMode.live are calls real, and then they stop for the process once
 *     spendCapUsd (settings.safeMode.spendCapUsd) is spent.
 *
 * Today the Maps ranking loop (rank-tracker.maps) runs through it; the other ids are the seo-ops
 * loops still to come and run nothing yet.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeModeActive } from '../safe-mode.js';
import { createSeoOpsStore, defaultSeoOpsSettings } from './store.js';

export const SEO_SCHEDULERS = Object.freeze([
  Object.freeze({ id: 'rank-tracker.maps', purpose: 'maps' }),
  Object.freeze({ id: 'rank-tracker.organic', purpose: 'tracking' }),
  Object.freeze({ id: 'report', purpose: 'tracking' }),
  Object.freeze({ id: 'blog-scheduler', purpose: 'local' }),
  Object.freeze({ id: 'local-pack', purpose: 'local' }),
  Object.freeze({ id: 'ai-visibility', purpose: 'aiVisibility' }),
  Object.freeze({ id: 'live-audit', purpose: 'audits' }),
  Object.freeze({ id: 'health-probe', purpose: 'audits' }),
]);

export const DEFAULT_DFS_FIXTURES_DIR = resolve(fileURLToPath(new URL('../../scripts/fixtures/seo-ops/dfs', import.meta.url)));
const DFS_HOST = 'api.dataforseo.com';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function urlOf(input) {
  try {
    return new URL(typeof input === 'string' ? input : input?.url || String(input));
  } catch {
    return null;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The fixture file name for a DataForSEO path: /v3/serp/google/maps/live/advanced -> serp__google__maps__live__advanced.json */
export function dfsFixtureName(pathname) {
  return `${String(pathname || '').replace(/^\/v3\//, '').replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9/_-]/gi, '').split('/').join('__')}.json`;
}

function zeroCost(value) {
  if (Array.isArray(value)) return value.map(zeroCost);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) out[key] = key === 'cost' ? 0 : zeroCost(inner);
  return out;
}

/**
 * A fetch that never leaves the process: DataForSEO paths answer with their recorded fixture (cost
 * set to 0) or an empty successful task; anything else answers 200 with an empty list.
 */
export function createReplayFetch({ fixturesDir = DEFAULT_DFS_FIXTURES_DIR, onCall = null } = {}) {
  return async function replayFetch(input) {
    const url = urlOf(input);
    onCall?.({ url: url?.href || String(input), replayed: true });
    if (url?.hostname !== DFS_HOST) return jsonResponse([]);
    const file = join(fixturesDir, dfsFixtureName(url.pathname));
    if (existsSync(file)) {
      try {
        return jsonResponse(zeroCost(JSON.parse(readFileSync(file, 'utf8'))));
      } catch {
        // a broken fixture answers like a missing one
      }
    }
    return jsonResponse({
      status_code: 20000,
      cost: 0,
      tasks: [{ status_code: 20000, status_message: 'Replayed (no fixture).', cost: 0, result: [{ items: [], check_url: '', datetime: new Date().toISOString() }] }],
    });
  };
}

/** Live fetch in safe mode: real calls until `capUsd` (summed from DataForSEO task costs) is spent. */
function createCappedFetch({ capUsd, fetchImpl = globalThis.fetch, spent }) {
  return async function cappedFetch(input, init) {
    const url = urlOf(input);
    if (url?.hostname === DFS_HOST && spent.usd >= capUsd) {
      const error = new Error(`safe-mode spend cap of $${capUsd} reached for this process`);
      error.code = 'safe-mode-cap';
      throw error;
    }
    const response = await fetchImpl(input, init);
    if (url?.hostname === DFS_HOST) {
      try {
        const body = await response.clone().json();
        spent.usd += Number(body?.tasks?.[0]?.cost ?? body?.cost) || 0;
      } catch {
        // unreadable body: nothing to add
      }
    }
    return response;
  };
}

function schedulerConfig(def, settings) {
  const safe = { ...defaultSeoOpsSettings().safeMode, ...(isPlainObject(settings?.safeMode) ? settings.safeMode : {}) };
  const own = isPlainObject(safe.schedulers?.[def.id]) ? safe.schedulers[def.id] : {};
  const allowSites = Array.isArray(own.allowSites) ? own.allowSites : (Array.isArray(safe.allowSites) ? safe.allowSites : []);
  const cap = Number(own.spendCapUsd ?? safe.spendCapUsd);
  return {
    id: def.id,
    purpose: def.purpose,
    allowSites: allowSites.map((key) => String(key)),
    spendCapUsd: Number.isFinite(cap) && cap >= 0 ? cap : 0,
    live: (own.live ?? safe.live) === true,
    fixturesDir: String(own.fixturesDir || safe.fixturesDir || DEFAULT_DFS_FIXTURES_DIR),
  };
}

/**
 * The registry for one settings snapshot. `safeMode` defaults to the hub's state; `fetchImpl` is
 * the real fetch used for live calls; `onCall` sees every replayed call (tests count them).
 */
export function createSeoSchedulerRegistry({ settings = null, safeMode = isSafeModeActive(), fetchImpl = undefined, onCall = null } = {}) {
  // With safe mode off nothing here depends on settings, so none are read. An unreadable settings
  // file in safe mode counts as the defaults: no site allow-listed.
  let resolved = settings;
  if (!resolved && safeMode) {
    try {
      resolved = createSeoOpsStore().readSettings();
    } catch {
      resolved = defaultSeoOpsSettings();
    }
  }
  const entries = new Map(SEO_SCHEDULERS.map((def) => [def.id, schedulerConfig(def, resolved)]));
  const spent = new Map();

  function planFor(id, siteKey) {
    const entry = entries.get(id);
    if (!entry) return { run: false, live: false, replay: false, spendCapUsd: 0, reason: `unknown scheduler ${id}` };
    if (!safeMode) return { run: true, live: true, replay: false, spendCapUsd: null, reason: 'safe mode is off' };
    const key = String(siteKey || '');
    if (!key || !entry.allowSites.includes(key)) {
      return { run: false, live: false, replay: false, spendCapUsd: entry.spendCapUsd, reason: 'hub safe mode: the site is not allow-listed for this scheduler' };
    }
    if (!entry.live) {
      return { run: true, live: false, replay: true, spendCapUsd: entry.spendCapUsd, reason: 'safe mode: replaying fixtures', fetchImpl: createReplayFetch({ fixturesDir: entry.fixturesDir, onCall }) };
    }
    if (!spent.has(id)) spent.set(id, { usd: 0 });
    return {
      run: true,
      live: true,
      replay: false,
      spendCapUsd: entry.spendCapUsd,
      reason: 'safe mode: live within the spend cap',
      fetchImpl: createCappedFetch({ capUsd: entry.spendCapUsd, fetchImpl: fetchImpl || globalThis.fetch, spent: spent.get(id) }),
    };
  }

  return {
    safeMode,
    list: () => [...entries.values()].map((entry) => ({ ...entry, allowSites: [...entry.allowSites] })),
    get: (id) => (entries.has(id) ? { ...entries.get(id), allowSites: [...entries.get(id).allowSites] } : null),
    planFor,
    spentUsd: (id) => spent.get(id)?.usd || 0,
  };
}

/** One scheduler of a fresh registry: { id, planFor(siteKey) }. */
export function seoScheduler(id, options = {}) {
  const registry = createSeoSchedulerRegistry(options);
  return { id, registry, planFor: (siteKey) => registry.planFor(id, siteKey) };
}
