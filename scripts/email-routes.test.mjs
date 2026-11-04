// The client CMS → hub email API (lib/routes/email-site-routes.js) and the site-config email block
// (lib/email-site-config.js, data/hub.js getSiteConfig):
//  - off (the default): every route answers 404 disabled and site-config is unchanged;
//  - every site route needs the emailKey: the site key alone, or with the site credential, gets 401;
//  - 120 requests a minute per site, then 429;
//  - send, contacts, erasure, quota, suppressions, stats, lint and owner recipients for the calling
//    site only; the routes whose platform part is not built yet answer 501;
//  - the email block appears only for a site whose email is on, and is the only field that changes;
//  - the Brevo webhook route and the signed wake of a CMS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-routes-'));
process.env.APP_DATA_DIR = dataDir;
// A placeholder so Brevo counts as configured; every Brevo call in this file goes to a stub.
process.env.BREVO_API_KEY = 'placeholder-brevo-key-for-route-tests';

const T0 = Date.parse('2026-11-04T09:00:00Z');
let clock = T0;
const SITES = [
  { id: 'site_shop', site_key: 'pk-shop-0001', domain: 'shop.example.com', name: 'Eksempelbutikken', websitePlan: 'tier-3-ecommerce', features: { emailMarketing: true, ecommerce: true }, clientAdmin: { email: 'eier@example.com' } },
  { id: 'site_plain', site_key: 'pk-plain-0002', domain: 'plain.example.com', name: 'Plain', websitePlan: 'tier-2-standard', features: { emailMarketing: true } },
  { id: 'site_basic', site_key: 'pk-basic-0003', domain: 'basic.example.com', name: 'Basic', websitePlan: 'tier-1-standard', features: {} },
  { id: 'site_out', site_key: 'pk-out-0004', domain: 'out.example.com', name: 'Utenfor', websitePlan: 'tier-3-ecommerce', features: { emailMarketing: true, ecommerce: true } },
];
writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(SITES, null, 2));

const store = await import('../data/email-store.js');
const auth = await import('../lib/email-site-auth.js');
const unsub = await import('../lib/email-unsubscribe.js');
const hubData = await import('../data/hub.js');
const { PUBLIC_SITE_CONFIG_FIELDS } = await import('../lib/cms-entitlements.js');
const { siteCredentialStore } = await import('../lib/site-credentials.js');
const { registerEmailHubRoutes } = await import('../lib/routes/email-hub-routes.js');
const siteRoutes = await import('../lib/routes/email-site-routes.js');
const { createEmailLog } = await import('../lib/email-log.js');
const { createEmailQuota, memoryLedgerStore } = await import('../lib/email-quota.js');

const hub = {
  getSiteByKey: (key) => SITES.find((s) => s.site_key === key) || null,
  getSiteById: (id) => SITES.find((s) => s.id === id) || null,
  getAllSites: () => SITES,
};
const CREDENTIAL = randomBytes(32).toString('base64url');
siteCredentialStore().enroll('site_shop', CREDENTIAL, { proofDomain: 'shop.example.com', proofOrigin: 'https://shop.example.com' });
const adminToken = 'admin-route-token';
const adminAuth = (req, res, next) => (req.get('authorization') === `Bearer ${adminToken}` ? next() : res.status(401).json({ message: 'Unauthorized' }));
const admin = { authorization: `Bearer ${adminToken}` };

function brevoStub() {
  const calls = [];
  const rec = (name, value) => async (...args) => {
    calls.push([name, ...args]);
    return typeof value === 'function' ? value(...args) : value;
  };
  return {
    calls,
    brevoConfigured: () => true,
    sendBrevoEmail: async (payload) => {
      calls.push(['sendBrevoEmail', payload]);
      return { providerMessageId: `<m${calls.length}@smtp.example.com>`, mode: 'brevo' };
    },
    ensureSiteList: rec('ensureSiteList', 57),
    upsertContacts: rec('upsertContacts', (_id, emails) => ({ ok: true, count: emails.length })),
    removeFromList: rec('removeFromList', (_id, emails) => ({ ok: true, count: emails.length })),
    deleteSmtpLog: rec('deleteSmtpLog', { ok: true }),
    // A contact on another site's list (list 99) is shared and must stay.
    getContact: rec('getContact', (email) => ({ email, listIds: email.startsWith('shared') ? [99] : [] })),
    deleteContact: rec('deleteContact', { ok: true }),
  };
}

