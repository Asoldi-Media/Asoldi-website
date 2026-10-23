// Rotation on the real hub (server.js), two processes on one data dir, 127.0.0.1 only:
// - a new signing secret refuses every admin, staff and client token signed before it, in the
//   process that rotated and in the other one within about a second;
// - a new Maker callback token refuses the old one in both processes;
// - with ADMIN_SECRET / a Maker token in the env, both rotations answer 409 and change nothing.
// Each child runs from an empty working folder (no .env), with the egress recorder enforcing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWLIST, AUDIT, REPO, freePort } from './safe-mode/hub-boot.mjs';

const ADMIN = 'rotation-admin';
const ADMIN_PASSWORD = `rotation-${Date.now()}-pw`;

async function startHub(dataDir, extraEnv = {}) {
  const port = await freePort();
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-rotation-cwd-'));
  const shell = { ...process.env };
  for (const key of Object.keys(shell)) {
    if (/^(HUB_SAFE_MODE|HUB_LISTEN_HOST|HOSTINGER|EMAIL_REDIRECT_TO|WEBSITE_MAKER_|SALES_MAKER_STATUS|SALES_PREVIEW_PUSH_URL|ADMIN_SECRET|AUTH_TOKEN_MAX_AGE_DAYS)/.test(key)) delete shell[key];
  }
  const child = spawn(process.execPath, [join(REPO, 'server.js')], {
    cwd: runDir,
    env: {
      ...shell,
      HUB_SAFE_MODE: '1',
      PERSIST_PRODUCTION_ENV: '0',
      ADMIN_USERNAME: ADMIN,
      ADMIN_PASSWORD,
      ...extraEnv,
      PORT: String(port),
      APP_DATA_DIR: dataDir,
      NODE_OPTIONS: `--require="${AUDIT}"`,
      EGRESS_AUDIT_FILE: join(dataDir, `egress-${port}.jsonl`),
      EGRESS_AUDIT_ALLOW: ALLOWLIST,
      EGRESS_AUDIT_ENFORCE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    up = await fetch(`${base}/api/health`).then((res) => res.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  return {
    base,
    log: () => log,
    up,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 600));
      if (child.exitCode === null) child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bearer = (token, init = {}) => ({ ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } });

async function adminLogin(hub) {
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${hub.base}/api/admin/login`, json({ username: ADMIN, password: ADMIN_PASSWORD })).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (body.token) return body.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`admin login failed:\n${hub.log().slice(-2000)}`);
}

async function waitUntil(check, what, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('two hub processes on one data dir: a rotation refuses every old token in both', { timeout: 240_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-rotation-boot-'));
  const a = await startHub(dataDir);
  t.after(async () => {
    await a.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  assert.ok(a.up, `hub A did not start:\n${a.log().slice(-3000)}`);
  const adminA = await adminLogin(a);
  // Hub B starts after the admin exists, so both share admin.json and the disk secrets.
  const b = await startHub(dataDir);
  t.after(() => b.stop());
  assert.ok(b.up, `hub B did not start:\n${b.log().slice(-3000)}`);
  const status = async (hub, path, token, headers = {}) => (await fetch(`${hub.base}${path}`, { headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } })).status;

  // A staff user (developer role) and a client portal user.
  const staffPassword = `staff-${Date.now()}-pw`;
  const created = await fetch(`${a.base}/api/admin/users`, bearer(adminA, json({ username: 'rotation-dev@example.com', password: staffPassword, role: 'developer' })));
  assert.equal(created.status, 201, await created.text());
  const staffToken = (await (await fetch(`${a.base}/api/auth/login`, json({ username: 'rotation-dev@example.com', password: staffPassword }))).json()).token;
  assert.ok(staffToken);
  const signup = await fetch(`${a.base}/api/client/auth/signup`, json({ email: 'rotation-client@example.com', password: 'rotation-client-pw-1' }));
  assert.equal(signup.status, 201);
  const clientToken = (await signup.json()).token;

  // Every token works in both processes before the rotation.
  for (const hub of [a, b]) {
    assert.equal(await status(hub, '/api/hub/sites', adminA), 200);
    assert.equal(await status(hub, '/myphoner-recordings/none.mp3', staffToken), 404, 'staff passes the media gate (file missing)');
    assert.equal(await status(hub, '/api/client/profile', clientToken), 200);
  }

  // Maker callback token: rotate in A; the old one stops in A at once and in B within a second or so.
  const oldMaker = (await (await fetch(`${a.base}/api/admin/system/maker-callback-token`, bearer(adminA))).json()).token;
  const callback = (hub, token) => status(hub, '/api/admin/sales/maker-status-callback', '', { 'x-sales-callback-token': token });
  assert.equal(await callback(a, oldMaker), 200);
  assert.equal(await callback(b, oldMaker), 200);
  const refused = await fetch(`${a.base}/api/admin/security/maker-callback-token/rotate`, bearer(adminA, json({ currentPassword: 'wrong', confirm: 'ROTER' })));
  assert.equal(refused.status, 401);
  assert.equal(await callback(a, oldMaker), 200, 'a refused rotation changes nothing');
  const makerRes = await fetch(`${a.base}/api/admin/security/maker-callback-token/rotate`, bearer(adminA, json({ currentPassword: ADMIN_PASSWORD, confirm: 'ROTER' })));
  assert.equal(makerRes.status, 200);
  const newMaker = (await makerRes.json()).callbackToken;
  assert.equal(readFileSync(join(dataDir, 'secrets', 'maker-callback-token'), 'utf8').trim(), newMaker);
  assert.equal(await callback(a, oldMaker), 401, 'old Maker token refused at once');
  assert.equal(await callback(a, newMaker), 200);
  const makerLag = await waitUntil(async () => (await callback(b, oldMaker)) === 401, 'hub B refuses the old Maker token');
  assert.equal(await callback(b, newMaker), 200);

  // Signing secret: rotate in A.
  const secretBefore = readFileSync(join(dataDir, 'secrets', 'admin-secret'), 'utf8').trim();
  const rotateRes = await fetch(`${a.base}/api/admin/security/signing-secret/rotate`, bearer(adminA, json({ currentPassword: ADMIN_PASSWORD, confirm: 'ROTER' })));
  assert.equal(rotateRes.status, 200);
  const rotated = await rotateRes.json();
  assert.ok(rotated.token);
  const secretAfter = readFileSync(join(dataDir, 'secrets', 'admin-secret'), 'utf8').trim();
  assert.notEqual(secretAfter, secretBefore);
  assert.equal(JSON.stringify(rotated).includes(secretAfter), false);

  // In A at once: admin, staff and client tokens are refused; the fresh admin token works.
  assert.equal(await status(a, '/api/hub/sites', adminA), 401, 'old admin token, process A');
  assert.equal(await status(a, '/myphoner-recordings/none.mp3', staffToken), 401, 'old staff token, process A');
  assert.equal(await status(a, '/api/client/profile', clientToken), 401, 'old client token, process A');
  assert.equal(await status(a, '/api/hub/sites', rotated.token), 200);
  // In B within about a second.
  const signLag = await waitUntil(async () => (await status(b, '/api/hub/sites', adminA)) === 401, 'hub B refuses the old admin token');
  assert.equal(await status(b, '/myphoner-recordings/none.mp3', staffToken), 401, 'old staff token, process B');
  assert.equal(await status(b, '/api/client/profile', clientToken), 401, 'old client token, process B');
  assert.equal(await status(b, '/api/hub/sites', rotated.token), 200, 'the fresh token works in B too');
  assert.ok(makerLag < 3000 && signLag < 3000, `lag ${makerLag} / ${signLag} ms`);

  // Everyone can sign in again; the new tokens work in both processes.
  const clientAgain = (await (await fetch(`${b.base}/api/client/auth/login`, json({ email: 'rotation-client@example.com', password: 'rotation-client-pw-1' }))).json()).token;
  assert.equal(await status(a, '/api/client/profile', clientAgain), 200);
  const staffAgain = (await (await fetch(`${b.base}/api/auth/login`, json({ username: 'rotation-dev@example.com', password: staffPassword }))).json()).token;
  assert.equal(await status(a, '/myphoner-recordings/none.mp3', staffAgain), 404);

  // The audit record and counters.
  const overview = await (await fetch(`${a.base}/api/admin/system/security`, bearer(rotated.token))).json();
  assert.equal(overview.secretRotations['admin-secret'].by, `admin:${ADMIN}`);
  assert.equal(overview.secretRotations['maker-callback-token'].by, `admin:${ADMIN}`);
  assert.equal(overview.counters['admin-secret-rotated'].total, 1);
  assert.match(a.log(), /\[security\] token signing secret rotated by admin:rotation-admin/);
  assert.equal(a.log().includes(secretAfter) || b.log().includes(secretAfter), false, 'the secret is never logged');
  assert.equal(a.log().includes(newMaker) || b.log().includes(newMaker), false, 'the Maker token is never logged');
  for (const hub of [a, b]) {
    const file = join(dataDir, `egress-${new URL(hub.base).port}.jsonl`);
    if (!existsSync(file)) continue;
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(rows.filter((row) => row.blocked), [], 'no blocked egress');
  }
});

test('env secrets win: both rotations answer 409 and change nothing', { timeout: 180_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-rotation-env-'));
  const envSecret = `env-signing-secret-${'x'.repeat(16)}-${Date.now()}`;
  const hub = await startHub(dataDir, { ADMIN_SECRET: envSecret, WEBSITE_MAKER_STATUS_CALLBACK_TOKEN: `env-maker-token-${Date.now()}` });
  t.after(async () => {
    await hub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  assert.ok(hub.up, `hub did not start:\n${hub.log().slice(-3000)}`);
  const admin = await adminLogin(hub);
  for (const [path, pattern] of [
    ['/api/admin/security/signing-secret/rotate', /ADMIN_SECRET fra miljøvariablene/],
    ['/api/admin/security/maker-callback-token/rotate', /WEBSITE_MAKER_STATUS_CALLBACK_TOKEN/],
  ]) {
    const res = await fetch(`${hub.base}${path}`, bearer(admin, json({ currentPassword: ADMIN_PASSWORD, confirm: 'ROTER' })));
    assert.equal(res.status, 409, path);
    const body = await res.json();
    assert.equal(body.code, 'secret-from-env');
    assert.match(body.message, pattern);
  }
  assert.equal((await fetch(`${hub.base}/api/hub/sites`, bearer(admin))).status, 200, 'the admin token still works');
  assert.equal(existsSync(join(dataDir, 'secrets', 'admin-secret')), false, 'no disk signing secret was made');
  const overview = await (await fetch(`${hub.base}/api/admin/system/security`, bearer(admin))).json();
  assert.equal(overview.adminSecretSource, 'env');
  assert.equal(overview.makerCallbackTokenSource, 'env');
  assert.deepEqual(overview.secretRotations, {});
});
