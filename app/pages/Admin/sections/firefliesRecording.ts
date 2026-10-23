/**
 * What happened to each booked meeting's Fireflies recording, in the sales UI's words.
 *
 * Pure helpers. The state comes from the server (lib/fireflies-recording-state.js): client.liveRecordings
 * while a meeting is near, and `recording` on its live: placeholder row after. A missing field means an
 * older hub, so every helper reads it defensively and falls back to saying less, never to a guess.
 */
import { slotKindFromKey } from '../../../../lib/fireflies-recording-state.js';
import { isPlaceholderMeetingId } from '../../../../lib/offer-meetings.js';
import { ONLINE_CALENDAR_DURATION_MINUTES } from '../../../../lib/sales-meeting-duration.js';
import {
  SALES_ACTION_TIMEZONE,
  isoToDatetimeLocalOslo,
  recordedSalesActions,
} from '../../../../lib/sales-next-actions.js';
import { WORKSHOP_DURATION_MINUTES, getWorkshopAction, sanitizeWorkshopFormat } from '../../../../lib/workshop-action-shared.js';
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
/** Fireflies waits up to 10 minutes in a Meet lobby; the engine allows 2 more before it calls the bot gone. */
export const LIVE_KNOCK_OPEN_MS = 12 * MINUTE_MS;
// A planned send this far in the past means the engine did not run it.
const LATE_SEND_MS = 2 * MINUTE_MS;

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

/** Booked length of the slot behind a live entry, as the server books it (sales: the client's own length). */
export function liveRecordingBookedMinutes(entry: Pick<SalesLiveRecording, 'kind'>, client?: Pick<SalesClient, 'meetingDurationMinutes'> | null) {
  if (entry.kind === 'workshop' || entry.kind === 'iteration') return WORKSHOP_DURATION_MINUTES;
  if (entry.kind === 'sales') return Number(client?.meetingDurationMinutes) || ONLINE_CALENDAR_DURATION_MINUTES;
  return ONLINE_CALENDAR_DURATION_MINUTES;
}

export type LiveRecordingView = {
  /** The status line. */
  label: string;
  /** Chip text on compact cards. */
  short: string;
  tone: RecordingTone;
  /** A notetaker is (or may still be) waiting in the Meet lobby: only someone in the meeting can let it in. */
  knock: boolean;
  /** The hub will not send the bot in: live-join is off here, the key is missing, or every send failed. */
  blocked: boolean;
  /** A transcript with talk is in: nothing is left to send or mark. */
  ready: boolean;
};

/**
 * What one live entry means right now. The label only promises a send the server has planned: an entry with
 * no planned send says so, and a planned send that is long past says it did not happen.
 */
export function liveRecordingView(entry: SalesLiveRecording, { nowMs = Date.now(), bookedMinutes = 0 } = {}): LiveRecordingView {
  const view = (label: string, short: string, tone: RecordingTone, extra: Partial<LiveRecordingView> = {}): LiveRecordingView => (
    { label, short, tone, knock: false, blocked: false, ready: false, ...extra }
  );
  const state = String(entry.state || '');
  const start = startMs(entry.startAt);
  // A transcript with talk is in: that is the answer, whatever a rep or the engine said before.
  if (entry.hasTranscript && ['ended', 'not-admitted', 'missing', 'empty', 'declined'].includes(state)) {
    return view('Opptaket er klart', 'Opptak klart', 'green', { ready: true });
  }
  if (state === 'scheduled') {
    const next = startMs(entry.nextAttemptAt);
    if (Number.isFinite(next)) {
      const clock = recordingClock(entry.nextAttemptAt);
      const again = Number(entry.attempts) > 0;
      if (next - nowMs > 30_000) {
        return view(`Fireflies sendes inn${again ? ' på nytt' : ''} kl. ${clock}`, `Fireflies kl. ${clock}`, 'muted');
      }
      if (nowMs - next <= LATE_SEND_MS) return view('Fireflies sendes inn nå', 'Fireflies sendes inn', 'muted');
      return view(`Fireflies skulle vært sendt inn kl. ${clock}`, 'Fireflies ikke sendt inn', 'red', { blocked: true });
    }
    // No planned send: every send failed, or the server will not send (safe mode, no key). Its message says which.
    if (Number(entry.attempts) > 0) return view('Fireflies ble ikke sendt inn', 'Ikke sendt inn', 'red', { blocked: true });
    if (entry.canResend) return view('Fireflies sendes inn nå', 'Fireflies sendes inn', 'muted');
    return view('Fireflies sendes ikke inn', 'Sendes ikke inn', 'red', { blocked: true });
  }
  if (state === 'dispatched') {
    // A running engine knocks again within about 10 minutes or gives up; an older knock has left the lobby.
    const knockMs = startMs(entry.lastAttemptAt);
    if (Number.isFinite(knockMs) && nowMs - knockMs > LIVE_KNOCK_OPEN_MS) {
      return view('Fireflies er ikke bekreftet i møtet', 'Ikke bekreftet', 'amber');
    }
    return view(recordingStateLabel('dispatched'), recordingStateShortLabel('dispatched'), 'amber', { knock: true });
  }
  if (state === 'ended') {
    const knockMs = startMs(entry.lastAttemptAt);
    const seenMs = startMs(entry.lastSeenAt);
    // The bot was in, dropped out and was sent in again: it knocks while the meeting may still run.
    if (Number.isFinite(knockMs) && Number.isFinite(seenMs) && knockMs > seenMs && nowMs - knockMs <= LIVE_KNOCK_OPEN_MS) {
      return view('Fireflies banker på igjen – slipp inn «Fireflies.ai Notetaker» i Meet', 'Fireflies banker på', 'amber', { knock: true });
    }
    if (bookedMinutes > 0 && Number.isFinite(start) && nowMs < start + bookedMinutes * MINUTE_MS) {
      return view('Fireflies gikk ut av møtet', 'Fireflies gikk ut', 'amber');
    }
  }
  const tone = recordingStateTone(state, { hasTranscript: entry.hasTranscript });
  return view(
    recordingStateLabel(state, { hasTranscript: entry.hasTranscript }),
    recordingStateShortLabel(state, { hasTranscript: entry.hasTranscript }),
    tone,
  );
}

