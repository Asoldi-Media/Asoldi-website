/**
 * Owner recipients of a client site's notices, with change control, and the owner notices
 * themselves. docs/email-owner-notify.md describes the contract.
 *
 * - setOwnerRecipients: a client CMS changes the list for an owner-rank user (at most 3 addresses,
 *   at most 10 changes per site per Oslo day). An address that is already confirmed stays
 *   confirmed; every other listed address is pending and receives a confirm link; addresses not
 *   listed are removed. The previous confirmed owners (or clientAdmin.email when there were none)
 *   get a change notice with a revert link. Both links are valid for 7 days.
 * - confirmOwnerRecipient / revertOwnerChange: the state changes behind those links. A revert puts
 *   back exactly the list from before the change and also undoes every later change of the site.
 * - sendOwnerNotice: a notice (order, form, checkout-started, digest; and the hub's own
 *   seo-report) to the confirmed owners only, through the hub mailer (Resend or SMTP, never Brevo).
 *   A pending address or the sales client's contact never receives one. At most 50 per site per
 *   Oslo day, one per dedupe key, and one seo-report per site per 7 days. Without a confirmed
 *   owner a notice goes to Asoldi's inbox with the "[Ingen eier-e-post satt]" prefix, as client
 *   forms do; a seo-report is then not sent.
 *
 * Owner rows in email-sites.json keep their shape { email, status, confirmedAt, source } (new rows
 * from a CMS change have source 'owner'). The change records and the notice counters live in
 * email-owner.json ({ changes, notices }), written under its own lock; records and dedupe keys
 * older than 30 days are dropped whenever the file is written. Links carry no plain address: a
 * token is v1.<payload>.<HMAC-SHA256 with a key derived from the unsubscribe key>.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { patchEmailSite, readEmailSettings, readEmailSite, readEmailUnsubKey, readJson, withFileLock, writeJsonAtomic } from '../data/email-store.js';
import { maskEmail } from './email-log.js';
import { nextResetAt, osloDayKey } from './email-quota.js';
import { checkLinks, publicBaseUrl, withoutControls } from './email-relay.js';
import { NO_OWNER_SUBJECT_PREFIX, fallbackFormInbox, normalizeOwnerEmail, resolveOwnerRecipients } from './owner-recipients.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const OWNER_FILE = 'email-owner.json';
export const MAX_OWNER_RECIPIENTS = 3;
export const CHANGES_PER_DAY = 10;
export const NOTICES_PER_DAY = 50;
export const LINK_VALID_MS = 7 * DAY_MS;
export const SEO_REPORT_EVERY_MS = 7 * DAY_MS;
const KEEP_MS = 30 * DAY_MS;
/** Kinds a client CMS may send through POST /api/hub/email/owner-notify. */
export const SITE_NOTICE_KINDS = Object.freeze(['order', 'form', 'checkout-started', 'digest']);
/** Kinds only hub code may send (sendOwnerNotice with allowInternal). */
export const INTERNAL_NOTICE_KINDS = Object.freeze(['seo-report']);
const MAX_SUBJECT = 200;
const MAX_SEO_SUBJECT = 150;
const MAX_TEXT_BYTES = 50 * 1024;
const MAX_HTML_BYTES = 200 * 1024;
const MAX_TOKEN_LENGTH = 800;
const VERIFIED_SOURCES = new Set(['ownerRecipients', 'clientAdmin']);

function clean(value, max = 500) {
  if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value ?? '').trim().slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(status, code, extra = {}) {
  return { status, body: { ok: false, code, ...extra } };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shopName(site) {
  return clean(withoutControls(site?.name), 120) || clean(site?.domain, 120) || 'nettbutikken';
}

/** First 32 hex characters of sha256 over the normalized address. */
export function addressHash(email) {
  return createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 32);
}

/** The confirmed owner addresses (confirmed rows, else clientAdmin.email); never pending rows or the sales contact. */
export function confirmedOwnerAddresses(site, { emailSite, getSalesClients } = {}) {
  const owner = resolveOwnerRecipients(site, { emailSite, getSalesClients });
  return VERIFIED_SOURCES.has(owner.source) ? owner.recipients : [];
}

/* ------------------------------------------------------------------ state file */

function emptyState() {
  return { changes: [], notices: {} };
}

function readState() {
  const raw = readJson(OWNER_FILE, null);
  if (!isPlainObject(raw)) return emptyState();
  return {
    ...raw,
    changes: Array.isArray(raw.changes) ? raw.changes.filter(isPlainObject) : [],
    notices: isPlainObject(raw.notices) ? raw.notices : {},
  };
}

