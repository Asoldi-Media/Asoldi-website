// Delivery gate routes. Registered through lib/routes/optional-routes.js.
//
// While the `gate` switch is off every route here answers 404 {code:'disabled'} and the desk mail
// route behaves exactly as before. Developers see the gate of the clients they may see; waivers need
// work access to the client; approving a gate and marking a workshop held are admin actions.
import { activeSitePlan } from '../site-plan-model.js';
import { normalizeDelivery } from '../delivery-state.js';
import {
  approveGate,
  askableLines,
  evaluateAndStoreGate,
  evaluateDeliveryGate,
  gateDirectives,
  gateMailRows,
  gateModeForClient,
  gateSwitchEnabled,
  gatherGateInputs,
  installShopConnectionListener,
  setGateWaiver,
  withKeptGateFields,
} from '../delivery-gate.js';
import { schedulePostWorkshop, sendPostWorkshopNow } from '../delivery-emails.js';
import { canWorkDevelopmentClient, developmentItemVisible } from '../developer-assignment.js';

function text(value, max = 400) {
  return String(value ?? '').trim().slice(0, max);
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function inDelivery(client) {
  if (text(client?.product).toLowerCase() === 'ssu') return false;
  if (text(client?.status) === 'archived') return false;
  return client?.progression?.contractSigned === true || Boolean(activeSitePlan(client));
}

function gateSummary(client) {
  const gate = normalizeDelivery(client?.delivery).gate;
  if (!gate) return null;
  const lines = Array.isArray(gate.lines) ? gate.lines : [];
  return {
    evaluatedAt: text(gate.evaluatedAt, 40),
    devComplete: gate.devComplete === true,
    passed: gate.passed === true || Boolean(text(gate.approvedAt)),
    missingDev: Array.isArray(gate.missingDev) ? gate.missingDev : [],
    missingReady: Array.isArray(gate.missingReady) ? gate.missingReady : [],
    declined: lines.filter((line) => line?.status === 'declined').map((line) => line.id),
    info: Array.isArray(gate.info) ? gate.info.map((line) => line.id) : [],
    approvedAt: text(gate.approvedAt, 40),
  };
}

/**
 * @param {import('express').Express} app
 * @param {{ developmentAuth: Function, salesAuth: Function, sales: object, hub: object, salesOffers?: object, getDataDir?: () => string }} deps
 */
export function register(app, deps = {}) {
  const { developmentAuth, salesAuth, sales, hub, salesOffers = null } = deps;
  const gateDeps = { hub, salesOffers };

  const requireGate = (_req, res, next) => {
    if (!gateSwitchEnabled()) return res.status(404).json({ code: 'disabled', message: 'The delivery gate is off.' });
    return next();
  };

  const visibleClient = (req, res) => {
    const client = sales.getSalesClientById(text(req.params.clientId || req.params.id, 120));
    if (!client || !developmentItemVisible(req.developmentUser, client)) {
      res.status(404).json({ message: 'Development client not found.' });
      return null;
    }
    return client;
  };

  // A connection change on a site bumps its shopConnectionRev while the gate is on (see
  // installShopConnectionListener); with it off a connection write changes nothing more.
  void installShopConnectionListener({ sales, hub });

  app.get('/api/admin/delivery/gate', requireGate, developmentAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const clients = sales.getSalesClients()
      .filter((client) => inDelivery(client) && developmentItemVisible(req.developmentUser, client))
      .map((client) => ({
        clientId: client.id,
        businessName: text(client.businessName, 200),
        stage: text(normalizeDelivery(client.delivery).stage, 40),
        mode: gateModeForClient(client),
        gate: gateSummary(client),
      }));
    res.json({ enabled: true, clients });
  });

  app.get('/api/admin/delivery/gate/:clientId', requireGate, developmentAuth, async (req, res) => {
    const client = visibleClient(req, res);
    if (!client) return;
    res.set('Cache-Control', 'no-store');
    const inputs = await gatherGateInputs(client, gateDeps);
    const stored = normalizeDelivery(client.delivery).gate;
    const gate = withKeptGateFields(stored, evaluateDeliveryGate(client, inputs));
    res.json({
      clientId: client.id,
      mode: gateModeForClient(client),
      gate,
      stored: stored ? { inputHash: text(stored.inputHash, 80), evaluatedAt: text(stored.evaluatedAt, 40) } : null,
      stale: !stored || stored.inputHash !== gate.inputHash,
      askable: askableLines(gate),
      mailRows: gateMailRows(gate, inputs.materials),
      directives: gateDirectives(gate),
      canWork: canWorkDevelopmentClient(req.developmentUser, client) || req.developmentUser?.isAdmin === true,
    });
  });

  app.post('/api/admin/delivery/gate/:clientId/evaluate', requireGate, developmentAuth, async (req, res) => {
    const client = visibleClient(req, res);
    if (!client) return;
    const result = await evaluateAndStoreGate(client.id, { sales, deps: gateDeps });
    res.json({ clientId: client.id, changed: result.changed, gate: result.gate });
  });

  app.put('/api/admin/delivery/gate/:clientId/waivers/:lineId', requireGate, developmentAuth, async (req, res) => {
    const client = visibleClient(req, res);
    if (!client) return;
    if (!req.developmentUser?.isAdmin && !canWorkDevelopmentClient(req.developmentUser, client)) {
      return res.status(403).json({ message: 'This project is assigned to another developer.' });
    }
    const body = bodyOf(req);
    const result = await setGateWaiver(client.id, {
      lineId: req.params.lineId,
      option: text(body.option, 120),
      reason: text(body.reason, 300),
      by: `dev:${text(req.developmentUser?.username || req.developmentUser?.accountKey, 100)}`,
      sales,
      deps: gateDeps,
    });
    if (!result.ok) return res.status(result.status || 400).json({ message: result.error });
    res.json({ clientId: client.id, gate: result.gate });
  });

  app.delete('/api/admin/delivery/gate/:clientId/waivers/:lineId', requireGate, developmentAuth, async (req, res) => {
    const client = visibleClient(req, res);
    if (!client) return;
    if (!req.developmentUser?.isAdmin && !canWorkDevelopmentClient(req.developmentUser, client)) {
      return res.status(403).json({ message: 'This project is assigned to another developer.' });
    }
    const result = await setGateWaiver(client.id, {
      lineId: req.params.lineId,
      option: '',
      by: `dev:${text(req.developmentUser?.username || req.developmentUser?.accountKey, 100)}`,
      sales,
      deps: gateDeps,
    });
    if (!result.ok) return res.status(result.status || 400).json({ message: result.error });
    res.json({ clientId: client.id, gate: result.gate });
  });

  app.post('/api/admin/delivery/gate/:clientId/approve', requireGate, developmentAuth, async (req, res) => {
    if (!req.developmentUser?.isAdmin) return res.status(403).json({ message: 'Admin only.' });
    const client = visibleClient(req, res);
    if (!client) return;
    const body = bodyOf(req);
    const result = await approveGate(client.id, {
      by: `admin:${text(req.developmentUser?.username, 100)}`,
      note: text(body.note, 1000),
      approve: body.approve !== false,
      sales,
      deps: gateDeps,
    });
    if (!result.ok) return res.status(result.status || 400).json({ message: result.error });
    res.json({ clientId: client.id, gate: result.gate });
  });

  // The workshop was held (also without a recording): stores heldAt when it is missing and
  // schedules the post-workshop mail from the workshop's end.
  app.post('/api/admin/sales/:id/workshop/held', requireGate, salesAuth, async (req, res) => {
    if (!req.salesUser?.isAdmin) return res.status(403).json({ message: 'Admin only.' });
    const existing = sales.getSalesClientById(text(req.params.id, 120));
    if (!existing) return res.status(404).json({ message: 'Sales client not found.' });
    const body = bodyOf(req);
    const { getWorkshopRecord, mergeWorkshopRecord } = await import('../workshop-record.js');
    const record = getWorkshopRecord(existing);
    const endedAt = text(body.endedAt, 40);
    const heldAt = record.heldAt || endedAt || new Date().toISOString();
    if (!record.heldAt) sales.setSalesWorkshop(existing.id, mergeWorkshopRecord(record, { heldAt }));
    const scheduled = schedulePostWorkshop(existing.id, {
      sales,
      endedAt,
      startedAt: text(body.startedAt, 40),
      durationMinutes: Number(body.durationMinutes) || 0,
      fallbackNow: heldAt,
    });
    res.json({ clientId: existing.id, heldAt, postWorkshopDueAt: scheduled.dueAt, scheduled: scheduled.scheduled, reason: scheduled.reason });
  });

  // The desk's manual post-workshop mail. Every other desk kind (and this one while the gate is off)
  // passes on to the existing desk route unchanged.
  app.post('/api/admin/sales/:id/workshop/desk-email', (req, res, next) => {
    const kind = text(bodyOf(req).kind).toLowerCase();
    if (kind !== 'post-workshop' || !gateSwitchEnabled()) return next('route');
    return next();
  }, salesAuth, async (req, res) => {
    if (!req.salesUser?.isAdmin) return res.status(403).json({ message: 'Admin only.' });
    const existing = sales.getSalesClientById(text(req.params.id, 120));
    if (!existing) return res.status(404).json({ message: 'Sales client not found.' });
    try {
      const { buildSalesSender } = await import('../sales-sender.js');
      const sender = buildSalesSender({ username: req.salesUser?.username, name: req.salesUser?.name });
      const mailed = await sendPostWorkshopNow(existing, { sender, deps: { ...gateDeps, sales } });
      if (!mailed.sent) return res.status(400).json({ message: `Kunne ikke sende e-posten (${mailed.reason}).` });
      return res.json({ client: sales.getSalesClientById(existing.id), sent: true, kind: 'post-workshop', ready: mailed.ready });
    } catch (error) {
      return res.status(500).json({ message: text(error?.message) || 'Kunne ikke sende e-posten.' });
    }
  });
}
