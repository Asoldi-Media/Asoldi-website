// Unsubscribe tokens, the public pages, one-click, resubscribe, the opt-out record, the signed CMS
// hint (checked with the reference CMS verifier) and the rebuild from CMS mirrors after a loss.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-unsub-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.BREVO_API_KEY;

const store = await import('../data/email-store.js');
const auth = await import('../lib/email-site-auth.js');
const unsub = await import('../lib/email-unsubscribe.js');
const brevo = await import('../lib/brevo.js');
const { relaySend } = await import('../lib/email-relay.js');
const { createEmailLog } = await import('../lib/email-log.js');
const { createEmailQuota, memoryLedgerStore } = await import('../lib/email-quota.js');
const { registerEmailHubRoutes } = await import('../lib/routes/email-hub-routes.js');

const NOW = Date.parse('2026-11-03T10:00:00Z');
let clock = NOW;
const SITES = [
  { id: 'site_a', site_key: 'pk-a', domain: 'butikk-a.example.com', name: 'Butikk A', features: { emailMarketing: true, ecommerce: true } },
  { id: 'site_b', site_key: 'pk-b', domain: 'butikk-b.example.com', name: 'Butikk B', features: { emailMarketing: true, ecommerce: true } },
];
const hub = { getSiteByKey: (k) => SITES.find((s) => s.site_key === k) || null, getSiteById: (id) => SITES.find((s) => s.id === id) || null, getAllSites: () => SITES };
const hints = [];
const fetchImpl = async (url, init) => {
  hints.push({ url, init });
  return new Response('{}', { status: 200 });
};
const brevoCalls = [];
brevo.setBrevoDeps({
  env: { BREVO_API_KEY: 'fake-brevo-key-for-unsubscribe-tests' },
  fetch: async (url, init) => {
    brevoCalls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return new Response('{}', { status: 201 });
  },
});

let base = '';
let server;
const keys = {};
test.before(async () => {
  await store.saveEmailSettings({ enabled: true, rollout: { mode: 'allowlist', siteIds: ['site_a', 'site_b'] } });
  for (const site of SITES) {
    await auth.issuePending(site.id, { now: NOW });
    const pending = store.readEmailSiteKeys()[site.id].pending.key;
    assert.equal((await auth.confirmProvision(pending, { now: NOW })).ok, true);
    keys[site.id] = pending;
    await store.patchEmailSite(site.id, { dpa: { acceptedAt: '2026-10-01T00:00:00.000Z', version: 'v1' } });
  }
  const app = express();
  app.use(express.json());
  registerEmailHubRoutes(app, { adminAuth: (_q, r) => r.status(401).end(), hub }, { now: () => clock, fetchImpl, env: { HUB_SAFE_MODE: '0' }, startJobs: false });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

const suppressionsFile = () => join(dataDir, 'email-suppressions.json');
const fileState = () => (existsSync(suppressionsFile()) ? `${statSync(suppressionsFile()).mtimeMs}:${readFileSync(suppressionsFile(), 'utf8')}` : 'none');

async function page(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers }, ...(body ? { body } : {}) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

test('(a) a token round-trips; a changed or foreign token gives 400 and changes nothing', async () => {
  const t = unsub.mintUnsubToken({ siteId: 'site_a', email: 'Ola@Example.com', kind: 'cart-recovery', messageId: 'em_1' });
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.equal(t.toLowerCase().includes('ola'), false, 'no plain address in the link');
  assert.deepEqual(unsub.readUnsubToken(t), { siteId: 'site_a', email: 'ola@example.com', kind: 'cart-recovery', messageId: 'em_1', scope: 'marketing' });
  const flipped = `${t.slice(0, 20)}${t[20] === 'A' ? 'B' : 'A'}${t.slice(21)}`;
  assert.equal(unsub.readUnsubToken(flipped), null);
  assert.equal(unsub.readUnsubToken('not-a-token'), null);
  assert.equal(unsub.readUnsubToken(''), null);
  const before = fileState();
  for (const bad of [flipped, 'x'.repeat(60), '']) {
    assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${bad}`, { body: 'confirm=1' })).status, 400);
    assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${bad}`, { body: 'List-Unsubscribe=One-Click' })).status, 400);
    assert.equal((await page('POST', `/api/hub/email/resubscribe?t=${bad}`, { body: 'from=page' })).status, 400);
  }
  assert.equal(fileState(), before, 'no state change');
});

