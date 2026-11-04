// Boots the real hub (server.js) with a throwaway data dir, safe mode on, no credentials and a
// loopback-only egress guard, and checks the brief routes end to end: dark by default (404
// brief-disabled, nothing written), then shadow after a settings change (the board builds and reads
// a brief; the Maker still gets 404), and that a PUT cannot set auto without pilots.
//
// Run: node --test scripts/delivery-brief-boot.test.mjs
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
const EXTRA_KEYS = ['PROD_ADMIN_URL', 'PROD_ADMIN_PASSWORD', 'WEBSITE_MAKER_API_KEY', 'WEBSITEMAKER_API_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'AI_PROFILE'];

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

// A merged hub can take well over a minute to start when other test processes share the machine;
// BRIEF_BOOT_WAIT_MS (optional) changes how long the server start may take.
const BOOT_WAIT_MS = Number(process.env.BRIEF_BOOT_WAIT_MS) > 0 ? Number(process.env.BRIEF_BOOT_WAIT_MS) : 240_000;

async function waitFor(check, { timeoutMs = 90_000, stepMs = 150, what = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const CLIENT_ID = 'syn-brief-boot';
const RUN_ID = 'run-brief-boot';

function seed(dataDir) {
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([{
    id: CLIENT_ID,
    businessName: 'Eksempel Boot AS',
    industry: 'Bad',
    product: 'asoldi',
    makerRun: { runId: RUN_ID },
    sitePlan: { status: 'active', tierId: 'tier-1-standard', services: ['site', 'changes', 'blog'], pages: 5, billing: 'month', signedAt: '2026-10-02T10:00:00.000Z' },
  }]));
}

test('real hub: brief routes are dark by default, then shadow after the switch is turned on', { timeout: BOOT_WAIT_MS + 180_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-brief-boot-'));
  const home = mkdtempSync(join(tmpdir(), 'asoldi-brief-boot-home-'));
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-brief-boot-cwd-'));
  seed(dataDir);
  const port = await freePort();
  let logs = '';
  const child = spawn(process.execPath, ['--import', egressGuard, serverPath], { cwd: runDir, env: bootEnv({ dataDir, home, port }), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const dir of [dataDir, home, runDir]) rmSync(dir, { recursive: true, force: true });
  });
  try {
    await waitFor(() => logs.includes('Server running on port'), { timeoutMs: BOOT_WAIT_MS, what: 'server start' });
    const passwordFile = join(dataDir, 'secrets', 'initial-admin-password');
    await waitFor(() => existsSync(passwordFile) && existsSync(join(dataDir, 'admin.json')), { what: 'initial admin' });
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'asoldi.com', password: readFileSync(passwordFile, 'utf8').trim() }),
    });
    assert.equal(login.status, 200);
    const admin = { authorization: `Bearer ${(await login.json()).token}` };
    const json = { 'content-type': 'application/json' };

    // A host whose reported run is the client's run.
    const created = await (await fetch(`${base}/api/admin/maker-hosts`, { method: 'POST', headers: { ...admin, ...json }, body: JSON.stringify({ label: 'Boot host' }) })).json();
    const maker = { 'x-maker-host-token': created.token };
    const beat = await fetch(`${base}/api/maker/hosts/heartbeat`, { method: 'POST', headers: { ...maker, ...json }, body: JSON.stringify({ runIds: [RUN_ID] }) });
    assert.equal(beat.status, 200);

    // 1. Off (the default): 404 brief-disabled everywhere, before auth, and nothing is written.
    for (const [path, headers] of [
      [`/api/admin/development/${CLIENT_ID}/brief`, admin],
      [`/api/admin/development/${CLIENT_ID}/brief/versions`, admin],
      [`/api/maker/clients/${CLIENT_ID}/brief`, maker],
      [`/api/maker/clients/${CLIENT_ID}/brief`, {}],
      [`/api/maker/clients/${CLIENT_ID}/transcripts/${'a'.repeat(64)}`, maker],
    ]) {
      const response = await fetch(`${base}${path}`, { headers });
      assert.equal(response.status, 404, path);
      assert.equal((await response.json()).code, 'brief-disabled', path);
    }
    const rebuildOff = await fetch(`${base}/api/admin/development/${CLIENT_ID}/brief/rebuild`, { method: 'POST', headers: { ...admin, ...json }, body: '{}' });
    assert.equal(rebuildOff.status, 404);
    assert.equal(existsSync(join(dataDir, 'delivery-briefs')), false, 'no brief folder');
    assert.equal(existsSync(join(dataDir, 'maker-access-log')), false, 'no access log line');

    // 2. Auto without pilots is refused; shadow is accepted.
    const auto = await fetch(`${base}/api/admin/automation-settings`, { method: 'PUT', headers: { ...admin, ...json }, body: JSON.stringify({ brief: { enabled: true, mode: 'auto' } }) });
    assert.equal(auto.status, 400);
    const errors = (await auto.json()).errors.map((error) => error.path);
    assert.ok(errors.includes('brief.mode') && errors.includes('brief'), JSON.stringify(errors));
    const shadow = await fetch(`${base}/api/admin/automation-settings`, { method: 'PUT', headers: { ...admin, ...json }, body: JSON.stringify({ brief: { enabled: true } }) });
    assert.equal(shadow.status, 200);

    // 3. Shadow: the board builds (no meetings, so no LLM call) and reads; the Maker still gets 404.
    const none = await fetch(`${base}/api/admin/development/${CLIENT_ID}/brief`, { headers: admin });
    assert.equal(none.status, 404);
    assert.equal((await none.json()).code, 'no-brief');
    const rebuild = await fetch(`${base}/api/admin/development/${CLIENT_ID}/brief/rebuild`, { method: 'POST', headers: { ...admin, ...json }, body: JSON.stringify({ wait: true }) });
    assert.equal(rebuild.status, 200, await rebuild.clone().text());
    assert.equal((await rebuild.json()).status, 'built');
    const got = await fetch(`${base}/api/admin/development/${CLIENT_ID}/brief`, { headers: admin });
    assert.equal(got.status, 200);
    const brief = await got.json();
    assert.equal(brief.sitePlan.tierId, 'tier-1-standard');
    assert.equal(brief.facts.identity.legalName, 'Eksempel Boot AS');
    assert.ok(existsSync(join(dataDir, 'delivery-briefs', CLIENT_ID, 'v1.json')));
    const md = await fetch(`${base}/api/admin/development/${CLIENT_ID}/brief?format=md`, { headers: admin });
    assert.match(await md.text(), /Standard \(nivå 1\)/);
    const makerShadow = await fetch(`${base}/api/maker/clients/${CLIENT_ID}/brief`, { headers: maker });
    assert.equal(makerShadow.status, 404);
    assert.equal((await makerShadow.json()).code, 'brief-disabled');
    const access = await (await fetch(`${base}/api/admin/maker-hosts/access-log?clientId=${CLIENT_ID}`, { headers: admin })).json();
    assert.ok(access.rows.some((row) => row.kind === 'brief' && row.allowed === true), 'the Maker fetch is logged');
    assert.equal((await fetch(`${base}/api/maker/clients/${CLIENT_ID}/brief`)).status, 401);

    const blocked = logs.split(/\r?\n/).filter((line) => line.startsWith('[egress-guard] blocked'));
    assert.deepEqual(blocked, [], 'the hub tried to reach a non-loopback host');
  } catch (error) {
    console.error(logs.split(/\r?\n/).slice(-60).join('\n'));
    throw error;
  }
});
