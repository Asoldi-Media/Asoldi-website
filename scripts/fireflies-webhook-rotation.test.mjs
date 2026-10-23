// WS0.9: Fireflies webhook credentials live on the data disk; the retired env values are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-ff-rotation-'));
process.env.APP_DATA_DIR = dataDir;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const secrets = await import('../data/webhook-secrets.js');
const ff = await import('../lib/fireflies-webhook.js');
const counters = await import('../lib/security-counters.js');
const routes = await import('../lib/security-admin-routes.js');

// Fake values standing in for the retired env credentials (never real ones).
const RETIRED_SECRET = 'fake-retired-fireflies-signing-secret-0000';
const RETIRED_TOKEN = 'fake-retired-fireflies-url-token-0000';
const ENV = {
  FIREFLIES_WEBHOOK_SECRET: RETIRED_SECRET,
  FIREFLIES_WEBHOOK_TOKEN: RETIRED_TOKEN,
  FIREFLIES_API: 'fake-fireflies-api-key-alias',
};

function sign(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

const BODY = '{"meeting_id":"TEST123","event":"meeting.bot_joined"}';

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test('first use generates a 64-hex secret and a URL token on disk, then reuses them', () => {
  const first = secrets.ensureFirefliesWebhookSecrets();
  assert.match(first.secret, /^[0-9a-f]{64}$/);
  assert.ok(first.token.length >= 32);
  assert.equal(first.acceptQueryToken, true);
  const again = secrets.ensureFirefliesWebhookSecrets();
  assert.equal(again.secret, first.secret);
  assert.equal(again.token, first.token);
  const onDisk = JSON.parse(readFileSync(join(dataDir, 'secrets', 'webhooks.json'), 'utf8'));
  assert.equal(onDisk.fireflies.secret, first.secret);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(dataDir, 'secrets', 'webhooks.json')).mode & 0o777, 0o600);
  }
});

test('two processes creating the file at the same time end with one secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-ff-race-'));
  try {
    const moduleUrl = pathToFileURL(join(repoRoot, 'data', 'webhook-secrets.js')).href;
    const script = `const m = await import(${JSON.stringify(moduleUrl)});
      const row = m.ensureFirefliesWebhookSecrets();
      const { createHash } = await import('node:crypto');
      process.stdout.write(createHash('sha256').update(row.secret).digest('hex'));`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, APP_DATA_DIR: dir },
      });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    });
    const hashes = await Promise.all([run(), run(), run(), run()]);
    assert.equal(new Set(hashes).size, 1);
    const stored = JSON.parse(readFileSync(join(dir, 'secrets', 'webhooks.json'), 'utf8')).fireflies.secret;
    assert.equal(createHash('sha256').update(stored).digest('hex'), hashes[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config trusts only disk credentials and keeps the env ones as retired', () => {
  const row = secrets.ensureFirefliesWebhookSecrets();
  const config = ff.readFirefliesWebhookConfig(ENV);
  assert.deepEqual(config.secrets, [row.secret]);
  assert.equal(config.token, row.token);
  assert.deepEqual(config.retiredSecrets, [RETIRED_SECRET]);
  assert.equal(config.retiredToken, RETIRED_TOKEN);
  assert.equal(config.secrets.includes(RETIRED_SECRET), false);
});

test('FIREFLIES_API is an alias of FIREFLIES_API_KEY, which wins when both are set', () => {
  assert.deepEqual(ff.resolveFirefliesApiKey({ FIREFLIES_API: ' alias-key ' }), { apiKey: 'alias-key', source: 'FIREFLIES_API' });
  assert.deepEqual(
    ff.resolveFirefliesApiKey({ FIREFLIES_API: 'alias-key', FIREFLIES_API_KEY: 'main-key' }),
    { apiKey: 'main-key', source: 'FIREFLIES_API_KEY' }
  );
  assert.deepEqual(ff.resolveFirefliesApiKey({}), { apiKey: '', source: '' });
  const config = ff.readFirefliesWebhookConfig({ FIREFLIES_API: 'alias-key' }, { webhookSecrets: null });
  assert.equal(config.apiKey, 'alias-key');
  assert.equal(config.apiKeySource, 'FIREFLIES_API');
});

test('a request signed with the disk secret is accepted and recorded as data-signature', () => {
  const row = secrets.ensureFirefliesWebhookSecrets();
  const verdict = ff.authorizeFirefliesWebhook({ headers: { 'x-hub-signature': sign(row.secret, BODY) }, query: {}, rawBody: BODY });
  assert.deepEqual(verdict, { ok: true, via: 'signature' });
  const status = secrets.firefliesWebhookSecretStatus();
  assert.equal(status.lastVerified.via, 'data-signature');
});

