/**
 * Which Fireflies recordings an open offer should use as AI context: the sales meeting's, one copy per
 * meeting (lib/fireflies-slots.js). Workshop and iteration recordings are listed but not picked by default,
 * and a fragment of a few sentences is not the meeting's recording (the card's cover rule).
 */
import { normalizeFirefliesMeetLink } from './fireflies-client-match.js';
import { duplicateRecordingIds, recordingTalk, talkCoversPlaceholder } from './fireflies-slots.js';

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

/** An offer is written from the sales meeting: workshop and iteration recordings only when a rep picks them. */
export function meetingPurposeFitsOffer(purpose = '') {
  const value = sanitizeText(purpose).toLowerCase();
  return value !== 'workshop' && value !== 'iteration';
}

/**
 * The rows that are a shorter or emptier copy of another row in the list (duplicateOf from the card, or
 * worked out from room, start, slot and talk). A copy whose primary is not in the list stays.
 */
function duplicateIdsIn(rows = []) {
  return duplicateRecordingIds(rows);
}

/** One row per meeting: the copy with the most talk. */
export function distinctOfferMeetings(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const duplicates = duplicateIdsIn(list);
  return list.filter((row) => !duplicates.has(sanitizeText(row?.meetingId)));
}

function offerSelectionLocked(offer = {}) {
  const status = sanitizeText(offer?.status);
  return status === 'review-requested' || status === 'verified' || status === 'sent';
}

function offerSelectionManual(offer = {}) {
  return sanitizeText(offer?.meetingSource) === 'manual';
}

