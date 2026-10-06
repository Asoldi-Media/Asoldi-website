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

export function transcriptMeetingIds(client = {}) {
  return (Array.isArray(client?.meetings) ? client.meetings : [])
    .filter((row) => sanitizeText(row?.meetingId) && !isPlaceholderMeetingId(row.meetingId) && row?.hasTranscript)
    .map((row) => sanitizeText(row.meetingId));
}

/** Open offers: all transcripts, plus any already picked. Locked/sent offers stay as stored. */
export function seedOfferMeetingIds(offer = {}, client = {}) {
  const existing = normalizeOfferMeetingIds(offer?.meetingIds, offer?.meetingId);
  if (offerSelectionLocked(offer)) return existing;
  const transcripts = transcriptMeetingIds(client);
  const kept = existing.filter((id) => !isPlaceholderMeetingId(id) || !transcripts.length);
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
