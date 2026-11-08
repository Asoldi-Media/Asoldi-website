// Boots the real hub (server.js) on 127.0.0.1 in safe mode with a throwaway data dir, an empty
// working directory (no .env), blank credentials and the loopback-only egress guard, and checks
// the email core routes end to end:
//  - with the default settings every new public route (the owner-recipient and owner-notify routes
//    too) answers 404 { code: 'disabled' } and the boot writes no email data;
//  - the Superadmin preview of the owner-routing default works while everything is off;
//  - once switched on, a one-click unsubscribe is recorded and the Brevo list removal becomes a
//    safe-mode intent: no connection to api.brevo.com is ever attempted.
// With EMAIL_DARK_COMPARE_REF=<git ref> it also boots that commit on an identical data dir and
// requires byte-identical site-config, CMS config and owner-routing answers (the dark-default
// control for a release).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

// This process mints an unsubscribe token with the booted hub's secret, so its data dir is fixed
// before any module that resolves the data dir is loaded.
const mainDataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-boot-data-'));
process.env.APP_DATA_DIR = mainDataDir;
const { PRODUCTION_ENV_KEYS } = await import('../lib/persistent-env.js');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const egressGuard = pathToFileURL(join(repoRoot, 'scripts', 'security', 'loopback-only-egress.mjs')).href;
const CREDENTIAL_KEY = /(KEY|SECRET|TOKEN|PASS|PASSWORD|AUTH|_API$|_JSON$|_LOGIN$|_USER$|_URL$|_HOST$|_SUBDOMAIN$|_ID$|_IDS$)/;
const KEY_ONE = 'f1x7ure5173k3y0000000000000000a1';
const KEY_TWO = 'f1x7ure5173k3y0000000000000000b2';

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
    SALES_CONTACT_EMAIL: 'salg@asoldi.com',
    // A placeholder so the client counts as configured; safe mode keeps it off the network.
    BREVO_API_KEY: 'fake-brevo-key-for-boot-test',
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

function seedDataDir(dataDir) {
  const at = '2026-10-01T10:00:00.000Z';
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify([
    { id: 'site_boot_1', site_key: KEY_ONE, domain: 'boot-one.example.com', name: 'Boot One', websitePlan: 'tier-3-ecommerce', clientAdmin: { email: 'owner-one@example.com', username: 'owner' }, createdAt: at },
    { id: 'site_boot_2', site_key: KEY_TWO, domain: 'boot-two.example.com', name: 'Boot Two', websitePlan: 'tier-1-standard', createdAt: at },
  ], null, 2));
  writeFileSync(join(dataDir, 'email-sites.json'), JSON.stringify({
    site_boot_1: { brevoListId: 57 },
    site_boot_2: { ownerRouting: 'owner+asoldi-bcc', ownerRoutingSetAt: '2026-10-30T10:00:00.000Z', ownerRecipients: [{ email: 'owner-two@example.com', status: 'confirmed', source: 'superadmin' }] },
  }, null, 2));
}

