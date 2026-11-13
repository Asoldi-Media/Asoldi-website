/**
 * When a linked recording IS a booked meeting's recording ("covers" it): the one rule, read with the stored
 * Fireflies copies. A placeholder ('live:…') is covered by a real recording on the card
 *   - with talk that is not live captions (storedMeetingIsPartial),
 *   - of more than a fragment (lib/fireflies-slots.js talkCoversPlaceholder: COVER_MIN_SENTENCES sentences,
 *     or talk from before sentences were counted), counted on the stored copy,
 *   - on the placeholder's own slot by the slot rules (placeholderSupersededBy: its room and window, the
 *     bot capture saw, a person's pick or link).
 * The card (lib/workshop-meetings.js clientMeetingRowsView), capture (lib/fireflies-live-sessions.js
 * clientHasTranscriptForSession) and the watchdog (lib/fireflies-recording-watchdog.js) all ask here, so a
 * "hallo?" fragment from a bot that sat alone, or live captions linked while the meeting runs, never make one
 * of them think the meeting is recorded while another still waits for it.
 * Server only (it reads the archive); lib/fireflies-slots.js keeps the browser-safe rules.
 */
import {
  clientMeetingSlots,
  meetingSlotFacts,
  placeholderSessionEndMs,
  placeholderSupersededBy,
  recordingTalk,
  talkCoversPlaceholder,
} from './fireflies-slots.js';
import { readStoredFirefliesMeeting, storedMeetingHasTalk, storedMeetingIsPartial } from './fireflies-webhook.js';

function text(value) {
  return String(value ?? '').trim();
}

function isPlaceholderId(id = '') {
  return text(id).toLowerCase().startsWith('live:');
}

/** Talk of a client row, read from the stored copy where there is one (sentence count, transcript, length). */
export function storedTalkOf(readStored = readStoredFirefliesMeeting) {
  return (row = {}) => {
    const stored = isPlaceholderId(row?.meetingId) ? null : readStored(row?.meetingId);
    if (!stored) return recordingTalk(row);
    const storedMinutes = stored.durationMinutes === '' || stored.durationMinutes == null ? null : stored.durationMinutes;
    return recordingTalk({
      ...row,
      sentenceCount: stored.sentenceCount ?? row.sentenceCount,
      transcript: stored.transcript || '',
      summary: stored.summary || row.summary,
      hasTranscript: storedMeetingHasTalk(stored) || Boolean(row.hasTranscript),
      durationMinutes: storedMinutes ?? row.durationMinutes,
    });
  };
}

/** A recording that can stand in for a placeholder: talk on disk (on the row when nothing is stored) that is not live captions. */
export function storedCountsAsTalk(row = {}, stored = null) {
  if (isPlaceholderId(row?.meetingId)) return false;
  const talk = stored ? storedMeetingHasTalk(stored) : Boolean(row?.hasTranscript);
  return talk && !storedMeetingIsPartial(stored);
}

/**
 * Would this Fireflies record (a stored copy, or one just fetched) cover a booked meeting once it is linked:
 * talk that is not live captions and more than a fragment, counted as the card will count it.
 */
export function storedRecordCovers(record = null) {
  if (!record || typeof record !== 'object' || isPlaceholderId(record.meetingId)) return false;
  return storedCountsAsTalk(record, record) && talkCoversPlaceholder(storedTalkOf(() => record)(record));
}

/** Talk that is not live captions, but too little to be the meeting (a "hallo?" in an open room). */
export function storedRecordIsFragment(record = null) {
  if (!record || typeof record !== 'object' || isPlaceholderId(record.meetingId)) return false;
  return storedCountsAsTalk(record, record) && !storedRecordCovers(record);
}

function slotFactsOf(row = {}) {
  return {
    slotKey: text(row.slotKey),
    purpose: text(row.purpose),
    by: text(row.purposePickedAt) ? 'person' : '',
  };
}

/**
 * The ids of the placeholders among `rows` that a recording covers. `rows` are a card's rows, each tagged
 * with the purpose and slotKey the slot rules give it now (as clientMeetingRowsView tags them);
 * `storedOf(id)` is the stored copy of a recording, or null.
 */
export function coveredPlaceholderIds(rows = [], { storedOf = readStoredFirefliesMeeting, sessionEndMs = placeholderSessionEndMs } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.some((row) => isPlaceholderId(row?.meetingId))) return new Set();
  // One read per recording, however many placeholders ask about it.
  const copies = new Map();
  const copyOf = (id) => {
    const key = text(id);
    if (!key || isPlaceholderId(key)) return null;
    if (!copies.has(key)) copies.set(key, storedOf(key) || null);
    return copies.get(key);
  };
  const talkOf = storedTalkOf(copyOf);
  const covered = new Set();
  for (const row of list) {
    if (!isPlaceholderId(row?.meetingId)) continue;
    const by = placeholderSupersededBy(row, list, {
      factsOf: slotFactsOf,
      countsAsTalk: (candidate) => storedCountsAsTalk(candidate, copyOf(candidate?.meetingId)),
      talkOf,
      sessionEndMs,
    });
    if (by) covered.add(text(row.meetingId));
  }
  return covered;
}