const brevo = brevoStub();
const relayLog = createEmailLog({ flushMs: 0, dir: mkdtempSync(join(tmpdir(), 'asoldi-email-routes-log-')) });
const quota = createEmailQuota({ store: memoryLedgerStore(), settings: () => store.readEmailSettings() });
const KEYS = {};
let base = '';
let server;
let handle;

function siteHeaders(siteId, extra = {}) {
  const site = hub.getSiteById(siteId);
  return { 'x-site-key': site.site_key, 'x-email-key': KEYS[siteId], ...extra };
}

async function call(method, path, headers = {}, body = undefined) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, data, headers: res.headers };
}

function samplePath(route) {
  return route.split(' ')[1].replace(/:[A-Za-z_]+/g, 'hc_1');
}

/** Every site-config answer (by key and by domain) as text, the way the route sends it. */
function siteConfigs() {
  const out = {};
  for (const site of SITES) {
    out[`key ${site.id}`] = JSON.stringify(hubData.getSiteConfig(site.site_key, false));
    out[`domain ${site.id}`] = JSON.stringify(hubData.getSiteConfig(site.domain, true));
    out[`trusted ${site.id}`] = JSON.stringify(hubData.getSiteConfig(site.site_key, false, { includeAdmin: true }));
  }
  return out;
}

function emailFiles() {
  return readdirSync(dataDir).filter((name) => name.startsWith('email-') || name === 'secrets').sort();
}

let darkConfigs;
let darkFiles;
test.before(async () => {
  darkConfigs = siteConfigs();
  darkFiles = emailFiles();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  registerEmailHubRoutes(app, { adminAuth, hub }, { now: () => clock, env: { HUB_SAFE_MODE: '0' }, startJobs: false });
  handle = siteRoutes.registerEmailSiteRoutes(app, { adminAuth, hub, sales: { getSalesClients: () => [] } }, {
    now: () => clock,
    env: { HUB_SAFE_MODE: '1', BREVO_API_KEY: 'placeholder' },
    startJobs: false,
    relayDeps: { brevo, log: relayLog, quota },
    brevo,
  });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  handle?.stop();
  relayLog.stop?.();
  server?.closeAllConnections?.();
  server?.close();
});

test('off (the default): every route answers 404 disabled, site-config has no email block and nothing is written', async () => {
  for (const route of [...siteRoutes.EMAIL_SITE_ROUTES, ...siteRoutes.EMAIL_WEBHOOK_ROUTES]) {
    const [method] = route.split(' ');
    const res = await call(method, samplePath(route), {}, method === 'GET' ? undefined : {});
    assert.equal(res.status, 404, route);
    assert.equal(res.data.code, 'disabled', route);
  }
  const wake = await call('POST', '/api/admin/email/sites/site_shop/wake', admin, {});
  assert.equal(wake.status, 404);
  assert.equal(wake.data.code, 'disabled');
  const anonymous = await call('POST', '/api/admin/email/sites/site_shop/wake', {}, {});
  assert.deepEqual([anonymous.status, anonymous.data.code], [404, 'disabled'], 'off, the wake route looks absent even without a sign-in');
  for (const [name, text] of Object.entries(siteConfigs())) {
    assert.equal(text, darkConfigs[name], `${name} is unchanged`);
    assert.equal(Object.hasOwn(JSON.parse(text), 'email'), false, name);
  }
  assert.deepEqual(emailFiles(), darkFiles, 'no email file or secret is written while email is off');
  assert.equal(darkFiles.some((name) => name.startsWith('email-')), false);
});

