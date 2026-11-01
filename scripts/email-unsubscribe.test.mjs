// Unsubscribe tokens, the public pages, one-click, resubscribe, the opt-out record, the signed CMS
// hint (checked with the reference CMS verifier), opt-outs that only ever get stronger, the pending
// opt-outs taken during a loss, the merge-only rebuild from CMS mirrors and the public POST limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const { createPublicPostLimiter, registerEmailHubRoutes } = await import('../lib/routes/email-hub-routes.js');
const { isAsoldiMarketingSuppressed } = await import('../lib/asoldi-unsubscribe.js');

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
  registerEmailHubRoutes(app, { adminAuth: (q, r, next) => (q.get('authorization') === 'Bearer admin' ? next() : r.status(401).end()), hub }, { now: () => clock, fetchImpl, env: { HUB_SAFE_MODE: '0' }, startJobs: false });
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

const backupsDir = () => join(dataDir, 'backups');
const latestBackup = () => join(backupsDir(), 'email-suppressions.json.latest.json');
const datedSnapshots = () => readdirSync(backupsDir()).filter((name) => /^email-suppressions\.json\.\d{4}-.+\.json$/.test(name));

/** The record and its .latest backup gone (dated snapshots kept unless `snapshots: false`). */
function loseRecord({ snapshots = true } = {}) {
  rmSync(suppressionsFile(), { force: true });
  rmSync(latestBackup(), { force: true });
  if (!snapshots) for (const name of datedSnapshots()) rmSync(join(backupsDir(), name));
  assert.equal(unsub.suppressionsAvailable(), false, 'the marker shows the record existed: it is lost, not new');
}

function relayDeps(extra = {}) {
  return {
    settings: store.deepMerge(store.readEmailSettings(), extra),
    brevo: { brevoConfigured: () => true, sendBrevoEmail: async () => ({ providerMessageId: '<p@x>', mode: 'brevo' }) },
    log: createEmailLog({ flushMs: 0, dir: join(dataDir, 'email-log-g') }),
    quota: createEmailQuota({ store: memoryLedgerStore() }),
  };
}

let mailRef = 0;
function mail(siteId, to, deps, kind = 'welcome') {
  mailRef += 1;
  return relaySend(hub.getSiteById(siteId), {
    kind, ref: `r-${mailRef}`, to: { email: to }, subject: 'Hei', html: '<p>Hei {{unsubscribeUrl}}</p>', text: 'Hei',
    consent: { basis: 'explicit', scope: 'marketing', grade: 'checkout' },
    sender: { legalName: 'Butikk AS', orgNumber: '999 999 999', address: 'Gata 1, 0000 Oslo', email: 'post@example.com' },
  }, { now: clock, authenticated: true, deps });
}

