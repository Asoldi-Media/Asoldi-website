// Owner recipients with change control and owner notices (lib/email-owner.js,
// lib/routes/email-owner-routes.js):
//  - off (the default): all six routes answer 404 disabled before any other check, nothing written;
//  - the CMS-facing routes need the emailKey and a site in the rollout;
//  - only an owner-rank actor may change the list; a new address is pending until it confirms, and
//    a pending address neither receives a notice nor is a test recipient;
//  - a change notifies the previous confirmed owners with a revert link that restores the old list;
//  - 50 notices per site per day, dedupe per key, a failed send gives its count back;
//  - seo-report only through the hub-internal function, at most one per site per 7 days.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-owner-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.BREVO_API_KEY;

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-05T09:00:00Z');
let clock = T0;
const SITES = [
  { id: 'site_shop', site_key: 'pk-shop-owner', domain: 'fjellbutikk.example.com', name: 'Fjellbutikken', features: { emailMarketing: true, ecommerce: true } },
  { id: 'site_busy', site_key: 'pk-busy-owner', domain: 'travel.example.com', name: 'Travel butikk', features: { emailMarketing: true } },
  { id: 'site_none', site_key: 'pk-none-owner', domain: 'uten-eier.example.com', name: 'Uten eier', features: { emailMarketing: true } },
  { id: 'site_out', site_key: 'pk-out-owner', domain: 'utenfor.example.com', name: 'Utenfor', features: { emailMarketing: true } },
];
writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(SITES, null, 2));

const store = await import('../data/email-store.js');
const auth = await import('../lib/email-site-auth.js');
const owner = await import('../lib/email-owner.js');
const routes = await import('../lib/routes/email-owner-routes.js');
const relay = await import('../lib/email-relay.js');
const { createEmailLog } = await import('../lib/email-log.js');
const { createEmailQuota, memoryLedgerStore } = await import('../lib/email-quota.js');

const hub = {
  getSiteByKey: (key) => SITES.find((s) => s.site_key === key) || null,
  getSiteById: (id) => SITES.find((s) => s.id === id) || null,
  getAllSites: () => SITES,
};
const KEYS = {};
const mails = [];
let mailFails = false;
const sendEmail = async (message) => {
  if (mailFails) throw Object.assign(new Error('transport down'), { code: 'ETRANSPORT' });
  mails.push(message);
};
const relayLog = createEmailLog({ flushMs: 0, dir: join(dataDir, 'email-log-owner') });

let base = '';
let server;
test.before(async () => {
  for (const site of SITES) {
    await auth.issuePending(site.id, { now: T0 });
    const pending = store.readEmailSiteKeys()[site.id].pending.key;
    await auth.confirmProvision(pending, { now: T0 });
    KEYS[site.id] = pending;
  }
  await store.patchEmailSite('site_shop', { ownerRecipients: [{ email: 'eier@example.com', status: 'confirmed', confirmedAt: '2026-10-01T00:00:00.000Z', source: 'superadmin' }] });
  await store.patchEmailSite('site_busy', { ownerRecipients: [{ email: 'travel-eier@example.com', status: 'confirmed', confirmedAt: '2026-10-01T00:00:00.000Z', source: 'superadmin' }] });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  routes.registerEmailOwnerRoutes(app, { hub, sales: { getSalesClients: () => [] } }, { now: () => clock, env: { SALES_CONTACT_EMAIL: 'innboks@example.com' }, sendEmail });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server?.closeAllConnections?.();
  server?.close();
});

async function call(method, path, headers = {}, body = undefined) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json' }) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // a page
  }
  return { status: res.status, data, text, headers: res.headers };
}

