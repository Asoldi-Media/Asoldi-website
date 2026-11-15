// Delivery loop: one tick every 60 s that moves signed clients along (stage, jobs, alerts and the
// steps other modules plug in through lib/delivery-steps.js).
//
// Switch: automation settings `delivery.loop` = { enabled, mode: 'shadow' | 'auto', paused }.
//   - Off (the default): a tick returns at once. It takes no lease and reads and writes nothing
//     but the settings file.
//   - Paused: only steps marked whenPaused (alerts) run.
//   - Per client the mode is spineModeForClient('delivery.loop', client): 'auto' only for pilot
//     clients, 'shadow' for everyone else. In shadow a step writes delivery-audit records only
//     (ctx.shadow dedupes them, so an unchanged client is not recorded again).
//
// Clients in scope: signed website clients, clients marked dirty (markDirty) and clients in an
// active nurture. Each tick holds the lease 'delivery-loop' (90 s, renewed every 30 s while the
// tick runs), so two hub processes on one data dir never tick together; a tick whose lease cannot
// be renewed stops after the step or client it is on and stores nothing more. Dirty marks and
// step schedules live in delivery-hot/ and survive a restart; a mark is cleared only after every
// client step ran for that client without an error.
// Loop health goes to delivery-hot/loop-health.json at most every 5 minutes; a tick that changes
// nothing writes nothing.
//
// The core steps here: 'stage' persists deriveStage for auto clients (one batch write), and
// 'phases' runs the hub-site phase reconcile and the developer-owner seeding for auto clients.
// For every other client the development GET keeps doing both (developmentGetLoopScope).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLease } from '../data/email-store.js';
import { effectiveSwitchMode, getAutomationSettings, readAutomationSettingsFile, releasePassedFor } from '../data/automation-settings.js';
import { appendDeliveryAudit, appendDeliveryAuditBatch } from './delivery-audit.js';
import { jobsByClient } from './delivery-jobs.js';
import { planStageWrite } from './delivery-state.js';
import { assertTickStep, loadTickSteps, sortTickSteps } from './delivery-steps.js';
import { canonicalDeveloperOwnerId } from './developer-assignment.js';
import { linkedSalesClientIndex } from './development-phase.js';
import { hotPath, readHotJson, updateHotJson, writeHotJson } from './hot-store.js';
import { LOOP_HEALTH_FILE } from './maker-host-meta.js';
import { isSafeModeActive } from './safe-mode.js';
import { spineModeForClient } from './spine-mode.js';

export const LOOP_SWITCH = 'delivery.loop';
export const TICK_INTERVAL_MS = 60_000;
export const LOOP_LEASE_NAME = 'delivery-loop';
export const LOOP_LEASE_MS = 90_000;
export const HEALTH_WRITE_MS = 5 * 60 * 1000;
export const STALL_MS = 15 * 60 * 1000;
export const LOOP_STATE_FILE = join('delivery-hot', 'loop-state.json');
export const LOOP_DIRTY_FILE = join('delivery-hot', 'loop-dirty.json');
export { LOOP_HEALTH_FILE };
const SHADOW_MEMO_MAX = 5000;
const LAST_ERRORS_MAX = 20;
const STORAGE_CACHE_MS = 60_000;
const STORAGE_MAX_FILES = 50_000;
const STORAGE_YIELD_EVERY = 250;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function errorText(error) {
  return String(error?.message || error || 'error').replace(/\s+/g, ' ').slice(0, 300);
}

// ---------------------------------------------------------------- switch and scope

export function deliveryLoopSettings(settings) {
  const node = settings?.delivery?.loop;
  return isPlainObject(node) ? node : { enabled: false, mode: 'shadow', paused: null };
}

export function deliveryLoopEnabled(settings) {
  return deliveryLoopSettings(settings).enabled === true;
}

/**
 * off | paused | shadow | auto for the loop as a whole ('auto' needs a pilot list and a recorded
 * release pass for delivery.loop).
 */
