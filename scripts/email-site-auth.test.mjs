// Email credential: the provisioning pull over the site credential, the confirm, rotation with the
// 10-minute grace, the site key never authenticating an email route, signed hub → CMS hints that go
// only to https://<site domain>, and the local-only CMS target override.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-site-auth-'));
process.env.APP_DATA_DIR = dataDir;

const store = await import('../data/email-store.js');
const auth = await import('../lib/email-site-auth.js');
const { postCmsHint, HUB_EVENT_PATH } = await import('../lib/email-hint.js');
const { siteCredentialStore } = await import('../lib/site-credentials.js');
const { registerEmailHubRoutes } = await import('../lib/routes/email-hub-routes.js');

const T0 = Date.parse('2026-11-03T09:00:00Z');
let clock = T0;
const SITES = [
  { id: 'site_1', site_key: 'public-key-one', domain: 'shop.example.com', name: 'Eksempelbutikk', cms: { adminUrl: 'https://admin-elsewhere.example.net/admin' }, features: { emailMarketing: true } },
  { id: 'site_2', site_key: 'public-key-two', domain: 'other.example.com', name: 'Annen butikk', features: { emailMarketing: true } },
];
const hub = {
  getSiteByKey: (key) => SITES.find((s) => s.site_key === key) || null,
  getSiteById: (id) => SITES.find((s) => s.id === id) || null,
  getAllSites: () => SITES,
};
const CREDENTIAL = randomBytes(32).toString('base64url');
const OTHER_CREDENTIAL = randomBytes(32).toString('base64url');
siteCredentialStore().enroll('site_1', CREDENTIAL, { proofDomain: 'shop.example.com', proofOrigin: 'https://shop.example.com' });
siteCredentialStore().enroll('site_2', OTHER_CREDENTIAL, { proofDomain: 'other.example.com', proofOrigin: 'https://other.example.com' });

const hints = [];
const fetchImpl = async (url, init) => {
  hints.push({ url, init });
  return new Response('{"ok":true}', { status: 200 });
};

/** The site routes a client CMS calls with its emailKey (the send, contacts, quota and campaign API). */
const EMAIL_SITE_ROUTES = [
  ['post', '/api/hub/email/send'],
  ['post', '/api/hub/email/contacts'],
  ['delete', '/api/hub/email/contacts'],
  ['get', '/api/hub/email/quota'],
  ['get', '/api/hub/email/suppressions'],
  ['get', '/api/hub/email/stats'],
  ['post', '/api/hub/email/lint'],
  ['post', '/api/hub/email/campaigns'],
  ['post', '/api/hub/email/campaigns/hc_1/recipients'],
  ['post', '/api/hub/email/campaigns/hc_1/start'],
  ['post', '/api/hub/email/campaigns/hc_1/cancel'],
  ['get', '/api/hub/email/campaigns/hc_1'],
  ['get', '/api/hub/email/owner-recipients'],
  ['put', '/api/hub/email/owner-recipients'],
  ['post', '/api/hub/email/owner-notify'],
];

