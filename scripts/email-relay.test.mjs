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
  ['campaign on the free plan', { settings: { brevo: { planTier: 'free', termsConfirmedAt: '2026-10-30T10:00:00.000Z' } }, body: (b) => ({ ...b, kind: 'campaign' }), expect: [403, 'not_entitled'] }],
  ['campaign while the plan is unknown', { settings: { brevo: { planTier: 'unknown', termsConfirmedAt: '2026-10-30T10:00:00.000Z' } }, body: (b) => ({ ...b, kind: 'campaign' }), expect: [403, 'not_entitled'] }],
  ['campaign before the Brevo terms check is recorded', { settings: { brevo: { planTier: 'starter', termsConfirmedAt: '' } }, body: (b) => ({ ...b, kind: 'campaign' }), expect: [403, 'not_entitled'] }],
  ['bad recipient', { body: (b) => ({ ...b, to: { email: 'not-an-address' } }), expect: [400, 'bad_recipient'] }],
  ['html over 200 KB', { body: (b) => ({ ...b, html: `<p>${'x'.repeat(200 * 1024)}</p>` }), expect: [413, 'too_large'] }],
  ['no html and no text', { body: (b) => ({ ...b, html: '', text: '  ' }), expect: [400, 'empty_body'] }],
  ['subject over 200 characters', { body: (b) => ({ ...b, subject: 's'.repeat(201) }), expect: [400, 'bad_subject'] }],
  ['no ref', { body: (b) => ({ ...b, ref: '' }), expect: [400, 'bad_ref'] }],
  ['no consent on cart recovery', { body: (b) => ({ ...b, consent: null }), expect: [409, 'no_consent'] }],
  ['campaign with unverified consent', { settings: { brevo: { planTier: 'starter', termsConfirmedAt: '2026-10-30T10:00:00.000Z' } }, body: (b) => ({ ...b, kind: 'campaign', consent: { basis: 'explicit', grade: 'unverified' } }), expect: [409, 'no_consent'] }],
  ['campaign on a paid plan with the terms check recorded', { settings: { brevo: { planTier: 'starter', termsConfirmedAt: '2026-10-30T10:00:00.000Z' } }, body: (b) => ({ ...b, kind: 'campaign', consent: { basis: 'explicit', grade: 'checkout' } }), expect: [200] }],
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
  // Markup a browser reads differently from a naive scanner: the link after it is real.
  ['a quote inside a comment does not hide the link after it', { body: withHtml('<p>Hei</p><!-- <x a=" --> <a href="https://unlisted.example/login">Logg inn</a> <y b=" -->'), expect: [422, 'link_not_allowed'] }],
  ['a quote inside a title does not hide the link after it', { body: withHtml('<title><a t="</title><a href=https://unlisted.example/>x</a>">'), expect: [422, 'link_not_allowed'] }],
  ['a quote inside a style block does not hide the link after it', { body: withHtml('<style><a b="</style><a href=https://unlisted.example/>x</a>">'), expect: [422, 'link_not_allowed'] }],
  ['a quote inside a textarea does not hide the link after it', { body: withHtml('<textarea><a b="</textarea><a href=https://unlisted.example/>x</a>">'), expect: [422, 'link_not_allowed'] }],
  ['a quote inside an end tag does not hide the link after it', { body: withHtml('</p title="<x a=\'">\'<a href=https://unlisted.example/>x</a>'), expect: [422, 'link_not_allowed'] }],
  ['a bogus comment ends at the first >', { body: withHtml('<![CDATA[ x > <a href="https://unlisted.example/">x</a> ]]>'), expect: [422, 'link_not_allowed'] }],
  ['a link inside a comment (Outlook renders conditional comments)', { body: withHtml('<!--[if mso]><a href="https://unlisted.example/">x</a><![endif]-->'), expect: [422, 'link_not_allowed'] }],
  ['a protocol-relative link', { body: withHtml('<a href="//unlisted.example/">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['a link with a tab in the scheme', { body: withHtml('<a href="ht&Tab;tps://unlisted.example/">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['a code point past U+10FFFF in a link does not crash the check', { body: withHtml('<a href="https://fjordbutikk.example.com/&#x110000;">x</a>'), expect: [200] }],
  ['script', { body: withHtml('<script><!--<script></script><x a="--></script><a href=https://fjordbutikk.example.com/>x</a>">'), expect: [422, 'link_not_allowed'] }],
  ['noscript', { body: withHtml('<noscript><a b="</noscript><a href=https://fjordbutikk.example.com/>x</a>">'), expect: [422, 'link_not_allowed'] }],
  ['inline SVG', { body: withHtml('<svg><a href="https://fjordbutikk.example.com/"><text>x</text></a></svg>'), expect: [422, 'link_not_allowed'] }],
  ['SVG animate that sets a link', { body: withHtml('<svg><a><animate attributeName="href" values="https://unlisted.example/"/><text>x</text></a></svg>'), expect: [422, 'link_not_allowed'] }],
  ['MathML', { body: withHtml('<math><mi>x</mi></math>'), expect: [422, 'link_not_allowed'] }],
  ['iframe', { body: withHtml('<iframe src="https://fjordbutikk.example.com/"></iframe>'), expect: [422, 'link_not_allowed'] }],
  ['meta refresh', { body: withHtml('<meta http-equiv="refresh" content="0;url=https://fjordbutikk.example.com/">'), expect: [422, 'link_not_allowed'] }],
  ['a ping to a foreign host', { body: withHtml('<a href="https://fjordbutikk.example.com/" ping="https://tracker.example.net/p">x</a>'), expect: [422, 'link_not_allowed'] }],
  ['image-set with a quoted foreign URL', { body: withHtml('<div style="background-image:image-set(\'https://tracker.example.net/p.png\' 1x)">x</div>'), expect: [422, 'image_not_allowed'] }],
  ['a CSS-escaped url()', { body: withHtml('<div style="background:\\75 rl(https://tracker.example.net/p.png)">x</div>'), expect: [422, 'image_not_allowed'] }],
  ['a srcset entry hidden behind an encoded comma', { body: withHtml('<img src="https://fjordbutikk.example.com/a.png" srcset="https://fjordbutikk.example.com/a.png 1x&#44;https://tracker.example.net/b.png 2x">'), expect: [422, 'image_not_allowed'] }],
  ['a VML link inside an Outlook comment to a foreign host', { body: withHtml('<!--[if mso]><v:roundrect href="https://unlisted.example/" style="width:200px"><v:fill src="https://fjordbutikk.example.com/b.png"/></v:roundrect><![endif]-->'), expect: [422, 'link_not_allowed'] }],
  ['allowed: an XHTML template with conditional comments, VML and a style block', {
    body: (b) => ({
      ...b,
      html: '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">'
        + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>'
        + '<title>Tilbud fra Fjordbutikken</title><!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->'
        + '<style type="text/css">/* hero */ .hero{background:url("https://cdn.example.net/hero.jpg")} @media (max-width:480px){.c{width:100%!important}}</style></head><body>'
        + '<!--[if mso]><v:roundrect href="https://fjordbutikk.example.com/kasse" arcsize="10%"><v:fill src="https://cdn.example.net/b.png"/></v:roundrect><![endif]-->'
        + '<!--[if !mso]><!--><a href="https://fjordbutikk.example.com/kasse">Til kassen</a><!--<![endif]-->'
        + '<img src="https://fjordbutikk.example.com/logo.png" srcset="https://fjordbutikk.example.com/logo.png 1x, https://cdn.example.net/logo@2x.png?w=2&amp;q=80 2x" alt="">'
        + '<p>Besøk https://fjordbutikk.example.com/tilbud</p><a href="{{unsubscribeUrl}}">Meld deg av</a></body></html>',
    }),
    expect: [200],
  }],
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

test('only a send Brevo accepted marks unsubscribe links as out in mail (the safe-mode outbox does not)', async () => {
  const { rmSync, existsSync } = await import('node:fs');
  const marker = join(dataDir, unsub.RELAY_SENT_FILE);
  rmSync(marker, { force: true });
  brevoLib.setBrevoDeps({ env: { BREVO_API_KEY: 'fake-brevo-key-for-relay-tests' }, fetch: async () => new Response('{}', { status: 201 }) });
  installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, egress: false, log: null });
  try {
    const settings = settingsFor();
    const outbox = await relay.relaySend(SITES.shop, body(), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, log, quota: quotaFor(null, settings), env: { BREVO_API_KEY: 'fake-brevo-key-for-relay-tests' } } });
    assert.equal(outbox.body.mode, 'outbox');
    assert.equal(existsSync(marker), false, 'an outbox send is not delivered mail');
    assert.equal(unsub.relayHasSent(), false);
  } finally {
    resetSafeModeForTests();
    brevoLib.setBrevoDeps(null);
  }
  const settings = settingsFor();
  const sandbox = await relay.relaySend(SITES.shop, body(), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo: brevoStub({ mode: 'sandbox' }), log, quota: quotaFor(null, settings) } });
  assert.equal(sandbox.body.mode, 'sandbox');
  assert.equal(existsSync(marker), false, 'a sandbox send is dropped by Brevo');
  const accepted = await relay.relaySend(SITES.shop, body(), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo: brevoStub(), log, quota: quotaFor(null, settings) } });
  assert.equal(accepted.status, 200);
  assert.equal(unsub.relayHasSent(), true);
  assert.match(readFileSync(marker, 'utf8'), /"firstAcceptedAt":"2026-11-03T10:00:00.000Z"/);
});