test('(b) (f) GET shows a confirm page, changes nothing, loads nothing external and shows only a masked address', async () => {
  const t = unsub.mintUnsubToken({ siteId: 'site_a', email: 'kari.nordmann@example.com', kind: 'welcome', messageId: 'em_2' });
  const before = fileState();
  const res = await page('GET', `/api/hub/email/unsubscribe?t=${t}`);
  assert.equal(res.status, 200);
  assert.equal(fileState(), before, 'GET never changes state');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(res.text.includes('kari.nordmann@example.com'), false, 'no full address');
  assert.equal(res.text.includes('kari'), false);
  assert.ok(res.text.includes('k***@example.com'));
  assert.equal(/\b(src|href)=/i.test(res.text), false, 'no external asset or link');
  assert.equal(/https?:\/\//i.test(res.text), false);
  assert.match(res.text, /Meld deg av e-post fra Butikk A/);
  const en = await page('GET', `/api/hub/email/unsubscribe?t=${t}&lang=en`);
  assert.match(en.text, /Unsubscribe from Butikk A emails/);
  assert.equal(unsub.isSuppressed('site_a', 'kari.nordmann@example.com', 'welcome'), false);
});

test('(c) (d) (e) one-click POST without cookies records the opt-out, removes the list member and sends a signed hint', async () => {
  await store.saveEmailSettings({ brevo: { syncContacts: true } });
  await store.patchEmailSite('site_a', { brevoListId: 57 });
  hints.length = 0;
  brevoCalls.length = 0;
  const t = unsub.mintUnsubToken({ siteId: 'site_a', email: 'ola@example.com', kind: 'cart-recovery', messageId: 'em_3' });
  const res = await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'List-Unsubscribe=One-Click' });
  assert.equal(res.status, 200);
  assert.equal(unsub.isSuppressed('site_a', 'ola@example.com', 'cart-recovery'), true);
  for (const kind of ['welcome', 'campaign', 'winback', 'review-request', 'back-in-stock']) assert.equal(unsub.isSuppressed('site_a', 'ola@example.com', kind), true, kind);
  assert.equal(unsub.isSuppressed('site_a', 'ola@example.com', 'test'), false, 'test sends are not marketing');
  assert.equal(unsub.isSuppressed('site_b', 'ola@example.com', 'welcome'), false, 'one shop\'s opt-out does not stop another');
  assert.equal(store.readEmailSuppressions().site_a['ola@example.com'].source, 'one-click');
  assert.deepEqual(brevoCalls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ['POST /v3/contacts/lists/57/contacts/remove']);
  assert.deepEqual(brevoCalls[0].body, { emails: ['ola@example.com'] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hints.length, 1);
  assert.equal(hints[0].url, 'https://butikk-a.example.com/api/cms/email/hub-event');
  const cms = auth.createReferenceCmsVerifier({ key: keys.site_a });
  assert.equal(cms.check({ headers: hints[0].init.headers, body: hints[0].init.body, now: clock }).ok, true, 'verifies with the emailKey');
  assert.equal(JSON.parse(hints[0].init.body).type, 'suppression');
  assert.equal(hints[0].init.body.includes('ola@example.com'), false, 'the hint carries no address; the CMS pulls');
  const siteKeySigned = { ...hints[0].init.headers, 'x-asoldi-signature': auth.signEmailPayload('pk-a', hints[0].init.body, { now: clock }) };
  assert.equal(cms.check({ headers: siteKeySigned, body: hints[0].init.body, now: clock }).ok, false, 'a hint signed with the site key is refused');
  await store.saveEmailSettings({ brevo: { syncContacts: false } });
});

