// Maker host tokens (WS0.4) and host heartbeat, routing fields and scoped access (WS8.25).
// Temp data dirs only; every token here is generated at run time. Nothing leaves 127.0.0.1.
//
// Run: node --test scripts/maker-auth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const baseDir = mkdtempSync(join(tmpdir(), 'asoldi-maker-auth-'));
process.env.APP_DATA_DIR = baseDir;
process.env.PERSIST_PRODUCTION_ENV = '0';

const hosts = await import('../data/maker-hosts.js');
const settings = await import('../data/security-settings.js');
const hardening = await import('../lib/auth-hardening.js');
const counters = await import('../lib/security-counters.js');
const makerAuthLib = await import('../lib/maker-auth.js');
const meta = await import('../lib/maker-host-meta.js');
const accessLog = await import('../lib/maker-access-log.js');
const routes = await import('../lib/routes/maker-host-routes.js');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');

const temps = [baseDir];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-maker-auth-'));
  temps.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const hostsFile = (dir) => join(dir, 'maker-hosts.json');
const readHostsRaw = (dir) => readFileSync(hostsFile(dir), 'utf8');

function req(headers = {}) {
  return { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
}

function legacyHolder(dir, envValue = '') {
  return hardening.createHubSecretHolder({ envValue, envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 });
}

// ── data/maker-hosts.js ─────────────────────────────────────────────────────────

test('a new host gets a mkr_ token shown once; the file keeps only its sha256', () => {
  const dir = tempDir();
  const { host, token } = hosts.createMakerHost({ label: 'Test PC (Docker)', createdBy: 'admin:test' }, { dataDir: dir });
  assert.match(host.hostId, /^mh_[0-9a-f]{8}$/);
  assert.match(token, new RegExp(`^mkr_${host.hostId.slice(3)}_[A-Za-z0-9_-]{43}$`));
  assert.equal(host.tokenPrefix, `mkr_${host.hostId.slice(3)}`);
  assert.deepEqual(host.scopes, ['callback', 'preview-push', 'client-bundle', 'jobs']);
  assert.equal(host.tokenHash, undefined, 'the public row carries no hash');
  const raw = readHostsRaw(dir);
  assert.equal(raw.includes(token), false, 'the token itself is never stored');
  assert.equal(raw.includes(token.slice(-43)), false);
  const stored = JSON.parse(raw).hosts[0];
  assert.equal(stored.tokenHash, hosts.hashMakerToken(token));
  assert.match(stored.tokenHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(stored.lastSeenAt, null);
  assert.equal(stored.revokedAt, null);
  if (process.platform !== 'win32') assert.equal(statSync(hostsFile(dir)).mode & 0o777, 0o600);
  const listed = hosts.listMakerHosts({ dataDir: dir });
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes('sha256:'), false, 'the list carries no hash');
});

test('create validates the label, scopes and owner', () => {
  const dir = tempDir();
  assert.throws(() => hosts.createMakerHost({ label: '  ' }, { dataDir: dir }), /label is required/);
  assert.throws(() => hosts.createMakerHost({ label: 'x', scopes: ['admin'] }, { dataDir: dir }), /scopes must include/);
  assert.throws(() => hosts.createMakerHost({ label: 'x', ownerAccountKey: 'a b' }, { dataDir: dir }), /account key/);
  const { host } = hosts.createMakerHost({ label: 'x', scopes: ['jobs', 'callback', 'jobs', 'nope'] }, { dataDir: dir });
  assert.deepEqual(host.scopes, ['callback', 'jobs'], 'known scopes only, in canonical order');
});

test('verifyMakerHostToken: valid, wrong scope, wrong secret, unknown host, malformed, revoked', () => {
  const dir = tempDir();
  const { host, token } = hosts.createMakerHost({ label: 'A', scopes: ['callback'] }, { dataDir: dir });
  assert.equal(hosts.verifyMakerHostToken(token, { dataDir: dir, scope: 'callback' }).ok, true);
  assert.equal(hosts.verifyMakerHostToken(token, { dataDir: dir, scope: 'jobs' }).reason, 'scope');
  const lastChar = token.at(-1) === 'A' ? 'B' : 'A';
  const sameLengthOther = `${token.slice(0, -1)}${lastChar}`;
  assert.equal(hosts.verifyMakerHostToken(sameLengthOther, { dataDir: dir, scope: 'callback' }).reason, 'mismatch');
  const otherHost = `mkr_00000000_${'a'.repeat(43)}`;
  assert.equal(hosts.verifyMakerHostToken(otherHost, { dataDir: dir, scope: 'callback' }).reason, 'unknown-host');
  assert.equal(hosts.verifyMakerHostToken('not-a-token', { dataDir: dir }).reason, 'malformed');
  assert.equal(hosts.verifyMakerHostToken('', { dataDir: dir }).reason, 'malformed');
  const revoked = hosts.revokeMakerHost(host.hostId, { dataDir: dir, by: 'admin:test' });
  assert.ok(revoked.revokedAt);
  assert.equal(revoked.revoked, true);
  assert.equal(hosts.verifyMakerHostToken(token, { dataDir: dir, scope: 'callback' }).reason, 'revoked');
  const again = hosts.revokeMakerHost(host.hostId, { dataDir: dir, by: 'admin:other' });
  assert.equal(again.revokedAt, revoked.revokedAt, 'a second revoke keeps the first time');
  assert.equal(hosts.revokeMakerHost('mh_ffffffff', { dataDir: dir }), null);
});

test('constant-time compare: token hashes are compared with timingSafeEqual, never with === on secrets', () => {
  const source = readFileSync(new URL('../data/maker-hosts.js', import.meta.url), 'utf8');
  assert.match(source, /timingSafeEqual\(presented, host \? hashBytes\(host\.tokenHash\) : ZERO_HASH\)/);
  assert.doesNotMatch(source, /tokenHash\s*[!=]==|[!=]==\s*\w*\.?tokenHash/);
  const auth = readFileSync(new URL('../lib/maker-auth.js', import.meta.url), 'utf8');
  assert.match(auth, /safeEqual\(token, current\)/, 'the legacy token is compared in constant time');
  assert.match(auth, /safeEqual\(provided, configured\)/, 'the API key is compared in constant time');
  assert.doesNotMatch(auth, /(legacy|token|provided)\s*[!=]==\s*(current|configured|token)\b/);
  // An unknown host still runs one full-length compare (against a zero hash).
  assert.match(source, /const ZERO_HASH = Buffer\.alloc\(32\)/);
});

test('lastSeenAt is written on first use, then at most every 5 minutes', () => {
  const dir = tempDir();
  hosts.resetMakerHostsMemoForTests();
  const { host } = hosts.createMakerHost({ label: 'A' }, { dataDir: dir });
  const t0 = Date.parse('2026-10-24T10:00:00.000Z');
  assert.equal(hosts.touchMakerHostLastSeen(host.hostId, { dataDir: dir, now: t0 }), true);
  const afterFirst = readHostsRaw(dir);
  assert.equal(JSON.parse(afterFirst).hosts[0].lastSeenAt, '2026-10-24T10:00:00.000Z');
  assert.equal(hosts.touchMakerHostLastSeen(host.hostId, { dataDir: dir, now: t0 + 60_000 }), false);
  assert.equal(hosts.touchMakerHostLastSeen(host.hostId, { dataDir: dir, now: t0 + 4 * 60_000 }), false);
  assert.equal(readHostsRaw(dir), afterFirst, 'no write inside the 5-minute window');
  assert.equal(hosts.touchMakerHostLastSeen(host.hostId, { dataDir: dir, now: t0 + 5 * 60_000 }), true);
  assert.equal(JSON.parse(readHostsRaw(dir)).hosts[0].lastSeenAt, '2026-10-24T10:05:00.000Z');
});

test('another process sees a revocation within a second and a new host at once', async () => {
  const dir = tempDir();
  const { host, token } = hosts.createMakerHost({ label: 'A' }, { dataDir: dir });
  assert.equal(hosts.verifyMakerHostToken(token, { dataDir: dir, scope: 'callback' }).ok, true);
  // Simulate another process: rewrite the file directly (revoked), then wait past the cache window.
  const raw = JSON.parse(readHostsRaw(dir));
  raw.hosts[0].revokedAt = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(hostsFile(dir), JSON.stringify(raw));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(hosts.verifyMakerHostToken(token, { dataDir: dir, scope: 'callback' }).reason, 'revoked');
  // A host written by another process a moment ago is found by one fresh read.
  hosts.resetMakerHostsMemoForTests();
  const before = JSON.parse(readHostsRaw(dir));
  const other = hosts.createMakerHost({ label: 'B' }, { dataDir: tempDir() });
  const otherRow = JSON.parse(readHostsRaw(temps.at(-1))).hosts[0];
  before.hosts.push(otherRow);
  writeFileSync(hostsFile(dir), JSON.stringify(before));
  assert.equal(hosts.verifyMakerHostToken(other.token, { dataDir: dir, scope: 'callback' }).ok, true);
  assert.equal(host.hostId.length, 11);
});

// ── lib/maker-auth.js: verifyMakerRequest ───────────────────────────────────────

test('verifyMakerRequest: no credential is refused even with nothing configured (fail closed)', () => {
  const dir = tempDir();
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: null, dataDir: dir, env: {} });
  assert.deepEqual(auth.verifyMakerRequest(req({}), { scope: 'callback' }), { ok: false, reason: 'missing' });
  assert.equal(auth.verifyMakerRequest(req({ 'x-sales-callback-token': 'anything' })).ok, false);
});

