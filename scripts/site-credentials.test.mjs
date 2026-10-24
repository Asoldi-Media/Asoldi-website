// Site credential: enrollment with a proof from the stored domain, the store, the admin routes and
// the gates on hub routes a client CMS calls server to server. Everything runs on 127.0.0.1: the
// stored domains below are mapped to loopback servers through the routes' test-only resolveProofUrl.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-site-cred-'));
process.env.APP_DATA_DIR = dataDir;

const { clearJsonCacheForTests } = await import('../data/atomic-json.js');
const hub = await import('../data/hub.js');
const sc = await import('../lib/site-credentials.js');
const { registerShopPaymentsRoutes } = await import('../lib/shop-payments-routes.js');
const { mountClientAnalyticsRoutes, resetHubAnalyticsLimitsForTests } = await import('../lib/client-analytics-http.js');
const { resetSecurityCounters, securityCounters } = await import('../lib/security-counters.js');
const { useClientAddressSettingsFrom } = await import('../lib/client-address.js');
const { updateSecuritySettings } = await import('../data/security-settings.js');

const value = () => randomBytes(32).toString('base64url');
const proofOf = (credential, nonce) => createHmac('sha256', credential).update(nonce).digest('hex');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * A stand-in client CMS on loopback: it answers a proof only for a nonce it started itself
 * (pending), like CMS 2.2.2. `mode` changes the answer for the redirect and size tests.
 */
async function fakeCms(name) {
  const pending = new Map();
  const state = { name, mode: 'normal', calls: 0, redirectTo: '', delayMs: 0, inFlight: 0, maxInFlight: 0 };
  const app = express();
  app.get('/api/cms/hub-enroll-proof', async (req, res) => {
    state.calls += 1;
    const nonce = String(req.query.nonce || '');
    if (state.delayMs) {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      state.inFlight -= 1;
    }
    if (state.mode === 'redirect') {
      const target = state.redirectTo.replace('{nonce}', encodeURIComponent(nonce));
      state.mode = state.afterRedirect || 'normal';
      return res.redirect(302, target);
    }
    if (state.mode === 'huge') return res.json({ proof: 'a'.repeat(64), pad: 'x'.repeat(10_000) });
    if (state.mode === 'slow') return setTimeout(() => res.json({ proof: 'a'.repeat(64) }), 1_500);
    const credential = pending.get(nonce);
    if (!credential) return res.status(404).json({ message: 'Not found' });
    return res.json({ proof: proofOf(credential, nonce) });
  });
  const server = await listen(app);
  return {
    state,
    pending,
    server,
    port: server.address().port,
    start(credential) {
      const nonce = value();
      pending.set(nonce, credential);
      return nonce;
    },
  };
}

const cmsA = await fakeCms('site-a');
const cmsOther = await fakeCms('other');
/** Host → loopback port, for the proof fetch only. */
const hosts = new Map([
  ['site-a.example', cmsA.port],
  ['www.site-a.example', cmsA.port],
  ['other.example', cmsOther.port],
]);
function resolveProofUrl(href) {
  const url = new URL(href);
  const port = hosts.get(url.hostname);
  if (!port) throw new Error(`test resolver has no host ${url.hostname}`);
  return `http://127.0.0.1:${port}${url.pathname}${url.search}`;
}

const store = sc.createSiteCredentialStore({ dataDir });
sc.setSiteCredentialStoreForTests(store);
/** A trusted CMS version, as a heartbeat with a valid credential (or one from before credentials) leaves it. */
const trustVersion = (site, packageVersion) => hub.recordHeartbeat(site.site_key, { packageVersion }, { verified: true });
// Site A ran CMS 2.1.3 (site key only) and enrolls below.
const siteA = hub.createSite({ name: 'Site A', domain: 'site-a.example', websitePlan: 'tier-3-ecommerce' });
trustVersion(siteA, '2.1.3');
const siteNoDomain = hub.createSite({ name: 'No domain yet' });
const siteInternal = hub.createSite({ name: 'Internal', domain: '127.0.0.1:8080' });
// A shop with no reported CMS version: it never gets the site-key-only routes.
const siteOther = hub.createSite({ name: 'Other', domain: 'other.example', websitePlan: 'tier-3-ecommerce' });
// A shop that stays on CMS 2.1.3 and never enrolls.
const siteLegacy = hub.createSite({ name: 'Legacy shop', domain: 'legacy.example', websitePlan: 'tier-3-ecommerce' });
trustVersion(siteLegacy, '2.1.3');
// A 1.7 site with the shop feature on: 1.7 never calls the shop or dashboard routes.
const site17 = hub.createSite({ name: 'Site on 1.7', domain: 'seventeen.example', websitePlan: 'tier-3-ecommerce' });
trustVersion(site17, '1.7.0');
// A 2.2.2 site that has not enrolled: it has a credential, so it must enroll.
const site222 = hub.createSite({ name: 'Site on 2.2.2', domain: 'new.example', websitePlan: 'tier-3-ecommerce' });
trustVersion(site222, '2.2.2');

const app = express();
app.use(express.json());
const adminAuth = (req, _res, next) => {
  req.admin = { username: 'staff-one' };
  next();
};
registerShopPaymentsRoutes(app, { adminAuth });
mountClientAnalyticsRoutes(app, { clientAuth: (_req, res) => res.status(401).end(), loadClientUser: async () => null, clientPortal: {} });
let limiter = sc.createEnrollLimiter();
const routes = sc.registerSiteCredentialRoutes(app, {
  adminAuth,
  getSiteByKey: hub.getSiteByKey,
  getSiteById: hub.getSiteById,
  getAllSites: hub.getAllSites,
  setTrustedCmsVersion: (id, packageVersion) => hub.updateSite(id, { cms: { packageVersion } }).ok,
  store,
  limiter: {
    unknownSite: (...args) => limiter.unknownSite(...args),
    site: (...args) => limiter.site(...args),
    proofFailed: (...args) => limiter.proofFailed(...args),
  },
  resolveProofUrl,
});
const server = await listen(app);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  for (const s of [server, cmsA.server, cmsOther.server]) s.close();
  sc.setSiteCredentialStoreForTests(null);
  rmSync(dataDir, { recursive: true, force: true });
});

