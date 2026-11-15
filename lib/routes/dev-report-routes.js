// Developer page routes, registered through lib/routes/optional-routes.js.
//
// Maker (host token, scope jobs, host tokens only), contract dev-report/1:
//   POST  /api/maker/runs/:runId/dev-report                       one session report (at most 64 KB)
//   POST  /api/maker/runs/:runId/dev-report/shots?sessionId=&shot= one JPEG thumbnail (at most 150 KB)
//   PATCH /api/maker/clients/:id/brief/directives/:did/status      a host may set `done` only; staff may use it too
// Staff (developmentAuth):
//   GET   /api/admin/development/board-status?since=<rev>          only the items that changed since <rev>
//   GET   /api/admin/development/:id/detail                        gate lines, brief summary, jobs, change requests, history
//   GET   /api/admin/development/:id/dev-report                    the latest stored report and its thumbnails
//   GET   /api/admin/development/:id/dev-report/shots/:sessionId/:shot   a thumbnail (never public, never a host token)
// Admin only:
//   POST  /api/admin/system/client-purge                           { salesClientId, mode:'report' } or
//                                                                   { mode:'delete', reportId, backupListing }
//
// While the devReport switch is off the Maker routes answer 404 {code:'disabled'} before any other check and
// the heartbeat lists no capability. The purge route answers the same while purgeJobs is off. Every refused
// request writes and enqueues nothing.
import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAutomationSettings } from '../../data/automation-settings.js';
import { briefErased, readLatestBrief, readReviews, setDirectiveStatus } from '../delivery-brief/store.js';
import { boardDetail, createBoardRevisions } from '../development-board.js';
import { canWorkDevelopmentClient, developmentItemVisible } from '../developer-assignment.js';
import { findLinkedSalesClient, parseDevelopmentItemId } from '../development-phase.js';
import {
  DEV_REPORT_CONTRACT,
  MAX_REPORT_BYTES,
  MAX_SHOT_BYTES,
  devReportEnabled,
  devSummaryOf,
  isJpeg,
  listReports,
  listShots,
  readShot,
  storeReport,
  storeShot,
  validateDevReport,
} from '../dev-reports.js';
import { enqueueJob, routedJobsForClient } from '../delivery-jobs.js';
import { hostMayAccessClient, hostReportsRun, makerClientAccess, registerHubCapabilities } from '../maker-host-meta.js';
import { MAKER_HOST_TOKEN_HEADER, LEGACY_MAKER_TOKEN_HEADERS } from '../maker-auth.js';
import { getPersistentDataDir } from '../../data/storage-path.js';
import { PURGE_REPORT_DIR, PurgeRefused, applyClientPurge, purgeJobsEnabled, reportClientPurge } from '../purge-jobs.js';
import { recordAgentQuotaUnits } from '../change-requests.js';

const CLIENT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;
const DIRECTIVE_RE = /^dir-[a-z0-9]{6,40}$/;

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function fail(res, status, code, extra = {}) {
  noStore(res);
  return res.status(status).json({ ok: false, code, ...extra });
}

function wrap(handler, log) {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error) => {
        log?.error?.(`[dev-report] ${req.method} ${req.path} failed: ${error?.code || error?.message || 'error'}`);
        if (!res.headersSent) fail(res, 500, 'error');
      });
  };
}

function header(req, name) {
  return String((typeof req.get === 'function' ? req.get(name) : req.headers?.[name]) || '').trim();
}

function hasHostCredential(req) {
  return Boolean(header(req, MAKER_HOST_TOKEN_HEADER) || LEGACY_MAKER_TOKEN_HEADERS.some((name) => header(req, name)));
}

