// CMS fleet monitor routes (Superadmin). Registered through lib/routes/optional-routes.js.
//
//   GET  /api/admin/cms-fleet           switches, every CMS site evaluated now (contact, block hits,
//                                       conflicts, migrations, last health ping, proposal state and why
//                                       a site is not proposed), the proposals, the last review and
//                                       digest, and the last flips. Reads only.
//   POST /api/admin/cms-fleet/flip      { siteIds?: [id], all?: true, reason? }: featureEnforcement
//                                       'on' for the listed sites (each must be in 'log'), or with
//                                       all for every current proposal nobody dismissed
//   POST /api/admin/cms-fleet/revert    { siteId, reason? }: back from 'on' to 'log'
//   POST /api/admin/cms-fleet/dismiss   { siteId, reason? }: an objection to a proposal (no bulk flip
//                                       and no automatic apply for it)
//
// Every route needs the Superadmin token (401 without it). They act only on a Superadmin request and
// work whatever the cmsFleet switches say; the background jobs live in lib/cms-fleet-monitor.js.
import { dismissProposal, evaluateSite, fleetOverview, flipSites, readFleetState } from '../cms-fleet-monitor.js';
import { readCmsFeatureSettings } from '../../data/cms-feature-settings.js';

const MAX_SITE_IDS = 500;

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function text(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

function actor(req) {
  return `admin:${text(req.admin?.username || 'admin', 100)}`;
}

/** Runs a synchronous handler and answers 500 when it throws (a sites.json lock that timed out). */
function guarded(handler) {
  return (req, res) => {
    try {
      handler(req, res);
    } catch (error) {
      res.status(500).json({ message: text(error?.message || error, 200) || 'Failed' });
    }
  };
}

/**
 * @param {import('express').Express} app
 * @param {{ adminAuth: Function, hub: object, getDataDir?: () => string }} deps
 */
export function register(app, { adminAuth, hub, getDataDir = null } = {}) {
  const dataDir = () => (typeof getDataDir === 'function' ? getDataDir() : undefined);

  app.get('/api/admin/cms-fleet', adminAuth, guarded((_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(fleetOverview({ hub, dataDir: dataDir() }));
  }));

  app.post('/api/admin/cms-fleet/flip', adminAuth, guarded((req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = bodyOf(req);
    const reason = text(body.reason) || 'fleet monitor proposal approved';
    let siteIds;
    if (body.all === true) {
      siteIds = fleetOverview({ hub, dataDir: dataDir() }).proposals;
    } else if (Array.isArray(body.siteIds) && body.siteIds.length && body.siteIds.length <= MAX_SITE_IDS && body.siteIds.every((id) => typeof id === 'string' && id.trim())) {
      siteIds = body.siteIds.map((id) => text(id, 80));
    } else {
      return res.status(400).json({ message: 'Send siteIds (a list of site ids) or all: true.' });
    }
    const results = flipSites({ hub, siteIds, to: 'on', by: actor(req), reason, dataDir: dataDir() });
    res.json({ ok: results.every((row) => row.ok), results });
  }));

  app.post('/api/admin/cms-fleet/revert', adminAuth, guarded((req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = bodyOf(req);
    const siteId = text(body.siteId, 80);
    if (!siteId || !hub.getSiteById(siteId)) return res.status(404).json({ message: 'Site not found' });
    const [result] = flipSites({ hub, siteIds: [siteId], to: 'log', by: actor(req), reason: text(body.reason) || 'enforcement reverted', dataDir: dataDir() });
    if (!result.ok) return res.status(result.status || 409).json({ message: 'Enforcement is not on for this site.', code: result.error, result });
    res.json({ ok: true, result });
  }));

  app.post('/api/admin/cms-fleet/dismiss', adminAuth, guarded((req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = bodyOf(req);
    const siteId = text(body.siteId, 80);
    const site = siteId ? hub.getSiteById(siteId) : null;
    if (!site) return res.status(404).json({ message: 'Site not found' });
    const row = evaluateSite(site, { state: readFleetState({ dataDir: dataDir() }), featureSettings: readCmsFeatureSettings({ dataDir: dataDir() }) });
    const result = dismissProposal({ siteId, by: actor(req), reason: text(body.reason), dataDir: dataDir(), proposable: row.proposable });
    if (!result.ok) return res.status(409).json({ message: 'No open proposal for this site.', code: result.error });
    res.json({ ok: true });
  }));
}