async function send(method, path, { body, siteKey, credential, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(siteKey ? { 'x-site-key': siteKey } : {}),
      ...(credential ? { 'x-site-credential': credential } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, data, headers: res.headers };
}

const enroll = (site, credential, nonce, extra = {}) => send('POST', '/api/hub/site-credential/enroll', { body: { siteKey: site.site_key, credential, nonce }, ...extra });

function freshLimits() {
  limiter = sc.createEnrollLimiter();
}

test('the proof origin is the stored domain over https; internal, malformed or missing domains give none', () => {
  assert.equal(sc.enrollProofOrigin('kafe.no'), 'https://kafe.no');
  assert.equal(sc.enrollProofOrigin('http://www.kafe.no/admin'), 'https://www.kafe.no');
  assert.equal(sc.enrollProofOrigin('https://kafe.no:8443'), 'https://kafe.no:8443');
  assert.equal(sc.enrollProofOrigin('frisør.no'), 'https://xn--frisr-yua.no');
  for (const domain of ['', 'localhost', '127.0.0.1', '10.0.0.4', '192.168.1.20:3000', 'printer.local', `https://${'user'}:${'pw'}@kafe.no`, 'intranet', 'ftp://kafe.no', '[::1]']) {
    assert.equal(sc.enrollProofOrigin(domain), '', domain);
  }
});

test('enrollment answers 503 while it is switched off, which is the default', async () => {
  assert.equal(store.settings().enrollment, 'off');
  const credential = value();
  const res = await enroll(siteA, credential, cmsA.start(credential));
  assert.equal(res.status, 503);
  assert.equal(res.data.code, 'enrollment-off');
  assert.equal(cmsA.state.calls, 0, 'no outgoing call while off');
  const toggled = await send('PUT', '/api/hub/site-credentials/settings', { body: { enrollment: 'on' } });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.data.settings.enrollment, 'on');
  assert.equal(toggled.data.settings.updatedBy, 'staff-one');
  assert.equal((await send('PUT', '/api/hub/site-credentials/settings', { body: { enrollment: 'maybe' } })).status, 400);
});

