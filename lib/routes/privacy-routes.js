// Privacy, media and recording-candidate routes. Registered through lib/routes/optional-routes.js.
//
// Superadmin (adminAuth):
//   GET  /api/admin/system/personal-data-stores        the registry: stores, retention texts, processors
//   GET  /api/admin/sales/:id/personal-data-export     one JSON bundle with every store's records
//   POST /api/admin/sales/:id/erase {dryRun, allowActiveContract, allowMissingClient}
//                                                      403 {code:'purge-disabled'} unless privacy.purge is on;
//                                                      a dry run unless dryRun is false; 409 for a running
//                                                      contract, 404 {code:'client-not-found'} for an id
//                                                      with no client card, unless confirmed
//   GET  /api/admin/system/retention-purge             switch state, last run, reports
//   POST /api/admin/system/retention-purge/run         one purge run now (403 while privacy.purge is off)
// Admin staff (salesAuth, admin only):
//   GET  /api/admin/sales/:id/media-manifest           404 {code:'disabled'} unless media.signedUrls is on
//   GET  /api/admin/fireflies/candidates               404 {code:'disabled'} unless the candidate ranker is on
//   POST /api/admin/fireflies/meetings/:meetingId/candidate-link {clientId, purpose}
//                                                      same switch; a person's link, never automatic
// Signed URL (no session): GET /api/maker/media/:assetId?c&exp&sig
//                                                      404 {code:'disabled'} off, 403 bad signature, 410 expired
// Client portal (clientAuth, a portal user with role 'client'): GET / POST /api/client/media-rights
//                                                      404 {code:'disabled'} unless media.rightsConfirm is on
import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPersistentDataDir } from '../../data/storage-path.js';
import { getUserById } from '../../data/store.js';
import {
  eraseClient,
  exportClient,
  isValidClientId,
  loadStoreModules,
  retentionText,
} from '../personal-data.js';
import { listPurgeReports, runRetentionPurge } from '../delivery-retention.js';
import {
  MEDIA_RIGHTS_MAX_ITEMS,
  buildMediaManifest,
  mediaRightsForPortalUser,
  recordMediaRightsBatch,
  resolveMediaAsset,
  verifyMediaRequest,
} from '../media-manifest.js';
import {
  candidatesForUnownedRecordings,
  rankRecordingCandidates,
  recordingIsUnowned,
} from '../fireflies-candidate-rank.js';
import { activeFirefliesLinker } from '../fireflies-linking.js';
import { meetingRefForClient, readStoredFirefliesMeeting } from '../fireflies-webhook.js';
import {
  firefliesRankSettings,
  purgeSettings,
  rightsConfirmEnabled,
  sendDisabled,
  signedMediaEnabled,
} from '../privacy-settings.js';

export const CANDIDATE_PURPOSES = Object.freeze(['', 'sales', 'workshop', 'iteration', 'demo']);