test('(g) losing the record blocks marketing with 503 until the rebuild: newest snapshot plus two CMS mirrors plus pending opt-outs', async () => {
  await store.updateEmailSuppressions((rows) => {
    rows.asoldi = { 'asoldi-optout@example.com': { scope: 'marketing', source: 'unsubscribe-link', at: '2026-10-01T00:00:00.000Z' } };
  });
  const rows = store.readEmailSuppressions();
  const mirrorA = Object.entries(rows.site_a).map(([email, r]) => ({ email, scope: r.scope, source: r.source, at: r.at }));
  mirrorA.push({ email: 'hard@example.com', scope: 'all', source: 'hardBounce', at: new Date(NOW).toISOString() });
  const mirrorB = Object.entries(rows.site_b).map(([email, r]) => ({ email, scope: r.scope, source: r.source, at: r.at }));
  mirrorB.push({ email: 'mirror-only@example.com', scope: 'marketing', source: 'cms-form', at: new Date(NOW + 5000).toISOString() });
  const cmsA = await fakeCms('site_a', mirrorA);
  const cmsB = await fakeCms('site_b', mirrorB);
  try {
    loseRecord();
    const deps = relayDeps({ devCmsTargets: { site_a: cmsA.origin, site_b: cmsB.origin } });
    const blocked = await mail('site_a', 'fresh@example.com', deps);
    assert.deepEqual([blocked.status, blocked.body.code], [503, 'suppressions_unavailable']);

    const t = unsub.mintUnsubToken({ siteId: 'site_b', email: 'during@example.com', kind: 'welcome' });
    assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'confirm=1' })).status, 200, 'an opt-out during the loss is still recorded (pending)');
    assert.equal(existsSync(join(dataDir, unsub.PENDING_FILE)), true);
    assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'confirm=1' })).status, 200);
    assert.equal(readFileSync(join(dataDir, unsub.PENDING_FILE), 'utf8').trim().split('\n').length, 1, 'a repeat is not appended twice');

    const result = await unsub.rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, now: clock, settings: deps.settings, env: { HUB_SAFE_MODE: '1' } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual([result.written, result.mode, result.base], [true, 'lost', 'snapshot']);
    assert.equal(cmsA.seen.length, 1);
    assert.equal(cmsA.seen[0].ok, true, 'the pull was signed with the site emailKey');
    assert.equal(cmsB.seen[0].ok, true);
    assert.equal(unsub.suppressionsAvailable(), true);
    assert.equal(existsSync(join(dataDir, unsub.PENDING_FILE)), false, 'the pending file was applied');

    const restored = store.readEmailSuppressions();
    assert.deepEqual(Object.keys(restored.asoldi), ['asoldi-optout@example.com'], 'Asoldi\'s own opt-outs survive the rebuild');
    assert.equal(isAsoldiMarketingSuppressed('asoldi-optout@example.com'), true);
    assert.equal(isAsoldiMarketingSuppressed('someone-else@example.com'), false);
    for (const [siteId, email] of [['site_a', 'ola@example.com'], ['site_b', 'b1@example.com'], ['site_b', 'b3@example.com'], ['site_b', 'during@example.com'], ['site_b', 'mirror-only@example.com'], ['site_a', 'hard@example.com'], ['site_b', 'hard@example.com']]) {
      const res = await mail(siteId, email, deps);
      assert.deepEqual([res.status, res.body.code], [409, 'suppressed'], `${siteId} ${email}`);
    }
    const fine = await mail('site_a', 'fresh@example.com', deps);
    assert.equal(fine.status, 200, JSON.stringify(fine.body));
    const before = fileState();
    const second = await unsub.rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, now: clock, settings: deps.settings, env: { HUB_SAFE_MODE: '1' } });
    assert.deepEqual([second.ok, second.written, second.mode, second.changed], [true, false, 'merge', 0], 'a readable record is merged into, and nothing new means no write');
    assert.equal(fileState(), before);
  } finally {
    cmsA.srv.close();
    cmsB.srv.close();
  }
});

test('a rebuild never removes rows: forced on a readable record it keeps the Asoldi and global rows and only adds or strengthens', async () => {
  const before = store.readEmailSuppressions();
  assert.ok(before.asoldi && before['*']);
  const cms = await fakeCms('site_a', [
    { email: 'ola@example.com', scope: 'none', source: 'cms-mirror', at: new Date(NOW + 9000).toISOString() },
    { email: 'per@example.com', scope: 'all', source: 'complaint', at: new Date(NOW + 9000).toISOString() },
  ]);
  try {
    const settings = store.deepMerge(store.readEmailSettings(), { devCmsTargets: { site_a: cms.origin, site_b: 'http://127.0.0.1:9' } });
    const partial = await unsub.rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, now: clock, settings, env: { HUB_SAFE_MODE: '1' } });
    assert.deepEqual([partial.ok, partial.written, partial.failed.map((f) => f.siteId)], [false, false, ['site_b']], 'a mirror that did not answer: nothing written');
    const forced = await unsub.rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, now: clock, settings, env: { HUB_SAFE_MODE: '1' }, force: true });
    assert.deepEqual([forced.ok, forced.written, forced.mode, forced.changed], [true, true, 'merge', 1]);
    const after = store.readEmailSuppressions();
    assert.deepEqual(after.asoldi, before.asoldi);
    assert.deepEqual(Object.keys(after['*']).sort(), Object.keys(before['*']).sort());
    for (const id of ['site_a', 'site_b']) for (const email of Object.keys(before[id])) assert.ok(after[id][email], `${id} ${email} kept`);
    assert.equal(after.site_a['ola@example.com'].scope, 'marketing', 'a mirrored "none" never weakens an opt-out');
    assert.equal(after.site_a['per@example.com'].scope, 'all', 'a stronger mirrored row strengthens');
  } finally {
    cms.srv.close();
  }
});

