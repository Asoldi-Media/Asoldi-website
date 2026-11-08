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
 *   12 no script, noscript, iframe, SVG, MathML, plug-in or other refused element and no
 *      meta refresh (the markup a tokenizer could read differently)                      422 link_not_allowed (reason markup)
 *      every image is https on the site's hosts or an approved image host                422 image_not_allowed
 *   13 every link is mailto:/tel:, on the site's hosts or a path rule; no redirector and
 *      no nested http(s) URL anywhere in it. Tags inside comments, style, title and
 *      textarea are checked too, and so is every absolute URL anywhere in the HTML       422 link_not_allowed
 *   14 test sends go only to a confirmed owner or a listed test recipient                403 test_recipient
 *   15 the address is not suppressed for this site and kind                              409 suppressed
 *   16 not a duplicate of siteId:kind:ref:step                                           409 duplicate
 *   17 per-recipient frequency (per site)                                                429 recipient_rate
 *   18 quota                                                                             429 quota / 503 quota_unavailable
 * Then the message gets its unsubscribe token, the footer unless the template shows a visible
 * {{unsubscribeUrl}} link (unsubscribeLinkVisible), https-only List-Unsubscribe plus
 * List-Unsubscribe-Post, X-Mailin-custom, an idempotency key and tags; it goes to Brevo (or the
 * safe-mode outbox) and one log line is appended. The From name is the hub's name for the site,
 * never the CMS's brand name. A Brevo refusal, or any error before Brevo accepted the message,
 * gives the quota back; a 400 that says this contact is blocked adds a global provider-blocked row
 * (account-level refusals never do). The heartbeat adminUrl is never consulted.
 *
 * The duplicate check holds across hub processes: the dedupe key is reserved in
 * email-relay-inflight.json under a file lock until the message's log line is written
 * (reserveRelayDedupe). `ref` loses every control character before it is used, so it never
 * carries a line break into a provider header.
 */
import { EMAIL_FILES, readEmailSettings, readEmailSite, readJson, withFileLock, writeJsonAtomic } from '../data/email-store.js';
import * as brevoClient from './brevo.js';
import { dpaAccepted, emailKindsForSite, fromAddress, senderDisplayName } from './email-site-config.js';
import * as emailLog from './email-log.js';
import { createEmailQuota } from './email-quota.js';
import { emailPlatformEnabled, findSiteByEmailKey, siteInRollout } from './email-site-auth.js';
import {
  addSuppression,
  applyPendingSuppressions,
  mintUnsubToken,
  noteGlobalRowSite,
  noteRelaySent,
  pendingSuppressionsExist,
  suppressionFor,
  suppressionsAvailable,
} from './email-unsubscribe.js';
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

/** Control characters (C0, DEL, C1, line and paragraph separators) removed. */
export function withoutControls(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/gu, '');
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

/** Named references (HTML names, case as written) that can rebuild a scheme, host or separator. */
const NAMED_ENTITIES = new Map(Object.entries({
  colon: ':', sol: '/', bsol: '\\', period: '.', commat: '@', quest: '?', num: '#', percnt: '%', equals: '=',
  plus: '+', comma: ',', semi: ';', excl: '!', lpar: '(', rpar: ')', lowbar: '_', Tab: '\t', NewLine: '\n',
  quot: '"', QUOT: '"', apos: "'", lt: '<', LT: '<', gt: '>', GT: '>',
}));

function codePointText(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
}

/** Character references decoded once: numeric, the named ones above, then &amp;. */
function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => codePointText(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => codePointText(Number.parseInt(dec, 10)))
    .replace(/&([A-Za-z]+);/g, (whole, name) => NAMED_ENTITIES.get(name) ?? whole)
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

