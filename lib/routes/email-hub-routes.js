/**
 * Hub email core routes: emailKey provisioning, the public unsubscribe pages and the Superadmin
 * controls for the email settings, key rotation, the opt-out rebuild and the owner-routing default.
 *
 * While the email platform is off (email setting `enabled`, the default) every /api/hub/email/*
 * route here answers 404 { code: 'disabled' } and writes nothing. Superadmin routes stay available.
 * Exception: once Brevo has accepted a relay send (email-relay-sent.json), the unsubscribe pages
 * stay open even if the platform is switched off again, so links in delivered mail keep working.
 * The public POST routes are limited per token and per client address.
 * CMS → hub send, contacts and quota routes are not here; they use requireEmailKey from
 * lib/email-site-auth.js.
 *
 * The owner-routing default runs at boot and daily while enabled (lease 'email-owner-routing',
 * so two hub workers do not both run it). Off, it reads and writes nothing. Opt-outs left pending
 * while the record was unavailable are merged in at boot (only when that file exists).
 */
import express from 'express';
import { createHash } from 'crypto';
import { acquireLease, readEmailSettings, saveEmailSettings } from '../../data/email-store.js';
import { clientIpFromRequest } from '../auth-hardening.js';
import { brevoConfigured } from '../brevo.js';
import { postCmsHint } from '../email-hint.js';
import { quotaSnapshot } from '../email-quota.js';
import {
  EMAIL_KEY_HEADER,
  confirmProvision,
  currentEmailKey,
  emailPlatformEnabled,
  issuePending,
  provisionRequest,
  siteKeyStatus,
} from '../email-site-auth.js';
import {
  UNSUB_PAGE_HEADERS,
  addSuppression,
  applyPendingSuppressions,
  brandFor,
  canResubscribe,
  pageLanguage,
  pendingSuppressionsExist,
  readUnsubToken,
  rebuildSuppressionsFromCms,
  relayHasSent,
  renderUnsubPage,
  resubscribe,
} from '../email-unsubscribe.js';
import { applyOwnerRoutingDefault, previewOwnerRoutingDefault } from '../owner-recipients.js';
import { safeModeState } from '../runtime-mode.js';
import { siteCredentialState } from '../site-credentials.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The /api/hub/email/ routes that do not take the emailKey: provisioning and the public pages. */
export const PUBLIC_EMAIL_ROUTES = Object.freeze([
  'POST /api/hub/email/provision-request',
  'POST /api/hub/email/provision/confirm',
  'GET /api/hub/email/unsubscribe',
  'POST /api/hub/email/unsubscribe',
  'POST /api/hub/email/resubscribe',
]);
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;
const ROLLOUT_MODES = new Set(['off', 'allowlist', 'all']);

function clean(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((id) => clean(id, 80)).filter(Boolean))].slice(0, 500);
}

function adminName(req) {
  return clean(req.admin?.username || req.admin?.email, 80) || 'admin';
}

/** 404 { code: 'disabled' } while the email platform is off. */
export function requireEmailEnabled({ settings = () => readEmailSettings() } = {}) {
  return (_req, res, next) => {
    if (emailPlatformEnabled(settings())) return next();
    return res.status(404).json({ code: 'disabled' });
  };
}

/**
 * The unsubscribe pages: 404 { code: 'disabled' } while the platform is off and Brevo never
 * accepted a relay send. Once one was delivered, its unsubscribe links keep working even if the
 * platform is switched off again (the kill switch pauses sends without closing them). Only the
 * relay's own marker counts, never another sender's log line.
 */
export function requireUnsubscribeOpen({ settings = () => readEmailSettings(), hasSent = () => relayHasSent() } = {}) {
  return (_req, res, next) => {
    if (emailPlatformEnabled(settings()) || hasSent()) return next();
    return res.status(404).json({ code: 'disabled' });
  };
}

/**
 * Sliding-window limits for the public POST routes: per unsubscribe token (one recipient of one
 * mail) and, much higher, per client address (mail providers post one-click opt-outs for many
 * people from few addresses). In memory, at most `maxKeys` keys, oldest dropped first.
 */