test('a lost record with no dated snapshot is only rebuilt on a supplied base; with no site to pull it stays lost', async () => {
  const saved = store.readEmailSuppressions();
  loseRecord({ snapshots: false });
  const none = await unsub.rebuildSuppressionsFromCms({ getAllSites: () => [], now: clock, env: { HUB_SAFE_MODE: '1' } });
  assert.deepEqual([none.ok, none.written, none.reason], [false, false, 'no_sites']);
  const noBase = await unsub.rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, now: clock, fetchImpl, env: { HUB_SAFE_MODE: '1' }, force: true });
  assert.deepEqual([noBase.ok, noBase.written, noBase.reason], [false, false, 'no_base']);
  assert.equal(unsub.suppressionsAvailable(), false, 'still unavailable: marketing stays blocked');
  assert.equal(isAsoldiMarketingSuppressed('anyone@example.com'), true, 'Asoldi marketing stays blocked too');
  const notAsoldi = await unsub.rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, now: clock, fetchImpl, env: { HUB_SAFE_MODE: '1' }, force: true, base: { site_a: {} } });
  assert.equal(notAsoldi.reason, 'no_base', 'a supplied base must state the Asoldi opt-outs');
  const refused = await fetch(`${base}/api/admin/email/suppressions/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer admin' }, body: JSON.stringify({ force: true }) });
  assert.deepEqual([refused.status, (await refused.json()).reason], [409, 'no_base']);

  // The mirrors answer through the stub CMS of this suite (empty lists); the supplied base carries the rest.
  const route = await fetch(`${base}/api/admin/email/suppressions/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer admin' }, body: JSON.stringify({ base: saved }) });
  assert.equal(route.status, 200);
  const answer = await route.json();
  assert.deepEqual([answer.written, answer.mode, answer.base, answer.sites], [true, 'lost', 'supplied', 2]);
  const rebuilt = store.readEmailSuppressions();
  assert.deepEqual(rebuilt.asoldi, saved.asoldi);
  assert.deepEqual(rebuilt['*'], saved['*']);
  assert.equal(rebuilt.site_a['ola@example.com'].scope, 'marketing');
});

test('an opt-out taken while the record was lost counts at once and is merged when the record comes back from a snapshot', async () => {
  const snapshot = join(dataDir, 'snapshot-copy.json');
  writeFileSync(snapshot, readFileSync(suppressionsFile(), 'utf8'));
  loseRecord({ snapshots: false });
  const deps = relayDeps();
  const t = unsub.mintUnsubToken({ siteId: 'site_a', email: 'while-lost@example.com', kind: 'welcome' });
  assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'List-Unsubscribe=One-Click' })).status, 200);
  copyFileSync(snapshot, suppressionsFile());
  assert.equal(unsub.suppressionsAvailable(), true);
  assert.equal(store.readEmailSuppressions().site_a['while-lost@example.com'], undefined, 'the restored file does not have it');
  assert.equal(unsub.isSuppressed('site_a', 'while-lost@example.com', 'campaign'), true, 'the pending row counts before it is merged');
  const res = await mail('site_a', 'while-lost@example.com', deps);
  assert.deepEqual([res.status, res.body.code], [409, 'suppressed']);
  assert.equal(store.readEmailSuppressions().site_a['while-lost@example.com'].source, 'one-click', 'the relay merged it into the record');
  assert.equal(existsSync(join(dataDir, unsub.PENDING_FILE)), false);
  assert.ok(readdirSync(dataDir).some((name) => name.startsWith(`${unsub.PENDING_FILE}.applied-`)));
});

test('a repeated opt-out changes nothing: one write, one Brevo call, one hint, and the first time is kept', async () => {
  await store.saveEmailSettings({ brevo: { syncContacts: true } });
  hints.length = 0;
  brevoCalls.length = 0;
  const t = unsub.mintUnsubToken({ siteId: 'site_a', email: 'twice@example.com', kind: 'welcome' });
  clock = NOW + 60_000;
  assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'List-Unsubscribe=One-Click' })).status, 200);
  const first = fileState();
  const snapshots = datedSnapshots().length;
  clock = NOW + 120_000;
  for (let i = 0; i < 3; i += 1) assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'List-Unsubscribe=One-Click' })).status, 200);
  assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'confirm=1' })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fileState(), first, 'no write');
  assert.equal(datedSnapshots().length, snapshots, 'no new snapshot');
  assert.equal(brevoCalls.length, 1);
  assert.equal(hints.length, 1);
  assert.equal(store.readEmailSuppressions().site_a['twice@example.com'].at, new Date(NOW + 60_000).toISOString());
  assert.deepEqual(await unsub.addSuppression({ siteId: 'site_a', email: 'twice@example.com', now: NOW + 180_000 }), { recorded: 'already' });
  clock = NOW;
  await store.saveEmailSettings({ brevo: { syncContacts: false } });
});

