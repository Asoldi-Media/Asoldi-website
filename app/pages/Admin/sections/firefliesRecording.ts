/**
 * What happened to each booked meeting's Fireflies recording, in the sales UI's words.
 *
 * Pure helpers. The state comes from the server (lib/fireflies-recording-state.js): client.liveRecordings
 * while a meeting is near, and `recording` on its live: placeholder row after. A missing field means an
 * older hub, so every helper reads it defensively and falls back to saying less, never to a guess.
 */
import { slotKindFromKey } from '../../../../lib/fireflies-recording-state.js';
import { isPlaceholderMeetingId } from '../../../../lib/offer-meetings.js';
import { SALES_ACTION_TIMEZONE, isoToDatetimeLocalOslo } from '../../../../lib/sales-next-actions.js';
import type { FirefliesRecordingState, SalesClient, SalesClientMeeting, SalesLiveRecording } from '../shared';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** A card with a live meeting is refreshed about this often. */
export const LIVE_REFRESH_MS = 30_000;
/** More live clients than this in one tick: reload the list once instead of each client. */
export const LIVE_REFRESH_MAX_CLIENTS = 3;
// The server lists a slot from 30 minutes before start, so look again from then.
const LIVE_ENTRY_LEAD_MS = 31 * MINUTE_MS;
// Only a safety cap for a stale list: the server drops a slot 2 hours after its booked end.
const LIVE_REFRESH_TAIL_MS = 4 * HOUR_MS;

/** Fireflies will not deliver for these: the rep pastes a recording or marks the meeting as held without one. */
export const NO_RECORDING_STATES: readonly FirefliesRecordingState[] = ['not-admitted', 'missing', 'empty'];

export function isNoRecordingState(state = '') {
  return (NO_RECORDING_STATES as readonly string[]).includes(state);
}

export type RecordingTone = 'amber' | 'red' | 'green' | 'grey' | 'muted';

/** Classes that read in the dark admin and in staff-light (it remaps the colours; gray borders show in both). */
export const RECORDING_TONE_CLASS: Record<RecordingTone, string> = {
  amber: 'border-amber-400/40 bg-amber-900/30 text-amber-200',
  red: 'border-red-500/40 bg-red-900/30 text-red-200',
  green: 'border-green-600/40 bg-green-900/40 text-green-300',
  grey: 'border-gray-500/40 bg-white/5 text-gray-400',
  muted: 'border-gray-500/40 bg-white/5 text-gray-300',
};

export function isPlaceholderRow(row?: { meetingId?: string; placeholder?: boolean } | null) {
  return Boolean(row?.placeholder) || isPlaceholderMeetingId(String(row?.meetingId || ''));
}

export function isDuplicateRow(row?: { duplicateOf?: string } | null) {
  return Boolean(String(row?.duplicateOf || '').trim());
}

/** HH:MM in Oslo, '' for a missing or bad time. */
export function recordingClock(iso = '') {
  const local = isoToDatetimeLocalOslo(iso);
  return local ? local.slice(11, 16) : '';
}

function osloDay(ms: number) {
  return isoToDatetimeLocalOslo(new Date(ms).toISOString()).slice(0, 10);
}

/** "i dag kl. 10:00", "i går kl. 10:00" or "tor. 22. okt. kl. 10:00". */
export function recordingWhen(iso = '', nowMs = Date.now()) {
  const local = isoToDatetimeLocalOslo(iso);
  if (!local) return '';
  const day = local.slice(0, 10);
  const dayText = day === osloDay(nowMs)
    ? 'i dag'
    : day === osloDay(nowMs - 24 * HOUR_MS)
      ? 'i går'
      : day === osloDay(nowMs + 24 * HOUR_MS)
        ? 'i morgen'
        : new Intl.DateTimeFormat('nb-NO', {
          timeZone: SALES_ACTION_TIMEZONE,
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        }).format(new Date(iso));
  return `${dayText} kl. ${local.slice(11, 16)}`;
}

/** The status line for one meeting. `at` is when the bot goes in (scheduled only). */
export function recordingStateLabel(state = '', { at = '', hasTranscript = false } = {}) {
  switch (state) {
    case 'scheduled': {
      const clock = recordingClock(at);
      return clock ? `Fireflies sendes inn kl. ${clock}` : 'Fireflies sendes inn når møtet starter';
    }
    case 'dispatched':
      return 'Fireflies banker på – slipp inn «Fireflies.ai Notetaker» i Meet';
    case 'recording':
      return 'Fireflies tar opp';
    case 'ended':
      return hasTranscript ? 'Opptaket er klart' : 'Møtet er ferdig – transkriptet kommer';
    case 'not-admitted':
      return 'Fireflies kom ikke inn i møtet';
    case 'missing':
      return 'Ingen opptak fra Fireflies';
    case 'empty':
      return 'Opptaket er tomt';
    case 'declined':
      return 'Markert uten opptak';
    default:
      return '';
  }
}