function pruneState(state, now) {
  const keepAfter = now - KEEP_MS;
  state.changes = state.changes.filter((change) => (Date.parse(change.at) || 0) >= keepAfter);
  for (const row of Object.values(state.notices)) {
    if (!isPlainObject(row?.keys)) continue;
    for (const [key, at] of Object.entries(row.keys)) if (!(Number(at) >= keepAfter)) delete row.keys[key];
  }
}

/** Runs fn(state) under the owner lock; writes the state when fn returns { write: true }. */
function withState(now, fn) {
  return withFileLock(OWNER_FILE, async () => {
    const state = readState();
    const out = await fn(state);
    if (out?.write) {
      pruneState(state, now);
      writeJsonAtomic(OWNER_FILE, state);
    }
    return out?.result;
  });
}

/** True while a change younger than 7 days that was not reverted exists (its links must keep working). Never writes. */
export function ownerLinksOpen({ now = Date.now() } = {}) {
  try {
    return readState().changes.some((change) => !change.revertedAt && now - (Date.parse(change.at) || 0) < LINK_VALID_MS);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ links */

function tokenKey() {
  return createHash('sha256').update(`email-owner-token:v1:${readEmailUnsubKey()}`).digest();
}

function mac(body) {
  return createHmac('sha256', tokenKey()).update(`owner-link:v1:${body}`).digest('base64url');
}

/** A confirm or revert link token (no plain address in it). */
export function mintOwnerToken({ action, siteId, changeId, email = '', expiresAt }) {
  const payload = { a: action, s: clean(siteId, 80), c: clean(changeId, 40), x: Number(expiresAt), ...(email ? { h: addressHash(email) } : {}) };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `v1.${body}.${mac(body)}`;
}

/** { action, siteId, changeId, hash, expiresAt } for an intact token, else null (an expired one is returned with expired:true). Never throws. */
export function readOwnerToken(token, { now = Date.now() } = {}) {
  const text = clean(token, MAX_TOKEN_LENGTH + 1);
  if (!text || text.length > MAX_TOKEN_LENGTH) return null;
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
  try {
    const expected = Buffer.from(mac(parts[1]));
    const given = Buffer.from(parts[2]);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const action = data?.a === 'confirm' || data?.a === 'revert' ? data.a : '';
    const siteId = clean(data?.s, 80);
    const changeId = clean(data?.c, 40);
    const expiresAt = Number(data?.x);
    if (!action || !siteId || !changeId || !Number.isFinite(expiresAt)) return null;
    if (action === 'confirm' && !/^[0-9a-f]{32}$/.test(String(data.h || ''))) return null;
    return { action, siteId, changeId, hash: action === 'confirm' ? data.h : '', expiresAt, expired: now > expiresAt };
  } catch {
    return null;
  }
}

function linkUrl(env, action, token) {
  return `${publicBaseUrl(env)}/api/hub/email/owner-recipients/${action}?t=${token}`;
}

/* ------------------------------------------------------------------ mail */

async function mailer(sendEmail) {
  if (typeof sendEmail === 'function') return sendEmail;
  return (await import('./email.js')).sendEmail;
}

function paragraphsHtml(lines) {
  return lines.map((line) => `<p>${line}</p>`).join('');
}

function confirmMail({ shop, username, url }) {
  const subject = `Bekreft e-postadressen for varsler fra ${shop}`;
  const text = [
    'Hei!',
    '',
    `${username} har lagt til denne adressen som mottaker av varsler fra ${shop} (bestillinger, skjemaer og rapporter).`,
    '',
    'Bekreft adressen her (lenken gjelder i 7 dager):',
    url,
    '',
    'Kjenner du ikke til dette, kan du se bort fra e-posten. Adressen får ingen varsler før den er bekreftet.',
    '',
  ].join('\n');
  const html = paragraphsHtml([
    'Hei!',
    `${escapeHtml(username)} har lagt til denne adressen som mottaker av varsler fra ${escapeHtml(shop)} (bestillinger, skjemaer og rapporter).`,
    `<a href="${escapeHtml(url)}">Bekreft adressen</a> (lenken gjelder i 7 dager).`,
    'Kjenner du ikke til dette, kan du se bort fra e-posten. Adressen får ingen varsler før den er bekreftet.',
  ]);
  return { subject, text, html };
}

function changeMail({ shop, username, at, before, after, url }) {
  const list = (rows) => (rows.length ? rows.map((row) => `${row.email}${row.status === 'confirmed' ? '' : ' (venter på bekreftelse)'}`).join(', ') : '(ingen)');
  const when = new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  const subject = `Varslingsadressene for ${shop} er endret`;
  const text = [
    'Hei!',
    '',
    `${username} endret ${when} (UTC) hvem som får varsler fra ${shop}.`,
    '',
    `Før: ${list(before)}`,
    `Nå: ${list(after)}`,
    '',
    'Nye adresser får varsler først når de er bekreftet.',
    '',
    'Var det ikke deg? Angre endringen her (lenken gjelder i 7 dager):',
    url,
    '',
  ].join('\n');
  const html = paragraphsHtml([
    'Hei!',
    `${escapeHtml(username)} endret ${escapeHtml(when)} (UTC) hvem som får varsler fra ${escapeHtml(shop)}.`,
    `Før: ${escapeHtml(list(before))}<br>Nå: ${escapeHtml(list(after))}`,
    'Nye adresser får varsler først når de er bekreftet.',
    `Var det ikke deg? <a href="${escapeHtml(url)}">Angre endringen</a> (lenken gjelder i 7 dager).`,
  ]);
  return { subject, text, html };
}

/* ------------------------------------------------------------------ change control */

function rowsView(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({ email: row.email, status: row.status }));
}

function sameRows(a, b) {
  return JSON.stringify(rowsView(a)) === JSON.stringify(rowsView(b));
}

/**
 * A client CMS's change of the owner recipients. body: { emails: [<=3 addresses], actor: { username,
 * rank } }. Resolves { status, body } where a success body is the new list [{ email, status }].
 * options: now, env, sendEmail (the hub mailer by default), getSalesClients.
 */
export async function setOwnerRecipients(site, body = {}, { now = Date.now(), env = process.env, sendEmail = null, getSalesClients = null } = {}) {
  const siteId = clean(site?.id, 80);
  if (!siteId) return fail(404, 'not_found');
  const actor = isPlainObject(body?.actor) ? body.actor : {};
  if (clean(actor.rank, 40).toLowerCase() !== 'owner') return fail(403, 'forbidden');
  if (!Array.isArray(body?.emails)) return fail(400, 'bad_recipient');
  const emails = [];
  for (const entry of body.emails) {
    const email = normalizeOwnerEmail(typeof entry === 'string' ? entry : '');
    if (!email) return fail(400, 'bad_recipient');
    if (!emails.includes(email)) emails.push(email);
  }
  if (emails.length > MAX_OWNER_RECIPIENTS) return fail(400, 'too_many', { max: MAX_OWNER_RECIPIENTS });
  const username = clean(withoutControls(actor.username), 80) || 'En eier';
  const at = new Date(now).toISOString();

  const outcome = await withState(now, async (state) => {
    const row = readEmailSite(siteId);
    const current = Array.isArray(row.ownerRecipients) ? row.ownerRecipients : [];
    const byEmail = new Map(current.map((entry) => [entry.email, entry]));
    const next = emails.map((email) => {
      const existing = byEmail.get(email);
      return existing && existing.status === 'confirmed' ? { ...existing } : { email, status: 'pending', confirmedAt: '', source: 'owner' };
    });
    if (sameRows(current, next)) return { result: { unchanged: true, list: current } };
    const day = osloDayKey(now);
    const counters = isPlainObject(state.notices[siteId]) ? state.notices[siteId] : {};
    const used = counters.changes?.day === day ? Number(counters.changes.count) || 0 : 0;
    if (used >= CHANGES_PER_DAY) return { result: { limited: true } };
    const previousOwners = confirmedOwnerAddresses(site, { emailSite: row, getSalesClients });
    const change = { id: `oc_${randomBytes(6).toString('hex')}`, siteId, at, actor: { username, rank: 'owner' }, previous: current, next, revertedAt: '' };
    state.changes.push(change);
    state.notices[siteId] = { ...counters, changes: { day, count: used + 1 } };
    // The record first: a change that reached the site row can always be reverted.
    pruneState(state, now);
    writeJsonAtomic(OWNER_FILE, state);
    await patchEmailSite(siteId, { ownerRecipients: next });
    return { result: { change, previousOwners } };
  });
  if (outcome.limited) return fail(429, 'change_rate', { retryAt: new Date(nextResetAt(now)).toISOString() });
  if (outcome.unchanged) return { status: 200, body: rowsView(outcome.list) };

  const { change, previousOwners } = outcome;
  const shop = shopName(site);
  const expiresAt = now + LINK_VALID_MS;
  let send;
  try {
    send = await mailer(sendEmail);
  } catch (error) {
    console.error('[email-owner] mailer unavailable:', error?.code || 'error');
  }
  if (send) {
    for (const entry of change.next.filter((r) => r.status === 'pending')) {
      const url = linkUrl(env, 'confirm', mintOwnerToken({ action: 'confirm', siteId, changeId: change.id, email: entry.email, expiresAt }));
      try {
        await send({ bcc: false, to: entry.email, ...confirmMail({ shop, username, url }) });
      } catch (error) {
        console.error(`[email-owner] confirm link to ${maskEmail(entry.email)} for ${siteId} not sent:`, error?.code || 'error');
      }
    }
    if (previousOwners.length) {
      const url = linkUrl(env, 'revert', mintOwnerToken({ action: 'revert', siteId, changeId: change.id, expiresAt }));
      try {
        await send({ bcc: false, to: previousOwners.join(', '), ...changeMail({ shop, username, at: now, before: change.previous, after: change.next, url }) });
      } catch (error) {
        console.error(`[email-owner] change notice for ${siteId} not sent:`, error?.code || 'error');
      }
    } else {
      console.log(`[email-owner] owner recipients of ${siteId} changed with no previous owner to notify`);
    }
  }
  return { status: 200, body: rowsView(change.next) };
}

/**
 * The confirm link's POST. Resolves { status, state, siteId? } with state 'confirmed', 'invalid' or
 * 'expired'. A repeat answers 'confirmed' again without a write.
 */
export async function confirmOwnerRecipient(token, { now = Date.now() } = {}) {
  const data = readOwnerToken(token, { now });
  if (!data || data.action !== 'confirm') return { status: 400, state: 'invalid' };
  if (data.expired) return { status: 410, state: 'expired', siteId: data.siteId };
  return withState(now, async (state) => {
    const change = state.changes.find((entry) => entry.id === data.changeId && entry.siteId === data.siteId);
    if (!change || change.revertedAt) return { result: { status: 400, state: 'invalid', siteId: data.siteId } };
    const rows = readEmailSite(data.siteId).ownerRecipients || [];
    const index = rows.findIndex((row) => addressHash(row.email) === data.hash);
    if (index < 0) return { result: { status: 400, state: 'invalid', siteId: data.siteId } };
    if (rows[index].status === 'confirmed') return { result: { status: 200, state: 'confirmed', siteId: data.siteId } };
    const next = rows.map((row, i) => (i === index ? { ...row, status: 'confirmed', confirmedAt: new Date(now).toISOString() } : row));
    await patchEmailSite(data.siteId, { ownerRecipients: next });
    return { result: { status: 200, state: 'confirmed', siteId: data.siteId } };
  });
}

/**
 * The revert link's POST: the site's owner rows become exactly the list from before the change, and
 * the change and every later change of the site are marked reverted. Resolves { status, state,
 * siteId? } with state 'reverted', 'already', 'invalid' or 'expired'.
 */
export async function revertOwnerChange(token, { now = Date.now() } = {}) {
  const data = readOwnerToken(token, { now });
  if (!data || data.action !== 'revert') return { status: 400, state: 'invalid' };
  if (data.expired) return { status: 410, state: 'expired', siteId: data.siteId };
  return withState(now, async (state) => {
    const index = state.changes.findIndex((entry) => entry.id === data.changeId && entry.siteId === data.siteId);
    if (index < 0) return { result: { status: 400, state: 'invalid', siteId: data.siteId } };
    const change = state.changes[index];
    if (change.revertedAt) return { result: { status: 200, state: 'already', siteId: data.siteId } };
    await patchEmailSite(data.siteId, { ownerRecipients: Array.isArray(change.previous) ? change.previous : [] });
    const stamp = new Date(now).toISOString();
    state.changes.forEach((entry, i) => {
      if (entry.siteId === data.siteId && i >= index && !entry.revertedAt) entry.revertedAt = stamp;
    });
    return { write: true, result: { status: 200, state: 'reverted', siteId: data.siteId } };
  });
}

/* ------------------------------------------------------------------ notices */

/**
 * One owner notice. body: { kind, subject, text, html?, dedupeKey }. Resolves { status, body } and
 * never throws. allowInternal (default true, hub code) also accepts 'seo-report'; the site route
 * passes false. It does not read the e-mail platform switch: the site route does, and a hub caller
 * has its own switch. options: now, env, sendEmail, getSalesClients, settings, emailSite.
 */
export async function sendOwnerNotice(site, body = {}, { now = Date.now(), env = process.env, sendEmail = null, allowInternal = true, getSalesClients = null, settings = null, emailSite = undefined } = {}) {
  try {
    return await runOwnerNotice(site, isPlainObject(body) ? body : {}, { now, env, sendEmail, allowInternal, getSalesClients, settings, emailSite });
  } catch (error) {
    console.error('[email-owner] notice failed:', error?.code || 'error');
    return fail(503, 'unavailable');
  }
}

async function runOwnerNotice(site, body, { now, env, sendEmail, allowInternal, getSalesClients, settings, emailSite }) {
  const siteId = clean(site?.id, 80);
  if (!siteId) return fail(404, 'not_found');
  const kind = clean(body.kind, 40);
  const kinds = allowInternal ? [...SITE_NOTICE_KINDS, ...INTERNAL_NOTICE_KINDS] : SITE_NOTICE_KINDS;
  if (!kinds.includes(kind)) return fail(400, 'bad_kind');
  const subject = typeof body.subject === 'string' ? clean(withoutControls(body.subject), 1000) : '';
  if (!subject || subject.length > (kind === 'seo-report' ? MAX_SEO_SUBJECT : MAX_SUBJECT)) return fail(400, 'bad_subject');
  const text = typeof body.text === 'string' ? body.text : '';
  const html = typeof body.html === 'string' ? body.html : '';
  if (!text.trim()) return fail(400, 'empty_body');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) return fail(413, 'too_large');
  const dedupeKey = clean(withoutControls(body.dedupeKey), 120);
  if (!dedupeKey) return fail(400, 'bad_ref');
  const row = emailSite === undefined ? readEmailSite(siteId) : emailSite;
  const cfg = settings || readEmailSettings();
  // Links and images in the html must be on the site's own hosts and refused markup is refused, as
  // in relayed mail. Addresses that are only text (a visitor's message in a form notice, the text
  // part) are not links and stay as they are.
  const bad = checkLinks(html, site, { emailSite: row, settings: cfg }).find((verdict) => !verdict.ok && verdict.tag !== 'loose');
  if (bad) return fail(422, 'link_not_allowed', { host: bad.host || '', reason: bad.reason || '' });
  const owners = confirmedOwnerAddresses(site, { emailSite: row, getSalesClients });
  if (!owners.length && kind === 'seo-report') return fail(409, 'no_owner');

  const keyHash = createHash('sha256').update(`${kind}:${dedupeKey}`).digest('hex').slice(0, 32);
  const day = osloDayKey(now);
  const reserved = await withState(now, (state) => {
    const counters = isPlainObject(state.notices[siteId]) ? { ...state.notices[siteId] } : {};
    const keys = isPlainObject(counters.keys) ? { ...counters.keys } : {};
    if (Number(keys[keyHash]) >= now - KEEP_MS) return { result: { code: 'duplicate' } };
    const lastSeo = Number(counters.seoReportAt) || 0;
    if (kind === 'seo-report' && lastSeo && now - lastSeo < SEO_REPORT_EVERY_MS) return { result: { code: 'too_soon', retryAt: lastSeo + SEO_REPORT_EVERY_MS } };
    const used = counters.day === day ? Number(counters.count) || 0 : 0;
    if (used >= NOTICES_PER_DAY) return { result: { code: 'owner_rate', retryAt: nextResetAt(now) } };
    keys[keyHash] = now;
    state.notices[siteId] = { ...counters, day, count: used + 1, keys, ...(kind === 'seo-report' ? { seoReportAt: now } : {}) };
    return { write: true, result: { code: '', previousSeo: lastSeo } };
  });
  if (reserved.code === 'duplicate') return fail(409, 'duplicate');
  if (reserved.code) return fail(429, reserved.code, { retryAt: new Date(reserved.retryAt).toISOString() });

  const message = owners.length
    ? { bcc: false, to: owners.join(', '), subject, text, ...(html ? { html } : {}) }
    : { to: fallbackFormInbox(env), subject: `${NO_OWNER_SUBJECT_PREFIX} ${subject}`, text, ...(html ? { html } : {}) };
  try {
    const send = await mailer(sendEmail);
    await send(message);
  } catch (error) {
    console.error(`[email-owner] ${kind} notice for ${siteId} not sent:`, error?.code || 'error');
    // Give the count and the dedupe key back, so the next attempt can send.
    await withState(now, (state) => {
      const counters = isPlainObject(state.notices[siteId]) ? state.notices[siteId] : null;
      if (!counters) return {};
      if (isPlainObject(counters.keys)) delete counters.keys[keyHash];
      if (counters.day === day) counters.count = Math.max(0, (Number(counters.count) || 0) - 1);
      if (kind === 'seo-report') {
        if (reserved.previousSeo) counters.seoReportAt = reserved.previousSeo;
        else delete counters.seoReportAt;
      }
      return { write: true };
    }).catch(() => {});
    return fail(502, 'provider_unavailable');
  }
  return { status: 200, body: { ok: true } };
}
