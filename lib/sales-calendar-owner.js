/** Sales meetings never use the personal Gmail that used to own the admin calendar. */

export const BLOCKED_CALENDAR_GOOGLE_EMAIL = 'daracha777@gmail.com';
export const DAMIAN_SALES_CALENDAR_EMAIL = 'damian@asoldi.com';

function text(value = '') {
  return String(value ?? '').trim();
}

function emailOf(value = '') {
  return text(value).toLowerCase();
}

export function isBlockedCalendarGoogleEmail(email = '') {
  return emailOf(email) === BLOCKED_CALENDAR_GOOGLE_EMAIL;
}

export function isBlockedCalendarAccountKey(accountKey = '') {
  const key = emailOf(accountKey);
  if (!key) return false;
  return key.includes(BLOCKED_CALENDAR_GOOGLE_EMAIL) || key.includes('daracha777');
}

export function calendarRecordIsOnBlockedMailbox(calendar = {}) {
  const input = calendar && typeof calendar === 'object' ? calendar : {};
  return isBlockedCalendarAccountKey(input.accountKey)
    || isBlockedCalendarGoogleEmail(input.calendarId)
    || isBlockedCalendarGoogleEmail(input.googleEmail);
}

/** Old Gmail admin keys are Damian's pipeline, not a destination mailbox. */
export function calendarOwnerIdForSync(ownerId = '') {
  const owner = text(ownerId);
  if (!owner) return owner;
  if (isBlockedCalendarAccountKey(owner) || isBlockedCalendarGoogleEmail(owner)) {
    return `admin:${DAMIAN_SALES_CALENDAR_EMAIL}`;
  }
  return owner;
}

export function sanitizeMyphonerDefaultOwnerKey(raw = '', fallback = `admin:${DAMIAN_SALES_CALENDAR_EMAIL}`) {
  const value = text(raw);
  if (!value) return fallback;
  if (isBlockedCalendarAccountKey(value) || isBlockedCalendarGoogleEmail(value)) return fallback;
  return value;
}

export function isAssignedSalesRepOwner(ownerId = '') {
  return text(ownerId).startsWith('sales:');
}

/**
 * Unassigned / admin-hold clients do not get a new Google event.
 * Existing events still on the blocked Gmail calendar are moved (no client email).
 */
export function shouldSyncSalesMeetingCalendar({ ownerId = '', calendar = {} } = {}) {
  if (isAssignedSalesRepOwner(ownerId)) return true;
  return Boolean(text(calendar?.eventId)) && calendarRecordIsOnBlockedMailbox(calendar);
}

export function salesClientNeedsCalendarMove(client = {}, now = Date.now()) {
  if (!client?.agreedTime || !text(client?.meetingAt)) return false;
  const meetingMs = new Date(client.meetingAt).getTime();
  if (!Number.isFinite(meetingMs) || meetingMs < now) return false;
  if (!text(client?.calendar?.eventId)) return false;
  return calendarRecordIsOnBlockedMailbox(client.calendar);
}

export function calendarTokenIsUsable(token, accountKey = '') {
  if (isBlockedCalendarAccountKey(accountKey)) return false;
  if (!token || typeof token !== 'object') return false;
  if (!token.refresh_token && !token.access_token) return false;
  if (isBlockedCalendarGoogleEmail(token.googleEmail)) return false;
  return true;
}

export function pickCalendarSyncAccountKey({
  ownerId = '',
  actorAccountKey = '',
  previousAccountKey = '',
  fallbackAccountKeys = [],
  preferredAccountKeys = [],
  isUsable = () => false,
} = {}) {
  const owner = calendarOwnerIdForSync(ownerId);
  const candidates = [
    ...(Array.isArray(preferredAccountKeys) ? preferredAccountKeys : []),
    owner,
    text(actorAccountKey),
    text(previousAccountKey),
    ...(Array.isArray(fallbackAccountKeys) ? fallbackAccountKeys.map((key) => text(key)) : []),
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    const key = text(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (isBlockedCalendarAccountKey(key)) continue;
    if (isUsable(key)) return key;
  }

  const fallback = text(owner) || text(actorAccountKey);
  if (isBlockedCalendarAccountKey(fallback)) return owner || '';
  return fallback;
}