const keyHeaders = (siteId) => ({ 'x-site-key': hub.getSiteById(siteId).site_key, 'x-email-key': KEYS[siteId] });
const put = (siteId, body) => call('PUT', '/api/hub/email/owner-recipients', keyHeaders(siteId), body);
let noticeRef = 0;
const notify = (siteId, over = {}) => {
  noticeRef += 1;
  return call('POST', '/api/hub/email/owner-notify', keyHeaders(siteId), { kind: 'order', subject: 'Ny bestilling', text: `Ordre ${noticeRef}`, dedupeKey: `ord_${noticeRef}`, ...over });
};
const ownerRows = (siteId) => store.readEmailSite(siteId).ownerRecipients.map((row) => [row.email, row.status]);
/** The path and token of the link in a mail (confirm or revert). */
function linkIn(message, action) {
  const match = message.text.match(new RegExp(`https://[^\\s]+/api/hub/email/owner-recipients/${action}\\?t=([A-Za-z0-9._-]+)`));
  assert.ok(match, `a ${action} link in: ${message.subject}`);
  return { path: `/api/hub/email/owner-recipients/${action}?t=${match[1]}`, token: match[1] };
}
const recipientsOf = (message) => message.to.split(',').map((a) => a.trim()).sort();

test('off (the default): every owner route answers 404 disabled before any other check and writes nothing', async () => {
  assert.equal(store.readEmailSettings().enabled, false);
  for (const [method, path, headers, body] of [
    ['PUT', '/api/hub/email/owner-recipients', {}, { emails: [] }],
    ['PUT', '/api/hub/email/owner-recipients', keyHeaders('site_shop'), { emails: ['ny@example.com'], actor: { username: 'eier', rank: 'owner' } }],
    ['POST', '/api/hub/email/owner-notify', keyHeaders('site_shop'), { kind: 'order', subject: 'x', text: 'x', dedupeKey: 'x' }],
    ['GET', '/api/hub/email/owner-recipients/confirm?t=abc'],
    ['POST', '/api/hub/email/owner-recipients/confirm?t=abc', {}, 'go=1'],
    ['GET', '/api/hub/email/owner-recipients/revert?t=abc'],
    ['POST', '/api/hub/email/owner-recipients/revert?t=abc', {}, 'go=1'],
  ]) {
    const res = await call(method, path, headers, body);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.deepEqual(res.data, { code: 'disabled' }, `${method} ${path}`);
  }
  assert.equal(existsSync(join(dataDir, owner.OWNER_FILE)), false, 'no owner file');
  assert.deepEqual(ownerRows('site_shop'), [['eier@example.com', 'confirmed']]);
  assert.equal(mails.length, 0);
});

test('setup: the platform on for three sites', async () => {
  await store.saveEmailSettings({ enabled: true, rollout: { mode: 'allowlist', siteIds: ['site_shop', 'site_busy', 'site_none'] } });
});

test('the CMS-facing owner routes need the emailKey, and a site outside the rollout gets 403', async () => {
  for (const [method, path] of [['PUT', '/api/hub/email/owner-recipients'], ['POST', '/api/hub/email/owner-notify']]) {
    for (const headers of [{ 'x-site-key': 'pk-shop-owner' }, { 'x-site-key': 'pk-shop-owner', 'x-email-key': 'A'.repeat(43) }, { 'x-site-key': 'pk-shop-owner', 'x-email-key': KEYS.site_busy }]) {
      const res = await call(method, path, headers, {});
      assert.deepEqual([res.status, res.data.code], [401, 'unauthorized'], `${method} ${path}`);
    }
    const out = await call(method, path, keyHeaders('site_out'), {});
    assert.deepEqual([out.status, out.data.code], [403, 'not_enabled'], `${method} ${path} outside the rollout`);
  }
  for (const route of routes.EMAIL_OWNER_SITE_ROUTES) {
    const registered = [];
    const fake = Object.fromEntries(['get', 'post', 'put', 'delete'].map((m) => [m, (p, ...handlers) => registered.push({ route: `${m.toUpperCase()} ${p}`, handlers })]));
    routes.registerEmailOwnerRoutes(fake, { hub }, { sendEmail });
    const entry = registered.find((r) => r.route === route);
    assert.ok(entry?.handlers.some((h) => h?.requiresEmailKey === true), `${route} is behind requireEmailKey`);
  }
});