export function normalizeOfferMeetingIds(rawIds = [], fallbackId = '') {
  const ids = [];
  const seen = new Set();
  const source = [...(Array.isArray(rawIds) ? rawIds : []), fallbackId];
  for (const value of source) {
    const id = sanitizeText(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function isPlaceholderMeetingId(meetingId = '') {
  return sanitizeText(meetingId).toLowerCase().startsWith('live:');
}

export function meetingHasOfferTalk(meeting = {}) {
  return Boolean(
    sanitizeText(meeting?.transcript)
    || sanitizeText(meeting?.summary)
    || meeting?.hasTranscript
  );
}

/** Real Fireflies text on disk. A hasTranscript flag on an empty row is not enough to write the letter. */
export function meetingHasUsableOfferTalk(meeting = {}) {
  return Boolean(sanitizeText(meeting?.transcript) || sanitizeText(meeting?.summary));
}

/**
 * A real recording with talk, but only a few sentences counted (a "hallo?" from a bot that sat alone):
 * by the card's rule (lib/fireflies-slots.js talkCoversPlaceholder) it is not the meeting's recording.
 */
export function offerMeetingIsFragment(row = {}) {
  if (!sanitizeText(row?.meetingId) || isPlaceholderMeetingId(row.meetingId) || !meetingHasOfferTalk(row)) return false;
  const talk = recordingTalk(row);
  return talk.known && !talkCoversPlaceholder(talk);
}

function roomOf(row = {}) {
  return normalizeFirefliesMeetLink(row?.meetLink || row?.meetingLink);
}

/** Fragments in a room where another row is a recording with real talk: noise next to that meeting. */
function withoutFragmentsBeside(rows = []) {
  const rooms = new Set(rows
    .filter((row) => meetingHasOfferTalk(row) && !offerMeetingIsFragment(row))
    .map(roomOf)
    .filter(Boolean));
  return rows.filter((row) => !offerMeetingIsFragment(row) || !rooms.has(roomOf(row)));
}

/**
 * The selected recordings with talk; with none, the sales meeting's recordings with talk, one copy per
 * meeting (no placeholder, no workshop or iteration recording).
 */
export function usableMeetingsForOfferFill({ meetings = [], selectedIds = [] } = {}) {
  const listed = (Array.isArray(meetings) ? meetings : []).filter(Boolean);
  const selected = new Set(normalizeOfferMeetingIds(selectedIds));
  if (selected.size) {
    const usableInSelection = withoutFragmentsBeside(listed.filter((row) => (
      selected.has(sanitizeText(row?.meetingId)) && meetingHasUsableOfferTalk(row)
    )));
    if (usableInSelection.length) return usableInSelection;
  }
  return distinctOfferMeetings(withoutFragmentsBeside(listed.filter((row) => (
    meetingHasUsableOfferTalk(row)
    && !isPlaceholderMeetingId(row?.meetingId)
    && meetingPurposeFitsOffer(row?.purpose)
  ))));
}

/**
 * Auto-fill only when exactly one meeting has talk, or the rep already picked. Copies of one meeting
 * (a short fragment next to the real recording) count once and the letter uses the one with the most
 * talk. Empty rows wait. Several meetings wait for a pick so we do not mix them. `tooThin(meetings)`
 * (server: lib/offer-ai.js meetingContextIsTooThin with the product notes) makes noise wait as well.
 */
export function offerAutoFillDecision({ offer = {}, meetings = [], selectedIds = [], tooThin = () => false } = {}) {
  const usable = usableMeetingsForOfferFill({
    meetings,
    selectedIds: selectedIds.length ? selectedIds : normalizeOfferMeetingIds(offer?.meetingIds, offer?.meetingId),
  });
  if (!usable.length) return { action: 'wait', meetings: [] };
  const picked = sanitizeText(offer?.meetingSource) === 'manual';
  const chosen = picked ? usable : distinctOfferMeetings(usable);
  if (!picked && chosen.length > 1) return { action: 'pick', meetings: chosen };
  if (tooThin(chosen)) return { action: 'wait', meetings: [] };
  return { action: 'fill', meetings: chosen };
}

/** Board/playbook only has the client meeting list (flag + short summary), not the Fireflies store. */
export function offerLetterNeedsMeetingPick(client = {}) {
  if (sanitizeText(client?.offerLetterFilledAt)) return false;
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  return distinctOfferMeetings(withoutFragmentsBeside(meetings.filter((row) => (
    !isPlaceholderMeetingId(row?.meetingId)
    && (row?.hasTranscript || sanitizeText(row?.summary))
    && meetingPurposeFitsOffer(row?.purpose)
  )))).length > 1;
}

/** The booked sales meeting's placeholder on the card: it stands for the meeting while no recording does. */
function bookedSalesPlaceholderIds(client = {}) {
  const startMs = client?.agreedTime ? Date.parse(sanitizeText(client.meetingAt)) : NaN;
  if (!Number.isFinite(startMs)) return [];
  const row = (Array.isArray(client?.meetings) ? client.meetings : []).find((item) => (
    isPlaceholderMeetingId(item?.meetingId) && sanitizeText(item.slotKey) === `sales:${startMs}`
  ));
  return row ? [sanitizeText(row.meetingId)] : [];
}

/**
 * Recordings an open offer is seeded with: the sales meeting's transcripts, one copy per meeting, never a
 * fragment of a few sentences (so a booked meeting with only a "hallo?" keeps its placeholder).
 */
export function transcriptMeetingIds(client = {}) {
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const duplicates = duplicateIdsIn(meetings);
  return meetings
    .filter((row) => (
      sanitizeText(row?.meetingId)
      && !isPlaceholderMeetingId(row.meetingId)
      && row?.hasTranscript
      && !offerMeetingIsFragment(row)
      && !duplicates.has(sanitizeText(row.meetingId))
      && meetingPurposeFitsOffer(row?.purpose)
    ))
    .map((row) => sanitizeText(row.meetingId));
}

/**
 * Open offers default to the sales meeting's transcripts (transcriptMeetingIds). After Save, keep the
 * stored list. Locked/sent stay as stored. An automatic selection drops what the seed would not pick; with
 * nothing left, the booked sales meeting's placeholder stands for the meeting.
 */
export function seedOfferMeetingIds(offer = {}, client = {}) {
  const existing = normalizeOfferMeetingIds(offer?.meetingIds, offer?.meetingId);
  if (offerSelectionLocked(offer)) return existing;
  const transcripts = transcriptMeetingIds(client);
  const placeholderFree = existing.filter((id) => !isPlaceholderMeetingId(id) || !transcripts.length);
  if (offerSelectionManual(offer)) return placeholderFree;
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const duplicates = duplicateIdsIn(meetings);
  const kept = placeholderFree.filter((id) => {
    const row = meetings.find((item) => sanitizeText(item?.meetingId) === id);
    return !row || (!duplicates.has(id) && meetingPurposeFitsOffer(row.purpose) && !offerMeetingIsFragment(row));
  });
  if (!kept.length) return transcripts.length ? transcripts : bookedSalesPlaceholderIds(client);
  const seen = new Set(kept);
  const next = [...transcripts.filter((id) => seen.has(id)), ...kept.filter((id) => !transcripts.includes(id))];
  for (const id of transcripts) {
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

export function toggleOfferMeetingId(offer = {}, meetingId = '') {
  const id = sanitizeText(meetingId);
  const current = normalizeOfferMeetingIds(offer?.meetingIds, offer?.meetingId);
  if (!id) return current;
  if (current.includes(id)) return current.filter((entry) => entry !== id);
  return [...current, id];
}

/** Paste / match picks this recording. It never unchecks one that is already on the offer. */
export function selectOfferMeetingId(currentIds = [], meetingId = '') {
  const id = sanitizeText(meetingId);
  const current = normalizeOfferMeetingIds(currentIds);
  if (!id || current.includes(id)) return current;
  return [...current, id];
}
