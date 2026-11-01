/**
 * Brevo API client for client-site email (transactional sends, the CMS contact folder and lists,
 * webhooks and sender domains).
 *
 * - Every call goes to https://api.brevo.com/v3 with the `api-key` header. The key comes from
 *   resolveBrevoKey() (env first, then the Superadmin paste); without one a call throws
 *   code 'not_configured'. The key never appears in an error, a log line or a return value.
 * - 15 s timeout per attempt. A 5xx answer or a network error is retried once after 2 s. A 429 is
 *   retried after its Retry-After (seconds or an HTTP date), up to three times and at most 60 s.
 * - sendBrevoEmail takes exactly one recipient. There is no batch call: each recipient needs its
 *   own List-Unsubscribe and X-Mailin-custom headers, which Brevo's message versions cannot carry.
 * - Safe mode (hub not on asoldi.com, brevoSend not allowed): no call reaches Brevo. A send goes to
 *   the safe-mode outbox; other changes are recorded as safe-mode intents; every call returns a
 *   deterministic stub answer.
 * - Sandbox (settings.brevo.sandbox): the send body carries headers['X-Sib-Sandbox'] = 'drop', so
 *   Brevo validates the request and delivers nothing.
 * - Lists: only lists inside the folder "Asoldi CMS-kunder" that email-sites.json records for a
 *   site are ever changed.
 * - setBrevoDeps({ fetch, now, sleep, env }) replaces the network, clock and env in tests.
 */
import { createHash } from 'crypto';
import {
  patchEmailSite,
  readEmailSettings,
  readEmailSite,
  readEmailSites,
  resolveBrevoKey,
  saveEmailSettings,
} from '../data/email-store.js';
import { isSafeModeActive, recordIntent, safeModeAllows } from './safe-mode.js';
import { outboxOrSend } from './safe-mode-mail.js';

export const BREVO_API_BASE = 'https://api.brevo.com/v3';
export const BREVO_TIMEOUT_MS = 15_000;
export const BREVO_RETRY_DELAY_MS = 2_000;
export const BREVO_MAX_RETRY_AFTER_MS = 60_000;
export const BREVO_MAX_429_RETRIES = 3;
export const CMS_FOLDER_NAME = 'Asoldi CMS-kunder';
export const WEBHOOK_EVENTS = Object.freeze(['delivered', 'hardBounce', 'softBounce', 'blocked', 'spam', 'invalid', 'opened', 'click', 'unsubscribed']);
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;

const defaultDeps = () => ({
  fetch: (...args) => globalThis.fetch(...args),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  env: process.env,
});
let deps = defaultDeps();

/** Tests: replace fetch, now, sleep and env. Call with no argument to restore the defaults. */
export function setBrevoDeps(patch = null) {
  deps = patch ? { ...defaultDeps(), ...patch } : defaultDeps();
}

