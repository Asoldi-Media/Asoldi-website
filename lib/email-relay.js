/**
 * relaySend: the hub's send pipeline for client-site email (CMS → hub → Brevo).
 *
 * Checks run in this order; the first failing one answers:
 *   1  x-email-key matches the site (current key, or the previous one inside its grace)  401 unauthorized
 *   2  Brevo is configured                                                               503 not_configured
 *   3  kill switch off / the opt-out record is readable                                  503 paused / suppressions_unavailable
 *   4  email on and the rollout lists the site / DPA accepted or attested (not for test) 403 not_enabled / dpa_missing
 *   5  the site is not suspended for this class                                          403 suspended
 *   6  the kind is entitled for the site                                                 403 not_entitled
 *   7  to.email is valid                                                                 400 bad_recipient
 *   8  html at most 200 KB, and html or text present                                     413 too_large / 400 empty_body
 *   9  subject 1-200 characters, ref present (every kind except test)                    400 bad_subject / bad_ref
 *   10 consent present (except test, double-opt-in, back-in-stock); campaign, winback and
 *      welcome need a grade other than 'unverified'                                      409 no_consent
 *   11 marketing kinds carry the sender identity block                                   422 sender_identity_missing
 *   12 every image is https on the site's hosts or an approved image host                422 image_not_allowed
 *   13 every link is mailto:/tel:, on the site's hosts or a path rule; no redirector and
 *      no nested http(s) URL anywhere in it                                              422 link_not_allowed
 *   14 test sends go only to a confirmed owner or a listed test recipient                403 test_recipient
 *   15 the address is not suppressed for this site and kind                              409 suppressed
 *   16 not a duplicate of siteId:kind:ref:step                                           409 duplicate
 *   17 per-recipient frequency (per site)                                                429 recipient_rate
 *   18 quota                                                                             429 quota / 503 quota_unavailable
 * Then the message gets its unsubscribe token, the footer when the template has no
 * {{unsubscribeUrl}}, https-only List-Unsubscribe plus List-Unsubscribe-Post, X-Mailin-custom,
 * an idempotency key and tags; it goes to Brevo (or the safe-mode outbox) and one log line is
 * appended. A Brevo refusal gives the quota back; a blocked-contact refusal adds a global
 * provider-blocked row. The heartbeat adminUrl is never consulted.
 */
import { EMAIL_FILES, readEmailSettings, readEmailSite, readJson, withFileLock, writeJsonAtomic } from '../data/email-store.js';
import * as brevoClient from './brevo.js';
import { emailKindsFor } from './email-feature-keys.js';
import * as emailLog from './email-log.js';
import { createEmailQuota } from './email-quota.js';
import { emailPlatformEnabled, findSiteByEmailKey, siteInRollout } from './email-site-auth.js';
import { addSuppression, mintUnsubToken, noteGlobalRowSite, suppressionFor, suppressionsAvailable } from './email-unsubscribe.js';
import { resolveOwnerRecipients } from './owner-recipients.js';
import { enrollProofOrigin } from './site-credentials.js';

export const KIND_CLASS = Object.freeze({
  'cart-recovery': 'p1',
  'back-in-stock': 'p1',
  test: 'p1',
  'double-opt-in': 's',
  welcome: 's',
  'review-request': 'p2',
  winback: 'p2',
  campaign: 'p3',
});
const NO_CONSENT_KINDS = new Set(['test', 'double-opt-in', 'back-in-stock']);
const VERIFIED_CONSENT_KINDS = new Set(['campaign', 'winback', 'welcome']);
const NO_SENDER_KINDS = new Set(['test', 'double-opt-in']);
/** Kinds counted against the per-recipient daily cap (consented marketing). */
const FREQUENCY_KINDS = new Set(['welcome', 'cart-recovery', 'review-request', 'winback', 'campaign']);
const PLACEHOLDERS = new Set(['{{unsubscribeUrl}}', '{{preferencesUrl}}']);
export const MAX_HTML_BYTES = 200 * 1024;
export const MAX_SUBJECT = 200;
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;
const DEFAULT_PUBLIC_BASE = 'https://asoldi.com';
const BRAND_WRITE_EVERY_MS = 60_000;

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(status, code, extra = {}) {
  return { status, body: { ok: false, code, ...extra } };
}

