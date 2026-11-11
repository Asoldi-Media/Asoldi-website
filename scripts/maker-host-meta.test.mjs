// Maker host heartbeat fields, hub capabilities and scoped client access with the job queue.
// Temp data dir only; tokens are generated here. Nothing leaves 127.0.0.1.
//
// Run: node --test scripts/maker-host-meta.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-maker-host-meta-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';
process.env.PERSIST_PRODUCTION_ENV = '0';

const hosts = await import('../data/maker-hosts.js');
const meta = await import('../lib/maker-host-meta.js');
const makerAuthLib = await import('../lib/maker-auth.js');
const hostRoutes = await import('../lib/routes/maker-host-routes.js');
const jobRoutes = await import('../lib/routes/delivery-jobs-routes.js');
const jobs = await import('../lib/delivery-jobs.js');
const loopLib = await import('../lib/delivery-loop.js');
const sales = await import('../data/sales.js');
const settingsStore = await import('../data/automation-settings.js');
const { writeReleasesFile } = await import('./fixtures/test-releases.mjs');
const accessLog = await import('../lib/maker-access-log.js');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const signed = { meetingHeld: true, offerSent: true, contractSigned: true };

function setSettings(patch) {
  // Auto needs a recorded release pass (lib/spine-mode.js): start from settings that hold the passes.
  writeReleasesFile(dataDir);
  settingsStore.invalidateAutomationSettingsCache();
  assert.equal(settingsStore.saveAutomationSettings(patch, { by: 'test' }).ok, true);
  settingsStore.invalidateAutomationSettingsCache();
}

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function buildApp() {
  const makerAuth = makerAuthLib.createMakerAuth({ legacyHolder: null, dataDir, env: {} });
  const app = express();
  app.use(express.json());
  const pass = (req, _res, next) => {
    req.developmentUser = { role: 'admin', isAdmin: true, accountKey: 'admin' };
    next();
  };
  const heartbeatStore = meta.createHostHeartbeatStore({ dataDir, flushMs: 0 });
  hostRoutes.registerMakerHostRoutes(app, { adminAuth: pass, makerAuth, getDataDir: () => dataDir, heartbeatStore });
  jobRoutes.register(app, { adminAuth: pass, makerAuth, developmentAuth: pass, sales, hub: null, getDataDir: () => dataDir });
  return app;
}

