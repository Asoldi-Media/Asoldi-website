import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

// data/storage-path.js fixes the data dir when it is first loaded, and lib/cms-sso.js loads it. So
// this file's own data dir is set before any hub module is imported: run on its own, without
// APP_DATA_DIR, the file then never writes into the local hub data folder.
const fileDataDir = mkdtempSync(path.join(tmpdir(), 'hub-cms-sso-data-'));
process.env.APP_DATA_DIR = fileDataDir;
const {
  cmsOrigin,
  cmsSsoFormatForVersion,
  cmsSsoOrigin,
  cmsSsoVersionForSite,
  createCmsSsoStore,
  createQuietCounter,
  createRedeemLimiter,
  hashCmsSsoToken,
  findSiteByKeyConstantTime,
  mintSiteKeyCmsSsoToken,
  parseCmsVersion,
  registerCmsSsoRoutes,
} = await import('../lib/cms-sso.js');
const { useClientAddressSettingsFrom } = await import('../lib/client-address.js');
const { updateSecuritySettings } = await import('../data/security-settings.js');
const { getPersistentDataDir } = await import('../data/storage-path.js');
test.after(() => rmSync(fileDataDir, { recursive: true, force: true }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const site = { id: '42', site_key: 'key-42', domain: 'https://shop.example/', cms: { adminUrl: 'https://snow.example.com/admin', packageVersion: '2.2.1' } };
const otherSite = { id: '43', site_key: 'key-43', domain: 'https://other.example', cms: { packageVersion: '2.2.1' } };
const legacySite = { id: '44', site_key: 'key-44', domain: 'https://legacy.example', cms: { packageVersion: '2.1.3' } };
const oldSite = { id: '45', site_key: 'key-45', domain: 'https://old.example', cms: { packageVersion: '1.7.1' } };
const newSite = { id: '46', site_key: 'key-46', domain: 'https://new.example', cms: { packageVersion: '' } };
const noDomainSite = { id: '47', site_key: 'key-47', domain: '', cms: { adminUrl: 'https://cms.example.net/admin', packageVersion: '2.2.1' } };
// Trusted 2.1.3; its last heartbeat without a credential reports 2.2.2 (moved to 2.2.2 before it enrolled).
const movedSite = { id: '48', site_key: 'key-48', domain: 'https://moved.example', cms: { packageVersion: '2.1.3', unverified: { packageVersion: '2.2.2', at: '2026-10-23T00:00:00.000Z' } } };
const ALL = [site, otherSite, legacySite, oldSite, newSite, noDomainSite, movedSite, { id: '7', site_key: 'k7' }];
const byId = (id) => ALL.find((s) => s.id === id) || null;

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'hub-cms-sso-'));
}