let base = '';
let server;
const adminToken = 'admin-test-token';
test.before(async () => {
  const app = express();
  app.use(express.json());
  const adminAuth = (req, res, next) => (req.get('authorization') === `Bearer ${adminToken}` ? next() : res.status(401).json({ message: 'Unauthorized' }));
  registerEmailHubRoutes(app, { adminAuth, hub }, { now: () => clock, fetchImpl, env: { HUB_SAFE_MODE: '0' }, startJobs: false });
  const guard = auth.requireEmailKey({ getSiteById: hub.getSiteById, getSiteByKey: hub.getSiteByKey, now: () => clock });
  for (const [method, path] of EMAIL_SITE_ROUTES) app[method](path, guard, (req, res) => res.json({ ok: true, siteId: req.emailAuth.siteId, which: req.emailAuth.which }));
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

async function call(method, path, headers = {}, body = undefined) {
  const res = await fetch(`${base}${path}`, {
    method: method.toUpperCase(),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

const admin = { authorization: `Bearer ${adminToken}` };
const cms1 = { 'x-site-key': 'public-key-one', 'x-site-credential': CREDENTIAL };

test('email is disabled by default: provisioning routes answer 404 and write nothing', async () => {
  assert.equal(store.readEmailSettings().enabled, false);
  for (const [path, headers] of [['/api/hub/email/provision-request', cms1], ['/api/hub/email/provision/confirm', { 'x-email-key': 'x'.repeat(43) }]]) {
    const res = await call('post', path, headers);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { code: 'disabled' });
  }
  assert.equal(store.readEmailSite('site_1').auth.provisionRequests, undefined, 'nothing was counted');
  assert.deepEqual(store.readEmailSiteKeys(), {});
});

test('provision-request without a valid site credential returns { ok: true } and no key', async () => {
  await store.saveEmailSettings({ enabled: true, rollout: { mode: 'allowlist', siteIds: ['site_1', 'site_2'] } });
  for (const headers of [
    { 'x-site-key': 'public-key-one' },
    { 'x-site-key': 'public-key-one', 'x-site-credential': OTHER_CREDENTIAL },
    { 'x-site-key': 'public-key-one', 'x-site-credential': 'short' },
    { 'x-site-key': 'no-such-site', 'x-site-credential': CREDENTIAL },
    {},
  ]) {
    const res = await call('post', '/api/hub/email/provision-request', headers);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  }
  assert.deepEqual(store.readEmailSiteKeys(), {}, 'no key was issued');
  assert.equal(store.readEmailSite('site_1').auth.provisionRequests, undefined, 'requests without a credential do not use up the daily allowance');
});

let firstKey = '';
test('a credential-valid request gets the pending key; the confirm commits it; a never-issued key gets 401', async () => {
  const first = await call('post', '/api/hub/email/provision-request', cms1);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.keyId, 'ek_1');
  assert.match(first.body.emailKey, auth.EMAIL_KEY_RE);
  firstKey = first.body.emailKey;
  const again = await call('post', '/api/hub/email/provision-request', cms1);
  assert.equal(again.body.emailKey, firstKey, 'the same pending key until it is confirmed');
  assert.equal(auth.findSiteByEmailKey(firstKey, { now: clock }), null, 'a pending key authenticates nothing');

  const never = await call('post', '/api/hub/email/provision/confirm', { 'x-email-key': randomBytes(32).toString('base64url') });
  assert.deepEqual([never.status, never.body], [401, { ok: false, code: 'unauthorized' }]);
  for (const headers of [{ 'x-site-key': 'public-key-one' }, cms1, { 'x-email-key': 'public-key-one' }, { 'x-email-key': firstKey, 'x-site-key': 'public-key-two' }]) {
    assert.equal((await call('post', '/api/hub/email/provision/confirm', headers)).status, 401);
  }
  const ok = await call('post', '/api/hub/email/provision/confirm', { 'x-email-key': firstKey, 'x-site-key': 'public-key-one' });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true, keyId: 'ek_1' }]);
  const repeat = await call('post', '/api/hub/email/provision/confirm', { 'x-email-key': firstKey });
  assert.deepEqual([repeat.status, repeat.body], [200, { ok: true, keyId: 'ek_1' }], 'a repeated confirm is idempotent');
  assert.equal(store.readEmailSite('site_1').auth.keyId, 'ek_1');
  assert.ok(store.readEmailSite('site_1').auth.confirmedAt);
  // A CMS that lost its key, or whose owner asks to reconnect, asks again with its credential: the
  // hub hands out a new pending key (a rotation); the confirmed key keeps working until its confirm.
  const again2 = await call('post', '/api/hub/email/provision-request', cms1);
  assert.equal(again2.body.keyId, 'ek_2', 'a site with a key gets a new pending key');
  assert.notEqual(again2.body.emailKey, firstKey);
  assert.deepEqual(auth.findSiteByEmailKey(firstKey, { now: clock }), { siteId: 'site_1', keyId: 'ek_1', which: 'current' }, 'the confirmed key still works');
  assert.equal(auth.findSiteByEmailKey(again2.body.emailKey, { now: clock }), null, 'the new key authenticates nothing until its confirm');
  const limit = await call('post', '/api/hub/email/provision-request', cms1);
  assert.deepEqual(limit.body, { ok: true }, 'the fourth credential-valid request of the day gets nothing');
});