test('form POST shows the done page with a one-time undo inside 30 days', async () => {
  const t = unsub.mintUnsubToken({ siteId: 'site_a', email: 'per@example.com', kind: 'welcome' });
  const done = await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'confirm=1' });
  assert.equal(done.status, 200);
  assert.match(done.text, /Du er meldt av/);
  assert.match(done.text, /action="\/api\/hub\/email\/resubscribe\?t=/);
  assert.equal(done.text.includes('per@example.com'), false);
  const again = await page('POST', `/api/hub/email/resubscribe?t=${t}`, { body: 'from=page' });
  assert.equal(again.status, 200);
  assert.match(again.text, /meldt på igjen/);
  assert.equal(unsub.isSuppressed('site_a', 'per@example.com', 'welcome'), false);
  await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'confirm=1' });
  assert.equal(unsub.isSuppressed('site_a', 'per@example.com', 'welcome'), true);
  const second = await page('POST', `/api/hub/email/resubscribe?t=${t}`, { body: 'from=page' });
  assert.equal(second.status, 409, 'resubscribe works once');
  assert.equal(unsub.isSuppressed('site_a', 'per@example.com', 'welcome'), true);
  const t2 = unsub.mintUnsubToken({ siteId: 'site_a', email: 'sen@example.com', kind: 'welcome' });
  await page('POST', `/api/hub/email/unsubscribe?t=${t2}`, { body: 'confirm=1' });
  clock = NOW + 31 * 24 * 60 * 60_000;
  assert.equal((await page('POST', `/api/hub/email/resubscribe?t=${t2}`, { body: 'from=page' })).status, 409, 'not after 30 days');
  clock = NOW;
});

test('listSuppressions: own rows plus global rows for addresses the site sent to, paged by time', async () => {
  await unsub.addSuppression({ siteId: 'site_b', email: 'b1@example.com', source: 'unsubscribe-link', now: NOW + 1000 });
  await unsub.addSuppression({ siteId: 'site_b', email: 'b2@example.com', source: 'unsubscribe-link', now: NOW + 2000 });
  await unsub.addSuppression({ siteId: 'site_b', email: 'b3@example.com', source: 'unsubscribe-link', now: NOW + 2000 });
  await unsub.addSuppression({ siteId: 'site_a', email: 'hard@example.com', global: true, source: 'hardBounce', now: NOW + 3000 });
  const forB = unsub.listSuppressions('site_b', { limit: 1 });
  assert.deepEqual(forB.items.map((i) => i.email), ['b1@example.com']);
  const page2 = unsub.listSuppressions('site_b', { since: forB.next, limit: 1 });
  assert.deepEqual(page2.items.map((i) => i.email), ['b2@example.com', 'b3@example.com'], 'a page never splits one timestamp');
  assert.equal(page2.next, null);
  assert.equal(JSON.stringify(unsub.listSuppressions('site_b')).includes('hard@example.com'), false, 'site_b never sent to it');
  assert.ok(unsub.listSuppressions('site_a').items.some((i) => i.email === 'hard@example.com' && i.scope === 'all'));
  assert.equal(unsub.isSuppressed('site_b', 'hard@example.com', 'test'), true, 'a hard bounce blocks every site and kind');
});

function fakeCms(siteId, items) {
  const verifier = auth.createReferenceCmsVerifier({ key: keys[siteId] });
  const seen = [];
  const srv = createServer((req, res) => {
    const check = verifier.check({ headers: req.headers, body: '', now: clock });
    seen.push({ path: req.url, ok: check.ok });
    if (!check.ok || !req.url.startsWith('/api/cms/email/suppressions')) {
      res.writeHead(401);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ items, next: null }));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, origin: `http://127.0.0.1:${srv.address().port}` })));
}

