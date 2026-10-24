/**
 * WS8.25 on top of WS0.4's Maker hosts: heartbeat fields, the heartbeat hot file and per-client
 * access for host-scoped Maker routes.
 *
 * - recordHostHeartbeat stores runIds, capabilities.handlers (known job kinds only), version and
 *   makerPort through updateHostMeta, which writes maker-hosts.json only when a value changed.
 * - Last-heartbeat times and per-host heartbeat counts live in memory and in the hot file
 *   <dataDir>/delivery-hot/host-heartbeats.json, written at most every flushMs (temp file +
 *   rename under the shared lock, no backups).
 * - hostMayAccessClient(host, clientId): a host may read a client's data only when a live job for
 *   that client is routed to it, or when one of the runIds it reports is the client's
 *   makerRun.runId. makerClientAccess() is the middleware for /api/maker/clients/:id/* routes;
 *   every decision goes to the Maker access log (ids only).
 *
 * Not wired yet (contract for the track that adds the routes): GET /api/maker/clients/:id/brief,
 * GET /api/maker/clients/:id/transcripts/:sha256 and POST /api/maker/clients/:id/link-run each
 * mount requireMakerHost('jobs', { hostOnly: true }) and then makerClientAccess({ kind, getClient,
 * routedJobs }), so every brief fetch is logged. hubCapabilities stays empty and
 * hubLoopLastTickAt null until the hub loop writes delivery-hot/loop-health.json.
 */
import { join } from 'path';
import { readJsonCached, updateJsonLocked } from '../data/atomic-json.js';
import { getPersistentDataDir } from '../data/storage-path.js';
import { normalizeCapabilities, updateHostMeta } from '../data/maker-hosts.js';
import { appendMakerAccess } from './maker-access-log.js';

export const DEFAULT_POLL_AFTER_MS = 30_000;
export const HEARTBEAT_FLUSH_MS = 60_000;
export const HOST_HEARTBEATS_FILE = join('delivery-hot', 'host-heartbeats.json');
export const LOOP_HEALTH_FILE = join('delivery-hot', 'loop-health.json');
const FINISHED_JOB_STATUSES = new Set(['done', 'completed', 'failed', 'cancelled', 'canceled']);

function dataDirOf(dataDir) {
  return dataDir || getPersistentDataDir();
}

function laterIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * In-memory heartbeat stats with a throttled hot-file write. Several hub processes merge into the
 * same file: the newest lastHeartbeatAt wins and counts add up.
 */
export function createHostHeartbeatStore({ dataDir, flushMs = HEARTBEAT_FLUSH_MS, now = () => Date.now() } = {}) {
  const path = () => join(dataDirOf(dataDir), HOST_HEARTBEATS_FILE);
  const memory = new Map();
  let lastFlushAt = -Infinity;
  let timer = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const dirty = [...memory.entries()].filter(([, row]) => row.pending > 0 || row.changedPending);
    if (!dirty.length) return false;
    lastFlushAt = now();
    try {
      updateJsonLocked(
        path(),
        (raw) => {
          const hosts = raw?.hosts && typeof raw.hosts === 'object' && !Array.isArray(raw.hosts) ? { ...raw.hosts } : {};
          for (const [hostId, row] of dirty) {
            const stored = hosts[hostId] && typeof hosts[hostId] === 'object' ? hosts[hostId] : {};
            hosts[hostId] = {
              lastHeartbeatAt: laterIso(stored.lastHeartbeatAt, row.lastHeartbeatAt),
              lastChangedAt: laterIso(stored.lastChangedAt, row.lastChangedAt),
              heartbeats: (Number(stored.heartbeats) || 0) + row.pending,
            };
          }
          return { version: 1, hosts, updatedAt: new Date(now()).toISOString() };
        },
        { mode: 0o600 }
      );
      for (const [, row] of dirty) {
        row.pending = 0;
        row.changedPending = false;
      }
      return true;
    } catch (error) {
      console.error(`[maker-hosts] could not write the heartbeat file: ${error?.code || error?.message || 'error'}`);
      return false;
    }
  }

  return {
    note(hostId, { changed = false } = {}) {
      const at = new Date(now()).toISOString();
      const row = memory.get(hostId) || { lastHeartbeatAt: null, lastChangedAt: null, pending: 0, changedPending: false };
      row.lastHeartbeatAt = at;
      row.pending += 1;
      if (changed) {
        row.lastChangedAt = at;
        row.changedPending = true;
      }
      memory.set(hostId, row);
      const t = now();
      if (t - lastFlushAt >= flushMs) flush();
      else if (!timer) {
        timer = setTimeout(flush, Math.max(10, lastFlushAt + flushMs - t));
        timer.unref?.();
      }
    },
    /** { hostId: { lastHeartbeatAt, lastChangedAt, heartbeats } } from the file and this process. */
    read() {
      const raw = readJsonCached(path());
      const out = {};
      const stored = raw?.hosts && typeof raw.hosts === 'object' ? raw.hosts : {};
      for (const [hostId, row] of Object.entries(stored)) {
        out[hostId] = {
          lastHeartbeatAt: row?.lastHeartbeatAt || null,
          lastChangedAt: row?.lastChangedAt || null,
          heartbeats: Number(row?.heartbeats) || 0,
        };
      }
      for (const [hostId, row] of memory) {
        const base = out[hostId] || { lastHeartbeatAt: null, lastChangedAt: null, heartbeats: 0 };
        out[hostId] = {
          lastHeartbeatAt: laterIso(base.lastHeartbeatAt, row.lastHeartbeatAt),
          lastChangedAt: laterIso(base.lastChangedAt, row.lastChangedAt),
          heartbeats: base.heartbeats + row.pending,
        };
      }
      return out;
    },
    flush,
  };
}

