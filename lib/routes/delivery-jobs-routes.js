// Delivery loop and job queue routes. Registered through lib/routes/optional-routes.js.
//
// Maker (host token with the 'jobs' scope; 404 {code:'disabled'} while delivery.loop is off):
//   GET  /api/maker/jobs                          jobs this host may claim (its handlers only, and
//                                                 only for clients in auto; none while the loop is
//                                                 paused or in shadow)
//   POST /api/maker/jobs/:id/claim                10-minute lease; 409 when taken, and 409
//                                                 'paused' / 'not-auto' while the client is not in auto
//   POST /api/maker/jobs/:id/heartbeat            {progress, log}; the answer carries stop:
//                                                 'paused' | 'not-auto' when the job should stop
//   POST /api/maker/jobs/:id/complete             {result, warnings}
//   POST /api/maker/jobs/:id/fail                 {error, blocking, retryable}
//   POST /api/maker/clients/:id/link-run          {runId}: links a run the host reports to a client
//                                                 without one; never replaces a linked run
// Developers (developmentAuth; the client must be visible to the caller):
//   GET  /api/admin/delivery/jobs?clientId=       switch state, the client's mode and its jobs
//   POST /api/admin/delivery/jobs                 {salesClientId, kind:'preview', input}
//   POST /api/admin/delivery/jobs/:jobId/cancel | /retry
// Superadmin (adminAuth):
//   GET  /api/admin/system/delivery-loop          health, steps, dirty marks, job counts, storage
//   POST /api/admin/system/delivery-loop/tick     {now}: one tick on a given clock (safe mode only;
//                                                 404 otherwise)
//   GET  /api/admin/system/delivery-alerts        active, recent and live alerts
import { getAutomationSettings } from '../../data/automation-settings.js';
import { getMakerHost, listMakerHosts } from '../../data/maker-hosts.js';
import { developmentItemVisible } from '../developer-assignment.js';
import { appendDeliveryAudit } from '../delivery-audit.js';
import { alertMailEnabled, currentAlerts, readAlertState, readHeartbeatFile } from '../delivery-alerts.js';
import {
  attachRunToJobs,
  cancelJob,
  claimJob,
  completeJob,
  failJob,
  getJob,
  heartbeatJob,
  isJobId,
  isRunId,
  kindSwitchOff,
  listJobs,
  listOfferable,
  requestJob,
  retryJob,
  routedJobsForClient,
} from '../delivery-jobs.js';
import {
  LOOP_SWITCH,
  deliveryLoopEnabled,
  deliveryLoopSettings,
  deliveryStorageReport,
  ensureDeliveryLoop,
  globalLoopMode,
  readDirtyMarks,
  readLoopHealth,
} from '../delivery-loop.js';
import { DEFAULT_POLL_AFTER_MS, hostReportsRun, makerClientAccess, registerHubCapabilities } from '../maker-host-meta.js';
import { isSafeModeActive } from '../safe-mode.js';
import { spineModeForClient } from '../spine-mode.js';

export const HUB_CAPABILITY_JOBS = 'delivery-jobs/1';
const ADMIN_ENQUEUE_KINDS = new Set(['preview']);

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function sendOutcome(res, outcome, extra = {}) {
  const status = Number(outcome?.status) || 500;
  if (status >= 400) return res.status(status).json({ ok: false, code: outcome?.code || 'error', ...(outcome?.job ? { job: outcome.job } : {}), ...extra });
  return res.status(status).json({ ok: true, ...outcome, ...extra });
}

/**
 * The site language a new run for this client should lock: the client's language, its linked run's
 * language, else the first language of its site plan ('' when none is known).
 */
export function clientLanguage(client) {
  const own = client?.language;
  const code = (typeof own === 'string' ? own : own?.code) || client?.makerRun?.language?.code || (Array.isArray(client?.sitePlan?.languages) ? client.sitePlan.languages[0] : '');
  const value = text(code, 12).toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(value) ? value : '';
}

