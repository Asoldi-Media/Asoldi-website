/**
 * Keyword research jobs for the delivery queue.
 *
 * The producer decides when a job is due and enqueues it. Research itself happens elsewhere.
 * Two switches gate it: development.seoJobs and seo.jobGating. Either one off (jobGating counts
 * as off when enabled is not true or it is paused) and runSeoJobProducer returns immediately:
 * it does not read its state file and it does not write. Mode is not a third gate.
 *
 * seo.refresh: one job when the SEO inputs hash changes. The hash is sha256 over canonical JSON
 * (keys sorted, no spaces) of tierId, sorted unique site-plan services, approved keywords
 * (NFC, lower case, unique, sorted) and trimmed audience values (sorted). The first time a
 * client is seen only records the hash. A note or any other brief field does not change it.
 * The dedupe key is seo.refresh:<client id>:<first 16 hex of the new hash>. The recorded hash
 * moves forward only after the queue accepts the job. A duplicate answer does not.
 *
 * seo.maintenance: one job per Europe/Oslo calendar month for a client whose go-live has
 * happened and whose tier level is 2 or higher. An unresolved tier, including custom, is level
 * 0. The dedupe key is seo.maintenance:<client id>:<YYYY-MM>.
 *
 * A cancelled, ended or paused contract queues nothing: lifecycleJobBlock answers
 * contract-ended or paused when that client's cancellation switch is in auto.
 *
 * The payload is ids, hashes and enums only (seo-jobs/1). An enqueue that fails does not
 * advance that client's hash or month, so the next tick retries. One client's error does not
 * stop the others. A state file that is not versioned JSON is copied to a sibling .bak once
 * and then read as empty, which is first sight for every client.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeDataJson } from '../../data/storage-path.js';
import { computeBriefHash } from '../delivery-brief/store.js';
import { CLIENT_ID_RE, hashOf, isPlainObject, text } from '../delivery-brief/text.js';
import { lifecycleJobBlock } from '../delivery-lifecycle.js';
import { seoPhraseKey } from './phrase-filters.js';
import { resolveTier } from '../website-tiers.js';

const STATE_NAME = join('seo-ops', 'keyword-jobs.json');
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_LIST = 50;
const OSLO_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function emptyInputs() {
  return { tierId: '', services: [], agreedKeywords: [], audience: [] };
}

function emptyState() {
  return { version: 1, updatedAt: '', clients: {} };
}

/**
 * True when both keyword-job switches allow a run. jobGating is off when it is missing,
 * disabled, or paused. shadow and auto are both on: mode belongs to the other gating decision.
 * @param {object} [settings]
 * @returns {boolean}
 */
export function keywordJobsOn(settings) {
  if (settings?.development?.seoJobs !== true) return false;
  const node = settings?.seo?.jobGating;
  if (!isPlainObject(node) || node.enabled !== true || node.paused) return false;
  return true;
}

/** State file for the producer. One JSON object, version 1. */
export function keywordJobsStatePath(dataDir) {
  return join(dataDir, STATE_NAME);
}

