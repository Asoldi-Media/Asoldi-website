// Delivery job queue: enqueue rules, routing, claim race, leases, backoff, link-run, admin routes.
// Temp data dir only; every host token is generated here. Nothing leaves 127.0.0.1.
//
// Run: node --test scripts/delivery-jobs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-delivery-jobs-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';
process.env.PERSIST_PRODUCTION_ENV = '0';

const jobs = await import('../lib/delivery-jobs.js');
const sales = await import('../data/sales.js');
const settingsStore = await import('../data/automation-settings.js');
const hosts = await import('../data/maker-hosts.js');
const meta = await import('../lib/maker-host-meta.js');
const makerAuthLib = await import('../lib/maker-auth.js');
const hardening = await import('../lib/auth-hardening.js');
const routes = await import('../lib/routes/delivery-jobs-routes.js');
const loopLib = await import('../lib/delivery-loop.js');
const { readDeliveryAudit } = await import('../lib/delivery-audit.js');
const { deriveStage } = await import('../lib/delivery-state.js');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const T0 = Date.parse('2026-11-02T09:00:00.000Z');
const MIN = 60 * 1000;
const signed = { meetingHeld: true, offerSent: true, contractSigned: true };

function seedClients(list) {
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify(list, null, 2));
}

function resetJobs() {
  rmSync(jobs.jobsPath(), { force: true });
  rmSync(join(dataDir, 'snapshots'), { recursive: true, force: true });
  clearJsonCacheForTests();
}

function setSettings(patch) {
  rmSync(join(dataDir, 'automation-settings.json'), { force: true });
  settingsStore.invalidateAutomationSettingsCache();
  const result = settingsStore.saveAutomationSettings(patch, { by: 'test' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  settingsStore.invalidateAutomationSettingsCache();
  return result.settings;
}

const loopOn = (pilots = ['cl-auto'], extra = {}) => setSettings({
  pilotClientIds: pilots,
  delivery: { loop: { enabled: true, mode: 'auto' } },
  development: { previewJobs: true },
  ...extra,
});

function makeHost(label, handlers, { runIds = [], ownerAccountKey } = {}) {
  const { host, token } = hosts.createMakerHost({ label, ownerAccountKey }, { dataDir });
  meta.recordHostHeartbeat(host.hostId, { runIds, capabilities: { handlers } }, { dataDir });
  return { host: hosts.getMakerHost(host.hostId, { dataDir, fresh: true }), token };
}

function baseClients() {
  return [
    { id: 'cl-auto', product: 'asoldi', businessName: 'Bakeri Eksempel AS', status: 'active', progression: signed, developerOwnerId: 'admin' },
    { id: 'cl-shadow', product: 'asoldi', businessName: 'Frisør Eksempel AS', status: 'active', progression: signed },
    { id: 'cl-linked', product: 'asoldi', businessName: 'Rørlegger Eksempel AS', status: 'active', progression: signed, makerRun: { runId: 'run-linked-0001' } },
  ];
}

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function routeApp() {
  const holder = hardening.createHubSecretHolder({ envValue: '', envRule: 'any', lazy: true, dataDir, name: 'maker-callback-token', bytes: 32 });
  const makerAuth = makerAuthLib.createMakerAuth({ legacyHolder: holder, dataDir, env: {} });
  const app = express();
  app.use(express.json());
  const pass = (req, _res, next) => {
    req.developmentUser = { role: 'admin', isAdmin: true, accountKey: 'admin', username: 'admin' };
    next();
  };
  routes.register(app, { adminAuth: pass, makerAuth, developmentAuth: pass, salesOrDevelopmentAuth: pass, sales, hub: null, getDataDir: () => dataDir });
  return app;
}

// ── enqueue rules ────────────────────────────────────────────────────────────

test('enqueueJob: unknown kinds throw, one active job per client and kind', () => {
  resetJobs();
  seedClients(baseClients());
  assert.throws(() => jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'teleport' }, { now: T0 }), /Unknown delivery job kind/);
  const first = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'preview', createdBy: 'test' }, { now: T0 });
  assert.equal(first.ok, true);
  assert.equal(first.status, 201);
  assert.match(first.job.id, /^job_[a-z0-9]+$/);
  const again = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'preview' }, { now: T0 + 1 });
  assert.equal(again.status, 409);
  assert.equal(again.code, 'duplicate');
  assert.equal(again.job.id, first.job.id);
  assert.equal(jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'publish' }, { now: T0 + 2 }).ok, true, 'another kind is fine');
  assert.equal(jobs.listJobs({ clientId: 'cl-auto' }).length, 2);
});

