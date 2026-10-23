// Site credential: enrollment with a proof from the stored domain, the store, the admin routes and
// the gates on hub routes a client CMS calls server to server. Everything runs on 127.0.0.1: the
// stored domains below are mapped to loopback servers through the routes' test-only resolveProofUrl.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-site-cred-'));
process.env.APP_DATA_DIR = dataDir;

const hub = await import('../data/hub.js');
const sc = await import('../lib/site-credentials.js');
const { registerShopPaymentsRoutes } = await import('../lib/shop-payments-routes.js');
const { mountClientAnalyticsRoutes, resetHubAnalyticsLimitsForTests } = await import('../lib/client-analytics-http.js');
const { resetSecurityCounters, securityCounters } = await import('../lib/security-counters.js');

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
  const state = { name, mode: 'normal', calls: 0, redirectTo: '' };
  const app = express();
  app.get('/api/cms/hub-enroll-proof', (req, res) => {
    state.calls += 1;
    const nonce = String(req.query.nonce || '');
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
const siteA = hub.createSite({ name: 'Site A', domain: 'site-a.example', websitePlan: 'tier-3-ecommerce' });
const siteNoDomain = hub.createSite({ name: 'No domain yet' });
const siteInternal = hub.createSite({ name: 'Internal', domain: '127.0.0.1:8080' });
const siteOther = hub.createSite({ name: 'Other', domain: 'other.example', websitePlan: 'tier-3-ecommerce' });

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
  store,
  limiter: {
    unknownSite: (...args) => limiter.unknownSite(...args),
    site: (...args) => limiter.site(...args),
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

test('a revoked credential stops working; the site enrolls again and that counts as a re-enrollment', async () => {
  freshLimits();
  const credential = value();
  assert.equal((await enroll(siteA, credential, cmsA.start(credential))).status, 200);
  assert.equal(store.state(siteA.id, credential), 'valid');
  resetSecurityCounters();
  const revoked = await send('POST', `/api/hub/sites/${siteA.id}/site-credential/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.credential.enrolled, false);
  assert.equal(revoked.data.credential.revokedBy, 'staff-one');
  assert.equal(store.state(siteA.id, credential), 'not-enrolled');
  const status = await send('GET', '/api/hub/shop/status', { siteKey: siteA.site_key, credential });
  assert.equal(status.headers.get('x-site-credential-status'), 'not-enrolled', 'the CMS learns that it must enroll again');
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
  for (const site of [siteA, siteOther]) {
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

test('shop status and documents accept the site key until the site enrolls, then need the credential', async () => {
  const before = await send('GET', '/api/hub/shop/status', { siteKey: siteOther.site_key });
  assert.equal(before.status, 200, 'a site without a credential (older CMS) keeps its shop status');
  assert.equal(before.headers.get('x-site-credential-status'), 'not-enrolled');
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
  const dashOld = await send('GET', `/api/hub/analytics?site_key=${siteOther.site_key}`);
  assert.equal(dashOld.status, 200, 'a site that never enrolled keeps its dashboard');
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes were registered with the shared store', () => {
  assert.equal(routes.store(), store);
});
