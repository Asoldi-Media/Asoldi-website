// Delivery gate routes. Registered through lib/routes/optional-routes.js.
//
// While the `gate` switch is off every route here answers 404 {code:'disabled'} and the desk mail
// route behaves exactly as before. Developers see the gate of the clients they may see; storing an
// evaluation and waivers need work access to the client; approving a gate and marking a workshop
// held are admin actions. A write while the gate does not run for the client (paused) answers 409
// and writes nothing.
import { activeSitePlan } from '../site-plan-model.js';
import { deliveryEmailStamps, normalizeDelivery } from '../delivery-state.js';
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
import { schedulePostWorkshop, sendPostWorkshopNow, shadowMailsFor } from '../delivery-emails.js';
import { canWorkDevelopmentClient, developmentItemVisible } from '../developer-assignment.js';

// A workshop time may be at most this far ahead of the server clock (clock drift between devices).
const CLOCK_SKEW_MS = 5 * 60_000;

function text(value, max = 400) {
  return String(value ?? '').trim().slice(0, max);
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

/**
 * An optional workshop time from a request body: { ok, iso }. Empty is ok (iso ''); anything else
 * must be an ISO date-time that is not in the future.
 */
function workshopTime(value, nowMs) {
  const raw = text(value, 60);
  if (!raw) return { ok: true, iso: '' };
  const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms) || ms > nowMs + CLOCK_SKEW_MS) return { ok: false, iso: '' };
  return { ok: true, iso: new Date(ms).toISOString() };
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

  const canWork = (req, client) => req.developmentUser?.isAdmin === true || canWorkDevelopmentClient(req.developmentUser, client);

  // Writes need the gate running for the client: paused (or otherwise not running) writes nothing.
  const gateRunsFor = (res, client) => {
    const mode = gateModeForClient(client);
    if (mode === 'shadow' || mode === 'auto') return true;
    res.status(409).json({ code: mode === 'paused' ? 'paused' : 'off', message: 'The delivery gate does not run for this client now.' });
    return false;
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
    // Shadow mails are never sent; admins review them here (the system outbox route is for safe
    // mode only).
    const shadowMails = req.developmentUser?.isAdmin === true
      ? (await shadowMailsFor(client.id, { limit: 10 })).map((row) => ({
        key: row.key,
        kind: row.kind,
        at: row.at,
        subject: text(row.item?.subject, 300),
        to: Array.isArray(row.item?.to) ? row.item.to : [],
        replyTo: text(row.item?.replyTo, 200),
        text: text(row.item?.text, 20_000),
        purged: !row.item,
      }))
      : [];
    res.json({
      clientId: client.id,
      mode: gateModeForClient(client),
      gate,
      stored: stored ? { inputHash: text(stored.inputHash, 80), evaluatedAt: text(stored.evaluatedAt, 40) } : null,
      stale: !stored || stored.inputHash !== gate.inputHash,
      askable: askableLines(gate),
      mailRows: gateMailRows(gate, inputs.materials),
      directives: gateDirectives(gate),
      canWork: canWork(req, client),
      shadowMails,
    });
  });

  app.post('/api/admin/delivery/gate/:clientId/evaluate', requireGate, developmentAuth, async (req, res) => {
    const client = visibleClient(req, res);
    if (!client) return;
    if (!canWork(req, client)) return res.status(403).json({ message: 'This project is assigned to another developer.' });
    if (!gateRunsFor(res, client)) return;
    const result = await evaluateAndStoreGate(client.id, { sales, deps: gateDeps });
    res.json({ clientId: client.id, changed: result.changed, gate: result.gate });
  });

  app.put('/api/admin/delivery/gate/:clientId/waivers/:lineId', requireGate, developmentAuth, async (req, res) => {
    const client = visibleClient(req, res);
    if (!client) return;
    if (!canWork(req, client)) return res.status(403).json({ message: 'This project is assigned to another developer.' });
    if (!gateRunsFor(res, client)) return;
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
    if (!canWork(req, client)) return res.status(403).json({ message: 'This project is assigned to another developer.' });
    if (!gateRunsFor(res, client)) return;
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
    if (!gateRunsFor(res, client)) return;
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
  // schedules the post-workshop mail from the workshop's end. startedAt and endedAt are optional ISO
  // times that may not lie in the future; durationMinutes is 1-600.
  app.post('/api/admin/sales/:id/workshop/held', requireGate, salesAuth, async (req, res) => {
    if (!req.salesUser?.isAdmin) return res.status(403).json({ message: 'Admin only.' });
    const existing = sales.getSalesClientById(text(req.params.id, 120));
    if (!existing) return res.status(404).json({ message: 'Sales client not found.' });
    if (!gateRunsFor(res, existing)) return;
    const body = bodyOf(req);
    const nowMs = Date.now();
    const ended = workshopTime(body.endedAt, nowMs);
    const started = workshopTime(body.startedAt, nowMs);
    if (!ended.ok || !started.ok) {
      return res.status(400).json({ message: 'startedAt and endedAt must be ISO times that are not in the future.' });
    }
    if (started.iso && ended.iso && Date.parse(started.iso) > Date.parse(ended.iso)) {
      return res.status(400).json({ message: 'startedAt must be before endedAt.' });
    }
    const hasDuration = body.durationMinutes !== undefined && body.durationMinutes !== null && body.durationMinutes !== '';
    const durationMinutes = hasDuration ? Number(body.durationMinutes) : 0;
    if (hasDuration && !(Number.isFinite(durationMinutes) && durationMinutes >= 1 && durationMinutes <= 600)) {
      return res.status(400).json({ message: 'durationMinutes must be between 1 and 600.' });
    }
    const { getWorkshopRecord, mergeWorkshopRecord } = await import('../workshop-record.js');
    const record = getWorkshopRecord(existing);
    if (!record.heldAt) {
      sales.setSalesWorkshop(existing.id, mergeWorkshopRecord(record, { heldAt: ended.iso || new Date(nowMs).toISOString() }));
    }
    const heldAt = text(getWorkshopRecord(sales.getSalesClientById(existing.id) || existing).heldAt, 40);
    const scheduled = schedulePostWorkshop(existing.id, {
      sales,
      endedAt: ended.iso,
      startedAt: started.iso,
      durationMinutes,
      fallbackNow: heldAt || nowMs,
      now: nowMs,
    });
    res.json({ clientId: existing.id, heldAt, postWorkshopDueAt: scheduled.dueAt, scheduled: scheduled.scheduled, reason: scheduled.reason });
  });

  // The desk's manual post-workshop mail. Every other desk kind (and this one while the gate is off)
  // passes on to the existing desk route unchanged. It follows the post-workshop kind's mode: off or
  // paused answers 409; shadow (the gate is shadow-only for now) records a shadow mail and sends
  // nothing; only auto sends. A sent mail is not sent again unless body.force is true. Answers the
  // client's delivery email stamps.
  app.post('/api/admin/sales/:id/workshop/desk-email', (req, res, next) => {
    const kind = text(bodyOf(req).kind).toLowerCase();
    if (kind !== 'post-workshop' || !gateSwitchEnabled()) return next('route');
    return next();
  }, salesAuth, async (req, res) => {
    if (!req.salesUser?.isAdmin) return res.status(403).json({ message: 'Admin only.' });
    const existing = sales.getSalesClientById(text(req.params.id, 120));
    if (!existing) return res.status(404).json({ message: 'Sales client not found.' });
    if (!gateRunsFor(res, existing)) return;
    try {
      const { buildSalesSender } = await import('../sales-sender.js');
      const sender = buildSalesSender({ username: req.salesUser?.username, name: req.salesUser?.name });
      const mailed = await sendPostWorkshopNow(existing, { sender, force: bodyOf(req).force === true, deps: { ...gateDeps, sales } });
      const refused = {
        'mode-off': [409, 'off', 'Etter workshop-e-posten er slått av under Automatisering.'],
        'mode-paused': [409, 'paused', 'Etter workshop-e-posten er satt på pause under Automatisering.'],
        'already-sent': [409, 'already-sent', 'Etter workshop-e-posten er allerede sendt.'],
        busy: [409, 'busy', 'E-posten sendes allerede.'],
      }[mailed.reason];
      if (refused) return res.status(refused[0]).json({ code: refused[1], message: refused[2] });
      if (!mailed.sent && !(mailed.shadow && (mailed.status === 'shadow' || mailed.status === 'already-recorded'))) {
        return res.status(400).json({ message: `Kunne ikke sende e-posten (${mailed.reason}).` });
      }
      const stored = sales.getSalesClientById(existing.id) || existing;
      return res.json({
        clientId: existing.id,
        sent: mailed.sent,
        shadow: mailed.shadow,
        status: mailed.status,
        kind: 'post-workshop',
        ready: mailed.ready,
        emails: deliveryEmailStamps(stored),
      });
    } catch (error) {
      return res.status(500).json({ message: text(error?.message) || 'Kunne ikke sende e-posten.' });
    }
  });
}
