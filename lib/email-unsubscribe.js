/**
 * Unsubscribe tokens, the per-site opt-out record and the public unsubscribe pages for client-site
 * email sent through the hub relay.
 *
 * - Tokens: AES-256-GCM over {v:1, s:siteId, e:email, k:kind, m:messageId, sc:scope} with a key
 *   derived from the email unsubKey (disk secret store). 12-byte iv, 16-byte tag, base64url. No
 *   plain address in the link, no expiry; a changed or foreign token does not decrypt.
 * - The record is email-suppressions.json (data/email-store.js), keyed per site id, plus "*" for
 *   global rows (hard bounce, invalid address, provider block; scope 'all'). A global row lists the
 *   sites that sent to the address (siteIds), so a site only ever sees rows for its own recipients.
 * - Scopes: 'marketing' blocks every kind except test and double-opt-in; 'all' blocks every kind;
 *   'none' is a row that was resubscribed (kept, so a second resubscribe through a link is refused).
 * - addSuppression also removes the address from the site's Brevo list when contacts are synced
 *   (never the account-wide blocklist: one shop's opt-out must not stop another shop's mail) and
 *   sends the CMS a signed hint. When the record cannot be written, the opt-out is appended to
 *   email-suppressions-pending.jsonl and applied by the next rebuild.
 * - rebuildSuppressionsFromCms pulls every enabled site's mirror when the record is lost; marketing
 *   sends get 503 suppressions_unavailable until it is back.
 * - The page (nb/en) loads nothing external, shows only a masked address, and GET never changes
 *   state. POST records the opt-out (also RFC 8058 one-click). Resubscribe works once, within 30 days.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { appendFileSync, existsSync, readFileSync, renameSync } from 'fs';
import {
  EMAIL_FILES,
  emailDataPath,
  readEmailSettings,
  readEmailSite,
  readEmailSuppressions,
  readEmailUnsubKey,
  readJson,
  restoreEmailSuppressions,
  updateEmailSuppressions,
} from '../data/email-store.js';
import { removeFromList, upsertContacts } from './brevo.js';
import { CMS_SUPPRESSIONS_PATH, getFromCms, postCmsHint } from './email-hint.js';
import { maskEmail } from './email-log.js';
import { currentEmailKey, siteInRollout } from './email-site-auth.js';

export const NON_MARKETING_KINDS = Object.freeze(['test', 'double-opt-in']);
export const RESUBSCRIBE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const PENDING_FILE = 'email-suppressions-pending.jsonl';
const GLOBAL_SOURCES = new Set(['hardBounce', 'invalid', 'provider-blocked']);
const SCOPES = new Set(['marketing', 'all', 'none']);
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;
const MAX_TOKEN_LENGTH = 1200;
const PAGE_LIMIT = 500;

function clean(value, max = 320) {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizeAddress(value) {
  const email = clean(value).toLowerCase();
  return EMAIL_RE.test(email) ? email : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ tokens */

function tokenKey() {
  return createHash('sha256').update(`email-unsub-token:v1:${readEmailUnsubKey()}`).digest();
}

