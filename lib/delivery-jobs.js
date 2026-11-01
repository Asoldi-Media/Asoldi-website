// Delivery job queue: jobs the Maker hosts pull and run (preview, continue, publish, ...).
//
// Storage: <dataDir>/delivery-jobs.json in the hot store (temp file + rename under a file lock,
// no stamped backups), plus one dated copy a day under snapshots/delivery-jobs/<day>.json (the
// newest SNAPSHOT_KEEP_DAYS are kept). Every change is a locked read-modify-write, so claims from
// any number of requests or hub processes are serialized: one claim wins, the others get 409.
//
// Rules:
//   - enqueueJob checks the kind (assertJobKind) and keeps at most one active job per client and
//     kind. requestJob adds the switches: delivery.loop must be on, the kind switch on
//     (development.previewJobs for preview, development.seoJobs for seo.*), and the client in auto
//     (spineModeForClient). A client in shadow gets a delivery-audit record and no job.
//   - routeHost: the host that reports the client's run; with two, the handoff owner's host, then
//     the most recently seen; else the host owned by the client's developer; else
//     development.defaultHostId; else any host (the first capable host to claim it).
//   - A job is offered only to a host whose capabilities.handlers list its kind.
//   - claimJob takes a 10-minute lease; heartbeatJob extends it and keeps the last 50 log lines;
//     failJob backs off 5, 15, then 45 minutes until maxAttempts; requeueStale (a tick step)
//     returns jobs whose lease ran out.
//   - Results are cleaned: local and private-network URLs are removed.
//   - client.delivery.job mirrors a job only when its status changes (and only through `sales`).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertJobKind, isBlockingCode, isWarningCode } from '../packages/suite/core/delivery/vocab.js';
import { getAutomationSettings } from '../data/automation-settings.js';
import { listMakerHosts } from '../data/maker-hosts.js';
import { canonicalDeveloperOwnerId } from './developer-assignment.js';
import { appendDeliveryAudit } from './delivery-audit.js';
import { ACTIVE_JOB_STATUSES, normalizeDeliveryJob } from './delivery-state.js';
import { hotPath, readHotJson, updateHotJson, writeHotJson } from './hot-store.js';
import { spineModeForClient } from './spine-mode.js';

export const DELIVERY_JOBS_FILE = 'delivery-jobs.json';
export const JOBS_SNAPSHOT_DIR = join('snapshots', 'delivery-jobs');
export const SNAPSHOT_KEEP_DAYS = 7;
export const CLAIM_LEASE_MS = 10 * 60 * 1000;
export const BACKOFF_MS = Object.freeze([5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000]);
export const DEFAULT_MAX_ATTEMPTS = 4;
export const JOB_LOG_MAX = 50;
export const FINISHED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_JOBS = 2000;
export const LOOP_SWITCH = 'delivery.loop';
const OFFERABLE = new Set(['queued', 'retrying']);
const RUNNING = new Set(['claimed', 'running']);
const ACTIVE = new Set(ACTIVE_JOB_STATUSES);
const KIND_SWITCHES = Object.freeze({
  preview: 'development.previewJobs',
  'seo.refresh': 'development.seoJobs',
  'seo.maintenance': 'development.seoJobs',
});
const JOB_ID_RE = /^job_[a-z0-9]{8,40}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function toMs(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function getPath(obj, path) {
  return path.split('.').reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), obj);
}

export function jobsPath({ dataDir } = {}) {
  return hotPath(DELIVERY_JOBS_FILE, { dataDir });
}

export function isJobId(value) {
  return JOB_ID_RE.test(String(value || ''));
}

export function isRunId(value) {
  return RUN_ID_RE.test(String(value || ''));
}

function newJobId(now) {
  return `job_${Math.floor(now).toString(36)}${randomBytes(5).toString('hex')}`;
}

// ---------------------------------------------------------------- settings

export function deliveryLoopEnabled(settings) {
  return settings?.delivery?.loop?.enabled === true;
}

/** '' when the kind may be enqueued under these settings, else the switch that is off. */
export function kindSwitchOff(kind, settings) {
  const path = KIND_SWITCHES[kind];
  if (!path) return '';
  return getPath(settings, path) === true ? '' : path;
}

