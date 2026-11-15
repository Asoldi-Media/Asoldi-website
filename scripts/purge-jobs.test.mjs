// The admin client purge (lib/purge-jobs.js and its route): report first, then delete only with a prior
// report id and the backup listing. Synthetic clients only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const baseDir = mkdtempSync(join(tmpdir(), 'asoldi-purge-'));
process.env.APP_DATA_DIR = baseDir;
process.env.HUB_SAFE_MODE = '1';
delete process.env.DATA_DIR;

const hosts = await import('../data/maker-hosts.js');
const hardening = await import('../lib/auth-hardening.js');
const makerAuthLib = await import('../lib/maker-auth.js');
const meta = await import('../lib/maker-host-meta.js');
const routes = await import('../lib/routes/dev-report-routes.js');
const reports = await import('../lib/dev-reports.js');
const purge = await import('../lib/purge-jobs.js');
const { defaultAutomationSettings } = await import('../data/automation-settings.js');

const fixture = JSON.parse(readFileSync(new URL('./fixtures/contracts/dev-report-1.json', import.meta.url), 'utf8'));
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

/** Every file of the stores a purge may touch, with size and time. */
function snapshot(dir) {
  const out = [];
  const walk = (path, rel) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full, `${rel}/${name}`);
      else out.push(`${rel}/${name}|${statSync(full).size}|${statSync(full).mtimeMs}|${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  for (const sub of ['dev-reports', 'purge-reports']) if (existsSync(join(dir, sub))) walk(join(dir, sub), sub);
  const jobs = join(dir, 'delivery-jobs.json');
  if (existsSync(jobs)) out.push(`delivery-jobs.json|${readFileSync(jobs, 'utf8').length}`);
  return out.sort();
}

function jpeg(bytes) {
  const buffer = Buffer.alloc(bytes, 0x61);
  buffer.set([0xff, 0xd8, 0xff]);
  return buffer;
}

function seedClient(dir, clientId, caseId) {
  const row = fixture.reports.find((entry) => entry.id === caseId);
  const body = structuredClone(row.body);
  assert.equal(reports.storeReport(clientId, body, { dataDir: dir }).stored, true);
  for (const shot of ['thumb_01', 'thumb_02']) assert.equal(reports.storeShot(clientId, body.dev.sessionId, shot, jpeg(300), { dataDir: dir }).ok, true);
  return body.dev.sessionId;
}

async function setup(t, { enabled = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-purge-case-'));
  temps.push(dir);
  const { token } = hosts.createMakerHost({ label: 'Test host' }, { dataDir: dir });
  const sessionA = seedClient(dir, 'syn-client-a', 'review-initial');
  const sessionB = seedClient(dir, 'syn-client-b', 'iteration-accepted');
  const clients = { 'syn-client-a': { id: 'syn-client-a' }, 'syn-client-b': { id: 'syn-client-b' } };
  const current = { settings: defaultAutomationSettings() };
  if (enabled) current.settings = { ...current.settings, purgeJobs: { enabled: true, mode: 'shadow', paused: null } };
  const jobs = [];
  const makerAuth = makerAuthLib.createMakerAuth({
    legacyHolder: hardening.createHubSecretHolder({ envValue: '', envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 }),
    dataDir: dir,
    env: {},
  });
  meta.resetHubCapabilitiesForTests();
  const app = express();
  app.use(express.json());
  routes.register(app, {
    developmentAuth,
    makerAuth,
    sales: { getSalesClientById: (id) => clients[id] || null, getSalesClients: () => Object.values(clients) },
    getDataDir: () => dir,
    settings: () => current.settings,
    routedJobs: () => [],
    boardItems: () => [],
    enqueuePurgeJob: (job) => {
      jobs.push(job);
      return { queued: true, jobId: 'job_syn00001' };
    },
    log: { warn() {}, error() {}, log() {} },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (headers, body) => fetch(`${base}/api/admin/system/client-purge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { dir, current, jobs, call, sessionA, sessionB, host: { 'x-maker-host-token': token }, admin: { 'x-test-user': 'admin' }, developer: { 'x-test-user': 'dev-1' } };
}

test('refused purges write and enqueue nothing: switch off, no credentials, developer role, Maker host token', async (t) => {
  const off = await setup(t, { enabled: false });
  const hub = await setup(t);
  const body = { mode: 'report', salesClientId: 'syn-client-a' };
  const cases = [
    [off, 'switch off', off.admin, 404, 'disabled'],
    [off, 'switch off without credentials', {}, 404, 'disabled'],
    [hub, 'no credentials', {}, 401, undefined],
    [hub, 'developer role', hub.developer, 403, 'forbidden'],
    [hub, 'Maker host token', hub.host, 403, 'forbidden'],
  ];
  let requests = 0;
  for (const [h, name, headers, status, code] of cases) {
    const before = snapshot(h.dir);
    assert.ok(before.length > 0, `${name}: seeded files > 0`);
    const res = await h.call(headers, body);
    requests += 1;
    assert.equal(res.status, status, name);
    if (code) assert.equal((await res.json()).code, code, name);
    assert.deepEqual(snapshot(h.dir), before, `${name}: store snapshot equal`);
    assert.equal(h.jobs.length, 0, `${name}: no job enqueued`);
  }
  assert.ok(requests === cases.length);
  assert.equal(existsSync(join(hub.dir, 'purge-reports')), false, 'no report folder was created by a refusal');
});

