/**
 * Hub email core routes: emailKey provisioning, the public unsubscribe pages and the Superadmin
 * controls for the email settings, key rotation, the opt-out rebuild and the owner-routing default.
 *
 * While the email platform is off (email setting `enabled`, the default) every /api/hub/email/*
 * route here answers 404 { code: 'disabled' } and writes nothing. Superadmin routes stay available.
 * CMS → hub send, contacts and quota routes are not here; they use requireEmailKey from
 * lib/email-site-auth.js.
 *
 * The owner-routing default runs at boot and daily while enabled (lease 'email-owner-routing',
 * so two hub workers do not both run it). Off, it reads and writes nothing.
 */
import express from 'express';
import { acquireLease, readEmailSettings, saveEmailSettings } from '../../data/email-store.js';
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
  brandFor,
  canResubscribe,
  pageLanguage,
  readUnsubToken,
  rebuildSuppressionsFromCms,
  renderUnsubPage,
  resubscribe,
} from '../email-unsubscribe.js';
import { applyOwnerRoutingDefault, previewOwnerRoutingDefault } from '../owner-recipients.js';
import { safeModeState } from '../runtime-mode.js';
import { siteCredentialState } from '../site-credentials.js';

const DAY_MS = 24 * 60 * 60 * 1000;
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

function sendPage(res, status, html) {
  res.status(status).set(UNSUB_PAGE_HEADERS).type('html').send(html);
}

/**
 * Registers the routes. Options (tests): now, fetchImpl (hub → CMS calls), env, startJobs.
 * Returns { runOwnerRoutingDefault, stop }.
 */
export function registerEmailHubRoutes(app, deps = {}, { now = () => Date.now(), fetchImpl = undefined, env = process.env, startJobs = true } = {}) {
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
  const form = express.urlencoded({ extended: false, limit: '4kb' });
  const hintDeps = () => ({ ...(fetchImpl ? { fetchImpl } : {}), env, now: now() });

  // ── Provisioning (client CMS, server to server) ──────────────────────────
  app.post('/api/hub/email/provision-request', enabled, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const siteKey = clean(req.get('x-site-key'), 200);
    const site = siteKey ? hub.getSiteByKey(siteKey) : null;
    if (!site?.id) return res.json({ ok: true });
    const state = siteCredentialState(req, site, { res });
    try {
      const result = await provisionRequest({ site, credentialState: state, now: now() });
      if (result.emailKey) return res.json({ ok: true, keyId: result.keyId, emailKey: result.emailKey });
    } catch (error) {
      console.error('[email-hub] provision request failed:', error?.code || 'error');
    }
    return res.json({ ok: true });
  });

  app.post('/api/hub/email/provision/confirm', enabled, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const siteKey = clean(req.get('x-site-key'), 200);
    const named = siteKey ? hub.getSiteByKey(siteKey) : null;
    if (siteKey && !named) return res.status(401).json({ ok: false, code: 'unauthorized' });
    const result = await confirmProvision(req.get(EMAIL_KEY_HEADER), { now: now(), siteId: named?.id || '' });
    if (!result.ok) return res.status(401).json({ ok: false, code: 'unauthorized' });
    return res.json({ ok: true, keyId: result.keyId });
  });

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

  app.get('/api/hub/email/unsubscribe', enabled, (req, res) => {
    const { token, data, site } = tokenSite(req);
    if (!data) return sendPage(res, 400, renderUnsubPage({ state: 'invalid', lang: pageLanguage(req.query?.lang) }));
    const brand = brandFor(site);
    return sendPage(res, 200, renderUnsubPage({ state: 'confirm', lang: langFor(req, site), shop: brand.name, accent: brand.accent, email: data.email, token }));
  });

  app.post('/api/hub/email/unsubscribe', enabled, form, async (req, res) => {
    const { token, data, site } = tokenSite(req);
    // RFC 8058 allows the one-click body as urlencoded or as multipart form data.
    const oneClick = clean(req.body?.['List-Unsubscribe'], 40) === 'One-Click' || /multipart\/form-data/i.test(clean(req.get('content-type'), 200));
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

  app.post('/api/hub/email/resubscribe', enabled, form, async (req, res) => {
    const { data, site } = tokenSite(req);
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

  app.put('/api/admin/email/settings', adminAuth, async (req, res) => {
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
  });

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
    const result = await rebuildSuppressionsFromCms({ getAllSites: hub.getAllSites, force: req.body?.force === true, now: now(), env, ...(fetchImpl ? { fetchImpl } : {}) });
    console.log(`[email-hub] opt-out rebuild by ${adminName(req)}: written=${result.written} sites=${result.sites} failed=${result.failed.length}`);
    return res.status(result.ok ? 200 : 409).json(result);
  });

  app.get('/api/admin/email/owner-routing/preview', adminAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json(previewOwnerRoutingDefault({ getAllSites: hub.getAllSites, getSalesClients }));
  });

  app.put('/api/admin/email/owner-routing/default', adminAuth, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be true or false.' });
    const siteIds = cleanIds(body.siteIds);
    const saved = await saveEmailSettings({ ownerRoutingDefault: { enabled: body.enabled, siteIds } });
    console.log(`[email-hub] owner routing default ${body.enabled ? 'on' : 'off'} for ${siteIds.length} site(s) by ${adminName(req)}`);
    const result = body.enabled ? await runOwnerRoutingDefault() : { ran: false, changed: [], skipped: 0 };
    return res.json({ ownerRoutingDefault: saved.ownerRoutingDefault, result, preview: previewOwnerRoutingDefault({ getAllSites: hub.getAllSites, getSalesClients }) });
  });

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
    bootTimer = setTimeout(run, 0);
    bootTimer.unref?.();
    timer = setInterval(run, DAY_MS);
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