/** What the claiming Maker needs to start or continue the client's run. */
function claimClientView(client) {
  if (!client) return null;
  return {
    id: client.id,
    businessName: text(client.businessName, 180),
    industry: text(client.industry, 180),
    websiteDomain: text(client.websiteDomain, 180),
    makerRun: { runId: text(client.makerRun?.runId, 80), templateSetId: text(client.makerRun?.templateSetId, 120) },
  };
}

export function register(app, deps = {}) {
  const { adminAuth, makerAuth, developmentAuth, sales, hub, getDataDir } = deps;
  if (!adminAuth || !makerAuth || !developmentAuth || !sales) throw new Error('delivery-jobs-routes: missing deps');
  const dataDir = () => (typeof getDataDir === 'function' ? getDataDir() : undefined);
  const settingsNow = () => getAutomationSettings({ dataDir: dataDir() });
  const loop = ensureDeliveryLoop({ sales, hub, dataDir: dataDir() });

  // Makers poll for jobs only while some client can get one: the loop on, in auto with pilots and
  // not paused. Off, shadow and paused offer nothing (a running job still gets its heartbeats).
  registerHubCapabilities('delivery-jobs', ({ dataDir: dir } = {}) => (globalLoopMode(getAutomationSettings({ dataDir: dir || dataDir() })) === 'auto' ? [HUB_CAPABILITY_JOBS] : []));

  const requireLoop = (_req, res, next) => {
    if (deliveryLoopEnabled(settingsNow())) return next();
    noStore(res);
    return res.status(404).json({ code: 'disabled', message: 'Not available.' });
  };
  const hostGate = makerAuth.requireMakerHost('jobs', { hostOnly: true });
  const freshHost = (req) => getMakerHost(req.makerAuth?.hostId, { dataDir: dataDir(), fresh: true }) || req.makerAuth?.host || null;
  const getClient = (id) => sales.getSalesClientById(id);
  const jobParam = (req, res) => {
    const id = String(req.params.id || '');
    if (isJobId(id)) return id;
    res.status(404).json({ ok: false, code: 'unknown-job' });
    return '';
  };

  // ------------------------------------------------------------ Maker pull API

  app.get('/api/maker/jobs', requireLoop, hostGate, (req, res) => {
    noStore(res);
    const host = freshHost(req);
    if (!host) return res.status(401).json({ message: 'Unauthorized callback.' });
    const settings = settingsNow();
    const mode = globalLoopMode(settings);
    // Paused or shadow: nothing is offered (the jobs stay queued until the loop is in auto again).
    if (mode !== 'auto') return res.json({ ok: true, hostId: host.hostId, jobs: [], hold: mode, pollAfterMs: DEFAULT_POLL_AFTER_MS });
    return res.json({ ok: true, hostId: host.hostId, jobs: listOfferable(host, { dataDir: dataDir(), settings, getClient }), pollAfterMs: DEFAULT_POLL_AFTER_MS });
  });

  app.post('/api/maker/jobs/:id/claim', requireLoop, hostGate, (req, res) => {
    noStore(res);
    const id = jobParam(req, res);
    if (!id) return undefined;
    const host = freshHost(req);
    const outcome = claimJob(id, host, { dataDir: dataDir(), sales, settings: settingsNow(), getClient });
    if (outcome?.status !== 200) return sendOutcome(res, outcome);
    return sendOutcome(res, outcome, { client: claimClientView(sales.getSalesClientById(outcome.job.salesClientId)) });
  });

  app.post('/api/maker/jobs/:id/heartbeat', requireLoop, hostGate, (req, res) => {
    noStore(res);
    const id = jobParam(req, res);
    if (!id) return undefined;
    const body = bodyOf(req);
    return sendOutcome(res, heartbeatJob(id, freshHost(req), { progress: body.progress, log: body.log, dataDir: dataDir(), sales, settings: settingsNow(), getClient }));
  });

  app.post('/api/maker/jobs/:id/complete', requireLoop, hostGate, (req, res) => {
    noStore(res);
    const id = jobParam(req, res);
    if (!id) return undefined;
    const body = bodyOf(req);
    return sendOutcome(res, completeJob(id, freshHost(req), { result: body.result, warnings: body.warnings, dataDir: dataDir(), sales }));
  });

  app.post('/api/maker/jobs/:id/fail', requireLoop, hostGate, (req, res) => {
    noStore(res);
    const id = jobParam(req, res);
    if (!id) return undefined;
    const body = bodyOf(req);
    return sendOutcome(res, failJob(id, freshHost(req), { error: body.error, blocking: body.blocking, retryable: body.retryable !== false, dataDir: dataDir(), sales }));
  });

  app.post(
    '/api/maker/clients/:id/link-run',
    requireLoop,
    hostGate,
    makerClientAccess({
      kind: 'link-run',
      getClient: (id) => sales.getSalesClientById(id),
      routedJobs: (clientId) => routedJobsForClient(clientId, { dataDir: dataDir() }),
      dataDir: dataDir(),
    }),
    (req, res) => {
      noStore(res);
      const runId = text(bodyOf(req).runId, 80);
      if (!isRunId(runId)) return res.status(400).json({ ok: false, code: 'bad-run-id' });
      const host = freshHost(req);
      if (!hostReportsRun(host, runId)) return res.status(403).json({ ok: false, code: 'run-not-on-host', message: 'Send a heartbeat that lists this run first.' });
      const client = req.makerClient;
      const linked = text(client.makerRun?.runId, 80);
      if (linked === runId) return res.json({ ok: true, linked: true, unchanged: true, runId });
      if (linked) return res.status(409).json({ ok: false, code: 'already-linked', runId: linked });
      const settings = settingsNow();
      const mode = spineModeForClient(LOOP_SWITCH, client, { settings, dataDir: dataDir() });
      if (mode !== 'auto') return res.status(409).json({ ok: false, code: mode === 'paused' ? 'paused' : 'not-auto' });
      const updated = sales.setSalesMakerRun(client.id, { runId, createdAt: new Date().toISOString() });
      if (!updated) return res.status(404).json({ ok: false, code: 'unknown-client' });
      const jobs = attachRunToJobs(client.id, runId, { dataDir: dataDir() });
      appendDeliveryAudit({ kind: 'job', clientId: client.id, by: host.hostId, reason: 'link-run', runId }, { dataDir: dataDir() });
      return res.json({ ok: true, linked: true, runId, jobsUpdated: jobs });
    },
  );

  // ------------------------------------------------------------ developers

  const visibleClient = (req, res, clientId) => {
    const client = clientId ? sales.getSalesClientById(clientId) : null;
    if (!client || !developmentItemVisible(req.developmentUser, client)) {
      res.status(404).json({ ok: false, message: 'Development client not found.' });
      return null;
    }
    return client;
  };

  app.get('/api/admin/delivery/jobs', developmentAuth, (req, res) => {
    noStore(res);
    const settings = settingsNow();
    const enabled = deliveryLoopEnabled(settings);
    const clientId = text(req.query?.clientId, 80);
    if (clientId) {
      const client = visibleClient(req, res, clientId);
      if (!client) return undefined;
      const mode = enabled ? spineModeForClient(LOOP_SWITCH, client, { settings, dataDir: dataDir() }) : 'off';
      return res.json({
        ok: true,
        enabled,
        previewJobs: settings.development?.previewJobs === true,
        mode,
        canEnqueuePreview: enabled && !kindSwitchOff('preview', settings) && mode === 'auto',
        jobs: enabled ? listJobs({ dataDir: dataDir(), clientId }) : [],
      });
    }
    if (!req.developmentUser?.isAdmin) return res.status(400).json({ ok: false, message: 'clientId is required.' });
    return res.json({ ok: true, enabled, jobs: enabled ? listJobs({ dataDir: dataDir(), status: text(req.query?.status, 20), kind: text(req.query?.kind, 40) }) : [] });
  });

  app.post('/api/admin/delivery/jobs', developmentAuth, requireLoop, (req, res) => {
    noStore(res);
    const body = bodyOf(req);
    const kind = text(body.kind, 40);
    if (!ADMIN_ENQUEUE_KINDS.has(kind)) return res.status(400).json({ ok: false, code: 'kind-not-allowed', allowed: [...ADMIN_ENQUEUE_KINDS] });
    const client = visibleClient(req, res, text(body.salesClientId, 80));
    if (!client) return undefined;
    const input = body.input && typeof body.input === 'object' ? body.input : {};
    const outcome = requestJob(
      {
        kind,
        input: {
          templateSetId: text(input.templateSetId, 120) || text(client.makerRun?.templateSetId, 120),
          language: text(input.language, 12) || clientLanguage(client),
          pages: input.pages,
        },
        createdBy: `developer:${text(req.developmentUser?.accountKey || req.developmentUser?.username, 80)}`,
      },
      { dataDir: dataDir(), client, hosts: listMakerHosts({ dataDir: dataDir() }), sales },
    );
    return sendOutcome(res, outcome, { mode: outcome.mode, ...(outcome.shadow ? { shadow: true } : {}) });
  });

  for (const action of ['cancel', 'retry']) {
    app.post(`/api/admin/delivery/jobs/:jobId/${action}`, developmentAuth, requireLoop, (req, res) => {
      noStore(res);
      const jobId = String(req.params.jobId || '');
      const job = isJobId(jobId) ? getJob(jobId, { dataDir: dataDir() }) : null;
      if (!job) return res.status(404).json({ ok: false, code: 'unknown-job' });
      if (!visibleClient(req, res, job.salesClientId)) return undefined;
      const by = text(req.developmentUser?.accountKey || req.developmentUser?.username, 80);
      const outcome = action === 'cancel' ? cancelJob(jobId, { by, dataDir: dataDir(), sales }) : retryJob(jobId, { by, dataDir: dataDir(), sales });
      return sendOutcome(res, outcome);
    });
  }

  // ------------------------------------------------------------ superadmin

  app.get('/api/admin/system/delivery-loop', adminAuth, async (_req, res) => {
    noStore(res);
    const settings = settingsNow();
    const counts = {};
    for (const job of listJobs({ dataDir: dataDir() })) counts[job.status] = (counts[job.status] || 0) + 1;
    const registered = await loop.steps().catch((error) => ({ steps: [], errors: [{ module: 'loop', error: String(error?.message || error) }] }));
    return res.json({
      ok: true,
      enabled: deliveryLoopEnabled(settings),
      mode: globalLoopMode(settings),
      settings: deliveryLoopSettings(settings),
      safeMode: isSafeModeActive(),
      health: loop.health(),
      storedHealth: readLoopHealth({ dataDir: dataDir() }),
      steps: registered.steps,
      stepErrors: registered.errors,
      dirtyClients: Object.keys(readDirtyMarks({ dataDir: dataDir() })).length,
      jobs: counts,
      storage: deliveryStorageReport({ dataDir: dataDir() }),
    });
  });

  app.post('/api/admin/system/delivery-loop/tick', adminAuth, async (req, res) => {
    noStore(res);
    if (!isSafeModeActive()) return res.status(404).json({ message: 'Not found.' });
    const nowValue = bodyOf(req).now;
    const parsed = nowValue === undefined || nowValue === null || nowValue === '' ? 0 : typeof nowValue === 'number' ? nowValue : Date.parse(String(nowValue));
    if (nowValue !== undefined && nowValue !== null && nowValue !== '' && !Number.isFinite(parsed)) return res.status(400).json({ ok: false, code: 'bad-now' });
    try {
      const result = await loop.tick(parsed ? { now: parsed } : {});
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(500).json({ ok: false, message: String(error?.message || error).slice(0, 300) });
    }
  });

  app.get('/api/admin/system/delivery-alerts', adminAuth, (_req, res) => {
    noStore(res);
    const settings = settingsNow();
    const stored = readAlertState({ dataDir: dataDir() });
    const health = loop.health();
    return res.json({
      ok: true,
      enabled: deliveryLoopEnabled(settings),
      mail: alertMailEnabled(settings),
      to: settings.alerts?.to || '',
      active: Object.values(stored.active),
      recent: stored.history.slice(-20).reverse(),
      live: currentAlerts({
        dataDir: dataDir(),
        settings,
        heartbeats: readHeartbeatFile({ dataDir: dataDir() }),
        previousSuccessAt: health.lastSuccessAt,
        recentErrors: health.lastErrors,
      }),
    });
  });

  return { loop };
}