test('enrollment stores only a hash and is audited when the stored domain confirms the nonce', async () => {
  freshLimits();
  resetSecurityCounters();
  const credential = value();
  const nonce = cmsA.start(credential);
  const res = await enroll(siteA, credential, nonce, { headers: { 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.ok, true);
  assert.equal(res.data.kind, 'first');
  assert.equal(res.data.reenrolled, false);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(store.state(siteA.id, credential), 'valid');
  const files = ['credentials.json', 'audit.json', 'nonces.json'].map((name) => readFileSync(join(dataDir, 'site-credentials', name), 'utf8')).join('\n');
  assert.equal(files.includes(credential), false, 'the credential itself is never written');
  assert.equal(files.includes(nonce), false, 'the nonce itself is never written');
  const row = store.auditLog().at(-1);
  assert.equal(row.action, 'enroll');
  assert.equal(row.ok, true);
  assert.equal(row.siteId, siteA.id);
  assert.equal(row.origin, 'https://site-a.example');
  assert.equal(securityCounters()['site-credential-enrolled'].total, 1);
  const again = await enroll(siteA, credential, cmsA.start(credential));
  assert.equal(again.status, 200);
  assert.equal(again.data.kind, 'same', 'enrolling the same credential again is harmless');
});

test('a proof that does not match the credential is refused and the stored credential stays', async () => {
  freshLimits();
  const before = JSON.parse(readFileSync(join(dataDir, 'site-credentials', 'credentials.json'), 'utf8')).sites[siteA.id].hash;
  const real = value();
  const presented = value();
  const nonce = cmsA.start(real);
  const res = await enroll(siteA, presented, nonce);
  assert.equal(res.status, 403);
  assert.equal(res.data.code, 'proof-mismatch');
  assert.equal(store.state(siteA.id, presented), 'invalid');
  const after = JSON.parse(readFileSync(join(dataDir, 'site-credentials', 'credentials.json'), 'utf8')).sites[siteA.id].hash;
  assert.equal(after, before);
  assert.equal(store.auditLog().at(-1).reason, 'proof-mismatch');
});

test('a site without a public stored domain cannot enroll', async () => {
  freshLimits();
  for (const site of [siteNoDomain, siteInternal]) {
    const credential = value();
    const res = await enroll(site, credential, cmsA.start(credential));
    assert.equal(res.status, 409, site.name);
    assert.equal(res.data.code, 'no-domain');
  }
});

test('the proof is asked only from the stored domain, never from another site that holds the key', async () => {
  freshLimits();
  // A server for other.example that would confirm any nonce for its own credential.
  const credential = value();
  const nonce = cmsOther.start(credential);
  const before = { a: cmsA.state.calls, other: cmsOther.state.calls };
  const res = await enroll(siteA, credential, nonce);
  assert.equal(res.status, 403, 'site-a.example does not know this nonce');
  assert.equal(res.data.code, 'proof-refused');
  assert.equal(cmsA.state.calls, before.a + 1);
  assert.equal(cmsOther.state.calls, before.other, 'other.example is never asked');
});

test('redirects are followed only to https on the same host or its www twin', async () => {
  freshLimits();
  const credential = value();
  let nonce = cmsA.start(credential);
  cmsA.state.mode = 'redirect';
  cmsA.state.redirectTo = 'https://www.site-a.example/api/cms/hub-enroll-proof?nonce={nonce}';
  const twin = await enroll(siteA, credential, nonce);
  assert.equal(twin.status, 200, JSON.stringify(twin.data));

  for (const [target, label] of [
    ['https://other.example/api/cms/hub-enroll-proof?nonce={nonce}', 'another host'],
    ['http://site-a.example/api/cms/hub-enroll-proof?nonce={nonce}', 'plain http'],
    ['https://site-a.example/somewhere-else?nonce={nonce}', 'another path'],
    ['https://site-a.example/api/cms/hub-enroll-proof?nonce=AAAA', 'another nonce'],
  ]) {
    freshLimits();
    const otherCalls = cmsOther.state.calls;
    nonce = cmsA.start(credential);
    cmsA.state.mode = 'redirect';
    cmsA.state.redirectTo = target;
    const res = await enroll(siteA, credential, nonce);
    assert.equal(res.status, 403, label);
    assert.equal(res.data.code, 'proof-redirect', label);
    assert.equal(cmsOther.state.calls, otherCalls, `${label}: the redirect target is not fetched`);
  }
  cmsA.state.mode = 'normal';
});

test('a nonce is accepted once; sending it again is refused even with a valid proof', async () => {
  freshLimits();
  const credential = value();
  const nonce = cmsA.start(credential);
  assert.equal((await enroll(siteA, credential, nonce)).status, 200);
  const replay = await enroll(siteA, credential, nonce);
  assert.equal(replay.status, 409);
  assert.equal(replay.data.code, 'nonce-used');
  assert.equal(store.auditLog().at(-1).reason, 'nonce-used');
});

test('an oversized or slow proof answer is refused', async () => {
  freshLimits();
  const credential = value();
  cmsA.state.mode = 'huge';
  const big = await enroll(siteA, credential, cmsA.start(credential));
  assert.equal(big.status, 403);
  assert.equal(big.data.code, 'proof-too-large');
  cmsA.state.mode = 'slow';
  await assert.rejects(
    sc.fetchEnrollProof({ origin: 'https://site-a.example', nonce: value(), fetchImpl: fetch, resolveUrl: resolveProofUrl, timeoutMs: 300 }),
    (error) => error.code === 'proof-unreachable',
  );
  cmsA.state.mode = 'normal';
  await new Promise((r) => setTimeout(r, 1_300));
});

test('malformed values and unknown site keys are refused before any outgoing call', async () => {
  freshLimits();
  const calls = cmsA.state.calls;
  const bad = await send('POST', '/api/hub/site-credential/enroll', { body: { siteKey: siteA.site_key, credential: 'short', nonce: value() } });
  assert.equal(bad.status, 400);
  const unknown = await send('POST', '/api/hub/site-credential/enroll', { body: { siteKey: 'not-a-site', credential: value(), nonce: value() } });
  assert.equal(unknown.status, 401);
  assert.equal(cmsA.state.calls, calls);
});

test('enroll attempts are limited per site and address, and unknown keys per address', async () => {
  freshLimits();
  const headers = { 'x-forwarded-for': '198.51.100.20' };
  const statuses = [];
  for (let i = 0; i < 7; i += 1) {
    const credential = value();
    statuses.push((await enroll(siteA, credential, value(), { headers })).status);
  }
  assert.deepEqual(statuses.slice(0, 6), [403, 403, 403, 403, 403, 403]);
  assert.equal(statuses[6], 429);
  const credential = value();
  const elsewhere = await enroll(siteA, credential, cmsA.start(credential), { headers: { 'x-forwarded-for': '198.51.100.21' } });
  assert.equal(elsewhere.status, 200, 'another address is not held up');
  freshLimits();
  const unknown = [];
  for (let i = 0; i < 31; i += 1) {
    unknown.push((await send('POST', '/api/hub/site-credential/enroll', { body: { siteKey: `nope-${i}`, credential: value(), nonce: value() }, headers })).status);
  }
  assert.equal(unknown.filter((s) => s === 401).length, 30);
  assert.equal(unknown.at(-1), 429);
});

test('callers whose proofs fail cannot use up the enrollment of the site\'s own CMS', async () => {
  freshLimits();
  const statuses = [];
  // Five addresses with the public site key, six attempts each, none of which the site confirms.
  for (const address of ['192.0.2.101', '192.0.2.102', '192.0.2.103', '192.0.2.104', '192.0.2.105']) {
    for (let i = 0; i < 6; i += 1) statuses.push((await enroll(siteA, value(), value(), { headers: { 'x-forwarded-for': address } })).status);
  }
  assert.equal(statuses.filter((s) => s === 403).length, 25, 'each address gets its first try; retries share 20 an hour');
  assert.equal(statuses.filter((s) => s === 429).length, 5);
  // The site's own CMS, from an address with no failed proof, still enrolls.
  const credential = value();
  const real = await enroll(siteA, credential, cmsA.start(credential), { headers: { 'x-forwarded-for': '203.0.113.10' } });
  assert.equal(real.status, 200, JSON.stringify(real.data));
  siteA.credential = credential;
});

test('the enroll limiter: fresh addresses are never held by the shared allowance; an IPv6 /64 counts as one address', () => {
  let t = 0;
  const local = sc.createEnrollLimiter({ now: () => t });
  // Six hours of attempts from three addresses that never prove anything, every 10 s.
  let refusedReal = 0;
  for (t = 0; t < 6 * 3600_000; t += 10_000) {
    for (const address of ['198.51.100.66', '198.51.100.67', '198.51.100.68']) {
      if (local.site('s1', address).ok) local.proofFailed('s1', address);
    }
    if (t % (15 * 60_000) === 7 * 60_000 && !local.site('s1', '203.0.113.10').ok) refusedReal += 1;
  }
  assert.equal(refusedReal, 0, 'the CMS trying every 15 minutes is never refused');
  t = 0;
  const v6 = sc.createEnrollLimiter({ now: () => t });
  for (let i = 1; i <= 6; i += 1) assert.equal(v6.site('s2', `2001:db8:5:6::${i}`).ok, true);
  assert.equal(v6.site('s2', '2001:db8:5:6:ffff::99').ok, false, 'the same /64');
  assert.equal(v6.site('s2', '2001:db8:5:7::1').ok, true, 'another /64');
});

test('proof calls for one site run one at a time and later callers wait their turn', async () => {
  freshLimits();
  cmsA.state.delayMs = 300;
  cmsA.state.maxInFlight = 0;
  const first = value();
  const second = value();
  const results = await Promise.all([
    enroll(siteA, first, cmsA.start(first), { headers: { 'x-forwarded-for': '203.0.113.21' } }),
    enroll(siteA, second, cmsA.start(second), { headers: { 'x-forwarded-for': '203.0.113.22' } }),
  ]);
  cmsA.state.delayMs = 0;
  assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results.map((r) => r.data)));
  assert.equal(cmsA.state.maxInFlight, 1, 'never two proof calls to the site at once');
  siteA.credential = store.state(siteA.id, second) === 'valid' ? second : first;

  const lane = sc.createProofLane({ waitMs: 150 });
  const order = [];
  const slow = lane.run('s', () => new Promise((resolve) => setTimeout(() => { order.push('slow'); resolve(1); }, 350)));
  const late = await lane.run('s', () => { order.push('late'); return 2; });
  assert.deepEqual(late, { busy: true }, 'a caller whose turn does not come in time is told to try again');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = lane.run('s', () => { order.push('after'); return 3; });
  assert.deepEqual(await slow, { busy: false, value: 1 });
  assert.deepEqual(await after, { busy: false, value: 3 });
  assert.deepEqual(order, ['slow', 'after'], 'the next caller still waits for the running proof');
  assert.equal(lane.size(), 0);
});

