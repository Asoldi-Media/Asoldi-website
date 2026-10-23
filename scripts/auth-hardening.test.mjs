import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clientIpFromRequest,
  createLoginLimiter,
  createStaffMediaGate,
  guardLogin,
  isInternalAddress,
  isTokenFresh,
  readOrCreateDiskSecret,
  safeEqual,
  DEFAULT_TOKEN_MAX_AGE_MS,
} from '../lib/auth-hardening.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'auth-hardening-'));
}

test('disk secret is created once and reused', () => {
  const dir = tempDir();
  try {
    const first = readOrCreateDiskSecret(dir, 'admin-secret');
    assert.match(first, /^[0-9a-f]{96}$/);
    assert.equal(readOrCreateDiskSecret(dir, 'admin-secret'), first);
    assert.equal(readFileSync(join(dir, 'secrets', 'admin-secret'), 'utf8').trim(), first);
    assert.notEqual(readOrCreateDiskSecret(dir, 'other-secret'), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disk secret replaces a truncated file and refuses path names', () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(join(dir, 'secrets', 'admin-secret'), 'short\n');
    const value = readOrCreateDiskSecret(dir, 'admin-secret');
    assert.ok(value.length >= 32);
    assert.throws(() => readOrCreateDiskSecret(dir, '../escape'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('safeEqual compares exactly', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual(undefined, 'x'), false);
});

test('tokens need a recent issue time', () => {
  const now = 1_800_000_000_000;
  assert.equal(isTokenFresh({ at: now - 1000 }, { now }), true);
  assert.equal(isTokenFresh({ at: now - DEFAULT_TOKEN_MAX_AGE_MS - 1 }, { now }), false);
  assert.equal(isTokenFresh({ at: now + 60 * 60 * 1000 }, { now }), false);
  assert.equal(isTokenFresh({ role: 'admin' }, { now }), false);
  assert.equal(isTokenFresh(null, { now }), false);
});

test('login limiter blocks an account after repeated failures and resets on success', () => {
  let clock = 0;
  const limiter = createLoginLimiter({ maxPerAccount: 3, maxPerIp: 100, windowMs: 1000, now: () => clock });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.check('Admin:X', '1.1.1.1').ok, true);
    limiter.fail('Admin:X', '1.1.1.1');
  }
  const blocked = limiter.check('admin:x', '2.2.2.2');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.equal(limiter.check('admin:other', '2.2.2.2').ok, true);
  clock = 1500;
  assert.equal(limiter.check('admin:x', '2.2.2.2').ok, true);
  limiter.fail('admin:x', '');
  limiter.succeed('admin:x');
  assert.equal(limiter.check('admin:x', '').ok, true);
});

test('login limiter blocks one IP spraying many accounts', () => {
  const limiter = createLoginLimiter({ maxPerAccount: 100, maxPerIp: 5, windowMs: 60_000 });
  for (let i = 0; i < 5; i += 1) limiter.fail(`user${i}`, '9.9.9.9');
  assert.equal(limiter.check('fresh-user', '9.9.9.9').ok, false);
  assert.equal(limiter.check('fresh-user', '8.8.8.8').ok, true);
});

function fakeLimitRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('a forged leading X-Forwarded-For entry cannot reset the per-IP login counter', () => {
  const limiter = createLoginLimiter({ maxPerAccount: 100, maxPerIp: 3, windowMs: 60_000 });
  // The client sends a new fake address each time; the hosting proxy appends the real one,
  // and an internal hop may follow it.
  const request = (i) => ({
    headers: { 'x-forwarded-for': `198.51.100.${i}, 1.2.3.${i}, 203.0.113.7${i % 2 ? ', 10.0.0.5' : ''}` },
    socket: { remoteAddress: '127.0.0.1' },
  });
  for (let i = 0; i < 3; i += 1) {
    const req = request(i);
    assert.equal(clientIpFromRequest(req), '203.0.113.7');
    assert.equal(guardLogin(limiter, req, fakeLimitRes(), `account${i}`), true);
    limiter.fail(`account${i}`, clientIpFromRequest(req));
  }
  const res = fakeLimitRes();
  assert.equal(guardLogin(limiter, request(99), res, 'another-account'), false, 'the fourth try from that address is throttled');
  assert.equal(res.statusCode, 429);

  assert.equal(clientIpFromRequest({ headers: {}, socket: { remoteAddress: '::ffff:192.0.2.9' } }), '::ffff:192.0.2.9');
  assert.equal(clientIpFromRequest({ headers: { 'x-forwarded-for': '10.1.2.3' }, socket: { remoteAddress: '127.0.0.1' } }), '10.1.2.3');
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isInternalAddress(ip), true, ip);
  }
  for (const ip of ['203.0.113.7', '172.32.0.1', '100.128.0.1', '8.8.8.8', '2001:db8::1']) assert.equal(isInternalAddress(ip), false, ip);
});

function fakeRes() {
  return {
    statusCode: 200,
    body: '',
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
  };
}

test('staff media gate lets only signed-in staff through', () => {
  const tokens = { staff: { role: 'sales' }, client: { role: 'client' } };
  const gate = createStaffMediaGate((token) => tokens[token] || null);
  for (const [header, expected] of [
    [undefined, 401],
    ['Bearer nope', 401],
    ['Bearer client', 401],
    ['Bearer staff', 200],
  ]) {
    const res = fakeRes();
    let passed = false;
    gate({ headers: header ? { authorization: header } : {} }, res, () => { passed = true; });
    assert.equal(passed ? 200 : res.statusCode, expected, String(header));
  }
});

test('site config by domain never carries admin data', async () => {
  const dir = tempDir();
  const previous = process.env.APP_DATA_DIR;
  process.env.APP_DATA_DIR = dir;
  try {
    writeFileSync(join(dir, 'sites.json'), JSON.stringify([{
      id: 'site-1',
      name: 'Test',
      domain: 'example.no',
      site_key: 'k'.repeat(32),
      clientAdmin: { email: 'owner@example.no', username: 'owner', passwordHash: '$2a$10$abcdefghijklmnopqrstuv', pendingSync: true },
    }]));
    const hub = await import(`../data/hub.js?case=${Date.now()}`);
    const byDomain = hub.getSiteConfig('example.no', true);
    assert.ok(byDomain);
    assert.equal(byDomain.pendingAdmin, undefined);
    assert.equal(byDomain.clientAdmin, undefined);
    const byKey = hub.getSiteConfig('k'.repeat(32), false);
    assert.equal(byKey.pendingAdmin?.passwordHash, '$2a$10$abcdefghijklmnopqrstuv');
  } finally {
    if (previous === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
