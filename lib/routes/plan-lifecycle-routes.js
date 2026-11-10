// Sales-card routes for plan changes after signing and for taking a signing back
// (lib/contract-signing.js markPlanChanged and markContractUnsigned, lib/delivery-lifecycle.js).
//
//   GET   /api/admin/sales/:id/plan-lifecycle                      the card's view: modes, what the user may
//                                                                   do, the plan, its history and open
//                                                                   conflicts, the contract state and tasks
//   PATCH /api/admin/sales/:id/site-plan                           'Endre plan' (superadmin; planChange)
//   POST  /api/admin/sales/:id/site-plan/conflicts/:index/accept   a Stripe conflict becomes the plan
//   POST  /api/admin/sales/:id/site-plan/conflicts/:index/dismiss  the conflict is set aside
//   POST  /api/admin/sales/:id/unsign                              'Angre signering' (superadmin; cancellation)
//   PATCH /api/admin/sales/:id/progression                         only the Kontrakt tick taken off, for a
//                                                                   signed client whose cancellation switch
//                                                                   is on; everything else passes on to the
//                                                                   existing route unchanged
//
// Every route runs the sales sign-in first (401 without credentials) and answers 404 { code:'disabled' }
// while its switch is off for the whole hub. Changes happen only for clients in auto (pilots); a client in
// shadow gets 409 { code:'not-auto' } (the Kontrakt tick then runs as today, plus a shadow record).
import { activeSitePlan, normalizeSitePlan, sitePlanSummary } from '../site-plan-model.js';
import {
  cancellationModeForClient,
  markContractUnsigned,
  markPlanChanged,
  planChangeModeForClient,
} from '../contract-signing.js';
import { changeRequestIntakeAnswer, lifecycleState, lifecycleSwitchMode } from '../delivery-lifecycle.js';
import { appendDeliveryAudit } from '../delivery-audit.js';
import { CUSTOM_TIER_ID, WEBSITE_TIERS, resolveTier, tierById } from '../website-tiers.js';

const LIFECYCLE_TASK_KINDS = Object.freeze(['plan_downgrade', 'unsigned_published', 'payment_failed']);

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ownerKeys(salesUser = {}) {
  const keys = new Set();
  const accountKey = text(salesUser.accountKey);
  if (accountKey) keys.add(accountKey);
  if (text(salesUser.userId)) keys.add(`sales:${text(salesUser.userId)}`);
  if (text(salesUser.username)) keys.add(`sales:${text(salesUser.username)}`);
  return keys;
}

// The same access rule as the progression route: an admin, a developer, or the client's owner.
function canSee(req, client) {
  if (req.salesUser?.isAdmin) return true;
  if (req.developmentUser) return true;
  const owner = text(client?.ownerId);
  return Boolean(owner) && ownerKeys(req.salesUser).has(owner);
}

/** False exactly where the progression route's parseBoolean(value, false) is false (a missing value too). */
function isFalseValue(value) {
  if (typeof value === 'boolean') return value === false;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') return !['true', '1', 'yes', 'on'].includes(value.toLowerCase().trim());
  return true;
}

function actorOf(req) {
  return text(req.salesUser?.accountKey || req.salesUser?.username, 120) || 'superadmin';
}

function tierChoices() {
  return [
    ...(Array.isArray(WEBSITE_TIERS) ? WEBSITE_TIERS : []).map((tier) => ({ id: tier.id, name: tier.name })),
    { id: CUSTOM_TIER_ID, name: 'Tilpasset' },
  ];
}

