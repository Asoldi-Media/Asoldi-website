// Developer report routes (lib/routes/dev-report-routes.js) on a local express app with the real Maker
// host auth, plus one boot of the real hub for the legacy callback event. Cases come from
// scripts/fixtures/contracts/dev-report-1.json.
//
// Every refused request writes and enqueues nothing: the stored reports, thumbnails, briefs, purge
// reports and the sales writes are compared before and after (requests made > 0 per case).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const baseDir = mkdtempSync(join(tmpdir(), 'asoldi-dev-report-'));
process.env.APP_DATA_DIR = baseDir;
process.env.HUB_SAFE_MODE = '1';
delete process.env.DATA_DIR;

const hosts = await import('../data/maker-hosts.js');
const hardening = await import('../lib/auth-hardening.js');
const makerAuthLib = await import('../lib/maker-auth.js');
const meta = await import('../lib/maker-host-meta.js');
const accessLog = await import('../lib/maker-access-log.js');
const routes = await import('../lib/routes/dev-report-routes.js');
const reports = await import('../lib/dev-reports.js');
const { defaultAutomationSettings } = await import('../data/automation-settings.js');
const { bootHub } = await import('./safe-mode/hub-boot.mjs');

const fixture = JSON.parse(readFileSync(new URL('./fixtures/contracts/dev-report-1.json', import.meta.url), 'utf8'));
const CLIENT_ID = 'syn-salon-client';
const OTHER_CLIENT = 'syn-other-client';
const RUN = 'syn-salon-run-0001';
const OTHER_RUN = 'syn-salon-run-0002';
const SESSION = 'ds_20261201_0900_a1';

const temps = [baseDir];
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function developmentAuth(req, res, next) {
  const who = String(req.headers['x-test-user'] || '');
  if (!who) return res.status(401).json({ message: 'Unauthorized' });
  req.developmentUser = who === 'admin'
    ? { role: 'admin', isAdmin: true, userId: '', username: 'admin', accountKey: 'admin' }
    : { role: 'developer', isAdmin: false, userId: who, username: who, accountKey: `developer:${who}` };
  return next();
}