async function boot({ dataDir, clock, quiet, getAllSites = () => ALL } = {}) {
  const app = express();
  app.use(express.json());
  const adminAuth = (req, res, next) => (req.get('authorization') === 'Bearer ok' ? ((req.admin = { username: 'staff-one' }), next()) : res.status(401).end());
  const now = clock ? () => clock.t : undefined;
  const registered = registerCmsSsoRoutes(app, { adminAuth, getSiteById: byId, getAllSites, dataDir, now, quiet });
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

test('HS-1: a sign-in link goes to the stored domain over https; a reported address on another host is ignored', () => {
  assert.deepEqual(cmsSsoOrigin(site), { origin: 'https://shop.example', source: 'domain', ignoredHost: 'snow.example.com' });
  const at = (domain, adminUrl) => cmsSsoOrigin({ domain, cms: { adminUrl } }).origin;
  assert.equal(at('shop.example', 'https://www.shop.example/admin'), 'https://www.shop.example', 'the report picks the www spelling of the same host');
  assert.equal(at('www.shop.example', 'https://shop.example/admin'), 'https://shop.example');
  assert.equal(at('shop.example', 'http://shop.example/admin'), 'https://shop.example', 'an http report still gives https');
  assert.equal(at('http://shop.example', ''), 'https://shop.example', 'an http domain still gives https');
  assert.equal(at('shop.example', 'https://shop.example:8443/admin'), 'https://shop.example', 'a reported port is not used');
  assert.equal(at('shop.example', 'https://shop.example.other.example/admin'), 'https://shop.example');
  assert.equal(at('shop.example', 'https://evilshop.example/admin'), 'https://shop.example');
  const withCredentials = new URL('https://shop.example/admin');
  withCredentials.username = 'user';
  withCredentials.password = 'pw';
  assert.equal(at('shop.example', withCredentials.href), 'https://shop.example', 'a report with credentials is not used');
  assert.equal(at('shop.example', 'http://127.0.0.1:4200/admin'), 'https://shop.example', 'a loopback report on a public domain is ignored');
  assert.equal(at('kafé.example', 'https://www.xn--kaf-dma.example/admin'), 'https://www.xn--kaf-dma.example', 'Unicode and punycode spellings match');
  assert.equal(at('127.0.0.1:4100', 'http://127.0.0.1:4200/admin'), 'http://127.0.0.1:4200', 'local runs keep http and the reported port');
  assert.equal(at('127.0.0.1:4100', ''), 'http://127.0.0.1:4100');
  assert.equal(at('localhost:4100', 'http://127.0.0.1:4200/admin'), 'http://localhost:4100');
  assert.deepEqual(cmsSsoOrigin(noDomainSite), { origin: '', source: '', ignoredHost: 'cms.example.net' }, 'no domain, no link');
  assert.equal(cmsSsoOrigin({}).origin, '');
  assert.equal(cmsOrigin(site), 'https://snow.example.com', 'cmsOrigin still prefers the reported address');
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

test('HS-1: the link format follows the newer of the trusted version and a report without the credential', async () => {
  assert.deepEqual(cmsSsoVersionForSite(movedSite), { packageVersion: '2.2.2', from: 'unverified-heartbeat' });
  assert.deepEqual(cmsSsoVersionForSite({ cms: { packageVersion: '2.2.2', unverified: { packageVersion: '2.1.3' } } }), { packageVersion: '2.2.2', from: 'heartbeat' }, 'an older report never lowers it');
  assert.deepEqual(cmsSsoVersionForSite({ cms: { packageVersion: '', unverified: { packageVersion: '2.1.3' } } }), { packageVersion: '2.1.3', from: 'unverified-heartbeat' });
  assert.deepEqual(cmsSsoVersionForSite({ cms: { packageVersion: '2.1.3', unverified: { packageVersion: 'junk' } } }), { packageVersion: '2.1.3', from: 'heartbeat' });
  assert.deepEqual(cmsSsoVersionForSite(legacySite), { packageVersion: '2.1.3', from: 'heartbeat' });
  await withHub(async (hub) => {
    const res = await link(hub.base, '48');
    assert.equal(res.status, 200);
    assert.equal(res.body.format, 'redeem', 'a site that moved to 2.2.2 before it enrolled gets a link 2.2.x accepts');
    const row = hub.registered.store().auditLog().at(-1);
    assert.equal(row.packageVersion, '2.2.2');
    assert.equal(row.versionFrom, 'unverified-heartbeat');
  });
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
    assert.match(ok.body.url, /^https:\/\/shop\.example\/api\/cms\/admin\/sso\?token=[A-Za-z0-9_-]{43}$/, 'the stored domain, not the reported address');
    assert.equal(ok.body.expiresInSeconds, 60);
    assert.equal(ok.body.format, 'redeem');
    assert.equal((await link(hub.base, '99')).status, 404);
    assert.equal((await link(hub.base, '7')).status, 409);
    assert.equal((await link(hub.base, '47')).status, 409, 'a reported address alone is not enough');
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
    assert.deepEqual(rows.map((r) => [r.action, r.siteId, r.format, r.packageVersion, r.by, r.origin, r.originFrom]), [
      ['link', '44', 'site-key', '2.1.3', 'staff-one', 'https://legacy.example', 'domain'],
      ['link', '46', 'redeem', '', 'staff-one', 'https://new.example', 'domain'],
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
  const quiet = createQuietCounter({ log: () => {} });
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
    const refusals = hub.registered.store().auditLog().filter((r) => r.action === 'redeem' && !r.ok);
    assert.deepEqual(refusals.map((r) => [r.reason, r.siteId, r.via]), [['other-site', '42', '43']], 'only refusals of a real token are audited');
    assert.deepEqual(quiet.totals(), { unknown: 1, malformed: 2, 'no-site': 2 }, 'the rest are counted in memory');
  }, { quiet });
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

const junkToken = () => randomBytes(32).toString('base64url');

test('HS-4: junk tokens with a valid site key are never limited, so the next real link from that address works', async () => {
  await withHub(async (hub) => {
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await redeem(hub.base, { token: junkToken(), siteKey: 'key-42', ip: '203.0.113.9' })).status, 401);
    }
    assert.equal((await redeem(hub.base, { token: 'not a token', siteKey: 'key-42', ip: '203.0.113.9' })).status, 401);
    const good = tokenOf((await link(hub.base, '42')).body.url);
    assert.equal((await redeem(hub.base, { token: good, siteKey: 'key-42', ip: '203.0.113.9' })).status, 200, 'a CMS passing on junk from its visitors keeps working');
    assert.equal(hub.registered.limiter.size(), 0, 'nothing was counted');
    for (let i = 0; i < 3; i += 1) assert.equal((await redeem(hub.base, { token: good, siteKey: 'key-42', ip: '203.0.113.9' })).status, 401, 'a used token stays refused');
    assert.equal(hub.registered.limiter.check({ ip: '203.0.113.9', siteId: '42' }).ok, true);
  });
});

test('HS-4: calls without a known site key are limited per address; a known key from that address still works', async () => {
  await withHub(async (hub) => {
    for (let i = 0; i < 30; i += 1) assert.equal((await redeem(hub.base, { token: junkToken(), siteKey: `guess-${i}`, ip: '203.0.113.9' })).status, 401);
    const limited = await redeem(hub.base, { token: junkToken(), siteKey: 'guess-x', ip: '203.0.113.9' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const extraHop = await redeem(hub.base, { token: junkToken(), siteKey: 'guess-y', ip: '192.0.2.1, 203.0.113.9' });
    assert.equal(extraHop.status, 429, 'a client-written first hop does not change the counted address');
    assert.equal((await redeem(hub.base, { token: junkToken(), ip: '203.0.113.9' })).status, 429, 'no key at all counts the same way');
    const good = tokenOf((await link(hub.base, '42')).body.url);
    assert.equal((await redeem(hub.base, { token: good, siteKey: 'key-42', ip: '203.0.113.9' })).status, 200, 'another tenant on a shared address cannot block a real site');
  });
});

test('redeem: the per-address limit uses the trusted-hop setting of the sign-in limits, so visitors behind one CDN can be counted apart', async () => {
  const settingsDir = tempDir();
  const setHops = (loginTrustedHops) => updateSecuritySettings({ loginTrustedHops }, { dataDir: settingsDir, by: 'admin:tester' });
  // The hosting proxy (the loopback peer here) appends the CDN's address; the CDN appended the caller's.
  const viaCdn = (caller) => `${caller}, 203.0.113.250`;
  useClientAddressSettingsFrom(settingsDir);
  try {
    await withHub(async (hub) => {
      for (let i = 0; i < 30; i += 1) assert.equal((await redeem(hub.base, { token: junkToken(), siteKey: `guess-${i}`, ip: viaCdn('198.51.100.71') })).status, 401);
      assert.equal((await redeem(hub.base, { token: junkToken(), siteKey: 'guess-x', ip: viaCdn('198.51.100.72') })).status, 429, 'by default every caller behind the CDN shares its entry, as before');
      setHops(2);
      for (let i = 0; i < 30; i += 1) assert.equal((await redeem(hub.base, { token: junkToken(), siteKey: `guess-${i}`, ip: viaCdn('198.51.100.73') })).status, 401, 'with 2 hops the CDN entry no longer counts');
      assert.equal((await redeem(hub.base, { token: junkToken(), siteKey: 'guess-x', ip: viaCdn('198.51.100.73') })).status, 429, 'the busy caller is still limited');
      assert.equal((await redeem(hub.base, { token: junkToken(), siteKey: 'guess-y', ip: viaCdn('198.51.100.74') })).status, 401, 'another caller behind the CDN has a count of its own');
    });
  } finally {
    useClientAddressSettingsFrom('');
    rmSync(settingsDir, { recursive: true, force: true });
  }
});

test('HS-4: live tokens of another site are limited per (site, address)', async () => {
  await withHub(async (hub) => {
    for (let i = 0; i < 10; i += 1) {
      const foreign = tokenOf((await link(hub.base, '43')).body.url);
      assert.equal((await redeem(hub.base, { token: foreign, siteKey: 'key-42', ip: '203.0.113.9' })).status, 401);
    }
    const foreign = tokenOf((await link(hub.base, '43')).body.url);
    assert.equal((await redeem(hub.base, { token: foreign, siteKey: 'key-42', ip: '203.0.113.9' })).status, 429);
    const good = tokenOf((await link(hub.base, '42')).body.url);
    assert.equal((await redeem(hub.base, { token: good, siteKey: 'key-42', ip: '203.0.113.9' })).status, 429, 'a limited pair waits even with a good token');
    assert.equal((await redeem(hub.base, { token: good, siteKey: 'key-42', ip: '198.51.100.7' })).status, 200, 'the site from another address still works');
    assert.equal((await redeem(hub.base, { token: foreign, siteKey: 'key-43', ip: '203.0.113.9' })).status, 200, 'the other site is not affected');
  });
});

/** Sites whose site_key reads are counted, so a test can see that a lookup compares every key. */
function countingSites(count) {
  const reads = new Array(count).fill(0);
  const sites = Array.from({ length: count }, (_, i) => {
    const row = { id: String(100 + i), domain: `https://s${i}.example`, cms: { packageVersion: '2.2.1' } };
    Object.defineProperty(row, 'site_key', { enumerable: true, get() { reads[i] += 1; return `key-${100 + i}`; } });
    return row;
  });
  return { sites, reads, reset: () => reads.fill(0) };
}

test('HS-4: the site-key lookup compares every site, whichever one matches or none', () => {
  const { sites, reads, reset } = countingSites(6);
  for (const [key, expected] of [['key-100', '100'], ['key-103', '103'], ['key-105', '105'], ['key-999', null], ['key-10', null], ['', null], [undefined, null]]) {
    reset();
    assert.equal(findSiteByKeyConstantTime(sites, key)?.id ?? null, expected, String(key));
    assert.deepEqual(reads, Array(6).fill(1), `every key is read exactly once for ${String(key)}`);
  }
  assert.equal(findSiteByKeyConstantTime(sites, '  key-102 ')?.id, '102', 'the given key is trimmed, as the route does');
  assert.equal(findSiteByKeyConstantTime([{ id: 'x' }, null, { id: 'y', site_key: '' }], ''), null, 'a site without a key never matches an empty key');
  assert.equal(findSiteByKeyConstantTime(null, 'key-100'), null);
});

test('HS-4: the redeem route looks the key up across all sites without stopping at the match', async () => {
  const { sites, reads, reset } = countingSites(5);
  const all = [...sites, site];
  await withHub(async (hub) => {
    const token = tokenOf((await link(hub.base, '42')).body.url);
    reset();
    const first = await redeem(hub.base, { token: junkToken(), siteKey: 'key-100' });
    assert.equal(first.status, 401, 'a junk token for the first site');
    assert.ok(reads.every((n) => n >= 1), `the first site matched, and every other key was still compared (reads ${reads})`);
    reset();
    assert.equal((await redeem(hub.base, { token, siteKey: 'key-42' })).status, 200, 'the last site in the list');
    assert.deepEqual(reads, Array(5).fill(1));
  }, { getAllSites: () => all });
});

test('HS-4: registering the routes without the all-sites lookup throws instead of answering every redeem with 401', () => {
  const app = { get() {}, post() {}, put() {}, delete() {} };
  const adminAuth = (_req, _res, next) => next();
  const getSiteById = () => null;
  assert.throws(() => registerCmsSsoRoutes(app, { adminAuth, getSiteById }), /getAllSites are required/);
  assert.throws(() => registerCmsSsoRoutes(app, { adminAuth, getSiteById, getSiteByKey: () => site }), /getAllSites are required/,
    'the earlier single-site lookup is no longer enough');
  assert.throws(() => registerCmsSsoRoutes(app, { adminAuth, getSiteById, getAllSites: ALL }), /getAllSites are required/, 'a list, not a function');
  assert.throws(() => registerCmsSsoRoutes(app, { getSiteById, getAllSites: () => ALL }), /required/);
  assert.throws(() => registerCmsSsoRoutes(app, { adminAuth, getAllSites: () => ALL }), /required/);
  assert.doesNotThrow(() => registerCmsSsoRoutes(app, { adminAuth, getSiteById, getAllSites: () => ALL }));
});

test('HS-4: limiter counts pairs and addresses in a sliding window with bounded memory', () => {
  let t = 0;
  const limiter = createRedeemLimiter({ windowMs: 1000, maxPerPair: 3, maxPerIp: 5, maxKeys: 50, now: () => t });
  for (let i = 0; i < 5; i += 1) limiter.fail({ ip: '1.1.1.1', siteId: '' });
  assert.equal(limiter.check({ ip: '1.1.1.1', siteId: '' }).ok, false, 'an address with five failures without a key is limited');
  assert.equal(limiter.check({ ip: '1.1.1.1', siteId: '42' }).ok, true, 'a known site from that address is not');
  for (let i = 0; i < 3; i += 1) limiter.fail({ ip: '2.2.2.2', siteId: '43' });
  assert.equal(limiter.check({ ip: '2.2.2.2', siteId: '43' }).ok, false);
  assert.equal(limiter.check({ ip: '3.3.3.3', siteId: '43' }).ok, true);
  for (let i = 0; i < 500; i += 1) limiter.fail({ ip: `10.0.${i}.1`, siteId: '' });
  assert.ok(limiter.size() <= 50, `key count ${limiter.size()} is capped`);
  assert.equal(limiter.check({ ip: '2.2.2.2', siteId: '43' }).ok, false, 'address keys are evicted before pair keys');
  t = 1001;
  assert.equal(limiter.check({ ip: '2.2.2.2', siteId: '43' }).ok, true, 'the window slides');
});

test('HS-4: junk redeems are not written to the audit; they are counted and logged at most once a minute', async () => {
  const clock = { t: 5_000_000 };
  const lines = [];
  const quiet = createQuietCounter({ now: () => clock.t, log: (...args) => lines.push(args.join(' ')) });
  await withHub(async (hub) => {
    await link(hub.base, '42');
    const auditPath = hub.registered.store().auditPath();
    const before = readFileSync(auditPath, 'utf8');
    for (let i = 0; i < 50; i += 1) {
      const ip = `198.51.100.${i}`;
      const kind = i % 3;
      let res;
      if (kind === 0) res = await redeem(hub.base, { token: junkToken(), ip });
      else if (kind === 1) res = await redeem(hub.base, { token: junkToken(), siteKey: `guess-${i}`, ip });
      else res = await redeem(hub.base, { token: i % 2 ? junkToken() : 'x', siteKey: 'key-42', ip });
      assert.equal(res.status, 401);
    }
    assert.equal(readFileSync(auditPath, 'utf8'), before, 'audit.json is unchanged');
    const totals = quiet.totals();
    assert.equal(Object.values(totals).reduce((a, b) => a + b, 0), 50);
    assert.equal(lines.length, 1, 'one log line inside the minute');
    clock.t += 60_000;
    await redeem(hub.base, { token: junkToken(), ip: '198.51.100.200' });
    assert.equal(lines.length, 2, 'the next line after a minute');
    assert.match(lines[1], /no-site/);
  }, { clock, quiet });
});

test('the hub records this file writes go to its own data dir, also when it runs without APP_DATA_DIR', () => {
  assert.equal(getPersistentDataDir(), fileDataDir);
});

test('HS-1: a heartbeat from a site-key holder cannot move the sign-in link to another host', async () => {
  const dataDir = tempDir();
  // data/hub.js keeps its sites in the file's data dir (set before the first import above).
  assert.equal(getPersistentDataDir(), fileDataDir);
  const hub = await import('../data/hub.js');
  const created = hub.createSite({ name: 'Example shop', domain: 'shop.example' });
  const id = created.site?.id || created.id;
  const key = hub.getSiteById(id).site_key;
  assert.equal(hub.recordHeartbeat(key, { packageVersion: '2.2.1', adminUrl: 'https://elsewhere.example/admin' }, { verified: true }).ok, true);
  const app = express();
  app.use(express.json());
  const adminAuth = (req, _res, next) => { req.admin = { username: 'staff-one' }; next(); };
  const registered = registerCmsSsoRoutes(app, { adminAuth, getSiteById: hub.getSiteById, getAllSites: hub.getAllSites, dataDir });
  const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/hub/sites/${id}/cms-sso`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.format, 'redeem');
    assert.equal(new URL(body.url).origin, 'https://shop.example', 'the link stays on the stored domain');
    const row = registered.store().auditLog().at(-1);
    assert.equal(row.originFrom, 'domain');
    assert.equal(row.ignoredAdminHost, 'elsewhere.example', 'the ignored report is noted');
    hub.recordHeartbeat(key, { adminUrl: 'http://www.shop.example/admin' }, { verified: true });
    const www = await (await fetch(`${base}/api/hub/sites/${id}/cms-sso`, { method: 'POST' })).json();
    assert.equal(new URL(www.url).origin, 'https://www.shop.example', 'a plain-http report on the same host still gives https');
    // The redeem route finds the site among the hub's real site list.
    const redeemed = await redeem(base, { token: tokenOf(www.url), siteKey: key });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.body.ok, true);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
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
