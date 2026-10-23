// Delivery admin routes, batch 0 (WS8.10, WS8.44, WS8.56). Registered from server.js with
// registerDeliveryRoutes(app, {...}) so server.js only gains an import and one call.
// Every route here is superadmin only (adminAuth = the admin role).
import {
  automationSettingsView,
  saveAutomationSettings,
  invalidateAutomationSettingsCache,
} from '../../data/automation-settings.js';
import {
  createDeliverySnapshot,
  DELIVERY_SCHEMA_VERSION,
  isValidSnapshotId,
  listDeliverySnapshots,
  readStoredSchemaVersion,
  restoreDeliverySnapshot,
} from '../delivery-snapshots.js';

function actorOf(req) {
  return String(req.admin?.username || req.admin?.email || 'admin').slice(0, 120);
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

/**
 * @param {import('express').Express} app
 * @param {{ adminAuth: Function, sales: object, hub: object, salesOffers?: object, getDataDir?: () => string }} deps
 */
export function registerDeliveryRoutes(app, { adminAuth, sales, hub, salesOffers = null, getDataDir = null }) {
  const dataDir = () => (typeof getDataDir === 'function' ? getDataDir() : undefined);

  // --- Automation settings (WS8.10)
  app.get('/api/admin/automation-settings', adminAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(automationSettingsView({ dataDir: dataDir() }));
  });

  // Body: a (partial) settings object, or {settings, reason}. Partial objects deep-merge, except the
  // per-mailbox maps and pauses, which replace as a whole. Changing inbox.mailboxes drops the map
  // entries of a mailbox that is no longer listed.
  app.put('/api/admin/automation-settings', adminAuth, (req, res) => {
    const body = bodyOf(req);
    const wrapped = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings);
    const patch = wrapped ? body.settings : body;
    const result = saveAutomationSettings(patch, {
      dataDir: dataDir(),
      by: actorOf(req),
      reason: wrapped ? String(body.reason || '') : '',
    });
    if (!result.ok) return res.status(400).json({ message: 'Invalid automation settings.', errors: result.errors });
    res.json({ ...automationSettingsView({ dataDir: dataDir() }), changes: result.changes });
  });

  // --- Delivery snapshots (WS8.44)
  app.get('/api/admin/system/delivery-snapshots', adminAuth, (_req, res) => {
    const schema = readStoredSchemaVersion({ dataDir: dataDir() });
    res.json({
      codeSchemaVersion: DELIVERY_SCHEMA_VERSION,
      storedSchemaVersion: schema.version,
      snapshots: listDeliverySnapshots({ dataDir: dataDir() }),
    });
  });

  app.post('/api/admin/system/delivery-snapshots', adminAuth, (req, res) => {
    const body = bodyOf(req);
    const snapshot = createDeliverySnapshot({
      dataDir: dataDir(),
      label: String(body.label || 'manual'),
      reason: String(body.reason || `manual snapshot by ${actorOf(req)}`),
    });
    const { dir: _dir, ...publicSnapshot } = snapshot;
    res.status(201).json(publicSnapshot);
  });

  // Dry run unless the body says {dryRun:false}.
  app.post('/api/admin/system/delivery-snapshots/:id/restore', adminAuth, (req, res) => {
    const id = String(req.params.id || '');
    if (!isValidSnapshotId(id)) return res.status(400).json({ message: 'Invalid snapshot id.' });
    const dryRun = bodyOf(req).dryRun !== false;
    const result = restoreDeliverySnapshot({ dataDir: dataDir(), id, dryRun, by: actorOf(req) });
    if (!result.ok) {
      return res.status(result.status || 500).json({ message: result.error, errors: result.errors || [], diff: result.diff || null });
    }
    if (!dryRun) {
      sales?.noteSalesStoreReplaced?.();
      salesOffers?.noteOffersStoreReplaced?.();
      invalidateAutomationSettingsCache();
      console.warn(`[delivery] snapshot ${id} restored by ${actorOf(req)}: ${result.restored.join(', ') || 'no files changed'}; previous state ${result.preRestoreSnapshotId}`);
    }
    res.json(result);
  });

  // --- Test-client flag (WS8.56). Sites use PUT /api/hub/sites/:id {isTest}.
  app.patch('/api/admin/sales/:id/test-flag', adminAuth, (req, res) => {
    const value = bodyOf(req).isTest;
    if (typeof value !== 'boolean') return res.status(400).json({ message: 'isTest must be true or false.' });
    const client = sales.setSalesTestFlag(String(req.params.id || ''), value);
    if (!client) return res.status(404).json({ message: 'Sales client not found.' });
    res.json({ id: client.id, isTest: client.isTest === true });
  });

  app.patch('/api/hub/sites/:id/test-flag', adminAuth, (req, res) => {
    const value = bodyOf(req).isTest;
    if (typeof value !== 'boolean') return res.status(400).json({ message: 'isTest must be true or false.' });
    const result = hub.updateSite(String(req.params.id || ''), { isTest: value });
    if (!result.ok) return res.status(404).json({ message: result.error });
    res.json({ id: result.site.id, isTest: result.site.isTest === true });
  });
}
