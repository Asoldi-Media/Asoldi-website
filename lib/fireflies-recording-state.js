/**
 * Shared vocabulary for "did this booked meeting get recorded?".
 *
 * Every booked online meeting (sales, workshop, iteration, recorded Møte action) is a live
 * session keyed on its Meet room and start time. The client.meetings placeholder row
 * ('live:<client>[:slot]:<ms>') carries that session's recording state until a real Fireflies
 * transcript replaces it. Capture (live join + verification), intake (transcript pull and the
 * missing-recording watchdog) and the UI all read and write the same `recording` object.
 */
import { normalizeFirefliesMeetLink } from './fireflies-client-match.js';

export const RECORDING_STATES = [
  // Session known, bot not sent yet.
  'scheduled',
  // addToLiveMeeting accepted the request; the bot has not been seen in the room yet.
  'dispatched',
  // The bot is in the room (seen in Fireflies active_meetings).
  'recording',
  // The bot was in the room and has left; a transcript is expected.
  'ended',
  // Every dispatch attempt ran out without the bot ever being seen in the room.
  'not-admitted',
  // The transcript deadline passed and no recording was linked.
  'missing',
  // Fireflies finished, but the recording has no talk (silent or too short).
  'empty',
  // A human marked the meeting as held without a recording.
  'declined',
];

const STATE_SET = new Set(RECORDING_STATES);

/** States after which nothing more is expected from Fireflies for this meeting. */
export const TERMINAL_RECORDING_STATES = new Set(['missing', 'empty', 'declined']);

function text(value = '') {
  return String(value ?? '').trim();
}

function iso(value = '') {
  const raw = text(value);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : '';
}

function startMs(startAt = '') {
  const ms = Date.parse(text(startAt));
  return Number.isFinite(ms) ? ms : NaN;
}

/** `<normalized meet link>|<start ms>`, or '' when either part is missing. */
export function sessionKeyFor(meetLink = '', startAt = '') {
  const link = normalizeFirefliesMeetLink(meetLink);
  const ms = startMs(startAt);
  if (!link || !Number.isFinite(ms)) return '';
  return `${link}|${ms}`;
}

export const SLOT_KINDS = ['sales', 'workshop', 'iteration', 'action'];

/** Which booked slot of one client a meeting row belongs to: sales:<ms>, workshop:<ms>, iteration:<ms>, action:<id>. */
export function slotKeyFor(kind = '', { startAt = '', actionId = '' } = {}) {
  const value = text(kind);
  if (value === 'action') {
    const id = text(actionId);
    return id ? `action:${id}` : '';
  }
  if (!SLOT_KINDS.includes(value)) return '';
  const ms = startMs(startAt);
  return Number.isFinite(ms) ? `${value}:${ms}` : '';
}

export function slotKindFromKey(slotKey = '') {
  const kind = text(slotKey).split(':')[0];
  return SLOT_KINDS.includes(kind) ? kind : '';
}

function count(value) {
  const number = Math.round(Number(value) || 0);
  return number > 0 ? Math.min(number, 99) : 0;
}

/**
 * The `recording` object on a client.meetings row. Returns null when the row carries no
 * recording state, so ordinary transcript rows stay small.
 */
export function normalizeRecordingState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const state = STATE_SET.has(text(raw.state)) ? text(raw.state) : '';
  if (!state) return null;
  // What a rep's "uten opptak" replaced ('missing' or 'empty'), so its undo says the same again.
  const declinedFrom = state === 'declined' && STATE_SET.has(text(raw.declinedFrom)) ? text(raw.declinedFrom) : '';
  return {
    state,
    ...(declinedFrom ? { declinedFrom } : {}),
    sessionKey: text(raw.sessionKey),
    ffMeetingId: text(raw.ffMeetingId),
    attempts: count(raw.attempts),
    dispatchedAt: iso(raw.dispatchedAt),
    verifiedAt: iso(raw.verifiedAt),
    lastSeenAt: iso(raw.lastSeenAt),
    endedAt: iso(raw.endedAt),
    missingAt: iso(raw.missingAt),
    alertedAt: iso(raw.alertedAt),
    checkedAt: iso(raw.checkedAt),
    message: text(raw.message).slice(0, 300),
  };
}

/** Merge a partial recording update into the current one (fields not in the patch are kept). */
export function mergeRecordingState(current, patch) {
  const base = normalizeRecordingState(current) || {};
  if (!patch || typeof patch !== 'object') return normalizeRecordingState(base);
  return normalizeRecordingState({ ...base, ...patch });
}
