// WS6.7 / WS6.8 on the real hub: boots server.js in safe mode on 127.0.0.1 with a throwaway data dir
// and no credentials (same isolation as scripts/security-boot.test.mjs: empty cwd, blanked keys,
// loopback-only egress), then checks over HTTP that site-config is unchanged while the feature switch
// is off, that cms-spec works in safe mode, and what the switch changes. The shop site holds a site
// credential (lib/site-credentials.js), so its admin data and pendingSettings go only to calls that carry it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { PRODUCTION_ENV_KEYS } from '../lib/persistent-env.js';
import { PUBLIC_SITE_CONFIG_FIELDS } from '../lib/cms-entitlements.js';
import { createSiteCredentialStore } from '../lib/site-credentials.js';

// A Maker callback token made for this boot only, and a site key served by /api/cms/config.
const MAKER_TOKEN = randomBytes(24).toString('hex');
const ENV_SITE_KEY = 'boot-key-shop';

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
    WEBSITE_MAKER_STATUS_CALLBACK_TOKEN: MAKER_TOKEN,
    CMS_SITE_KEY: ENV_SITE_KEY,
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
    const siteConfig = (query, headers = {}) => json(`/api/hub/site-config?${query}`, { headers });
    // The shop site's CMS holds a site credential (written to the store the hub reads; the proof is
    // covered in scripts/site-credentials.test.mjs).
    const credential = randomBytes(32).toString('base64url');
    createSiteCredentialStore({ dataDir }).enroll('b1', credential, { proofDomain: 'boot-shop.test', proofOrigin: 'https://boot-shop.test' });
    const withCredential = { 'x-site-credential': credential };

    // Dark: the site-config answer has exactly the fields it has today: the admin fields only with the
    // site credential, never for the site key alone.
    const darkKey = await siteConfig('site_key=boot-key-shop');
    const darkTrusted = await siteConfig('site_key=boot-key-shop', withCredential);
    const darkDomain = await siteConfig('domain=boot-shop.test');
    assert.equal(darkKey.status, 200);
    assert.deepEqual(Object.keys(darkKey.body).sort(), ['analyticsGoals', 'analyticsLevel', 'desiredCmsVersion', 'domain', 'ecommerceCatalogType', 'features', 'id', 'name', 'websitePlan']);
    assert.equal(darkTrusted.status, 200);
    assert.deepEqual(Object.keys(darkTrusted.body).sort(), ['analyticsGoals', 'analyticsLevel', 'clientAdmin', 'desiredCmsVersion', 'domain', 'ecommerceCatalogType', 'features', 'id', 'name', 'pendingAdmin', 'websitePlan']);
    assert.deepEqual(Object.keys(darkDomain.body).sort(), ['analyticsGoals', 'analyticsLevel', 'desiredCmsVersion', 'domain', 'ecommerceCatalogType', 'features', 'id', 'name', 'websitePlan']);
    assert.equal(darkKey.body.features.socialSync, true);
    // Every field of the dark domain answer is public, so switching a site on keeps all of them.
    assert.deepEqual(Object.keys(darkDomain.body).filter((key) => !PUBLIC_SITE_CONFIG_FIELDS.includes(key)), []);
    // /api/cms/config is open and its site key comes from the environment: no admin data.
    const darkCmsConfig = await json('/api/cms/config');
    assert.equal(darkCmsConfig.status, 200);
    assert.equal(darkCmsConfig.body.id, 'b1');
    for (const field of ['clientAdmin', 'pendingAdmin', 'pendingSettings']) assert.equal(field in darkCmsConfig.body, false, field);

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
    assert.deepEqual((await siteConfig('site_key=boot-key-shop', withCredential)).body, darkTrusted.body);

    // A Maker request meets the real Maker check in server.js first, then the switch.
    const makerGet = (headers) => json('/api/hub/sites/b1/cms-spec', { headers });
    assert.equal((await makerGet({ 'x-maker-callback-token': 'not-the-token' })).status, 401);
    assert.equal((await makerGet({ 'x-maker-host-token': 'not-a-host-token' })).status, 401);
    assert.equal((await makerGet({ 'x-maker-callback-token': MAKER_TOKEN })).status, 403, 'a valid token while makerAccess is off');
    const access = await json('/api/admin/cms-features/settings', { method: 'PUT', headers: admin, body: JSON.stringify({ cmsSpec: { makerAccess: true } }) });
    assert.equal(access.status, 200);
    const makerRead = await makerGet({ 'x-maker-callback-token': MAKER_TOKEN });
    assert.equal(makerRead.status, 200, JSON.stringify(makerRead.body).slice(0, 300));
    assert.equal(makerRead.body.cmsSpec.rev, 1);
    assert.equal((await makerGet({ 'x-maker-callback-token': 'not-the-token' })).status, 401, 'still 401 with access on');
    const makerHeaders = { 'content-type': 'application/json', 'x-sales-callback-token': MAKER_TOKEN };
    const makerGrant = await json('/api/hub/sites/b1/cms-spec', { method: 'PUT', headers: makerHeaders, body: JSON.stringify({ featureSpec: { grantServices: ['email'] } }) });
    assert.equal(makerGrant.status, 403);
    const makerWrite = await json('/api/hub/sites/b1/cms-spec', { method: 'PUT', headers: makerHeaders, body: JSON.stringify({ sections: { blog: { categories: ['Nyheter'] } } }) });
    assert.equal(makerWrite.status, 200, JSON.stringify(makerWrite.body));
    assert.equal(makerWrite.body.cmsSpecRev, 2);
    await json('/api/admin/cms-features/settings', { method: 'PUT', headers: admin, body: JSON.stringify({ cmsSpec: { makerAccess: false } }) });
    assert.equal((await makerGet({ 'x-maker-callback-token': MAKER_TOKEN })).status, 403);

    // Switch on for the shop only.
    const on = await json('/api/admin/cms-features/settings', { method: 'PUT', headers: admin, body: JSON.stringify({ siteConfig: { mode: 'on', siteIds: ['b1'] } }) });
    assert.equal(on.status, 200);
    const lit = await siteConfig('site_key=boot-key-shop', withCredential);
    assert.equal(lit.body.featureTree.plan, 'tier-3-ecommerce');
    assert.ok(lit.body.featureTree.entitled.includes('shop.subscriptions'));
    assert.equal(lit.body.features.socialSync, false);
    assert.equal(lit.body.ecommerceCatalogType, 'menu');
    assert.equal(lit.body.pendingSettings.rev, 2);
    // The site key alone gets the tree, never pendingSettings or the admin fields.
    const litKeyOnly = await siteConfig('site_key=boot-key-shop');
    assert.ok(litKeyOnly.body.featureTree);
    for (const field of ['pendingSettings', 'pendingAdmin', 'clientAdmin']) assert.equal(field in litKeyOnly.body, false, field);
    // The open /api/cms/config gets the tree but never pendingSettings or admin fields.
    const litCmsConfig = await json('/api/cms/config');
    assert.ok(litCmsConfig.body.featureTree);
    for (const field of ['clientAdmin', 'pendingAdmin', 'pendingSettings']) assert.equal(field in litCmsConfig.body, false, field);
    assert.equal(JSON.stringify(litCmsConfig.body).includes('Nyheter'), false);
    const litDomain = await siteConfig('domain=boot-shop.test');
    assert.ok(litDomain.body.featureTree);
    for (const field of ['pendingSettings', 'pendingAdmin', 'clientAdmin']) assert.equal(field in litDomain.body, false, field);
    const plain = await siteConfig('site_key=boot-key-plain');
    assert.equal('featureTree' in plain.body, false, 'a site that is not listed stays as it was');

    // A heartbeat with the site key alone cannot stop pendingSettings.
    const today = new Date().toISOString().slice(0, 10);
    const keyOnlyBeat = await json('/api/hub/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site_key: 'boot-key-shop', packageVersion: '2.3.0', settingsRevApplied: 2, featuresRev: 2 }),
    });
    assert.equal(keyOnlyBeat.status, 200);
    assert.equal(keyOnlyBeat.body.verified, false);
    assert.equal((await siteConfig('site_key=boot-key-shop', withCredential)).body.pendingSettings.rev, 2);
    // The CMS reports with its credential that it applied rev 2: pendingSettings stops, the report is stored.
    const beat = await json('/api/hub/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...withCredential },
      body: JSON.stringify({ site_key: 'boot-key-shop', packageVersion: '2.3.0', settingsRevApplied: 2, featuresRev: 2, effective: ['users', 'shop'], featureBlocksDaily: [{ date: today, count: 3 }, { date: '2099-01-01', count: 7 }] }),
    });
    assert.equal(beat.status, 200);
    assert.equal(beat.body.verified, true);
    assert.equal('pendingSettings' in (await siteConfig('site_key=boot-key-shop', withCredential)).body, false);
    const spec = await json('/api/hub/sites/b1/cms-spec', { headers: admin });
    assert.equal(spec.body.cmsReported.settingsRevApplied, 2);
    assert.deepEqual(spec.body.cmsReported.blockHistory, [{ date: today, count: 3, top: [] }], 'a day far ahead is not kept');

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
