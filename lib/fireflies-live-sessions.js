/**
 * Live-join engine: get the Fireflies bot into every booked online meeting, check that it is really in the
 * room, keep it there, and say so.
 *
 * A session is one Meet room at one start time (sessionKeyFor in lib/fireflies-recording-state.js). Sessions
 * are rebuilt from booking facts on every tick (collectLiveSessions), never from e-mail or calendar stamps: a
 * missing confirmation or fred@ guest does not stop recording, a ticked "Møtet hatt" or a done action does not
 * stop it once the meeting's window has begun, and a new start time is a new session. Two slots on one room and
 * start are one session, so one bot and one call.
 *
 * addToLiveMeeting success only means "dispatched": the bot is an anonymous guest that someone in the room
 * has to let in, and Fireflies keeps no trace of a bot that was never admitted. So the planner
 * (planLiveSessionTick, pure) checks Fireflies active_meetings every tick from the first dispatch, sends again
 * on a fixed schedule while the bot has not been seen, once more if it drops out early, and once near the end
 * of its time. Every send goes through one account-wide limiter (3 per rolling 20 minutes), stored with the
 * sessions in fireflies-live-sessions.json.
 */
import { existsSync, readFileSync, renameSync } from 'fs';
import { getDataFilePath } from '../data/storage-path.js';
import { readJsonCached, updateJsonLocked } from '../data/atomic-json.js';
import { normalizeFirefliesMeetLink } from './fireflies-client-match.js';
import { clientCoveredPlaceholderIds } from './fireflies-cover.js';
import { firefliesKeyOwnerEmail } from './fireflies-key-owner.js';
import { TERMINAL_RECORDING_STATES, sessionKeyFor, slotKeyFor } from './fireflies-recording-state.js';
import { isSafeModeActive, safeModeAllows } from './safe-mode.js';
import { salesConfirmedMeetLink, salesInboxMeetLink } from './sales-calendar-owner.js';
import { ONLINE_CALENDAR_DURATION_MINUTES } from './sales-meeting-duration.js';
import { recordedSalesActions } from './sales-next-actions.js';
import {
  WORKSHOP_DURATION_MINUTES,
  getWorkshopAction,
  isRealWorkshopMeetLink,
  sanitizeWorkshopFormat,
} from './workshop-action-shared.js';

export const LIVE_SESSIONS_FILE = 'fireflies-live-sessions.json';
const STORE_PATH = getDataFilePath(LIVE_SESSIONS_FILE);

const MINUTE_MS = 60_000;
export const LIVE_JOIN_DEFAULT_BOOKED_MINUTES = 60;
/** First dispatch from 3 minutes before start (the first tick in that window). */
export const LIVE_JOIN_FIRST_LEAD_MS = 3 * MINUTE_MS;
/** First dispatches and retries stop 30 minutes after start. */
export const LIVE_JOIN_DISPATCH_UNTIL_MS = 30 * MINUTE_MS;
/** A dispatched bot is looked for until 30 minutes after the booked end. */
export const LIVE_JOIN_VERIFY_TAIL_MS = 30 * MINUTE_MS;
/** Automatic sends per session; a rep's own "send again" is not counted. */
export const LIVE_JOIN_MAX_ATTEMPTS = 5;
/** Account-wide addToLiveMeeting budget: 3 calls per rolling 20 minutes. */
export const LIVE_JOIN_LIMIT = 3;
export const LIVE_JOIN_LIMIT_WINDOW_MS = 20 * MINUTE_MS;
/** Same cap as FIREFLIES_LIVE_JOIN_DURATION_MINUTES in lib/fireflies-webhook.js (documented maximum). */
export const LIVE_JOIN_MAX_DURATION_MINUTES = 120;
export const LIVE_JOIN_MIN_DURATION_MINUTES = 15;
/** The card shows a session from 30 minutes before start until 2 hours after the booked end. */
export const LIVE_RECORDINGS_LEAD_MS = 30 * MINUTE_MS;
export const LIVE_RECORDINGS_TAIL_MS = 2 * 60 * MINUTE_MS;
/** Track D opens the Meet room once, when the session first comes within 30 minutes of start. */
export const LIVE_JOIN_MEET_ROOM_LEAD_MS = 30 * MINUTE_MS;

// Fireflies waits up to 10 minutes in a Meet lobby before it gives up.
const LOBBY_WAIT_MS = 10 * MINUTE_MS;
// One missed check is not "left": wait this long after the last sighting.
const GONE_GRACE_MS = 2 * MINUTE_MS;
// No rejoin in the last 10 minutes of the booked time (after the first-send window).
const REJOIN_CUTOFF_MS = 10 * MINUTE_MS;
// A bot that left sooner than this after it came in did not sit alone for the lobby wait: someone took it out.
const SAT_ALONE_MS = LOBBY_WAIT_MS - GONE_GRACE_MS;
// Continuation: within 3 minutes of the bot's end time, while now < start + booked + 60.
const CONTINUATION_LEAD_MS = 3 * MINUTE_MS;
const CONTINUATION_TAIL_MS = 60 * MINUTE_MS;
// A bot still in the room is followed until booked end + 60 (or its own end time), never past start + 4 h.
const RECORDING_TAIL_MS = 60 * MINUTE_MS;
const MAX_FOLLOW_MS = 4 * 60 * MINUTE_MS;
// One-bot plans only: the bot leaves one minute before the next meeting's first dispatch.
const NEXT_MEETING_GAP_MS = LIVE_JOIN_FIRST_LEAD_MS + MINUTE_MS;
const MANUAL_REQUEST_TTL_MS = 30 * MINUTE_MS;
// A retry waits for a look at the room, but not forever when Fireflies' active_meetings keeps failing.
const BLIND_RETRY_AFTER_MS = 5 * MINUTE_MS;
// One knock per room at a time: two bots from one account in one room collapse into a fragment.
const ROOM_KNOCK_SPACING_MS = 4 * MINUTE_MS;
// A tick kicked by a card save reuses a look this fresh unless it may send.
const LOOK_MIN_INTERVAL_MS = 45_000;
// A bot that started this long before the booked start was sent for an earlier meeting in the room (one that ran
// over): it may record this meeting too, but its recording is that meeting's. The watchdog's room window starts
// at the same point.
const OWN_BOT_LEAD_MS = 30 * MINUTE_MS;
const RESEND_LEAD_MS = 15 * MINUTE_MS;
const RESEND_TAIL_MS = 60 * MINUTE_MS;
// Sessions are collected from 48 hours back to 36 hours ahead and kept a week for intake and the card. 48 hours
// is the watchdog's watch: a meeting the hub was down through (or one before this hub ran) still gets its
// placeholder and is reported. Past the first-send window nothing is sent for it.
const COLLECT_PAST_MS = 48 * 60 * MINUTE_MS;
const COLLECT_AHEAD_MS = 36 * 60 * MINUTE_MS;
const KEEP_SESSIONS_MS = 7 * 24 * 60 * MINUTE_MS;
const KEEP_CALLS_MS = 2 * 60 * MINUTE_MS;
const MAX_STORED_ATTEMPTS = 20;
const MAX_BLOCK_MS = 30 * MINUTE_MS;
const WATCHDOG_MS = 2 * MINUTE_MS;

const KIND_RANK = { manual: 0, rejoin: 1, retry: 2, continuation: 3 };
const ATTEMPT_KINDS = new Set(['first', 'retry', 'rejoin', 'continuation', 'manual']);
const SESSION_STATES = new Set(['scheduled', 'dispatched', 'recording', 'ended', 'not-admitted']);
// Why a wanted send did not go out (the last time one was due): kept for the "never sent" copy.
const UNSENT_REASONS = new Set(['no-api-key', 'safe-mode', 'rate-limited', 'failed']);
const UNSENT_BY_OUTCOME = {
  'no-api-key': 'no-api-key',
  'safe-mode': 'safe-mode',
  limit: 'rate-limited',
  'rate-limited': 'rate-limited',
  failed: 'failed',
};
const UNSENT_BY_DEFERRAL = { blocked: 'rate-limited', limit: 'rate-limited', reserved: 'rate-limited' };

/** Card copy (Norwegian, like the rest of the sales card). */
export const LIVE_JOIN_MESSAGES = Object.freeze({
  scheduled: 'Fireflies sendes inn i Meet 3 minutter før start.',
  dispatched: 'Fireflies er sendt inn i Meet. Slipp inn «Fireflies.ai Notetaker» når den banker på.',
  waiting: 'Fireflies er ikke i møtet ennå. Den sendes inn på nytt – slipp den inn fra lobbyen i Meet.',
  recording: 'Fireflies er i møtet og tar opp.',
  earlierBot: 'Fireflies fra møtet før i samme Meet-rom er fortsatt der og tar opp. Det opptaket kobles ikke til denne kunden av seg selv.',
  continuation: 'Fireflies er snart ute av tid og er sendt inn på nytt for å fortsette opptaket. Slipp inn «Fireflies.ai Notetaker» når den banker på.',
  ended: 'Fireflies har gått ut av møtet. Transkriptet kommer når opptaket er ferdig behandlet.',
  dropped: 'Fireflies gikk ut av møtet før tiden. Den sendes inn én gang til i tilfelle møtet fortsatt pågår. Vil ikke kunden bli tatt opp, marker møtet uten opptak.',
  rejoined: 'Fireflies gikk ut av møtet før tiden og er sendt inn én gang til. Er dere fortsatt i møtet, slipp den inn fra lobbyen. Vil ikke kunden bli tatt opp, marker møtet uten opptak.',
  notAdmitted: 'Fireflies ble ikke sluppet inn i møtet, så det blir trolig ikke noe opptak. Skriv notater fra møtet.',
  notChecked: 'Fireflies ble sendt inn, men Asoldi fikk ikke sjekket om den kom inn i møtet. Kommer det ikke noe opptak, skriv notater fra møtet.',
  neverSent: 'Fireflies ble aldri sendt inn i møtet, så det blir trolig ikke noe opptak. Skriv notater fra møtet.',
  neverSentNoKey: 'Fireflies ble aldri sendt inn i møtet fordi Fireflies-nøkkelen mangler på serveren. Det blir trolig ikke noe opptak – skriv notater fra møtet.',
  neverSentLimited: 'Fireflies ble aldri sendt inn i møtet fordi grensen på 3 innsendinger per 20 minutter var nådd. Det blir trolig ikke noe opptak – skriv notater fra møtet.',
  neverSentSafeMode: 'Fireflies ble aldri sendt inn i møtet fordi live-join var av på huben (safe mode). Det blir trolig ikke noe opptak – skriv notater fra møtet.',
  failed: 'Fireflies tok ikke imot forespørselen',
  limited: 'Fireflies har nådd grensen på 3 innsendinger per 20 minutter. Neste forsøk går så snart det er lov.',
  manual: 'Fireflies sendes inn på nytt nå.',
  safeMode: 'Live-join er av på denne huben (safe mode), så Fireflies sendes ikke inn herfra.',
  noApiKey: 'Fireflies-nøkkelen mangler på serveren, så Fireflies kan ikke sendes inn.',
});

