// Delivery emails driven by the gate: the mail two hours after the workshop (post-workshop), the
// Datainnsamling reminders, and the one send path every gate mail goes through.
//
// - Every mail here needs the gate switch on for the client (spineModeForClient('gate')) and its
//   own email kind (spineModeForClient('emails.<kind>')). Off or paused: nothing is drafted.
// - Shadow (the gate is shadow-only for now, and a loop in shadow forces it too): the mail is built,
//   written to the outbox with channel 'delivery-shadow' and recorded in the delivery audit. It never
//   reaches the mail transport and stamps nothing on the client. A shadow mail is recorded once.
// - Auto: sent through lib/email.js (the safe-mode outbox and guards apply), then stamped with
//   stampDeliveryEmail, under a lease so two processes never send the same mail.
// - Schedules are stored times (delivery.emails.postWorkshopDueAt), never timers, so a restart loses
//   nothing: the next tick after the due time sends.
import { INBOX_MAILBOX_ALLOWLIST, getAutomationSettings } from '../data/automation-settings.js';
import { updateJsonLocked, readJsonFresh } from '../data/atomic-json.js';
import { acquireLease } from '../data/email-store.js';
import { getPersistentDataDir } from '../data/storage-path.js';
import { join } from 'node:path';
import { appendDeliveryAudit } from './delivery-audit.js';
import {
  askableLines,
  evaluateDeliveryGate,
  gateActiveForClient,
  gatherGateInputs,
  gateMailRows,
  gateModeForClient,
  optionalModule,
  placeholderSlots,
} from './delivery-gate.js';
import { STAGES, deliveryEmailStamps, deriveStage, normalizeDelivery } from './delivery-state.js';
import { writeOutboxEmail } from './safe-mode-outbox.js';
import { spineModeForClient } from './spine-mode.js';
import { WORKSHOP_DURATION_MINUTES } from './workshop-action-shared.js';

