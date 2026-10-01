/** Browser-safe workshop booking helpers. No Google or disk imports. */

export const WORKSHOP_DURATION_MINUTES = 30;
export const WORKSHOP_DEFAULT_NAME = 'Workshop';
export const DAMIAN_WORKSHOP_CALENDAR_EMAIL = 'damian@asoldi.com';
export const WORKSHOP_FORMATS = ['mote', 'sms-ring'];

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function parseMs(value = '') {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function makeWorkshopActionId() {
  return `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeWorkshopFormat(value = '') {
  const raw = sanitizeText(value).toLowerCase();
  if (raw === 'sms-ring' || raw === 'smsring' || raw === 'sms/ring') return 'sms-ring';
  return 'mote';
}

export function workshopEventSummary(client = {}, action = {}) {
  const businessName = sanitizeText(client?.businessName);
  const name = sanitizeText(action?.name) || WORKSHOP_DEFAULT_NAME;
  return businessName ? `Asoldi · ${name} · ${businessName}` : `Asoldi · ${name}`;
}

export function normalizeWorkshopAction(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const format = sanitizeWorkshopFormat(input.format);
  const dueAt = parseMs(input.dueAt) != null ? sanitizeText(input.dueAt) : '';
  const addToCalendar = format === 'mote'
    ? Boolean(dueAt)
    : Object.prototype.hasOwnProperty.call(input, 'addToCalendar')
      ? Boolean(input.addToCalendar)
      : false;
  return {
    id: sanitizeText(input.id) || makeWorkshopActionId(),
    name: sanitizeText(input.name) || WORKSHOP_DEFAULT_NAME,
    format,
    dueAt,
    addToCalendar,
    calendarEventId: sanitizeText(input.calendarEventId),
    meetLink: format === 'mote' ? sanitizeText(input.meetLink) : '',
    accountKey: sanitizeText(input.accountKey),
    firefliesInvitedAt: format === 'mote' ? sanitizeText(input.firefliesInvitedAt) : '',
    firefliesMeetingId: sanitizeText(input.firefliesMeetingId),
    firefliesLiveJoinedAt: format === 'mote' ? sanitizeText(input.firefliesLiveJoinedAt) : '',
    firefliesLiveJoinAttemptAt: sanitizeText(input.firefliesLiveJoinAttemptAt),
    firefliesLiveJoinError: sanitizeText(input.firefliesLiveJoinError),
  };
}

/** T06 reads this. Ignore offer startDate, nextActions, details.workshopAction, and client.workshop.action. */
export function getWorkshopAction(client = {}) {
  const raw = client && typeof client === 'object' ? client.workshopAction : null;
  if (!raw || typeof raw !== 'object') return null;
  const normalized = normalizeWorkshopAction(raw);
  if (!normalized.dueAt && !sanitizeText(raw.name) && !sanitizeText(raw.format) && !sanitizeText(raw.calendarEventId)) {
    return null;
  }
  return normalized;
}

export function workshopIsBooked(action = {}) {
  return parseMs(action?.dueAt) != null;
}

export function workshopNeedsCalendarEvent(action = {}) {
  const next = normalizeWorkshopAction(action);
  if (!workshopIsBooked(next)) return false;
  if (next.format === 'mote') return true;
  return Boolean(next.addToCalendar);
}

export function workshopInvitesClient(action = {}) {
  const next = normalizeWorkshopAction(action);
  return next.format === 'mote' && workshopIsBooked(next);
}

/** Offer startDate is date-only copy. It never books a workshop or creates a calendar event. */
export function offerStartDateCreatesEvent(_startDate = '') {
  return false;
}

export function workshopDeleteSendUpdates(action = {}) {
  return sanitizeWorkshopFormat(action?.format) === 'mote' ? 'all' : 'none';
}

export const DAMIAN_CALENDAR_ACCOUNT_KEY = `admin:${DAMIAN_WORKSHOP_CALENDAR_EMAIL}`;

/** Prefer the admin mailbox key when several tokens share damian@asoldi.com. */
export function pickDamianCalendarAccountKey(keys = []) {
  const list = (Array.isArray(keys) ? keys : [])
    .map((key) => sanitizeText(key))
    .filter(Boolean);
  const preferred = list.find((key) => key.toLowerCase() === DAMIAN_CALENDAR_ACCOUNT_KEY.toLowerCase());
  return preferred || list[0] || '';
}

export function buildWorkshopSyntheticMeetingClient(client = {}, action = {}) {
  const next = normalizeWorkshopAction(action);
  return {
    businessName: sanitizeText(client?.businessName),
    contactPerson: sanitizeText(client?.contactPerson),
    contactEmail: sanitizeText(client?.contactEmail),
    contactPhone: sanitizeText(client?.contactPhone),
    meetingAt: next.dueAt,
    meetingMode: 'online',
    calendar: {
      eventId: next.calendarEventId,
      meetLink: next.meetLink,
    },
  };
}

export function workshopEmailShouldSend(previous = {}, next = {}) {
  const prev = previous && typeof previous === 'object' ? normalizeWorkshopAction(previous) : normalizeWorkshopAction({});
  const curr = normalizeWorkshopAction(next);
  if (!workshopIsBooked(curr)) return false;
  if (!workshopIsBooked(prev)) return true;
  return prev.dueAt !== curr.dueAt || prev.format !== curr.format;
}