test('setup: email on for three sites, keys confirmed, the DPA accepted for the shop', async () => {
  await store.saveEmailSettings({
    enabled: true,
    rollout: { mode: 'allowlist', siteIds: ['site_shop', 'site_plain', 'site_basic'] },
    testRecipients: ['test-recipient@example.com'],
    brevo: { planTier: 'starter', termsConfirmedAt: '2026-11-01T10:00:00.000Z' },
  });
  for (const id of ['site_shop', 'site_plain', 'site_basic']) {
    await auth.issuePending(id, { now: clock });
    const pending = store.readEmailSiteKeys()[id].pending.key;
    await auth.confirmProvision(pending, { now: clock });
    KEYS[id] = pending;
  }
  await store.patchEmailSite('site_shop', { dpa: { acceptedAt: '2026-10-01T00:00:00.000Z', version: 'v1' }, ownerRecipients: [{ email: 'eier@example.com', status: 'confirmed', source: 'superadmin' }] });
});

test('the site key alone, with the site credential, or a wrong or foreign emailKey gets 401 on every site route', async () => {
  const bad = [
    ['the site key alone', { 'x-site-key': 'pk-shop-0001' }],
    ['the site key and its credential', { 'x-site-key': 'pk-shop-0001', 'x-site-credential': CREDENTIAL }],
    ['a wrong emailKey', { 'x-site-key': 'pk-shop-0001', 'x-email-key': 'A'.repeat(43) }],
    ['another site\'s emailKey under this site key', { 'x-site-key': 'pk-shop-0001', 'x-email-key': KEYS.site_plain }],
    ['the site credential as emailKey', { 'x-email-key': CREDENTIAL }],
  ];
  for (const route of siteRoutes.EMAIL_SITE_ROUTES) {
    const [method] = route.split(' ');
    for (const [label, headers] of bad) {
      const res = await call(method, samplePath(route), headers, method === 'GET' ? undefined : { email: 'x@example.com' });
      assert.equal(res.status, 401, `${route}: ${label}`);
      assert.equal(res.data.code, 'unauthorized', `${route}: ${label}`);
    }
  }
  const provision = await call('POST', '/api/hub/email/provision-request', { 'x-site-key': 'pk-shop-0001' }, {});
  assert.equal(provision.status, 200);
  assert.deepEqual(provision.data, { ok: true }, 'provision-request with the site key alone only answers ok');
});

test('120 requests a minute per site, then 429 with Retry-After; another site keeps its own allowance', async () => {
  clock = T0 + 10 * 60_000;
  for (let i = 0; i < siteRoutes.SITE_BURST_PER_MINUTE; i += 1) {
    const res = await call('GET', '/api/hub/email/owner-recipients', siteHeaders('site_basic'));
    assert.equal(res.status, 200, `request ${i + 1}`);
  }
  const over = await call('GET', '/api/hub/email/owner-recipients', siteHeaders('site_basic'));
  assert.equal(over.status, 429);
  assert.equal(over.data.code, 'rate_limited');
  assert.ok(Number(over.headers.get('retry-after')) >= 1);
  assert.equal((await call('GET', '/api/hub/email/owner-recipients', siteHeaders('site_plain'))).status, 200);
  clock += 61_000;
  assert.equal((await call('GET', '/api/hub/email/owner-recipients', siteHeaders('site_basic'))).status, 200, 'the window moves on');
});

