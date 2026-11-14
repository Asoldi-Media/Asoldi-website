// Change requests: quota, intake, auth and the contract fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-cr-'));
process.env.APP_DATA_DIR = dataDir;
process.env.HUB_SAFE_MODE = '1';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/contracts/change-requests.json', import.meta.url), 'utf8'));
const CLIENT_ID = fixture.record.salesClientId;
const SITE_KEY = fixture.intake.headers['x-site-key'];
const CREDENTIAL = 'C'.repeat(43);
const WRONG_CREDENTIAL = 'D'.repeat(43);

const routes = await import('../lib/routes/change-request-routes.js');
const seoRoutes = await import('../lib/routes/seo-record-routes.js');
const store = await import('../lib/change-requests.js');
const settingsStore = await import('../data/automation-settings.js');
const releases = await import('./fixtures/test-releases.mjs');
const credentials = await import('../lib/site-credentials.js');
const jobs = await import('../lib/delivery-jobs.js');
const core = await import('../packages/suite/core/llm/index.js');
const llmHarness = await import('../packages/suite/harness/asoldi/llm.js');

const client = {
  id: CLIENT_ID,
  developerOwnerId: 'developer:201',
  makerRun: { goLive: { target: 'production', liveVerifiedAt: '2026-11-01T00:00:00.000Z' } },
  sitePlan: plan('track'),
};
const site = { id: 'site-salon', site_key: SITE_KEY, planSource: { salesClientId: CLIENT_ID } };
const credentialStore = credentials.createSiteCredentialStore({ dataDir });
credentialStore.enroll(site.id, CREDENTIAL);

let nowIso = '2026-12-15T12:00:00.000Z';
store.setChangeRequestClockForTests(() => new Date(nowIso));
store.setChangeRequestLlmForTests({
  async json() {
    return { size: 'small', type: 'image', outOfScope: false, summary: fixture.record.summary };
  },
});

function plan(enforcement, extra = {}) {
  return {
    tierId: 'tier-1-standard',
    services: ['site'],
    changesPerMonth: 4,
    enforcement,
    status: 'active',
    ...extra,
  };
}

function staffAuth(req, res, next) {
  const role = req.get('x-test-role') || '';
  if (!role) return res.status(401).json({ ok: false, code: 'unauthorized' });
  if (role === 'sales') {
    req.salesUser = { role: 'sales', isAdmin: false, username: 'rep-a', userId: '101' };
    return next();
  }
  if (role === 'admin') {
    req.developmentUser = { role: 'admin', isAdmin: true, username: 'admin', accountKey: 'admin' };
    req.salesUser = { role: 'admin', isAdmin: true, username: 'admin' };
    return next();
  }
  if (role === 'developer') {
    req.developmentUser = { role: 'developer', isAdmin: false, username: 'dev-one', userId: '201', accountKey: 'developer:201' };
    return next();
  }
  return res.status(401).json({ ok: false, code: 'unauthorized' });
}

