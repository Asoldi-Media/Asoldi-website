// Delivery brief routes, registered through lib/routes/optional-routes.js.
//
// Developer board (developmentAuth; a developer sees only their own clients):
//   GET   /api/admin/development/:id/brief[?format=md][&version=N]   the brief (ETag, 304)
//   GET   /api/admin/development/:id/brief/versions                   stored versions
//   POST  /api/admin/development/:id/brief/rebuild {wait?}            rebuild now
//   PATCH /api/admin/development/:id/brief/directives/:directiveId {status, note?}
//   PATCH /api/admin/development/:id/brief/facts {path, status, value?, note?}
// Maker (host token with scope jobs, and a routed job or the client's linked run):
//   GET   /api/maker/clients/:id/brief                 the newest brief (ETag, 304)
//   GET   /api/maker/clients/:id/transcripts/:sha256   one transcript, on demand
//
// Switch `brief`: while it is off every route answers 404 {code:'brief-disabled'} before any
// other check or write. In shadow the board routes work and the Maker routes answer 404
// {code:'brief-disabled'}; in auto (pilot clients) the Maker routes serve too. Every Maker request
// for a client's data is written to the Maker access log (ids only).
import { effectiveSwitchMode, getAutomationSettings } from '../../data/automation-settings.js';
import { canWorkDevelopmentClient, developmentItemVisible } from '../developer-assignment.js';
import { makerClientAccess } from '../maker-host-meta.js';
import { BRIEF_SWITCH, briefModeForClient, rebuildBrief, reassembleBrief } from '../delivery-brief/index.js';
import { renderBriefMarkdown } from '../delivery-brief/render-md.js';
import { findClientTranscript, optionalModule } from '../delivery-brief/sources.js';
import {
  listBriefVersions,
  readBriefVersion,
  readLatestBrief,
  registerBriefStore,
  reviewFact,
  setDirectiveStatus,
} from '../delivery-brief/store.js';

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const REBUILD_WAIT_MS = 120_000;

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function disabled(res) {
  noStore(res);
  return res.status(404).json({ message: 'The delivery brief is switched off.', code: 'brief-disabled' });
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function etagOf(value) {
  return `"${String(value || '').replace(/"/g, '')}"`;
}

function notModified(req, etag) {
  const header = String(req.headers['if-none-match'] || '');
  if (!header) return false;
  return header.split(',').map((part) => part.trim().replace(/^W\//, '')).includes(etag);
}

/** Express 4 does not catch a rejected handler: answer 500 instead of leaving the request hanging. */
function wrap(handler, log) {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error) => {
        log?.error?.(`[delivery-brief] ${req.method} ${req.path} failed: ${error?.code || error?.message || 'error'}`);
        if (!res.headersSent) res.status(500).json({ message: 'The brief request failed.', code: String(error?.code || 'error').slice(0, 60) });
      });
  };
}

function actorOf(req) {
  const user = req.developmentUser || {};
  return String(user.username || user.accountKey || user.role || 'developer').slice(0, 120);
}

/** Signed media URLs are made fresh on every fetch when the build has a signer. */
async function withFreshMediaUrls(brief, client, log) {
  const manifest = brief?.facts?.media?.manifest;
  if (!Array.isArray(manifest) || !manifest.length) return brief;
  const mod = await optionalModule('../media-manifest.js', { log });
  const sign = typeof mod?.signedMediaUrl === 'function' ? mod.signedMediaUrl : null;
  if (!sign) return brief;
  const items = manifest.map((item) => {
    try {
      const url = sign(item, { client });
      return url ? { ...item, url: String(url) } : item;
    } catch {
      return item;
    }
  });
  return { ...brief, facts: { ...brief.facts, media: { ...brief.facts.media, manifest: items } } };
}

/**
 * deps (from server.js through optional-routes.js): developmentAuth, makerAuth (createMakerAuth()),
 * sales (data/sales.js), getDataDir. Optional: briefLlm (an LLM facade), briefDeps (source readers),
 * routedJobs(clientId) (jobs routed to hosts), settings() (automation settings), log.
 */
