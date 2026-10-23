// WS0.2 (rest): token age from the data dir, revokedBefore per class, per-user tokenVersion,
// and env secrets that are known defaults or too short are ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-token-revocation-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.AUTH_TOKEN_MAX_AGE_DAYS;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const policy = await import('../lib/token-policy.js');
const settings = await import('../data/security-settings.js');
const hardening = await import('../lib/auth-hardening.js');
const store = await import('../data/store.js');
const { windowsAccountName } = await import('../data/private-dir.js');

const DAY = 24 * 60 * 60 * 1000;
const NO_ENV = {};

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

// The same composition server.js uses: HMAC over the stamped payload, then isTokenAccepted.
const SECRET = 'test-signing-secret-0123456789abcdef';
function sign(payload) {
  const data = JSON.stringify(policy.stampTokenVersion(payload));
  const sig = createHmac('sha256', SECRET).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64url');
}
function verify(token, now = Date.now()) {
  const raw = JSON.parse(Buffer.from(token, 'base64url').toString());
  const expect = createHmac('sha256', SECRET).update(String(raw.data)).digest('hex');
  if (!hardening.safeEqual(expect, raw.sig)) return null;
  const payload = JSON.parse(raw.data);
  return policy.isTokenAccepted(payload, { now, env: NO_ENV }) ? payload : null;
}

test('subjects and role classes', () => {
  assert.equal(policy.tokenSubject({ role: 'client', userId: 'abc' }), 'u:abc');
  assert.equal(policy.tokenSubject({ role: 'sales', userId: 7 }), 'u:7');
  assert.equal(policy.tokenSubject({ role: 'admin', username: 'Asoldi.com' }), 'admin:asoldi.com');
  assert.equal(policy.tokenSubject({ role: 'sales' }), '');
  assert.equal(policy.tokenRoleClass({ role: 'admin' }), 'admin');
  assert.equal(policy.tokenRoleClass({ role: 'client' }), 'client');
  assert.equal(policy.tokenRoleClass({ role: 'developer' }), 'staff');
});

test('a never-revoked user gets no tv, so old and new tokens look the same', () => {
  const payload = { role: 'client', userId: 'fresh-user', at: Date.now() };
  assert.deepEqual(policy.stampTokenVersion(payload), payload);
  assert.ok(verify(sign(payload)));
});

test('client "log out everywhere" refuses every older token and accepts new ones', () => {
  const before = sign({ role: 'client', userId: 'client-1', at: Date.now() - 1000 });
  const otherUser = sign({ role: 'client', userId: 'client-2', at: Date.now() - 1000 });
  assert.ok(verify(before));
  const version = policy.logoutSubjectEverywhere({ role: 'client', userId: 'client-1' });
  assert.equal(version, 1);
  assert.equal(verify(before), null);
  assert.ok(verify(otherUser), 'other users stay logged in');
  const after = sign({ role: 'client', userId: 'client-1', at: Date.now() });
  const payload = verify(after);
  assert.equal(payload.tv, 1);
  // A forged tv cannot help: the signature covers it, and a lower tv is refused.
  assert.equal(policy.isTokenAccepted({ role: 'client', userId: 'client-1', at: Date.now(), tv: 0 }, { env: NO_ENV }), false);
  policy.logoutSubjectEverywhere('u:client-1');
  assert.equal(verify(after), null);
});

test('revokedBefore per class: client scope logs out clients only; all logs out everyone', () => {
  const t0 = Date.now() - 5000;
  const client = sign({ role: 'client', userId: 'c-scope', at: t0 });
  const staff = sign({ role: 'sales', userId: 's-scope', at: t0 });
  const admin = sign({ role: 'admin', username: 'asoldi.com', at: t0 });
  settings.revokeTokensBefore('client', { by: 'test' });
  assert.equal(verify(client), null);
  assert.ok(verify(staff));
  assert.ok(verify(admin));
  assert.ok(verify(sign({ role: 'client', userId: 'c-scope', at: Date.now() })), 'new client logins work');
  settings.revokeTokensBefore('all', { by: 'test' });
  assert.equal(verify(staff), null);
  assert.equal(verify(admin), null);
  assert.equal(policy.tokenRevocationReason({ role: 'sales', userId: 's', at: t0 }), 'revoked-all');
  assert.ok(verify(sign({ role: 'admin', username: 'asoldi.com', at: Date.now() })));
});