function buildApp(extra = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  routes.register(app, {
    salesOrDevelopmentAuth: staffAuth,
    hub: { getSiteByKey: (key) => (key === SITE_KEY ? site : null) },
    sales: { getSalesClientById: (id) => (id === client.id ? client : null) },
    getDataDir: () => dataDir,
    credentialStore,
    ...extra,
  });
  return app;
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function call(base, method, path, { headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text };
}

function enableSwitch(on = true) {
  releases.writeReleasesFile(dataDir);
  const saved = settingsStore.saveAutomationSettings({
    changeRequests: { enabled: on },
    lifecycle: { cancellation: { enabled: true, mode: 'auto' } },
    pilotClientIds: [CLIENT_ID],
  }, { dataDir, by: 'test' });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
}

function resetFiles() {
  for (const path of [store.changeRequestStorePath(dataDir), jobs.jobsPath({ dataDir })]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

function snap(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function jobCount() {
  return jobs.listJobs({ dataDir, fresh: true, kind: 'change_request' }).length;
}

function usedNow() {
  return store.quotaFor(client, { dataDir }).used;
}

const credentialHeaders = { 'x-site-key': SITE_KEY, 'x-site-credential': CREDENTIAL };
const keyHeaders = { 'x-site-key': SITE_KEY };
const adminHeaders = { 'x-test-role': 'admin' };

test.describe('change requests', { concurrency: 1 }, () => {
  let base;
  let close;
  test.before(async () => {
    const started = await listen(buildApp());
    base = started.base;
    close = started.close;
    enableSwitch(true);
  });
  test.after(async () => { await close(); });

  test('Oslo month boundaries, the due date, and the fifth request', async () => {
    for (const row of fixture.quotaScenario.osloMonth) {
      assert.equal(store.osloMonthOf(row.countedAt), row.month, row.note);
    }
    for (const row of fixture.quotaScenario.dueAt) {
      assert.equal(store.dueDateFor(row.countedAt, row.slaWorkDays), row.dueAt);
    }
    assert.equal(fixture.quotaScenario.steps.length, 5);
    assert.equal(fixture.quotaScenario.osloMonth.length, 4);

    resetFiles();
    client.sitePlan = plan('track');
    client.makerRun = { goLive: { target: 'production', liveVerifiedAt: '2026-11-01T00:00:00.000Z' } };
    nowIso = '2026-12-02T08:00:00.000Z';
    const accepted = [];
    for (let n = 0; n < 4; n += 1) {
      const posted = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
      assert.equal(posted.status, 201);
      const result = await call(base, 'PATCH', `/api/admin/change-requests/${posted.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
      assert.equal(result.status, 200);
      accepted.push(result.json.request);
    }
    assert.equal(usedNow(), 4);
    assert.equal(accepted[3].overQuota, false);

    const fifth = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
    assert.equal(fifth.status, 201);
    assert.equal(fifth.json.status, 'received');
    assert.equal(usedNow(), 4, 'a received request does not count');

    const tracked = await call(base, 'PATCH', `/api/admin/change-requests/${fifth.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
    assert.equal(tracked.status, 200);
    assert.equal(tracked.json.request.overQuota, true);
    assert.equal(usedNow(), 5);

    resetFiles();
    client.sitePlan = plan('block');
    for (let n = 0; n < 4; n += 1) {
      const posted = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
      const result = await call(base, 'PATCH', `/api/admin/change-requests/${posted.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
      assert.equal(result.status, 200, result.text);
    }
    const blockedPost = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
    const before = snap(store.changeRequestStorePath(dataDir));
    const blocked = await call(base, 'PATCH', `/api/admin/change-requests/${blockedPost.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'over-quota');
    assert.equal(usedNow(), 4);
    assert.deepEqual(snap(store.changeRequestStorePath(dataDir)), before);

    resetFiles();
    client.makerRun = {};
    client.sitePlan = plan('track');
    const early = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
    const earlyAccept = await call(base, 'PATCH', `/api/admin/change-requests/${early.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
    assert.equal(earlyAccept.status, 200);
    assert.equal(earlyAccept.json.request.month, '');
    assert.equal(earlyAccept.json.request.countedAt, '');
    assert.equal(usedNow(), 0);

    client.makerRun = { goLive: { target: 'production', liveVerifiedAt: '2026-01-01T00:00:00.000Z' } };
    for (const row of fixture.quotaScenario.osloMonth) {
      resetFiles();
      nowIso = row.countedAt;
      const posted = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
      const result = await call(base, 'PATCH', `/api/admin/change-requests/${posted.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
      assert.equal(result.json.request.month, row.month, row.note);
    }
    nowIso = '2026-12-02T08:00:00.000Z';
    resetFiles();
    const dated = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: { ...fixture.intake.body, title: 'Frist' } });
    nowIso = '2026-12-01T19:20:00.000Z';
    const created = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
    nowIso = '2026-12-02T08:00:00.000Z';
    await call(base, 'PATCH', `/api/admin/change-requests/${dated.json.id}`, { headers: adminHeaders, body: { action: 'reject' } });
    const acceptedRow = await call(base, 'PATCH', `/api/admin/change-requests/${created.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
    assert.equal(acceptedRow.json.request.dueAt, '2026-12-16');
    nowIso = '2026-12-17T12:00:00.000Z';
    const listed = await call(base, 'GET', `/api/admin/change-requests?clientId=${CLIENT_ID}`, { headers: adminHeaders });
    const flagged = listed.json.items.find((row) => row.id === created.json.id);
    assert.ok(flagged.flags.includes('overdue'));
    const done = await call(base, 'PATCH', `/api/admin/change-requests/${created.json.id}`, { headers: adminHeaders, body: { action: 'start' } });
    await call(base, 'PATCH', `/api/admin/change-requests/${created.json.id}`, { headers: adminHeaders, body: { action: 'done' } });
    const afterDone = await call(base, 'GET', `/api/admin/change-requests?clientId=${CLIENT_ID}`, { headers: adminHeaders });
    const finished = afterDone.json.items.find((row) => row.id === created.json.id);
    assert.equal(finished.flags.includes('overdue'), false);
    assert.equal(done.status, 200);

    const agent = store.recordAgentQuotaUnits(created.json.id, 2, { dataDir, by: 'maker' });
    assert.equal(agent.request.quotaUnits, 1);
    assert.equal(agent.request.agentQuotaUnits, 2);
    assert.ok(store.flagsFor(agent.request, nowIso).includes('agent-quota-differs'));
  });

  test('the fixture intake, the lists, the stored record and the job view', async () => {
    resetFiles();
    client.sitePlan = plan('track');
    client.makerRun = { goLive: { target: 'production', liveVerifiedAt: '2026-11-01T00:00:00.000Z' } };
    nowIso = '2026-12-04T10:00:00.000Z';
    for (let n = 0; n < 3; n += 1) {
      const posted = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: { ...fixture.intake.body, title: `Tidligere ${n}` } });
      assert.equal((await call(base, 'PATCH', `/api/admin/change-requests/${posted.json.id}`, { headers: adminHeaders, body: { action: 'accept' } })).status, 200);
    }
    nowIso = '2026-12-01T19:20:00.000Z';
    const posted = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
    assert.equal(posted.status, fixture.intake.expect.status);
    assert.equal(posted.json.ok, true);
    assert.equal(posted.json.status, 'received');
    assert.equal(posted.json.sourceVerified, true);
    assert.match(posted.json.id, /^cr_[a-z0-9]{8,40}$/);
    assert.notEqual(posted.json.id, fixture.record.id);
    assert.deepEqual(posted.json.quota, fixture.intake.expect.body.quota);
    assert.equal(posted.json.quota.used, usedNow());

    nowIso = '2026-12-02T08:00:00.000Z';
    const accepted = await call(base, 'PATCH', `/api/admin/change-requests/${posted.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
    assert.equal(accepted.status, 200);
    const stored = store.getChangeRequest(posted.json.id, { dataDir });
    assert.deepEqual({ ...stored, id: fixture.record.id }, fixture.record);
    assert.deepEqual({ ...store.jobViewOf(stored), id: fixture.jobView.id }, fixture.jobView);
    assert.deepEqual(store.jobInputOf({ ...stored, id: fixture.record.id }), fixture.jobInput);
    assert.equal(store.quotaFor(client, { dataDir }).used, store.readChangeRequests(dataDir).reduce((sum, row) => sum + (row.month === '2026-12' ? row.quotaUnits : 0), 0));

    const credentialList = await call(base, 'GET', '/api/hub/change-requests', { headers: credentialHeaders });
    assert.equal(credentialList.status, 200);
    assert.equal(credentialList.json.ok, true);
    for (const item of credentialList.json.items) {
      assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'doneAt', 'id', 'status', 'title']);
    }
    assert.deepEqual(Object.keys(credentialList.json.quota).sort(), ['limit', 'period', 'used']);
    const mine = credentialList.json.items.find((item) => item.id === posted.json.id);
    assert.equal(mine.title, fixture.listCredential.expect.body.items[0].title);
    assert.equal(mine.status, 'accepted');
    assert.equal(credentialList.json.quota.used, usedNow());
    assert.ok(credentialList.json.items.length > 1);

    resetFiles();
    nowIso = '2026-12-02T08:00:00.000Z';
    const seeded = structuredClone(fixture.record);
    seeded.quotaUnits = 4;
    writeFileSync(store.changeRequestStorePath(dataDir), JSON.stringify({ version: 1, requests: [seeded] }));
    const exact = await call(base, 'GET', '/api/hub/change-requests', { headers: credentialHeaders });
    assert.deepEqual(exact.json, fixture.listCredential.expect.body);
    const hidden = await call(base, 'GET', '/api/hub/change-requests', { headers: keyHeaders });
    assert.deepEqual(hidden.json, fixture.listKeyOnly.expect.body);
    assert.throws(() => {
      const planted = { ...hidden.json, items: [{ id: 'cr_planted01', title: 'Bytt bilde på forsiden', status: 'accepted', createdAt: '', doneAt: '' }] };
      assert.deepEqual(planted, fixture.listKeyOnly.expect.body);
    });

    const limited = fixture.quota.find((row) => row.id === 'limited');
    assert.deepEqual(store.quotaFor(client, { dataDir }), limited.body);
    resetFiles();
    client.sitePlan = plan('track', { serviceTerms: { unlimited: { until: '2027-01-31T00:00:00.000Z' } }, changesPerMonth: 4 });
    const rows = [];
    for (let n = 0; n < 9; n += 1) {
      const one = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
      const result = await call(base, 'PATCH', `/api/admin/change-requests/${one.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
      assert.equal(result.status, 200, result.text);
      rows.push(result.json.request);
    }
    assert.equal(rows[8].overQuota, false);
    assert.deepEqual(store.quotaFor(client, { dataDir }), fixture.quota.find((row) => row.id === 'unlimited').body);
    client.sitePlan = plan('track');
  });

  test('every refused fixture case, the oversize body, and a verified job', async () => {
    assert.equal(fixture.refused.length > 0, true);
    let ran = 0;
    for (const item of fixture.refused) {
      ran += 1;
      resetFiles();
      enableSwitch(true);
      client.sitePlan = plan('track');
      client.makerRun = { goLive: { target: 'production', liveVerifiedAt: '2026-11-01T00:00:00.000Z' } };
      nowIso = '2026-12-02T08:00:00.000Z';
      const beforeJobs = jobCount();
      if (item.id === 'unknown-type' || item.id === 'long-title') {
        const before = snap(store.changeRequestStorePath(dataDir));
        const response = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: item.body });
        assert.equal(response.status, item.expect.status, item.id);
        assert.equal(response.json.code, item.expect.code, item.id);
        assert.equal(response.json.field, item.expect.field, item.id);
        assert.deepEqual(snap(store.changeRequestStorePath(dataDir)), before);
        assert.equal(jobCount(), beforeJobs);
      } else if (item.id === 'long-excerpt-cut') {
        const response = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: item.body });
        assert.equal(response.status, 201, item.id);
        const stored = store.getChangeRequest(response.json.id, { dataDir });
        assert.equal(stored.elementRef.textExcerpt.length, item.expect.storedExcerptLength);
      } else if (item.id === 'key-only-21st') {
        for (let n = 0; n < fixture.limits.unverifiedPerSiteDay; n += 1) {
          const posted = await call(base, 'POST', '/api/hub/change-requests', { headers: keyHeaders, body: fixture.intake.body });
          assert.equal(posted.status, 201, `unverified ${n}`);
        }
        const before = snap(store.changeRequestStorePath(dataDir));
        const response = await call(base, 'POST', '/api/hub/change-requests', { headers: keyHeaders, body: fixture.intake.body });
        assert.equal(response.status, 429);
        assert.equal(response.json.code, 'rate-limited');
        assert.deepEqual(snap(store.changeRequestStorePath(dataDir)), before);
        assert.equal(jobCount(), beforeJobs);
      } else if (item.id === 'key-only-no-job') {
        const posted = await call(base, 'POST', '/api/hub/change-requests', { headers: keyHeaders, body: fixture.intake.body });
        assert.equal(posted.status, 201);
        assert.equal(posted.json.sourceVerified, false);
        const accepted = await call(base, 'PATCH', `/api/admin/change-requests/${posted.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
        assert.equal(accepted.status, 200);
        const started = await call(base, 'PATCH', `/api/admin/change-requests/${posted.json.id}`, { headers: adminHeaders, body: { action: 'start' } });
        assert.equal(started.status, 200);
        assert.equal(jobCount(), beforeJobs);
      } else if (item.id === 'cancelled-client') {
        client.sitePlan = { ...plan('track'), status: 'ended' };
        const before = snap(store.changeRequestStorePath(dataDir));
        const response = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
        assert.equal(response.status, 409);
        assert.equal(response.json.code, 'contract-ended');
        assert.equal(response.json.message, 'Avtalen er avsluttet');
        assert.deepEqual(snap(store.changeRequestStorePath(dataDir)), before);
        client.sitePlan = plan('track');
      } else if (item.id === 'switch-off') {
        enableSwitch(false);
        const before = snap(store.changeRequestStorePath(dataDir));
        const response = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
        assert.equal(response.status, 404);
        assert.equal(response.json.code, 'disabled');
        assert.deepEqual(snap(store.changeRequestStorePath(dataDir)), before);
        enableSwitch(true);
      } else if (item.id === 'no-auth') {
        const before = snap(store.changeRequestStorePath(dataDir));
        const response = await call(base, 'POST', '/api/hub/change-requests', { body: fixture.intake.body });
        assert.equal(response.status, 401);
        assert.equal(response.json.code, 'unauthorized');
        assert.deepEqual(snap(store.changeRequestStorePath(dataDir)), before);
      } else if (item.id === 'bad-credential') {
        const before = snap(store.changeRequestStorePath(dataDir));
        const response = await call(base, 'POST', '/api/hub/change-requests', {
          headers: { 'x-site-key': SITE_KEY, 'x-site-credential': WRONG_CREDENTIAL },
          body: fixture.intake.body,
        });
        assert.equal(response.status, 401);
        assert.equal(response.json.code, 'unauthorized');
        assert.deepEqual(snap(store.changeRequestStorePath(dataDir)), before);
      } else if (item.id === 'staff-sales-only') {
        const posted = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
        const before = snap(store.changeRequestStorePath(dataDir));
        const patched = await call(base, 'PATCH', `/api/admin/change-requests/${posted.json.id}`, { headers: { 'x-test-role': 'sales' }, body: { action: 'accept' } });
        const created = await call(base, 'POST', `/api/admin/sales/${CLIENT_ID}/change-requests`, { headers: { 'x-test-role': 'sales' }, body: { ...fixture.intake.body, source: 'admin' } });
        assert.equal(patched.status, 403);
        assert.equal(patched.json.code, 'forbidden');
        assert.equal(created.status, 403);
        assert.equal(created.json.code, 'forbidden');
        assert.deepEqual(snap(store.changeRequestStorePath(dataDir)), before);
      } else if (item.id === 'invalid-transition') {
        const posted = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
        const before = snap(store.changeRequestStorePath(dataDir));
        const response = await call(base, 'PATCH', `/api/admin/change-requests/${posted.json.id}`, { headers: adminHeaders, body: { action: 'done' } });
        assert.equal(response.status, 409);
        assert.equal(response.json.code, 'invalid-transition');
        assert.deepEqual(snap(store.changeRequestStorePath(dataDir)), before);
        assert.equal(jobCount(), beforeJobs);
      } else {
        assert.fail(`unhandled refused case ${item.id}`);
      }
    }
    assert.equal(ran, fixture.refused.length);

    const recipe = fixture.recipes.find((row) => row.id === 'oversize-intake');
    const raw = paddedBody(recipe.toTotalBytes);
    assert.equal(Buffer.byteLength(raw), recipe.toTotalBytes);
    const over = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: raw });
    assert.equal(over.status, 413);
    assert.equal(over.json.code, 'too-large');

    resetFiles();
    const unverifiedBefore = jobCount();
    const unverified = await call(base, 'POST', '/api/hub/change-requests', { headers: keyHeaders, body: fixture.intake.body });
    await call(base, 'PATCH', `/api/admin/change-requests/${unverified.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
    await call(base, 'PATCH', `/api/admin/change-requests/${unverified.json.id}`, { headers: adminHeaders, body: { action: 'start' } });
    assert.equal(jobCount(), unverifiedBefore);
    const verifiedBefore = jobCount();
    const verified = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
    await call(base, 'PATCH', `/api/admin/change-requests/${verified.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
    await call(base, 'PATCH', `/api/admin/change-requests/${verified.json.id}`, { headers: adminHeaders, body: { action: 'start' } });
    assert.equal(jobCount(), verifiedBefore + 1);
    const queued = jobs.listJobs({ dataDir, fresh: true, kind: 'change_request' });
    assert.deepEqual(queued[0].input.changeRequestIds, [verified.json.id]);
  });

  test('staff and CMS auth negatives write nothing, and an admin patch changes one request', async () => {
    resetFiles();
    enableSwitch(true);
    nowIso = '2026-12-02T08:00:00.000Z';
    const first = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
    const second = await call(base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: { ...fixture.intake.body, title: 'Andre' } });
    const paths = [store.changeRequestStorePath(dataDir), jobs.jobsPath({ dataDir })];
    const before = () => paths.map(snap);
    let made = 0;
    const refused = [
      ['PATCH', `/api/admin/change-requests/${first.json.id}`, {}],
      ['POST', `/api/admin/sales/${CLIENT_ID}/change-requests`, {}],
      ['GET', '/api/admin/change-requests', {}],
      ['POST', '/api/hub/change-requests', { body: fixture.intake.body }],
      ['GET', '/api/hub/change-requests', {}],
    ];
    for (const [method, path, options] of refused) {
      made += 1;
      const shot = before();
      const response = await call(base, method, path, options);
      assert.equal(response.status, 401, path);
      assert.deepEqual(before(), shot);
    }
    for (const [method, path, options] of [
      ['PATCH', `/api/admin/change-requests/${first.json.id}`, { headers: { 'x-test-role': 'sales' }, body: { action: 'accept' } }],
      ['POST', `/api/admin/sales/${CLIENT_ID}/change-requests`, { headers: { 'x-test-role': 'sales' }, body: { ...fixture.intake.body, source: 'admin' } }],
    ]) {
      made += 1;
      const shot = before();
      const response = await call(base, method, path, options);
      assert.equal(response.status, 403, path);
      assert.equal(response.json.code, 'forbidden');
      assert.deepEqual(before(), shot);
    }
    enableSwitch(false);
    for (const [method, path] of [
      ['POST', '/api/hub/change-requests'],
      ['GET', '/api/hub/change-requests'],
      ['GET', '/api/admin/change-requests'],
      ['PATCH', `/api/admin/change-requests/${first.json.id}`],
      ['POST', `/api/admin/sales/${CLIENT_ID}/change-requests`],
    ]) {
      made += 1;
      const shot = before();
      const response = await call(base, method, path, {
        headers: { ...credentialHeaders, 'x-test-role': 'admin' },
        ...(method === 'GET' ? {} : { body: fixture.intake.body }),
      });
      assert.equal(response.status, 404, path);
      assert.equal(response.json.code, 'disabled');
      assert.deepEqual(before(), shot);
    }
    assert.ok(made > 0);
    enableSwitch(true);

    const otherBefore = store.getChangeRequest(second.json.id, { dataDir });
    const patched = await call(base, 'PATCH', `/api/admin/change-requests/${first.json.id}`, { headers: adminHeaders, body: { action: 'accept' } });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.request.status, 'accepted');
    assert.equal(patched.json.request.id, first.json.id);
    assert.deepEqual(store.getChangeRequest(second.json.id, { dataDir }), otherBefore);
    const listed = await call(base, 'GET', '/api/hub/change-requests', { headers: credentialHeaders });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.quota.used, usedNow());
    assert.ok(listed.json.items.some((item) => item.id === first.json.id));
  });

  test('with the switch off, existing route answers stay byte-identical', async () => {
    enableSwitch(false);
    const seoDeps = {
      salesOrDevelopmentAuth: staffAuth,
      developmentAuth: staffAuth,
      makerAuth: { requireMakerHost: () => (_req, _res, next) => next() },
      sales: { getSalesClientById: (id) => (id === client.id ? client : null) },
      getDataDir: () => dataDir,
    };
    const beforeApp = express();
    beforeApp.use(express.json());
    seoRoutes.register(beforeApp, seoDeps);
    const afterApp = express();
    afterApp.use(express.json());
    seoRoutes.register(afterApp, seoDeps);
    routes.register(afterApp, {
      salesOrDevelopmentAuth: staffAuth,
      hub: { getSiteByKey: (key) => (key === SITE_KEY ? site : null) },
      sales: { getSalesClientById: (id) => (id === client.id ? client : null) },
      getDataDir: () => dataDir,
      credentialStore,
    });
    const left = await listen(beforeApp);
    const right = await listen(afterApp);
    try {
      const paths = [`/api/admin/sales-clients/${CLIENT_ID}/seo`, '/api/internal/maker/seo-record?salesClientId=' + CLIENT_ID];
      let compared = 0;
      for (const path of paths) {
        const a = await call(left.base, 'GET', path, { headers: adminHeaders });
        const b = await call(right.base, 'GET', path, { headers: adminHeaders });
        assert.equal(a.status, b.status, path);
        assert.equal(a.text, b.text, path);
        compared += 1;
      }
      assert.ok(compared > 0);
      const closed = await call(right.base, 'POST', '/api/hub/change-requests', { headers: credentialHeaders, body: fixture.intake.body });
      assert.equal(closed.status, 404);
      assert.equal(closed.json.code, 'disabled');
    } finally {
      await left.close();
      await right.close();
      enableSwitch(true);
    }
  });

  test('the rule-based classifier answers when the provider throws', async () => {
    let calls = 0;
    store.setChangeRequestLlmForTests({
      async json() {
        calls += 1;
        throw new Error('provider down');
      },
    });
    try {
      const result = await store.classifyChange({ type: 'text', title: 'Ny setning i om oss', description: 'Bytt ordlyden.' });
      assert.ok(calls > 0);
      assert.equal(result.size, 'unknown');
      assert.equal(result.type, 'text');
    } finally {
      store.setChangeRequestLlmForTests({
        async json() {
          return { size: 'small', type: 'image', outOfScope: false, summary: fixture.record.summary };
        },
      });
    }
  });

  test('change classification does not resolve to DeepSeek', () => {
    const legacyRoute = (_task, _ctx, spec) => (spec.kind === 'tools' ? 'claude:claude-haiku-5-5' : spec.vision ? 'gemini:gemini-2.5-flash' : 'deepseek:deepseek-chat');
    const now = new Date('2026-12-02T08:00:00.000Z');
    const router = core.createRouter({ ...llmHarness.asoldiLlmConfig(), legacyRoute, now });
    function notDeepSeek(profile) {
      const route = router.resolveRoute('change.classify', { profile });
      assert.notEqual(route.primary.provider, 'deepseek', profile);
      assert.ok(!route.chain.some((entry) => entry.provider === 'deepseek'), profile);
    }
    notDeepSeek('legacy');
    notDeepSeek('prod');
    const policy = { ...llmHarness.ASOLDI_LLM_POLICY, redirect: 'deepseek:deepseek-flash' };
    const opened = core.createRouter({ ...llmHarness.asoldiLlmConfig(), policy, legacyRoute, now });
    assert.throws(() => {
      const route = opened.resolveRoute('change.classify', { profile: 'legacy' });
      assert.notEqual(route.primary.provider, 'deepseek');
      assert.ok(!route.chain.some((entry) => entry.provider === 'deepseek'));
    });
  });

  test('added files do not name a plan task or a planning label', () => {
    const banned = new RegExp(`${String.fromCharCode(87, 83)}\\d|\\b${String.fromCharCode(119, 97, 118, 101)}\\b|\\b${String.fromCharCode(119, 111, 114, 107, 115, 116, 114, 101, 97, 109)}\\b|\\b${String.fromCharCode(97, 112, 112, 101, 110, 100, 105, 120)}\\b`, 'gi');
    const files = [
      'lib/change-requests.js',
      'lib/routes/change-request-routes.js',
      'scripts/change-requests.test.mjs',
      'scripts/seo-compliance-signoff.test.mjs',
      'docs/change-requests.md',
    ].map((rel) => join(dataDir, '..', '..', '..', 'work', rel));
    const root = new URL('..', import.meta.url);
    const paths = [
      'lib/change-requests.js',
      'lib/routes/change-request-routes.js',
      'scripts/change-requests.test.mjs',
      'scripts/seo-compliance-signoff.test.mjs',
      'docs/change-requests.md',
    ].map((rel) => new URL(rel, root));
    let hits = 0;
    for (const file of paths) {
      const source = readFileSync(file, 'utf8');
      hits += [...source.matchAll(banned)].length;
    }
    assert.ok(paths.length > 0);
    assert.equal(hits, 0);
    const plantedPath = join(tmpdir(), 'planted-copy.js');
    writeFileSync(plantedPath, `${readFileSync(paths[0], 'utf8')}\n// ${String.fromCharCode(87, 83)}8.36\n`);
    const plantedHits = [...readFileSync(plantedPath, 'utf8').matchAll(banned)].length;
    assert.equal(plantedHits, 1);
    unlinkSync(plantedPath);
    assert.equal(files.length, paths.length);
  });
});

function paddedBody(total) {
  const prefix = '{"type":"image","title":"Bytt bilde","description":"';
  const suffix = '","pageUrl":"/"}';
  const pad = total - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  return prefix + 'y'.repeat(pad) + suffix;
}