test('heartbeat: no capabilities and no loop time while the loop is off; jobs only while it runs in auto', async (t) => {
  setSettings({});
  writeFileSync(join(dataDir, 'sales-clients.json'), '[]');
  const app = buildApp();
  const { base, close } = await serve(app);
  t.after(close);
  const { token } = hosts.createMakerHost({ label: 'Heartbeat PC' }, { dataDir });
  const beat = async (body = { runIds: ['run-a-0001'], capabilities: { handlers: ['preview'] }, version: 'maker@test', makerPort: 3000 }) => (
    fetch(`${base}/api/maker/hosts/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-maker-host-token': token }, body: JSON.stringify(body) }).then((res) => res.json())
  );
  const off = await beat();
  assert.deepEqual(off.hubCapabilities, []);
  assert.equal(off.hubLoopLastTickAt, null);
  assert.equal(off.pollAfterMs, 30000);

  setSettings({ delivery: { loop: { enabled: true, mode: 'shadow' } } });
  loopLib.resetDeliveryLoopForTests();
  const loop = loopLib.createDeliveryLoop({ sales, hub: null, log: { warn() {}, error() {} } });
  const tickAt = Date.parse('2026-11-02T09:00:00.000Z');
  await loop.tick({ now: tickAt });
  clearJsonCacheForTests();
  const shadow = await beat();
  assert.deepEqual(shadow.hubCapabilities, [], 'in shadow no client can get a job, so none is offered');
  assert.equal(shadow.hubLoopLastTickAt, new Date(tickAt).toISOString());
  setSettings({ pilotClientIds: ['meta-p1'], delivery: { loop: { enabled: true, mode: 'auto' } } });
  const on = await beat();
  assert.deepEqual(on.hubCapabilities, ['delivery-jobs/1']);
  assert.equal(on.hubLoopLastTickAt, new Date(tickAt).toISOString());
  setSettings({ pilotClientIds: ['meta-p1'], delivery: { loop: { enabled: true, mode: 'auto', paused: { reason: 'check' } } } });
  assert.deepEqual((await beat()).hubCapabilities, [], 'a paused loop offers no jobs');
});

test('an unchanged heartbeat leaves maker-hosts.json untouched', () => {
  const { host } = hosts.createMakerHost({ label: 'Quiet PC' }, { dataDir });
  const body = { runIds: ['run-q-0001'], capabilities: { handlers: ['preview', 'continue'] }, version: 'maker@1', makerPort: 3000 };
  assert.equal(meta.recordHostHeartbeat(host.hostId, body, { dataDir }).changed, true);
  const file = join(dataDir, 'maker-hosts.json');
  const text = readFileSync(file, 'utf8');
  const mtime = statSync(file).mtimeMs;
  assert.equal(meta.recordHostHeartbeat(host.hostId, body, { dataDir }).changed, false);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(statSync(file).mtimeMs, mtime);
});

test('client access through the queue: 403 without a routed job or reported run, logged with ids only', async (t) => {
  accessLog.resetMakerAccessLogMemoForTests();
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([
    { id: 'meta-c1', product: 'asoldi', businessName: 'Eksempel Kafe AS', status: 'active', progression: signed },
    { id: 'meta-c2', product: 'asoldi', businessName: 'Eksempel Verksted AS', status: 'active', progression: signed },
  ]));
  setSettings({ pilotClientIds: ['meta-c1', 'meta-c2'], delivery: { loop: { enabled: true, mode: 'auto' } }, development: { previewJobs: true } });
  const app = buildApp();
  const { base, close } = await serve(app);
  t.after(close);
  const a = hosts.createMakerHost({ label: 'Routed PC' }, { dataDir });
  const b = hosts.createMakerHost({ label: 'Other PC' }, { dataDir });
  meta.recordHostHeartbeat(a.host.hostId, { runIds: ['run-m-0001'], capabilities: { handlers: ['preview'] } }, { dataDir });
  meta.recordHostHeartbeat(b.host.hostId, { runIds: ['run-m-0001'], capabilities: { handlers: ['preview'] } }, { dataDir });
  jobs.enqueueJob({ salesClientId: 'meta-c1', kind: 'preview' }, { hosts: [hosts.getMakerHost(a.host.hostId, { dataDir, fresh: true })], settings: { development: { defaultHostId: a.host.hostId } } });
  const link = (token, clientId) => fetch(`${base}/api/maker/clients/${clientId}/link-run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-maker-host-token': token }, body: JSON.stringify({ runId: 'run-m-0001' }) });
  assert.equal((await link(b.token, 'meta-c1')).status, 403, 'the job is routed to another host');
  assert.equal((await link(a.token, 'meta-c2')).status, 403, 'no job for this client');
  assert.equal((await link(a.token, 'meta-c1')).status, 200);
  const rows = accessLog.readMakerAccessLog({ dataDir }).filter((row) => row.kind === 'link-run');
  assert.deepEqual(rows.map((row) => [row.hostId, row.clientId, row.allowed]).reverse(), [
    [b.host.hostId, 'meta-c1', false],
    [a.host.hostId, 'meta-c2', false],
    [a.host.hostId, 'meta-c1', true],
  ]);
  const logText = JSON.stringify(rows);
  assert.equal(logText.includes('Eksempel'), false, 'no names in the access log');
  // Once the run is linked, the host that reports it keeps access without a job.
  assert.equal(meta.hostMayAccessClient(hosts.getMakerHost(b.host.hostId, { dataDir, fresh: true }), 'meta-c1', { client: sales.getSalesClientById('meta-c1') }), true);
});

test('a stale token polling at 3 failures a minute never blocks a valid host', async (t) => {
  let clock = Date.parse('2026-11-02T09:00:00.000Z');
  const makerAuth = makerAuthLib.createMakerAuth({ legacyHolder: null, dataDir, env: {}, now: () => clock });
  const { token } = hosts.createMakerHost({ label: 'Valid PC' }, { dataDir });
  const stale = `${token.slice(0, -4)}AAAA`;
  for (let minute = 0; minute < 30; minute += 1) {
    for (let i = 0; i < 3; i += 1) {
      clock += 20_000;
      assert.equal(makerAuth.checkMakerRequest({ headers: { 'x-maker-host-token': stale } }, { scope: 'jobs' }).ok, false);
    }
    assert.equal(makerAuth.checkMakerRequest({ headers: { 'x-maker-host-token': token } }, { scope: 'jobs' }).ok, true, `minute ${minute}`);
  }
});