test('requestJob: loop off, kind switch off and shadow clients never queue; auto clients do', () => {
  resetJobs();
  seedClients(baseClients());
  const auto = sales.getSalesClientById('cl-auto');
  const shadow = sales.getSalesClientById('cl-shadow');
  setSettings({});
  assert.deepEqual(
    [jobs.requestJob({ kind: 'preview' }, { client: auto }).status, jobs.requestJob({ kind: 'preview' }, { client: auto }).code],
    [404, 'disabled'],
  );
  setSettings({ pilotClientIds: ['cl-auto'], delivery: { loop: { enabled: true, mode: 'auto' } } });
  const switchOff = jobs.requestJob({ kind: 'preview' }, { client: auto });
  assert.equal(switchOff.code, 'disabled');
  assert.equal(switchOff.switch, 'development.previewJobs');
  loopOn();
  const recorded = jobs.requestJob({ kind: 'preview', createdBy: 'test' }, { client: shadow, sales });
  assert.equal(recorded.status, 202);
  assert.equal(recorded.shadow, true);
  assert.equal(recorded.mode, 'shadow');
  assert.equal(jobs.listJobs({ clientId: 'cl-shadow' }).length, 0, 'a shadow client gets no job');
  assert.ok(readDeliveryAudit().some((row) => row.kind === 'loop-shadow' && row.clientId === 'cl-shadow' && row.jobKind === 'preview'));
  const queued = jobs.requestJob({ kind: 'preview', createdBy: 'test' }, { client: auto, sales });
  assert.equal(queued.status, 201);
  assert.equal(queued.mode, 'auto');
  const mirrored = sales.getSalesClientById('cl-auto').delivery.job;
  assert.equal(mirrored.id, queued.job.id);
  assert.equal(mirrored.status, 'queued');
});

// ── routing and offers ───────────────────────────────────────────────────────

test('routeHost: the run owner, the handoff owner on a tie, the developer, the default host, else any', () => {
  const a = { hostId: 'mh_aaaaaa01', scopes: ['jobs'], runIds: ['run-1'], ownerAccountKey: 'admin', capabilities: { handlers: ['preview'] }, lastSeenAt: '2026-11-01T08:00:00.000Z' };
  const b = { hostId: 'mh_bbbbbb02', scopes: ['jobs'], runIds: ['run-1'], ownerAccountKey: 'developer:u2', capabilities: { handlers: ['preview'] }, lastSeenAt: '2026-11-01T09:00:00.000Z' };
  const c = { hostId: 'mh_cccccc03', scopes: ['jobs'], runIds: [], ownerAccountKey: 'developer:u3', capabilities: { handlers: ['preview'] } };
  const revoked = { ...c, hostId: 'mh_dddddd04', revokedAt: '2026-10-01T00:00:00.000Z', runIds: ['run-2'] };
  const all = [a, b, c, revoked];
  assert.equal(jobs.routeHost({ client: { makerRun: { runId: 'run-1' } }, kind: 'preview' }, { hosts: [a, c] }), a.hostId);
  assert.equal(jobs.routeHost({ client: { makerRun: { runId: 'run-1' }, developerOwnerId: 'admin' }, kind: 'preview' }, { hosts: all }), a.hostId, 'tie: owner');
  assert.equal(jobs.routeHost({ client: { makerRun: { runId: 'run-1' }, developerHandoff: { toOwnerId: 'developer:u2' } }, kind: 'preview' }, { hosts: all }), b.hostId, 'tie: handoff owner');
  assert.equal(jobs.routeHost({ client: { makerRun: { runId: 'run-1' } }, kind: 'preview' }, { hosts: all }), b.hostId, 'tie without owner: newest seen');
  assert.equal(jobs.routeHost({ client: { developerOwnerId: 'developer:u3' }, kind: 'preview' }, { hosts: all }), c.hostId);
  assert.equal(jobs.routeHost({ client: { makerRun: { runId: 'run-2' } }, kind: 'preview' }, { hosts: all }), '', 'revoked hosts are never chosen');
  assert.equal(jobs.routeHost({ client: {}, kind: 'preview' }, { hosts: all, settings: { development: { defaultHostId: c.hostId } } }), c.hostId);
  assert.equal(jobs.routeHost({ client: {}, kind: 'preview' }, { hosts: all, settings: { development: { defaultHostId: 'mh_ffffff00' } } }), '');
});

