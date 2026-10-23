/**
 * Missing-recording watchdog, one step of the Fireflies ingest tick.
 *
 * Every booked online meeting the bot was sent to keeps a placeholder on client.meetings
 * ('live:…', isPlaceholderMeetingId) until a real transcript replaces it. Capture writes
 * scheduled / dispatched / recording / ended / not-admitted on its `recording` object
 * (lib/fireflies-recording-state.js); this module takes over once the session is over:
 *   - while capture still sees the bot in the room (state 'recording', lastSeenAt fresh) the
 *     meeting is on, however long it runs;
 *   - it looks for the transcript by recording.ffMeetingId (the active_meetings id is the
 *     transcript id), else by transcripts(fromDate: start - 1 h, toDate: start + 4 h) matched on
 *     the normalized Meet link and a start inside the session (half an hour before the booked
 *     start to the session's end), so a later meeting in the same room is not taken for this
 *     one, nor an earlier one's recording by the id of its bot still in the room. A title match,
 *     or the room at another time, is only offered as a candidate;
 *   - a transcript with talk is stored and linked to the client, which drops the placeholder.
 *     Live captions are never linked, nor stored from here: they are "not yet". One Fireflies is
 *     still processing keeps it waiting;
 *   - at the session's end (start + booked, else 60 minutes, or later when capture saw the bot
 *     later) + 90 minutes with nothing found it sets 'missing' and sends one e-mail to the team
 *     and the owning rep; a recording Fireflies has still not finished three hours after that
 *     counts as missing too. With only a finished recording with no talk on the room by then it
 *     sets 'empty', with its own one e-mail: a bot that sat alone in an open room leaves such a
 *     fragment early in many meetings that are recorded after all, so it is never decided sooner.
 *     A missing or empty meeting is looked for hourly for 48 hours after its deadline, so a late
 *     transcript still links.
 * Placeholders capture wrote for a meeting the bot never got into ('not-admitted', sent or never
 * sent) are followed the same way. Lookups run at most every 10 minutes per placeholder, three per
 * tick. A try-later error (rate limit, network, safe mode) never makes a meeting missing.
 */
import { normalizeFirefliesMeetLink } from './fireflies-client-match.js';
import { TERMINAL_RECORDING_STATES, sessionKeyFor, slotKindFromKey } from './fireflies-recording-state.js';
import { hydrateFirefliesTranscript, isTryLaterError } from './fireflies-ingest.js';
import {
  LIVE_JOIN_DISPATCH_UNTIL_MS,
  LIVE_JOIN_MESSAGES,
  NEVER_SENT_FAILED_LEAD,
  bookedSlotForKey,
  clientHasTranscriptForSession,
  readLiveSessionStore,
  recordingForLiveSession,
} from './fireflies-live-sessions.js';
import {
  buildFirefliesListRecord,
  fetchFirefliesTranscript,
  fetchRecentFirefliesTranscripts,
  listStoredFirefliesMeetings,
  readStoredFirefliesMeeting,
  storedMeetingHasTalk,
  storedMeetingIsEmptyFinal,
  storedMeetingIsFinal,
  storedMeetingIsPartial,
  upsertListedFirefliesMeetings,
} from './fireflies-webhook.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_BOOKED_MINUTES = 60;
/** Minutes after the session's end before a meeting with no recording counts as missing. */
export const MISSING_GRACE_MS = 90 * MINUTE_MS;
/** A recording on the room that Fireflies has still not finished this long after the deadline counts as missing. */
export const PENDING_GRACE_MS = 3 * HOUR_MS;
export const WATCHDOG_CHECK_EVERY_MS = 10 * MINUTE_MS;
export const WATCHDOG_MISSING_CHECK_EVERY_MS = HOUR_MS;
/** A missing meeting is looked for, and alerted about, this long after its deadline. */
export const WATCHDOG_MISSING_WATCH_MS = 48 * HOUR_MS;
const SEARCH_BEFORE_MS = HOUR_MS;
const SEARCH_AFTER_MS = 4 * HOUR_MS;
// A transcript on the room is this session's when it starts between this long before the booked
// start and the session's end: sales rooms are reused, so a later meeting there is another one.
const ROOM_MATCH_BEFORE_MS = 30 * MINUTE_MS;
// Capture saw the bot in the room this recently: the meeting is still on.
const RECORDING_FRESH_MS = 10 * MINUTE_MS;
const MAX_LOOKUPS_PER_TICK = 3;
// Capture's "never sent" copy (lib/fireflies-live-sessions.js notAdmittedMessage), quoted in the e-mail.
const NEVER_SENT_MESSAGES = new Set([
  LIVE_JOIN_MESSAGES.neverSent,
  LIVE_JOIN_MESSAGES.neverSentNoKey,
  LIVE_JOIN_MESSAGES.neverSentLimited,
  LIVE_JOIN_MESSAGES.neverSentSafeMode,
]);

