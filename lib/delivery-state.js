// Delivery state machine (WS8.9). Pure: no I/O, no Node imports (the browser bundle may use it).
//
// client.delivery holds facts (events, email stamps, the mirrored job, the gate) and the last
// derived stage with its history. The stage itself is always derived by deriveStage from the
// client record; the writer (data/sales.js syncSalesDeliveryStage) stores it only when it changes.
//
// Email stamps have one source, delivery.emails. stampDeliveryEmail (data/sales.js) writes it and
// mirrors the legacy keys into workshop.deskEmails in the same write; deliveryEmailStamps reads
// both, so a stamp the legacy code wrote is never missed.
import {
  JOB_KINDS,
  STAGES,
  STAGE_LABELS_NB,
  STAGE_OVERLAYS,
  isBlockingCode,
  isWarningCode,
} from '../packages/suite/core/delivery/vocab.js';
import { normalizeSitePlan } from './site-plan-model.js';

export { STAGES, STAGE_OVERLAYS, STAGE_LABELS_NB };

export const DELIVERY_VERSION = 1;
export const DELIVERY_HISTORY_MAX = 50;
export const MAINTENANCE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const JOB_STATUSES = Object.freeze(['queued', 'claimed', 'running', 'retrying', 'done', 'failed', 'cancelled', 'blocked']);
export const ACTIVE_JOB_STATUSES = Object.freeze(['queued', 'claimed', 'running', 'retrying']);
const DEV_JOB_KINDS = ['continue', 'iteration', 'change_request'];

// delivery.emails keys and their legacy mirror in workshop.deskEmails.
export const DELIVERY_EMAIL_KEYS = Object.freeze([
  'preWorkshopSentAt',
  'postWorkshopDueAt',
  'postWorkshopSentAt',
  'previewReadySentAt',
  'stagingReadySentAt',
  'siteLiveSentAt',
]);
export const DESK_EMAIL_MIRROR = Object.freeze({ preWorkshopSentAt: 'preWorkshopSentAt' });
// delivery.emails.dataReminders[i] mirrors deskEmails[DATA_REMINDER_MIRROR[i]].
export const DATA_REMINDER_MIRROR = Object.freeze(['data1SentAt', 'data2SentAt']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function iso(value) {
  const raw = text(value, 40);
  if (!raw) return '';
  return Number.isFinite(Date.parse(raw)) ? raw : '';
}

function ms(value) {
  const parsed = Date.parse(text(value, 40));
  return Number.isFinite(parsed) ? parsed : 0;
}

function keepExtra(target, raw) {
  const extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(target, key) && value !== undefined) extra[key] = value;
  }
  return { ...extra, ...target };
}

function normalizePreviewReady(raw) {
  const input = isPlainObject(raw) ? raw : {};
  return {
    at: iso(input.at),
    previewHash: text(input.previewHash, 128),
    jobId: text(input.jobId, 80),
    variant: input.variant === 'iteration' ? 'iteration' : (input.variant === 'first' ? 'first' : ''),
  };
}

function normalizeApproval(raw) {
  const input = isPlainObject(raw) ? raw : {};
  return {
    at: iso(input.at),
    by: text(input.by, 120),
    source: text(input.source, 40),
    quote: text(input.quote, 400),
    previewHash: text(input.previewHash, 128),
  };
}

