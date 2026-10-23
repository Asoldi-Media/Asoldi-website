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
 * "asoldi" key. Every Asoldi marketing send checks isAsoldiMarketingSuppressed.
 * WS7.4 later re-exports this module from lib/email-unsubscribe.js.
 */
import express from 'express';
import { createHmac } from 'crypto';
import { readEmailSecrets, readEmailSuppressions, updateEmailSuppressions } from '../data/email-store.js';
import { clientIpFromRequest, safeEqual } from './auth-hardening.js';
import { maskEmail } from './email-log.js';

export const ASOLDI_SUPPRESSION_KEY = 'asoldi';
const SITE_URL = 'https://asoldi.com';
const SIGNATURE_LENGTH = 32;
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;
const MAX_CLIENT_ID = 120;

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

function unsubKey() {
  try {
    return readEmailSecrets().unsubKey;
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

export async function recordAsoldiSuppression({ emails = [], clientId = '', source = 'unsubscribe-link', now = Date.now() } = {}) {
  const addresses = [...new Set((Array.isArray(emails) ? emails : [emails]).map(normalizeUnsubscribeEmail).filter(Boolean))];
  if (!addresses.length) return { recorded: [] };
  const at = new Date(now).toISOString();
  await updateEmailSuppressions((rows) => {
    const scope = rows[ASOLDI_SUPPRESSION_KEY] && typeof rows[ASOLDI_SUPPRESSION_KEY] === 'object' ? rows[ASOLDI_SUPPRESSION_KEY] : {};
    for (const email of addresses) {
      if (scope[email]) continue;
      scope[email] = { scope: 'marketing', source, at, ...(clientId ? { clientId: clean(clientId, MAX_CLIENT_ID) } : {}) };
    }
    rows[ASOLDI_SUPPRESSION_KEY] = scope;
  });
  return { recorded: addresses };
}

export function isAsoldiServiceTemplate(templateKey, template = null) {
  if (template && template.preset === true) return true;
  return SERVICE_TEMPLATE_KEYS.has(clean(templateKey || 'thank-you').toLowerCase());
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

  app.post('/email/avmeld', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const clientId = clean(body.c || req.query?.c, MAX_CLIENT_ID);
    const signature = clean(body.s || req.query?.s, 100);
    const oneClick = clean(body['List-Unsubscribe']) === 'One-Click';
    if (!limiter(clientIpFromRequest(req))) {
      return sendPage(res, 429, { state: 'limited' });
    }
    const signed = Boolean(clientId) && verifyAsoldiUnsubscribe(clientId, signature);
    let addresses = signed ? asoldiAddressesForClient(lookup(clientId)) : [];
    let source = oneClick ? 'one-click' : 'unsubscribe-link';
    if (!addresses.length) {
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
      console.error('[avmeld] could not record the opt-out', error?.code || error?.message || error);
      return sendPage(res, 503, { state: 'unavailable' });
    }
    if (oneClick) return res.status(200).type('text/plain').send('Unsubscribed');
    return sendPage(res, 200, { state: 'done', maskedEmails: addresses.map(maskEmail) });
  });
}
