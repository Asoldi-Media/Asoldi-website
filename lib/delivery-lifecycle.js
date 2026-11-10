// Contract lifecycle after signing: a cancelled subscription, a failed payment (paused after
// lifecycle.paymentGraceDays without recovery), a recovered payment, and the questions other code asks
// about a client in that state: may it get a job of this kind, and what does the change-request intake
// answer. Behind the `lifecycle.cancellation` switch, decided per client through spineModeForClient():
//
//   off     nothing is read or written here; the Stripe webhook keeps its own handling, unchanged.
//   shadow  one delivery-audit row says what would change; nothing else is written.
//   auto    pilot clients: delivery.events and delivery.tasks, the hub site's deliveryPhase, the job stop.
//
// The published site keeps running in every state: nothing here removes a site, a DNS record or hosting.
// Built here: the cancelled state (events.cancelled, and events.serviceEndsAt = the end of the paid
// period plus lifecycle.cancellationGraceDays, when hosting may stop), paused on a failed payment, the
// stop of SEO maintenance and change-request jobs, and the change-request intake answer. Not built here:
// stopping CMS updates, automatic posts, hub-brokered e-mail and backlinks, and the export package.
//
// The pure parts (lifecycleState, lifecycleJobBlock, changeRequestIntakeAnswer) import no data module, so
// lib/delivery-jobs.js can ask them without an import cycle; the writers load the data modules lazily.
import { effectiveSwitchMode, getAutomationSettings } from '../data/automation-settings.js';
import { CANCELLATION_GRACE_DAYS } from '../packages/suite/core/delivery/vocab.js';
import { appendDeliveryAudit } from './delivery-audit.js';
import { normalizeDelivery } from './delivery-state.js';
import { normalizeSitePlan } from './site-plan-model.js';
import { spineModeForClient } from './spine-mode.js';