test('the site key alone gets 401 on every email site route; only the emailKey opens them', async () => {
  for (const [method, path] of EMAIL_SITE_ROUTES) {
    for (const headers of [
      { 'x-site-key': 'public-key-one' },
      cms1,
      { 'x-site-key': 'public-key-one', 'x-email-key': 'public-key-one' },
      { 'x-email-key': randomBytes(32).toString('base64url') },
      { 'x-email-key': firstKey, 'x-site-key': 'public-key-two' },
    ]) {
      const res = await call(method, path, headers, method === 'get' ? undefined : {});
      assert.deepEqual([res.status, res.body], [401, { ok: false, code: 'unauthorized' }], `${method} ${path} ${JSON.stringify(Object.keys(headers))}`);
    }
    const ok = await call(method, path, { 'x-email-key': firstKey, 'x-site-key': 'public-key-one' }, method === 'get' ? undefined : {});
    assert.deepEqual([ok.status, ok.body.siteId], [200, 'site_1'], `${method} ${path}`);
  }
});

test('rotation: a signed hint goes to https://<domain> only; the old key works 10 minutes after the confirm, then 401', async () => {
  // The next day: site_1 used its three provision requests for today above.
  clock = T0 + 24 * 60 * 60_000;
  hints.length = 0;
  const rotated = await call('post', '/api/admin/email/sites/site_1/provision', admin);
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.pendingKeyId, 'ek_3', 'a superadmin rotation replaces the unconfirmed ek_2');
  assert.equal(rotated.body.rotation, true);
  assert.equal(JSON.stringify(rotated.body).includes(firstKey), false, 'the admin answer carries no key');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hints.length, 1);
  assert.equal(hints[0].url, `https://shop.example.com${HUB_EVENT_PATH}`, 'never the heartbeat adminUrl');
  const cms = auth.createReferenceCmsVerifier({ key: firstKey });
  assert.deepEqual(cms.check({ headers: hints[0].init.headers, body: hints[0].init.body, url: hints[0].url, now: clock }), { ok: true, reason: 'ok' });
  assert.equal(JSON.parse(hints[0].init.body).type, 'key-rotation');

  const guarded = (key) => call('get', '/api/hub/email/quota', { 'x-email-key': key });
  assert.equal((await guarded(firstKey)).status, 200, 'the current key keeps working until the confirm');
  const pulled = await call('post', '/api/hub/email/provision-request', cms1);
  assert.equal(pulled.body.keyId, 'ek_3');
  const secondKey = pulled.body.emailKey;
  assert.notEqual(secondKey, firstKey);
  const confirmAt = clock;
  assert.equal((await call('post', '/api/hub/email/provision/confirm', { 'x-email-key': secondKey })).status, 200);
  assert.equal((await guarded(secondKey)).body.which, 'current');
  clock = confirmAt + 9 * 60_000;
  const grace = await guarded(firstKey);
  assert.deepEqual([grace.status, grace.body.which], [200, 'previous']);
  clock = confirmAt + 10 * 60_000 + 1000;
  assert.equal((await guarded(firstKey)).status, 401, 'the old key is refused after 10 minutes');
  assert.equal((await guarded(secondKey)).status, 200);
  assert.equal((await call('post', '/api/hub/email/provision/confirm', { 'x-email-key': firstKey })).status, 401, 'a retired key cannot be confirmed again');
  clock = T0;
});

