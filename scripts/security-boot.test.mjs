// Boots the real hub (server.js) on a random local port with a throwaway data dir and no
// real credentials, then probes the security behaviour over HTTP. Nothing leaves 127.0.0.1:
//
// - The child runs in an empty temp working directory, so dotenv (which reads <cwd>/.env)
//   finds no .env even when this test runs from the main checkout that has the live .env.
// - Every credential-like key is set to an empty string in the child env: dotenv never
//   overrides a key that is already set, so even a stray .env could not fill them.
// - Myphoner reconcile / SSU sync are off, and HUB_SAFE_MODE=1 (honoured once WS0.11 lands).
// - scripts/security/loopback-only-egress.mjs is preloaded: any TCP connection to a
//   non-loopback host fails inside the child.
//
// Run: node --test scripts/security-boot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { PRODUCTION_ENV_KEYS } from '../lib/persistent-env.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverPath = join(repoRoot, 'server.js');
const egressGuard = pathToFileURL(join(repoRoot, 'scripts', 'security', 'loopback-only-egress.mjs')).href;
const RETIRED_SECRET = 'fake-retired-fireflies-signing-secret-boot';
const RETIRED_TOKEN = 'fake-retired-fireflies-url-token-boot';
const BODY = '{"meeting_id":"BOOTTEST","event":"meeting.bot_joined"}';

// Credential-like names among the hub's env keys, plus outbound keys that are not in that list.
const CREDENTIAL_KEY = /(KEY|SECRET|TOKEN|PASS|PASSWORD|AUTH|_API$|_JSON$|_LOGIN$|_USER$|_URL$|_HOST$|_SUBDOMAIN$|_ID$|_IDS$)/;
const EXTRA_OUTBOUND_KEYS = [
  'PROD_ADMIN_URL', 'PROD_ADMIN_USERNAME', 'PROD_ADMIN_PASSWORD', 'HOSTINGER_API_TOKEN', 'BREVO_API_KEY',
  'OPENAI_API_KEY', 'BRAVE_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'DEEPGRAM_API_KEY', 'DATAFORSEO_AUTH',
  'SERPAPI_API_KEY', 'SERPAPI_API_KEY_2', 'SERP_API_KEY', 'LUCA_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY',
  'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PASS', 'SMTP_FALLBACK_HOST', 'SMTP_FALLBACK_PASS',
  'INBOX_IMAP_HOST', 'INBOX_IMAP_DAMIAN_PASS', 'INBOX_IMAP_ALEXANDER_PASS', 'MYPHONER_API_KEY',
  'MYPHONER_PERSONAL_API_KEY', 'FIREFLIES_API_KEY', 'FIREFLIES_API', 'STRIPE_SECRET_KEY',
  'STRIPE_CONNECT_SECRET_KEY', 'STRIPE_CONNECT_TEST_SECRET_KEY', 'WORDPRESS_APP_PASSWORD',
  'GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON', 'WEBSITE_MAKER_API_KEY', 'WEBSITE_MAKER_DEV_ROOT',
];