test('a revoked credential stops working; the site enrolls again and that counts as a re-enrollment', async () => {
  freshLimits();
  const credential = value();
  assert.equal((await enroll(siteA, credential, cmsA.start(credential))).status, 200);
  assert.equal(store.state(siteA.id, credential), 'valid');
  resetSecurityCounters();
  const revoked = await send('POST', `/api/hub/sites/${siteA.id}/site-credential/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.credential.enrolled, false);
  assert.equal(revoked.data.credential.revoked, true);
  assert.equal(revoked.data.credential.revokedBy, 'staff-one');
  assert.equal(store.state(siteA.id, credential), 'revoked');
  const status = await send('GET', '/api/hub/shop/status', { siteKey: siteA.site_key, credential });
  assert.equal(status.headers.get('x-site-credential-status'), 'not-enrolled', 'the CMS learns that it must enroll again');
  // Site A ran 2.1.3 before it enrolled, but a revoked site stays closed: neither the site key alone
  // nor the revoked credential opens the routes that allow the site key for never-enrolled sites.
  for (const [method, path, body] of [
    ['GET', '/api/hub/shop/status'],
    ['POST', '/api/hub/shop/document', { document: { kind: 'magic-link' }, to: 'someone@example.com' }],
    ['GET', '/api/hub/analytics'],
  ]) {
    for (const presented of [undefined, credential]) {
      const res = await send(method, path, { siteKey: siteA.site_key, credential: presented, body });
      assert.equal(res.status, 401, `${method} ${path} after revoke, ${presented ? 'revoked credential' : 'site key only'}`);
      assert.equal(res.headers.get('x-site-credential-status'), 'not-enrolled');
    }
  }
  assert.equal((await send('POST', `/api/hub/sites/${siteA.id}/site-credential/revoke`)).status, 409);
  const next = value();
  const res = await enroll(siteA, next, cmsA.start(next));
  assert.equal(res.status, 200);
  assert.equal(res.data.reenrolled, true);
  assert.equal(store.state(siteA.id, credential), 'invalid', 'the old credential stays refused');
  assert.equal(store.state(siteA.id, next), 'valid');
  assert.equal(securityCounters()['site-credential-revoked'].total, 1);
  assert.equal(securityCounters()['site-credential-reenrolled'].total, 1);
  const replaced = value();
  const swap = await enroll(siteA, replaced, cmsA.start(replaced));
  assert.equal(swap.data.kind, 'replaced');
  assert.equal(store.auditLog().at(-1).action, 'reenroll');
  assert.equal(securityCounters()['site-credential-reenrolled'].total, 2);
  siteA.credential = replaced;
});

test('the admin list shows enrollment per site and never a hash', async () => {
  const res = await send('GET', '/api/hub/site-credentials');
  assert.equal(res.status, 200);
  const row = res.data.sites.find((r) => r.siteId === siteA.id);
  assert.equal(row.enrolled, true);
  assert.match(row.enrolledAt, /^\d{4}-/);
  assert.equal(row.proofDomain, 'site-a.example');
  assert.equal(row.proofDomainMatches, true);
  assert.ok(row.reenrollCount >= 2);
  assert.equal(res.data.sites.find((r) => r.siteId === siteNoDomain.id).enrolled, false);
  assert.equal(res.data.totals.enrolled, 1);
  assert.equal(JSON.stringify(res.data).includes(siteA.credential), false);
  assert.doesNotMatch(JSON.stringify(res.data), /"hash"|[a-f0-9]{64}/);
  assert.equal((await send('POST', '/api/hub/sites/nope/site-credential/revoke')).status, 404);
});

// Routes that move money, change a payee or read payment details.
const MONEY_ROUTES = [
  ['POST', '/api/hub/shop/stripe/connect', { returnUrl: 'https://site-a.example/admin' }],
  ['POST', '/api/hub/shop/stripe/checkout', { ref: 'r1', currency: 'nok', lineItems: [] }],
  ['GET', '/api/hub/shop/stripe/session/cs_test_1'],
  ['POST', '/api/hub/shop/paypal/connect', { returnUrl: 'https://site-a.example/admin', email: 'pay@example.com' }],
  ['POST', '/api/hub/shop/paypal/order', { ref: 'r1' }],
  ['POST', '/api/hub/shop/paypal/capture', { orderId: 'O1' }],
  ['GET', '/api/hub/shop/stripe/invoice/in_1'],
  ['GET', '/api/hub/shop/stripe/subscription/sub_1'],
  ['POST', '/api/hub/shop/stripe/subscription/sub_1/cancel', {}],
  ['POST', '/api/hub/shop/refund', { provider: 'stripe', providerId: 'cs_1', amountMinor: 100, currency: 'nok' }],
  ['POST', '/api/hub/shop/disconnect', { provider: 'paypal' }],
];

test('each money and payee route refuses the site key alone, also for a site that never enrolled', async () => {
  for (const site of [siteA, siteOther, siteLegacy]) {
    for (const [method, path, body] of MONEY_ROUTES) {
      const res = await send(method, path, { siteKey: site.site_key, body });
      assert.equal(res.status, 401, `${site.name} ${method} ${path}`);
      assert.equal(res.data.code, 'site-credential-required', `${method} ${path}`);
    }
  }
  for (const [method, path, body] of MONEY_ROUTES) {
    const wrong = await send(method, path, { siteKey: siteA.site_key, credential: value(), body });
    assert.equal(wrong.status, 401, `wrong credential ${method} ${path}`);
    assert.equal(wrong.data.code, 'site-credential-invalid');
    const otherSite = await send(method, path, { siteKey: siteOther.site_key, credential: siteA.credential, body });
    assert.equal(otherSite.status, 401, `another site's credential ${method} ${path}`);
  }
});