export function liveRecordingLabel(entry: SalesLiveRecording, options: { nowMs?: number; bookedMinutes?: number } = {}) {
  return liveRecordingView(entry, options).label;
}

/** Still worth a fresh look: the bot is due, knocking or in the room, or its transcript is on the way. */
export function liveRecordingIsOpen(entry: SalesLiveRecording, nowMs = Date.now()) {
  const start = startMs(entry.startAt);
  if (Number.isFinite(start) && nowMs > start + LIVE_REFRESH_TAIL_MS) return false;
  if (entry.state === 'scheduled' || entry.state === 'dispatched' || entry.state === 'recording') return true;
  if (entry.state === 'ended' || entry.state === 'not-admitted') return !entry.hasTranscript;
  return false;
}

/**
 * Start times of the client's booked online slots, as the server collects them for liveRecordings (the sales
 * meeting, a workshop or iteration Møte, a recorded Møte action). Only used to start looking before the
 * server lists a slot, so it may say a little too much, never too little.
 */
export function bookedOnlineSlotStarts(client?: SalesClient | null): number[] {
  if (!client || typeof client !== 'object') return [];
  const out: number[] = [];
  const add = (iso: unknown, link: unknown, needsLink = true) => {
    const ms = startMs(String(iso || ''));
    if (Number.isFinite(ms) && (!needsLink || String(link || '').trim())) out.push(ms);
  };
  if (client.agreedTime && client.meetingMode === 'online') add(client.meetingAt, '', false);
  const workshop = getWorkshopAction(client) as { format?: string; dueAt?: string; meetLink?: string } | null;
  if (workshop && sanitizeWorkshopFormat(workshop.format) === 'mote') add(workshop.dueAt, workshop.meetLink);
  const iteration = client.workshop?.iterationMeeting;
  if (iteration && sanitizeWorkshopFormat(iteration.format) === 'mote') add(iteration.dueAt, iteration.meetLink);
  try {
    for (const action of recordedSalesActions(client, { includeDone: true }) as Array<{ dueAt?: string; meetLink?: string }>) {
      add(action.dueAt, action.meetLink);
    }
  } catch {
    // A malformed action list only costs the lead-in.
  }
  return out;
}

/** The 30-second refresh: an open live entry, or a booked online meeting about to get its first entry. */
export function clientNeedsLiveRefresh(client: SalesClient, nowMs = Date.now()) {
  const entries = liveRecordingsOf(client);
  if (entries.some((entry) => liveRecordingIsOpen(entry, nowMs))) return true;
  const listed = new Set(entries.map((entry) => startMs(entry.startAt)));
  return bookedOnlineSlotStarts(client).some((start) => (
    start > nowMs && start - nowMs <= LIVE_ENTRY_LEAD_MS && !listed.has(start)
  ));
}

function urgency(view: LiveRecordingView, state: string) {
  if (view.knock) return 0;
  if (view.tone === 'red') return 1;
  if (state === 'recording') return 2;
  if (view.tone === 'amber') return 3;
  if (state === 'scheduled') return 4;
  if (state === 'declined') return 6;
  return 5;
}

