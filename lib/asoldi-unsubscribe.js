/**
 * Real unsubscribe for Asoldi's own marketing email (WS7.14 hotfix).
 *
 * Sales mail links to /email/avmeld?c=<clientId>&s=<sig>. The signature is an
 * HMAC of the client id with the email unsubKey (disk secret store), so the
 * link identifies the sales card without a plain address in the URL. A legacy
 * unsigned ?c= link shows a form that asks for the address.
 *
 * GET only shows a confirm page (link scanners must not unsubscribe anyone).
 * POST records a durable suppression in email-suppressions.json under the
 * "asoldi" key (also the RFC 8058 one-click body). Every Asoldi marketing send
 * checks isAsoldiMarketingSuppressed / asoldiMarketingSendBlock, and carries the
 * signed link plus List-Unsubscribe headers (withAsoldiMarketingUnsubscribe).
 * Typed addresses (the unsigned form) are rate limited per client and capped hub-wide.
 * WS7.4 later re-exports this module from lib/email-unsubscribe.js.
 */
import express from 'express';
import { createHmac } from 'crypto';
import { readEmailSuppressions, readEmailUnsubKey, updateEmailSuppressions } from '../data/email-store.js';
import { safeEqual } from './auth-hardening.js';
import { maskEmail } from './email-log.js';

export const ASOLDI_SUPPRESSION_KEY = 'asoldi';
const SITE_URL = 'https://asoldi.com';
const SIGNATURE_LENGTH = 32;
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;
const MAX_CLIENT_ID = 120;
const HOUR_MS = 60 * 60 * 1000;
/**
 * The address form accepts any typed address, so it is capped hub-wide, whatever
 * the caller's IP: at most this many new form rows per hour, and in total.
 * Signed links only ever suppress their own card's addresses and are not capped.
 */
export const FORM_ROWS_PER_HOUR = 200;
export const FORM_ROWS_MAX = 5000;

/**
 * Sales templates tied to a meeting the person booked, an offer they asked for
 * or a signed project. They are not marketing and still go out after an
 * unsubscribe. Anything else (custom templates, nurture, follow-ups) is
 * marketing and is blocked for suppressed addresses.
 */
const SERVICE_TEMPLATE_KEYS = new Set([
  'thank-you',
  'thank-you-in-person',
  'reminder-3d',
  'reminder-3d-in-person',
  'reminder-24h',
  'reminder-24h-in-person',
  'reminder-1h',
  'reminder-1h-in-person',
  'workshop',
  'workshop-sms-ring',
  'workshop-reminder-3d',
  'workshop-reminder-24h',
  'pre-workshop',
  'pre-workshop-timed',
  'data-innsamling-1',
  'data-innsamling-2',
  'iteration',
  'offer',
]);