/** Short form for chips on compact cards. */
export function recordingStateShortLabel(state = '', { at = '', hasTranscript = false } = {}) {
  switch (state) {
    case 'scheduled': {
      const clock = recordingClock(at);
      return clock ? `Fireflies kl. ${clock}` : 'Fireflies ved start';
    }
    case 'dispatched':
      return 'Fireflies banker på';
    case 'recording':
      return 'Fireflies tar opp';
    case 'ended':
      return hasTranscript ? 'Opptak klart' : 'Transkript kommer';
    case 'not-admitted':
      return 'Fireflies kom ikke inn';
    case 'missing':
      return 'Ingen opptak';
    case 'empty':
      return 'Tomt opptak';
    case 'declined':
      return 'Uten opptak';
    default:
      return '';
  }
}

export function recordingStateTone(state = '', { hasTranscript = false } = {}): RecordingTone {
  if (state === 'dispatched' || state === 'empty') return 'amber';
  if (state === 'not-admitted' || state === 'missing') return 'red';
  if (state === 'recording' || (state === 'ended' && hasTranscript)) return 'green';
  if (state === 'declined') return 'grey';
  return 'muted';
}

const SLOT_KIND_LABEL: Record<string, string> = {
  sales: 'Salgsmøte',
  workshop: 'Workshop',
  iteration: 'Iterasjonsmøte',
  action: 'Møte',
};

export function slotKindLabel(kind = '') {
  return SLOT_KIND_LABEL[kind] || 'Møte';
}

/** The kind of a client.meetings row: its slotKey, else its purpose. */
export function meetingRowKind(row?: Pick<SalesClientMeeting, 'slotKey' | 'purpose' | 'forSalesMeeting'> | null) {
  const fromKey = slotKindFromKey(String(row?.slotKey || ''));
  if (fromKey) return fromKey;
  if (row?.purpose) return row.purpose;
  return row?.forSalesMeeting ? 'sales' : '';
}

export function liveRecordingsOf(client?: Pick<SalesClient, 'liveRecordings'> | null): SalesLiveRecording[] {
  const list = Array.isArray(client?.liveRecordings) ? client.liveRecordings : [];
  return list.filter((entry) => entry && typeof entry === 'object' && String(entry.slotKey || ''));
}