test('a job is never offered to a host without its handler, and such a claim gets 409', () => {
  resetJobs();
  seedClients(baseClients());
  loopOn();
  const previewHost = makeHost('Preview PC', ['preview']);
  const continueHost = makeHost('Continue PC', ['continue']);
  const { job } = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'preview' }, { now: T0 });
  assert.deepEqual(jobs.listOfferable(continueHost.host, { now: T0 }).map((row) => row.id), []);
  assert.deepEqual(jobs.listOfferable(previewHost.host, { now: T0 }).map((row) => row.id), [job.id]);
  assert.equal(jobs.claimJob(job.id, continueHost.host, { now: T0 }).status, 409);
  assert.equal(jobs.claimJob(job.id, previewHost.host, { now: T0 }).status, 200);
  assert.deepEqual(jobs.listOfferable(previewHost.host, { now: T0 }), [], 'a claimed job is no longer offered');
});

// ── claim race over HTTP ─────────────────────────────────────────────────────

test('100 concurrent claims of one job: exactly one 200 and 99 409', async (t) => {
  resetJobs();
  seedClients(baseClients());
  loopOn();
  const app = routeApp();
  const { base, close } = await serve(app);
  t.after(close);
  const worker = makeHost('Race PC', ['preview']);
  const { job } = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'preview' }, {});
  const headers = { 'content-type': 'application/json', 'x-maker-host-token': worker.token };
  const offered = await (await fetch(`${base}/api/maker/jobs`, { headers })).json();
  assert.deepEqual(offered.jobs.map((row) => row.id), [job.id]);
  const responses = await Promise.all(Array.from({ length: 100 }, () => fetch(`${base}/api/maker/jobs/${job.id}/claim`, { method: 'POST', headers, body: '{}' })));
  const statuses = responses.map((res) => res.status);
  assert.equal(statuses.filter((status) => status === 200).length, 1);
  assert.equal(statuses.filter((status) => status === 409).length, 99);
  const winner = await responses[statuses.indexOf(200)].json();
  assert.equal(winner.job.status, 'claimed');
  assert.equal(winner.client.id, 'cl-auto');
  assert.equal(winner.client.makerRun.runId, '');
  const stored = jobs.getJob(job.id);
  assert.equal(stored.attempts, 1, 'only the winning claim counted an attempt');
  assert.equal(Date.parse(stored.leaseUntil) - Date.parse(stored.claimedAt), 10 * MIN);
});

// ── leases, heartbeats, backoff ──────────────────────────────────────────────

test('heartbeats extend the lease and keep 50 log lines, without backup files', () => {
  resetJobs();
  seedClients(baseClients());
  loopOn();
  const worker = makeHost('Beat PC', ['preview']);
  const { job } = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'preview' }, { now: T0 });
  jobs.claimJob(job.id, worker.host, { now: T0 });
  const backupsBefore = existsSync(join(dataDir, 'backups')) ? readdirSync(join(dataDir, 'backups')).length : 0;
  for (let i = 0; i < 60; i += 1) {
    const beat = jobs.heartbeatJob(job.id, worker.host, { now: T0 + (i + 1) * 1000, progress: { phase: 'pipeline', message: `step ${i}`, pct: i }, log: `line ${i}` });
    assert.equal(beat.status, 200);
  }
  const stored = jobs.getJob(job.id);
  assert.equal(stored.status, 'running');
  assert.equal(stored.log.length, 50);
  assert.equal(stored.log.at(-1), 'line 59');
  assert.equal(Date.parse(stored.leaseUntil), T0 + 60 * 1000 + 10 * MIN);
  const backupsAfter = existsSync(join(dataDir, 'backups')) ? readdirSync(join(dataDir, 'backups')).length : 0;
  assert.equal(backupsAfter, backupsBefore, 'a heartbeat writes no backup files');
  const other = makeHost('Other PC', ['preview']);
  assert.equal(jobs.heartbeatJob(job.id, other.host, { now: T0 + 70 * 1000 }).status, 409, 'only the claiming host may report');
  assert.equal(jobs.heartbeatJob(job.id, worker.host, { now: T0 + 60 * MIN }).code, 'lease-lost');
});

