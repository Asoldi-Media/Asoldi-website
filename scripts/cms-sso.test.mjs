import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import {
  cmsOrigin,
  cmsSsoFormatForVersion,
  createCmsSsoStore,
  createRedeemLimiter,
  hashCmsSsoToken,
  mintSiteKeyCmsSsoToken,
  parseCmsVersion,
  registerCmsSsoRoutes,
} from '../lib/cms-sso.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const site = { id: '42', site_key: 'key-42', domain: 'https://shop.example/', cms: { adminUrl: 'https://snow.example.com/admin', packageVersion: '2.2.1' } };
const otherSite = { id: '43', site_key: 'key-43', domain: 'https://other.example', cms: { packageVersion: '2.2.1' } };
const legacySite = { id: '44', site_key: 'key-44', domain: 'https://legacy.example', cms: { packageVersion: '2.1.3' } };
const oldSite = { id: '45', site_key: 'key-45', domain: 'https://old.example', cms: { packageVersion: '1.7.1' } };
const newSite = { id: '46', site_key: 'key-46', domain: 'https://new.example', cms: { packageVersion: '' } };
const ALL = [site, otherSite, legacySite, oldSite, newSite, { id: '7', site_key: 'k7' }];
const byId = (id) => ALL.find((s) => s.id === id) || null;
const byKey = (key) => ALL.find((s) => s.site_key === key) || null;

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'hub-cms-sso-'));
}

async function boot({ dataDir, clock } = {}) {
  const app = express();
  app.use(express.json());
  const adminAuth = (req, res, next) => (req.get('authorization') === 'Bearer ok' ? ((req.admin = { username: 'staff-one' }), next()) : res.status(401).end());
  const now = clock ? () => clock.t : undefined;
  const registered = registerCmsSsoRoutes(app, { adminAuth, getSiteById: byId, getSiteByKey: byKey, dataDir, now });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, registered, close: () => new Promise((r) => server.close(r)) };
}