/* ------------------------------------------------------------------ hosts and link rules */

function bareHost(value) {
  return clean(value, 300).toLowerCase().replace(/\.$/, '');
}

/** The site's own hosts: its domain and the www variant. */
export function siteHosts(site) {
  const origin = enrollProofOrigin(site?.domain);
  if (!origin) return [];
  const host = bareHost(new URL(origin).hostname);
  const apex = host.startsWith('www.') ? host.slice(4) : host;
  return [apex, `www.${apex}`];
}

function normalizedHostList(list) {
  return (Array.isArray(list) ? list : []).map((entry) => {
    const text = clean(entry, 300);
    try {
      return bareHost(new URL(text.includes('://') ? text : `https://${text}`).hostname);
    } catch {
      return '';
    }
  }).filter(Boolean);
}

function allowedLinkHosts(site, emailSite) {
  return new Set([...siteHosts(site), ...normalizedHostList(emailSite?.allowHosts)]);
}

function allowedImageHosts(site, emailSite, settings) {
  return new Set([
    ...allowedLinkHosts(site, emailSite),
    ...normalizedHostList(emailSite?.allowImageHosts),
    ...normalizedHostList(settings?.links?.imageHosts),
  ]);
}

function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16) || 0))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10) || 0))
    .replace(/&colon;/gi, ':')
    .replace(/&sol;/gi, '/')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** True when the text, raw or percent-decoded up to twice, carries an http(s) URL. */