test('at most three credential-valid provision requests per site and day', async () => {
  await call('post', '/api/admin/email/sites/site_2/provision', admin);
  const cms2 = { 'x-site-key': 'public-key-two', 'x-site-credential': OTHER_CREDENTIAL };
  const answers = [];
  for (let i = 0; i < 4; i += 1) answers.push((await call('post', '/api/hub/email/provision-request', cms2)).body);
  assert.equal(answers.slice(0, 3).every((a) => a.keyId === 'ek_1'), true);
  assert.deepEqual(answers[3], { ok: true }, 'the fourth request of the day gets nothing');
  clock = T0 + 24 * 60 * 60_000;
  assert.equal((await call('post', '/api/hub/email/provision-request', cms2)).body.keyId, 'ek_1', 'the allowance resets the next day');
  clock = T0;
});

test('hub → CMS signatures: the reference verifier accepts the emailKey only, for the signed method, path and body, within ±300 s', () => {
  const key = auth.generateEmailKey();
  const body = JSON.stringify({ type: 'suppression', siteId: 'site_1' });
  const call = { method: 'POST', path: '/api/cms/email/hub-event' };
  const header = auth.signEmailPayload(key, body, { now: T0, ...call });
  assert.match(header, /^t=\d+,v1=[a-f0-9]{64}$/);
  assert.equal(auth.verifyEmailSignature({ header, body, key, now: T0 + 299_000, ...call }), true);
  assert.equal(auth.verifyEmailSignature({ header, body, key, now: T0 + 301_000, ...call }), false, 'too old');
  assert.equal(auth.verifyEmailSignature({ header, body, key, now: T0 - 301_000, ...call }), false, 'too far ahead');
  assert.equal(auth.verifyEmailSignature({ header, body: `${body} `, key, now: T0, ...call }), false, 'a changed body');
  assert.equal(auth.verifyEmailSignature({ header, body, key, now: T0, method: 'POST', path: '/api/cms/email/tick' }), false, 'another path');
  assert.equal(auth.verifyEmailSignature({ header, body, key, now: T0, method: 'PUT', path: call.path }), false, 'another method');
  const siteKeySigned = auth.signEmailPayload('public-key-one', body, { now: T0, ...call });
  assert.equal(auth.verifyEmailSignature({ header: siteKeySigned, body, key, now: T0, ...call }), false, 'a hint signed with the site key is refused');
  assert.equal(auth.createReferenceCmsVerifier({ key }).check({ headers: {}, body, now: T0 }).reason, 'missing-signature');
  // A GET covers its query: the signature of one page of the mirror opens no other.
  const get = { method: 'GET', path: '/api/cms/email/suppressions?since=2026-11-03T08%3A00%3A00.000Z' };
  const getHeader = auth.signEmailPayload(key, '', { now: T0, ...get });
  assert.equal(auth.verifyEmailSignature({ header: getHeader, key, now: T0, ...get }), true);
  assert.equal(auth.verifyEmailSignature({ header: getHeader, key, now: T0, method: 'GET', path: '/api/cms/email/suppressions' }), false, 'without the query');
  assert.equal(auth.verifyEmailSignature({ header: getHeader, key, now: T0, method: 'GET', path: '/api/cms/email/suppressions?since=2000-01-01T00%3A00%3A00.000Z' }), false, 'another query');
  assert.equal(auth.signedPathOf('https://shop.example.com/api/cms/email/suppressions?since=2026-11-03T08%3A00%3A00.000Z'), get.path);
});

test('postCmsHint skips sites without a key or a public domain and never follows redirects', async () => {
  const seen = [];
  const fetchSpy = async (url, init) => {
    seen.push({ url, redirect: init.redirect });
    return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.net/' } });
  };
  assert.deepEqual(await postCmsHint({ id: 'site_none', domain: 'x.example.com' }, 'suppression', {}, { fetchImpl: fetchSpy }), { ok: false, reason: 'no-key' });
  const res = await postCmsHint(SITES[0], 'suppression', {}, { fetchImpl: fetchSpy, env: { HUB_SAFE_MODE: '0' } });
  assert.deepEqual(res, { ok: false, status: 302 });
  assert.deepEqual(seen, [{ url: `https://shop.example.com${HUB_EVENT_PATH}`, redirect: 'manual' }]);
  assert.equal(auth.cmsTarget({ id: 'x', domain: 'localhost' }, { env: { HUB_SAFE_MODE: '0' } }), '', 'an internal host is no target');
  assert.equal(auth.cmsTarget({ id: 'x', domain: 'https://Shop.Example.com/path' }, { env: { HUB_SAFE_MODE: '0' } }), 'https://shop.example.com');
});