export const SHADOW_FILE = 'delivery-email-shadow.json';
export const SHADOW_CHANNEL = 'delivery-shadow';
export const POST_WORKSHOP_DEFAULT_DELAY_MINUTES = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
// A post-workshop due time further in the past than this when it is scheduled is not stored.
export const POST_WORKSHOP_STALE_MS = DAY_MS;
const SEND_LEASE_MS = 120_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value, max = 400) {
  return String(value ?? '').trim().slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const parsed = Date.parse(text(value, 60));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function nowMs(now) {
  const ms = toMs(now);
  return Number.isFinite(ms) ? ms : Date.now();
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function settingsOf(options = {}) {
  return options.settings || getAutomationSettings({ dataDir: options.dataDir });
}

function dataDirOf(options = {}) {
  return options.dataDir || getPersistentDataDir();
}

// ---------------------------------------------------------------- modes

/**
 * How a gate mail of email kind `kindId` goes to this client: 'off', 'paused', 'shadow' or 'auto'.
 * The gate and the kind must both run; it is 'auto' only when both are auto (and the delivery loop,
 * when one asks, is auto for the client too). Anything less is 'shadow'.
 */
export function deliveryEmailMode(kindId, client, { settings = null, loopMode = '', dataDir } = {}) {
  const resolved = settings || getAutomationSettings({ dataDir });
  const gate = gateModeForClient(client, { settings: resolved });
  if (gate !== 'shadow' && gate !== 'auto') return 'off';
  let kind;
  try {
    kind = spineModeForClient(`emails.${kindId}`, client, { settings: resolved });
  } catch {
    kind = 'off';
  }
  if (kind === 'off' || kind === 'paused') return kind;
  if (loopMode && loopMode !== 'auto') return 'shadow';
  return gate === 'auto' && kind === 'auto' ? 'auto' : 'shadow';
}

// ---------------------------------------------------------------- sender and Reply-To

function lower(value) {
  return text(value, 200).toLowerCase();
}

/** The inbox mailboxes the inbox bot reads (listed in settings and allowed). */
export function botReadMailboxes(settings) {
  const listed = Array.isArray(settings?.inbox?.mailboxes) ? settings.inbox.mailboxes.map(lower) : [];
  return listed.filter((mailbox) => INBOX_MAILBOX_ALLOWLIST.includes(mailbox));
}

/** The mailbox of the client's rep from the client's owner id, or ''. */
export async function ownerMailboxFor(client, deps = {}) {
  if (typeof deps.ownerMailbox === 'function') return lower(await deps.ownerMailbox(client));
  const ownerId = text(client?.ownerId, 200);
  if (!ownerId) return '';
  if (ownerId.startsWith('admin:')) {
    const name = lower(ownerId.slice('admin:'.length));
    return EMAIL_RE.test(name) ? name : '';
  }
  const userId = ownerId.includes(':') ? ownerId.slice(ownerId.indexOf(':') + 1) : ownerId;
  try {
    const store = await import('../data/store.js');
    const user = (await store.getUserById(userId)) || null;
    const name = lower(user?.username);
    return EMAIL_RE.test(name) ? name : '';
  } catch {
    return '';
  }
}

/**
 * The sender of a scheduling mail on the gate path. The Reply-To becomes the rep's mailbox only
 * when that mailbox is one the inbox bot reads (INBOX_MAILBOX_ALLOWLIST and inbox.mailboxes), so
 * the bot still files the client's replies. Otherwise the sender keeps today's Reply-To.
 */
export async function schedulingSender(client, sender = {}, { settings = null, deps = {} } = {}) {
  const base = isPlainObject(sender) ? { ...sender } : {};
  const readable = botReadMailboxes(settings || getAutomationSettings());
  const candidates = [lower(base.replyTo), lower(base.fromEmail), await ownerMailboxFor(client, deps)].filter(Boolean);
  const pick = candidates.find((mailbox) => readable.includes(mailbox));
  return pick ? { ...base, replyTo: pick } : base;
}

// ---------------------------------------------------------------- shadow records

function shadowPath(dataDir) {
  return join(dataDir, SHADOW_FILE);
}

function readShadow(dataDir) {
  const value = readJsonFresh(shadowPath(dataDir));
  return isPlainObject(value?.entries) ? value.entries : {};
}

// An entry is { at, clientId, kind, outboxId }.
function entryAt(entry) {
  return text(isPlainObject(entry) ? entry.at : entry, 40);
}

export function shadowRecordAt(key, { dataDir } = {}) {
  return entryAt(readShadow(dataDirOf({ dataDir }))[key]);
}

function shadowKeysWithPrefix(prefix, dataDir) {
  return Object.entries(readShadow(dataDir)).filter(([key]) => key.startsWith(prefix)).map(([key, entry]) => ({ key, at: entryAt(entry) }));
}

/**
 * Claims a shadow key under the file lock: true for the one caller that records it, false when it
 * is already recorded (also by another process).
 */
function claimShadow(key, entry, dataDir) {
  let claimed = false;
  updateJsonLocked(shadowPath(dataDir), (current) => {
    const entries = isPlainObject(current?.entries) ? { ...current.entries } : {};
    if (entryAt(entries[key])) return undefined;
    entries[key] = entry;
    claimed = true;
    return { version: 1, entries };
  });
  return claimed;
}

function updateShadow(key, patch, dataDir) {
  updateJsonLocked(shadowPath(dataDir), (current) => {
    const entries = isPlainObject(current?.entries) ? { ...current.entries } : {};
    if (patch === null) delete entries[key];
    else entries[key] = { ...(isPlainObject(entries[key]) ? entries[key] : {}), ...patch };
    return { version: 1, entries };
  });
}

/**
 * The shadow mails recorded for one client, newest first: { key, kind, at, outboxId, item }. `item`
 * is the outbox record with its body ({subject, to, replyTo, text, html, ...}), or null once the
 * outbox purged it. Shadow mails are never sent, so this is where they are reviewed.
 */
export async function shadowMailsFor(clientId, { dataDir, limit = 20 } = {}) {
  const id = text(clientId, 120);
  if (!id) return [];
  const dir = dataDirOf({ dataDir });
  const { readOutboxItem } = await import('./safe-mode-outbox.js');
  return Object.entries(readShadow(dir))
    .filter(([, entry]) => isPlainObject(entry) && text(entry.clientId, 120) === id)
    .map(([key, entry]) => ({ key, kind: text(entry.kind, 40), at: entryAt(entry), outboxId: text(entry.outboxId, 120) }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, Math.max(1, Number(limit) || 20))
    .map((row) => {
      let item = null;
      try {
        item = row.outboxId ? readOutboxItem(dir, row.outboxId) : null;
      } catch {
        item = null;
      }
      return { ...row, item };
    });
}

// ---------------------------------------------------------------- the send path

/**
 * Sends or records one gate mail. `mode`: 'shadow' (outbox record and audit, never the transport),
 * 'auto' or 'manual' (the transport, then the stamp). `stampKey` is a delivery email key or
 * 'dataReminders'. `dedupeKey` identifies the mail (one shadow record per key; the lease name for
 * a send). deps: { sendEmail, stampDeliveryEmail, alreadySent() }.
 */
export async function deliverDeliveryEmail({
  kindId,
  client,
  message,
  mode,
  stampKey = '',
  dedupeKey,
  now,
  dataDir,
  deps = {},
} = {}) {
  const at = isoAt(nowMs(now));
  const dir = dataDirOf({ dataDir });
  const clientId = text(client?.id, 80);
  if (mode !== 'shadow' && mode !== 'auto' && mode !== 'manual') return { status: 'skipped', reason: `mode-${mode || 'off'}` };
  if (!EMAIL_RE.test(text(message?.to, 200))) return { status: 'skipped', reason: 'no-recipient' };
  if (mode === 'shadow') {
    // Claimed under the lock before the outbox write, so two processes never record it twice.
    if (!claimShadow(dedupeKey, { at, clientId, kind: text(kindId, 40), outboxId: '' }, dir)) return { status: 'already-recorded' };
    let entry;
    try {
      entry = await writeOutboxEmail(dir, message, { channel: SHADOW_CHANNEL, transport: 'shadow', now: new Date(at) });
    } catch (error) {
      updateShadow(dedupeKey, null, dir);
      throw error;
    }
    updateShadow(dedupeKey, { outboxId: entry.id }, dir);
    appendDeliveryAudit({ at, kind: 'email-shadow', clientId, email: kindId, key: dedupeKey, outboxId: entry.id }, { dataDir: dir });
    return { status: 'shadow', outboxId: entry.id };
  }
  const lease = await acquireLease(`delivery-email:${dedupeKey}`, SEND_LEASE_MS);
  if (!lease) return { status: 'busy' };
  try {
    if (typeof deps.alreadySent === 'function' && await deps.alreadySent()) return { status: 'already-sent' };
    const send = deps.sendEmail || (await import('./email.js')).sendEmail;
    await send(message);
    const stamp = deps.stampDeliveryEmail || (await import('../data/sales.js')).stampDeliveryEmail;
    if (stampKey && clientId) stamp(clientId, stampKey, at, { by: mode === 'manual' ? 'desk' : 'delivery' });
    appendDeliveryAudit({ at, kind: mode === 'manual' ? 'email-sent-manual' : 'email-sent', clientId, email: kindId, key: dedupeKey }, { dataDir: dir });
    return { status: 'sent' };
  } finally {
    await lease.release();
  }
}

// ---------------------------------------------------------------- post-workshop timing

/**
 * When the recorded meeting started. A stored Fireflies meeting (buildFirefliesMeetingRecord in
 * lib/fireflies-webhook.js) has `startedAt` and `durationMinutes`; a raw Fireflies answer has
 * `dateString` or `date` (ms) and `duration` (minutes).
 */
function meetingStartMs(meeting = {}) {
  const stored = toMs(meeting?.startedAt);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const iso = text(meeting?.dateString, 60);
  const ms = iso ? Date.parse(iso) : Number(meeting?.date);
  return Number.isFinite(ms) && ms > 0 ? ms : NaN;
}

function meetingMinutes(meeting = {}) {
  const minutes = Number(meeting?.durationMinutes);
  if (Number.isFinite(minutes) && minutes > 0) return minutes;
  const raw = Number(meeting?.duration);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * When the workshop ended: an explicit end, a start plus a duration, the recorded meeting (start
 * plus duration), or the booked workshop time plus the standard length. NaN when unknown.
 */
export function workshopEndMs(client = {}, { endedAt = '', startedAt = '', durationMinutes = 0, workshopMeeting = null } = {}) {
  const end = toMs(endedAt);
  if (Number.isFinite(end)) return end;
  const start = toMs(startedAt);
  const minutes = Number(durationMinutes) > 0 ? Number(durationMinutes) : WORKSHOP_DURATION_MINUTES;
  if (Number.isFinite(start)) return start + minutes * 60_000;
  const meetingStart = meetingStartMs(workshopMeeting || {});
  if (Number.isFinite(meetingStart)) return meetingStart + (meetingMinutes(workshopMeeting) || WORKSHOP_DURATION_MINUTES) * 60_000;
  const booked = toMs(client?.workshopAction?.dueAt);
  if (Number.isFinite(booked)) return booked + WORKSHOP_DURATION_MINUTES * 60_000;
  return NaN;
}

export function postWorkshopDelayMinutes(settings) {
  const value = Number(settings?.emails?.postWorkshop?.delayMinutes);
  return Number.isFinite(value) && value >= 0 ? value : POST_WORKSHOP_DEFAULT_DELAY_MINUTES;
}

/** The post-workshop due time for a workshop that ended at endMs (ISO), or ''. */
export function postWorkshopDueAtFor(endMs, settings) {
  return Number.isFinite(endMs) ? isoAt(endMs + postWorkshopDelayMinutes(settings) * 60_000) : '';
}

/**
 * Stores delivery.emails.postWorkshopDueAt when a workshop is held (the Prosjektdokument was applied,
 * or POST workshop/held). Only while the gate runs for the client, only once (an existing due time or
 * a sent mail is kept), and never for a workshop of unknown time unless `fallbackNow` is set. A due
 * time more than POST_WORKSHOP_STALE_MS before `now` (a recording linked days after the workshop) is
 * not stored (reason 'stale'): a thank-you days late is worse than none. A due time that has passed by
 * less than that is stored as `now`, so a stored due time is never in the past. Returns { scheduled,
 * dueAt, reason }.
 */
export function schedulePostWorkshop(clientId, {
  sales,
  settings = null,
  endedAt = '',
  startedAt = '',
  durationMinutes = 0,
  workshopMeeting = null,
  fallbackNow = null,
  now,
  dataDir,
} = {}) {
  const client = sales.getSalesClientById(clientId);
  if (!client) return { scheduled: false, dueAt: '', reason: 'not-found' };
  const resolved = settings || getAutomationSettings({ dataDir });
  if (!gateActiveForClient(client, { settings: resolved })) return { scheduled: false, dueAt: '', reason: 'gate-off' };
  const stamps = deliveryEmailStamps(client);
  if (stamps.postWorkshopSentAt) return { scheduled: false, dueAt: stamps.postWorkshopDueAt, reason: 'already-sent' };
  if (stamps.postWorkshopDueAt) return { scheduled: false, dueAt: stamps.postWorkshopDueAt, reason: 'already-scheduled' };
  let end = workshopEndMs(client, { endedAt, startedAt, durationMinutes, workshopMeeting });
  if (!Number.isFinite(end) && fallbackNow !== null) end = nowMs(fallbackNow);
  const dueAt = postWorkshopDueAtFor(end, resolved);
  if (!dueAt) return { scheduled: false, dueAt: '', reason: 'unknown-time' };
  const at = nowMs(now);
  if (toMs(dueAt) < at - POST_WORKSHOP_STALE_MS) return { scheduled: false, dueAt: '', reason: 'stale' };
  // A due time that has already passed (within the stale window) is stored as now, never in the past.
  const stored = toMs(dueAt) < at ? isoAt(at) : dueAt;
  sales.stampDeliveryEmail(client.id, 'postWorkshopDueAt', stored, { by: 'gate' });
  return { scheduled: true, dueAt: stored, reason: '' };
}

/** Called when the Prosjektdokument sets heldAt for the first time. A no-op while the gate is off. */
export function schedulePostWorkshopOnHeld(client, { workshopMeeting = null, sales, settings = null, now } = {}) {
  if (!client?.id || !sales) return { scheduled: false, dueAt: '', reason: 'no-client' };
  return schedulePostWorkshop(client.id, { sales, settings, workshopMeeting, now });
}

// ---------------------------------------------------------------- building the mails

async function bookingLinkFor(client) {
  const booking = await optionalModule('./meeting-booking.js');
  if (!booking) return '';
  for (const name of ['clientBookingLink', 'bookingLinkForClient']) {
    if (typeof booking[name] === 'function') {
      try {
        return text(await booking[name](client, { purpose: 'iteration' }), 500);
      } catch {
        return '';
      }
    }
  }
  return '';
}

async function senderForClient(client, sender, { settings, deps }) {
  let base = isPlainObject(sender) && Object.keys(sender).length ? sender : {};
  if (!Object.keys(base).length) {
    const mailbox = await ownerMailboxFor(client, deps);
    if (mailbox && mailbox.endsWith('@asoldi.com')) {
      const { buildSalesSender } = await import('./sales-sender.js');
      base = buildSalesSender({ username: mailbox });
    }
  }
  return schedulingSender(client, base, { settings, deps });
}

function messageFor(client, composed) {
  return {
    to: text(client?.contactEmail, 200),
    from: composed.from,
    replyTo: composed.replyTo,
    subject: composed.subject,
    text: composed.text,
    html: composed.html,
    attachments: [],
  };
}

/** The post-workshop mail for a client from its gate: { message, ready, rows }. */
export async function buildPostWorkshopMessage(client, { sender = {}, settings = null, deps = {}, now } = {}) {
  const resolved = settings || getAutomationSettings();
  const inputs = await gatherGateInputs(client, deps);
  const gate = evaluateDeliveryGate(client, inputs, { now });
  const lines = askableLines(gate).rows;
  const placeholders = placeholderSlots(inputs.materials).sentence;
  const ready = gate.devComplete === true && !lines.length;
  const { composeEmailForClient } = await import('./email-templates-store.js');
  const schedSender = await senderForClient(client, sender, { settings: resolved, deps });
  const composed = composeEmailForClient(client, ready ? 'post-workshop-ready' : 'post-workshop', null, {
    sender: schedSender,
    attachInvite: false,
    postWorkshop: { lines, placeholders, ready, bookingLink: await bookingLinkFor(client) },
  }).message;
  return { message: messageFor(client, composed), ready, rows: lines, gate };
}

/** A Datainnsamling reminder from the gate's askable lines: { message, rows }. */
export async function buildDataReminderMessage(client, { sender = {}, settings = null, deps = {}, now } = {}) {
  const resolved = settings || getAutomationSettings();
  const inputs = await gatherGateInputs(client, deps);
  const gate = evaluateDeliveryGate(client, inputs, { now });
  const rows = gateMailRows(gate, inputs.materials);
  const { composeEmailForClient } = await import('./email-templates-store.js');
  const schedSender = await senderForClient(client, sender, { settings: resolved, deps });
  const composed = composeEmailForClient(client, 'data-innsamling-2', null, { sender: schedSender, attachInvite: false, needLines: rows }).message;
  return { message: messageFor(client, composed), rows: rows.filter((row) => !row.placeholder), gate };
}

// ---------------------------------------------------------------- tick steps

async function salesOf(ctx) {
  return ctx.sales || import('../data/sales.js');
}

// The last delivery stage at which the post-workshop mail and the reminders still go out. A client
// further along (dev review, preview, live, ...) or cancelled or paused gets neither.
export const DELIVERY_EMAIL_LAST_STAGE = 'developing';

/** Whether the client's derived stage still takes gate mails: { ok, reason }. */
export function deliveryEmailStageAllows(client, { now } = {}) {
  let derived;
  try {
    derived = deriveStage(client, { now: nowMs(now) });
  } catch {
    return { ok: false, reason: 'stage-unknown' };
  }
  if (!derived?.stage) return { ok: false, reason: 'no-stage' };
  if (derived.overlay) return { ok: false, reason: `overlay-${derived.overlay}` };
  if (STAGES.indexOf(derived.stage) > STAGES.indexOf(DELIVERY_EMAIL_LAST_STAGE)) return { ok: false, reason: `stage-${derived.stage}` };
  return { ok: true, reason: '' };
}

/**
 * The post-workshop send time this flow can count reminders from: a due time this flow scheduled,
 * or a post-workshop mail it sent. A stamp the backfill wrote for a client already past the
 * workshop (listed in delivery.emails.backfilled) never counts.
 */
function reminderAnchorStamps(client) {
  const stamps = deliveryEmailStamps(client);
  const backfilled = normalizeDelivery(client?.delivery).emails.backfilled;
  return {
    dueAt: backfilled.includes('postWorkshopDueAt') ? '' : stamps.postWorkshopDueAt,
    sentAt: backfilled.includes('postWorkshopSentAt') ? '' : stamps.postWorkshopSentAt,
  };
}

/**
 * Post-workshop step: sends (or records, in shadow) the mail once its due time has passed. A tick
 * before the due time writes nothing; a later tick after a restart still finds the stored due time.
 */
export async function runPostWorkshopStep(ctx = {}, client = null) {
  if (!client?.id) return { wrote: false };
  const settings = settingsOf(ctx);
  const stamps = deliveryEmailStamps(client);
  if (!stamps.postWorkshopDueAt || stamps.postWorkshopSentAt) return { wrote: false };
  const dueMs = toMs(stamps.postWorkshopDueAt);
  const at = nowMs(ctx.now);
  if (!Number.isFinite(dueMs) || at < dueMs) return { wrote: false };
  const stage = deliveryEmailStageAllows(client, { now: at });
  if (!stage.ok) return { wrote: false, skipped: stage.reason };
  const mode = deliveryEmailMode('postWorkshop', client, { settings, loopMode: text(ctx.mode) });
  if (mode !== 'shadow' && mode !== 'auto') return { wrote: false, skipped: `mode-${mode}` };
  const dedupeKey = `postWorkshop:${client.id}:${stamps.postWorkshopDueAt}`;
  if (mode === 'shadow' && shadowRecordAt(dedupeKey, { dataDir: ctx.dataDir })) return { wrote: false };
  const built = await buildPostWorkshopMessage(client, { settings, deps: ctx.emailDeps || {}, now: at });
  const sales = await salesOf(ctx);
  const result = await deliverDeliveryEmail({
    kindId: 'postWorkshop',
    client,
    message: built.message,
    mode,
    stampKey: 'postWorkshopSentAt',
    dedupeKey,
    now: at,
    dataDir: ctx.dataDir,
    deps: {
      ...(ctx.emailDeps || {}),
      stampDeliveryEmail: ctx.emailDeps?.stampDeliveryEmail || sales.stampDeliveryEmail,
      alreadySent: () => Boolean(deliveryEmailStamps(sales.getSalesClientById(client.id) || client).postWorkshopSentAt),
    },
  });
  return { wrote: result.status === 'sent' || result.status === 'shadow', status: result.status, ready: built.ready };
}

function reminderSettings(settings) {
  const node = isPlainObject(settings?.emails?.dataReminder) ? settings.emails.dataReminder : {};
  const afterDays = Number(node.afterDays);
  const max = Number(node.max);
  return {
    afterDays: Number.isFinite(afterDays) && afterDays > 0 ? afterDays : 4,
    max: Number.isFinite(max) && max >= 0 ? Math.floor(max) : 2,
  };
}

/**
 * Data reminder step: after emails.dataReminder.afterDays since the post-workshop mail (or the last
 * reminder), and while the gate still has askable lines, one Datainnsamling reminder; at most
 * emails.dataReminder.max of them. Only for a post-workshop mail this flow scheduled or sent (never
 * from a backfilled stamp), and only while the client's stage is at most `developing` with no
 * cancelled or paused overlay.
 */
export async function runDataReminderStep(ctx = {}, client = null) {
  if (!client?.id) return { wrote: false };
  const settings = settingsOf(ctx);
  const stamps = deliveryEmailStamps(client);
  const anchors = reminderAnchorStamps(client);
  if (!anchors.dueAt && !anchors.sentAt) return { wrote: false };
  const stage = deliveryEmailStageAllows(client, { now: ctx.now });
  if (!stage.ok) return { wrote: false, skipped: stage.reason };
  const mode = deliveryEmailMode('dataReminder', client, { settings, loopMode: text(ctx.mode) });
  if (mode !== 'shadow' && mode !== 'auto') return { wrote: false, skipped: `mode-${mode}` };
  const { afterDays, max } = reminderSettings(settings);
  const dir = dataDirOf(ctx);
  const recorded = mode === 'shadow' ? shadowKeysWithPrefix(`dataReminder:${client.id}:`, dir).map((entry) => entry.at) : [];
  const history = [...stamps.dataReminders, ...recorded].filter(Boolean).sort();
  if (history.length >= max) return { wrote: false };
  const anchor = history.at(-1) || anchors.sentAt || anchors.dueAt;
  const at = nowMs(ctx.now);
  if (!Number.isFinite(toMs(anchor)) || at < toMs(anchor) + afterDays * DAY_MS) return { wrote: false };
  const dedupeKey = `dataReminder:${client.id}:${history.length + 1}`;
  const built = await buildDataReminderMessage(client, { settings, deps: ctx.emailDeps || {}, now: at });
  if (!built.rows.length) return { wrote: false, skipped: 'nothing-to-ask' };
  const sales = await salesOf(ctx);
  const result = await deliverDeliveryEmail({
    kindId: 'dataReminder',
    client,
    message: built.message,
    mode,
    stampKey: 'dataReminders',
    dedupeKey,
    now: at,
    dataDir: ctx.dataDir,
    deps: {
      ...(ctx.emailDeps || {}),
      stampDeliveryEmail: ctx.emailDeps?.stampDeliveryEmail || sales.stampDeliveryEmail,
      alreadySent: () => deliveryEmailStamps(sales.getSalesClientById(client.id) || client).dataReminders.length > stamps.dataReminders.length,
    },
  });
  return { wrote: result.status === 'sent' || result.status === 'shadow', status: result.status };
}

export const tickSteps = Object.freeze([
  Object.freeze({ name: 'post-workshop', order: 50, scope: 'client', run: runPostWorkshopStep }),
  Object.freeze({ name: 'data-reminder', order: 60, scope: 'client', run: runDataReminderStep }),
]);

// ---------------------------------------------------------------- manual desk send

/**
 * The desk's manual post-workshop mail (an admin presses send), built from the gate. It follows the
 * same mode as the scheduled mail (deliveryEmailMode('postWorkshop')):
 * - off or paused: nothing is built, drafted or sent (reason 'mode-off' or 'mode-paused');
 * - shadow (the gate is shadow-only for now): recorded as a shadow mail, never sent; one record per
 *   client, or a new one with `force`;
 * - auto: sent now through the transport and stamped. Refused once postWorkshopSentAt is set unless
 *   `force` is true, and two presses at once send once (a lease, then a stamp check).
 * Returns { sent, shadow, status, reason, ready }.
 */
export async function sendPostWorkshopNow(client, { sender = {}, settings = null, deps = {}, now, dataDir, force = false } = {}) {
  const resolved = settings || getAutomationSettings({ dataDir });
  const mode = deliveryEmailMode('postWorkshop', client, { settings: resolved });
  if (mode !== 'shadow' && mode !== 'auto') return { sent: false, shadow: false, status: 'skipped', reason: `mode-${mode}` };
  const sales = deps.sales || await import('../data/sales.js');
  const sentBefore = deliveryEmailStamps(sales.getSalesClientById(client.id) || client).postWorkshopSentAt;
  if (sentBefore && force !== true) return { sent: false, shadow: false, status: 'skipped', reason: 'already-sent' };
  const at = isoAt(nowMs(now));
  const built = await buildPostWorkshopMessage(client, { sender, settings: resolved, deps, now: at });
  const dedupeKey = force === true ? `postWorkshop:${client.id}:manual:${at}` : `postWorkshop:${client.id}:manual`;
  const result = await deliverDeliveryEmail({
    kindId: 'postWorkshop',
    client,
    message: built.message,
    mode: mode === 'auto' ? 'manual' : 'shadow',
    stampKey: 'postWorkshopSentAt',
    dedupeKey,
    now: at,
    dataDir,
    deps: {
      ...deps,
      stampDeliveryEmail: deps.stampDeliveryEmail || sales.stampDeliveryEmail,
      // Sent by someone else since this press read the client (a double click waits for the lease).
      alreadySent: () => deliveryEmailStamps(sales.getSalesClientById(client.id) || client).postWorkshopSentAt !== sentBefore,
    },
  });
  return {
    sent: result.status === 'sent',
    shadow: mode === 'shadow',
    status: result.status,
    reason: result.reason || result.status,
    ready: built.ready,
  };
}