test('the From name is the hub name for the site, cleaned; the brand name from the CMS stays in the body only', async () => {
  const settings = settingsFor();
  const brevo = brevoStub();
  const site = { ...SITES.shop, name: 'Fjord "Butikk" <post@example.com>\u0007' + 'x'.repeat(80) };
  const input = body({ brand: { name: 'Din Bank', accent: '#0F2A44' }, html: '<html><body><p>Hei</p></body></html>', text: 'Hei' });
  const result = await relay.relaySend(site, input, { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const name = brevo.calls[0].sender.name;
  assert.equal(name.includes('Din Bank'), false);
  assert.equal(/["<>\\\u0000-\u001f]/.test(name), false, name);
  assert.ok(name.startsWith('Fjord Butikk post@example.com x'), name);
  assert.ok(name.length <= 60, `${name.length}`);
  assert.match(brevo.calls[0].htmlContent, /Du får denne e-posten fra Din Bank/, 'the in-body brand is the CMS brand');
});

test('account, key, IP and rate refusals never add a global provider-blocked row; a 400 about the contact does', async () => {
  const settings = settingsFor();
  const refusals = [
    ['acct-401@example.com', 401, 'unauthorized', 'Your account is blocked'],
    ['acct-403@example.com', 403, 'permission_denied', 'Unrecognised IP address, blocked'],
    ['acct-400@example.com', 400, 'account_under_validation', 'Your account has been blocked'],
    ['acct-429@example.com', 429, 'too_many_requests', 'Blocked for too many requests'],
    ['sender-400@example.com', 400, 'invalid_parameter', 'Sender email is blocked'],
  ];
  for (const [email, status, brevoCode, brevoMessage] of refusals) {
    const error = new brevoLib.BrevoError('provider_rejected', { status, brevoCode, brevoMessage });
    const result = await relay.relaySend(SITES.shop, body({ to: { email } }), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo: brevoStub({ error }), log, quota: quotaFor(null, settings) } });
    assert.equal(result.status, 502, email);
    assert.equal(store.readEmailSuppressions()['*']?.[email], undefined, `${status} ${brevoMessage}: no global row`);
  }
  const contact = new brevoLib.BrevoError('provider_rejected', { status: 400, brevoCode: 'invalid_parameter', brevoMessage: 'The email address is blacklisted' });
  await relay.relaySend(SITES.shop, body({ to: { email: 'svartelistet@example.com' } }), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo: brevoStub({ error: contact }), log, quota: quotaFor(null, settings) } });
  assert.equal(store.readEmailSuppressions()['*']['svartelistet@example.com'].source, 'provider-blocked');
});