/**
 * Would linking `record` (a stored or fetched Fireflies record) to this client cover the placeholder
 * `placeholderId`? The card's rule, run on the card as it would be with the record on it: its room, start or
 * bot id decide its slot, its own copy the talk. A recording with talk that would land on another booked slot
 * of the client (a second meeting in the same room that day) does not.
 */
export function recordWouldCover(client = {}, placeholderId = '', record = null, { storedOf = readStoredFirefliesMeeting, sessionEndMs = placeholderSessionEndMs } = {}) {
  const id = text(record?.meetingId);
  if (!id || !storedRecordCovers(record)) return false;
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const existing = meetings.find((row) => text(row?.meetingId) === id) || null;
  const row = {
    ...(existing || {}),
    meetingId: id,
    meetLink: text(record.meetingLink || record.meetLink) || text(existing?.meetLink),
    startedAt: text(record.startedAt) || text(existing?.startedAt),
    hasTranscript: true,
    linkedBy: text(existing?.linkedBy) || 'meet-link',
  };
  const linked = { ...client, meetings: [...meetings.filter((item) => item !== existing), row] };
  return clientCoveredPlaceholderIds(linked, {
    storedOf: (key) => (text(key) === id ? record : storedOf(key)),
    sessionEndMs,
  }).has(text(placeholderId));
}

const MOVED_BEFORE_MS = 30 * 60 * 1000;
const MOVED_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Sales placeholders whose meeting was held and recorded anyway, at a moved time or in a re-minted room: the
 * card holds a sales recording that covers a meeting (talk, more than a fragment) and started from 30
 * minutes before to under 2 hours after the placeholder's booked start. A placeholder exists only once the
 * first send went out (T-3), so only a last-minute move leaves one behind; a recording hours later is
 * another meeting. The slot rules above tie a recording to one room and window; this keeps the old time of
 * a moved meeting from being reported "ingen opptak".
 */
export function movedSalesPlaceholderIds(client = {}, { storedOf = readStoredFirefliesMeeting, sessionEndMs = placeholderSessionEndMs } = {}) {
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  if (!meetings.some((row) => isPlaceholderId(row?.meetingId))) return new Set();
  const slots = clientMeetingSlots(client);
  const tagged = meetings.map((row) => ({ row, facts: meetingSlotFacts(client, row, { slots, sessionEndMs }) }));
  const isSales = (facts) => facts.purpose === 'sales' || Boolean(facts.forSalesMeeting);
  // A recording the slot rules cannot place (its room or time matches no booked slot) may be the moved one.
  const mayBeSales = (facts) => isSales(facts) || !text(facts.purpose);
  const talkOf = storedTalkOf(storedOf);
  const heldStarts = tagged
    .filter(({ row, facts }) => !isPlaceholderId(row?.meetingId) && !text(row?.duplicateOf) && mayBeSales(facts)
      && storedCountsAsTalk(row, storedOf(row.meetingId)) && talkCoversPlaceholder(talkOf(row)))
    .map(({ row }) => Date.parse(text(row.startedAt)))
    .filter(Number.isFinite);
  const moved = new Set();
  if (!heldStarts.length) return moved;
  for (const { row, facts } of tagged) {
    if (!isPlaceholderId(row?.meetingId) || !isSales(facts)) continue;
    const start = Date.parse(text(row.startedAt));
    if (!Number.isFinite(start)) continue;
    if (heldStarts.some((ms) => ms >= start - MOVED_BEFORE_MS && ms < start + MOVED_AFTER_MS)) moved.add(text(row.meetingId));
  }
  return moved;
}

/** coveredPlaceholderIds for a client as it is stored: each row tagged by the slot rules first (meetingSlotFacts). */
export function clientCoveredPlaceholderIds(client = {}, { storedOf = readStoredFirefliesMeeting, sessionEndMs = placeholderSessionEndMs } = {}) {
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  if (!meetings.some((row) => isPlaceholderId(row?.meetingId))) return new Set();
  const slots = clientMeetingSlots(client);
  const rows = meetings.map((row) => {
    const facts = meetingSlotFacts(client, row, { slots, sessionEndMs });
    return { ...row, purpose: facts.purpose, slotKey: facts.slotKey, forSalesMeeting: facts.forSalesMeeting };
  });
  return coveredPlaceholderIds(rows, { storedOf, sessionEndMs });
}