async function withHub(fn, options = {}) {
  const dataDir = tempDir();
  const hub = await boot({ dataDir, ...options });
  try {
    await fn(hub);
  } finally {
    await hub.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function link(base, id) {
  const res = await fetch(`${base}/api/hub/sites/${id}/cms-sso`, { method: 'POST', headers: { authorization: 'Bearer ok' } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const tokenOf = (url) => new URL(url).searchParams.get('token');

async function redeem(base, { token, siteKey, via = 'header', ip } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (via === 'header' && siteKey !== undefined) headers['x-site-key'] = siteKey;
  if (ip) headers['x-forwarded-for'] = ip;
  const body = via === 'body' ? { token, site_key: siteKey } : { token };
  const res = await fetch(`${base}/api/cms/sso/redeem`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}

test('HS-1: CMS origin prefers the heartbeat admin URL, falls back to the domain', () => {
  assert.equal(cmsOrigin(site), 'https://snow.example.com');
  assert.equal(cmsOrigin({ domain: 'shop.example' }), 'https://shop.example');
  assert.equal(cmsOrigin({}), '');
});

test('HS-1: the link format follows the CMS version from the heartbeat', () => {
  assert.deepEqual(parseCmsVersion('2.2.1'), [2, 2, 1, '']);
  assert.equal(parseCmsVersion('next'), null);
  assert.equal(cmsSsoFormatForVersion('2.2.1'), 'redeem');
  assert.equal(cmsSsoFormatForVersion('v2.3.0'), 'redeem');
  assert.equal(cmsSsoFormatForVersion('10.0.0'), 'redeem');
  assert.equal(cmsSsoFormatForVersion(''), 'redeem', 'no heartbeat yet: the current format');
  assert.equal(cmsSsoFormatForVersion('2.2.0'), 'site-key');
  assert.equal(cmsSsoFormatForVersion('2.1.3'), 'site-key');
  assert.equal(cmsSsoFormatForVersion('2.0.0'), 'site-key');
  assert.equal(cmsSsoFormatForVersion('2.2.1-rc.1'), 'site-key', 'a prerelease sorts before its release');
  assert.equal(cmsSsoFormatForVersion('1.7.1'), 'none');
});

test('HS-1: the site-key format is kept for CMS 2.0.0 up to 2.2.0 (60 s, fresh nonce)', () => {
  const token = mintSiteKeyCmsSsoToken(legacySite, { by: 'staff-one', now: 1_000 });
  const { data, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
  assert.equal(sig, createHmac('sha256', 'key-44').update(data).digest('hex'));
  const body = JSON.parse(data);
  assert.equal(body.sid, '44');
  assert.equal(body.exp, 61_000);
  assert.match(body.n, /^[a-f0-9]{32}$/);
  assert.notEqual(JSON.parse(Buffer.from(mintSiteKeyCmsSsoToken(legacySite), 'base64url').toString()).data, data, 'fresh nonce each time');
});

test('HS-1: only admins get a link, unknown sites 404, sites without an address or with CMS 1.x 409', async () => {
  await withHub(async (hub) => {
    assert.equal((await fetch(`${hub.base}/api/hub/sites/42/cms-sso`, { method: 'POST' })).status, 401);
    const ok = await link(hub.base, '42');
    assert.equal(ok.status, 200);
    assert.match(ok.body.url, /^https:\/\/snow\.example\.com\/api\/cms\/admin\/sso\?token=[A-Za-z0-9_-]{43}$/);
    assert.equal(ok.body.expiresInSeconds, 60);
    assert.equal(ok.body.format, 'redeem');
    assert.equal((await link(hub.base, '99')).status, 404);
    assert.equal((await link(hub.base, '7')).status, 409);
    const old = await link(hub.base, '45');
    assert.equal(old.status, 409);
    assert.match(old.body.message, /1\.7\.1/);
  });
});

test('HS-1: a 2.2.1 site gets an opaque token that carries nothing signed with its site key', async () => {
  await withHub(async (hub) => {
    const token = tokenOf((await link(hub.base, '42')).body.url);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32, '32 random bytes');
    let decoded = null;
    try {
      decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    } catch {
      decoded = null;
    }
    assert.equal(decoded, null, 'not a signed JSON envelope');
    const stored = readFileSync(hub.registered.store().tokensPath(), 'utf8');
    assert.ok(!stored.includes(token), 'the token itself is never stored');
    const row = JSON.parse(stored).tokens[hashCmsSsoToken(token)];
    assert.equal(row.siteId, '42');
    assert.equal(row.by, 'staff-one');
    assert.equal(row.exp - row.createdAt, 60_000);
  });
});

test('HS-1: site-key format for 2.1.3, redeem for an unreported version, and each link is audited', async () => {
  await withHub(async (hub) => {
    const legacy = await link(hub.base, '44');
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.format, 'site-key');
    const raw = JSON.parse(Buffer.from(tokenOf(legacy.body.url), 'base64url').toString());
    assert.equal(raw.sig, createHmac('sha256', 'key-44').update(raw.data).digest('hex'));
    const fresh = await link(hub.base, '46');
    assert.equal(fresh.body.format, 'redeem');
    const rows = hub.registered.store().auditLog();
    assert.deepEqual(rows.map((r) => [r.action, r.siteId, r.format, r.packageVersion, r.by]), [
      ['link', '44', 'site-key', '2.1.3', 'staff-one'],
      ['link', '46', 'redeem', '', 'staff-one'],
    ]);
    const auditText = readFileSync(hub.registered.store().auditPath(), 'utf8');
    assert.ok(!auditText.includes(tokenOf(fresh.body.url)), 'no token in the audit');
  });
});

test('HS-4: redeem accepts a token once, for its own site, with the key in the header or the body', async () => {
  await withHub(async (hub) => {
    const first = tokenOf((await link(hub.base, '42')).body.url);
    const ok = await redeem(hub.base, { token: first, siteKey: 'key-42' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true, by: 'staff-one' });
    assert.equal(ok.headers.get('cache-control'), 'no-store');

    const replay = await redeem(hub.base, { token: first, siteKey: 'key-42' });
    assert.equal(replay.status, 401, 'a token is burned on first use');
    assert.deepEqual(replay.body, { ok: false, message: 'Unauthorized.' });

    const second = tokenOf((await link(hub.base, '42')).body.url);
    assert.equal((await redeem(hub.base, { token: second, siteKey: 'key-42', via: 'body' })).status, 200, 'site key in the body');

    const rows = hub.registered.store().auditLog().filter((r) => r.action === 'redeem');
    assert.deepEqual(rows.map((r) => [r.ok, r.reason || '', r.siteId]), [[true, '', '42'], [false, 'used', '42'], [true, '', '42']]);
  });
});

test('HS-4: a token for another site, an unknown or malformed token and a missing key get the same 401', async () => {
  await withHub(async (hub) => {
    const token = tokenOf((await link(hub.base, '42')).body.url);
    const cross = await redeem(hub.base, { token, siteKey: 'key-43' });
    assert.equal(cross.status, 401, 'token minted for site 42, presented with the key of site 43');
    const unknown = await redeem(hub.base, { token: 'A'.repeat(43), siteKey: 'key-42' });
    const malformed = await redeem(hub.base, { token: 'not a token', siteKey: 'key-42' });
    const noKey = await redeem(hub.base, { token });
    const wrongKey = await redeem(hub.base, { token, siteKey: 'key-42x' });
    for (const res of [unknown, malformed, noKey, wrongKey]) {
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, cross.body, 'one generic body for every refusal');
    }
    assert.equal((await redeem(hub.base, { token, siteKey: 'key-42' })).status, 200, 'refusals elsewhere do not burn the token for its own site');
    const signed = mintSiteKeyCmsSsoToken(site);
    assert.equal((await redeem(hub.base, { token: signed, siteKey: 'key-42' })).status, 401, 'a token signed with the site key is not a hub token');
    const reasons = hub.registered.store().auditLog().filter((r) => r.action === 'redeem' && !r.ok).map((r) => r.reason);
    assert.deepEqual(reasons, ['other-site', 'unknown', 'malformed', 'malformed', 'other-site', 'malformed']);
  });
});

test('HS-4: a token expires after 60 seconds, and settled rows are pruned', async () => {
  const clock = { t: 1_000_000 };
  await withHub(async (hub) => {
    const late = tokenOf((await link(hub.base, '42')).body.url);
    const onTime = tokenOf((await link(hub.base, '42')).body.url);
    clock.t += 59_999;
    assert.equal((await redeem(hub.base, { token: onTime, siteKey: 'key-42' })).status, 200);
    clock.t += 1;
    assert.equal((await redeem(hub.base, { token: late, siteKey: 'key-42' })).status, 401);
    const reasons = hub.registered.store().auditLog().filter((r) => r.action === 'redeem').map((r) => r.reason || 'ok');
    assert.deepEqual(reasons, ['ok', 'expired']);
    clock.t += 11 * 60_000;
    await link(hub.base, '42');
    const rows = JSON.parse(readFileSync(hub.registered.store().tokensPath(), 'utf8')).tokens;
    assert.equal(Object.keys(rows).length, 1, 'settled rows are pruned after ten minutes');
  }, { clock });
});

test('HS-4: failed redeems are limited per site and address; other addresses keep working', async () => {
  await withHub(async (hub) => {
    const bogus = 'B'.repeat(43);
    for (let i = 0; i < 10; i += 1) assert.equal((await redeem(hub.base, { token: bogus, siteKey: 'key-42', ip: '203.0.113.9' })).status, 401);
    const limited = await redeem(hub.base, { token: bogus, siteKey: 'key-42', ip: '203.0.113.9' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const spoofed = await redeem(hub.base, { token: bogus, siteKey: 'key-42', ip: '192.0.2.1, 203.0.113.9' });
    assert.equal(spoofed.status, 429, 'a client-written first hop does not change the counted address');
    const good = tokenOf((await link(hub.base, '42')).body.url);
    assert.equal((await redeem(hub.base, { token: good, siteKey: 'key-42', ip: '203.0.113.9' })).status, 429, 'a limited pair waits even with a good token');
    assert.equal((await redeem(hub.base, { token: good, siteKey: 'key-42', ip: '198.51.100.7' })).status, 200, 'the site from another address still works');
  });
});

test('HS-4: limiter counts per address across sites and per site across addresses, with bounded memory', () => {
  let t = 0;
  const limiter = createRedeemLimiter({ windowMs: 1000, maxPerPair: 3, maxPerIp: 5, maxPerSite: 6, maxKeys: 50, now: () => t });
  for (let i = 0; i < 5; i += 1) limiter.fail({ ip: '1.1.1.1', siteId: '' });
  assert.equal(limiter.check({ ip: '1.1.1.1', siteId: '42' }).ok, false, 'an address with five failures is limited for every site');
  assert.equal(limiter.check({ ip: '2.2.2.2', siteId: '42' }).ok, true);
  for (let i = 0; i < 6; i += 1) limiter.fail({ ip: `9.9.9.${i}`, siteId: '43' });
  assert.equal(limiter.check({ ip: '8.8.8.8', siteId: '43' }).ok, false, 'a site with six failures from many addresses is limited');
  for (let i = 0; i < 500; i += 1) limiter.fail({ ip: `10.0.${i}.1`, siteId: '' });
  assert.ok(limiter.size() <= 50, `key count ${limiter.size()} is capped`);
  assert.equal(limiter.check({ ip: '8.8.8.8', siteId: '43' }).ok, false, 'site counts are never evicted inside the window');
  t = 1001;
  assert.equal(limiter.check({ ip: '8.8.8.8', siteId: '43' }).ok, true, 'the window slides');
});

test('HS-4: four processes redeeming one token at the same time accept it once', async () => {
  const dataDir = tempDir();
  try {
    const store = createCmsSsoStore({ dataDir });
    const { token } = store.mint(site, { by: 'staff-one' });
    const moduleUrl = pathToFileURL(path.join(HERE, '..', 'lib', 'cms-sso.js')).href;
    const code = [
      `import { createCmsSsoStore } from ${JSON.stringify(moduleUrl)};`,
      'const store = createCmsSsoStore({ dataDir: process.env.SSO_DIR });',
      "const site = { id: '42', site_key: 'key-42' };",
      'let accepted = 0;',
      "for (let i = 0; i < 20; i += 1) if (store.redeem({ token: process.env.SSO_TOKEN, siteKey: 'key-42', getSiteById: () => site }).ok) accepted += 1;",
      'process.stdout.write(String(accepted));',
    ].join('\n');
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SSO_DIR: dataDir, SSO_TOKEN: token } });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('exit', (status) => (status === 0 ? resolve(Number(out)) : reject(new Error(`worker exit ${status}: ${err}`))));
    });
    const counts = await Promise.all([run(), run(), run(), run()]);
    assert.equal(counts.reduce((a, b) => a + b, 0), 1, `exactly one accept across four processes (${counts})`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