function normalizeEvents(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const cancelled = isPlainObject(input.cancelled) ? input.cancelled : {};
  const handover = isPlainObject(input.handover) ? input.handover : {};
  const events = {
    gateApprovedAt: iso(input.gateApprovedAt),
    previewReady: normalizePreviewReady(input.previewReady),
    approval: normalizeApproval(input.approval),
    approvalProposed: isPlainObject(input.approvalProposed) ? normalizeApproval(input.approvalProposed) : null,
    stagingLiveAt: iso(input.stagingLiveAt),
    productionRequestedAt: iso(input.productionRequestedAt),
    liveVerifiedAt: iso(input.liveVerifiedAt),
    pausedAt: iso(input.pausedAt),
    pauseReason: text(input.pauseReason, 300),
    paymentFailedAt: iso(input.paymentFailedAt),
    cancelled: { at: iso(cancelled.at), source: text(cancelled.source, 40), reason: text(cancelled.reason, 300) },
    unsignedAt: iso(input.unsignedAt),
    planChangedAt: iso(input.planChangedAt),
    handover: {
      exportedAt: iso(handover.exportedAt),
      repoTransferredTo: text(handover.repoTransferredTo, 200),
      dnsInstructionsSentAt: iso(handover.dnsInstructionsSentAt),
      completedAt: iso(handover.completedAt),
    },
  };
  return keepExtra(events, input);
}

function normalizeEmails(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const emails = {};
  for (const key of DELIVERY_EMAIL_KEYS) emails[key] = iso(input[key]);
  emails.dataReminders = (Array.isArray(input.dataReminders) ? input.dataReminders : []).map(iso).filter(Boolean).slice(0, 10);
  emails.backfilled = (Array.isArray(input.backfilled) ? input.backfilled : [])
    .map((key) => text(key, 40))
    .filter((key, index, all) => DELIVERY_EMAIL_KEYS.includes(key) && all.indexOf(key) === index);
  return keepExtra(emails, input);
}

export function normalizeDeliveryJob(raw) {
  if (!isPlainObject(raw)) return null;
  const id = text(raw.id, 80);
  const kind = JOB_KINDS.includes(raw.kind) ? raw.kind : '';
  if (!id || !kind) return null;
  const job = {
    id,
    kind,
    status: JOB_STATUSES.includes(raw.status) ? raw.status : 'queued',
    hostId: text(raw.hostId, 80),
    at: iso(raw.at),
    doneAt: iso(raw.doneAt),
    attempts: Math.max(0, Math.round(Number(raw.attempts) || 0)),
    maxAttempts: Math.max(1, Math.round(Number(raw.maxAttempts) || 3)),
    target: raw.target === 'staging' || raw.target === 'production' ? raw.target : '',
    error: text(raw.error, 500),
    blocking: isBlockingCode(raw.blocking) ? text(raw.blocking, 80) : '',
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).filter((code) => isWarningCode(code)).slice(0, 20),
  };
  return keepExtra(job, raw);
}

function normalizeHistoryEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const to = STAGES.includes(raw.to) ? raw.to : '';
  if (!to) return null;
  return {
    from: STAGES.includes(raw.from) ? raw.from : null,
    to,
    overlay: STAGE_OVERLAYS.includes(raw.overlay) ? raw.overlay : '',
    at: iso(raw.at),
    by: text(raw.by, 120),
    reason: text(raw.reason, 200),
  };
}

export function emptyDelivery() {
  return normalizeDelivery({});
}

/**
 * client.delivery, normalized (§3.2.5 of the WS8 plan). `events` and `emails` are objects of
 * facts; `gate` (WS8.14) is kept as stored; `job` is the mirrored latest job. Unknown keys are
 * kept so a later batch's additions survive this code. Idempotent.
 */
export function normalizeDelivery(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const delivery = {
    version: DELIVERY_VERSION,
    stage: STAGES.includes(input.stage) ? input.stage : '',
    overlay: STAGE_OVERLAYS.includes(input.overlay) ? input.overlay : '',
    stageAt: iso(input.stageAt),
    history: (Array.isArray(input.history) ? input.history : [])
      .map(normalizeHistoryEntry)
      .filter(Boolean)
      .slice(-DELIVERY_HISTORY_MAX),
    events: normalizeEvents(input.events),
    gate: isPlainObject(input.gate) ? input.gate : null,
    job: normalizeDeliveryJob(input.job),
    emails: normalizeEmails(input.emails),
    info: (Array.isArray(input.info) ? input.info : [])
      .filter(isPlainObject)
      .map((entry) => ({ id: text(entry.id, 60), at: iso(entry.at) }))
      .filter((entry) => entry.id)
      .slice(0, 50),
    pendingIteration: text(input.pendingIteration, 80),
    targetLaunchAt: /^\d{4}-\d{2}-\d{2}$/.test(text(input.targetLaunchAt, 10)) ? text(input.targetLaunchAt, 10) : '',
    dirtyAt: iso(input.dirtyAt),
  };
  return keepExtra(delivery, input);
}