test('(b) an employee-rank actor gets 403 and nothing changes; bad lists get 400', async () => {
  const before = mails.length;
  const employee = await put('site_shop', { emails: ['ny@example.com'], actor: { username: 'ansatt', rank: 'employee' } });
  assert.deepEqual([employee.status, employee.data.code], [403, 'forbidden']);
  const noActor = await put('site_shop', { emails: ['ny@example.com'] });
  assert.deepEqual([noActor.status, noActor.data.code], [403, 'forbidden']);
  const tooMany = await put('site_shop', { emails: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'], actor: { username: 'eier', rank: 'owner' } });
  assert.deepEqual([tooMany.status, tooMany.data.code], [400, 'too_many']);
  const invalid = await put('site_shop', { emails: ['ikke-en-adresse'], actor: { username: 'eier', rank: 'owner' } });
  assert.deepEqual([invalid.status, invalid.data.code], [400, 'bad_recipient']);
  assert.deepEqual(ownerRows('site_shop'), [['eier@example.com', 'confirmed']]);
  assert.equal(mails.length, before, 'no mail');
});

test('(a) (c) a new address is pending until it confirms; the previous owner gets a revert link that restores the old list', async () => {
  mails.length = 0;
  const changed = await put('site_shop', { emails: ['Eier@Example.com', 'ny@example.com'], actor: { username: 'Kari\r\nBcc: x@example.com', rank: 'owner' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.deepEqual(changed.data, [{ email: 'eier@example.com', status: 'confirmed' }, { email: 'ny@example.com', status: 'pending' }]);
  const confirmMail = mails.find((m) => m.to === 'ny@example.com');
  const changeMail = mails.find((m) => m.to === 'eier@example.com');
  assert.ok(confirmMail && changeMail, 'a confirm link to the new address and a notice to the previous owner');
  assert.equal(mails.length, 2);
  assert.match(changeMail.text, /KariBcc: x@example\.com endret/, 'the actor name carries no line break');
  assert.match(changeMail.text, /Før: eier@example\.com/);
  assert.equal(confirmMail.text.includes('ny@example.com'), false, 'the confirm link carries no plain address');
  const confirm = linkIn(confirmMail, 'confirm');
  assert.equal(confirm.path.includes('example.com'), false);

  // (a) The pending address gets no notice and is no test recipient.
  mails.length = 0;
  assert.equal((await notify('site_shop')).status, 200);
  assert.deepEqual(recipientsOf(mails[0]), ['eier@example.com']);
  const settings = store.readEmailSettings();
  const relayDeps = { settings, brevo: { brevoConfigured: () => true, sendBrevoEmail: async () => ({ providerMessageId: '<x@example.com>', mode: 'brevo' }) }, log: relayLog, quota: createEmailQuota({ store: memoryLedgerStore(), settings: () => settings }) };
  const testMail = { kind: 'test', to: { email: 'ny@example.com' }, subject: 'Test', html: '<p>Test</p>', text: 'Test' };
  const refused = await relay.relaySend(hub.getSiteById('site_shop'), testMail, { now: clock, authenticated: true, deps: relayDeps });
  assert.deepEqual([refused.status, refused.body.code], [403, 'test_recipient']);

  // GET shows a button and changes nothing; POST confirms.
  const page = await call('GET', confirm.path);
  assert.equal(page.status, 200);
  assert.match(page.text, /<form method="post"/);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.deepEqual(ownerRows('site_shop'), [['eier@example.com', 'confirmed'], ['ny@example.com', 'pending']]);
  const confirmed = await call('POST', confirm.path, {}, 'go=1');
  assert.equal(confirmed.status, 200);
  assert.deepEqual(ownerRows('site_shop'), [['eier@example.com', 'confirmed'], ['ny@example.com', 'confirmed']]);
  assert.equal((await call('POST', confirm.path, {}, 'go=1')).status, 200, 'a repeat changes nothing');
  mails.length = 0;
  assert.equal((await notify('site_shop')).status, 200);
  assert.deepEqual(recipientsOf(mails[0]), ['eier@example.com', 'ny@example.com']);
  const accepted = await relay.relaySend(hub.getSiteById('site_shop'), testMail, { now: clock, authenticated: true, deps: relayDeps });
  assert.equal(accepted.status, 200, 'once confirmed it is a test recipient');

  // (c) A change that removes both owners: both get the notice; the revert link restores the list.
  mails.length = 0;
  const takeover = await put('site_shop', { emails: ['annen@example.com'], actor: { username: 'Ola', rank: 'owner' } });
  assert.deepEqual(takeover.data, [{ email: 'annen@example.com', status: 'pending' }]);
  const notice = mails.find((m) => m.subject.startsWith('Varslingsadressene'));
  assert.deepEqual(recipientsOf(notice), ['eier@example.com', 'ny@example.com']);
  const strangerConfirm = linkIn(mails.find((m) => m.to === 'annen@example.com'), 'confirm');
  const revert = linkIn(notice, 'revert');
  mails.length = 0;
  assert.equal((await notify('site_shop')).status, 200);
  assert.deepEqual(recipientsOf(mails[0]), ['innboks@example.com'], 'with no confirmed owner the notice goes to the fallback inbox');
  assert.match(mails[0].subject, /^\[Ingen eier-e-post satt\] /);
  assert.equal((await call('GET', revert.path)).status, 200);
  assert.deepEqual(ownerRows('site_shop'), [['annen@example.com', 'pending']], 'GET changes nothing');
  const reverted = await call('POST', revert.path, {}, 'go=1');
  assert.equal(reverted.status, 200);
  assert.match(reverted.text, /Endringen er angret/);
  assert.deepEqual(ownerRows('site_shop'), [['eier@example.com', 'confirmed'], ['ny@example.com', 'confirmed']], 'the old list is back');
  const again = await call('POST', revert.path, {}, 'go=1');
  assert.equal(again.status, 200);
  assert.match(again.text, /allerede angret/);
  const late = await call('POST', strangerConfirm.path, {}, 'go=1');
  assert.equal(late.status, 400, 'a confirm link of a reverted change is void');
  assert.deepEqual(ownerRows('site_shop'), [['eier@example.com', 'confirmed'], ['ny@example.com', 'confirmed']]);
});

test('a change notice never goes to a pending address of the previous list', async () => {
  await store.patchEmailSite('site_none', { ownerRecipients: [{ email: 'venter@example.com', status: 'pending', confirmedAt: '', source: 'owner' }] });
  mails.length = 0;
  const res = await put('site_none', { emails: ['ny-none@example.com'], actor: { username: 'eier', rank: 'owner' } });
  assert.equal(res.status, 200);
  assert.deepEqual(mails.map((m) => m.to), ['ny-none@example.com'], 'only the confirm link; no previous confirmed owner to notify');
});

test('links: a changed token, a token for another site and an expired one are refused', async () => {
  mails.length = 0;
  await put('site_busy', { emails: ['travel-eier@example.com', 'travel-ny@example.com'], actor: { username: 'eier', rank: 'owner' } });
  const confirm = linkIn(mails.find((m) => m.to === 'travel-ny@example.com'), 'confirm');
  const revert = linkIn(mails.find((m) => m.to === 'travel-eier@example.com'), 'revert');
  const [v, body, mac] = confirm.token.split('.');
  const tampered = `${v}.${body}.${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`;
  assert.equal((await call('POST', `/api/hub/email/owner-recipients/confirm?t=${tampered}`, {}, 'go=1')).status, 400);
  const otherSite = owner.mintOwnerToken({ action: 'confirm', siteId: 'site_shop', changeId: JSON.parse(Buffer.from(body, 'base64url').toString()).c, email: 'travel-ny@example.com', expiresAt: clock + DAY });
  assert.equal((await call('POST', `/api/hub/email/owner-recipients/confirm?t=${otherSite}`, {}, 'go=1')).status, 400, 'a token for another site');
  assert.equal((await call('POST', `/api/hub/email/owner-recipients/revert?t=${confirm.token}`, {}, 'go=1')).status, 400, 'a confirm token on the revert page');
  clock += 8 * DAY;
  assert.equal((await call('GET', confirm.path)).status, 410);
  assert.equal((await call('POST', revert.path, {}, 'go=1')).status, 410);
  assert.deepEqual(ownerRows('site_busy'), [['travel-eier@example.com', 'confirmed'], ['travel-ny@example.com', 'pending']], 'nothing changed');
  clock = T0 + 10 * DAY;
});

test('(d) 50 notices a day per site, the 51st gets 429; a repeated dedupe key sends nothing; a failed send gives its count back', async () => {
  clock = T0 + 20 * DAY;
  mails.length = 0;
  mailFails = true;
  const down = await notify('site_busy', { dedupeKey: 'ord_down' });
  mailFails = false;
  assert.deepEqual([down.status, down.data.code], [502, 'provider_unavailable']);
  assert.equal((await notify('site_busy', { dedupeKey: 'ord_down' })).status, 200, 'the failed key can be sent again');
  const dup = await notify('site_busy', { dedupeKey: 'ord_down' });
  assert.deepEqual([dup.status, dup.data.code], [409, 'duplicate']);
  for (let i = 2; i <= 50; i += 1) assert.equal((await notify('site_busy')).status, 200, `notice ${i}`);
  assert.equal(mails.length, 50);
  const over = await notify('site_busy');
  assert.deepEqual([over.status, over.data.code], [429, 'owner_rate']);
  assert.ok(Date.parse(over.data.retryAt) > clock);
  assert.equal(mails.length, 50);
  assert.equal((await notify('site_shop')).status, 200, 'another site has its own allowance');
  clock += DAY;
  assert.equal((await notify('site_busy')).status, 200, 'the next Oslo day starts over');
});

test('(e) seo-report only through the internal function: confirmed owners, at most 150 characters, once per 7 days', async () => {
  const viaSite = await notify('site_shop', { kind: 'seo-report', dedupeKey: 'seo-report:2026-11' });
  assert.deepEqual([viaSite.status, viaSite.data.code], [400, 'bad_kind']);
  const unknown = await notify('site_shop', { kind: 'campaign' });
  assert.deepEqual([unknown.status, unknown.data.code], [400, 'bad_kind']);
  const site = hub.getSiteById('site_shop');
  const report = { kind: 'seo-report', subject: 'SEO-rapport for november', text: 'Se rapporten: https://fjellbutikk.example.com/admin/analytics', dedupeKey: 'seo-report:2026-11' };
  const long = await owner.sendOwnerNotice(site, { ...report, subject: 's'.repeat(151) }, { now: clock, sendEmail });
  assert.deepEqual([long.status, long.body.code], [400, 'bad_subject']);
  mails.length = 0;
  const sent = await owner.sendOwnerNotice(site, report, { now: clock, sendEmail });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(recipientsOf(mails[0]), ['eier@example.com', 'ny@example.com']);
  const soon = await owner.sendOwnerNotice(site, { ...report, dedupeKey: 'seo-report:2026-11b' }, { now: clock + 6 * DAY, sendEmail });
  assert.deepEqual([soon.status, soon.body.code], [429, 'too_soon']);
  assert.equal((await owner.sendOwnerNotice(site, { ...report, dedupeKey: 'seo-report:2026-12' }, { now: clock + 7 * DAY, sendEmail })).status, 200);
  const nobody = await owner.sendOwnerNotice(hub.getSiteById('site_none'), { ...report, text: 'Se rapporten: https://uten-eier.example.com/admin/analytics' }, { now: clock, sendEmail });
  assert.deepEqual([nobody.status, nobody.body.code], [409, 'no_owner'], 'a site without a confirmed owner gets no report');
  assert.equal(mails.some((m) => m.to.includes('innboks@example.com') && m.subject.includes('SEO')), false);
});

test('owner notices may link only to the site\'s own hosts', async () => {
  const foreign = await notify('site_shop', { html: '<p>Se <a href="https://evil.example.net/login">her</a></p>' });
  assert.deepEqual([foreign.status, foreign.data.code], [422, 'link_not_allowed']);
  const script = await notify('site_shop', { html: '<p>Hei</p><script>alert(1)</script>' });
  assert.deepEqual([script.status, script.data.code, script.data.reason], [422, 'link_not_allowed', 'markup']);
  const own = await notify('site_shop', { html: '<p>Se <a href="https://fjellbutikk.example.com/admin/ordre/1">ordren</a></p>' });
  assert.equal(own.status, 200);
  const visitorText = await notify('site_shop', { kind: 'form', text: 'Melding: se https://min-side.example.org/bilder', html: '<p>Melding: se https://min-side.example.org/bilder</p>' });
  assert.equal(visitorText.status, 200, 'an address a visitor typed is text, not a link, and does not block the notice');
  const noText = await notify('site_shop', { text: ' ' });
  assert.deepEqual([noText.status, noText.data.code], [400, 'empty_body']);
  const noKey = await notify('site_shop', { dedupeKey: '\r\n' });
  assert.deepEqual([noKey.status, noKey.data.code], [400, 'bad_ref']);
});

test('at most 10 owner-recipient changes per site per day', async () => {
  clock = T0 + 40 * DAY;
  const statuses = [];
  for (let i = 0; i < 11; i += 1) statuses.push((await put('site_none', { emails: [`skift${i}@example.com`], actor: { username: 'eier', rank: 'owner' } })).status);
  assert.deepEqual(statuses, [...Array(10).fill(200), 429]);
  const same = await put('site_none', { emails: ['skift9@example.com'], actor: { username: 'eier', rank: 'owner' } });
  assert.equal(same.status, 200, 'an unchanged list is not a change');
});

test('switched off again, the pages stay open only while a recent change exists', async () => {
  clock = T0 + 60 * DAY;
  mails.length = 0;
  await put('site_shop', { emails: ['eier@example.com'], actor: { username: 'eier', rank: 'owner' } });
  const revert = linkIn(mails.find((m) => m.subject.startsWith('Varslingsadressene')), 'revert');
  await store.saveEmailSettings({ enabled: false });
  try {
    assert.equal((await call('GET', revert.path)).status, 200, 'a delivered revert link keeps working');
    assert.deepEqual((await put('site_shop', { emails: [], actor: { username: 'eier', rank: 'owner' } })).data, { code: 'disabled' });
    clock += 8 * DAY;
    assert.deepEqual((await call('GET', revert.path)).data, { code: 'disabled' }, 'after 7 days the pages are closed again');
  } finally {
    await store.saveEmailSettings({ enabled: true });
  }
});

test('every route the owner module registers is called in this file, and the lists match the registration', () => {
  const registered = [];
  const fake = Object.fromEntries(['get', 'post', 'put', 'delete', 'patch'].map((m) => [m, (p) => registered.push(`${m.toUpperCase()} ${p}`)]));
  routes.registerEmailOwnerRoutes(fake, { hub }, { sendEmail });
  assert.deepEqual(registered.slice().sort(), [...routes.EMAIL_OWNER_SITE_ROUTES, ...routes.EMAIL_OWNER_PUBLIC_ROUTES].sort());
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const missing = registered.filter((route) => !source.includes(route.split(' ')[1]));
  assert.deepEqual(missing, []);
  assert.ok(existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'routes', 'email-owner-routes.js')));
});