// ---------------------------------------------------------------- sanitizing

const LOCAL_HOST_RE = /^(localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|\[?::1\]?|host\.docker\.internal|[a-z0-9.-]+\.(?:local|internal|localhost))$/i;
const URL_RE = /\b(?:https?|wss?|file):\/\/[^\s"'<>]+/gi;

function isLocalUrl(raw) {
  if (/^file:/i.test(raw)) return true;
  try {
    return LOCAL_HOST_RE.test(new URL(raw).hostname);
  } catch {
    return true;
  }
}

function cleanString(value, max) {
  const stripped = String(value).replace(URL_RE, (match) => (isLocalUrl(match) ? '' : match)).trim();
  return stripped.slice(0, max);
}

/**
 * A job result or progress payload made safe to store and show: local and private-network URLs
 * are removed, strings are capped, depth and size are bounded. Empty strings are dropped.
 */
export function sanitizeJobPayload(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = cleanString(value, 500);
    return cleaned || null;
  }
  if (depth >= 4) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeJobPayload(item, depth + 1)).filter((item) => item !== null);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      const cleanKey = text(key, 60);
      if (!cleanKey || /^__proto__$|^constructor$|^prototype$/.test(cleanKey)) continue;
      const cleaned = sanitizeJobPayload(item, depth + 1);
      if (cleaned !== null) out[cleanKey] = cleaned;
    }
    return out;
  }
  return null;
}

function cleanProgress(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const pct = Number(input.pct);
  return {
    phase: cleanString(text(input.phase, 60), 60),
    message: cleanString(text(input.message, 200), 200),
    pct: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null,
  };
}

function cleanLogLines(lines) {
  return (Array.isArray(lines) ? lines : [lines])
    .map((line) => cleanString(text(line, 300), 300))
    .filter(Boolean)
    .slice(-JOB_LOG_MAX);
}

// ---------------------------------------------------------------- store

function normalizeJobRow(raw) {
  if (!isPlainObject(raw) || !isJobId(raw.id)) return null;
  return raw;
}

function readFile(path, fresh) {
  const raw = readHotJson(path, { fresh });
  const jobs = Array.isArray(raw?.jobs) ? raw.jobs.map(normalizeJobRow).filter(Boolean) : [];
  return { version: 1, jobs, snapshotDay: text(raw?.snapshotDay, 10) };
}

/** Every job (copies), newest first. */
export function listJobs({ dataDir, clientId = '', status = '', kind = '', fresh = false } = {}) {
  const { jobs } = readFile(jobsPath({ dataDir }), fresh);
  return jobs
    .filter((job) => (!clientId || job.salesClientId === clientId) && (!status || job.status === status) && (!kind || job.kind === kind))
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
    .map((job) => structuredClone(job));
}

export function getJob(jobId, { dataDir, fresh = true } = {}) {
  return listJobs({ dataDir, fresh }).find((job) => job.id === jobId) || null;
}

/** Jobs grouped by client id, for deriveStage. */
export function jobsByClient({ dataDir } = {}) {
  const out = new Map();
  for (const job of listJobs({ dataDir })) {
    const id = String(job.salesClientId || '');
    if (!id) continue;
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(job);
  }
  return out;
}

/** Active jobs of one client (for hostMayAccessClient). */
export function routedJobsForClient(clientId, { dataDir } = {}) {
  return listJobs({ dataDir, clientId }).filter((job) => ACTIVE.has(job.status));
}

function pruneFinished(jobs, now) {
  const keep = jobs.filter((job) => ACTIVE.has(job.status) || job.status === 'blocked' || now - toMs(job.updatedAt || job.createdAt) < FINISHED_KEEP_MS);
  return keep.length > MAX_JOBS ? keep.sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt)).slice(0, MAX_JOBS) : keep;
}

/**
 * Locked change of the job list. change(jobs) mutates the array (copies) and returns
 * { changed, result }; nothing is written when changed is false.
 */
