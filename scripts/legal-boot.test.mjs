// The legal routes on the real hub: boots server.js in safe mode on 127.0.0.1 with a throwaway data
// dir and no credentials (empty cwd, blanked keys, loopback-only egress, as in
// scripts/cms-features-boot.test.mjs). While legal.catalogTexts is off every legal route answers
// 404 {code:'disabled'}, before any authentication; switched on from Superadmin, the texts are
// served, the client routes need a client login and the terms-update list sends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { PRODUCTION_ENV_KEYS } from '../lib/persistent-env.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverPath = join(repoRoot, 'server.js');
const egressGuard = pathToFileURL(join(repoRoot, 'scripts', 'security', 'loopback-only-egress.mjs')).href;
const CREDENTIAL_KEY = /(KEY|SECRET|TOKEN|PASS|PASSWORD|AUTH|_API$|_JSON$|_LOGIN$|_USER$|_URL$|_HOST$|_SUBDOMAIN$|_ID$|_IDS$)/;

function bootEnv({ dataDir, home, port }) {
  const env = {};
  for (const key of PRODUCTION_ENV_KEYS.filter((name) => CREDENTIAL_KEY.test(name))) env[key] = '';
  for (const key of ['BREVO_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'DATAFORSEO_AUTH',
    'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PASS', 'STRIPE_SECRET_KEY', 'HOSTINGER_API_TOKEN', 'PROD_ADMIN_PASSWORD', 'GITHUB_TOKEN']) env[key] = '';
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

test('local hub in safe mode: legal routes are 404 while dark and serve the catalog when switched on', { timeout: 180_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-legal-boot-'));
  const home = mkdtempSync(join(tmpdir(), 'asoldi-legal-home-'));
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-legal-cwd-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
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

  try {
    await waitFor(() => logs.includes('Server running on port'), { what: 'server start' });
    assert.match(logs, /\[safe-mode\] ON/);
    const json = async (path, init = {}) => {
      const res = await fetch(`${base}${path}`, init);
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, body };
    };

    // Dark: every legal route answers the same 404, with or without a login.
    for (const [path, method] of [
      ['/api/legal/texts/vilkar', 'GET'],
      ['/api/legal/texts/salg', 'GET'],
      ['/api/client/legal', 'GET'],
      ['/api/client/dpa/sign', 'POST'],
      ['/api/admin/legal/terms-update', 'GET'],
    ]) {
      const res = await json(path, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(res.status, 404, path);
      assert.deepEqual(res.body, { code: 'disabled' }, path);
    }

    const passwordFile = join(dataDir, 'secrets', 'initial-admin-password');
    await waitFor(() => existsSync(passwordFile) && existsSync(join(dataDir, 'admin.json')), { what: 'initial admin' });
    const login = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'asoldi.com', password: readFileSync(passwordFile, 'utf8').trim() }),
    });
    assert.equal(login.status, 200);
    const admin = { authorization: `Bearer ${(await login.json()).token}`, 'content-type': 'application/json' };
    assert.equal((await json('/api/admin/legal/terms-update', { headers: admin })).status, 404, 'still dark with an admin login');
    const settingsFile = join(dataDir, 'automation-settings.json');
    assert.equal(existsSync(settingsFile), false, 'nothing stored while dark');

    // Switched on from Superadmin.
    const on = await json('/api/admin/automation-settings', { method: 'PUT', headers: admin, body: JSON.stringify({ settings: { legal: { catalogTexts: { enabled: true } } }, reason: 'boot test' }) });
    assert.equal(on.status, 200, JSON.stringify(on.body).slice(0, 300));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const terms = await json('/api/legal/texts/vilkar');
    assert.equal(terms.status, 200);
    assert.equal(terms.body.catalogVersion, 1);
    assert.match(JSON.stringify(terms.body.sections), /Alle nivåer har blogg/);
    const privacy = await json('/api/legal/texts/personvern');
    assert.match(JSON.stringify(privacy.body.sections), /Anthropic/);
    assert.equal((await json('/api/legal/texts/salg')).status, 200);
    assert.equal((await json('/api/client/legal')).status, 401, 'the client routes need a client login');
    assert.equal((await json('/api/client/dpa/sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    const update = await json('/api/admin/legal/terms-update', { headers: admin });
    assert.equal(update.status, 200);
    assert.equal(update.body.sends, false);
    assert.deepEqual(update.body.clients, []);
    assert.deepEqual(readdirSync(dataDir).filter((name) => /outbox/i.test(name)), [], 'nothing was queued');
  } catch (error) {
    error.message += `\n--- hub log ---\n${logs.slice(-4000)}`;
    throw error;
  }
});
