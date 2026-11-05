// Runtime guards for automatic delivery mails. There is no approval queue: an email kind that runs in
// auto sends on its own and pauses itself (pauseAutomationSwitch, `emails.<kind>`) when its sends go
// wrong. A pause shows as the delivery alert switch-paused:emails.<kind> with the guard's reason.
//
// Before a send (the mail is not sent, the kind pauses):
//   empty-fields      no recipient, no subject, no text and no html, or a subject or text that
//                     still holds a template placeholder ({{...}}, undefined, [object Object], NaN);
//   recipient-class   a recipient that is not the client's own address, or an internal address
//                     (inbox.internalDomains, inbox.internalSenders).
// After sends, per kind in the last guards.windowHours:
//   error-rate        refused or failed sends > guards.errorRatePct of the attempts;
//   bounce-rate       reported bounces > guards.bounceRatePct of the sends;
//   complaints        reported complaints > guards.complaintsMax (no minimum sample);
//   volume-spike      sends > guards.volumeSpikeFactor x the average of the 7 windows before, and
//                     never less than guards.minSample; only once those 7 windows hold at least
//                     guards.minSample sends (a new kind has no usual volume yet).
// The rate checks wait for guards.minSample attempts (sends for the bounce rate) in the window.
// Bounces and complaints arrive through noteDeliveryEmailFeedback (a provider event or a returned
// mail); this file does not read any mailbox.
//
// State: delivery-hot/email-guards.json { version, kinds: { <kind>: [[ms, type], ...] }, trips: [...] }:
// times and event types only, no address, subject or client id. Events older than 8 windows are
// dropped on the next write.
import { join } from 'node:path';
import { appendDeliveryAudit } from './delivery-audit.js';
import { hotPath, readHotJson, updateHotJson } from './hot-store.js';
import { getAutomationSettings, pauseAutomationSwitch } from '../data/automation-settings.js';

export const GUARDS_FILE = join('delivery-hot', 'email-guards.json');
export const GUARD_EVENT_TYPES = Object.freeze(['sent', 'error', 'bounce', 'complaint']);
export const GUARD_CODES = Object.freeze(['empty-fields', 'recipient-class', 'error-rate', 'bounce-rate', 'complaints', 'volume-spike']);
export const SPIKE_BASELINE_WINDOWS = 7;
const KEEP_WINDOWS = SPIKE_BASELINE_WINDOWS + 1;
const MAX_EVENTS_PER_KIND = 5000;
const TRIPS_MAX = 50;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_GUARDS = Object.freeze({ errorRatePct: 20, bounceRatePct: 5, complaintsMax: 1, volumeSpikeFactor: 3, windowHours: 24, minSample: 5 });
const PLACEHOLDER_RE = /\{\{|\}\}|\bundefined\b|\[object Object\]|\bNaN\b/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 400) {
  return String(value ?? '').trim().slice(0, max);
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : Date.now();
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function lower(value) {
  return text(value, 200).toLowerCase();
}

/** The guard thresholds from automation settings, with the defaults filled in. */
export function guardSettings(settings) {
  const raw = isPlainObject(settings?.guards) ? settings.guards : {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_GUARDS)) {
    const value = Number(raw[key]);
    out[key] = Number.isFinite(value) ? value : fallback;
  }
  return out;
}

export function guardsPath({ dataDir } = {}) {
  return hotPath(GUARDS_FILE, { dataDir });
}

function readState(dataDir) {
  const raw = readHotJson(guardsPath({ dataDir }), { fresh: true });
  return {
    kinds: isPlainObject(raw?.kinds) ? raw.kinds : {},
    trips: Array.isArray(raw?.trips) ? raw.trips : [],
  };
}

function recipients(message) {
  const raw = Array.isArray(message?.to) ? message.to : String(message?.to ?? '').split(',');
  return raw.map((entry) => lower(typeof entry === 'object' ? entry?.email || entry?.address : entry)).filter(Boolean);
}

/** The addresses a client's own mail may go to (contact, client and invoice addresses). */
export function clientAddresses(client) {
  const out = new Set();
  for (const key of ['contactEmail', 'clientEmail', 'email', 'invoiceEmail']) {
    const value = lower(client?.[key]);
    if (EMAIL_RE.test(value)) out.add(value);
  }
  return out;
}

function internalAddress(address, settings) {
  const inbox = isPlainObject(settings?.inbox) ? settings.inbox : {};
  const senders = (Array.isArray(inbox.internalSenders) ? inbox.internalSenders : []).map(lower);
  const domains = (Array.isArray(inbox.internalDomains) ? inbox.internalDomains : ['asoldi.com']).map(lower);
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return senders.includes(address) || domains.includes(domain);
}

/**
 * Checks one mail before an automatic send: { ok: true } or { ok: false, code, reason }. Pure: reads
 * only its arguments.
 */
