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

test('security-settings keeps a capped rotation history, newest first', () => {
  const dir = tempDir();
  const start = Date.parse('2026-10-23T12:00:00Z');
  const limit = settings.SECRET_ROTATION_HISTORY_LIMIT;
  for (let i = 0; i < limit + 5; i += 1) {
    const name = i % 2 ? 'maker-callback-token' : 'admin-secret';
    settings.recordSecretRotation(name, { dataDir: dir, by: `admin:a${i}`, now: start + i * 60_000 });
  }
  const read = settings.readSecuritySettings({ dataDir: dir });
  assert.equal(read.secretRotationHistory.length, limit);
  assert.deepEqual(read.secretRotationHistory[0], { name: 'admin-secret', at: new Date(start + (limit + 4) * 60_000).toISOString(), by: `admin:a${limit + 4}` });
  assert.equal(read.secretRotationHistory[1].name, 'maker-callback-token');
  assert.equal(read.secretRotationHistory.at(-1).by, 'admin:a5', 'the oldest rows are dropped');
  // The latest-per-secret record and the history agree; other writers keep the history.
  assert.equal(read.secretRotations['admin-secret'].at, read.secretRotationHistory[0].at);
  settings.updateSecuritySettings({ maxTokenAgeDays: 3 }, { dataDir: dir, by: 'admin:tester' });
  assert.equal(settings.readSecuritySettings({ dataDir: dir }).secretRotationHistory.length, limit);
  // Junk rows in the file are dropped, never shown (a fresh folder: reads are cached per file).
  const raw = JSON.parse(readFileSync(join(dir, 'security-settings.json'), 'utf8'));
  raw.secretRotationHistory = [{ name: 'webhooks.json', at: raw.secretRotationHistory[0].at }, { name: 'admin-secret', at: 'not a date' }, 'x', null, ...raw.secretRotationHistory.slice(0, 2)];
  const junkDir = tempDir();
  writeFileSync(join(junkDir, 'security-settings.json'), JSON.stringify(raw));
  const cleaned = settings.readSecuritySettings({ dataDir: junkDir }).secretRotationHistory;
  assert.equal(cleaned.length, 2);
  assert.equal(JSON.stringify(cleaned).includes('webhooks.json'), false);
});

test('holder: get({ fresh: true }) re-reads the file at once, at most once per freshMs', () => {
  const dir = tempDir();
  let clockA = 5_000_000;
  let clockB = 5_000_000;
  const a = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret', now: () => clockA });
  const b = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret', now: () => clockB });
  const before = b.get();
  const after = a.rotate();
  assert.equal(b.get(), before, 'a plain get waits for refreshMs');
  assert.equal(b.get({ fresh: true }), after, 'a fresh get reads the file now');
  // Rate limit: a second rotation right after is only seen by a fresh get once freshMs has passed.
  const third = a.rotate();
  clockB += 50;
  assert.equal(b.get({ fresh: true }), after, 'within freshMs no second read');
  clockB += 60;
  assert.equal(b.get({ fresh: true }), third);

  // checkWithFreshSecret: one re-read on a mismatch, and only a changed value is tried again.
  clockA += 10_000;
  const c = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret', now: () => clockA });
  const tried = [];
  const fourth = a.rotate();
  clockA += 1; // c read the file 1 ms ago, so a plain get still has the old value
  assert.equal(hardening.checkWithFreshSecret(c, (secret) => { tried.push(secret); return secret === fourth; }), true);
  assert.deepEqual(tried, [third, fourth]);
  tried.length = 0;
  clockA += 1000;
  assert.equal(hardening.checkWithFreshSecret(c, (secret) => { tried.push(secret); return false; }), false);
  assert.deepEqual(tried, [fourth], 'unchanged after the re-read: not tried twice');

  // The re-read interval: 1 s unless a test sets HUB_SECRET_REFRESH_MS (100 ms to one hour).
  assert.equal(hardening.secretRefreshMs({}), 1000);
  assert.equal(hardening.secretRefreshMs({ HUB_SECRET_REFRESH_MS: '600000' }), 600_000);
  for (const value of ['', '5', '99', 'abc', '3600001', '-1']) {
    assert.equal(hardening.secretRefreshMs({ HUB_SECRET_REFRESH_MS: value }), 1000, value);
  }
});

