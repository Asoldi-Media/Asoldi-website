// WS6.7 / WS6.8 on the real hub: boots server.js in safe mode on 127.0.0.1 with a throwaway data dir
// and no credentials (same isolation as scripts/security-boot.test.mjs: empty cwd, blanked keys,
// loopback-only egress), then checks over HTTP that site-config is unchanged while the feature switch
// is off, that cms-spec works in safe mode, and what the switch changes.
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

const ALL_ON = { users: true, analytics: true, ecommerce: true, blog: true, socialSync: true, emailMarketing: true, general: true };
const SITES = [
  { id: 'b1', site_key: 'boot-key-shop', domain: 'boot-shop.test', name: 'Boot shop', websitePlan: 'tier-3-ecommerce', features: ALL_ON, ecommerceCatalogType: 'menu', cms: { packageVersion: '2.1.3' } },
  { id: 'b2', site_key: 'boot-key-plain', domain: 'boot-plain.test', name: 'Boot plain', websitePlan: 'tier-1-standard', features: { users: true } },
];

test('local hub in safe mode: site-config unchanged while dark, cms-spec writes, the switch and the heartbeat', { timeout: 180_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-features-boot-'));
  const home = mkdtempSync(join(tmpdir(), 'asoldi-features-home-'));
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-features-cwd-'));
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(SITES, null, 2));
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
    assert.equal(logs.includes('[cms-features] the synced feature registry did not load'), false);
    const passwordFile = join(dataDir, 'secrets', 'initial-admin-password');
    await waitFor(() => existsSync(passwordFile) && existsSync(join(dataDir, 'admin.json')), { what: 'initial admin' });
    const login = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'asoldi.com', password: readFileSync(passwordFile, 'utf8').trim() }),
    });
    assert.equal(login.status, 200);
    const admin = { authorization: `Bearer ${(await login.json()).token}`, 'content-type': 'application/json' };
    const json = async (path, init = {}) => {
      const res = await fetch(`${base}${path}`, init);
      return { status: res.status, body: await res.json() };
    };
    const siteConfig = (query) => json(`/api/hub/site-config?${query}`);

    // Dark: the site-config answer has exactly the fields it has today.
    const darkKey = await siteConfig('site_key=boot-key-shop');
    const darkDomain = await siteConfig('domain=boot-shop.test');
    assert.equal(darkKey.status, 200);
    assert.deepEqual(Object.keys(darkKey.body).sort(), ['analyticsGoals', 'analyticsLevel', 'clientAdmin', 'desiredCmsVersion', 'domain', 'ecommerceCatalogType', 'features', 'id', 'name', 'pendingAdmin', 'websitePlan']);
    assert.deepEqual(Object.keys(darkDomain.body).sort(), ['analyticsGoals', 'analyticsLevel', 'desiredCmsVersion', 'domain', 'ecommerceCatalogType', 'features', 'id', 'name', 'websitePlan']);
    assert.equal(darkKey.body.features.socialSync, true);

    // cms-spec works in safe mode (local data only) and still does not change site-config.
    const write = await json('/api/hub/sites/b1/cms-spec', {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({
        featureSpec: { grant: ['shop.subscriptions'] },
        sections: { email: { recovery: { enabled: true, steps: [{ delayMinutes: 60 }, { delayMinutes: 20160 }] } } },
        reason: 'boot test',
      }),
    });
    assert.equal(write.status, 200, JSON.stringify(write.body));
    assert.deepEqual([write.body.featureSpecRev, write.body.cmsSpecRev], [2, 1]);
    const prompt = await json('/api/hub/sites/b1/cms-spec/prompt', { headers: admin });
    assert.equal(prompt.status, 200);
    assert.ok(prompt.body.length <= 12000);
    assert.deepEqual((await siteConfig('site_key=boot-key-shop')).body, darkKey.body);

    // Switch on for the shop only.
    const on = await json('/api/admin/cms-features/settings', { method: 'PUT', headers: admin, body: JSON.stringify({ siteConfig: { mode: 'on', siteIds: ['b1'] } }) });
    assert.equal(on.status, 200);
    const lit = await siteConfig('site_key=boot-key-shop');
    assert.equal(lit.body.featureTree.plan, 'tier-3-ecommerce');
    assert.ok(lit.body.featureTree.entitled.includes('shop.subscriptions'));
    assert.equal(lit.body.features.socialSync, false);
    assert.equal(lit.body.ecommerceCatalogType, 'menu');
    assert.equal(lit.body.pendingSettings.rev, 1);
    const litDomain = await siteConfig('domain=boot-shop.test');
    assert.ok(litDomain.body.featureTree);
    for (const field of ['pendingSettings', 'pendingAdmin', 'clientAdmin']) assert.equal(field in litDomain.body, false, field);
    const plain = await siteConfig('site_key=boot-key-plain');
    assert.equal('featureTree' in plain.body, false, 'a site that is not listed stays as it was');

    // The CMS reports that it applied rev 1: pendingSettings stops, the report is stored.
    const today = new Date().toISOString().slice(0, 10);
    const beat = await json('/api/hub/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site_key: 'boot-key-shop', packageVersion: '2.3.0', settingsRevApplied: 1, featuresRev: 2, effective: ['users', 'shop'], featureBlocksDaily: { date: today, count: 3 } }),
    });
    assert.equal(beat.status, 200);
    assert.equal('pendingSettings' in (await siteConfig('site_key=boot-key-shop')).body, false);
    const spec = await json('/api/hub/sites/b1/cms-spec', { headers: admin });
    assert.equal(spec.body.cmsReported.settingsRevApplied, 1);
    assert.deepEqual(spec.body.cmsReported.blockHistory, [{ date: today, count: 3, top: [] }]);

    // Off again: the old answer comes back.
    await json('/api/admin/cms-features/settings', { method: 'PUT', headers: admin, body: JSON.stringify({ siteConfig: { mode: 'off' } }) });
    const dark = await siteConfig('site_key=boot-key-shop');
    assert.equal('featureTree' in dark.body, false);
    assert.deepEqual(dark.body.features, darkKey.body.features);
  } catch (error) {
    error.message += `\n--- server log (tail) ---\n${logs.slice(-3000)}`;
    throw error;
  }
});
