// Sales-card plan routes for the signing switch (lib/contract-signing.js).
//
//   GET  /api/admin/sales/:id/site-plan          the client's plan: summary, history, open conflicts,
//                                                the shadow plan, and whether it can be confirmed
//   POST /api/admin/sales/:id/site-plan/confirm  'Bekreft tjenester': confirms a derived plan or one
//                                                that needs a confirmation (Superadmin, auto only)
//
// Both answer 404 { code: 'disabled' } while the signing switch is off. Neither changes the plan's
// tier or services, and neither undoes a signing.
import { activeSitePlan, normalizeSitePlan } from '../site-plan-model.js';
import { signingModeForClient, signingSwitchMode } from '../contract-signing.js';
import { appendDeliveryAudit } from '../delivery-audit.js';
import { tierById } from '../website-tiers.js';

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function ownerKeys(salesUser = {}) {
  const keys = new Set();
  const accountKey = text(salesUser.accountKey);
  if (accountKey) keys.add(accountKey);
  if (text(salesUser.userId)) keys.add(`sales:${text(salesUser.userId)}`);
  if (text(salesUser.username)) keys.add(`sales:${text(salesUser.username)}`);
  return keys;
}

function canSee(req, client) {
  if (req.salesUser?.isAdmin) return true;
  const owner = text(client?.ownerId);
  return Boolean(owner) && ownerKeys(req.salesUser).has(owner);
}

function canConfirm(plan, mode) {
  return mode === 'auto' && Boolean(plan) && plan.status === 'active' && (plan.derived || plan.needsConfirmation) && !plan.confirmedAt;
}

/** The card's view of a client's plan. */
export function sitePlanView(client, { mode, isAdmin = false } = {}) {
  const plan = normalizeSitePlan(client?.sitePlan);
  const shadow = client?.delivery?.sitePlanShadow && typeof client.delivery.sitePlanShadow === 'object' ? client.delivery.sitePlanShadow : null;
  return {
    mode,
    plan: plan
      ? {
        status: plan.status,
        tierId: plan.tierId,
        tierName: tierById(plan.tierId)?.name || (plan.tierId === 'custom' ? 'Tilpasset' : plan.tierId),
        services: plan.services,
        billing: plan.billing,
        pages: plan.pages,
        source: plan.source,
        offerId: plan.offerId,
        alternativeIndex: plan.alternativeIndex,
        signedAt: plan.signedAt,
        appliedAt: plan.appliedAt,
        derived: plan.derived,
        needsConfirmation: plan.needsConfirmation && !plan.confirmedAt,
        confirmedAt: plan.confirmedAt,
        confirmedBy: plan.confirmedBy,
      }
      : null,
    inForce: Boolean(activeSitePlan(client)),
    history: plan ? plan.history.slice(-20).reverse() : [],
    conflicts: plan ? plan.conflicts.filter((conflict) => conflict.status === 'open') : [],
    shadow: shadow
      ? {
        at: text(shadow.at, 40),
        source: text(shadow.source, 40),
        tierId: text(shadow.tierId, 40),
        services: Array.isArray(shadow.services) ? shadow.services.map((id) => text(id, 40)) : [],
        wouldCreateSite: shadow.wouldCreateSite === true,
        needsChoice: shadow.needsChoice === true,
      }
      : null,
    canConfirm: isAdmin === true && canConfirm(plan, mode),
  };
}

export function register(app, deps = {}) {
  const { salesAuth, sales } = deps;
  if (typeof salesAuth !== 'function' || !sales) throw new Error('signing-routes needs salesAuth and sales');

  const disabled = (res) => res.status(404).json({ code: 'disabled', message: 'Signering er ikke slått på.' });

  app.get('/api/admin/sales/:id/site-plan', salesAuth, (req, res) => {
    if (signingSwitchMode() === 'off') return disabled(res);
    const client = sales.getSalesClientById(req.params.id);
    if (!client) return res.status(404).json({ message: 'Sales client not found.' });
    if (!canSee(req, client)) return res.status(403).json({ message: 'Not your sales client.' });
    res.json(sitePlanView(client, { mode: signingModeForClient(client), isAdmin: req.salesUser?.isAdmin === true }));
  });

  app.post('/api/admin/sales/:id/site-plan/confirm', salesAuth, (req, res) => {
    if (signingSwitchMode() === 'off') return disabled(res);
    if (!req.salesUser?.isAdmin) return res.status(403).json({ message: 'Admin only.' });
    const client = sales.getSalesClientById(req.params.id);
    if (!client) return res.status(404).json({ message: 'Sales client not found.' });
    const mode = signingModeForClient(client);
    if (mode !== 'auto') return res.status(409).json({ code: 'not-auto', message: 'Planen bekreftes først når signeringen går automatisk for denne kunden.' });
    const plan = normalizeSitePlan(client.sitePlan);
    if (!canConfirm(plan, mode)) return res.status(409).json({ code: 'nothing-to-confirm', message: 'Planen trenger ingen bekreftelse.' });
    const by = text(req.salesUser?.accountKey || req.salesUser?.username, 120) || 'superadmin';
    const at = new Date().toISOString();
    const updated = sales.setSalesSitePlan(client.id, { ...plan, needsConfirmation: false, confirmedBy: by, confirmedAt: at }, { by, reason: 'confirmed', now: at });
    if (!updated) return res.status(400).json({ message: 'Kunne ikke bekrefte planen.' });
    appendDeliveryAudit({ at, kind: 'site-plan-confirmed', clientId: client.id, by, tierId: plan.tierId });
    res.json(sitePlanView(updated, { mode, isAdmin: true }));
  });
}