test('POST /api/hub/email/send relays one message: a test send reaches Brevo once; without the DPA a marketing kind is refused', async () => {
  clock = T0 + 20 * 60_000;
  const before = brevo.calls.filter((c) => c[0] === 'sendBrevoEmail').length;
  const ok = await call('POST', '/api/hub/email/send', siteHeaders('site_shop'), {
    kind: 'test',
    to: { email: 'test-recipient@example.com' },
    subject: '[TEST] Handlekurv',
    html: '<p>Hei</p><a href="https://shop.example.com/kasse">Til kassen</a> <a href="{{unsubscribeUrl}}">Meld deg av</a>',
    text: 'Hei {{unsubscribeUrl}}',
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.ok, true);
  const sends = brevo.calls.filter((c) => c[0] === 'sendBrevoEmail');
  assert.equal(sends.length, before + 1);
  assert.equal(sends.at(-1)[1].to[0].email, 'test-recipient@example.com');
  assert.match(sends.at(-1)[1].headers['List-Unsubscribe'], /^<https:\/\/[^>]+\/api\/hub\/email\/unsubscribe\?t=/);
  const noDpa = await call('POST', '/api/hub/email/send', siteHeaders('site_plain'), {
    kind: 'welcome', ref: 'lead_1', to: { email: 'kunde@example.com' }, subject: 'Velkommen', text: 'Hei {{unsubscribeUrl}}',
    consent: { basis: 'explicit', grade: 'form-label' },
    sender: { legalName: 'Plain AS', orgNumber: '999 999 999', address: 'Gate 1, 0000 Oslo', email: 'post@plain.example.com' },
  });
  assert.equal(noDpa.status, 403);
  assert.equal(noDpa.data.code, 'dpa_missing');
});

test('POST /api/hub/email/contacts is a no-op while contact sync is off; with sync on it calls the site list', async () => {
  const off = await call('POST', '/api/hub/email/contacts', siteHeaders('site_shop'), { upsert: [{ email: 'a@example.com' }], remove: ['b@example.com'] });
  assert.deepEqual(off.data, { ok: true, synced: 0, removed: 0, sync: false });
  assert.equal(brevo.calls.filter((c) => c[0] === 'upsertContacts').length, 0);
  await store.saveEmailSettings({ brevo: { syncContacts: true } });
  const on = await call('POST', '/api/hub/email/contacts', siteHeaders('site_shop'), { upsert: [{ email: 'a@example.com' }, 'A@example.com', 'not-an-address'], remove: ['b@example.com'] });
  assert.deepEqual(on.data, { ok: true, synced: 1, removed: 1, sync: true });
  const tooMany = await call('POST', '/api/hub/email/contacts', siteHeaders('site_shop'), { upsert: Array.from({ length: 501 }, (_, i) => `u${i}@example.com`) });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.data.code, 'too_many');
  await store.saveEmailSettings({ brevo: { syncContacts: false } });
});

