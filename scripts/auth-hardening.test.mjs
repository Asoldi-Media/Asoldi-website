import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginLogin,
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
import { createKnownAccountCheck } from '../lib/login-limits.js';

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

test('login limiter: ten failures for one account from ten addresses leave a right password from another address working', () => {
  const limiter = createLoginLimiter();
  for (let i = 1; i <= 10; i += 1) {
    assert.equal(limiter.check('admin:owner', `203.0.113.${i}`).ok, true);
    limiter.fail('admin:owner', `203.0.113.${i}`);
  }
  assert.equal(limiter.check('admin:owner', '198.51.100.20').ok, true, 'another address still gets to try the password');
  limiter.succeed('admin:owner', '198.51.100.20');
  assert.equal(limiter.check('admin:owner', '203.0.113.1').ok, true, 'one failure from an address does not block it');
});

test('login limiter: ten failures from one address block that account there, and only there', () => {
  let clock = 0;
  const limiter = createLoginLimiter({ now: () => clock });
  for (let i = 0; i < 10; i += 1) limiter.fail('staff:dev', '203.0.113.7');
  const here = limiter.check('staff:dev', '203.0.113.7');
  assert.equal(here.ok, false);
  assert.equal(here.retryAfterSec, 900);
  assert.equal(limiter.check('staff:dev', '203.0.113.8').ok, true, 'the same account from another address');
  assert.equal(limiter.check('staff:other', '203.0.113.7').ok, true, 'another account from the same address');
  clock = 15 * 60 * 1000;
  assert.equal(limiter.check('staff:dev', '203.0.113.7').ok, true, 'the window passes');
});

test('login limiter: an account is blocked everywhere after 100 failures, an address after 50', () => {
  const limiter = createLoginLimiter();
  for (let i = 0; i < 100; i += 1) {
    limiter.fail('client:owner@example.com', `198.51.100.${i % 100}`);
  }
  assert.equal(limiter.check('client:owner@example.com', '192.0.2.1').ok, false, 'the per-account limit is reached');
  assert.equal(limiter.check('client:other@example.com', '192.0.2.1').ok, true);
  for (let i = 0; i < 50; i += 1) limiter.fail(`client:user${i}@example.com`, '192.0.2.200');
  assert.equal(limiter.check('client:fresh@example.com', '192.0.2.200').ok, false, 'the per-address limit is reached');
  assert.equal(limiter.check('client:fresh@example.com', '192.0.2.201').ok, true);
});

test('login limiter: a right password clears only that account and address; the account and address counts keep running', () => {
  const limiter = createLoginLimiter({ maxPerPair: 3, maxPerAccount: 5, maxPerIp: 4 });
  for (let i = 0; i < 2; i += 1) limiter.fail('admin:owner', '203.0.113.1');
  limiter.succeed('admin:owner', '203.0.113.1');
  for (let i = 0; i < 2; i += 1) limiter.fail('admin:owner', '203.0.113.1');
  assert.equal(limiter.check('admin:owner', '203.0.113.1').ok, false, 'the address count (4) is reached although the pair was cleared');
  assert.equal(limiter.check('admin:owner', '203.0.113.2').ok, true);
  limiter.fail('admin:owner', '203.0.113.2');
  assert.equal(limiter.check('admin:owner', '203.0.113.3').ok, false, 'the account count (5) is reached');
  assert.equal(limiter.keys().every((key) => /^(p|a):[0-9a-f]{32}$|^i:/.test(key)), true, 'accounts are kept as short hashes');
});