function text(value = '') {
  return String(value ?? '').trim();
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function isoOrEmpty(value = '') {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function msOf(value = '') {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? ms : NaN;
}

function linkOf(session = {}) {
  return normalizeFirefliesMeetLink(session.meetLink);
}

function timesOf(session = {}) {
  const startMs = msOf(session.startAt);
  const minutes = Number(session.bookedMinutes) > 0 ? Number(session.bookedMinutes) : LIVE_JOIN_DEFAULT_BOOKED_MINUTES;
  const bookedMs = minutes * MINUTE_MS;
  return { startMs, bookedMs, endMs: startMs + bookedMs };
}

// ── facts → sessions ─────────────────────────────────────────────────────────

/** "Business · Contact", the title Fireflies files the recording under. */
export function liveJoinTitleForClient(client = {}) {
  return [text(client?.businessName), text(client?.contactPerson)].filter(Boolean).join(' · ') || 'Asoldi møte';
}

/** Same id as data/sales.js liveJoinMeetingId: the client.meetings placeholder of one slot. */
export function liveJoinStubMeetingId(scopeId = '', startAt = '') {
  const when = Date.parse(startAt);
  return `live:${text(scopeId)}:${Number.isFinite(when) ? when : 'open'}`;
}

function isOnline(mode = '') {
  const raw = text(mode).toLowerCase();
  return !['in-person', 'in_person', 'inperson', 'physical', 'fysisk', 'irl'].includes(raw);
}

/**
 * A ticked "held" or "done" stops only a meeting that has not begun: inside its own window it is still joined,
 * and afterwards it is still the booking its placeholder and the missing-recording watch follow (a hub that was
 * down through the meeting writes that placeholder later). Past the window no send goes out anyway.
 */
function begunDespiteDone(startAt, nowMs) {
  const startMs = msOf(startAt);
  return Number.isFinite(startMs) && nowMs >= startMs - LIVE_RECORDINGS_LEAD_MS;
}

function workshopWasBooked(action = {}) {
  return text(action.status) === 'confirmed' || Boolean(text(action.calendarEventId));
}

function iterationWasBooked(meeting = {}) {
  return Boolean(text(meeting.confirmationSentAt) || text(meeting.sentAt) || text(meeting.calendarEventId));
}

/**
 * A dispatch Fireflies accepted for this slot before the session store knew the session (an older hub, or a
 * store that was lost): the slot's live-join stamp in this room, or its placeholder row, inside the window a
 * send for this start could have gone out. A new session starts from it instead of "never sent".
 */
function legacyDispatchFor(slot = {}, stamp = {}, row = null) {
  const startMs = msOf(slot.startAt);
  const inWindow = (ms) => Number.isFinite(ms) && ms >= startMs - RESEND_LEAD_MS
    && ms <= startMs + slot.bookedMinutes * MINUTE_MS + RESEND_TAIL_MS;
  const joined = normalizeFirefliesMeetLink(stamp?.firefliesLiveJoinedMeetLink);
  const stampMs = msOf(stamp?.firefliesLiveJoinedAt);
  const fromStamp = inWindow(stampMs) && (!joined || joined === normalizeFirefliesMeetLink(slot.meetLink)) ? stampMs : NaN;
  const rowMs = msOf(row?.liveJoinedAt);
  const fromRow = inWindow(rowMs) ? rowMs : NaN;
  const at = [fromRow, fromStamp].filter(Number.isFinite).sort((a, b) => a - b)[0];
  return {
    legacyDispatchedAt: Number.isFinite(at) ? iso(at) : '',
    // The placeholder exists, or existed and was dropped once the real recording was linked.
    placeholderKnown: Boolean(row) || Number.isFinite(fromStamp),
  };
}

/**
 * Every booked online slot of one client that the bot should join, with its room and start. `anyTime` drops the
 * collect horizon (48 hours back, 36 ahead), for a rep who marks a slot further out.
 */
export function bookedLiveSlots(client = {}, nowMs = Date.now(), { anyTime = false } = {}) {
  const clientId = text(client?.id);
  if (!clientId) return [];
  const base = liveJoinTitleForClient(client);
  const meetings = Array.isArray(client.meetings) ? client.meetings : [];
  const out = [];
  const push = (slot, stamp = {}) => {
    const startMs = msOf(slot.startAt);
    if (!Number.isFinite(startMs)) return;
    if (!anyTime && (startMs < nowMs - COLLECT_PAST_MS || startMs > nowMs + COLLECT_AHEAD_MS)) return;
    if (!isRealWorkshopMeetLink(slot.meetLink)) return;
    const slotKey = slotKeyFor(slot.kind, { startAt: slot.startAt, actionId: slot.actionId });
    if (!slotKey) return;
    const row = meetings.find((item) => text(item?.meetingId) === slot.stubMeetingId) || null;
    out.push({ ...slot, ...legacyDispatchFor(slot, stamp, row), clientId, slotKey, startAt: new Date(startMs).toISOString() });
  };

  // The booked sales meeting, in the room the client was e-mailed.
  if (client.agreedTime && isOnline(client.meetingMode)) {
    const booked = Number(client.meetingDurationMinutes) || ONLINE_CALENDAR_DURATION_MINUTES;
    if (!client.progression?.meetingHeld || begunDespiteDone(client.meetingAt, nowMs)) {
      push({
        kind: 'sales',
        startAt: text(client.meetingAt),
        meetLink: salesInboxMeetLink(client) || salesConfirmedMeetLink(client.calendar) || text(client.calendar?.meetLink),
        bookedMinutes: booked,
        title: base,
        purpose: 'sales',
        confirmed: Boolean(text(client.reminders?.thankYouSentAt) || text(client.calendar?.firefliesInvitedAt)),
        stubMeetingId: liveJoinStubMeetingId(clientId, client.meetingAt),
      }, client.calendar);
    }
  }

  const workshop = getWorkshopAction(client);
  if (workshop && sanitizeWorkshopFormat(workshop.format) === 'mote' && workshopWasBooked(workshop)) {
    push({
      kind: 'workshop',
      startAt: workshop.dueAt,
      meetLink: workshop.meetLink,
      bookedMinutes: WORKSHOP_DURATION_MINUTES,
      title: `${base} · Workshop`,
      purpose: 'workshop',
      confirmed: workshop.status === 'confirmed',
      stubMeetingId: liveJoinStubMeetingId(`${clientId}:workshop`, workshop.dueAt),
    }, workshop);
  }

  const iteration = client.workshop?.iterationMeeting;
  if (iteration && sanitizeWorkshopFormat(iteration.format) === 'mote' && iterationWasBooked(iteration)) {
    push({
      kind: 'iteration',
      startAt: text(iteration.dueAt),
      meetLink: text(iteration.meetLink),
      bookedMinutes: WORKSHOP_DURATION_MINUTES,
      title: `${base} · Iterasjon`,
      purpose: 'iteration',
      confirmed: Boolean(text(iteration.confirmationSentAt) || text(iteration.sentAt)),
      stubMeetingId: liveJoinStubMeetingId(`${clientId}:iteration`, iteration.dueAt),
    }, iteration);
  }

  for (const action of recordedSalesActions(client, { includeDone: true })) {
    if (text(action.doneAt) && !begunDespiteDone(action.dueAt, nowMs)) continue;
    push({
      kind: 'action',
      actionId: text(action.id),
      startAt: text(action.dueAt),
      meetLink: text(action.meetLink),
      bookedMinutes: ONLINE_CALENDAR_DURATION_MINUTES,
      title: `${base} · ${text(action.name) || 'Møte'}`,
      purpose: text(action.goalKey) === 'meetingHeld' ? 'sales' : '',
      // The rep's own Møte: booked once it is in the rep's calendar (the client is never a guest on it).
      confirmed: Boolean(text(action.calendarEventId)),
      stubMeetingId: liveJoinStubMeetingId(`${clientId}:${text(action.id)}`, action.dueAt),
    }, action);
  }
  return out;
}

const brokenClientsLogged = new Set();

/** bookedLiveSlots, but one malformed client record is logged once and skipped instead of stopping every bot. */
function safeBookedLiveSlots(client, nowMs) {
  try {
    return bookedLiveSlots(client, nowMs);
  } catch (error) {
    const signature = `${text(client?.id)}|${text(error?.message)}`;
    if (!brokenClientsLogged.has(signature)) {
      brokenClientsLogged.add(signature);
      console.warn(`[fireflies] live-join skipped client id=${text(client?.id) || '-'}: ${text(error?.message) || error}`);
    }
    return [];
  }
}

function slotEntry(slot = {}) {
  return {
    clientId: text(slot.clientId),
    kind: text(slot.kind),
    ...(text(slot.actionId) ? { actionId: text(slot.actionId) } : {}),
    slotKey: text(slot.slotKey),
    stubMeetingId: text(slot.stubMeetingId),
    purpose: text(slot.purpose),
  };
}

/**
 * Sessions from booking facts: online sales meetings, workshop and iteration Møter, recorded Møte actions,
 * each with a real Meet link and a start in the collect horizon. One session per room and start.
 */
export function collectLiveSessions(clients = [], nowMs = Date.now()) {
  const byKey = new Map();
  for (const client of Array.isArray(clients) ? clients : []) {
    for (const slot of safeBookedLiveSlots(client, nowMs)) {
      const key = sessionKeyFor(slot.meetLink, slot.startAt);
      if (!key) continue;
      const entry = slotEntry(slot);
      const placeholderIds = slot.placeholderKnown ? [entry.stubMeetingId] : [];
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          key,
          meetLink: text(slot.meetLink),
          startAt: slot.startAt,
          bookedMinutes: slot.bookedMinutes,
          title: slot.title,
          confirmed: Boolean(slot.confirmed),
          legacyDispatchedAt: slot.legacyDispatchedAt || '',
          placeholderIds,
          slots: [entry],
        });
        continue;
      }
      if (existing.slots.some((row) => row.clientId === entry.clientId && row.slotKey === entry.slotKey)) continue;
      existing.slots.push(entry);
      existing.bookedMinutes = Math.max(existing.bookedMinutes, slot.bookedMinutes);
      existing.confirmed = existing.confirmed || Boolean(slot.confirmed);
      existing.placeholderIds.push(...placeholderIds);
      if (slot.legacyDispatchedAt && (!existing.legacyDispatchedAt || slot.legacyDispatchedAt < existing.legacyDispatchedAt)) {
        existing.legacyDispatchedAt = slot.legacyDispatchedAt;
      }
      // The sales meeting names a shared room.
      if (entry.kind === 'sales' && existing.slots[0].kind !== 'sales') existing.title = slot.title;
    }
  }
  return [...byKey.values()].sort((a, b) => msOf(a.startAt) - msOf(b.startAt) || a.key.localeCompare(b.key));
}

// ── sessions and the store ───────────────────────────────────────────────────

function normalizeAttempt(raw = {}) {
  const at = isoOrEmpty(raw?.at);
  if (!at) return null;
  const kind = ATTEMPT_KINDS.has(text(raw.kind)) ? text(raw.kind) : 'retry';
  return {
    at,
    ok: raw.ok === true,
    message: text(raw.message).slice(0, 300),
    kind,
    ...(Number(raw.durationMinutes) > 0 ? { durationMinutes: Math.round(Number(raw.durationMinutes)) } : {}),
    ...(raw.uncertain === true ? { uncertain: true } : {}),
    ...(raw.rateLimited === true ? { rateLimited: true } : {}),
  };
}

export function normalizeLiveSession(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const key = text(raw.key);
  const meetLink = text(raw.meetLink);
  const startAt = isoOrEmpty(raw.startAt);
  if (!key || !meetLink || !startAt) return null;
  const attempts = (Array.isArray(raw.attempts) ? raw.attempts : []).map(normalizeAttempt).filter(Boolean)
    .slice(-MAX_STORED_ATTEMPTS);
  const slots = (Array.isArray(raw.slots) ? raw.slots : []).map(slotEntry).filter((slot) => slot.clientId && slot.slotKey);
  const ids = [...new Set((Array.isArray(raw.ffMeetingIds) ? raw.ffMeetingIds : []).map(text).filter(Boolean))].slice(-10);
  const placeholderIds = [...new Set((Array.isArray(raw.placeholderIds) ? raw.placeholderIds : []).map(text).filter(Boolean))].slice(-10);
  return {
    key,
    meetLink,
    startAt,
    bookedMinutes: Number(raw.bookedMinutes) > 0 ? Math.round(Number(raw.bookedMinutes)) : LIVE_JOIN_DEFAULT_BOOKED_MINUTES,
    title: text(raw.title).slice(0, 256),
    slots,
    // The client was e-mailed the room (or it is the rep's own booked Møte): ranks first when sends compete.
    confirmed: raw.confirmed === true,
    // Placeholder rows written for this session (or found from an older hub): never written a second time.
    placeholderIds,
    state: SESSION_STATES.has(text(raw.state)) ? text(raw.state) : 'scheduled',
    message: text(raw.message).slice(0, 300),
    attempts,
    dispatchedAt: isoOrEmpty(raw.dispatchedAt),
    lastDispatchedAt: isoOrEmpty(raw.lastDispatchedAt),
    firstSeenActiveAt: isoOrEmpty(raw.firstSeenActiveAt),
    lastSeenActiveAt: isoOrEmpty(raw.lastSeenActiveAt),
    checkedAt: isoOrEmpty(raw.checkedAt),
    ffMeetingId: text(raw.ffMeetingId),
    ffMeetingIds: ids,
    ffEndTime: isoOrEmpty(raw.ffEndTime),
    // When the bot behind ffMeetingId started ('' unknown): an earlier meeting's bot is not this one's recording.
    ffStartTime: isoOrEmpty(raw.ffStartTime),
    endedAt: isoOrEmpty(raw.endedAt),
    nextAttemptAt: isoOrEmpty(raw.nextAttemptAt),
    manualRequestedAt: isoOrEmpty(raw.manualRequestedAt),
    meetRoomRequestedAt: isoOrEmpty(raw.meetRoomRequestedAt),
    // Set under the store lock while an addToLiveMeeting call is out, so a second sender stands back.
    dispatchingAt: isoOrEmpty(raw.dispatchingAt),
    transcriptSeenAt: isoOrEmpty(raw.transcriptSeenAt),
    declinedAt: isoOrEmpty(raw.declinedAt),
    permanentError: text(raw.permanentError).slice(0, 300),
    unsentReason: UNSENT_REASONS.has(text(raw.unsentReason)) ? text(raw.unsentReason) : '',
    // The rep was told the bot is knocking (lib/fireflies-live-alerts.js): claimed before the send, once per
    // knock; lobbyAlertKnockAt is the `at` of the knock the last one was about.
    lobbyAlertAt: isoOrEmpty(raw.lobbyAlertAt),
    lobbyAlertKnockAt: isoOrEmpty(raw.lobbyAlertKnockAt),
    lobbyAlertFailedAt: isoOrEmpty(raw.lobbyAlertFailedAt),
    detachedAt: isoOrEmpty(raw.detachedAt),
    createdAt: isoOrEmpty(raw.createdAt),
    updatedAt: isoOrEmpty(raw.updatedAt),
  };
}

function newSessionFromFact(fact = {}, at = '') {
  const legacy = isoOrEmpty(fact.legacyDispatchedAt);
  // A send an older hub (or a lost store) already made is verified and followed up, not reported as never sent.
  const seeded = legacy
    ? {
      state: 'dispatched',
      message: LIVE_JOIN_MESSAGES.dispatched,
      attempts: [{ at: legacy, ok: true, kind: 'first', message: 'Sendt inn før live-join-økten fantes.' }],
      dispatchedAt: legacy,
      lastDispatchedAt: legacy,
    }
    : { state: 'scheduled', message: LIVE_JOIN_MESSAGES.scheduled, attempts: [] };
  return normalizeLiveSession({
    ...fact,
    ...seeded,
    createdAt: at,
    updatedAt: at,
  });
}

function normalizeLimiter(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const calls = (Array.isArray(input.calls) ? input.calls : [])
    .map((call) => ({ at: isoOrEmpty(call?.at), key: text(call?.key), kind: text(call?.kind) }))
    .filter((call) => call.at)
    .sort((a, b) => msOf(a.at) - msOf(b.at));
  return {
    calls,
    blockedUntil: isoOrEmpty(input.blockedUntil),
    blockedReason: text(input.blockedReason).slice(0, 200),
  };
}