test('the markup scan stays linear on pathological input', () => {
  const settings = store.readEmailSettings();
  const inputs = [
    '<!--'.repeat(50_000),
    '<style>'.repeat(25_000),
    '<title><a b="'.repeat(15_000),
    'image-set('.repeat(20_000),
    'url('.repeat(40_000),
    '/*'.repeat(80_000),
    '&#'.repeat(80_000),
    `<a href="${' '.repeat(190_000)}">`,
    '='.repeat(50_000) + '//'.repeat(50_000),
    'https:'.repeat(30_000),
  ];
  for (const html of inputs) {
    const started = Date.now();
    relay.checkLinks(html, SITES.shop, { settings, text: html });
    assert.ok(Date.now() - started < 2000, `${html.slice(0, 12)}…: ${Date.now() - started} ms`);
  }
});

test('the tokenizer: comments, bogus comments, end tags and text-only elements', () => {
  const hrefs = (html) => relay.scanMarkup(html).tags.filter((t) => !t.hidden).flatMap((t) => t.attrs.filter(([n]) => n === 'href').map(([, v]) => v));
  assert.deepEqual(hrefs('<!--><a href="https://a.example.com/">'), ['https://a.example.com/'], '<!--> ends the comment at once');
  assert.deepEqual(hrefs('<!---><a href="https://a.example.com/">'), ['https://a.example.com/'], '<!---> too');
  assert.deepEqual(hrefs('<!-- x --!><a href="https://a.example.com/">'), ['https://a.example.com/'], '--!> ends a comment');
  assert.deepEqual(hrefs('<!-- x -- ><a href="https://a.example.com/">'), [], '-- > does not');
  assert.deepEqual(hrefs('<style>x</STYLE ><a href="https://a.example.com/">'), ['https://a.example.com/'], 'end tags match without regard to ASCII case');
  assert.deepEqual(hrefs('<style>x</styles><a href="https://a.example.com/">'), [], '</styles> does not end a style block');
  assert.deepEqual(hrefs('</><a href="https://a.example.com/">'), ['https://a.example.com/'], '</> is dropped');
  assert.deepEqual(hrefs('</ x="><a href="https://a.example.com/">'), ['https://a.example.com/'], '</ + space is a bogus comment up to the first >, quotes do not count');
  assert.deepEqual(hrefs('</p x="><a href=https://c.example.com/>"><a href="https://a.example.com/">'), ['https://a.example.com/'], 'an end tag reads its quoted attributes');
  const hidden = relay.scanMarkup('<!--[if mso]><a href="https://b.example.com/">x</a><![endif]-->').tags;
  assert.deepEqual(hidden.map((t) => [t.name, t.hidden === true]), [['a', true]], 'tags inside comments are scanned and marked hidden');
  assert.deepEqual(relay.scanMarkup('<!--[if mso]><noscript><xml></xml></noscript><![endif]-->').problems, [], 'refused elements inside comments are inert');
  assert.deepEqual(relay.scanMarkup('<noscript></noscript>').problems, [{ tag: 'noscript', reason: 'markup' }]);
});