function mutateJobs(dataDir, now, change) {
  let outcome = { changed: false, result: null };
  updateHotJson(jobsPath({ dataDir }), (raw) => {
    const current = Array.isArray(raw?.jobs) ? raw.jobs.map(normalizeJobRow).filter(Boolean).map((job) => structuredClone(job)) : [];
    outcome = change(current) || { changed: false, result: null };
    if (!outcome.changed) return undefined;
    return { version: 1, jobs: pruneFinished(current, now), snapshotDay: text(raw?.snapshotDay, 10), updatedAt: iso(now) };
  });
  return outcome.result;
}

// ---------------------------------------------------------------- mirror

function mirrorOf(job) {
  return normalizeDeliveryJob({
    id: job.id,
    kind: job.kind,
    status: job.status,
    hostId: job.hostId,
    at: job.updatedAt || job.createdAt,
    doneAt: job.doneAt || '',
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    target: job.input?.target || '',
    error: job.error || '',
    blocking: job.blocking || '',
    warnings: job.warnings || [],
  });
}

/** Writes client.delivery.job when the stored mirror's status differs. Returns true on a write. */
export function mirrorJobToClient(job, sales) {
  if (!job || !sales || typeof sales.getSalesClientById !== 'function' || typeof sales.setSalesDelivery !== 'function') return false;
  const client = sales.getSalesClientById(job.salesClientId);
  if (!client) return false;
  const stored = client.delivery?.job;
  if (stored && stored.id === job.id && stored.status === job.status) return false;
  const mirror = mirrorOf(job);
  if (!mirror) return false;
  sales.setSalesDelivery(job.salesClientId, { job: mirror }, { by: 'jobs', reason: `job ${job.kind} ${job.status}` });
  return true;
}

// ---------------------------------------------------------------- routing

function liveHosts(hosts) {
  return (Array.isArray(hosts) ? hosts : []).filter((host) => host && !host.revokedAt && Array.isArray(host.scopes) && host.scopes.includes('jobs'));
}

function hasHandler(host, kind) {
  return Array.isArray(host?.capabilities?.handlers) && host.capabilities.handlers.includes(kind);
}

function newestSeen(list, seenAt) {
  return [...list].sort((a, b) => toMs(seenAt(b)) - toMs(seenAt(a)) || String(a.hostId).localeCompare(String(b.hostId)))[0] || null;
}

function ownedBy(host, ownerId) {
  return Boolean(ownerId) && canonicalDeveloperOwnerId(host.ownerAccountKey) === ownerId;
}

/**
 * The host a job for `client` goes to, or '' (any capable host). `seenAt(host)` gives the host's
 * last heartbeat or lastSeenAt for tie-breaks.
 */
export function routeHost({ client = null, runId = '', kind = '' } = {}, { hosts = [], settings = null, seenAt = (host) => host.lastSeenAt } = {}) {
  const live = liveHosts(hosts);
  const preferCapable = (list) => {
    const capable = list.filter((host) => hasHandler(host, kind));
    return capable.length ? capable : list;
  };
  const id = text(runId || client?.makerRun?.runId, 80);
  if (id) {
    const reporting = live.filter((host) => Array.isArray(host.runIds) && host.runIds.includes(id));
    if (reporting.length === 1) return reporting[0].hostId;
    if (reporting.length > 1) {
      const handoffOwner = canonicalDeveloperOwnerId(client?.developerHandoff?.toOwnerId || client?.developerOwnerId);
      const owned = reporting.filter((host) => ownedBy(host, handoffOwner));
      return newestSeen(owned.length ? owned : reporting, seenAt).hostId;
    }
  }
  const owner = canonicalDeveloperOwnerId(client?.developerOwnerId);
  const owned = preferCapable(live.filter((host) => ownedBy(host, owner)));
  if (owned.length) return newestSeen(owned, seenAt).hostId;
  const fallback = text(settings?.development?.defaultHostId, 64);
  if (fallback && live.some((host) => host.hostId === fallback)) return fallback;
  return '';
}

