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
 *     start to the session's end, or to the next booked meeting's first send in that room), so a
 *     later meeting in the same room is not taken for this one, nor an earlier or later one's
 *     recording by the id of its bot in the room. A title match,
 *     or the room at another time, is only offered as a candidate. A recording a person said is
 *     not this client's, pinned to another client or holds as their link on another card is
 *     neither found nor offered;
 *   - a transcript that is the meeting's recording by the card's rule (lib/fireflies-cover.js:
 *     talk that is not live captions, more than a fragment) is stored and linked to the client,
 *     which drops the placeholder. Live captions are never linked, nor stored from here: they are
 *     "not yet". One Fireflies is still processing keeps it waiting. A finished one with only a
 *     few sentences is linked so the rep sees it, but the placeholder stays;
 *   - at the session's end (start + booked, else 60 minutes, or later when capture saw the bot
 *     later) + 90 minutes with nothing found it sets 'missing' and sends one e-mail to the team
 *     and the owning rep; a recording Fireflies has still not finished three hours after that
 *     counts as missing too. With only a finished recording with no talk, or too little, on the
 *     room by then it sets 'empty', with its own one e-mail: a bot that sat alone in an open room
 *     leaves such a fragment early in many meetings that are recorded after all, so it is never
 *     decided sooner. A missing or empty meeting is looked for hourly for 48 hours after its
 *     deadline, so a late transcript still links.
 * Placeholders capture wrote for a meeting the bot never got into ('not-admitted', sent or never
 * sent) are followed the same way, and so is one whose only linked recording is a fragment. Lookups
 * run at most every 10 minutes per placeholder, three per tick. A try-later error (rate limit,
 * network, safe mode) never makes a meeting missing.
 */