test('verifyMakerRequest: host token, legacy disk token, legacy env token, host token in the legacy header', () => {
  const dir = tempDir();
  const { host, token } = hosts.createMakerHost({ label: 'A', scopes: ['callback'] }, { dataDir: dir });
  const disk = legacyHolder(dir);
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: disk, dataDir: dir, env: {} });
  const viaHost = auth.verifyMakerRequest(req({ 'x-maker-host-token': token }), { scope: 'callback' });
  assert.equal(viaHost.ok, true);
  assert.equal(viaHost.via, 'host');
  assert.equal(viaHost.hostId, host.hostId);
  const diskToken = disk.get();
  const viaDisk = auth.verifyMakerRequest(req({ 'x-sales-callback-token': diskToken }), { scope: 'callback' });
  assert.deepEqual(viaDisk, { ok: true, via: 'legacy', source: 'disk' });
  assert.equal(auth.verifyMakerRequest(req({ 'x-maker-callback-token': diskToken })).ok, true);
  const inLegacyHeader = auth.verifyMakerRequest(req({ 'x-sales-callback-token': token }), { scope: 'callback' });
  assert.equal(inLegacyHeader.via, 'host');

  const envAuth = makerAuthLib.createMakerAuth({ legacyHolder: legacyHolder(dir, 'env-callback-token-value-1'), dataDir: dir, env: {} });
  assert.deepEqual(envAuth.verifyMakerRequest(req({ 'x-sales-callback-token': 'env-callback-token-value-1' })), { ok: true, via: 'legacy', source: 'env' });
  assert.equal(envAuth.verifyMakerRequest(req({ 'x-sales-callback-token': diskToken })).ok, false, 'env wins over the disk token');
  assert.equal(envAuth.verifyMakerRequest(req({ 'x-maker-host-token': token }), { scope: 'callback' }).ok, true, 'host tokens work beside env');
});

