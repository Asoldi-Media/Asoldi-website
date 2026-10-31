// The disk secret store (data/secret-store.js): reads every secret from where it lives, creates one
// only when no file exists, never replaces or moves a file, and keeps permissions best effort.
//
// Every value below is fake, made in the test.
//
//   node --test scripts/secret-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const dataDirForModules = mkdtempSync(join(tmpdir(), 'secret-store-modules-'));
process.env.APP_DATA_DIR = dataDirForModules;

const store = await import('../data/secret-store.js');
const hardening = await import('../lib/auth-hardening.js');
const webhookSecrets = await import('../data/webhook-secrets.js');
const cmsSso = await import('../lib/cms-sso.js');
const privateDir = await import('../data/private-dir.js');

test.after(() => rmSync(dataDirForModules, { recursive: true, force: true }));

const hex = (bytes) => randomBytes(bytes).toString('hex');

/** A data dir shaped like the live one: every secret file the hub keeps today, with fake values. */
function prodLikeLayout() {
  const dir = mkdtempSync(join(tmpdir(), 'secret-store-prod-like-'));
  const secrets = join(dir, 'secrets');
  mkdirSync(secrets, { recursive: true });
  const values = {
    'admin-secret': hex(48),
    'maker-callback-token': hex(32),
    'initial-admin-password': hex(18),
    'email-unsub-key': hex(32),
    'email-webhook-token': hex(24),
  };
  for (const [name, value] of Object.entries(values)) writeFileSync(join(secrets, name), `${value}\n`, { mode: 0o600 });
  const webhooks = {
    version: 1,
    fireflies: { secret: hex(32), token: randomBytes(24).toString('base64url'), acceptQueryToken: true, rotatedAt: '2026-10-20T10:00:00.000Z', lastVerified: null },
  };
  writeFileSync(join(secrets, 'webhooks.json'), `${JSON.stringify(webhooks, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(secrets, 'email-secrets.json'), `${JSON.stringify({ brevoApiKey: 'fake-pasted-key', siteKeys: {} }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(secrets, 'email-suppressions-created'), '2026-10-20T10:00:00.000Z\n', { mode: 0o600 });
  mkdirSync(join(dir, 'cms-sso'), { recursive: true });
  writeFileSync(join(dir, 'cms-sso', 'tokens.json'), '{"version":1,"tokens":{}}\n');
  mkdirSync(join(dir, 'site-credentials'), { recursive: true });
  writeFileSync(join(dir, 'site-credentials', 'credentials.json'), '{"version":1,"sites":{}}\n');
  writeFileSync(join(dir, 'sales-clients.json'), '[]\n');
  return { dir, values, webhooks };
}

/** rel path → sha256 of every file under dir. */
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const HUB_SECRET_BYTES = {
  'admin-secret': 48,
  'maker-callback-token': 32,
  'initial-admin-password': 18,
  'email-unsub-key': 32,
  'email-webhook-token': 24,
};

/** Every read the hub does at boot and on first use, against `dir`. */
function readEverySecret(dir) {
  const read = {};
  for (const [name, bytes] of Object.entries(HUB_SECRET_BYTES)) read[name] = hardening.readOrCreateDiskSecret(dir, name, bytes);
  read.fireflies = webhookSecrets.ensureFirefliesWebhookSecrets({ dataDir: dir });
  cmsSso.createCmsSsoStore({ dataDir: dir }).tokensPath();
  return read;
}

test('a prod-like data dir: every secret reads byte-identical and no file is added or changed', () => {
  const { dir, values, webhooks } = prodLikeLayout();
  try {
    const before = snapshot(dir);
    const read = readEverySecret(dir);
    for (const [name, value] of Object.entries(values)) assert.equal(read[name], value, name);
    assert.deepEqual(read.fireflies, webhooks.fireflies);
    for (const name of Object.keys(values)) assert.equal(store.secretStoreFor(dir).read(name), values[name]);
    // A second boot reads the same values again.
    assert.deepEqual(readEverySecret(dir), read);
    assert.deepEqual(snapshot(dir), before, 'no secret file was created, replaced or moved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('negative control: removing one secret file creates exactly that one file and logs it', () => {
  const { dir, values } = prodLikeLayout();
  try {
    rmSync(join(dir, 'secrets', 'email-webhook-token'));
    const before = snapshot(dir);
    const logs = [];
    const local = store.createSecretStore({ dataDir: dir, log: (line) => logs.push(String(line)) });
    const read = {};
    for (const [name, bytes] of Object.entries(HUB_SECRET_BYTES)) read[name] = local.readOrCreate(name, { bytes });
    const after = snapshot(dir);
    const added = Object.keys(after).filter((rel) => !(rel in before));
    assert.deepEqual(added, ['secrets/email-webhook-token']);
    for (const rel of Object.keys(before)) assert.equal(after[rel], before[rel], `${rel} unchanged`);
    assert.match(read['email-webhook-token'], /^[0-9a-f]{48}$/);
    for (const name of Object.keys(values).filter((n) => n !== 'email-webhook-token')) assert.equal(read[name], values[name]);
    const created = logs.filter((line) => line.includes('created'));
    assert.deepEqual(created, ['[secret-store] created secrets/email-webhook-token']);
    assert.ok(!logs.join('\n').includes(read['email-webhook-token']), 'the value is never logged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy path is read where it is; only its removal makes a new file at the store path', () => {
  const { dir } = prodLikeLayout();
  try {
    mkdirSync(join(dir, 'old-keys'), { recursive: true });
    const legacyValue = hex(32);
    writeFileSync(join(dir, 'old-keys', 'thing.key'), `${legacyValue}\n`);
    const logs = [];
    const local = store.createSecretStore({ dataDir: dir, log: (line) => logs.push(String(line)) });
    const before = snapshot(dir);
    assert.equal(local.readOrCreate('thing-key', { legacyPaths: ['old-keys/thing.key'] }), legacyValue);
    assert.equal(local.read('thing-key', { legacyPaths: ['old-keys/thing.key'] }), legacyValue);
    assert.deepEqual(snapshot(dir), before, 'the legacy file is neither copied nor moved');
    assert.equal(existsSync(join(dir, 'secrets', 'thing-key')), false);
    assert.deepEqual(logs, []);

    rmSync(join(dir, 'old-keys', 'thing.key'));
    const created = local.readOrCreate('thing-key', { legacyPaths: ['old-keys/thing.key'] });
    assert.notEqual(created, legacyValue);
    assert.equal(readFileSync(join(dir, 'secrets', 'thing-key'), 'utf8').trim(), created);
    assert.deepEqual(logs, ['[secret-store] created secrets/thing-key']);
    assert.equal(local.readOrCreate('thing-key', { legacyPaths: ['old-keys/thing.key'] }), created);
    assert.equal(logs.length, 1, 'created once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing file that holds no usable value is never replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-store-unusable-'));
  try {
    const local = store.createSecretStore({ dataDir: dir, log: () => {} });
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(join(dir, 'secrets', 'short'), 'short\n');
    writeFileSync(join(dir, 'secrets', 'empty'), '');
    writeFileSync(join(dir, 'secrets', 'broken.json'), '{"fireflies":');
    mkdirSync(join(dir, 'secrets', 'a-folder'));
    const before = snapshot(dir);
    for (const name of ['short', 'empty', 'a-folder']) {
      assert.throws(() => local.readOrCreate(name), (error) => error.code === store.SECRET_UNUSABLE && error.path === `secrets/${name}`, name);
      assert.throws(() => local.read(name), (error) => error.code === store.SECRET_UNUSABLE, name);
    }
    assert.throws(() => local.readOrCreateJson('broken.json', { create: () => ({ fresh: true }) }), (error) => error.code === store.SECRET_UNUSABLE);
    assert.throws(() => hardening.readOrCreateDiskSecret(dir, 'short'), (error) => error.code === store.SECRET_UNUSABLE);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(existsSync(join(dir, 'secrets', 'a-folder')), true);
    // A legacy path that exists but is damaged also blocks a new secret.
    mkdirSync(join(dir, 'old'), { recursive: true });
    writeFileSync(join(dir, 'old', 'k'), 'x');
    assert.throws(() => local.readOrCreate('fresh-name', { legacyPaths: ['old/k'] }), (error) => error.code === store.SECRET_UNUSABLE);
    assert.equal(existsSync(join(dir, 'secrets', 'fresh-name')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('names with folders, traversal, streams, lock or temp suffixes are refused; legacy paths stay in the data dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-store-names-'));
  try {
    const local = store.createSecretStore({ dataDir: dir, log: () => {} });
    for (const name of ['../escape', '..', '.', '', 'a/b', 'a\\b', '/etc/passwd', 'C:evil', 'name:stream', '.hidden', 'x.lock', 'x.tmp', 'a..b', 'x'.repeat(200), null, undefined]) {
      assert.throws(() => local.readOrCreate(name), (error) => error.code === store.SECRET_BAD_NAME, String(name));
      assert.throws(() => local.read(name), (error) => error.code === store.SECRET_BAD_NAME, String(name));
    }
    assert.throws(() => hardening.readOrCreateDiskSecret(dir, '../escape'));
    for (const legacy of ['../outside', join(tmpdir(), 'elsewhere-secret'), '..']) {
      assert.throws(() => local.readOrCreate('ok-name', { legacyPaths: [legacy] }), (error) => error.code === store.SECRET_BAD_NAME, legacy);
    }
    assert.throws(() => local.privateFolder('not-private'), (error) => error.code === store.SECRET_BAD_NAME);
    assert.throws(() => local.privateFolder('../secrets'), (error) => error.code === store.SECRET_BAD_NAME);
    assert.equal(existsSync(join(dir, 'secrets', 'ok-name')), false, 'nothing was created by a refused call');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing icacls (win32) or chmod (POSIX) stub never throws; the secret is still made once', () => {
  for (const platform of ['win32', 'linux']) {
    const dir = mkdtempSync(join(tmpdir(), `secret-store-perm-${platform}-`));
    try {
      privateDir.resetPrivateDirCacheForTests();
      const logs = [];
      const calls = [];
      const local = store.createSecretStore({
        dataDir: dir,
        platform,
        exec: (cmd, args) => {
          calls.push([cmd, ...args]);
          throw Object.assign(new Error('icacls stub failed'), { code: 'ESTUB' });
        },
        chmod: (target, mode) => {
          calls.push(['chmod', target, mode.toString(8)]);
          throw Object.assign(new Error('chmod stub failed'), { code: 'ESTUB' });
        },
        log: (line) => logs.push(String(line)),
      });
      const value = local.readOrCreate('perm-secret', { bytes: 32 });
      assert.match(value, /^[0-9a-f]{64}$/);
      assert.equal(local.readOrCreate('perm-secret'), value);
      assert.equal(readFileSync(join(dir, 'secrets', 'perm-secret'), 'utf8').trim(), value);
      const folder = local.privateFolder('cms-sso');
      assert.equal(existsSync(folder), true);
      if (platform === 'win32' && calls.length) {
        assert.ok(calls.every(([cmd]) => cmd === 'icacls'));
        assert.ok(calls.some((call) => call.includes('/inheritance:r')));
      }
      if (platform === 'linux') {
        assert.ok(calls.some(([cmd, , mode]) => cmd === 'chmod' && mode === '700'), 'folder chmod tried');
        assert.ok(calls.some(([cmd, , mode]) => cmd === 'chmod' && mode === '600'), 'file chmod tried');
      }
      assert.ok(logs.some((line) => /could not restrict/.test(line)), `${platform}: the failure is logged`);
      assert.ok(!logs.join('\n').includes(value));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  privateDir.resetPrivateDirCacheForTests();
});

test('POSIX: a new secret file is 0600 in a 0700 folder', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-store-mode-'));
  try {
    const local = store.createSecretStore({ dataDir: dir, log: () => {} });
    local.readOrCreate('mode-secret');
    assert.equal(statSync(join(dir, 'secrets', 'mode-secret')).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'secrets')).mode & 0o777, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runChildren(count, script, dir) {
  const run = () => new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, APP_DATA_DIR: dir, RACE_DIR: dir } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolvePromise(out.trim()) : reject(new Error(`exit ${code}: ${err}`))));
  });
  return Promise.all(Array.from({ length: count }, run));
}

test('concurrent creates in separate processes end with one value and one file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-store-race-'));
  try {
    const moduleUrl = pathToFileURL(join(REPO, 'data', 'secret-store.js')).href;
    const script = `const m = await import(${JSON.stringify(moduleUrl)});
      const { createHash, randomBytes } = await import('node:crypto');
      const s = m.createSecretStore({ dataDir: process.env.RACE_DIR, log: () => {} });
      const text = s.readOrCreate('race-secret', { bytes: 32 });
      const json = s.readOrCreateJson('race.json', { create: () => ({ version: 1, value: randomBytes(16).toString('hex') }) });
      process.stdout.write(createHash('sha256').update(text).digest('hex') + ':' + json.value);`;
    const results = await runChildren(6, script, dir);
    assert.equal(new Set(results).size, 1, 'every process got the same values');
    const [textHash, jsonValue] = results[0].split(':');
    assert.equal(createHash('sha256').update(readFileSync(join(dir, 'secrets', 'race-secret'), 'utf8').trim()).digest('hex'), textHash);
    assert.equal(JSON.parse(readFileSync(join(dir, 'secrets', 'race.json'), 'utf8')).value, jsonValue);
    assert.deepEqual(readdirSync(join(dir, 'secrets')).sort(), ['race-secret', 'race.json'], 'no temp files are left');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a secret holder on an unusable file keeps the file, signs in memory, and takes the file once it is usable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-store-holder-'));
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(join(dir, 'secrets', 'admin-secret'), 'too-short\n');
    const before = snapshot(dir);
    let clock = 0;
    const holder = hardening.createHubSecretHolder({ dataDir: dir, name: 'admin-secret', refreshMs: 100, now: () => clock });
    assert.equal(holder.memoryOnly, true);
    const inMemory = holder.get();
    assert.match(inMemory, /^[0-9a-f]{96}$/);
    assert.deepEqual(snapshot(dir), before, 'the damaged file is left as it is');
    assert.ok(errors.some((line) => /admin-secret/.test(line) && /memory/.test(line)));
    assert.ok(!errors.join('\n').includes(inMemory));
    // Someone restores the file: the holder takes the disk value on its next re-read.
    const restored = hex(48);
    writeFileSync(join(dir, 'secrets', 'admin-secret'), `${restored}\n`);
    clock += 150;
    assert.equal(holder.get(), restored);
    assert.equal(holder.memoryOnly, false);
    // Rotation is the admin fix and always writes a fresh file.
    writeFileSync(join(dir, 'secrets', 'admin-secret'), 'damaged-again\n');
    const rotated = holder.rotate();
    assert.equal(readFileSync(join(dir, 'secrets', 'admin-secret'), 'utf8').trim(), rotated);
  } finally {
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('webhooks.json: a damaged Fireflies entry is left in place (null); an older file gets one added; rotation replaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-store-webhooks-'));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    const file = join(dir, 'secrets', 'webhooks.json');
    writeFileSync(file, '{"fireflies":{"secret":"short"}}');
    const damaged = readFileSync(file);
    assert.equal(webhookSecrets.ensureFirefliesWebhookSecrets({ dataDir: dir }), null);
    assert.deepEqual(readFileSync(file), damaged);
    writeFileSync(file, '{"fireflies":');
    assert.equal(webhookSecrets.ensureFirefliesWebhookSecrets({ dataDir: dir }), null);
    assert.equal(readFileSync(file, 'utf8'), '{"fireflies":');
    assert.ok(warnings.length >= 1);

    writeFileSync(file, `${JSON.stringify({ version: 1, other: { kept: true } })}\n`);
    const added = webhookSecrets.ensureFirefliesWebhookSecrets({ dataDir: dir });
    assert.match(added.secret, /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).other, { kept: true });

    writeFileSync(file, '{"fireflies":{"secret":"short"}}');
    const rotated = webhookSecrets.rotateFirefliesWebhookSecrets({ dataDir: dir, by: 'test' });
    assert.match(rotated.secret, /^[0-9a-f]{64}$/);
    assert.equal(webhookSecrets.ensureFirefliesWebhookSecrets({ dataDir: dir }).secret, rotated.secret);
  } finally {
    console.warn = originalWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});