test('with the credential the money routes reach the payment code (200 for disconnect)', async () => {
  for (const [method, path, body] of MONEY_ROUTES) {
    const res = await send(method, path, { siteKey: siteA.site_key, credential: siteA.credential, body });
    assert.notEqual(res.status, 401, `${method} ${path}: ${JSON.stringify(res.data)}`);
    assert.equal(res.headers.get('x-site-credential-status'), 'valid');
  }
  const disconnect = await send('POST', '/api/hub/shop/disconnect', { siteKey: siteA.site_key, credential: siteA.credential, body: { provider: 'paypal' } });
  assert.equal(disconnect.status, 200);
});

test('legacy versions: CMS 2.0.0 up to 2.2.1 are the versions without a credential', () => {
  for (const version of ['2.0.0', '2.1.3', 'v2.1.3', '2.2.0', '2.2.1']) assert.equal(sc.isLegacyKeyOnlyVersion(version), true, version);
  for (const version of ['', '1.7.0', '1.7.2', '2.2.2', '2.3.0', '3.0.0', 'junk']) assert.equal(sc.isLegacyKeyOnlyVersion(version), false, version);
  const shop = { cms: { packageVersion: '2.1.3' }, features: { ecommerce: true } };
  assert.equal(sc.legacyKeyOnlySite(shop, { shop: true }), true);
  assert.equal(sc.legacyKeyOnlySite({ ...shop, features: { ecommerce: false } }, { shop: true }), false, 'shop routes need the shop feature');
  assert.equal(sc.legacyKeyOnlySite({ ...shop, features: { ecommerce: false } }), true, 'the dashboard does not');
  assert.equal(sc.legacyKeyOnlySite({ cms: { packageVersion: '', unverified: { packageVersion: '2.1.3' } }, features: { ecommerce: true } }, { shop: true }), false, 'an unverified report is not a trusted version');
});

test('the site key alone opens shop status, documents and the dashboard only for a never-enrolled shop on CMS 2.0.0 to 2.2.1', async () => {
  const legacyStatus = await send('GET', '/api/hub/shop/status', { siteKey: siteLegacy.site_key });
  assert.equal(legacyStatus.status, 200, 'a shop on CMS 2.1.3 keeps its shop status');
  assert.equal(legacyStatus.headers.get('x-site-credential-status'), 'not-enrolled');
  const legacyDoc = await send('POST', '/api/hub/shop/document', { siteKey: siteLegacy.site_key, body: { document: { kind: 'magic-link' }, to: 'someone@example.com' } });
  assert.notEqual(legacyDoc.status, 401, 'and reaches the document code');
  const legacyDash = await send('GET', `/api/hub/analytics?site_key=${siteLegacy.site_key}&refresh=1`);
  assert.equal(legacyDash.status, 200, 'and its dashboard');
  assert.equal(legacyDash.data.mapsRefreshSkipped, 'site-credential-required', 'a paid refresh is skipped without the credential, and says so');
  for (const site of [siteOther, site17, site222]) {
    for (const [method, path, body] of [
      ['GET', '/api/hub/shop/status'],
      ['POST', '/api/hub/shop/document', { document: { kind: 'magic-link' }, to: 'someone@example.com' }],
      ['GET', '/api/hub/analytics'],
    ]) {
      const res = await send(method, path, { siteKey: site.site_key, body });
      assert.equal(res.status, 401, `${site.name}: ${method} ${path} with the site key alone`);
      assert.equal(res.data.code, 'site-credential-required');
      assert.equal(res.headers.get('x-site-credential-status'), 'not-enrolled', 'a CMS 2.2.2 learns that it must enroll');
    }
  }
});

test('shop status and documents need the credential once the site has enrolled', async () => {
  const keyOnly = await send('GET', '/api/hub/shop/status', { siteKey: siteA.site_key });
  assert.equal(keyOnly.status, 401);
  assert.equal(keyOnly.headers.get('x-site-credential-status'), 'missing');
  const docKeyOnly = await send('POST', '/api/hub/shop/document', { siteKey: siteA.site_key, body: { document: { kind: 'magic-link' }, to: 'someone@example.com' } });
  assert.equal(docKeyOnly.status, 401);
  const withCredential = await send('GET', '/api/hub/shop/status', { siteKey: siteA.site_key, credential: siteA.credential });
  assert.equal(withCredential.status, 200);
  assert.equal((await send('GET', '/api/hub/shop/status', { siteKey: 'unknown' })).status, 401);
});

test('analytics: the spend summary needs the credential; an enrolled site must send it for its dashboard', async () => {
  const spendKeyOnly = await send('GET', `/api/hub/analytics/spend?site_key=${siteA.site_key}`);
  assert.equal(spendKeyOnly.status, 401);
  const spendOther = await send('GET', `/api/hub/analytics/spend?site_key=${siteOther.site_key}`);
  assert.equal(spendOther.status, 401, 'also for a site that never enrolled');
  const spend = await send('GET', '/api/hub/analytics/spend', { siteKey: siteA.site_key, credential: siteA.credential });
  assert.equal(spend.status, 200);
  assert.equal(typeof spend.data.budgetUsd, 'number');
  const dashKeyOnly = await send('GET', `/api/hub/analytics?site_key=${siteA.site_key}`);
  assert.equal(dashKeyOnly.status, 401, 'an enrolled site needs its credential');
  const dash = await send('GET', '/api/hub/analytics', { siteKey: siteA.site_key, credential: siteA.credential });
  assert.equal(dash.status, 200, JSON.stringify(dash.data).slice(0, 200));
  const dashOld = await send('GET', `/api/hub/analytics?site_key=${siteLegacy.site_key}`);
  assert.equal(dashOld.status, 200, 'a never-enrolled site on CMS 2.1.3 keeps its dashboard');
  const dashNoVersion = await send('GET', `/api/hub/analytics?site_key=${siteOther.site_key}`);
  assert.equal(dashNoVersion.status, 401, 'a site with no CMS 2.0.0–2.2.1 version needs the credential');
});