function emptyStore() {
  return { version: 1, sessions: {}, limiter: normalizeLimiter({}), updatedAt: '' };
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;
  const sessions = raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions) ? raw.sessions : {};
  for (const [key, value] of Object.entries(sessions)) {
    const session = normalizeLiveSession({ ...(value || {}), key: text(value?.key) || key });
    if (session) store.sessions[session.key] = session;
  }
  store.limiter = normalizeLimiter(raw.limiter);
  store.updatedAt = isoOrEmpty(raw.updatedAt);
  return store;
}

// readJsonCached hands back the same object until the file changes, so one normalization serves every
// card in a list. Callers treat the result as read-only.
let normalizedCache = { raw: undefined, store: null };

/** The stored sessions and limiter (cached by mtime; a missing or corrupt file reads as empty). Read-only. */
export function readLiveSessionStore() {
  const raw = readJsonCached(STORE_PATH);
  if (normalizedCache.store && normalizedCache.raw === raw) return normalizedCache.store;
  const store = normalizeStore(raw);
  normalizedCache = { raw, store };
  return store;
}

/** A file that exists but does not parse is moved aside (kept for a look) before a new one is written. */
function setAsideCorruptStore() {
  try {
    if (!existsSync(STORE_PATH)) return;
    const raw = readFileSync(STORE_PATH, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return;
    } catch {
      // not JSON: set aside below
    }
    renameSync(STORE_PATH, `${STORE_PATH}.corrupt-${Date.now()}`);
    console.warn(`[fireflies] ${LIVE_SESSIONS_FILE} was not valid JSON; kept it aside and started a new one`);
  } catch {
    // best effort: the write below still replaces it
  }
}

function pruneCalls(limiter, nowMs) {
  return {
    ...limiter,
    calls: limiter.calls.filter((call) => nowMs - msOf(call.at) < KEEP_CALLS_MS),
    blockedUntil: msOf(limiter.blockedUntil) > nowMs ? limiter.blockedUntil : '',
    blockedReason: msOf(limiter.blockedUntil) > nowMs ? limiter.blockedReason : '',
  };
}

/**
 * Locked read-modify-write of the whole store on fresh data, so a writer elsewhere (a route, another
 * process) is never lost. `mutate(store)` returns the next store, or undefined to leave the file alone.
 * Returns the store as written (or as read when nothing was written).
 */
export function updateLiveSessionStore(mutate, { nowMs = Date.now() } = {}) {
  let result = null;
  const written = updateJsonLocked(STORE_PATH, (current) => {
    if (current === null) setAsideCorruptStore();
    const store = normalizeStore(current);
    const next = mutate(store);
    if (next === undefined) {
      result = store;
      return undefined;
    }
    const sessions = {};
    for (const session of Object.values(next.sessions || {})) {
      const normalized = normalizeLiveSession(session);
      if (normalized) sessions[normalized.key] = normalized;
    }
    result = {
      version: 1,
      sessions,
      limiter: pruneCalls(normalizeLimiter(next.limiter), nowMs),
      updatedAt: new Date(nowMs).toISOString(),
    };
    return result;
  });
  return result || normalizeStore(written);
}

function mergeSlots(existing = [], incoming = [], clientIds = new Set()) {
  const kept = existing.filter((slot) => !clientIds.has(slot.clientId));
  return [...kept, ...incoming];
}

/**
 * The placeholder this session's slot has on the client's card, or the row capture would write for it
 * (server.js writeLivePlaceholder), so a session with no row yet is judged by the same rule.
 */
function slotPlaceholder(client, session, slot) {
  return slotRow(client, slot) || {
    meetingId: text(slot.stubMeetingId) || liveJoinStubMeetingId(text(slot.clientId), session.startAt),
    startedAt: text(session.startAt),
    meetLink: text(session.meetLink),
    hasTranscript: false,
    linkedBy: 'live-join',
    forSalesMeeting: text(slot.kind) === 'sales',
    purpose: text(slot.purpose),
    slotKey: text(slot.slotKey),
    recording: recordingForLiveSession(session),
  };
}

/**
 * True when the client already has the real recording of this session linked: one that covers the slot's
 * placeholder by the card's rule (lib/fireflies-cover.js), so talk that is not live captions and more than a
 * fragment, in this room and session, by this meeting's own bot, or put on the slot by a person. A "hallo?"
 * from a bot that sat alone in an open room, or live captions linked while the meeting runs, are not the
 * recording: the bot is still sent back and the placeholder is still followed. `storedOf` is for tests.
 */
export function clientHasTranscriptForSession(client = {}, session = {}, { storedOf } = {}) {
  const clientId = text(client?.id);
  const slots = (Array.isArray(session?.slots) ? session.slots : []).filter((slot) => text(slot?.clientId) === clientId);
  if (!clientId || !slots.length) return false;
  const rows = Array.isArray(client?.meetings) ? client.meetings : [];
  const stubs = slots.map((slot) => slotPlaceholder(client, session, slot));
  const meetings = [...rows, ...stubs.filter((stub) => !rows.includes(stub))];
  const covered = clientCoveredPlaceholderIds({ ...client, meetings }, storedOf ? { storedOf } : {});
  return stubs.some((stub) => covered.has(text(stub.meetingId)));
}

function annotateFromClients(sessions, clients, at, nowMs) {
  const byId = new Map((Array.isArray(clients) ? clients : []).map((client) => [text(client?.id), client]));
  for (const session of Object.values(sessions)) {
    if (nowMs - msOf(session.startAt) > 24 * 60 * MINUTE_MS) continue;
    for (const slot of session.slots) {
      const client = byId.get(slot.clientId);
      if (!client) continue;
      if (!session.transcriptSeenAt && clientHasTranscriptForSession(client, session)) session.transcriptSeenAt = at;
      const row = (client.meetings || []).find((item) => text(item?.meetingId) === slot.stubMeetingId);
      // A rep who marked the meeting "held without recording" stops every automatic send.
      if (!session.declinedAt && text(row?.recording?.state) === 'declined') session.declinedAt = at;
    }
  }
}

/**
 * Merge collected sessions into the stored ones. `full` (the tick, all clients) also detaches sessions that
 * are no longer booked: never-touched ones are dropped, others are kept and only watched to the end.
 * A partial merge (one client's save) never detaches anything.
 */
export function syncLiveSessions(current = {}, collected = [], { nowMs = Date.now(), full = true, clients = null } = {}) {
  const at = new Date(nowMs).toISOString();
  const sessions = {};
  for (const [key, value] of Object.entries(current || {})) {
    const session = normalizeLiveSession({ ...value, key: value?.key || key });
    if (session) sessions[session.key] = session;
  }
  const seen = new Set();
  for (const fact of Array.isArray(collected) ? collected : []) {
    seen.add(fact.key);
    const existing = sessions[fact.key];
    if (!existing) {
      const created = newSessionFromFact(fact, at);
      if (created) sessions[created.key] = created;
      continue;
    }
    const clientIds = new Set(fact.slots.map((slot) => slot.clientId));
    sessions[fact.key] = {
      ...existing,
      meetLink: fact.meetLink,
      startAt: fact.startAt,
      bookedMinutes: fact.bookedMinutes,
      title: fact.title,
      confirmed: full ? Boolean(fact.confirmed) : existing.confirmed || Boolean(fact.confirmed),
      slots: full ? fact.slots.map(slotEntry) : mergeSlots(existing.slots, fact.slots.map(slotEntry), clientIds),
      detachedAt: '',
    };
  }
  if (full) {
    for (const [key, session] of Object.entries(sessions)) {
      if (seen.has(key)) continue;
      if (nowMs - msOf(session.startAt) > KEEP_SESSIONS_MS) {
        delete sessions[key];
        continue;
      }
      // A session that wrote a placeholder is kept, so the row is never written a second time.
      const touched = session.attempts.length || session.firstSeenActiveAt || session.manualRequestedAt
        || session.placeholderIds.length;
      if (!touched) {
        delete sessions[key];
        continue;
      }
      if (!session.detachedAt) sessions[key] = { ...session, detachedAt: at };
    }
  }
  if (clients) annotateFromClients(sessions, clients, at, nowMs);
  return sessions;
}

function sameSessions(a = {}, b = {}) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A request handler saved this client: record its bookings now; the next tick decides and sends. */
export function upsertLiveSessionsForClient(client = {}, { nowMs = Date.now() } = {}) {
  const collected = collectLiveSessions([client], nowMs);
  if (!collected.length) return [];
  updateLiveSessionStore((store) => {
    const sessions = syncLiveSessions(store.sessions, collected, { nowMs, full: false });
    if (sameSessions(sessions, store.sessions)) return undefined;
    return { ...store, sessions };
  }, { nowMs });
  return collected.map((session) => session.key);
}

// ── limiter ──────────────────────────────────────────────────────────────────

function callsInWindow(limiter, nowMs) {
  return normalizeLimiter(limiter).calls.filter((call) => {
    const at = msOf(call.at);
    return at <= nowMs && nowMs - at < LIVE_JOIN_LIMIT_WINDOW_MS;
  });
}

function limiterBlockedUntilMs(limiter, nowMs) {
  const until = msOf(normalizeLimiter(limiter).blockedUntil);
  return Number.isFinite(until) && until > nowMs ? until : 0;
}

function effectiveAttempts(session = {}) {
  // A call Fireflies refused for the rate limit sent no bot, so it does not move the schedule.
  return (session.attempts || []).filter((attempt) => !attempt.rateLimited);
}

function firstDispatchDueMs(session = {}) {
  return timesOf(session).startMs - LIVE_JOIN_FIRST_LEAD_MS;
}

function firstDispatchPending(session = {}) {
  return !session.detachedAt && !session.declinedAt && !session.firstSeenActiveAt && !effectiveAttempts(session).length;
}

/** Never-sent sessions whose first dispatch falls in (now, now + 20 min]: their sends are reserved. */
function upcomingFirstDispatches(sessions = [], nowMs) {
  return sessions.filter((session) => {
    if (!firstDispatchPending(session)) return false;
    const due = firstDispatchDueMs(session);
    return due > nowMs && due <= nowMs + LIVE_JOIN_LIMIT_WINDOW_MS;
  }).length;
}

/**
 * When the next retry, rejoin, continuation or manual send may go out: after a rate-limit block, and once the
 * calls in the window plus the reserved first dispatches leave room. '' when only reserved first dispatches
 * may go next.
 */
export function liveJoinNextAllowedAt(limiter, nowMs = Date.now(), { reserve = 0 } = {}) {
  let at = Math.max(nowMs, limiterBlockedUntilMs(limiter, nowMs));
  const allowed = LIVE_JOIN_LIMIT - 1 - Math.max(0, reserve);
  if (allowed < 0) return '';
  const calls = callsInWindow(limiter, nowMs).map((call) => msOf(call.at)).sort((a, b) => a - b);
  const excess = calls.length - allowed;
  if (excess > 0) at = Math.max(at, calls[excess - 1] + LIVE_JOIN_LIMIT_WINDOW_MS);
  return new Date(at).toISOString();
}

/** Record one addToLiveMeeting call (made from any path) in the account-wide limiter. */
export function recordLiveJoinCall(limiter, { key = '', kind = '', nowMs = Date.now() } = {}) {
  const next = normalizeLimiter(limiter);
  next.calls = [...next.calls, { at: new Date(nowMs).toISOString(), key: text(key), kind: text(kind) }];
  return next;
}

/** A rate-limit answer blocks every send until its retry-after, or 20 minutes after the oldest call in the window. */
export function blockLiveJoinLimiter(limiter, { nowMs = Date.now(), retryAfterMs = 0, reason = '' } = {}) {
  const next = normalizeLimiter(limiter);
  let until;
  if (Number(retryAfterMs) > 0) {
    until = nowMs + Number(retryAfterMs);
  } else {
    const oldest = callsInWindow(next, nowMs).map((call) => msOf(call.at)).sort((a, b) => a - b)[0];
    until = Number.isFinite(oldest) ? oldest + LIVE_JOIN_LIMIT_WINDOW_MS : nowMs + LIVE_JOIN_LIMIT_WINDOW_MS;
  }
  until = Math.min(Math.max(until, nowMs + MINUTE_MS), nowMs + MAX_BLOCK_MS);
  const current = msOf(next.blockedUntil);
  next.blockedUntil = new Date(Number.isFinite(current) ? Math.max(current, until) : until).toISOString();
  next.blockedReason = text(reason).slice(0, 200) || 'rate-limited';
  return next;
}

function limiterAllows(limiter, kind, nowMs, reserve = 0) {
  if (limiterBlockedUntilMs(limiter, nowMs)) return false;
  const used = callsInWindow(limiter, nowMs).length;
  if (kind === 'first') return used < LIVE_JOIN_LIMIT;
  return used + Math.max(0, reserve) < LIVE_JOIN_LIMIT;
}

// ── planner (pure) ───────────────────────────────────────────────────────────

function asSessionList(sessions) {
  const list = Array.isArray(sessions) ? sessions : Object.values(sessions || {});
  return list.map((session) => normalizeLiveSession(session)).filter(Boolean);
}

/** The last send that may have put a bot at the door (accepted, or timed out without an answer). */
function lastKnock(session = {}) {
  const knocks = (session.attempts || []).filter((attempt) => attempt.ok || attempt.uncertain);
  return knocks.length ? knocks[knocks.length - 1] : null;
}

function lastKnockMs(session = {}) {
  return msOf(lastKnock(session)?.at);
}

/** A knock that may still be waiting in the lobby (or just got in). */
function knockOpen(session = {}, nowMs) {
  const knock = lastKnockMs(session);
  return Number.isFinite(knock) && nowMs <= knock + LOBBY_WAIT_MS + GONE_GRACE_MS;
}

