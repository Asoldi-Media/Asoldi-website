// Developer page backend: the read-only board answer, per-item summaries, board-status and detail,
// and the writes the board GET used to do (now run from the delivery loop tick).
//
// The development GET never writes. What it used to do on every call is run by
// runLegacyDevelopmentWrites, which the delivery loop calls once per tick whatever the loop switch says:
//   - the hub-site phase reconcile, for the sites the loop does not own,
//   - the one-time developer-owner seed for every client,
//   - the open-client owner assignment while the admin is the only developer, for the clients the
//     loop does not own.
// With the loop off or owning no client the scope is undefined, so the result is the old GET path.
import { createHash } from 'node:crypto';
import { listMakerHosts } from '../data/maker-hosts.js';
import { readJsonCached } from '../data/atomic-json.js';
import { getPersistentDataDir } from '../data/storage-path.js';
import { developmentGetLoopScope } from './delivery-loop.js';
import { deliveryEmailStamps, normalizeDelivery } from './delivery-state.js';
import { listForClient, quotaFor } from './change-requests.js';
import { readBriefState, readLatestBrief } from './delivery-brief/store.js';
import { listReports } from './dev-reports.js';
import { listJobs } from './delivery-jobs.js';
import { HOST_HEARTBEATS_FILE, hostReportsRun } from './maker-host-meta.js';
import { join } from 'node:path';

const ONLINE_MS = 3 * 60 * 1000;

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

// ---------------------------------------------------------------- the writes the GET used to do

let legacyRunning = false;

/**
 * Runs the three board writes once. deps: { sales, hub, listDeveloperOwnerOptions }. Returns what each
 * step changed. Never throws for a step that fails: the loop notes the error.
 */
export async function runLegacyDevelopmentWrites({ sales, hub, listDeveloperOwnerOptions, dataDir, settings = null } = {}) {
  if (legacyRunning) return { skipped: 'busy' };
  legacyRunning = true;
  try {
    const loopScope = developmentGetLoopScope(() => sales.getSalesClients(), { dataDir, settings });
    const result = { reconciled: false, seeded: false, assigned: false };
    hub.reconcileDeliveryPhases(sales.getSalesClients(), loopScope.reconcile);
    result.reconciled = true;
    sales.seedExistingDeveloperOwnersToAdmin();
    result.seeded = true;
    const options = typeof listDeveloperOwnerOptions === 'function' ? await listDeveloperOwnerOptions() : [];
    const onlyAdmin = !(Array.isArray(options) ? options : []).some((row) => text(row?.accountKey).startsWith('developer:'));
    if (onlyAdmin) {
      sales.assignOpenDeveloperClientsToAdmin(loopScope.owners);
      result.assigned = true;
    }
    return result;
  } finally {
    legacyRunning = false;
  }
}

export function resetLegacyDevelopmentWritesForTests() {
  legacyRunning = false;
}

// ---------------------------------------------------------------- item summaries

function hostStatusFor(client, { hosts, heartbeats, now }) {
  const runId = text(client?.makerRun?.runId, 80);
  if (!runId) return null;
  const host = hosts.find((row) => hostReportsRun(row, runId));
  if (!host) return { hostId: '', online: false, lastHeartbeatAt: '' };
  const beat = heartbeats?.hosts?.[host.hostId]?.lastHeartbeatAt || '';
  const at = Date.parse(beat);
  return { hostId: host.hostId, online: Number.isFinite(at) && now - at <= ONLINE_MS, lastHeartbeatAt: beat || '' };
}

function gateSummary(gate) {
  if (!plain(gate)) return null;
  const lines = Array.isArray(gate.lines) ? gate.lines : [];
  const open = lines.filter((line) => line && line.status && line.status !== 'ok' && line.status !== 'waived');
  return {
    status: text(gate.status, 40),
    approved: Boolean(gate.approvedAt || gate.approved),
    lines: lines.length,
    open: open.length,
    blocking: open.filter((line) => line.blocking === true || line.severity === 'blocking').length,
  };
}

function jobSummary(job) {
  if (!plain(job)) return null;
  return {
    id: text(job.id, 80),
    kind: text(job.kind, 40),
    status: text(job.status, 20),
    blocking: text(job.blocking, 80),
    warnings: Array.isArray(job.warnings) ? job.warnings.slice(0, 20) : [],
    at: text(job.at, 40),
    doneAt: text(job.doneAt, 40),
  };
}

function aiSpendSummary(client) {
  const spend = client?.makerRun?.aiSpend;
  if (!plain(spend)) return null;
  return { totalUsd: Number(spend.totalUsd) || 0, calls: Number(spend.calls) || 0, receivedAt: text(spend.receivedAt, 40) };
}