function text(value) {
  return String(value ?? '').trim();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function isPlaceholderId(id = '') {
  return text(id).toLowerCase().startsWith('live:');
}

function startMs(row = {}) {
  return Date.parse(text(row.startedAt));
}

/** The booked length: the placeholder's durationMinutes when capture sets it, else 60. */
export function placeholderBookedMinutes(row = {}) {
  const minutes = Number(row.durationMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_BOOKED_MINUTES;
}

/** The booked end, or later when capture saw the bot in the room later (lastSeenAt, endedAt). */
export function placeholderSessionEndMs(row = {}) {
  const booked = startMs(row) + placeholderBookedMinutes(row) * MINUTE_MS;
  const seen = [row.recording?.lastSeenAt, row.recording?.endedAt]
    .map((value) => Date.parse(text(value)))
    .filter(Number.isFinite);
  return Math.max(booked, ...seen);
}

/** Session end + 90 minutes: after this, no transcript means the recording is missing. */
export function recordingDeadlineMs(row = {}) {
  return placeholderSessionEndMs(row) + MISSING_GRACE_MS;
}

/** Does this record start inside the placeholder's session (half an hour before the booked start to its end)? */
function startsInSession(placeholder, record) {
  const at = Date.parse(text(record?.startedAt));
  return Number.isFinite(at) && at >= startMs(placeholder) - ROOM_MATCH_BEFORE_MS && at <= placeholderSessionEndMs(placeholder);
}

/** Does this record (stored or listed: startedAt, meetingLink) start in the placeholder's room and session? */
function inSession(placeholder, record) {
  const link = normalizeFirefliesMeetLink(placeholder.meetLink);
  if (!link || normalizeFirefliesMeetLink(record?.meetingLink || record?.meetLink) !== link) return false;
  return startsInSession(placeholder, record);
}

/**
 * The recording of the bot capture saw is this session's only when it started in the session: in a
 * reused room, an earlier meeting that ran over still has its bot there at this one's start. A record
 * with no start time is taken on its id.
 */
function byIdInSession(placeholder, record) {
  return !Number.isFinite(Date.parse(text(record?.startedAt))) || startsInSession(placeholder, record);
}

/**
 * A real (non-placeholder) row with talk on the client already covers this session: the bot's
 * recording, one in this room and session, or one resolved to this slot within the session. A
 * silent fragment is not the recording.
 */
function sessionLinked(client = {}, placeholder = {}) {
  const ffId = text(placeholder.recording?.ffMeetingId);
  const slotKey = text(placeholder.slotKey);
  return (Array.isArray(client.meetings) ? client.meetings : []).some((row) => {
    const id = text(row?.meetingId);
    if (!id || isPlaceholderId(id) || !(row.hasTranscript || text(row.summary))) return false;
    if ((ffId && id === ffId && byIdInSession(placeholder, row)) || inSession(placeholder, row)) return true;
    if (!slotKey || text(row.slotKey) !== slotKey) return false;
    return startsInSession(placeholder, row);
  });
}

// No usable recording, but a late one may still come: looked for hourly within the watch.
const WATCHED_STATES = new Set(['missing', 'empty']);

/**
 * What to do for one placeholder now: { action: 'skip', reason } or
 * { action: 'lookup', deadlineMs, overdue }. `checkedMs` is the last lookup this process made.
 */
export function planPlaceholderCheck(row = {}, { nowMs = Date.now(), checkedMs = 0 } = {}) {
  const skip = (reason) => ({ action: 'skip', reason });
  if (!isPlaceholderId(row?.meetingId)) return skip('not-a-placeholder');
  const state = text(row.recording?.state);
  const watched = WATCHED_STATES.has(state);
  if (TERMINAL_RECORDING_STATES.has(state) && !watched) return skip('done');
  const start = startMs(row);
  if (!Number.isFinite(start) || start > nowMs) return skip('not-started');
  const seen = Date.parse(text(row.recording?.lastSeenAt));
  if (state === 'recording' && Number.isFinite(seen) && nowMs - seen < RECORDING_FRESH_MS) return skip('in-session');
  const bookedEnd = start + placeholderBookedMinutes(row) * MINUTE_MS;
  if (state !== 'ended' && !watched && nowMs < bookedEnd) return skip('in-session');
  const deadlineMs = recordingDeadlineMs(row);
  const last = Math.max(Number(checkedMs) || 0, Date.parse(text(row.recording?.checkedAt)) || 0);
  // Long past the deadline: one look decides it (without an e-mail); after that, nothing.
  if (nowMs - deadlineMs > WATCHDOG_MISSING_WATCH_MS && (watched || last)) return skip('watch-over');
  const every = watched ? WATCHDOG_MISSING_CHECK_EVERY_MS : WATCHDOG_CHECK_EVERY_MS;
  if (last && nowMs - last < every) return skip('checked-lately');
  return { action: 'lookup', deadlineMs, overdue: nowMs >= deadlineMs };
}

function normalizedTitle(value = '') {
  return text(value).toLowerCase().replace(/\s+/g, ' ');
}

/** Talk Fireflies is done recording (not live captions). */
function usable(record) {
  return storedMeetingHasTalk(record) && !storedMeetingIsPartial(record);
}

function sentences(record = {}) {
  return Number(record.sentenceCount) || text(record.transcript).length;
}

function bestUsable(rows = []) {
  return rows.filter(usable).sort((a, b) => sentences(b) - sentences(a))[0] || null;
}

/**
 * Find this session's transcript. Returns { found, empty, pending, candidates }:
 *   found       a record with talk that is not live captions (by id, or on the room in the session);
 *   empty       a finished record on the room with no talk;
 *   pending     a record exists but Fireflies is not done with it (live, or still processing);
 *   candidates  [{ meetingId, title, startedAt, transcriptUrl, why: 'title' | 'room' }]: the hub's
 *               title in another room, or this room at another time.
 * Throws try-later errors so the caller can stop for this tick.
 */
export async function lookupPlaceholderTranscript(placeholder = {}, {
  apiKey,
  nowMs = Date.now(),
  listTranscripts = fetchRecentFirefliesTranscripts,
  fetchTranscript = fetchFirefliesTranscript,
  // Only answers worth keeping are stored. Live captions and the empty answer Fireflies gives for a
  // few minutes after the call are looked at and left out: other steps would link them.
  hydrate = (id) => hydrateFirefliesTranscript(id, {
    apiKey,
    nowMs,
    fetchTranscript,
    keep: (record) => usable(record) || storedMeetingIsFinal(record, { nowMs }),
  }),
  readStored = readStoredFirefliesMeeting,
  storedRows = () => listStoredFirefliesMeetings(),
} = {}) {
  const link = normalizeFirefliesMeetLink(placeholder.meetLink);
  const start = startMs(placeholder);
  const outcome = { found: null, empty: null, pending: false, candidates: [] };
  const offer = (record, why) => {
    const meetingId = text(record?.meetingId);
    if (!meetingId || outcome.candidates.some((row) => row.meetingId === meetingId)) return;
    outcome.candidates.push({ meetingId, title: record.title, startedAt: record.startedAt, transcriptUrl: record.transcriptUrl, why });
  };
  const settle = (record) => {
    if (!record) return;
    if (usable(record)) {
      if (!outcome.found || sentences(record) > sentences(outcome.found)) outcome.found = record;
    } else if (storedMeetingIsEmptyFinal(record, { nowMs })) {
      outcome.empty = outcome.empty || record;
    } else {
      outcome.pending = true;
    }
  };
  const fetchOne = async (id) => {
    const known = readStored(id);
    if (known && storedMeetingIsFinal(known, { nowMs })) return known;
    const result = await hydrate(id);
    if (result?.outcome === 'later') throw result.error || new Error('Fireflies asked to wait.');
    return result?.outcome === 'fetched' ? result.record : known;
  };

  // 1. What the archive already holds: the id capture saw, or this room in this session. The bot
  // of an earlier meeting in a reused room is only offered: its recording is that meeting's.
  const ffId = text(placeholder.recording?.ffMeetingId);
  const byId = ffId ? readStored(ffId) : null;
  const earlier = Boolean(byId) && !byIdInSession(placeholder, byId);
  if (earlier) offer(byId, 'room');
  const storedBest = bestUsable([...(byId && !earlier ? [byId] : []), ...storedRows().filter((row) => inSession(placeholder, row))]);
  if (storedBest) {
    outcome.found = storedBest;
    return outcome;
  }

  // 2. The id capture saw in active_meetings is the transcript id.
  if (ffId && !earlier) {
    const record = await fetchOne(ffId);
    if (record && !byIdInSession(placeholder, record)) offer(record, 'room');
    else settle(record);
  }
  if (outcome.found) return outcome;

  // 3. Ask Fireflies for everything around the booked time and match on the room and session.
  const rows = await listTranscripts({ apiKey, limit: 50, fromDate: start - SEARCH_BEFORE_MS, toDate: start + SEARCH_AFTER_MS });
  upsertListedFirefliesMeetings(rows.map(buildFirefliesListRecord), { nowMs });
  const title = normalizedTitle(placeholder.title);
  for (const row of rows) {
    const record = buildFirefliesListRecord(row);
    const id = record.meetingId;
    if (!id || id === ffId) continue;
    const sameRoom = Boolean(link) && normalizeFirefliesMeetLink(record.meetingLink) === link;
    if (sameRoom && inSession(placeholder, record)) {
      settle(await fetchOne(id));
    } else if (sameRoom || (title && normalizedTitle(record.title) === title)) {
      offer(record, sameRoom ? 'room' : 'title');
    }
  }
  return outcome;
}

function osloTime(value = '') {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('nb-NO', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Oslo' });
}

function meetingNoun(placeholder = {}) {
  const kind = slotKindFromKey(placeholder.slotKey) || text(placeholder.purpose);
  if (kind === 'sales' || placeholder.forSalesMeeting) return 'salgsmøtet';
  if (kind === 'workshop') return 'workshopen';
  if (kind === 'iteration') return 'iterasjonsmøtet';
  return 'møtet';
}

/**
 * What capture knew before the deadline, in one line. A 'not-admitted' row with no accepted send
 * never had a bot: its own message says why (no key, the rate limit, never sent).
 */
function stateLine(state = '', recording = {}) {
  if (state === 'not-admitted') {
    if (text(recording.dispatchedAt)) return 'Fireflies-boten ble sendt inn, men ble aldri sluppet inn i møtet.';
    // Capture's own copy says why; a later waiting note on the row does not.
    const why = text(recording.message);
    return NEVER_SENT_MESSAGES.has(why) || why.startsWith(NEVER_SENT_FAILED_LEAD) ? why : 'Fireflies ble aldri sendt inn i møtet.';
  }
  if (state === 'recording' || state === 'ended') return 'Fireflies var i møtet, men opptaket har ikke kommet inn.';
  if (state === 'dispatched') return 'Fireflies-boten ble sendt inn, men ble ikke sett i møtet.';
  return 'Fireflies har ikke noe opptak fra Meet-rommet i møtetiden.';
}

/** The short "why" kept on a missing row of a meeting the bot never got into. */
function notAdmittedNote(recording = {}) {
  if (text(recording.state) !== 'not-admitted') return '';
  return text(recording.dispatchedAt) ? ' Fireflies ble aldri sluppet inn.' : ' Fireflies ble aldri sendt inn.';
}

function candidateLine(row = {}) {
  const when = row.startedAt ? ` (${osloTime(row.startedAt)})` : '';
  const where = row.why === 'room'
    ? 'fra samme Meet-rom til en annen tid'
    : 'med samme tittel fra et annet Meet-rom';
  return `Fireflies har et opptak ${where}: «${row.title}»${when}. Er det dette møtet, lim inn lenken: ${row.transcriptUrl}`;
}

const TODO_LINES = [
  'Hva du kan gjøre:',
  '- Har noen opptaket i Fireflies (for eksempel i en egen konto)? Lim inn Fireflies-lenken under Bytt opptak på Tilbud.',
  '- Finnes det ikke noe opptak: skriv produktnotater på kundekortet, så kan tilbudet skrives fra dem.',
  '- Ble møtet holdt uten opptak med vilje, eller ble det ikke holdt? Marker møtet som uten opptak på kundekortet.',
];

function recipientList(to = []) {
  return [...new Set((Array.isArray(to) ? to : [to]).map((email) => text(email).toLowerCase()).filter(Boolean))].join(', ');
}

function withoutDoubleBlanks(lines = []) {
  return lines.filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''));
}

/** The one e-mail about a missing recording (Norwegian, to the team and the owning rep). */
export function buildMissingRecordingEmail({
  client = {},
  placeholder = {},
  to = [],
  previousState = '',
  previousRecording = null,
  candidates = [],
  unfinished = false,
} = {}) {
  const business = text(client.businessName) || 'kunden';
  const noun = meetingNoun(placeholder);
  const when = osloTime(placeholder.startedAt);
  const lines = withoutDoubleBlanks([
    `Det finnes ikke noe Fireflies-opptak av ${noun} med ${business}${when ? ` (${when})` : ''}.`,
    unfinished
      ? 'Fireflies har et opptak fra Meet-rommet, men er fortsatt ikke ferdig med det flere timer etter møtet.'
      : stateLine(previousState, previousRecording || placeholder.recording || {}),
    text(placeholder.meetLink) ? `Meet: ${text(placeholder.meetLink)}` : '',
    '',
    ...TODO_LINES,
    ...candidates.slice(0, 3).map(candidateLine),
    '',
    'Asoldi ser etter opptaket hver time i 48 timer til. Kommer det, kobles det til kunden av seg selv.',
  ]);
  return {
    to: recipientList(to),
    subject: `Fireflies: ingen opptak av ${noun} med ${business}`,
    text: lines.join('\n'),
  };
}

/** The one e-mail about a recording with no talk (Norwegian, to the team and the owning rep). */
export function buildEmptyRecordingEmail({
  client = {},
  placeholder = {},
  to = [],
  candidates = [],
} = {}) {
  const business = text(client.businessName) || 'kunden';
  const noun = meetingNoun(placeholder);
  const when = osloTime(placeholder.startedAt);
  const lines = withoutDoubleBlanks([
    `Fireflies var med på ${noun} med ${business}${when ? ` (${when})` : ''}, men opptaket er tomt: ingen tale, eller for kort.`,
    'Det betyr som regel at notetakeren satt alene i Meet-rommet, eller at møtet ble holdt et annet sted.',
    text(placeholder.meetLink) ? `Meet: ${text(placeholder.meetLink)}` : '',
    '',
    ...TODO_LINES,
    ...candidates.slice(0, 3).map(candidateLine),
    '',
    'Asoldi ser etter et opptak med tale hver time i 48 timer til. Kommer det, kobles det til kunden av seg selv.',
  ]);
  return {
    to: recipientList(to),
    subject: `Fireflies: tomt opptak av ${noun} med ${business}`,
    text: lines.join('\n'),
  };
}

/**
 * The recording patch for "Marker uten opptak": a person says the meeting was held without a
 * recording, or not held. Only on a placeholder; the watchdog stops looking ('declined' is final).
 * Returns { recording } or { error: 'not-a-placeholder' }.
 */
export function declinedRecordingPatch(row = {}, { by = '', nowMs = Date.now() } = {}) {
  if (!isPlaceholderId(row?.meetingId)) return { error: 'not-a-placeholder' };
  const who = text(by);
  return {
    recording: {
      state: 'declined',
      checkedAt: iso(nowMs),
      message: `Markert som uten opptak${who ? ` av ${who}` : ''}.`,
    },
  };
}

function sessionKeyOfRow(row = {}) {
  return text(row.recording?.sessionKey) || sessionKeyFor(row.meetLink, row.startedAt);
}

/**
 * The recording patch that undoes a rep's "uten opptak": back to what the watchdog and capture
 * know. A meeting that had already been reported missing stays reported (no second e-mail). With
 * no session yet (the engine collects 36 hours ahead) a meeting whose first send is still to come
 * is scheduled again.
 */
function reopenedRecording(row = {}, session = null, who = '', nowMs = Date.now()) {
  const current = row.recording || {};
  const by = who ? ` av ${who}` : '';
  if (text(current.missingAt)) {
    return { state: 'missing', checkedAt: '', message: `Åpnet igjen${by}. Ingen Fireflies-opptak etter møtet.` };
  }
  if (session) return { ...recordingForLiveSession(session), checkedAt: '' };
  if (nowMs <= startMs(row) + LIVE_JOIN_DISPATCH_UNTIL_MS) {
    return { state: 'scheduled', checkedAt: '', message: LIVE_JOIN_MESSAGES.scheduled };
  }
  return {
    state: text(current.dispatchedAt) ? 'ended' : 'not-admitted',
    checkedAt: '',
    message: `Åpnet igjen${by}. Asoldi ser etter opptaket.`,
  };
}

/**
 * POST /api/admin/sales/:id/fireflies/recording: "Marker uten opptak" ('declined') and its undo
 * ('open') for one meeting of a client, by meetingId (a placeholder) or slotKey (the slot's
 * placeholder, or, for 'declined', a booked slot with no row yet, which gets one). Returns
 *   { error: 'bad-state' | 'not-found' | 'has-recording' }, or
 *   { meetingId, sessionKey, declined, recording (patch for the row, or null: nothing to change),
 *     create ({ slot, session, recording } for a new placeholder, or null) }.
 */
export function recordingDecision({
  client = {},
  meetingId = '',
  slotKey = '',
  state = '',
  by = '',
  nowMs = Date.now(),
  store = null,
} = {}) {
  const wanted = text(state);
  if (wanted !== 'declined' && wanted !== 'open') return { error: 'bad-state' };
  const rows = Array.isArray(client?.meetings) ? client.meetings : [];
  const id = text(meetingId);
  const key = text(slotKey);
  const slot = !id && key ? bookedSlotForKey(client, key, nowMs) : null;
  let row = null;
  if (id) {
    row = rows.find((item) => text(item?.meetingId) === id) || null;
  } else if (slot) {
    // A booked slot is its current booking's row only: a moved Møte keeps its key, and the row of
    // the time it was moved from belongs to that earlier meeting.
    row = rows.find((item) => text(item?.meetingId) === slot.stubMeetingId) || null;
  } else if (key) {
    // No longer booked: the slot's newest placeholder.
    row = rows.filter((item) => text(item?.slotKey) === key && isPlaceholderId(item?.meetingId))
      .sort((a, b) => (startMs(b) || 0) - (startMs(a) || 0))[0]
      || null;
  }
  if (row && !isPlaceholderId(row.meetingId)) return { error: 'not-found' };
  const sessions = (store || readLiveSessionStore()).sessions || {};
  if (wanted === 'declined') {
    if (row) {
      const decided = declinedRecordingPatch(row, { by, nowMs });
      return { meetingId: text(row.meetingId), sessionKey: sessionKeyOfRow(row), declined: true, recording: decided.recording, create: null };
    }
    if (!slot) return { error: 'not-found' };
    const sessionKey = sessionKeyFor(slot.meetLink, slot.startAt);
    const session = sessions[sessionKey] || null;
    // Its recording with talk is already linked: not a meeting held without one.
    if (clientHasTranscriptForSession(client, { ...slot, ...(session || {}), slots: [slot] })) return { error: 'has-recording' };
    const decided = declinedRecordingPatch({ meetingId: slot.stubMeetingId }, { by, nowMs });
    return {
      meetingId: slot.stubMeetingId,
      sessionKey,
      declined: true,
      recording: null,
      create: {
        slot,
        session,
        recording: { ...(session ? recordingForLiveSession(session) : { sessionKey }), ...decided.recording },
      },
    };
  }
  if (!row) {
    if (!slot) return { error: 'not-found' };
    // A booked slot with no row has nothing to undo; the route still clears a stray "declined" on its session.
    return { meetingId: slot.stubMeetingId, sessionKey: sessionKeyFor(slot.meetLink, slot.startAt), declined: false, recording: null, create: null };
  }
  const sessionKey = sessionKeyOfRow(row);
  // Nothing to undo: the route still clears a stray "declined" on the session.
  if (text(row.recording?.state) !== 'declined') return { meetingId: text(row.meetingId), sessionKey, declined: false, recording: null, create: null };
  return {
    meetingId: text(row.meetingId),
    sessionKey,
    declined: false,
    recording: reopenedRecording(row, sessions[sessionKey] || null, text(by), nowMs),
    create: null,
  };
}

const MISSING_LIST_STATES = new Set(['missing', 'empty', 'not-admitted']);

function rowKind(row = {}) {
  const kind = slotKindFromKey(row.slotKey);
  if (kind) return kind;
  if (['sales', 'workshop', 'iteration'].includes(text(row.purpose))) return text(row.purpose);
  return row.forSalesMeeting ? 'sales' : '';
}

/**
 * GET /api/admin/fireflies/missing-recordings: the placeholders of booked online meetings that
 * have no recording with talk linked and are past their deadline, or that capture or the watchdog
 * already called 'not-admitted', 'missing' or 'empty'. Declined ones are left out. Newest first,
 * the last `days` days; `canAccess(client)` filters the clients a rep may see.
 * Returns { rows: [{ clientId, businessName, ownerId, meetingId, slotKey, kind, startedAt, meetLink,
 * title, state: 'missing' | 'empty' | 'not-admitted', message, missingAt, alertedAt }], count }.
 */
export function missingRecordingRows(clients = [], { nowMs = Date.now(), days = 60, canAccess = () => true } = {}) {
  const since = nowMs - days * DAY_MS;
  const rows = [];
  for (const client of Array.isArray(clients) ? clients : []) {
    if (!client?.id || !canAccess(client)) continue;
    for (const row of Array.isArray(client.meetings) ? client.meetings : []) {
      if (!isPlaceholderId(row?.meetingId)) continue;
      const start = startMs(row);
      if (!Number.isFinite(start) || start < since || start > nowMs) continue;
      const recording = row.recording || {};
      const current = text(recording.state);
      if (current === 'declined' || sessionLinked(client, row)) continue;
      // Past the deadline with no recording is missing, whatever the watchdog has had time to write.
      const state = MISSING_LIST_STATES.has(current) ? current : (nowMs >= recordingDeadlineMs(row) ? 'missing' : '');
      if (!state) continue;
      rows.push({
        clientId: text(client.id),
        businessName: text(client.businessName),
        ownerId: text(client.ownerId),
        meetingId: text(row.meetingId),
        slotKey: text(row.slotKey),
        kind: rowKind(row),
        startedAt: new Date(start).toISOString(),
        meetLink: text(row.meetLink),
        title: text(row.title),
        state,
        message: state === current ? text(recording.message) : 'Ingen Fireflies-opptak etter møtet.',
        missingAt: text(recording.missingAt),
        alertedAt: text(recording.alertedAt),
      });
    }
  }
  rows.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.meetingId.localeCompare(b.meetingId));
  return { rows, count: rows.length };
}