function verifyUntilMs(session = {}) {
  const { startMs, endMs } = timesOf(session);
  // Every send is followed through its lobby wait, a rep's late "send again" included.
  const knock = lastKnockMs(session);
  const knockTail = Number.isFinite(knock) ? knock + LOBBY_WAIT_MS + GONE_GRACE_MS : 0;
  if (session.state === 'recording') {
    const ffEnd = msOf(session.ffEndTime);
    const follow = Math.max(endMs + RECORDING_TAIL_MS, Number.isFinite(ffEnd) ? ffEnd + 5 * MINUTE_MS : 0, knockTail);
    return Math.min(follow, startMs + MAX_FOLLOW_MS);
  }
  return Math.max(endMs + LIVE_JOIN_VERIFY_TAIL_MS, knockTail);
}

function mayHaveBotOut(session = {}) {
  return Boolean(lastKnock(session));
}

function mayHaveBotOutSince(session = {}, sinceIso = '') {
  const since = msOf(sinceIso);
  return (session.attempts || []).some((attempt) => (attempt.ok || attempt.uncertain) && (!Number.isFinite(since) || msOf(attempt.at) > since));
}

function hasAttemptKind(session, kind) {
  return effectiveAttempts(session).some((attempt) => attempt.kind === kind);
}

/**
 * How long the bot last seen was in the room: from its own start (else the send that put it there, else the
 * first sighting) to its last sighting.
 */
function lastBotStayMs(session = {}) {
  const lastSeenMs = msOf(session.lastSeenActiveAt);
  if (!Number.isFinite(lastSeenMs)) return 0;
  const sent = (session.attempts || []).filter((attempt) => (attempt.ok || attempt.uncertain) && msOf(attempt.at) <= lastSeenMs).at(-1);
  const sinceMs = [msOf(session.ffStartTime), msOf(sent?.at), msOf(session.firstSeenActiveAt)].find(Number.isFinite);
  return Number.isFinite(sinceMs) ? Math.max(0, lastSeenMs - sinceMs) : 0;
}

/**
 * The bot left before its own end time, early in the meeting, and has not been sent back yet. Never before
 * the first-send window: a rejoin must not take the place of the first knock and its retries.
 *
 * Within the first-send window (to T+30) a bot that left can be sent back more than once: in a room the hub
 * opened (lib/google-meet-access.js) the bot walks in alone, waits its 10 minutes for someone and leaves,
 * which is the open room's version of a lobby knock nobody answered. The next one goes once the bot sent
 * back has been in and left too, or its knock has had its lobby wait; the 5-send cap still holds. A bot sent
 * back that left within minutes of coming in was taken out by someone in the meeting: it is not sent again.
 * The last 10 booked minutes get no rejoin, but the first-send window always does (a short booking, such as
 * a 30-minute workshop, can start late too).
 */
function rejoinOpen(session = {}, nowMs) {
  if (session.state !== 'ended' || session.detachedAt || session.transcriptSeenAt || session.permanentError) return false;
  if (!session.firstSeenActiveAt) return false;
  const { startMs, endMs } = timesOf(session);
  const dispatchUntil = startMs + LIVE_JOIN_DISPATCH_UNTIL_MS;
  if (nowMs < startMs - LIVE_JOIN_FIRST_LEAD_MS || (nowMs > dispatchUntil && nowMs >= endMs - REJOIN_CUTOFF_MS)) return false;
  const rejoins = effectiveAttempts(session).filter((attempt) => attempt.kind === 'rejoin');
  if (rejoins.length) {
    if (nowMs > dispatchUntil) return false;
    const backSince = msOf(session.lastSeenActiveAt) > msOf(rejoins[rejoins.length - 1].at);
    if (backSince && lastBotStayMs(session) < SAT_ALONE_MS) return false;
    if (!backSince && knockOpen(session, nowMs)) return false;
  }
  const ffEndMs = msOf(session.ffEndTime);
  return !Number.isFinite(ffEndMs) || msOf(session.lastSeenActiveAt) < ffEndMs - 2 * MINUTE_MS;
}

function firstDispatchDue(session = {}, nowMs) {
  const { startMs } = timesOf(session);
  return firstDispatchPending(session) && nowMs >= startMs - LIVE_JOIN_FIRST_LEAD_MS
    && nowMs <= startMs + LIVE_JOIN_DISPATCH_UNTIL_MS;
}

function needsVerification(session = {}, nowMs) {
  if (session.declinedAt) return false;
  const { startMs } = timesOf(session);
  if (!Number.isFinite(startMs)) return false;
  if (nowMs < startMs - LIVE_RECORDINGS_LEAD_MS || nowMs > verifyUntilMs(session)) return false;
  // Look before the first knock too: a bot added by hand (or a calendar bot) must not be doubled.
  if (firstDispatchDue(session, nowMs)) return true;
  if (session.state === 'ended') {
    return knockOpen(session, nowMs) || mayHaveBotOutSince(session, session.endedAt) || rejoinOpen(session, nowMs)
      || Boolean(session.manualRequestedAt);
  }
  return session.state === 'recording' || mayHaveBotOut(session) || Boolean(session.manualRequestedAt);
}

/** Keys of the sessions that need this tick's one active_meetings look (none: the call is not made). */
export function sessionsNeedingVerification(sessions = [], nowMs = Date.now()) {
  return asSessionList(sessions).filter((session) => needsVerification(session, nowMs)).map((session) => session.key);
}

/** Room → the bots in it, newest first. */
function indexActiveMeetings(activeMeetings = []) {
  const map = new Map();
  for (const row of Array.isArray(activeMeetings) ? activeMeetings : []) {
    const link = normalizeFirefliesMeetLink(row?.meetingLink || row?.meeting_link);
    if (!link) continue;
    const entry = {
      id: text(row.id),
      endTime: isoOrEmpty(row.endTime || row.end_time),
      startTime: isoOrEmpty(row.startTime || row.start_time),
    };
    if (!map.has(link)) map.set(link, []);
    map.get(link).push(entry);
  }
  for (const entries of map.values()) entries.sort((a, b) => (msOf(b.startTime) || 0) - (msOf(a.startTime) || 0));
  return map;
}

function setState(session, state, message, at) {
  if (session.state !== state) session.state = state;
  if (message) session.message = message;
  if (state === 'ended' && !session.endedAt) session.endedAt = session.lastSeenActiveAt || at;
}

/** The bot in the room started well before this meeting: an earlier meeting's in a reused room, still there. */
function earlierMeetingBot(session = {}) {
  const botStartMs = msOf(session.ffStartTime);
  return Number.isFinite(botStartMs) && botStartMs < timesOf(session).startMs - OWN_BOT_LEAD_MS;
}

/**
 * The mirror of earlierMeetingBot: a bot that started after this meeting's booked end, or once a later booked
 * session in the same room (`list`) reached its first send, was sent for that later meeting, unless one of
 * this session's own knocks can have put it in (it started within that knock's lobby wait). It is never this
 * session's, so its recording is never this meeting's.
 */
function laterMeetingBot(session = {}, botStartMs = NaN, list = []) {
  if (!Number.isFinite(botStartMs)) return false;
  const ownKnock = (session.attempts || []).some((attempt) => {
    const knockMs = msOf(attempt.at);
    return (attempt.ok || attempt.uncertain)
      && botStartMs >= knockMs - MINUTE_MS && botStartMs <= knockMs + LOBBY_WAIT_MS + GONE_GRACE_MS;
  });
  if (ownKnock) return false;
  const { startMs, endMs } = timesOf(session);
  if (botStartMs > endMs) return true;
  const link = linkOf(session);
  return list.some((other) => other.key !== session.key && !other.detachedAt && linkOf(other) === link
    && msOf(other.startAt) > startMs && botStartMs >= msOf(other.startAt) - LIVE_JOIN_FIRST_LEAD_MS);
}

function markSeen(session, hit, at) {
  session.firstSeenActiveAt = session.firstSeenActiveAt || at;
  session.lastSeenActiveAt = at;
  session.checkedAt = at;
  if (hit.id) {
    // A sighting without a start time (the bot_joined webhook) keeps what a look said about the same bot.
    if (hit.startTime || hit.id !== session.ffMeetingId) session.ffStartTime = hit.startTime || '';
    session.ffMeetingId = hit.id;
    if (!session.ffMeetingIds.includes(hit.id)) session.ffMeetingIds = [...session.ffMeetingIds, hit.id].slice(-10);
  }
  if (hit.endTime) session.ffEndTime = hit.endTime;
  session.endedAt = '';
  // A continuation bot has to be let in as well: keep saying so while the bot in the room is still the old one.
  const knock = lastKnock(session);
  const oldBot = knock?.kind === 'continuation' && knock.ok && msOf(hit.startTime) < msOf(knock.at) - MINUTE_MS;
  let message = LIVE_JOIN_MESSAGES.recording;
  if (oldBot) message = LIVE_JOIN_MESSAGES.continuation;
  else if (earlierMeetingBot(session)) message = LIVE_JOIN_MESSAGES.earlierBot;
  setState(session, 'recording', message, at);
}

/**
 * One-bot plans: start of the next booked meeting in another room that starts once this one's booked time is
 * over. A meeting that overlaps this one cannot get a bot while this one has it, so it never shortens this
 * bot's stay; nor does a booking the client was never e-mailed.
 */
function nextOtherStartMs(session, list, nowMs) {
  const link = linkOf(session);
  const { endMs } = timesOf(session);
  let best = Infinity;
  for (const other of list) {
    if (other.key === session.key || other.detachedAt || other.declinedAt || !other.confirmed || linkOf(other) === link) continue;
    const start = msOf(other.startAt);
    if (Number.isFinite(start) && start >= endMs && start > nowMs && start < best) best = start;
  }
  return best;
}

function roomMinutes(session, list, nowMs) {
  const next = nextOtherStartMs(session, list, nowMs);
  if (!Number.isFinite(next)) return LIVE_JOIN_MAX_DURATION_MINUTES;
  return Math.floor((next - NEXT_MEETING_GAP_MS - nowMs) / MINUTE_MS);
}

/**
 * Minutes to pass to addToLiveMeeting: 120, the documented maximum. Only with `oneBot` (a Fireflies plan that
 * runs one bot at a time; FIREFLIES_LIVE_JOIN_ONE_BOT) is the stay cut so the bot is gone one minute before the
 * next booked meeting's first send, never under Fireflies' minimum of 15.
 */
export function liveJoinDurationMinutes(session, sessions = [], nowMs = Date.now(), { oneBot = false } = {}) {
  if (!oneBot) return LIVE_JOIN_MAX_DURATION_MINUTES;
  const minutes = roomMinutes(normalizeLiveSession(session) || session, asSessionList(sessions), nowMs);
  return Math.min(LIVE_JOIN_MAX_DURATION_MINUTES, Math.max(LIVE_JOIN_MIN_DURATION_MINUTES, minutes));
}

/** One-bot plans only: a rejoin or continuation would take the bot the next meeting needs. */
function nextMeetingNeedsBot(session, ctx) {
  return ctx.oneBot && roomMinutes(session, ctx.list, ctx.nowMs) < LIVE_JOIN_MIN_DURATION_MINUTES;
}

/**
 * Why a session that ends with the bot never in the room got there: 'not-let-in' (Fireflies accepted a send),
 * or why no bot ever went out: 'failed' (Fireflies refused or did not answer), 'rate-limited', 'no-api-key',
 * 'safe-mode', or 'never-sent' (the hub did not try in time, for example while it was down).
 */
export function liveSessionUnsentReason(input = {}) {
  const session = normalizeLiveSession(input) || {};
  if (session.dispatchedAt) return 'not-let-in';
  if (session.unsentReason) return session.unsentReason;
  const attempts = session.attempts || [];
  if (attempts.some((attempt) => !attempt.rateLimited)) return 'failed';
  return attempts.length ? 'rate-limited' : 'never-sent';
}

/** How the 'failed' copy of notAdmittedMessage starts (the watchdog quotes it in its e-mail). */
export const NEVER_SENT_FAILED_LEAD = 'Fireflies tok ikke imot forespørselen om å bli med i møtet';

/** The card and placeholder copy for 'not-admitted': what happened, in plain words. */
export function notAdmittedMessage(input = {}) {
  const session = normalizeLiveSession(input) || {};
  const reason = liveSessionUnsentReason(session);
  // Never looked at since the send (the hub was down through the meeting, an older hub sent it, or every look
  // failed): the bot may have been in, so the card does not say it was kept out.
  if (reason === 'not-let-in' && !(msOf(session.checkedAt) > msOf(session.dispatchedAt))) return LIVE_JOIN_MESSAGES.notChecked;
  if (reason === 'not-let-in') return LIVE_JOIN_MESSAGES.notAdmitted;
  if (reason === 'no-api-key') return LIVE_JOIN_MESSAGES.neverSentNoKey;
  if (reason === 'rate-limited') return LIVE_JOIN_MESSAGES.neverSentLimited;
  if (reason === 'safe-mode') return LIVE_JOIN_MESSAGES.neverSentSafeMode;
  if (reason === 'failed') {
    const last = [...(session.attempts || [])].reverse().find((attempt) => !attempt.ok && !attempt.rateLimited);
    const detail = text(last?.message).slice(0, 120);
    return `${NEVER_SENT_FAILED_LEAD}${detail ? ` (${detail})` : ''}, så det blir trolig ikke noe opptak. Skriv notater fra møtet.`;
  }
  return LIVE_JOIN_MESSAGES.neverSent;
}

function retryDueMs(position, lastAttemptMs, startMs) {
  if (position <= 1) return Math.max(startMs + MINUTE_MS, lastAttemptMs + 4 * MINUTE_MS);
  if (position === 2) return Math.max(startMs + 5 * MINUTE_MS, lastAttemptMs + 4 * MINUTE_MS);
  return Math.max(startMs + 5 * MINUTE_MS, lastAttemptMs + 10 * MINUTE_MS);
}

