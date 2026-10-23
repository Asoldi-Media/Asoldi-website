/**
 * Which booked slot of one client a Fireflies recording belongs to, and which recordings are one meeting.
 *
 * A slot is one booked meeting of the client: the sales meeting, an extra recorded Møte, the workshop or
 * the iteration Møte, keyed as lib/fireflies-recording-state.js slotKeyFor does. The room decides: a
 * recording in a slot's Meet room is that slot's, and time only picks between slots that share a room.
 * It gets the slot's key only when it starts inside the slot's session window (as the watchdog: half an
 * hour before the booked start to the session's end). A recording in none of the client's rooms keeps
 * the purpose it was linked with; one with no purpose takes the nearest booked slot's within three hours,
 * never its key.
 *
 * A live-join placeholder is superseded only by a recording with talk on its own slot that starts inside
 * the placeholder's session window, or one a person put on that slot. Two recordings in one room that
 * start close together are one meeting; the one with the most talk is the primary.
 * Browser-safe: no storage or network imports (the activity log runs in the admin app).
 */
import { normalizeFirefliesMeetLink } from './fireflies-client-match.js';
import { slotKeyFor, slotKindFromKey } from './fireflies-recording-state.js';
import { getWorkshopAction, WORKSHOP_DURATION_MINUTES } from './workshop-action-shared.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** A recording that starts this long before the booked start still belongs to it (the watchdog's room match). */
export const SLOT_MATCH_BEFORE_MS = 30 * MINUTE_MS;
/** A session without a booked length runs this long (the watchdog's DEFAULT_BOOKED_MINUTES). */
const DEFAULT_SESSION_MINUTES = 60;
/** A recording in none of the client's rooms takes the nearest slot's purpose within this. */
export const TIME_ONLY_PURPOSE_WINDOW_MS = 3 * HOUR_MS;
/** Two recordings in one room that start this close together are one meeting... */
export const DUPLICATE_START_GAP_MS = 20 * MINUTE_MS;
/** ...as are two that overlap, or where one starts this soon after the other ended (a bot that rejoined). */
export const DUPLICATE_RESUME_GAP_MS = 5 * MINUTE_MS;

const PURPOSES = ['sales', 'workshop', 'iteration'];

function text(value) {
  return String(value ?? '').trim();
}

function msOf(value) {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? ms : NaN;
}

function isPlaceholderId(id = '') {
  return text(id).toLowerCase().startsWith('live:');
}

function purposeOf(value) {
  const purpose = text(value).toLowerCase();
  return PURPOSES.includes(purpose) ? purpose : '';
}

function roomOf(row = {}) {
  return normalizeFirefliesMeetLink(row?.meetLink || row?.meetingLink);
}

/** When a recording started: startedAt, or Fireflies' dateString (ms, NaN when unknown). */
export function recordingStartMs(row = {}) {
  return msOf(row?.startedAt || row?.dateString);
}

/**
 * A placeholder's slot: its slotKey, or for a row from before slot keys the slot its live: id names
 * (live:<client>:<ms> sales, live:<client>:workshop|iteration:<ms>, live:<client>:<actionId>:<ms>).
 */
export function placeholderSlotKey(row = {}) {
  const own = text(row?.slotKey);
  if (own) return own;
  const id = text(row?.meetingId);
  if (!isPlaceholderId(id)) return '';
  const parts = id.split(':');
  const last = parts[parts.length - 1];
  const stamped = /^\d+$/.test(last) ? Number(last) : NaN;
  if (parts.length === 3) {
    if (Number.isFinite(stamped)) return `sales:${stamped}`;
    return purposeOf(row.purpose) === 'sales' || row.forSalesMeeting ? slotKeyFor('sales', { startAt: row.startedAt }) : '';
  }
  if (parts.length === 4) {
    const scope = parts[2];
    if (scope === 'workshop' || scope === 'iteration') {
      return Number.isFinite(stamped) ? `${scope}:${stamped}` : slotKeyFor(scope, { startAt: row.startedAt });
    }
    return slotKeyFor('action', { actionId: scope });
  }
  return '';
}