/** The card's view of a client's plan changes and contract state. */
export function planLifecycleView(client, { isAdmin = false, settings } = {}) {
  const planChange = planChangeModeForClient(client, { settings });
  const cancellation = cancellationModeForClient(client, { settings });
  const plan = normalizeSitePlan(client?.sitePlan);
  const signed = client?.progression?.contractSigned === true;
  const tasks = Array.isArray(client?.delivery?.tasks) ? client.delivery.tasks : [];
  return {
    planChange,
    cancellation,
    canChangePlan: isAdmin === true && planChange === 'auto' && Boolean(activeSitePlan(client)),
    canUnsign: isAdmin === true && cancellation === 'auto' && (signed || plan?.status === 'active'),
    tiers: tierChoices(),
    plan: sitePlanSummary(client),
    history: plan ? plan.history.slice(-20).reverse() : [],
    conflicts: plan
      ? plan.conflicts.map((conflict, index) => ({ ...conflict, index, tierName: tierById(conflict.tierId)?.name || conflict.tierId })).filter((conflict) => conflict.status === 'open')
      : [],
    lifecycle: lifecycleState(client, { settings }),
    changeRequests: changeRequestIntakeAnswer(client, { settings }),
    tasks: tasks
      .filter((task) => isPlainObject(task) && LIFECYCLE_TASK_KINDS.includes(task.kind) && task.status === 'open')
      .map((task) => ({ id: text(task.id, 120), kind: task.kind, at: text(task.at, 40), hint: text(task.hint, 300), removed: Array.isArray(task.removed) ? task.removed.map((id) => text(id, 40)) : [] })),
  };
}