test('verifyMakerRequest: a revoked or out-of-scope host token is refused even when a valid legacy token or API key comes with it', () => {
  const dir = tempDir();
  const { host, token } = hosts.createMakerHost({ label: 'A', scopes: ['callback'] }, { dataDir: dir });
  const disk = legacyHolder(dir);
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: disk, dataDir: dir, env: { WEBSITE_MAKER_API_KEY: 'maker-api-key-value' } });
  // The header set a Maker sends for a run the hub started: its host token plus the run's legacy token.
  const makerHeaders = { 'x-maker-host-token': token, 'x-sales-callback-token': disk.get() };
  assert.deepEqual(auth.verifyMakerRequest(req({ 'x-maker-host-token': token }), { scope: 'jobs' }), { ok: false, reason: 'scope', hostId: host.hostId });
  assert.deepEqual(auth.verifyMakerRequest(req(makerHeaders), { scope: 'jobs' }), { ok: false, reason: 'scope', hostId: host.hostId }, 'the legacy token does not widen the scopes');
  assert.deepEqual(
    auth.verifyMakerRequest(req({ ...makerHeaders, 'x-api-key': 'maker-api-key-value' }), { scope: 'preview-push', allowApiKey: true }),
    { ok: false, reason: 'scope', hostId: host.hostId },
    'nor does the API key'
  );
  assert.equal(auth.verifyMakerRequest(req(makerHeaders), { scope: 'callback' }).via, 'host', 'before the revoke the host token is used');

  hosts.revokeMakerHost(host.hostId, { dataDir: dir });
  assert.equal(auth.verifyMakerRequest(req({ 'x-maker-host-token': token })).reason, 'revoked');
  assert.equal(auth.verifyMakerRequest(req({ 'x-sales-callback-token': token })).reason, 'revoked', 'also in the legacy header');
  assert.deepEqual(auth.verifyMakerRequest(req(makerHeaders), { scope: 'callback' }), { ok: false, reason: 'revoked', hostId: host.hostId }, 'host token plus legacy token after the revoke');
  assert.equal(
    auth.verifyMakerRequest(req({ ...makerHeaders, 'x-api-key': 'maker-api-key-value' }), { scope: 'preview-push', allowApiKey: true }).reason,
    'revoked',
    'the API key does not stand in for a revoked host'
  );
  assert.deepEqual(
    auth.verifyMakerRequest(req({ 'x-sales-callback-token': disk.get() }), { scope: 'callback' }),
    { ok: true, via: 'legacy', source: 'disk' },
    'the legacy token alone is not tied to a host and keeps working until it is rotated'
  );
});