test('the disk URL token works until query tokens are switched off', () => {
  const row = secrets.ensureFirefliesWebhookSecrets();
  const request = { headers: {}, query: { token: row.token }, rawBody: BODY };
  assert.deepEqual(ff.decideFirefliesWebhookAuth(request, ff.readFirefliesWebhookConfig({})), { ok: true, via: 'token' });
  secrets.setFirefliesQueryTokenAccepted(false);
  const off = ff.decideFirefliesWebhookAuth(request, ff.readFirefliesWebhookConfig({}));
  assert.equal(off.ok, false);
  assert.equal(off.status, 401);
  secrets.setFirefliesQueryTokenAccepted(true);
});

test('the retired env secret and token are recognised and refused with 401', () => {
  counters.resetSecurityCounters();
  const config = ff.readFirefliesWebhookConfig(ENV);
  const signed = ff.decideFirefliesWebhookAuth({ headers: { 'x-hub-signature': sign(RETIRED_SECRET, BODY) }, query: {}, rawBody: BODY }, config);
  assert.deepEqual(signed, { ok: false, status: 401, reason: 'retired-credential' });
  const queried = ff.decideFirefliesWebhookAuth({ headers: {}, query: { token: RETIRED_TOKEN }, rawBody: BODY }, config);
  assert.deepEqual(queried, { ok: false, status: 401, reason: 'retired-credential' });
  const unknown = ff.decideFirefliesWebhookAuth({ headers: { 'x-hub-signature': sign('nope', BODY) }, query: {}, rawBody: BODY }, config);
  assert.deepEqual(unknown, { ok: false, status: 401, reason: 'unauthorized' });
});