export const CANCELLATION_SWITCH = 'lifecycle.cancellation';
export const PLAN_CHANGE_SWITCH = 'lifecycle.planChange';
export const DEFAULT_PAYMENT_GRACE_DAYS = 14;
export const CONTRACT_ENDED_MESSAGE = 'Avtalen er avsluttet';
export const CONTRACT_PAUSED_MESSAGE = 'Avtalen er satt på pause';
export const PAYMENT_FAILED_TASK_ID = 'payment-failed';
// Job kinds a cancelled contract no longer gets (maintenance, SEO and change work). A paused contract gets
// no job at all, except the retention purge.
export const CANCELLED_STOPPED_JOB_KINDS = Object.freeze(['seo.maintenance', 'seo.refresh', 'change_request']);
export const PAUSED_ALLOWED_JOB_KINDS = Object.freeze(['purge']);
const DAY_MS = 24 * 60 * 60 * 1000;
const TASKS_MAX = 20;

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(text(value, 60));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function nowMs(now) {
  const ms = toMs(now);
  return Number.isFinite(ms) ? ms : Date.now();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function settingsOf(options = {}) {
  return options.settings || getAutomationSettings({ dataDir: options.dataDir });
}

function graceDays(settings, key, fallback) {
  const value = Number(settings?.lifecycle?.[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// ---------------------------------------------------------------- modes

/**
 * off, shadow or auto for one client and one lifecycle switch ('planChange' or 'cancellation'). A paused
 * switch records only (shadow). Settings that cannot be read mean off.
 */
export function lifecycleModeForClient(name, client, { settings } = {}) {
  const path = name === 'planChange' ? PLAN_CHANGE_SWITCH : CANCELLATION_SWITCH;
  let mode;
  try {
    mode = spineModeForClient(path, client || {}, { settings: settings || getAutomationSettings() });
  } catch (error) {
    console.warn('[lifecycle] settings unreadable; the lifecycle switches count as off:', error?.message || error);
    return 'off';
  }
  if (mode === 'auto') return 'auto';
  if (mode === 'shadow' || mode === 'paused') return 'shadow';
  return 'off';
}

/** The switch for the whole hub: off, shadow, paused or auto. */
export function lifecycleSwitchMode(name, { settings } = {}) {
  const path = name === 'planChange' ? PLAN_CHANGE_SWITCH : CANCELLATION_SWITCH;
  try {
    return effectiveSwitchMode(path, { settings: settings || getAutomationSettings() });
  } catch {
    return 'off';
  }
}

// ---------------------------------------------------------------- state (pure)

/**
 * The client's contract state from its stored delivery events (no writes):
 * { state, cancelledAt, serviceEndsAt, paymentFailedAt, pausedAt, pauseReason, graceEndsAt, unsignedAt }.
 * state: 'unsigned' (contract taken back), 'ended' (cancelled and the service end has passed),
 * 'cancelled', 'paused' (stored, or a failed payment older than lifecycle.paymentGraceDays),
 * 'payment-failed' (within the grace days) or 'active'.
 */
export function lifecycleState(client, { now, settings } = {}) {
  const resolved = settings || getAutomationSettings();
  const events = normalizeDelivery(client?.delivery).events;
  const at = nowMs(now);
  const cancelledAt = text(events.cancelled?.at, 40);
  const serviceEndsAt = text(events.serviceEndsAt, 40);
  const paymentFailedAt = text(events.paymentFailedAt, 40);
  const pausedAt = text(events.pausedAt, 40);
  const failedMs = toMs(paymentFailedAt);
  const graceEndsAt = Number.isFinite(failedMs)
    ? iso(failedMs + graceDays(resolved, 'paymentGraceDays', DEFAULT_PAYMENT_GRACE_DAYS) * DAY_MS)
    : '';
  const plan = normalizeSitePlan(client?.sitePlan);
  let state = 'active';
  if (plan?.status === 'void' && client?.progression?.contractSigned !== true) state = 'unsigned';
  else if (cancelledAt || plan?.status === 'ended') {
    const endMs = toMs(serviceEndsAt);
    state = plan?.status === 'ended' || (Number.isFinite(endMs) && endMs <= at) ? 'ended' : 'cancelled';
  } else if (pausedAt || (graceEndsAt && toMs(graceEndsAt) <= at)) state = 'paused';
  else if (paymentFailedAt) state = 'payment-failed';
  return {
    state,
    cancelledAt,
    serviceEndsAt,
    paymentFailedAt,
    pausedAt,
    pauseReason: text(events.pauseReason, 300),
    graceEndsAt,
    unsignedAt: text(events.unsignedAt, 40),
  };
}

/**
 * '' when a job of `kind` may be requested for the client, else the code that stops it: 'contract-ended'
 * (cancelled or ended: no SEO maintenance, SEO refresh or change work) or 'paused' (no job but the purge).
 * Only for a client whose cancellation switch runs in auto; everyone else is never stopped here.
 */
export function lifecycleJobBlock(client, kind, { settings, now } = {}) {
  if (!client?.id) return '';
  const resolved = settings || getAutomationSettings();
  if (lifecycleModeForClient('cancellation', client, { settings: resolved }) !== 'auto') return '';
  const { state } = lifecycleState(client, { now, settings: resolved });
  if ((state === 'cancelled' || state === 'ended') && CANCELLED_STOPPED_JOB_KINDS.includes(kind)) return 'contract-ended';
  if (state === 'paused' && !PAUSED_ALLOWED_JOB_KINDS.includes(kind)) return 'paused';
  return '';
}

/**
 * What the change-request intake answers for this client: null while requests are taken (always, unless
 * the client's cancellation switch runs in auto), else { open:false, code, message }: 'contract-ended'
 * ("Avtalen er avsluttet") for a cancelled or ended contract, 'paused' for a paused one. There is no
 * change-request intake in the hub yet; the intake calls this before it accepts a request.
 */
export function changeRequestIntakeAnswer(client, { settings, now } = {}) {
  if (!client?.id) return null;
  const resolved = settings || getAutomationSettings();
  if (lifecycleModeForClient('cancellation', client, { settings: resolved }) !== 'auto') return null;
  const { state } = lifecycleState(client, { now, settings: resolved });
  if (state === 'cancelled' || state === 'ended') return { open: false, code: 'contract-ended', message: CONTRACT_ENDED_MESSAGE };
  if (state === 'paused') return { open: false, code: 'paused', message: CONTRACT_PAUSED_MESSAGE };
  return null;
}

/** The lifecycle facts other code reads (SEO maintenance, e-mail): one object of ISO times ('' when unset). */
export function lifecycleEvents(client) {
  const events = normalizeDelivery(client?.delivery).events;
  return {
    cancelledAt: text(events.cancelled?.at, 40),
    cancelSource: text(events.cancelled?.source, 40),
    serviceEndsAt: text(events.serviceEndsAt, 40),
    paymentFailedAt: text(events.paymentFailedAt, 40),
    pausedAt: text(events.pausedAt, 40),
    unsignedAt: text(events.unsignedAt, 40),
    planChangedAt: text(events.planChangedAt, 40),
  };
}

// ---------------------------------------------------------------- Stripe

/** The newest of the subscription's period end, end and cancel times (Stripe seconds) and `now`, in ms. */
export function paidUntilMs(subscription = {}, now) {
  const at = nowMs(now);
  const times = ['current_period_end', 'ended_at', 'cancel_at']
    .map((key) => Number(subscription?.[key]))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((seconds) => seconds * 1000);
  return Math.max(at, ...times);
}

/**
 * The sales client a Stripe object belongs to: metadata.salesClientId, else the client portal profile
 * whose payment carries the Stripe customer (the link connect-portal writes). null when none.
 */
export async function salesClientForStripe({ customer = '', metadata = {} } = {}, deps = {}) {
  const sales = deps.sales || await import('../data/sales.js');
  const named = text(isPlainObject(metadata) ? metadata.salesClientId : '', 80);
  if (named) return sales.getSalesClientById(named) || null;
  const customerId = text(customer, 120);
  if (!customerId) return null;
  const clientPortal = deps.clientPortal || await import('../data/client-portal.js');
  let profile = null;
  try {
    profile = clientPortal.getClientProfileByStripeCustomerId(customerId);
  } catch {
    profile = null;
  }
  const salesClientId = text(profile?.websiteBuilder?.salesClientId, 80);
  return salesClientId ? sales.getSalesClientById(salesClientId) || null : null;
}

function openTasks(client) {
  const tasks = isPlainObject(client?.delivery) && Array.isArray(client.delivery.tasks) ? client.delivery.tasks : [];
  return tasks.filter(isPlainObject);
}

function withTask(client, task) {
  const tasks = openTasks(client);
  if (tasks.some((row) => row.id === task.id && row.status === 'open')) return null;
  return [...tasks.filter((row) => row.id !== task.id), task].slice(-TASKS_MAX);
}

function shadowRow(clientId, event, extra = {}) {
  appendDeliveryAudit({ kind: 'lifecycle-shadow', clientId, by: 'stripe', event, ...extra });
}

async function ownSite(client) {
  const { findSiteForClient } = await import('./site-plan-apply.js');
  try {
    return findSiteForClient(client);
  } catch {
    return null;
  }
}

/**
 * customer.subscription.deleted. auto: events.cancelled { at, source:'stripe' } (an earlier entry is kept),
 * events.serviceEndsAt (the paid period's end plus lifecycle.cancellationGraceDays), and the client's own
 * hub site moves to deliveryPhase 'cancelled'. The site itself keeps running. Returns
 * { ok, mode, clientId, serviceEndsAt }.
 */
export async function onSubscriptionEnded(subscription = {}, options = {}) {
  const client = await salesClientForStripe({ customer: subscription?.customer, metadata: subscription?.metadata }, options.deps);
  if (!client) return { ok: false, mode: 'off', reason: 'no-client' };
  const settings = settingsOf(options);
  const mode = lifecycleModeForClient('cancellation', client, { settings });
  if (mode === 'off') return { ok: false, mode, skipped: 'switch-off', clientId: client.id };
  const at = nowMs(options.now);
  const serviceEndsAt = iso(paidUntilMs(subscription, at) + graceDays(settings, 'cancellationGraceDays', CANCELLATION_GRACE_DAYS) * DAY_MS);
  if (mode === 'shadow') {
    shadowRow(client.id, 'subscription-ended', { serviceEndsAt });
    return { ok: true, mode, clientId: client.id, serviceEndsAt };
  }
  const sales = options.deps?.sales || await import('../data/sales.js');
  const current = normalizeDelivery(client.delivery).events;
  const keepEarlier = text(current.cancelled?.at, 40);
  sales.setSalesDelivery(client.id, {
    events: {
      cancelled: keepEarlier ? current.cancelled : { at: iso(at), source: 'stripe', reason: 'subscription-deleted' },
      serviceEndsAt: text(current.serviceEndsAt, 40) || serviceEndsAt,
    },
  }, { by: 'stripe', reason: 'subscription-deleted' });
  const site = await ownSite(sales.getSalesClientById(client.id) || client);
  if (site?.id && site.deliveryPhase !== 'cancelled') {
    const hub = options.deps?.hub || await import('../data/hub.js');
    hub.updateSite(site.id, { deliveryPhase: 'cancelled' });
  }
  appendDeliveryAudit({ kind: 'lifecycle', clientId: client.id, by: 'stripe', event: 'subscription-ended', serviceEndsAt, siteId: text(site?.id, 80) });
  sales.syncSalesDeliveryStage(client.id, { by: 'stripe', reason: 'cancelled' });
  return { ok: true, mode, clientId: client.id, serviceEndsAt: text(current.serviceEndsAt, 40) || serviceEndsAt };
}

/**
 * invoice.payment_failed. auto: events.paymentFailedAt (the first failure not yet recovered is kept) and
 * one open payment_failed task for a person. After lifecycle.paymentGraceDays without recovery the client
 * counts as paused (lifecycleState) and the lifecycle tick step stores it.
 */
export async function onPaymentFailed(invoice = {}, options = {}) {
  const client = await salesClientForStripe({ customer: invoice?.customer, metadata: invoice?.metadata }, options.deps);
  if (!client) return { ok: false, mode: 'off', reason: 'no-client' };
  const settings = settingsOf(options);
  const mode = lifecycleModeForClient('cancellation', client, { settings });
  if (mode === 'off') return { ok: false, mode, skipped: 'switch-off', clientId: client.id };
  const at = iso(nowMs(options.now));
  if (mode === 'shadow') {
    shadowRow(client.id, 'payment-failed');
    return { ok: true, mode, clientId: client.id };
  }
  const sales = options.deps?.sales || await import('../data/sales.js');
  const events = normalizeDelivery(client.delivery).events;
  const failedAt = text(events.paymentFailedAt, 40) || at;
  const patch = { events: { paymentFailedAt: failedAt } };
  const tasks = withTask(client, { id: PAYMENT_FAILED_TASK_ID, kind: 'payment_failed', status: 'open', at, hint: 'Betalingen feilet. Kontakt kunden.' });
  if (tasks) patch.tasks = tasks;
  sales.setSalesDelivery(client.id, patch, { by: 'stripe', reason: 'payment-failed' });
  appendDeliveryAudit({ kind: 'lifecycle', clientId: client.id, by: 'stripe', event: 'payment-failed', paymentFailedAt: failedAt });
  return { ok: true, mode, clientId: client.id, paymentFailedAt: failedAt };
}

/**
 * invoice.paid. auto: a failed payment is recovered: paymentFailedAt is cleared, a pause the failure caused
 * ends, and the payment_failed task is done. Nothing is written when there was no failure.
 */
export async function onPaymentRecovered(invoice = {}, options = {}) {
  const client = await salesClientForStripe({ customer: invoice?.customer, metadata: invoice?.metadata }, options.deps);
  if (!client) return { ok: false, mode: 'off', reason: 'no-client' };
  const settings = settingsOf(options);
  const mode = lifecycleModeForClient('cancellation', client, { settings });
  if (mode === 'off') return { ok: false, mode, skipped: 'switch-off', clientId: client.id };
  const events = normalizeDelivery(client.delivery).events;
  const pausedByPayment = Boolean(events.pausedAt) && events.pauseReason === 'payment-failed';
  if (!events.paymentFailedAt && !pausedByPayment) return { ok: true, mode, clientId: client.id, changed: false };
  if (mode === 'shadow') {
    shadowRow(client.id, 'payment-recovered');
    return { ok: true, mode, clientId: client.id, changed: false };
  }
  const at = iso(nowMs(options.now));
  const sales = options.deps?.sales || await import('../data/sales.js');
  const patch = { events: { paymentFailedAt: '', ...(pausedByPayment ? { pausedAt: '', pauseReason: '' } : {}) } };
  const tasks = openTasks(client);
  if (tasks.some((task) => task.id === PAYMENT_FAILED_TASK_ID && task.status === 'open')) {
    patch.tasks = tasks.map((task) => (task.id === PAYMENT_FAILED_TASK_ID && task.status === 'open' ? { ...task, status: 'done', doneAt: at } : task));
  }
  sales.setSalesDelivery(client.id, patch, { by: 'stripe', reason: 'payment-recovered' });
  appendDeliveryAudit({ kind: 'lifecycle', clientId: client.id, by: 'stripe', event: 'payment-recovered', unpaused: pausedByPayment });
  sales.syncSalesDeliveryStage(client.id, { by: 'stripe', reason: 'payment-recovered' });
  return { ok: true, mode, clientId: client.id, changed: true };
}

// ---------------------------------------------------------------- tick step

/**
 * One client in the delivery tick. Only for a client whose cancellation switch runs in auto. With the
 * loop in auto for the client: a failed payment past its grace days is stored as paused
 * (events.pausedAt, pauseReason 'payment-failed'), and a cancelled contract past its service end gets its
 * plan ended (sitePlan status 'ended'). With the loop in shadow: one audit row per change, nothing else.
 */
export async function runLifecycleStep(ctx = {}, client = null) {
  if (!client?.id) return { wrote: false };
  const settings = ctx.settings || getAutomationSettings({ dataDir: ctx.dataDir });
  if (lifecycleModeForClient('cancellation', client, { settings }) !== 'auto') return { wrote: false, skipped: 'switch' };
  const loopMode = text(ctx.mode) || 'shadow';
  if (loopMode === 'off' || loopMode === 'paused') return { wrote: false, skipped: `loop-${loopMode}` };
  const at = nowMs(ctx.now);
  const state = lifecycleState(client, { now: at, settings });
  const events = normalizeDelivery(client.delivery).events;
  const plan = normalizeSitePlan(client.sitePlan);
  const pauseDue = state.state === 'paused' && !events.pausedAt && Boolean(events.paymentFailedAt);
  const endDue = state.state === 'ended' && plan?.status === 'active';
  if (!pauseDue && !endDue) return { wrote: false };
  if (loopMode !== 'auto') {
    const key = `lifecycle:${client.id}:${pauseDue ? 'pause' : 'end'}`;
    if (typeof ctx.shadow === 'function') ctx.shadow(key, { kind: 'lifecycle-shadow', clientId: client.id, event: pauseDue ? 'pause-due' : 'service-ended' });
    else appendDeliveryAudit({ kind: 'lifecycle-shadow', clientId: client.id, event: pauseDue ? 'pause-due' : 'service-ended' }, { dataDir: ctx.dataDir });
    return { wrote: true, shadow: true };
  }
  const sales = ctx.sales || await import('../data/sales.js');
  if (pauseDue) {
    sales.setSalesDelivery(client.id, { events: { pausedAt: iso(at), pauseReason: 'payment-failed' } }, { by: 'lifecycle', reason: 'payment-grace-ended' });
    appendDeliveryAudit({ kind: 'lifecycle', clientId: client.id, by: 'lifecycle', event: 'paused', reason: 'payment-failed' }, { dataDir: ctx.dataDir });
  }
  if (endDue) {
    sales.setSalesSitePlan(client.id, { ...plan, status: 'ended' }, { by: 'lifecycle', reason: 'service-ended', now: iso(at) });
    appendDeliveryAudit({ kind: 'lifecycle', clientId: client.id, by: 'lifecycle', event: 'service-ended' }, { dataDir: ctx.dataDir });
  }
  sales.syncSalesDeliveryStage(client.id, { by: 'lifecycle', reason: pauseDue ? 'paused' : 'service-ended', now: at });
  return { wrote: true, paused: pauseDue, ended: endDue };
}

// The delivery loop runs this step once this module is listed in its step modules (lib/delivery-steps.js).
export const tickSteps = Object.freeze([
  Object.freeze({ name: 'lifecycle', order: 35, scope: 'client', run: runLifecycleStep }),
]);