test('max token age comes from security-settings.json, env overrides, default 30 days', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-token-age-'));
  try {
    const now = Date.now();
    const opts = (env = NO_ENV) => ({ now, env, dataDir: dir });
    const twoDaysOld = { role: 'sales', userId: 'age', at: now - 2 * DAY };
    assert.equal(policy.isTokenAccepted(twoDaysOld, opts()), true);
    settings.updateSecuritySettings({ maxTokenAgeDays: 1 }, { by: 'test', dataDir: dir });
    assert.equal(policy.effectiveTokenMaxAge({ env: NO_ENV, dataDir: dir }).source, 'data');
    assert.equal(policy.isTokenAccepted(twoDaysOld, opts()), false);
    assert.equal(policy.isTokenAccepted(twoDaysOld, opts({ AUTH_TOKEN_MAX_AGE_DAYS: '3' })), true);
    settings.updateSecuritySettings({ maxTokenAgeDays: null }, { by: 'test', dataDir: dir });
    assert.equal(policy.effectiveTokenMaxAge({ env: NO_ENV, dataDir: dir }).source, 'default');
    assert.equal(policy.isTokenAccepted({ role: 'sales', userId: 'age', at: now - 31 * DAY }, opts()), false);
    assert.equal(policy.isTokenAccepted({ role: 'sales', userId: 'age', at: now - 29 * DAY }, opts()), true);
    assert.throws(() => settings.updateSecuritySettings({ maxTokenAgeDays: -2 }, { dataDir: dir }));
    assert.throws(() => settings.revokeTokensBefore('everyone', { dataDir: dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a password change, role change, deletion or deactivation logs the user out everywhere', async () => {
  const created = await store.createUser('revoke-me@example.com', 'first-password-1', 'client');
  assert.equal(created.ok, true);
  const id = created.user.id;
  const subject = `u:${id}`;
  const token = sign({ role: 'client', userId: id, at: Date.now() });
  assert.ok(verify(token));
  await store.updateUserPassword(id, 'second-password-2');
  assert.equal(settings.subjectTokenVersion(subject), 1);
  assert.equal(verify(token), null);

  const afterReset = sign({ role: 'client', userId: id, at: Date.now() });
  await store.updateUserRole(id, 'client');
  assert.equal(settings.subjectTokenVersion(subject), 1, 'same role: no logout');
  await store.updateUserRole(id, 'sales');
  assert.equal(settings.subjectTokenVersion(subject), 2);
  assert.equal(verify(afterReset), null);

  await store.deactivateUserKeepingData(id, 'test');
  assert.equal(settings.subjectTokenVersion(subject), 3);
  await store.deleteUser(id);
  assert.equal(settings.subjectTokenVersion(subject), 4);
  const revocations = JSON.parse(readFileSync(join(dataDir, 'token-revocations.json'), 'utf8'));
  assert.equal(revocations.subjects[subject].reason, 'deleted');
});

test('env secrets that are public defaults or shorter than 16 characters are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-hub-secret-'));
  try {
    const known = hardening.resolveHubSecret({ envValue: 'change-me-in-production', dataDir: dir, name: 'admin-secret' });
    assert.equal(known.source, 'disk');
    assert.equal(known.envRejected, 'known-default');
    assert.notEqual(known.secret, 'change-me-in-production');
    const short = hardening.resolveHubSecret({ envValue: 'short-secret', dataDir: dir, name: 'admin-secret' });
    assert.equal(short.source, 'disk');
    assert.equal(short.envRejected, 'too-short');
    assert.equal(short.secret, known.secret, 'same disk secret both times');
    const good = hardening.resolveHubSecret({ envValue: 'a-long-enough-env-secret-value', dataDir: dir, name: 'admin-secret' });
    assert.deepEqual(good, { secret: 'a-long-enough-env-secret-value', source: 'env', envRejected: '' });
    const none = hardening.resolveHubSecret({ envValue: '', dataDir: dir, name: 'admin-secret' });
    assert.equal(none.envRejected, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hub processes booting at once produce one admin secret', async () => {
  for (let round = 0; round < 3; round += 1) {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-hub-secret-race-'));
  try {
    const moduleUrl = pathToFileURL(join(repoRoot, 'lib', 'auth-hardening.js')).href;
    const script = `const m = await import(${JSON.stringify(moduleUrl)});
      const r = m.resolveHubSecret({ envValue: '', dataDir: process.env.RACE_DIR, name: 'admin-secret' });
      const { createHash } = await import('node:crypto');
      process.stdout.write(createHash('sha256').update(r.secret).digest('hex'));`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, RACE_DIR: dir } });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    });
    const hashes = await Promise.all(Array.from({ length: 8 }, run));
    assert.equal(new Set(hashes).size, 1);
    const stored = readFileSync(join(dir, 'secrets', 'admin-secret'), 'utf8').trim();
    assert.equal(createHash('sha256').update(stored).digest('hex'), hashes[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  }
});