/**
 * The placeholder's session end, as lib/fireflies-recording-watchdog.js placeholderSessionEndMs: the
 * booked end (durationMinutes, else 60) or later when capture saw the bot later. Server code passes the
 * watchdog's own function; this copy keeps the activity log in the browser on the same window.
 */
export function placeholderSessionEndMs(row = {}) {
  const minutes = Number(row?.durationMinutes);
  const booked = msOf(row?.startedAt) + (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SESSION_MINUTES) * MINUTE_MS;
  const seen = [row?.recording?.lastSeenAt, row?.recording?.endedAt].map(msOf).filter(Number.isFinite);
  return Math.max(booked, ...seen);
}

function newSlot({ kind, slotKey = '', purpose = '', actionId = '', startMs = NaN, bookedMinutes = DEFAULT_SESSION_MINUTES, historic = false }) {
  return {
    kind,
    slotKey,
    purpose,
    actionId,
    startMs,
    bookedMinutes,
    historic,
    rooms: new Set(),
    historyRooms: new Set(),
    placeholders: [],
  };
}

function addRoom(slot, value) {
  const room = normalizeFirefliesMeetLink(value);
  if (room) slot.rooms.add(room);
}

/**
 * The client's booked slots: [{ kind, slotKey, purpose, actionId, startMs, bookedMinutes, historic, rooms,
 * historyRooms, placeholders }]. A slot's rooms are the one it was booked with, where the live join sent
 * the bot, and the room of each of its placeholders, so a meeting moved to a fresh room keeps the old one.
 * The client's earlier rooms that no other slot uses are the sales meeting's historyRooms: a weaker sign
 * that never overrides the purpose a recording was linked with. A placeholder whose booking has moved on
 * keeps its own (historic) slot.
 */
export function clientMeetingSlots(client = {}) {
  const slots = [];
  const byKey = new Map();
  const add = (slot) => {
    slots.push(slot);
    if (slot.slotKey && !byKey.has(slot.slotKey)) byKey.set(slot.slotKey, slot);
    return slot;
  };

  const calendar = client?.calendar || {};
  const salesStart = client?.agreedTime ? msOf(client.meetingAt) : NaN;
  const sales = newSlot({
    kind: 'sales',
    purpose: 'sales',
    slotKey: Number.isFinite(salesStart) ? `sales:${salesStart}` : '',
    startMs: salesStart,
    bookedMinutes: Number(client?.meetingDurationMinutes) || DEFAULT_SESSION_MINUTES,
  });
  addRoom(sales, calendar.meetLink);
  addRoom(sales, calendar.confirmedMeetLink);
  addRoom(sales, calendar.firefliesLiveJoinedMeetLink);
  add(sales);

  for (const action of Array.isArray(client?.nextActions) ? client.nextActions : []) {
    if (text(action?.presetKey) === 'meeting' || text(action?.format) !== 'mote' || !action?.addToCalendar) continue;
    const actionId = text(action.id);
    if (!actionId) continue;
    const slot = add(newSlot({
      kind: 'action',
      actionId,
      purpose: text(action.goalKey) === 'meetingHeld' ? 'sales' : '',
      slotKey: slotKeyFor('action', { actionId }),
      startMs: msOf(action.dueAt),
    }));
    addRoom(slot, action.meetLink);
    addRoom(slot, action.firefliesLiveJoinedMeetLink);
  }

  const workshop = getWorkshopAction(client);
  if (workshop) {
    const startMs = msOf(workshop.dueAt);
    const slot = add(newSlot({
      kind: 'workshop',
      purpose: 'workshop',
      slotKey: Number.isFinite(startMs) ? `workshop:${startMs}` : '',
      startMs,
      bookedMinutes: WORKSHOP_DURATION_MINUTES,
    }));
    addRoom(slot, workshop.meetLink);
    addRoom(slot, workshop.firefliesLiveJoinedMeetLink);
  }

  const iteration = client?.workshop?.iterationMeeting;
  if (iteration && typeof iteration === 'object') {
    const startMs = msOf(iteration.dueAt);
    const slot = add(newSlot({
      kind: 'iteration',
      purpose: 'iteration',
      slotKey: Number.isFinite(startMs) ? `iteration:${startMs}` : '',
      startMs,
      bookedMinutes: WORKSHOP_DURATION_MINUTES,
    }));
    addRoom(slot, iteration.meetLink);
    addRoom(slot, iteration.firefliesLiveJoinedMeetLink);
  }

  for (const row of Array.isArray(client?.meetings) ? client.meetings : []) {
    if (!isPlaceholderId(row?.meetingId)) continue;
    const key = placeholderSlotKey(row);
    if (!key) continue;
    let slot = byKey.get(key);
    if (!slot) {
      const kind = slotKindFromKey(key);
      slot = add(newSlot({
        kind,
        slotKey: key,
        purpose: purposeOf(row.purpose) || (kind === 'action' ? '' : purposeOf(kind)),
        actionId: kind === 'action' ? key.slice('action:'.length) : '',
        startMs: msOf(row.startedAt),
        historic: true,
      }));
    }
    addRoom(slot, row.meetLink || row.meetingLink);
    slot.placeholders.push(row);
  }

  // The sales part of the client's room history: rooms no slot books now.
  const bookedRooms = new Set();
  for (const slot of slots) {
    for (const room of slot.rooms) bookedRooms.add(room);
  }
  for (const value of Array.isArray(client?.recordedMeetLinks) ? client.recordedMeetLinks : []) {
    const room = normalizeFirefliesMeetLink(value);
    if (room && !bookedRooms.has(room)) sales.historyRooms.add(room);
  }
  return slots.filter((slot) => (
    slot.rooms.size || slot.historyRooms.size || Number.isFinite(slot.startMs) || slot.placeholders.length
  ));
}