function briefSummary(client, dataDir) {
  try {
    const state = readBriefState(client.id, { dataDir });
    const out = {};
    for (const key of ['version', 'hash', 'builtAt', 'status', 'updatedAt']) if (state?.[key] !== undefined && typeof state[key] !== 'object') out[key] = state[key];
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** The new fields of one board item (everything here is additive). */
export function boardExtras(client, context) {
  const { dataDir, now } = context;
  const delivery = normalizeDelivery(client?.delivery);
  const extras = {};
  const guard = (key, fn) => {
    try {
      extras[key] = fn();
    } catch {
      extras[key] = null;
    }
  };
  guard('delivery', () => ({
    stage: delivery.stage,
    overlay: delivery.overlay,
    stageAt: delivery.stageAt,
    gate: gateSummary(delivery.gate),
    job: jobSummary(delivery.job),
    emails: deliveryEmailStamps(client),
    info: delivery.info.map((entry) => entry.id),
    pendingIteration: delivery.pendingIteration,
  }));
  guard('briefSummary', () => briefSummary(client, dataDir));
  guard('changeRequestSummary', () => {
    const rows = listForClient(client.id, { dataDir });
    const quota = quotaFor(client, { dataDir, requests: rows });
    return { open: rows.filter((row) => row.status !== 'done' && row.status !== 'rejected').length, used: quota.used, quota: quota.limit };
  });
  guard('hostStatus', () => hostStatusFor(client, context));
  guard('autopilotSummary', () => {
    const a = client?.makerRun?.autopilot;
    return plain(a) ? { status: text(a.status, 40), step: text(a.step, 40), at: text(a.at || a.updatedAt, 40) } : null;
  });
  // Empty until a report arrives.
  guard('devSummary', () => (plain(client?.makerRun?.dev) ? client.makerRun.dev : {}));
  guard('aiSpendSummary', () => aiSpendSummary(client));
  guard('goLiveSummary', () => {
    const go = client?.makerRun?.goLive;
    return { needsImport: Boolean(go && go.needsImport), status: text(go?.status, 40) };
  });
  return extras;
}

/** Adds boardExtras to every item that has a sales client. Returns the same array. */
export function decorateBoardItems(items, { salesClientById, dataDir, now = Date.now() } = {}) {
  let hosts = [];
  let heartbeats = null;
  try {
    hosts = listMakerHosts({ dataDir });
    heartbeats = readJsonCached(join(dataDir || getPersistentDataDir(), HOST_HEARTBEATS_FILE));
  } catch {
    hosts = [];
  }
  const context = { dataDir, now, hosts, heartbeats };
  for (const item of items) {
    const client = item?.salesClientId && typeof salesClientById === 'function' ? salesClientById(item.salesClientId) : null;
    if (!client) continue;
    Object.assign(item, boardExtras(client, context));
  }
  return items;
}

// ---------------------------------------------------------------- board-status

function hashOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * Revision tracker for board-status: remembers a hash per item and gives each changed item the next
 * revision number. The state is memory only; a caller whose `since` is newer than this process's
 * revision (a restart) gets every item.
 */
export function createBoardRevisions() {
  // One tracker per caller scope (the account key): each caller sees its own item set, so ids and
  // revisions must never be shared between callers.
  const scopes = new Map();
  return {
    /** Folds the caller's visible items in; returns { rev, changed: [item], removed: [id] } newer than `since`. */
    status(items, since = 0, scope = '') {
      const key = String(scope || '');
      if (!scopes.has(key)) scopes.set(key, { rev: 0, seen: new Map() });
      const state = scopes.get(key);
      const { seen } = state;
      const ids = new Set();
      for (const item of items) {
        const id = String(item.id || '');
        ids.add(id);
        const hash = hashOf(item);
        const row = seen.get(id);
        if (!row || row.hash !== hash || row.removedAt) {
          state.rev += 1;
          seen.set(id, { hash, rev: state.rev, removedAt: 0 });
        }
      }
      const removed = [];
      for (const [id, row] of seen) {
        if (ids.has(id)) continue;
        if (!row.removedAt) {
          state.rev += 1;
          row.removedAt = state.rev;
        }
        removed.push({ id, rev: row.removedAt });
      }
      const rev = state.rev;
      const from = Number.isFinite(since) && since <= rev ? since : 0;
      return {
        rev,
        changed: items.filter((item) => (seen.get(String(item.id || ''))?.rev || 0) > from),
        removed: removed.filter((row) => row.rev > from).map((row) => row.id),
        count: items.length,
      };
    },
  };
}

// ---------------------------------------------------------------- detail

/** One client's detail: gate lines, brief summary, job history, change requests, delivery history, dev reports. */
export function boardDetail(client, { dataDir } = {}) {
  const delivery = normalizeDelivery(client?.delivery);
  let brief = null;
  try {
    const latest = readLatestBrief(client.id, { dataDir });
    if (latest) {
      const directives = Array.isArray(latest.directives) ? latest.directives : [];
      brief = {
        version: latest.version ?? null,
        hash: text(latest.hash, 80),
        directives: directives.length,
        facts: Array.isArray(latest.facts) ? latest.facts.length : 0,
      };
    }
  } catch {
    brief = null;
  }
  let jobs = [];
  try {
    jobs = listJobs({ dataDir, clientId: client.id }).slice(0, 30).map((job) => ({ ...jobSummary(job), attempts: job.attempts ?? 0, createdAt: text(job.createdAt, 40) }));
  } catch {
    jobs = [];
  }
  let changeRequests = [];
  try {
    changeRequests = listForClient(client.id, { dataDir }).slice(0, 50).map((row) => ({
      id: text(row.id, 80),
      status: text(row.status, 40),
      title: text(row.title || row.summary, 200),
      quotaUnits: Number(row.quotaUnits) || 0,
      createdAt: text(row.createdAt, 40),
    }));
  } catch {
    changeRequests = [];
  }
  let reports = [];
  try {
    reports = listReports(client.id, { dataDir }).slice(0, 5).map((row) => ({ sessionId: row.sessionId, receivedAt: row.receivedAt, reportRev: row.reportRev, status: row.report?.dev?.status || '' }));
  } catch {
    reports = [];
  }
  return {
    id: `sales:${client.id}`,
    salesClientId: client.id,
    gate: delivery.gate,
    brief,
    jobs,
    changeRequests,
    deliveryHistory: delivery.history,
    devReports: reports,
  };
}