function toMs(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  const parsed = Date.parse(String(now ?? ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** Europe/Oslo calendar month (YYYY-MM). An ISO string is an instant, not already a calendar day. */
function osloMonth(now) {
  const ms = toMs(now);
  if (!Number.isFinite(ms)) return '';
  const day = OSLO_DAY.format(new Date(ms));
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(0, 7) : '';
}

function stamp(value) {
  const raw = text(value, 40);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : '';
}

function stringList(list, maxLen) {
  const seen = new Set();
  let out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const value = text(entry, maxLen);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out = [...out, value];
    if (out.length >= MAX_LIST) break;
  }
  return out.sort();
}

function approvedKeywords(brief) {
  const list = Array.isArray(brief?.seo?.agreedKeywords) ? brief.seo.agreedKeywords : [];
  const seen = new Set();
  let out = [];
  for (const row of list) {
    if (isPlainObject(row) && row.status !== 'approved') continue;
    if (!isPlainObject(row) && typeof row !== 'string') continue;
    const raw = typeof row === 'string' ? row : (row.phrase || row.keyword || '');
    const key = seoPhraseKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out = [...out, key];
    if (out.length >= MAX_LIST) break;
  }
  return out.sort();
}

function audienceValues(brief) {
  const raw = brief?.facts?.positioning?.audience;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const seen = new Set();
  let out = [];
  for (const entry of list) {
    const value = text(entry, 500).normalize('NFC');
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out = [...out, value];
    if (out.length >= MAX_LIST) break;
  }
  return out.sort();
}

function readInputs(client, brief) {
  const plan = isPlainObject(brief.sitePlan) ? brief.sitePlan : (isPlainObject(client.sitePlan) ? client.sitePlan : {});
  return {
    tierId: text(plan.tierId || client.tierId, 40),
    services: stringList(plan.services, 40),
    agreedKeywords: approvedKeywords(brief),
    audience: audienceValues(brief),
  };
}

function cloneInputs(inputs) {
  const source = isPlainObject(inputs) ? inputs : {};
  return {
    tierId: text(source.tierId, 40),
    services: stringList(source.services, 40),
    agreedKeywords: stringList(source.agreedKeywords, 80),
    audience: stringList(source.audience, 500),
  };
}

function tierNumberOf(tierId) {
  const resolved = resolveTier(tierId);
  return Number.isInteger(resolved?.tierNumber) ? resolved.tierNumber : 0;
}

function clientLive(client) {
  const goLive = isPlainObject(client?.makerRun?.goLive) ? client.makerRun.goLive : {};
  const verified = (goLive.target === 'production' && stamp(goLive.liveVerifiedAt))
    || stamp(client?.delivery?.events?.liveVerifiedAt);
  if (verified) return true;
  return client?.progression?.live === true;
}

function briefVersionOf(brief) {
  const value = Number(brief?.version);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function briefHashOf(brief) {
  const given = text(brief?.hash, 80);
  if (HASH_RE.test(given)) return given;
  if (isPlainObject(brief)) return computeBriefHash(brief);
  return '';
}

function viewOf(client) {
  if (!isPlainObject(client)) return null;
  const id = text(client.id || client.salesClientId, 80);
  if (!CLIENT_ID_RE.test(id)) return null;
  const brief = isPlainObject(client.brief) ? client.brief : {};
  const inputs = readInputs(client, brief);
  return {
    id,
    runId: text(client.runId || client.makerRun?.runId, 80),
    inputs,
    hash: hashOf(inputs),
    briefVersion: briefVersionOf(brief),
    briefHash: briefHashOf(brief),
    live: clientLive(client),
    tier: tierNumberOf(inputs.tierId),
  };
}

function changedFields(before, after) {
  const left = cloneInputs(before);
  const right = cloneInputs(after);
  let changed = [];
  if (left.tierId !== right.tierId) changed = [...changed, 'tier'];
  if (JSON.stringify(left.services) !== JSON.stringify(right.services)) changed = [...changed, 'services'];
  if (JSON.stringify(left.agreedKeywords) !== JSON.stringify(right.agreedKeywords)) changed = [...changed, 'agreedKeywords'];
  if (JSON.stringify(left.audience) !== JSON.stringify(right.audience)) changed = [...changed, 'audience'];
  return changed;
}

function refreshInput(view, previousHash, changed) {
  return {
    contract: 'seo-jobs/1',
    trigger: 'brief-changed',
    mode: changed.length === 1 && changed[0] === 'agreedKeywords' ? 'agreed-only' : 'full',
    changed,
    seoInputsHash: view.hash,
    previousSeoInputsHash: previousHash,
    briefVersion: view.briefVersion,
    briefHash: view.briefHash,
    tierId: view.inputs.tierId,
    dedupeKey: `seo.refresh:${view.id}:${view.hash.slice(7, 23)}`,
  };
}

function maintenanceInput(view, period) {
  return {
    contract: 'seo-jobs/1',
    trigger: 'monthly',
    mode: 'maintenance',
    period,
    tierId: view.inputs.tierId,
    dedupeKey: `seo.maintenance:${view.id}:${period}`,
  };
}

function jobOf(view, kind, input) {
  return {
    salesClientId: view.id,
    kind,
    ...(view.runId ? { runId: view.runId } : {}),
    input,
    createdBy: 'keyword-jobs',
  };
}

function rowFrom(raw) {
  const period = text(raw?.lastMaintenancePeriod, 7);
  return {
    seoInputsHash: text(raw?.seoInputsHash, 80),
    inputs: cloneInputs(raw?.inputs),
    lastRefreshKey: text(raw?.lastRefreshKey, 200),
    lastMaintenancePeriod: /^\d{4}-\d{2}$/.test(period) ? period : '',
  };
}

function normalizeState(raw) {
  const clients = {};
  const source = isPlainObject(raw?.clients) ? raw.clients : {};
  for (const id of Object.keys(source).sort()) {
    if (!CLIENT_ID_RE.test(id) || !isPlainObject(source[id])) continue;
    clients[id] = rowFrom(source[id]);
  }
  return { version: 1, updatedAt: text(raw?.updatedAt, 40), clients };
}

function blocked(client, kind, settings, now) {
  return lifecycleJobBlock(client, kind, { settings, now }) !== '';
}

/**
 * Plans seo.refresh and seo.maintenance for one tick. Pure: it does not read or write
 * the state file, and it does not mutate `state` or `clients`.
 * @param {object} [options]
 * @param {object[]} [options.clients]
 * @param {object} [options.settings]
 * @param {number|string} [options.now]
 * @param {object} [options.state]
 * @returns {{ enqueue: object[], state: object }}
 */
export function planSeoJobs({ clients = [], settings, now, state } = {}) {
  const current = normalizeState(state);
  if (!keywordJobsOn(settings)) return { enqueue: [], state: current };
  const next = normalizeState(state);
  let enqueue = [];
  const period = osloMonth(now);
  for (const client of Array.isArray(clients) ? clients : []) {
    const view = viewOf(client);
    if (!view) continue;
    const refreshBlocked = blocked(client, 'seo.refresh', settings, now);
    const maintenanceBlocked = blocked(client, 'seo.maintenance', settings, now);
    if (refreshBlocked && maintenanceBlocked) continue;
    if (!refreshBlocked) {
      const prior = next.clients[view.id] || null;
      if (!prior || !HASH_RE.test(prior.seoInputsHash)) {
        next.clients[view.id] = {
          seoInputsHash: view.hash,
          inputs: cloneInputs(view.inputs),
          lastRefreshKey: prior?.lastRefreshKey || '',
          lastMaintenancePeriod: prior?.lastMaintenancePeriod || '',
        };
      } else if (prior.seoInputsHash !== view.hash) {
        const changed = changedFields(prior.inputs, view.inputs);
        if (changed.length && HASH_RE.test(view.briefHash) && HASH_RE.test(view.hash)) {
          const input = refreshInput(view, prior.seoInputsHash, changed);
          next.clients[view.id] = {
            seoInputsHash: view.hash,
            inputs: cloneInputs(view.inputs),
            lastRefreshKey: input.dedupeKey,
            lastMaintenancePeriod: prior.lastMaintenancePeriod,
          };
          enqueue = [...enqueue, jobOf(view, 'seo.refresh', input)];
        }
      }
    }
    if (!maintenanceBlocked && view.live && view.tier >= 2 && period) {
      const row = next.clients[view.id] || {
        seoInputsHash: view.hash,
        inputs: cloneInputs(view.inputs),
        lastRefreshKey: '',
        lastMaintenancePeriod: '',
      };
      if (row.lastMaintenancePeriod !== period) {
        next.clients[view.id] = { ...row, lastMaintenancePeriod: period };
        enqueue = [...enqueue, jobOf(view, 'seo.maintenance', maintenanceInput(view, period))];
      }
    }
  }
  return { enqueue, state: next };
}

function quarantine(path, raw) {
  const bak = `${path}.bak`;
  if (!existsSync(bak)) writeFileSync(bak, raw);
  return { state: emptyState(), corrupt: true, quarantined: existsSync(bak) };
}

function readStateFile(path) {
  if (!existsSync(path)) return { state: emptyState(), corrupt: false, quarantined: false };
  const raw = readFileSync(path, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.clients)) return quarantine(path, raw);
    return { state: normalizeState(parsed), corrupt: false, quarantined: false };
  } catch {
    return quarantine(path, raw);
  }
}

function writeStateFile(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeDataJson(path, state, { backupName: 'seo-ops__keyword-jobs.json', latest: false, atomic: true, keep: 2 });
}

function accepted(result) {
  return result?.ok === true;
}

function restore(state, previous, clientId, kind) {
  const row = state.clients[clientId];
  if (!row) return;
  const prior = previous.clients[clientId];
  if (kind === 'seo.refresh') {
    row.seoInputsHash = prior?.seoInputsHash || '';
    row.inputs = cloneInputs(prior?.inputs);
    row.lastRefreshKey = prior?.lastRefreshKey || '';
    return;
  }
  if (kind === 'seo.maintenance') row.lastMaintenancePeriod = prior?.lastMaintenancePeriod || '';
}

async function defaultClients(deps) {
  const list = typeof deps.sales?.getSalesClients === 'function' ? deps.sales.getSalesClients() : [];
  const { readLatestBrief } = await import('../delivery-brief/store.js');
  let out = [];
  for (const client of Array.isArray(list) ? list : []) {
    let brief = isPlainObject(client?.brief) ? client.brief : null;
    if (!brief && client?.id) {
      try {
        brief = readLatestBrief(client.id, { dataDir: deps.dataDir });
      } catch {
        brief = null;
      }
    }
    out = [...out, { ...client, brief: isPlainObject(brief) ? brief : null }];
  }
  return out;
}

async function defaultEnqueue(job, deps) {
  const { enqueueJob } = await import('../delivery-jobs.js');
  const at = toMs(deps.now);
  return enqueueJob({
    salesClientId: job.salesClientId,
    kind: job.kind,
    runId: job.runId || '',
    input: job.input,
    createdBy: job.createdBy || 'keyword-jobs',
  }, {
    dataDir: deps.dataDir,
    now: Number.isFinite(at) ? at : Date.now(),
    sales: deps.sales || null,
    settings: deps.settings || null,
  });
}

/**
 * Reads clients and producer state, plans jobs, enqueues them and stores the state.
 * Every dependency may be injected. With either switch off, returns `{ ran: false }` and
 * touches nothing else. Does not call any network.
 * @param {object} [deps]
 * @returns {Promise<{ ran: boolean, enqueued?: object[], errors?: object[], clientsRead?: number, state?: object, stateReport?: string }>}
 */
export async function runSeoJobProducer(deps = {}) {
  if (!keywordJobsOn(deps.settings)) return { ran: false };
  const path = deps.statePath || (deps.dataDir ? keywordJobsStatePath(deps.dataDir) : '');
  let loaded;
  if (typeof deps.readState === 'function') loaded = { state: normalizeState(await deps.readState()), corrupt: false, quarantined: false };
  else if (path) loaded = readStateFile(path);
  else loaded = { state: emptyState(), corrupt: false, quarantined: false };
  const clients = typeof deps.readClients === 'function' ? await deps.readClients() : await defaultClients(deps);
  const list = Array.isArray(clients) ? clients : [];
  const previous = normalizeState(loaded.state);
  const plan = planSeoJobs({ clients: list, settings: deps.settings, now: deps.now, state: structuredClone(previous) });
  const next = structuredClone(plan.state);
  const enqueue = typeof deps.enqueue === 'function' ? deps.enqueue : (job) => defaultEnqueue(job, deps);
  let enqueued = [];
  let errors = [];
  for (const item of plan.enqueue) {
    try {
      const result = await enqueue(item);
      if (!accepted(result)) {
        errors = [...errors, { clientId: item.salesClientId, kind: item.kind, message: text(result?.code || result?.error || 'enqueue-failed', 160) }];
        restore(next, previous, item.salesClientId, item.kind);
        continue;
      }
      enqueued = [...enqueued, item.input];
    } catch (error) {
      errors = [...errors, { clientId: item.salesClientId, kind: item.kind, message: text(error?.message || error, 160) }];
      restore(next, previous, item.salesClientId, item.kind);
    }
  }
  const stored = normalizeState(next);
  const same = JSON.stringify(stored.clients) === JSON.stringify(previous.clients);
  const repair = loaded.corrupt === true && loaded.quarantined === true;
  const hold = loaded.corrupt === true && loaded.quarantined !== true;
  let written = previous;
  if (!hold && (!same || repair)) {
    const at = toMs(deps.now);
    written = { ...stored, updatedAt: new Date(Number.isFinite(at) ? at : Date.now()).toISOString() };
    try {
      if (typeof deps.writeState === 'function') await deps.writeState(written);
      else if (path) writeStateFile(path, written);
    } catch (error) {
      errors = [...errors, { clientId: '', kind: 'state', message: text(error?.message || error, 160) }];
    }
  }
  return {
    ran: true,
    enqueued,
    errors,
    clientsRead: list.length,
    state: written,
    stateReport: loaded.corrupt ? 'corrupt' : '',
  };
}
