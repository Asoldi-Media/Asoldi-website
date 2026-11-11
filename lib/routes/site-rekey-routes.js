// Site rekey route (staff or Maker host). Registered through lib/routes/optional-routes.js.
//
//   POST /api/admin/sites/rekey
//     { event: 'run.sitekey.adopt', runId, siteId?, salesClientId?, previousSiteKey?, siteKey }
//
// Gives the hub site the key its published site carries (data/hub.js rekeySite): the old key stays
// valid as an alias for 90 days, so the deployed CMS, forms, analytics and heartbeats keep resolving.
// The site is found by siteId, else by previousSiteKey, else by salesClientId.
//
// While the siteRekey switch is off (the default) or paused the route answers 404 { code: 'disabled' }
// before any sign-in check and nothing is read or written. Otherwise it needs a Maker host token
// (x-maker-host-token, scope callback) or the Superadmin token; anything else is 401.
//   200 { ok: true }                      rekeyed (or the site already had the key)
//   400 { code: 'bad-key' | 'bad-event' } the request is malformed
//   409 { code: 'site-key-held' }         another site holds that key (as its key or a live alias)
//   422 { code: 'site-not-found' }        no site matches the ids sent
import { getAutomationSettings } from '../../data/automation-settings.js';

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function rekeySwitchOn(dataDir) {
  try {
    const node = getAutomationSettings({ dataDir }).siteRekey;
    return Boolean(node) && node.enabled === true && !(node.paused && typeof node.paused === 'object');
  } catch {
    return false;
  }
}

/** The hub site a request names: siteId, else the previous key, else the sales client. */
export function findSiteForRekey(hub, { siteId = '', previousSiteKey = '', salesClientId = '', sales = null } = {}) {
  if (siteId) {
    const byId = hub.getSiteById(siteId);
    if (byId) return byId;
  }
  if (previousSiteKey) {
    const byKey = hub.getSiteByKey(previousSiteKey);
    if (byKey) return byKey;
  }
  if (salesClientId) {
    const client = typeof sales?.getSalesClientById === 'function' ? sales.getSalesClientById(salesClientId) : null;
    const linked = text(client?.hubSite?.id);
    if (linked) {
      const byClient = hub.getSiteById(linked);
      if (byClient) return byClient;
    }
    const byPlan = hub.getAllSites().find((site) => text(site.planSource?.salesClientId) === salesClientId);
    if (byPlan) return byPlan;
  }
  return null;
}

/**
 * @param {import('express').Express} app
 * @param {{ adminAuth: Function, makerAuth: object, hub: object, sales?: object, getDataDir?: () => string }} deps
 */
export function register(app, { adminAuth, makerAuth, hub, sales = null, getDataDir = null } = {}) {
  const dataDir = () => (typeof getDataDir === 'function' ? getDataDir() : undefined);
  const hostGate = makerAuth.requireMakerHost('callback', { hostOnly: true });

  app.post('/api/admin/sites/rekey', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!rekeySwitchOn(dataDir())) return res.status(404).json({ code: 'disabled' });
    const host = String(req.headers['x-maker-host-token'] || '').trim();
    return host ? hostGate(req, res, next) : adminAuth(req, res, next);
  }, (req, res) => {
    const body = bodyOf(req);
    const event = text(body.event, 60);
    if (event && event !== 'run.sitekey.adopt') return res.status(400).json({ code: 'bad-event' });
    const siteKey = text(body.siteKey, 200);
    const site = findSiteForRekey(hub, {
      siteId: text(body.siteId, 80),
      previousSiteKey: text(body.previousSiteKey, 200),
      salesClientId: text(body.salesClientId, 80),
      sales,
    });
    if (!site) return res.status(422).json({ code: 'site-not-found' });
    const by = req.makerAuth?.hostId ? `maker:${req.makerAuth.hostId}` : `admin:${text(req.admin?.username || 'admin', 80)}`;
    let result;
    try {
      result = hub.rekeySite(site.id, siteKey, { by, reason: event ? `${event} ${text(body.runId, 80)}`.trim() : '' });
    } catch (error) {
      return res.status(500).json({ message: text(error?.message || error, 200) || 'Failed' });
    }
    if (result.ok) {
      // Keep the sales client's stored link on the key the site now has (the go-live adopt does the same).
      try {
        const clientId = text(body.salesClientId, 80);
        const linked = clientId && typeof sales?.getSalesClientById === 'function' ? sales.getSalesClientById(clientId) : null;
        if (linked?.hubSite && (linked.hubSite.id === site.id || linked.hubSite.siteKey === site.site_key) && linked.hubSite.siteKey !== siteKey) {
          sales.updateSalesClient(linked.id, { hubSite: { ...linked.hubSite, id: site.id, siteKey } });
        }
      } catch { /* the link is a convenience; the site is already rekeyed */ }
      return res.json({ ok: true });
    }
    if (result.code === 'site-key-held') return res.status(409).json({ code: 'site-key-held' });
    if (result.code === 'bad-key') return res.status(400).json({ code: 'bad-key' });
    return res.status(422).json({ code: 'site-not-found' });
  });
}
