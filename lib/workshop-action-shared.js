/** Browser-safe workshop booking helpers. No Google or disk imports. */

export const WORKSHOP_DURATION_MINUTES = 30;
export const WORKSHOP_DEFAULT_NAME = 'Workshop';
export const DAMIAN_WORKSHOP_CALENDAR_EMAIL = 'damian@asoldi.com';
export const WORKSHOP_PRIMARY_CALENDAR_ID = 'primary';
export const WORKSHOP_FORMATS = ['sms', 'ring', 'sms-ring', 'mote'];
export const WORKSHOP_TIMEZONE = 'Europe/Oslo';
export const DAMIAN_CALENDAR_DISCONNECTED_MESSAGE = 'damian@asoldi.com er ikke koblet til Google Calendar. Workshopen ble lagret, men ikke lagt i kalenderen. Selgerens kalender brukes ikke.';

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
  if (raw === 'sms') return 'sms';
  if (raw === 'ring') return 'ring';
  if (raw === 'sms-ring' || raw === 'smsring' || raw === 'sms/ring' || raw === 'sms / ring') return 'sms-ring';
  return 'mote';
}

export function workshopFormatInvitesClient(format = '') {
  return sanitizeWorkshopFormat(format) === 'mote';
}

export function workshopFormatIsPhone(format = '') {
  const raw = sanitizeText(format).toLowerCase();
  return raw === 'sms' || raw === 'ring' || raw === 'sms-ring' || raw === 'smsring' || raw === 'sms/ring' || raw === 'sms / ring';
}

/** Real Meet URLs look like https://meet.google.com/abc-defg-hij — reject placeholders/tests. */
export function isRealWorkshopMeetLink(value = '') {
  const url = sanitizeText(value);
  if (!url) return false;
  if (!/^https:\/\/meet\.google\.com\//i.test(url)) return false;
  if (/asoldi-(sim|email)-test|lookup\/asoldi/i.test(url)) return false;
  return /meet\.google\.com\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}(?:\?|$)/i.test(url)
    || /meet\.google\.com\/[a-z0-9-]{10,}(?:\?|$)/i.test(url);
}

/** Force the damian@asoldi.com Google session so Admin Chrome (often another account) is not a guest. */
export function damianMeetJoinUrl(meetLink = '') {
  if (!isRealWorkshopMeetLink(meetLink)) return '';
  const continueUrl = encodeURIComponent(sanitizeText(meetLink));
  const email = encodeURIComponent(DAMIAN_WORKSHOP_CALENDAR_EMAIL);
  const hd = encodeURIComponent('asoldi.com');
  return `https://accounts.google.com/AccountChooser?Email=${email}&hd=${hd}&continue=${continueUrl}`;
}

function emailOf(value = '') {
  return sanitizeText(value).toLowerCase();
}

/** Fail closed unless Damian owns the Google event, the Meet, and Fireflies is a guest. */
export function workshopInviteHostError(meta = {}) {
  const expected = DAMIAN_WORKSHOP_CALENDAR_EMAIL.toLowerCase();
  const googleEmail = emailOf(meta.googleEmail);
  const organizerEmail = emailOf(meta.organizerEmail);
  if (googleEmail !== expected) {
    if (!googleEmail) return DAMIAN_CALENDAR_DISCONNECTED_MESSAGE;
    return 'Google-kontoen som opprettet møtet er ikke damian@asoldi.com. Koble damian@asoldi.com og prøv igjen. Selgerens kalender brukes ikke.';
  }
  if (!organizerEmail) {
    return 'Google svarte uten eier på kalenderhendelsen. Møtet ble ikke sendt.';
  }
  if (organizerEmail !== expected) {
    return 'Google-møtet har en annen eier enn damian@asoldi.com. Møtet ble ikke sendt.';
  }
  if (!isRealWorkshopMeetLink(meta.meetLink)) {
    return 'Google Calendar sync ran but did not return a real Google Meet link.';
  }
  if (!meta.firefliesInvited) {
    return 'Google did not keep fred@fireflies.ai on the event. Check that this Google account can invite guests outside the company, then send again.';
  }
  return '';
}

export function workshopInviteHostOk(meta = {}) {
  return workshopInviteHostError(meta) === '';
}

export function workshopInviteShouldDeleteFailedEvent(meta = {}) {
  const expected = DAMIAN_WORKSHOP_CALENDAR_EMAIL.toLowerCase();
  const googleEmail = emailOf(meta.googleEmail);
  const organizerEmail = emailOf(meta.organizerEmail);
  if (googleEmail !== expected) return true;
  if (organizerEmail && organizerEmail !== expected) return true;
  if (!isRealWorkshopMeetLink(meta.meetLink)) return true;
  return false;
}

export function offerStartDateFromWorkshopDueAt(dueAt = '') {
  const ms = parseMs(dueAt);
  if (ms == null) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORKSHOP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : '';
}

export function workshopIsConfirmed(action = {}) {
  const input = action && typeof action === 'object' ? action : {};
  if (sanitizeText(input.confirmationSentAt)) return true;
  return sanitizeText(input.status).toLowerCase() === 'confirmed';
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
  const confirmationSentAt = sanitizeText(input.confirmationSentAt);
  const status = confirmationSentAt || sanitizeText(input.status).toLowerCase() === 'confirmed'
    ? 'confirmed'
    : 'draft';
  return {
    id: sanitizeText(input.id) || makeWorkshopActionId(),
    name: sanitizeText(input.name) || WORKSHOP_DEFAULT_NAME,
    format,
    dueAt,
    addToCalendar,
    status,
    confirmationSentAt,
    calendarEventId: sanitizeText(input.calendarEventId),
    meetLink: format === 'mote' ? sanitizeText(input.meetLink) : '',
    accountKey: sanitizeText(input.accountKey),
    firefliesInvitedAt: format === 'mote' ? sanitizeText(input.firefliesInvitedAt) : '',
    firefliesMeetingId: sanitizeText(input.firefliesMeetingId),
    firefliesLiveJoinedAt: format === 'mote' ? sanitizeText(input.firefliesLiveJoinedAt) : '',
    firefliesLiveJoinAttemptAt: sanitizeText(input.firefliesLiveJoinAttemptAt),
    firefliesLiveJoinError: sanitizeText(input.firefliesLiveJoinError),
    firefliesLiveJoinedMeetLink: format === 'mote' ? sanitizeText(input.firefliesLiveJoinedMeetLink) : '',
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
  if (workshopFormatInvitesClient(next.format)) return Boolean(next.addToCalendar);
  return Boolean(next.addToCalendar);
}

export function workshopInvitesClient(action = {}) {
  const next = normalizeWorkshopAction(action);
  return workshopFormatInvitesClient(next.format) && workshopIsBooked(next) && Boolean(next.addToCalendar);
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

export function workshopEmailShouldSend(previous = {}, next = {}, options = {}) {
  if (!options?.confirmSend) return false;
  const prev = previous && typeof previous === 'object' ? normalizeWorkshopAction(previous) : normalizeWorkshopAction({});
  const curr = normalizeWorkshopAction(next);
  if (!workshopInvitesClient(curr)) return false;
  if (!sanitizeText(prev.confirmationSentAt) && !sanitizeText(prev.calendarEventId)) return true;
  if (!workshopIsBooked(prev)) return true;
  return prev.dueAt !== curr.dueAt || prev.format !== curr.format;
}