const lastLookups = new Map();

function lookupKey(clientId, meetingId) {
  return `${clientId}|${meetingId}`;
}

function alerted(recording = {}) {
  const alertedAt = Date.parse(text(recording.alertedAt));
  const missingAt = Date.parse(text(recording.missingAt));
  return Number.isFinite(alertedAt) && Number.isFinite(missingAt) && alertedAt >= missingAt;
}

/**
 * Check every placeholder whose session is over. deps:
 *   getClients()                                   sales clients (fresh each call);
 *   linkTranscript(clientId, record, placeholder)  store-backed client link (server.js linkStoredTranscriptToClient);
 *   patchPlaceholder(clientId, meetingId, recording)  merge into the row's recording (sales.patchSalesClientMeeting);
 *   recipientsFor(client)                          [team address, owning rep's e-mail] (may be async);
 *   sendEmail(message)                             the hub mailer.
 * Returns { checked, linked, empty, missing, alerted, failed, paused,
 *           health: { missingPlaceholders, lookups, lookupErrors, lastLookupError } }:
 * lookups counts the ones that ran to an answer or a real error (not a try-later pause).
 */
export async function runFirefliesRecordingWatchdog({
  getClients,
  apiKey,
  linkTranscript,
  patchPlaceholder,
  recipientsFor = () => [],
  sendEmail,
  nowMs = Date.now(),
  maxLookups = MAX_LOOKUPS_PER_TICK,
  lookup = (placeholder) => lookupPlaceholderTranscript(placeholder, { apiKey, nowMs }),
  log = console,
} = {}) {
  const summary = { checked: [], linked: [], empty: [], missing: [], alerted: [], failed: [], paused: '' };
  let lastLookupError = '';
  const due = [];
  for (const client of getClients()) {
    for (const row of Array.isArray(client?.meetings) ? client.meetings : []) {
      if (!isPlaceholderId(row?.meetingId)) continue;
      const key = lookupKey(client.id, row.meetingId);
      const plan = planPlaceholderCheck(row, { nowMs, checkedMs: lastLookups.get(key) });
      if (plan.action !== 'lookup' || sessionLinked(client, row)) continue;
      due.push({ client, row, plan, key });
    }
  }
  // The newest deadlines first, so a meeting that just ended is never queued behind old ones.
  due.sort((a, b) => b.plan.deadlineMs - a.plan.deadlineMs);

  for (const { client, row, plan, key } of due) {
    if (summary.checked.length >= maxLookups || summary.paused) break;
    const meetingId = text(row.meetingId);
    const previousState = text(row.recording?.state);
    // As the row was before this lookup's own patches (e-mail copy and the kept "why").
    const previousRecording = { ...(row.recording || {}) };
    lastLookups.set(key, nowMs);
    if (lastLookups.size > 2000) lastLookups.delete(lastLookups.keys().next().value);
    summary.checked.push(meetingId);
    let result;
    try {
      result = await lookup(row);
    } catch (error) {
      if (isTryLaterError(error)) {
        // Fireflies or the network asked us to wait: nothing is decided about this meeting.
        summary.paused = text(error?.message) || 'try later';
        log.warn?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} paused: ${summary.paused}`);
        break;
      }
      summary.failed.push(meetingId);
      lastLookupError = text(error?.message) || String(error);
      log.warn?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} ${lastLookupError}`);
      continue;
    }
    try {
      if (result.found) {
        // The link drops the placeholder; should it stay (another slot), it says what was found.
        await linkTranscript(client.id, result.found, row);
        if (previousState) {
          patchPlaceholder(client.id, meetingId, {
            // A late transcript: the meeting is no longer missing (or empty).
            ...(WATCHED_STATES.has(previousState) ? { state: 'ended' } : {}),
            ffMeetingId: text(result.found.meetingId),
            checkedAt: iso(nowMs),
            message: 'Opptaket er funnet og koblet til kunden.',
          });
        }
        summary.linked.push(meetingId);
        log.log?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} linked ${text(result.found.meetingId)}`);
        continue;
      }
      const candidateNote = result.candidates.length
        ? ` Mulige opptak å sjekke: ${result.candidates.map((row2) => row2.meetingId).join(', ')}.`
        : '';
      // Something on the room is still in Fireflies' hands: wait for it, even next to an empty
      // fragment, until it has had hours more than any meeting needs.
      const unfinished = result.pending && nowMs >= plan.deadlineMs + PENDING_GRACE_MS;
      if (result.pending && !unfinished) {
        // Capture owns the earlier states; a row without one keeps its throttle in memory.
        if (previousState) {
          patchPlaceholder(client.id, meetingId, { checkedAt: iso(nowMs), message: 'Fireflies behandler fortsatt opptaket.' });
        }
        continue;
      }
      const empty = Boolean(result.empty) && !result.pending;
      if (!plan.overdue) {
        // Before the deadline nothing is decided: a silent fragment is often a bot that sat alone
        // before the meeting that was then recorded after all.
        if (!previousState) continue;
        if (empty) {
          patchPlaceholder(client.id, meetingId, { checkedAt: iso(nowMs), message: `Fireflies har bare et tomt opptak fra møtet så langt.${candidateNote}` });
        } else if (previousState === 'not-admitted') {
          // Keep capture's "why" (never sent, never let in).
          patchPlaceholder(client.id, meetingId, { checkedAt: iso(nowMs) });
        } else {
          patchPlaceholder(client.id, meetingId, { checkedAt: iso(nowMs), message: `Venter på opptaket fra Fireflies.${candidateNote}` });
        }
        continue;
      }
      const recording = previousRecording;
      // Missing and empty share one stamp: the team hears once that this meeting has no usable recording.
      const missingAt = WATCHED_STATES.has(previousState) && text(recording.missingAt) ? text(recording.missingAt) : iso(nowMs);
      const state = empty ? 'empty' : 'missing';
      patchPlaceholder(client.id, meetingId, {
        state,
        missingAt,
        checkedAt: iso(nowMs),
        ...(empty ? { ffMeetingId: text(result.empty.meetingId) } : {}),
        message: empty
          ? `Fireflies var med, men opptaket er tomt (ingen tale, eller for kort).${candidateNote}`
          : `${unfinished ? 'Fireflies ble aldri ferdig med opptaket.' : `Ingen Fireflies-opptak etter møtet.${notAdmittedNote(recording)}`}${candidateNote}`,
      });
      if (previousState !== state) summary[empty ? 'empty' : 'missing'].push(meetingId);
      // One e-mail, while the deadline is recent. alertedAt is claimed before the send.
      const fresh = nowMs - plan.deadlineMs <= WATCHDOG_MISSING_WATCH_MS;
      if (fresh && typeof sendEmail === 'function' && !alerted({ ...recording, missingAt })) {
        const to = await recipientsFor(client);
        const email = empty
          ? buildEmptyRecordingEmail({ client, placeholder: row, to, candidates: result.candidates })
          : buildMissingRecordingEmail({
            client,
            placeholder: row,
            to,
            previousState: WATCHED_STATES.has(previousState) ? '' : previousState,
            previousRecording: recording,
            candidates: result.candidates,
            unfinished,
          });
        if (email.to) {
          patchPlaceholder(client.id, meetingId, { alertedAt: iso(nowMs) });
          try {
            await sendEmail(email);
            summary.alerted.push(meetingId);
            log.warn?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} ${state}, alert sent to ${email.to}`);
          } catch (error) {
            patchPlaceholder(client.id, meetingId, { alertedAt: '' });
            log.warn?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} alert not sent: ${text(error?.message) || error}`);
          }
        }
      }
    } catch (error) {
      log.warn?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} ${text(error?.message) || error}`);
    }
  }

  let missingPlaceholders = 0;
  for (const client of getClients()) {
    for (const row of Array.isArray(client?.meetings) ? client.meetings : []) {
      if (isPlaceholderId(row?.meetingId) && text(row.recording?.state) === 'missing') missingPlaceholders += 1;
    }
  }
  return {
    ...summary,
    health: {
      missingPlaceholders,
      lookups: summary.checked.length - (summary.paused ? 1 : 0),
      lookupErrors: summary.failed.length,
      lastLookupError,
    },
  };
}

export function resetFirefliesWatchdogForTests() {
  lastLookups.clear();
}
