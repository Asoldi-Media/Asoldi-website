// SEO record routes (lib/seo-ops/record.js). Registered by lib/routes/optional-routes.js.
//
//   GET  /api/admin/sales-clients/:id/seo                 staff (sales, developer, admin): the record
//   PUT  /api/admin/sales-clients/:id/seo                 developer or admin: replace the agreed keywords
//                                                         ({agreedKeywords: [{phrase, status, allowBrand?}]})
//   POST /api/admin/sales-clients/:id/seo/approve         developer or admin: {phrase, source?, quoteRef?,
//                                                         allowBrand?} (400 'brand' for the own name without it)
//   POST /api/admin/sales-clients/:id/seo/block           developer or admin: {phrase, reason?}
//   GET  /api/internal/maker/seo-record?salesClientId=    Maker host (client-bundle scope); 404
//                                                         {code:'disabled'} while seo.recordPull is off
//
// Every answer carries seoRecorded: whether the client has a stored record after the call. The admin
// record view also says whether it is linked: whether a portal profile uses it (the profile's data bank
// names the client and the client's portal link points back at that profile). Until then the site
// config, the Maps keywords and the dashboard ignore the record.
// Access follows the other sales-client and developer routes: a sales rep reads only their own
// clients (403 otherwise); a developer reads the clients they can see on the developer page (404
// otherwise) and changes keywords only on a client they may work on now (403 during a handoff or
// for another developer's client); an admin reads and changes all.
import { getAutomationSettings } from '../../data/automation-settings.js';
import { listClientProfiles } from '../../data/client-portal.js';
import { canWorkDevelopmentClient, developmentItemVisible } from '../developer-assignment.js';
import {
  approveAgreedKeyword,
  blockAgreedKeyword,
  compliancePayload,
  makerSeoRecordView,
  readSeoRecord,
  recordComplianceSignoff,
  SeoRecordError,
  seoRecordPortalLinked,
  seoRecordView,
  updateClientSeo,
} from '../seo-ops/record.js';

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function idOf(value) {
  return String(value ?? '').trim().slice(0, 120);
}

function actorOf(req) {
  const user = req.developmentUser || req.salesUser || req.admin || {};
  return String(user.username || user.email || user.accountKey || user.role || 'staff').slice(0, 120);
}

function brandNameOf(client) {
  return String(client?.brandName || client?.businessName || '').trim();
}

export function seoRecordPullEnabled(settings = getAutomationSettings()) {
  const node = settings?.seo?.recordPull;
  return node?.enabled === true && !node.paused;
}

/** The owner ids a sales rep's clients carry (as salesUserOwnerKeys in server.js). */
export function salesOwnerKeys(salesUser = {}) {
  const keys = new Set();
  const accountKey = idOf(salesUser.accountKey);
  const userId = idOf(salesUser.userId);
  const username = idOf(salesUser.username);
  if (accountKey) keys.add(accountKey);
  if (userId) keys.add(`sales:${userId}`);
  if (username) keys.add(`sales:${username}`);
  return keys;
}

/**
 * Who may read or change a client's SEO record: 'ok', 'not-found' (unknown client, or a developer
 * who cannot see it) or 'forbidden' (another rep's client, or a developer who may not work on it now).
 */
export function seoRecordAccess(req, client, { work = false } = {}) {
  if (!client) return 'not-found';
  const developer = req.developmentUser;
  if (developer) {
    if (developer.isAdmin) return 'ok';
    if (!developmentItemVisible(developer, client)) return 'not-found';
    if (work && !canWorkDevelopmentClient(developer, client)) return 'forbidden';
    return 'ok';
  }
  const salesUser = req.salesUser;
  if (!salesUser || work) return 'forbidden';
  if (salesUser.isAdmin) return 'ok';
  const ownerId = idOf(client.ownerId);
  return ownerId && salesOwnerKeys(salesUser).has(ownerId) ? 'ok' : 'forbidden';
}

/**
 * @param {import('express').Express} app
 * @param {{ salesOrDevelopmentAuth: Function, developmentAuth: Function, makerAuth: { requireMakerHost: Function }, sales: object }} deps
 */