export class BrevoError extends Error {
  constructor(code, { status = 0, brevoCode = '', brevoMessage = '' } = {}) {
    super(`Brevo: ${code}${status ? ` (${status})` : ''}${brevoCode ? ` ${brevoCode}` : ''}`);
    this.name = 'BrevoError';
    this.code = code;
    this.status = status;
    this.brevoCode = brevoCode;
    this.brevoMessage = brevoMessage;
  }
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function stubNumber(seed, base = 900_000) {
  const hex = createHash('sha256').update(String(seed)).digest('hex').slice(0, 8);
  return base + (parseInt(hex, 16) % 99_999);
}

/** True when the hub must not reach Brevo: safe mode is on and brevoSend is not allowed. */
export function brevoBlockedBySafeMode() {
  return isSafeModeActive() && !safeModeAllows('brevoSend');
}

export function brevoConfigured({ env = deps.env } = {}) {
  return Boolean(resolveBrevoKey({ env }));
}

function apiKey() {
  const key = resolveBrevoKey({ env: deps.env });
  if (!key) throw new BrevoError('not_configured', { status: 503 });
  return key;
}

/** Brevo error text, without the key (in case an answer ever echoes it) and shortened. */
function scrub(text, key) {
  let out = clean(text, 300);
  if (key) out = out.split(key).join('***');
  return out.replace(/\b[A-Za-z0-9_-]{40,}\b/g, '***');
}

export function retryAfterMs(header, now = Date.now()) {
  const value = clean(header, 100);
  if (!value) return 1000;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 1000;
}

async function readJsonBody(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

/**
 * One API call with timeout, the 5xx/network retry and the 429 backoff.
 * Resolves the parsed JSON body ({} for an empty answer). allow404: resolves null on 404.
 */
async function brevoRequest(method, path, body = undefined, { allow404 = false } = {}) {
  const key = apiKey();
  const url = `${BREVO_API_BASE}${path}`;
  let retried = false;
  let limited = 0;
  for (;;) {
    let response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BREVO_TIMEOUT_MS);
    timer.unref?.();
    try {
      response = await deps.fetch(url, {
        method,
        headers: {
          'api-key': key,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.safeMode) throw new BrevoError('safe_mode_blocked', { status: 423 });
      if (!retried) {
        retried = true;
        await deps.sleep(BREVO_RETRY_DELAY_MS);
        continue;
      }
      throw new BrevoError('provider_unavailable', { status: 0 });
    }
    clearTimeout(timer);
    if (response.status === 429) {
      const wait = retryAfterMs(response.headers?.get?.('retry-after'), deps.now());
      await response.body?.cancel?.().catch?.(() => {});
      if (limited < BREVO_MAX_429_RETRIES && wait <= BREVO_MAX_RETRY_AFTER_MS) {
        limited += 1;
        await deps.sleep(Math.max(wait, 0));
        continue;
      }
      throw new BrevoError('rate_limited', { status: 429 });
    }
    if (response.status >= 500) {
      await response.body?.cancel?.().catch?.(() => {});
      if (!retried) {
        retried = true;
        await deps.sleep(BREVO_RETRY_DELAY_MS);
        continue;
      }
      throw new BrevoError('provider_unavailable', { status: response.status });
    }
    if (response.status === 404 && allow404) {
      await response.body?.cancel?.().catch?.(() => {});
      return null;
    }
    const parsed = await readJsonBody(response);
    if (response.status >= 400) {
      throw new BrevoError('provider_rejected', {
        status: response.status,
        brevoCode: scrub(parsed?.code, key),
        brevoMessage: scrub(parsed?.message, key),
      });
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  }
}

function intent(detail) {
  recordIntent('brevoSend', detail);
}

function ownedListIds() {
  const ids = new Set();
  for (const row of Object.values(readEmailSites())) {
    const id = Number(row?.brevoListId);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

function assertOwnedList(listId) {
  const id = Number(listId);
  if (!Number.isInteger(id) || id <= 0 || !ownedListIds().has(id)) {
    throw new BrevoError('list_not_owned', { status: 400 });
  }
  return id;
}

function cleanEmails(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : [list]) {
    const email = clean(raw, 320).toLowerCase();
    if (EMAIL_RE.test(email) && !out.includes(email)) out.push(email);
  }
  return out;
}

function slugify(value) {
  return clean(value, 120)
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'site';
}

/* ------------------------------------------------------------------ transactional send */

/**
 * One transactional email. payload: { sender:{name,email}, to:[{email,name}] (exactly one),
 * replyTo, subject, htmlContent, textContent, headers, tags }. Resolves
 * { providerMessageId, mode: 'brevo'|'outbox'|'sandbox', outboxId? }.
 */
export async function sendBrevoEmail(payload = {}, { settings = null } = {}) {
  const to = Array.isArray(payload.to) ? payload.to : [];
  if (to.length !== 1) throw new BrevoError('one_recipient_per_call', { status: 400 });
  const recipient = { email: clean(to[0]?.email, 320).toLowerCase(), ...(clean(to[0]?.name, 120) ? { name: clean(to[0].name, 120) } : {}) };
  if (!EMAIL_RE.test(recipient.email)) throw new BrevoError('bad_recipient', { status: 400 });
  const cfg = settings || readEmailSettings();
  const sandbox = cfg?.brevo?.sandbox === true;
  const headers = { ...(payload.headers && typeof payload.headers === 'object' ? payload.headers : {}) };
  if (sandbox) headers['X-Sib-Sandbox'] = 'drop';
  const body = {
    sender: { name: clean(payload.sender?.name, 120), email: clean(payload.sender?.email, 320) },
    to: [recipient],
    ...(payload.replyTo?.email ? { replyTo: { email: clean(payload.replyTo.email, 320), ...(payload.replyTo.name ? { name: clean(payload.replyTo.name, 120) } : {}) } } : {}),
    subject: String(payload.subject ?? ''),
    ...(payload.htmlContent ? { htmlContent: String(payload.htmlContent) } : {}),
    ...(payload.textContent ? { textContent: String(payload.textContent) } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(Array.isArray(payload.tags) && payload.tags.length ? { tags: payload.tags.map((tag) => clean(tag, 60)).filter(Boolean) } : {}),
  };
  if (brevoBlockedBySafeMode()) {
    const out = await outboxOrSend({
      channel: 'brevo',
      allowKey: 'brevoSend',
      message: {
        from: `${body.sender.name ? `"${body.sender.name.replace(/"/g, '')}" ` : ''}<${body.sender.email}>`,
        to: recipient.email,
        replyTo: body.replyTo?.email || '',
        subject: body.subject,
        text: body.textContent || '',
        html: body.htmlContent || '',
        headers: Object.fromEntries(Object.entries(headers).filter(([name]) => /^[A-Za-z0-9-]+$/.test(name)).map(([name, value]) => [name, String(value)])),
      },
      send: async () => {
        throw new BrevoError('safe_mode_blocked', { status: 423 });
      },
    });
    return { providerMessageId: `<outbox-${out.id}@safe-mode.invalid>`, mode: 'outbox', outboxId: out.id };
  }
  apiKey();
  const answer = await brevoRequest('POST', '/smtp/email', body);
  const providerMessageId = clean(answer?.messageId, 300) || clean(answer?.messageIds?.[0], 300);
  return { providerMessageId, mode: sandbox ? 'sandbox' : 'brevo' };
}

/* ------------------------------------------------------------------ account */

/** { plan:[{type, creditsType, credits}], relay } from GET /account. Safe mode: a stub with no credits. */
export async function getBrevoAccount() {
  if (brevoBlockedBySafeMode()) return { plan: [{ type: 'safe-mode-stub', creditsType: 'sendLimit', credits: null }], relay: null, stub: true };
  const account = await brevoRequest('GET', '/account');
  const plan = (Array.isArray(account?.plan) ? account.plan : []).map((row) => ({
    type: clean(row?.type, 40),
    creditsType: clean(row?.creditsType, 40),
    credits: Number.isFinite(Number(row?.credits)) ? Number(row.credits) : null,
  }));
  return { plan, relay: account?.relay ? { enabled: account.relay.enabled === true } : null };
}

/* ------------------------------------------------------------------ folder and lists */

/** The id of the folder "Asoldi CMS-kunder" (found or created, then kept in the email settings). */
export async function ensureCmsFolder() {
  const settings = readEmailSettings();
  const stored = Number(settings?.brevo?.folderId);
  if (Number.isInteger(stored) && stored > 0) return stored;
  if (brevoBlockedBySafeMode()) {
    intent('ensure the CMS contact folder');
    return stubNumber('cms-folder', 9_000);
  }
  for (let offset = 0; offset < 1000; offset += 50) {
    const page = await brevoRequest('GET', `/contacts/folders?limit=50&offset=${offset}`);
    const folders = Array.isArray(page?.folders) ? page.folders : [];
    const found = folders.find((folder) => clean(folder?.name) === CMS_FOLDER_NAME);
    if (found && Number.isInteger(Number(found.id))) {
      await saveEmailSettings({ brevo: { folderId: Number(found.id) } });
      return Number(found.id);
    }
    if (folders.length < 50) break;
  }
  const created = await brevoRequest('POST', '/contacts/folders', { name: CMS_FOLDER_NAME });
  const id = Number(created?.id);
  if (!Number.isInteger(id) || id <= 0) throw new BrevoError('provider_rejected', { status: 502, brevoCode: 'no_folder_id' });
  await saveEmailSettings({ brevo: { folderId: id } });
  return id;
}

/** The site's list id (created as cms-<siteId>-<slug> in the CMS folder and kept in email-sites.json). */
export async function ensureSiteList(site) {
  const siteId = clean(site?.id, 80);
  if (!siteId) throw new BrevoError('bad_site', { status: 400 });
  const existing = Number(readEmailSite(siteId).brevoListId);
  if (Number.isInteger(existing) && existing > 0) return existing;
  if (brevoBlockedBySafeMode()) {
    intent(`ensure the contact list of site ${siteId}`);
    // Not stored: a stub id must never reach a live hub's data.
    return stubNumber(`list:${siteId}`);
  }
  const folderId = await ensureCmsFolder();
  const created = await brevoRequest('POST', '/contacts/lists', { name: `cms-${siteId}-${slugify(site?.name || site?.domain)}`, folderId });
  const id = Number(created?.id);
  if (!Number.isInteger(id) || id <= 0) throw new BrevoError('provider_rejected', { status: 502, brevoCode: 'no_list_id' });
  await patchEmailSite(siteId, { brevoListId: id });
  return id;
}

/** Adds addresses (email only) to a site list: the import call for more than 10, else one call each. */
export async function upsertContacts(listId, emails = []) {
  const id = assertOwnedList(listId);
  const list = cleanEmails(emails);
  if (!list.length) return { ok: true, count: 0 };
  if (brevoBlockedBySafeMode()) {
    intent(`add ${list.length} contact(s) to list ${id}`);
    return { ok: true, count: list.length, stub: true };
  }
  if (list.length > 10) {
    const answer = await brevoRequest('POST', '/contacts/import', {
      listIds: [id],
      jsonBody: list.map((email) => ({ email })),
      updateExistingContacts: true,
      emptyContactsAttributes: false,
    });
    return { ok: true, count: list.length, processId: Number(answer?.processId) || null };
  }
  for (const email of list) {
    await brevoRequest('POST', '/contacts', { email, listIds: [id], updateEnabled: true });
  }
  return { ok: true, count: list.length };
}

/** Removes addresses from one site list. Never the account-wide blocklist. */
export async function removeFromList(listId, emails = []) {
  const id = assertOwnedList(listId);
  const list = cleanEmails(emails);
  if (!list.length) return { ok: true, count: 0 };
  if (brevoBlockedBySafeMode()) {
    intent(`remove ${list.length} contact(s) from list ${id}`);
    return { ok: true, count: list.length, stub: true };
  }
  await brevoRequest('POST', `/contacts/lists/${id}/contacts/remove`, { emails: list });
  return { ok: true, count: list.length };
}

/** The contact, or null when Brevo has none. */
export async function getContact(email) {
  const address = cleanEmails([email])[0];
  if (!address) throw new BrevoError('bad_recipient', { status: 400 });
  if (brevoBlockedBySafeMode()) return null;
  const contact = await brevoRequest('GET', `/contacts/${encodeURIComponent(address)}`, undefined, { allow404: true });
  if (!contact) return null;
  return { email: clean(contact.email, 320).toLowerCase(), listIds: Array.isArray(contact.listIds) ? contact.listIds.map(Number).filter(Number.isInteger) : [], emailBlacklisted: contact.emailBlacklisted === true };
}

export async function deleteContact(email) {
  const address = cleanEmails([email])[0];
  if (!address) throw new BrevoError('bad_recipient', { status: 400 });
  if (brevoBlockedBySafeMode()) {
    intent('delete one contact');
    return { ok: true, stub: true };
  }
  const answer = await brevoRequest('DELETE', `/contacts/${encodeURIComponent(address)}`, undefined, { allow404: true });
  return { ok: true, found: answer !== null };
}

/** Deletes Brevo's transactional log rows for an address (erasure). */
export async function deleteSmtpLog(email) {
  const address = cleanEmails([email])[0];
  if (!address) throw new BrevoError('bad_recipient', { status: 400 });
  if (brevoBlockedBySafeMode()) {
    intent('delete the transactional log of one address');
    return { ok: true, stub: true };
  }
  const answer = await brevoRequest('DELETE', `/smtp/log/${encodeURIComponent(address)}`, undefined, { allow404: true });
  return { ok: true, found: answer !== null };
}

/** Lifts Brevo's transactional block for an address (Superadmin unblock). */
export async function unblockTransactional(email) {
  const address = cleanEmails([email])[0];
  if (!address) throw new BrevoError('bad_recipient', { status: 400 });
  if (brevoBlockedBySafeMode()) {
    intent('unblock one address');
    return { ok: true, stub: true };
  }
  const answer = await brevoRequest('DELETE', `/smtp/blockedContacts/${encodeURIComponent(address)}`, undefined, { allow404: true });
  return { ok: true, found: answer !== null };
}

/* ------------------------------------------------------------------ webhooks */

function webhookBody({ url, token }) {
  return {
    url,
    description: 'Asoldi CMS e-post',
    events: [...WEBHOOK_EVENTS],
    headers: [{ key: 'x-asoldi-webhook', value: token }],
  };
}

/**
 * Registers (or repairs) the transactional webhook. The URL and token are never logged or returned.
 * Resolves { id, created }.
 */
export async function ensureWebhook({ url, token } = {}) {
  const target = clean(url, 500);
  const secret = clean(token, 200);
  if (!/^https:\/\//.test(target) || !secret) throw new BrevoError('bad_webhook', { status: 400 });
  if (brevoBlockedBySafeMode()) {
    intent('register the transactional webhook');
    return { id: stubNumber('webhook', 7_000), created: false, stub: true };
  }
  const settings = readEmailSettings();
  const stored = Number(settings?.brevo?.webhookId);
  const listing = await brevoRequest('GET', '/webhooks?type=transactional');
  const hooks = Array.isArray(listing?.webhooks) ? listing.webhooks : [];
  const base = target.replace(/\/[^/]*$/, '/');
  const existing = hooks.find((hook) => Number(hook?.id) === stored) || hooks.find((hook) => clean(hook?.url, 500).startsWith(base));
  if (existing && Number.isInteger(Number(existing.id))) {
    await brevoRequest('PUT', `/webhooks/${Number(existing.id)}`, webhookBody({ url: target, token: secret }));
    if (Number(existing.id) !== stored) await saveEmailSettings({ brevo: { webhookId: Number(existing.id) } });
    return { id: Number(existing.id), created: false };
  }
  const created = await brevoRequest('POST', '/webhooks', { ...webhookBody({ url: target, token: secret }), type: 'transactional' });
  const id = Number(created?.id);
  if (!Number.isInteger(id) || id <= 0) throw new BrevoError('provider_rejected', { status: 502, brevoCode: 'no_webhook_id' });
  await saveEmailSettings({ brevo: { webhookId: id } });
  return { id, created: true };
}

/* ------------------------------------------------------------------ sender domains */

function cleanDomain(value) {
  const domain = clean(value, 253).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new BrevoError('bad_domain', { status: 400 });
  return domain;
}

export async function createSenderDomain(domain) {
  const name = cleanDomain(domain);
  if (brevoBlockedBySafeMode()) {
    intent(`create sender domain ${name}`);
    return { id: stubNumber(`domain:${name}`, 5_000), domain: name, stub: true };
  }
  const answer = await brevoRequest('POST', '/senders/domains', { name });
  return { id: Number(answer?.id) || null, domain: name, dnsRecords: answer?.dns_records || null };
}

export async function authenticateSenderDomain(domain) {
  const name = cleanDomain(domain);
  if (brevoBlockedBySafeMode()) {
    intent(`authenticate sender domain ${name}`);
    return { domain: name, authenticated: false, stub: true };
  }
  const answer = await brevoRequest('PUT', `/senders/domains/${encodeURIComponent(name)}/authenticate`, {});
  return { domain: name, message: clean(answer?.message, 200) };
}

export async function getSenderDomain(domain) {
  const name = cleanDomain(domain);
  if (brevoBlockedBySafeMode()) return { domain: name, verified: false, authenticated: false, stub: true };
  const answer = await brevoRequest('GET', `/senders/domains/${encodeURIComponent(name)}`, undefined, { allow404: true });
  if (!answer) return null;
  return { domain: name, verified: answer.verified === true, authenticated: answer.authenticated === true, dnsRecords: answer.dns_records || null };
}