export function register(app, deps = {}) {
  const { salesAuth, sales } = deps;
  if (typeof salesAuth !== 'function' || !sales) throw new Error('plan-lifecycle-routes needs salesAuth and sales');

  const disabled = (res) => res.status(404).json({ code: 'disabled', message: 'Planendring og oppsigelse er ikke slått på.' });
  const bothOff = () => lifecycleSwitchMode('planChange') === 'off' && lifecycleSwitchMode('cancellation') === 'off';

  // Loads the client for a superadmin route; answers and returns null when it cannot go on.
  function adminClient(req, res, switchName) {
    if (lifecycleSwitchMode(switchName) === 'off') {
      disabled(res);
      return null;
    }
    if (!req.salesUser?.isAdmin) {
      res.status(403).json({ message: 'Admin only.' });
      return null;
    }
    const client = sales.getSalesClientById(text(req.params.id, 120));
    if (!client) {
      res.status(404).json({ message: 'Sales client not found.' });
      return null;
    }
    return client;
  }

  function notAuto(res) {
    return res.status(409).json({ code: 'not-auto', message: 'Endringen gjøres først når denne kunden er med i piloten.' });
  }

  function answer(res, result, client) {
    if (result?.needsChoice) {
      return res.status(409).json({ code: 'needs-choice', message: 'Tilbudet har to alternativer. Velg hvilket kunden signerte.', alternatives: result.alternatives || [] });
    }
    if (!result?.ok) {
      const status = result?.status || (result?.reason === 'busy' ? 409 : 400);
      return res.status(status).json({ code: text(result?.reason || result?.skipped, 60) || 'failed', message: result?.reason === 'busy' ? 'En signering pågår allerede. Prøv igjen om litt.' : 'Kunne ikke lagre endringen.' });
    }
    const fresh = sales.getSalesClientById(client.id) || client;
    return res.json({ ...planLifecycleView(fresh, { isAdmin: true }), changed: result.changed !== false, warnings: result.warnings || [] });
  }

  app.get('/api/admin/sales/:id/plan-lifecycle', salesAuth, (req, res) => {
    if (bothOff()) return disabled(res);
    const client = sales.getSalesClientById(text(req.params.id, 120));
    if (!client) return res.status(404).json({ message: 'Sales client not found.' });
    if (!canSee(req, client)) return res.status(403).json({ message: 'Not your sales client.' });
    res.json(planLifecycleView(client, { isAdmin: req.salesUser?.isAdmin === true }));
  });

  app.patch('/api/admin/sales/:id/site-plan', salesAuth, async (req, res) => {
    const client = adminClient(req, res, 'planChange');
    if (!client) return undefined;
    if (planChangeModeForClient(client) !== 'auto') return notAuto(res);
    const body = isPlainObject(req.body) ? req.body : {};
    const raw = text(body.tierId, 40);
    const tier = raw === CUSTOM_TIER_ID ? null : resolveTier(raw);
    if (!tier && raw !== CUSTOM_TIER_ID) return res.status(400).json({ message: 'Ukjent nivå.' });
    const services = Array.isArray(body.services) ? body.services.map((id) => text(id, 40)).filter(Boolean).slice(0, 30) : undefined;
    if (raw === CUSTOM_TIER_ID && !services?.length) return res.status(400).json({ message: 'Velg tjenester for en tilpasset plan.' });
    const billing = body.billing === 'once' || body.billing === 'month' ? body.billing : undefined;
    const result = await markPlanChanged(client.id, {
      source: 'superadmin',
      tierId: tier ? tier.id : CUSTOM_TIER_ID,
      services,
      billing,
      actor: actorOf(req),
      reason: text(body.reason, 300),
    });
    return answer(res, result, client);
  });

  async function resolveConflict(req, res, action) {
    const client = adminClient(req, res, 'planChange');
    if (!client) return undefined;
    if (planChangeModeForClient(client) !== 'auto') return notAuto(res);
    const plan = activeSitePlan(client);
    const index = Number(req.params.index);
    const conflict = plan && Number.isInteger(index) ? plan.conflicts[index] : null;
    if (!conflict || conflict.status !== 'open') return res.status(404).json({ message: 'Fant ingen åpen konflikt.' });
    const by = actorOf(req);
    const at = new Date().toISOString();
    const conflicts = plan.conflicts.map((row, position) => (position === index ? { ...row, status: action === 'accept' ? 'accepted' : 'dismissed' } : row));
    const marked = sales.setSalesSitePlan(client.id, { ...plan, conflicts }, { by, reason: action === 'accept' ? 'conflict-accepted' : 'conflict-dismissed', now: at });
    if (!marked) return res.status(400).json({ message: 'Kunne ikke lagre konflikten.' });
    appendDeliveryAudit({ at, kind: 'site-plan-conflict', clientId: client.id, by, action, source: conflict.source, tierId: conflict.tierId });
    if (action === 'dismiss') return answer(res, { ok: true, changed: false }, client);
    const result = await markPlanChanged(client.id, { source: 'stripe', tierId: conflict.tierId, actor: by, reason: 'conflict-accepted' });
    return answer(res, result, client);
  }

  app.post('/api/admin/sales/:id/site-plan/conflicts/:index/accept', salesAuth, (req, res) => resolveConflict(req, res, 'accept'));
  app.post('/api/admin/sales/:id/site-plan/conflicts/:index/dismiss', salesAuth, (req, res) => resolveConflict(req, res, 'dismiss'));

  app.post('/api/admin/sales/:id/unsign', salesAuth, async (req, res) => {
    const client = adminClient(req, res, 'cancellation');
    if (!client) return undefined;
    if (cancellationModeForClient(client) !== 'auto') return notAuto(res);
    const body = isPlainObject(req.body) ? req.body : {};
    const result = await markContractUnsigned(client.id, { actor: actorOf(req), reason: text(body.reason, 300) });
    return answer(res, result, client);
  });

  // The Kontrakt tick taken off. This route only joins in for a signed client whose cancellation switch
  // is on; every other request passes on to the existing progression route before anything is read
  // from the sign-in or written.
  app.patch('/api/admin/sales/:id/progression', (req, res, next) => {
    const body = isPlainObject(req.body) ? req.body : {};
    if (text(body.key) !== 'contractSigned' || !isFalseValue(body.value)) return next('route');
    let client;
    try {
      client = sales.getSalesClientById(text(req.params.id, 120));
    } catch {
      return next('route');
    }
    if (!client || client.progression?.contractSigned !== true) return next('route');
    if (cancellationModeForClient(client) === 'off') return next('route');
    return next();
  }, salesAuth, async (req, res, next) => {
    const client = sales.getSalesClientById(text(req.params.id, 120));
    if (!client) return res.status(404).json({ message: 'Sales client not found.' });
    if (!canSee(req, client)) return res.status(403).json({ message: 'Not your sales client.' });
    const mode = cancellationModeForClient(client);
    if (mode !== 'auto') {
      // Shadow: today's route unchecks as before; this only records what un-signing would change.
      await markContractUnsigned(client.id, { actor: actorOf(req), reason: 'progression' }).catch(() => null);
      return next('route');
    }
    try {
      const result = await markContractUnsigned(client.id, { actor: actorOf(req), reason: 'progression' });
      if (!result?.ok) {
        return res.status(result?.status || 400).json({ message: result?.reason === 'busy' ? 'En signering pågår allerede. Prøv igjen om litt.' : 'Failed updating progression.' });
      }
      return res.json({ client: result.client, warnings: result.warnings || [] });
    } catch (error) {
      return res.status(400).json({ message: text(error?.message) || 'Failed updating progression.' });
    }
  });
}
