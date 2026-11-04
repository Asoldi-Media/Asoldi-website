/**
 * The client CMS → hub email API (the site routes), the Brevo webhook route, and the wake loop
 * that calls each enabled CMS's email tick. docs/email-credential.md describes the contract.
 *
 * Every site route needs the site's emailKey (x-email-key, lib/email-site-auth.js requireEmailKey);
 * the site key, alone or with the site credential, gets 401. Each site may make 120 requests a
 * minute across these routes (then 429 rate_limited with Retry-After). While the email platform
 * is off (email setting `enabled`, the default) every route here answers 404 { code: 'disabled' },
 * the wake loop calls nobody and nothing is written.
 *
 *   POST   /api/hub/email/send                         relay one message (lib/email-relay.js)
 *   POST   /api/hub/email/contacts                     { upsert:[{email}], remove:[email] }, a no-op
 *                                                      unless contact sync is on
 *   DELETE /api/hub/email/contacts                     { email }: erase one address for the site
 *   GET    /api/hub/email/quota                        the site's own quota view
 *   GET    /api/hub/email/suppressions?since=          the site's opt-out rows
 *   GET    /api/hub/email/stats?campaignId|kind,from,to|refs
 *   POST   /api/hub/email/lint                         { subject, html, text, kind }: link verdicts
 *   GET    /api/hub/email/owner-recipients             [{ email, status }]
 * Answer 501 { code: 'not_available' } until their part of the platform exists: the campaign
 * routes, PUT /api/hub/email/owner-recipients and POST /api/hub/email/owner-notify.
 *
 * POST /api/hub/email/brevo-webhook/:token takes Brevo's events later; today it checks the token
 * and the x-asoldi-webhook header and answers 503 not_ready (an unknown token gets 404).
 *
 * The wake loop runs every 5 minutes (lib/email-wake.js); POST /api/admin/email/sites/:id/wake
 * (superadmin) wakes one site now.
 */
import { readCmsFeatureSettings, siteConfigModeFor } from '../../data/cms-feature-settings.js';
import { readEmailSecrets, readEmailSettings, readEmailSite } from '../../data/email-store.js';
import * as brevoClient from '../brevo.js';
import { cmsFeatureRegistry, resolveSiteFeatures } from '../cms-entitlements.js';
import * as emailLog from '../email-log.js';
import { createEmailQuota } from '../email-quota.js';
import { checkLinks, relaySend } from '../email-relay.js';
import { keysMatch, requireEmailKey } from '../email-site-auth.js';
import { campaignsFor } from '../email-site-config.js';
import { eraseSiteAddress, listSuppressions, normalizeAddress } from '../email-unsubscribe.js';
import { WAKE_EVERY_MS, createEmailWake } from '../email-wake.js';
import { salesClientForSite } from '../local-blog-brief.js';
import { requireEmailEnabled } from './email-hub-routes.js';

/** The CMS-facing routes, each behind the emailKey. */
export const EMAIL_SITE_ROUTES = Object.freeze([
  'POST /api/hub/email/send',
  'POST /api/hub/email/contacts',
  'DELETE /api/hub/email/contacts',
  'GET /api/hub/email/quota',
  'GET /api/hub/email/suppressions',
  'GET /api/hub/email/stats',
  'POST /api/hub/email/lint',
  'POST /api/hub/email/campaigns',
  'POST /api/hub/email/campaigns/:id/recipients',
  'POST /api/hub/email/campaigns/:id/start',
  'POST /api/hub/email/campaigns/:id/cancel',
  'GET /api/hub/email/campaigns/:id',
  'GET /api/hub/email/owner-recipients',
  'PUT /api/hub/email/owner-recipients',
  'POST /api/hub/email/owner-notify',
]);
/** /api/hub/email/ routes that take another credential than the emailKey (Brevo's webhook token). */
export const EMAIL_WEBHOOK_ROUTES = Object.freeze(['POST /api/hub/email/brevo-webhook/:token']);
export const SITE_BURST_PER_MINUTE = 120;
const CONTACTS_MAX = 500;
const WEBHOOK_HEADER = 'x-asoldi-webhook';
const quietLog = { warn() {}, error() {}, log() {} };