/** An unsubscribe token for one address at one site. */
export function mintUnsubToken({ siteId, email, kind = '', messageId = '', scope = 'marketing' } = {}) {
  const address = normalizeAddress(email);
  const id = clean(siteId, 80);
  if (!address || !id) throw new Error('mintUnsubToken: siteId and email required');
  const payload = JSON.stringify({ v: 1, s: id, e: address, k: clean(kind, 40), m: clean(messageId, 60), sc: SCOPES.has(scope) ? scope : 'marketing' });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const body = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** { siteId, email, kind, messageId, scope } for a valid token, else null (never throws). */
export function readUnsubToken(token) {
  const text = clean(token, MAX_TOKEN_LENGTH + 1);
  if (!text || text.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const raw = Buffer.from(text, 'base64url');
    if (raw.length < 12 + 16 + 10) return null;
    const decipher = createDecipheriv('aes-256-gcm', tokenKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    const data = JSON.parse(plain);
    const email = normalizeAddress(data?.e);
    const siteId = clean(data?.s, 80);
    if (data?.v !== 1 || !email || !siteId) return null;
    return { siteId, email, kind: clean(data.k, 40), messageId: clean(data.m, 60), scope: SCOPES.has(data.sc) ? data.sc : 'marketing' };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ the record */

export function isMarketingKind(kind) {
  return !NON_MARKETING_KINDS.includes(String(kind || ''));
}

/** True when the record can be read (not lost, not mid-rebuild). */
export function suppressionsAvailable() {
  try {
    readEmailSuppressions();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a send of `kind` to `email` from a site is blocked, and by which row.
 * Throws EMAIL_STORE_UNREADABLE while the record is unavailable (callers fail closed).
 */
export function suppressionFor(siteId, email, kind, { rows = null } = {}) {
  const address = normalizeAddress(email);
  if (!address) return { suppressed: false };
  const all = rows || readEmailSuppressions();
  const siteRow = all?.[clean(siteId, 80)]?.[address];
  const globalRow = all?.['*']?.[address];
  if (isPlainObject(globalRow) && globalRow.scope === 'all') return { suppressed: true, where: '*', row: globalRow };
  if (isPlainObject(siteRow)) {
    if (siteRow.scope === 'all') return { suppressed: true, where: 'site', row: siteRow };
    if (siteRow.scope === 'marketing' && isMarketingKind(kind)) return { suppressed: true, where: 'site', row: siteRow };
  }
  return { suppressed: false };
}

export function isSuppressed(siteId, email, kind, options) {
  return suppressionFor(siteId, email, kind, options).suppressed;
}

function appendPending(row) {
  try {
    appendFileSync(emailDataPath(PENDING_FILE), `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function readPending() {
  const path = emailDataPath(PENDING_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((row) => row && normalizeAddress(row.email) && clean(row.siteId, 80));
}

function applyRow(rows, { siteId, email, scope, source, at, messageId = '', global = false, extra = {} }) {
  const address = normalizeAddress(email);
  if (global) {
    rows['*'] = isPlainObject(rows['*']) ? rows['*'] : {};
    const previous = isPlainObject(rows['*'][address]) ? rows['*'][address] : {};
    const siteIds = new Set(Array.isArray(previous.siteIds) ? previous.siteIds : []);
    if (siteId) siteIds.add(siteId);
    rows['*'][address] = { ...previous, ...extra, scope: 'all', source, at: previous.at || at, updatedAt: at, siteIds: [...siteIds] };
    return;
  }
  rows[siteId] = isPlainObject(rows[siteId]) ? rows[siteId] : {};
  const previous = isPlainObject(rows[siteId][address]) ? rows[siteId][address] : {};
  rows[siteId][address] = {
    ...extra,
    scope,
    source,
    at,
    updatedAt: at,
    ...(messageId ? { messageId } : {}),
    ...(previous.resubscribedAt ? { resubscribedAt: previous.resubscribedAt } : {}),
  };
}

function hint(site, deps) {
  if (!site?.id) return;
  Promise.resolve(postCmsHint(site, 'suppression', {}, deps)).catch(() => {});
}

/**
 * Records an opt-out. global:true writes a "*" row (scope 'all'). Resolves { recorded: 'record' |
 * 'pending' } and never sets Brevo's account-wide blocklist.
 */
export async function addSuppression({ site = null, siteId = '', email, scope = 'marketing', source = 'unsubscribe-link', messageId = '', global = false, now = Date.now(), extra = {} } = {}, deps = {}) {
  const id = clean(site?.id || siteId, 80);
  const address = normalizeAddress(email);
  if (!address || (!id && !global)) throw new Error('addSuppression: site and email required');
  const at = new Date(now).toISOString();
  const row = { siteId: id, email: address, scope: global ? 'all' : (SCOPES.has(scope) ? scope : 'marketing'), source: clean(source, 40), at, messageId: clean(messageId, 60), global: Boolean(global), extra };
  let recorded = 'record';
  try {
    await updateEmailSuppressions((rows) => applyRow(rows, row));
  } catch (error) {
    if (error?.code !== 'EMAIL_STORE_UNREADABLE' || !appendPending(row)) throw error;
    recorded = 'pending';
  }
  if (!global && id) {
    try {
      const settings = deps.settings || readEmailSettings();
      const listId = Number(readEmailSite(id).brevoListId);
      if (settings?.brevo?.syncContacts === true && Number.isInteger(listId) && listId > 0) await removeFromList(listId, [address]);
    } catch (error) {
      console.warn('[email-unsubscribe] list removal failed:', error?.code || 'error');
    }
  }
  if (site) hint(site, deps);
  return { recorded };
}

/**
 * Undo an unsubscribe-link or one-click opt-out within 30 days, once per address and site.
 * Resolves { ok } or { ok:false, reason }.
 */
export async function resubscribe({ site, email, now = Date.now() } = {}, deps = {}) {
  const id = clean(site?.id, 80);
  const address = normalizeAddress(email);
  if (!id || !address) return { ok: false, reason: 'bad-input' };
  const result = await updateEmailSuppressions((rows) => {
    const row = rows?.[id]?.[address];
    if (!isPlainObject(row) || row.scope !== 'marketing') return { ok: false, reason: 'not-unsubscribed' };
    if (!['unsubscribe-link', 'one-click'].includes(row.source)) return { ok: false, reason: 'not-by-link' };
    if (row.resubscribedAt) return { ok: false, reason: 'already-used' };
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || now - at > RESUBSCRIBE_WINDOW_MS) return { ok: false, reason: 'expired' };
    const stamp = new Date(now).toISOString();
    rows[id][address] = { ...row, scope: 'none', resubscribedAt: stamp, updatedAt: stamp };
    return { ok: true };
  });
  if (result.ok) {
    try {
      const settings = deps.settings || readEmailSettings();
      const listId = Number(readEmailSite(id).brevoListId);
      if (settings?.brevo?.syncContacts === true && Number.isInteger(listId) && listId > 0) await upsertContacts(listId, [address]);
    } catch (error) {
      console.warn('[email-unsubscribe] list re-add failed:', error?.code || 'error');
    }
    hint(site, deps);
  }
  return result;
}

/**
 * The site's rows changed after `since` (exclusive), oldest first: its own rows plus "*" rows for
 * addresses it sent to. Pages end on a timestamp boundary; `next` is the `since` for the next page.
 */
export function listSuppressions(siteId, { since = '', limit = PAGE_LIMIT, rows = null } = {}) {
  const id = clean(siteId, 80);
  const all = rows || readEmailSuppressions();
  const items = [];
  for (const [email, row] of Object.entries(isPlainObject(all?.[id]) ? all[id] : {})) {
    if (!isPlainObject(row)) continue;
    items.push({ email, scope: SCOPES.has(row.scope) ? row.scope : 'marketing', source: clean(row.source, 40), at: clean(row.at, 40), updatedAt: clean(row.updatedAt || row.at, 40) });
  }
  for (const [email, row] of Object.entries(isPlainObject(all?.['*']) ? all['*'] : {})) {
    if (!isPlainObject(row) || !Array.isArray(row.siteIds) || !row.siteIds.includes(id)) continue;
    items.push({ email, scope: 'all', source: clean(row.source, 40), at: clean(row.at, 40), updatedAt: clean(row.updatedAt || row.at, 40) });
  }
  const after = clean(since, 40);
  const sorted = items.filter((item) => !after || item.updatedAt > after).sort((a, b) => (a.updatedAt === b.updatedAt ? a.email.localeCompare(b.email) : a.updatedAt < b.updatedAt ? -1 : 1));
  const max = Math.max(1, Math.min(PAGE_LIMIT, Number(limit) || PAGE_LIMIT));
  let end = Math.min(sorted.length, max);
  while (end < sorted.length && sorted[end].updatedAt === sorted[end - 1].updatedAt) end += 1;
  const page = sorted.slice(0, end);
  return { items: page, next: end < sorted.length ? page[page.length - 1].updatedAt : null };
}

/** Adds a site to a "*" row's siteIds (a site that tries to send to a globally blocked address). */
export async function noteGlobalRowSite(siteId, email) {
  const id = clean(siteId, 80);
  const address = normalizeAddress(email);
  if (!id || !address) return;
  await updateEmailSuppressions((rows) => {
    const row = rows?.['*']?.[address];
    if (!isPlainObject(row)) return;
    const siteIds = Array.isArray(row.siteIds) ? row.siteIds : [];
    if (!siteIds.includes(id)) rows['*'][address] = { ...row, siteIds: [...siteIds, id] };
  });
}

/**
 * Rebuilds a lost record from the sites' mirrors: GET <cmsTarget>/api/cms/email/suppressions
 * (signed with each site's emailKey) from every site in the rollout with a committed key, plus the
 * pending opt-outs recorded while the record was unavailable. Writes only when every such site
 * answered, unless `force`. Resolves { ok, written, sites, rows, failed }.
 */
export async function rebuildSuppressionsFromCms({ getAllSites, force = false, now = Date.now(), fetchImpl, settings = null, env = process.env } = {}) {
  if (suppressionsAvailable() && !force) return { ok: true, written: false, reason: 'readable', sites: 0, rows: 0, failed: [] };
  const cfg = settings || readEmailSettings();
  const sites = (typeof getAllSites === 'function' ? getAllSites() : []).filter((site) => site?.id && siteInRollout(site.id, cfg) && currentEmailKey(site.id));
  const rows = {};
  const failed = [];
  let count = 0;
  for (const site of sites) {
    try {
      let since = '';
      for (let page = 0; page < 200; page += 1) {
        const answer = await getFromCms(site, `${CMS_SUPPRESSIONS_PATH}${since ? `?since=${encodeURIComponent(since)}` : ''}`, { fetchImpl, now, settings: cfg, env });
        const items = Array.isArray(answer?.items) ? answer.items : [];
        for (const item of items) {
          const email = normalizeAddress(item?.email);
          if (!email) continue;
          const scope = SCOPES.has(item.scope) ? item.scope : 'marketing';
          const source = clean(item.source, 40) || 'cms-mirror';
          const at = clean(item.at, 40) || new Date(now).toISOString();
          const global = scope === 'all' && GLOBAL_SOURCES.has(source);
          applyRow(rows, { siteId: String(site.id), email, scope, source, at, global });
          count += 1;
        }
        if (!answer?.next || !items.length) break;
        since = clean(answer.next, 40);
      }
    } catch (error) {
      failed.push({ siteId: String(site.id), code: error?.code || 'error' });
    }
  }
  const pending = readPending();
  for (const row of pending) applyRow(rows, { ...row, email: row.email, siteId: clean(row.siteId, 80), scope: row.scope || 'marketing', source: clean(row.source, 40) || 'unsubscribe-link', at: clean(row.at, 40) || new Date(now).toISOString() });
  if (failed.length && !force) return { ok: false, written: false, sites: sites.length, rows: count, failed };
  const result = await restoreEmailSuppressions(rows, { force });
  if (result.written && pending.length) {
    try {
      renameSync(emailDataPath(PENDING_FILE), emailDataPath(`${PENDING_FILE}.applied-${new Date(now).toISOString().replace(/[:.]/g, '-')}`));
    } catch {
      // applied again on the next rebuild; rows are idempotent
    }
  }
  return { ok: result.written || result.reason === 'readable', written: result.written, sites: sites.length, rows: count + pending.length, failed };
}

/* ------------------------------------------------------------------ the page */

const COPY = {
  nb: {
    title: 'Meld deg av',
    confirmHeading: (shop) => `Meld deg av e-post fra ${shop}`,
    confirmBody: (shop, email) => `Adressen ${email} får da ikke flere e-poster med tilbud og nyheter fra ${shop}.`,
    confirmButton: 'Meld meg av',
    doneHeading: 'Du er meldt av',
    doneBody: (shop) => `Du får ikke flere e-poster med tilbud og nyheter fra ${shop}. Ordrebekreftelser og svar på henvendelser kommer fortsatt.`,
    undoButton: 'Angre, meld meg på igjen',
    undoNote: 'Du kan angre én gang innen 30 dager.',
    resubscribedHeading: 'Du er meldt på igjen',
    resubscribedBody: (shop) => `Du får igjen e-poster fra ${shop}.`,
    deniedHeading: 'Kan ikke meldes på igjen her',
    deniedBody: 'Denne lenken kan ikke lenger brukes til å melde deg på igjen. Du kan melde deg på i nettbutikken.',
    invalidHeading: 'Lenken virker ikke',
    invalidBody: 'Lenken er ufullstendig eller endret. Bruk avmeldingslenken nederst i e-posten.',
    unavailableHeading: 'Prøv igjen litt senere',
    unavailableBody: 'Vi kunne ikke lagre valget ditt akkurat nå.',
    footer: 'Utsendt via Asoldi på vegne av nettbutikken.',
  },
  en: {
    title: 'Unsubscribe',
    confirmHeading: (shop) => `Unsubscribe from ${shop} emails`,
    confirmBody: (shop, email) => `${email} will no longer receive offers and news from ${shop}.`,
    confirmButton: 'Unsubscribe',
    doneHeading: 'You are unsubscribed',
    doneBody: (shop) => `You will no longer receive offers and news from ${shop}. Order confirmations and replies still reach you.`,
    undoButton: 'Undo, subscribe again',
    undoNote: 'You can undo this once within 30 days.',
    resubscribedHeading: 'You are subscribed again',
    resubscribedBody: (shop) => `You will receive emails from ${shop} again.`,
    deniedHeading: 'Cannot subscribe again here',
    deniedBody: 'This link can no longer be used to subscribe again. You can sign up in the shop.',
    invalidHeading: 'This link does not work',
    invalidBody: 'The link is incomplete or was changed. Use the unsubscribe link at the bottom of the email.',
    unavailableHeading: 'Please try again later',
    unavailableBody: 'We could not save your choice right now.',
    footer: 'Sent through Asoldi on behalf of the shop.',
  },
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function pageLanguage(value) {
  return String(value || '').toLowerCase().startsWith('en') ? 'en' : 'nb';
}

export function safeAccent(value) {
  const text = clean(value, 20);
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(text) ? text : '#1f2937';
}

/** Shop name, accent and language for a site from email-brand-cache.json (written by the relay). */
export function brandFor(site) {
  let cache = {};
  try {
    cache = readJson(EMAIL_FILES.brandCache, {}) || {};
  } catch {
    cache = {};
  }
  const row = isPlainObject(cache?.[site?.id]) ? cache[site.id] : {};
  return {
    name: clean(row.name, 120) || clean(site?.name, 120) || clean(site?.domain, 120) || 'nettbutikken',
    accent: safeAccent(row.accent),
    lang: pageLanguage(row.lang),
  };
}

/** Headers for the page: no indexing, no caching, nothing loaded from elsewhere. */
export const UNSUB_PAGE_HEADERS = Object.freeze({
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
});

/**
 * The page HTML. state: 'confirm' | 'done' | 'resubscribed' | 'denied' | 'invalid' | 'unavailable'.
 * Only the masked address appears; forms post back to this hub with the same token.
 */
export function renderUnsubPage({ state = 'confirm', lang = 'nb', shop = '', accent = '', email = '', token = '', canUndo = false } = {}) {
  const copy = COPY[pageLanguage(lang)];
  const name = escapeHtml(clean(shop, 120) || 'nettbutikken');
  const color = safeAccent(accent);
  const masked = escapeHtml(maskEmail(email));
  const t = encodeURIComponent(clean(token, MAX_TOKEN_LENGTH));
  const langParam = pageLanguage(lang) === 'en' ? '&amp;lang=en' : '';
  let heading = '';
  let body = '';
  let action = '';
  if (state === 'confirm') {
    heading = escapeHtml(copy.confirmHeading(clean(shop, 120) || 'nettbutikken'));
    body = `<p>${copy.confirmBody(name, masked)}</p>`;
    action = `<form method="post" action="/api/hub/email/unsubscribe?t=${t}${langParam}"><input type="hidden" name="confirm" value="1"><button type="submit">${escapeHtml(copy.confirmButton)}</button></form>`;
  } else if (state === 'done') {
    heading = escapeHtml(copy.doneHeading);
    body = `<p>${copy.doneBody(name)}</p>`;
    if (canUndo) {
      action = `<form method="post" action="/api/hub/email/resubscribe?t=${t}${langParam}"><input type="hidden" name="from" value="page"><button type="submit" class="secondary">${escapeHtml(copy.undoButton)}</button></form><p class="note">${escapeHtml(copy.undoNote)}</p>`;
    }
  } else if (state === 'resubscribed') {
    heading = escapeHtml(copy.resubscribedHeading);
    body = `<p>${copy.resubscribedBody(name)}</p>`;
  } else if (state === 'denied') {
    heading = escapeHtml(copy.deniedHeading);
    body = `<p>${escapeHtml(copy.deniedBody)}</p>`;
  } else if (state === 'unavailable') {
    heading = escapeHtml(copy.unavailableHeading);
    body = `<p>${escapeHtml(copy.unavailableBody)}</p>`;
  } else {
    heading = escapeHtml(copy.invalidHeading);
    body = `<p>${escapeHtml(copy.invalidBody)}</p>`;
  }
  return `<!doctype html>
<html lang="${pageLanguage(lang) === 'en' ? 'en' : 'nb'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(copy.title)} – ${name}</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f6f4;color:#1b1b1b}
main{max-width:34rem;margin:10vh auto;padding:2rem;background:#fff;border-radius:12px;border-top:6px solid ${color}}
h1{font-size:1.4rem;margin:0 0 1rem}
button{font:inherit;padding:.7rem 1.2rem;border:0;border-radius:8px;background:${color};color:#fff;cursor:pointer}
button.secondary{background:#fff;color:${color};border:2px solid ${color}}
.note,footer{font-size:.85rem;color:#555}
footer{margin-top:2rem}
</style>
</head>
<body>
<main>
<p><strong>${name}</strong></p>
<h1>${heading}</h1>
${body}
${action}
<footer>${escapeHtml(copy.footer)}</footer>
</main>
</body>
</html>`;
}

/** True when a resubscribe link would still work for this row (for the "done" page). */
export function canResubscribe(siteId, email, { now = Date.now() } = {}) {
  try {
    const row = readEmailSuppressions()?.[clean(siteId, 80)]?.[normalizeAddress(email)];
    if (!isPlainObject(row) || row.scope !== 'marketing' || row.resubscribedAt) return false;
    if (!['unsubscribe-link', 'one-click'].includes(row.source)) return false;
    const at = Date.parse(row.at);
    return Number.isFinite(at) && now - at <= RESUBSCRIBE_WINDOW_MS;
  } catch {
    return false;
  }
}