test('DELETE /api/hub/email/contacts erases the address for the site: the listing drops it, the opt-out still holds, Brevo is cleaned', async () => {
  await unsub.addSuppression({ siteId: 'site_shop', email: 'slett-meg@example.com', source: 'unsubscribe-link', now: clock });
  assert.ok(unsub.listSuppressions('site_shop').items.some((row) => row.email === 'slett-meg@example.com'));
  const res = await call('DELETE', '/api/hub/email/contacts', siteHeaders('site_shop'), { email: 'Slett-Meg@example.com' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.erased, true);
  assert.deepEqual(res.data.provider, { list: false, log: true, contact: true });
  const record = store.readEmailSuppressions();
  assert.equal(Object.hasOwn(record.site_shop, 'slett-meg@example.com'), false, 'the address is no longer a key');
  assert.ok(record.site_shop[unsub.tombstoneKey('slett-meg@example.com')], 'its tombstone is');
  assert.equal(JSON.stringify(record).includes('slett-meg'), false, 'the address is nowhere in the record');
  assert.equal(unsub.listSuppressions('site_shop').items.some((row) => row.email.includes('slett-meg') || row.email.startsWith('sha256:')), false);
  assert.equal(unsub.isSuppressed('site_shop', 'slett-meg@example.com', 'welcome'), true, 'the opt-out still blocks marketing');
  await unsub.addSuppression({ siteId: 'site_shop', email: 'slett-meg@example.com', scope: 'all', source: 'admin', now: clock + 1000 });
  assert.equal(JSON.stringify(store.readEmailSuppressions()).includes('slett-meg'), false, 'a later opt-out merges into the tombstone');
  assert.equal(unsub.isSuppressed('site_shop', 'slett-meg@example.com', 'test'), true);
  const again = await call('DELETE', '/api/hub/email/contacts', siteHeaders('site_shop'), { email: 'slett-meg@example.com' });
  assert.equal(again.data.erased, false);
  await unsub.addSuppression({ siteId: 'site_shop', email: 'shared@example.com', now: clock });
  const shared = await call('DELETE', '/api/hub/email/contacts', siteHeaders('site_shop'), { email: 'shared@example.com' });
  assert.deepEqual(shared.data.provider, { list: false, log: true, contact: false }, 'a contact on another site list is kept');
  assert.equal((await call('DELETE', '/api/hub/email/contacts', siteHeaders('site_shop'), { email: 'nope' })).status, 400);
});

test('quota, suppressions, stats, lint and owner recipients answer for the calling site only', async () => {
  await unsub.addSuppression({ siteId: 'site_plain', email: 'other-site@example.com', now: clock });
  const quotaView = await call('GET', '/api/hub/email/quota', siteHeaders('site_shop'));
  assert.equal(quotaView.status, 200);
  assert.ok(quotaView.data.site && quotaView.data.pool && quotaView.data.nextResetAt);
  assert.deepEqual(quotaView.data.campaigns, { allowed: true, reason: '' });
  assert.equal(quotaView.data.paused, false);
  assert.equal(JSON.stringify(quotaView.data).includes('site_plain'), false, 'nothing about other sites');
  const rows = await call('GET', '/api/hub/email/suppressions', siteHeaders('site_shop'));
  assert.equal(rows.status, 200);
  assert.equal(rows.data.items.some((row) => row.email === 'other-site@example.com'), false);
  const since = await call('GET', `/api/hub/email/suppressions?since=${encodeURIComponent('2099-01-01T00:00:00.000Z')}`, siteHeaders('site_plain'));
  assert.deepEqual(since.data, { items: [], next: null });
  const stats = await call('GET', '/api/hub/email/stats?kind=test', siteHeaders('site_shop'));
  assert.equal(stats.status, 200);
  assert.equal(stats.data.totals.sent, 1, 'the one test send above');
  const otherStats = await call('GET', '/api/hub/email/stats?refs=a,b', siteHeaders('site_plain'));
  assert.equal(otherStats.data.totals.sent, 0);
  const lint = await call('POST', '/api/hub/email/lint', siteHeaders('site_shop'), { subject: 'x', kind: 'campaign', html: '<a href="https://shop.example.com/a">a</a><a href="https://unlisted.example/">b</a>' });
  assert.equal(lint.status, 200);
  assert.equal(lint.data.claimsChecked, false);
  assert.deepEqual(lint.data.links.map((l) => [l.href, l.ok]), [['https://shop.example.com/a', true], ['https://unlisted.example/', false]]);
  const owners = await call('GET', '/api/hub/email/owner-recipients', siteHeaders('site_shop'));
  assert.deepEqual(owners.data, [{ email: 'eier@example.com', status: 'confirmed' }]);
  assert.deepEqual((await call('GET', '/api/hub/email/owner-recipients', siteHeaders('site_plain'))).data, []);
});

test('the campaign, owner-recipient change and owner-notify routes answer 501 not_available', async () => {
  for (const route of ['POST /api/hub/email/campaigns', 'POST /api/hub/email/campaigns/:id/recipients', 'POST /api/hub/email/campaigns/:id/start', 'POST /api/hub/email/campaigns/:id/cancel', 'GET /api/hub/email/campaigns/:id', 'PUT /api/hub/email/owner-recipients', 'POST /api/hub/email/owner-notify']) {
    const [method] = route.split(' ');
    const res = await call(method, samplePath(route), siteHeaders('site_shop'), method === 'GET' ? undefined : {});
    assert.equal(res.status, 501, route);
    assert.equal(res.data.code, 'not_available', route);
  }
});

test('site-config: the email block appears only for a site whose email is on, and is the only field that changes', async () => {
  const configs = siteConfigs();
  for (const [name, text] of Object.entries(configs)) {
    const { email, ...rest } = JSON.parse(text);
    assert.deepEqual(rest, JSON.parse(darkConfigs[name]), `${name}: every other field is as before`);
    if (name.endsWith('site_out')) assert.equal(email, undefined, `${name}: not in the rollout, no block`);
    else assert.ok(email, `${name}: in the rollout`);
  }
  const shop = JSON.parse(configs['key site_shop']).email;
  assert.deepEqual(shop, {
    api: 1,
    enabled: true,
    provisioned: true,
    kinds: ['cart-recovery', 'welcome', 'double-opt-in', 'back-in-stock', 'review-request', 'winback', 'campaign', 'test'],
    campaigns: { allowed: true, reason: '' },
    sender: { mode: 'asoldi', fromName: 'Eksempelbutikken', fromAddress: 'kunder@asoldi.com' },
    suspended: false,
    paused: false,
  });
  const plain = JSON.parse(configs['key site_plain']).email;
  assert.equal(plain.enabled, false);
  assert.equal(plain.reason, 'dpa_missing');
  assert.deepEqual(plain.kinds, ['welcome', 'double-opt-in', 'campaign', 'test']);
  const basic = JSON.parse(configs['key site_basic']).email;
  assert.equal(basic.enabled, false);
  assert.deepEqual(basic.kinds, [], 'a site without email marketing gets no kinds');
  assert.deepEqual(basic.campaigns, { allowed: false, reason: 'not_entitled' });
  const byDomain = JSON.parse(configs['domain site_shop']);
  assert.deepEqual(Object.keys(byDomain).filter((key) => !PUBLIC_SITE_CONFIG_FIELDS.includes(key)), []);
  assert.deepEqual(byDomain.email, shop);
  assert.doesNotMatch(JSON.stringify(configs), new RegExp(Object.values(KEYS).join('|')), 'no key in any answer');

  await store.saveEmailSettings({ brevo: { planTier: 'free' } });
  assert.deepEqual(hubData.getSiteConfig('pk-shop-0001').email.campaigns, { allowed: false, reason: 'free_plan' });
  assert.equal(hubData.getSiteConfig('pk-shop-0001').email.kinds.includes('campaign'), false);
  await store.saveEmailSettings({ brevo: { planTier: 'starter', termsConfirmedAt: '' } });
  assert.deepEqual(hubData.getSiteConfig('pk-shop-0001').email.campaigns, { allowed: false, reason: 'terms_unconfirmed' });
  await store.saveEmailSettings({ brevo: { termsConfirmedAt: '2026-11-01T10:00:00.000Z' }, killSwitch: true });
  assert.equal(hubData.getSiteConfig('pk-shop-0001').email.paused, true);
  await store.saveEmailSettings({ killSwitch: false });
  const prior = process.env.BREVO_API_KEY;
  delete process.env.BREVO_API_KEY;
  try {
    assert.equal(hubData.getSiteConfig('pk-shop-0001').email.reason, 'not_configured');
  } finally {
    process.env.BREVO_API_KEY = prior;
  }

  await store.saveEmailSettings({ rollout: { mode: 'allowlist', siteIds: ['site_shop', 'site_plain', 'site_basic'] }, enabled: false });
  for (const [name, text] of Object.entries(siteConfigs())) assert.equal(text, darkConfigs[name], `${name}: switched off again, the answer is as before`);
  await store.saveEmailSettings({ enabled: true });
});

test('a pending key is not provisioned: the block says provisioned false until the confirm', async () => {
  await auth.rotateSiteKey('site_plain', { now: clock });
  assert.equal(hubData.getSiteConfig('pk-plain-0002').email.provisioned, true, 'the current key stays until the confirm');
  const fresh = { id: 'site_new', site_key: 'pk-new-0005', domain: 'new.example.com', name: 'Ny', features: { emailMarketing: true } };
  const { emailConfigForSite } = await import('../lib/email-site-config.js');
  await store.saveEmailSettings({ rollout: { mode: 'allowlist', siteIds: ['site_shop', 'site_plain', 'site_basic', 'site_new'] } });
  assert.equal(emailConfigForSite(fresh).provisioned, false);
  await store.saveEmailSettings({ rollout: { mode: 'allowlist', siteIds: ['site_shop', 'site_plain', 'site_basic'] } });
});

test('email settings that exist but cannot be read: a site the last good read switched on holds its mail (paused, unavailable); others get no block', async () => {
  const { emailConfigForSite } = await import('../lib/email-site-config.js');
  const shop = hub.getSiteById('site_shop');
  const outside = hub.getSiteById('site_out');
  assert.equal(emailConfigForSite(shop).paused, false, 'a good read');
  const files = [join(dataDir, 'email-settings.json'), join(dataDir, 'backups', 'email-settings.json.latest.json')].filter((f) => existsSync(f));
  const saved = files.map((f) => [f, readFileSync(f, 'utf8')]);
  try {
    for (const f of files) writeFileSync(f, '{ "enabled": tr');
    assert.throws(() => store.readEmailSettings({ strict: true }), 'the strict read sees the damage');
    assert.equal(store.readEmailSettings().enabled, false, 'the lenient read still gives the defaults');
    const block = emailConfigForSite(shop);
    assert.deepEqual([block.enabled, block.paused, block.reason, block.provisioned, block.kinds], [false, true, 'unavailable', false, []]);
    assert.equal(JSON.stringify(block).includes(KEYS.site_shop), false);
    assert.equal(hubData.getSiteConfig(shop.site_key, false).email.reason, 'unavailable', 'site-config carries it, so the CMS holds its mail');
    assert.equal(emailConfigForSite(outside), null, 'a site the last good read did not switch on gets no block');
  } finally {
    for (const [f, text] of saved) writeFileSync(f, text);
  }
  assert.equal(emailConfigForSite(shop).paused, false, 'back to normal once the file reads again');
});

test('POST /api/hub/email/brevo-webhook/:token: an unknown token gets 404, the hub token with its header 503 not_ready', async () => {
  const token = store.readEmailSecrets().webhookToken;
  assert.equal((await call('POST', '/api/hub/email/brevo-webhook/not-the-token', { 'x-asoldi-webhook': 'not-the-token' }, {})).status, 404);
  assert.equal((await call('POST', `/api/hub/email/brevo-webhook/${token}`, {}, {})).status, 404, 'the header is needed too');
  const ok = await call('POST', `/api/hub/email/brevo-webhook/${token}`, { 'x-asoldi-webhook': token }, { event: 'delivered' });
  assert.equal(ok.status, 503);
  assert.equal(ok.data.code, 'not_ready');
});

test('the wake: a signed tick goes to the local CMS target, sites without a confirmed key or outside the rollout are skipped', async () => {
  const received = [];
  const cms = express();
  cms.use(express.text({ type: '*/*' }));
  cms.post('/api/cms/email/tick', (req, res) => {
    received.push({ headers: req.headers, body: req.body });
    res.json({ ran: true, dueSteps: 2 });
  });
  const cmsServer = await new Promise((resolve) => {
    const s = cms.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const target = `http://127.0.0.1:${cmsServer.address().port}`;
    await store.saveEmailSettings({ devCmsTargets: { site_shop: target, site_plain: target, site_basic: target, site_out: target } });
    clock = Date.now();
    const result = await handle.wake();
    assert.equal(result.ran, true);
    // site_plain has a pending rotation; its current key still signs the wake.
    assert.deepEqual(result.results.map((r) => r.siteId).sort(), ['site_basic', 'site_plain', 'site_shop']);
    const shop = result.results.find((r) => r.siteId === 'site_shop');
    assert.equal(shop.ok, true);
    assert.deepEqual(shop.answer, { ran: true, dueSteps: 2 });
    assert.equal(received.length, 3, 'site_out is not in the rollout');
    for (const call of received) {
      const body = JSON.parse(call.body);
      assert.equal(body.type, 'wake');
      const key = KEYS[body.siteId];
      assert.ok(auth.verifyEmailSignature({ header: call.headers['x-asoldi-signature'], body: call.body, method: 'POST', path: '/api/cms/email/tick', key, now: clock }), `${body.siteId}: signed with its emailKey over the method and path`);
      assert.equal(auth.verifyEmailSignature({ header: call.headers['x-asoldi-signature'], body: call.body, method: 'POST', path: '/api/cms/email/hub-event', key, now: clock }), false, 'the wake signature opens no other path');
      const [, t] = call.headers['x-asoldi-signature'].match(/t=(\d+)/);
      const siteKeySignature = createHmac('sha256', 'pk-shop-0001').update(`${t}.${call.body}`).digest('hex');
      assert.equal(call.headers['x-asoldi-signature'].includes(siteKeySignature), false, 'never signed with the site key');
    }
    const one = await call('POST', '/api/admin/email/sites/site_shop/wake', admin, {});
    assert.equal(one.status, 200, JSON.stringify(one.data));
    assert.deepEqual(one.data, { ok: true, status: 200, reason: '', answer: { ran: true, dueSteps: 2 } });
    assert.equal((await call('POST', '/api/admin/email/sites/site_out/wake', admin, {})).status, 409);
    assert.equal((await call('POST', '/api/admin/email/sites/site_none/wake', admin, {})).status, 404);
    assert.equal((await call('POST', '/api/admin/email/sites/site_shop/wake', {}, {})).status, 401);
    await store.saveEmailSettings({ killSwitch: true });
    assert.deepEqual(await handle.wake(), { ran: false, results: [] }, 'the kill switch stops the wakes');
    await store.saveEmailSettings({ killSwitch: false, enabled: false });
    assert.deepEqual(await handle.wake(), { ran: false, results: [] }, 'off: nobody is woken');
  } finally {
    await store.saveEmailSettings({ enabled: true, devCmsTargets: { site_shop: null, site_plain: null, site_basic: null, site_out: null } });
    cmsServer.closeAllConnections?.();
    cmsServer.close();
  }
  assert.equal(existsSync(join(dataDir, 'email-settings.json')), true);
});

test('an erased address stays erased: a mirrored row for it merges into its hashed key, and a hashed row from a mirror is kept', () => {
  const tomb = unsub.tombstoneKey('slett-meg@example.com');
  const target = { site_shop: { [tomb]: { scope: 'marketing', source: 'unsubscribe-link', at: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' } } };
  const changed = unsub.mergeSuppressionRows(target, { site_shop: { 'Slett-Meg@example.com': { scope: 'all', source: 'cms-mirror', at: '2026-11-02T10:00:00.000Z' } } });
  assert.equal(changed, 1);
  assert.deepEqual(Object.keys(target.site_shop), [tomb], 'the address never comes back as a key');
  assert.equal(target.site_shop[tomb].scope, 'all', 'the stronger row is kept under the hash');
  const fromMirror = {};
  unsub.mergeSuppressionRows(fromMirror, { site_plain: { [tomb]: { scope: 'marketing', source: 'cms-mirror', at: '2026-11-02T10:00:00.000Z' } } });
  assert.deepEqual(Object.keys(fromMirror.site_plain), [tomb]);
  assert.equal(unsub.suppressionFor('site_plain', 'slett-meg@example.com', 'campaign', { rows: fromMirror }).suppressed, true);
  assert.equal(unsub.suppressionFor('site_plain', 'slett-meg@example.com', 'test', { rows: fromMirror }).suppressed, false);
});

test('a rebuild from the CMS mirrors keeps an erased address as its hashed row', async () => {
  const tomb = unsub.tombstoneKey('mirror-only@example.com');
  const fetchImpl = async (url) => {
    assert.match(String(url), /^https:\/\/shop\.example\.com\/api\/cms\/email\/suppressions/);
    return new Response(JSON.stringify({ items: [{ email: tomb, scope: 'marketing', source: 'unsubscribe-link', at: '2026-11-03T10:00:00.000Z' }, { email: 'not an address', scope: 'all' }], next: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await unsub.rebuildSuppressionsFromCms({ getAllSites: () => [hub.getSiteById('site_shop')], fetchImpl, env: { HUB_SAFE_MODE: '0' }, now: Date.now() });
  assert.equal(result.ok, true, JSON.stringify(result));
  const record = store.readEmailSuppressions();
  assert.equal(record.site_shop[tomb].scope, 'marketing');
  assert.equal(JSON.stringify(record).includes('mirror-only'), false);
  assert.equal(Object.hasOwn(record['*'] || {}, tomb), false, 'a hashed row never becomes a global row');
});