/**
 * Whether the engine will still knock again on its own before the first-send window closes (T+30): the next
 * retry while the bot was never in, or, for one that was in and left, a send-back once the last knock has had
 * its lobby wait. The rep's lobby e-mail says "nothing to do" only then.
 */
export function liveSessionKnocksAgain(input = {}, nowMs = Date.now()) {
  const s = normalizeLiveSession(input);
  if (!s || s.declinedAt || s.detachedAt || s.permanentError || s.transcriptSeenAt) return false;
  const { startMs } = timesOf(s);
  const attempts = effectiveAttempts(s);
  if (attempts.filter((attempt) => attempt.kind !== 'manual').length >= LIVE_JOIN_MAX_ATTEMPTS) return false;
  const dispatchUntil = startMs + LIVE_JOIN_DISPATCH_UNTIL_MS;
  if (nowMs > dispatchUntil) return false;
  if (!attempts.length) return true;
  const lastMs = msOf(attempts[attempts.length - 1].at);
  if (s.firstSeenActiveAt) {
    // As rejoinOpen: a bot sent back that was taken out within minutes of coming in is not sent again.
    const rejoin = attempts.filter((attempt) => attempt.kind === 'rejoin').at(-1);
    if (rejoin && msOf(s.lastSeenActiveAt) > msOf(rejoin.at) && lastBotStayMs(s) < SAT_ALONE_MS) return false;
    const nextMs = (lastKnockMs(s) || lastMs) + LOBBY_WAIT_MS + GONE_GRACE_MS;
    return nextMs <= dispatchUntil;
  }
  return retryDueMs(attempts.length, lastMs, startMs) <= dispatchUntil;
}

function cloneSession(session) {
  return {
    ...session,
    slots: session.slots.map((slot) => ({ ...slot })),
    attempts: session.attempts.map((attempt) => ({ ...attempt })),
    ffMeetingIds: [...session.ffMeetingIds],
    placeholderIds: [...(session.placeholderIds || [])],
  };
}

function evaluateSession(input, ctx) {
  const s = cloneSession(input);
  const { nowMs, active } = ctx;
  const at = new Date(nowMs).toISOString();
  const out = { session: s, want: null, reason: '', openMeetRoom: false };
  const { startMs, endMs } = timesOf(s);
  if (!Number.isFinite(startMs)) {
    out.reason = 'no-start';
    return out;
  }
  const watchEnd = verifyUntilMs(input);
  const watching = nowMs >= startMs - LIVE_RECORDINGS_LEAD_MS && nowMs <= watchEnd;
  const observed = active !== null && watching;
  // Before the first-send window a bot in the room belongs to an earlier meeting there (one moved into the
  // same room): an early sighting only counts once this session has sent a bot of its own.
  const adoptable = nowMs >= startMs - LIVE_JOIN_FIRST_LEAD_MS || mayHaveBotOut(s);
  // The newest bot in the room that is not a later meeting's there (a reused room's next booking).
  const hit = observed && adoptable
    ? (active.get(linkOf(s)) || []).find((entry) => !laterMeetingBot(s, msOf(entry.startTime), ctx.list)) || null
    : null;

  if (ctx.meetRooms && !s.meetRoomRequestedAt && !s.detachedAt && !s.declinedAt
    && nowMs >= startMs - LIVE_JOIN_MEET_ROOM_LEAD_MS && nowMs <= endMs) {
    out.openMeetRoom = true;
  }
  if (s.declinedAt) {
    s.nextAttemptAt = '';
    s.manualRequestedAt = '';
    out.reason = 'declined';
    return out;
  }

  if (hit) markSeen(s, hit, at);
  else if (observed && needsVerification(input, nowMs)) s.checkedAt = at;

  const attempts = effectiveAttempts(s);
  const automatic = attempts.filter((attempt) => attempt.kind !== 'manual');
  const lastAttemptMs = attempts.length ? msOf(attempts[attempts.length - 1].at) : NaN;
  const budgetLeft = automatic.length < LIVE_JOIN_MAX_ATTEMPTS;
  const seenEver = Boolean(s.firstSeenActiveAt);
  const lastSeenMs = msOf(s.lastSeenActiveAt);

  // A rep's "send again": stale after 30 minutes, void once the bot is in the room.
  const manualMs = msOf(s.manualRequestedAt);
  let manualWanted = Number.isFinite(manualMs) && nowMs - manualMs <= MANUAL_REQUEST_TTL_MS && !s.detachedAt;
  if (s.manualRequestedAt && (!manualWanted || hit)) {
    s.manualRequestedAt = '';
    manualWanted = false;
  }
  const want = (kind) => ({ key: s.key, kind, startMs, confirmed: Boolean(s.confirmed) });

  if (hit) {
    s.nextAttemptAt = '';
    const ffEndMs = msOf(s.ffEndTime);
    if (!s.detachedAt && Number.isFinite(ffEndMs) && nowMs >= ffEndMs - CONTINUATION_LEAD_MS
      && nowMs < endMs + CONTINUATION_TAIL_MS && !hasAttemptKind(s, 'continuation') && budgetLeft) {
      // The meeting runs past the bot's time: send one more before it leaves (a one-bot plan's next meeting first).
      if (nextMeetingNeedsBot(s, ctx)) out.reason = 'next-meeting';
      else out.want = want('continuation');
    } else {
      out.reason = 'recording';
    }
    return out;
  }

  if (s.state === 'recording') {
    if (observed && Number.isFinite(lastSeenMs) && nowMs - lastSeenMs >= GONE_GRACE_MS) {
      setState(s, 'ended', LIVE_JOIN_MESSAGES.ended, at);
    } else if (nowMs > watchEnd) {
      setState(s, 'ended', LIVE_JOIN_MESSAGES.ended, at);
    } else {
      out.reason = 'recording';
      return out;
    }
  }

  if (manualWanted) {
    out.want = want(firstDispatchPending(s) && nowMs >= startMs - LIVE_JOIN_FIRST_LEAD_MS ? 'first' : 'manual');
    s.nextAttemptAt = '';
    return out;
  }

  if (seenEver) {
    // The bot was in and is gone. One rejoin if it dropped out early (not at its own end time), sent only
    // after a fresh look shows the room without it.
    if (rejoinOpen(s, nowMs) && budgetLeft) {
      s.message = LIVE_JOIN_MESSAGES.dropped;
      if (!observed) out.reason = 'unverified';
      else if (nextMeetingNeedsBot(s, ctx)) out.reason = 'next-meeting';
      else out.want = want('rejoin');
      return out;
    }
    if (s.state === 'dispatched' && nowMs > watchEnd) setState(s, 'ended', LIVE_JOIN_MESSAGES.ended, at);
    // Most bots that leave early left a meeting that ended early: once a rejoin knock has had its lobby wait,
    // the card says "ended" again instead of a drop-out.
    if (s.state === 'ended' && !knockOpen(s, nowMs)) s.message = LIVE_JOIN_MESSAGES.ended;
    out.reason = s.state === 'dispatched' ? 'waiting-admission' : 'ended';
    s.nextAttemptAt = '';
    return out;
  }

  // Never seen in the room.
  const dispatchUntil = startMs + LIVE_JOIN_DISPATCH_UNTIL_MS;
  if (!attempts.length) {
    if (!s.detachedAt && nowMs >= startMs - LIVE_JOIN_FIRST_LEAD_MS && nowMs <= dispatchUntil) {
      out.want = want('first');
      s.nextAttemptAt = '';
      return out;
    }
    if (nowMs > dispatchUntil) {
      if (s.state !== 'not-admitted') setState(s, 'not-admitted', notAdmittedMessage(s), at);
      s.nextAttemptAt = '';
      out.reason = 'never-sent';
      return out;
    }
    s.nextAttemptAt = iso(startMs - LIVE_JOIN_FIRST_LEAD_MS);
    out.reason = 'scheduled';
    return out;
  }

  let exhausted = !budgetLeft || Boolean(s.permanentError) || Boolean(s.detachedAt) || nowMs > dispatchUntil;
  if (!exhausted) {
    const dueMs = retryDueMs(attempts.length, lastAttemptMs, startMs);
    if (dueMs > dispatchUntil) {
      exhausted = true;
    } else if (nowMs >= dueMs) {
      // A retry into a room where a bot may be is only safe after a fresh look at who is in it. When the
      // looks keep failing, a second bot is the lesser harm than none: go blind after 5 minutes.
      const lookedMs = Math.max(msOf(s.checkedAt) || 0, lastAttemptMs || 0);
      const blind = nowMs - lookedMs >= BLIND_RETRY_AFTER_MS;
      if (!mayHaveBotOut(s) || observed || blind) {
        s.nextAttemptAt = '';
        if (s.state === 'dispatched') s.message = LIVE_JOIN_MESSAGES.waiting;
        out.want = want('retry');
        return out;
      }
      s.nextAttemptAt = iso(dueMs);
      out.reason = 'unverified';
      return out;
    } else {
      s.nextAttemptAt = iso(dueMs);
      if (s.state === 'dispatched' && nowMs >= startMs) s.message = LIVE_JOIN_MESSAGES.waiting;
      out.reason = 'waiting-retry';
      return out;
    }
  }
  s.nextAttemptAt = '';
  // Out of automatic sends: "not let in" once the last knock has had its lobby wait (or the watch is over).
  const settleMs = Number.isFinite(lastAttemptMs) ? lastAttemptMs + LOBBY_WAIT_MS : dispatchUntil;
  if (s.state !== 'not-admitted' && (nowMs >= settleMs || nowMs > watchEnd)) {
    setState(s, 'not-admitted', notAdmittedMessage(s), at);
  }
  out.reason = s.permanentError ? 'bad-link' : 'attempts-done';
  return out;
}

/** Earliest start first; at the same start a meeting the client was e-mailed goes before an unconfirmed one. */
function compareWants(a, b) {
  return a.startMs - b.startMs
    || Number(b.confirmed) - Number(a.confirmed)
    || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)
    || a.key.localeCompare(b.key);
}

/**
 * One tick of decisions, without I/O. `activeMeetings` is the active_meetings answer of this tick, or null
 * when it was not asked (or failed): null never counts as "not in the room". Returns the sessions with the
 * observation applied and the actions, in send order:
 *   { type: 'dispatch', key, kind: 'first'|'retry'|'rejoin'|'continuation'|'manual', durationMinutes }
 *   { type: 'open-meet-room', key }   (only with meetRooms: true)
 * plus `deferred` ({ key, kind, reason: 'blocked'|'limit'|'reserved'|'room' }), `reasons` per key, `reserve`
 * (first dispatches due within 20 minutes) and `nextAllowedAt` for retries and manual sends. `oneBot`: the
 * Fireflies plan runs one bot at a time (see liveJoinDurationMinutes).
 */
export function planLiveSessionTick({
  sessions = [],
  activeMeetings = null,
  nowMs = Date.now(),
  limiter = null,
  meetRooms = false,
  oneBot = false,
} = {}) {
  const list = asSessionList(sessions);
  const ctx = {
    nowMs,
    active: activeMeetings == null ? null : indexActiveMeetings(activeMeetings),
    list,
    meetRooms: Boolean(meetRooms),
    oneBot: Boolean(oneBot),
  };
  const lim = normalizeLimiter(limiter);
  const next = [];
  const wants = [];
  const reasons = {};
  const roomActions = [];
  for (const session of list) {
    const evaluated = evaluateSession(session, ctx);
    next.push(evaluated.session);
    if (evaluated.want) wants.push(evaluated.want);
    if (evaluated.reason) reasons[session.key] = evaluated.reason;
    if (evaluated.openMeetRoom) roomActions.push({ type: 'open-meet-room', key: session.key });
  }
  const byKey = new Map(next.map((session) => [session.key, session]));

  // One knock per room at a time, whichever session on that room sends it: a rep's "send again" seconds after
  // a knock, or two sessions on one room, would put a second bot from the same account at the door.
  const roomKnockMs = new Map();
  for (const session of next) {
    const knock = lastKnockMs(session);
    const link = linkOf(session);
    if (Number.isFinite(knock) && !(roomKnockMs.get(link) >= knock)) roomKnockMs.set(link, knock);
  }
  const roomFreeAtMs = (entry) => {
    const knock = roomKnockMs.get(linkOf(byKey.get(entry.key)));
    return Number.isFinite(knock) ? knock + ROOM_KNOCK_SPACING_MS : 0;
  };

  const blocked = Boolean(limiterBlockedUntilMs(lim, nowMs));
  let used = callsInWindow(lim, nowMs).length;
  const dispatch = [];
  const deferred = [];
  const roomWaits = new Map();
  const take = (entry) => {
    dispatch.push(entry);
    used += 1;
    roomKnockMs.set(linkOf(byKey.get(entry.key)), nowMs);
  };
  const waitForRoom = (entry) => {
    const roomAt = roomFreeAtMs(entry);
    if (roomAt <= nowMs) return false;
    deferred.push({ key: entry.key, kind: entry.kind, reason: 'room' });
    roomWaits.set(entry.key, roomAt);
    return true;
  };
  const firsts = wants.filter((entry) => entry.kind === 'first').sort(compareWants);
  const others = wants.filter((entry) => entry.kind !== 'first').sort(compareWants);
  for (const entry of firsts) {
    if (waitForRoom(entry)) continue;
    if (!blocked && used < LIVE_JOIN_LIMIT) take(entry);
    else deferred.push({ key: entry.key, kind: entry.kind, reason: blocked ? 'blocked' : 'limit' });
  }
  const reserve = upcomingFirstDispatches(next, nowMs) + deferred.length;
  for (const entry of others) {
    if (waitForRoom(entry)) continue;
    if (!blocked && used + reserve < LIVE_JOIN_LIMIT) take(entry);
    else deferred.push({ key: entry.key, kind: entry.kind, reason: blocked ? 'blocked' : (used >= LIVE_JOIN_LIMIT ? 'limit' : 'reserved') });
  }
  const nextAllowedAt = liveJoinNextAllowedAt(lim, nowMs, { reserve });
  for (const entry of deferred) {
    reasons[entry.key] = entry.reason;
    const session = byKey.get(entry.key);
    if (!session) continue;
    if (roomWaits.has(entry.key)) {
      session.nextAttemptAt = iso(roomWaits.get(entry.key));
      continue;
    }
    // A first dispatch only needs a free call; the others also leave room for the reserved first dispatches.
    session.nextAttemptAt = entry.kind === 'first' ? liveJoinNextAllowedAt(lim, nowMs, { reserve: 0 }) : nextAllowedAt;
    if (entry.reason !== 'reserved') session.message = LIVE_JOIN_MESSAGES.limited;
  }
  // Rooms open first, so a bot sent in the same tick can walk in.
  const actions = [
    ...roomActions,
    ...dispatch.map((entry) => ({
      type: 'dispatch',
      key: entry.key,
      kind: entry.kind,
      durationMinutes: liveJoinDurationMinutes(byKey.get(entry.key), next, nowMs, { oneBot: ctx.oneBot }),
    })),
  ];
  return { sessions: next, actions, deferred, reasons, reserve, nextAllowedAt };
}