function text(value) {
  return String(value ?? '').trim();
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function refuse(_req, res) {
  res.status(401).json({ message: 'Unauthorized' });
}

function adminStaff(req, res, next) {
  if (req.salesUser?.isAdmin) return next();
  return res.status(403).json({ message: 'Admin only.' });
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function staffLabel(req) {
  return text(req.salesUser?.name || req.salesUser?.username || req.salesUser?.accountKey) || 'admin';
}

/**
 * Every route is added before register returns (the hub registers its page fallback right after,
 * and loads server.js without a top-level await). It returns a promise for the store modules,
 * which load in the background; the hub answers no request before that promise has settled.
 */
export function register(app, deps = {}) {
  const adminAuth = deps.adminAuth || refuse;
  const salesAuth = deps.salesAuth || refuse;
  const clientAuth = deps.clientAuth || refuse;
  const findUser = typeof deps.getUserById === 'function' ? deps.getUserById : getUserById;
  const sales = deps.sales;

  // The portal user behind a client token, as the other client routes load it: role 'client' only.
  async function portalUser(req, res) {
    const userId = text(req.client?.userId);
    const user = userId ? await findUser(userId) : null;
    if (!user || user.role !== 'client') {
      res.status(401).json({ message: 'Unauthorized' });
      return null;
    }
    return user;
  }
  const dataDir = () => (typeof deps.getDataDir === 'function' ? deps.getDataDir() : getPersistentDataDir());
  if (!sales) throw new Error('privacy-routes: deps.sales is required');
  const started = loadStoreModules();

  // ------------------------------------------------------------ registry, export, erase

  app.get('/api/admin/system/personal-data-stores', adminAuth, async (_req, res) => {
    noStore(res);
    const stores = await loadStoreModules();
    res.json({
      stores: stores.map((store) => ({
        id: store.id,
        label: store.label,
        files: store.files,
        dir: store.dir,
        clientKey: store.clientKey,
        personalData: store.personalData,
        purpose: store.purpose,
        legalBasis: store.legalBasis,
        processors: store.processors,
        retention: retentionText(store.id),
        purge: Boolean(store.purge),
      })),
    });
  });

  app.get('/api/admin/sales/:id/personal-data-export', adminAuth, async (req, res) => {
    noStore(res);
    const id = text(req.params.id);
    if (!isValidClientId(id)) return res.status(400).json({ message: 'Invalid client id.' });
    try {
      const bundle = await exportClient(id, { dataDir: dataDir() });
      const empty = bundle.stores.every((store) => !store.records.length && !store.files.length);
      if (!bundle.found && empty) return res.status(404).json({ message: 'Sales client not found.' });
      res.setHeader('Content-Disposition', `attachment; filename="personal-data-${id}.json"`);
      return res.json(bundle);
    } catch (error) {
      return res.status(error?.status || 500).json({ message: text(error?.message) || 'Export failed.' });
    }
  });

  app.post('/api/admin/sales/:id/erase', adminAuth, async (req, res) => {
    noStore(res);
    if (!purgeSettings().enabled) {
      return res.status(403).json({ code: 'purge-disabled', message: 'Sletting er slått av (privacy.purge).' });
    }
    const id = text(req.params.id);
    if (!isValidClientId(id)) return res.status(400).json({ message: 'Invalid client id.' });
    const body = bodyOf(req);
    try {
      const result = await eraseClient(id, {
        dryRun: body.dryRun !== false,
        allowActiveContract: body.allowActiveContract === true,
        allowMissingClient: body.allowMissingClient === true,
        dataDir: dataDir(),
        by: text(req.admin?.username) || 'superadmin',
      });
      if (result.blocked === 'active-contract') return res.status(409).json({ code: 'active-contract', ...result });
      if (result.blocked === 'client-not-found') return res.status(404).json({ code: 'client-not-found', ...result });
      if (result.blocked === 'busy') return res.status(409).json({ code: 'busy', ...result });
      return res.json(result);
    } catch (error) {
      return res.status(error?.status || 500).json({ message: text(error?.message) || 'Erase failed.' });
    }
  });

  app.get('/api/admin/system/retention-purge', adminAuth, (_req, res) => {
    noStore(res);
    let state = null;
    try {
      state = JSON.parse(readFileSync(join(dataDir(), 'privacy', 'retention-state.json'), 'utf8'));
    } catch {
      state = null;
    }
    res.json({ settings: purgeSettings(), lastRun: state, reports: listPurgeReports({ dataDir: dataDir() }).slice(0, 30) });
  });

  app.post('/api/admin/system/retention-purge/run', adminAuth, async (_req, res) => {
    noStore(res);
    if (!purgeSettings().enabled) return res.status(403).json({ code: 'purge-disabled', message: 'Sletting er slått av (privacy.purge).' });
    const result = await runRetentionPurge({ dataDir: dataDir(), force: true });
    return res.json(result);
  });

  // ------------------------------------------------------------ media manifest and signed downloads

  app.get('/api/admin/sales/:id/media-manifest', salesAuth, adminStaff, (req, res) => {
    noStore(res);
    if (!signedMediaEnabled()) return sendDisabled(res);
    const id = text(req.params.id);
    if (!isValidClientId(id)) return res.status(400).json({ message: 'Invalid client id.' });
    try {
      const manifest = buildMediaManifest(id, { dataDir: dataDir() });
      if (!manifest) return res.status(404).json({ message: 'Sales client not found.' });
      return res.json(manifest);
    } catch (error) {
      return res.status(error?.status || 500).json({ message: text(error?.message) || 'Manifest failed.' });
    }
  });

  app.get('/api/maker/media/:assetId', (req, res) => {
    noStore(res);
    if (!signedMediaEnabled()) return sendDisabled(res);
    const check = verifyMediaRequest({ assetId: req.params.assetId, query: req.query || {}, dataDir: dataDir() });
    if (!check.ok) return res.status(check.status).json({ code: check.code });
    const asset = resolveMediaAsset(check.clientId, check.assetId, { dataDir: dataDir() });
    if (!asset) return res.status(404).json({ code: 'not-found' });
    res.setHeader('Content-Type', asset.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${asset.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (asset.sha256) res.setHeader('X-Content-SHA256', asset.sha256);
    const stream = createReadStream(asset.path);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ code: 'not-found' });
      else res.destroy();
    });
    return stream.pipe(res);
  });

  // ------------------------------------------------------------ rights checkbox (client portal)

  // Client-facing: while the switch is off both routes answer 404 disabled before the sign-in check,
  // so a caller without a session sees the same answer as for a route that does not exist.
  const rightsSwitch = (_req, res, next) => {
    if (rightsConfirmEnabled()) return next();
    noStore(res);
    return sendDisabled(res);
  };

  app.get('/api/client/media-rights', rightsSwitch, clientAuth, async (req, res) => {
    noStore(res);
    if (!rightsConfirmEnabled()) return sendDisabled(res);
    const user = await portalUser(req, res);
    if (!user) return undefined;
    return res.json({ enabled: true, rights: mediaRightsForPortalUser(user.id, { dataDir: dataDir() }) });
  });

  app.post('/api/client/media-rights', rightsSwitch, clientAuth, async (req, res) => {
    noStore(res);
    if (!rightsConfirmEnabled()) return sendDisabled(res);
    const user = await portalUser(req, res);
    if (!user) return undefined;
    const body = bodyOf(req);
    const items = Array.isArray(body.items) ? body.items : [{ url: body.url, confirmed: body.confirmed }];
    if (items.length > MEDIA_RIGHTS_MAX_ITEMS) return res.status(400).json({ message: `Høyst ${MEDIA_RIGHTS_MAX_ITEMS} filer om gangen.` });
    const result = recordMediaRightsBatch({ userId: user.id, items, dataDir: dataDir() });
    if (!result.ok) return res.status(result.status || 400).json({ message: result.message });
    return res.json({ ok: true, saved: result.saved });
  });

  // ------------------------------------------------------------ recording candidates

  app.get('/api/admin/fireflies/candidates', salesAuth, adminStaff, (_req, res) => {
    noStore(res);
    const config = firefliesRankSettings();
    if (!config.rankerEnabled) return sendDisabled(res);
    const recordings = candidatesForUnownedRecordings({ clients: sales.getSalesClients() });
    return res.json({ enabled: true, candidateMinScore: config.candidateMinScore, purposes: CANDIDATE_PURPOSES.filter(Boolean), recordings });
  });

  app.post('/api/admin/fireflies/meetings/:meetingId/candidate-link', salesAuth, adminStaff, (req, res) => {
    noStore(res);
    const config = firefliesRankSettings();
    if (!config.rankerEnabled) return sendDisabled(res);
    const body = bodyOf(req);
    const purpose = text(body.purpose).toLowerCase();
    if (!CANDIDATE_PURPOSES.includes(purpose)) return res.status(400).json({ message: 'Velg salg, workshop, iterasjon, demo eller automatisk.' });
    const record = readStoredFirefliesMeeting(req.params.meetingId);
    if (!record) return res.status(404).json({ message: 'Meeting not found.' });
    const client = sales.getSalesClientById(text(body.clientId));
    if (!client) return res.status(404).json({ message: 'Sales client not found.' });
    const clients = sales.getSalesClients();
    if (!recordingIsUnowned(record, clients)) return res.status(409).json({ code: 'owned', message: 'Opptaket hører allerede til en kunde.' });
    const linker = activeFirefliesLinker();
    if (!linker) return res.status(503).json({ message: 'Koblingen er ikke klar. Prøv igjen.' });
    const ranked = rankRecordingCandidates(record, clients, { minScore: config.candidateMinScore, internalDomains: config.internalDomains });
    const index = ranked.findIndex((row) => row.clientId === client.id);
    const actor = text(req.salesUser?.accountKey) || 'admin';
    const match = {
      clientId: client.id,
      businessName: text(client.businessName),
      confidence: 'manual',
      score: 100,
      reasons: ['Koblet fra kandidatlisten'],
      linkedBy: actor,
    };
    const ref = {
      ...meetingRefForClient(record, match, { linkedBy: actor }),
      audit: { action: 'candidate-link', ...(index >= 0 ? { rank: index + 1, score: ranked[index].score } : {}) },
    };
    const linked = linker.link(client.id, ref);
    if (!linked) return res.status(404).json({ message: 'Sales client not found.' });
    let updated = linked;
    if (purpose) updated = linker.setPurpose(client.id, record.meetingId, purpose, { by: staffLabel(req), actor }) || linked;
    const row = (updated?.meetings || []).find((entry) => text(entry.meetingId) === text(record.meetingId)) || null;
    return res.json({
      meetingId: record.meetingId,
      clientId: client.id,
      purpose: text(row?.purpose),
      linkedBy: text(row?.linkedBy),
      rank: index >= 0 ? index + 1 : null,
    });
  });

  return started.then(() => undefined);
}
