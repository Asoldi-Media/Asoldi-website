// Boots the real hub (server.js) on a random local port with a throwaway data dir and no real
// credentials, then checks Maker host tokens over HTTP (WS0.4, WS8.25). Same isolation as
// scripts/security-boot.test.mjs: empty child cwd (no .env), every credential-like env key
// blanked, safe mode on, and scripts/security/loopback-only-egress.mjs preloaded so nothing but
// 127.0.0.1 can be reached.
//
// Run: node --test scripts/maker-hosts-boot.test.mjs
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
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-maker-hosts-boot-'));
  const home = mkdtempSync(join(tmpdir(), 'asoldi-maker-hosts-home-'));
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-maker-hosts-cwd-'));
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

const RUN_ID = 'run-boot-0001';
const CLIENT_ID = 'sc-boot-0001';

function seedSalesClient(dataDir) {
  writeFileSync(
    join(dataDir, 'sales-clients.json'),
    JSON.stringify([{ id: CLIENT_ID, businessName: 'Boot Testbedrift', industry: 'Kafe', product: 'asoldi', makerRun: { runId: RUN_ID } }])
  );
}

function fieldsCallback(base, headers) {
  return fetch(`${base}/api/admin/sales/maker-status-callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ event: 'run.fields.updated', runId: RUN_ID, salesClientId: CLIENT_ID, fields: { businessName: 'Boot Testbedrift Oppdatert' } }),
  });
}

test('real hub: per-host tokens on Maker callbacks, revoke, legacy disk token, heartbeat, counters', { timeout: 180_000 }, async (t) => {
  const hub = await bootHub(t, { seed: seedSalesClient });
  const { base, dataDir } = hub;
  try {
    // No hosts yet; the list works and carries no secrets.
    const empty = await (await fetch(`${base}/api/admin/maker-hosts`, { headers: hub.admin() })).json();
    assert.deepEqual(empty.hosts, []);
    assert.equal(empty.legacyTokenSource, 'disk');
    assert.equal((await fetch(`${base}/api/admin/maker-hosts`)).status, 401, 'admin only');

    // 1. A callback without a header gets 401.
    assert.equal((await fieldsCallback(base, {})).status, 401);
    assert.equal((await fetch(`${base}/api/admin/sales/maker-status-callback`)).status, 401);

    // 2. A valid host token gets 200 and stamps lastSeenAt.
    const created = await fetch(`${base}/api/admin/maker-hosts`, {
      method: 'POST',
      headers: hub.admin({ 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Boot test Maker' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const { hostId, token } = await created.json();
    const ok = await fieldsCallback(base, { 'x-maker-host-token': token });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.fieldsApplied, true);
    assert.equal(okBody.client.businessName, 'Boot Testbedrift Oppdatert');
    const hostsText = readFileSync(join(dataDir, 'maker-hosts.json'), 'utf8');
    assert.equal(hostsText.includes(token), false, 'only the sha256 is stored');
    const stored = JSON.parse(hostsText).hosts.find((row) => row.hostId === hostId);
    assert.ok(stored.lastSeenAt, 'lastSeenAt stamped');
    assert.match(stored.tokenHash, /^sha256:[0-9a-f]{64}$/);

    // 3. The legacy disk token keeps working (the running Maker and old runs use it).
    const legacy = (await (await fetch(`${base}/api/admin/system/maker-callback-token`, { headers: hub.admin() })).json()).token;
    assert.ok(legacy);
    assert.equal((await fetch(`${base}/api/admin/sales/maker-status-callback`, { headers: { 'x-sales-callback-token': legacy } })).status, 200);
    const bundle = await fetch(`${base}/api/internal/maker/client-bundle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-maker-host-token': token },
      body: JSON.stringify({}),
    });
    assert.notEqual(bundle.status, 401, 'the client-bundle scope is granted by default');
    assert.notEqual(bundle.status, 403);

    // 4. WS8.25 heartbeat: stores the routing fields once; an unchanged heartbeat writes nothing.
    const beat = (body) => fetch(`${base}/api/maker/hosts/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-maker-host-token': token },
      body: JSON.stringify(body),
    });
    const beatBody = { runIds: [RUN_ID], capabilities: { handlers: ['continue', 'publish'] }, version: 'maker@boot', makerPort: 3000 };
    const first = await beat(beatBody);
    assert.equal(first.status, 200);
    const firstAnswer = await first.json();
    assert.equal(firstAnswer.changed, true);
    assert.equal(firstAnswer.pollAfterMs, 30000);
    const afterFirst = readFileSync(join(dataDir, 'maker-hosts.json'), 'utf8');
    assert.equal((await (await beat(beatBody)).json()).changed, false);
    assert.equal(readFileSync(join(dataDir, 'maker-hosts.json'), 'utf8'), afterFirst, 'unchanged heartbeat wrote nothing');
    assert.equal((await fetch(`${base}/api/maker/hosts/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sales-callback-token': legacy },
      body: '{}',
    })).status, 403, 'heartbeats need a host identity');
    const listed = await (await fetch(`${base}/api/admin/maker-hosts`, { headers: hub.admin() })).json();
    const row = listed.hosts.find((host) => host.hostId === hostId);
    assert.deepEqual(row.capabilities.handlers, ['continue', 'publish']);
    assert.equal(row.version, 'maker@boot');
    assert.ok(row.lastHeartbeatAt);
    assert.equal(JSON.stringify(listed).includes(token), false);

    // 5. A revoked token gets 401.
    const revoke = await fetch(`${base}/api/admin/maker-hosts/${hostId}`, { method: 'DELETE', headers: hub.admin() });
    assert.equal(revoke.status, 200);
    assert.equal((await fieldsCallback(base, { 'x-maker-host-token': token })).status, 401);
    assert.equal((await fieldsCallback(base, { 'x-sales-callback-token': token })).status, 401, 'also in the legacy header');

    // 6. Counters: in memory under the existing names, and persisted without any token.
    const security = await (await fetch(`${base}/api/admin/system/security`, { headers: hub.admin() })).json();
    assert.ok(security.counters['maker-callback-missing-token'].total >= 2);
    assert.ok(security.counters['maker-callback-rejected'].total >= 2);
    const settingsText = readFileSync(join(dataDir, 'security-settings.json'), 'utf8');
    assert.ok(JSON.parse(settingsText).counters.makerRejected.total >= 1, 'the first refusal is saved at once');
    assert.equal(settingsText.includes(token), false);

    const blocked = hub.logs().split(/\r?\n/).filter((line) => line.startsWith('[egress-guard] blocked'));
    assert.deepEqual(blocked, [], 'the hub tried to reach a non-loopback host');
  } catch (error) {
    console.error(hub.logs().split(/\r?\n/).slice(-60).join('\n'));
    throw error;
  }
});

