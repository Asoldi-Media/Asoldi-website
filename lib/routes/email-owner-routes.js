/**
 * Owner recipients and owner notices for client sites (lib/email-owner.js,
 * docs/email-owner-notify.md).
 *
 * CMS-facing, behind the site's emailKey (x-email-key), 120 requests a minute per site, and only for
 * a site in the e-mail rollout (else 403 not_enabled):
 *   PUT  /api/hub/email/owner-recipients   { emails: [<=3], actor: { username, rank:'owner' } }
 *   POST /api/hub/email/owner-notify       { kind, subject, text, html?, dedupeKey }
 * Public pages behind the links in the confirm and change mails (GET shows a button, only POST
 * changes state; the POSTs are limited per link and per client address):
 *   GET|POST /api/hub/email/owner-recipients/confirm?t=
 *   GET|POST /api/hub/email/owner-recipients/revert?t=
 *
 * While the e-mail platform is off (email setting `enabled`, the default) every route answers
 * 404 { code: 'disabled' } before any other check and nothing is written. Exception: the two pages
 * stay open while a change younger than 7 days that was not reverted exists, so a revert link in a
 * delivered change notice keeps working when the platform is switched off again.
 */
import express from 'express';
import { readEmailSettings } from '../../data/email-store.js';
import { confirmOwnerRecipient, ownerLinksOpen, readOwnerToken, revertOwnerChange, sendOwnerNotice, setOwnerRecipients } from '../email-owner.js';
import { emailPlatformEnabled, requireEmailKey, siteInRollout } from '../email-site-auth.js';
import { UNSUB_PAGE_HEADERS } from '../email-unsubscribe.js';
import { createPublicPostLimiter, requireEmailEnabled } from './email-hub-routes.js';
import { createSiteBurstLimit } from './email-site-routes.js';

/** The CMS-facing owner routes (each behind the emailKey). */
export const EMAIL_OWNER_SITE_ROUTES = Object.freeze([
  'PUT /api/hub/email/owner-recipients',
  'POST /api/hub/email/owner-notify',
]);
/** The public pages behind the confirm and revert links. */
export const EMAIL_OWNER_PUBLIC_ROUTES = Object.freeze([
  'GET /api/hub/email/owner-recipients/confirm',
  'POST /api/hub/email/owner-recipients/confirm',
  'GET /api/hub/email/owner-recipients/revert',
  'POST /api/hub/email/owner-recipients/revert',
]);

function clean(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const COPY = {
  confirm: { heading: 'Bekreft e-postadressen', body: (shop) => `Adressen skal få varsler fra ${shop} (bestillinger, skjemaer og rapporter).`, button: 'Bekreft adressen' },
  confirmed: { heading: 'Adressen er bekreftet', body: (shop) => `Adressen får nå varsler fra ${shop}.` },
  revert: { heading: 'Angre endringen', body: (shop) => `Varslingsadressene for ${shop} settes tilbake slik de var før endringen.`, button: 'Angre endringen' },
  reverted: { heading: 'Endringen er angret', body: (shop) => `Varslingsadressene for ${shop} er satt tilbake.` },
  already: { heading: 'Endringen er allerede angret', body: () => 'Det er ikke noe mer å gjøre.' },
  invalid: { heading: 'Lenken er ugyldig', body: () => 'Lenken gjelder ikke lenger, eller den er endret.' },
  expired: { heading: 'Lenken er utløpt', body: () => 'Lenken gjaldt i 7 dager.' },
  busy: { heading: 'For mange forsøk', body: () => 'Prøv igjen om litt.' },
  unavailable: { heading: 'Noe gikk galt', body: () => 'Prøv igjen om litt.' },
};

/** The page HTML (Norwegian, no external assets). state: a COPY key; action and token for the button. */
export function renderOwnerPage({ state = 'invalid', shop = '', action = '', token = '' } = {}) {
  const copy = COPY[state] || COPY.invalid;
  const name = clean(shop, 120) || 'nettbutikken';
  const button = copy.button && action && token
    ? `<form method="post" action="/api/hub/email/owner-recipients/${action}?t=${encodeURIComponent(token)}"><button type="submit">${escapeHtml(copy.button)}</button></form>`
    : '';
  return `<!doctype html><html lang="nb"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(copy.heading)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f6;color:#222}main{max-width:480px;margin:10vh auto;padding:24px;background:#fff;border-radius:8px}h1{font-size:1.4em;margin-top:0}button{font:inherit;padding:10px 18px;border:0;border-radius:6px;background:#0f2a44;color:#fff;cursor:pointer}</style></head><body><main><h1>${escapeHtml(copy.heading)}</h1><p>${escapeHtml(copy.body(name))}</p>${button}</main></body></html>`;
}

function sendPage(res, status, html) {
  res.status(status).set(UNSUB_PAGE_HEADERS).type('html').send(html);
}

/** Wraps an async handler: an error becomes 503 { ok:false, code:'unavailable' } (or the error page). */
function wrap(handler, { page = false } = {}) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      console.error('[email-owner] request failed:', error?.code || 'error');
      if (res.headersSent) return;
      if (page) sendPage(res, 503, renderOwnerPage({ state: 'unavailable' }));
      else res.status(503).set('Cache-Control', 'no-store').json({ ok: false, code: 'unavailable' });
    }
  };
}