async function bootHub({ codeRoot, dataDir }) {
  const home = mkdtempSync(join(tmpdir(), 'asoldi-email-boot-home-'));
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-email-boot-cwd-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = spawn(process.execPath, ['--import', egressGuard, join(codeRoot, 'server.js')], { cwd: runDir, env: bootEnv({ dataDir, home, port }), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  await waitFor(() => logs.includes('Server running on port'), { what: `server start (${codeRoot})` });
  const passwordFile = join(dataDir, 'secrets', 'initial-admin-password');
  await waitFor(() => existsSync(passwordFile) && existsSync(join(dataDir, 'admin.json')), { what: 'initial admin' });
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'asoldi.com', password: readFileSync(passwordFile, 'utf8').trim() }) });
  assert.equal(login.status, 200);
  const admin = { authorization: `Bearer ${(await login.json()).token}`, 'content-type': 'application/json' };
  const call = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  return {
    base,
    admin,
    call,
    logs: () => logs,
    async stop() {
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const dir of [home, runDir]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out.sort();
}

test('real hub: email core routes are dark by default, and safe mode keeps Brevo off the network', { timeout: 240_000 }, async (t) => {
  const dataDir = mainDataDir;
  seedDataDir(dataDir);
  const seededSites = readFileSync(join(dataDir, 'email-sites.json'), 'utf8');
  const hub = await bootHub({ codeRoot: repoRoot, dataDir });
  t.after(async () => {
    await hub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Off by default: every new public and CMS-facing route is 404 { code: 'disabled' }.
  for (const [method, path, body, type] of [
    ['GET', '/api/hub/email/unsubscribe?t=abc'],
    ['POST', '/api/hub/email/unsubscribe?t=abc', 'List-Unsubscribe=One-Click', 'application/x-www-form-urlencoded'],
    ['POST', '/api/hub/email/resubscribe?t=abc', 'from=page', 'application/x-www-form-urlencoded'],
    ['POST', '/api/hub/email/provision-request', '{}', 'application/json'],
    ['POST', '/api/hub/email/provision/confirm', '{}', 'application/json'],
    ['PUT', '/api/hub/email/owner-recipients', '{"emails":[],"actor":{"rank":"owner"}}', 'application/json'],
    ['POST', '/api/hub/email/owner-notify', '{"kind":"order"}', 'application/json'],
    ['GET', '/api/hub/email/owner-recipients/confirm?t=abc'],
    ['POST', '/api/hub/email/owner-recipients/confirm?t=abc', 'go=1', 'application/x-www-form-urlencoded'],
    ['GET', '/api/hub/email/owner-recipients/revert?t=abc'],
    ['POST', '/api/hub/email/owner-recipients/revert?t=abc', 'go=1', 'application/x-www-form-urlencoded'],
  ]) {
    const res = await hub.call(path, { method, ...(body ? { body, headers: { 'content-type': type, 'x-site-key': KEY_ONE } } : {}) });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.deepEqual(JSON.parse(res.text), { code: 'disabled' });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const emailFiles = listFiles(dataDir).filter((name) => /(^|\/)email-/.test(name));
  assert.deepEqual(emailFiles, ['email-sites.json'], 'the boot and the refused calls wrote no email data');
  assert.equal(readFileSync(join(dataDir, 'email-sites.json'), 'utf8'), seededSites);

  // Superadmin can preview the owner-routing default while everything is off.
  const preview = await hub.call('/api/admin/email/owner-routing/preview', { headers: hub.admin });
  assert.equal(preview.status, 200);
  const rows = JSON.parse(preview.text);
  assert.equal(rows.enabled, false);
  assert.deepEqual(rows.sites.map((row) => [row.siteId, row.action, row.reason]), [['site_boot_1', 'skip', 'not-listed'], ['site_boot_2', 'skip', 'already-set']]);
  const status = JSON.parse((await hub.call('/api/admin/email/status', { headers: hub.admin })).text);
  assert.equal(status.enabled, false);
  assert.equal(status.brevo.configured, true);
  assert.equal(listFiles(dataDir).filter((name) => /(^|\/)email-/.test(name)).length, 1, 'reads write nothing');

  // Switched on: a one-click unsubscribe is recorded; the list removal is a safe-mode intent.
  const put = await hub.call('/api/admin/email/settings', { method: 'PUT', headers: hub.admin, body: JSON.stringify({ enabled: true, rollout: { mode: 'allowlist', siteIds: ['site_boot_1'] }, brevo: { syncContacts: true } }) });
  assert.equal(put.status, 200, put.text);
  const { mintUnsubToken } = await import('../lib/email-unsubscribe.js');
  const token = mintUnsubToken({ siteId: 'site_boot_1', email: 'kunde@example.com', kind: 'welcome', messageId: 'em_boot' });
  const page = await hub.call(`/api/hub/email/unsubscribe?t=${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.text.includes('kunde@example.com'), false);
  const oneClick = await hub.call(`/api/hub/email/unsubscribe?t=${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.deepEqual([oneClick.status, oneClick.text], [200, 'unsubscribed']);
  const record = JSON.parse(readFileSync(join(dataDir, 'email-suppressions.json'), 'utf8'));
  assert.equal(record.site_boot_1['kunde@example.com'].source, 'one-click');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const intents = existsSync(join(dataDir, 'safe-mode', 'intents.jsonl')) ? readFileSync(join(dataDir, 'safe-mode', 'intents.jsonl'), 'utf8') : '';
  assert.match(intents, /remove 1 contact\(s\) from list 57/, 'the Brevo list removal became a safe-mode intent');
  assert.equal(/api\.brevo\.com|api\.sendinblue\.com/.test(intents), false, 'no connection to Brevo was even attempted');
  assert.equal(/api\.brevo\.com|api\.sendinblue\.com/.test(hub.logs()), false);
  assert.equal(hub.logs().includes('fake-brevo-key-for-boot-test'), false, 'the key is never logged');
});

function untar(buffer, destination) {
  let offset = 0;
  let paxPath = '';
  const text = (start, length) => buffer.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(offset, 100);
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(offset + 345, 155);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const match = body.toString('utf8').match(/\d+ path=([^\n]+)\n/);
      paxPath = match ? match[1] : '';
      continue;
    }
    if (type === 'g') continue;
    const path = paxPath || (prefix ? `${prefix}/${name}` : name);
    paxPath = '';
    if (path.includes('..')) throw new Error(`unsafe path in archive: ${path}`);
    const target = join(destination, path);
    if (type === '5') mkdirSync(target, { recursive: true });
    else if (type === '0' || type === '\0') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
  }
}

const compareRef = String(process.env.EMAIL_DARK_COMPARE_REF || '').trim();

test(`dark default: answers are byte-identical to ${compareRef || '(set EMAIL_DARK_COMPARE_REF)'}`, { timeout: 300_000, skip: compareRef ? false : 'EMAIL_DARK_COMPARE_REF is not set' }, async (t) => {
  const sha = execFileSync('git', ['rev-parse', '--short=12', `${compareRef}^{commit}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const codeRoot = join(repoRoot, 'build', `dark-compare-${sha}`);
  rmSync(codeRoot, { recursive: true, force: true });
  mkdirSync(codeRoot, { recursive: true });
  untar(execFileSync('git', ['archive', '--format=tar', sha], { cwd: repoRoot, maxBuffer: 512 * 1024 * 1024 }), codeRoot);
  const seed = mkdtempSync(join(tmpdir(), 'asoldi-email-dark-seed-'));
  seedDataDir(seed);
  const dirs = { ref: mkdtempSync(join(tmpdir(), 'asoldi-email-dark-ref-')), tree: mkdtempSync(join(tmpdir(), 'asoldi-email-dark-tree-')) };
  cpSync(seed, dirs.ref, { recursive: true });
  cpSync(seed, dirs.tree, { recursive: true });
  t.after(() => {
    for (const dir of [seed, dirs.ref, dirs.tree, codeRoot]) rmSync(dir, { recursive: true, force: true });
  });
  const requests = (h) => [
    ['site-config by key', `/api/hub/site-config?site_key=${KEY_ONE}`, {}],
    ['site-config by header', '/api/hub/site-config', { headers: { 'x-site-key': KEY_TWO } }],
    ['site-config by domain', '/api/hub/site-config?domain=boot-one.example.com', {}],
    ['site-config unknown', '/api/hub/site-config?site_key=nope', {}],
    ['cms config', '/api/cms/config', {}],
    ['owner routing 1', '/api/hub/sites/site_boot_1/owner-routing', { headers: h.admin }],
    ['owner routing 2', '/api/hub/sites/site_boot_2/owner-routing', { headers: h.admin }],
  ];
  const answers = {};
  for (const [label, root] of [['ref', codeRoot], ['tree', repoRoot]]) {
    const hub = await bootHub({ codeRoot: root, dataDir: dirs[label] });
    try {
      answers[label] = [];
      for (const [name, path, init] of requests(hub)) {
        const res = await hub.call(path, init);
        answers[label].push([name, res.status, res.text]);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      await hub.stop();
    }
  }
  assert.deepEqual(answers.tree, answers.ref);
  const by = Object.fromEntries(answers.tree.map(([name, status, text]) => [name, { status, text }]));
  assert.equal(by['site-config by key'].status, 200);
  assert.match(by['site-config by key'].text, /"name":"Boot One"/);
  assert.match(by['site-config by domain'].text, /"domain":"boot-one.example.com"/);
  assert.equal(by['site-config unknown'].status, 404);
  assert.match(by['owner routing 2'].text, /owner-two@example.com/, 'the comparison covers a site with owner routing');
  const emailFiles = (dir) => listFiles(dir).filter((name) => /(^|\/)email-/.test(name)).map((name) => [name, statSync(join(dir, name)).size]);
  assert.deepEqual(emailFiles(dirs.tree), emailFiles(dirs.ref), 'the same email data on disk');
  assert.equal(readFileSync(join(dirs.tree, 'email-sites.json'), 'utf8'), readFileSync(join(seed, 'email-sites.json'), 'utf8'));
});