test('verifyMakerRequest: an unknown host id or a wrong secret is not final, so the legacy token still carries the request', () => {
  const dir = tempDir();
  const { token } = hosts.createMakerHost({ label: 'A' }, { dataDir: dir });
  const disk = legacyHolder(dir);
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: disk, dataDir: dir, env: {} });
  const unknownHost = `mkr_0badc0de_${'b'.repeat(43)}`;
  const wrongSecret = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`;
  for (const hostToken of [unknownHost, wrongSecret, 'not-a-host-token']) {
    assert.deepEqual(
      auth.verifyMakerRequest(req({ 'x-maker-host-token': hostToken, 'x-sales-callback-token': disk.get() }), { scope: 'callback' }),
      { ok: true, via: 'legacy', source: 'disk' },
      `legacy fallback for ${hostToken.slice(0, 12)}`
    );
  }
  assert.equal(auth.verifyMakerRequest(req({ 'x-maker-host-token': unknownHost })).reason, 'unknown-host');
  assert.equal(auth.verifyMakerRequest(req({ 'x-maker-host-token': wrongSecret })).reason, 'mismatch');
  // A hub whose maker-hosts.json is gone: the Maker keeps working through the legacy token.
  rmSync(hostsFile(dir));
  clearJsonCacheForTests();
  hosts.resetMakerHostsMemoForTests();
  assert.equal(auth.verifyMakerRequest(req({ 'x-maker-host-token': token, 'x-sales-callback-token': disk.get() }), { scope: 'callback' }).via, 'legacy');
});

test('checkMakerRequest: the yes/no form counts refusals like the middleware and stamps lastSeenAt', () => {
  const dir = tempDir();
  hosts.resetMakerHostsMemoForTests();
  counters.resetSecurityCounters();
  const { host, token } = hosts.createMakerHost({ label: 'A', scopes: ['callback'] }, { dataDir: dir });
  const pending = [];
  const auth = makerAuthLib.createMakerAuth({
    legacyHolder: legacyHolder(dir),
    dataDir: dir,
    env: {},
    counters: makerAuthLib.createPersistedMakerCounters({ dataDir: dir, flushMs: 0, write: (deltas) => pending.push(deltas) }),
  });
  assert.equal(auth.checkMakerRequest(req({ 'x-maker-host-token': token })).ok, true);
  assert.ok(JSON.parse(readHostsRaw(dir)).hosts[0].lastSeenAt, 'lastSeenAt stamped');
  assert.equal(auth.checkMakerRequest(req({ 'x-maker-host-token': token }), { scope: 'jobs' }).reason, 'scope');
  assert.equal(auth.checkMakerRequest(req({})).ok, false);
  assert.equal(auth.checkMakerRequest(req({ 'x-sales-callback-token': 'wrong' }), { count: false }).ok, false);
  const memory = counters.securityCounters();
  assert.equal(memory['maker-callback-rejected'].total, 1, 'the scope refusal is counted; count:false is not');
  assert.equal(memory['maker-callback-missing-token'].total, 1);
  assert.deepEqual(pending.flatMap((delta) => Object.keys(delta.makerRejected?.byReason || {})).sort(), ['missing', 'scope']);
  hosts.revokeMakerHost(host.hostId, { dataDir: dir });
  assert.equal(auth.checkMakerRequest(req({ 'x-maker-host-token': token })).ok, false);
  // server.js keeps the old yes/no helper name for route modules that take an isMakerAuthorized callback.
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(
    server,
    /function isMakerStatusCallbackAuthorized\(req, \{ scope = 'callback', count = true \} = \{\}\) \{\n  return makerAuth\.checkMakerRequest\(req, \{ scope, count \}\)\.ok;\n\}/
  );
});

test('verifyMakerRequest: the Maker API key counts only where allowApiKey is set', () => {
  const dir = tempDir();
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: legacyHolder(dir), dataDir: dir, env: { WEBSITE_MAKER_API_KEY: 'maker-api-key-value' } });
  const headers = req({ 'x-api-key': 'maker-api-key-value' });
  assert.equal(auth.verifyMakerRequest(headers, { scope: 'callback' }).ok, false);
  assert.deepEqual(auth.verifyMakerRequest(headers, { scope: 'preview-push', allowApiKey: true }), { ok: true, via: 'api-key' });
  assert.equal(auth.verifyMakerRequest(req({ 'x-api-key': 'maker-api-key-valuX' }), { allowApiKey: true }).reason, 'mismatch');
  const noKey = makerAuthLib.createMakerAuth({ legacyHolder: null, dataDir: dir, env: {} });
  assert.equal(noKey.verifyMakerRequest(req({ 'x-api-key': '' }), { allowApiKey: true }).ok, false, 'no key configured: never open');
});

// ── requireMakerHost over HTTP ──────────────────────────────────────────────────

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function callbackApp(auth) {
  const app = express();
  app.use(express.json());
  app.post('/cb', auth.requireMakerHost('callback'), (req, res) => res.json({ ok: true, via: req.makerAuth.via, hostId: req.makerAuth.hostId || null }));
  app.post('/push', auth.requireMakerHost('preview-push', { allowApiKey: true, message: 'Unauthorized preview push.' }), (_req, res) => res.json({ ok: true }));
  return app;
}

test('requireMakerHost: 401 without a header, 200 with a host token (and lastSeenAt), 401 after revoke, legacy still 200', async (t) => {
  const dir = tempDir();
  hosts.resetMakerHostsMemoForTests();
  counters.resetSecurityCounters();
  const { host, token } = hosts.createMakerHost({ label: 'A' }, { dataDir: dir });
  const disk = legacyHolder(dir);
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: disk, dataDir: dir, env: {} });
  const { base, close } = await serve(callbackApp(auth));
  t.after(close);
  const post = (headers) => fetch(`${base}/cb`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

  const none = await post({});
  assert.equal(none.status, 401);
  assert.deepEqual(await none.json(), { message: 'Unauthorized callback.' });
  assert.equal(none.headers.get('cache-control'), 'no-store');

  const ok = await post({ 'x-maker-host-token': token });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, via: 'host', hostId: host.hostId });
  const seen = JSON.parse(readHostsRaw(dir)).hosts[0].lastSeenAt;
  assert.ok(seen && Date.now() - Date.parse(seen) < 60_000, 'lastSeenAt is stamped');

  hosts.revokeMakerHost(host.hostId, { dataDir: dir });
  assert.equal((await post({ 'x-maker-host-token': token })).status, 401);
  assert.equal((await post({ 'x-sales-callback-token': disk.get() })).status, 200, 'the legacy disk token still works');

  const memory = counters.securityCounters();
  assert.equal(memory['maker-callback-missing-token'].total, 1);
  assert.equal(memory['maker-callback-rejected'].total, 1);
  auth.flushCounters();
  const stored = settings.readSecuritySettings({ dataDir: dir }).counters.makerRejected;
  assert.equal(stored.total, 2);
  assert.deepEqual(stored.byReason, { missing: 1, revoked: 1 });
  const fileText = readFileSync(join(dir, 'security-settings.json'), 'utf8');
  assert.equal(fileText.includes(token), false, 'counters never hold a token');
  assert.equal(fileText.includes(disk.get()), false);
});

test('requireMakerHost: with the Maker header set (host token plus legacy run token) a revoke gives 401 and a missing scope 403', async (t) => {
  const dir = tempDir();
  hosts.resetMakerHostsMemoForTests();
  const callbackOnly = hosts.createMakerHost({ label: 'callback only', scopes: ['callback'] }, { dataDir: dir });
  const full = hosts.createMakerHost({ label: 'all scopes' }, { dataDir: dir });
  const disk = legacyHolder(dir);
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: disk, dataDir: dir, env: { WEBSITE_MAKER_API_KEY: 'k-123' } });
  const { base, close } = await serve(callbackApp(auth));
  t.after(close);
  const post = (path, headers) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  const withRun = (token) => ({ 'x-maker-host-token': token, 'x-sales-callback-token': disk.get() });

  assert.equal((await post('/cb', withRun(full.token))).status, 200);
  assert.equal((await post('/push', withRun(full.token))).status, 200);
  const scoped = await post('/push', { ...withRun(callbackOnly.token), 'x-api-key': 'k-123' });
  assert.equal(scoped.status, 403, 'a callback-only host may not push previews, legacy token and API key or not');
  assert.equal((await scoped.json()).code, 'maker-scope');

  hosts.revokeMakerHost(full.host.hostId, { dataDir: dir });
  const refused = await post('/cb', withRun(full.token));
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { message: 'Unauthorized callback.' });
  assert.equal((await post('/push', { ...withRun(full.token), 'x-api-key': 'k-123' })).status, 401);
  assert.equal((await post('/cb', { 'x-sales-callback-token': disk.get() })).status, 200, 'the legacy token alone still works');
});

test('failure limiter: a stale legacy run token keeps getting 401, never 429, so the Maker fallback on 401 still runs', () => {
  const dir = tempDir();
  const disk = legacyHolder(dir);
  const stale = disk.get();
  disk.rotate();
  let clock = Date.parse('2026-10-24T12:00:00.000Z');
  const auth = makerAuthLib.createMakerAuth({
    legacyHolder: disk,
    dataDir: dir,
    env: { WEBSITE_MAKER_API_KEY: 'k-123' },
    now: () => clock,
    counters: makerAuthLib.createPersistedMakerCounters({ dataDir: dir, now: () => clock, write: () => {} }),
  });
  const call = (handler, headers) => {
    let code = 200;
    const res = { setHeader() {}, status(c) { code = c; return this; }, json() { return this; } };
    handler(req(headers), res, () => {});
    return code;
  };
  const callback = auth.requireMakerHost('callback');
  const push = auth.requireMakerHost('preview-push', { allowApiKey: true, message: 'Unauthorized preview push.' });
  const codes = [];
  for (let i = 0; i < 25; i += 1) {
    codes.push(call(callback, { 'x-sales-callback-token': stale }));
    clock += 1000;
  }
  assert.ok(codes.every((code) => code === 401), `status callbacks: ${codes.join(',')}`);
  assert.equal(call(push, { 'x-sales-callback-token': stale }), 401, 'the preview push with the same stale run token still gets 401');
  for (let i = 0; i < 25; i += 1) call(push, { 'x-api-key': 'k-wrong' });
  assert.equal(call(push, { 'x-api-key': 'k-wrong' }), 401, 'a wrong API key keeps getting 401');
  assert.equal(call(callback, { 'x-sales-callback-token': disk.get() }), 200, 'the current token passes');
});

test('requireMakerHost: 403 for a host without the scope, and the preview push message and API key', async (t) => {
  const dir = tempDir();
  const { token } = hosts.createMakerHost({ label: 'jobs only', scopes: ['jobs'] }, { dataDir: dir });
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: legacyHolder(dir), dataDir: dir, env: { WEBSITE_MAKER_API_KEY: 'k-123' } });
  const { base, close } = await serve(callbackApp(auth));
  t.after(close);
  const scoped = await fetch(`${base}/cb`, { method: 'POST', headers: { 'x-maker-host-token': token } });
  assert.equal(scoped.status, 403);
  assert.equal((await scoped.json()).code, 'maker-scope');
  const push = await fetch(`${base}/push`, { method: 'POST' });
  assert.equal(push.status, 401);
  assert.equal((await push.json()).message, 'Unauthorized preview push.');
  assert.equal((await fetch(`${base}/push`, { method: 'POST', headers: { 'x-api-key': 'k-123' } })).status, 200);
});

test('failure limiter: a stale token polling at 3 failures a minute never blocks a valid host', () => {
  const dir = tempDir();
  hosts.resetMakerHostsMemoForTests();
  const { token } = hosts.createMakerHost({ label: 'valid' }, { dataDir: dir });
  const stale = hosts.createMakerHost({ label: 'stale' }, { dataDir: dir });
  hosts.revokeMakerHost(stale.host.hostId, { dataDir: dir });
  let clock = Date.parse('2026-10-24T12:00:00.000Z');
  const alerts = [];
  const auth = makerAuthLib.createMakerAuth({
    legacyHolder: null,
    dataDir: dir,
    env: {},
    now: () => clock,
    counters: makerAuthLib.createPersistedMakerCounters({ dataDir: dir, now: () => clock, write: () => {} }),
    onAlert: (info) => alerts.push(info),
  });
  const handler = auth.requireMakerHost('callback');
  const run = (headers) => {
    const result = { status: 200, headers: {} };
    const res = {
      setHeader: (k, v) => { result.headers[k.toLowerCase()] = v; },
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    };
    let passed = false;
    handler(req(headers), res, () => { passed = true; });
    return { ...result, passed };
  };
  const statuses = [];
  for (let minute = 0; minute < 30; minute += 1) {
    for (let i = 0; i < 3; i += 1) {
      statuses.push(run({ 'x-maker-host-token': stale.token }).status);
      clock += 20_000;
    }
    const good = run({ 'x-maker-host-token': token });
    assert.equal(good.passed, true, `valid host passes in minute ${minute}`);
  }
  assert.ok(statuses.includes(429), 'the stale token is told to back off');
  assert.ok(statuses.every((code) => code === 401 || code === 429));
  assert.equal(alerts.length, 0, '3 failures a minute stays under the alert threshold');
});

test('failure limiter: more than 30 failures in 10 minutes raises one alert per window; header-less calls always get 401', () => {
  const dir = tempDir();
  let clock = Date.parse('2026-10-24T12:00:00.000Z');
  const persisted = [];
  const alerts = [];
  const auth = makerAuthLib.createMakerAuth({
    legacyHolder: null,
    dataDir: dir,
    env: {},
    now: () => clock,
    counters: makerAuthLib.createPersistedMakerCounters({ dataDir: dir, now: () => clock, flushMs: 0, write: (deltas) => persisted.push(deltas) }),
    onAlert: (info) => alerts.push(info),
  });
  const handler = auth.requireMakerHost('callback');
  const statuses = [];
  for (let i = 0; i < 40; i += 1) {
    const res = { status(code) { statuses.push(code); return this; }, json() { return this; }, setHeader() {} };
    handler(req({}), res, () => assert.fail('must not pass'));
    clock += 1000;
  }
  assert.ok(statuses.every((code) => code === 401), 'no credential: always a plain 401');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].failures, 31);
  assert.equal(auth.status().failures.alertActive, true);
  assert.ok(persisted.some((delta) => delta.makerFailureAlerts?.total === 1));
  clock += 11 * 60_000;
  assert.equal(auth.status().failures.alertActive, false);
});

test('persisted counters: batched, merged across writers, and the settings record is untouched', () => {
  const dir = tempDir();
  settings.updateSecuritySettings({ maxTokenAgeDays: 14 }, { dataDir: dir, by: 'admin:owner' });
  const before = settings.readSecuritySettings({ dataDir: dir });
  let clock = 1_000_000;
  const a = makerAuthLib.createPersistedMakerCounters({ dataDir: dir, now: () => clock, flushMs: 30_000 });
  const b = makerAuthLib.createPersistedMakerCounters({ dataDir: dir, now: () => clock, flushMs: 30_000 });
  a.rejected('missing');
  a.rejected('mismatch');
  a.rejected('mismatch');
  b.rejected('revoked');
  assert.deepEqual(a.pending().makerRejected.byReason, { mismatch: 2 }, 'only the first one was written at once');
  a.flush();
  b.flush();
  const after = settings.readSecuritySettings({ dataDir: dir });
  assert.equal(after.counters.makerRejected.total, 4);
  assert.deepEqual(after.counters.makerRejected.byReason, { missing: 1, mismatch: 2, revoked: 1 });
  assert.equal(after.updatedBy, before.updatedBy);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.maxTokenAgeDays, 14);
  // A later settings change keeps the counters.
  settings.updateSecuritySettings({ maxTokenAgeDays: 20 }, { dataDir: dir, by: 'admin:owner' });
  assert.equal(settings.readSecuritySettings({ dataDir: dir }).counters.makerRejected.total, 4);
});

// ── WS8.25: heartbeat, routing fields, scoped access ───────────────────────────

test('updateHostMeta / heartbeat: unchanged fields write nothing to maker-hosts.json', () => {
  const dir = tempDir();
  const { host } = hosts.createMakerHost({ label: 'A' }, { dataDir: dir });
  const body = { runIds: ['run-b', 'run-a', 'run-a'], capabilities: { handlers: ['continue', 'publish', 'teleport'], vision: true }, version: 'maker@abc123', makerPort: 3000 };
  const first = meta.recordHostHeartbeat(host.hostId, body, { dataDir: dir });
  assert.equal(first.changed, true);
  assert.deepEqual(first.ignoredHandlers, ['teleport']);
  assert.deepEqual(first.host.runIds, ['run-a', 'run-b']);
  assert.deepEqual(first.host.capabilities, { handlers: ['continue', 'publish'], vision: true, cdp: false });
  const text = readHostsRaw(dir);
  const mtime = statSync(hostsFile(dir)).mtimeMs;
  const second = meta.recordHostHeartbeat(host.hostId, { ...body, runIds: ['run-a', 'run-b'] }, { dataDir: dir });
  assert.equal(second.changed, false);
  assert.equal(readHostsRaw(dir), text);
  assert.equal(statSync(hostsFile(dir)).mtimeMs, mtime, 'the file was not rewritten');
  assert.equal(meta.recordHostHeartbeat(host.hostId, { makerPort: 3001 }, { dataDir: dir }).changed, true);
  assert.equal(JSON.parse(readHostsRaw(dir)).hosts[0].makerPort, 3001);
  assert.deepEqual(JSON.parse(readHostsRaw(dir)).hosts[0].runIds, ['run-a', 'run-b'], 'keys not sent stay as they were');
  assert.equal(meta.recordHostHeartbeat('mh_ffffffff', body, { dataDir: dir }), null);
});

test('hostMayAccessClient: a routed live job or a reported run; nothing else', () => {
  const host = { hostId: 'mh_aaaaaaaa', runIds: ['run-1'], revokedAt: null };
  const client = { id: 'c1', makerRun: { runId: 'run-1' } };
  const other = { id: 'c2', makerRun: { runId: 'run-2' } };
  assert.equal(meta.hostMayAccessClient(host, 'c1', { client }), true);
  assert.equal(meta.hostMayAccessClient(host, 'c2', { client: other }), false);
  assert.equal(meta.hostMayAccessClient(host, 'c2', { client: other, jobs: [{ salesClientId: 'c2', hostId: 'mh_aaaaaaaa', status: 'queued' }] }), true);
  assert.equal(meta.hostMayAccessClient(host, 'c2', { client: other, jobs: [{ salesClientId: 'c2', hostId: 'mh_bbbbbbbb', status: 'queued' }] }), false);
  assert.equal(meta.hostMayAccessClient(host, 'c2', { client: other, jobs: [{ salesClientId: 'c2', hostId: 'mh_aaaaaaaa', status: 'done' }] }), false);
  assert.equal(meta.hostMayAccessClient({ ...host, revokedAt: '2026-10-24T00:00:00Z' }, 'c1', { client }), false);
  assert.equal(meta.hostMayAccessClient(host, 'c1', { client: { id: 'c1', makerRun: {} } }), false);
  assert.equal(meta.hostReportsRun(host, 'run-1'), true);
  assert.equal(meta.hostReportsRun(host, 'run-2'), false);
});

test('scoped client route: 403 on another client\'s brief and transcripts, and every access is logged with ids only', async (t) => {
  const dir = tempDir();
  accessLog.resetMakerAccessLogMemoForTests();
  const { host, token } = hosts.createMakerHost({ label: 'A' }, { dataDir: dir });
  meta.recordHostHeartbeat(host.hostId, { runIds: ['run-own'] }, { dataDir: dir });
  const clients = {
    own: { id: 'own', businessName: 'Kafe Eksempel', makerRun: { runId: 'run-own' } },
    other: { id: 'other', businessName: 'Annen Bedrift', makerRun: { runId: 'run-other' } },
  };
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: legacyHolder(dir), dataDir: dir, env: {} });
  const app = express();
  const gate = auth.requireMakerHost('jobs', { hostOnly: true });
  const scope = (kind, refParam = '') => meta.makerClientAccess({ kind, getClient: (id) => clients[id] || null, dataDir: dir, refParam });
  app.get('/api/maker/clients/:id/brief', gate, scope('brief'), (req, res) => res.json({ brief: req.makerClient.id }));
  app.get('/api/maker/clients/:id/transcripts/:sha256', gate, scope('transcript', 'sha256'), (_req, res) => res.json({ ok: true }));
  const { base, close } = await serve(app);
  t.after(close);
  const get = (path, headers = { 'x-maker-host-token': token }) => fetch(`${base}${path}`, { headers });

  assert.equal((await get('/api/maker/clients/own/brief')).status, 200);
  assert.equal((await get('/api/maker/clients/other/brief')).status, 403);
  assert.equal((await get('/api/maker/clients/other/transcripts/abc123')).status, 403);
  assert.equal((await get('/api/maker/clients/missing/brief')).status, 403, 'unknown clients look the same');
  const legacy = await get('/api/maker/clients/own/brief', { 'x-sales-callback-token': legacyHolder(dir).get() });
  assert.equal(legacy.status, 403, 'client data needs a host token, not the legacy token');
  assert.equal((await legacy.json()).code, 'maker-host-token-required');

  const rows = accessLog.readMakerAccessLog({ dataDir: dir });
  assert.equal(rows.length, 4, 'every client access is logged');
  assert.deepEqual(rows.map((row) => [row.clientId, row.kind, row.allowed]).reverse(), [
    ['own', 'brief', true],
    ['other', 'brief', false],
    ['other', 'transcript', false],
    ['missing', 'brief', false],
  ]);
  assert.ok(rows.every((row) => row.hostId === host.hostId));
  assert.equal(rows.find((row) => row.kind === 'transcript').ref, 'abc123');
  const logText = readdirSync(join(dir, 'maker-access-log')).map((name) => readFileSync(join(dir, 'maker-access-log', name), 'utf8')).join('');
  assert.equal(logText.includes('Kafe Eksempel'), false, 'no names in the log');
  assert.equal(logText.includes(token), false);
});

test('access log: one file per month, older than 12 months dropped, ids cleaned', () => {
  const dir = tempDir();
  accessLog.resetMakerAccessLogMemoForTests();
  const logDir = join(dir, 'maker-access-log');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, '2025-09.jsonl'), '{}\n');
  writeFileSync(join(logDir, '2025-11.jsonl'), '{}\n');
  const now = Date.parse('2026-10-24T08:00:00.000Z');
  const row = accessLog.appendMakerAccess({ hostId: 'mh_aaaaaaaa', clientId: 'bad id with spaces', kind: 'brief', allowed: true }, { dataDir: dir, now });
  assert.equal(row.clientId, null);
  assert.deepEqual(readdirSync(logDir).sort(), ['2025-11.jsonl', '2026-10.jsonl']);
});

test('heartbeat route: host token with jobs scope only; response carries the poll interval and hub fields', async (t) => {
  const dir = tempDir();
  const { host, token } = hosts.createMakerHost({ label: 'A' }, { dataDir: dir });
  const callbackOnly = hosts.createMakerHost({ label: 'B', scopes: ['callback'] }, { dataDir: dir });
  const disk = legacyHolder(dir);
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: disk, dataDir: dir, env: {} });
  mkdirSync(join(dir, 'delivery-hot'), { recursive: true });
  writeFileSync(join(dir, 'delivery-hot', 'loop-health.json'), JSON.stringify({ lastTickAt: '2026-10-24T09:00:00.000Z' }));
  const app = express();
  app.use(express.json());
  const heartbeatStore = meta.createHostHeartbeatStore({ dataDir: dir, flushMs: 0 });
  const pass = (_req, _res, next) => next();
  routes.registerMakerHostRoutes(app, { adminAuth: pass, makerAuth: auth, getDataDir: () => dir, heartbeatStore });
  const { base, close } = await serve(app);
  t.after(close);
  const beat = (headers, body) => fetch(`${base}/api/maker/hosts/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const body = { runIds: ['r1'], capabilities: { handlers: ['continue'] }, version: 'maker@1', makerPort: 3000 };

  assert.equal((await beat({}, body)).status, 401);
  assert.equal((await beat({ 'x-sales-callback-token': disk.get() }, body)).status, 403, 'the legacy token has no host identity');
  assert.equal((await beat({ 'x-maker-host-token': callbackOnly.token }, body)).status, 403);
  const ok = await beat({ 'x-maker-host-token': token }, body);
  assert.equal(ok.status, 200);
  const answer = await ok.json();
  assert.equal(answer.pollAfterMs, 30000);
  assert.deepEqual(answer.hubCapabilities, []);
  assert.equal(answer.hubLoopLastTickAt, '2026-10-24T09:00:00.000Z');
  assert.equal(answer.changed, true);
  const unchanged = await (await beat({ 'x-maker-host-token': token }, body)).json();
  assert.equal(unchanged.changed, false);
  const hot = JSON.parse(readFileSync(join(dir, 'delivery-hot', 'host-heartbeats.json'), 'utf8'));
  assert.equal(hot.hosts[host.hostId].heartbeats, 2);
  assert.ok(hot.hosts[host.hostId].lastHeartbeatAt);
});