/**
 * Registers the routes. Options (tests): now, env, sendEmail (the hub mailer by default), limits
 * (createPublicPostLimiter options for the pages), burst (createSiteBurstLimit options).
 */
export function registerEmailOwnerRoutes(app, deps = {}, { now = () => Date.now(), env = process.env, sendEmail = null, limits = {}, burst = {} } = {}) {
  const { hub } = deps;
  if (!hub?.getSiteById || !hub?.getSiteByKey) throw new Error('email-owner-routes: hub is required');
  const getSalesClients = () => {
    try {
      return typeof deps.sales?.getSalesClients === 'function' ? deps.sales.getSalesClients() : [];
    } catch {
      return [];
    }
  };
  const enabled = requireEmailEnabled();
  const emailKey = requireEmailKey({ getSiteById: hub.getSiteById, getSiteByKey: hub.getSiteByKey, now });
  const limit = createSiteBurstLimit({ now, ...burst });
  const inRollout = (req, res, next) => {
    if (siteInRollout(req.emailAuth.siteId, readEmailSettings())) return next();
    return res.status(403).json({ ok: false, code: 'not_enabled' });
  };
  const site = [enabled, emailKey, limit, inRollout];

  app.put('/api/hub/email/owner-recipients', ...site, wrap(async (req, res) => {
    const result = await setOwnerRecipients(req.emailAuth.site, req.body, { now: now(), env, sendEmail, getSalesClients });
    res.status(result.status).json(result.body);
  }));

  app.post('/api/hub/email/owner-notify', ...site, wrap(async (req, res) => {
    const result = await sendOwnerNotice(req.emailAuth.site, req.body, { now: now(), env, sendEmail, allowInternal: false, getSalesClients });
    res.status(result.status).json(result.body);
  }));

  // ── The pages behind the links ───────────────────────────────────────────
  const pagesOpen = (_req, res, next) => {
    if (emailPlatformEnabled(readEmailSettings()) || ownerLinksOpen({ now: now() })) return next();
    return res.status(404).json({ code: 'disabled' });
  };
  const postLimiter = createPublicPostLimiter({ now, ...limits });
  const form = express.urlencoded({ extended: false, limit: '4kb' });
  const shopFor = (siteId) => {
    const target = siteId ? hub.getSiteById(siteId) : null;
    return clean(target?.name, 120) || clean(target?.domain, 120);
  };

  for (const action of ['confirm', 'revert']) {
    const path = `/api/hub/email/owner-recipients/${action}`;
    app.get(path, pagesOpen, wrap(async (req, res) => {
      const token = clean(req.query?.t, 900);
      const data = readOwnerToken(token, { now: now() });
      if (!data || data.action !== action) return sendPage(res, 400, renderOwnerPage({ state: 'invalid' }));
      if (data.expired) return sendPage(res, 410, renderOwnerPage({ state: 'expired', shop: shopFor(data.siteId) }));
      return sendPage(res, 200, renderOwnerPage({ state: action, shop: shopFor(data.siteId), action, token }));
    }, { page: true }));

    app.post(path, pagesOpen, form, wrap(async (req, res) => {
      const token = clean(req.query?.t, 900);
      const wait = postLimiter.check(req, token);
      if (wait) {
        res.set('Retry-After', String(wait));
        return sendPage(res, 429, renderOwnerPage({ state: 'busy' }));
      }
      const result = action === 'confirm' ? await confirmOwnerRecipient(token, { now: now() }) : await revertOwnerChange(token, { now: now() });
      return sendPage(res, result.status, renderOwnerPage({ state: result.state, shop: shopFor(result.siteId) }));
    }, { page: true }));
  }
}

export async function register(app, deps) {
  registerEmailOwnerRoutes(app, deps);
}
