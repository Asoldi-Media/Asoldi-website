/**
 * Which Fireflies recordings an open offer should use as AI context.
 */

function sanitizeText(value = '') {
  return String(value ?? '').trim();
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

export function usableMeetingsForOfferFill({ meetings = [], selectedIds = [] } = {}) {
  const listed = (Array.isArray(meetings) ? meetings : []).filter(Boolean);
  const selected = new Set(normalizeOfferMeetingIds(selectedIds));
  const inSelection = selected.size
    ? listed.filter((row) => selected.has(sanitizeText(row?.meetingId)))
    : listed;
  const usableInSelection = inSelection.filter(meetingHasUsableOfferTalk);
  if (usableInSelection.length) return usableInSelection;
  return listed.filter((row) => meetingHasUsableOfferTalk(row) && !isPlaceholderMeetingId(row?.meetingId));
}

/**
 * Auto-fill only when exactly one recording has talk, or the rep already picked.
 * Empty rows wait. Several usable transcripts wait for a pick so we do not mix them.
 */
export function offerAutoFillDecision({ offer = {}, meetings = [], selectedIds = [] } = {}) {
  const usable = usableMeetingsForOfferFill({
    meetings,
    selectedIds: selectedIds.length ? selectedIds : normalizeOfferMeetingIds(offer?.meetingIds, offer?.meetingId),
  });
  if (!usable.length) return { action: 'wait', meetings: [] };
  const picked = sanitizeText(offer?.meetingSource) === 'manual';
  if (usable.length > 1 && !picked) return { action: 'pick', meetings: usable };
  return { action: 'fill', meetings: usable };
}

/** Board/playbook only has the client meeting list (flag + short summary), not the Fireflies store. */
export function offerLetterNeedsMeetingPick(client = {}) {
  if (sanitizeText(client?.offerLetterFilledAt)) return false;
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  return meetings.filter((row) => row?.hasTranscript || sanitizeText(row?.summary)).length > 1;
}

export function transcriptMeetingIds(client = {}) {
  return (Array.isArray(client?.meetings) ? client.meetings : [])
    .filter((row) => sanitizeText(row?.meetingId) && !isPlaceholderMeetingId(row.meetingId) && row?.hasTranscript)
    .map((row) => sanitizeText(row.meetingId));
}

/** Open offers default to every transcript. After Save, keep the stored list. Locked/sent stay as stored. */
export function seedOfferMeetingIds(offer = {}, client = {}) {
  const existing = normalizeOfferMeetingIds(offer?.meetingIds, offer?.meetingId);
  if (offerSelectionLocked(offer)) return existing;
  const transcripts = transcriptMeetingIds(client);
  const kept = existing.filter((id) => !isPlaceholderMeetingId(id) || !transcripts.length);
  if (offerSelectionManual(offer)) return kept;
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
