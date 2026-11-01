// Boots the real hub (server.js) on a random local port with a throwaway data dir, no real
// credentials, safe mode on and loopback-only egress, then checks the SEO record over HTTP:
// both bundle ingest routes record the plan summary without a portal user, a push without a summary
// answers exactly as before, the admin routes round-trip agreed keywords, and the Maker read stays
// 404 {code:'disabled'} until seo.recordPull is switched on. Negative controls: staff access, and a
// portal data bank that names another business's sales client never gets that client's keywords in
// the public site config.
//
// Run: node --test scripts/seo-record-boot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { PRODUCTION_ENV_KEYS } from '../lib/persistent-env.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverPath = join(repoRoot, 'server.js');
const egressGuard = pathToFileURL(join(repoRoot, 'scripts', 'security', 'loopback-only-egress.mjs')).href;
const CREDENTIAL_KEY = /(KEY|SECRET|TOKEN|PASS|PASSWORD|AUTH|_API$|_JSON$|_LOGIN$|_USER$|_URL$|_HOST$|_SUBDOMAIN$|_ID$|_IDS$)/;
const EXTRA_KEYS = ['PROD_ADMIN_URL', 'PROD_ADMIN_PASSWORD', 'WEBSITE_MAKER_API_KEY', 'WEBSITEMAKER_API_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY'];
const CLIENT_ID = 'sc-seo-boot-1';
const RUN_ID = 'run-seo-boot-1';
// Owned by sales rep A (by username) and assigned to developers during the test. The second one has a
// Maker run, so each new assignment starts a handoff (the boot assigns both to Admin first).
const OWNED_ID = 'sc-seo-boot-2';
const HANDOFF_ID = 'sc-seo-boot-3';

function bootEnv({ dataDir, home, port }) {
  const env = {};
  for (const key of new Set([...PRODUCTION_ENV_KEYS.filter((key) => CREDENTIAL_KEY.test(key)), ...EXTRA_KEYS])) env[key] = '';
  return {
    ...env,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot || '',
    TEMP: process.env.TEMP || tmpdir(),
    TMP: process.env.TMP || tmpdir(),
    HOME: home,
    USERPROFILE: home,
    APP_DATA_DIR: dataDir,
    PORT: String(port),
    PERSIST_PRODUCTION_ENV: '0',
    SALES_EMAIL_AUTOSEND: '0',
    MYPHONER_WEBHOOK_RECONCILE_ENABLED: '0',
    MYPHONER_SSU_WINS_SYNC_ENABLED: '0',
    MYPHONER_RECORDING_DOWNLOAD_ENABLED: '0',
    HUB_SAFE_MODE: '1',
    WEBSITE_MAKER_LOCAL_URL: 'http://127.0.0.1:9',
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(check, { timeoutMs = 90_000, stepMs = 150, what = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function bootHub(t, { seed = null } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-record-boot-'));
  const home = mkdtempSync(join(tmpdir(), 'asoldi-seo-record-home-'));
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-record-cwd-'));
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([
    { id: CLIENT_ID, businessName: 'Eksempel Rørlegger AS', industry: 'Rørlegger', product: 'asoldi', makerRun: { runId: RUN_ID } },
    { id: OWNED_ID, businessName: 'Eksempel Baderom AS', industry: 'Baderom', product: 'asoldi', ownerId: 'sales:rep-a@example.com' },
    { id: HANDOFF_ID, businessName: 'Eksempel Maler AS', industry: 'Maler', product: 'asoldi', ownerId: 'sales:rep-a@example.com', makerRun: { runId: 'run-seo-boot-3' } },
  ]));
  if (seed) seed(dataDir);
  const port = await freePort();
  let logs = '';
  const child = spawn(process.execPath, ['--import', egressGuard, serverPath], {
    cwd: runDir,
    env: bootEnv({ dataDir, home, port }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const dir of [dataDir, home, runDir]) rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => logs.includes('Server running on port'), { what: 'server start' });
  const passwordFile = join(dataDir, 'secrets', 'initial-admin-password');
  await waitFor(() => existsSync(passwordFile) && existsSync(join(dataDir, 'admin.json')), { what: 'initial admin' });
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'asoldi.com', password: readFileSync(passwordFile, 'utf8').trim() }),
  });
  assert.equal(login.status, 200);
  const adminToken = (await login.json()).token;
  const admin = (more = {}) => ({ authorization: `Bearer ${adminToken}`, ...more });
  const legacy = (await (await fetch(`${base}/api/admin/system/maker-callback-token`, { headers: admin() })).json()).token;
  assert.ok(legacy);
  return { base, dataDir, admin, adminToken, legacy, logs: () => logs };
}