test('holder: a clock that steps back an hour still re-reads the file (injected clock)', () => {
  const dir = tempDir();
  let clock = 9_000_000;
  const reader = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret', now: () => clock });
  const writer = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret', now: () => 0 });
  const before = reader.get();
  clock -= 3_600_000;
  const after = writer.rotate();
  assert.notEqual(after, before);
  assert.equal(reader.get(), after, 'a step back counts as a re-read being due, not as an hour to wait');
  // From the new time on, the normal interval applies again.
  const third = writer.rotate();
  clock += 500;
  assert.equal(reader.get(), after, 'within refreshMs of the last read: no read');
  clock += 600;
  assert.equal(reader.get(), third);
  // The rate limit of fresh reads also restarts after a step back.
  const fourth = writer.rotate();
  clock -= 10_000;
  assert.equal(reader.get({ fresh: true }), fourth);
});

test('holder: the default clock is monotonic, so a wall-clock step back neither pauses nor floods the re-reads', async () => {
  const dir = tempDir();
  const reader = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret', refreshMs: 300 });
  const writer = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret' });
  const before = reader.get();
  const wallClock = Date.now;
  Date.now = () => wallClock() - 3_600_000;
  try {
    const after = writer.rotate();
    assert.equal(reader.get(), before, 'within refreshMs of the last read: no read, whatever the wall clock says');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(reader.get(), after, 'refreshMs later the rotation is picked up');
  } finally {
    Date.now = wallClock;
  }
  assert.equal(typeof hardening.monotonicMs(), 'number');
});