test('login limiter: a full table drops made-up names first, then addresses, and keeps real accounts', () => {
  const flood = (isKnownAccount) => {
    const limiter = createLoginLimiter({ maxKeys: 40, isKnownAccount });
    for (let i = 0; i < 10; i += 1) limiter.fail('admin:owner', '203.0.113.5');
    for (let i = 0; i < 50; i += 1) limiter.fail(`staff:made-up-${i}`, '198.51.100.9');
    const afterNames = {
      size: limiter.keys().length,
      owner: limiter.check('admin:owner', '203.0.113.5').ok,
      address: limiter.check('staff:another', '198.51.100.9').ok,
    };
    for (let i = 0; i < 300; i += 1) limiter.fail(`staff:x-${i}`, `192.0.2.${i % 250}`);
    return { afterNames, size: limiter.keys().length, owner: limiter.check('admin:owner', '203.0.113.5').ok };
  };
  const real = flood((account) => account === 'admin:owner');
  assert.ok(real.afterNames.size <= 40 && real.size <= 40, `capped: ${real.afterNames.size}, ${real.size}`);
  assert.equal(real.afterNames.owner, false, 'the real account stays limited at that address');
  assert.equal(real.afterNames.address, false, 'the address count outlived the made-up names');
  assert.equal(real.owner, false, 'a flood from many addresses still does not reset the real account');
  const unknown = flood(() => false);
  assert.equal(unknown.owner, true, 'without isKnownAccount the same flood pushes the count out (the check above is what keeps it)');
  const throwing = createLoginLimiter({ isKnownAccount: () => { throw new Error('read failed'); } });
  throwing.fail('admin:owner', '203.0.113.5');
  assert.equal(throwing.keys().length, 3, 'a failing isKnownAccount counts as unknown');
});

test('known accounts: the hub admin and users.json users, case-insensitive, re-read when the files change', () => {
  const dir = tempDir();
  try {
    const adminPath = join(dir, 'admin.json');
    const usersPath = join(dir, 'users.json');
    let clock = 0;
    const isKnown = createKnownAccountCheck({ adminPath, usersPath, now: () => clock });
    assert.equal(isKnown('admin:owner'), false, 'no files yet');
    writeFileSync(adminPath, JSON.stringify({ username: 'Owner', passwordHash: 'x' }));
    writeFileSync(usersPath, JSON.stringify([{ username: 'dev@example.com' }, { username: 'Client@Example.com' }, null, {}]));
    assert.equal(isKnown('admin:owner'), false, 'within a second of the last check the files are not read again');
    clock += 1000;
    assert.equal(isKnown('admin:owner'), true);
    assert.equal(isKnown('Admin: OWNER '), true);
    assert.equal(isKnown('staff:dev@example.com'), true);
    assert.equal(isKnown('client:client@example.com'), true);
    for (const account of ['admin:dev@example.com', 'staff:owner', 'client:nobody@example.com', 'owner', ':owner', 'admin:', '', null, 'other:owner']) {
      assert.equal(isKnown(account), false, String(account));
    }
    writeFileSync(usersPath, 'not json');
    utimesSync(usersPath, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    clock += 1000;
    assert.equal(isKnown('staff:dev@example.com'), false, 'an unreadable file names nobody');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('beginLogin: one address per attempt, a 429 with Retry-After when limited, and only the first settle counts', () => {
  const limiter = createLoginLimiter({ maxPerPair: 2 });
  const req = { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } };
  const first = beginLogin(limiter, req, fakeLimitRes(), 'admin:owner');
  first.fail();
  first.fail();
  first.succeed();
  assert.equal(limiter.check('admin:owner', '203.0.113.9').ok, true, 'one failure counted, the later settles did nothing');
  beginLogin(limiter, req, fakeLimitRes(), 'admin:owner').fail();
  const res = fakeLimitRes();
  assert.equal(beginLogin(limiter, req, res, 'admin:owner'), null);
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['Retry-After']) > 0);
  assert.equal(guardLogin(limiter, req, fakeLimitRes(), 'admin:owner'), false);
  const elsewhere = { headers: { 'x-forwarded-for': '203.0.113.10' }, socket: { remoteAddress: '127.0.0.1' } };
  const ok = beginLogin(limiter, elsewhere, fakeLimitRes(), 'admin:owner');
  ok.succeed();
  assert.equal(guardLogin(limiter, elsewhere, fakeLimitRes(), 'admin:owner'), true);
});

test('a client-written leading X-Forwarded-For entry cannot reset the per-IP login counter', () => {
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