/** True when `host` may take `job` now. */
export function jobOfferableTo(job, host, now = Date.now()) {
  if (!job || !host || host.revokedAt) return false;
  if (!Array.isArray(host.scopes) || !host.scopes.includes('jobs')) return false;
  if (!OFFERABLE.has(job.status)) return false;
  if (job.notBefore && toMs(job.notBefore) > now) return false;
  if (!hasHandler(host, job.kind)) return false;
  return !job.hostId || job.hostId === host.hostId;
}

/** Jobs this host may claim, oldest and most urgent first, in the shape the Maker sees. */
export function listOfferable(host, { dataDir, now = Date.now(), limit = 20 } = {}) {
  return listJobs({ dataDir, fresh: true })
    .filter((job) => jobOfferableTo(job, host, now))
    .sort((a, b) => (Number(a.priority) || 5) - (Number(b.priority) || 5) || toMs(a.createdAt) - toMs(b.createdAt))
    .slice(0, limit)
    .map(publicJob);
}

/** The job as a Maker host or an admin sees it. */
export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    salesClientId: job.salesClientId,
    runId: job.runId || '',
    hostId: job.hostId || '',
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    createdBy: job.createdBy || '',
    claimedAt: job.claimedAt || '',
    leaseUntil: job.leaseUntil || '',
    heartbeatAt: job.heartbeatAt || '',
    notBefore: job.notBefore || '',
    doneAt: job.doneAt || '',
    updatedAt: job.updatedAt || '',
    input: job.input || {},
    progress: job.progress || null,
    log: Array.isArray(job.log) ? job.log : [],
    result: job.result ?? null,
    error: job.error || '',
    blocking: job.blocking || '',
    warnings: Array.isArray(job.warnings) ? job.warnings : [],
  };
}

// ---------------------------------------------------------------- enqueue

function cleanInput(kind, raw) {
  const input = isPlainObject(raw) ? raw : {};
  const out = sanitizeJobPayload(input) || {};
  if (kind === 'preview') {
    return {
      templateSetId: text(input.templateSetId, 120),
      language: text(input.language, 12).toLowerCase(),
      pages: (Array.isArray(input.pages) ? input.pages : []).map((page) => text(page, 120)).filter(Boolean).slice(0, 30),
    };
  }
  return out;
}

/**
 * Adds a job. Throws for an unknown kind. Returns { ok, status, code?, job }: 409 'duplicate'
 * (with the active job) when the client already has an active job of this kind.
 */
export function enqueueJob(
  { salesClientId, kind, runId = '', input = {}, createdBy = '', priority = 5, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {},
  { dataDir, now = Date.now(), client = null, hosts = [], settings = null, sales = null } = {},
) {
  const jobKind = assertJobKind(kind);
  const clientId = text(salesClientId, 80);
  if (!clientId) return { ok: false, status: 400, code: 'client-required', job: null };
  const at = typeof now === 'number' ? now : toMs(now) || Date.now();
  const resolvedRunId = text(runId || client?.makerRun?.runId, 80);
  const routed = routeHost({ client, runId: resolvedRunId, kind: jobKind }, { hosts, settings });
  const outcome = mutateJobs(dataDir, at, (jobs) => {
    const existing = jobs.find((job) => job.salesClientId === clientId && job.kind === jobKind && ACTIVE.has(job.status));
    if (existing) return { changed: false, result: { ok: false, status: 409, code: 'duplicate', job: publicJob(existing) } };
    const job = {
      id: newJobId(at),
      salesClientId: clientId,
      kind: jobKind,
      runId: resolvedRunId,
      hostId: routed,
      routedHostId: routed,
      status: 'queued',
      priority: Math.max(1, Math.min(9, Math.round(Number(priority) || 5))),
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(10, Math.round(Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS))),
      createdAt: iso(at),
      createdBy: text(createdBy, 120),
      claimedAt: '',
      leaseUntil: '',
      heartbeatAt: '',
      notBefore: '',
      doneAt: '',
      updatedAt: iso(at),
      input: cleanInput(jobKind, input),
      progress: null,
      log: [],
      result: null,
      error: '',
      blocking: '',
      warnings: [],
    };
    jobs.push(job);
    return { changed: true, result: { ok: true, status: 201, job: publicJob(job) } };
  });
  if (outcome?.ok) {
    appendDeliveryAudit({ kind: 'job', clientId, by: createdBy, reason: 'enqueued', jobKind, jobId: outcome.job.id, hostId: routed }, { dataDir });
    mirrorJobToClient(outcome.job, sales);
  }
  return outcome;
}