function bootEnv({ dataDir, home, port }) {
  const env = {};
  for (const key of new Set([...PRODUCTION_ENV_KEYS.filter((key) => CREDENTIAL_KEY.test(key)), ...EXTRA_OUTBOUND_KEYS])) {
    env[key] = '';
  }
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
    // The public default must be ignored: the hub falls back to a disk secret.
    ADMIN_SECRET: 'change-me-in-production',
    FIREFLIES_WEBHOOK_SECRET: RETIRED_SECRET,
    FIREFLIES_WEBHOOK_TOKEN: RETIRED_TOKEN,
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

function forge(secret, payload) {
  const data = JSON.stringify(payload);
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64url');
}

function hubSign(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

async function waitFor(check, { timeoutMs = 45_000, stepMs = 150, what = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('the boot env blanks every credential and the child cwd has no .env', () => {
  const env = bootEnv({ dataDir: 'd', home: 'h', port: 1 });
  for (const key of ['RESEND_API_KEY', 'SMTP_PASS', 'MYPHONER_API_KEY', 'FIREFLIES_API_KEY', 'FIREFLIES_API', 'DEEPSEEK_API_KEY',
    'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_CONNECT_SECRET_KEY', 'STRIPE_CONNECT_TEST_SECRET_KEY',
    'INBOX_IMAP_DAMIAN_PASS', 'INBOX_IMAP_ALEXANDER_PASS', 'HOSTINGER_API_TOKEN', 'PROD_ADMIN_PASSWORD', 'LUCA_API_KEY',
    'DATAFORSEO_AUTH', 'SERPAPI_API_KEY', 'SERPAPI_API_KEY_2', 'DEEPGRAM_API_KEY', 'BREVO_API_KEY', 'MYPHONER_WEBHOOK_BASE_URL',
    'SALES_PREVIEW_PUSH_URL', 'GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON']) {
    assert.equal(env[key], '', key);
  }
  assert.equal(env.MYPHONER_WEBHOOK_RECONCILE_ENABLED, '0');
  assert.equal(env.MYPHONER_SSU_WINS_SYNC_ENABLED, '0');
  assert.equal(env.HUB_SAFE_MODE, '1');
});

test('local hub boot: tokens signed with an old default secret, stale tokens, password change, logout everywhere, Fireflies rotation, counters', { timeout: 120_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-security-boot-'));
  const home = mkdtempSync(join(tmpdir(), 'asoldi-security-home-'));
  // Empty working directory: dotenv reads <cwd>/.env, and there must be none.
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-security-cwd-'));
  for (const name of ['.env', '.env.vault', '.env.local']) {
    assert.equal(existsSync(join(runDir, name)), false, `child cwd must not contain ${name}`);
  }
  assert.deepEqual(readdirSync(runDir), []);
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
    const passwordFile = join(dataDir, 'secrets', 'initial-admin-password');
    await waitFor(() => existsSync(passwordFile) && existsSync(join(dataDir, 'admin.json')), { what: 'initial admin' });
    const diskSecret = readFileSync(join(dataDir, 'secrets', 'admin-secret'), 'utf8').trim();
    const adminPassword = readFileSync(passwordFile, 'utf8').trim();
    const now = Date.now();

    // 1. Tokens signed with public defaults are refused; the env default was ignored.
    for (const fake of ['change-me-in-production', 'change-me']) {
      const res = await fetch(`${base}/api/hub/sites`, {
        headers: { authorization: `Bearer ${forge(fake, { role: 'admin', username: 'asoldi.com', at: now })}` },
      });
      assert.equal(res.status, 401, `signed with the ${fake.length}-char default`);
    }

    // 2. The one-time boot migration refuses admin tokens issued before this code first booted.
    const settingsFile = JSON.parse(readFileSync(join(dataDir, 'security-settings.json'), 'utf8'));
    assert.ok(settingsFile.migrations.adminSessionReset2026_10);
    const cutoff = Date.parse(settingsFile.revokedBefore.admin);
    assert.equal(settingsFile.revokedBefore.staff, settingsFile.revokedBefore.admin);
    const preBoot = forge(diskSecret, { role: 'admin', username: 'asoldi.com', at: cutoff - 60_000 });
    assert.equal((await fetch(`${base}/api/hub/sites`, { headers: { authorization: `Bearer ${preBoot}` } })).status, 401);

    // 3. Real admin login works; a 31-day-old token signed with the real secret is refused.
    const loginWith = (password) => fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'asoldi.com', password }),
    });
    const login = await loginWith(adminPassword);
    assert.equal(login.status, 200);
    let adminToken = (await login.json()).token;
    const admin = () => ({ authorization: `Bearer ${adminToken}` });
    const sitesWith = async (token) => (await fetch(`${base}/api/hub/sites`, { headers: { authorization: `Bearer ${token}` } })).status;
    assert.equal(await sitesWith(adminToken), 200);
    const stale = forge(diskSecret, { role: 'admin', username: 'asoldi.com', at: now - 31 * 24 * 60 * 60 * 1000 });
    assert.equal(await sitesWith(stale), 401);

    // 4. Changing the admin password logs out every admin session; the caller gets a fresh token.
    const otherDevice = (await (await loginWith(adminPassword)).json()).token;
    assert.equal(await sitesWith(otherDevice), 200);
    const newPassword = 'boot-new-admin-password-1';
    const change = await fetch(`${base}/api/admin/change-password`, {
      method: 'POST',
      headers: { ...admin(), 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: adminPassword, newPassword }),
    });
    assert.equal(change.status, 200);
    const fresh = (await change.json()).token;
    assert.ok(fresh);
    assert.equal(await sitesWith(otherDevice), 401, 'other device logged out');
    assert.equal(await sitesWith(adminToken), 401, 'the token used for the change is replaced');
    assert.equal(await sitesWith(fresh), 200, 'fresh token works');
    adminToken = fresh;
    assert.equal((await loginWith(adminPassword)).status, 401);
    assert.equal((await loginWith(newPassword)).status, 200);

    // 5. Security overview: sources, never values.
    const overviewRes = await fetch(`${base}/api/admin/system/security`, { headers: admin() });
    assert.equal(overviewRes.status, 200);
    const overviewText = await overviewRes.text();
    assert.equal(overviewText.includes(diskSecret), false);
    const overview = JSON.parse(overviewText);
    assert.equal(overview.adminSecretSource, 'disk');
    assert.equal(overview.adminSecretEnvRejected, 'known-default');
    assert.equal(overview.tokens.maxTokenAgeDays, 30);

    // 6. Fireflies: the retired env credentials get 401; the disk secret gets 200.
    const retiredSigned = await fetch(`${base}/api/webhooks/fireflies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature': hubSign(RETIRED_SECRET, BODY) },
      body: BODY,
    });
    assert.equal(retiredSigned.status, 401);
    const retiredQuery = await fetch(`${base}/api/webhooks/fireflies?token=${encodeURIComponent(RETIRED_TOKEN)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: BODY,
    });
    assert.equal(retiredQuery.status, 401);
    const reveal = await (await fetch(`${base}/api/admin/security/fireflies-webhook/reveal`, { method: 'POST', headers: admin() })).json();
    assert.match(reveal.secret, /^[0-9a-f]{64}$/);
    const good = await fetch(`${base}/api/webhooks/fireflies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature': hubSign(reveal.secret, BODY) },
      body: BODY,
    });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).reason, 'ignored-event');
    const ffStatus = await (await fetch(`${base}/api/admin/security/fireflies-webhook`, { headers: admin() })).json();
    assert.equal(ffStatus.lastVerified.via, 'data-signature');
    assert.equal(ffStatus.counters['fireflies-webhook-retired-credential'].total, 2);
    assert.deepEqual(ffStatus.retiredEnvPresent, { secret: true, token: true });

    const rotated = await (await fetch(`${base}/api/admin/security/fireflies-webhook/rotate`, { method: 'POST', headers: admin() })).json();
    const oldSecret = await fetch(`${base}/api/webhooks/fireflies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature': hubSign(reveal.secret, BODY) },
      body: BODY,
    });
    assert.equal(oldSecret.status, 401);
    assert.notEqual(rotated.secret, reveal.secret);
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'secrets', 'webhooks.json'), 'utf8')).fireflies;
    assert.equal(onDisk.secret, rotated.secret, 'the rotation is what is stored');

    // 7. Client portal: log out everywhere.
    const signup = await fetch(`${base}/api/client/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'boot-client@example.com', password: 'boot-password-1' }),
    });
    assert.equal(signup.status, 201);
    const deviceA = (await signup.json()).token;
    const clientLogin = () => fetch(`${base}/api/client/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'boot-client@example.com', password: 'boot-password-1' }),
    });
    const deviceB = (await (await clientLogin()).json()).token;
    const profile = (token) => fetch(`${base}/api/client/profile`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await profile(deviceA)).status, 200);
    assert.equal((await profile(deviceB)).status, 200);
    const out = await fetch(`${base}/api/client/account/logout-everywhere`, { method: 'POST', headers: { authorization: `Bearer ${deviceA}` } });
    assert.equal(out.status, 200);
    assert.equal((await profile(deviceA)).status, 401);
    assert.equal((await profile(deviceB)).status, 401);
    const deviceC = (await (await clientLogin()).json()).token;
    assert.equal((await profile(deviceC)).status, 200);

    // 8. Admin revokes every client token; the admin keeps working with a fresh token after revoking admins.
    const revokeClients = await fetch(`${base}/api/admin/security/revoke-tokens`, {
      method: 'POST',
      headers: { ...admin(), 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'client' }),
    });
    assert.equal(revokeClients.status, 200);
    assert.equal((await profile(deviceC)).status, 401);
    const oldAdmin = adminToken;
    const revokeAdmins = await (await fetch(`${base}/api/admin/security/revoke-tokens`, {
      method: 'POST',
      headers: { ...admin(), 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'admin' }),
    })).json();
    adminToken = revokeAdmins.token;
    assert.equal(await sitesWith(oldAdmin), 401);
    assert.equal(await sitesWith(adminToken), 200);

    // 9. Maker callbacks with a wrong token, or with none, are refused and counted separately.
    const callback = (headers) => fetch(`${base}/api/admin/sales/maker-status-callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ event: 'run.step.updated' }),
    });
    assert.equal((await callback({ 'x-sales-callback-token': 'wrong-token-value' })).status, 401);
    assert.equal((await callback({})).status, 401);
    const counters = (await (await fetch(`${base}/api/admin/system/security`, { headers: admin() })).json()).counters;
    assert.equal(counters['maker-callback-rejected'].total, 1);
    assert.equal(counters['maker-callback-missing-token'].total, 1);

    // 10. The read-only probe (WS0.32) passes against the real hub for a real site; only the
    //     Fireflies API key is missing because the boot env has none on purpose.
    const site = await fetch(`${base}/api/hub/sites`, {
      method: 'POST',
      headers: { ...admin(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Probe site', domain: 'probe.example' }),
    });
    assert.equal(site.status, 201);
    const { runProbe } = await import('./security/probe-hub.mjs');
    const report = await runProbe({ target: base, adminToken, siteDomain: 'probe.example' });
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    for (const id of ['health', 'default-secret-token:23', 'default-secret-token:9', 'site-config', 'recordings', 'counters']) {
      assert.equal(byId[id].ok, true, `${id}: ${byId[id].detail}`);
    }
    assert.equal(byId.fireflies.ok, false);

    // 11. No live system was touched: no Myphoner reconcile, no Fireflies pull, and nothing
    //     but loopback was even attempted.
    assert.doesNotMatch(logs, /\[myphoner\] webhook reconcile complete/);
    assert.doesNotMatch(logs, /\[fireflies\] recent-transcripts/);
    const blocked = logs.split(/\r?\n/).filter((line) => line.startsWith('[egress-guard] blocked'));
    assert.deepEqual(blocked, [], 'the hub tried to reach a non-loopback host');
  } catch (error) {
    console.error(logs.split(/\r?\n/).slice(-60).join('\n'));
    throw error;
  }
});
