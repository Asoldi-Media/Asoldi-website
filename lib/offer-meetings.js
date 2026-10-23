/**
 * Which Fireflies recordings an open offer should use as AI context: the sales meeting's, one copy per
 * meeting (lib/fireflies-slots.js). Workshop and iteration recordings are listed but not picked by default.
 */
import { duplicateRecordingIds } from './fireflies-slots.js';

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
 * The selected recordings with talk; with none, the sales meeting's recordings with talk, one copy per
 * meeting (no placeholder, no workshop or iteration recording).
 */
export function usableMeetingsForOfferFill({ meetings = [], selectedIds = [] } = {}) {
  const listed = (Array.isArray(meetings) ? meetings : []).filter(Boolean);
  const selected = new Set(normalizeOfferMeetingIds(selectedIds));
  if (selected.size) {
    const usableInSelection = listed.filter((row) => selected.has(sanitizeText(row?.meetingId)) && meetingHasUsableOfferTalk(row));
    if (usableInSelection.length) return usableInSelection;
  }
  return distinctOfferMeetings(listed.filter((row) => (
    meetingHasUsableOfferTalk(row)
    && !isPlaceholderMeetingId(row?.meetingId)
    && meetingPurposeFitsOffer(row?.purpose)
  )));
}

/**
 * Auto-fill only when exactly one meeting has talk, or the rep already picked. Copies of one meeting
 * (a short fragment next to the real recording) count once and the letter uses the one with the most
 * talk. Empty rows wait. Several meetings wait for a pick so we do not mix them.
 */
export function offerAutoFillDecision({ offer = {}, meetings = [], selectedIds = [] } = {}) {
  const usable = usableMeetingsForOfferFill({
    meetings,
    selectedIds: selectedIds.length ? selectedIds : normalizeOfferMeetingIds(offer?.meetingIds, offer?.meetingId),
  });
  if (!usable.length) return { action: 'wait', meetings: [] };
  const picked = sanitizeText(offer?.meetingSource) === 'manual';
  if (picked) return { action: 'fill', meetings: usable };
  const distinct = distinctOfferMeetings(usable);
  if (distinct.length > 1) return { action: 'pick', meetings: distinct };
  return { action: 'fill', meetings: distinct };
}

/** Board/playbook only has the client meeting list (flag + short summary), not the Fireflies store. */
export function offerLetterNeedsMeetingPick(client = {}) {
  if (sanitizeText(client?.offerLetterFilledAt)) return false;
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  return distinctOfferMeetings(meetings.filter((row) => (
    !isPlaceholderMeetingId(row?.meetingId)
    && (row?.hasTranscript || sanitizeText(row?.summary))
    && meetingPurposeFitsOffer(row?.purpose)
  ))).length > 1;
}

/** Recordings an open offer is seeded with: the sales meeting's transcripts, one copy per meeting. */
export function transcriptMeetingIds(client = {}) {
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const duplicates = duplicateIdsIn(meetings);
  return meetings
    .filter((row) => (
      sanitizeText(row?.meetingId)
      && !isPlaceholderMeetingId(row.meetingId)
      && row?.hasTranscript
      && !duplicates.has(sanitizeText(row.meetingId))
      && meetingPurposeFitsOffer(row?.purpose)
    ))
    .map((row) => sanitizeText(row.meetingId));
}

/**
 * Open offers default to the sales meeting's transcripts (transcriptMeetingIds). After Save, keep the
 * stored list. Locked/sent stay as stored. An automatic selection drops what the seed would not pick.
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
    return !row || (!duplicates.has(id) && meetingPurposeFitsOffer(row.purpose));
  });
  if (!kept.length) return transcripts;
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