test('password confirmer: wrong passwords count toward the limit, the right one clears them', async () => {
  const limiter = hardening.createLoginLimiter();
  const confirm = hardening.createPasswordConfirmer({
    limiter,
    accountFor: (req) => `admin:${req.admin.username}`,
    verifyPassword: async (_req, password) => password === PASSWORD,
  });
  const attempt = async (password) => {
    const res = {
      statusCode: 200,
      body: null,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    const ok = await confirm({ admin: { username: 'tester' }, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res, password);
    return ok ? 'ok' : res.statusCode;
  };
  const statuses = [];
  for (let i = 0; i < 9; i += 1) statuses.push(await attempt(`guess-${i}`));
  statuses.push(await attempt(PASSWORD));
  for (let i = 0; i < 9; i += 1) statuses.push(await attempt(`again-${i}`));
  assert.deepEqual(statuses, [...Array(9).fill(401), 'ok', ...Array(9).fill(401)], 'the right password resets the count');
  assert.equal(await attempt(PASSWORD), 'ok');
  // Without a right password in between, the 11th try is refused with 429 (even the right one).
  for (let i = 0; i < 10; i += 1) assert.equal(await attempt(`more-${i}`), 401);
  assert.equal(await attempt(PASSWORD), 429);
  for (const empty of ['', undefined, null, 42]) assert.notEqual(await attempt(empty), 'ok');
});

test('password confirmer: password checks that start together are counted at once, and a check that throws stays counted without blocking the next', async () => {
  const limiter = hardening.createLoginLimiter({ log: () => {} });
  const fakeRes = () => ({
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const req = { admin: { username: 'tester' }, headers: { 'x-forwarded-for': '203.0.113.30' }, socket: { remoteAddress: '127.0.0.1' } };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = hardening.createPasswordConfirmer({
    limiter,
    accountFor: (r) => `admin:${r.admin.username}`,
    verifyPassword: async () => { await gate; return false; },
  });
  const responses = Array.from({ length: 12 }, fakeRes);
  const pending = responses.map((res) => slow(req, res, 'wrong'));
  release();
  await Promise.all(pending);
  const codes = responses.map((res) => res.statusCode);
  assert.equal(codes.filter((code) => code === 401).length, 2, `two checks ran, the rest waited: ${codes}`);
  assert.equal(codes.filter((code) => code === 429).length, 10);
  assert.equal(limiter.running(), 0);

  const throwing = hardening.createPasswordConfirmer({
    limiter,
    accountFor: (r) => `admin:${r.admin.username}`,
    verifyPassword: async () => { throw new Error('store read failed'); },
  });
  for (let i = 0; i < 3; i += 1) await assert.rejects(throwing(req, fakeRes(), 'pw'), /store read failed/, `attempt ${i} is checked, not refused as busy`);
  assert.equal(limiter.running(), 0, 'a check that threw no longer runs');
  const counted = fakeRes();
  for (let i = 0; i < 5; i += 1) await slow(req, fakeRes(), 'wrong');
  assert.equal(await slow(req, counted, 'wrong'), false);
  assert.equal(counted.statusCode, 429, 'two failures, three checks that threw and five failures fill the ten tries of that address');
});

// ------------------------------------------------------------------ routes (a small express app)

const PASSWORD = `pw-${Date.now()}`;

function sign(secret, payload) {
  const data = JSON.stringify(payload);
  return Buffer.from(JSON.stringify({ data, sig: createHmac('sha256', secret).update(data).digest('hex') })).toString('base64url');
}

async function withApp({ adminSecretHolder, makerCallbackTokenHolder, recordRotation, loginLimiter, canConfirm, verifyPassword }, fn) {
  const app = express();
  app.use(express.json());
  // The real hub verifies with the holder's current value, like server.js verifyToken.
  const verify = (token) => {
    try {
      const raw = JSON.parse(Buffer.from(token, 'base64url').toString());
      const ok = hardening.checkWithFreshSecret(adminSecretHolder, (secret) =>
        hardening.safeEqual(createHmac('sha256', secret).update(String(raw.data)).digest('hex'), raw.sig));
      return ok ? JSON.parse(raw.data) : null;
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
  // The same confirmer server.js uses, with a fixed password.
  const confirmAdminPassword = hardening.createPasswordConfirmer({
    limiter: loginLimiter || hardening.createLoginLimiter(),
    accountFor: (req) => `admin:${req.admin.username}`,
    verifyPassword: verifyPassword || (async (_req, password) => password === PASSWORD),
    ...(canConfirm ? { canConfirm } : {}),
  });
  routes.registerSecurityAdminRoutes(app, {
    ...(loginLimiter ? { loginLimiter } : {}),
    adminAuth,
    clientAuth,
    signToken: (payload) => sign(adminSecretHolder.get(), payload),
    adminSecret: { source: adminSecretHolder.source, envRejected: adminSecretHolder.envRejected },
    adminSecretHolder,
    makerCallbackTokenHolder,
    confirmAdminPassword,
    ...(recordRotation ? { recordRotation } : {}),
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
  // A route that never answers fails the test instead of hanging it.
  signal: AbortSignal.timeout(10_000),
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
    assert.deepEqual(overview.secretRotationHistory.slice(0, 2).map((row) => [row.name, row.by]), [['admin-secret', 'admin:tester'], ['maker-callback-token', 'admin:tester']]);
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

test('routes: a right password after wrong ones resets the count, as a sign-in does', async () => {
  const dir = tempDir();
  const adminSecretHolder = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret' });
  const makerCallbackTokenHolder = hardening.createHubSecretHolder({ envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 });
  await withApp({ adminSecretHolder, makerCallbackTokenHolder }, async (base, { adminToken }) => {
    const path = '/api/admin/security/maker-callback-token/rotate';
    const token = adminToken();
    const statuses = [];
    for (let i = 0; i < 9; i += 1) statuses.push((await post(base, path, token, { currentPassword: `guess-${i}`, confirm: 'ROTER' })).status);
    statuses.push((await post(base, path, token, { currentPassword: PASSWORD, confirm: 'ROTER' })).status);
    for (let i = 0; i < 9; i += 1) statuses.push((await post(base, path, token, { currentPassword: `again-${i}`, confirm: 'ROTER' })).status);
    assert.deepEqual(statuses, [...Array(9).fill(401), 200, ...Array(9).fill(401)]);
  });
});

test('routes: when the rotation record cannot be saved, the answer still carries the new token', async () => {
  const dir = tempDir();
  const adminSecretHolder = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret' });
  const makerCallbackTokenHolder = hardening.createHubSecretHolder({ envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 });
  const recordRotation = () => {
    throw Object.assign(new Error('lock timeout'), { code: 'ELOCKED' });
  };
  const errors = [];
  const savedError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await withApp({ adminSecretHolder, makerCallbackTokenHolder, recordRotation }, async (base, { adminToken }) => {
      const oldSecret = adminSecretHolder.get();
      const oldMaker = makerCallbackTokenHolder.get();
      const good = { currentPassword: PASSWORD, confirm: 'ROTER' };
      const makerRes = await post(base, '/api/admin/security/maker-callback-token/rotate', adminToken(), good);
      assert.equal(makerRes.status, 200);
      assert.equal(makerRes.headers.get('cache-control'), 'no-store');
      const maker = await makerRes.json();
      assert.equal(maker.auditSaved, false);
      assert.equal(maker.callbackToken, makerCallbackTokenHolder.get(), 'the one-time token is shown');
      assert.notEqual(maker.callbackToken, oldMaker);
      assert.ok(maker.rotatedAt);

      const oldAdmin = adminToken();
      const signingRes = await post(base, '/api/admin/security/signing-secret/rotate', oldAdmin, good);
      assert.equal(signingRes.status, 200);
      const signing = await signingRes.json();
      assert.equal(signing.auditSaved, false);
      assert.notEqual(adminSecretHolder.get(), oldSecret);
      const status = (token) => fetch(`${base}/api/admin/system/security`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal((await status(oldAdmin)).status, 401);
      assert.equal((await status(signing.token)).status, 200, 'the admin keeps a working login');
    });
  } finally {
    console.error = savedError;
  }
  assert.equal(errors.filter((line) => /rotation record could not be saved: ELOCKED/.test(line)).length, 2, errors.join('\n'));
  assert.equal(errors.join('\n').includes(adminSecretHolder.get()), false, 'no secret in the log');
});

test('routes: the security status shows where login addresses come from, never an address', async () => {
  const dir = tempDir();
  const adminSecretHolder = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret' });
  const makerCallbackTokenHolder = hardening.createHubSecretHolder({ envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 });
  const lines = [];
  const loginLimiter = hardening.createLoginLimiter({ log: (line) => lines.push(line) });
  await withApp({ adminSecretHolder, makerCallbackTokenHolder, loginLimiter }, async (base, { adminToken }) => {
    const token = adminToken();
    const status = async () => (await fetch(`${base}/api/admin/system/security`, { headers: { authorization: `Bearer ${token}` } })).json();
    const before = await status();
    assert.equal(before.loginAddressMode, 'none');
    assert.equal(before.loginAddresses.distinctLastHour, 0);
    for (const client of ['203.0.113.1', '203.0.113.2', '203.0.113.2']) {
      const res = await fetch(`${base}/api/admin/security/maker-callback-token/rotate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-forwarded-for': client },
        body: JSON.stringify({ currentPassword: 'wrong-password', confirm: 'ROTER' }),
      });
      assert.equal(res.status, 401);
    }
    const after = await status();
    assert.equal(after.loginAddressMode, 'forwarded');
    assert.deepEqual(after.loginAddresses, {
      mode: 'forwarded',
      modesLastHour: { forwarded: 3 },
      attemptsLastHour: 3,
      distinctLastHour: 2,
      hopFromRight: 1,
      peer: 'internal',
      trustedHops: null,
      processId: process.pid,
      processStartedAt: after.loginAddresses.processStartedAt,
    });
    const startedAt = Date.parse(after.loginAddresses.processStartedAt);
    assert.ok(startedAt <= Date.now() && Date.now() - startedAt < 24 * 60 * 60 * 1000, 'the figures name the process that answered');
    assert.equal(before.loginAddresses.processStartedAt, after.loginAddresses.processStartedAt);
    assert.equal(JSON.stringify(after).includes('203.0.113.'), false, 'no address in the status');
  });
  assert.equal(lines.length, 1);
  assert.equal(/203\.0\.113\./.test(lines[0]), false, 'no address in the log');
});

test('routes: an admin sets the trusted proxy hops; the setting survives other writes and changes the counted address', async () => {
  const { createHubLoginLimiter, readLoginTrustedHops } = await import('../lib/login-limits.js');
  const dir = tempDir();
  const adminSecretHolder = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret' });
  const makerCallbackTokenHolder = hardening.createHubSecretHolder({ envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 });
  // The routes write security-settings.json in this file's APP_DATA_DIR (dataDir).
  const loginLimiter = createHubLoginLimiter({ dataDir, log: () => {} });
  const viaCdn = { headers: { 'x-forwarded-for': '198.51.100.1, 192.0.2.50' }, socket: { remoteAddress: '127.0.0.1' } };
  try {
    await withApp({ adminSecretHolder, makerCallbackTokenHolder, loginLimiter }, async (base, { adminToken }) => {
      const token = adminToken();
      const put = (body, auth = token) => fetch(`${base}/api/admin/security/login-address`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify({ currentPassword: PASSWORD, ...body }),
      });
      assert.equal((await put({ trustedHops: 2 }, '')).status, 401, 'admins only');
      assert.equal((await put({})).status, 400, 'the field is required');
      for (const bad of [0, 6, 2.5, '2.5', 'x', true, -1]) {
        const res = await put({ trustedHops: bad });
        assert.equal(res.status, 400, String(bad));
        assert.match((await res.json()).message, /whole number from 1 to 5/);
      }
      assert.equal(loginLimiter.addressOf(viaCdn), '192.0.2.50', 'default: the right-most public entry');

      const set = await put({ trustedHops: 2 });
      assert.equal(set.status, 200);
      const body = await set.json();
      assert.equal(body.trustedHops, 2);
      assert.equal(body.loginAddresses.trustedHops, 2);
      assert.equal(settings.readSecuritySettings().loginTrustedHops, 2);
      assert.equal(readLoginTrustedHops(dataDir), 2);
      assert.equal(loginLimiter.addressOf(viaCdn), '198.51.100.1', 'two trusted public hops: the client behind the second proxy');

      // Other writers keep the setting.
      settings.updateSecuritySettings({ maxTokenAgeDays: 9 }, { by: 'admin:tester' });
      settings.recordSecretRotation('admin-secret', { by: 'admin:tester' });
      settings.revokeTokensBefore('client', { by: 'admin:tester', now: Date.now() - 60_000 });
      assert.equal(settings.readSecuritySettings().loginTrustedHops, 2);
      assert.equal(settings.readSecuritySettings().maxTokenAgeDays, 9);

      assert.equal((await (await put({ trustedHops: ' 3 ' })).json()).trustedHops, 3);
      const reset = await (await put({ trustedHops: null })).json();
      assert.equal(reset.trustedHops, null);
      assert.equal(loginLimiter.addressOf(viaCdn), '192.0.2.50', 'back to the default');
      const overview = await (await fetch(`${base}/api/admin/system/security`, { headers: { authorization: `Bearer ${token}` } })).json();
      assert.equal(overview.loginAddresses.trustedHops, null);
      assert.equal(overview.tokens.maxTokenAgeDays, 9);
    });
  } finally {
    settings.updateSecuritySettings({ maxTokenAgeDays: null, loginTrustedHops: null }, { by: 'admin:tester' });
  }
});

test('routes: only the hub admin sets the trusted proxy hops, with the current password; wrong passwords count toward the login limits', async () => {
  const dir = tempDir();
  const adminSecretHolder = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret' });
  const makerCallbackTokenHolder = hardening.createHubSecretHolder({ envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 });
  const loginLimiter = hardening.createLoginLimiter({ log: () => {} });
  const hubAdmin = { username: 'tester' };
  const canConfirm = async (req) => hardening.isHubAdminPayload(req.admin, hubAdmin);
  let checks = 0;
  const verifyPassword = async (_req, password) => {
    checks += 1;
    return password === PASSWORD;
  };
  // The route writes security-settings.json in this file's APP_DATA_DIR (dataDir).
  const stored = () => settings.readSecuritySettings().loginTrustedHops;
  try {
    await withApp({ adminSecretHolder, makerCallbackTokenHolder, loginLimiter, canConfirm, verifyPassword }, async (base, { adminToken }) => {
      const put = (token, body, address = '203.0.113.20') => fetch(`${base}/api/admin/security/login-address`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-forwarded-for': address },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(stored(), null);

      // Any other admin token gets 403 before any password check, even with the right password.
      const usersJsonAdmin = sign(adminSecretHolder.get(), { role: 'admin', userId: 'u-7', username: 'tester', at: Date.now() });
      const otherAdmin = sign(adminSecretHolder.get(), { role: 'admin', username: 'someone-else', at: Date.now() });
      for (const [label, token] of [['users.json admin', usersJsonAdmin], ['another username', otherAdmin]]) {
        for (let i = 0; i < 12; i += 1) {
          const res = await put(token, { trustedHops: 2, currentPassword: i % 3 ? `guess-${i}` : PASSWORD });
          assert.equal(res.status, 403, `${label} attempt ${i}`);
          const body = await res.json();
          assert.equal(body.code, 'hub-admin-only');
          assert.equal(body.message, hardening.HUB_ADMIN_ONLY_MESSAGE);
        }
      }
      assert.equal(checks, 0, 'no password was checked');
      assert.deepEqual(loginLimiter.keys(), [], 'no limiter key counted the refusals');
      assert.equal(stored(), null, 'nothing stored');

      // The hub admin: a missing or wrong password gets 401 and counts toward the login limits.
      const token = adminToken();
      const missing = await put(token, { trustedHops: 2 });
      assert.equal(missing.status, 401);
      assert.equal((await missing.json()).code, 'wrong-password');
      for (let i = 0; i < 9; i += 1) {
        const wrong = await put(token, { trustedHops: 2, currentPassword: `wrong-${i}` });
        assert.equal(wrong.status, 401, `wrong password ${i}`);
        assert.equal((await wrong.json()).message, 'Feil passord.');
      }
      assert.ok(loginLimiter.keys().length > 0, 'the wrong passwords are counted');
      const limited = await put(token, { trustedHops: 2, currentPassword: PASSWORD });
      assert.equal(limited.status, 429, 'ten failures from one address: that address waits, right password or not');
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      assert.equal(stored(), null, 'nothing stored');

      // The right password from an address that is not limited gets 200 and stores the value.
      const set = await put(token, { trustedHops: 2, currentPassword: PASSWORD }, '203.0.113.21');
      assert.equal(set.status, 200);
      assert.equal(set.headers.get('cache-control'), 'no-store');
      const setBody = await set.json();
      assert.equal(setBody.trustedHops, 2);
      assert.equal(stored(), 2);

      // A value outside 1–5 is refused as before, before any password check; null is the default.
      const checksBefore = checks;
      for (const bad of [0, 6, 2.5, '2.5', 'x', true, -1, {}, []]) {
        for (const body of [{ trustedHops: bad, currentPassword: PASSWORD }, { trustedHops: bad }]) {
          const res = await put(token, body, '203.0.113.21');
          assert.equal(res.status, 400, JSON.stringify(body));
          assert.match((await res.json()).message, /whole number from 1 to 5/);
        }
      }
      assert.equal(checks, checksBefore, 'a bad value never reaches the password check');
      assert.equal(stored(), 2, 'a bad value changes nothing');
      const reset = await put(token, { trustedHops: null, currentPassword: PASSWORD }, '203.0.113.21');
      assert.equal(reset.status, 200);
      assert.equal((await reset.json()).trustedHops, null);
      assert.equal(stored(), null);
    });
  } finally {
    settings.updateSecuritySettings({ loginTrustedHops: null }, { by: 'admin:tester' });
  }
});

test('password confirmer: a signed-in user that may not confirm gets 403 before any password check, and no limiter key counts it', async () => {
  const limiter = hardening.createLoginLimiter({ log: () => {} });
  const hubAdmin = { username: 'tester', passwordHash: 'x' };
  let checks = 0;
  const confirm = hardening.createPasswordConfirmer({
    limiter,
    accountFor: (req) => `admin:${req.admin.username}`,
    verifyPassword: async (_req, password) => {
      checks += 1;
      return password === PASSWORD;
    },
    canConfirm: async (req) => hardening.isHubAdminPayload(req.admin, hubAdmin),
  });
  const attempt = async (admin, password) => {
    const res = {
      statusCode: 200,
      body: null,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    const ok = await confirm({ admin, headers: { 'x-forwarded-for': '203.0.113.4' }, socket: { remoteAddress: '127.0.0.1' } }, res, password);
    return ok ? 'ok' : `${res.statusCode} ${res.body?.code || ''}`.trim();
  };
  const usersJsonAdmin = { role: 'admin', userId: 'u-1', username: 'tester' };
  for (let i = 0; i < 15; i += 1) {
    assert.equal(await attempt(usersJsonAdmin, i % 2 ? PASSWORD : `guess-${i}`), `403 ${hardening.HUB_ADMIN_ONLY_CODE}`, `attempt ${i}`);
  }
  assert.equal(await attempt({ role: 'admin', username: 'someone-else' }, PASSWORD), '403 hub-admin-only', 'an admin token for another username');
  assert.equal(checks, 0, 'no password was checked');
  assert.deepEqual(limiter.keys(), [], 'no limiter key counted the refusals');
  assert.equal(await attempt({ role: 'admin', username: 'tester' }, 'wrong'), '401 wrong-password');
  assert.equal(await attempt({ role: 'admin', username: 'tester' }, PASSWORD), 'ok', 'the hub admin confirms as before');

  for (const [payload, admin, expected] of [
    [{ role: 'admin', username: 'tester' }, hubAdmin, true],
    [{ role: 'Admin', username: 'tester' }, hubAdmin, true],
    [{ role: 'admin', username: 'tester', userId: 'u-1' }, hubAdmin, false],
    [{ role: 'admin', username: 'tester', userId: 0 }, hubAdmin, false],
    [{ role: 'admin', username: 'Tester' }, hubAdmin, false],
    [{ role: 'sales', username: 'tester' }, hubAdmin, false],
    [{ role: 'admin', username: '' }, { username: '' }, false],
    [{ role: 'admin', username: 'tester' }, null, false],
    [null, hubAdmin, false],
  ]) {
    assert.equal(hardening.isHubAdminPayload(payload, admin), expected, JSON.stringify([payload, admin]));
  }
});

test('routes: an admin token of a users.json user cannot rotate; it gets 403 and never reaches the login limits', async () => {
  const dir = tempDir();
  const adminSecretHolder = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret' });
  const makerCallbackTokenHolder = hardening.createHubSecretHolder({ envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 });
  const loginLimiter = hardening.createLoginLimiter({ log: () => {} });
  const hubAdmin = { username: 'tester' };
  const canConfirm = async (req) => hardening.isHubAdminPayload(req.admin, hubAdmin);
  await withApp({ adminSecretHolder, makerCallbackTokenHolder, loginLimiter, canConfirm }, async (base, { adminToken }) => {
    const usersJsonAdmin = sign(adminSecretHolder.get(), { role: 'admin', userId: 'u-7', username: 'tester', at: Date.now() });
    const oldSecret = adminSecretHolder.get();
    const oldMaker = makerCallbackTokenHolder.get();
    for (const path of ['/api/admin/security/signing-secret/rotate', '/api/admin/security/maker-callback-token/rotate']) {
      for (let i = 0; i < 12; i += 1) {
        const res = await post(base, path, usersJsonAdmin, { currentPassword: i % 3 ? `guess-${i}` : PASSWORD, confirm: 'ROTER' });
        assert.equal(res.status, 403, `${path} attempt ${i}`);
        const body = await res.json();
        assert.equal(body.code, 'hub-admin-only');
        assert.equal(body.message, hardening.HUB_ADMIN_ONLY_MESSAGE);
      }
    }
    assert.deepEqual(loginLimiter.keys(), [], 'no limiter key counted the refusals');
    assert.equal(adminSecretHolder.get(), oldSecret, 'nothing rotated');
    assert.equal(makerCallbackTokenHolder.get(), oldMaker);
    const good = { currentPassword: PASSWORD, confirm: 'ROTER' };
    assert.equal((await post(base, '/api/admin/security/maker-callback-token/rotate', adminToken(), good)).status, 200, 'the hub admin still rotates');
  });
});