test('devCmsTargets is honoured only in safe mode and only for loopback origins', async () => {
  const settings = store.deepMerge(store.readEmailSettings(), { devCmsTargets: { site_1: 'http://127.0.0.1:4555', site_2: 'https://unlisted.example.net' } });
  const lines = [];
  const log = { warn: (line) => lines.push(line) };
  assert.equal(auth.cmsTarget(SITES[0], { settings, env: { HUB_SAFE_MODE: '1' }, log }), 'http://127.0.0.1:4555');
  assert.equal(auth.cmsTarget(SITES[0], { settings, env: { HUB_SAFE_MODE: '0' }, log }), 'https://shop.example.com');
  assert.equal(auth.cmsTarget(SITES[0], { settings, env: { HOSTINGER: '1' }, log }), 'https://shop.example.com', 'the Hostinger runtime is never in safe mode by default');
  assert.equal(auth.cmsTarget(SITES[1], { settings, env: { HUB_SAFE_MODE: '1' }, log }), 'https://other.example.com', 'a non-loopback override is ignored');
  assert.ok(lines.some((line) => line.includes('site_1') && line.includes('not in safe mode')), 'the ignored override is logged');
  const refused = await call('put', '/api/admin/email/settings', admin, { devCmsTargets: { site_1: 'http://127.0.0.1:4555' } });
  assert.equal(refused.status, 400, 'the admin route refuses the override outside safe mode');
  assert.deepEqual(store.readEmailSettings().devCmsTargets, {});
});

test('key status and secrets: no key in any admin view or email-sites.json', async () => {
  const status = await call('get', '/api/admin/email/status', admin);
  assert.equal(status.status, 200);
  const keys = store.readEmailSiteKeys();
  const values = Object.values(keys).flatMap((rec) => [rec.key, rec.prevKey, rec.pending?.key]).filter(Boolean);
  assert.ok(values.length >= 2);
  const text = JSON.stringify(status.body) + JSON.stringify(store.readEmailSites());
  for (const value of values) assert.equal(text.includes(value), false);
});

test('the opt-out rebuild route merges into a readable record and writes nothing when nothing is new', async () => {
  const res = await call('post', '/api/admin/email/suppressions/rebuild', admin, {});
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.ok, res.body.written, res.body.mode, res.body.changed], [true, false, 'merge', 0]);
  assert.equal((await call('post', '/api/admin/email/suppressions/rebuild', {}, {})).status, 401, 'superadmin only');
});

test('route coverage: every /api/hub/email/ route outside the public list needs the emailKey', async () => {
  const { existsSync } = await import('node:fs');
  const { PUBLIC_EMAIL_ROUTES } = await import('../lib/routes/email-hub-routes.js');
  const probe = express();
  registerEmailHubRoutes(probe, { adminAuth: (_q, _r, n) => n(), hub }, { startJobs: false });
  const guard = auth.requireEmailKey({ getSiteById: hub.getSiteById, getSiteByKey: hub.getSiteByKey });
  for (const [method, path] of EMAIL_SITE_ROUTES) probe[method](path, guard, (_q, r) => r.json({ ok: true }));
  probe.post('/api/hub/email/unguarded-example', (_q, r) => r.json({ ok: true }));
  const unguarded = auth.emailRouteGuards(probe).filter((r) => !r.guarded).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(unguarded.sort(), [...PUBLIC_EMAIL_ROUTES, 'POST /api/hub/email/unguarded-example'].sort(), 'the walker finds a route without the guard');
  assert.equal(auth.emailRouteGuards(probe).filter((r) => r.guarded).length, EMAIL_SITE_ROUTES.length);
});