import { automaticLinkRefusal, normalizeFirefliesMeetLink } from './fireflies-client-match.js';
import { clientCoveredPlaceholderIds, recordWouldCover, storedRecordCovers } from './fireflies-cover.js';
import { TERMINAL_RECORDING_STATES, sessionKeyFor, slotKindFromKey } from './fireflies-recording-state.js';
import { hydrateFirefliesTranscript, isTryLaterError } from './fireflies-ingest.js';
import { clientMeetingSlots } from './fireflies-slots.js';
import {
  LIVE_JOIN_DISPATCH_UNTIL_MS,
  LIVE_JOIN_FIRST_LEAD_MS,
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
// The row's note while Fireflies is still processing a recording from the room (the list waits for it).
const PENDING_MESSAGE = 'Fireflies behandler fortsatt opptaket.';
// Capture's "never sent" copy (lib/fireflies-live-sessions.js notAdmittedMessage, and a bot another card's
// "uten opptak" stopped), quoted in the e-mail.
const NEVER_SENT_MESSAGES = new Set([
  LIVE_JOIN_MESSAGES.neverSent,
  LIVE_JOIN_MESSAGES.neverSentNoKey,
  LIVE_JOIN_MESSAGES.neverSentLimited,
  LIVE_JOIN_MESSAGES.neverSentSafeMode,
  LIVE_JOIN_MESSAGES.declinedElsewhere,
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

/**
 * Every booked start in each room, of all clients (their bookings and placeholders, lib/fireflies-slots.js
 * clientMeetingSlots): room → [start ms].
 */
function bookedStartsByRoom(clients = []) {
  const byRoom = new Map();
  for (const client of Array.isArray(clients) ? clients : []) {
    for (const slot of clientMeetingSlots(client)) {
      if (!Number.isFinite(slot.startMs)) continue;
      for (const room of slot.rooms) {
        if (!byRoom.has(room)) byRoom.set(room, []);
        byRoom.get(room).push(slot.startMs);
      }
    }
  }
  return byRoom;
}

/**
 * The placeholder's session end for matching recordings on its room: placeholderSessionEndMs, cut where the
 * next booked meeting in that room (any client's) gets its bot, at its first send. A sales room is reused, and
 * a recording that starts from then on is that meeting's, however long this one was booked or watched.
 */
export function roomSessionEndMs(clients = []) {
  const byRoom = bookedStartsByRoom(clients);
  return (row = {}) => {
    const end = placeholderSessionEndMs(row);
    const start = startMs(row);
    const starts = byRoom.get(normalizeFirefliesMeetLink(row.meetLink)) || [];
    const next = Math.min(...starts.filter((at) => at > start));
    return Number.isFinite(next) ? Math.min(end, next - LIVE_JOIN_FIRST_LEAD_MS - 1) : end;
  };
}

/** Does this record start inside the placeholder's session (half an hour before the booked start to its end)? */
function startsInSession(placeholder, record, sessionEndMs = placeholderSessionEndMs) {
  const at = Date.parse(text(record?.startedAt));
  return Number.isFinite(at) && at >= startMs(placeholder) - ROOM_MATCH_BEFORE_MS && at <= sessionEndMs(placeholder);
}

/** Does this record (stored or listed: startedAt, meetingLink) start in the placeholder's room and session? */
function inSession(placeholder, record, sessionEndMs = placeholderSessionEndMs) {
  const link = normalizeFirefliesMeetLink(placeholder.meetLink);
  if (!link || normalizeFirefliesMeetLink(record?.meetingLink || record?.meetLink) !== link) return false;
  return startsInSession(placeholder, record, sessionEndMs);
}

/**
 * The recording of the bot capture saw is this session's only when it started in the session: in a
 * reused room, an earlier meeting that ran over still has its bot there at this one's start, and the
 * next meeting's bot comes in before this one's booked end. A record with no start time is taken on its id.
 */
function byIdInSession(placeholder, record, sessionEndMs = placeholderSessionEndMs) {
  return !Number.isFinite(Date.parse(text(record?.startedAt))) || startsInSession(placeholder, record, sessionEndMs);
}

/**
 * The client's placeholders a linked recording already covers, by the card's rule
 * (lib/fireflies-cover.js): talk that is not live captions and more than a fragment, on the
 * placeholder's own slot (its room and session, the bot capture saw, or a person's pick). A silent or
 * few-sentence fragment, or captions, is not the recording: that placeholder is still followed.
 */
function coveredPlaceholders(client = {}) {
  return clientCoveredPlaceholderIds(client, { sessionEndMs: placeholderSessionEndMs });
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

function bestOf(rows = []) {
  return [...rows].sort((a, b) => sentences(b) - sentences(a))[0] || null;
}

/**
 * Find this session's transcript. Returns { found, short, empty, pending, candidates }:
 *   found       a record that is the meeting's recording by the card's rule, by id or on the room in the
 *               session: talk that is not live captions and more than a fragment (storedRecordCovers)
 *               that, with the client's card at hand, would land on this placeholder's slot
 *               (recordWouldCover; one of another booked slot in the room is offered instead);
 *   short       a finished record on the room with talk, but only a fragment of it (a "hallo?");
 *   empty       a finished record on the room with no talk;
 *   pending     a record exists but Fireflies is not done with it (live, or still processing);
 *   candidates  [{ meetingId, title, startedAt, transcriptUrl, why: 'title' | 'room' }]: the hub's
 *               title in another room, or this room at another time.
 * With `clientId` (and `clients`, the sales clients), a record that is not this client's is skipped
 * everywhere, never offered either: excluded from it ("Ikke denne kunden"), pinned to another client,
 * or held as a person's link on another card (lib/fireflies-client-match.js automaticLinkRefusal). With
 * `clients`, the session also ends where the next booked meeting in the room gets its bot (roomSessionEndMs).
 * Throws try-later errors so the caller can stop for this tick.
 */
export async function lookupPlaceholderTranscript(placeholder = {}, {
  apiKey,
  nowMs = Date.now(),
  clientId = '',
  clients = [],
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
  const outcome = { found: null, short: null, empty: null, pending: false, candidates: [] };
  const owner = text(clientId);
  const card = owner ? (Array.isArray(clients) ? clients : []).find((entry) => text(entry?.id) === owner) || null : null;
  const sessionEndMs = roomSessionEndMs(clients);
  // The stored copy carries the pin and the exclusions; a fresh Fireflies copy does not.
  const elsewhere = (record) => Boolean(owner) && Boolean(record) && Boolean(automaticLinkRefusal(text(record.meetingId), owner, {
    stored: readStored(text(record.meetingId)) || record,
    clients,
  }));
  // Found means it would cover this placeholder once linked, by the card's rule (with the card at hand: its
  // slot too, so a second booked meeting in the same room keeps its own recording).
  const covers = (record) => (card
    ? recordWouldCover(card, placeholder.meetingId, record, { storedOf: readStored, sessionEndMs })
    : storedRecordCovers(record));
  const offer = (record, why) => {
    const meetingId = text(record?.meetingId);
    if (!meetingId || elsewhere(record) || outcome.candidates.some((row) => row.meetingId === meetingId)) return;
    outcome.candidates.push({ meetingId, title: record.title, startedAt: record.startedAt, transcriptUrl: record.transcriptUrl, why });
  };
  const settle = (record) => {
    if (!record || elsewhere(record)) return;
    if (storedRecordCovers(record)) {
      if (!covers(record)) offer(record, 'room');
      else if (!outcome.found || sentences(record) > sentences(outcome.found)) outcome.found = record;
    } else if (usable(record) && storedMeetingIsFinal(record, { nowMs })) {
      if (!outcome.short || sentences(record) > sentences(outcome.short)) outcome.short = record;
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
  // of an earlier or a later meeting in a reused room is only offered: its recording is that meeting's.
  const ffId = text(placeholder.recording?.ffMeetingId);
  const byId = ffId ? readStored(ffId) : null;
  const earlier = Boolean(byId) && !byIdInSession(placeholder, byId, sessionEndMs);
  if (earlier) offer(byId, 'room');
  const storedBest = bestOf([...(byId && !earlier ? [byId] : []), ...storedRows().filter((row) => inSession(placeholder, row, sessionEndMs))]
    .filter((row) => !elsewhere(row) && covers(row)));
  if (storedBest) {
    outcome.found = storedBest;
    return outcome;
  }

  // 2. The id capture saw in active_meetings is the transcript id.
  if (ffId && !earlier) {
    const record = await fetchOne(ffId);
    if (record && !byIdInSession(placeholder, record, sessionEndMs)) offer(record, 'room');
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
    if (!id || id === ffId || elsewhere(record)) continue;
    const sameRoom = Boolean(link) && normalizeFirefliesMeetLink(record.meetingLink) === link;
    if (sameRoom && inSession(placeholder, record, sessionEndMs)) {
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
    // Nobody looked at the room after the send (the hub was down, or an older hub sent it): not "never let in".
    if (text(recording.message) === LIVE_JOIN_MESSAGES.notChecked) return 'Fireflies-boten ble sendt inn, men Asoldi fikk ikke sjekket om den kom inn i møtet.';
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
  if (text(recording.message) === LIVE_JOIN_MESSAGES.notChecked) return ' Asoldi fikk ikke sjekket om Fireflies kom inn.';
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

/**
 * The one e-mail about a missing recording (Norwegian, to the team and the owning rep). `keyless`:
 * the hub had no Fireflies key, so it could not look in Fireflies at all.
 */
export function buildMissingRecordingEmail({
  client = {},
  placeholder = {},
  to = [],
  previousState = '',
  previousRecording = null,
  candidates = [],
  unfinished = false,
  keyless = false,
} = {}) {
  const business = text(client.businessName) || 'kunden';
  const noun = meetingNoun(placeholder);
  const when = osloTime(placeholder.startedAt);
  const lines = withoutDoubleBlanks([
    `${keyless ? 'Asoldi har ikke noe' : 'Det finnes ikke noe'} Fireflies-opptak av ${noun} med ${business}${when ? ` (${when})` : ''}.`,
    unfinished
      ? 'Fireflies har et opptak fra Meet-rommet, men er fortsatt ikke ferdig med det flere timer etter møtet.'
      : stateLine(previousState, previousRecording || placeholder.recording || {}),
    text(placeholder.meetLink) ? `Meet: ${text(placeholder.meetLink)}` : '',
    '',
    ...TODO_LINES,
    ...candidates.slice(0, 3).map(candidateLine),
    '',
    keyless
      ? 'Asoldi kan ikke se etter opptaket i Fireflies før Fireflies-nøkkelen er på plass igjen. Kommer det innen 48 timer, kobles det til kunden av seg selv.'
      : 'Asoldi ser etter opptaket hver time i 48 timer til. Kommer det, kobles det til kunden av seg selv.',
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
  const was = text(row.recording?.state);
  return {
    recording: {
      state: 'declined',
      // What the watchdog had called it, for the undo.
      ...(WATCHED_STATES.has(was) ? { declinedFrom: was } : {}),
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
 * know. A meeting that had already been reported missing or empty stays so (no second e-mail). With
 * no session yet (the engine collects 36 hours ahead) a meeting whose first send is still to come
 * is scheduled again.
 */
function reopenedRecording(row = {}, session = null, who = '', nowMs = Date.now()) {
  const current = row.recording || {};
  const by = who ? ` av ${who}` : '';
  if (text(current.missingAt)) {
    // Back to what the watchdog had called it: a silent or few-sentence recording is still "tomt opptak".
    if (text(current.declinedFrom) === 'empty') {
      return { state: 'empty', checkedAt: '', message: `Åpnet igjen${by}. Fireflies var med, men opptaket er tomt (ingen tale, eller for kort).` };
    }
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

function rowKind(row = {}) {
  const kind = slotKindFromKey(row.slotKey);
  if (kind) return kind;
  if (['sales', 'workshop', 'iteration'].includes(text(row.purpose))) return text(row.purpose);
  return row.forSalesMeeting ? 'sales' : '';
}

/**
 * GET /api/admin/fireflies/missing-recordings: the placeholders of booked online meetings that
 * no linked recording covers (the card's rule: a fragment or live captions do not) and that are
 * past their deadline (later while Fireflies is still processing a recording from the room), or
 * that the watchdog already called 'missing' or 'empty'. Declined ones are left out. Newest first,
 * the last `days` days; `canAccess(client)` filters the clients a rep may see. A row past its
 * deadline keeps 'not-admitted' and its "why"
 * until the watchdog has written 'missing'; any other state lists as 'missing'.
 * Returns { rows: [{ clientId, businessName, ownerId, meetingId, slotKey, kind, startedAt, meetLink,
 * title, state: 'missing' | 'empty' | 'not-admitted', message, missingAt, alertedAt }], count }.
 */
export function missingRecordingRows(clients = [], { nowMs = Date.now(), days = 60, canAccess = () => true } = {}) {
  const since = nowMs - days * DAY_MS;
  const rows = [];
  for (const client of Array.isArray(clients) ? clients : []) {
    if (!client?.id || !canAccess(client)) continue;
    let covered = null;
    for (const row of Array.isArray(client.meetings) ? client.meetings : []) {
      if (!isPlaceholderId(row?.meetingId)) continue;
      const start = startMs(row);
      if (!Number.isFinite(start) || start < since || start > nowMs) continue;
      const recording = row.recording || {};
      const current = text(recording.state);
      if (current === 'declined') continue;
      covered = covered || coveredPlaceholders(client);
      if (covered.has(text(row.meetingId))) continue;
      const decided = WATCHED_STATES.has(current);
      const deadlineMs = recordingDeadlineMs(row) + (text(recording.message) === PENDING_MESSAGE ? PENDING_GRACE_MS : 0);
      // A meeting that may still get its recording is not listed yet, whatever capture has called it.
      if (!decided && nowMs < deadlineMs) continue;
      const state = decided || current === 'not-admitted' ? current : 'missing';
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

/** A bot of the hub's Fireflies account may have recorded this meeting: one was sent or seen, or a recording is named. */
function botMayHaveRecorded(row = {}) {
  const recording = row.recording || {};
  return Boolean(text(row.liveJoinedAt) || text(recording.dispatchedAt) || text(recording.verifiedAt)
    || text(recording.lastSeenAt) || text(recording.ffMeetingId));
}

function alerted(recording = {}) {
  const alertedAt = Date.parse(text(recording.alertedAt));
  const missingAt = Date.parse(text(recording.missingAt));
  return Number.isFinite(alertedAt) && Number.isFinite(missingAt) && alertedAt >= missingAt;
}

/**
 * The placeholder as it is now (getClients reads fresh), or null once it is decided elsewhere: gone (its
 * recording was linked), marked "uten opptak" by a rep, or covered by a recording on the card. With
 * `replan`, also null when it is no longer due for this lookup (another pass checked it a moment ago).
 */
function placeholderNow(getClients, clientId, meetingId, { nowMs, replan = false } = {}) {
  const client = (getClients() || []).find((entry) => text(entry?.id) === text(clientId)) || null;
  const row = (Array.isArray(client?.meetings) ? client.meetings : []).find((item) => text(item?.meetingId) === meetingId) || null;
  if (!row || text(row.recording?.state) === 'declined') return null;
  if (replan && planPlaceholderCheck(row, { nowMs }).action !== 'lookup') return null;
  return coveredPlaceholders(client).has(meetingId) ? null : { client, row };
}

/**
 * Check every placeholder whose session is over. deps:
 *   getClients()                                   sales clients (fresh each call);
 *   apiKey                                         the Fireflies key; without one nothing is looked up, and only a
 *                                                  meeting no bot of the hub's can have recorded (never sent, never
 *                                                  seen) is followed to its deadline, so the team still hears of it;
 *   linkTranscript(clientId, record, placeholder)  store-backed client link (server.js linkStoredTranscriptToClient):
 *                                                  the client, or null when nothing was linked (an automatic link
 *                                                  refused: excluded, pinned or a person's link elsewhere);
 *   patchPlaceholder(clientId, meetingId, recording)  merge into the row's recording (sales.patchSalesClientMeeting);
 *   recipientsFor(client)                          [team address, owning rep's e-mail] (may be async);
 *   mayAlert(client)                               false for a client that gets no e-mail (a test client that is
 *                                                  not a pilot): its row still turns missing or empty;
 *   sendEmail(message)                             the hub mailer.
 * Returns { checked, linked, empty, missing, alerted, failed, paused,
 *           health: { missingPlaceholders, lookups, lookupErrors, lastLookupError } }:
 * lookups counts the Fireflies lookups that ran to an answer or a real error (not a try-later pause).
 */
export async function runFirefliesRecordingWatchdog({
  getClients,
  apiKey,
  linkTranscript,
  patchPlaceholder,
  recipientsFor = () => [],
  mayAlert = (client) => client?.isTest !== true,
  sendEmail,
  nowMs = Date.now(),
  maxLookups = MAX_LOOKUPS_PER_TICK,
  lookup = (placeholder, client, clients) => lookupPlaceholderTranscript(placeholder, { apiKey, nowMs, clientId: client?.id, clients }),
  log = console,
} = {}) {
  const summary = { checked: [], linked: [], empty: [], missing: [], alerted: [], failed: [], paused: '' };
  const keyless = !text(apiKey);
  let lookups = 0;
  let lastLookupError = '';
  const due = [];
  const clients = getClients();
  for (const client of clients) {
    let covered = null;
    for (const row of Array.isArray(client?.meetings) ? client.meetings : []) {
      if (!isPlaceholderId(row?.meetingId)) continue;
      // A meeting a bot may have recorded waits for the key: it is never called missing unlooked.
      if (keyless && botMayHaveRecorded(row)) continue;
      const key = lookupKey(client.id, row.meetingId);
      const plan = planPlaceholderCheck(row, { nowMs, checkedMs: lastLookups.get(key) });
      if (plan.action !== 'lookup') continue;
      covered = covered || coveredPlaceholders(client);
      if (covered.has(text(row.meetingId))) continue;
      due.push({ client, row, plan, key });
    }
  }
  // The newest deadlines first, so a meeting that just ended is never queued behind old ones.
  due.sort((a, b) => b.plan.deadlineMs - a.plan.deadlineMs);

  for (const { client: listed, row: listedRow, plan, key } of due) {
    if (summary.checked.length >= maxLookups || summary.paused) break;
    const meetingId = text(listedRow.meetingId);
    lastLookups.set(key, nowMs);
    if (lastLookups.size > 2000) lastLookups.delete(lastLookups.keys().next().value);
    summary.checked.push(meetingId);
    let result;
    try {
      if (keyless) {
        result = { found: null, short: null, empty: null, pending: false, candidates: [] };
      } else {
        lookups += 1;
        result = await lookup(listedRow, listed, clients);
      }
    } catch (error) {
      if (isTryLaterError(error)) {
        // Fireflies or the network asked us to wait: nothing is decided about this meeting.
        summary.paused = text(error?.message) || 'try later';
        log.warn?.(`[fireflies] watchdog client=${listed.id} meeting=${meetingId} paused: ${summary.paused}`);
        break;
      }
      summary.failed.push(meetingId);
      lastLookupError = text(error?.message) || String(error);
      log.warn?.(`[fireflies] watchdog client=${listed.id} meeting=${meetingId} ${lastLookupError}`);
      continue;
    }
    // The lookup waited on Fireflies: a rep's "uten opptak", the link of its recording or another pass may
    // have landed meanwhile. Only a row still waiting is decided, from what it says now.
    const now = placeholderNow(getClients, listed.id, meetingId, { nowMs, replan: true });
    if (!now) {
      log.log?.(`[fireflies] watchdog client=${listed.id} meeting=${meetingId} decided meanwhile`);
      continue;
    }
    const { client, row } = now;
    const previousState = text(row.recording?.state);
    // As the row was before this lookup's own patches (e-mail copy and the kept "why").
    const previousRecording = { ...(row.recording || {}) };
    try {
      if (result.found) {
        // The link drops the placeholder; should it stay (another slot), it says what was found.
        const linked = await linkTranscript(client.id, result.found, row);
        if (linked) {
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
        // Refused (a person said it is not this client's, or put it on another card): nothing was
        // linked, so the meeting is decided as if nothing had been found.
        log.warn?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} link of ${text(result.found.meetingId)} refused`);
        result = { ...result, found: null };
      }
      // A few sentences are not the meeting's recording, but the rep should see them on the card.
      if (result.short && !(client.meetings || []).some((item) => text(item?.meetingId) === text(result.short.meetingId))) {
        await linkTranscript(client.id, result.short, row);
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
          patchPlaceholder(client.id, meetingId, { checkedAt: iso(nowMs), message: PENDING_MESSAGE });
        }
        continue;
      }
      // Only a fragment with a few sentences counts as empty too: it is not the meeting's recording.
      const emptyRecord = result.short || result.empty;
      const empty = Boolean(emptyRecord) && !result.pending;
      if (!plan.overdue) {
        // Before the deadline nothing is decided: a silent fragment is often a bot that sat alone
        // before the meeting that was then recorded after all.
        if (!previousState) continue;
        if (empty) {
          const sofar = result.short ? 'et veldig kort opptak' : 'et tomt opptak';
          patchPlaceholder(client.id, meetingId, { checkedAt: iso(nowMs), message: `Fireflies har bare ${sofar} fra møtet så langt.${candidateNote}` });
        } else if (previousState === 'not-admitted') {
          // Keep capture's "why" (never sent, never let in).
          patchPlaceholder(client.id, meetingId, { checkedAt: iso(nowMs) });
        } else {
          patchPlaceholder(client.id, meetingId, { checkedAt: iso(nowMs), message: `Venter på opptaket fra Fireflies.${candidateNote}` });
        }
        continue;
      }
      // The links above may have waited too: decide only a row that is still open.
      if (!placeholderNow(getClients, client.id, meetingId, { nowMs })) continue;
      const recording = previousRecording;
      // Missing and empty share one stamp: the team hears once that this meeting has no usable recording.
      const missingAt = WATCHED_STATES.has(previousState) && text(recording.missingAt) ? text(recording.missingAt) : iso(nowMs);
      const state = empty ? 'empty' : 'missing';
      patchPlaceholder(client.id, meetingId, {
        state,
        missingAt,
        checkedAt: iso(nowMs),
        ...(empty ? { ffMeetingId: text(emptyRecord.meetingId) } : {}),
        message: empty
          ? `Fireflies var med, men opptaket er tomt (ingen tale, eller for kort).${candidateNote}`
          : `${unfinished ? 'Fireflies ble aldri ferdig med opptaket.' : `Ingen Fireflies-opptak etter møtet.${notAdmittedNote(recording)}`}${candidateNote}`,
      });
      if (previousState !== state) summary[empty ? 'empty' : 'missing'].push(meetingId);
      // One e-mail, while the deadline is recent. alertedAt is claimed before the send.
      const fresh = nowMs - plan.deadlineMs <= WATCHDOG_MISSING_WATCH_MS;
      if (fresh && typeof sendEmail === 'function' && mayAlert(client) && !alerted({ ...recording, missingAt })) {
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
            keyless,
          });
        // Claimed on the row as it is after the wait for the addresses: not once it is marked or already told.
        const claimable = placeholderNow(getClients, client.id, meetingId, { nowMs });
        if (email.to && claimable && !alerted({ ...(claimable.row.recording || {}), missingAt })) {
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

  // The same count as "Møter uten opptak": missing, empty and never let in, past the deadline.
  const missingPlaceholders = missingRecordingRows(getClients(), { nowMs }).count;
  return {
    ...summary,
    health: {
      missingPlaceholders,
      lookups: lookups - (summary.paused ? 1 : 0),
      lookupErrors: summary.failed.length,
      lastLookupError,
    },
  };
}

export function resetFirefliesWatchdogForTests() {
  lastLookups.clear();
}