test('(g) losing the record blocks marketing with 503 until the rebuild from two CMS mirrors; then no suppressed address gets mail', async () => {
  const rows = store.readEmailSuppressions();
  const mirrorA = Object.entries(rows.site_a).map(([email, r]) => ({ email, scope: r.scope, source: r.source, at: r.at }));
  mirrorA.push({ email: 'hard@example.com', scope: 'all', source: 'hardBounce', at: new Date(NOW).toISOString() });
  const mirrorB = Object.entries(rows.site_b).map(([email, r]) => ({ email, scope: r.scope, source: r.source, at: r.at }));
  const cmsA = await fakeCms('site_a', mirrorA);
  const cmsB = await fakeCms('site_b', mirrorB);
  try {
    rmSync(suppressionsFile());
    for (const name of readdirSync(join(dataDir, 'backups'))) if (name.startsWith('email-suppressions')) rmSync(join(dataDir, 'backups', name));
    assert.equal(unsub.suppressionsAvailable(), false, 'the marker shows the record existed: it is lost, not new');

    const deps = {
      settings: store.deepMerge(store.readEmailSettings(), { devCmsTargets: { site_a: cmsA.origin, site_b: cmsB.origin } }),
      brevo: { brevoConfigured: () => true, sendBrevoEmail: async () => ({ providerMessageId: '<p@x>', mode: 'brevo' }) },
      log: createEmailLog({ flushMs: 0, dir: join(dataDir, 'email-log-g') }),
      quota: createEmailQuota({ store: memoryLedgerStore() }),
    };
    const mail = (siteId, to, kind = 'welcome', ref = `r-${to}`) => relaySend(hub.getSiteById(siteId), {
      kind, ref, to: { email: to }, subject: 'Hei', html: '<p>Hei {{unsubscribeUrl}}</p>', text: 'Hei',
      consent: { basis: 'explicit', scope: 'marketing', grade: 'checkout' },
      sender: { legalName: 'Butikk AS', orgNumber: '999 999 999', address: 'Gata 1, 0000 Oslo', email: 'post@example.com' },
    }, { now: clock, authenticated: true, deps });

    const blocked = await mail('site_a', 'fresh@example.com');
    assert.deepEqual([blocked.status, blocked.body.code], [503, 'suppressions_unavailable']);

    const t = unsub.mintUnsubToken({ siteId: 'site_b', email: 'during@example.com', kind: 'welcome' });
    assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'confirm=1' })).status, 200, 'an opt-out during the loss is still recorded (pending)');
    assert.equal(existsSync(join(dataDir, unsub.PENDING_FILE)), true);

    const result = await unsub.rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, now: clock, settings: deps.settings, env: { HUB_SAFE_MODE: '1' } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.written, true);
    assert.equal(cmsA.seen.length, 1);
    assert.equal(cmsA.seen[0].ok, true, 'the pull was signed with the site emailKey');
    assert.equal(cmsB.seen[0].ok, true);
    assert.equal(unsub.suppressionsAvailable(), true);

    for (const [siteId, email] of [['site_a', 'ola@example.com'], ['site_b', 'b1@example.com'], ['site_b', 'b3@example.com'], ['site_b', 'during@example.com'], ['site_a', 'hard@example.com'], ['site_b', 'hard@example.com']]) {
      const res = await mail(siteId, email);
      assert.deepEqual([res.status, res.body.code], [409, 'suppressed'], `${siteId} ${email}`);
    }
    const fine = await mail('site_a', 'fresh@example.com');
    assert.equal(fine.status, 200, JSON.stringify(fine.body));
    const second = await unsub.rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, now: clock, settings: deps.settings, env: { HUB_SAFE_MODE: '1' } });
    assert.equal(second.written, false, 'a readable record is never replaced by a rebuild');
  } finally {
    cmsA.srv.close();
    cmsB.srv.close();
  }
});

test('a rebuild with an unreachable mirror writes nothing unless forced', async () => {
  const saved = readFileSync(suppressionsFile(), 'utf8');
  rmSync(suppressionsFile());
  for (const name of readdirSync(join(dataDir, 'backups'))) if (name.startsWith('email-suppressions')) rmSync(join(dataDir, 'backups', name));
  const settings = store.deepMerge(store.readEmailSettings(), { devCmsTargets: { site_a: 'http://127.0.0.1:9', site_b: 'http://127.0.0.1:9' } });
  const partial = await unsub.rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, now: clock, settings, env: { HUB_SAFE_MODE: '1' } });
  assert.equal(partial.ok, false);
  assert.equal(partial.failed.length, 2);
  assert.equal(unsub.suppressionsAvailable(), false, 'still unavailable: marketing stays blocked');
  const forced = await unsub.rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, now: clock, settings, env: { HUB_SAFE_MODE: '1' }, force: true });
  assert.equal(forced.written, true);
  assert.equal(unsub.suppressionsAvailable(), true);
  await store.restoreEmailSuppressions(JSON.parse(saved), { force: true });
});

test('public routes answer 404 while email is disabled', async () => {
  await store.saveEmailSettings({ enabled: false });
  const t = unsub.mintUnsubToken({ siteId: 'site_a', email: 'x@example.com' });
  const before = fileState();
  for (const [method, path, body] of [['GET', `/api/hub/email/unsubscribe?t=${t}`], ['POST', `/api/hub/email/unsubscribe?t=${t}`, 'List-Unsubscribe=One-Click'], ['POST', `/api/hub/email/resubscribe?t=${t}`, 'from=page']]) {
    const res = await page(method, path, body ? { body } : {});
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(res.text), { code: 'disabled' });
  }
  assert.equal(fileState(), before);
  await store.saveEmailSettings({ enabled: true });
});