/**
 * Patch merge used by the writer: `events` and `emails` merge shallowly; `gate`, `job`, `history`
 * and every other key replace. Returns a normalized delivery.
 */
export function mergeDelivery(current, patch = {}) {
  const base = normalizeDelivery(current);
  const next = isPlainObject(patch) ? patch : {};
  return normalizeDelivery({
    ...base,
    ...next,
    events: isPlainObject(next.events) ? { ...base.events, ...next.events } : base.events,
    emails: isPlainObject(next.emails) ? { ...base.emails, ...next.emails } : base.emails,
  });
}

/**
 * Email stamps with the legacy desk stamps folded in: delivery.emails wins, and a key only the
 * legacy code stamped (workshop.deskEmails) still counts as sent.
 */
export function deliveryEmailStamps(client = {}) {
  const delivery = normalizeDelivery(client?.delivery);
  const desk = isPlainObject(client?.workshop?.deskEmails) ? client.workshop.deskEmails : {};
  const out = {};
  for (const key of DELIVERY_EMAIL_KEYS) {
    const mirror = DESK_EMAIL_MIRROR[key];
    out[key] = delivery.emails[key] || (mirror ? iso(desk[mirror]) : '');
  }
  const reminders = [...delivery.emails.dataReminders];
  DATA_REMINDER_MIRROR.forEach((mirror, index) => {
    if (!reminders[index] && iso(desk[mirror])) reminders[index] = iso(desk[mirror]);
  });
  out.dataReminders = reminders.filter(Boolean);
  return out;
}

/**
 * The patch for one stamp: delivery.emails and the legacy workshop.deskEmails mirror together.
 * `key` is a DELIVERY_EMAIL_KEYS entry or `dataReminders`. Returns { delivery, deskEmails }.
 */
export function deliveryEmailStampPatch(client = {}, key, at) {
  const value = iso(at);
  if (!value) throw new Error('A stamp needs a valid time.');
  const delivery = normalizeDelivery(client?.delivery);
  const deskEmails = {};
  if (key === 'dataReminders') {
    const reminders = [...delivery.emails.dataReminders, value].slice(0, 10);
    const mirror = DATA_REMINDER_MIRROR[reminders.length - 1];
    if (mirror) deskEmails[mirror] = value;
    return { emails: { dataReminders: reminders }, deskEmails };
  }
  if (!DELIVERY_EMAIL_KEYS.includes(key)) throw new Error(`Unknown delivery email stamp: ${key}`);
  const mirror = DESK_EMAIL_MIRROR[key];
  if (mirror) deskEmails[mirror] = value;
  return { emails: { [key]: value }, deskEmails };
}

function jobsOf(delivery, ctx) {
  if (Array.isArray(ctx?.jobs)) return ctx.jobs.map(normalizeDeliveryJob).filter(Boolean);
  return delivery.job ? [delivery.job] : [];
}

function newest(list, pick) {
  return [...list].sort((a, b) => ms(pick(b)) - ms(pick(a)))[0] || null;
}

function isActive(job) {
  if (!job) return false;
  if (ACTIVE_JOB_STATUSES.includes(job.status)) return true;
  return job.status === 'failed' && job.attempts < job.maxAttempts;
}

function gatePassed(delivery, events) {
  const gate = isPlainObject(delivery.gate) ? delivery.gate : {};
  return Boolean(gate.devComplete === true || iso(gate.approvedAt) || events.gateApprovedAt);
}

function gateLineMissing(delivery, lineId) {
  const lines = Array.isArray(delivery.gate?.lines) ? delivery.gate.lines : [];
  return lines.some((line) => line?.id === lineId && line?.status === 'missing');
}