test('a stronger row is never weakened by a later link click, and only a link opt-out can be undone', async () => {
  await unsub.addSuppression({ siteId: 'site_b', email: 'klage@example.com', scope: 'all', source: 'complaint', now: NOW });
  assert.equal(unsub.isSuppressed('site_b', 'klage@example.com', 'test'), true);
  const t = unsub.mintUnsubToken({ siteId: 'site_b', email: 'klage@example.com', kind: 'welcome' });
  assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'confirm=1' })).status, 200);
  const row = store.readEmailSuppressions().site_b['klage@example.com'];
  assert.deepEqual([row.scope, row.source], ['all', 'complaint']);
  assert.equal(unsub.isSuppressed('site_b', 'klage@example.com', 'test'), true);
  assert.equal((await page('POST', `/api/hub/email/resubscribe?t=${t}`, { body: 'from=page' })).status, 409);
  assert.equal(unsub.isSuppressed('site_b', 'klage@example.com', 'campaign'), true);
  const linkFirst = 'opp@example.com';
  await unsub.addSuppression({ siteId: 'site_b', email: linkFirst, source: 'unsubscribe-link', now: NOW });
  await unsub.addSuppression({ siteId: 'site_b', email: linkFirst, scope: 'all', source: 'complaint', now: NOW + 1000 });
  assert.equal(store.readEmailSuppressions().site_b[linkFirst].scope, 'all', 'a link opt-out is strengthened by a complaint');
  assert.equal((await unsub.resubscribe({ site: { id: 'site_b' }, email: linkFirst, now: NOW + 2000 })).ok, false);
  await assert.rejects(() => unsub.addSuppression({ siteId: 'asoldi', email: 'x@example.com' }), /not a site id/);
});

test('public routes answer 404 while email is disabled', async () => {
  rmSync(join(dataDir, unsub.RELAY_SENT_FILE), { force: true }); // as if Brevo never accepted a relay send
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

test('one-click as multipart form data is recorded too', async () => {
  const t = unsub.mintUnsubToken({ siteId: 'site_b', email: 'multipart@example.com', kind: 'welcome' });
  const form = new FormData();
  form.append('List-Unsubscribe', 'One-Click');
  const res = await fetch(`${base}/api/hub/email/unsubscribe?t=${t}`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'unsubscribed');
  assert.equal(store.readEmailSuppressions().site_b['multipart@example.com'].source, 'one-click');
});

test('after Brevo accepted relay mail, unsubscribe links keep working when the platform is switched off again; another log line does not count', async () => {
  rmSync(join(dataDir, unsub.RELAY_SENT_FILE), { force: true });
  await store.saveEmailSettings({ enabled: false });
  const t = unsub.mintUnsubToken({ siteId: 'site_a', email: 'later@example.com', kind: 'welcome' });
  assert.equal((await page('GET', `/api/hub/email/unsubscribe?t=${t}`)).status, 404, 'never sent: still dark');
  mkdirSync(join(dataDir, 'email-log'), { recursive: true });
  writeFileSync(join(dataDir, 'email-log', 'messages-202611.jsonl'), '{"id":"em_x","siteId":"site_a","kind":"welcome","status":"accepted"}\n');
  assert.equal((await page('GET', `/api/hub/email/unsubscribe?t=${t}`)).status, 404, 'a message log alone does not open the pages');
  unsub.noteRelaySent(NOW);
  assert.equal((await page('GET', `/api/hub/email/unsubscribe?t=${t}`)).status, 200);
  assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'List-Unsubscribe=One-Click' })).status, 200);
  assert.equal(unsub.isSuppressed('site_a', 'later@example.com', 'welcome'), true);
  assert.equal((await fetch(`${base}/api/hub/email/provision-request`, { method: 'POST' })).status, 404, 'other email routes stay closed');
  await store.saveEmailSettings({ enabled: true });
});

test('the public POST routes are limited per token and per client address', async () => {
  const t = unsub.mintUnsubToken({ siteId: 'site_a', email: 'many@example.com', kind: 'welcome' });
  const statuses = [];
  for (let i = 0; i < 11; i += 1) statuses.push((await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'List-Unsubscribe=One-Click' })).status);
  assert.deepEqual(statuses, [...Array(10).fill(200), 429]);
  const limited = await page('POST', `/api/hub/email/unsubscribe?t=${t}`, { body: 'List-Unsubscribe=One-Click' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const other = unsub.mintUnsubToken({ siteId: 'site_a', email: 'other@example.com', kind: 'welcome' });
  assert.equal((await page('POST', `/api/hub/email/unsubscribe?t=${other}`, { body: 'List-Unsubscribe=One-Click' })).status, 200, 'another token is not limited');
  let at = 0;
  const limiter = createPublicPostLimiter({ perToken: 2, perAddress: 3, windowMs: 1000, now: () => at });
  const req = { socket: { remoteAddress: '203.0.113.7' }, headers: {} };
  assert.deepEqual([limiter.check(req, 'a'), limiter.check(req, 'a'), limiter.check(req, 'a') > 0], [0, 0, true], 'per token');
  assert.ok(limiter.check(req, 'b') > 0, 'per address');
  at = 1001;
  assert.equal(limiter.check(req, 'a'), 0, 'the window slides');
});