/** [booked start − 30 min, session end] of a slot: the booked length (at least an hour) or its placeholders' sessions. */
export function slotWindow(slot = {}, { sessionEndMs = placeholderSessionEndMs } = {}) {
  if (!Number.isFinite(slot.startMs)) return null;
  const minutes = Math.max(DEFAULT_SESSION_MINUTES, Number(slot.bookedMinutes) || 0);
  const ends = (slot.placeholders || []).map((row) => sessionEndMs(row)).filter(Number.isFinite);
  return {
    startMs: slot.startMs - SLOT_MATCH_BEFORE_MS,
    endMs: Math.max(slot.startMs + minutes * MINUTE_MS, ...ends),
  };
}

function insideWindow(window, at) {
  return Boolean(window) && Number.isFinite(at) && at >= window.startMs && at <= window.endMs;
}

/** Of slots sharing a room: the one nearest in time (no start: a booked one before a historic one). */
function nearestSlot(list = [], at = NaN) {
  if (!Number.isFinite(at)) return list.find((slot) => !slot.historic) || list[0] || null;
  let best = null;
  let bestDiff = Infinity;
  for (const slot of list) {
    const diff = Number.isFinite(slot.startMs) ? Math.abs(at - slot.startMs) : Infinity;
    if (diff < bestDiff || (!best && diff === Infinity)) {
      best = slot;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * The slot a recording was recorded in, by its room: { slot, purpose, slotKey, by } with by 'room' when
 * the room is one a slot books, 'history' when it is only one of the client's earlier rooms (the sales
 * meeting's historyRooms), else { slot: null, purpose: '', slotKey: '', by: '' }. The slotKey is set only
 * when the recording started inside that slot's window.
 */
export function resolveRecordingSlot(client = {}, record = {}, { slots = null, sessionEndMs } = {}) {
  const list = slots || clientMeetingSlots(client);
  const room = roomOf(record);
  if (!room) return { slot: null, purpose: '', slotKey: '', by: '' };
  let inRoom = list.filter((slot) => slot.rooms.has(room));
  let by = 'room';
  if (!inRoom.length) {
    inRoom = list.filter((slot) => slot.historyRooms?.has(room));
    by = 'history';
  }
  if (!inRoom.length) return { slot: null, purpose: '', slotKey: '', by: '' };
  const at = recordingStartMs(record);
  const slot = nearestSlot(inRoom, at);
  const fits = slot.slotKey && insideWindow(slotWindow(slot, { sessionEndMs }), at);
  return { slot, purpose: slot.purpose, slotKey: fits ? slot.slotKey : '', by };
}

/** The booked slot nearest in time within three hours (for a recording with no room of the client). */
function nearestSlotInTime(list = [], at = NaN) {
  if (!Number.isFinite(at)) return null;
  const near = list.filter((slot) => !slot.historic
    && Number.isFinite(slot.startMs)
    && Math.abs(at - slot.startMs) <= TIME_ONLY_PURPOSE_WINDOW_MS);
  return nearestSlot(near, at);
}

/**
 * Purpose and slot of one client.meetings row: { purpose, slotKey, forSalesMeeting, by }.
 *   by 'person'   a person picked the purpose (purposePickedAt): kept as it is;
 *   by 'slot'     a placeholder: its own slot;
 *   by 'room'     a room a slot books: its purpose wins over what the row had;
 *   by 'kept'     no booked room: the purpose (and slot) the row was linked with;
 *   by 'history'  one of the client's earlier rooms and no purpose yet: the sales meeting's;
 *   by 'time'     none of that: the nearest booked slot's purpose within three hours, no slot key.
 */
export function meetingSlotFacts(client = {}, row = {}, { slots = null, sessionEndMs } = {}) {
  const list = slots || clientMeetingSlots(client);
  const persisted = purposeOf(row?.purpose) || (row?.forSalesMeeting ? 'sales' : '');
  const facts = (purpose, slotKey, by) => ({ purpose, slotKey, forSalesMeeting: purpose === 'sales', by });
  if (isPlaceholderId(row?.meetingId)) {
    const key = placeholderSlotKey(row);
    const kind = slotKindFromKey(key);
    return facts(persisted || (kind === 'action' ? '' : purposeOf(kind)), key, 'slot');
  }
  if (text(row?.purposePickedAt)) return facts(purposeOf(row.purpose), text(row.slotKey), 'person');
  const resolved = resolveRecordingSlot(client, row, { slots: list, sessionEndMs });
  // A slot the row was linked with earlier (the booking has since moved on) stays, if it is the same kind.
  const kept = text(row?.slotKey);
  const keptFor = (slot) => (kept && slot && slotKindFromKey(kept) === slot.kind ? kept : '');
  if (resolved.by === 'room') return facts(resolved.purpose, resolved.slotKey || keptFor(resolved.slot), 'room');
  if (persisted) return facts(persisted, kept, 'kept');
  if (resolved.by === 'history') return facts(resolved.purpose, resolved.slotKey || keptFor(resolved.slot), 'history');
  const timed = nearestSlotInTime(list, recordingStartMs(row));
  return timed ? facts(timed.purpose, '', 'time') : facts('', '', '');
}

/**
 * The slot a person means when they say a recording is the client's sales meeting, workshop or iteration:
 * the slot of that purpose in the recording's room, else the one nearest in time, else the booked one.
 */
export function slotForPurposePick(client = {}, row = {}, purpose = '', { slots = null } = {}) {
  const wanted = purposeOf(purpose);
  if (!wanted) return null;
  const list = (slots || clientMeetingSlots(client)).filter((slot) => slot.purpose === wanted && slot.slotKey);
  if (!list.length) return null;
  const room = roomOf(row);
  const inRoom = room ? list.filter((slot) => slot.rooms.has(room)) : [];
  return nearestSlot(inRoom.length ? inRoom : list, recordingStartMs(row));
}

/**
 * The recording that supersedes this placeholder, or null. It must be a real recording with talk
 * (countsAsTalk: not live captions, not a silent copy) on the placeholder's own slot (factsOf(row).slotKey)
 * that starts inside the placeholder's window [booked start − 30 min, session end], or one a person put
 * on that slot (factsOf(row).by === 'person'). A recording of another slot, or of none, never does.
 */
export function placeholderSupersededBy(placeholder = {}, rows = [], {
  factsOf = (row) => ({ slotKey: text(row?.slotKey), by: text(row?.purposePickedAt) ? 'person' : '' }),
  countsAsTalk = (row) => Boolean(row?.hasTranscript) && row?.partial !== true,
  sessionEndMs = placeholderSessionEndMs,
} = {}) {
  if (!isPlaceholderId(placeholder?.meetingId)) return null;
  const key = placeholderSlotKey(placeholder);
  if (!key) return null;
  const startMs = msOf(placeholder.startedAt);
  const from = startMs - SLOT_MATCH_BEFORE_MS;
  const to = sessionEndMs(placeholder);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!text(row?.meetingId) || isPlaceholderId(row.meetingId)) continue;
    const facts = factsOf(row) || {};
    if (text(facts.slotKey) !== key || !countsAsTalk(row)) continue;
    if (facts.by === 'person') return row;
    const at = recordingStartMs(row);
    if (Number.isFinite(at) && Number.isFinite(startMs) && at >= from && at <= to) return row;
  }
  return null;
}

/** How much talk a row has: { sentences, minutes }. sentenceCount, else transcript lines; durationMinutes. */
export function recordingTalk(row = {}) {
  const raw = row?.sentenceCount;
  const counted = raw === '' || raw == null ? NaN : Number(raw);
  const lines = text(row?.transcript).split('\n').filter((line) => line.trim()).length;
  const sentences = Number.isFinite(counted)
    ? Math.max(0, counted)
    : (lines || (row?.hasTranscript || text(row?.summary) ? 1 : 0));
  return { sentences, minutes: Math.max(0, Number(row?.durationMinutes) || 0) };
}

/** > 0 when `a` has more talk than `b`: sentences first, then minutes. */
export function compareTalk(a = {}, b = {}) {
  return (a.sentences || 0) - (b.sentences || 0) || (a.minutes || 0) - (b.minutes || 0);
}

/** One meeting: the same room, and starts within 20 minutes, overlapping, or one resumed within 5 minutes of the other's end. */
export function sameRecordedMeeting(a = {}, b = {}) {
  const room = roomOf(a);
  if (!room || room !== roomOf(b)) return false;
  const startA = recordingStartMs(a);
  const startB = recordingStartMs(b);
  if (!Number.isFinite(startA) || !Number.isFinite(startB)) return false;
  if (Math.abs(startA - startB) <= DUPLICATE_START_GAP_MS) return true;
  const minutes = recordingTalk(startA <= startB ? a : b).minutes;
  if (!minutes) return false;
  return Math.max(startA, startB) <= Math.min(startA, startB) + minutes * MINUTE_MS + DUPLICATE_RESUME_GAP_MS;
}

/**
 * meetingId → primary meetingId for every real recording that is a copy of another one of the same meeting
 * (sameRecordedMeeting, transitively). The primary has the most talk; ties go to the earlier start.
 */
export function duplicateRecordingMap(rows = [], { talkOf = recordingTalk } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => (
    text(row?.meetingId) && !isPlaceholderId(row.meetingId) && roomOf(row) && Number.isFinite(recordingStartMs(row))
  ));
  const parent = list.map((_, index) => index);
  const find = (index) => {
    let at = index;
    while (parent[at] !== at) at = parent[at];
    return at;
  };
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (sameRecordedMeeting(list[i], list[j])) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  list.forEach((row, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(row);
  });
  const out = new Map();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const primary = [...members].sort((a, b) => (
      compareTalk(talkOf(b), talkOf(a))
      || recordingStartMs(a) - recordingStartMs(b)
      || text(a.meetingId).localeCompare(text(b.meetingId))
    ))[0];
    for (const row of members) {
      if (row !== primary) out.set(text(row.meetingId), text(primary.meetingId));
    }
  }
  return out;
}

/**
 * Of clients sharing one Meet room, the one whose booked slot in that room the recording started in, or
 * null when none or several fit.
 */
export function slotOwnerAmongClients(record = {}, clients = []) {
  const room = roomOf(record);
  const at = recordingStartMs(record);
  if (!room || !Number.isFinite(at)) return null;
  const fits = (Array.isArray(clients) ? clients : []).filter((client) => clientMeetingSlots(client).some((slot) => (
    slot.rooms.has(room) && slot.slotKey && insideWindow(slotWindow(slot), at)
  )));
  return fits.length === 1 ? fits[0] : null;
}
