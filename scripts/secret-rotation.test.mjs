// Rotation of the token signing secret (<dataDir>/secrets/admin-secret) and the Maker callback
// token (<dataDir>/secrets/maker-callback-token) from Admin → Security, without FTP or a deploy.
// Temp data dirs only; every value here is generated at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-rotation-'));
process.env.APP_DATA_DIR = dataDir;
process.env.PERSIST_PRODUCTION_ENV = '0';

const hardening = await import('../lib/auth-hardening.js');
const settings = await import('../data/security-settings.js');
const routes = await import('../lib/security-admin-routes.js');
const counters = await import('../lib/security-counters.js');

const temps = [dataDir];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-rotation-'));
  temps.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const fileValue = (dir, name) => readFileSync(join(dir, 'secrets', name), 'utf8').trim();

test('rotateDiskSecret replaces the file in one step and returns the new value', () => {
  const dir = tempDir();
  const first = hardening.readOrCreateDiskSecret(dir, 'admin-secret');
  const next = hardening.rotateDiskSecret(dir, 'admin-secret');
  assert.match(next, /^[0-9a-f]{96}$/);
  assert.notEqual(next, first);
  assert.equal(fileValue(dir, 'admin-secret'), next);
  // readOrCreateDiskSecret now returns the rotated value (a restart keeps it).
  assert.equal(hardening.readOrCreateDiskSecret(dir, 'admin-secret'), next);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(dir, 'secrets', 'admin-secret')).mode & 0o777, 0o600);
  }
  assert.throws(() => hardening.rotateDiskSecret(dir, '../escape'));
  // No temp or lock files are left behind.
  const left = readFileSync(join(dir, 'secrets', 'admin-secret'), 'utf8');
  assert.equal(left, `${next}\n`);
});

test('holder: rotate() takes effect in this process at once and in another process within refreshMs', () => {
  const dir = tempDir();
  let clockA = 1_000_000;
  let clockB = 1_000_000;
  const a = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret', now: () => clockA });
  const b = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret', now: () => clockB });
  assert.equal(a.source, 'disk');
  const before = a.get();
  assert.equal(b.get(), before, 'both processes start from the same disk secret');
  const after = a.rotate();
  assert.notEqual(after, before);
  assert.equal(a.get(), after, 'this process: at once');
  clockB += 500;
  assert.equal(b.get(), before, 'the other process re-reads at most once per refreshMs');
  clockB += 600;
  assert.equal(b.get(), after, 'the other process follows within a second');

  // A damaged or missing file never replaces a good value in memory.
  writeFileSync(join(dir, 'secrets', 'admin-secret'), 'short\n');
  clockA += 2000;
  assert.equal(a.get(), after);
  rmSync(join(dir, 'secrets', 'admin-secret'));
  clockA += 2000;
  assert.equal(a.get(), after);
});

test('holder: env wins for signing secrets unless it is a default or too short; env tokens are never rotated', () => {
  const dir = tempDir();
  const strong = `env-${'k'.repeat(20)}-${Date.now()}`;
  const env = hardening.createHubSecretHolder({ envValue: strong, dataDir: dir, name: 'admin-secret' });
  assert.equal(env.source, 'env');
  assert.equal(env.get(), strong);
  assert.throws(() => env.rotate(), (error) => error.code === hardening.SECRET_FROM_ENV);
  assert.equal(env.get(), strong);
  for (const [value, reason] of [['change-me-in-production', 'known-default'], ['short-value', 'too-short']]) {
    const holder = hardening.createHubSecretHolder({ envValue: value, dataDir: dir, name: 'admin-secret' });
    assert.equal(holder.source, 'disk');
    assert.equal(holder.envRejected, reason);
    assert.notEqual(holder.get(), value);
  }
  // Shared tokens (envRule any): any non-empty env value wins, and the disk file is made lazily.
  const lazyDir = tempDir();
  const fromEnv = hardening.createHubSecretHolder({ envValue: 'x', envRule: 'any', lazy: true, dataDir: lazyDir, name: 'maker-callback-token', bytes: 32 });
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.get(), 'x');
  assert.throws(() => fromEnv.rotate(), (error) => error.code === hardening.SECRET_FROM_ENV);
  const lazy = hardening.createHubSecretHolder({ envRule: 'any', lazy: true, dataDir: lazyDir, name: 'maker-callback-token', bytes: 32 });
  assert.throws(() => statSync(join(lazyDir, 'secrets', 'maker-callback-token')), 'not created before first use');
  assert.match(lazy.get(), /^[0-9a-f]{64}$/);
  assert.equal(fileValue(lazyDir, 'maker-callback-token'), lazy.get());
});