function clean(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Per-site sliding window over one minute (after the emailKey check): at most `perMinute` requests,
 * then 429 { ok:false, code:'rate_limited', retryAt } with Retry-After. In memory, at most
 * `maxSites` sites, oldest dropped first.
 */
export function createSiteBurstLimit({ perMinute = SITE_BURST_PER_MINUTE, windowMs = 60_000, maxSites = 5000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const siteId = clean(req.emailAuth?.siteId, 80);
    if (!siteId) return res.status(401).json({ ok: false, code: 'unauthorized' });
    const at = now();
    const times = (hits.get(siteId) || []).filter((t) => at - t < windowMs);
    if (times.length >= perMinute) {
      hits.set(siteId, times);
      const wait = Math.max(1, Math.ceil((times[0] + windowMs - at) / 1000));
      res.set('Retry-After', String(wait));
      return res.status(429).json({ ok: false, code: 'rate_limited', retryAt: new Date(at + wait * 1000).toISOString() });
    }
    times.push(at);
    hits.delete(siteId);
    hits.set(siteId, times);
    while (hits.size > maxSites) hits.delete(hits.keys().next().value);
    return next();
  };
}

function cleanEmails(list, max = CONTACTS_MAX + 1) {
  const out = [];
  for (const entry of Array.isArray(list) ? list.slice(0, max) : []) {
    const address = normalizeAddress(isPlainObject(entry) ? entry.email : entry);
    if (address && !out.includes(address)) out.push(address);
  }
  return out;
}

function notAvailable(_req, res) {
  res.status(501).json({ ok: false, code: 'not_available' });
}

/** Wraps an async handler: an error becomes 503 { code: 'unavailable' } (or the code it names). */
function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const code = error?.code === 'EMAIL_STORE_UNREADABLE' ? 'unavailable' : clean(error?.code, 60) || 'unavailable';
      console.error('[email-site] request failed:', code);
      if (!res.headersSent) res.status(503).json({ ok: false, code });
    }
  };
}

/**
 * Registers the site routes and the webhook route, and starts the wake loop (startJobs).
 * Options (tests): now, env, fetchImpl (wakes), startJobs, relayDeps (relaySend deps: brevo,
 * quota, log, settings), brevo (contacts and erasure calls), burst (createSiteBurstLimit options).
 * Returns { wake, stop }.
 */