/** The session after one addToLiveMeeting attempt (pure). */
export function applyLiveJoinAttempt(input, {
  at = new Date().toISOString(),
  kind = 'retry',
  ok = false,
  message = '',
  durationMinutes = 0,
  uncertain = false,
  rateLimited = false,
  permanent = false,
} = {}) {
  const s = cloneSession(normalizeLiveSession(input));
  const attempt = normalizeAttempt({ at, kind, ok, message, durationMinutes, uncertain, rateLimited });
  s.attempts = [...s.attempts, attempt].slice(-MAX_STORED_ATTEMPTS);
  if (!rateLimited) s.manualRequestedAt = '';
  s.nextAttemptAt = '';
  if (attempt.ok) {
    s.dispatchedAt = s.dispatchedAt || attempt.at;
    s.lastDispatchedAt = attempt.at;
    s.permanentError = '';
    if (attempt.kind === 'rejoin' && s.state === 'ended') {
      // The bot most often left because the meeting ended early: the session stays "ended" unless it is seen again.
      s.message = LIVE_JOIN_MESSAGES.rejoined;
    } else if (attempt.kind === 'continuation' && s.state === 'recording') {
      s.message = LIVE_JOIN_MESSAGES.continuation;
    } else if (s.state !== 'recording') {
      // Out again: the end time is set anew from the last sighting if this bot never shows up.
      s.endedAt = '';
      setState(s, 'dispatched', LIVE_JOIN_MESSAGES.dispatched, attempt.at);
    }
  } else if (rateLimited) {
    s.message = LIVE_JOIN_MESSAGES.limited;
  } else {
    if (permanent) s.permanentError = attempt.message || 'error';
    s.message = `${LIVE_JOIN_MESSAGES.failed}${attempt.message ? `: ${attempt.message}` : '.'}`.slice(0, 300);
  }
  return s;
}

/**
 * The `recording` object a client.meetings placeholder carries for this session. ffMeetingId names the bot's
 * recording only when that bot is this meeting's: the watchdog links a recording by it.
 */
export function recordingForLiveSession(session = {}) {
  const s = normalizeLiveSession(session) || {};
  return {
    state: s.state || 'scheduled',
    sessionKey: s.key || '',
    ffMeetingId: earlierMeetingBot(s) || laterMeetingBot(s, msOf(s.ffStartTime)) ? '' : s.ffMeetingId || '',
    attempts: (s.attempts || []).length,
    dispatchedAt: s.dispatchedAt || '',
    verifiedAt: s.firstSeenActiveAt || '',
    lastSeenAt: s.lastSeenActiveAt || '',
    endedAt: s.endedAt || '',
    checkedAt: s.checkedAt || '',
    message: s.message || '',
  };
}

/**
 * The `recording` patch capture may write onto an existing placeholder row. Intake's missing/empty and a rep's
 * declined have the last word: capture then only adds its facts, unless the bot is back in the room or (with
 * `reopen`, a rep's accepted "send again") the lifecycle starts over. A declined row never changes state.
 */
export function placeholderRecordingPatch(row = {}, session = {}, { reopen = false } = {}) {
  const recording = recordingForLiveSession(session);
  const current = text(row?.recording?.state);
  if (!TERMINAL_RECORDING_STATES.has(current)) return recording;
  if (current !== 'declined' && (reopen || recording.state === 'recording')) return recording;
  const facts = { ...recording };
  delete facts.state;
  delete facts.message;
  return facts;
}

/**
 * Whether capture may write the slot's placeholder row now: only after Fireflies accepted a dispatch, once per
 * session and slot (a row intake dropped when the real recording was linked never comes back), and not when
 * the client already has this meeting's transcript.
 */
export function shouldCreateLivePlaceholder(session = {}, slot = {}, client = {}) {
  const s = normalizeLiveSession(session);
  if (!s?.dispatchedAt || s.transcriptSeenAt) return false;
  if (s.placeholderIds.includes(text(slot?.stubMeetingId))) return false;
  return !clientHasTranscriptForSession(client, s);
}

/** Remember that the slot's placeholder row was written for this session (see shouldCreateLivePlaceholder). */
export function noteLivePlaceholderCreated(sessionKey = '', stubMeetingId = '', { nowMs = Date.now() } = {}) {
  const key = text(sessionKey);
  const id = text(stubMeetingId);
  if (!key || !id) return;
  updateLiveSessionStore((current) => {
    const session = current.sessions[key];
    if (!session || session.placeholderIds.includes(id)) return undefined;
    session.placeholderIds = [...session.placeholderIds, id];
    return current;
  }, { nowMs });
}

// Sessions that can end without the row an accepted send writes: never sent or never let in ('not-admitted'),
// or a bot the hub did not send (adopted: 'recording', then 'ended').
const UNSENT_PLACEHOLDER_STATES = new Set(['not-admitted', 'recording', 'ended']);
// The slot must still book the session, which bookedLiveSlots only knows within its collect horizon.
const UNSENT_PLACEHOLDER_MAX_AGE_MS = COLLECT_PAST_MS;

/**
 * Whether a session with no accepted send (or whose row was never written) needs this slot's placeholder now,
 * so the watchdog can follow it to 'missing': the session still books this slot, it is not declined, its
 * recording with talk is not linked, and the row was never written before (one intake dropped stays dropped).
 */
export function unsentPlaceholderNeeded(input = {}, slot = {}, client = {}, nowMs = Date.now()) {
  const session = normalizeLiveSession(input);
  if (!session || !UNSENT_PLACEHOLDER_STATES.has(session.state)) return false;
  if (session.detachedAt || session.declinedAt || session.transcriptSeenAt) return false;
  if (nowMs - msOf(session.startAt) > UNSENT_PLACEHOLDER_MAX_AGE_MS) return false;
  if (!text(slot?.stubMeetingId) || session.placeholderIds.includes(text(slot.stubMeetingId))) return false;
  if (slotRow(client, slot) || clientHasTranscriptForSession(client, session)) return false;
  return currentSessionKeyForSlot(client, slot, nowMs) === session.key;
}

/**
 * Make sure every booked online session that ended up without a bot in the room, or with one the hub did not
 * send, has its placeholder rows ('live:…' on client.meetings), with the session's honest state and no
 * liveJoinedAt. `writePlaceholder({ session, slot, client, recording })` writes one row (server.js) and returns
 * a truthy value when it did. A row that exists already is only remembered on the session.
 */
export function ensureLivePlaceholders({
  clients = [],
  writePlaceholder,
  nowMs = Date.now(),
  store = null,
  log = console,
} = {}) {
  const created = [];
  if (typeof writePlaceholder !== 'function') return created;
  const byId = new Map((Array.isArray(clients) ? clients : []).map((client) => [text(client?.id), client]));
  for (const session of Object.values((store || readLiveSessionStore()).sessions)) {
    if (!UNSENT_PLACEHOLDER_STATES.has(session.state) || nowMs - msOf(session.startAt) > UNSENT_PLACEHOLDER_MAX_AGE_MS) continue;
    for (const slot of session.slots) {
      const client = byId.get(slot.clientId);
      if (!client) continue;
      try {
        if (slotRow(client, slot)) {
          // Written by an accepted send (or an earlier tick): remembered so it never comes back once dropped.
          if (!session.placeholderIds.includes(slot.stubMeetingId)) noteLivePlaceholderCreated(session.key, slot.stubMeetingId, { nowMs });
          continue;
        }
        if (!unsentPlaceholderNeeded(session, slot, client, nowMs)) continue;
        if (!writePlaceholder({ session, slot, client, recording: recordingForLiveSession(session) })) continue;
        noteLivePlaceholderCreated(session.key, slot.stubMeetingId, { nowMs });
        created.push({ sessionKey: session.key, clientId: slot.clientId, meetingId: slot.stubMeetingId, state: session.state });
        log?.log?.(`[fireflies] live-join placeholder client=${slot.clientId} meeting=${slot.stubMeetingId} state=${session.state}`);
      } catch (error) {
        log?.warn?.(`[fireflies] live-join placeholder client=${slot.clientId} failed: ${text(error?.message) || error}`);
      }
    }
  }
  return created;
}

/**
 * A rep's "held without recording" (declined: true) or its undo (false) on one session: no more sends while
 * declined; the engine takes the session up again once it is opened.
 */
export function setLiveSessionDeclined(sessionKey = '', declined = true, { nowMs = Date.now() } = {}) {
  const key = text(sessionKey);
  if (!key) return null;
  const at = new Date(nowMs).toISOString();
  const store = updateLiveSessionStore((current) => {
    const session = current.sessions[key];
    if (!session || Boolean(session.declinedAt) === Boolean(declined)) return undefined;
    session.declinedAt = declined ? at : '';
    if (declined) Object.assign(session, { manualRequestedAt: '', nextAttemptAt: '' });
    session.updatedAt = at;
    return current;
  }, { nowMs });
  return store.sessions[key] || null;
}

/** One of this client's booked online slots by its slot key, at any time (for a rep's mark), or null. */
export function bookedSlotForKey(client = {}, slotKey = '', nowMs = Date.now()) {
  const wanted = text(slotKey);
  if (!wanted) return null;
  try {
    return bookedLiveSlots(client, nowMs, { anyTime: true }).find((slot) => slot.slotKey === wanted) || null;
  } catch {
    return null;
  }
}

// ── engine ───────────────────────────────────────────────────────────────────

const engine = {
  running: false,
  startedAt: 0,
  token: 0,
  lastTickAt: '',
  lastError: '',
  lastSummary: null,
  lastLookAtMs: 0,
  // Health for the owner alert (lib/fireflies-live-alerts.js): the last tick without errors, and since when
  // every tick has had one.
  lastOkTickAt: '',
  failingSince: '',
  logged: new Map(),
};

const PERMANENT_ERROR_CODES = new Set(['unsupported_platform', 'invalid_arguments', 'args_required', 'forbidden', 'paid_required', 'account_cancelled']);

function classifyDispatchError(error) {
  const code = text(error?.code).toLowerCase();
  const message = text(error?.message) || 'Fireflies live join failed.';
  const rateLimited = code === 'rate-limited' || /exceeded|too many requests/i.test(message);
  const uncertain = !rateLimited && (code === 'timeout' || code === 'network');
  const permanent = !rateLimited && !uncertain && (
    PERMANENT_ERROR_CODES.has(code) || /unsupported_platform|platform is not supported|invalid_arguments/i.test(message)
  );
  return { message, rateLimited, uncertain, permanent, retryAfterMs: Number(error?.retryAfterMs) || 0 };
}

function logOnce(log, session, state, reason) {
  const signature = `${state}|${reason}`;
  if (engine.logged.get(session.key) === signature) return;
  engine.logged.set(session.key, signature);
  log?.log?.(`[fireflies] live-join session=${session.key} state=${state} reason=${reason || '-'} attempts=${session.attempts.length}`);
}

function insideWatchWindow(session, nowMs) {
  const { startMs } = timesOf(session);
  return Number.isFinite(startMs) && nowMs >= startMs - LIVE_JOIN_FIRST_LEAD_MS && nowMs <= verifyUntilMs(session);
}

function changedFields(before = {}, after = {}) {
  const patch = {};
  for (const [field, value] of Object.entries(after)) {
    if (JSON.stringify(before[field]) !== JSON.stringify(value)) patch[field] = value;
  }
  return patch;
}

/**
 * Card saves kick a tick seconds after the last one. Such a tick looks at the rooms again only when the last
 * look is stale or it may send (a send, or a retry that waits for a look), so bursts of saves during a meeting
 * do not spend the general API budget the sends and ingest share.
 */
function lookIsDue(sessions, planOptions) {
  if (!engine.lastLookAtMs || planOptions.nowMs - engine.lastLookAtMs >= LOOK_MIN_INTERVAL_MS) return true;
  const dry = planLiveSessionTick({ sessions, activeMeetings: null, ...planOptions, meetRooms: false });
  return dry.actions.length > 0 || Object.values(dry.reasons).includes('unverified');
}

/** A rep marked the meeting "held without recording" on a placeholder row since the tick read the clients. */
function declinedOnRows(session, getClient) {
  if (typeof getClient !== 'function') return false;
  return session.slots.some((slot) => {
    const client = getClient(slot.clientId);
    const row = (Array.isArray(client?.meetings) ? client.meetings : []).find((item) => text(item?.meetingId) === slot.stubMeetingId);
    return text(row?.recording?.state) === 'declined';
  });
}