export function checkDeliveryMessage({ client, message, settings } = {}) {
  const to = recipients(message);
  const subject = text(message?.subject, 2000);
  const body = text(message?.text, 200_000);
  const html = text(message?.html, 400_000);
  if (!to.length || !subject || (!body && !html)) {
    return { ok: false, code: 'empty-fields', reason: `missing ${[!to.length && 'recipient', !subject && 'subject', !body && !html && 'text'].filter(Boolean).join(', ')}` };
  }
  if (PLACEHOLDER_RE.test(subject) || PLACEHOLDER_RE.test(body)) {
    return { ok: false, code: 'empty-fields', reason: 'a template placeholder was not filled in' };
  }
  const own = clientAddresses(client);
  for (const address of to) {
    if (!EMAIL_RE.test(address)) return { ok: false, code: 'recipient-class', reason: 'a recipient is not an e-mail address' };
    if (internalAddress(address, settings)) return { ok: false, code: 'recipient-class', reason: 'a recipient is an internal address' };
    if (!own.has(address)) return { ok: false, code: 'recipient-class', reason: "a recipient is not the client's own address" };
  }
  return { ok: true };
}

/** Counts per window for one kind's events: { current: {sent, error, bounce, complaint}, previous: [sent per earlier window] }. */
export function windowCounts(events, { nowMs, windowMs }) {
  const current = { sent: 0, error: 0, bounce: 0, complaint: 0 };
  const previous = new Array(SPIKE_BASELINE_WINDOWS).fill(0);
  for (const row of Array.isArray(events) ? events : []) {
    const [at, type] = Array.isArray(row) ? row : [];
    const age = nowMs - Number(at);
    if (!Number.isFinite(age) || age < 0) continue;
    const slot = Math.floor(age / windowMs);
    if (slot === 0) {
      if (Object.prototype.hasOwnProperty.call(current, type)) current[type] += 1;
    } else if (slot <= SPIKE_BASELINE_WINDOWS && type === 'sent') {
      previous[slot - 1] += 1;
    }
  }
  return { current, previous };
}

/**
 * The first guard that holds for these counts, or null. Pure. `counts` comes from windowCounts.
 */
export function evaluateGuards(counts, guards) {
  const { current, previous } = counts;
  const attempts = current.sent + current.error;
  const pct = (part, whole) => Math.round((part / whole) * 1000) / 10;
  if (attempts >= guards.minSample && (current.error / attempts) * 100 > guards.errorRatePct) {
    return { code: 'error-rate', reason: `${current.error} of ${attempts} sends failed (${pct(current.error, attempts)} % > ${guards.errorRatePct} %)` };
  }
  if (current.sent >= guards.minSample && (current.bounce / current.sent) * 100 > guards.bounceRatePct) {
    return { code: 'bounce-rate', reason: `${current.bounce} bounces on ${current.sent} sends (${pct(current.bounce, current.sent)} % > ${guards.bounceRatePct} %)` };
  }
  if (current.complaint > guards.complaintsMax) {
    return { code: 'complaints', reason: `${current.complaint} complaints (more than ${guards.complaintsMax})` };
  }
  // A spike needs a usual volume to compare with: at least guards.minSample sends in the windows before.
  const history = previous.reduce((sum, value) => sum + value, 0);
  const baseline = history / previous.length;
  const limit = Math.max(guards.minSample, guards.volumeSpikeFactor * baseline);
  if (history >= guards.minSample && current.sent > limit) {
    return { code: 'volume-spike', reason: `${current.sent} sends in ${guards.windowHours} h against a usual ${Math.round(baseline * 10) / 10} (limit ${Math.round(limit * 10) / 10})` };
  }
  return null;
}

/** Window counts and the guard verdict for every kind with events (the promotion view). */
export function guardStats({ dataDir, settings = null, now = Date.now() } = {}) {
  const resolved = settings || getAutomationSettings({ dataDir });
  const guards = guardSettings(resolved);
  const windowMs = guards.windowHours * HOUR_MS;
  const nowMs = toMs(now);
  const state = readState(dataDir);
  const kinds = {};
  for (const [kind, events] of Object.entries(state.kinds)) {
    const counts = windowCounts(events, { nowMs, windowMs });
    kinds[kind] = { ...counts.current, previous: counts.previous, verdict: evaluateGuards(counts, guards) };
  }
  return { guards, kinds, trips: state.trips.slice(-20) };
}

function pruneEvents(events, nowMs, windowMs) {
  const keepAfter = nowMs - KEEP_WINDOWS * windowMs;
  return events.filter((row) => Array.isArray(row) && Number(row[0]) > keepAfter).slice(-MAX_EVENTS_PER_KIND);
}