// ------------------------------------------------------------------ admin password, boot migration

test('changing the hub admin password logs the admin out everywhere (old and new username)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-admin-pw-'));
  try {
    // store.js binds its admin.json path at import, so it runs in a child with its own data dir.
    const script = `
      const store = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'data', 'store.js')).href)});
      const settings = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'data', 'security-settings.js')).href)});
      const out = {};
      await store.setAdminCredentials('Asoldi.com', 'first-admin-password');
      out.afterCreate = settings.subjectTokenVersion('admin:asoldi.com');
      await store.setAdminCredentials('Asoldi.com', 'second-admin-password');
      out.afterChange = settings.subjectTokenVersion('admin:asoldi.com');
      await store.setAdminCredentials('new-admin', 'third-admin-password');
      out.oldName = settings.subjectTokenVersion('admin:asoldi.com');
      out.newName = settings.subjectTokenVersion('admin:new-admin');
      process.stdout.write(JSON.stringify(out));`;
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, APP_DATA_DIR: dir } });
      let text = '';
      let err = '';
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(text)) : reject(new Error(`exit ${code}: ${err}`))));
    });
    assert.deepEqual(out, { afterCreate: 0, afterChange: 1, oldName: 2, newName: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an admin token from before a password change is refused; the fresh one works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-admin-tv-'));
  try {
    const opts = { env: NO_ENV, dataDir: dir };
    const before = policy.stampTokenVersion({ role: 'admin', username: 'Asoldi.com', at: Date.now() }, { dataDir: dir });
    assert.equal(policy.isTokenAccepted(before, opts), true);
    settings.bumpSubjectTokenVersion(settings.adminSubject('ASOLDI.COM'), { dataDir: dir, reason: 'admin-password-changed' });
    assert.equal(policy.isTokenAccepted(before, opts), false);
    const fresh = policy.stampTokenVersion({ role: 'admin', username: 'asoldi.com', at: Date.now() }, { dataDir: dir });
    assert.equal(fresh.tv, 1);
    assert.equal(policy.isTokenAccepted(fresh, opts), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot migration: admin and staff tokens from before the first boot die once; clients and later logins are fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-boot-migration-'));
  try {
    const bootAt = Date.now();
    const opts = { env: NO_ENV, dataDir: dir, now: bootAt + 10 };
    const oldAdmin = { role: 'admin', username: 'asoldi.com', at: bootAt - 60_000 };
    const oldStaff = { role: 'sales', userId: 's-old', at: bootAt - 60_000 };
    const oldClient = { role: 'client', userId: 'c-old', at: bootAt - 60_000 };
    const logs = [];
    const log = { log: (line) => logs.push(line), warn: (line) => logs.push(line) };
    assert.deepEqual(policy.runTokenPolicyBootMigrations({ dataDir: dir, now: bootAt, log }), [settings.ADMIN_SESSION_RESET_MIGRATION]);
    assert.match(logs[0], /one-time migration adminSessionReset2026_10/);
    assert.equal(policy.isTokenAccepted(oldAdmin, opts), false);
    assert.equal(policy.isTokenAccepted(oldStaff, opts), false);
    assert.equal(policy.isTokenAccepted(oldClient, opts), true, 'client portal sessions are not touched');
    assert.equal(policy.isTokenAccepted({ role: 'admin', username: 'asoldi.com', at: bootAt + 5 }, opts), true);

    // A later boot (restart, second process) does nothing: tokens issued since stay valid.
    const second = policy.runTokenPolicyBootMigrations({ dataDir: dir, now: bootAt + 3_600_000, log });
    assert.deepEqual(second, []);
    assert.equal(policy.isTokenAccepted({ role: 'admin', username: 'asoldi.com', at: bootAt + 5 }, { ...opts, now: bootAt + 3_600_000 }), true);
    const stored = JSON.parse(readFileSync(join(dir, 'security-settings.json'), 'utf8'));
    assert.equal(stored.migrations.adminSessionReset2026_10, new Date(bootAt).toISOString());
    assert.equal(stored.revokedBefore.admin, new Date(bootAt).toISOString());
    assert.equal(stored.revokedBefore.client, null);
    assert.equal(stored.updatedBy, 'boot-migration');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot migration never moves a later cutoff backwards and keeps other settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-boot-migration-'));
  try {
    const later = Date.now() + 60_000;
    settings.updateSecuritySettings({ maxTokenAgeDays: 7 }, { dataDir: dir, by: 'test' });
    settings.revokeTokensBefore('admin', { dataDir: dir, by: 'test', now: later });
    settings.runSecurityBootMigrations({ dataDir: dir, now: later - 30_000 });
    const after = settings.readSecuritySettings({ dataDir: dir });
    assert.equal(after.revokedBefore.admin, new Date(later).toISOString());
    assert.equal(after.revokedBefore.staff, new Date(later - 30_000).toISOString());
    assert.equal(after.maxTokenAgeDaysStored, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs `body` (module source using `m`, the imported module) in N processes that start together. */
function runInProcesses(n, modulePath, body, env) {
  const moduleUrl = pathToFileURL(join(repoRoot, modulePath)).href;
  const script = `const m = await import(${JSON.stringify(moduleUrl)});
    const wait = Number(process.env.START_AT) - Date.now();
    if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    ${body}`;
  const startAt = String(Date.now() + 1500);
  return Promise.all(Array.from({ length: n }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...env, START_AT: startAt, INDEX: String(index) },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
  })));
}

test('processes booting together run the boot migration exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-boot-migration-race-'));
  try {
    const outs = await runInProcesses(6, 'data/security-settings.js',
      'process.stdout.write(JSON.stringify(m.runSecurityBootMigrations({ dataDir: process.env.RACE_DIR })));',
      { RACE_DIR: dir });
    const ran = outs.map((text) => JSON.parse(text)).filter((names) => names.length);
    assert.equal(ran.length, 1, `ran in ${ran.length} processes`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('"log out everywhere" and revocations in several processes at once lose nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-revocation-race-'));
  try {
    // Each process first reads the file (warming its 1-second cache), then writes.
    await runInProcesses(6, 'data/security-settings.js', `
      m.subjectTokenVersion('u:warm', { dataDir: process.env.RACE_DIR });
      m.readSecuritySettings({ dataDir: process.env.RACE_DIR });
      for (let i = 0; i < 5; i += 1) m.bumpSubjectTokenVersion('u:' + process.env.INDEX, { dataDir: process.env.RACE_DIR });
      m.revokeTokensBefore(['all', 'admin', 'staff', 'client'][Number(process.env.INDEX) % 4], { dataDir: process.env.RACE_DIR, by: 'p' + process.env.INDEX });`,
    { RACE_DIR: dir });
    const subjects = JSON.parse(readFileSync(join(dir, 'token-revocations.json'), 'utf8')).subjects;
    assert.deepEqual(Object.keys(subjects).sort(), ['u:0', 'u:1', 'u:2', 'u:3', 'u:4', 'u:5']);
    for (const row of Object.values(subjects)) assert.equal(row.tokenVersion, 5);
    const revoked = JSON.parse(readFileSync(join(dir, 'security-settings.json'), 'utf8')).revokedBefore;
    for (const scope of ['all', 'admin', 'staff', 'client']) assert.ok(revoked[scope], `revokedBefore.${scope} kept`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ file permissions

test('secret and policy files are private: 0600 files and a 0700 folder on POSIX, a user-only ACL on Windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-modes-'));
  try {
    hardening.readOrCreateDiskSecret(dir, 'admin-secret');
    settings.revokeTokensBefore('client', { dataDir: dir, by: 'test' });
    settings.bumpSubjectTokenVersion('u:mode', { dataDir: dir });
    const files = [
      join(dir, 'secrets', 'admin-secret'),
      join(dir, 'security-settings.json'),
      join(dir, 'token-revocations.json'),
    ];
    if (process.platform !== 'win32') {
      for (const file of files) assert.equal(statSync(file).mode & 0o777, 0o600, file);
      assert.equal(statSync(join(dir, 'secrets')).mode & 0o777, 0o700);
      return;
    }
    // icacls prints the path first; only the entries after it matter.
    const acl = (path) => execFileSync('icacls', [path], { encoding: 'utf8' }).slice(path.length);
    const broad = /Everyone|BUILTIN\\Users|Authenticated Users|BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM/i;
    const folderAcl = acl(join(dir, 'secrets'));
    const fileAcl = acl(files[0]);
    for (const text of [folderAcl, fileAcl]) {
      assert.doesNotMatch(text, broad);
      assert.match(text, new RegExp(`${process.env.USERNAME}:\\(`, 'i'));
    }
    assert.match(folderAcl, /\(OI\)\(CI\)\(F\)/);
    // A secret written later inherits the same single entry.
    const later = join(dir, 'secrets', 'later');
    writeFileSync(later, 'x');
    assert.doesNotMatch(acl(later), broad);
    assert.match(acl(later), /:\(I\)\(F\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ locks and other processes

test('a token signed right after a revocation in another process is not refused a second later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-stamp-fresh-'));
  try {
    const subject = 'u:fresh-sign';
    settings.bumpSubjectTokenVersion('u:other', { dataDir: dir });
    // This process caches token-revocations.json (version 0 for the subject) for one second.
    assert.equal(settings.subjectTokenVersion(subject, { dataDir: dir }), 0);
    const moduleUrl = pathToFileURL(join(repoRoot, 'data/security-settings.js')).href;
    execFileSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(moduleUrl)}); m.bumpSubjectTokenVersion(${JSON.stringify(subject)}, { dataDir: ${JSON.stringify(dir)} });`]);
    // Signed in this process while its cache still says version 0.
    const stamped = policy.stampTokenVersion({ userId: 'fresh-sign', role: 'client', at: Date.now() }, { dataDir: dir });
    assert.equal(stamped.tv, 1, 'signing reads the revocation the other process wrote');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(policy.tokenRevocationReason(stamped, { dataDir: dir }), '', 'still accepted once the cache refreshes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder that refuses the lock file makes a locked write fail fast instead of hanging the hub', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-lock-denied-'));
  const account = process.platform === 'win32' ? windowsAccountName() : '';
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (process.platform !== 'win32' && isRoot) {
    rmSync(dir, { recursive: true, force: true });
    return; // root ignores folder modes; the Linux run uses a non-root user
  }
  try {
    if (process.platform === 'win32') execFileSync('icacls', [dir, '/deny', `${account}:(W)`, '/Q'], { stdio: 'ignore' });
    else chmodSync(dir, 0o500);
    const atomicUrl = pathToFileURL(join(repoRoot, 'data/atomic-json.js')).href;
    const policyUrl = pathToFileURL(join(repoRoot, 'lib/token-policy.js')).href;
    // In a child with a hard timeout: the old code spun here forever.
    const script = `
      const atomic = await import(${JSON.stringify(atomicUrl)});
      const policy = await import(${JSON.stringify(policyUrl)});
      const dir = ${JSON.stringify(dir)};
      const out = {};
      let t = Date.now();
      try { atomic.updateJsonLocked(dir + '/security-settings.json', () => ({ a: 1 })); out.write = 'wrote'; }
      catch (error) { out.write = error.code || error.message; }
      out.writeMs = Date.now() - t;
      t = Date.now();
      out.boot = policy.runTokenPolicyBootMigrations({ dataDir: dir, log: { log() {}, warn() {} } });
      out.bootMs = Date.now() - t;
      process.stdout.write(JSON.stringify(out));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.signal, null, `the locked write hung (killed): ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.ok(['EPERM', 'EACCES'].includes(out.write), JSON.stringify(out));
    assert.ok(out.writeMs < 3000, `took ${out.writeMs} ms`);
    assert.deepEqual(out.boot, [], 'the boot migration gives up without stopping the hub');
    assert.ok(out.bootMs < 3000, `boot took ${out.bootMs} ms`);
  } finally {
    try {
      if (process.platform === 'win32') execFileSync('icacls', [dir, '/remove:d', account, '/Q'], { stdio: 'ignore' });
      else chmodSync(dir, 0o700);
    } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