export function registerEmailSiteRoutes(app, deps = {}, { now = () => Date.now(), env = process.env, fetchImpl = undefined, startJobs = true, relayDeps = {}, brevo = brevoClient, burst = {} } = {}) {
  const { adminAuth, hub } = deps;
  if (typeof adminAuth !== 'function' || !hub?.getSiteById || !hub?.getSiteByKey || !hub?.getAllSites) {
    throw new Error('email-site-routes: adminAuth and hub are required');
  }
  const getSalesClients = () => {
    try {
      return typeof deps.sales?.getSalesClients === 'function' ? deps.sales.getSalesClients() : [];
    } catch {
      return [];
    }
  };
  const dataDir = () => (typeof deps.getDataDir === 'function' ? deps.getDataDir() : undefined);

  /** The site's entitled keys from the feature tree when site-config carries the tree for it, else null (legacy flags). */
  function treeEntitledKeys(site) {
    try {
      if (siteConfigModeFor(site, readCmsFeatureSettings({ dataDir: dataDir() })) !== 'on') return null;
      const registry = cmsFeatureRegistry();
      if (!registry) return null;
      return resolveSiteFeatures(site, salesClientForSite(site, getSalesClients()), { registry, log: quietLog }).resolved.entitled;
    } catch {
      return null;
    }
  }

  const enabled = requireEmailEnabled();
  const emailKey = requireEmailKey({ getSiteById: hub.getSiteById, getSiteByKey: hub.getSiteByKey, now });
  const limit = createSiteBurstLimit({ now, ...burst });
  const site = [enabled, emailKey, limit];
  const quota = relayDeps.quota || createEmailQuota();

  app.post('/api/hub/email/send', ...site, wrap(async (req, res) => {
    const result = await relaySend(req.emailAuth.site, req.body, {
      now: now(),
      authenticated: true,
      deps: { entitledKeys: treeEntitledKeys, getSalesClients, ...relayDeps },
    });
    res.status(result.status).json(result.body);
  }));

  app.post('/api/hub/email/contacts', ...site, wrap(async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const upsert = cleanEmails(body.upsert);
    const remove = cleanEmails(body.remove);
    if (upsert.length + remove.length > CONTACTS_MAX) return res.status(400).json({ ok: false, code: 'too_many', max: CONTACTS_MAX });
    const settings = readEmailSettings();
    if (settings.brevo?.syncContacts !== true) return res.json({ ok: true, synced: 0, removed: 0, sync: false });
    if (!brevo.brevoConfigured({ env })) return res.status(503).json({ ok: false, code: 'not_configured' });
    const listId = await brevo.ensureSiteList(req.emailAuth.site);
    const added = upsert.length ? await brevo.upsertContacts(listId, upsert) : { count: 0 };
    const dropped = remove.length ? await brevo.removeFromList(listId, remove) : { count: 0 };
    return res.json({ ok: true, synced: added.count || 0, removed: dropped.count || 0, sync: true });
  }));

  app.delete('/api/hub/email/contacts', ...site, wrap(async (req, res) => {
    const address = normalizeAddress(req.body?.email);
    if (!address) return res.status(400).json({ ok: false, code: 'bad_recipient' });
    const siteId = req.emailAuth.siteId;
    const { erased } = await eraseSiteAddress(siteId, address, { now: now() });
    const provider = { list: false, log: false, contact: false };
    if (brevo.brevoConfigured({ env })) {
      const settings = readEmailSettings();
      const listId = Number(readEmailSite(siteId).brevoListId);
      try {
        if (settings.brevo?.syncContacts === true && Number.isInteger(listId) && listId > 0) {
          await brevo.removeFromList(listId, [address]);
          provider.list = true;
        }
        await brevo.deleteSmtpLog(address);
        provider.log = true;
        const contact = await brevo.getContact(address);
        // The Brevo contact is shared by every site; it goes only when no other site's list holds it.
        if (contact && contact.listIds.every((id) => Number.isInteger(listId) && id === listId)) {
          await brevo.deleteContact(address);
          provider.contact = true;
        }
      } catch (error) {
        console.warn('[email-site] provider erasure incomplete:', error?.code || 'error');
        return res.status(502).json({ ok: false, code: 'provider_unavailable', erased, provider });
      }
    }
    return res.json({ ok: true, erased, provider });
  }));

  app.get('/api/hub/email/quota', ...site, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const settings = readEmailSettings();
    let view;
    try {
      view = quota.siteQuotaView(req.emailAuth.siteId, { now: now() });
    } catch {
      return res.status(503).json({ ok: false, code: 'quota_unavailable' });
    }
    const row = readEmailSite(req.emailAuth.siteId);
    return res.json({
      ...view,
      campaigns: campaignsFor(req.emailAuth.site, settings, { entitled: treeEntitledKeys(req.emailAuth.site) }),
      paused: settings.killSwitch === true,
      suspended: Boolean(row.suspended),
    });
  }));

  app.get('/api/hub/email/suppressions', ...site, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      return res.json(listSuppressions(req.emailAuth.siteId, { since: clean(req.query?.since, 40) }));
    } catch {
      return res.status(503).json({ ok: false, code: 'suppressions_unavailable' });
    }
  }));

  app.get('/api/hub/email/stats', ...site, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const q = req.query || {};
    const log = relayDeps.log || emailLog;
    return res.json(log.statsFor({
      siteId: req.emailAuth.siteId,
      campaignId: clean(q.campaignId, 80),
      kind: clean(q.kind, 40),
      from: clean(q.from, 40),
      to: clean(q.to, 40),
      refs: clean(q.refs, 4000).split(',').map((ref) => ref.trim()).filter(Boolean).slice(0, 200),
    }));
  }));

  app.post('/api/hub/email/lint', ...site, wrap(async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const html = typeof body.html === 'string' ? body.html : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const verdicts = checkLinks(html, req.emailAuth.site, { emailSite: readEmailSite(req.emailAuth.siteId), settings: readEmailSettings(), text });
    return res.json({
      claims: [],
      claimsChecked: false,
      links: verdicts.slice(0, 500).map((v) => ({ href: v.url || '', kind: v.kind, ok: v.ok === true, host: v.host || '', reason: v.reason || '', tag: v.tag || '' })),
    });
  }));

  app.post('/api/hub/email/campaigns', ...site, notAvailable);
  app.post('/api/hub/email/campaigns/:id/recipients', ...site, notAvailable);
  app.post('/api/hub/email/campaigns/:id/start', ...site, notAvailable);
  app.post('/api/hub/email/campaigns/:id/cancel', ...site, notAvailable);
  app.get('/api/hub/email/campaigns/:id', ...site, notAvailable);

  app.get('/api/hub/email/owner-recipients', ...site, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const rows = readEmailSite(req.emailAuth.siteId).ownerRecipients || [];
    return res.json(rows.map((row) => ({ email: row.email, status: row.status })));
  }));
  app.put('/api/hub/email/owner-recipients', ...site, notAvailable);
  app.post('/api/hub/email/owner-notify', ...site, notAvailable);

  registerEmailWebhook(app);

  const wakes = createEmailWake({ getAllSites: hub.getAllSites });
  const runWake = (options = {}) => wakes.wake({ now: now(), env, ...(fetchImpl ? { fetchImpl } : {}), ...options });

  app.post('/api/admin/email/sites/:id/wake', adminAuth, enabled, wrap(async (req, res) => {
    const target = hub.getSiteById(clean(req.params.id, 80));
    if (!target?.id) return res.status(404).json({ message: 'Site not found.' });
    const result = await runWake({ only: target.id, lease: false });
    const row = result.results[0];
    if (!row) return res.status(409).json({ ok: false, code: 'not_ready', message: 'The site is not in the rollout, its key is not confirmed, or the kill switch is on.' });
    return res.json({ ok: row.ok === true, status: row.status || 0, reason: row.reason || '', answer: row.answer || null });
  }));

  // The first wake comes one interval after start (a CMS runs its own tick at start anyway).
  let timer = null;
  if (startJobs) {
    timer = setInterval(() => {
      runWake().catch((error) => console.error('[email-wake] failed:', error?.code || error?.message || 'error'));
    }, WAKE_EVERY_MS);
    timer.unref?.();
  }

  return {
    wake: runWake,
    wakeFailures: () => wakes.failures(),
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * POST /api/hub/email/brevo-webhook/:token. Brevo calls it with the hub's webhook token in the
 * path and in the x-asoldi-webhook header. Off: 404 disabled. Another token: 404. The event
 * handling is not part of this build, so a valid call gets 503 not_ready and Brevo tries again.
 */
export function registerEmailWebhook(app) {
  const enabled = requireEmailEnabled();
  app.post('/api/hub/email/brevo-webhook/:token', enabled, (req, res) => {
    res.set('Cache-Control', 'no-store');
    let expected = '';
    try {
      expected = clean(readEmailSecrets().webhookToken, 200);
    } catch {
      return res.status(503).json({ ok: false, code: 'unavailable' });
    }
    const given = clean(req.params.token, 200);
    const header = clean(req.get(WEBHOOK_HEADER), 200);
    if (!expected || !keysMatch(given, expected) || !keysMatch(header, expected)) return res.status(404).json({ ok: false, code: 'not_found' });
    res.set('Retry-After', '3600');
    return res.status(503).json({ ok: false, code: 'not_ready' });
  });
}

/** The name the email platform's design uses for the site routes. */
export const registerEmailRoutes = registerEmailSiteRoutes;

export async function register(app, deps) {
  registerEmailSiteRoutes(app, deps);
}