/** The delivery loop's last tick (written by the WS8 loop into delivery-hot/loop-health.json), or null. */
export function readHubLoopLastTickAt({ dataDir } = {}) {
  const raw = readJsonCached(join(dataDirOf(dataDir), LOOP_HEALTH_FILE));
  const at = Date.parse(String(raw?.lastTickAt || ''));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Stores a heartbeat body's WS8 fields. Returns { changed, host, ignoredHandlers } or null for an
 * unknown host. Only keys present in the body are touched.
 */
export function recordHostHeartbeat(hostId, body = {}, { dataDir } = {}) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const patch = {};
  for (const key of ['runIds', 'capabilities', 'version', 'makerPort']) {
    if (Object.prototype.hasOwnProperty.call(source, key)) patch[key] = source[key];
  }
  const sentHandlers = Array.isArray(source.capabilities?.handlers) ? source.capabilities.handlers.map((kind) => String(kind ?? '')) : [];
  const known = normalizeCapabilities(source.capabilities).handlers;
  const ignoredHandlers = sentHandlers.filter((kind) => !known.includes(kind)).slice(0, 20);
  const result = updateHostMeta(hostId, patch, { dataDir });
  if (!result) return null;
  return { ...result, ignoredHandlers };
}

export function hostReportsRun(host, runId) {
  const id = String(runId || '').trim();
  return Boolean(host && !host.revokedAt && id && Array.isArray(host.runIds) && host.runIds.includes(id));
}

/**
 * True when `host` may read client `clientId`'s data:
 *   - a job for the client that is not finished is routed to the host (jobs: rows with
 *     salesClientId, hostId, status), or
 *   - one of the host's reported runIds is the client's makerRun.runId.
 */
export function hostMayAccessClient(host, clientId, { client = null, jobs = [] } = {}) {
  const id = String(clientId || '').trim();
  if (!host || host.revokedAt || !id) return false;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || String(job.salesClientId || '') !== id) continue;
    if (job.hostId === host.hostId && !FINISHED_JOB_STATUSES.has(String(job.status || ''))) return true;
  }
  if (client && String(client.id || id) === id) {
    return hostReportsRun(host, client.makerRun?.runId);
  }
  return false;
}

/**
 * Middleware for host-scoped client routes (after requireMakerHost(..., { hostOnly: true })).
 * deps: getClient(id) → client or null; routedJobs(clientId) → jobs (default none: the WS8 job
 * queue supplies them); kind names the access in the log (e.g. 'brief', 'transcript').
 * Unknown clients and clients outside the host's scope get the same 403.
 */
export function makerClientAccess({ kind, getClient, routedJobs = () => [], dataDir, param = 'id', refParam = '' } = {}) {
  if (typeof getClient !== 'function') throw new Error('makerClientAccess: getClient is required');
  return (req, res, next) => {
    const host = req.makerAuth?.host || null;
    const clientId = String(req.params?.[param] || '').trim();
    let client = null;
    let jobs = [];
    try {
      client = clientId ? getClient(clientId) : null;
      jobs = client ? routedJobs(clientId) || [] : [];
    } catch {
      client = null;
    }
    const allowed = Boolean(client) && hostMayAccessClient(host, clientId, { client, jobs });
    const reason = allowed ? '' : client ? 'not-routed' : 'unknown-client';
    appendMakerAccess(
      { hostId: host?.hostId, clientId, kind, allowed, reason, runId: client?.makerRun?.runId, ref: refParam ? req.params?.[refParam] : '' },
      { dataDir }
    );
    if (!allowed) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(403).json({ message: 'This Maker host has no job or run for this client.', code: 'maker-client-scope' });
    }
    req.makerClient = client;
    return next();
  };
}