function clean(value, max = 320) {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizeUnsubscribeEmail(value) {
  const email = clean(value).toLowerCase();
  return EMAIL_RE.test(email) ? email : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only the HMAC key: signing a link must not create or read any other secret. */
function unsubKey() {
  try {
    return readEmailUnsubKey();
  } catch {
    return '';
  }
}

/** Signature for a sales client id ('' when the id is empty or the secret store is unavailable). */
export function signAsoldiUnsubscribe(clientId) {
  const id = clean(clientId, MAX_CLIENT_ID);
  const key = id ? unsubKey() : '';
  if (!key) return '';
  return createHmac('sha256', key).update(`asoldi-avmeld:v1:${id}`).digest('base64url').slice(0, SIGNATURE_LENGTH);
}

export function verifyAsoldiUnsubscribe(clientId, signature) {
  const sig = clean(signature, 100);
  if (!sig) return false;
  const expected = signAsoldiUnsubscribe(clientId);
  return Boolean(expected) && safeEqual(sig, expected);
}

/** The footer link in Asoldi sales mail. Signed when possible; unsigned links still work through the form. */
export function asoldiUnsubscribeUrl(clientId, siteUrl = SITE_URL) {
  const base = (clean(siteUrl) || SITE_URL).replace(/\/$/, '');
  const id = clean(clientId, MAX_CLIENT_ID);
  if (!id) return `${base}/email/avmeld`;
  const sig = signAsoldiUnsubscribe(id);
  return `${base}/email/avmeld?c=${encodeURIComponent(id)}${sig ? `&s=${sig}` : ''}`;
}

/** Addresses a sales card is mailed at. */
export function asoldiAddressesForClient(client) {
  if (!client) return [];
  const list = [client.contactEmail, client.clientEmail].map(normalizeUnsubscribeEmail).filter(Boolean);
  return [...new Set(list)];
}

/**
 * True when the address opted out of Asoldi marketing (or bounced hard).
 * Fails closed: an unreadable suppression record counts as suppressed.
 */
export function isAsoldiMarketingSuppressed(email) {
  const address = normalizeUnsubscribeEmail(email);
  if (!address) return false;
  try {
    const rows = readEmailSuppressions();
    if (rows?.[ASOLDI_SUPPRESSION_KEY]?.[address]) return true;
    return rows?.['*']?.[address]?.scope === 'all';
  } catch {
    return true;
  }
}

/**
 * True when someone opted out through the signed link of this sales card, even if the
 * card's address changed since. Fails closed like isAsoldiMarketingSuppressed.
 */
export function isAsoldiClientSuppressed(clientId) {
  const id = clean(clientId, MAX_CLIENT_ID);
  if (!id) return false;
  try {
    const rows = readEmailSuppressions()?.[ASOLDI_SUPPRESSION_KEY] || {};
    return Object.values(rows).some((row) => row && row.clientId === id);
  } catch {
    return true;
  }
}

function formCapError() {
  const error = new Error('avmeld: the address form reached its hub-wide cap');
  error.code = 'AVMELD_FORM_CAP';
  return error;
}

/** True when nothing would change: every address is suppressed (and already carries this card id). */
function alreadyRecorded(scope, addresses, clientId) {
  return addresses.every((email) => scope?.[email] && (!clientId || scope[email].clientId));
}

/**
 * Record an Asoldi marketing opt-out. Idempotent: a repeat writes nothing (not even
 * the lock). Form rows (typed addresses) are capped hub-wide and throw AVMELD_FORM_CAP
 * past FORM_ROWS_PER_HOUR / FORM_ROWS_MAX; the check runs under the cross-process lock.
 */
export async function recordAsoldiSuppression({ emails = [], clientId = '', source = 'unsubscribe-link', now = Date.now() } = {}) {
  const addresses = [...new Set((Array.isArray(emails) ? emails : [emails]).map(normalizeUnsubscribeEmail).filter(Boolean))];
  if (!addresses.length) return { recorded: [] };
  const id = clean(clientId, MAX_CLIENT_ID);
  try {
    if (alreadyRecorded(readEmailSuppressions()?.[ASOLDI_SUPPRESSION_KEY], addresses, id)) return { recorded: addresses, added: 0 };
  } catch {
    // An unreadable record is reported by the locked path below.
  }
  const at = new Date(now).toISOString();
  let added = 0;
  await updateEmailSuppressions((rows) => {
    const existing = rows[ASOLDI_SUPPRESSION_KEY];
    const scope = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    const fresh = addresses.filter((email) => !scope[email]);
    if (fresh.length && source === 'unsubscribe-form') {
      const since = now - HOUR_MS;
      let total = 0;
      let lastHour = 0;
      for (const row of Object.values(scope)) {
        if (row?.source !== 'unsubscribe-form') continue;
        total += 1;
        if (Date.parse(row.at) >= since) lastHour += 1;
      }
      if (lastHour + fresh.length > FORM_ROWS_PER_HOUR || total + fresh.length > FORM_ROWS_MAX) throw formCapError();
    }
    for (const email of fresh) {
      scope[email] = { scope: 'marketing', source, at, ...(id ? { clientId: id } : {}) };
    }
    // A signed link also ties an earlier form opt-out to its card (isAsoldiClientSuppressed).
    if (id) for (const email of addresses) if (scope[email] && !scope[email].clientId) scope[email].clientId = id;
    added = fresh.length;
    if (fresh.length) rows[ASOLDI_SUPPRESSION_KEY] = scope;
  });
  return { recorded: addresses, added };
}

/** Keys of the Asoldi service presets. Only asoldiPresets() may hold them (email-templates-store). */
export function isReservedServiceTemplateKey(key) {
  return SERVICE_TEMPLATE_KEYS.has(clean(key).toLowerCase());
}

/**
 * Service mail (meeting, offer, project) still goes after an opt-out. A stored template
 * counts as service only when it is an Asoldi preset with a service key; a custom template
 * is marketing whatever its flags say. A key with no stored row is judged by the key alone.
 */
export function isAsoldiServiceTemplate(templateKey, template = null) {
  if (template) return template.preset === true && isReservedServiceTemplateKey(template.key);
  return isReservedServiceTemplateKey(clean(templateKey) || 'thank-you');
}

function unsubscribeFooterHtml(url) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:16px 12px 24px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#9a9a9a;">`
    + `Du får denne e-posten fra Asoldi. <a href="${escapeHtml(url)}" style="color:#9a9a9a;text-decoration:underline;">Avmeld e-postmarkedsføring</a>`
    + '</td></tr></table>';
}

/**
 * Asoldi marketing mail gets the signed /email/avmeld footer link (html and text) and,
 * when the link is a signed https link, RFC 8058 headers: List-Unsubscribe (https only,
 * no mailto, since no task reads such a mailbox) and List-Unsubscribe-Post. Runs after
 * stripMarketingUnsubscribe, so the link always survives. Service mail is returned as is.
 */
export function withAsoldiMarketingUnsubscribe(message, { clientId = '', service = false, siteUrl = SITE_URL } = {}) {
  if (service || !message) return message;
  const url = asoldiUnsubscribeUrl(clientId, siteUrl);
  const html = String(message.html || '');
  const footer = unsubscribeFooterHtml(url);
  const bodyClose = html.toLowerCase().lastIndexOf('</body');
  const nextHtml = bodyClose >= 0 ? `${html.slice(0, bodyClose)}${footer}${html.slice(bodyClose)}` : `${html}${footer}`;
  const text = String(message.text || '');
  const nextText = text ? `${text.replace(/\s+$/, '')}\n\nAvmeld e-postmarkedsføring fra Asoldi: ${url}\n` : text;
  const headers = { ...(message.headers && typeof message.headers === 'object' ? message.headers : {}) };
  if (/^https:\/\//i.test(url) && /[?&]s=/.test(url)) {
    headers['List-Unsubscribe'] = `<${url}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return { ...message, html: nextHtml, text: nextText, headers };
}

/**
 * Guard for an Asoldi send. Service mail (meeting, offer, project) passes.
 * Marketing to an address that opted out returns a 409 body; otherwise null.
 */
export function asoldiMarketingSendBlock({ to = '', clientId = '', service = false } = {}) {
  if (service) return null;
  const addresses = String(to || '').split(/[,;]/).map((part) => {
    const angle = part.match(/<([^>]+)>/);
    return normalizeUnsubscribeEmail(angle ? angle[1] : part);
  }).filter(Boolean);
  const blocked = addresses.find((address) => isAsoldiMarketingSuppressed(address));
  const cardBlocked = !blocked && isAsoldiClientSuppressed(clientId);
  if (!blocked && !cardBlocked) return null;
  const who = blocked ? `Mottakeren (${maskEmail(blocked)})` : 'Kunden på dette kortet';
  return {
    ok: false,
    code: 'asoldi_unsubscribed',
    message: `${who} har meldt seg av markedsføring fra Asoldi. Denne e-posten er ikke en møte-, tilbuds- eller prosjektmelding, så den sendes ikke.`,
  };
}

const PAGE_COPY = {
  confirm: {
    title: 'Avmeld e-postmarkedsføring',
    body: (masked) => `Vil du slutte å få markedsføring på e-post fra Asoldi til ${masked}?`,
  },
  email: {
    title: 'Avmeld e-postmarkedsføring',
    body: () => 'Skriv e-postadressen du vil melde av, så slutter vi å sende markedsføring på e-post til den.',
  },
  done: {
    title: 'Du er meldt av',
    body: (masked) => `Vi sender ikke mer markedsføring på e-post til ${masked}.`,
  },
  limited: {
    title: 'For mange forsøk',
    body: () => 'Prøv igjen om noen minutter.',
  },
  unavailable: {
    title: 'Vi fikk ikke registrert avmeldingen',
    body: () => 'Prøv igjen om litt, eller svar på e-posten fra oss, så melder vi deg av manuelt.',
  },
};

export function renderAsoldiUnsubscribePage({ state = 'email', clientId = '', signature = '', maskedEmails = [], error = '' } = {}) {
  const copy = PAGE_COPY[state] || PAGE_COPY.email;
  const masked = maskedEmails.map(escapeHtml).join(', ') || 'denne adressen';
  const hidden = `${clientId ? `<input type="hidden" name="c" value="${escapeHtml(clientId)}" />` : ''}${signature ? `<input type="hidden" name="s" value="${escapeHtml(signature)}" />` : ''}`;
  const button = 'background:#FF5B00;color:#fff;border:0;border-radius:999px;padding:12px 24px;font-size:15px;cursor:pointer;';
  let form = '';
  if (state === 'confirm') {
    form = `<form method="post" action="/email/avmeld">${hidden}<button type="submit" style="${button}">Meld meg av</button></form>`;
  } else if (state === 'email') {
    form = `<form method="post" action="/email/avmeld">${hidden}
      <label for="avmeld-email" style="display:block;color:#cfcfcf;margin:0 0 8px;">E-postadresse</label>
      <input id="avmeld-email" name="email" type="email" required autocomplete="email" style="width:100%;max-width:320px;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #444;background:#111;color:#fff;font-size:15px;" />
      <p style="margin:16px 0 0;"><button type="submit" style="${button}">Meld meg av</button></p>
    </form>`;
  }
  const note = state === 'confirm' || state === 'email' || state === 'done'
    ? '<p style="color:#8a8a8a;font-size:13px;line-height:1.6;margin-top:24px;">Du får fortsatt e-post om avtaler du har med oss: møtebekreftelser, tilbud du har bedt om og nettsideprosjektet ditt.</p>'
    : '';
  return `<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(copy.title)} | Asoldi</title>
</head>
<body style="margin:0;background:#050505;color:#fff;font-family:Arial,Helvetica,sans-serif;">
  <main style="max-width:560px;margin:12vh auto;padding:24px;text-align:center;">
    <p style="color:#FF5B00;letter-spacing:0.08em;text-transform:uppercase;font-size:12px;">Asoldi</p>
    <h1 style="font-size:28px;font-weight:normal;">${escapeHtml(copy.title)}</h1>
    <p style="color:#cfcfcf;line-height:1.6;">${copy.body(masked)}</p>
    ${error ? `<p role="alert" style="color:#ff8a65;">${escapeHtml(error)}</p>` : ''}
    ${form}
    ${note}
    <p style="margin-top:32px;"><a href="${SITE_URL}" style="color:#FF5B00;">Tilbake til asoldi.com</a></p>
  </main>
</body>
</html>`;
}

function isInternalAddress(address) {
  const value = String(address || '').trim().toLowerCase().replace(/^::ffff:/, '');
  if (!value) return false;
  if (value === '::1' || /^f[cd][0-9a-f]{2}:/.test(value) || value.startsWith('fe80:')) return true;
  return /^(10|127)\./.test(value) || /^192\.168\./.test(value) || /^172\.(1[6-9]|2\d|3[01])\./.test(value) || /^169\.254\./.test(value);
}

/**
 * Rate-limit key for a request. The left-most X-Forwarded-For entries are whatever the
 * client sent, so they are never used. Behind the hosting proxy (an internal socket peer)
 * the right-most hop is the one that proxy appended, i.e. the real client; a request from
 * a public peer is keyed on the peer itself.
 */
export function unsubscribeRateKey(req) {
  const peer = String(req?.socket?.remoteAddress || '').trim();
  const hops = String(req?.headers?.['x-forwarded-for'] || '').split(',').map((hop) => hop.trim()).filter(Boolean);
  if (hops.length && isInternalAddress(peer)) return hops[hops.length - 1].slice(0, 64);
  return peer || 'unknown';
}

/** RFC 8058 one-click: List-Unsubscribe=One-Click, urlencoded or multipart/form-data. */
function isOneClickBody(body) {
  if (typeof body === 'string') {
    return /name="?List-Unsubscribe"?[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n\s*One-Click\b/i.test(body);
  }
  return clean(body?.['List-Unsubscribe']) === 'One-Click';
}

function createPostLimiter({ windowMs = 10 * 60 * 1000, max = 20, now = () => Date.now() } = {}) {
  const hits = new Map();
  return (ip) => {
    const t = now();
    const key = ip || 'unknown';
    const list = (hits.get(key) || []).filter((at) => t - at < windowMs);
    list.push(t);
    hits.set(key, list);
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (!v.some((at) => t - at < windowMs)) hits.delete(k);
    }
    return list.length <= max;
  };
}

function sendPage(res, status, options) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).type('html').send(renderAsoldiUnsubscribePage(options));
}

/** GET shows a page and never changes state; POST records the opt-out. No login. */
export function registerAsoldiUnsubscribeRoutes(app, { getSalesClientById = () => null, limiter = createPostLimiter(), now = () => Date.now() } = {}) {
  const lookup = (clientId) => {
    try {
      return getSalesClientById(clientId) || null;
    } catch {
      return null;
    }
  };

  app.get('/email/avmeld', (req, res) => {
    const clientId = clean(req.query?.c, MAX_CLIENT_ID);
    const signature = clean(req.query?.s, 100);
    const signed = Boolean(clientId) && verifyAsoldiUnsubscribe(clientId, signature);
    const addresses = signed ? asoldiAddressesForClient(lookup(clientId)) : [];
    if (addresses.length) {
      return sendPage(res, 200, { state: 'confirm', clientId, signature, maskedEmails: addresses.map(maskEmail) });
    }
    return sendPage(res, 200, { state: 'email', clientId: signed ? clientId : '', signature: signed ? signature : '' });
  });

  const parseForm = express.urlencoded({ extended: false, limit: '8kb' });
  // Some mailbox providers send the RFC 8058 one-click POST as multipart/form-data.
  const parseMultipart = express.text({ type: 'multipart/form-data', limit: '8kb' });

  app.post('/email/avmeld', parseForm, parseMultipart, async (req, res) => {
    const rawBody = req.body;
    const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
    const clientId = clean(body.c || req.query?.c, MAX_CLIENT_ID);
    const signature = clean(body.s || req.query?.s, 100);
    const oneClick = isOneClickBody(rawBody);
    const signed = Boolean(clientId) && verifyAsoldiUnsubscribe(clientId, signature);
    let addresses = signed ? asoldiAddressesForClient(lookup(clientId)) : [];
    let source = oneClick ? 'one-click' : 'unsubscribe-link';
    if (!addresses.length) {
      // Typed addresses are the abuse path: limited per client (never on a spoofable header) and capped hub-wide.
      if (!limiter(unsubscribeRateKey(req))) {
        return sendPage(res, 429, { state: 'limited' });
      }
      const typed = normalizeUnsubscribeEmail(body.email);
      if (!typed) {
        return sendPage(res, 400, {
          state: 'email',
          clientId: signed ? clientId : '',
          signature: signed ? signature : '',
          error: clean(body.email) ? 'Skriv en gyldig e-postadresse.' : 'Skriv e-postadressen du vil melde av.',
        });
      }
      addresses = [typed];
      source = 'unsubscribe-form';
    }
    try {
      await recordAsoldiSuppression({ emails: addresses, clientId: signed ? clientId : '', source, now: now() });
    } catch (error) {
      if (error?.code === 'AVMELD_FORM_CAP') {
        console.error('[avmeld] ALERT the address form hit its hub-wide cap; typed opt-outs are paused');
        return sendPage(res, 429, { state: 'limited' });
      }
      console.error('[avmeld] could not record the opt-out', error?.code || 'error');
      return sendPage(res, 503, { state: 'unavailable' });
    }
    if (oneClick) return res.status(200).type('text/plain').send('Unsubscribed');
    return sendPage(res, 200, { state: 'done', maskedEmails: addresses.map(maskEmail) });
  });
}