const FOOTER_START = '<div style="margin-top:24px';

/** What follows the footer in the sent html (the footer cut out), or null without a footer. */
function afterFooter(html) {
  const at = html.indexOf(FOOTER_START);
  return at < 0 ? null : html.slice(at).replace(/^<div style="margin-top:24px[\s\S]*?<\/div>/, '');
}

test('the footer is added unless {{unsubscribeUrl}} is a visible link, and goes right before the real </body>', async () => {
  const settings = settingsFor();
  const cases = [
    ['only in a comment', '<html><body><p>Kjøp nå</p><!-- {{unsubscribeUrl}} --></body></html>', true],
    ['only in the title', '<html><head><title>{{unsubscribeUrl}}</title></head><body><p>Hei</p></body></html>', true],
    ['a link in a display:none block', '<html><body><div style="display: none"><a href="{{unsubscribeUrl}}">Meld deg av</a></div><p>Hei</p></body></html>', true],
    ['a link hidden from Outlook with mso-hide', '<html><body><p>Hei</p><a style="MSO-HIDE:ALL" href="{{unsubscribeUrl}}">x</a></body></html>', true],
    ['a link in an element with the hidden attribute', '<html><body><span hidden><a href="{{unsubscribeUrl}}">x</a></span><p>Hei</p></body></html>', true],
    ['a link inside an Outlook conditional comment only', '<html><body><!--[if mso]><a href="{{unsubscribeUrl}}">Meld deg av</a><![endif]--><p>Hei</p></body></html>', true],
    ['link text but not a link', '<html><body><p>Meld deg av: {{unsubscribeUrl}}</p></body></html>', true],
    ['a link inside a template element', '<html><body><template><a href="{{unsubscribeUrl}}">x</a></template><p>Hei</p></body></html>', true],
    ['an early </body> inside an Outlook conditional comment', '<html><body><p>Hei</p><!--[if mso]></body><![endif]--><p>Mer tekst</p></body></html>', true],
    ['a visible link', '<html><body><p>Hei</p><a href="{{unsubscribeUrl}}">Meld deg av</a></body></html>', false],
    ['a visible link after a closed hidden preheader', '<html><body><div style="display:none;max-height:0">Forhåndstekst</div><a href="{{unsubscribeUrl}}">Meld deg av</a></body></html>', false],
    ['a visible link in the non-Outlook branch', '<html><body><!--[if !mso]><!--><a href="{{unsubscribeUrl}}">Meld deg av</a><!--<![endif]--></body></html>', false],
    ['a visible link after an unclosed head', '<html><head><title>Hei</title><body><a href="{{unsubscribeUrl}}">Meld deg av</a></body></html>', false],
  ];
  for (const [name, html, footer] of cases) {
    const brevo = brevoStub();
    const result = await relay.relaySend(SITES.shop, body({ html, text: 'Hei {{unsubscribeUrl}}' }), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
    assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
    const out = brevo.calls[0].htmlContent;
    assert.equal(out.includes('{{unsubscribeUrl}}'), false, `${name}: the placeholder is replaced`);
    assert.equal(out.includes(FOOTER_START), footer, `${name}: footer ${footer ? 'added' : 'not added'}`);
    if (footer) assert.equal(afterFooter(out), '</body></html>', `${name}: the footer sits right before the real </body>, outside every comment`);
  }
  assert.equal(relay.unsubscribeLinkVisible('<a href="{{unsubscribeUrl}}">x</a>'), true, 'a fragment without body or head');
  assert.equal(relay.withFooterHtml('<p>Hei</p>', '<div>F</div>'), '<p>Hei</p><div>F</div>', 'without </body> the footer goes at the end');
});

test('nested URLs are found on the parsed URL: a backslash after the host, encoded slashes and protocol-relative values', async () => {
  const ctx = { site: SITES.shop, settings: store.readEmailSettings() };
  for (const href of [
    'https://fjordbutikk.example.com\\https://evil.example.net',
    'https://fjordbutikk.example.com/go?to=%2F%2Fevil.example.net',
    'https://fjordbutikk.example.com/go?to=%252F%252Fevil.example.net',
    'https://fjordbutikk.example.com/go?to=/\\evil.example.net',
    'https://fjordbutikk.example.com/go?to=%5C%5Cevil.example.net',
    'https://fjordbutikk.example.com/go?a=1&to=+%2F%2Fevil.example.net',
    'https://fjordbutikk.example.com//evil.example.net/',
    'https://fjordbutikk.example.com/#//evil.example.net',
  ]) {
    const verdict = relay.checkLinkUrl(href, ctx);
    assert.deepEqual([verdict.ok, verdict.reason], [false, 'nested_url'], href);
  }
  for (const href of [
    'https://fjordbutikk.example.com/kasse?c=1&ref=mail',
    'https://fjordbutikk.example.com/sok?q=sko+str%2F42',
    'https://fjordbutikk.example.com/a/b/#topp',
    'https://fjordbutikk.example.com/?next=/kasse',
  ]) assert.equal(relay.checkLinkUrl(href, ctx).ok, true, href);
  const image = relay.checkImageUrl('https://cdn.example.net\\https://evil.example.net/p.png', ctx);
  assert.deepEqual([image.ok, image.reason], [false, 'nested_url']);
  const settings = settingsFor();
  const brevo = brevoStub();
  const result = await relay.relaySend(SITES.shop, body({ html: '<html><body><a href="https://fjordbutikk.example.com\\https://evil.example.net">x</a> <a href="{{unsubscribeUrl}}">x</a></body></html>' }), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
  assert.deepEqual([result.status, result.body.code, result.body.reason], [422, 'link_not_allowed', 'nested_url']);
  assert.equal(brevo.calls.length, 0);
});

test('a ref with control characters never carries a line break into the provider header or the log', async () => {
  const settings = settingsFor();
  const brevo = brevoStub();
  const input = body({ ref: `int_crlf\r\nX-Other: 1${String.fromCharCode(0)}` });
  const result = await relay.relaySend(SITES.shop, input, { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(brevo.calls[0].headers.idempotencyKey, 'site_shop:cart-recovery:int_crlfX-Other: 1:1');
  const lines = readdirSync(join(dataDir, 'email-log')).filter((f) => f.startsWith('messages-'))
    .flatMap((f) => readFileSync(join(dataDir, 'email-log', f), 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l));
  const row = lines.find((l) => l.id === result.body.messageId);
  assert.equal(row.ref, 'int_crlfX-Other: 1');
  assert.equal(/[\r\n\x00]/.test(row.dedupeKey), false);
  const onlyControls = await relay.relaySend(SITES.shop, body({ ref: '\r\n' }), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
  assert.deepEqual([onlyControls.status, onlyControls.body.code], [400, 'bad_ref']);
});

test('an error after the quota ticket was taken gives the ticket and the recipient count back', async () => {
  const settings = settingsFor();
  const mem = memoryLedgerStore();
  const quota = createEmailQuota({ store: mem, settings: () => settings });
  const brevo = brevoStub();
  const broken = () => {
    throw Object.assign(new Error('the unsubscribe key cannot be read'), { code: 'EACCES' });
  };
  const result = await relay.relaySend(SITES.shop, body({ to: { email: 'feil@example.com' } }), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota, mintUnsubToken: broken } });
  assert.deepEqual([result.status, result.body.code], [500, 'internal']);
  assert.equal(brevo.calls.length, 0);
  assert.equal(mem.peek().total, 0, 'the ticket was given back');
  assert.deepEqual(mem.peek().byRecipient, {}, 'and the recipient count');
  const retry = await relay.relaySend(SITES.shop, body({ to: { email: 'feil@example.com' } }), { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota } });
  assert.equal(retry.status, 200, 'the next attempt sends');
});

test('the duplicate check holds across hub processes: a send another process has in progress is refused', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const settings = settingsFor();
  const inflightFile = join(dataDir, relay.RELAY_INFLIGHT_FILE);
  const input = body();
  const key = `site_shop:cart-recovery:${input.ref}:1`;
  // Another hub process takes the reservation and stops mid-send (it never releases it).
  const relayUrl = new URL('../lib/email-relay.js', import.meta.url).href;
  const child = `const m = await import(${JSON.stringify(relayUrl)}); const r = await m.reserveRelayDedupe(${JSON.stringify(key)}, { now: ${NOW} }); console.log(r ? 'held' : 'refused');`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, APP_DATA_DIR: dataDir }, encoding: 'utf8' }).trim(), 'held');
  const brevo = brevoStub();
  const held = await relay.relaySend(SITES.shop, input, { now: NOW + 1000, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
  assert.deepEqual([held.status, held.body.code], [409, 'duplicate']);
  assert.equal(brevo.calls.length, 0, 'no Brevo call while another process sends it');
  // Ten minutes on, the reservation of the stopped process no longer counts: the message goes out once.
  const later = NOW + relay.RELAY_RESERVATION_MS + 1;
  const sent = await relay.relaySend(SITES.shop, input, { now: later, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(inflightFile, 'utf8')), key), false, 'released after the log line');
  const again = await relay.relaySend(SITES.shop, input, { now: later, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
  assert.deepEqual([again.status, again.body.code], [409, 'duplicate'], 'the log line now dedupes it');
  assert.equal(brevo.calls.length, 1);
  // One holder at a time; a damaged reservation file only drops the reservations it held.
  const first = await relay.reserveRelayDedupe('site_shop:test:k1:', { now: NOW, log });
  assert.ok(first);
  assert.equal(await relay.reserveRelayDedupe('site_shop:test:k1:', { now: NOW, log }), null);
  await first.release();
  writeFileSync(inflightFile, '{not json');
  const afterDamage = await relay.reserveRelayDedupe('site_shop:test:k1:', { now: NOW, log });
  assert.ok(afterDamage, 'a damaged reservation file does not block sends');
  await afterDamage.release();
});

test('a provider failure releases the reservation, so the retry sends', async () => {
  const settings = settingsFor();
  const input = body();
  const down = await relay.relaySend(SITES.shop, input, { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo: brevoStub({ error: new brevoLib.BrevoError('provider_unavailable', { status: 503 }) }), log, quota: quotaFor(null, settings) } });
  assert.deepEqual([down.status, down.body.code], [502, 'provider_unavailable']);
  const brevo = brevoStub();
  const retry = await relay.relaySend(SITES.shop, input, { now: NOW, emailKey: KEYS.site_shop, deps: { settings, brevo, log, quota: quotaFor(null, settings) } });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(brevo.calls.length, 1);
});