export function globalLoopMode(settings) {
  if (!deliveryLoopEnabled(settings)) return 'off';
  const mode = effectiveSwitchMode(LOOP_SWITCH, { settings });
  if (mode !== 'auto') return mode;
  if (!(Array.isArray(settings.pilotClientIds) && settings.pilotClientIds.length)) return 'shadow';
  return releasePassedFor(LOOP_SWITCH, settings) ? 'auto' : 'shadow';
}

function isWebsiteClient(client) {
  return Boolean(client?.id) && String(client.product || '').trim().toLowerCase() !== 'ssu';
}

function isNurtured(client) {
  const nurture = client?.nurture;
  return isPlainObject(nurture) && nurture.state === 'deferred' && !nurture.stopReason && !nurture.unsubscribedAt;
}

/** Why a client is in the loop's scope ('signed', 'dirty', 'nurture'), or '' when it is not. */
export function clientInLoopScope(client, dirty = {}) {
  if (!isWebsiteClient(client)) return '';
  if (client.progression?.contractSigned === true || client.sitePlan?.status === 'active') return 'signed';
  if (dirty && Object.prototype.hasOwnProperty.call(dirty, client.id)) return 'dirty';
  if (isNurtured(client)) return 'nurture';
  return '';
}

// ---------------------------------------------------------------- dirty marks and state

function dirtyPath(dataDir) {
  return hotPath(LOOP_DIRTY_FILE, { dataDir });
}

function statePath(dataDir) {
  return hotPath(LOOP_STATE_FILE, { dataDir });
}

function healthPath(dataDir) {
  return hotPath(LOOP_HEALTH_FILE, { dataDir });
}

/** { clientId: markedAt } */
export function readDirtyMarks({ dataDir, fresh = false } = {}) {
  const raw = readHotJson(dirtyPath(dataDir), { fresh });
  return isPlainObject(raw?.clients) ? { ...raw.clients } : {};
}

/**
 * Asks the next tick to look at a client (a fact it depends on changed). Does nothing and
 * returns false while delivery.loop is off.
 */
export function markDirty(clientId, { dataDir, now = Date.now(), settings = null } = {}) {
  const id = String(clientId || '').trim();
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return false;
  const resolved = settings || getAutomationSettings({ dataDir });
  if (!deliveryLoopEnabled(resolved)) return false;
  const at = iso(toMs(now) || Date.now());
  updateHotJson(dirtyPath(dataDir), (raw) => {
    const clients = isPlainObject(raw?.clients) ? { ...raw.clients } : {};
    if (clients[id]) return undefined;
    clients[id] = at;
    return { version: 1, clients };
  });
  return true;
}

function clearDirtyMarks(dataDir, cleared) {
  if (!cleared.length) return false;
  let wrote = false;
  updateHotJson(dirtyPath(dataDir), (raw) => {
    const clients = isPlainObject(raw?.clients) ? { ...raw.clients } : {};
    let changed = false;
    for (const { id, at } of cleared) {
      // A mark set again during the tick (newer than the one this tick saw) stays.
      if (clients[id] && clients[id] === at) {
        delete clients[id];
        changed = true;
      }
    }
    if (!changed) return undefined;
    wrote = true;
    return { version: 1, clients };
  });
  return wrote;
}

function readState(dataDir) {
  const raw = readHotJson(statePath(dataDir), { fresh: true });
  return {
    stepRuns: isPlainObject(raw?.stepRuns) ? { ...raw.stepRuns } : {},
    shadow: isPlainObject(raw?.shadow) ? { ...raw.shadow } : {},
  };
}

export function readLoopHealth({ dataDir } = {}) {
  return readHotJson(healthPath(dataDir), { fresh: true });
}

/** When delivery.loop.enabled was last switched on (settings audit), in ms; 0 when unknown. */
export function loopSwitchedOnAt({ dataDir } = {}) {
  try {
    const { audit } = readAutomationSettingsFile({ dataDir });
    for (let index = audit.length - 1; index >= 0; index -= 1) {
      const entry = audit[index];
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      if (changes.some((change) => change?.path === 'delivery.loop.enabled' && change.to === true)) return toMs(entry.at);
    }
  } catch {
    // no audit: unknown
  }
  return 0;
}

function hashOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

// ---------------------------------------------------------------- core steps