test('failures back off 5, 15, then 45 minutes and fail after maxAttempts; a blocking code blocks', () => {
  resetJobs();
  seedClients(baseClients());
  loopOn();
  const worker = makeHost('Retry PC', ['preview', 'publish']);
  const { job } = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'preview' }, { now: T0 });
  let now = T0;
  const waits = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal(jobs.claimJob(job.id, worker.host, { now }).status, 200, `claim ${attempt}`);
    const failed = jobs.failJob(job.id, worker.host, { now, error: 'step crashed' });
    if (attempt < 4) {
      assert.equal(failed.job.status, 'retrying');
      const wait = Date.parse(failed.job.notBefore) - now;
      waits.push(wait / MIN);
      assert.equal(jobs.claimJob(job.id, worker.host, { now: now + wait - 1 }).status, 409, 'not before the backoff');
      now += wait;
    } else {
      assert.equal(failed.job.status, 'failed');
    }
  }
  assert.deepEqual(waits, [5, 15, 45]);
  const publish = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'publish' }, { now }).job;
  jobs.claimJob(publish.id, worker.host, { now });
  const blocked = jobs.failJob(publish.id, worker.host, { now, error: 'confirm first', blocking: 'needs-confirm' });
  assert.equal(blocked.job.status, 'blocked');
  assert.equal(blocked.job.blocking, 'needs-confirm');
  assert.equal(jobs.failJob(publish.id, worker.host, { now }).status, 409);
  const retried = jobs.retryJob(publish.id, { by: 'admin', now });
  assert.equal(retried.job.status, 'queued');
  assert.equal(retried.job.attempts, 0);
});

test('a stale lease is requeued by one loop tick', async () => {
  resetJobs();
  seedClients(baseClients());
  loopOn();
  const worker = makeHost('Stale PC', ['preview']);
  const { job } = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'preview' }, { now: T0 });
  jobs.claimJob(job.id, worker.host, { now: T0 });
  loopLib.resetDeliveryLoopForTests();
  const loop = loopLib.createDeliveryLoop({ sales, hub: null, log: { warn() {}, error() {} } });
  const early = await loop.tick({ now: T0 + 9 * MIN });
  assert.equal(early.ran, true);
  assert.equal(jobs.getJob(job.id).status, 'claimed', 'a live lease stays');
  const late = await loop.tick({ now: T0 + 11 * MIN });
  assert.equal(late.steps['jobs-requeue-stale'].wrote, true);
  const requeued = jobs.getJob(job.id);
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.leaseUntil, '');
  assert.ok(requeued.log.some((line) => line.includes('lease expired')));
  assert.equal(sales.getSalesClientById('cl-auto').delivery.job.status, 'queued', 'the mirror follows the status change');
});

// ── paused, shadow and pilot removed: queued work stays put ─────────────────