function snapshot(dir) {
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(`${full.slice(dir.length)}|${statSync(full).size}|${statSync(full).mtimeMs}`);
    }
  };
  for (const sub of ['dev-reports', 'delivery-briefs', 'purge-reports', 'delivery-jobs.json']) {
    const path = join(dir, sub);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) walk(path);
    else out.push(`${sub}|${statSync(path).size}|${statSync(path).mtimeMs}`);
  }
  return out.sort();
}

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function setup(t, { enabled = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-dev-report-case-'));
  temps.push(dir);
  accessLog.resetMakerAccessLogMemoForTests();
  meta.resetHubCapabilitiesForTests();
  const { host, token } = hosts.createMakerHost({ label: 'Test host' }, { dataDir: dir });
  const { token: otherToken } = hosts.createMakerHost({ label: 'Other host' }, { dataDir: dir });
  meta.recordHostHeartbeat(host.hostId, { runIds: [RUN, OTHER_RUN] }, { dataDir: dir });
  const clients = {
    [CLIENT_ID]: { id: CLIENT_ID, businessName: 'Syn Salon AS', developerOwnerId: 'developer:dev-1', makerRun: { runId: RUN } },
    [OTHER_CLIENT]: { id: OTHER_CLIENT, businessName: 'Syn Other AS', developerOwnerId: 'developer:dev-1', makerRun: { runId: OTHER_RUN } },
  };
  const writes = [];
  const sales = {
    getSalesClientById: (id) => clients[id] || null,
    getSalesClients: () => Object.values(clients),
    setSalesMakerRunDev: (id, dev) => {
      writes.push({ id, dev });
      clients[id] = { ...clients[id], makerRun: { ...clients[id].makerRun, dev } };
    },
  };
  const current = { settings: defaultAutomationSettings() };
  if (enabled) current.settings = { ...current.settings, devReport: { enabled: true, mode: 'shadow', paused: null } };
  const makerAuth = makerAuthLib.createMakerAuth({
    legacyHolder: hardening.createHubSecretHolder({ envValue: '', envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 }),
    dataDir: dir,
    env: {},
  });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  routes.register(app, {
    developmentAuth,
    makerAuth,
    sales,
    hub: { getAllSites: () => [] },
    getDataDir: () => dir,
    settings: () => current.settings,
    routedJobs: () => [],
    boardItems: () => [],
    log: { warn() {}, error() {}, log() {} },
  });
  const server = await serve(app);
  t.after(server.close);
  const call = (method, path, { headers = {}, body, raw } = {}) => fetch(`${server.base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { dir, current, writes, clients, call, token, otherToken, host, maker: { 'x-maker-host-token': token }, admin: { 'x-test-user': 'admin' } };
}

const reportCase = (id) => fixture.reports.find((row) => row.id === id);
const post = (hub, row, headers) => hub.call('POST', `/api/maker/runs/${row.route.runId}/dev-report`, { headers: headers || hub.maker, body: row.body });

function jpeg(bytes) {
  const buffer = Buffer.alloc(bytes, 0x61);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  return buffer;
}

function bodyOfSize(row, total) {
  const body = structuredClone(row.body);
  body.dev.qaProposal.evidence = '';
  const base = Buffer.byteLength(JSON.stringify(body));
  body.dev.qaProposal.evidence = 'x'.repeat(total - base);
  assert.equal(Buffer.byteLength(JSON.stringify(body)), total);
  return body;
}

test('fixture reports: valid ones are stored with their summary, invalid ones answer the listed status, code and field', async (t) => {
  const hub = await setup(t);
  let compared = 0;
  for (const row of fixture.reports) {
    const before = snapshot(hub.dir);
    const writesBefore = hub.writes.length;
    const res = await post(hub, row);
    const body = await res.json();
    assert.equal(res.status, row.expect.status, `${row.id}: ${JSON.stringify(body)}`);
    compared += 1;
    if (row.valid) {
      assert.equal(body.ok, true, row.id);
      assert.equal(body.stored, row.expect.stored, row.id);
      if (row.expect.duplicate) assert.equal(body.duplicate, true);
      if (row.expect.stored) assert.equal(hub.writes.length, writesBefore + 1, `${row.id}: the summary is kept on the client`);
      else {
        assert.deepEqual(snapshot(hub.dir), before, `${row.id}: a duplicate writes nothing`);
        assert.equal(hub.writes.length, writesBefore);
      }
    } else {
      assert.equal(body.code, row.expect.code, row.id);
      if (row.expect.field) assert.equal(body.field, row.expect.field, row.id);
      assert.deepEqual(snapshot(hub.dir), before, `${row.id}: a refused report writes nothing`);
      assert.equal(hub.writes.length, writesBefore, `${row.id}: no client write`);
    }
  }
  assert.ok(compared >= 10);
  // The stored report round-trips and the summary on the client stays small and empty of arrays.
  const stored = reports.listReports(CLIENT_ID, { dataDir: hub.dir });
  assert.ok(stored.length >= 3);
  const latest = hub.clients[CLIENT_ID].makerRun.dev;
  assert.ok(Buffer.byteLength(JSON.stringify(latest)) <= 2048);
  assert.equal(latest.render.routes, 0, 'a count, not the route list');
  assert.equal(JSON.stringify(latest).includes('directives'), false);
});

test('size: one byte over 64 KB is refused before the field checks; exactly 64 KB reaches them', async (t) => {
  const hub = await setup(t);
  const base = reportCase('review-initial');
  for (const recipe of fixture.recipes) {
    const before = snapshot(hub.dir);
    const res = await hub.call('POST', `/api/maker/runs/${RUN}/dev-report`, { headers: hub.maker, body: bodyOfSize(base, recipe.toTotalBytes) });
    const body = await res.json();
    assert.equal(res.status, recipe.expect.status, recipe.id);
    assert.equal(body.code, recipe.expect.code, recipe.id);
    if (recipe.expect.field) assert.equal(body.field, recipe.expect.field);
    assert.deepEqual(snapshot(hub.dir), before, `${recipe.id}: nothing written`);
  }
});

test('auth, switch and scope: nothing is stored or written for a refused report', async (t) => {
  const hub = await setup(t);
  const row = reportCase('review-initial');
  const cases = [
    ['no token', {}, 401],
    ['wrong token', { 'x-maker-host-token': 'mkh_wrong.wrong' }, 401],
    ['host without the run', { 'x-maker-host-token': hub.otherToken }, 403],
  ];
  let requests = 0;
  for (const [name, headers, status] of cases) {
    const before = snapshot(hub.dir);
    const res = await post(hub, row, headers);
    requests += 1;
    assert.equal(res.status, status, name);
    if (status === 403) assert.equal((await res.json()).code, 'run-not-on-host');
    assert.deepEqual(snapshot(hub.dir), before, name);
  }
  assert.equal(hub.writes.length, 0);
  assert.ok(requests > 0);
  // Not JSON: 415 before any body check.
  const wrongType = await hub.call('POST', `/api/maker/runs/${RUN}/dev-report`, { headers: { ...hub.maker, 'content-type': 'text/plain' }, raw: 'x' });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).code, 'unsupported-media-type');
  // A salesClientId that is not the run's client.
  const claimed = structuredClone(row.body);
  claimed.salesClientId = OTHER_CLIENT;
  const mismatch = await hub.call('POST', `/api/maker/runs/${RUN}/dev-report`, { headers: hub.maker, body: claimed });
  assert.equal(mismatch.status, 400);
  assert.deepEqual(snapshot(hub.dir).filter((line) => line.includes('dev-reports')), []);
});

test('switch off: every Maker route answers 404 disabled first, nothing is written and the capability is not listed', async (t) => {
  const hub = await setup(t, { enabled: false });
  const before = snapshot(hub.dir);
  const row = reportCase('review-initial');
  const attempts = [
    hub.call('POST', `/api/maker/runs/${RUN}/dev-report`, { headers: hub.maker, body: row.body }),
    hub.call('POST', `/api/maker/runs/${RUN}/dev-report`, { headers: {}, body: row.body }),
    hub.call('POST', `/api/maker/runs/${RUN}/dev-report/shots?sessionId=${SESSION}&shot=thumb_01`, { headers: { ...hub.maker, 'content-type': 'image/jpeg' }, raw: jpeg(100) }),
  ];
  for (const res of await Promise.all(attempts)) {
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'disabled');
  }
  const directive = await hub.call('PATCH', `/api/maker/clients/${CLIENT_ID}/brief/directives/dir-synsal001/status`, { headers: hub.maker, body: { status: 'done' } });
  assert.equal(directive.status, 404);
  assert.equal((await directive.json()).code, 'disabled');
  assert.deepEqual(snapshot(hub.dir), before);
  assert.equal(hub.writes.length, 0);
  assert.deepEqual(meta.hubCapabilities({ dataDir: hub.dir }), [], 'the heartbeat lists no capability while off');
  hub.current.settings = { ...hub.current.settings, devReport: { enabled: true, mode: 'shadow', paused: null } };
  assert.deepEqual(meta.hubCapabilities({ dataDir: hub.dir }), ['dev-report/1'], 'on: listed');
  hub.current.settings = { ...hub.current.settings, devReport: { enabled: true, mode: 'shadow', paused: { reason: 'test' } } };
  assert.deepEqual(meta.hubCapabilities({ dataDir: hub.dir }), [], 'paused counts as off');
});

test('thumbnails: contract cases, the 12-per-session cap, and staff-only reads', async (t) => {
  const hub = await setup(t);
  const review = reportCase('review-initial');
  assert.equal((await post(hub, review)).status, 200);
  const shotUrl = (query) => `/api/maker/runs/${RUN}/dev-report/shots?sessionId=${query.sessionId}&shot=${query.shot}`;
  const send = (c, headers = hub.maker) => hub.call('POST', shotUrl(c.query), {
    headers: { ...headers, 'content-type': c.contentType },
    raw: c.magicHex === 'ffd8ff' ? jpeg(c.bytes) : Buffer.concat([Buffer.from(c.magicHex, 'hex'), Buffer.alloc(Math.max(0, c.bytes - 4), 1)]),
  });
  const byId = Object.fromEntries(fixture.shots.map((c) => [c.id, c]));
  const first = await send(byId['first-shot']);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, shot: 'thumb_01', bytes: 48213 });
  for (const id of ['bad-shot-id', 'png', 'too-big', 'unknown-session']) {
    const before = snapshot(hub.dir);
    const res = await send(byId[id]);
    assert.equal(res.status, byId[id].expect.status, id);
    assert.equal((await res.json()).code, byId[id].expect.code, id);
    assert.deepEqual(snapshot(hub.dir), before, `${id}: nothing written`);
  }
  // A JPEG content type over bytes that are not a JPEG is refused too.
  const fake = await hub.call('POST', shotUrl({ sessionId: SESSION, shot: 'thumb_05' }), { headers: { ...hub.maker, 'content-type': 'image/jpeg' }, raw: Buffer.alloc(500, 1) });
  assert.equal(fake.status, 415);
  for (let n = 2; n <= 12; n += 1) {
    const res = await send({ ...byId['first-shot'], query: { sessionId: SESSION, shot: `thumb_${String(n).padStart(2, '0')}` }, bytes: 500 });
    assert.equal(res.status, 200, `shot ${n}`);
  }
  const before = snapshot(hub.dir);
  const thirteenth = await send(byId.thirteenth);
  assert.equal(thirteenth.status, 409);
  assert.equal((await thirteenth.json()).code, 'too-many-shots');
  assert.deepEqual(snapshot(hub.dir), before);
  assert.equal(reports.listShots(CLIENT_ID, { dataDir: hub.dir }).length, 12, 'exactly the valid shots were stored');
  // No token: 401, nothing written.
  const anon = await hub.call('POST', shotUrl({ sessionId: SESSION, shot: 'thumb_02' }), { headers: { 'content-type': 'image/jpeg' }, raw: jpeg(100) });
  assert.equal(anon.status, 401);

  // Reads: staff only.
  const item = `sales:${CLIENT_ID}`;
  const url = `/api/admin/development/${item}/dev-report/shots/${SESSION}/thumb_01`;
  const ok = await hub.call('GET', url, { headers: hub.admin });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.match(ok.headers.get('cache-control'), /no-store/);
  assert.equal(Buffer.from(await ok.arrayBuffer()).length, 48213);
  for (const [name, headers] of [['no credentials', {}], ['a host token alone', hub.maker]]) {
    const res = await hub.call('GET', url, { headers });
    assert.equal(res.status, 401, name);
  }
  const stranger = await hub.call('GET', url, { headers: { 'x-test-user': 'dev-2' } });
  assert.equal(stranger.status, 404, 'a developer who does not own the client cannot see it');
  const listing = await hub.call('GET', `/api/admin/development/${item}/dev-report`, { headers: hub.admin });
  const data = await listing.json();
  assert.equal(data.report.dev.sessionId, SESSION);
  assert.equal(data.shots.length, 12);
  assert.equal((await hub.call('GET', `/api/admin/development/${item}/dev-report`, { headers: {} })).status, 401);
  assert.equal((await hub.call('GET', `/api/admin/development/${item}/dev-report`, { headers: hub.maker })).status, 401);
});

function seedBrief(dir) {
  const folder = join(dir, 'delivery-briefs', CLIENT_ID);
  mkdirSync(folder, { recursive: true });
  const directives = ['dir-synsal001', 'dir-synsal002', 'dir-synsal003'].map((id) => ({ id, kind: 'change', ask: 'x' }));
  writeFileSync(join(folder, 'latest.json'), JSON.stringify({ version: 1, hash: 'sha256:syn', directives }));
}

test('directive status: a host may set done once; accepted and rejected are staff decisions; refusals change nothing', async (t) => {
  const hub = await setup(t);
  seedBrief(hub.dir);
  const url = (id, client = CLIENT_ID) => `/api/maker/clients/${client}/brief/directives/${id}/status`;
  const byId = Object.fromEntries(fixture.directiveStatus.map((c) => [c.id, c]));
  const readReview = () => JSON.parse(readFileSync(join(hub.dir, 'delivery-briefs', CLIENT_ID, 'reviews.json'), 'utf8'));
  // The host reports the run, so its access to the client is the run link.
  const done = byId['host-done'];
  const first = await hub.call('PATCH', url(done.path.directiveId), { headers: hub.maker, body: done.body });
  assert.equal(first.status, 200);
  const record = (await first.json()).directive;
  assert.equal(record.status, 'done');
  assert.deepEqual(record.appliedInJobs, ['job_synsalon0002']);
  const again = await hub.call('PATCH', url(done.path.directiveId), { headers: hub.maker, body: done.body });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).directive.at, record.at, 'the same status and job again changes nothing');

  const accepted = byId['host-accepted'];
  const before = snapshot(hub.dir);
  const refused = await hub.call('PATCH', url(accepted.path.directiveId), { headers: hub.maker, body: accepted.body });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'status-not-allowed');
  const bad = byId['bad-id'];
  const badRes = await hub.call('PATCH', url(bad.path.directiveId), { headers: hub.maker, body: bad.body });
  assert.equal(badRes.status, 400);
  assert.equal((await badRes.json()).code, 'bad-directive-id');
  const unknown = await hub.call('PATCH', url('dir-synsal999'), { headers: hub.maker, body: { status: 'done' } });
  assert.equal(unknown.status, 404);
  assert.deepEqual(snapshot(hub.dir), before, 'refused PATCH requests leave the brief files unchanged');
  assert.equal(readReview().directives['dir-synsal002'], undefined);

  // No credentials, a host without access, and a stranger signed in as another developer.
  assert.equal((await hub.call('PATCH', url('dir-synsal001'), { headers: {}, body: { status: 'done' } })).status, 401);
  assert.equal((await hub.call('PATCH', url('dir-synsal001'), { headers: { 'x-maker-host-token': 'mkh_nope.nope' }, body: { status: 'done' } })).status, 401);
  const noAccess = await hub.call('PATCH', url('dir-synsal001'), { headers: { 'x-maker-host-token': hub.otherToken }, body: { status: 'done' } });
  assert.equal(noAccess.status, 403);
  assert.equal((await hub.call('PATCH', url('dir-synsal001'), { headers: { 'x-test-user': 'dev-2' }, body: { status: 'rejected' } })).status, 404);
  assert.deepEqual(snapshot(hub.dir), before);

  const rejected = byId['staff-rejected'];
  const staff = await hub.call('PATCH', url(rejected.path.directiveId), { headers: hub.admin, body: rejected.body });
  assert.equal(staff.status, 200);
  assert.equal((await staff.json()).directive.status, 'rejected');
  assert.equal(readReview().directives['dir-synsal003'].status, 'rejected');
  assert.equal(readReview().directives['dir-synsal001'].status, 'done', 'a positive host call changed exactly that directive');
});

test('run.dev.updated on the legacy callback answers 202 ignored and writes nothing; the generic branch does write', { timeout: 240_000 }, async (t) => {
  const callbackToken = `dev-report-callback-${Date.now()}`;
  const adminPassword = `dev-report-${Date.now()}-pw`;
  const hub = await bootHub(
    { ADMIN_USERNAME: 'dev-report-admin', ADMIN_PASSWORD: adminPassword, WEBSITE_MAKER_STATUS_CALLBACK_TOKEN: callbackToken, PERSIST_PRODUCTION_ENV: '0', HUB_SAFE_MODE: '1' },
    { seed: (dir) => writeFileSync(join(dir, 'sales-clients.json'), JSON.stringify([{ id: CLIENT_ID, product: 'asoldi', businessName: 'Syn Salon AS', status: 'active', progression: { meetingHeld: true }, makerRun: { runId: RUN } }])) }
  );
  t.after(() => hub.stop());
  assert.ok(hub.health, `hub did not start:\n${hub.log().slice(-2000)}`);
  const read = () => readFileSync(join(hub.dataDir, 'sales-clients.json'), 'utf8');
  const send = (body, token = callbackToken) => fetch(`${hub.base}/api/admin/sales/maker-status-callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sales-callback-token': token },
    body: JSON.stringify(body),
  });
  // The loop's first tick (and the store's own normalizing read) write right after boot; let both finish, then measure.
  const adminToken = await hub.adminToken('dev-report-admin', adminPassword);
  assert.ok(adminToken, 'admin login');
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.equal((await fetch(`${hub.base}/api/admin/sales`, { headers: { authorization: `Bearer ${adminToken}` } })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const before = read();
  const noAuth = await send(fixture.legacyCallback.body, 'wrong-token');
  assert.equal(noAuth.status, 401, 'the callback keeps its own auth in front');
  const res = await send(fixture.legacyCallback.body);
  assert.equal(res.status, fixture.legacyCallback.expect.status);
  assert.deepEqual(await res.json(), fixture.legacyCallback.expect.body);
  assert.equal(read(), before, 'no client sync, no preview push');
  // Control: the same run through the generic branch is a real sync that rewrites the client.
  const generic = await send({ event: 'run.step.updated', runId: RUN, salesClientId: CLIENT_ID, status: 'running', latestReadyStep: '1' });
  assert.equal(generic.status, 200);
  assert.notEqual(read(), before, 'the generic branch writes (the control the 202 is measured against)');
});

test('step keys cms, dev and dev-verify and the dev summary round-trip through the client store', async () => {
  const sales = await import('../data/sales.js');
  const { clearJsonCacheForTests } = await import('../data/atomic-json.js');
  for (const name of readdirSync(baseDir)) if (name === 'sales-clients.json') rmSync(join(baseDir, name), { force: true });
  clearJsonCacheForTests();
  writeFileSync(join(baseDir, 'sales-clients.json'), JSON.stringify([{ id: 'syn-steps', product: 'asoldi', businessName: 'Syn Steps AS', status: 'active', makerRun: { runId: 'syn-steps-run-1' } }]));
  sales.getSalesClients();
  const patch = { runId: 'syn-steps-run-1', steps: { 1: 'ready', 2: 'running', cms: 'ready', dev: 'running', 'dev-verify': 'idle' }, dev: { injected: true } };
  // A patch from a rep (the default call) cannot write the agent's tokens; the authenticated callback can.
  const injected = sales.setSalesMakerRun('syn-steps', patch);
  assert.equal(injected.makerRun.steps.cms, undefined);
  assert.equal(injected.makerRun.steps.dev, undefined);
  assert.equal(injected.makerRun.steps['1'], 'ready', 'ordinary keys still apply');
  const stored = sales.setSalesMakerRun('syn-steps', patch, { devSteps: true });
  assert.equal(stored.makerRun.steps.cms, 'ready');
  assert.equal(stored.makerRun.steps.dev, 'running');
  assert.equal(stored.makerRun.steps['dev-verify'], 'idle');
  assert.equal(stored.makerRun.steps['1'], 'ready', 'the legacy keys are unchanged');
  assert.equal(stored.makerRun.dev, undefined, 'a generic patch cannot write the dev summary');
  const again = sales.setSalesMakerRun('syn-steps', { steps: { 1: 'ready', dev: 'ready' } }, { devSteps: true });
  assert.equal(again.makerRun.steps.dev, 'ready');
  assert.equal(again.makerRun.steps.cms, 'ready', 'a token not in the patch is kept');
  const summary = reports.devSummaryOf(reportCase('review-initial').body, { receivedAt: '2026-12-01T09:12:00.000Z', reportRev: 1 });
  const withDev = sales.setSalesMakerRunDev('syn-steps', summary);
  assert.equal(withDev.makerRun.dev.sessionId, SESSION);
  const reread = sales.getSalesClientById('syn-steps');
  assert.deepEqual(reread.makerRun.dev, summary, 'the summary survives normalization');
  assert.equal(reread.makerRun.steps.dev, 'ready');
  assert.equal(sales.setSalesMakerRun('syn-steps', { dev: { injected: true } }, { devSteps: true }).makerRun.dev.sessionId, SESSION, 'a later patch leaves it alone');
  assert.equal(sales.setSalesMakerRun('syn-steps', { steps: { dev: 'idle' } }).makerRun.steps.dev, 'ready', 'a rep patch cannot change an agent token');
});
