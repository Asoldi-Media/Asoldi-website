// Boots the real hub (server.js) on a random local port with a throwaway data dir, no real
// credentials, safe mode on and loopback-only egress, then checks the SEO record over HTTP:
// both bundle ingest routes record the plan summary without a portal user, a push without a summary
// answers exactly as before, the admin routes round-trip agreed keywords, and the Maker read stays
// 404 {code:'disabled'} until seo.recordPull is switched on.
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

async function bootHub(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-record-boot-'));
  const home = mkdtempSync(join(tmpdir(), 'asoldi-seo-record-home-'));
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-record-cwd-'));
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([
    { id: CLIENT_ID, businessName: 'Eksempel Rørlegger AS', industry: 'Rørlegger', product: 'asoldi', makerRun: { runId: RUN_ID } },
  ]));
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
  return { base, dataDir, admin, legacy, logs: () => logs };
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