test('admin with the switch on: delete is refused without a report id, a stored report or its backup listing', async (t) => {
  const hub = await setup(t);
  const report = await (await hub.call(hub.admin, { mode: 'report', salesClientId: 'syn-client-a' })).json();
  const other = await (await hub.call(hub.admin, { mode: 'report', salesClientId: 'syn-client-b' })).json();
  assert.equal(report.ok, true);
  const before = snapshot(hub.dir);
  const cases = [
    [{ mode: 'delete' }, 'no-report'],
    [{ mode: 'delete', reportId: 'rpt_0000000000000000', backupListing: report.listingFile }, 'no-report'],
    [{ mode: 'delete', reportId: report.reportId }, 'no-backup-listing'],
    [{ mode: 'delete', reportId: report.reportId, backupListing: join(hub.dir, 'missing.listing.json') }, 'no-backup-listing'],
    [{ mode: 'delete', reportId: report.reportId, backupListing: other.listingFile }, 'no-backup-listing'],
    [{ mode: 'weird', salesClientId: 'syn-client-a' }, 'bad-mode'],
    [{ mode: 'report', salesClientId: '../x' }, 'bad-client'],
  ];
  for (const [body, code] of cases) {
    const res = await hub.call(hub.admin, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, code, JSON.stringify(body));
    assert.deepEqual(snapshot(hub.dir), before, `${JSON.stringify(body)}: nothing changed`);
  }
  assert.equal(hub.jobs.length, 0);
});

test('report mode writes only its report and listing and deletes 0 rows; delete removes exactly that client', async (t) => {
  const hub = await setup(t);
  const before = snapshot(hub.dir);
  assert.ok(before.length >= 6);
  const res = await hub.call(hub.admin, { mode: 'report', salesClientId: 'syn-client-a' });
  const report = await res.json();
  assert.equal(res.status, 200);
  assert.equal(report.counts.files, 3, 'one report and two thumbnails');
  assert.equal(report.counts.shots, 2);
  assert.equal(report.counts.reports, 1);
  const after = snapshot(hub.dir);
  assert.deepEqual(after.filter((line) => !line.startsWith('purge-reports/')), before, 'every stored file is unchanged');
  assert.equal(after.filter((line) => line.startsWith('purge-reports/')).length, 2, 'the report and its listing');
  assert.equal(hub.jobs.length, 0);

  const removed = await hub.call(hub.admin, { mode: 'delete', reportId: report.reportId, backupListing: report.listingFile });
  const result = await removed.json();
  assert.equal(removed.status, 200, JSON.stringify(result));
  assert.equal(result.removed, 3, 'one report and two thumbnails of that client');
  assert.equal(result.changed, 0);
  assert.deepEqual(result.makerJob, { queued: true, jobId: 'job_syn00001' });
  assert.equal(hub.jobs.length, 1);
  assert.equal(hub.jobs[0].salesClientId, 'syn-client-a');
  assert.equal(reports.listReports('syn-client-a', { dataDir: hub.dir }).length, 0);
  assert.equal(reports.listShots('syn-client-a', { dataDir: hub.dir }).length, 0);
  assert.equal(existsSync(join(hub.dir, 'dev-reports', 'syn-client-a')), false, 'emptied folders go too');
  assert.equal(reports.listReports('syn-client-b', { dataDir: hub.dir }).length, 1, 'the other client keeps its report');
  assert.equal(reports.listShots('syn-client-b', { dataDir: hub.dir }).length, 2, 'and its thumbnails');
  const kept = snapshot(hub.dir).filter((line) => line.startsWith('dev-reports/syn-client-b'));
  assert.deepEqual(kept, before.filter((line) => line.startsWith('dev-reports/syn-client-b')), 'byte for byte');

  // A report applies once.
  const again = await hub.call(hub.admin, { mode: 'delete', reportId: report.reportId, backupListing: report.listingFile });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'report-used');
  assert.equal(hub.jobs.length, 1, 'no second job');
});

test('a file that changed after the report stays; a stale report is refused', async (t) => {
  const hub = await setup(t);
  const report = await (await hub.call(hub.admin, { mode: 'report', salesClientId: 'syn-client-a' })).json();
  const shot = join(hub.dir, 'dev-reports', 'syn-client-a', 'shots', hub.sessionA, 'thumb_01.jpg');
  writeFileSync(shot, jpeg(999));
  const res = await hub.call(hub.admin, { mode: 'delete', reportId: report.reportId, backupListing: report.listingFile });
  const result = await res.json();
  assert.equal(result.changed, 1);
  assert.equal(result.removed, 2);
  assert.equal(existsSync(shot), true, 'the changed thumbnail is left alone');

  const second = await setup(t);
  const fresh = purge.reportClientPurge({ salesClientId: 'syn-client-a', dataDir: second.dir, now: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) });
  const before = snapshot(second.dir);
  const stale = await second.call(second.admin, { mode: 'delete', reportId: fresh.reportId, backupListing: fresh.listingFile });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'report-stale');
  assert.deepEqual(snapshot(second.dir), before);
});

test('the purge job kind exists in the delivery vocabulary and survives a pause', async () => {
  const { JOB_KINDS } = await import('../packages/suite/core/delivery/vocab.js');
  const { PAUSED_ALLOWED_JOB_KINDS } = await import('../lib/delivery-lifecycle.js');
  assert.ok(JOB_KINDS.includes('purge'));
  assert.ok(PAUSED_ALLOWED_JOB_KINDS.includes('purge'));
});