export function createPublicPostLimiter({ perToken = 10, perAddress = 300, windowMs = 10 * 60_000, maxKeys = 5000, now = () => Date.now() } = {}) {
  const hits = new Map();
  const take = (key, limit) => {
    const at = now();
    const times = (hits.get(key) || []).filter((t) => at - t < windowMs);
    if (times.length >= limit) {
      hits.set(key, times);
      return Math.max(1, Math.ceil((times[0] + windowMs - at) / 1000));
    }
    times.push(at);
    hits.delete(key);
    hits.set(key, times);
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    return 0;
  };
  return {
    /** 0 when the request may go on, else the seconds to wait. */
    check(req, token) {
      const address = clean(clientIpFromRequest(req), 64) || 'unknown';
      const waitAddress = take(`a:${address}`, perAddress);
      if (waitAddress) return waitAddress;
      if (!token) return 0;
      return take(`t:${createHash('sha256').update(String(token)).digest('hex').slice(0, 32)}`, perToken);
    },
  };
}

function sendPage(res, status, html) {
  res.status(status).set(UNSUB_PAGE_HEADERS).type('html').send(html);
}

/** Provision request and confirm: at most this many per client address in 10 minutes. */
export const PROVISION_PER_ADDRESS = 30;

/** Wraps an async handler: an error becomes 503 { ok:false, code:'unavailable' } instead of a hanging request. */
function wrap(handler, label, extra = {}) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      console.error(`[email-hub] ${label} failed:`, error?.code || 'error');
      if (!res.headersSent) res.status(503).set('Cache-Control', 'no-store').json({ ok: false, code: 'unavailable', ...extra });
    }
  };
}

const NOT_SAVED = { message: 'The email settings could not be read or saved; nothing was changed.' };

/**
 * Registers the routes. Options (tests): now, fetchImpl (hub → CMS calls), env, startJobs,
 * limits (createPublicPostLimiter options for the unsubscribe pages), provisionLimits (the same for
 * provision request and confirm, per client address). Returns { runOwnerRoutingDefault, stop }.
 */
