// relaySend: a table with one case per rejection code and the allowed link shapes, plus the happy
// path in detail, quota release on a provider refusal, the provider-blocked row and the safe-mode
// outbox. Brevo is a stub (or the real client in safe mode, which makes no network call).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-relay-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.BREVO_API_KEY;

const store = await import('../data/email-store.js');
const auth = await import('../lib/email-site-auth.js');
const unsub = await import('../lib/email-unsubscribe.js');
const brevoLib = await import('../lib/brevo.js');
const relay = await import('../lib/email-relay.js');
const { createEmailLog } = await import('../lib/email-log.js');
const { createEmailQuota, memoryLedgerStore } = await import('../lib/email-quota.js');
const { installSafeMode, resetSafeModeForTests } = await import('../lib/safe-mode.js');

const NOW = Date.parse('2026-11-03T10:00:00Z');
const SITES = {
  shop: { id: 'site_shop', site_key: 'pk-shop', domain: 'fjordbutikk.example.com', name: 'Fjordbutikken', features: { emailMarketing: true, ecommerce: true }, clientAdmin: { email: 'eier@example.com' }, cms: { adminUrl: 'https://cms-admin.example.net/admin' } },
  plain: { id: 'site_plain', site_key: 'pk-plain', domain: 'plain.example.com', name: 'Plain', features: { emailMarketing: true, ecommerce: false } },
  nodpa: { id: 'site_nodpa', site_key: 'pk-nodpa', domain: 'nodpa.example.com', name: 'Uten DPA', features: { emailMarketing: true, ecommerce: true } },
  susp: { id: 'site_susp', site_key: 'pk-susp', domain: 'susp.example.com', name: 'Pause', features: { emailMarketing: true, ecommerce: true } },
  out: { id: 'site_out', site_key: 'pk-out', domain: 'out.example.com', name: 'Utenfor', features: { emailMarketing: true, ecommerce: true } },
};
const KEYS = {};
const SENDER = { legalName: 'Fjordbutikken AS', orgNumber: '999 999 999', address: 'Storgata 1, 0000 Oslo', email: 'post@fjordbutikk.example.com' };
const log = createEmailLog({ flushMs: 0, dir: join(dataDir, 'email-log') });
let refCounter = 0;

test.before(async () => {
  await store.saveEmailSettings({ enabled: true, rollout: { mode: 'allowlist', siteIds: ['site_shop', 'site_plain', 'site_nodpa', 'site_susp'] }, links: { imageHosts: ['cdn.example.net'] } });
  for (const site of Object.values(SITES)) {
    await auth.issuePending(site.id, { now: NOW });
    const pending = store.readEmailSiteKeys()[site.id].pending.key;
    await auth.confirmProvision(pending, { now: NOW });
    KEYS[site.id] = pending;
    if (site.id !== 'site_nodpa') await store.patchEmailSite(site.id, { dpa: { acceptedAt: '2026-10-01T00:00:00.000Z', version: 'v1' } });
  }
  await store.patchEmailSite('site_shop', { allowImageHosts: ['images.example.org'] });
  await store.patchEmailSite('site_susp', { suspended: { at: '2026-11-02T00:00:00.000Z', reason: 'bounces', classes: ['p2', 'p3'] } });
  await unsub.addSuppression({ siteId: 'site_shop', email: 'avmeldt@example.com', source: 'unsubscribe-link', now: NOW - 1000 });
  await unsub.addSuppression({ siteId: 'site_plain', email: 'bounce@example.com', global: true, source: 'hardBounce', now: NOW - 1000 });
});

function body(over = {}) {
  refCounter += 1;
  return {
    kind: 'cart-recovery',
    ref: `int_${refCounter}`,
    step: 1,
    to: { email: `kunde${refCounter}@example.com`, name: 'Kari' },
    subject: 'Du glemte noe i handlekurven',
    preheader: 'Varene venter',
    html: '<!doctype html><html><body><p>Hei</p><a href="https://fjordbutikk.example.com/kasse?c=1">Til kassen</a> <a href="{{unsubscribeUrl}}">Meld deg av</a></body></html>',
    text: 'Hei. Til kassen: https://fjordbutikk.example.com/kasse Meld deg av: {{unsubscribeUrl}}',
    replyTo: 'post@fjordbutikk.example.com',
    consent: { basis: 'explicit', scope: 'cartReminder', grade: 'checkout', at: '2026-11-03T09:58:00.000Z', textHash: 'sha256:ab12' },
    sender: SENDER,
    brand: { name: 'Fjordbutikken', accent: '#0F2A44' },
    ...over,
  };
}