/**
 * enqueueJob behind the switches: delivery.loop on, the kind's switch on, the client in auto.
 * In shadow the request is recorded in the delivery audit and nothing is queued.
 * Returns { ok, status, code?, shadow?, mode, job }.
 */
export function requestJob(request = {}, { dataDir, now = Date.now(), client, hosts = [], settings: given = null, sales = null } = {}) {
  const settings = given || getAutomationSettings({ dataDir });
  const kind = assertJobKind(request.kind);
  if (!deliveryLoopEnabled(settings)) return { ok: false, status: 404, code: 'disabled', mode: 'off', job: null };
  const offSwitch = kindSwitchOff(kind, settings);
  if (offSwitch) return { ok: false, status: 404, code: 'disabled', switch: offSwitch, mode: 'off', job: null };
  if (!client) return { ok: false, status: 404, code: 'unknown-client', mode: 'off', job: null };
  const mode = spineModeForClient(LOOP_SWITCH, client, { settings, dataDir });
  if (mode === 'off' || mode === 'paused') return { ok: false, status: 409, code: mode === 'paused' ? 'paused' : 'not-included', mode, job: null };
  if (mode !== 'auto') {
    appendDeliveryAudit({ kind: 'loop-shadow', step: 'enqueue', clientId: client.id, by: request.createdBy, reason: `would enqueue ${kind}`, jobKind: kind }, { dataDir });
    return { ok: true, status: 202, shadow: true, mode, job: null };
  }
  return { ...enqueueJob({ ...request, kind, salesClientId: client.id }, { dataDir, now, client, hosts, settings, sales }), mode };
}

// ---------------------------------------------------------------- claim, heartbeat, finish

function holderCheck(job, host) {
  if (!job) return { status: 404, code: 'unknown-job' };
  if (!RUNNING.has(job.status) || job.hostId !== host?.hostId) return { status: 409, code: 'not-claimed-by-host' };
  return null;
}

/** Claims a job for `host` with a 10-minute lease. { status: 200, job } or 404 / 409. */
export function claimJob(jobId, host, { dataDir, now = Date.now(), leaseMs = CLAIM_LEASE_MS, sales = null } = {}) {
  const at = typeof now === 'number' ? now : toMs(now);
  const outcome = mutateJobs(dataDir, at, (jobs) => {
    const job = jobs.find((row) => row.id === jobId);
    if (!job) return { changed: false, result: { status: 404, code: 'unknown-job' } };
    if (!jobOfferableTo(job, host, at)) return { changed: false, result: { status: 409, code: 'conflict', jobStatus: job.status } };
    job.status = 'claimed';
    job.hostId = host.hostId;
    job.claimedAt = iso(at);
    job.heartbeatAt = iso(at);
    job.leaseUntil = iso(at + leaseMs);
    job.attempts = (Number(job.attempts) || 0) + 1;
    job.notBefore = '';
    job.updatedAt = iso(at);
    job.log = [...(job.log || []), `${iso(at)} claimed by ${host.hostId}`].slice(-JOB_LOG_MAX);
    return { changed: true, result: { status: 200, job: publicJob(job) } };
  });
  if (outcome?.status === 200) mirrorJobToClient(outcome.job, sales);
  return outcome;
}

/** Progress from the claiming host: extends the lease, keeps the last 50 log lines. */
export function heartbeatJob(jobId, host, { progress, log, dataDir, now = Date.now(), leaseMs = CLAIM_LEASE_MS, sales = null } = {}) {
  const at = typeof now === 'number' ? now : toMs(now);
  let statusChanged = false;
  const outcome = mutateJobs(dataDir, at, (jobs) => {
    const job = jobs.find((row) => row.id === jobId);
    const refused = holderCheck(job, host);
    if (refused) return { changed: false, result: refused };
    if (job.leaseUntil && toMs(job.leaseUntil) < at) return { changed: false, result: { status: 409, code: 'lease-lost' } };
    statusChanged = job.status !== 'running';
    job.status = 'running';
    job.heartbeatAt = iso(at);
    job.leaseUntil = iso(at + leaseMs);
    if (progress !== undefined) job.progress = cleanProgress(progress);
    if (log !== undefined) job.log = [...(job.log || []), ...cleanLogLines(log)].slice(-JOB_LOG_MAX);
    job.updatedAt = iso(at);
    return { changed: true, result: { status: 200, job: publicJob(job) } };
  });
  if (outcome?.status === 200 && statusChanged) mirrorJobToClient(outcome.job, sales);
  return outcome;
}