test('paused, shadow or no longer a pilot: no job is offered, a claim gets 409 and the client is not written', async (t) => {
  resetJobs();
  seedClients(baseClients());
  loopOn();
  const app = routeApp();
  const { base, close } = await serve(app);
  t.after(close);
  const worker = makeHost('Hold PC', ['preview']);
  const queued = jobs.requestJob({ kind: 'preview', createdBy: 'test' }, { client: sales.getSalesClientById('cl-auto'), sales });
  assert.equal(queued.status, 201);
  const headers = { 'content-type': 'application/json', 'x-maker-host-token': worker.token };
  const clientBefore = JSON.stringify(sales.getSalesClientById('cl-auto'));
  // [label, settings, claim code, capabilities]: another pilot in auto still asks Makers to poll.
  const cases = [
    ['paused', { pilotClientIds: ['cl-auto'], delivery: { loop: { enabled: true, mode: 'auto', paused: { reason: 'check' } } }, development: { previewJobs: true } }, 'paused', []],
    ['shadow', { pilotClientIds: ['cl-auto'], delivery: { loop: { enabled: true, mode: 'shadow' } }, development: { previewJobs: true } }, 'not-auto', []],
    ['pilot removed', { pilotClientIds: ['cl-linked'], delivery: { loop: { enabled: true, mode: 'auto' } }, development: { previewJobs: true } }, 'not-auto', ['delivery-jobs/1']],
  ];
  for (const [label, patch, code, capabilities] of cases) {
    setSettings(patch);
    const listed = await (await fetch(`${base}/api/maker/jobs`, { headers })).json();
    assert.deepEqual(listed.jobs, [], `${label}: nothing is offered`);
    assert.deepEqual(jobs.listOfferable(worker.host, {}), [], `${label}: listOfferable agrees`);
    const claim = await fetch(`${base}/api/maker/jobs/${queued.job.id}/claim`, { method: 'POST', headers, body: '{}' });
    assert.equal(claim.status, 409, label);
    assert.equal((await claim.json()).code, code, label);
    assert.equal(jobs.getJob(queued.job.id).status, 'queued', `${label}: the job stays queued`);
    assert.equal(jobs.getJob(queued.job.id).attempts, 0, `${label}: no attempt is used`);
    assert.equal(JSON.stringify(sales.getSalesClientById('cl-auto')), clientBefore, `${label}: the client record is not written`);
    assert.deepEqual(meta.hubCapabilities({ dataDir }), capabilities, `${label}: capabilities`);
  }
  loopOn();
  assert.deepEqual((await (await fetch(`${base}/api/maker/jobs`, { headers })).json()).jobs.map((row) => row.id), [queued.job.id], 'back in auto: offered again');
  assert.deepEqual(meta.hubCapabilities({ dataDir }), ['delivery-jobs/1']);
});

test('a claimed job is told to stop while the loop is paused; heartbeat, complete and fail keep working', async (t) => {
  resetJobs();
  seedClients(baseClients());
  loopOn();
  const app = routeApp();
  const { base, close } = await serve(app);
  t.after(close);
  const worker = makeHost('Stop PC', ['preview', 'continue']);
  const headers = { 'content-type': 'application/json', 'x-maker-host-token': worker.token };
  const post = (path, body = {}) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const first = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'preview' }, {}).job;
  const second = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'continue' }, {}).job;
  assert.equal((await post(`/api/maker/jobs/${first.id}/claim`)).status, 200);
  assert.equal((await post(`/api/maker/jobs/${second.id}/claim`)).status, 200);
  const running = await (await post(`/api/maker/jobs/${first.id}/heartbeat`, { progress: { phase: 'pipeline', pct: 10 } })).json();
  assert.equal(running.stop, undefined, 'no stop while the client is in auto');
  setSettings({ pilotClientIds: ['cl-auto'], delivery: { loop: { enabled: true, mode: 'auto', paused: { reason: 'check' } } }, development: { previewJobs: true } });
  const beat = await post(`/api/maker/jobs/${first.id}/heartbeat`, { progress: { phase: 'pipeline', pct: 20 } });
  assert.equal(beat.status, 200);
  assert.equal((await beat.json()).stop, 'paused');
  const failed = await post(`/api/maker/jobs/${first.id}/fail`, { error: 'Stopped: the hub holds this job (paused).', retryable: true });
  assert.equal(failed.status, 200);
  assert.equal(jobs.getJob(first.id).status, 'retrying', 'it waits in the queue');
  const done = await post(`/api/maker/jobs/${second.id}/complete`, { result: { runId: 'run-done-0001' } });
  assert.equal(done.status, 200, 'a job that finished anyway is recorded');
  assert.equal(jobs.getJob(second.id).status, 'done');
});