test('real hub: an env callback token, when set, still works beside host tokens', { timeout: 180_000 }, async (t) => {
  const envToken = `env-callback-${Date.now().toString(36)}-value`;
  const hub = await bootHub(t, { extraEnv: { WEBSITE_MAKER_STATUS_CALLBACK_TOKEN: envToken }, seed: seedSalesClient });
  try {
    const status = (headers) => fetch(`${hub.base}/api/admin/sales/maker-status-callback`, { headers }).then((res) => res.status);
    assert.equal(await status({}), 401);
    assert.equal(await status({ 'x-sales-callback-token': envToken }), 200);
    assert.equal(await status({ 'x-sales-callback-token': `${envToken}x` }), 401);
    const made = await (await fetch(`${hub.base}/api/admin/maker-hosts`, {
      method: 'POST',
      headers: hub.admin({ 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Env hub Maker', scopes: ['callback'] }),
    })).json();
    assert.equal(await status({ 'x-maker-host-token': made.token }), 200);
    assert.equal((await fieldsCallback(hub.base, { 'x-maker-host-token': made.token, 'x-sales-callback-token': envToken })).status, 200);
    const listed = await (await fetch(`${hub.base}/api/admin/maker-hosts`, { headers: hub.admin() })).json();
    assert.equal(listed.legacyTokenSource, 'env');
  } catch (error) {
    console.error(hub.logs().split(/\r?\n/).slice(-60).join('\n'));
    throw error;
  }
});