// Placeholder rows follow transitions only; the minute-by-minute sightings stay in the store (liveRecordings).
function noteChange(changes, previous, session) {
  if (!previous || !session) return;
  const fields = ['state', 'firstSeenActiveAt', 'ffMeetingId', 'endedAt', 'message'];
  if (fields.some((field) => previous[field] !== session[field])) changes.push({ previous, session });
}

/**
 * One engine tick. deps:
 *   listClients()                    fresh clients (sales.getSalesClients)
 *   getClient(id)                    optional, one fresh client (a rep's "declined" is checked right before a send)
 *   apiKey()                         Fireflies key ('' → nothing is asked or sent)
 *   fetchActiveMeetings()            fetchActiveFirefliesMeetings
 *   addToLive({ meetingLink, title, durationMinutes })   addFirefliesToLiveMeeting
 *   onDispatch({ session, attempt }) after every attempt (stamps, placeholder rows)
 *   onSessionChange({ session, previous })  after a state or sighting change (placeholder rows)
 *   openMeetRoom(session)            optional, from 30 minutes before start; asked again each tick while it
 *                                    resolves { ok: false } (lib/google-meet-access.js)
 *   refreshKeyOwner()                optional, the fred@ owner lookup (at most once per 6 h)
 *   oneBot                           optional, the Fireflies plan runs one bot at a time (liveJoinDurationMinutes)
 *   log, nowMs
 * One tick runs at a time per process; a tick stuck for over 2 minutes is let go by the next one.
 */
export async function runFirefliesLiveJoinTick(deps = {}) {
  const log = deps.log === undefined ? console : deps.log;
  const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
  if (engine.running) {
    if (nowMs - engine.startedAt < WATCHDOG_MS) return { skipped: 'running' };
    log?.warn?.('[fireflies] live-join tick has run for over 2 minutes; starting a new one');
  }
  engine.running = true;
  engine.startedAt = nowMs;
  const token = ++engine.token;
  const at = new Date(nowMs).toISOString();
  try {
    const summary = await tickOnce(deps, nowMs, log);
    engine.lastError = summary.errors.length ? summary.errors[summary.errors.length - 1] : '';
    engine.lastSummary = summary;
    if (summary.errors.length) engine.failingSince = engine.failingSince || at;
    else Object.assign(engine, { failingSince: '', lastOkTickAt: at });
    return summary;
  } catch (error) {
    engine.lastError = text(error?.message) || String(error);
    engine.failingSince = engine.failingSince || at;
    log?.error?.('[fireflies] live-join tick failed', engine.lastError);
    return { at, errors: [engine.lastError] };
  } finally {
    engine.lastTickAt = new Date(nowMs).toISOString();
    if (engine.token === token) engine.running = false;
  }
}

async function tickOnce(deps, nowMs, log) {
  const summary = {
    at: new Date(nowMs).toISOString(),
    sessions: 0,
    verified: false,
    dispatched: [],
    deferred: [],
    errors: [],
    oneBot: Boolean(deps.oneBot),
  };
  const clients = typeof deps.listClients === 'function' ? deps.listClients() : [];
  const collected = collectLiveSessions(clients, nowMs);
  let store = updateLiveSessionStore((current) => {
    const sessions = syncLiveSessions(current.sessions, collected, { nowMs, full: true, clients });
    if (sameSessions(sessions, current.sessions)) return undefined;
    return { ...current, sessions };
  }, { nowMs });
  summary.sessions = Object.keys(store.sessions).length;
  const apiKey = typeof deps.apiKey === 'function' ? text(deps.apiKey()) : text(deps.apiKey);
  if (apiKey && typeof deps.refreshKeyOwner === 'function') {
    try {
      await deps.refreshKeyOwner();
    } catch {
      // the owner lookup is best effort (it answers from its cache at most every 6 hours)
    }
  }
  if (!summary.sessions) return summary;

  const planOptions = {
    nowMs,
    limiter: store.limiter,
    meetRooms: typeof deps.openMeetRoom === 'function',
    oneBot: Boolean(deps.oneBot),
  };
  let activeMeetings = null;
  if (apiKey && typeof deps.fetchActiveMeetings === 'function'
    && sessionsNeedingVerification(store.sessions, nowMs).length
    && lookIsDue(store.sessions, planOptions)) {
    try {
      activeMeetings = await deps.fetchActiveMeetings();
      engine.lastLookAtMs = nowMs;
      summary.verified = true;
    } catch (error) {
      summary.errors.push(`active meetings: ${text(error?.message) || error}`);
    }
  }

  const plan = planLiveSessionTick({ sessions: store.sessions, activeMeetings, ...planOptions });
  summary.deferred = plan.deferred;

  // Apply what the planner changed on fresh data, field by field, so a concurrent write is kept.
  const changes = [];
  const planned = new Map(plan.sessions.map((session) => [session.key, session]));
  store = updateLiveSessionStore((current) => {
    let touched = false;
    for (const [key, session] of planned) {
      const before = store.sessions[key];
      const fresh = current.sessions[key];
      if (!before || !fresh) continue;
      const patch = changedFields(before, session);
      // Seen in the room since the plan read the store (the bot_joined webhook): its words about a bot that
      // is not in yet are stale.
      if (fresh.state === 'recording' && before.state !== 'recording') {
        delete patch.state;
        delete patch.message;
      }
      if (!Object.keys(patch).length) continue;
      current.sessions[key] = { ...fresh, ...patch, updatedAt: new Date(nowMs).toISOString() };
      noteChange(changes, normalizeLiveSession(fresh), normalizeLiveSession(current.sessions[key]));
      touched = true;
    }
    return touched ? current : undefined;
  }, { nowMs });
  for (const change of changes) {
    try {
      deps.onSessionChange?.(change);
    } catch (error) {
      summary.errors.push(`session ${change.session.key}: ${text(error?.message) || error}`);
    }
  }

  const executed = new Map();
  for (const action of plan.actions) {
    const session = store.sessions[action.key];
    if (!session) continue;
    try {
      if (action.type === 'open-meet-room') {
        const opened = await deps.openMeetRoom(normalizeLiveSession(session));
        // A room that is not open yet is asked about again next tick (the opener caches its own failures).
        if (opened && typeof opened === 'object' && opened.ok === false) continue;
        store = updateLiveSessionStore((current) => {
          if (!current.sessions[action.key]) return undefined;
          current.sessions[action.key].meetRoomRequestedAt = new Date(nowMs).toISOString();
          return current;
        }, { nowMs });
        continue;
      }
      if (action.type !== 'dispatch') continue;
      const outcome = await dispatchOnce({ deps, apiKey, action, session, plan, nowMs });
      executed.set(action.key, outcome.reason);
      if (outcome.store) store = outcome.store;
      if (outcome.attempt) {
        summary.dispatched.push({ key: action.key, kind: action.kind, ok: outcome.attempt.ok });
        try {
          deps.onDispatch?.({ session: normalizeLiveSession(store.sessions[action.key]), attempt: { ...outcome.attempt } });
        } catch (error) {
          summary.errors.push(`stamps ${action.key}: ${text(error?.message) || error}`);
        }
      }
    } catch (error) {
      summary.errors.push(`session ${action.key}: ${text(error?.message) || error}`);
      log?.warn?.(`[fireflies] live-join session=${action.key} failed: ${text(error?.message) || error}`);
    }
  }
  store = noteUnsentReasons(store, plan, executed, nowMs);

  for (const session of Object.values(store.sessions)) {
    if (!insideWatchWindow(session, nowMs)) continue;
    const reason = executed.get(session.key) ?? plan.reasons[session.key] ?? '';
    logOnce(log, session, session.state, reason);
  }
  for (const key of engine.logged.keys()) {
    if (!store.sessions[key]) engine.logged.delete(key);
  }
  return summary;
}

/**
 * A send that was due and did not go out (no key, safe mode, the rate limit, a refusal) leaves its reason on the
 * session, so a meeting that never got a bot can say why. One write, only when a reason changed.
 */
function noteUnsentReasons(store, plan, executed, nowMs) {
  const reasons = new Map();
  for (const entry of plan.deferred) {
    if (UNSENT_BY_DEFERRAL[entry.reason]) reasons.set(entry.key, UNSENT_BY_DEFERRAL[entry.reason]);
  }
  for (const [key, outcome] of executed) {
    if (UNSENT_BY_OUTCOME[outcome]) reasons.set(key, UNSENT_BY_OUTCOME[outcome]);
  }
  if (![...reasons].some(([key, reason]) => store.sessions[key] && store.sessions[key].unsentReason !== reason)) return store;
  return updateLiveSessionStore((current) => {
    let touched = false;
    for (const [key, reason] of reasons) {
      const fresh = current.sessions[key];
      if (!fresh || fresh.unsentReason === reason) continue;
      fresh.unsentReason = reason;
      touched = true;
    }
    return touched ? current : undefined;
  }, { nowMs });
}

/** When a send goes out: deps.clock() (tests), else the tick's fixed deps.nowMs, else the real clock. */
function sendClockMs(deps = {}) {
  if (typeof deps.clock === 'function') return Number(deps.clock());
  return Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
}

async function dispatchOnce({ deps, apiKey, action, session, plan, nowMs }) {
  if (!apiKey) return { reason: 'no-api-key' };
  if (typeof deps.addToLive !== 'function') return { reason: 'no-transport' };
  if (declinedOnRows(session, deps.getClient)) {
    const store = updateLiveSessionStore((current) => {
      const fresh = current.sessions[action.key];
      if (!fresh || fresh.declinedAt) return undefined;
      Object.assign(fresh, { declinedAt: new Date(nowMs).toISOString(), manualRequestedAt: '', nextAttemptAt: '' });
      return current;
    }, { nowMs });
    return { reason: 'declined', store };
  }
  // Re-check on fresh data and count the call before it is made (a crash mid-call still counts). Another
  // sender (a second hub process, a tick the watchdog let go) that got here first wins: one knock, not two.
  // The call is stamped when it goes out, not when the tick began: the look, room opens and earlier sends
  // take seconds, and a tick that took over may have sent since.
  const sentMs = sendClockMs(deps);
  const plannedSeenMs = msOf((plan.sessions || []).find((row) => row.key === action.key)?.lastSeenActiveAt) || 0;
  let skip = 'limit';
  updateLiveSessionStore((current) => {
    const fresh = current.sessions[action.key];
    if (!fresh) return undefined;
    const busy = msOf(fresh.dispatchingAt);
    if (fresh.attempts.length !== session.attempts.length || (Number.isFinite(busy) && sentMs - busy < WATCHDOG_MS)) {
      skip = 'busy';
      return undefined;
    }
    // Seen in the room since the plan (the bot_joined webhook, a tick that took over): a knock now would put
    // a second bot from the account at the door. A continuation is meant for a bot that is in.
    if (action.kind !== 'continuation'
      && (fresh.state === 'recording' || (msOf(fresh.lastSeenActiveAt) || 0) > plannedSeenMs)) {
      skip = 'seen';
      return undefined;
    }
    if (!limiterAllows(current.limiter, action.kind, sentMs, plan.reserve)) return undefined;
    skip = '';
    fresh.dispatchingAt = new Date(sentMs).toISOString();
    current.limiter = recordLiveJoinCall(current.limiter, { key: action.key, kind: action.kind, nowMs: sentMs });
    return current;
  }, { nowMs: sentMs });
  if (skip) return { reason: skip };

  let result;
  try {
    result = await deps.addToLive({ meetingLink: session.meetLink, title: session.title, durationMinutes: action.durationMinutes });
  } catch (error) {
    result = { ok: false, error };
  }
  const at = new Date(sentMs).toISOString();
  if (result?.safeMode) {
    // Never left the hub: take the call back out of the limiter and do not count an attempt.
    const store = updateLiveSessionStore((current) => {
      current.limiter.calls = current.limiter.calls.filter((call) => !(call.at === at && call.key === action.key));
      if (current.sessions[action.key]) current.sessions[action.key].dispatchingAt = '';
      return current;
    }, { nowMs });
    return { reason: 'safe-mode', store };
  }
  const failure = result?.ok ? null : classifyDispatchError(result?.error || { message: result?.message, code: '' });
  const attemptInput = {
    at,
    kind: action.kind,
    ok: Boolean(result?.ok),
    message: result?.ok ? text(result?.message) : failure.message,
    durationMinutes: action.durationMinutes,
    uncertain: Boolean(failure?.uncertain),
    rateLimited: Boolean(failure?.rateLimited),
    permanent: Boolean(failure?.permanent),
  };
  const store = updateLiveSessionStore((current) => {
    const fresh = current.sessions[action.key];
    if (!fresh) return undefined;
    current.sessions[action.key] = { ...applyLiveJoinAttempt(fresh, attemptInput), dispatchingAt: '', updatedAt: at };
    if (failure?.rateLimited) {
      // Without a retry-after (an "exceeded" answer) a short block, as the transport's: the limiter itself
      // holds the next sends until the window has room, and a full window would stop every first knock too.
      current.limiter = blockLiveJoinLimiter(current.limiter, { nowMs: sentMs, retryAfterMs: failure.retryAfterMs || MINUTE_MS, reason: failure.message });
    }
    return current;
  }, { nowMs: sentMs });
  const attempt = store.sessions[action.key]?.attempts.at(-1) || normalizeAttempt(attemptInput);
  return { reason: attempt.ok ? `sent-${action.kind}` : (failure?.rateLimited ? 'rate-limited' : 'failed'), store, attempt };
}

/**
 * A meeting.bot_joined webhook: the bot is in the room of `meetingId`. `fetchPresence(id)` resolves to
 * { meetingLink, isLive, startTime } (fetchFirefliesTranscriptPresence). Marks every session on that room that
 * is inside its window as recording and returns them, by the rules of a sighting in a look: a transcript that
 * is no longer live (a late or replayed delivery) is no bot in the room now, and a bot that started for an
 * earlier or a later meeting in a reused room is not this one's.
 */
