// scripts/golden/delivery-e2e.mjs
// -----------------------------------------------------------------------------
// The delivery end-to-end driver: a hub booted in safe mode on a seeded `.local-data` folder
// (seed-hub.mjs, then seed-delivery.mjs), driven over HTTP from signing to a Maker preview job.
// Used by the release suite (scripts/release-suite.mjs, with the stub worker below) and by the
// Maker's golden runner (`run.mjs --delivery`, with the real Maker worker).
//
// runDeliveryScenario does, for every client of the plan:
//   1. the client's Kundedata in the portal (an account, the data bank, the portal link), when the
//      plan gives a bank;
//   2. signs it through its signing path (progression, got-client, preview-accept, portal-accept);
//   3. moves a fake clock through the safe-mode tick route: one tick per minute until every brief
//      is built (at most 6), then snapshots the gate;
//   4. marks the workshop held (ended 5 minutes ago) and ticks one minute before and one minute
//      after the latest post-workshop due time;
//   5. links a Maker run the plan names (the sales preview run) and enqueues one preview job per
//      client, waits for the worker to finish them, and ticks once more.
// Nothing here reads hub modules: only HTTP and the data folder, so it drives any hub build.
// The hub's own 60-second loop keeps ticking on the real clock meanwhile; the fake clock only moves
// ahead of it, so both see time move forward.
// -----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');
export const SIGNING_PATHS = Object.freeze(['progression', 'got-client', 'preview-accept', 'portal-accept']);
// The portal accounts of one run share a random password that lives only in this process.
const portalSecret = randomBytes(18).toString('base64url');
const MINUTE = 60_000;
const DROP_ENV = /^(HUB_SAFE_MODE|HUB_LISTEN_HOST|HOSTINGER|EMAIL_REDIRECT_TO|WEBSITE_MAKER_|SALES_PREVIEW_PUSH_URL|SALES_MAKER_STATUS|HUB_PUBLIC_URL_FOR_MAKER|APP_DATA_DIR|DATA_DIR|ADMIN_|PROD_|RESEND_|SMTP_|BREVO_|STRIPE_|FIREFLIES_|DEEPSEEK_|ANTHROPIC_|GEMINI_|OPENAI_|GOOGLE_|GITHUB_|AI_PROFILE)/;

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export function freePort() {
  return new Promise((done) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/**
 * Boots server.js in safe mode on `dataDir` (a seeded `.local-data` folder) from an empty working
 * folder, so no .env is read, with the egress recorder refusing every host but loopback.
 * extraEnv may hold only the names the caller needs (for example HUB_SAFE_MODE_ALLOW).
 */
export async function bootDeliveryHub({ hubDir = REPO, dataDir, port = 0, extraEnv = {}, egressFile = '', egressAllow = '', bootTimeoutMs = 120_000 } = {}) {
  if (!dataDir || !resolve(dataDir).split(/[\\/]+/).includes('.local-data')) throw new Error(`bootDeliveryHub: ${dataDir} is not below a .local-data folder`);
  const listenPort = port || (await freePort());
  const shell = {};
  for (const [key, value] of Object.entries(process.env)) if (!DROP_ENV.test(key)) shell[key] = value;
  const audit = join(hubDir, 'scripts', 'safe-mode', 'egress-audit.cjs').replace(/\\/g, '/');
  const env = {
    ...shell,
    ...extraEnv,
    HUB_SAFE_MODE: '1',
    PORT: String(listenPort),
    APP_DATA_DIR: resolve(dataDir),
    PERSIST_PRODUCTION_ENV: '0',
    NODE_OPTIONS: `--require="${audit}"`,
    EGRESS_AUDIT_FILE: egressFile || join(resolve(dataDir), 'egress.jsonl'),
    // Loopback only, unless the caller names hosts (a live LLM recording run names its provider).
    EGRESS_AUDIT_ALLOW: egressAllow,
    EGRESS_AUDIT_ENFORCE: '1',
  };
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-e2e-hub-cwd-'));
  const child = spawn(process.execPath, [join(hubDir, 'server.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${listenPort}`;
  let health = null;
  const deadline = Date.now() + bootTimeoutMs;
  while (!health && Date.now() < deadline && child.exitCode === null) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) health = await res.json();
    } catch {
      await sleep(500);
    }
  }
  const hub = {
    base,
    port: listenPort,
    dataDir: resolve(dataDir),
    health,
    egressFile: env.EGRESS_AUDIT_FILE,
    log: () => log,
    async stop() {
      child.kill('SIGTERM');
      await sleep(800);
      if (child.exitCode === null) child.kill('SIGKILL');
      await sleep(300);
      rmSync(cwd, { recursive: true, force: true });
    },
  };
  if (health?.safeMode !== true) {
    await hub.stop();
    throw new Error(`the hub did not start in safe mode:\n${log.slice(-3000)}`);
  }
  return hub;
}

/** JSON over HTTP: { status, body }. Never throws for an HTTP status. */
export function hubApi(base, { token = '', headers = {} } = {}) {
  const call = async (method, path, body, extra = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body: parsed };
  };
  return {
    get: (path, extra) => call('GET', path, undefined, extra),
    post: (path, body = {}, extra) => call('POST', path, body, extra),
    put: (path, body = {}, extra) => call('PUT', path, body, extra),
    patch: (path, body = {}, extra) => call('PATCH', path, body, extra),
  };
}

/** The local admin's bearer token (the seeded admin from secrets/local-admin.json). */
export async function adminToken(base, dataDir) {
  const admin = JSON.parse(readFileSync(join(dataDir, 'secrets', 'local-admin.json'), 'utf8'));
  await sleep(500);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await hubApi(base).post('/api/admin/login', { username: admin.username, password: admin.password });
    if (res.body?.token) return res.body.token;
    await sleep(750);
  }
  throw new Error('the local admin could not sign in');
}

