// Delivery brief routes, registered through lib/routes/optional-routes.js.
//
// Developer board (developmentAuth; a developer sees only their own clients):
//   GET   /api/admin/development/:id/brief[?format=md][&version=N]   the brief (ETag, 304)
//   GET   /api/admin/development/:id/brief/versions                   stored versions
//   POST  /api/admin/development/:id/brief/rebuild {wait?, retryGaps?} rebuild now (409 brief-busy
//                                                                       while another runner holds it)
//   PATCH /api/admin/development/:id/brief/directives/:directiveId {status, note?}
//   PATCH /api/admin/development/:id/brief/facts {path, status, value?, note?}  (400 when the review
//                                                                       would make the brief invalid)
// Maker (host token with scope jobs, and a routed job or the client's linked run):
//   GET   /api/maker/clients/:id/brief                 the newest brief (ETag, 304)
//   GET   /api/maker/clients/:id/transcripts/:sha256   one transcript, on demand
//
// After a privacy erase of the client, the writing routes answer 410 {code:'brief-erased'} and write
// nothing.
//
// Switch `brief`: while it is off every route answers 404 {code:'brief-disabled'} before any
// other check or write. In shadow the board routes work and the Maker routes answer 404
// {code:'brief-disabled'}; in auto (pilot clients) the Maker routes serve too. Every Maker request
// for a client's data is written to the Maker access log (ids only).
//
// ETag: the brief hash, which leaves URL signatures out. When the build signs media URLs (the media
// manifest's signer, while its switch is on), each fetch signs them again with an expiry on the next
// full hour after 24 hours, and the ETag also covers the signed URLs actually sent, so a client never
// keeps expired ones through a 304.
import { createHash } from 'node:crypto';
import { effectiveSwitchMode, getAutomationSettings } from '../../data/automation-settings.js';
import { acquireLease } from '../../data/email-store.js';
import { canWorkDevelopmentClient, developmentItemVisible } from '../developer-assignment.js';
import { makerClientAccess } from '../maker-host-meta.js';
import { BRIEF_SWITCH, LEASE_TTL_MS, briefModeForClient, rebuildBrief, reassembleBrief, reviewBriefFact } from '../delivery-brief/index.js';
import { renderBriefMarkdown } from '../delivery-brief/render-md.js';
import { findClientTranscript, moduleFor, optionalModule } from '../delivery-brief/sources.js';
import {
  briefErased,
  listBriefVersions,
  readBriefVersion,
  readLatestBrief,
  registerBriefStore,
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

/** The ETag of a brief as sent: its hash, plus a digest of the media URLs when they were signed for this response. */
function briefEtag(stored, sent) {
  if (sent === stored) return etagOf(stored.hash);
  const urls = (Array.isArray(sent?.facts?.media?.manifest) ? sent.facts.media.manifest : []).map((item) => String(item?.url || ''));
  return etagOf(`${stored.hash}:${createHash('sha256').update(JSON.stringify(urls)).digest('hex').slice(0, 16)}`);
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

const MEDIA_ROUTE_PREFIX = '/api/maker/media/';
const MEDIA_URL_TTL_MS = 24 * 60 * 60 * 1000;
// Signed links expire on the hour, so every fetch within the same hour sends the same links (and the
// same ETag), and a link always lasts at least the manifest's TTL.
const SIGN_WINDOW_MS = 60 * 60 * 1000;

/**
 * The build's media signer (lib/media-manifest.js signMediaUrl({ assetId, clientId, expiresAt, dataDir })),
 * only while the media switch (lib/privacy-settings.js signedMediaEnabled) is on, as (item, {client}) →
 * signed path for a hub media item ('/api/maker/media/<id>'), '' for any other item. null otherwise.
 */
export async function buildMediaSigner({ log = console, modules = null, settings = undefined, dataDir = undefined, now = Date.now() } = {}) {
  const deps = { modules };
  const mod = await moduleFor('../media-manifest.js', deps, log);
  if (typeof mod?.signMediaUrl !== 'function') return null;
  const privacy = await moduleFor('../privacy-settings.js', deps, log);
  if (typeof privacy?.signedMediaEnabled !== 'function') return null;
  let enabled = false;
  try {
    enabled = privacy.signedMediaEnabled(settings) === true;
  } catch {
    enabled = false;
  }
  if (!enabled) return null;
  const prefix = typeof mod.MEDIA_ROUTE_PREFIX === 'string' && mod.MEDIA_ROUTE_PREFIX ? mod.MEDIA_ROUTE_PREFIX : MEDIA_ROUTE_PREFIX;
  const ttl = Number(mod.MEDIA_URL_TTL_MS) > 0 ? Number(mod.MEDIA_URL_TTL_MS) : MEDIA_URL_TTL_MS;
  const expiresAt = Math.ceil((now + ttl) / SIGN_WINDOW_MS) * SIGN_WINDOW_MS;
  return (item, { client } = {}) => {
    const assetId = String(item?.id || '');
    const clientId = String(client?.id || '');
    if (!assetId || !clientId || !String(item?.url || '').startsWith(prefix)) return '';
    return mod.signMediaUrl({ assetId, clientId, expiresAt, ...(dataDir ? { dataDir } : {}) });
  };
}

/** Signed media URLs are made fresh on every fetch when the build has a signer; the same object comes back otherwise. */
async function withFreshMediaUrls(brief, client, log, signer = null, signerOptions = {}) {
  const manifest = brief?.facts?.media?.manifest;
  if (!Array.isArray(manifest) || !manifest.length) return brief;
  const sign = signer || (await buildMediaSigner({ log, ...signerOptions }));
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
 * routedJobs(clientId) (jobs routed to hosts), settings() (automation settings), signMediaUrl(item,
 * {client}) (replaces the build's media signer), personalDataRegistry (replaces lib/personal-data.js),
 * log. briefDeps.modules stands in for optional modules (see sources.js), the media signer's too.
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

  // Privacy export and erase see the brief store from boot on, not only after a rebuild in this
  // process. Registering writes nothing, so it changes nothing while the switch is off.
  await registerBriefStore({ log, registry: deps.personalDataRegistry || null });
  const fresh = (brief, client) => withFreshMediaUrls(brief, client, log, typeof deps.signMediaUrl === 'function' ? deps.signMediaUrl : null, {
    modules: deps.briefDeps?.modules || null,
    settings: settings(),
    dataDir: dataDir(),
  });

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

  /**
   * Starts a rebuild under the lease brief:<id>, shared with the delivery loop and other hub
   * processes. Returns { promise } (a rebuild of this client already running in this process is
   * joined), or { busy: true } while another runner holds the lease.
   */
  async function startRebuild(client, { retryGaps = false } = {}) {
    const id = String(client.id);
    if (running.has(id)) return { promise: running.get(id) };
    const lease = await acquireLease(`brief:${id}`, LEASE_TTL_MS);
    if (!lease) return { busy: true };
    const promise = (async () => {
      try {
        return await rebuildBrief(client, {
          llm: deps.briefLlm || null,
          dataDir: dataDir(),
          deps: deps.briefDeps || {},
          log,
          deadline: Date.now() + 5 * 60 * 1000,
          lease,
          // A person asked for this rebuild: chunks waiting out a backoff are asked again now.
          ignoreBackoff: true,
          retryGaps,
        });
      } finally {
        await lease.release();
      }
    })().finally(() => running.delete(id));
    running.set(id, promise);
    return { promise };
  }

  function busy(res) {
    noStore(res);
    return res.status(409).json({ message: 'Another rebuild of this brief is running.', code: 'brief-busy' });
  }

  function erased(res) {
    noStore(res);
    return res.status(410).json({ message: 'The brief of this client was erased.', code: 'brief-erased' });
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
    const sent = markdown ? brief : await fresh(brief, client);
    const etag = markdown ? etagOf(`${brief.hash}:md`) : briefEtag(brief, sent);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
    if (notModified(req, etag)) return res.status(304).end();
    if (markdown) return res.type('text/markdown; charset=utf-8').send(renderBriefMarkdown(brief));
    return res.json(sent);
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
    if (briefErased(client.id, { dataDir: dataDir() })) return erased(res);
    const started = await startRebuild(client, { retryGaps: bodyOf(req).retryGaps === true });
    if (started.busy) return busy(res);
    const { promise } = started;
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
      if (result.status === 'lease-lost') return busy(res);
      return res.status(result.status === 'running' ? 202 : 200).json({ ok: true, ...result });
    } catch (error) {
      if (error?.code === 'brief-busy') return busy(res);
      if (error?.code === 'brief-erased') return erased(res);
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
      if (error?.code === 'brief-erased') return erased(res);
      throw error;
    }
    let result;
    try {
      result = await reassembleBrief(client, { dataDir: dataDir(), deps: deps.briefDeps || {}, log });
    } catch (error) {
      if (error?.code === 'brief-erased') return erased(res);
      throw error;
    }
    return res.json({ ok: true, ...result });
  }, log));

  app.patch('/api/admin/development/:id/brief/facts', switchOn, developmentAuth, wrap(async (req, res) => {
    const client = boardClient(req, res, { write: true });
    if (!client) return undefined;
    noStore(res);
    const body = bodyOf(req);
    let result;
    try {
      result = await reviewBriefFact(client, body.path, { status: body.status, value: body.value, note: body.note, by: actorOf(req) }, { dataDir: dataDir(), deps: deps.briefDeps || {}, log });
    } catch (error) {
      if (['bad-fact-path', 'bad-status', 'bad-value', 'invalid-review'].includes(error?.code)) {
        return res.status(400).json({
          message: error.message,
          code: error.code,
          ...(Array.isArray(error.errors) ? { errors: error.errors.slice(0, 5).map((row) => ({ path: String(row?.path || ''), message: String(row?.message || '') })) } : {}),
        });
      }
      if (error?.code === 'brief-erased') return erased(res);
      throw error;
    }
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
      const sent = await fresh(brief, req.makerClient);
      const etag = briefEtag(brief, sent);
      res.setHeader('ETag', etag);
      if (notModified(req, etag)) return res.status(304).end();
      return res.json(sent);
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