export async function register(app, deps = {}) {
  const { developmentAuth, makerAuth, sales } = deps;
  if (typeof developmentAuth !== 'function' || !makerAuth?.requireMakerHost || typeof sales?.getSalesClientById !== 'function') {
    throw new Error('brief-routes: missing developmentAuth, makerAuth or sales');
  }
  const log = deps.log || console;
  const dataDir = () => (typeof deps.getDataDir === 'function' ? deps.getDataDir() : undefined);
  const settings = () => (typeof deps.settings === 'function' ? deps.settings() : getAutomationSettings({ dataDir: dataDir() }));
  const getClient = (id) => (CLIENT_ID_RE.test(String(id || '')) ? sales.getSalesClientById(String(id)) : null);
  const running = new Map();

  let routedJobs = typeof deps.routedJobs === 'function' ? deps.routedJobs : null;
  if (!routedJobs) {
    const jobs = await optionalModule('../delivery-jobs.js', { log });
    const fn = ['routedJobsForClient', 'jobsForClient', 'listJobsForClient'].map((name) => jobs?.[name]).find((value) => typeof value === 'function');
    routedJobs = fn ? (clientId) => fn(clientId, { dataDir: dataDir() }) : () => [];
  }

  /** The global switch: off answers before anything else runs. */
  const switchOn = (_req, res, next) => (effectiveSwitchMode(BRIEF_SWITCH, { settings: settings() }) === 'off' ? disabled(res) : next());

  /** Board routes: the client exists, the caller may see it, and its brief mode is not off. */
  function boardClient(req, res, { write = false } = {}) {
    const client = getClient(req.params.id);
    if (!client || !developmentItemVisible(req.developmentUser, client)) {
      noStore(res);
      res.status(404).json({ message: 'Development client not found.' });
      return null;
    }
    if (write && !req.developmentUser?.isAdmin && !canWorkDevelopmentClient(req.developmentUser, client)) {
      noStore(res);
      res.status(403).json({ message: 'This project is assigned to another developer.' });
      return null;
    }
    const mode = briefModeForClient(client, { settings: settings() });
    if (mode === 'off' || mode === 'paused') {
      disabled(res);
      return null;
    }
    return client;
  }

  function startRebuild(client) {
    const id = String(client.id);
    if (running.has(id)) return running.get(id);
    const promise = (async () => {
      await registerBriefStore({ dataDir: dataDir() });
      return rebuildBrief(client, { llm: deps.briefLlm || null, dataDir: dataDir(), deps: deps.briefDeps || {}, log, deadline: Date.now() + 5 * 60 * 1000 });
    })().finally(() => running.delete(id));
    running.set(id, promise);
    return promise;
  }

  app.get('/api/admin/development/:id/brief', switchOn, developmentAuth, wrap(async (req, res) => {
    const client = boardClient(req, res);
    if (!client) return undefined;
    const version = req.query?.version ? Number(req.query.version) : 0;
    const brief = version ? readBriefVersion(client.id, version, { dataDir: dataDir() }) : readLatestBrief(client.id, { dataDir: dataDir() });
    if (!brief) {
      noStore(res);
      return res.status(404).json({ message: 'No brief yet.', code: 'no-brief' });
    }
    const markdown = String(req.query?.format || '').toLowerCase() === 'md';
    const etag = etagOf(`${brief.hash}${markdown ? ':md' : ''}`);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
    if (notModified(req, etag)) return res.status(304).end();
    if (markdown) return res.type('text/markdown; charset=utf-8').send(renderBriefMarkdown(brief));
    return res.json(await withFreshMediaUrls(brief, client, log));
  }, log));

  app.get('/api/admin/development/:id/brief/versions', switchOn, developmentAuth, (req, res) => {
    const client = boardClient(req, res);
    if (!client) return undefined;
    noStore(res);
    return res.json({ versions: listBriefVersions(client.id, { dataDir: dataDir() }), mode: briefModeForClient(client, { settings: settings() }) });
  });

  app.post('/api/admin/development/:id/brief/rebuild', switchOn, developmentAuth, wrap(async (req, res) => {
    const client = boardClient(req, res, { write: true });
    if (!client) return undefined;
    noStore(res);
    const promise = startRebuild(client);
    if (bodyOf(req).wait !== true) {
      promise.catch((error) => log.warn?.(`[delivery-brief] rebuild failed for ${client.id}: ${error?.code || error?.message || 'error'}`));
      return res.status(202).json({ ok: true, status: 'started' });
    }
    let timer = null;
    try {
      const result = await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ status: 'running' }), REBUILD_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      return res.status(result.status === 'running' ? 202 : 200).json({ ok: true, ...result });
    } catch (error) {
      return res.status(500).json({ message: 'The brief rebuild failed.', code: String(error?.code || 'error').slice(0, 60) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, log));

  app.patch('/api/admin/development/:id/brief/directives/:directiveId', switchOn, developmentAuth, wrap(async (req, res) => {
    const client = boardClient(req, res, { write: true });
    if (!client) return undefined;
    noStore(res);
    const body = bodyOf(req);
    try {
      setDirectiveStatus(client.id, req.params.directiveId, { status: body.status, note: body.note, jobId: body.jobId, by: actorOf(req) }, { dataDir: dataDir() });
    } catch (error) {
      if (['bad-directive-id', 'bad-status'].includes(error?.code)) return res.status(400).json({ message: error.message, code: error.code });
      throw error;
    }
    const result = await reassembleBrief(client, { dataDir: dataDir(), deps: deps.briefDeps || {}, log });
    return res.json({ ok: true, ...result });
  }, log));

  app.patch('/api/admin/development/:id/brief/facts', switchOn, developmentAuth, wrap(async (req, res) => {
    const client = boardClient(req, res, { write: true });
    if (!client) return undefined;
    noStore(res);
    const body = bodyOf(req);
    try {
      reviewFact(client.id, body.path, { status: body.status, value: body.value, note: body.note, by: actorOf(req) }, { dataDir: dataDir() });
    } catch (error) {
      if (['bad-fact-path', 'bad-status', 'bad-value'].includes(error?.code)) return res.status(400).json({ message: error.message, code: error.code });
      throw error;
    }
    const result = await reassembleBrief(client, { dataDir: dataDir(), deps: deps.briefDeps || {}, log });
    return res.json({ ok: true, ...result });
  }, log));

  // ---------------------------------------------------------------- Maker

  const hostOnly = makerAuth.requireMakerHost('jobs', { hostOnly: true });
  const makerMode = (req, res, next) => {
    const mode = briefModeForClient(req.makerClient, { settings: settings() });
    return mode === 'auto' ? next() : disabled(res);
  };

  app.get(
    '/api/maker/clients/:id/brief',
    switchOn,
    hostOnly,
    makerClientAccess({ kind: 'brief', getClient, routedJobs, dataDir: dataDir() }),
    makerMode,
    wrap(async (req, res) => {
      const brief = readLatestBrief(req.makerClient.id, { dataDir: dataDir() });
      res.setHeader('Cache-Control', 'private, no-cache');
      if (!brief) return res.status(404).json({ message: 'No brief yet.', code: 'no-brief' });
      const etag = etagOf(brief.hash);
      res.setHeader('ETag', etag);
      if (notModified(req, etag)) return res.status(304).end();
      return res.json(await withFreshMediaUrls(brief, req.makerClient, log));
    }, log)
  );

  app.get(
    '/api/maker/clients/:id/transcripts/:sha256',
    switchOn,
    hostOnly,
    makerClientAccess({ kind: 'transcript', getClient, routedJobs, dataDir: dataDir(), refParam: 'sha256' }),
    makerMode,
    wrap(async (req, res) => {
      noStore(res);
      const sha = String(req.params.sha256 || '').toLowerCase();
      if (!SHA_RE.test(sha)) return res.status(400).json({ message: 'Not a transcript sha256.', code: 'bad-sha256' });
      const etag = etagOf(`sha256:${sha}`);
      const found = await findClientTranscript(req.makerClient, sha, { deps: deps.briefDeps || {}, log });
      if (!found) return res.status(404).json({ message: 'No such transcript for this client.', code: 'no-transcript' });
      res.setHeader('ETag', etag);
      if (notModified(req, etag)) return res.status(304).end();
      return res.json({
        meetingId: found.meetingId,
        purpose: found.purpose,
        startedAt: found.startedAt || '',
        sha256: sha,
        chars: found.transcript.length,
        transcript: found.transcript,
      });
    }, log)
  );
}