/** Outbox rows ({id, channel, transport, to, subject, ...}) in write order. */
export function readOutbox(dataDir) {
  const file = join(dataDir, 'outbox', 'index.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/** Waits until the outbox stops growing for quietMs (mails sent after a response land a little later). */
export async function settledOutbox(dataDir, { quietMs = 2000, maxMs = 30_000 } = {}) {
  const started = Date.now();
  let count = readOutbox(dataDir).length;
  let stableSince = Date.now();
  while (Date.now() - started < maxMs) {
    await sleep(250);
    const next = readOutbox(dataDir).length;
    if (next !== count) {
      count = next;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) break;
  }
  return readOutbox(dataDir);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function salesClient(dataDir, id) {
  const raw = readJson(join(dataDir, 'sales-clients.json'), []);
  const list = Array.isArray(raw) ? raw : raw?.clients || [];
  return list.find((client) => client?.id === id) || null;
}

/** A portal session for the client's contact address: sign up, or sign in when it exists. */
async function portalToken(api, email) {
  const signup = await api.post('/api/client/auth/signup', { email, password: portalSecret });
  if (signup.body?.token) return signup.body.token;
  const login = await api.post('/api/client/auth/login', { email, password: portalSecret });
  return login.body?.token || '';
}

/** Signs one client through its path. Returns { path, status, ok, body }. */
export async function signClient(base, token, spec, client) {
  const admin = hubApi(base, { token });
  const open = hubApi(base);
  const email = String(client?.contactEmail || '').trim();
  let res;
  if (spec.signing === 'progression') {
    res = await admin.patch(`/api/admin/sales/${encodeURIComponent(spec.id)}/progression`, { key: 'contractSigned', value: true });
  } else if (spec.signing === 'got-client') {
    res = await admin.post(`/api/admin/sales/${encodeURIComponent(spec.id)}/got-client`, {});
  } else if (spec.signing === 'preview-accept') {
    res = await open.post(`/api/public/sales-preview/${encodeURIComponent(spec.id)}/contract/accept`, {
      accepted: true, termsAccepted: true, bindingAccepted: true, name: String(client?.contactPerson || 'Kontaktperson'), password: portalSecret,
    });
  } else if (spec.signing === 'portal-accept') {
    const register = await open.post('/api/client-auth/register', { email, password: portalSecret });
    const login = register.body?.token ? register : await open.post('/api/client-auth/login', { email, password: portalSecret });
    res = await hubApi(base, { token: login.body?.token || '' }).post('/api/client/offer/accept', {});
  } else {
    throw new Error(`unknown signing path ${spec.signing}`);
  }
  return { path: spec.signing, status: res.status, ok: res.status >= 200 && res.status < 300, body: res.body };
}

/** The client's Kundedata through the portal: a session, the bank, and the portal link on the card. */
export async function fillKundedata(base, token, spec, client, bank) {
  const open = hubApi(base);
  const session = await portalToken(open, String(client?.contactEmail || '').trim());
  if (!session) return { ok: false, step: 'session' };
  const saved = await hubApi(base, { token: session }).put('/api/client/settings/client-data', { clientDataBank: bank });
  if (saved.status !== 200) return { ok: false, step: 'bank', status: saved.status };
  const linked = await hubApi(base, { token }).post(`/api/admin/sales/${encodeURIComponent(spec.id)}/connect-portal`, {});
  return { ok: linked.status === 200, step: 'connect-portal', status: linked.status };
}

/** One tick of the delivery loop on the given clock (safe mode only). */
export async function tick(base, token, nowMs) {
  const res = await hubApi(base, { token }).post('/api/admin/system/delivery-loop/tick', { now: new Date(nowMs).toISOString() });
  return { at: new Date(nowMs).toISOString(), status: res.status, ran: res.body?.ran === true, mode: res.body?.mode || '', errors: res.body?.errors || res.body?.stepErrors || null };
}

/**
 * A stand-in Maker host for hub-only runs: heartbeats with the preview handler, claims each offered
 * job and completes it with a result like the Maker's (no Maker, no pipeline).
 */
export function createStubWorker({ base, hostToken, runIdFor = (job) => `stub-run-${job.salesClientId}` }) {
  const api = hubApi(base, { headers: { 'x-maker-host-token': hostToken } });
  const done = [];
  return {
    kind: 'stub',
    done,
    async heartbeat(runIds = []) {
      return api.post('/api/maker/hosts/heartbeat', { runIds, capabilities: { handlers: ['preview'] }, version: 'stub-worker' });
    },
    async drain() {
      await this.heartbeat(done.map((row) => row.runId));
      const listed = await api.get('/api/maker/jobs');
      for (const job of Array.isArray(listed.body?.jobs) ? listed.body.jobs : []) {
        const claim = await api.post(`/api/maker/jobs/${encodeURIComponent(job.id)}/claim`, {});
        if (claim.status !== 200) continue;
        const linked = String(claim.body?.client?.makerRun?.runId || '');
        const runId = linked || runIdFor(job);
        await api.post(`/api/maker/jobs/${encodeURIComponent(job.id)}/heartbeat`, { progress: { phase: 'pipeline', message: 'stub', pct: 50 } });
        if (!linked) {
          await this.heartbeat([...done.map((row) => row.runId), runId]);
          await api.post(`/api/maker/clients/${encodeURIComponent(job.salesClientId)}/link-run`, { runId });
        }
        const result = { runId, latestReadyStep: 'maps-embed-sync', createdRun: !linked, continuedFrom: linked ? 'generate-text' : '' };
        const completed = await api.post(`/api/maker/jobs/${encodeURIComponent(job.id)}/complete`, { result, warnings: [] });
        done.push({ jobId: job.id, clientId: job.salesClientId, runId, status: completed.status });
      }
      return done;
    },
  };
}

/** Jobs of one client from the developer route. */
export async function clientJobs(base, token, clientId) {
  const res = await hubApi(base, { token }).get(`/api/admin/delivery/jobs?clientId=${encodeURIComponent(clientId)}`);
  return Array.isArray(res.body?.jobs) ? res.body.jobs : [];
}

const FINISHED = new Set(['done', 'failed', 'cancelled', 'blocked']);

/**
 * The whole scenario. opts: { hub, token, plan, banks: {clientId: bank}, makerRuns: {clientId:
 * {runId, templateSetId}}, jobInputs: {clientId: {templateSetId, language}}, worker (stub worker or
 * { kind: 'external', poke() }), jobTimeoutMs, log }. Returns the timeline the checks read.
 */
export async function runDeliveryScenario({ hub, token, plan, banks = {}, makerRuns = {}, jobInputs = {}, worker = null, jobTimeoutMs = 60 * MINUTE, stopAfter = '', log = () => {} } = {}) {
  const base = hub.base;
  const dataDir = hub.dataDir;
  const admin = hubApi(base, { token });
  const timeline = { startedAt: new Date().toISOString(), clients: {}, ticks: [], jobs: {}, gates: {}, briefs: {}, workshop: {}, switches: plan.switches === 'on' ? 'on' : 'off' };
  const clock = { now: Date.now() };
  const advanceTo = async (ms, label) => {
    clock.now = Math.max(clock.now + MINUTE, ms);
    const row = await tick(base, token, clock.now);
    timeline.ticks.push({ ...row, label });
    log(`[delivery] tick ${label} ${row.at} -> ${row.status}${row.mode ? ` ${row.mode}` : ''}`);
    return row;
  };

  // 1. Kundedata.
  for (const spec of plan.clients) {
    timeline.clients[spec.id] = { signing: spec.signing, tier: spec.tier };
    if (!banks[spec.id]) continue;
    timeline.clients[spec.id].kundedata = await fillKundedata(base, token, spec, salesClient(dataDir, spec.id), banks[spec.id]);
  }
  // 2. Signing.
  const before = readOutbox(dataDir).length;
  for (const spec of plan.clients) {
    const signed = await signClient(base, token, spec, salesClient(dataDir, spec.id));
    timeline.clients[spec.id].sign = { path: signed.path, status: signed.status, ok: signed.ok };
    log(`[delivery] ${spec.id}: signed through ${signed.path} -> ${signed.status}`);
  }
  const afterSigning = await settledOutbox(dataDir);
  timeline.outboxAfterSigning = afterSigning.length - before;

  // 3. Ticks until every brief is built (switched on), then the gate as the developer sees it.
  await advanceTo(Date.now() + MINUTE, 'after-signing');
  if (timeline.switches === 'on') {
    // A brief is built once its inputs held still for the rebuild debounce (10 minutes), at most two
    // starts per tick: step 11 minutes, then once more a minute later, until every brief is there.
    for (let round = 0; round < 8; round += 1) {
      const missing = [];
      for (const spec of plan.clients) {
        const brief = await admin.get(`/api/admin/development/${encodeURIComponent(spec.id)}/brief`);
        timeline.briefs[spec.id] = { status: brief.status, version: Number(brief.body?.version || brief.body?.brief?.version || 0) };
        if (brief.status !== 200 || !timeline.briefs[spec.id].version) missing.push(spec.id);
      }
      if (!missing.length) break;
      await advanceTo(clock.now + 11 * MINUTE, `brief-${round + 1}`);
      await advanceTo(clock.now + MINUTE, `brief-${round + 1}-next`);
    }
    for (const spec of plan.clients) {
      const gate = await admin.get(`/api/admin/delivery/gate/${encodeURIComponent(spec.id)}`);
      const lines = Array.isArray(gate.body?.gate?.lines) ? gate.body.gate.lines.map((line) => ({ id: line.id, gate: line.gate, status: line.status, askable: line.askable === true })) : [];
      timeline.gates[spec.id] = {
        status: gate.status,
        inputHash: gate.body?.gate?.inputHash || '',
        mode: gate.body?.mode || '',
        lines,
        // Lines the client could be asked for: all of them, and those the development gate needs.
        askable: Number(gate.body?.askable?.total) || 0,
        askableDev: lines.filter((line) => line.askable && line.gate === 'dev' && line.status === 'missing').length,
      };
    }
  }

  if (stopAfter === 'brief') {
    timeline.finishedAt = new Date().toISOString();
    return timeline;
  }

  // 4. Workshop held, the post-workshop mail around its due time.
  const endedAt = new Date(Date.now() - 5 * MINUTE).toISOString();
  let latestDue = 0;
  let earliestDue = Infinity;
  for (const spec of plan.clients) {
    const held = await admin.post(`/api/admin/sales/${encodeURIComponent(spec.id)}/workshop/held`, { endedAt, durationMinutes: 60 });
    timeline.workshop[spec.id] = { status: held.status, heldAt: held.body?.heldAt || '', dueAt: held.body?.postWorkshopDueAt || '' };
    const due = Date.parse(held.body?.postWorkshopDueAt || '');
    if (Number.isFinite(due)) {
      latestDue = Math.max(latestDue, due);
      earliestDue = Math.min(earliestDue, due);
    }
  }
  if (latestDue) {
    await advanceTo(earliestDue - MINUTE, 'before-post-workshop');
    timeline.outboxBeforeDue = readOutbox(dataDir).length;
    await advanceTo(latestDue + MINUTE, 'after-post-workshop');
  } else {
    await advanceTo(clock.now + MINUTE, 'workshop');
  }

  // 5. Preview jobs.
  if (timeline.switches === 'on') {
    for (const spec of plan.clients) {
      const run = makerRuns[spec.id];
      if (run?.runId) {
        const linked = await admin.post(`/api/admin/sales/${encodeURIComponent(spec.id)}/set-maker-run`, { makerRun: { runId: run.runId, templateSetId: run.templateSetId || '' } });
        timeline.clients[spec.id].linkedRun = { runId: run.runId, status: linked.status };
      }
      const input = jobInputs[spec.id] || {};
      const queued = await admin.post('/api/admin/delivery/jobs', { salesClientId: spec.id, kind: 'preview', input });
      timeline.jobs[spec.id] = { enqueue: queued.status, jobId: queued.body?.job?.id || '', mode: queued.body?.mode || '' };
      log(`[delivery] ${spec.id}: preview job ${queued.status} ${queued.body?.job?.id || queued.body?.code || ''}`);
    }
    const deadline = Date.now() + jobTimeoutMs;
    for (;;) {
      if (worker?.drain) await worker.drain();
      else if (worker?.poke) await worker.poke();
      const states = {};
      for (const spec of plan.clients) {
        const jobs = (await clientJobs(base, token, spec.id)).filter((job) => job.kind === 'preview');
        states[spec.id] = jobs;
      }
      // A retrying job counts as finished here: its backoff runs for minutes, and the checks report it.
      const pending = plan.clients.filter((spec) => states[spec.id].some((job) => !FINISHED.has(job.status) && job.status !== 'retrying'));
      for (const spec of plan.clients) timeline.jobs[spec.id].jobs = states[spec.id].map((job) => ({ id: job.id, status: job.status, attempts: job.attempts, hostId: job.hostId, result: job.result || null, error: job.error || '', blocking: job.blocking || '' }));
      if (!pending.length) break;
      if (Date.now() > deadline) {
        timeline.jobsTimedOut = pending.map((spec) => spec.id);
        break;
      }
      await sleep(worker?.kind === 'stub' ? 500 : 15_000);
    }
    await advanceTo(Date.now() + MINUTE, 'after-jobs');
  }
  timeline.finishedAt = new Date().toISOString();
  return timeline;
}