function startMs(iso = '') {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

/** When the bot goes in for a scheduled entry: the planned send, else 3 minutes before start. */
export function liveRecordingSendAt(entry: SalesLiveRecording) {
  if (entry.nextAttemptAt) return entry.nextAttemptAt;
  const start = startMs(entry.startAt);
  return Number.isFinite(start) ? new Date(start - 3 * MINUTE_MS).toISOString() : '';
}

export function liveRecordingLabel(entry: SalesLiveRecording) {
  return recordingStateLabel(entry.state, { at: liveRecordingSendAt(entry), hasTranscript: entry.hasTranscript });
}

/** Still worth a fresh look: the bot is due, knocking or in the room, or its transcript is on the way. */
export function liveRecordingIsOpen(entry: SalesLiveRecording, nowMs = Date.now()) {
  const start = startMs(entry.startAt);
  if (Number.isFinite(start) && nowMs > start + LIVE_REFRESH_TAIL_MS) return false;
  if (entry.state === 'scheduled' || entry.state === 'dispatched' || entry.state === 'recording') return true;
  if (entry.state === 'ended' || entry.state === 'not-admitted') return !entry.hasTranscript;
  return false;
}

/** The 30-second refresh: an open live entry, or an online sales meeting about to get its first entry. */
export function clientNeedsLiveRefresh(client: SalesClient, nowMs = Date.now()) {
  const entries = liveRecordingsOf(client);
  if (entries.some((entry) => liveRecordingIsOpen(entry, nowMs))) return true;
  if (entries.length || client.meetingMode !== 'online' || !client.agreedTime) return false;
  const start = startMs(client.meetingAt);
  return Number.isFinite(start) && start > nowMs && start - nowMs <= LIVE_ENTRY_LEAD_MS;
}

const URGENCY: Record<string, number> = {
  dispatched: 0,
  'not-admitted': 1,
  missing: 2,
  recording: 3,
  empty: 4,
  scheduled: 5,
  ended: 6,
  declined: 7,
};

/** The card's order: a knock at the door first, a quiet finished meeting last, then by start. */
export function liveRecordingsByUrgency(client?: Pick<SalesClient, 'liveRecordings'> | null) {
  return [...liveRecordingsOf(client)].sort((a, b) => (
    (URGENCY[a.state] ?? 9) - (URGENCY[b.state] ?? 9) || (startMs(a.startAt) || 0) - (startMs(b.startAt) || 0)
  ));
}

/** The entry a compact card shows. */
export function mostUrgentLiveRecording(client?: Pick<SalesClient, 'liveRecordings'> | null) {
  return liveRecordingsByUrgency(client)[0] || null;
}

function rowStart(row: SalesClientMeeting) {
  return startMs(row.startedAt || row.when || '') || startMs(row.linkedAt || '') || 0;
}

export type SlotRecording = {
  state: FirefliesRecordingState;
  message: string;
  at: string;
  hasTranscript: boolean;
};

/** The sales meeting's recording state: its live entry while near, else its newest placeholder row. */
export function salesSlotRecording(client?: SalesClient | null): SlotRecording | null {
  const live = liveRecordingsOf(client)
    .filter((entry) => entry.kind === 'sales')
    .sort((a, b) => (startMs(b.startAt) || 0) - (startMs(a.startAt) || 0))[0];
  if (live) {
    return {
      state: live.state,
      message: String(live.message || ''),
      at: live.state === 'scheduled' ? liveRecordingSendAt(live) : live.startAt,
      hasTranscript: Boolean(live.hasTranscript),
    };
  }
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const row = meetings
    .filter((item) => isPlaceholderRow(item) && item.recording?.state && meetingRowKind(item) === 'sales')
    .sort((a, b) => rowStart(b) - rowStart(a))[0];
  if (!row?.recording) return null;
  return {
    state: row.recording.state,
    message: String(row.recording.message || ''),
    at: row.startedAt || '',
    hasTranscript: false,
  };
}

/** A real (not placeholder, not duplicate) recording of the sales meeting with talk. */
export function salesRecordingWithTalk(client?: SalesClient | null) {
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  return meetings.find((row) => (
    !isPlaceholderRow(row)
    && !isDuplicateRow(row)
    && row.hasTranscript
    && (row.purpose === 'sales' || row.forSalesMeeting)
  )) || null;
}

/**
 * One line for the card's "Kalender & utsendelser": the sales meeting's recording state when there is one,
 * else what will happen. Never the fred@ calendar stamps: an invite or an accepted send proves nothing.
 */
export function salesRecordingSummary(client: SalesClient, { nowMs = Date.now(), hasMeetLink = false } = {}) {
  const slot = salesSlotRecording(client);
  if (slot) {
    const label = recordingStateLabel(slot.state, { at: slot.at, hasTranscript: slot.hasTranscript });
    return { state: slot.state, hasTranscript: slot.hasTranscript, text: label, detail: slot.message !== label ? slot.message : '' };
  }
  const real = salesRecordingWithTalk(client);
  if (real) return { state: '', hasTranscript: true, text: 'Opptaket er koblet til kunden', detail: real.title || '' };
  if (client.meetingMode !== 'online') return { state: '', hasTranscript: false, text: 'Brukes ikke på fysiske møter', detail: '' };
  const start = startMs(client.meetingAt);
  if (client.agreedTime && Number.isFinite(start) && start > nowMs) {
    return hasMeetLink
      ? { state: '', hasTranscript: false, text: 'Sendes inn i Meet 3 minutter før start', detail: '' }
      : { state: '', hasTranscript: false, text: 'Ingen Meet-lenke ennå, så Fireflies kan ikke sendes inn', detail: '' };
  }
  return { state: '', hasTranscript: false, text: 'Ingen opptak koblet', detail: '' };
}

/** The server's answer to "Send Fireflies inn nå", plus "Tidligst kl. HH:MM" when the send has to wait. */
export function liveJoinAnswerText(answer: { message?: unknown; nextAllowedAt?: unknown } = {}, nowMs = Date.now()) {
  const message = String(answer.message || '').trim();
  const next = String(answer.nextAllowedAt || '');
  const nextMs = startMs(next);
  const later = Number.isFinite(nextMs) && nextMs - nowMs > 30_000 && recordingClock(next)
    ? `Tidligst kl. ${recordingClock(next)}.`
    : '';
  return [message, later].filter(Boolean).join(' ');
}

/** The offer composer's view of its meeting: recordingState when the hub sends it, else the old pendingTranscript. */
export function offerMeetingRecording(meeting?: { recordingState?: string; pendingTranscript?: boolean } | null) {
  const known = typeof meeting?.recordingState === 'string';
  const state = known ? String(meeting?.recordingState || '') : '';
  return {
    known,
    state,
    inMeeting: state === 'recording',
    knocking: state === 'dispatched',
    noRecording: isNoRecordingState(state),
    declined: state === 'declined',
    // Older hubs only say "no transcript yet", which is all that can be repeated.
    waiting: known ? state === 'ended' || (!state && Boolean(meeting?.pendingTranscript)) : Boolean(meeting?.pendingTranscript),
  };
}

/** Patch a fresh client from a route into the one on screen, keeping what that route leaves out. */
export function mergeFreshClient(current: SalesClient, fresh: SalesClient): SalesClient {
  return {
    ...fresh,
    offerStatus: fresh.offerStatus ?? current.offerStatus,
    liveRecordings: Array.isArray(fresh.liveRecordings) ? fresh.liveRecordings : current.liveRecordings,
  };
}