/** Records one event for a kind. Returns nothing; never throws. */
export function recordGuardEvent(kindId, type, { dataDir, now = Date.now(), settings = null } = {}) {
  const kind = text(kindId, 40);
  if (!kind || !GUARD_EVENT_TYPES.includes(type)) return;
  const nowMs = toMs(now);
  const windowMs = guardSettings(settings || getAutomationSettings({ dataDir })).windowHours * HOUR_MS;
  try {
    updateHotJson(guardsPath({ dataDir }), (raw) => {
      const kinds = isPlainObject(raw?.kinds) ? { ...raw.kinds } : {};
      kinds[kind] = pruneEvents([...(Array.isArray(kinds[kind]) ? kinds[kind] : []), [nowMs, type]], nowMs, windowMs);
      return { version: 1, kinds, trips: Array.isArray(raw?.trips) ? raw.trips : [] };
    });
  } catch (error) {
    console.warn('[delivery-guards] could not record a send event:', error?.message || error);
  }
}

async function raiseAlertNow({ dataDir, settings, now }) {
  try {
    const { currentAlerts, processAlerts, readHeartbeatFile } = await import('./delivery-alerts.js');
    const conditions = currentAlerts({ dataDir, settings, now, heartbeats: readHeartbeatFile({ dataDir }) });
    await processAlerts({ now, settings, conditions, dataDir });
  } catch (error) {
    console.warn('[delivery-guards] alert not raised now (the next loop tick raises it):', error?.message || error);
  }
}

/**
 * Pauses the kind for a guard verdict, records the trip and raises the delivery alert. Returns the
 * pause result. A kind that is already paused is not paused again.
 */
export async function tripEmailGuard(kindId, verdict, { dataDir, now = Date.now(), clientId = '' } = {}) {
  const kind = text(kindId, 40);
  const nowMs = toMs(now);
  const at = new Date(nowMs);
  const reason = `guard ${verdict.code}: ${text(verdict.reason, 240)}`;
  const settings = getAutomationSettings({ dataDir, fresh: true });
  const already = isPlainObject(settings?.emails?.[kind]?.paused);
  const paused = already ? { ok: true, changes: [] } : pauseAutomationSwitch(`emails.${kind}`, { reason, by: 'guard', dataDir, now: at });
  try {
    updateHotJson(guardsPath({ dataDir }), (raw) => {
      const trips = Array.isArray(raw?.trips) ? [...raw.trips] : [];
      trips.push({ at: at.toISOString(), kind, code: verdict.code, reason: text(verdict.reason, 240), paused: !already });
      return { version: 1, kinds: isPlainObject(raw?.kinds) ? raw.kinds : {}, trips: trips.slice(-TRIPS_MAX) };
    });
  } catch (error) {
    console.warn('[delivery-guards] could not record a trip:', error?.message || error);
  }
  appendDeliveryAudit({ at: at.toISOString(), kind: 'email-guard', clientId: text(clientId, 80), email: kind, reason: `${verdict.code}${already ? ' (already paused)' : ''}` }, { dataDir });
  if (!already) await raiseAlertNow({ dataDir, settings: getAutomationSettings({ dataDir, fresh: true }), now: nowMs });
  return paused;
}

/** Records an event, evaluates the kind and trips the guard when one holds. Returns the verdict or null. */
export async function noteEmailOutcome(kindId, type, { dataDir, now = Date.now(), clientId = '' } = {}) {
  const settings = getAutomationSettings({ dataDir, fresh: true });
  recordGuardEvent(kindId, type, { dataDir, now, settings });
  const guards = guardSettings(settings);
  const counts = windowCounts(readState(dataDir).kinds[text(kindId, 40)], { nowMs: toMs(now), windowMs: guards.windowHours * HOUR_MS });
  const verdict = evaluateGuards(counts, guards);
  if (verdict) await tripEmailGuard(kindId, verdict, { dataDir, now, clientId });
  return verdict;
}

/** A bounce or complaint for a mail of this kind (a provider event or a returned mail). */
export async function noteDeliveryEmailFeedback(kindId, type, options = {}) {
  if (type !== 'bounce' && type !== 'complaint') throw new Error(`feedback type must be bounce or complaint, not ${type}`);
  return noteEmailOutcome(kindId, type, options);
}

/**
 * The guarded automatic send: the message check, the send, then the outcome. Returns
 * { status: 'sent' } or { status: 'guarded', code, reason } (nothing was sent). A failed send is
 * recorded and its error is thrown again.
 */
export async function guardedSend(kindId, { client, message, send, dataDir, now = Date.now() } = {}) {
  const settings = getAutomationSettings({ dataDir, fresh: true });
  const check = checkDeliveryMessage({ client, message, settings });
  const clientId = text(client?.id, 80);
  if (!check.ok) {
    await tripEmailGuard(kindId, check, { dataDir, now, clientId });
    return { status: 'guarded', code: check.code, reason: check.reason };
  }
  try {
    await send(message);
  } catch (error) {
    await noteEmailOutcome(kindId, 'error', { dataDir, now, clientId });
    throw error;
  }
  await noteEmailOutcome(kindId, 'sent', { dataDir, now, clientId });
  return { status: 'sent' };
}