test('a stale lease of a client that left auto is requeued without writing the client', async () => {
  resetJobs();
  seedClients(baseClients());
  loopOn();
  const worker = makeHost('Left PC', ['preview']);
  const { job } = jobs.requestJob({ kind: 'preview', createdBy: 'test' }, { client: sales.getSalesClientById('cl-auto'), sales, now: T0 });
  jobs.claimJob(job.id, worker.host, { now: T0, sales });
  assert.equal(sales.getSalesClientById('cl-auto').delivery.job.status, 'claimed');
  setSettings({ pilotClientIds: ['cl-linked'], delivery: { loop: { enabled: true, mode: 'auto' } }, development: { previewJobs: true } });
  const before = JSON.stringify(sales.getSalesClientById('cl-auto'));
  const touched = jobs.requeueStale({ now: T0 + 11 * MIN, sales });
  assert.equal(touched.length, 1);
  assert.equal(jobs.getJob(job.id).status, 'queued');
  assert.equal(JSON.stringify(sales.getSalesClientById('cl-auto')), before, 'the loop does not write a client outside auto');
});

// ── results and stages ───────────────────────────────────────────────────────

test('completed results lose local and private-network URLs; a done continue job derives dev_review', () => {
  resetJobs();
  seedClients(baseClients());
  loopOn();
  const worker = makeHost('Done PC', ['continue']);
  const { job } = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'continue' }, { now: T0 });
  jobs.claimJob(job.id, worker.host, { now: T0 });
  const done = jobs.completeJob(job.id, worker.host, {
    now: T0 + MIN,
    warnings: ['cms-review-pending', 'made-up-code'],
    result: {
      runId: 'run-abc-123',
      latestReadyStep: 'maps-embed-sync',
      previewUrl: 'http://127.0.0.1:3000/preview/run-abc-123/step/2',
      lan: 'see http://192.168.1.20:3000/x and https://example.com/ok',
      docker: 'http://host.docker.internal:3101/api',
      nested: { url: 'http://localhost:3000/a' },
    },
  });
  assert.equal(done.status, 200);
  const text = JSON.stringify(done.job.result);
  for (const local of ['127.0.0.1', '192.168.', 'host.docker.internal', 'localhost']) assert.equal(text.includes(local), false, local);
  assert.ok(text.includes('https://example.com/ok'));
  assert.equal(done.job.result.latestReadyStep, 'maps-embed-sync');
  assert.deepEqual(done.job.warnings, ['cms-review-pending']);
  const client = sales.getSalesClientById('cl-auto');
  assert.equal(deriveStage(client, { jobs: jobs.listJobs({ clientId: 'cl-auto' }) }).stage, 'dev_review');
});

// ── link-run ─────────────────────────────────────────────────────────────────