export function registerEmailHubRoutes(app, deps = {}, { now = () => Date.now(), fetchImpl = undefined, env = process.env, startJobs = true, limits = {}, provisionLimits = {} } = {}) {
  const { adminAuth, hub } = deps;
  if (typeof adminAuth !== 'function' || !hub?.getSiteById || !hub?.getSiteByKey || !hub?.getAllSites) {
    throw new Error('email-hub-routes: adminAuth and hub are required');
  }
  const getSalesClients = () => {
    try {
      return typeof deps.sales?.getSalesClients === 'function' ? deps.sales.getSalesClients() : [];
    } catch {
      return [];
    }
  };
  const enabled = requireEmailEnabled();
  const unsubscribeOpen = requireUnsubscribeOpen();
  const postLimiter = createPublicPostLimiter({ now, ...limits });
  const provisionLimiter = createPublicPostLimiter({ perAddress: PROVISION_PER_ADDRESS, now, ...provisionLimits });
  const provisionLimit = (req, res, next) => {
    const wait = provisionLimiter.check(req, '');
    if (!wait) return next();
    res.set('Retry-After', String(wait)).set('Cache-Control', 'no-store');
    return res.status(429).json({ ok: false, code: 'rate_limited' });
  };
  const form = express.urlencoded({ extended: false, limit: '4kb' });
  const hintDeps = () => ({ ...(fetchImpl ? { fetchImpl } : {}), env, now: now() });

  // ── Provisioning (client CMS, server to server) ──────────────────────────
  // The answer is the same { ok:true } for every caller without a valid site credential, and never
  // carries the site-credential status header: the site key is public, so it must learn nothing.
  app.post('/api/hub/email/provision-request', enabled, provisionLimit, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const siteKey = clean(req.get('x-site-key'), 200);
    const site = siteKey ? hub.getSiteByKey(siteKey) : null;
    if (!site?.id) return res.json({ ok: true });
    const state = siteCredentialState(req, site);
    try {
      const result = await provisionRequest({ site, credentialState: state, now: now() });
      if (result.emailKey) return res.json({ ok: true, keyId: result.keyId, emailKey: result.emailKey });
    } catch (error) {
      console.error('[email-hub] provision request failed:', error?.code || 'error');
    }
    return res.json({ ok: true });
  }, 'provision request'));

  app.post('/api/hub/email/provision/confirm', enabled, provisionLimit, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const siteKey = clean(req.get('x-site-key'), 200);
    const named = siteKey ? hub.getSiteByKey(siteKey) : null;
    if (siteKey && !named) return res.status(401).json({ ok: false, code: 'unauthorized' });
    const result = await confirmProvision(req.get(EMAIL_KEY_HEADER), { now: now(), siteId: named?.id || '' });
    if (!result.ok) return res.status(401).json({ ok: false, code: 'unauthorized' });
    return res.json({ ok: true, keyId: result.keyId });
  }, 'provision confirm'));

  // ── Public unsubscribe pages ─────────────────────────────────────────────
  function tokenSite(req) {
    const token = clean(req.query?.t, 1300);
    const data = readUnsubToken(token);
    if (!data) return { token, data: null, site: null };
    return { token, data, site: hub.getSiteById(data.siteId) || { id: data.siteId } };
  }

  function langFor(req, site) {
    const asked = clean(req.query?.lang, 5);
    return asked ? pageLanguage(asked) : brandFor(site).lang;
  }

  app.get('/api/hub/email/unsubscribe', unsubscribeOpen, (req, res) => {
    const { token, data, site } = tokenSite(req);
    if (!data) return sendPage(res, 400, renderUnsubPage({ state: 'invalid', lang: pageLanguage(req.query?.lang) }));
    const brand = brandFor(site);
    return sendPage(res, 200, renderUnsubPage({ state: 'confirm', lang: langFor(req, site), shop: brand.name, accent: brand.accent, email: data.email, token }));
  });

  app.post('/api/hub/email/unsubscribe', unsubscribeOpen, form, async (req, res) => {
    const { token, data, site } = tokenSite(req);
    // RFC 8058 allows the one-click body as urlencoded or as multipart form data.
    const oneClick = clean(req.body?.['List-Unsubscribe'], 40) === 'One-Click' || /multipart\/form-data/i.test(clean(req.get('content-type'), 200));
    const wait = postLimiter.check(req, data ? token : '');
    if (wait) {
      res.set('Retry-After', String(wait));
      if (oneClick) return res.status(429).type('text').set('Cache-Control', 'no-store').send('busy');
      return sendPage(res, 429, renderUnsubPage({ state: 'unavailable', lang: pageLanguage(req.query?.lang) }));
    }
    if (!data) {
      if (oneClick) return res.status(400).type('text').set('Cache-Control', 'no-store').send('invalid');
      return sendPage(res, 400, renderUnsubPage({ state: 'invalid', lang: pageLanguage(req.query?.lang) }));
    }
    const brand = brandFor(site);
    const lang = langFor(req, site);
    try {
      await addSuppression({ site: site?.domain ? site : null, siteId: data.siteId, email: data.email, scope: 'marketing', source: oneClick ? 'one-click' : 'unsubscribe-link', messageId: data.messageId, now: now() }, hintDeps());
    } catch (error) {
      console.error('[email-hub] unsubscribe failed:', error?.code || 'error');
      if (oneClick) return res.status(503).type('text').set('Cache-Control', 'no-store').send('unavailable');
      return sendPage(res, 503, renderUnsubPage({ state: 'unavailable', lang, shop: brand.name, accent: brand.accent }));
    }
    if (oneClick) return res.status(200).type('text').set('Cache-Control', 'no-store').send('unsubscribed');
    return sendPage(res, 200, renderUnsubPage({ state: 'done', lang, shop: brand.name, accent: brand.accent, email: data.email, token, canUndo: canResubscribe(data.siteId, data.email, { now: now() }) }));
  });

  app.post('/api/hub/email/resubscribe', unsubscribeOpen, form, async (req, res) => {
    const { token, data, site } = tokenSite(req);
    const wait = postLimiter.check(req, data ? token : '');
    if (wait) {
      res.set('Retry-After', String(wait));
      return sendPage(res, 429, renderUnsubPage({ state: 'unavailable', lang: pageLanguage(req.query?.lang) }));
    }
    if (!data) return sendPage(res, 400, renderUnsubPage({ state: 'invalid', lang: pageLanguage(req.query?.lang) }));
    const brand = brandFor(site);
    const lang = langFor(req, site);
    let result;
    try {
      result = await resubscribe({ site, email: data.email, now: now() }, hintDeps());
    } catch (error) {
      console.error('[email-hub] resubscribe failed:', error?.code || 'error');
      return sendPage(res, 503, renderUnsubPage({ state: 'unavailable', lang, shop: brand.name, accent: brand.accent }));
    }
    return sendPage(res, result.ok ? 200 : 409, renderUnsubPage({ state: result.ok ? 'resubscribed' : 'denied', lang, shop: brand.name, accent: brand.accent }));
  });

  // ── Superadmin ───────────────────────────────────────────────────────────
  app.get('/api/admin/email/status', adminAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const settings = readEmailSettings();
    const ids = new Set([...(settings.rollout?.siteIds || []).map(String)]);
    const sites = hub.getAllSites().filter((site) => ids.has(String(site.id)) || currentEmailKey(site.id) || siteKeyStatus(site.id).pendingKeyId)
      .map((site) => ({ siteId: String(site.id), name: clean(site.name, 120), domain: clean(site.domain, 200), key: siteKeyStatus(site.id, { now: now() }) }));
    let quota = null;
    try {
      quota = quotaSnapshot({ now: now() });
    } catch {
      quota = { unavailable: true };
    }
    return res.json({
      enabled: settings.enabled === true,
      rollout: settings.rollout,
      killSwitch: settings.killSwitch === true,
      brevo: { configured: brevoConfigured({ env }), sandbox: settings.brevo?.sandbox === true, syncContacts: settings.brevo?.syncContacts === true },
      ownerRoutingDefault: settings.ownerRoutingDefault,
      sites,
      quota,
    });
  });

  app.put('/api/admin/email/settings', adminAuth, wrap(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be true or false.' });
      patch.enabled = body.enabled;
    }
    if (body.killSwitch !== undefined) {
      if (typeof body.killSwitch !== 'boolean') return res.status(400).json({ message: 'killSwitch must be true or false.' });
      patch.killSwitch = body.killSwitch;
    }
    if (body.rollout !== undefined) {
      const mode = clean(body.rollout?.mode, 20);
      if (!ROLLOUT_MODES.has(mode)) return res.status(400).json({ message: 'rollout.mode must be off, allowlist or all.' });
      patch.rollout = { mode, siteIds: cleanIds(body.rollout?.siteIds) };
    }
    if (body.brevo !== undefined) {
      const brevo = {};
      for (const key of ['sandbox', 'syncContacts']) {
        if (body.brevo?.[key] === undefined) continue;
        if (typeof body.brevo[key] !== 'boolean') return res.status(400).json({ message: `brevo.${key} must be true or false.` });
        brevo[key] = body.brevo[key];
      }
      patch.brevo = brevo;
    }
    if (body.testRecipients !== undefined) {
      const list = (Array.isArray(body.testRecipients) ? body.testRecipients : []).map((e) => clean(e, 320).toLowerCase());
      if (list.some((e) => !EMAIL_RE.test(e)) || list.length > 20) return res.status(400).json({ message: 'testRecipients must be up to 20 e-mail addresses.' });
      patch.testRecipients = [...new Set(list)];
    }
    if (body.devCmsTargets !== undefined) {
      if (!safeModeState(env).on) return res.status(400).json({ message: 'devCmsTargets is a local test setting and is refused outside safe mode.' });
      const targets = {};
      for (const [id, value] of Object.entries(body.devCmsTargets && typeof body.devCmsTargets === 'object' ? body.devCmsTargets : {})) {
        if (value === null) targets[clean(id, 80)] = null;
        else if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/?$/.test(clean(value, 100))) targets[clean(id, 80)] = clean(value, 100).replace(/\/$/, '');
        else return res.status(400).json({ message: 'devCmsTargets values must be loopback origins.' });
      }
      patch.devCmsTargets = targets;
    }
    const saved = await saveEmailSettings(patch);
    console.log(`[email-hub] settings changed by ${adminName(req)}: ${Object.keys(patch).join(', ') || 'nothing'}`);
    return res.json({ ok: true, enabled: saved.enabled === true, rollout: saved.rollout, killSwitch: saved.killSwitch === true, brevo: { sandbox: saved.brevo?.sandbox === true, syncContacts: saved.brevo?.syncContacts === true }, testRecipients: saved.testRecipients });
  }, 'settings change', NOT_SAVED));

  app.post('/api/admin/email/sites/:id/provision', adminAuth, async (req, res) => {
    const site = hub.getSiteById(clean(req.params.id, 80));
    if (!site?.id) return res.status(404).json({ message: 'Site not found.' });
    try {
      const hadKey = Boolean(currentEmailKey(site.id));
      const { keyId } = await issuePending(site.id, { now: now() });
      if (hadKey) Promise.resolve(postCmsHint(site, 'key-rotation', { keyId }, hintDeps())).catch(() => {});
      console.log(`[email-hub] ${hadKey ? 'rotation' : 'first key'} ${keyId} issued for ${site.id} by ${adminName(req)}`);
      return res.json({ ok: true, pendingKeyId: keyId, rotation: hadKey, key: siteKeyStatus(site.id, { now: now() }) });
    } catch (error) {
      return res.status(503).json({ message: 'The email secrets could not be read; nothing was changed.', code: error?.code || 'unavailable' });
    }
  });

  app.post('/api/admin/email/suppressions/rebuild', adminAuth, async (req, res) => {
    const base = req.body?.base && typeof req.body.base === 'object' && !Array.isArray(req.body.base) ? req.body.base : null;
    let result;
    try {
      result = await rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, force: req.body?.force === true, base, now: now(), env, ...(fetchImpl ? { fetchImpl } : {}) });
    } catch (error) {
      return res.status(503).json({ ok: false, written: false, code: error?.code || 'unavailable' });
    }
    console.log(`[email-hub] opt-out rebuild by ${adminName(req)}: mode=${result.mode} written=${result.written} changed=${result.changed} sites=${result.sites} failed=${result.failed.length}${result.reason ? ` reason=${result.reason}` : ''}`);
    return res.status(result.ok ? 200 : 409).json(result);
  });

  app.get('/api/admin/email/owner-routing/preview', adminAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json(previewOwnerRoutingDefault({ getAllSites: hub.getAllSites, getSalesClients }));
  });

  app.put('/api/admin/email/owner-routing/default', adminAuth, wrap(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be true or false.' });
    const siteIds = cleanIds(body.siteIds);
    const saved = await saveEmailSettings({ ownerRoutingDefault: { enabled: body.enabled, siteIds } });
    console.log(`[email-hub] owner routing default ${body.enabled ? 'on' : 'off'} for ${siteIds.length} site(s) by ${adminName(req)}`);
    const result = body.enabled ? await runOwnerRoutingDefault() : { ran: false, changed: [], skipped: 0 };
    return res.json({ ownerRoutingDefault: saved.ownerRoutingDefault, result, preview: previewOwnerRoutingDefault({ getAllSites: hub.getAllSites, getSalesClients }) });
  }, 'owner routing default change', NOT_SAVED));

  // ── Owner routing default job ────────────────────────────────────────────
  async function runOwnerRoutingDefault() {
    const settings = readEmailSettings();
    if (settings.ownerRoutingDefault?.enabled !== true) return { ran: false, changed: [], skipped: 0 };
    const lease = await acquireLease('email-owner-routing', 5 * 60_000).catch(() => null);
    if (!lease) return { ran: false, changed: [], skipped: 0, busy: true };
    try {
      const result = await applyOwnerRoutingDefault({ getAllSites: hub.getAllSites, getSalesClients, now: now(), settings });
      if (result.changed.length) console.log(`[email-hub] owner routing default set on ${result.changed.length} site(s): ${result.changed.join(', ')}`);
      return result;
    } finally {
      await lease.release().catch(() => {});
    }
  }

  let timer = null;
  let bootTimer = null;
  if (startJobs) {
    const run = () => runOwnerRoutingDefault().catch((error) => console.error('[email-hub] owner routing default failed:', error?.code || error?.message || 'error'));
    const drain = () => {
      if (!pendingSuppressionsExist()) return;
      applyPendingSuppressions({ now: now() })
        .then((result) => { if (result.applied) console.log(`[email-hub] merged ${result.applied} pending opt-out(s) into the record`); })
        .catch((error) => console.error('[email-hub] pending opt-outs not merged:', error?.code || 'error'));
    };
    bootTimer = setTimeout(() => {
      drain();
      run();
    }, 0);
    bootTimer.unref?.();
    timer = setInterval(() => {
      drain();
      run();
    }, DAY_MS);
    timer.unref?.();
  }

  return {
    runOwnerRoutingDefault,
    stop() {
      if (timer) clearInterval(timer);
      if (bootTimer) clearTimeout(bootTimer);
      timer = null;
      bootTimer = null;
    },
  };
}

export async function register(app, deps) {
  registerEmailHubRoutes(app, deps);
}