/** The card's order: a knock at the door first, a quiet finished meeting last, then by start. */
export function liveRecordingsByUrgency(client?: Pick<SalesClient, 'liveRecordings' | 'meetingDurationMinutes'> | null, nowMs = Date.now()) {
  const rank = (entry: SalesLiveRecording) => urgency(
    liveRecordingView(entry, { nowMs, bookedMinutes: liveRecordingBookedMinutes(entry, client) }),
    entry.state,
  );
  return [...liveRecordingsOf(client)].sort((a, b) => (
    rank(a) - rank(b) || (startMs(a.startAt) || 0) - (startMs(b.startAt) || 0)
  ));
}

/** The entry a compact card shows. */
export function mostUrgentLiveRecording(client?: Pick<SalesClient, 'liveRecordings' | 'meetingDurationMinutes'> | null, nowMs = Date.now()) {
  return liveRecordingsByUrgency(client, nowMs)[0] || null;
}

export type KnockingMeeting = { client: SalesClient; entry: SalesLiveRecording; view: LiveRecordingView };

/** Every meeting where the notetaker is at the door right now, across the clients on screen. */
export function knockingMeetings(clients: SalesClient[] = [], nowMs = Date.now()): KnockingMeeting[] {
  const out: KnockingMeeting[] = [];
  for (const client of Array.isArray(clients) ? clients : []) {
    for (const entry of liveRecordingsOf(client)) {
      const view = liveRecordingView(entry, { nowMs, bookedMinutes: liveRecordingBookedMinutes(entry, client) });
      if (view.knock) out.push({ client, entry, view });
    }
  }
  return out.sort((a, b) => (startMs(a.entry.startAt) || 0) - (startMs(b.entry.startAt) || 0));
}

function rowStart(row: SalesClientMeeting) {
  return startMs(row.startedAt || row.when || '') || startMs(row.linkedAt || '') || 0;
}

/** 'sales:<ms>' for the client's booked sales meeting, '' when none is booked. */
export function currentSalesSlotKey(client?: Pick<SalesClient, 'agreedTime' | 'meetingAt'> | null) {
  const start = startMs(String(client?.meetingAt || ''));
  return client?.agreedTime && Number.isFinite(start) ? `sales:${start}` : '';
}

export type SlotRecording = {
  state: FirefliesRecordingState;
  message: string;
  at: string;
  hasTranscript: boolean;
  /** Set for a live entry: what it means right now (labels that never promise an unplanned send). */
  view?: LiveRecordingView;
};

/**
 * The sales meeting's recording state: its live entry while near, else the placeholder row of the meeting
 * booked now. A placeholder of an earlier booking never speaks for a meeting that is still ahead.
 */
export function salesSlotRecording(client?: SalesClient | null, nowMs = Date.now()): SlotRecording | null {
  const live = liveRecordingsOf(client)
    .filter((entry) => entry.kind === 'sales')
    .sort((a, b) => (startMs(b.startAt) || 0) - (startMs(a.startAt) || 0))[0];
  if (live) {
    return {
      state: live.state,
      message: String(live.message || ''),
      at: live.state === 'scheduled' ? liveRecordingSendAt(live) : live.startAt,
      hasTranscript: Boolean(live.hasTranscript),
      view: liveRecordingView(live, { nowMs, bookedMinutes: liveRecordingBookedMinutes(live, client) }),
    };
  }
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const rows = meetings
    .filter((item) => isPlaceholderRow(item) && item.recording?.state && meetingRowKind(item) === 'sales')
    .sort((a, b) => rowStart(b) - rowStart(a));
  const currentKey = currentSalesSlotKey(client);
  const upcoming = Boolean(currentKey) && startMs(String(client?.meetingAt || '')) > nowMs;
  // A rebooked meeting that is still ahead has no placeholder of its own yet: an older one is history.
  const row = rows.find((item) => currentKey && item.slotKey === currentKey) || (upcoming ? null : rows[0]) || null;
  // Its real recording is in (pasted or found late): that recording is the answer, not the old state.
  if (!row?.recording || placeholderIsSuperseded(row, meetings)) return null;
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
  const slot = salesSlotRecording(client, nowMs);
  if (slot) {
    const label = slot.view?.label || recordingStateLabel(slot.state, { at: slot.at, hasTranscript: slot.hasTranscript });
    const tone = slot.view?.tone || recordingStateTone(slot.state, { hasTranscript: slot.hasTranscript });
    return { state: slot.state, tone, hasTranscript: slot.hasTranscript, text: label, detail: slot.message !== label ? slot.message : '' };
  }
  const real = salesRecordingWithTalk(client);
  if (real) return { state: '', tone: 'green' as RecordingTone, hasTranscript: true, text: 'Opptaket er koblet til kunden', detail: real.title || '' };
  if (client.meetingMode !== 'online') return { state: '', tone: 'muted' as RecordingTone, hasTranscript: false, text: 'Brukes ikke på fysiske møter', detail: '' };
  const start = startMs(client.meetingAt);
  if (client.agreedTime && Number.isFinite(start) && start > nowMs) {
    return hasMeetLink
      ? { state: '', tone: 'muted' as RecordingTone, hasTranscript: false, text: 'Sendes inn i Meet 3 minutter før start', detail: '' }
      : { state: '', tone: 'muted' as RecordingTone, hasTranscript: false, text: 'Ingen Meet-lenke ennå, så Fireflies kan ikke sendes inn', detail: '' };
  }
  return { state: '', tone: 'muted' as RecordingTone, hasTranscript: false, text: 'Ingen opptak koblet', detail: '' };
}