test('link-run: only a run the host reports, only for a client without a run, never a re-link', async (t) => {
  resetJobs();
  seedClients(baseClients());
  loopOn(['cl-auto', 'cl-linked']);
  const app = routeApp();
  const { base, close } = await serve(app);
  t.after(close);
  const worker = makeHost('Link PC', ['preview'], { runIds: ['run-new-0001'] });
  const stranger = makeHost('Stranger PC', ['preview'], { runIds: ['run-new-0001'] });
  const link = (token, clientId, runId) => fetch(`${base}/api/maker/clients/${clientId}/link-run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-maker-host-token': token },
    body: JSON.stringify({ runId }),
  });
  const { job } = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'preview' }, { hosts: [worker.host], settings: { development: { defaultHostId: worker.host.hostId } } });
  assert.equal(job.hostId, worker.host.hostId);
  assert.equal((await link(stranger.token, 'cl-auto', 'run-new-0001')).status, 403, 'no job routed to this host');
  assert.equal((await link(worker.token, 'cl-auto', 'run-not-reported')).status, 403, 'a run the host does not report');
  const ok = await link(worker.token, 'cl-auto', 'run-new-0001');
  assert.equal(ok.status, 200);
  assert.equal(sales.getSalesClientById('cl-auto').makerRun.runId, 'run-new-0001');
  assert.equal(jobs.getJob(job.id).runId, 'run-new-0001', 'the active job gets the run');
  const same = await (await link(worker.token, 'cl-auto', 'run-new-0001')).json();
  assert.equal(same.unchanged, true);
  meta.recordHostHeartbeat(worker.host.hostId, { runIds: ['run-new-0001', 'run-new-0002'] }, { dataDir });
  const relink = await link(worker.token, 'cl-auto', 'run-new-0002');
  assert.equal(relink.status, 409);
  assert.equal((await relink.json()).code, 'already-linked');
  assert.equal(sales.getSalesClientById('cl-auto').makerRun.runId, 'run-new-0001', 'the linked run stays');
  const linkedClient = makeHost('Owner PC', ['preview'], { runIds: ['run-linked-0001', 'run-new-0003'] });
  const overLinked = await link(linkedClient.token, 'cl-linked', 'run-new-0003');
  assert.equal(overLinked.status, 409, 'a client with a linked run is never re-linked');
  assert.equal(sales.getSalesClientById('cl-linked').makerRun.runId, 'run-linked-0001');
});

// ── switch off and admin routes ──────────────────────────────────────────────

test('switch off: every Maker job route answers 404 {code:disabled} before any auth', async (t) => {
  resetJobs();
  seedClients(baseClients());
  setSettings({});
  const app = routeApp();
  const { base, close } = await serve(app);
  t.after(close);
  const calls = [
    ['GET', '/api/maker/jobs'],
    ['POST', '/api/maker/jobs/job_abcdefgh12/claim'],
    ['POST', '/api/maker/jobs/job_abcdefgh12/heartbeat'],
    ['POST', '/api/maker/jobs/job_abcdefgh12/complete'],
    ['POST', '/api/maker/jobs/job_abcdefgh12/fail'],
    ['POST', '/api/maker/clients/cl-auto/link-run'],
  ];
  for (const [method, path] of calls) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { code: 'disabled', message: 'Not available.' });
  }
  const view = await (await fetch(`${base}/api/admin/delivery/jobs?clientId=cl-auto`)).json();
  assert.equal(view.enabled, false);
  assert.equal(view.canEnqueuePreview, false);
  const post = await fetch(`${base}/api/admin/delivery/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ salesClientId: 'cl-auto', kind: 'preview' }) });
  assert.equal(post.status, 404);
  assert.equal(existsSync(jobs.jobsPath()), false, 'nothing was written');
  assert.deepEqual(meta.hubCapabilities({ dataDir }), [], 'no capability is offered while off');
});

test('admin routes: the preview button state, enqueue, duplicate, cancel and retry', async (t) => {
  resetJobs();
  seedClients(baseClients());
  loopOn();
  const app = routeApp();
  const { base, close } = await serve(app);
  t.after(close);
  const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const autoView = await (await call('GET', '/api/admin/delivery/jobs?clientId=cl-auto')).json();
  assert.equal(autoView.canEnqueuePreview, true);
  assert.equal(autoView.mode, 'auto');
  const shadowView = await (await call('GET', '/api/admin/delivery/jobs?clientId=cl-shadow')).json();
  assert.equal(shadowView.canEnqueuePreview, false, 'only auto clients get the button');
  assert.equal((await call('POST', '/api/admin/delivery/jobs', { salesClientId: 'cl-auto', kind: 'publish' })).status, 400);
  const created = await call('POST', '/api/admin/delivery/jobs', { salesClientId: 'cl-auto', kind: 'preview', input: { language: 'NB', pages: ['/', '/om-oss'] } });
  assert.equal(created.status, 201);
  const job = (await created.json()).job;
  assert.deepEqual(job.input, { templateSetId: '', language: 'nb', pages: ['/', '/om-oss'] });
  assert.equal((await call('POST', '/api/admin/delivery/jobs', { salesClientId: 'cl-auto', kind: 'preview' })).status, 409);
  const shadow = await call('POST', '/api/admin/delivery/jobs', { salesClientId: 'cl-shadow', kind: 'preview' });
  assert.equal(shadow.status, 202);
  assert.equal((await shadow.json()).shadow, true);
  assert.equal((await call('POST', `/api/admin/delivery/jobs/${job.id}/cancel`)).status, 200);
  assert.equal(jobs.getJob(job.id).status, 'cancelled');
  assert.equal((await call('POST', `/api/admin/delivery/jobs/${job.id}/retry`)).status, 409, 'only failed or blocked jobs retry');
  assert.equal((await call('POST', '/api/admin/delivery/jobs/job_unknown0000/cancel')).status, 404);
  assert.deepEqual(meta.hubCapabilities({ dataDir }), ['delivery-jobs/1']);
});