/** True when the value, trimmed, raw or percent-decoded up to twice, starts with two slashes or backslashes. */
function startsProtocolRelative(value) {
  let current = String(value || '');
  for (let i = 0; i < 3; i += 1) {
    const flat = current.replace(/[\t\n\r]/g, '').trim();
    if (/^[\\/]{2}/.test(flat) || /^https?:/i.test(flat)) return true;
    const next = safeDecode(current);
    if (next === current) break;
    current = next;
  }
  return false;
}

/**
 * The nested-URL rule on a parsed URL (the parser turns a backslash after the host into a slash
 * and keeps percent-encoded slashes): an http(s) URL anywhere in its path, query or fragment; a
 * path that starts with '//'; or a query value or fragment that starts with two slashes or
 * backslashes (a protocol-relative address), raw or percent-decoded.
 */
function nestedInParsedUrl(url) {
  if (carriesNestedUrl(`${url.pathname}${url.search}${url.hash}`)) return true;
  if (url.pathname.startsWith('//') || startsProtocolRelative(url.pathname)) return true;
  for (const value of url.searchParams.values()) if (startsProtocolRelative(value)) return true;
  for (const part of url.search.replace(/^\?/, '').split('&')) {
    const eq = part.indexOf('=');
    if (startsProtocolRelative(eq >= 0 ? part.slice(eq + 1) : part)) return true;
  }
  return startsProtocolRelative(url.hash.replace(/^#/, ''));
}

/** The raw text after the host (as written) or the parsed URL carries another URL. */
function nestedUrl(raw, url) {
  const rest = raw.slice(raw.indexOf('//') + 2);
  const afterHost = rest.slice(Math.max(0, rest.search(/[/?#]/)) || rest.length);
  return carriesNestedUrl(afterHost) || nestedInParsedUrl(url);
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
  if (nestedUrl(href, url)) return { ok: false, reason: 'nested_url', host };
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
  if (nestedUrl(src, url)) return { ok: false, reason: 'nested_url', host };
  if (!allowedImageHosts(site, emailSite, settings).has(host)) return { ok: false, reason: 'host_not_allowed', host };
  return { ok: true, reason: 'allowed', host };
}

/* ------------------------------------------------------------------ markup scanner */

const SPACE = new Set([' ', '\t', '\n', '\r', '\f']);
/** Elements whose content an HTML tokenizer reads as text up to the matching end tag. */
const OPAQUE_ELEMENTS = new Set(['style', 'title', 'textarea']);
const OPAQUE_END = new Map([...OPAQUE_ELEMENTS].map((name) => [name, new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi')]));
/**
 * Elements refused outright (422 link_not_allowed, reason 'markup'). Scripts and the other text-only
 * elements whose end a parser finds by rules that depend on scripting or nesting; SVG and MathML,
 * where the tokenizer rules change; embedded documents and plug-ins. Mail clients drop them all,
 * so a mail template never needs one.
 */
const REFUSED_ELEMENTS = new Set(['script', 'noscript', 'plaintext', 'xmp', 'iframe', 'noembed', 'noframes', 'svg', 'math', 'object', 'embed', 'applet', 'frame', 'frameset', 'portal']);
const COMMENT_END = /--!?>/g;
const LINK_ATTRS = new Set(['href', 'action', 'formaction', 'cite', 'longdesc', 'manifest']);
const LINK_LIST_ATTRS = new Set(['ping']);
const IMAGE_ATTRS = new Set(['src', 'background', 'poster', 'lowsrc', 'dynsrc']);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
/** Hosts of XML namespace and DTD identifiers (xmlns="http://www.w3.org/1999/xhtml"), never fetched. */
const IDENTIFIER_HOSTS = new Set(['www.w3.org', 'w3.org', 'schemas.microsoft.com']);

function isAsciiAlpha(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function asciiLower(text) {
  return text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * One tag from the character after '<' (or '</'): its name and attributes, read as the HTML
 * tokenizer reads them (quotes only open a value right after '=', so a '>' inside a quoted value
 * never ends the tag). Returns { name, attrs, end } with end at the closing '>' (or the input end).
 */
function readTag(source, from) {
  const n = source.length;
  let j = from;
  while (j < n && !SPACE.has(source[j]) && source[j] !== '>' && source[j] !== '/') j += 1;
  const name = asciiLower(source.slice(from, j));
  const attrs = [];
  while (j < n && source[j] !== '>') {
    if (SPACE.has(source[j]) || source[j] === '/') {
      j += 1;
      continue;
    }
    const nameStart = j;
    while (j < n && !SPACE.has(source[j]) && source[j] !== '>' && source[j] !== '/' && !(source[j] === '=' && j > nameStart)) j += 1;
    const attrName = asciiLower(source.slice(nameStart, j));
    let k = j;
    while (k < n && SPACE.has(source[k])) k += 1;
    let value = '';
    if (source[k] === '=') {
      k += 1;
      while (k < n && SPACE.has(source[k])) k += 1;
      const quote = source[k];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, k + 1);
        value = source.slice(k + 1, close < 0 ? n : close);
        k = close < 0 ? n : close + 1;
      } else {
        const start = k;
        while (k < n && !SPACE.has(source[k]) && source[k] !== '>') k += 1;
        value = source.slice(start, k);
      }
      j = k;
    }
    if (attrName) attrs.push([attrName, value]);
  }
  return { name, attrs, end: j };
}

function indexOrEnd(source, needle, from) {
  const at = source.indexOf(needle, from);
  return at < 0 ? source.length : at;
}

/** Start tags in a stretch the tokenizer reads as text (a comment, a style block): no states. */
function scanFlat(text, out) {
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) return;
    if (!isAsciiAlpha(text[lt + 1] || '')) {
      i = lt + 1;
      continue;
    }
    const tag = readTag(text, lt + 1);
    out.push({ name: tag.name, attrs: tag.attrs, hidden: true });
    i = tag.end + 1;
  }
}

/**
 * The markup as an HTML tokenizer reads it, in one linear pass: start tags with their attributes;
 * end tags (attributes read, so their quotes count, then dropped); comments ending at the first
 * '-->' or '--!>' ('<!-->' and '<!--->' end at once); '<!...>', '<?...>' and '</' + non-letter as
 * bogus comments ending at the first '>'; style, title and textarea as text up to their end tag.
 * The text of every comment and text-only element is then scanned for tags as well (Outlook
 * renders the markup inside conditional comments), marked hidden. Returns { tags, problems, events }:
 * problems lists refused elements and meta refresh, each { tag, reason: 'markup' }; events lists, in
 * document order, the start and end tags the tokenizer reads as markup (never those inside a
 * comment or a text-only element), each { type: 'start'|'end', name, attrs, index } with index at
 * its '<'.
 */
export function scanMarkup(html) {
  const source = String(html || '');
  const n = source.length;
  const tags = [];
  const regions = [];
  const events = [];
  let i = 0;
  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    const next = source[lt + 1] || '';
    if (isAsciiAlpha(next)) {
      const tag = readTag(source, lt + 1);
      tags.push({ name: tag.name, attrs: tag.attrs });
      events.push({ type: 'start', name: tag.name, attrs: tag.attrs, index: lt });
      i = tag.end + 1;
      if (tag.end < n && OPAQUE_ELEMENTS.has(tag.name)) {
        const endTag = OPAQUE_END.get(tag.name);
        endTag.lastIndex = i;
        const match = endTag.exec(source);
        const close = match ? match.index : n;
        regions.push([i, close]);
        i = close;
      }
      continue;
    }
    if (next === '/') {
      const after = source[lt + 2] || '';
      if (isAsciiAlpha(after)) {
        const tag = readTag(source, lt + 2);
        events.push({ type: 'end', name: tag.name, attrs: tag.attrs, index: lt });
        i = tag.end + 1;
      } else if (after === '>') {
        i = lt + 3;
      } else if (lt + 2 >= n) {
        break;
      } else {
        const gt = indexOrEnd(source, '>', lt + 2);
        regions.push([lt + 2, gt]);
        i = gt + 1;
      }
      continue;
    }
    if (next === '!') {
      if (source.startsWith('<!--', lt)) {
        const k = lt + 4;
        if (source[k] === '>') {
          i = k + 1;
        } else if (source.startsWith('->', k)) {
          i = k + 2;
        } else {
          COMMENT_END.lastIndex = k;
          const match = COMMENT_END.exec(source);
          regions.push([k, match ? match.index : n]);
          i = match ? match.index + match[0].length : n;
        }
        continue;
      }
      const gt = indexOrEnd(source, '>', lt + 2);
      regions.push([lt + 2, gt]);
      i = gt + 1;
      continue;
    }
    if (next === '?') {
      const gt = indexOrEnd(source, '>', lt + 1);
      regions.push([lt + 1, gt]);
      i = gt + 1;
      continue;
    }
    i = lt + 1;
  }
  // Refused elements count where the tokenizer reads markup. Inside comments they are inert for
  // browsers (mail templates put <noscript><xml> for Outlook in conditional comments).
  const problems = [];
  for (const tag of tags) {
    if (REFUSED_ELEMENTS.has(tag.name)) problems.push({ tag: tag.name, reason: 'markup' });
    else if (tag.name === 'meta' && tag.attrs.some(([name, value]) => name === 'http-equiv' && /refresh/i.test(decodeEntities(value)))) problems.push({ tag: 'meta', reason: 'markup' });
  }
  for (const [start, end] of regions) scanFlat(source.slice(start, end), tags);
  return { tags, problems, events };
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param']);
/** Elements whose content a mail client does not show. */
const HIDDEN_ELEMENTS = new Set(['head', 'title', 'style', 'textarea', 'template', 'script', 'noscript']);

/** True when the element hides itself and its content: a hidden element, a `hidden` attribute or a hiding style. */
function hidesContent(name, attrs) {
  if (HIDDEN_ELEMENTS.has(name)) return true;
  for (const [attr, value] of attrs) {
    if (attr === 'hidden') return true;
    if (attr !== 'style') continue;
    const css = stripCssComments(cssUnescape(decodeEntities(value))).toLowerCase().replace(/\s+/g, '');
    if (/(^|;)(display:none|visibility:hidden|mso-hide:all|font-size:0(px|pt|em|rem|%)?(;|!|$)|opacity:0(.0+)?(;|!|$)|max-height:0(px|pt|em)?(;|!|$)|max-width:0(px|pt|em)?(;|!|$))/.test(css)) return true;
    if (/(^|;)(width|height):0(px|pt|em)?(;|!|$)/.test(css) && /(^|;)overflow:hidden/.test(css)) return true;
  }
  return false;
}

/**
 * True only when {{unsubscribeUrl}} is the href of an <a> a reader sees: in markup (not in a
 * comment, an Outlook conditional comment or a text-only element), outside <head>, <title> and
 * <template>, and with no open ancestor (or the link itself) hidden by a `hidden` attribute or a
 * display:none, visibility:hidden or mso-hide:all style. Anything else, and anything unclear, is
 * false, so the relay adds its own footer.
 */
export function unsubscribeLinkVisible(html) {
  const stack = [];
  let hiddenOpen = 0;
  const popTo = (k) => {
    for (const element of stack.splice(k)) if (element.hidden) hiddenOpen -= 1;
  };
  for (const event of scanMarkup(html).events) {
    if (event.type === 'end') {
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].name === event.name) {
          popTo(k);
          break;
        }
      }
      continue;
    }
    if (event.name === 'body') {
      const head = stack.findIndex((element) => element.name === 'head');
      if (head >= 0) popTo(head);
    }
    const hidden = hidesContent(event.name, event.attrs);
    if (event.name === 'a' && !hidden && hiddenOpen === 0
      && event.attrs.some(([attr, value]) => attr === 'href' && value.trim() === '{{unsubscribeUrl}}')) return true;
    if (VOID_ELEMENTS.has(event.name)) continue;
    stack.push({ name: event.name, hidden });
    if (hidden) hiddenOpen += 1;
  }
  return false;
}

/** Start tags with their attributes (see scanMarkup). */
export function scanTags(html) {
  return scanMarkup(html).tags;
}

/* ------------------------------------------------------------------ CSS */

/** CSS escapes (\75 rl, \:) decoded, so an escaped url( or scheme reads as written. */
function cssUnescape(text) {
  return String(text).replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f0-9a-fA-F]))/g, (_, hex, ch) => {
    if (ch !== undefined) return ch;
    const code = Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

/** CSS comments removed, in linear time (an unclosed comment runs to the end). */
function stripCssComments(text) {
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf('/*', i);
    if (open < 0) return out + text.slice(i);
    out += text.slice(i, open);
    const close = text.indexOf('*/', open + 2);
    if (close < 0) return out;
    i = close + 2;
  }
}

const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'\s)]+))/gi;
const CSS_IMPORT_RE = /@import\s+(["'])([^"']*)\1/gi;
const CSS_IMAGE_SET_RE = /(?:-webkit-)?image-set\(/gi;

/** Quoted strings inside image-set(...) (nested parentheses followed), each start walked once. */
function imageSetStrings(css) {
  const out = [];
  CSS_IMAGE_SET_RE.lastIndex = 0;
  let match;
  while ((match = CSS_IMAGE_SET_RE.exec(css))) {
    let k = match.index + match[0].length;
    let depth = 1;
    let quote = '';
    let start = 0;
    for (; k < css.length && depth > 0; k += 1) {
      const ch = css[k];
      if (quote) {
        if (ch === '\\') k += 1;
        else if (ch === quote) {
          out.push(css.slice(start, k));
          quote = '';
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        start = k + 1;
      } else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    if (quote) out.push(css.slice(start));
    CSS_IMAGE_SET_RE.lastIndex = Math.max(CSS_IMAGE_SET_RE.lastIndex, k);
  }
  return out;
}

/** Image references in CSS anywhere in the HTML: url(), @import and image-set() strings. */
function cssReferences(source) {
  const decoded = cssUnescape(decodeEntities(source));
  const variants = new Set([source, decoded, stripCssComments(decoded)]);
  const urls = new Set();
  for (const css of variants) {
    for (const match of css.matchAll(CSS_URL_RE)) urls.add(match[1] ?? match[2] ?? match[3]);
    for (const match of css.matchAll(CSS_IMPORT_RE)) urls.add(match[2]);
    for (const value of imageSetStrings(css)) urls.add(value);
  }
  return [...urls];
}

/* ------------------------------------------------------------------ the checks */

/**
 * Absolute URLs anywhere in the HTML (also in comments and in text), raw and with character
 * references decoded: every http: or https: run, and '//host' right after '=', a quote, '(' or
 * a space. A backstop for markup a mail client reads differently from the scanner.
 */
function looseUrls(source) {
  const out = new Set();
  for (const text of new Set([source, decodeEntities(source)])) {
    for (const match of text.matchAll(/https?:[^\s"'<>`]*/gi)) out.add(match[0]);
    for (const match of text.matchAll(/(?:^|[=("'\s,])(\/\/[^\s"'<>`/\\?#]+)/g)) out.add(`https:${match[1]}`);
  }
  return out;
}

function identifierHost(raw) {
  try {
    return IDENTIFIER_HOSTS.has(bareHost(new URL(raw).hostname));
  } catch {
    return false;
  }
}

/**
 * Every link and image reference in the HTML (and bare URLs in the text part):
 * [{ kind: 'link'|'image', url, ok, reason, host, tag }]. Refused markup comes first as
 * { kind: 'link', ok: false, reason: 'markup', tag }. Then the attributes of every tag the scanner
 * found (comments and text-only elements included), CSS references, absolute URLs anywhere else in
 * the HTML that no attribute or CSS rule covered (tag 'loose': allowed as a link or as an image),
 * and http(s) URLs in the text part.
 */
export function checkLinks(html, site, { emailSite = null, settings = null, text = '' } = {}) {
  const ctx = { site, emailSite, settings };
  const out = [];
  const source = String(html || '');
  const { tags, problems } = scanMarkup(source);
  for (const problem of problems) out.push({ kind: 'link', url: '', ok: false, reason: 'markup', host: '', tag: problem.tag });
  const seen = new Set();
  const add = (kind, url, tag) => {
    seen.add(url);
    seen.add(decodeEntities(url));
    out.push({ kind, url, ...(kind === 'link' ? checkLinkUrl(url, ctx) : checkImageUrl(url, ctx)), tag });
  };
  for (const tag of tags) {
    for (const [attrName, value] of tag.attrs) {
      if (LINK_ATTRS.has(attrName) || attrName.endsWith(':href')) add('link', value, tag.name);
      else if (IMAGE_ATTRS.has(attrName) || attrName.endsWith(':src')) add('image', value, tag.name);
      else if (LINK_LIST_ATTRS.has(attrName)) {
        // Lists are split after decoding, as a browser does; '&' is escaped again so the check
        // decodes each part exactly once.
        for (const url of decodeEntities(value).split(/[\t\n\f\r ]+/).filter(Boolean)) add('link', url.replace(/&/g, '&amp;'), tag.name);
      } else if (SRCSET_ATTRS.has(attrName)) {
        for (const part of decodeEntities(value).split(',')) {
          const url = part.trim().split(/[\t\n\f\r ]+/)[0];
          if (url) add('image', url.replace(/&/g, '&amp;'), tag.name);
        }
      }
    }
  }
  for (const url of cssReferences(source)) if (url && !seen.has(url)) add('image', url, 'css');
  for (const url of looseUrls(source)) {
    if (seen.has(url) || identifierHost(url)) continue;
    const asLink = checkLinkUrl(url, ctx);
    if (asLink.ok || checkImageUrl(url, ctx).ok) continue;
    seen.add(url);
    out.push({ kind: 'link', url, ...asLink, tag: 'loose' });
  }
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

/**
 * Kinds the site may send (legacy flags, or the feature tree through deps.entitledKeys). `campaign`
 * only when the site-config email block would allow campaigns (lib/email-site-config.js): a known
 * plan that is not the free plan (or campaigns on the free plan) and the Brevo terms check recorded.
 */
export function entitledKinds(site, settings, { entitledKeys = null } = {}) {
  let entitled = null;
  if (typeof entitledKeys === 'function') {
    try {
      entitled = entitledKeys(site) || null;
    } catch {
      entitled = null;
    }
  }
  return emailKindsForSite(site, settings, { entitled });
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

/**
 * The footer goes right before the last </body> end tag the tokenizer reads as markup (never one
 * inside a comment, such as an Outlook conditional comment), or at the end without one.
 */
export function withFooterHtml(html, footer) {
  if (!html) return html;
  const ends = scanMarkup(html).events.filter((event) => event.type === 'end' && event.name === 'body');
  if (!ends.length) return `${html}${footer}`;
  const at = ends[ends.length - 1].index;
  return `${html.slice(0, at)}${footer}${html.slice(at)}`;
}

function replacePlaceholders(value, unsubUrl) {
  return String(value).split('{{unsubscribeUrl}}').join(unsubUrl).split('{{preferencesUrl}}').join(unsubUrl);
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
/** Dedupe keys of sends in progress in any hub process: { [dedupeKey]: reservedAtMs }. */
export const RELAY_INFLIGHT_FILE = 'email-relay-inflight.json';
/** A reservation older than this is taken to belong to a process that died mid-send. */
export const RELAY_RESERVATION_MS = 10 * 60_000;

function readReservations() {
  try {
    const value = readJson(RELAY_INFLIGHT_FILE, {});
    return isPlainObject(value) ? value : {};
  } catch {
    // A damaged reservation file only holds sends in progress; the message log still dedupes.
    return {};
  }
}

/**
 * Reserves a dedupe key for one send across hub processes (under a file lock): null when another
 * send holds it (a reservation younger than RELAY_RESERVATION_MS) or the message log already has
 * it, else a handle whose release() drops the reservation. The relay releases only after the
 * message's log line is written, so a second process sees either the reservation or the line.
 */
export async function reserveRelayDedupe(key, { now = Date.now(), log = emailLog } = {}) {
  const id = String(key || '');
  if (!id) return null;
  const reserved = await withFileLock(RELAY_INFLIGHT_FILE, () => {
    const live = {};
    for (const [held, at] of Object.entries(readReservations())) {
      const ms = Number(at);
      if (Number.isFinite(ms) && now - ms < RELAY_RESERVATION_MS && ms - now < RELAY_RESERVATION_MS) live[held] = ms;
    }
    if (Object.hasOwn(live, id) || log.hasDedupeKey(id)) return false;
    live[id] = now;
    writeJsonAtomic(RELAY_INFLIGHT_FILE, live);
    return true;
  });
  if (!reserved) return null;
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await withFileLock(RELAY_INFLIGHT_FILE, () => {
        const current = readReservations();
        if (!Object.hasOwn(current, id)) return;
        delete current[id];
        writeJsonAtomic(RELAY_INFLIGHT_FILE, current);
      });
    },
  };
}

/**
 * True only for a 400 refusal about this recipient (the contact or address is blocked or
 * blacklisted). Account, key, IP, sender or domain blocks and every 401, 403 and 429 are not about
 * the recipient and must never add a global row.
 */
function looksRecipientBlocked(error) {
  if (Number(error?.status) !== 400) return false;
  const text = `${error?.brevoCode || ''} ${error?.brevoMessage || ''}`.toLowerCase();
  if (!/\bblock(ed)?\b|blacklist/.test(text)) return false;
  if (/\b(account|ip|key|api|sender|domain|user|plan|permission|unauthori[sz]ed)\b/.test(text)) return false;
  return /\b(contact|recipient|email|address)\b/.test(text) || /^\s*(blocked|blacklisted)\s*$/.test(text);
}

/**
 * Sends one email for a site. Resolves { status, body } and never throws.
 * options: now, emailKey (the presented x-email-key; checked here unless authenticated:true),
 * deps: { settings, quota, log, brevo, env, entitledKeys, getSalesClients, mintUnsubToken }.
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
  if (kind !== 'test' && !dpaAccepted(emailSite)) return fail(403, 'dpa_missing');
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
  const ref = clean(withoutControls(body.ref), 120);
  if (kind !== 'test' && !ref) return fail(400, 'bad_ref');
  // 10
  const consentIssue = consentProblem(kind, body.consent);
  if (consentIssue) return fail(409, 'no_consent', { reason: consentIssue });
  // 11
  if (!NO_SENDER_KINDS.has(kind) && !senderIdentityComplete(body.sender)) return fail(422, 'sender_identity_missing');
  // 12, 13
  const verdicts = checkLinks(html, site, { emailSite, settings, text });
  const badMarkup = verdicts.find((v) => v.reason === 'markup');
  if (badMarkup) return fail(422, 'link_not_allowed', { host: '', reason: 'markup', tag: badMarkup.tag });
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
  // 15 (opt-outs recorded while the record was unavailable are merged in first, and count anyway)
  if (pendingSuppressionsExist()) await applyPendingSuppressions({ now }).catch(() => {});
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
  let reservation = null;
  try {
    // Another hub process may be sending the same message right now.
    try {
      reservation = await reserveRelayDedupe(dedupeKey, { now, log });
    } catch {
      return fail(503, 'unavailable');
    }
    if (!reservation) return fail(409, 'duplicate');
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

    // Until Brevo has the message, any error gives the quota ticket (and the recipient count) back.
    let payload;
    let logRow;
    let shop;
    let lang;
    try {
      lang = clean(body.lang, 5) === 'en' ? 'en' : 'nb';
      shop = clean(body.brand?.name, 120) || clean(site?.name, 120) || clean(site?.domain, 120);
      const mint = typeof deps.mintUnsubToken === 'function' ? deps.mintUnsubToken : mintUnsubToken;
      const token = mint({ siteId, email: to, kind, messageId, scope: 'marketing' });
      const unsubUrl = `${publicBaseUrl(env)}/api/hub/email/unsubscribe?t=${token}`;
      const footer = footerFor({ kind, shop, unsubUrl, sender: body.sender, lang });
      let htmlOut = html;
      if (htmlOut) htmlOut = unsubscribeLinkVisible(htmlOut) ? replacePlaceholders(htmlOut, unsubUrl) : withFooterHtml(replacePlaceholders(htmlOut, unsubUrl), footer.html);
      let textOut = text;
      if (textOut) textOut = textOut.includes('{{unsubscribeUrl}}') ? replacePlaceholders(textOut, unsubUrl) : `${replacePlaceholders(textOut, unsubUrl)}${footer.text}`;
      const replyTo = EMAIL_RE.test(clean(body.replyTo, 320)) ? clean(body.replyTo, 320).toLowerCase() : (confirmedOwners(site, emailSite, deps.getSalesClients)[0] || '');
      payload = {
        sender: { name: senderDisplayName(site, settings), email: fromAddress(emailSite, settings) },
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
      logRow = {
        id: messageId,
        siteId,
        kind,
        cls,
        ref,
        step,
        campaignId: body.campaignId ? clean(withoutControls(body.campaignId), 80) : null,
        dedupeKey,
        to,
        provider: 'brevo',
        consent: isPlainObject(body.consent) ? body.consent : null,
        test: kind === 'test',
        createdAt: new Date(now).toISOString(),
      };
    } catch (error) {
      await quota.release(ticket.ticket, { now }).catch(() => {});
      console.error('[email-relay] message not built:', error?.code || 'error');
      return fail(500, 'internal');
    }
    let sent;
    try {
      sent = await brevo.sendBrevoEmail(payload, { settings });
    } catch (error) {
      await quota.release(ticket.ticket, { now }).catch(() => {});
      const code = error?.code || 'provider_unavailable';
      if (code === 'provider_rejected') {
        safeAppend(log, { ...logRow, status: 'rejected', error: error.brevoCode || String(error.status || '') });
        if (looksRecipientBlocked(error)) {
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
    // Delivered mail now carries unsubscribe links: they must keep working (lib/routes/email-hub-routes.js).
    if (status === 'accepted') noteRelaySent(now);
    rememberBrand(siteId, { name: shop, accent: body.brand?.accent, lang }, now);
    return {
      status: 200,
      body: { ok: true, messageId, ...(status !== 'accepted' ? { mode: status } : {}), quota: { siteRemaining: ticket.remaining, pool: ticket.pool } },
    };
  } finally {
    inflight.delete(dedupeKey);
    // After the log line: from here on another process finds the key in the message log.
    if (reservation) await reservation.release().catch(() => {});
  }
}

function safeAppend(log, row) {
  try {
    log.appendMessage(row);
  } catch (error) {
    console.error('[email-relay] message log append failed:', error?.code || 'error');
  }
}