/** Persists the derived stage for auto clients (one batch write); shadow clients get a record. */
export const stageStep = {
  name: 'stage',
  order: 80,
  scope: 'global',
  run: async (ctx) => {
    const jobs = jobsByClient({ dataDir: ctx.dataDir });
    const auto = [];
    let recorded = 0;
    for (const { client, mode } of ctx.clients) {
      if (!isWebsiteClient(client)) continue;
      const clientJobs = jobs.get(client.id);
      if (mode === 'auto') {
        // Only clients whose stage moves go to the writer, so a quiet tick reads no store again.
        if (planStageWrite(client, { now: ctx.now, jobs: clientJobs }).changed) auto.push({ id: client.id, jobs: clientJobs });
      } else if (mode === 'shadow') {
        const plan = planStageWrite(client, { now: ctx.now, jobs: clientJobs });
        if (plan.changed && ctx.shadow(`stage:${client.id}`, { step: 'stage', clientId: client.id, from: plan.change.from || '', to: plan.change.to, overlay: plan.change.overlay })) recorded += 1;
      }
    }
    let changed = [];
    if (auto.length && typeof ctx.sales?.syncSalesDeliveryStages === 'function') {
      changed = ctx.sales.syncSalesDeliveryStages(auto, { by: 'loop', reason: 'tick', now: ctx.now }).changed || [];
    }
    return { wrote: changed.length > 0 || recorded > 0, changed: changed.length, recorded };
  },
};

/** Hub-site phases and developer owners, for auto clients only. */
export const phasesStep = {
  name: 'phases',
  order: 90,
  scope: 'global',
  run: async (ctx) => {
    const autoIds = new Set(ctx.clients.filter((row) => row.mode === 'auto').map((row) => row.client.id));
    if (!autoIds.size) return { wrote: false };
    const all = ctx.allClients;
    const linked = linkedSalesClientIndex(all);
    let reconciled = 0;
    if (typeof ctx.hub?.reconcileDeliveryPhases === 'function') {
      const result = ctx.hub.reconcileDeliveryPhases(all, { siteFilter: (site) => autoIds.has(linked(site)?.id) });
      reconciled = Number(result?.changed) || 0;
    }
    const include = (client) => autoIds.has(client?.id);
    // The owner writers read and rewrite the client store; call them only when an auto client needs an owner.
    const ownerMissing = all.some((client) => {
      if (!autoIds.has(client.id) || !isWebsiteClient(client)) return false;
      const owner = String(client.developerOwnerId || '').trim();
      return !owner || canonicalDeveloperOwnerId(owner) !== owner;
    });
    // Until the development GET has run the one-time seed, auto clients get it here. The scoped seed
    // never marks the seed done, so the GET still seeds every other client once, as before.
    const seed = ownerMissing && typeof ctx.sales?.seedExistingDeveloperOwnersToAdmin === 'function' ? ctx.sales.seedExistingDeveloperOwnersToAdmin({ include }) : null;
    const seeded = Number(seed?.assignedCount) || 0;
    let assigned = 0;
    if (ownerMissing && !seeded && typeof ctx.deps?.listDeveloperOwnerOptions === 'function' && typeof ctx.sales?.assignOpenDeveloperClientsToAdmin === 'function') {
      const options = await ctx.deps.listDeveloperOwnerOptions();
      const onlyAdmin = !(Array.isArray(options) ? options : []).some((row) => String(row?.accountKey || '').trim().startsWith('developer:'));
      if (onlyAdmin) assigned = Number(ctx.sales.assignOpenDeveloperClientsToAdmin({ include })?.assignedCount) || 0;
    }
    return { wrote: reconciled + seeded + assigned > 0, reconciled, seeded, assigned };
  },
};

export const CORE_STEPS = Object.freeze([stageStep, phasesStep]);

// ---------------------------------------------------------------- development GET split

/**
 * What the development GET passes to its reconcile and owner writers. While the loop is off (or
 * owns no client) both are undefined, so the GET runs exactly as before. Otherwise the GET skips
 * the sites and clients the loop handles. `getClients` is only called when the loop is on.
 */