function stageResult(stage, extra = {}) {
  return { stage, overlay: '', subState: '', blocking: '', reason: '', liveAt: '', devDoneAt: '', ...extra };
}

/**
 * The delivery stage of a client (§3.6 of the WS8 plan; the first matching row wins).
 * Returns { stage, overlay, subState, blocking, reason, liveAt, devDoneAt }; stage is null for a
 * product without website delivery (SSU). ctx: { now (ms or ISO), jobs? (the client's jobs; the
 * mirrored delivery.job when absent) }. No I/O.
 */
export function deriveStage(client = {}, ctx = {}) {
  if (text(client?.product).toLowerCase() === 'ssu') {
    return { ...stageResult(null), reason: 'not-a-website-product' };
  }
  const now = typeof ctx.now === 'number' ? ctx.now : (ms(ctx.now) || Date.now());
  const delivery = normalizeDelivery(client?.delivery);
  const events = delivery.events;
  const plan = normalizeSitePlan(client?.sitePlan);
  const progression = isPlainObject(client?.progression) ? client.progression : {};
  const contractSigned = progression.contractSigned === true;
  const emails = deliveryEmailStamps(client);
  const jobs = jobsOf(delivery, ctx);
  const billing = plan?.billing || 'month';

  let overlay = '';
  if (events.cancelled.at || plan?.status === 'ended') overlay = 'cancelled';
  else if (events.pausedAt) overlay = 'paused';
  const withOverlay = (stage, extra = {}) => ({ ...stageResult(stage, extra), overlay });

  const tail = () => {
    if (progression.offerSent === true) return withOverlay('offer_sent');
    if (progression.meetingHeld === true) return withOverlay('sales_meeting');
    return withOverlay('lead');
  };

  // Un-signed (sitePlan void, contract unchecked): back to the sales stages.
  if (!contractSigned && plan?.status === 'void') return { ...tail(), reason: 'unsigned' };

  // Live: a verified production go-live, the identity-proven fallback check, or (legacy clients)
  // the progression flag the old go-live callback set.
  const goLive = isPlainObject(client?.makerRun?.goLive) ? client.makerRun.goLive : {};
  const verifiedLiveAt = (goLive.target === 'production' && iso(goLive.liveVerifiedAt)) || events.liveVerifiedAt;
  const legacyLive = !verifiedLiveAt && progression.live === true;
  const liveAt = verifiedLiveAt || (legacyLive ? (iso(client?.hubSite?.createdAt) || iso(client?.contractSignedAt)) : '');
  const live = Boolean(verifiedLiveAt) || legacyLive;
  if (live) {
    const subState = verifiedLiveAt ? '' : 'legacy';
    if (billing === 'once' && events.handover.completedAt) return withOverlay('handed_over', { subState, liveAt });
    const since = Math.max(ms(liveAt) ? now - ms(liveAt) : 0, ms(emails.siteLiveSentAt) ? now - ms(emails.siteLiveSentAt) : 0);
    if (billing === 'month' && since > MAINTENANCE_AFTER_MS) return withOverlay('maintenance', { subState, liveAt });
    return withOverlay('live', { subState, liveAt });
  }

  const publishJob = jobs.find((job) => job.kind === 'publish' && isActive(job));
  if (publishJob) return withOverlay('publishing', { subState: publishJob.target || 'production', blocking: publishJob.blocking });
  if (events.stagingLiveAt) {
    return withOverlay('publishing', {
      subState: 'staging-live',
      blocking: gateLineMissing(delivery, 'payment') ? 'needs-payment-setup' : '',
    });
  }

  const previewHash = events.previewReady.previewHash;
  const approved = Boolean(events.approval.at && events.approval.previewHash && events.approval.previewHash === previewHash);
  if (approved) return withOverlay('approved');

  const iterationJob = jobs.find((job) => (job.kind === 'iteration' || job.kind === 'change_request') && isActive(job));
  if (iterationJob) return withOverlay('iterating', { subState: iterationJob.status, blocking: iterationJob.blocking });

  const doneDevJobs = jobs.filter((job) => DEV_JOB_KINDS.includes(job.kind) && job.status === 'done');
  const lastDevJob = newest(doneDevJobs, (job) => job.doneAt || job.at);
  const previewPushAt = iso(client?.makerRun?.previewPush?.at);
  const devDoneAt = (lastDevJob && (lastDevJob.doneAt || lastDevJob.at)) || previewPushAt;
  if (events.previewReady.at && (!devDoneAt || ms(events.previewReady.at) >= ms(devDoneAt))) {
    const stale = Boolean(events.approval.at && events.approval.previewHash !== previewHash);
    return withOverlay('client_preview', { subState: stale ? 'approval-stale' : '', devDoneAt });
  }

  const lastBuild = newest(
    jobs.filter((job) => (job.kind === 'continue' || job.kind === 'iteration') && job.status === 'done'),
    (job) => job.doneAt || job.at,
  );
  if (lastBuild) {
    const doneAt = lastBuild.doneAt || lastBuild.at;
    const pushed = previewPushAt && ms(previewPushAt) >= ms(doneAt);
    return withOverlay('dev_review', { subState: pushed ? 'pushed' : 'awaiting-accept', devDoneAt: doneAt });
  }

  const continueJob = jobs.find((job) => job.kind === 'continue' && isActive(job));
  if (continueJob) return withOverlay('developing', { subState: continueJob.status, blocking: continueJob.blocking });

  const workshopHeldAt = iso(client?.workshop?.heldAt);
  if (workshopHeldAt && (emails.postWorkshopSentAt || gatePassed(delivery, events))) return withOverlay('gate');
  if (workshopHeldAt) return withOverlay('workshop_held');

  const signed = contractSigned && plan?.status !== 'void';
  const workshopBooked = Boolean(iso(client?.workshopAction?.dueAt));
  if (signed && (emails.preWorkshopSentAt || workshopBooked)) {
    return withOverlay('gathering', { subState: emails.preWorkshopSentAt ? '' : 'workshop-booked' });
  }
  if (signed) return withOverlay('signed', { subState: plan ? '' : 'plan-missing' });
  return tail();
}