/** The base body links to the shop's domain; other sites link to their own. */
function forSite(input, site) {
  if (site.domain === 'fjordbutikk.example.com') return input;
  const swap = (v) => (typeof v === 'string' ? v.split('fjordbutikk.example.com/').join(`${site.domain}/`) : v);
  return { ...input, html: swap(input.html), text: swap(input.text) };
}

function brevoStub({ configured = true, error = null, mode = 'brevo' } = {}) {
  const calls = [];
  return {
    calls,
    brevoConfigured: () => configured,
    sendBrevoEmail: async (payload) => {
      calls.push(payload);
      if (error) throw error;
      return { providerMessageId: `<m${calls.length}@smtp.example.com>`, mode };
    },
  };
}

function withHtml(html, extra = {}) {
  return (b) => ({ ...b, html: `<html><body>${html} <a href="{{unsubscribeUrl}}">x</a></body></html>`, ...extra });
}

const rejected = (code) => new brevoLib.BrevoError('provider_rejected', { status: 400, brevoCode: code, brevoMessage: code === 'blocked' ? 'Contact is blocked' : 'Invalid parameter' });

// [name, { site, key, body(b), settings, brevo, quota, expect: [status, code] }]
const CASES = [
  ['happy path, cart recovery', { expect: [200] }],
  ['no x-email-key', { key: '', expect: [401, 'unauthorized'] }],
  ['wrong x-email-key', { key: 'A'.repeat(43), expect: [401, 'unauthorized'] }],
  ['another site\'s emailKey', { key: () => KEYS.site_plain, expect: [401, 'unauthorized'] }],
  ['the public site key as emailKey', { key: 'pk-shop', expect: [401, 'unauthorized'] }],
  ['Brevo not configured', { brevo: { configured: false }, expect: [503, 'not_configured'] }],
  ['kill switch on', { settings: { killSwitch: true }, expect: [503, 'paused'] }],
  ['email switched off', { settings: { enabled: false }, expect: [403, 'not_enabled'] }],
  ['site not in the rollout', { site: 'out', expect: [403, 'not_enabled'] }],
  ['rollout off', { settings: { rollout: { mode: 'off', siteIds: [] } }, expect: [403, 'not_enabled'] }],
  ['no DPA', { site: 'nodpa', expect: [403, 'dpa_missing'] }],
  ['no DPA but a test send', { site: 'nodpa', body: (b) => ({ ...b, kind: 'test', to: { email: 'damian@asoldi.com' } }), expect: [200] }],
  ['suspended class p2', { site: 'susp', body: (b) => ({ ...b, kind: 'review-request' }), expect: [403, 'suspended'] }],
  ['suspended site still sends p1', { site: 'susp', expect: [200] }],
  ['unknown kind', { body: (b) => ({ ...b, kind: 'newsletter-blast' }), expect: [403, 'not_entitled'] }],
  ['shop kind on a site without a shop', { site: 'plain', expect: [403, 'not_entitled'] }],
  ['campaign on the free plan', { settings: { brevo: { planTier: 'free' } }, body: (b) => ({ ...b, kind: 'campaign' }), expect: [403, 'not_entitled'] }],
  ['bad recipient', { body: (b) => ({ ...b, to: { email: 'not-an-address' } }), expect: [400, 'bad_recipient'] }],
  ['html over 200 KB', { body: (b) => ({ ...b, html: `<p>${'x'.repeat(200 * 1024)}</p>` }), expect: [413, 'too_large'] }],
  ['no html and no text', { body: (b) => ({ ...b, html: '', text: '  ' }), expect: [400, 'empty_body'] }],
  ['subject over 200 characters', { body: (b) => ({ ...b, subject: 's'.repeat(201) }), expect: [400, 'bad_subject'] }],
  ['no ref', { body: (b) => ({ ...b, ref: '' }), expect: [400, 'bad_ref'] }],
  ['no consent on cart recovery', { body: (b) => ({ ...b, consent: null }), expect: [409, 'no_consent'] }],
  ['campaign with unverified consent', { body: (b) => ({ ...b, kind: 'campaign', consent: { basis: 'explicit', grade: 'unverified' } }), expect: [409, 'no_consent'] }],
  ['welcome with unverified consent', { body: (b) => ({ ...b, kind: 'welcome', consent: { basis: 'explicit', grade: 'unverified' } }), expect: [409, 'no_consent'] }],
  ['back-in-stock needs no marketing consent', { body: (b) => ({ ...b, kind: 'back-in-stock', consent: undefined }), expect: [200] }],
  ['marketing kind without a sender block', { body: (b) => ({ ...b, sender: undefined }), expect: [422, 'sender_identity_missing'] }],
  ['sender without org number or personal name', { body: (b) => ({ ...b, sender: { ...SENDER, orgNumber: '' } }), expect: [422, 'sender_identity_missing'] }],
  ['sole trader with a personal name', { body: (b) => ({ ...b, sender: { ...SENDER, orgNumber: '', personalName: 'Kari Nordmann' } }), expect: [200] }],
  ['double-opt-in needs no sender block', { body: (b) => ({ ...b, kind: 'double-opt-in', sender: undefined, consent: { basis: 'requested' } }), expect: [200] }],
  ['image on a third-party host', { body: withHtml('<img src="https://tracker.example.net/p.gif">'), expect: [422, 'image_not_allowed'] }],
  ['image over http on the site domain', { body: withHtml('<img src="http://fjordbutikk.example.com/logo.png">'), expect: [422, 'image_not_allowed'] }],
  ['image through a CSS url()', { body: withHtml('<td style="background:url(\'https://tracker.example.net/bg.png\')">x</td>'), expect: [422, 'image_not_allowed'] }],
  ['image in srcset', { body: withHtml('<img src="https://fjordbutikk.example.com/a.png" srcset="https://tracker.example.net/a2.png 2x">'), expect: [422, 'image_not_allowed'] }],
  ['image on the site, an approved CDN and a site image host', { body: withHtml('<img src="https://fjordbutikk.example.com/a.png"><img src="https://cdn.example.net/b.png"><img src="https://images.example.org/c.png">'), expect: [200] }],
  ['google.com/url redirector', { body: withHtml('<a href="https://www.google.com/url?q=https://unlisted.example">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['l.facebook.com redirector', { body: withHtml('<a href="https://l.facebook.com/l.php?u=https%3A%2F%2Funlisted.example">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['linkedin redirector', { body: withHtml('<a href="https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Funlisted.example">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['youtube redirector', { body: withHtml('<a href="https://www.youtube.com/redirect?q=https%3A%2F%2Funlisted.example">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['facebook l.php on www', { body: withHtml('<a href="https://www.facebook.com/l.php?u=https%3A%2F%2Funlisted.example">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['percent-encoded nested URL on the site domain', { body: withHtml('<a href="https://fjordbutikk.example.com/go?to=https%3A%2F%2Funlisted.example">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['double-encoded nested URL on the site domain', { body: withHtml('<a href="https://fjordbutikk.example.com/go?to=https%253A%252F%252Funlisted.example">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['nested URL in the path', { body: withHtml('<a href="https://fjordbutikk.example.com/out/https://unlisted.example">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['allowed: review link, g.page and instagram profile', { body: withHtml('<a href="https://search.google.com/local/writereview?placeid=X">r</a><a href="https://g.page/r/abc">g</a><a href="https://www.instagram.com/fjordbutikken">i</a><a href="mailto:post@fjordbutikk.example.com">m</a><a href="tel:+4700000000">t</a><a href="#top">top</a>'), expect: [200] }],
  ['the heartbeat adminUrl host is not allowed', { body: withHtml('<a href="https://cms-admin.example.net/admin">admin</a>'), expect: [422, 'link_not_allowed'] }],
  ['a foreign host', { body: withHtml('<a href="https://unlisted.example/">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['a link after a quoted > in another attribute', { body: withHtml('<a title="a > b" href="https://unlisted.example/">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['a link after a stray quote in an attribute name', { body: withHtml('<a x\'y title=\'a>b\' href="https://unlisted.example/">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['an unquoted foreign link with upper-case attribute', { body: withHtml('<A HREF=https://unlisted.example/x>x</A>'), expect: [422, 'link_not_allowed'] }],
  ['a form action to a foreign host', { body: withHtml('<form action="https://unlisted.example/post"><button>x</button></form>'), expect: [422, 'link_not_allowed'] }],
  ['a CSS @import from a foreign host', { body: withHtml('<style>@import "https://tracker.example.net/a.css";</style>'), expect: [422, 'image_not_allowed'] }],
  ['javascript: link', { body: withHtml('<a href="javascript:alert(1)">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['shortener', { body: withHtml('<a href="https://bit.ly/abc">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['instagram account pages are denied', { body: withHtml('<a href="https://www.instagram.com/accounts/login">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['entity-encoded foreign link', { body: withHtml('<a href="https&#58;//unlisted.example/">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['www variant is matched exactly, not stripped', { body: withHtml('<a href="https://www.fjordbutikk.example.com/ok">x</a><a href="https://www.g.page/r/abc">y</a>'), expect: [422, 'link_not_allowed'] }],
  ['a foreign URL in the text part', { body: (b) => ({ ...b, text: 'Se https://unlisted.example/tilbud {{unsubscribeUrl}}' }), expect: [422, 'link_not_allowed'] }],
  ['test send to an address not on the list', { body: (b) => ({ ...b, kind: 'test', to: { email: 'random@asoldi.com' } }), expect: [403, 'test_recipient'] }],
  ['test send to a listed test recipient', { body: (b) => ({ ...b, kind: 'test', to: { email: 'alexander@asoldi.com' } }), expect: [200] }],
  ['test send to the confirmed owner', { body: (b) => ({ ...b, kind: 'test', ref: '', to: { email: 'eier@example.com' } }), expect: [200] }],
  ['unsubscribed address', { body: (b) => ({ ...b, to: { email: 'avmeldt@example.com' } }), expect: [409, 'suppressed'] }],
  ['unsubscribed address still gets a test send', { body: (b) => ({ ...b, kind: 'test', to: { email: 'avmeldt@example.com' } }), settings: { testRecipients: ['avmeldt@example.com'] }, expect: [200] }],
  ['hard-bounced address from another site', { body: (b) => ({ ...b, kind: 'test', to: { email: 'bounce@example.com' } }), settings: { testRecipients: ['bounce@example.com'] }, expect: [409, 'suppressed'] }],
  ['quota exhausted', { quota: { quota: { limit: 15 } }, expect: [429, 'quota'] }],
  ['quota ledger unreadable', { quota: 'broken', expect: [503, 'quota_unavailable'] }],
  ['Brevo refuses the request', { brevo: { error: rejected('invalid_parameter') }, expect: [502, 'provider_rejected'] }],
  ['Brevo is down', { brevo: { error: new brevoLib.BrevoError('provider_unavailable', { status: 503 }) }, expect: [502, 'provider_unavailable'] }],
];

function settingsFor(patch) {
  return patch ? store.deepMerge(store.readEmailSettings(), patch) : store.readEmailSettings();
}

function quotaFor(spec, settings) {
  if (spec === 'broken') return createEmailQuota({ store: { read: () => { throw Object.assign(new Error('x'), { code: 'EMAIL_STORE_UNREADABLE' }); }, write: () => {}, lock: (fn) => fn() }, settings: () => settings });
  return createEmailQuota({ store: memoryLedgerStore(), settings: () => (spec ? store.deepMerge(settings, spec) : settings) });
}

test('relay table: one case per rejection code, the redirector shapes and the allowed links', async () => {
  assert.ok(CASES.length >= 40, `${CASES.length} cases`);
  for (const [name, spec] of CASES) {
    const site = SITES[spec.site || 'shop'];
    const settings = settingsFor(spec.settings);
    const brevo = brevoStub(spec.brevo || {});
    const quota = quotaFor(spec.quota, settings);
    const input = forSite(spec.body ? spec.body(body()) : body(), site);
    const key = spec.key === undefined ? KEYS[site.id] : typeof spec.key === 'function' ? spec.key() : spec.key;
    const result = await relay.relaySend(site, input, { now: NOW, emailKey: key, deps: { settings, brevo, log, quota } });
    const [status, code] = spec.expect;
    assert.equal(result.status, status, `${name}: ${JSON.stringify(result.body)}`);
    if (code) assert.equal(result.body.code, code, name);
    if (status === 200) assert.equal(brevo.calls.length, 1, `${name}: one Brevo call`);
    else if (status !== 502) assert.equal(brevo.calls.length, 0, `${name}: no Brevo call`);
  }
});

test('happy path: exactly one Brevo call with https-only List-Unsubscribe, one-click, X-Mailin-custom, idempotency key and the token in html and text', async () => {
  const settings = settingsFor();
  const brevo = brevoStub();
  const input = body({ to: { email: 'Ola@Example.com', name: 'Ola' } });
  const result = await relay.relaySend(SITES.shop, input, { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.match(result.body.messageId, /^em_/);
  assert.deepEqual(Object.keys(result.body.quota.siteRemaining).sort(), ['p1', 'p23', 's']);
  assert.equal(result.body.quota.pool, 'ok');
  assert.equal(brevo.calls.length, 1);
  const sent = brevo.calls[0];
  assert.deepEqual(sent.to, [{ email: 'ola@example.com', name: 'Ola' }]);
  assert.deepEqual(sent.sender, { name: 'Fjordbutikken', email: 'kunder@asoldi.com' });
  assert.deepEqual(sent.replyTo, { email: 'post@fjordbutikk.example.com' });
  const lu = sent.headers['List-Unsubscribe'];
  assert.match(lu, /^<https:\/\/asoldi\.com\/api\/hub\/email\/unsubscribe\?t=[A-Za-z0-9_-]+>$/);
  assert.equal(lu.includes('mailto:'), false);
  assert.equal(lu.split(',').length, 1, 'one URI');
  assert.equal(sent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(sent.headers['X-Mailin-custom'], `site:site_shop|cart-recovery|${result.body.messageId}`);
  assert.equal(sent.headers.idempotencyKey, `site_shop:cart-recovery:${input.ref}:1`);
  assert.deepEqual(sent.tags, ['cms', 'site_shop', 'cart-recovery']);
  const url = lu.slice(1, -1);
  assert.equal(sent.htmlContent.includes('{{unsubscribeUrl}}'), false);
  assert.equal(sent.textContent.includes('{{unsubscribeUrl}}'), false);
  assert.ok(sent.htmlContent.includes(`href="${url}"`));
  assert.ok(sent.textContent.includes(url));
  const token = new URL(url).searchParams.get('t');
  assert.deepEqual(unsub.readUnsubToken(token), { siteId: 'site_shop', email: 'ola@example.com', kind: 'cart-recovery', messageId: result.body.messageId, scope: 'marketing' });
  const files = readdirSync(join(dataDir, 'email-log')).filter((f) => f.startsWith('messages-'));
  const lines = files.flatMap((f) => readFileSync(join(dataDir, 'email-log', f), 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l));
  const row = lines.find((l) => l.id === result.body.messageId);
  assert.equal(row.status, 'accepted');
  assert.equal(row.providerMessageId, '<m1@smtp.example.com>');
  assert.equal(JSON.stringify(lines).includes('ola@example.com'), false, 'the log has no plain address');
  const dup = await relay.relaySend(SITES.shop, input, { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
  assert.deepEqual([dup.status, dup.body.code], [409, 'duplicate']);
  assert.equal(brevo.calls.length, 1, 'a duplicate makes 0 Brevo calls');
});

test('without {{unsubscribeUrl}} the footer with the sender block is appended to html and text', async () => {
  const settings = settingsFor();
  const brevo = brevoStub();
  const input = body({ html: '<html><body><p>Hei</p></body></html>', text: 'Hei' });
  const result = await relay.relaySend(SITES.shop, input, { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
  assert.equal(result.status, 200);
  const { htmlContent, textContent } = brevo.calls[0];
  assert.match(htmlContent, /Du får denne e-posten fra Fjordbutikken fordi du startet et kjøp hos oss\..*Meld deg av<\/a><br>Fjordbutikken AS · Org\.nr\. 999 999 999 · Storgata 1, 0000 Oslo · post@fjordbutikk.example.com<\/div><\/body>/s);
  assert.match(textContent, /Meld deg av: https:\/\/asoldi\.com\/api\/hub\/email\/unsubscribe\?t=/);
});

test('recipient frequency: the third marketing mail to one address in a day is refused, per site', async () => {
  const settings = settingsFor();
  const quota = quotaFor(null, settings);
  const brevo = brevoStub();
  const to = { email: 'ofte@example.com' };
  const send = (siteKey, over = {}) => relay.relaySend(SITES[siteKey], forSite(body({ to, ...over }), SITES[siteKey]), { now: NOW, emailKey: KEYS[SITES[siteKey].id], deps: { settings, brevo, log, quota } });
  assert.equal((await send('shop')).status, 200);
  assert.equal((await send('shop', { kind: 'welcome' })).status, 200);
  const third = await send('shop');
  assert.deepEqual([third.status, third.body.code], [429, 'recipient_rate']);
  assert.ok(third.body.retryAt);
  assert.equal((await send('plain', { kind: 'welcome' })).status, 200, 'another site is not limited by it');
});

test('a Brevo refusal gives the quota back; a blocked-contact refusal adds a global provider-blocked row', async () => {
  const settings = settingsFor();
  const mem = memoryLedgerStore();
  const quota = createEmailQuota({ store: mem, settings: () => settings });
  const refused = await relay.relaySend(SITES.shop, body(), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo: brevoStub({ error: rejected('invalid_parameter') }), log, quota } });
  assert.equal(refused.status, 502);
  assert.equal(mem.peek().total, 0, 'released');
  const blocked = await relay.relaySend(SITES.shop, body({ to: { email: 'sperret@example.com' } }), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo: brevoStub({ error: rejected('blocked') }), log, quota } });
  assert.deepEqual([blocked.status, blocked.body.code], [502, 'provider_rejected']);
  const row = store.readEmailSuppressions()['*']['sperret@example.com'];
  assert.equal(row.source, 'provider-blocked');
  assert.equal(row.scope, 'all');
  assert.deepEqual(row.siteIds, ['site_shop']);
  const again = await relay.relaySend(SITES.plain, forSite(body({ kind: 'welcome', to: { email: 'sperret@example.com' } }), SITES.plain), { now: NOW, emailKey: KEYS.site_plain, deps: { settings, brevo: brevoStub(), log, quota } });
  assert.deepEqual([again.status, again.body.code], [409, 'suppressed']);
});

test('checkLinks lists every reference with a verdict (lint view)', () => {
  const verdicts = relay.checkLinks('<a href="https://fjordbutikk.example.com/">a</a><img src="https://tracker.example.net/x.gif"><a href="https://g.page/r/x">g</a>', SITES.shop, { settings: store.readEmailSettings() });
  assert.deepEqual(verdicts.map((v) => [v.kind, v.ok, v.reason]), [['link', true, 'site'], ['image', false, 'host_not_allowed'], ['link', true, 'rule']]);
});

test('safe mode: the real client writes the outbox, makes 0 calls to api.brevo.com, and the log says outbox', async () => {
  const fetchCalls = [];
  brevoLib.setBrevoDeps({ env: { BREVO_API_KEY: 'fake-brevo-key-for-relay-tests' }, fetch: async (url) => { fetchCalls.push(String(url)); return new Response('{}', { status: 201 }); } });
  installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, egress: false, log: null });
  try {
    const settings = settingsFor();
    const result = await relay.relaySend(SITES.shop, body(), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, log, quota: quotaFor(null, settings), env: { BREVO_API_KEY: 'fake-brevo-key-for-relay-tests' } } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.mode, 'outbox');
    assert.equal(fetchCalls.length, 0);
    const day = readdirSync(join(dataDir, 'outbox')).find((n) => /^\d{4}-/.test(n));
    assert.equal(readdirSync(join(dataDir, 'outbox', day)).filter((n) => n.endsWith('.eml')).length, 1);
  } finally {
    resetSafeModeForTests();
    brevoLib.setBrevoDeps(null);
  }
});

test('the tag scanner reads attributes like an HTML tokenizer and stays linear on broken markup', () => {
  assert.deepEqual(relay.scanTags('<a title="x > y" href=\'https://a.example.com/\'>t</a><img src=https://b.example.com/i.png alt=x>').map((t) => [t.name, t.attrs]), [
    ['a', [['title', 'x > y'], ['href', 'https://a.example.com/']]],
    ['img', [['src', 'https://b.example.com/i.png'], ['alt', 'x']]],
  ]);
  const broken = '<a "'.repeat(40_000) + '<a title="never closed';
  const started = Date.now();
  relay.scanTags(broken);
  relay.checkLinks(broken, SITES.shop, { settings: store.readEmailSettings() });
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});