test('analytics collect keeps only the known event fields and limits calls per site and address', async () => {
  resetHubAnalyticsLimitsForTests();
  const now = new Date().toISOString();
  const res = await send('POST', '/api/hub/analytics/collect', {
    body: {
      site_key: siteOther.site_key,
      events: [
        { type: 'pageview', path: '/', at: now, visitorId: 'v1', injected: { deep: true }, html: '<script>' },
        { type: 'pageview', path: '/old', at: '2001-01-01T00:00:00Z' },
        { type: '<bad type>', path: '/' },
        'not-an-object',
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.accepted, 1);
  const day = now.slice(0, 10);
  const stored = readFileSync(join(dataDir, 'client-analytics-traffic', siteOther.site_key, `${day}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(Object.keys(stored.at(-1)).sort(), ['at', 'host', 'href', 'ms', 'path', 'referrer', 'sessionId', 'siteKey', 'type', 'ua', 'visitorId'].sort());
  assert.equal((await send('POST', '/api/hub/analytics/collect', { body: { site_key: siteOther.site_key, events: { not: 'a list' } } })).status, 400);

  resetHubAnalyticsLimitsForTests();
  const headers = { 'x-forwarded-for': '192.0.2.50' };
  let last;
  for (let i = 0; i < 121; i += 1) last = await send('POST', '/api/hub/analytics/collect', { body: { site_key: siteOther.site_key, events: [] }, headers });
  assert.equal(last.status, 429);
  const otherAddress = await send('POST', '/api/hub/analytics/collect', { body: { site_key: siteOther.site_key, events: [] }, headers: { 'x-forwarded-for': '192.0.2.51' } });
  assert.equal(otherAddress.status, 200);
  for (let i = 0; i < 130; i += 1) last = await send('POST', '/api/hub/analytics/collect', { body: { site_key: siteA.site_key, events: [] }, siteKey: siteA.site_key, credential: siteA.credential, headers });
  assert.equal(last.status, 200, 'the site server with its credential is limited per site only');
});

test('analytics commerce keeps the known summary fields, bounded, and refuses large bodies', async () => {
  resetHubAnalyticsLimitsForTests();
  const ok = await send('POST', '/api/hub/analytics/commerce', {
    body: { site_key: siteOther.site_key, orders: 3, revenue: 1e30, topProducts: Array.from({ length: 1000 }, (_, i) => ({ name: `p${i}`, units: i })), injected: 'x' },
  });
  assert.equal(ok.status, 200);
  const snaps = JSON.parse(readFileSync(join(dataDir, 'client-commerce-snapshots.json'), 'utf8'));
  const snap = snaps[siteOther.site_key];
  assert.equal(snap.orders, 3);
  assert.equal(snap.revenue, null, 'numbers out of range are dropped');
  assert.equal(snap.topProducts.length, 400);
  assert.equal(snap.injected, undefined);
  const big = await send('POST', '/api/hub/analytics/commerce', { body: { site_key: siteOther.site_key, series: Array.from({ length: 300 }, () => 'y'.repeat(250)) } });
  assert.equal(big.status, 413);
  const headers = { 'x-forwarded-for': '192.0.2.60' };
  let last;
  for (let i = 0; i < 21; i += 1) last = await send('POST', '/api/hub/analytics/commerce', { body: { site_key: siteOther.site_key, orders: i }, headers });
  assert.equal(last.status, 429);
});

test('collect, commerce and enrollment use the trusted-hop setting of the sign-in limits: with 2 hops visitors behind one CDN are counted apart', async () => {
  // The hosting proxy (the loopback peer here) appends the CDN's address; the CDN appended the visitor's.
  const viaCdn = (visitor) => ({ 'x-forwarded-for': `${visitor}, 203.0.113.250` });
  const setHops = (loginTrustedHops) => updateSecuritySettings({ loginTrustedHops }, { dataDir, by: 'admin:tester' });
  async function burst(path, count, visitor, body) {
    let last;
    for (let i = 0; i < count; i += 1) last = await send('POST', path, { body, headers: viaCdn(visitor) });
    return last;
  }
  useClientAddressSettingsFrom(dataDir);
  try {
    for (const [path, perAddress, body] of [
      ['/api/hub/analytics/collect', 120, { site_key: siteOther.site_key, events: [] }],
      ['/api/hub/analytics/commerce', 20, { site_key: siteOther.site_key, orders: 1 }],
    ]) {
      setHops(null);
      resetHubAnalyticsLimitsForTests();
      assert.equal((await burst(path, perAddress, '198.51.100.31', body)).status, 200);
      assert.equal((await send('POST', path, { body, headers: viaCdn('198.51.100.32') })).status, 429, `${path}: by default every visitor behind the CDN shares its entry, as before`);

      setHops(2);
      resetHubAnalyticsLimitsForTests();
      assert.equal((await burst(path, perAddress, '198.51.100.31', body)).status, 200);
      assert.equal((await send('POST', path, { body, headers: viaCdn('198.51.100.31') })).status, 429, `${path}: the busy visitor is still limited`);
      assert.equal((await send('POST', path, { body, headers: viaCdn('198.51.100.32') })).status, 200, `${path}: with 2 hops the second visitor has a count of its own`);
    }

    // Enrollment: the address its limits are asked about.
    const asked = [];
    limiter = {
      unknownSite: (address) => (asked.push(address), { ok: true, retryAfterSec: 0 }),
      site: () => ({ ok: true, retryAfterSec: 0 }),
      proofFailed: () => {},
    };
    setHops(null);
    assert.equal((await enroll({ site_key: 'no-such-site' }, value(), value(), { headers: viaCdn('198.51.100.33') })).status, 401);
    setHops(2);
    assert.equal((await enroll({ site_key: 'no-such-site' }, value(), value(), { headers: viaCdn('198.51.100.33') })).status, 401);
    assert.deepEqual(asked, ['203.0.113.250', '198.51.100.33'], 'enrollment is counted by the CDN entry by default and by the visitor with 2 hops');
  } finally {
    setHops(null);
    useClientAddressSettingsFrom('');
    resetHubAnalyticsLimitsForTests();
    freshLimits();
  }
});

test('a heartbeat without a valid credential is kept as unverified and changes nothing the hub acts on', async () => {
  const site = hub.createSite({ name: 'Heartbeat site', domain: 'beat.example' });
  hub.recordHeartbeat(site.site_key, { packageVersion: '2.2.2', adminUrl: 'https://beat.example/admin' }, { verified: true });
  await hub.updateClientAdmin(site.id, { username: 'owner', password: 'a-long-client-password' });
  assert.equal(hub.getSiteById(site.id).clientAdmin.pendingSync, true);
  const result = hub.recordHeartbeat(site.site_key, { packageVersion: '1.0.0', adminUrl: 'https://elsewhere.example/admin', name: 'Renamed', adminApplied: true }, { verified: false });
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  const stored = hub.getSiteById(site.id);
  assert.equal(stored.cms.packageVersion, '2.2.2');
  assert.equal(stored.cms.adminUrl, 'https://beat.example/admin');
  assert.equal(stored.clientAdmin.pendingSync, true, 'an unverified heartbeat cannot mark the admin password as applied');
  assert.equal(stored.cms.unverified.packageVersion, '1.0.0');
  assert.equal(stored.cms.unverified.adminUrl, 'https://elsewhere.example/admin');
  assert.ok(stored.cms.lastSeenAt);
  const verified = hub.recordHeartbeat(site.site_key, { packageVersion: '2.2.3', adminApplied: true }, { verified: true });
  assert.equal(verified.site.cms.packageVersion, '2.2.3');
  assert.equal(verified.site.cms.unverified, undefined);
  assert.ok(verified.site.cms.lastVerifiedAt);
  assert.equal(hub.getSiteById(site.id).clientAdmin.pendingSync, false);
});

test('heartbeats: unverified by default, an enrolled site is not marked seen without its credential, repeats are not rewritten, and calls are limited', async () => {
  const site = hub.createSite({ name: 'Beat two', domain: 'beat-two.example' });
  const byDefault = hub.recordHeartbeat(site.site_key, { packageVersion: '2.2.2', adminUrl: 'https://beat-two.example/admin' });
  assert.equal(byDefault.verified, false, 'a heartbeat is unverified unless the caller says otherwise');
  assert.equal(hub.getSiteById(site.id).cms.packageVersion, '');
  const seen = hub.getSiteById(site.id).cms.lastSeenAt;
  assert.ok(seen);
  const repeat = hub.recordHeartbeat(site.site_key, { packageVersion: '2.2.2', adminUrl: 'https://beat-two.example/admin' });
  assert.equal(repeat.written, false, 'the same report within a minute is not written again');
  const changed = hub.recordHeartbeat(site.site_key, { packageVersion: '2.2.3' });
  assert.equal(changed.written, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  hub.recordHeartbeat(site.site_key, { packageVersion: '9.9.9' }, { verified: false, marksSeen: false });
  const after = hub.getSiteById(site.id).cms;
  assert.equal(after.unverified.packageVersion, '9.9.9');
  assert.equal(after.lastSeenAt, changed.site.cms.lastSeenAt, 'an enrolled site is not marked seen by a heartbeat without its credential');
  for (const [state, marks] of [['valid', true], ['not-enrolled', true], ['unavailable', true], ['missing', false], ['invalid', false], ['revoked', false]]) {
    assert.equal(sc.heartbeatMarksSeen(state), marks, state);
  }

  let t = 0;
  const limits = sc.createHeartbeatLimits({ now: () => t });
  for (let i = 0; i < 30; i += 1) assert.equal(limits.take({ siteId: 's1', address: '2001:db8:9:9::1' }).ok, true);
  assert.equal(limits.take({ siteId: 's1', address: '2001:db8:9:9::2' }).ok, false, '30 a minute per site and address (/64)');
  assert.equal(limits.take({ siteId: 's1', address: '198.51.100.9' }).ok, true, 'another address is not held up');
  assert.equal(limits.take({ siteId: 's1', address: '2001:db8:9:9::1', credentialValid: true }).ok, true, 'the site server with its credential is not limited');
  t = 60_000;
  assert.equal(limits.take({ siteId: 's1', address: '2001:db8:9:9::1' }).ok, true);
});

test('site config by site key carries no admin fields unless asked for with the credential', async () => {
  const site = hub.createSite({ name: 'Config site', domain: 'config.example' });
  await hub.updateClientAdmin(site.id, { username: 'owner', email: 'owner@example.com', password: 'a-long-client-password' });
  const keyOnly = hub.getSiteConfig(site.site_key, false, { includeAdmin: false });
  assert.equal(keyOnly.pendingAdmin, undefined);
  assert.equal(keyOnly.clientAdmin, undefined);
  const withCredential = hub.getSiteConfig(site.site_key, false, { includeAdmin: true });
  assert.match(withCredential.pendingAdmin.passwordHash, /^\$2/);
  assert.equal(withCredential.clientAdmin.email, 'owner@example.com');
  assert.equal(hub.getSiteConfig('config.example', true).pendingAdmin, undefined);
});

test('the credential store survives a missing or damaged file and refuses a damaged hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-site-cred-store-'));
  try {
    const local = sc.createSiteCredentialStore({ dataDir: dir });
    assert.equal(local.state('1', value()), 'not-enrolled');
    assert.equal(local.settings().enrollment, 'off');
    const credential = value();
    local.enroll('1', credential, { proofDomain: 'x.example', proofOrigin: 'https://x.example' });
    assert.equal(local.state('1', credential), 'valid');
    assert.equal(local.state('1', ''), 'missing');
    assert.equal(local.state('1', 'not base64url!'), 'invalid');
    assert.equal(local.reserveNonce('n'.repeat(43)), true);
    assert.equal(local.reserveNonce('n'.repeat(43)), false);
    assert.deepEqual(local.list().map((r) => r.siteId), ['1']);
    assert.equal(sc.publicCredentialRow('1', { hash: 'h' }).hash, undefined);
    assert.equal(local.health().ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable credential store fails closed, keeps every row and is set aside only by an admin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-site-cred-damaged-'));
  const local = sc.createSiteCredentialStore({ dataDir: dir });
  const one = value();
  local.enroll('s1', one, { proofDomain: 'site-a.example', proofOrigin: 'https://site-a.example' });
  local.enroll('s2', value(), {});
  local.setSettings({ enrollment: 'on' });
  const fakeSite = { id: 's3', site_key: 'k-s3', domain: 'site-a.example' };
  const mini = express();
  mini.use(express.json());
  mini.get('/gated', sc.requireSiteCredential({ getSiteByKey: (key) => (key === 'k-s1' ? { id: 's1' } : null), policy: 'when-enrolled', legacyAllowed: () => true, store: local }), (_req, res) => res.json({ ok: true }));
  sc.registerSiteCredentialRoutes(mini, { adminAuth, getSiteByKey: (key) => (key === fakeSite.site_key ? fakeSite : null), getSiteById: (id) => (id === 's3' ? fakeSite : null), getAllSites: () => [fakeSite], store: local, resolveProofUrl });
  const miniServer = await listen(mini);
  const miniBase = `http://127.0.0.1:${miniServer.address().port}`;
  try {
    writeFileSync(local.credentialsPath(), '{ damaged');
    clearJsonCacheForTests();
    resetSecurityCounters();
    assert.throws(() => local.state('s1', one), (error) => error instanceof sc.SiteCredentialStoreUnreadable);
    assert.deepEqual(local.health(), { ok: false, problem: 'unreadable' });
    const gated = await fetch(`${miniBase}/gated`, { headers: { 'x-site-key': 'k-s1' } });
    assert.equal(gated.status, 503, 'a route that accepts never-enrolled sites does not treat an unreadable store as "nobody enrolled"');
    assert.equal(gated.headers.get('x-site-credential-status'), 'unavailable');
    assert.throws(() => local.enroll('s3', value(), {}), (error) => error instanceof sc.SiteCredentialStoreUnreadable);
    assert.throws(() => local.revoke('s1'), (error) => error instanceof sc.SiteCredentialStoreUnreadable);
    assert.equal(readFileSync(local.credentialsPath(), 'utf8'), '{ damaged', 'no write replaces the other sites\' rows');
    const calls = cmsA.state.calls;
    const credential = value();
    const enrollRes = await fetch(`${miniBase}/api/hub/site-credential/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ siteKey: 'k-s3', credential, nonce: cmsA.start(credential) }) });
    assert.equal(enrollRes.status, 503);
    assert.equal(cmsA.state.calls, calls, 'no proof call while the store cannot be read');
    assert.ok(securityCounters()['site-credential-store-unreadable'].total >= 1, 'counted on the Security card');
    const listing = await (await fetch(`${miniBase}/api/hub/site-credentials`)).json();
    assert.deepEqual(listing.store, { ok: false, problem: 'unreadable' });
    const aside = await fetch(`${miniBase}/api/hub/site-credentials/set-aside-unreadable`, { method: 'POST' });
    assert.equal(aside.status, 200);
    const { file } = await aside.json();
    assert.match(file, /^credentials\.json\.unreadable-/);
    assert.equal(readFileSync(join(dir, 'site-credentials', file), 'utf8'), '{ damaged', 'the unreadable file is kept for repair');
    assert.equal(local.state('s1', one), 'not-enrolled', 'the store starts empty; sites enroll again');
    assert.equal((await fetch(`${miniBase}/api/hub/site-credentials/set-aside-unreadable`, { method: 'POST' })).status, 409);
    assert.equal(local.auditLog().at(-1).action, 'set-aside-store');
  } finally {
    miniServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an admin reset forgets a site\'s credential row and takes back a reported 2.0.0–2.2.1 version (a CMS that went back)', async () => {
  const site = hub.createSite({ name: 'Rollback shop', domain: 'rollback.example', websitePlan: 'tier-3-ecommerce' });
  trustVersion(site, '2.2.2');
  const credential = value();
  store.enroll(site.id, credential, { proofDomain: 'rollback.example', proofOrigin: 'https://rollback.example' });
  // The site went back to 2.1.3, which sends no credential.
  hub.recordHeartbeat(site.site_key, { packageVersion: '2.1.3' }, { verified: false, marksSeen: false });
  assert.equal((await send('GET', '/api/hub/shop/status', { siteKey: site.site_key })).status, 401);
  const row = (await send('GET', '/api/hub/site-credentials')).data.sites.find((r) => r.siteId === site.id);
  assert.equal(row.reportedLegacyVersion, '2.1.3');
  resetSecurityCounters();
  const reset = await send('POST', `/api/hub/sites/${site.id}/site-credential/reset`);
  assert.equal(reset.status, 200);
  assert.equal(reset.data.trustedVersion, '2.1.3');
  assert.equal(reset.data.credential.enrolled, false);
  assert.equal(hub.getSiteById(site.id).cms.packageVersion, '2.1.3');
  assert.equal(store.state(site.id, credential), 'not-enrolled');
  assert.equal(store.auditLog().at(-1).action, 'reset');
  assert.equal(securityCounters()['site-credential-reset'].total, 1);
  assert.equal((await send('GET', '/api/hub/shop/status', { siteKey: site.site_key })).status, 200, 'the older CMS has its shop status again');
  assert.equal((await send('POST', '/api/hub/shop/disconnect', { siteKey: site.site_key, body: { provider: 'paypal' } })).status, 401, 'money routes still need a credential');
  assert.equal((await send('POST', `/api/hub/sites/${site.id}/site-credential/reset`)).status, 409, 'nothing left to reset');
  assert.equal((await send('POST', '/api/hub/sites/nope/site-credential/reset')).status, 404);
  // Without a reported legacy version the reset only forgets the row.
  const plain = hub.createSite({ name: 'Plain reset', domain: 'plain.example', websitePlan: 'tier-3-ecommerce' });
  trustVersion(plain, '2.2.2');
  store.enroll(plain.id, value(), {});
  const plainReset = await send('POST', `/api/hub/sites/${plain.id}/site-credential/reset`);
  assert.equal(plainReset.data.trustedVersion, '');
  assert.equal(hub.getSiteById(plain.id).cms.packageVersion, '2.2.2');
  assert.equal((await send('GET', '/api/hub/shop/status', { siteKey: plain.site_key })).status, 401, 'a 2.2.2 site must enroll again');
});

test('routes were registered with the shared store', () => {
  assert.equal(routes.store(), store);
});