export async function noteFirefliesBotJoined({ meetingId = '', fetchPresence, nowMs = Date.now() } = {}) {
  const id = text(meetingId);
  if (!id || typeof fetchPresence !== 'function') return [];
  const presence = await fetchPresence(id);
  if (presence?.isLive === false) return [];
  const link = normalizeFirefliesMeetLink(presence?.meetingLink);
  if (!link) return [];
  const startTime = isoOrEmpty(presence?.startTime);
  // Without Fireflies' start time, the delivery's own time stands in: the bot has just joined.
  const botStartMs = startTime ? msOf(startTime) : nowMs;
  const at = new Date(nowMs).toISOString();
  const changed = [];
  updateLiveSessionStore((current) => {
    const list = Object.values(current.sessions);
    for (const session of list) {
      if (linkOf(session) !== link || session.declinedAt || session.detachedAt) continue;
      const { startMs, endMs } = timesOf(session);
      if (nowMs > endMs + LIVE_RECORDINGS_TAIL_MS) continue;
      // Same rule as a sighting: before the first-send window the bot is another meeting's in that room.
      if (nowMs < startMs - LIVE_JOIN_FIRST_LEAD_MS && !mayHaveBotOut(session)) continue;
      if (laterMeetingBot(session, botStartMs, list)) continue;
      const next = cloneSession(session);
      markSeen(next, { id, startTime, endTime: '' }, at);
      next.updatedAt = at;
      current.sessions[session.key] = next;
      changed.push(normalizeLiveSession(next));
    }
    return changed.length ? current : undefined;
  }, { nowMs });
  return changed;
}

// ── card data ────────────────────────────────────────────────────────────────

function liveJoinAvailability({ liveJoinEnabled, apiKeyPresent } = {}) {
  if (liveJoinEnabled === false) return LIVE_JOIN_MESSAGES.safeMode;
  if (apiKeyPresent === false) return LIVE_JOIN_MESSAGES.noApiKey;
  return '';
}

function resendCheck(session, nowMs, options = {}) {
  if (liveJoinAvailability(options)) return { ok: false, reason: options.liveJoinEnabled === false ? 'safe-mode' : 'no-api-key' };
  const { startMs, endMs } = timesOf(session);
  if (session.declinedAt) return { ok: false, reason: 'declined' };
  if (session.detachedAt) return { ok: false, reason: 'not-booked' };
  if (nowMs < startMs - RESEND_LEAD_MS || nowMs > endMs + RESEND_TAIL_MS) return { ok: false, reason: 'outside-window' };
  if (session.state === 'recording') return { ok: false, reason: 'recording' };
  if (session.manualRequestedAt && nowMs - msOf(session.manualRequestedAt) <= MANUAL_REQUEST_TTL_MS) return { ok: false, reason: 'queued' };
  // A knock is at the door: a second one now would put two bots from one account in the lobby.
  const knock = lastKnockMs(session);
  if (Number.isFinite(knock) && nowMs - knock < ROOM_KNOCK_SPACING_MS) return { ok: false, reason: 'just-sent' };
  return { ok: true, reason: '' };
}

function slotRow(client, slot) {
  return (Array.isArray(client?.meetings) ? client.meetings : []).find((item) => text(item?.meetingId) === slot.stubMeetingId) || null;
}

function presentSlot(session, slot, client, nowMs, options) {
  const row = slotRow(client, slot);
  const rowState = text(row?.recording?.state);
  // Intake (missing, empty) and a rep ("declined") have the last word once they have spoken, as in
  // placeholderRecordingPatch: only a bot back in the room outranks missing/empty.
  const terminal = TERMINAL_RECORDING_STATES.has(rowState) ? rowState : '';
  const humanState = terminal && !(terminal !== 'declined' && session.state === 'recording') ? terminal : '';
  const last = session.attempts.at(-1);
  const blocked = ['recording', 'ended'].includes(session.state) ? '' : liveJoinAvailability(options);
  return {
    slotKey: slot.slotKey,
    kind: slot.kind,
    startAt: session.startAt,
    meetLink: session.meetLink,
    state: humanState || session.state,
    attempts: session.attempts.length,
    lastAttemptAt: last?.at || '',
    verifiedAt: session.firstSeenActiveAt,
    message: humanState ? (text(row?.recording?.message) || session.message) : (blocked || session.message),
    nextAttemptAt: blocked ? '' : session.nextAttemptAt,
    // After intake's missing/empty a rep may still send the bot while the meeting runs; never after "declined".
    canResend: humanState !== 'declined' && resendCheck(session, nowMs, options).ok,
    sessionKey: session.key,
    title: session.title,
    lastSeenAt: session.lastSeenActiveAt,
    hasTranscript: Boolean(session.transcriptSeenAt) || clientHasTranscriptForSession(client, session),
  };
}

/**
 * liveRecordings for jsonSalesClient: this client's booked online slots from 30 minutes before start until
 * 2 hours after the booked end, from the booking facts merged with the engine's stored state.
 */
export function presentLiveRecordings(client = {}, { nowMs = Date.now(), store = null, liveJoinEnabled = true, apiKeyPresent = true } = {}) {
  const clientId = text(client?.id);
  if (!clientId) return [];
  const sessions = (store || readLiveSessionStore()).sessions;
  const out = [];
  for (const fact of collectLiveSessions([client], nowMs)) {
    const { startMs, endMs } = timesOf(fact);
    if (nowMs < startMs - LIVE_RECORDINGS_LEAD_MS || nowMs > endMs + LIVE_RECORDINGS_TAIL_MS) continue;
    const stored = sessions[fact.key];
    const session = stored
      ? normalizeLiveSession({ ...stored, title: fact.title, slots: fact.slots })
      : newSessionFromFact({ ...fact, nextAttemptAt: iso(startMs - LIVE_JOIN_FIRST_LEAD_MS) }, '');
    if (!session) continue;
    for (const slot of fact.slots) {
      if (slot.clientId !== clientId) continue;
      out.push(presentSlot(session, slot, client, nowMs, { liveJoinEnabled, apiKeyPresent }));
    }
  }
  return out;
}

/** The stored session of one of this client's booked slots (by slot key or kind), with that slot. */
export function findLiveSessionForSlot(client = {}, { slotKey = '', kind = '', nowMs = Date.now(), store = null } = {}) {
  const wantedKey = text(slotKey);
  const wantedKind = text(kind);
  const sessions = (store || readLiveSessionStore()).sessions;
  for (const fact of collectLiveSessions([client], nowMs)) {
    const slot = fact.slots.find((entry) => entry.clientId === text(client?.id)
      && (wantedKey ? entry.slotKey === wantedKey : entry.kind === wantedKind));
    if (!slot) continue;
    const stored = sessions[fact.key];
    return { session: stored ? normalizeLiveSession({ ...stored, slots: fact.slots }) : null, slot, fact };
  }
  return null;
}

/** Session key the slot books right now ('' when it is no longer booked): writers check it before stamping. */
export function currentSessionKeyForSlot(client = {}, slot = {}, nowMs = Date.now()) {
  const found = safeBookedLiveSlots(client, nowMs).find((entry) => (
    entry.kind === text(slot.kind) && (entry.kind !== 'action' || entry.actionId === text(slot.actionId))
  ));
  return found ? sessionKeyFor(found.meetLink, found.startAt) : '';
}

/**
 * A rep's "send Fireflies again" for one slot: queued for the next tick, through the limiter. Returns
 * { queued, reason, message, recording, nextAllowedAt }.
 */
export function requestManualLiveJoin({ client = {}, slotKey = '', nowMs = Date.now(), liveJoinEnabled = true, apiKeyPresent = true } = {}) {
  const options = { liveJoinEnabled, apiKeyPresent };
  const blocked = liveJoinAvailability(options);
  if (blocked) return { queued: false, reason: liveJoinEnabled === false ? 'safe-mode' : 'no-api-key', message: blocked, recording: null, nextAllowedAt: '' };
  const fact = collectLiveSessions([client], nowMs).find((session) => session.slots.some((slot) => (
    slot.clientId === text(client?.id) && slot.slotKey === text(slotKey)
  )));
  if (!fact) {
    return { queued: false, reason: 'not-found', message: 'Fant ikke et booket nettmøte med Meet-lenke for denne luken.', recording: null, nextAllowedAt: '' };
  }
  const slot = fact.slots.find((entry) => entry.clientId === text(client?.id) && entry.slotKey === text(slotKey));
  const declinedOnRow = text(slotRow(client, slot)?.recording?.state) === 'declined';
  let outcome = { queued: false, reason: '' };
  const store = updateLiveSessionStore((current) => {
    const sessions = syncLiveSessions(current.sessions, [fact], { nowMs, full: false });
    const session = sessions[fact.key];
    const check = declinedOnRow ? { ok: false, reason: 'declined' } : resendCheck(session, nowMs, options);
    if (check.ok) {
      session.manualRequestedAt = new Date(nowMs).toISOString();
      session.message = LIVE_JOIN_MESSAGES.manual;
      outcome = { queued: true, reason: '' };
    } else {
      outcome = { queued: false, reason: check.reason };
    }
    return { ...current, sessions };
  }, { nowMs });
  const session = store.sessions[fact.key];
  const messages = {
    recording: 'Fireflies er allerede i møtet.',
    queued: 'Fireflies er allerede på vei inn.',
    'just-sent': 'Fireflies ble sendt inn for under fire minutter siden. Se etter den i lobbyen i Meet før du sender den på nytt.',
    'outside-window': 'Fireflies kan sendes inn fra 15 minutter før start til en time etter slutt.',
    declined: 'Møtet er merket som holdt uten opptak.',
    'not-booked': 'Møtet er ikke lenger booket på denne tiden.',
  };
  const reserve = upcomingFirstDispatches(Object.values(store.sessions), nowMs);
  return {
    ...outcome,
    message: outcome.queued ? LIVE_JOIN_MESSAGES.manual : (messages[outcome.reason] || ''),
    recording: session && slot ? presentSlot(session, slot, client, nowMs, options) : null,
    nextAllowedAt: liveJoinNextAllowedAt(store.limiter, nowMs, { reserve }),
  };
}

/**
 * Cache key part for lists that carry liveRecordings: the store version, plus the minute while any stored
 * session is near (the card's times and resend button move with the clock).
 */
export function liveRecordingsRevision(nowMs = Date.now()) {
  const store = readLiveSessionStore();
  const near = Object.values(store.sessions).some((session) => {
    const { startMs, endMs } = timesOf(session);
    return nowMs >= startMs - LIVE_RECORDINGS_LEAD_MS - 5 * MINUTE_MS && nowMs <= endMs + LIVE_RECORDINGS_TAIL_MS;
  });
  return `${store.updatedAt}${near ? `:${Math.floor(nowMs / MINUTE_MS)}` : ''}`;
}

/** For a health card: is the loop running, what is in its window, and what is the limiter doing. */
export function firefliesLiveJoinStatus({ nowMs = Date.now(), apiKeyPresent } = {}) {
  const store = readLiveSessionStore();
  // Same names as resolveFirefliesApiKey in lib/fireflies-webhook.js.
  const keyPresent = apiKeyPresent === undefined
    ? Boolean(text(process.env.FIREFLIES_API_KEY) || text(process.env.FIREFLIES_API))
    : Boolean(apiKeyPresent);
  const inWindow = Object.values(store.sessions).filter((session) => insideWatchWindow(session, nowMs));
  const reserve = upcomingFirstDispatches(Object.values(store.sessions), nowMs);
  return {
    lastTickAt: engine.lastTickAt,
    lastError: engine.lastError,
    // The last tick without errors, and since when every tick has had one ('' while ticks pass).
    lastOkTickAt: engine.lastOkTickAt,
    failingSince: engine.failingSince,
    running: engine.running,
    lastTick: engine.lastSummary
      ? { at: engine.lastSummary.at, verified: Boolean(engine.lastSummary.verified), dispatched: (engine.lastSummary.dispatched || []).length, errors: (engine.lastSummary.errors || []).length }
      : null,
    sessionsInWindow: inWindow.length,
    sessions: inWindow.map((session) => ({
      key: session.key,
      startAt: session.startAt,
      state: session.state,
      attempts: session.attempts.length,
      lastAttemptAt: session.attempts.at(-1)?.at || '',
      verifiedAt: session.firstSeenActiveAt,
      nextAttemptAt: session.nextAttemptAt,
      unsentReason: session.dispatchedAt ? '' : session.unsentReason,
      lobbyAlertAt: session.lobbyAlertAt,
    })),
    limiter: {
      limit: LIVE_JOIN_LIMIT,
      windowMinutes: LIVE_JOIN_LIMIT_WINDOW_MS / MINUTE_MS,
      callsInWindow: callsInWindow(store.limiter, nowMs).length,
      blockedUntil: limiterBlockedUntilMs(store.limiter, nowMs) ? store.limiter.blockedUntil : '',
      nextAllowedAt: liveJoinNextAllowedAt(store.limiter, nowMs, { reserve }),
    },
    apiKeyPresent: keyPresent,
    safeModeBlocking: isSafeModeActive() && !safeModeAllows('firefliesLiveJoin') && keyPresent,
    keyOwnerEmail: firefliesKeyOwnerEmail(),
    // FIREFLIES_LIVE_JOIN_ONE_BOT as the last tick ran with it.
    oneBot: Boolean(engine.lastSummary?.oneBot),
  };
}

export function resetFirefliesLiveJoinEngineForTests() {
  engine.running = false;
  engine.startedAt = 0;
  engine.lastTickAt = '';
  engine.lastError = '';
  engine.lastSummary = null;
  engine.lastLookAtMs = 0;
  engine.lastOkTickAt = '';
  engine.failingSince = '';
  engine.logged = new Map();
  brokenClientsLogged.clear();
}