export function developmentGetLoopScope(getClients, { dataDir, settings: given = null } = {}) {
  const settings = given || getAutomationSettings({ dataDir });
  const mode = globalLoopMode(settings);
  if (mode === 'off' || mode === 'paused') return { reconcile: undefined, owners: undefined, owned: new Set() };
  const clients = typeof getClients === 'function' ? getClients() : [];
  const linked = linkedSalesClientIndex(clients);
  const dirty = readDirtyMarks({ dataDir });
  const owned = new Set();
  for (const client of Array.isArray(clients) ? clients : []) {
    if (!clientInLoopScope(client, dirty)) continue;
    if (spineModeForClient(LOOP_SWITCH, client, { settings, dataDir }) === 'auto') owned.add(client.id);
  }
  if (!owned.size) return { reconcile: undefined, owners: undefined, owned };
  return {
    owned,
    reconcile: { siteFilter: (site) => !owned.has(linked(site)?.id) },
    owners: { include: (client) => !owned.has(client?.id) },
  };
}

// ---------------------------------------------------------------- storage report

let storageCache = { at: 0, dir: '', value: null, pending: null };

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Files and bytes under `path`, read with async fs calls; it yields every few hundred entries. */
async function walk(path, budget) {
  let files = 0;
  let bytes = 0;
  const stack = [path];
  while (stack.length && budget.left > 0) {
    const current = stack.pop();
    budget.seen += 1;
    if (budget.seen % STORAGE_YIELD_EVERY === 0) await nextTurn();
    let info;
    try {
      info = await stat(current);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      let names = [];
      try {
        names = await readdir(current);
      } catch {
        continue;
      }
      for (const name of names) stack.push(join(current, name));
    } else {
      files += 1;
      bytes += info.size;
      budget.left -= 1;
    }
  }
  return { files, bytes };
}

async function scanStorage(root, now) {
  const budget = { left: STORAGE_MAX_FILES, seen: 0 };
  const stores = {};
  let files = 0;
  let bytes = 0;
  let names = [];
  try {
    names = existsSync(root) ? await readdir(root) : [];
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    const usage = await walk(join(root, name), budget);
    stores[name] = usage;
    files += usage.files;
    bytes += usage.bytes;
  }
  return { at: iso(now), total: { files, bytes }, stores, truncated: budget.left <= 0 };
}

/**
 * File count and bytes per top-level entry of the data dir. The walk uses async fs calls, so it
 * never holds the event loop; one scan runs at a time. A report younger than a minute is returned
 * as is; an older one is returned at once while a new scan runs (the next call gets that one).
 */
export async function deliveryStorageReport({ dataDir, now = Date.now() } = {}) {
  const root = hotPath('', { dataDir });
  const sameDir = storageCache.dir === root;
  if (sameDir && storageCache.value && now - storageCache.at < STORAGE_CACHE_MS) return storageCache.value;
  if (!sameDir || !storageCache.pending) {
    const pending = scanStorage(root, now)
      .then((value) => {
        if (storageCache.pending === pending) storageCache = { at: now, dir: root, value, pending: null };
        return value;
      })
      .catch((error) => {
        if (storageCache.pending === pending) storageCache = { ...storageCache, pending: null };
        throw error;
      });
    storageCache = { ...(sameDir ? storageCache : { at: 0, value: null }), dir: root, pending };
  }
  if (sameDir && storageCache.value) return { ...storageCache.value, refreshing: true };
  return storageCache.pending;
}

// ---------------------------------------------------------------- the loop

function emptyHealth() {
  return {
    version: 1,
    lastTickAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    mode: 'off',
    ticks: 0,
    skipped: { lease: 0, busy: 0 },
    clientsInScope: 0,
    steps: {},
    lastErrors: [],
  };
}

/**
 * deps: sales (data/sales.js), hub (data/hub.js), dataDir, log, now() (ms),
 * listDeveloperOwnerOptions() (async; for the owner seeding), steps (replaces the module
 * steps, for tests), leaseMs, acquireLease (tests).
 */