type MeetingRowLike = {
  meetingId?: string;
  placeholder?: boolean;
  duplicateOf?: string;
  hasTranscript?: boolean;
  slotKey?: string;
  recording?: { state?: string; ffMeetingId?: string } | null;
};

/**
 * A placeholder whose real recording with talk is linked (same slot, or the Fireflies id the hub saw for it).
 * Newer hubs leave such a placeholder out already; raw client rows (the offer pages) still carry it.
 */
export function placeholderIsSuperseded(row: MeetingRowLike | null | undefined, rows: MeetingRowLike[] = []) {
  if (!row || !isPlaceholderRow(row)) return false;
  const slotKey = String(row.slotKey || '');
  const ffMeetingId = String(row.recording?.ffMeetingId || '');
  if (!slotKey && !ffMeetingId) return false;
  return (Array.isArray(rows) ? rows : []).some((other) => (
    other
    && !isPlaceholderRow(other)
    && !isDuplicateRow(other)
    && Boolean(other.hasTranscript)
    && ((slotKey && String(other.slotKey || '') === slotKey) || (ffMeetingId && String(other.meetingId || '') === ffMeetingId))
  ));
}

/** The rows a meeting list shows: superseded placeholders out, duplicates only when asked for. */
export function visibleMeetingRows<T extends MeetingRowLike>(rows: T[] | null | undefined, { showDuplicates = false } = {}): T[] {
  const list: T[] = Array.isArray(rows) ? rows.filter((row) => Boolean(row)) : [];
  return list.filter((row) => !placeholderIsSuperseded(row, list) && (showDuplicates || !isDuplicateRow(row)));
}

/**
 * What to say next to a real recording without a transcript: an empty recording the hub already judged
 * (a placeholder marked "empty" points at it) is not "on the way".
 */
export function realRowWaitingNote(row: MeetingRowLike | null | undefined, rows: MeetingRowLike[] = []) {
  if (!row || isPlaceholderRow(row) || row.hasTranscript) return '';
  const id = String(row.meetingId || '');
  const empty = Boolean(id) && (Array.isArray(rows) ? rows : []).some((other) => (
    isPlaceholderRow(other) && other?.recording?.state === 'empty' && String(other.recording?.ffMeetingId || '') === id
  ));
  return empty ? 'tomt opptak' : 'venter på transkript';
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

/**
 * A client read in the background is older than the one on screen when a save landed while it was on the
 * way: every save stamps updatedAt, so the answer with the older stamp must not win.
 */
export function freshClientIsStale(current?: Pick<SalesClient, 'updatedAt'> | null, fresh?: Pick<SalesClient, 'updatedAt'> | null) {
  const shown = startMs(String(current?.updatedAt || ''));
  const read = startMs(String(fresh?.updatedAt || ''));
  return Number.isFinite(shown) && Number.isFinite(read) && read < shown;
}

/**
 * Patch a fresh client from a route into the one on screen, keeping what that route leaves out. A full
 * client (jsonSalesClient) replaces the card; a compact one (an offer route's) only overrides its own fields.
 */
export function mergeFreshClient(current: SalesClient, fresh: SalesClient): SalesClient {
  const full = ['progression', 'calendar', 'nextActions'].some((key) => Object.prototype.hasOwnProperty.call(fresh, key));
  const base = full ? fresh : { ...current, ...fresh };
  return {
    ...base,
    offerStatus: fresh.offerStatus ?? current.offerStatus,
    liveRecordings: Array.isArray(fresh.liveRecordings) ? fresh.liveRecordings : current.liveRecordings,
  };
}