export function register(app, { salesOrDevelopmentAuth, developmentAuth, makerAuth, sales, getDataDir = null }) {
  const settings = () => getAutomationSettings(typeof getDataDir === 'function' ? { dataDir: getDataDir() } : {});

  /** The sales client, or null after answering 404 or 403 (seoRecordAccess). */
  function clientFor(req, res, { work = false } = {}) {
    const client = sales.getSalesClientById(idOf(req.params.id));
    const access = seoRecordAccess(req, client, { work });
    if (access === 'not-found') {
      res.status(404).json({ message: 'Fant ikke kunden.' });
      return null;
    }
    if (access === 'forbidden') {
      const message = req.developmentUser ? 'Prosjektet er tildelt en annen utvikler.' : 'Not your sales client.';
      res.status(403).json({ message });
      return null;
    }
    return client;
  }

  function answer(res, client, status = 200) {
    const record = readSeoRecord(client.id);
    const linked = record ? seoRecordPortalLinked(client, listClientProfiles()) : false;
    res.set('Cache-Control', 'no-store');
    return res.status(status).json({ seoRecorded: Boolean(record), record: seoRecordView(record, { linked }) });
  }

  async function change(req, res, run) {
    const client = clientFor(req, res, { work: true });
    if (!client) return undefined;
    try {
      await run(client);
      return answer(res, client);
    } catch (error) {
      if (error instanceof SeoRecordError) {
        return res.status(error.status || 400).json({ message: error.message, code: error.code, seoRecorded: Boolean(readSeoRecord(client.id)) });
      }
      console.error('[seo-record] change failed:', error?.code || error?.message || error);
      return res.status(500).json({ message: 'Kunne ikke lagre søkeordene.', code: 'error', seoRecorded: Boolean(readSeoRecord(client.id)) });
    }
  }

  app.get('/api/admin/sales-clients/:id/seo', salesOrDevelopmentAuth, (req, res) => {
    const client = clientFor(req, res);
    if (!client) return undefined;
    return answer(res, client);
  });

  app.put('/api/admin/sales-clients/:id/seo', developmentAuth, (req, res) => change(req, res, (client) => {
    const body = bodyOf(req);
    return updateClientSeo(client.id, { agreedKeywords: body.agreedKeywords }, { by: actorOf(req), brandName: brandNameOf(client) });
  }));

  app.post('/api/admin/sales-clients/:id/seo/approve', developmentAuth, (req, res) => change(req, res, (client) => {
    const body = bodyOf(req);
    return approveAgreedKeyword(client.id, body.phrase, {
      by: actorOf(req),
      source: typeof body.source === 'string' ? body.source : '',
      quoteRef: typeof body.quoteRef === 'string' ? body.quoteRef : '',
      brandName: brandNameOf(client),
      allowBrand: body.allowBrand === true,
    });
  }));

  app.put('/api/admin/sales-clients/:id/seo/compliance', salesOrDevelopmentAuth, async (req, res) => {
    const client = sales.getSalesClientById(idOf(req.params.id));
    const access = seoRecordAccess(req, client, { work: true });
    if (access === 'not-found') return res.status(404).json({ ok: false, code: 'not-found' });
    if (access === 'forbidden') return res.status(403).json({ ok: false, code: 'forbidden' });
    const body = bodyOf(req);
    if (body.role !== 'asoldi' && body.role !== 'client') return res.status(400).json({ ok: false, code: 'bad-request', field: 'role' });
    if (typeof body.approve !== 'boolean') return res.status(400).json({ ok: false, code: 'bad-request', field: 'approve' });
    try {
      const record = await recordComplianceSignoff(client.id, { role: body.role, approve: body.approve, by: actorOf(req) });
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, seoRecorded: true, compliance: compliancePayload(record) });
    } catch (error) {
      if (error instanceof SeoRecordError) return res.status(error.status || 400).json({ ok: false, code: 'bad-request', field: error.message === 'approve' ? 'approve' : 'role' });
      console.error('[seo-record] compliance sign-off failed:', error?.code || error?.message || error);
      return res.status(500).json({ ok: false, code: 'error' });
    }
  });

  app.post('/api/admin/sales-clients/:id/seo/block', developmentAuth, (req, res) => change(req, res, (client) => {
    const body = bodyOf(req);
    return blockAgreedKeyword(client.id, body.phrase, {
      by: actorOf(req),
      reason: typeof body.reason === 'string' ? body.reason : '',
      brandName: brandNameOf(client),
    });
  }));

  // The switch is checked before the credential, so a hub with it off answers every caller alike.
  app.get('/api/internal/maker/seo-record', (req, res, next) => {
    if (!seoRecordPullEnabled(settings())) return res.status(404).json({ message: 'Not found.', code: 'disabled' });
    return next();
  }, makerAuth.requireMakerHost('client-bundle'), (req, res) => {
    const id = idOf(req.query?.salesClientId);
    if (!id || !sales.getSalesClientById(id)) return res.status(404).json({ message: 'No matching sales client.', seoRecorded: false });
    const record = readSeoRecord(id);
    res.set('Cache-Control', 'no-store');
    return res.json({ seoRecorded: Boolean(record), record: makerSeoRecordView(record) });
  });
}