test('admin enqueue: a preview job takes the client language when the request names none', async (t) => {
  resetJobs();
  seedClients([
    { ...baseClients()[0], language: 'en' },
    { id: 'cl-plan', product: 'asoldi', businessName: 'Maler Eksempel AS', status: 'active', progression: signed, sitePlan: { status: 'active', tierId: 'tier-1', languages: ['nb'] } },
  ]);
  loopOn(['cl-auto', 'cl-plan']);
  const app = routeApp();
  const { base, close } = await serve(app);
  t.after(close);
  const call = (body) => fetch(`${base}/api/admin/delivery/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const own = await (await call({ salesClientId: 'cl-auto', kind: 'preview' })).json();
  assert.equal(own.job.input.language, 'en');
  const fromPlan = await (await call({ salesClientId: 'cl-plan', kind: 'preview' })).json();
  assert.equal(fromPlan.job.input.language, sales.getSalesClientById('cl-plan').sitePlan?.languages?.[0] || '', 'the site plan language when the client has no own one');
  const routesLib = await import('../lib/routes/delivery-jobs-routes.js');
  assert.equal(routesLib.clientLanguage({ language: { code: 'SV' } }), 'sv');
  assert.equal(routesLib.clientLanguage({ makerRun: { language: { code: 'da' } } }), 'da');
  assert.equal(routesLib.clientLanguage({ language: 'not a language' }), '');
  assert.equal(routesLib.clientLanguage({}), '');
});

test('handoff accepted: queued jobs move to the new developer host', () => {
  resetJobs();
  seedClients(baseClients());
  loopOn();
  const oldHost = makeHost('Old PC', ['preview'], { ownerAccountKey: 'admin' });
  const newHost = makeHost('New PC', ['preview'], { ownerAccountKey: 'developer:u9' });
  const client = { ...sales.getSalesClientById('cl-auto'), developerOwnerId: 'admin' };
  const { job } = jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'preview' }, { client, hosts: [oldHost.host, newHost.host] });
  assert.equal(job.hostId, oldHost.host.hostId);
  const moved = jobs.noteDeveloperHandoffAccepted({ ...client, developerHandoff: { status: 'ready', toOwnerId: 'developer:u9' } });
  assert.equal(moved, 1);
  assert.equal(jobs.getJob(job.id).hostId, newHost.host.hostId);
  setSettings({});
  assert.equal(jobs.noteDeveloperHandoffAccepted({ ...client, developerHandoff: { toOwnerId: 'admin' } }), 0, 'nothing moves while the loop is off');
});

test('daily snapshot: one dated copy per day, the newest 7 kept', () => {
  resetJobs();
  seedClients(baseClients());
  jobs.enqueueJob({ salesClientId: 'cl-auto', kind: 'preview' }, { now: T0 });
  const DAY = 24 * 60 * MIN;
  for (let day = 0; day < 9; day += 1) {
    assert.ok(jobs.snapshotJobsDaily({ now: T0 + day * DAY }), `day ${day}`);
    assert.equal(jobs.snapshotJobsDaily({ now: T0 + day * DAY + MIN }), null, 'once a day');
  }
  const dir = join(dataDir, 'snapshots', 'delivery-jobs');
  const files = readdirSync(dir).sort();
  assert.equal(files.length, 7);
  assert.equal(files.at(-1), '2026-11-10.json');
  assert.equal(JSON.parse(readFileSync(join(dir, files.at(-1)), 'utf8')).jobs.length, 1);
});