/** { from, to } when the derived stage or overlay differs from the stored one, else null. */
export function diffStage(delivery, derived) {
  const current = normalizeDelivery(delivery);
  if (!derived || !derived.stage) return null;
  if (current.stage === derived.stage && current.overlay === (derived.overlay || '')) return null;
  return { from: current.stage || null, to: derived.stage, fromOverlay: current.overlay, overlay: derived.overlay || '' };
}

/**
 * The delivery object after a stage sync, or null when nothing changes (idempotent). Writes the
 * stage, overlay and one history entry only when the stage or overlay changed.
 */
export function planStageWrite(client = {}, { now = Date.now(), by = '', reason = '', jobs } = {}) {
  const derived = deriveStage(client, { now, jobs });
  if (!derived.stage) return { changed: false, derived, delivery: null };
  const current = normalizeDelivery(client?.delivery);
  const change = diffStage(current, derived);
  if (!change) return { changed: false, derived, delivery: current };
  const at = new Date(typeof now === 'number' ? now : ms(now) || Date.now()).toISOString();
  const history = [...current.history, {
    from: change.from,
    to: change.to,
    overlay: change.overlay,
    at,
    by: text(by, 120),
    reason: text(reason, 200) || derived.reason || '',
  }].slice(-DELIVERY_HISTORY_MAX);
  const delivery = normalizeDelivery({
    ...current,
    stage: derived.stage,
    overlay: derived.overlay || '',
    stageAt: change.from === change.to ? current.stageAt : at,
    history,
  });
  return { changed: true, derived, delivery, change };
}

export function stageLabel(stage) {
  return STAGE_LABELS_NB[stage] || '';
}