test('security-settings keeps a rotation record (when and who, never a value)', () => {
  const dir = tempDir();
  const at = Date.parse('2026-10-23T12:00:00Z');
  const next = settings.recordSecretRotation('admin-secret', { dataDir: dir, by: 'admin:tester', now: at });
  assert.deepEqual(next.secretRotations['admin-secret'], { at: '2026-10-23T12:00:00.000Z', by: 'admin:tester' });
  // Other writers keep it (the record survives a token-settings change and a boot migration).
  settings.updateSecuritySettings({ maxTokenAgeDays: 7 }, { dataDir: dir, by: 'admin:tester' });
  settings.runSecurityBootMigrations({ dataDir: dir });
  const read = settings.readSecuritySettings({ dataDir: dir });
  assert.equal(read.secretRotations['admin-secret'].by, 'admin:tester');
  assert.throws(() => settings.recordSecretRotation('webhooks.json', { dataDir: dir }));
});

// ------------------------------------------------------------------ routes (a small express app)

const PASSWORD = `pw-${Date.now()}`;

function sign(secret, payload) {
  const data = JSON.stringify(payload);
  return Buffer.from(JSON.stringify({ data, sig: createHmac('sha256', secret).update(data).digest('hex') })).toString('base64url');
}

async function withApp({ adminSecretHolder, makerCallbackTokenHolder }, fn) {
  const app = express();
  app.use(express.json());
  // The real hub verifies with the holder's current value, like server.js verifyToken.
  const verify = (token) => {
    try {
      const raw = JSON.parse(Buffer.from(token, 'base64url').toString());
      const expect = createHmac('sha256', adminSecretHolder.get()).update(String(raw.data)).digest('hex');
      return hardening.safeEqual(expect, raw.sig) ? JSON.parse(raw.data) : null;
    } catch {
      return null;
    }
  };
  const adminAuth = (req, res, next) => {
    const payload = verify(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!payload || payload.role !== 'admin') return res.status(401).json({ message: 'Unauthorized' });
    req.admin = payload;
    return next();
  };
  const clientAuth = (_req, res) => res.status(401).json({ message: 'Unauthorized' });
  const limiter = hardening.createLoginLimiter();
  const confirmAdminPassword = async (req, res, password) => {
    const account = `admin:${req.admin.username}`;
    if (!hardening.guardLogin(limiter, req, res, account)) return false;
    if (password !== PASSWORD) {
      limiter.fail(account, '127.0.0.1');
      res.status(401).json({ code: 'wrong-password', message: 'Feil passord.' });
      return false;
    }
    return true;
  };
  routes.registerSecurityAdminRoutes(app, {
    adminAuth,
    clientAuth,
    signToken: (payload) => sign(adminSecretHolder.get(), payload),
    adminSecret: { source: adminSecretHolder.source, envRejected: adminSecretHolder.envRejected },
    adminSecretHolder,
    makerCallbackTokenHolder,
    confirmAdminPassword,
    env: {},
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, { adminToken: () => sign(adminSecretHolder.get(), { role: 'admin', username: 'tester', at: Date.now() }) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, path, token, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body ?? {}),
});

test('routes: rotation needs an admin, the word ROTER and the current password; old tokens stop at once', async () => {
  counters.resetSecurityCounters();
  const dir = tempDir();
  const adminSecretHolder = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret' });
  const makerCallbackTokenHolder = hardening.createHubSecretHolder({ envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 });
  // The default data dir of security-settings.js is this file's APP_DATA_DIR.
  await withApp({ adminSecretHolder, makerCallbackTokenHolder }, async (base, { adminToken }) => {
    const oldAdmin = adminToken();
    const oldSecret = adminSecretHolder.get();
    const oldMaker = makerCallbackTokenHolder.get();
    const good = { currentPassword: PASSWORD, confirm: 'ROTER' };
    for (const path of ['/api/admin/security/signing-secret/rotate', '/api/admin/security/maker-callback-token/rotate']) {
      assert.equal((await post(base, path, '', good)).status, 401, `${path} without a token`);
      assert.equal((await post(base, path, sign('not-the-secret-at-all-000', { role: 'admin', username: 'x', at: Date.now() }), good)).status, 401);
      const noWord = await post(base, path, oldAdmin, { currentPassword: PASSWORD });
      assert.equal(noWord.status, 400);
      assert.match((await noWord.json()).message, /Skriv ROTER/);
      assert.equal((await post(base, path, oldAdmin, { currentPassword: PASSWORD, confirm: 'ja' })).status, 400);
      const wrong = await post(base, path, oldAdmin, { currentPassword: 'wrong-password', confirm: 'ROTER' });
      assert.equal(wrong.status, 401);
      assert.equal((await wrong.json()).message, 'Feil passord.');
      assert.equal((await post(base, path, oldAdmin, { confirm: 'ROTER' })).status, 401, 'no password');
    }
    assert.equal(adminSecretHolder.get(), oldSecret, 'nothing rotated by refused requests');
    assert.equal(makerCallbackTokenHolder.get(), oldMaker);

    // Maker callback token: shown once, no-store, the old one stops at once.
    const makerRes = await post(base, '/api/admin/security/maker-callback-token/rotate', oldAdmin, { currentPassword: PASSWORD, confirm: ' roter ' });
    assert.equal(makerRes.status, 200);
    assert.equal(makerRes.headers.get('cache-control'), 'no-store');
    const maker = await makerRes.json();
    assert.equal('token' in maker, false, 'never a "token" field the admin UI would store as its login');
    assert.match(maker.callbackToken, /^[0-9a-f]{64}$/);
    assert.notEqual(maker.callbackToken, oldMaker);
    assert.equal(makerCallbackTokenHolder.get(), maker.callbackToken);
    assert.equal(fileValue(dir, 'maker-callback-token'), maker.callbackToken);
    assert.deepEqual(maker.envKeys, ['WEBSITE_MAKER_STATUS_CALLBACK_TOKEN', 'SALES_MAKER_STATUS_CALLBACK_TOKEN']);
    assert.ok(maker.rotatedAt);

    // Signing secret: the old admin token is refused, the response carries a fresh one.
    const signingRes = await post(base, '/api/admin/security/signing-secret/rotate', oldAdmin, good);
    assert.equal(signingRes.status, 200);
    assert.equal(signingRes.headers.get('cache-control'), 'no-store');
    const signing = await signingRes.json();
    const text = JSON.stringify(signing);
    assert.equal(text.includes(adminSecretHolder.get()), false, 'the secret itself is never returned');
    assert.notEqual(adminSecretHolder.get(), oldSecret);
    assert.equal(fileValue(dir, 'admin-secret'), adminSecretHolder.get());
    const status = (token) => fetch(`${base}/api/admin/system/security`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await status(oldAdmin)).status, 401, 'old admin token refused');
    const overviewRes = await status(signing.token);
    assert.equal(overviewRes.status, 200, 'fresh token works');
    const overview = await overviewRes.json();
    assert.equal(overview.secretRotations['admin-secret'].by, 'admin:tester');
    assert.equal(overview.secretRotations['maker-callback-token'].by, 'admin:tester');
    assert.equal(overview.rotateConfirmWord, 'ROTER');
    assert.equal(overview.makerCallbackTokenSource, 'disk');
    assert.equal(overview.counters['admin-secret-rotated'].total, 1);
    assert.equal(overview.counters['maker-callback-token-rotated'].total, 1);
    assert.equal(JSON.stringify(overview).includes(adminSecretHolder.get()), false);
    assert.equal(JSON.stringify(overview).includes(maker.callbackToken), false);
  });
});