test('the live path counts retired-credential attempts', () => {
  counters.resetSecurityCounters();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, ENV);
    const verdict = ff.authorizeFirefliesWebhook({ headers: {}, query: { token: RETIRED_TOKEN }, rawBody: BODY });
    assert.equal(verdict.reason, 'retired-credential');
    assert.equal(counters.securityCounters()['fireflies-webhook-retired-credential'].total, 1);
  } finally {
    for (const key of Object.keys(ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('with no disk credentials the retired env values still give 401, anything else 503', () => {
  const config = ff.readFirefliesWebhookConfig(ENV, { webhookSecrets: null });
  assert.equal(ff.isFirefliesWebhookConfigured(config), false);
  const retired = ff.decideFirefliesWebhookAuth({ headers: {}, query: { token: RETIRED_TOKEN }, rawBody: BODY }, config);
  assert.equal(retired.status, 401);
  const other = ff.decideFirefliesWebhookAuth({ headers: {}, query: { token: 'x' }, rawBody: BODY }, config);
  assert.equal(other.status, 503);
});

test('rotation replaces the secret: the old disk secret stops working', () => {
  const before = secrets.ensureFirefliesWebhookSecrets();
  const after = secrets.rotateFirefliesWebhookSecrets({ by: 'test' });
  assert.notEqual(after.secret, before.secret);
  assert.notEqual(after.token, before.token);
  const config = ff.readFirefliesWebhookConfig({});
  const old = ff.decideFirefliesWebhookAuth({ headers: { 'x-hub-signature': sign(before.secret, BODY) }, query: {}, rawBody: BODY }, config);
  assert.equal(old.ok, false);
  const fresh = ff.decideFirefliesWebhookAuth({ headers: { 'x-hub-signature': sign(after.secret, BODY) }, query: {}, rawBody: BODY }, config);
  assert.equal(fresh.ok, true);
});

test('a corrupt webhooks.json is replaced with fresh credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-ff-corrupt-'));
  try {
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(join(dir, 'secrets', 'webhooks.json'), '{"fireflies":{"secret":"short"}}');
    const row = secrets.ensureFirefliesWebhookSecrets({ dataDir: dir });
    assert.match(row.secret, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withAdminApp(fn) {
  const app = express();
  app.use(express.json());
  const adminAuth = (req, res, next) => {
    if (req.headers.authorization !== 'Bearer admin-ok') return res.status(401).json({ message: 'Unauthorized' });
    req.admin = { role: 'admin', username: 'tester' };
    return next();
  };
  const clientAuth = (_req, res) => res.status(401).json({ message: 'Unauthorized' });
  routes.registerSecurityAdminRoutes(app, {
    adminAuth,
    clientAuth,
    signToken: (payload) => `signed:${payload.role}`,
    adminSecret: { source: 'disk', envRejected: 'known-default' },
    env: { ...ENV, APP_URL: 'https://hub.example.test' },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('admin routes: status shows sources but no values; reveal and rotate are admin-only', async () => {
  await withAdminApp(async (base) => {
    const auth = { authorization: 'Bearer admin-ok' };
    assert.equal((await fetch(`${base}/api/admin/security/fireflies-webhook`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/security/fireflies-webhook/reveal`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/api/admin/security/fireflies-webhook/rotate`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/api/admin/system/security`)).status, 401);

    const row = secrets.ensureFirefliesWebhookSecrets();
    const statusRes = await fetch(`${base}/api/admin/security/fireflies-webhook`, { headers: auth });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.headers.get('cache-control'), 'no-store');
    const statusText = await statusRes.text();
    assert.equal(statusText.includes(row.secret), false);
    assert.equal(statusText.includes(row.token), false);
    assert.equal(statusText.includes(RETIRED_SECRET), false);
    assert.equal(statusText.includes(RETIRED_TOKEN), false);
    const status = JSON.parse(statusText);
    assert.equal(status.webhookUrl, 'https://hub.example.test/api/webhooks/fireflies');
    assert.equal(status.envRetired, true);
    assert.deepEqual(status.retiredEnvPresent, { secret: true, token: true });
    assert.equal(status.apiKeySource, 'FIREFLIES_API');

    const overview = await fetch(`${base}/api/admin/system/security`, { headers: auth });
    const overviewText = await overview.text();
    assert.equal(overviewText.includes(row.secret), false);
    const parsed = JSON.parse(overviewText);
    assert.equal(parsed.adminSecretSource, 'disk');
    assert.equal(parsed.adminSecretEnvRejected, 'known-default');

    const reveal = await (await fetch(`${base}/api/admin/security/fireflies-webhook/reveal`, { method: 'POST', headers: auth })).json();
    assert.equal(reveal.secret, row.secret);
    assert.equal(reveal.webhookUrl, 'https://hub.example.test/api/webhooks/fireflies');
    assert.equal(reveal.tokenUrl, `https://hub.example.test/api/webhooks/fireflies?token=${encodeURIComponent(row.token)}`);

    const rotated = await (await fetch(`${base}/api/admin/security/fireflies-webhook/rotate`, { method: 'POST', headers: auth })).json();
    assert.notEqual(rotated.secret, row.secret);
    assert.equal(secrets.ensureFirefliesWebhookSecrets().secret, rotated.secret);

    const off = await fetch(`${base}/api/admin/security/fireflies-webhook/query-token`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal((await off.json()).acceptQueryToken, false);
    const revealOff = await (await fetch(`${base}/api/admin/security/fireflies-webhook/reveal`, { method: 'POST', headers: auth })).json();
    assert.equal(revealOff.tokenUrl, null);
  });
});

test('a webhook verified by another process with its cached old secret never undoes a rotation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-ff-stale-'));
  try {
    const before = secrets.ensureFirefliesWebhookSecrets({ dataDir: dir });
    // Process A: warms its 1-second cache, waits for "go", then verifies a webhook with the old secret.
    const script = `
      const ff = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'lib', 'fireflies-webhook.js')).href)});
      ff.readFirefliesWebhookConfig({});
      process.stdout.write('ready\\n');
      process.stdin.once('data', () => {
        const verdict = ff.authorizeFirefliesWebhook({ headers: { 'x-hub-signature': process.env.SIG }, query: {}, rawBody: process.env.BODY });
        process.stdout.write(JSON.stringify(verdict));
        process.exit(0);
      });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, APP_DATA_DIR: dir, SIG: sign(before.secret, BODY), BODY },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    const done = new Promise((resolve, reject) => {
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${err}`))));
    });
    await new Promise((resolve) => {
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.startsWith('ready\n')) resolve();
      });
    });
    // Process B (this one) rotates, then A verifies within its cache window.
    const rotated = secrets.rotateFirefliesWebhookSecrets({ dataDir: dir, by: 'test' });
    child.stdin.write('go\n');
    await done;
    const onDisk = JSON.parse(readFileSync(join(dir, 'secrets', 'webhooks.json'), 'utf8')).fireflies;
    assert.equal(onDisk.secret, rotated.secret, 'the rotation survives');
    assert.equal(onDisk.token, rotated.token);
    assert.equal(onDisk.lastVerified, null, 'a stale credential is not recorded as verified');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lastVerified is recorded only while the verifying credential is still stored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-ff-verified-'));
  try {
    const row = secrets.ensureFirefliesWebhookSecrets({ dataDir: dir });
    secrets.recordFirefliesWebhookVerified('data-signature', { dataDir: dir, credential: 'not-the-stored-secret' });
    assert.equal(secrets.firefliesWebhookSecretStatus({ dataDir: dir }).lastVerified, null);
    secrets.recordFirefliesWebhookVerified('data-token', { dataDir: dir, credential: row.token });
    assert.equal(secrets.firefliesWebhookSecretStatus({ dataDir: dir }).lastVerified.via, 'data-token');
    // Concurrent toggles and rotations go through one lock: the toggle is not lost.
    secrets.setFirefliesQueryTokenAccepted(false, { dataDir: dir });
    const rotated = secrets.rotateFirefliesWebhookSecrets({ dataDir: dir });
    assert.equal(rotated.acceptQueryToken, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
