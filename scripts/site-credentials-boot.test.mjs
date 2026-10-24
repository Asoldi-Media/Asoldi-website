// Boots the real hub (server.js) on 127.0.0.1 with a throwaway data dir, an empty working
// directory (no .env), blank credentials, safe mode and the loopback-only egress guard, then checks
// the site credential rules over HTTP: site config, heartbeat, a money route, the enrollment switch,
// the admin list and revoke, the visitor form limit, the trusted-hop setting on the heartbeat
// and form limits, and the manual correction of a trusted CMS version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { PRODUCTION_ENV_KEYS } from '../lib/persistent-env.js';
import { createSiteCredentialStore } from '../lib/site-credentials.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverPath = join(repoRoot, 'server.js');
const egressGuard = pathToFileURL(join(repoRoot, 'scripts', 'security', 'loopback-only-egress.mjs')).href;
const CREDENTIAL_KEY = /(KEY|SECRET|TOKEN|PASS|PASSWORD|AUTH|_API$|_JSON$|_LOGIN$|_USER$|_URL$|_HOST$|_SUBDOMAIN$|_ID$|_IDS$)/;

function bootEnv({ dataDir, home, port }) {
  const env = {};
  for (const key of PRODUCTION_ENV_KEYS.filter((name) => CREDENTIAL_KEY.test(name))) env[key] = '';
  for (const key of ['SMTP_HOST', 'SMTP_PASS', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_CONNECT_SECRET_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'CMS_SITE_KEY']) env[key] = '';
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

async function waitFor(check, { timeoutMs = 60_000, stepMs = 150, what = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('real hub: site config, heartbeat, money routes, enrollment switch, revoke and form limits follow the site credential and the trusted-hop setting', { timeout: 180_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-site-cred-boot-'));
  const home = mkdtempSync(join(tmpdir(), 'asoldi-site-cred-home-'));
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-site-cred-cwd-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = spawn(process.execPath, ['--import', egressGuard, serverPath], { cwd: runDir, env: bootEnv({ dataDir, home, port }), stdio: ['ignore', 'pipe', 'pipe'] });
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
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'asoldi.com', password: readFileSync(passwordFile, 'utf8').trim() }),
  });
  assert.equal(login.status, 200);
  const admin = { authorization: `Bearer ${(await login.json()).token}`, 'content-type': 'application/json' };
  const json = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, body, headers: res.headers };
  };

  const created = await json('/api/hub/sites', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Boot shop', domain: 'boot-shop.example', websitePlan: 'tier-3-ecommerce' }) });
  assert.equal(created.status, 201);
  const site = created.body;
  const key = site.site_key;
  const setAdmin = await json(`/api/hub/sites/${site.id}/client-admin`, { method: 'PUT', headers: admin, body: JSON.stringify({ username: 'owner', email: 'owner@example.com', password: 'a-long-client-password' }) });
  assert.equal(setAdmin.status, 200);

  // 1. Not enrolled: the site key gets the public config only, by query or header.
  for (const init of [{}, { headers: { 'x-site-key': key } }]) {
    const path = init.headers ? '/api/hub/site-config' : `/api/hub/site-config?site_key=${key}`;
    const res = await json(path, init);
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Boot shop');
    assert.equal(res.body.pendingAdmin, undefined, 'no pending admin password on the site key alone');
    assert.equal(res.body.clientAdmin, undefined, 'no client admin contact on the site key alone');
    assert.equal(res.headers.get('x-site-credential-status'), 'not-enrolled');
  }
  assert.equal((await json('/api/hub/site-config?domain=boot-shop.example')).body.pendingAdmin, undefined);

  // 2. Enrollment is switched off by default (no outgoing proof call).
  const enrollOff = await json('/api/hub/site-credential/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ siteKey: key, credential: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url') }) });
  assert.equal(enrollOff.status, 503);
  assert.equal(enrollOff.body.code, 'enrollment-off');

  // 3. A heartbeat on the site key alone is liveness only.
  const beat = await json('/api/hub/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site_key: key, packageVersion: '9.9.9', adminUrl: 'https://elsewhere.example/admin', adminApplied: true }) });
  assert.equal(beat.status, 200);
  assert.equal(beat.body.verified, false);
  let listed = (await json('/api/hub/sites', { headers: admin })).body.find((row) => row.id === site.id);
  assert.equal(listed.cms.packageVersion, '');
  assert.equal(listed.cms.adminUrl, '');
  assert.equal(listed.cms.unverified.packageVersion, '9.9.9');
  assert.ok(listed.cms.lastSeenAt);

  // 4. The site enrolls (written to the store the hub reads; the proof itself is covered in
  //    site-credentials.test.mjs and the local end-to-end probe).
  const credential = randomBytes(32).toString('base64url');
  createSiteCredentialStore({ dataDir }).enroll(site.id, credential, { proofDomain: 'boot-shop.example', proofOrigin: 'https://boot-shop.example' });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const withCredential = { 'x-site-key': key, 'x-site-credential': credential, 'content-type': 'application/json' };

  const keyOnly = await json(`/api/hub/site-config?site_key=${key}`);
  assert.equal(keyOnly.body.pendingAdmin, undefined);
  assert.equal(keyOnly.headers.get('x-site-credential-status'), 'missing');
  const wrong = await json('/api/hub/site-config', { headers: { 'x-site-key': key, 'x-site-credential': randomBytes(32).toString('base64url') } });
  assert.equal(wrong.status, 200, 'a wrong credential still gets the public config');
  assert.equal(wrong.body.pendingAdmin, undefined);
  assert.equal(wrong.headers.get('x-site-credential-status'), 'invalid');
  const full = await json('/api/hub/site-config', { headers: withCredential });
  assert.equal(full.headers.get('x-site-credential-status'), 'valid');
  assert.equal(full.body.pendingAdmin.username, 'owner');
  assert.match(full.body.pendingAdmin.passwordHash, /^\$2/);
  assert.equal(full.body.clientAdmin.email, 'owner@example.com');
  assert.equal(full.headers.get('cache-control'), 'no-store');

  // 5. The unverified heartbeat above did not clear the pending password; a verified one does.
  const verified = await json('/api/hub/heartbeat', { method: 'POST', headers: withCredential, body: JSON.stringify({ site_key: key, packageVersion: '2.2.2', adminUrl: 'https://boot-shop.example/admin', adminApplied: true }) });
  assert.equal(verified.body.verified, true);
  assert.equal((await json('/api/hub/site-config', { headers: withCredential })).body.pendingAdmin, null);
  listed = (await json('/api/hub/sites', { headers: admin })).body.find((row) => row.id === site.id);
  assert.equal(listed.cms.packageVersion, '2.2.2');
  assert.equal(listed.cms.adminUrl, 'https://boot-shop.example/admin');
  assert.equal(listed.cms.unverified, undefined);
  assert.ok(listed.cms.lastVerifiedAt);

  // 6. A money route: site key alone 401, with the credential it reaches the payment code.
  const disconnectKeyOnly = await json('/api/hub/shop/disconnect', { method: 'POST', headers: { 'x-site-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'paypal' }) });
  assert.equal(disconnectKeyOnly.status, 401);
  const disconnect = await json('/api/hub/shop/disconnect', { method: 'POST', headers: withCredential, body: JSON.stringify({ provider: 'paypal' }) });
  assert.equal(disconnect.status, 200);

  // 7. The admin list shows the enrollment; revoke makes the credential stop working.
  const list = await json('/api/hub/site-credentials', { headers: admin });
  assert.equal(list.status, 200);
  const row = list.body.sites.find((r) => r.siteId === site.id);
  assert.equal(row.enrolled, true);
  assert.equal(row.proofDomain, 'boot-shop.example');
  assert.equal(list.body.settings.enrollment, 'off');
  assert.equal((await json('/api/hub/site-credentials', {})).status, 401, 'admin only');
  const revoke = await json(`/api/hub/sites/${site.id}/site-credential/revoke`, { method: 'POST', headers: admin });
  assert.equal(revoke.status, 200);
  const afterRevoke = await json('/api/hub/shop/disconnect', { method: 'POST', headers: withCredential, body: JSON.stringify({ provider: 'paypal' }) });
  assert.equal(afterRevoke.status, 401);
  assert.equal(afterRevoke.headers.get('x-site-credential-status'), 'not-enrolled');
  const security = await json('/api/admin/system/security', { headers: admin });
  assert.equal(security.body.counters['site-credential-revoked'].total, 1, 'counted on the Security card');

  // 7b. A revoked site stays closed and is not marked as seen by heartbeats without its credential;
  //     those heartbeats are limited to 30 a minute per site and address.
  const statusAfterRevoke = await json('/api/hub/shop/status', { headers: { 'x-site-key': key } });
  assert.equal(statusAfterRevoke.status, 401);
  const seenBefore = (await json('/api/hub/sites', { headers: admin })).body.find((r) => r.id === site.id).cms.lastSeenAt;
  const beats = [];
  for (let i = 0; i < 31; i += 1) {
    beats.push((await json('/api/hub/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site_key: key, packageVersion: '2.1.3' }) })).status);
  }
  assert.equal(beats[0], 200);
  assert.equal(beats.at(-1), 429, 'heartbeats without a valid credential are limited');
  listed = (await json('/api/hub/sites', { headers: admin })).body.find((r) => r.id === site.id);
  assert.equal(listed.cms.lastSeenAt, seenBefore, 'a revoked site is not marked as seen on its site key alone');
  assert.equal(listed.cms.unverified.packageVersion, '2.1.3');

  // 7c. An admin reset for a CMS that went back to 2.1.3: the row is forgotten and the reported
  //     version is taken, so shop status works on the site key again; money routes do not.
  const reset = await json(`/api/hub/sites/${site.id}/site-credential/reset`, { method: 'POST', headers: admin });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.trustedVersion, '2.1.3');
  assert.equal((await json('/api/hub/shop/status', { headers: { 'x-site-key': key } })).status, 200);
  assert.equal((await json('/api/hub/shop/disconnect', { method: 'POST', headers: { 'x-site-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'paypal' }) })).status, 401);

  // 8. Visitor forms: 8 per site and address in 10 minutes (safe mode keeps the e-mails in its outbox).
  const statuses = [];
  for (let i = 0; i < 9; i += 1) {
    const res = await fetch(`${base}/api/client-forms/${key}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: 'name=Kari&message=Hei' });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(200));
  assert.equal(statuses[8], 429);

  // 9. A CDN in front of the hosting proxy: by default every visitor behind it is counted by the
  //    CDN's entry. With the Security setting the sign-in limits use (trustedHops 2), heartbeats
  //    and visitor forms count each visitor apart.
  const viaCdn = (visitor, extra) => ({ 'x-forwarded-for': `${visitor}, 203.0.113.250`, ...extra });
  const beatFrom = async (visitor) => (await json('/api/hub/heartbeat', { method: 'POST', headers: viaCdn(visitor, { 'content-type': 'application/json' }), body: JSON.stringify({ site_key: key }) })).status;
  const formFrom = async (visitor) => (await fetch(`${base}/api/client-forms/${key}`, { method: 'POST', headers: viaCdn(visitor, { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }), body: 'name=Kari&message=Hei' })).status;
  for (let i = 0; i < 30; i += 1) assert.equal(await beatFrom('198.51.100.41'), 200);
  assert.equal(await beatFrom('198.51.100.42'), 429, 'by default a second visitor behind the CDN shares its heartbeat count');
  for (let i = 0; i < 8; i += 1) assert.equal(await formFrom('198.51.100.41'), 200);
  assert.equal(await formFrom('198.51.100.42'), 429, 'and its form count');
  const hops = await json('/api/admin/security/login-address', { method: 'PUT', headers: admin, body: JSON.stringify({ trustedHops: 2 }) });
  assert.equal(hops.status, 200);
  assert.equal(hops.body.trustedHops, 2);
  for (let i = 0; i < 30; i += 1) assert.equal(await beatFrom('198.51.100.42'), 200, 'with 2 trusted hops the visitor has a heartbeat count of its own');
  assert.equal(await beatFrom('198.51.100.42'), 429, 'which is still limited');
  assert.equal(await beatFrom('198.51.100.43'), 200, 'and another visitor behind the CDN is not');
  for (let i = 0; i < 8; i += 1) assert.equal(await formFrom('198.51.100.42'), 200, 'a form count of its own too');
  assert.equal(await formFrom('198.51.100.42'), 429);
  assert.equal(await formFrom('198.51.100.43'), 200);

  // 10. Correcting a trusted CMS version by hand: PUT with a partial cms body keeps the other cms
  //     fields. The path has no PATCH.
  const cmsBefore = (await json('/api/hub/sites', { headers: admin })).body.find((r) => r.id === site.id).cms;
  const corrected = await json(`/api/hub/sites/${site.id}`, { method: 'PUT', headers: admin, body: JSON.stringify({ cms: { packageVersion: '2.2.1' } }) });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.cms.packageVersion, '2.2.1');
  assert.equal(corrected.body.cms.adminUrl, cmsBefore.adminUrl, 'the other cms fields are kept');
  assert.equal(corrected.body.cms.lastSeenAt, cmsBefore.lastSeenAt);
  assert.equal(corrected.body.name, 'Boot shop');
  const patched = await json(`/api/hub/sites/${site.id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ cms: { packageVersion: '2.1.3' } }) });
  assert.equal(patched.status, 404, 'no PATCH route on /api/hub/sites/:id');
  assert.equal((await json('/api/hub/sites', { headers: admin })).body.find((r) => r.id === site.id).cms.packageVersion, '2.2.1');
  assert.equal(logs.includes(credential), false, 'the credential never reaches the log');
});