test('routes: an env secret wins, so rotation answers 409 with a Norwegian explanation', async () => {
  const dir = tempDir();
  const envSecret = `env-signing-${'q'.repeat(24)}`;
  const adminSecretHolder = hardening.createHubSecretHolder({ envValue: envSecret, dataDir: dir, name: 'admin-secret' });
  const makerCallbackTokenHolder = hardening.createHubSecretHolder({ envValue: 'env-maker-token', envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 });
  await withApp({ adminSecretHolder, makerCallbackTokenHolder }, async (base, { adminToken }) => {
    const token = adminToken();
    const signing = await post(base, '/api/admin/security/signing-secret/rotate', token, { currentPassword: PASSWORD, confirm: 'ROTER' });
    assert.equal(signing.status, 409);
    const body = await signing.json();
    assert.equal(body.code, 'secret-from-env');
    assert.match(body.message, /ADMIN_SECRET fra miljøvariablene/);
    assert.equal(body.message, routes.SIGNING_SECRET_FROM_ENV_MESSAGE);
    const maker = await post(base, '/api/admin/security/maker-callback-token/rotate', token, { currentPassword: PASSWORD, confirm: 'ROTER' });
    assert.equal(maker.status, 409);
    assert.match((await maker.json()).message, /WEBSITE_MAKER_STATUS_CALLBACK_TOKEN/);
    assert.equal(adminSecretHolder.get(), envSecret);
    assert.equal(makerCallbackTokenHolder.get(), 'env-maker-token');
    assert.throws(() => statSync(join(dir, 'secrets', 'admin-secret')), 'no disk secret was made');
  });
});

test('routes: wrong passwords count toward the login limit', async () => {
  const dir = tempDir();
  const adminSecretHolder = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret' });
  const makerCallbackTokenHolder = hardening.createHubSecretHolder({ envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 });
  await withApp({ adminSecretHolder, makerCallbackTokenHolder }, async (base, { adminToken }) => {
    const token = adminToken();
    const statuses = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await post(base, '/api/admin/security/signing-secret/rotate', token, { currentPassword: `guess-${i}`, confirm: 'ROTER' })).status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses[10], 429);
    // Even the right password waits for the window now.
    assert.equal((await post(base, '/api/admin/security/signing-secret/rotate', token, { currentPassword: PASSWORD, confirm: 'ROTER' })).status, 429);
  });
});