/** The claiming host finished the job. Warnings outside the vocabulary are dropped. */
export function completeJob(jobId, host, { result = null, warnings = [], dataDir, now = Date.now(), sales = null } = {}) {
  const at = typeof now === 'number' ? now : toMs(now);
  const outcome = mutateJobs(dataDir, at, (jobs) => {
    const job = jobs.find((row) => row.id === jobId);
    const refused = holderCheck(job, host);
    if (refused) return { changed: false, result: refused };
    job.status = 'done';
    job.doneAt = iso(at);
    job.updatedAt = iso(at);
    job.leaseUntil = '';
    job.result = sanitizeJobPayload(result);
    if (isPlainObject(job.result) && isRunId(job.result.runId) && !job.runId) job.runId = job.result.runId;
    job.warnings = (Array.isArray(warnings) ? warnings : []).filter((code) => isWarningCode(code)).slice(0, 20);
    job.error = '';
    job.blocking = '';
    job.progress = { ...(job.progress || {}), pct: 100 };
    job.log = [...(job.log || []), `${iso(at)} done`].slice(-JOB_LOG_MAX);
    return { changed: true, result: { status: 200, job: publicJob(job) } };
  });
  if (outcome?.status === 200) mirrorJobToClient(outcome.job, sales);
  return outcome;
}

/**
 * The claiming host could not finish. A blocking code (vocabulary) blocks the job; otherwise a
 * retryable failure waits 5, 15, then 45 minutes and is offered again until maxAttempts.
 */
export function failJob(jobId, host, { error = '', blocking = '', retryable = true, dataDir, now = Date.now(), sales = null } = {}) {
  const at = typeof now === 'number' ? now : toMs(now);
  const outcome = mutateJobs(dataDir, at, (jobs) => {
    const job = jobs.find((row) => row.id === jobId);
    const refused = holderCheck(job, host);
    if (refused) return { changed: false, result: refused };
    const code = isBlockingCode(blocking) ? text(blocking, 80) : '';
    job.error = cleanString(text(error, 500), 500) || code || 'failed';
    job.blocking = code;
    job.leaseUntil = '';
    job.updatedAt = iso(at);
    const attempts = Number(job.attempts) || 0;
    if (code) {
      job.status = 'blocked';
    } else if (retryable !== false && attempts < (Number(job.maxAttempts) || DEFAULT_MAX_ATTEMPTS)) {
      job.status = 'retrying';
      job.notBefore = iso(at + BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]);
      job.hostId = job.routedHostId || '';
    } else {
      job.status = 'failed';
      job.doneAt = iso(at);
    }
    job.log = [...(job.log || []), `${iso(at)} ${job.status}: ${job.error}`].slice(-JOB_LOG_MAX);
    return { changed: true, result: { status: 200, job: publicJob(job) } };
  });
  if (outcome?.status === 200) mirrorJobToClient(outcome.job, sales);
  return outcome;
}