const siteRoutesModule = new URL('../lib/routes/email-site-routes.js', import.meta.url);
test('the CMS-facing email routes: each needs the emailKey, and the site key alone gets 401', {
  skip: (await import('node:fs')).existsSync(siteRoutesModule) ? false : 'lib/routes/email-site-routes.js is not in this build; this check runs once it is',
}, async () => {
  const { PUBLIC_EMAIL_ROUTES } = await import('../lib/routes/email-hub-routes.js');
  const mod = await import(siteRoutesModule.href);
  const app = express();
  app.use(express.json());
  await mod.register(app, { adminAuth: (_q, r) => r.status(401).end(), hub, sales: { getSalesClients: () => [] } });
  // The Brevo webhook takes Brevo's token instead of an emailKey; it is checked below on its own.
  const webhookRoutes = mod.EMAIL_WEBHOOK_ROUTES || [];
  const all = auth.emailRouteGuards(app);
  const routes = all.filter((r) => !PUBLIC_EMAIL_ROUTES.includes(`${r.method} ${r.path}`) && !webhookRoutes.includes(`${r.method} ${r.path}`));
  assert.ok(routes.length > 0, 'the module registers CMS-facing routes');
  assert.deepEqual(routes.filter((r) => !r.guarded).map((r) => `${r.method} ${r.path}`), [], 'routes without requireEmailKey');
  assert.deepEqual(webhookRoutes.filter((r) => !all.some((x) => `${x.method} ${x.path}` === r)), [], 'every exempted webhook route exists');
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    for (const { method, path } of routes) {
      const url = `http://127.0.0.1:${srv.address().port}${path.replace(/:[A-Za-z_]+/g, 'x')}`;
      const res = await fetch(url, { method, headers: { ...cms1, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, ...(method === 'GET' ? {} : { body: '{}' }) });
      await res.text();
      assert.equal(res.status, 401, `${method} ${path} with the site key and credential only`);
    }
    for (const route of webhookRoutes) {
      const [method, path] = route.split(' ');
      const res = await fetch(`http://127.0.0.1:${srv.address().port}${path.replace(/:[A-Za-z_]+/g, 'x')}`, { method, headers: { ...cms1, 'content-type': 'application/json', 'x-asoldi-webhook': 'x' }, body: '{}' });
      await res.text();
      assert.equal(res.status, 404, `${route} with a token that is not the hub's`);
    }
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('every email core route is called by a test', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const routes = [];
  const fake = Object.fromEntries(['get', 'post', 'put', 'delete', 'patch'].map((m) => [m, (p) => routes.push(`${m.toUpperCase()} ${p}`)]));
  const handle = registerEmailHubRoutes(fake, { adminAuth: (_q, _r, n) => n(), hub }, { startJobs: false });
  handle.stop();
  assert.ok(routes.length >= 11, `found ${routes.length}`);
  const dir = dirname(fileURLToPath(import.meta.url));
  const sources = ['email-site-auth.test.mjs', 'email-unsubscribe.test.mjs', 'owner-routing-default.test.mjs', 'email-hub-boot.test.mjs']
    .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  const missing = routes.filter((r) => {
    const pattern = r.split(' ')[1].split(/(:[A-Za-z_]+)/).map((part) => (part.startsWith(':') ? '[^/\'"`\\s?]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
    return !new RegExp(`${pattern}(?=[^A-Za-z0-9_\\-/.]|$)`, 'm').test(sources);
  });
  assert.deepEqual(missing, [], `routes without a test: ${missing.join(', ')}`);
});

test('provision-request never carries the site-credential status header, whatever credential comes with it', async () => {
  await store.saveEmailSettings({ enabled: true });
  for (const [label, headers, plain] of [
    ['the site key alone', { 'x-site-key': 'public-key-one' }, true],
    ['a credential of another site', { 'x-site-key': 'public-key-one', 'x-site-credential': OTHER_CREDENTIAL }, true],
    ['a malformed credential', { 'x-site-key': 'public-key-one', 'x-site-credential': 'short' }, true],
    ['the valid credential', cms1, false],
  ]) {
    const res = await fetch(`${base}/api/hub/email/provision-request`, { method: 'POST', headers });
    const answer = await res.json();
    assert.equal(res.status, 200, label);
    assert.equal(res.headers.get('x-site-credential-status'), null, `${label}: no status header`);
    if (plain) assert.deepEqual(answer, { ok: true }, label);
  }
});

test('a provision confirm with an unknown or malformed key is refused without waiting for the key lock', async () => {
  await store.saveEmailSettings({ enabled: true });
  let release;
  const held = store.withFileLock('email-site-keys', () => new Promise((resolve) => { release = resolve; }));
  try {
    for (const key of ['x'.repeat(10), randomBytes(32).toString('base64url')]) {
      const started = Date.now();
      const res = await fetch(`${base}/api/hub/email/provision/confirm`, { method: 'POST', headers: { 'x-email-key': key }, signal: AbortSignal.timeout(5000) });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { ok: false, code: 'unauthorized' });
      assert.ok(Date.now() - started < 1500, `answered in ${Date.now() - started} ms while another holder kept the key lock`);
    }
  } finally {
    release();
    await held;
  }
});

test('provision request and confirm are limited per client address; the unsubscribe limits are separate', async () => {
  await store.saveEmailSettings({ enabled: true });
  const app = express();
  app.use(express.json());
  registerEmailHubRoutes(app, { adminAuth: (_q, r) => r.status(401).end(), hub }, { now: () => clock, env: { HUB_SAFE_MODE: '0' }, startJobs: false, provisionLimits: { perAddress: 3 } });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const url = (path) => `http://127.0.0.1:${srv.address().port}${path}`;
    const statuses = [];
    for (let i = 0; i < 2; i += 1) statuses.push((await fetch(url('/api/hub/email/provision/confirm'), { method: 'POST', headers: { 'x-email-key': 'y'.repeat(43) } })).status);
    statuses.push((await fetch(url('/api/hub/email/provision-request'), { method: 'POST', headers: { 'x-site-key': 'public-key-two' } })).status);
    const over = await fetch(url('/api/hub/email/provision/confirm'), { method: 'POST', headers: { 'x-email-key': 'y'.repeat(43) } });
    assert.deepEqual(statuses, [401, 401, 200]);
    assert.equal(over.status, 429);
    assert.deepEqual(await over.json(), { ok: false, code: 'rate_limited' });
    assert.ok(Number(over.headers.get('retry-after')) >= 1);
    assert.equal((await fetch(url('/api/hub/email/provision-request'), { method: 'POST', headers: { 'x-site-key': 'public-key-two' } })).status, 429, 'the request route shares the allowance');
    clock += 10 * 60_000 + 1000;
    assert.equal((await fetch(url('/api/hub/email/provision/confirm'), { method: 'POST', headers: { 'x-email-key': 'y'.repeat(43) } })).status, 401, 'the window moves on');
    const { PROVISION_PER_ADDRESS } = await import('../lib/routes/email-hub-routes.js');
    assert.equal(PROVISION_PER_ADDRESS, 30, 'the default allowance');
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('a settings change that cannot be saved answers 503 instead of hanging', async () => {
  const { existsSync, mkdirSync, renameSync, rmSync } = await import('node:fs');
  const live = join(dataDir, 'email-settings.json');
  const aside = join(dataDir, 'email-settings.json.aside');
  if (existsSync(live)) renameSync(live, aside);
  mkdirSync(live);
  try {
    for (const [path, payload] of [['/api/admin/email/settings', { killSwitch: true }], ['/api/admin/email/owner-routing/default', { enabled: false, siteIds: [] }]]) {
      const res = await fetch(`${base}${path}`, { method: 'PUT', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
      assert.equal(res.status, 503, path);
      const answer = await res.json();
      assert.equal(answer.code, 'unavailable', path);
      assert.equal(answer.ok, false, path);
    }
  } finally {
    rmSync(live, { recursive: true, force: true });
    if (existsSync(aside)) renameSync(aside, live);
  }
  assert.equal((await call('put', '/api/admin/email/settings', admin, { killSwitch: false })).status, 200, 'saving works again');
});