export function register(app, deps = {}) {
  const { developmentAuth, makerAuth, sales, hub } = deps;
  if (typeof developmentAuth !== 'function' || !makerAuth?.requireMakerHost || typeof sales?.getSalesClientById !== 'function') {
    throw new Error('dev-report-routes: developmentAuth, makerAuth and sales are required');
  }
  const log = deps.log || console;
  const dataDir = () => (typeof deps.getDataDir === 'function' ? deps.getDataDir() : undefined);
  const settings = () => (typeof deps.settings === 'function' ? deps.settings() : getAutomationSettings({ dataDir: dataDir() }));
  const getClient = (id) => (CLIENT_RE.test(String(id || '')) ? sales.getSalesClientById(String(id)) : null);
  const routedJobs = typeof deps.routedJobs === 'function' ? deps.routedJobs : (clientId) => routedJobsForClient(clientId, { dataDir: dataDir() });
  const revisions = createBoardRevisions();

  registerHubCapabilities('dev-report', ({ dataDir: dir } = {}) => (devReportEnabled(typeof deps.settings === 'function' ? deps.settings() : getAutomationSettings({ dataDir: dir || dataDir() })) ? [DEV_REPORT_CONTRACT] : []));

  const switchOn = (_req, res, next) => (devReportEnabled(settings()) ? next() : fail(res, 404, 'disabled'));
  const hostOnly = makerAuth.requireMakerHost('jobs', { hostOnly: true });

  function clientForRun(runId) {
    return sales.getSalesClients().find((entry) => String(entry?.makerRun?.runId || '') === runId) || null;
  }

  /** The run must be one the host reports, or belong to a client with a live job routed to the host. */
  function runScope(req, res, next) {
    const runId = String(req.params.runId || '');
    if (!RUN_RE.test(runId)) return fail(res, 404, 'unknown-run');
    const host = req.makerAuth?.host || null;
    const client = clientForRun(runId);
    const allowed = hostReportsRun(host, runId) || (client && hostMayAccessClient(host, client.id, { client, jobs: routedJobs(client.id) || [] }));
    if (!allowed) return fail(res, 403, 'run-not-on-host');
    if (!client) return fail(res, 404, 'unknown-run');
    req.devReportClient = client;
    return next();
  }

  // ---------------------------------------------------------------- Maker: report

  app.post(
    '/api/maker/runs/:runId/dev-report',
    switchOn,
    hostOnly,
    runScope,
    wrap((req, res) => {
      if (!req.is('application/json')) return fail(res, 415, 'unsupported-media-type');
      const declared = Number(header(req, 'content-length'));
      let size = Number.isFinite(declared) ? declared : 0;
      try {
        size = Math.max(size, Buffer.byteLength(JSON.stringify(req.body ?? {})));
      } catch {
        size = MAX_REPORT_BYTES + 1;
      }
      if (size > MAX_REPORT_BYTES) return fail(res, 413, 'too-large');
      const checked = validateDevReport(req.body, { routeRunId: req.params.runId });
      if (!checked.ok) return fail(res, checked.status, checked.code, { field: checked.field });
      const client = req.devReportClient;
      const claimed = String(checked.report.salesClientId || '');
      if (claimed && claimed !== client.id) return fail(res, 400, 'bad-report', { field: 'salesClientId' });
      const stored = storeReport(client.id, checked.report, { dataDir: dataDir() });
      if (!stored.stored) return res.json({ ok: true, stored: false, duplicate: true });
      if (typeof sales.setSalesMakerRunDev === 'function') {
        sales.setSalesMakerRunDev(client.id, devSummaryOf(checked.report, { receivedAt: stored.receivedAt, reportRev: stored.reportRev }));
      }
      const dev = checked.report.dev;
      if (dev.kind === 'change_request' && dev.changeRequestId && Number.isInteger(dev.quotaUnits)) {
        try {
          recordAgentQuotaUnits(dev.changeRequestId, dev.quotaUnits, { dataDir: dataDir(), by: 'maker' });
        } catch (error) {
          log?.warn?.(`[dev-report] quota units not recorded: ${error?.code || 'error'}`);
        }
      }
      noStore(res);
      return res.json({ ok: true, stored: true, sessionId: stored.sessionId, reportRev: stored.reportRev, bytes: stored.bytes });
    }, log)
  );

  // ---------------------------------------------------------------- Maker: thumbnails

  const shotBody = express.raw({ type: 'image/jpeg', limit: MAX_SHOT_BYTES });
  app.post(
    '/api/maker/runs/:runId/dev-report/shots',
    switchOn,
    hostOnly,
    runScope,
    (req, res, next) => (req.is('image/jpeg') ? next() : fail(res, 415, 'unsupported-media-type')),
    shotBody,
    // body-parser refuses an oversize or unreadable body with its own error; answer it in the contract's shape.
    (error, _req, res, next) => {
      if (!error) return next();
      return fail(res, error.status === 413 || error.type === 'entity.too.large' ? 413 : 400, error.status === 413 || error.type === 'entity.too.large' ? 'too-large' : 'bad-shot');
    },
    wrap((req, res) => {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (buffer.length > MAX_SHOT_BYTES) return fail(res, 413, 'too-large');
      if (!isJpeg(buffer)) return fail(res, 415, 'unsupported-media-type');
      const result = storeShot(req.devReportClient.id, String(req.query.sessionId || ''), String(req.query.shot || ''), buffer, { dataDir: dataDir() });
      if (!result.ok) return fail(res, result.status, result.code);
      noStore(res);
      return res.json({ ok: true, shot: result.shot, bytes: result.bytes });
    }, log)
  );

  // ---------------------------------------------------------------- directive status

  function directiveStatus(req, res, { staff }) {
    const client = req.makerClient || getClient(req.params.id);
    if (!client) return fail(res, 404, 'not-found');
    const did = String(req.params.did || '');
    if (!DIRECTIVE_RE.test(did)) return fail(res, 400, 'bad-directive-id');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const status = String(body.status ?? '');
    if (!['open', 'accepted', 'rejected', 'done'].includes(status)) return fail(res, 400, 'bad-status');
    if (!staff && status !== 'done') return fail(res, 403, 'status-not-allowed');
    if (briefErased(client.id, { dataDir: dataDir() })) return fail(res, 410, 'brief-erased');
    const brief = readLatestBrief(client.id, { dataDir: dataDir() });
    const listed = Array.isArray(brief?.directives) && brief.directives.some((entry) => String(entry?.id || '') === did);
    if (!listed) return fail(res, 404, 'not-found');
    const jobId = String(body.jobId || '').slice(0, 120);
    const by = staff ? String(req.developmentUser?.username || req.developmentUser?.accountKey || 'staff').slice(0, 120) : `maker:${req.makerAuth?.hostId || 'host'}`.slice(0, 120);
    const current = readReviews(client.id, { dataDir: dataDir() }).directives[did];
    const sameJob = !jobId || (Array.isArray(current?.appliedInJobs) && current.appliedInJobs.includes(jobId));
    if (current && current.status === status && sameJob) {
      noStore(res);
      return res.json({ ok: true, directive: { id: did, ...current } });
    }
    const note = String(body.note || (body.sessionId ? `session ${String(body.sessionId).slice(0, 80)}` : '')).slice(0, 500);
    const saved = setDirectiveStatus(client.id, did, { status, by, note, jobId }, { dataDir: dataDir() });
    noStore(res);
    return res.json({ ok: true, directive: { id: did, ...(saved?.directives?.[did] || readReviews(client.id, { dataDir: dataDir() }).directives[did] || { status }) } });
  }

  const hostStatusChain = [
    switchOn,
    hostOnly,
    makerClientAccess({ kind: 'directive-status', getClient, routedJobs, dataDir: dataDir(), param: 'id', refParam: 'did' }),
    wrap((req, res) => directiveStatus(req, res, { staff: false }), log),
  ];
  const staffStatusChain = [
    developmentAuth,
    wrap((req, res) => {
      const client = getClient(req.params.id);
      if (!client || !developmentItemVisible(req.developmentUser, client)) return fail(res, 404, 'not-found');
      if (!req.developmentUser?.isAdmin && !canWorkDevelopmentClient(req.developmentUser, client)) return fail(res, 403, 'forbidden');
      return directiveStatus(req, res, { staff: true });
    }, log),
  ];
  // A request that carries a host credential takes the host path; anything else needs a staff sign-in.
  app.patch('/api/maker/clients/:id/brief/directives/:did/status', (req, res, next) => {
    const chain = hasHostCredential(req) ? hostStatusChain : staffStatusChain;
    let index = 0;
    const step = (error) => {
      if (error) return next(error);
      const fn = chain[index];
      index += 1;
      return fn ? fn(req, res, step) : undefined;
    };
    return step();
  });

  // ---------------------------------------------------------------- staff reads

  function targetFor(itemId) {
    const parsed = parseDevelopmentItemId(itemId);
    if (parsed.kind === 'sales') return sales.getSalesClientById(parsed.id) || null;
    if (parsed.kind === 'site' && typeof hub?.getAllSites === 'function') {
      const site = hub.getAllSites().find((entry) => String(entry.id) === parsed.id) || null;
      return site ? findLinkedSalesClient(site, sales.getSalesClients()) : null;
    }
    return null;
  }

  function visibleClient(req, res) {
    const client = targetFor(req.params.id);
    if (!client || !developmentItemVisible(req.developmentUser, client)) {
      fail(res, 404, 'not-found');
      return null;
    }
    return client;
  }

  app.get(
    '/api/admin/development/board-status',
    developmentAuth,
    wrap((req, res) => {
      const items = typeof deps.boardItems === 'function' ? deps.boardItems(req.developmentUser) : [];
      const since = Number.parseInt(String(req.query.since ?? '0'), 10);
      const out = revisions.status(items, Number.isFinite(since) && since > 0 ? since : 0, String(req.developmentUser?.accountKey || req.developmentUser?.username || ''));
      noStore(res);
      return res.json({ ok: true, rev: out.rev, count: out.count, items: out.changed, removed: out.removed });
    }, log)
  );

  app.get(
    '/api/admin/development/:id/detail',
    developmentAuth,
    wrap((req, res) => {
      const client = visibleClient(req, res);
      if (!client) return undefined;
      noStore(res);
      return res.json({ ok: true, detail: boardDetail(client, { dataDir: dataDir() }) });
    }, log)
  );

  app.get(
    '/api/admin/development/:id/dev-report',
    developmentAuth,
    wrap((req, res) => {
      const client = visibleClient(req, res);
      if (!client) return undefined;
      const latest = listReports(client.id, { dataDir: dataDir() })[0] || null;
      noStore(res);
      return res.json({ ok: true, report: latest?.report || null, receivedAt: latest?.receivedAt || '', shots: listShots(client.id, { dataDir: dataDir() }) });
    }, log)
  );

  app.get(
    '/api/admin/development/:id/dev-report/shots/:sessionId/:shot',
    developmentAuth,
    wrap((req, res) => {
      const client = visibleClient(req, res);
      if (!client) return undefined;
      const image = readShot(client.id, req.params.sessionId, req.params.shot, { dataDir: dataDir() });
      if (!image) return fail(res, 404, 'not-found');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(image);
    }, log)
  );

  // ---------------------------------------------------------------- purge (admin only)

  const purgeSwitch = (_req, res, next) => (purgeJobsEnabled(settings()) ? next() : fail(res, 404, 'disabled'));
  function adminOnly(req, res, next) {
    // A valid Maker host token is a known caller that may not purge: 403, not the 401 of a stranger.
    if (hasHostCredential(req) && makerAuth.verifyMakerRequest?.(req, { scope: 'jobs' })?.ok) return fail(res, 403, 'forbidden');
    return developmentAuth(req, res, () => (req.developmentUser?.isAdmin ? next() : fail(res, 403, 'forbidden')));
  }

  app.post(
    '/api/admin/system/client-purge',
    purgeSwitch,
    adminOnly,
    wrap((req, res) => {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      try {
        if (body.mode === 'delete') {
          const result = applyClientPurge({ reportId: String(body.reportId || ''), backupListing: String(body.backupListing || ''), dataDir: dataDir() });
          const job = enqueuePurge(result.reportId, body);
          noStore(res);
          return res.json({ ok: true, mode: 'delete', ...result, makerJob: job });
        }
        if (body.mode !== 'report') return fail(res, 400, 'bad-mode');
        const result = reportClientPurge({ salesClientId: String(body.salesClientId || ''), dataDir: dataDir() });
        noStore(res);
        return res.json({ ok: true, mode: 'report', ...result });
      } catch (error) {
        if (error instanceof PurgeRefused) return fail(res, error.status, error.code);
        throw error;
      }
    }, log)
  );

  /** Asks the client's Maker host to erase its side (job kind purge). Never fails the hub-side erase. */
  function enqueuePurge(reportId, body) {
    const salesClientId = String(readReportClient(reportId) || '');
    if (!salesClientId) return { queued: false, code: 'no-client' };
    try {
      const client = getClient(salesClientId);
      if (typeof deps.enqueuePurgeJob === 'function') return deps.enqueuePurgeJob({ salesClientId, reportId, client });
      const hosts = typeof deps.listHosts === 'function' ? deps.listHosts() : [];
      const out = enqueueJob(
        { salesClientId, kind: 'purge', input: { salesClientId, hubReportId: reportId, mode: 'report' }, createdBy: 'purge' },
        { dataDir: dataDir(), client, hosts, settings: settings(), sales }
      );
      return { queued: Boolean(out?.ok), code: out?.code || '', jobId: out?.job?.id || '' };
    } catch (error) {
      return { queued: false, code: String(error?.code || 'error').slice(0, 60) };
    }
  }

  function readReportClient(reportId) {
    try {
      return deps.purgeReportClient ? deps.purgeReportClient(reportId) : readStoredReportClient(reportId, dataDir());
    } catch {
      return '';
    }
  }

  return undefined;
}


function readStoredReportClient(reportId, dataDir) {
  const file = join(dataDir || getPersistentDataDir(), PURGE_REPORT_DIR, `${reportId}.json`);
  return JSON.parse(readFileSync(file, 'utf8'))?.target?.salesClientId || '';
}