/** Claimed or running jobs whose lease ran out go back to the queue (or fail after maxAttempts). */
export function requeueStale({ dataDir, now = Date.now(), sales = null } = {}) {
  const at = typeof now === 'number' ? now : toMs(now);
  const touched = mutateJobs(dataDir, at, (jobs) => {
    const changed = [];
    for (const job of jobs) {
      if (!RUNNING.has(job.status)) continue;
      if (!job.leaseUntil || toMs(job.leaseUntil) >= at) continue;
      const attempts = Number(job.attempts) || 0;
      if (attempts >= (Number(job.maxAttempts) || DEFAULT_MAX_ATTEMPTS)) {
        job.status = 'failed';
        job.error = 'lease-expired';
        job.doneAt = iso(at);
      } else {
        job.status = 'queued';
        job.hostId = job.routedHostId || '';
        job.notBefore = '';
      }
      job.claimedAt = '';
      job.leaseUntil = '';
      job.updatedAt = iso(at);
      job.log = [...(job.log || []), `${iso(at)} lease expired: ${job.status}`].slice(-JOB_LOG_MAX);
      changed.push(publicJob(job));
    }
    return { changed: changed.length > 0, result: changed };
  }) || [];
  for (const job of touched) mirrorJobToClient(job, sales);
  return touched;
}

/** Admin: cancel an active or blocked job. */
export function cancelJob(jobId, { by = '', dataDir, now = Date.now(), sales = null } = {}) {
  const at = typeof now === 'number' ? now : toMs(now);
  const outcome = mutateJobs(dataDir, at, (jobs) => {
    const job = jobs.find((row) => row.id === jobId);
    if (!job) return { changed: false, result: { status: 404, code: 'unknown-job' } };
    if (!ACTIVE.has(job.status) && job.status !== 'blocked') return { changed: false, result: { status: 409, code: 'finished', job: publicJob(job) } };
    job.status = 'cancelled';
    job.leaseUntil = '';
    job.doneAt = iso(at);
    job.updatedAt = iso(at);
    job.log = [...(job.log || []), `${iso(at)} cancelled${by ? ` by ${text(by, 80)}` : ''}`].slice(-JOB_LOG_MAX);
    return { changed: true, result: { status: 200, job: publicJob(job) } };
  });
  if (outcome?.status === 200) {
    appendDeliveryAudit({ kind: 'job', clientId: outcome.job.salesClientId, by, reason: 'cancelled', jobId }, { dataDir });
    mirrorJobToClient(outcome.job, sales);
  }
  return outcome;
}

/** Admin: put a failed or blocked job back in the queue with a fresh attempt budget. */
export function retryJob(jobId, { by = '', dataDir, now = Date.now(), sales = null } = {}) {
  const at = typeof now === 'number' ? now : toMs(now);
  const outcome = mutateJobs(dataDir, at, (jobs) => {
    const job = jobs.find((row) => row.id === jobId);
    if (!job) return { changed: false, result: { status: 404, code: 'unknown-job' } };
    if (!['failed', 'blocked'].includes(job.status)) return { changed: false, result: { status: 409, code: 'not-failed', job: publicJob(job) } };
    const duplicate = jobs.find((row) => row.id !== job.id && row.salesClientId === job.salesClientId && row.kind === job.kind && ACTIVE.has(row.status));
    if (duplicate) return { changed: false, result: { status: 409, code: 'duplicate', job: publicJob(duplicate) } };
    job.status = 'queued';
    job.attempts = 0;
    job.hostId = job.routedHostId || '';
    job.notBefore = '';
    job.error = '';
    job.blocking = '';
    job.doneAt = '';
    job.updatedAt = iso(at);
    job.log = [...(job.log || []), `${iso(at)} retried${by ? ` by ${text(by, 80)}` : ''}`].slice(-JOB_LOG_MAX);
    return { changed: true, result: { status: 200, job: publicJob(job) } };
  });
  if (outcome?.status === 200) {
    appendDeliveryAudit({ kind: 'job', clientId: outcome.job.salesClientId, by, reason: 'retried', jobId }, { dataDir });
    mirrorJobToClient(outcome.job, sales);
  }
  return outcome;
}

/** A linked run: active jobs of the client without a run id get it. Returns the number changed. */
export function attachRunToJobs(clientId, runId, { dataDir, now = Date.now() } = {}) {
  const at = typeof now === 'number' ? now : toMs(now);
  return mutateJobs(dataDir, at, (jobs) => {
    let count = 0;
    for (const job of jobs) {
      if (job.salesClientId !== clientId || !ACTIVE.has(job.status) || job.runId) continue;
      job.runId = runId;
      job.updatedAt = iso(at);
      count += 1;
    }
    return { changed: count > 0, result: count };
  }) || 0;
}