const summary = (builtAt) => ({
  planVersion: 1,
  builtAt,
  town: 'Eksempelby',
  counts: { primary: 1, candidates: 12 },
  primaries: [{ phrase: 'rørlegger eksempelby', volume: 210, intent: 'commercial' }],
  candidates: [{ phrase: 'rørlegger eksempelby', volume: 210 }, { phrase: 'akutt rørlegger', volume: 70 }],
  brand: [],
});

async function json(response) {
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

test('real hub: SEO record ingest, admin routes and the Maker read switch', { timeout: 240_000 }, async (t) => {
  const hub = await bootHub(t);
  const { base, dataDir, admin, legacy } = hub;
  const maker = (more = {}) => ({ 'content-type': 'application/json', 'x-sales-callback-token': legacy, ...more });
  const recordFile = join(dataDir, 'seo-ops', 'clients', `${CLIENT_ID}.json`);
  try {
    // 1. A push without a summary answers exactly as before: the old message, no SEO fields, no file.
    const plain = await json(await fetch(`${base}/api/internal/maker/client-bundle`, {
      method: 'POST',
      headers: maker(),
      body: JSON.stringify({ salesClientId: CLIENT_ID, bundle: { id: 'b-1', data: { businessName: 'Eksempel Rørlegger AS' } } }),
    }));
    assert.equal(plain.status, 404);
    assert.deepEqual(Object.keys(plain.body), ['message']);
    assert.equal(existsSync(recordFile), false);

    // 2. The internal route records a summary for a client without a portal user (the portal sync still 404s).
    const internal = await json(await fetch(`${base}/api/internal/maker/client-bundle`, {
      method: 'POST',
      headers: maker(),
      body: JSON.stringify({ salesClientId: CLIENT_ID, bundle: { id: 'b-1', data: {}, keywordPlanSummary: summary('2026-10-30T10:00:00.000Z') } }),
    }));
    assert.equal(internal.status, 404);
    assert.deepEqual(internal.body, { message: plain.body.message, seoRecorded: true });
    assert.equal(existsSync(recordFile), true);

    // 3. The status-callback route does the same.
    const callback = await json(await fetch(`${base}/api/admin/sales/maker-status-callback`, {
      method: 'POST',
      headers: maker(),
      body: JSON.stringify({ event: 'run.client-bundle.updated', runId: RUN_ID, salesClientId: CLIENT_ID, bundle: { id: 'b-1', data: {}, keywordPlanSummary: summary('2026-10-31T10:00:00.000Z') } }),
    }));
    assert.equal(callback.status, 404);
    assert.equal(callback.body.seoRecorded, true);
    const unknown = await json(await fetch(`${base}/api/internal/maker/client-bundle`, {
      method: 'POST',
      headers: maker(),
      body: JSON.stringify({ salesClientId: 'sc-unknown', bundle: { keywordPlanSummary: summary('2026-10-31T10:00:00.000Z') } }),
    }));
    assert.deepEqual({ seoRecorded: unknown.body.seoRecorded, seoReason: unknown.body.seoReason }, { seoRecorded: false, seoReason: 'unknown-sales-client' });

    // 4. Staff read the record; nobody else does.
    assert.equal((await fetch(`${base}/api/admin/sales-clients/${CLIENT_ID}/seo`)).status, 401);
    const read = await json(await fetch(`${base}/api/admin/sales-clients/${CLIENT_ID}/seo`, { headers: admin() }));
    assert.equal(read.status, 200);
    assert.equal(read.body.seoRecorded, true);
    assert.equal(read.body.record.planSummary.builtAt, '2026-10-31T10:00:00.000Z');
    assert.deepEqual(read.body.record.planSummary.candidates.map((row) => row.phrase), ['rørlegger eksempelby', 'akutt rørlegger']);
    assert.equal(read.body.record.contractText, null);
    assert.equal((await fetch(`${base}/api/admin/sales-clients/sc-unknown/seo`, { headers: admin() })).status, 404);

    // 5. Approve, block, PUT and the limits.
    const post = (path, body) => fetch(`${base}/api/admin/sales-clients/${CLIENT_ID}/seo/${path}`, { method: 'POST', headers: admin({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
    assert.equal((await fetch(`${base}/api/admin/sales-clients/${CLIENT_ID}/seo/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phrase":"x"}' })).status, 401);
    const approved = await json(await post('approve', { phrase: 'rørlegger eksempelby', source: 'plan' }));
    assert.equal(approved.status, 200);
    assert.equal(approved.body.seoRecorded, true);
    assert.deepEqual(approved.body.record.agreedKeywords.map((row) => [row.phrase, row.status, row.source]), [['rørlegger eksempelby', 'approved', 'plan']]);
    assert.equal(approved.body.record.contractText, 'Avtalte søkeord: rørlegger eksempelby');
    const blocked = await json(await post('block', { phrase: 'akutt rørlegger', reason: 'not offered' }));
    assert.equal(blocked.status, 200);
    assert.deepEqual(blocked.body.record.agreedKeywords.map((row) => row.status), ['approved', 'blocked']);
    const regulated = await json(await post('approve', { phrase: 'melatonin eksempelby' }));
    assert.equal(regulated.status, 400);
    assert.equal(regulated.body.code, 'regulated');
    const put = (agreedKeywords) => fetch(`${base}/api/admin/sales-clients/${CLIENT_ID}/seo`, { method: 'PUT', headers: admin({ 'content-type': 'application/json' }), body: JSON.stringify({ agreedKeywords }) });
    const four = await json(await put(['a b', 'c d', 'e f', 'g h'].map((phrase) => ({ phrase, status: 'approved' }))));
    assert.equal(four.status, 400);
    assert.equal(four.body.code, 'too-many-approved');
    const replaced = await json(await put([{ phrase: 'rørlegger eksempelby', status: 'approved' }, { phrase: 'baderom eksempelby', status: 'proposed', source: 'sales' }]));
    assert.equal(replaced.status, 200);
    assert.deepEqual(replaced.body.record.agreedKeywords.map((row) => [row.phrase, row.status]), [['rørlegger eksempelby', 'approved'], ['baderom eksempelby', 'proposed']]);

    // 6. A new push keeps the agreed keywords.
    await fetch(`${base}/api/internal/maker/client-bundle`, {
      method: 'POST',
      headers: maker(),
      body: JSON.stringify({ salesClientId: CLIENT_ID, bundle: { keywordPlanSummary: summary('2026-11-01T10:00:00.000Z') } }),
    });
    const after = await json(await fetch(`${base}/api/admin/sales-clients/${CLIENT_ID}/seo`, { headers: admin() }));
    assert.equal(after.body.record.planSummary.builtAt, '2026-11-01T10:00:00.000Z');
    assert.equal(after.body.record.agreedKeywords.length, 2);

    // 7. The Maker read is 404 {code:'disabled'} for everyone while seo.recordPull is off.
    const pull = (headers = {}) => fetch(`${base}/api/internal/maker/seo-record?salesClientId=${CLIENT_ID}`, { headers });
    for (const headers of [{}, { 'x-sales-callback-token': legacy }]) {
      const off = await json(await pull(headers));
      assert.equal(off.status, 404);
      assert.equal(off.body.code, 'disabled');
    }
    const on = await fetch(`${base}/api/admin/automation-settings`, {
      method: 'PUT',
      headers: admin({ 'content-type': 'application/json' }),
      body: JSON.stringify({ seo: { recordPull: { enabled: true } } }),
    });
    assert.equal(on.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await pull()).status, 401, 'with the switch on the Maker credential is required');
    const pulled = await json(await pull({ 'x-sales-callback-token': legacy }));
    assert.equal(pulled.status, 200);
    assert.equal(pulled.body.seoRecorded, true);
    assert.deepEqual(pulled.body.record.agreedKeywords, [{ phrase: 'rørlegger eksempelby', status: 'approved', source: 'plan' }]);
  } catch (error) {
    console.error(hub.logs().slice(-4000));
    throw error;
  }
});

test('real hub negative controls: sales reps read only their own clients, developers change only the clients they work on', { timeout: 240_000 }, async (t) => {
  const hub = await bootHub(t);
  const { base, dataDir, admin } = hub;
  const recordFile = join(dataDir, 'seo-ops', 'clients', `${OWNED_ID}.json`);
  const sendTo = (id) => (method, path, token, body) => fetch(`${base}/api/admin/sales-clients/${id}/seo${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const send = sendTo(OWNED_ID);
  const sendHandoff = sendTo(HANDOFF_ID);
  const writes = (token, to = send) => [
    to('PUT', '', token, { agreedKeywords: [{ phrase: 'flis eksempelby', status: 'approved' }] }),
    to('POST', '/approve', token, { phrase: 'flis eksempelby' }),
    to('POST', '/block', token, { phrase: 'flis eksempelby' }),
  ];
  const statuses = async (calls) => (await Promise.all(calls)).map((response) => response.status);
  try {
    // Staff users: two sales reps and three developers.
    const users = {};
    const password = `staff-${Date.now()}-pw`;
    for (const [key, username, role, phone] of [
      ['repA', 'rep-a@example.com', 'sales', '+47 900 00 001'],
      ['repB', 'rep-b@example.com', 'sales', '+47 900 00 002'],
      ['devA', 'dev-a@example.com', 'developer'],
      ['devB', 'dev-b@example.com', 'developer'],
      ['devC', 'dev-c@example.com', 'developer'],
    ]) {
      const created = await fetch(`${base}/api/admin/users`, { method: 'POST', headers: admin({ 'content-type': 'application/json' }), body: JSON.stringify({ username, password, role, ...(phone ? { phone } : {}) }) });
      assert.equal(created.status, 201, await created.clone().text());
      const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      assert.equal(login.status, 200);
      users[key] = { id: (await created.json()).id, token: (await login.json()).token };
    }
    const assign = async (id, key) => {
      const response = await fetch(`${base}/api/admin/development/sales:${id}/assign`, { method: 'POST', headers: admin({ 'content-type': 'application/json' }), body: JSON.stringify({ developerOwnerId: `developer:${users[key].id}` }) });
      const answer = await json(response);
      assert.equal(answer.status, 200, answer.text);
      return answer.body.client;
    };
    // No Maker run: the assignment takes effect at once.
    assert.equal((await assign(OWNED_ID, 'devA')).developerHandoff?.status || '', '');

    // Sales: the owning rep reads; another rep gets 403 as on the other sales-client routes; no rep writes.
    assert.equal((await send('GET', '', users.repA.token)).status, 200);
    const other = await json(await send('GET', '', users.repB.token));
    assert.deepEqual([other.status, other.body], [403, { message: 'Not your sales client.' }]);
    assert.deepEqual(await statuses(writes(users.repA.token)), [401, 401, 401]);

    // Developers: the assigned one reads and approves; an unassigned one gets 404 for every call.
    assert.equal((await send('GET', '', users.devA.token)).status, 200);
    const approved = await json(await send('POST', '/approve', users.devA.token, { phrase: 'baderom eksempelby' }));
    assert.equal(approved.status, 200);
    const stored = readFileSync(recordFile, 'utf8');
    assert.equal((await send('GET', '', users.devC.token)).status, 404);
    assert.deepEqual(await statuses(writes(users.devC.token)), [404, 404, 404]);

    // The own name needs a confirmation on the route too.
    const brand = await json(await send('POST', '/approve', users.devA.token, { phrase: 'Eksempel Baderom' }));
    assert.deepEqual([brand.status, brand.body.code], [400, 'brand']);
    assert.equal(readFileSync(recordFile, 'utf8'), stored, 'refused calls write nothing');

    // With a Maker run every reassignment is a handoff: the developer it goes to (and the one it comes
    // from) still see the client, and nobody but an admin changes keywords until it is accepted.
    assert.equal((await assign(HANDOFF_ID, 'devA')).developerHandoff.status, 'waiting-upload');
    assert.equal((await sendHandoff('GET', '', users.devA.token)).status, 200);
    assert.deepEqual(await statuses(writes(users.devA.token, sendHandoff)), [403, 403, 403]);
    const handoff = await assign(HANDOFF_ID, 'devB');
    assert.deepEqual([handoff.developerHandoff.status, handoff.developerHandoff.fromOwnerId], ['waiting-upload', `developer:${users.devA.id}`]);
    for (const key of ['devA', 'devB']) {
      assert.equal((await sendHandoff('GET', '', users[key].token)).status, 200, key);
      const refused = await json(await sendHandoff('POST', '/approve', users[key].token, { phrase: 'maler eksempelby' }));
      assert.deepEqual([refused.status, refused.body.message], [403, 'Prosjektet er tildelt en annen utvikler.'], key);
      assert.deepEqual(await statuses(writes(users[key].token, sendHandoff)), [403, 403, 403], key);
    }
    assert.equal((await sendHandoff('GET', '', users.devC.token)).status, 404);
    assert.equal(existsSync(join(dataDir, 'seo-ops', 'clients', `${HANDOFF_ID}.json`)), false, 'refused calls write nothing');
    assert.equal((await sendHandoff('POST', '/approve', hub.adminToken, { phrase: 'maler eksempelby' })).status, 200);

    // Reassigned without a run: developer A no longer sees the client, B works on it.
    await assign(OWNED_ID, 'devB');
    assert.equal((await send('GET', '', users.devA.token)).status, 404);
    assert.deepEqual(await statuses(writes(users.devA.token)), [404, 404, 404]);
    assert.equal(readFileSync(recordFile, 'utf8'), stored, 'refused calls write nothing');
    assert.equal((await send('POST', '/block', users.devB.token, { phrase: 'akutt baderom' })).status, 200);

    // Admin changes it, and confirms the own name.
    const confirmed = await json(await send('POST', '/approve', hub.adminToken, { phrase: 'Eksempel Baderom', allowBrand: true }));
    assert.equal(confirmed.status, 200);
    assert.deepEqual(confirmed.body.record.agreedKeywords.map((row) => [row.phrase, row.status, row.flags || []]), [
      ['baderom eksempelby', 'approved', []],
      ['akutt baderom', 'blocked', []],
      ['Eksempel Baderom', 'approved', ['brand']],
    ]);
    assert.equal(confirmed.body.record.contractText, 'Avtalte søkeord: baderom eksempelby, Eksempel Baderom');
  } catch (error) {
    console.error(hub.logs().slice(-4000));
    throw error;
  }
});

test("real hub negative control: a portal bank naming another business's sales client gets none of its keywords in the site config", { timeout: 240_000 }, async (t) => {
  const LINKED_ID = 'sc-seo-boot-4';
  const site = (id, name, domain) => ({
    id,
    site_key: `key-${id}`,
    name,
    domain,
    websitePlan: 'tier-2-seo',
    features: { users: true, analytics: true, ecommerce: false, blog: true, socialSync: false, emailMarketing: false, general: true },
  });
  // Both portal banks name the same sales client; the hub links it to the first business only (as a
  // Maker bundle push does). A portal client can write that id into its own bank.
  const profile = (n, name, domain, phrase) => ({
    businessId: `biz-${n}`,
    userId: `user-${n}`,
    ownerUserId: `user-${n}`,
    email: `post-${n}@example.com`,
    businessName: name,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    clientDataBank: {
      generalInfo: { companyName: name, websiteUrl: `https://${domain}/` },
      websiteCreatorQuestions: { town: 'Eksempelby' },
      seo: { keywordPlan: { primary: [{ keyword: phrase }] } },
      makerLink: { salesClientId: LINKED_ID },
    },
  });
  const hub = await bootHub(t, {
    seed(dataDir) {
      const file = join(dataDir, 'sales-clients.json');
      const clients = JSON.parse(readFileSync(file, 'utf8'));
      clients.push({ id: LINKED_ID, businessName: 'Eksempel Flytting AS', product: 'asoldi', portalUserId: 'user-own', portalBusinessId: 'biz-own' });
      writeFileSync(file, JSON.stringify(clients));
      writeFileSync(join(dataDir, 'sites.json'), JSON.stringify([
        site('own', 'Eksempel Flytting AS', 'flytting.example.com'),
        site('other', 'Annen Bedrift AS', 'annen.example.com'),
      ]));
      writeFileSync(join(dataDir, 'client-portal-profiles.json'), JSON.stringify([
        profile('own', 'Eksempel Flytting AS', 'flytting.example.com', 'flytting eksempelby'),
        profile('other', 'Annen Bedrift AS', 'annen.example.com', 'regnskap eksempelby'),
      ]));
    },
  });
  const { base, admin } = hub;
  const goals = async (key) => {
    const answer = await json(await fetch(`${base}/api/hub/site-config?site_key=${key}`));
    assert.equal(answer.status, 200, answer.text);
    return answer.body.analyticsGoals;
  };
  try {
    const before = { own: await goals('key-own'), other: await goals('key-other') };
    assert.deepEqual(before.own.mapsKeywords, ['flytting eksempelby']);
    assert.deepEqual(before.other.mapsKeywords, ['regnskap eksempelby']);
    const approved = await fetch(`${base}/api/admin/sales-clients/${LINKED_ID}/seo/approve`, {
      method: 'POST',
      headers: admin({ 'content-type': 'application/json' }),
      body: JSON.stringify({ phrase: 'pianoflytting eksempelby' }),
    });
    assert.equal(approved.status, 200);
    const after = { own: await goals('key-own'), other: await goals('key-other') };
    assert.deepEqual(after.own.mapsKeywords, ['pianoflytting eksempelby', 'flytting eksempelby'], 'the linked business tracks the approved keyword first');
    assert.deepEqual(after.other, before.other, 'the other business gets exactly its own goals, as without a record');
  } catch (error) {
    console.error(hub.logs().slice(-4000));
    throw error;
  }
});
