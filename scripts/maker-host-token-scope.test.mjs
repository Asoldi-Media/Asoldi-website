// Boots the real hub (server.js) on a random local port in safe mode with a throwaway data dir and no real
// credentials, then checks the Maker host token read scope over HTTP: GET /api/admin/sales and
// GET /api/admin/sales/:id/preview-files accept a host token holding the sales-read scope; every other
// admin route keeps refusing it, and a request without a host token answers as it always did.
//
// Run: node --test scripts/maker-host-token-scope.test.mjs
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

function bootEnv({ dataDir, home, port, extra = {} }) {
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
    ...extra,
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

async function waitFor(check, { timeoutMs = 60_000, stepMs = 150, what = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Boots server.js; returns { base, dataDir, logs(), admin headers helper }. */
async function bootHub(t, { extraEnv = {}, seed = null } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-host-scope-'));
  const home = mkdtempSync(join(tmpdir(), 'asoldi-host-scope-home-'));
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-host-scope-cwd-'));
  if (seed) seed(dataDir);
  const port = await freePort();
  let logs = '';
  const child = spawn(process.execPath, ['--import', egressGuard, serverPath], {
    cwd: runDir,
    env: bootEnv({ dataDir, home, port, extra: extraEnv }),
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
  return {
    base,
    dataDir,
    logs: () => logs,
    admin: (more = {}) => ({ authorization: `Bearer ${adminToken}`, ...more }),
  };
}

const CLIENT_ID = 'sc-scope-0001';

function seedSalesClient(dataDir) {
  writeFileSync(
    join(dataDir, 'sales-clients.json'),
    JSON.stringify([{ id: CLIENT_ID, businessName: 'Scope Testbedrift', industry: 'Kafe', product: 'asoldi', makerRun: { runId: 'run-scope-0001' } }])
  );
}

async function createHost(hub, scopes) {
  const created = await fetch(`${hub.base}/api/admin/maker-hosts`, {
    method: 'POST',
    headers: hub.admin({ 'content-type': 'application/json' }),
    body: JSON.stringify(scopes ? { label: 'Scope test Maker', scopes } : { label: 'Scope test Maker' }),
  });
  assert.equal(created.status, 201);
  return created.json();
}

test('real hub: a host token with sales-read reads the two sales routes and nothing else', { timeout: 180_000 }, async (t) => {
  const hub = await bootHub(t, { seed: seedSalesClient });
  const { base } = hub;
  const { token } = await createHost(hub);
  const asHost = { 'x-maker-host-token': token };

  // The list: client rows only, no calendar, sender or owner list.
  const list = await fetch(`${base}/api/admin/sales`, { headers: asHost });
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.clients.length, 1);
  assert.equal(listBody.clients[0].makerRun.runId, 'run-scope-0001');
  assert.equal(listBody.isAdmin, false);
  for (const field of ['calendar', 'sender', 'owners', 'inboxPendingContracts']) assert.equal(field in listBody, false, field);

  // The product filter still applies.
  const none = await (await fetch(`${base}/api/admin/sales?product=ssu`, { headers: asHost })).json();
  assert.equal(none.clients.length, 0);

  const files = await fetch(`${base}/api/admin/sales/${CLIENT_ID}/preview-files`, { headers: asHost });
  assert.equal(files.status, 200);
  assert.equal((await files.json()).ok, true);
  assert.equal((await fetch(`${base}/api/admin/sales/sc-missing/preview-files`, { headers: asHost })).status, 404);

  // Every other admin route refuses the token.
  for (const [method, path] of [
    ['GET', '/api/admin/sales/offers'],
    ['GET', '/api/admin/sales/client-search'],
    ['GET', `/api/admin/sales/${CLIENT_ID}`],
    ['GET', '/api/admin/maker-hosts'],
    ['POST', '/api/admin/sales'],
    ['POST', `/api/admin/sales/${CLIENT_ID}/preview-files`],
    ['POST', '/api/admin/sales/preview-send-emails'],
  ]) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...asHost }, body: method === 'POST' ? '{}' : undefined });
    assert.ok([401, 403, 404, 405].includes(res.status) && res.status !== 200, `${method} ${path} answered ${res.status}`);
    assert.notEqual(res.status, 200, `${method} ${path}`);
  }
  assert.equal((await fetch(`${base}/api/admin/maker-hosts`, { headers: asHost })).status, 401);
  assert.equal((await fetch(`${base}/api/admin/sales/offers`, { headers: asHost })).status, 401);

  // A host without the scope gets 403; the legacy callback token alone is not enough.
  const narrow = await createHost(hub, ['callback']);
  const refused = await fetch(`${base}/api/admin/sales`, { headers: { 'x-maker-host-token': narrow.token } });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'maker-scope');
  const legacy = (await (await fetch(`${base}/api/admin/system/maker-callback-token`, { headers: hub.admin() })).json()).token;
  assert.equal((await fetch(`${base}/api/admin/sales`, { headers: { 'x-sales-callback-token': legacy } })).status, 401);
  assert.equal((await fetch(`${base}/api/admin/sales/${CLIENT_ID}/preview-files`, { headers: { 'x-sales-callback-token': legacy } })).status, 401);

  // A wrong host token and a revoked one are refused.
  const wrong = `${token.slice(0, -4)}AAAA`;
  assert.equal((await fetch(`${base}/api/admin/sales`, { headers: { 'x-maker-host-token': wrong } })).status, 401);
  const { hostId } = await createHost(hub);
  assert.equal((await fetch(`${base}/api/admin/maker-hosts/${hostId}`, { method: 'DELETE', headers: hub.admin() })).status, 200);
});

test('real hub: without a host token both routes answer as they always did', { timeout: 180_000 }, async (t) => {
  const hub = await bootHub(t, { seed: seedSalesClient });
  const { base } = hub;
  assert.equal((await fetch(`${base}/api/admin/sales`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/sales/${CLIENT_ID}/preview-files`)).status, 401);
  const admin = await fetch(`${base}/api/admin/sales`, { headers: hub.admin() });
  assert.equal(admin.status, 200);
  const body = await admin.json();
  assert.equal(body.isAdmin, true);
  assert.ok('calendar' in body && 'sender' in body && Array.isArray(body.owners), 'the staff answer keeps its full shape');
  assert.equal((await fetch(`${base}/api/admin/sales/${CLIENT_ID}/preview-files`, { headers: hub.admin() })).status, 200);
  // A staff Bearer beside a bad host token still takes the staff path.
  const both = await fetch(`${base}/api/admin/sales`, { headers: hub.admin({ 'x-maker-host-token': 'mkr_00000000_not-a-real-token' }) });
  assert.equal(both.status, 200);
});