/**
 * Developer handoff accepted: queued jobs of the client move to a host owned by the new
 * developer (when one exists). Nothing happens while delivery.loop is off.
 */
export function rerouteJobsForHandoff(client, { hosts = [], settings: given = null, dataDir, now = Date.now() } = {}) {
  const settings = given || getAutomationSettings({ dataDir });
  if (!deliveryLoopEnabled(settings) || !client?.id) return 0;
  if (!existsSync(jobsPath({ dataDir }))) return 0;
  const toOwner = canonicalDeveloperOwnerId(client.developerHandoff?.toOwnerId || client.developerOwnerId);
  if (!toOwner) return 0;
  const runId = text(client.developerHandoff?.runId || client.makerRun?.runId, 80);
  const at = typeof now === 'number' ? now : toMs(now);
  const count = mutateJobs(dataDir, at, (jobs) => {
    let moved = 0;
    for (const job of jobs) {
      if (job.salesClientId !== client.id || !OFFERABLE.has(job.status)) continue;
      if (runId && job.runId && job.runId !== runId) continue;
      const owned = liveHosts(hosts).filter((host) => ownedBy(host, toOwner));
      const target = (owned.find((host) => hasHandler(host, job.kind)) || owned[0])?.hostId || '';
      if (!target || job.hostId === target) continue;
      job.hostId = target;
      job.routedHostId = target;
      job.updatedAt = iso(at);
      job.log = [...(job.log || []), `${iso(at)} rerouted to ${target} after a developer handoff`].slice(-JOB_LOG_MAX);
      moved += 1;
    }
    return { changed: moved > 0, result: moved };
  }) || 0;
  if (count) appendDeliveryAudit({ kind: 'job', clientId: client.id, reason: 'handoff-reroute', by: 'jobs' }, { dataDir });
  return count;
}

/** server.js hook for an accepted developer handoff (reads the hosts itself; never throws). */
export function noteDeveloperHandoffAccepted(client, { dataDir } = {}) {
  try {
    const settings = getAutomationSettings({ dataDir });
    if (!deliveryLoopEnabled(settings)) return 0;
    return rerouteJobsForHandoff(client, { hosts: listMakerHosts({ dataDir }), settings, dataDir });
  } catch (error) {
    console.warn('[delivery-jobs] handoff reroute failed:', String(error?.message || error).slice(0, 200));
    return 0;
  }
}

// ---------------------------------------------------------------- daily snapshot

function dayOf(ms) {
  return iso(ms).slice(0, 10);
}

/** One dated copy of the job file per day (snapshots/delivery-jobs/<day>.json), newest 7 kept. */
export function snapshotJobsDaily({ dataDir, now = Date.now() } = {}) {
  const path = jobsPath({ dataDir });
  if (!existsSync(path)) return null;
  const day = dayOf(now);
  if (text(readHotJson(path)?.snapshotDay, 10) === day) return null;
  const raw = readHotJson(path, { fresh: true });
  if (!raw || text(raw.snapshotDay, 10) === day) return null;
  const dir = hotPath(JOBS_SNAPSHOT_DIR, { dataDir });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${day}.json`);
  writeHotJson(file, raw);
  updateHotJson(path, (current) => (current ? { ...current, snapshotDay: day } : undefined));
  const days = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  for (const old of days.slice(0, Math.max(0, days.length - SNAPSHOT_KEEP_DAYS))) rmSync(join(dir, old), { force: true });
  return file;
}

// ---------------------------------------------------------------- tick steps

export const tickSteps = [
  {
    name: 'jobs-requeue-stale',
    order: 40,
    scope: 'global',
    run: async (ctx) => {
      const touched = requeueStale({ dataDir: ctx.dataDir, now: ctx.now, sales: ctx.sales });
      return { wrote: touched.length > 0, requeued: touched.length };
    },
  },
  {
    name: 'jobs-daily-snapshot',
    order: 45,
    scope: 'global',
    run: async (ctx) => ({ wrote: Boolean(snapshotJobsDaily({ dataDir: ctx.dataDir, now: ctx.now })) }),
  },
];