test('admin routes: create shows the token once (no-store), the list has no hashes, revoke makes the token fail', async (t) => {
  const dir = tempDir();
  clearJsonCacheForTests();
  const auth = makerAuthLib.createMakerAuth({ legacyHolder: legacyHolder(dir), dataDir: dir, env: {} });
  const app = express();
  app.use(express.json());
  let admin = true;
  const adminAuth = (req, res, next) => (admin ? ((req.admin = { username: 'owner' }), next()) : res.status(401).json({ message: 'no' }));
  routes.registerMakerHostRoutes(app, { adminAuth, makerAuth: auth, getDataDir: () => dir });
  app.post('/cb', auth.requireMakerHost('callback'), (_req, res) => res.json({ ok: true }));
  const { base, close } = await serve(app);
  t.after(close);
  const json = { 'content-type': 'application/json' };

  const created = await fetch(`${base}/api/admin/maker-hosts`, { method: 'POST', headers: json, body: JSON.stringify({ label: 'Test PC', scopes: ['callback', 'jobs'] }) });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const made = await created.json();
  assert.match(made.token, /^mkr_[0-9a-f]{8}_/);
  assert.deepEqual(made.host.scopes, ['callback', 'jobs']);
  assert.equal(made.host.createdBy, 'admin:owner');
  assert.deepEqual(made.tokenEnv, { prod: 'MAKER_HUB_TOKEN', local: 'MAKER_LOCAL_HUB_TOKEN' });
  assert.equal((await fetch(`${base}/api/admin/maker-hosts`, { method: 'POST', headers: json, body: '{}' })).status, 400);

  const list = await fetch(`${base}/api/admin/maker-hosts`);
  const listText = await list.text();
  assert.equal(listText.includes(made.token), false);
  assert.equal(listText.includes('sha256:'), false);
  const listed = JSON.parse(listText);
  assert.equal(listed.hosts.length, 1);
  assert.equal(listed.legacyTokenSource, 'disk');
  assert.deepEqual(listed.scopes, ['callback', 'preview-push', 'client-bundle', 'jobs']);

  assert.equal((await fetch(`${base}/cb`, { method: 'POST', headers: { 'x-maker-host-token': made.token } })).status, 200);
  const revoked = await fetch(`${base}/api/admin/maker-hosts/${made.hostId}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.ok((await revoked.json()).host.revokedAt);
  assert.equal((await fetch(`${base}/cb`, { method: 'POST', headers: { 'x-maker-host-token': made.token } })).status, 401);
  assert.equal((await fetch(`${base}/api/admin/maker-hosts/mh_ffffffff`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(`${base}/api/admin/maker-hosts/..%2Fescape`, { method: 'DELETE' })).status, 404);

  admin = false;
  assert.equal((await fetch(`${base}/api/admin/maker-hosts`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/maker-hosts`, { method: 'POST', headers: json, body: JSON.stringify({ label: 'x' }) })).status, 401);
  assert.equal(existsSync(hostsFile(dir)), true);
});

test('Superadmin Maker hosts card: shows the token only from the create answer and never stores it in the browser', () => {
  const cardSource = readFileSync(new URL('../app/pages/Admin/sections/MakerHostsCard.tsx', import.meta.url), 'utf8');
  const section = readFileSync(new URL('../app/pages/Admin/sections/SystemSafetySection.tsx', import.meta.url), 'utf8');
  assert.match(section, /<MakerHostsCard \/>/);
  assert.ok(cardSource.includes('/admin/maker-hosts'));
  assert.doesNotMatch(cardSource, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(cardSource, /dangerouslySetInnerHTML|innerHTML/);
  assert.match(cardSource, /setFresh\(\{ hostId: body\.hostId, token: body\.token/);
});