function carriesNestedUrl(text) {
  let current = String(text || '');
  for (let i = 0; i < 3; i += 1) {
    if (/https?:\/\//i.test(current) || /https?:\\\/\\\//i.test(current) || /https?%3a/i.test(current)) return true;
    const next = safeDecode(current.replace(/\+/g, ' '));
    if (next === current) break;
    current = next;
  }
  return false;
}

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') out += '.*';
    else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i + 1) {
        out += `[${glob.slice(i + 1, end).replace(/[\\^]/g, '\\$&')}]`;
        i = end;
      } else out += '\\[';
    } else out += ch.replace(/[.+?^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function pathMatches(globs, path) {
  return (Array.isArray(globs) ? globs : []).some((glob) => globToRegExp(String(glob)).test(path));
}

function hostDenied(host, denyHosts) {
  return (Array.isArray(denyHosts) ? denyHosts : []).some((entry) => {
    const deny = bareHost(entry);
    return deny && (host === deny || host.endsWith(`.${deny}`));
  });
}

function pathDenied(host, path, denyPaths) {
  return (Array.isArray(denyPaths) ? denyPaths : []).some((entry) => {
    const text = clean(entry, 300).toLowerCase();
    const slash = text.indexOf('/');
    if (slash <= 0) return false;
    const denyHost = text.slice(0, slash);
    const denyPath = text.slice(slash);
    return host === denyHost && path.toLowerCase().startsWith(denyPath);
  });
}

/** Verdict for one link (href). { ok, reason, host }. */
export function checkLinkUrl(raw, { site, emailSite = null, settings = null } = {}) {
  const href = decodeEntities(clean(raw, 4000)).trim();
  if (!href) return { ok: false, reason: 'empty', host: '' };
  if (PLACEHOLDERS.has(href)) return { ok: true, reason: 'placeholder', host: '' };
  if (href.startsWith('#')) return { ok: true, reason: 'fragment', host: '' };
  if (/^(mailto|tel):/i.test(href)) return { ok: true, reason: 'contact', host: '' };
  let url;
  try {
    url = new URL(href);
  } catch {
    return { ok: false, reason: 'relative', host: '' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'scheme', host: '' };
  const host = bareHost(url.hostname);
  if (url.username || url.password) return { ok: false, reason: 'credentials', host };
  const rest = href.slice(href.indexOf('//') + 2);
  const afterHost = rest.slice(Math.max(0, rest.search(/[/?#]/)) || rest.length);
  if (carriesNestedUrl(afterHost)) return { ok: false, reason: 'nested_url', host };
  const links = settings?.links || {};
  if (hostDenied(host, links.denyHosts)) return { ok: false, reason: 'redirector', host };
  if (pathDenied(host, url.pathname, links.denyPaths)) return { ok: false, reason: 'redirector', host };
  if (allowedLinkHosts(site, emailSite).has(host)) return { ok: true, reason: 'site', host };
  for (const rule of Array.isArray(links.rules) ? links.rules : []) {
    if (bareHost(rule?.host) !== host) continue;
    if (pathMatches(rule.deny, url.pathname)) return { ok: false, reason: 'rule_denied', host };
    if (pathMatches(rule.paths, url.pathname)) return { ok: true, reason: 'rule', host };
    return { ok: false, reason: 'rule_path', host };
  }
  return { ok: false, reason: 'host_not_allowed', host };
}

/** Verdict for one image URL. { ok, reason, host }. */
export function checkImageUrl(raw, { site, emailSite = null, settings = null } = {}) {
  const src = decodeEntities(clean(raw, 4000)).trim();
  let url;
  try {
    url = new URL(src);
  } catch {
    return { ok: false, reason: 'relative', host: '' };
  }
  const host = bareHost(url.hostname);
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme', host };
  if (url.username || url.password) return { ok: false, reason: 'credentials', host };
  const rest = src.slice(src.indexOf('//') + 2);
  const afterHost = rest.slice(Math.max(0, rest.search(/[/?#]/)) || rest.length);
  if (carriesNestedUrl(afterHost)) return { ok: false, reason: 'nested_url', host };
  if (!allowedImageHosts(site, emailSite, settings).has(host)) return { ok: false, reason: 'host_not_allowed', host };
  return { ok: true, reason: 'allowed', host };
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi;
const LINK_ATTRS = new Set(['href', 'xlink:href', 'action', 'formaction']);
const IMAGE_ATTRS = new Set(['src', 'background', 'poster']);
const SPACE = new Set([' ', '\t', '\n', '\r', '\f']);

/**
 * Start tags with their attributes, read the way an HTML tokenizer reads them: quotes only open
 * right after '=', so a '>' inside a quoted value never ends the tag. One pass, linear time.
 */
export function scanTags(html) {
  const source = String(html || '');
  const n = source.length;
  const tags = [];
  let i = 0;
  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    let j = lt + 1;
    if (!/[A-Za-z]/.test(source[j] || '')) {
      i = j;
      continue;
    }
    while (j < n && !SPACE.has(source[j]) && source[j] !== '>' && source[j] !== '/') j += 1;
    const tag = { name: source.slice(lt + 1, j).toLowerCase(), attrs: [] };
    while (j < n && source[j] !== '>') {
      if (SPACE.has(source[j]) || source[j] === '/') {
        j += 1;
        continue;
      }
      const nameStart = j;
      while (j < n && !SPACE.has(source[j]) && source[j] !== '>' && source[j] !== '/' && !(source[j] === '=' && j > nameStart)) j += 1;
      const name = source.slice(nameStart, j).toLowerCase();
      let k = j;
      while (k < n && SPACE.has(source[k])) k += 1;
      let value = '';
      if (source[k] === '=') {
        k += 1;
        while (k < n && SPACE.has(source[k])) k += 1;
        const quote = source[k];
        if (quote === '"' || quote === "'") {
          const end = source.indexOf(quote, k + 1);
          value = source.slice(k + 1, end < 0 ? n : end);
          k = end < 0 ? n : end + 1;
        } else {
          const start = k;
          while (k < n && !SPACE.has(source[k]) && source[k] !== '>') k += 1;
          value = source.slice(start, k);
        }
        j = k;
      }
      if (name) tag.attrs.push([name, value]);
    }
    tags.push(tag);
    i = j + 1;
  }
  return tags;
}

/**
 * Every link and image reference in the HTML (and bare URLs in the text part):
 * [{ kind: 'link'|'image', url, ok, reason, host }].
 */
export function checkLinks(html, site, { emailSite = null, settings = null, text = '' } = {}) {
  const ctx = { site, emailSite, settings };
  const out = [];
  const source = String(html || '');
  for (const tag of scanTags(source)) {
    for (const [attrName, value] of tag.attrs) {
      if (LINK_ATTRS.has(attrName)) out.push({ kind: 'link', url: value, ...checkLinkUrl(value, ctx), tag: tag.name });
      else if (IMAGE_ATTRS.has(attrName)) out.push({ kind: 'image', url: value, ...checkImageUrl(value, ctx), tag: tag.name });
      else if (attrName === 'srcset') {
        for (const part of value.split(',')) {
          const url = part.trim().split(/\s+/)[0];
          if (url) out.push({ kind: 'image', url, ...checkImageUrl(url, ctx), tag: tag.name });
        }
      }
    }
  }
  for (const match of source.matchAll(CSS_URL_RE)) out.push({ kind: 'image', url: match[2], ...checkImageUrl(match[2], ctx), tag: 'css' });
  for (const match of source.matchAll(CSS_IMPORT_RE)) out.push({ kind: 'image', url: match[2], ...checkImageUrl(match[2], ctx), tag: 'css' });
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"')]+/gi)) out.push({ kind: 'link', url: match[0], ...checkLinkUrl(match[0], ctx), tag: 'text' });
  return out;
}

/* ------------------------------------------------------------------ body checks */

function consentProblem(kind, consent) {
  if (NO_CONSENT_KINDS.has(kind)) return '';
  if (!isPlainObject(consent) || !clean(consent.basis, 40)) return 'missing';
  if (VERIFIED_CONSENT_KINDS.has(kind) && clean(consent.grade, 40).toLowerCase() === 'unverified') return 'unverified';
  return '';
}

function senderIdentityComplete(sender) {
  if (!isPlainObject(sender)) return false;
  const legal = clean(sender.legalName, 200);
  const id = clean(sender.orgNumber, 40) || clean(sender.personalName, 200);
  return Boolean(legal && id && clean(sender.address, 300) && EMAIL_RE.test(clean(sender.email, 320)));
}

/** Kinds the site may send (legacy flags, or the feature tree through deps.entitledKeys). */
export function entitledKinds(site, settings, { entitledKeys = null } = {}) {
  const brevo = settings?.brevo || {};
  const campaignsAllowed = brevo.planTier !== 'free' || brevo.campaignsOnFree === true;
  let entitled = null;
  if (typeof entitledKeys === 'function') {
    try {
      entitled = entitledKeys(site) || null;
    } catch {
      entitled = null;
    }
  }
  return emailKindsFor({ entitled, legacyFeatures: site?.features || {}, campaignsAllowed }).kinds;
}

function confirmedOwners(site, emailSite, getSalesClients) {
  const owner = resolveOwnerRecipients(site, { emailSite, getSalesClients });
  return owner.source === 'ownerRecipients' || owner.source === 'clientAdmin' ? owner.recipients : [];
}

function suspendedFor(emailSite, cls) {
  const suspended = emailSite?.suspended;
  if (!suspended) return false;
  if (isPlainObject(suspended) && Array.isArray(suspended.classes) && suspended.classes.length) return suspended.classes.includes(cls);
  return true;
}

function dpaOk(emailSite) {
  const dpa = emailSite?.dpa || {};
  return Boolean(clean(dpa.acceptedAt, 40) || clean(dpa.attestedBy, 120));
}

/* ------------------------------------------------------------------ message building */

export function publicBaseUrl(env = process.env) {
  const raw = clean(env?.APP_URL, 300).replace(/\/+$/, '');
  return /^https:\/\/[^/\s]+$/.test(raw) ? raw : DEFAULT_PUBLIC_BASE;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FOOTER_REASON = {
  nb: {
    'cart-recovery': 'fordi du startet et kjøp hos oss',
    'back-in-stock': 'fordi du ba om beskjed når varen kom tilbake',
    'review-request': 'fordi du har handlet hos oss',
    winback: 'fordi du har sagt ja til e-post fra oss',
    welcome: 'fordi du meldte deg på nyhetsbrevet vårt',
    campaign: 'fordi du har sagt ja til e-post fra oss',
    'double-opt-in': 'fordi adressen ble meldt på nyhetsbrevet vårt',
    test: 'som en test',
  },
  en: {
    'cart-recovery': 'because you started a purchase with us',
    'back-in-stock': 'because you asked to hear when the item is back',
    'review-request': 'because you shopped with us',
    winback: 'because you agreed to receive email from us',
    welcome: 'because you signed up for our newsletter',
    campaign: 'because you agreed to receive email from us',
    'double-opt-in': 'because this address was signed up for our newsletter',
    test: 'as a test',
  },
};

function senderLines(sender) {
  if (!isPlainObject(sender)) return [];
  const id = clean(sender.orgNumber, 40) ? `Org.nr. ${clean(sender.orgNumber, 40)}` : clean(sender.personalName, 200);
  return [clean(sender.legalName, 200), id, clean(sender.address, 300), clean(sender.email, 320)].filter(Boolean);
}

function footerFor({ kind, shop, unsubUrl, sender, lang }) {
  const nb = lang !== 'en';
  const reason = (nb ? FOOTER_REASON.nb : FOOTER_REASON.en)[kind] || (nb ? 'fordi du har kontakt med oss' : 'because you are in touch with us');
  const lead = nb ? `Du får denne e-posten fra ${shop} ${reason}.` : `You receive this email from ${shop} ${reason}.`;
  const unsub = nb ? 'Meld deg av' : 'Unsubscribe';
  const lines = NO_SENDER_KINDS.has(kind) ? [] : senderLines(sender);
  const html = `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #ddd;font:12px/1.5 sans-serif;color:#666">${escapeHtml(lead)} <a href="${escapeHtml(unsubUrl)}" style="color:#666">${escapeHtml(unsub)}</a>${lines.length ? `<br>${lines.map(escapeHtml).join(' · ')}` : ''}</div>`;
  const text = `\n\n--\n${lead}\n${unsub}: ${unsubUrl}${lines.length ? `\n${lines.join(' · ')}` : ''}\n`;
  return { html, text };
}

function withFooterHtml(html, footer) {
  if (!html) return html;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${footer}</body>`);
  return `${html}${footer}`;
}

function replacePlaceholders(value, unsubUrl) {
  return String(value).split('{{unsubscribeUrl}}').join(unsubUrl).split('{{preferencesUrl}}').join(unsubUrl);
}

function fromAddress(emailSite, settings) {
  const sender = emailSite?.sender || {};
  if (sender.mode === 'client-domain' && clean(sender.brevoDomainVerifiedAt, 40) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean(sender.domain, 253))) {
    return `post@${clean(sender.domain, 253).toLowerCase()}`;
  }
  return clean(settings?.sender?.defaultAddress, 320) || 'kunder@asoldi.com';
}

/* ------------------------------------------------------------------ brand cache */

const brandWrites = new Map();

async function rememberBrand(siteId, { name, accent, lang }, now) {
  const last = brandWrites.get(siteId) || 0;
  if (now - last < BRAND_WRITE_EVERY_MS) return;
  brandWrites.set(siteId, now);
  try {
    await withFileLock(EMAIL_FILES.brandCache, () => {
      const cache = readJson(EMAIL_FILES.brandCache, {}) || {};
      const next = { name: clean(name, 120), accent: /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(clean(accent, 20)) ? clean(accent, 20) : '', lang: clean(lang, 5) === 'en' ? 'en' : 'nb' };
      const prev = cache[siteId] || {};
      if (prev.name === next.name && prev.accent === next.accent && prev.lang === next.lang) return;
      cache[siteId] = { ...next, updatedAt: new Date(now).toISOString() };
      writeJsonAtomic(EMAIL_FILES.brandCache, cache);
    });
  } catch (error) {
    console.warn('[email-relay] brand cache write failed:', error?.code || 'error');
  }
}

/* ------------------------------------------------------------------ the pipeline */

const inflight = new Set();

function looksBlocked(error) {
  const text = `${error?.brevoCode || ''} ${error?.brevoMessage || ''}`.toLowerCase();
  return /\bblock(ed)?\b|blacklist/.test(text);
}

/**
 * Sends one email for a site. Resolves { status, body } and never throws.
 * options: now, emailKey (the presented x-email-key; checked here unless authenticated:true),
 * deps: { settings, quota, log, brevo, env, entitledKeys, getSalesClients }.
 */
export async function relaySend(site, body = {}, { now = Date.now(), emailKey = '', authenticated = false, deps = {} } = {}) {
  try {
    return await runRelay(site, isPlainObject(body) ? body : {}, { now, emailKey, authenticated, deps });
  } catch (error) {
    console.error('[email-relay] send failed:', error?.code || error?.message || 'error');
    return fail(500, 'internal');
  }
}

async function runRelay(site, body, { now, emailKey, authenticated, deps }) {
  const siteId = clean(site?.id, 80);
  // 1
  if (!authenticated) {
    const match = findSiteByEmailKey(emailKey, { now });
    if (!match || !siteId || match.siteId !== siteId) return fail(401, 'unauthorized');
  }
  const settings = deps.settings || readEmailSettings();
  const env = deps.env || process.env;
  const brevo = deps.brevo || brevoClient;
  const log = deps.log || emailLog;
  const quota = deps.quota || createEmailQuota();
  // 2
  if (!brevo.brevoConfigured({ env })) return fail(503, 'not_configured');
  // 3
  if (settings.killSwitch === true) return fail(503, 'paused');
  if (!suppressionsAvailable()) return fail(503, 'suppressions_unavailable');
  let emailSite;
  try {
    emailSite = readEmailSite(siteId);
  } catch {
    return fail(503, 'paused');
  }
  const kind = clean(body.kind, 40);
  const cls = KIND_CLASS[kind] || '';
  // 4
  if (!emailPlatformEnabled(settings) || !siteInRollout(siteId, settings)) return fail(403, 'not_enabled');
  if (kind !== 'test' && !dpaOk(emailSite)) return fail(403, 'dpa_missing');
  // 5
  if (cls && suspendedFor(emailSite, cls)) return fail(403, 'suspended');
  // 6
  if (!cls || !entitledKinds(site, settings, { entitledKeys: deps.entitledKeys }).includes(kind)) return fail(403, 'not_entitled');
  // 7
  const to = clean(body.to?.email ?? body.to, 320).toLowerCase();
  if (!EMAIL_RE.test(to)) return fail(400, 'bad_recipient');
  // 8
  const html = typeof body.html === 'string' ? body.html : '';
  const text = typeof body.text === 'string' ? body.text : '';
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) return fail(413, 'too_large');
  if (!html.trim() && !text.trim()) return fail(400, 'empty_body');
  // 9
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  if (!subject || subject.length > MAX_SUBJECT) return fail(400, 'bad_subject');
  const ref = clean(body.ref, 120);
  if (kind !== 'test' && !ref) return fail(400, 'bad_ref');
  // 10
  const consentIssue = consentProblem(kind, body.consent);
  if (consentIssue) return fail(409, 'no_consent', { reason: consentIssue });
  // 11
  if (!NO_SENDER_KINDS.has(kind) && !senderIdentityComplete(body.sender)) return fail(422, 'sender_identity_missing');
  // 12, 13
  const verdicts = checkLinks(html, site, { emailSite, settings, text });
  const badImage = verdicts.find((v) => v.kind === 'image' && !v.ok);
  if (badImage) return fail(422, 'image_not_allowed', { host: badImage.host, reason: badImage.reason });
  const badLink = verdicts.find((v) => v.kind === 'link' && !v.ok);
  if (badLink) return fail(422, 'link_not_allowed', { host: badLink.host, reason: badLink.reason });
  // 14
  if (kind === 'test') {
    const allowed = new Set([
      ...confirmedOwners(site, emailSite, deps.getSalesClients),
      ...(Array.isArray(settings.testRecipients) ? settings.testRecipients : []).map((e) => clean(e, 320).toLowerCase()),
    ]);
    if (!allowed.has(to)) return fail(403, 'test_recipient');
  }
  // 15
  let suppression;
  try {
    suppression = suppressionFor(siteId, to, kind);
  } catch {
    return fail(503, 'suppressions_unavailable');
  }
  if (suppression.suppressed) {
    if (suppression.where === '*') noteGlobalRowSite(siteId, to).catch(() => {});
    return fail(409, 'suppressed');
  }
  // 16
  const step = Number.isFinite(Number(body.step)) ? Number(body.step) : null;
  const messageId = emailLog.newMessageId(now);
  const dedupeKey = kind === 'test' && !ref ? `${siteId}:test:${messageId}` : `${siteId}:${kind}:${ref}:${step ?? ''}`;
  if (inflight.has(dedupeKey) || log.hasDedupeKey(dedupeKey)) return fail(409, 'duplicate');
  inflight.add(dedupeKey);
  try {
    // 17, 18
    let ticket;
    try {
      ticket = await quota.tryAcquire({
        siteId,
        cls,
        now,
        kind,
        recipientHash: emailLog.hashEmail(to),
        marketing: FREQUENCY_KINDS.has(kind),
        campaign: kind === 'campaign',
      });
    } catch (error) {
      return fail(503, error?.code === 'quota_unavailable' ? 'quota_unavailable' : 'quota_unavailable');
    }
    if (!ticket.ok) return fail(429, ticket.code, { retryAt: ticket.retryAt });

    const lang = clean(body.lang, 5) === 'en' ? 'en' : 'nb';
    const shop = clean(body.brand?.name, 120) || clean(site?.name, 120) || clean(site?.domain, 120);
    const token = mintUnsubToken({ siteId, email: to, kind, messageId, scope: 'marketing' });
    const unsubUrl = `${publicBaseUrl(env)}/api/hub/email/unsubscribe?t=${token}`;
    const footer = footerFor({ kind, shop, unsubUrl, sender: body.sender, lang });
    let htmlOut = html;
    if (htmlOut) htmlOut = htmlOut.includes('{{unsubscribeUrl}}') ? replacePlaceholders(htmlOut, unsubUrl) : withFooterHtml(replacePlaceholders(htmlOut, unsubUrl), footer.html);
    let textOut = text;
    if (textOut) textOut = textOut.includes('{{unsubscribeUrl}}') ? replacePlaceholders(textOut, unsubUrl) : `${replacePlaceholders(textOut, unsubUrl)}${footer.text}`;
    const replyTo = EMAIL_RE.test(clean(body.replyTo, 320)) ? clean(body.replyTo, 320).toLowerCase() : (confirmedOwners(site, emailSite, deps.getSalesClients)[0] || '');
    const payload = {
      sender: { name: `${shop}${clean(settings.sender?.nameSuffix, 60)}`, email: fromAddress(emailSite, settings) },
      to: [{ email: to, ...(clean(body.to?.name, 120) ? { name: clean(body.to.name, 120) } : {}) }],
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
      subject,
      htmlContent: htmlOut,
      textContent: textOut,
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'X-Mailin-custom': `site:${siteId}|${kind}|${messageId}`,
        idempotencyKey: dedupeKey,
      },
      tags: ['cms', siteId, kind],
    };
    const logRow = {
      id: messageId,
      siteId,
      kind,
      cls,
      ref,
      step,
      campaignId: body.campaignId ? clean(body.campaignId, 80) : null,
      dedupeKey,
      to,
      provider: 'brevo',
      consent: isPlainObject(body.consent) ? body.consent : null,
      test: kind === 'test',
      createdAt: new Date(now).toISOString(),
    };
    let sent;
    try {
      sent = await brevo.sendBrevoEmail(payload, { settings });
    } catch (error) {
      await quota.release(ticket.ticket, { now }).catch(() => {});
      const code = error?.code || 'provider_unavailable';
      if (code === 'provider_rejected') {
        safeAppend(log, { ...logRow, status: 'rejected', error: error.brevoCode || String(error.status || '') });
        if (looksBlocked(error)) {
          await addSuppression({ siteId, email: to, global: true, source: 'provider-blocked', now, extra: { brevoReason: clean(error.brevoCode || 'blocked', 60) } }).catch(() => {});
        }
        return fail(502, 'provider_rejected', { brevoCode: error.brevoCode || '' });
      }
      if (code === 'not_configured') return fail(503, 'not_configured');
      if (code === 'one_recipient_per_call' || code === 'bad_recipient') return fail(400, 'bad_recipient');
      safeAppend(log, { ...logRow, status: 'failed', error: code });
      return fail(502, 'provider_unavailable');
    }
    const status = sent.mode === 'outbox' ? 'outbox' : sent.mode === 'sandbox' ? 'sandbox' : 'accepted';
    safeAppend(log, { ...logRow, providerMessageId: sent.providerMessageId || '', status });
    rememberBrand(siteId, { name: shop, accent: body.brand?.accent, lang }, now);
    return {
      status: 200,
      body: { ok: true, messageId, ...(status !== 'accepted' ? { mode: status } : {}), quota: { siteRemaining: ticket.remaining, pool: ticket.pool } },
    };
  } finally {
    inflight.delete(dedupeKey);
  }
}

function safeAppend(log, row) {
  try {
    log.appendMessage(row);
  } catch (error) {
    console.error('[email-relay] message log append failed:', error?.code || 'error');
  }
}