export function createDeliveryLoop(initialDeps = {}) {
  const deps = { log: console, now: () => Date.now(), ...initialDeps };
  let steps = null;
  let stepErrors = [];
  let extra = [];
  let running = false;
  let timer = null;
  let lastHealthWriteAt = -Infinity;
  // The last time a tick found the loop off (memory only: an off loop writes nothing). A success
  // stored before that is from before the off period and is no outage.
  let offSeenAt = 0;
  const health = emptyHealth();

  async function loadSteps() {
    if (steps) return steps;
    if (Array.isArray(deps.steps)) {
      steps = sortTickSteps(deps.steps.map((step) => assertTickStep(step, 'deps')));
      return steps;
    }
    const loaded = await loadTickSteps();
    stepErrors = loaded.errors;
    for (const error of loaded.errors) deps.log?.warn?.(`[delivery-loop] step module ${error.module} skipped: ${error.error}`);
    steps = sortTickSteps([...CORE_STEPS.map((step) => assertTickStep(step, 'core')), ...extra, ...loaded.steps]);
    return steps;
  }

  function noteError(step, error, clientId = '') {
    health.lastErrors = [...health.lastErrors, { at: iso(deps.now()), step, ...(clientId ? { clientId } : {}), error: errorText(error) }].slice(-LAST_ERRORS_MAX);
  }

  function writeHealth(now, { force = false } = {}) {
    const path = healthPath(deps.dataDir);
    if (!force && now - lastHealthWriteAt < HEALTH_WRITE_MS && existsSync(path)) return false;
    try {
      writeHotJson(path, { ...health, writtenAt: iso(now) });
      lastHealthWriteAt = now;
      return true;
    } catch (error) {
      deps.log?.warn?.(`[delivery-loop] could not write loop health: ${error?.code || errorText(error)}`);
      return false;
    }
  }

  // The writes the development GET used to make on every call (deps.legacyDevelopmentWrites, set by
  // server.js). They run whatever the loop switch says; with no such dependency nothing happens here.
  async function runLegacyDevelopmentWrites(now, settings) {
    if (typeof deps.legacyDevelopmentWrites !== 'function') return;
    try {
      await deps.legacyDevelopmentWrites({ now, settings });
    } catch (error) {
      noteError('development-writes', error);
    }
  }

  async function runTick({ now: nowArg } = {}) {
    const now = toMs(nowArg) || deps.now();
    const settings = getAutomationSettings({ dataDir: deps.dataDir, fresh: true });
    const mode = globalLoopMode(settings);
    await runLegacyDevelopmentWrites(now, settings);
    if (mode === 'off') {
      offSeenAt = Math.max(offSeenAt, now);
      return { ran: false, reason: 'disabled' };
    }
    if (running) {
      health.skipped.busy += 1;
      return { ran: false, reason: 'busy' };
    }
    running = true;
    let lease = null;
    let keeper = null;
    try {
      const leaseMs = deps.leaseMs || LOOP_LEASE_MS;
      lease = await (deps.acquireLease || acquireLease)(LOOP_LEASE_NAME, leaseMs);
      if (!lease) {
        health.skipped.lease += 1;
        return { ran: false, reason: 'lease-held' };
      }
      keeper = keepLease(lease, leaseMs);
      return await tickBody({ now, settings, mode, keeper, clockOverride: Boolean(toMs(nowArg)) });
    } finally {
      keeper?.stop();
      running = false;
      if (lease) await lease.release().catch(() => false);
    }
  }

  /**
   * Renews the lease every third of its time while the tick runs, so a slow step (an LLM call, a
   * long client list) never lets it lapse. lost() turns true once a renewal fails: another process
   * may hold the lease then, and the tick stops at its next check.
   */
  function keepLease(lease, leaseMs) {
    let lost = false;
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      Promise.resolve()
        .then(() => lease.renew())
        .then((ok) => {
          if (!ok) lost = true;
        })
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          renewing = false;
        });
    }, Math.max(50, Math.floor(leaseMs / 3)));
    timer.unref?.();
    return {
      lost: () => lost,
      stop: () => clearInterval(timer),
    };
  }

  async function tickBody({ now, settings, mode, keeper, clockOverride }) {
    const started = performance.now();
    const list = await loadSteps();
    const previous = { lastTickAt: health.lastTickAt, lastSuccessAt: health.lastSuccessAt, ...(health.lastSuccessAt ? {} : pickPrevious(readLoopHealth({ dataDir: deps.dataDir }))) };
    const allClients = typeof deps.sales?.getSalesClients === 'function' ? deps.sales.getSalesClients() : [];
    const dirty = readDirtyMarks({ dataDir: deps.dataDir, fresh: true });
    const clients = [];
    for (const client of allClients) {
      const reason = clientInLoopScope(client, dirty);
      if (!reason) continue;
      clients.push({ client, reason, mode: spineModeForClient(LOOP_SWITCH, client, { settings, dataDir: deps.dataDir }) });
    }
    const state = readState(deps.dataDir);
    let stateChanged = false;
    const shadowRecords = [];
    const shadow = (key, record) => {
      const hash = hashOf(record);
      if (state.shadow[key] === hash) return false;
      state.shadow[key] = hash;
      stateChanged = true;
      shadowRecords.push({ kind: 'loop-shadow', ...record, at: iso(now) });
      return true;
    };
    const base = {
      now,
      settings,
      safeMode: isSafeModeActive(),
      log: deps.log,
      sales: deps.sales,
      hub: deps.hub,
      deps,
      dataDir: deps.dataDir,
      clients,
      allClients,
      loop: {
        previous,
        dirty,
        clockOverride,
        recentErrors: () => health.lastErrors.slice(),
        // When the loop was last off or switched on (ms): a success stored before it is no outage.
        offSince: () => Math.max(offSeenAt, loopSwitchedOnAt({ dataDir: deps.dataDir })),
      },
      audit: (entry) => appendDeliveryAudit(entry, { dataDir: deps.dataDir }),
      shadow,
    };
    const failedClients = new Set();
    let globalFailed = false;
    let errors = 0;
    let wrote = false;
    const stepReport = {};
    let leaseLost = false;
    for (const step of list) {
      if (keeper?.lost()) {
        leaseLost = true;
        break;
      }
      if (mode === 'paused' && !step.whenPaused) continue;
      if (step.everyMs) {
        const last = toMs(state.stepRuns[step.name]);
        if (last && now - last < step.everyMs && now >= last) continue;
      }
      const t0 = performance.now();
      const row = { ms: 0, wrote: false, errors: 0 };
      let switchedOn = false;
      if (step.scope === 'global') {
        try {
          const result = await step.run({ ...base, mode: mode === 'paused' ? 'paused' : mode });
          row.wrote = Boolean(result?.wrote);
          switchedOn = result?.skipped !== 'switch-off';
        } catch (error) {
          row.errors += 1;
          globalFailed = true;
          noteError(step.name, error);
        }
      } else {
        for (const entry of clients) {
          if (entry.mode !== 'shadow' && entry.mode !== 'auto') continue;
          if (keeper?.lost()) {
            leaseLost = true;
            break;
          }
          try {
            const result = await step.run({ ...base, mode: entry.mode, client: entry.client }, entry.client);
            if (result?.wrote) row.wrote = true;
            if (result?.skipped !== 'switch-off') switchedOn = true;
          } catch (error) {
            row.errors += 1;
            failedClients.add(entry.client.id);
            noteError(step.name, error, entry.client.id);
          }
        }
      }
      if (step.everyMs && !row.errors && switchedOn) {
        state.stepRuns[step.name] = iso(now);
        stateChanged = true;
      }
      row.ms = Math.round(performance.now() - t0);
      errors += row.errors;
      wrote = wrote || row.wrote;
      stepReport[step.name] = row;
      health.steps[step.name] = {
        ms: row.ms,
        wrote: row.wrote,
        errors: row.errors,
        lastRunAt: iso(now),
        ...(row.errors ? { lastErrorAt: iso(now) } : health.steps[step.name]?.lastErrorAt ? { lastErrorAt: health.steps[step.name].lastErrorAt } : {}),
      };
      if (leaseLost) break;
    }

    if (leaseLost || keeper?.lost()) {
      // Another process may tick now: store nothing more (dirty marks, step schedules and shadow
      // records stay for the next tick).
      noteError('tick', new Error('the delivery-loop lease could not be renewed; the tick stopped'));
      health.lastTickAt = iso(now);
      return { ran: true, mode, aborted: 'lease-lost', clients: clients.length, errors: errors + 1, wrote, steps: stepReport };
    }

    if (mode !== 'paused' && !globalFailed) {
      // Every mark this tick saw is done, except for clients a step failed on (they stay dirty).
      // Marks of clients that are gone or outside the loop are dropped too. After a global step
      // failed every mark stays for the next tick.
      const cleared = Object.entries(dirty)
        .filter(([id]) => !failedClients.has(id))
        .map(([id, at]) => ({ id, at }));
      if (clearDirtyMarks(deps.dataDir, cleared)) wrote = true;
    }
    // Shadow records go out in one append, before the memo that dedupes them is stored.
    if (shadowRecords.length) appendDeliveryAuditBatch(shadowRecords, { dataDir: deps.dataDir });
    const keys = Object.keys(state.shadow);
    if (keys.length > SHADOW_MEMO_MAX) {
      for (const key of keys.slice(0, keys.length - SHADOW_MEMO_MAX)) delete state.shadow[key];
      stateChanged = true;
    }
    if (stateChanged) {
      writeHotJson(statePath(deps.dataDir), { version: 1, stepRuns: state.stepRuns, shadow: state.shadow, updatedAt: iso(now) });
    }

    const durationMs = Math.round(performance.now() - started);
    health.lastTickAt = iso(now);
    health.lastSuccessAt = iso(now);
    health.lastDurationMs = durationMs;
    health.mode = mode;
    health.ticks += 1;
    health.clientsInScope = clients.length;
    health.lastTickErrors = errors;
    writeHealth(now);
    return { ran: true, mode, durationMs, clients: clients.length, errors, wrote, steps: stepReport };
  }

  function pickPrevious(raw) {
    return raw ? { lastTickAt: raw.lastTickAt || null, lastSuccessAt: raw.lastSuccessAt || null } : {};
  }

  return {
    deps,
    tick: runTick,
    /** Adds a step (tests and in-process modules); takes effect before the first tick. */
    registerTickStep(step) {
      const checked = assertTickStep(step, 'registered');
      extra = [...extra, checked];
      if (steps) steps = sortTickSteps([...steps, checked]);
      return checked;
    },
    async steps() {
      return { steps: (await loadSteps()).map(({ run: _run, ...rest }) => rest), errors: stepErrors };
    },
    health() {
      return structuredClone(health);
    },
    flushHealth() {
      return writeHealth(deps.now(), { force: true });
    },
    start({ intervalMs = TICK_INTERVAL_MS } = {}) {
      if (timer) return false;
      const fire = () => {
        runTick().catch((error) => {
          noteError('tick', error);
          deps.log?.error?.(`[delivery-loop] tick failed: ${errorText(error)}`);
        });
      };
      timer = setInterval(fire, intervalMs);
      timer.unref?.();
      setImmediate(fire);
      return true;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get running() {
      return running;
    },
  };
}

// ---------------------------------------------------------------- process singleton

let singleton = null;

/** The process's loop (created on first use); later deps are merged in. */
export function ensureDeliveryLoop(deps = {}) {
  if (!singleton) {
    singleton = createDeliveryLoop(deps);
    return singleton;
  }
  for (const [key, value] of Object.entries(deps)) {
    if (value !== undefined && singleton.deps[key] === undefined) singleton.deps[key] = value;
  }
  return singleton;
}

export function getDeliveryLoop() {
  return singleton;
}

/** startBackgroundJobs entry: ticks every 60 s; each tick returns at once while the switch is off. */
export function startDeliveryLoop(deps = {}) {
  const loop = ensureDeliveryLoop(deps);
  loop.start();
  return loop;
}

export function resetDeliveryLoopForTests() {
  singleton?.stop();
  singleton = null;
  storageCache = { at: 0, dir: '', value: null, pending: null };
}

/** Tests: the storage scan running now (a refresh a stale report started), or null. */
export function deliveryStorageScanForTests() {
  return storageCache.pending;
}
