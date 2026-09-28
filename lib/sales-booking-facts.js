const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value) {
  return String(value ?? '').trim();
}

function toIso(value) {
  const raw = text(value);
  if (!raw) return '';
  const normalized = raw.includes(' ') && !raw.includes('T') ? raw.replace(' UTC', 'Z').replace(' ', 'T') : raw;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function asEmail(value) {
  if (value && typeof value === 'object') {
    return asEmail(value.email || value.user_email || value.userEmail || value.mail);
  }
  const candidate = text(value);
  return EMAIL_RE.test(candidate) ? candidate : '';
}

function asName(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number') {
    const raw = text(value);
    if (!raw || EMAIL_RE.test(raw)) return '';
    return raw;
  }
  if (typeof value !== 'object') return '';
  const combined = [value.first_name || value.firstName, value.last_name || value.lastName]
    .map((part) => text(part))
    .filter(Boolean)
    .join(' ');
  return combined || asName(value.name) || asName(value.full_name) || asName(value.fullName);
}

function eventKind(event = {}) {
  return text(event.kind || event.type || event.event || event.action).toLowerCase();
}

function isWinnerEvent(event = {}) {
  const kind = eventKind(event);
  if (kind === 'winner' || kind === 'won') return true;
  const state = text(event.state).toLowerCase();
  return state === 'won' || state === 'winner';
}

function listIdFromLead(source = {}) {
  const raw = text(source.list_id || source.listId || source.list_location || source.listLocation || source.list);
  const match = raw.match(/\/lists\/([^/?#]+)/i);
  if (match) return match[1];
  return /^\d+$/.test(raw) ? raw : '';
}

/**
 * Who booked the meeting, when it was booked, and which MyPhoner list it was sold on.
 * Winner-event user wins, then the agent who claimed the lead, then the call agent.
 */
export function extractBookingFromLead(lead = {}, call = null) {
  const source = lead && typeof lead === 'object' ? lead : {};
  const events = [
    ...(Array.isArray(source.events) ? source.events : []),
    source.last_event,
    source.last_action_or_note,
  ].filter((event) => event && typeof event === 'object');
  const winners = events.filter(isWinnerEvent);
  const winner = winners
    .slice()
    .sort((a, b) => text(a.created_at || a.createdAt).localeCompare(text(b.created_at || b.createdAt)))[0] || null;

  const bookedByEmail = asEmail(winner?.user_email)
    || asEmail(winner?.userEmail)
    || asEmail(winner?.user)
    || asEmail(winner?.agent)
    || asEmail(winner?.created_by)
    || asEmail(source.claimed_by)
    || asEmail(source.claimedBy)
    || asEmail(source.user_email)
    || asEmail(call?.user_email || call?.userEmail || call?.user);
  const bookedByName = asName(winner?.user)
    || asName(winner?.user_name)
    || asName(winner?.name)
    || asName(winner?.agent)
    || asName(winner?.agent_name)
    || asName(source.claimed_by)
    || asName(source.claimedBy)
    || asName(source.user)
    || asName(source.user_name)
    || asName(call?.user)
    || asName(call?.user_name)
    || asName(call?.agent);
  const bookedAt = toIso(winner?.created_at || winner?.createdAt || source.last_event?.created_at || source.updated_at);

  return {
    bookedByEmail,
    bookedByName,
    bookedAt,
    listName: text(source.list_name || source.listName),
    listId: listIdFromLead(source),
  };
}

/** Facts already on the client card, including older call/webhook fields. */
export function salesBookingFacts(client = {}) {
  const my = client?.myphoner && typeof client.myphoner === 'object' ? client.myphoner : {};
  const booker = text(my.bookedByName) || text(my.bookedByEmail) || text(my.latestCallUserEmail);
  const bookedAt = text(my.bookedAt) || text(my.lastWinnerWebhookAt) || (text(my.leadId) ? text(client.createdAt) : '');
  const meetingFor = text(client?.meetingAt);
  const listName = text(my.listName) || text(my.listId);
  return { booker, bookedAt, meetingFor, listName };
}
