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

/** Shared company mailboxes. A sales meeting must not be hosted by these. */
const SHARED_CALENDAR_MAILBOXES = new Set([
  'contact@asoldi.com',
  'admin@asoldi.com',
  'asoldi@asoldi.com',
]);

export function isSharedCalendarMailbox(email = '') {
  return SHARED_CALENDAR_MAILBOXES.has(emailOf(email));
}

export function isUnacceptableMeetingHostEmail(email = '') {
  return isBlockedCalendarGoogleEmail(email) || isSharedCalendarMailbox(email);
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
  if (isUnacceptableMeetingHostEmail(token.googleEmail)) return false;
  return true;
}

/**
 * True only when we created this Meet ourselves on the owning rep's Google account.
 * Calendar organizer email is not enough: an old room from contact@ or another account
 * can sit on the rep's calendar event and still be hosted by the other account.
 */
export function salesMeetHostIsVerified(expectedOwnerEmail = '', verifiedHostEmail = '') {
  const expected = emailOf(expectedOwnerEmail);
  const verified = emailOf(verifiedHostEmail);
  if (!expected || !verified) return false;
  if (isUnacceptableMeetingHostEmail(expected) || isUnacceptableMeetingHostEmail(verified)) return false;
  return expected === verified;
}

/**
 * True when this Google event's Meet was not created by the sales rep who owns the client.
 * The calendar organizer can already be the rep while the Meet room still belongs to the
 * account that first created the conference (shared contact@ or the old Gmail).
 */
export function salesMeetNeedsFreshConference({
  expectedOwnerEmail = '',
  verifiedHostEmail = '',
  organizerEmail = '',
  creatorEmail = '',
  hangoutLink = '',
} = {}) {
  const expected = emailOf(expectedOwnerEmail);
  if (!expected || isUnacceptableMeetingHostEmail(expected)) return false;
  if (!salesMeetHostIsVerified(expected, verifiedHostEmail)) return true;
  const link = text(hangoutLink);
  const hasMeet = /^https:\/\/meet\.google\.com\//i.test(link)
    && !/asoldi-(sim|email)-test|lookup\/asoldi/i.test(link);
  if (link && !hasMeet) return true;
  const organizer = emailOf(organizerEmail);
  const creator = emailOf(creatorEmail);
  if (organizer && (organizer !== expected || isUnacceptableMeetingHostEmail(organizer))) return true;
  if (creator && (creator !== expected || isUnacceptableMeetingHostEmail(creator))) return true;
  return false;
}

/** Open Meet already signed in as the sales rep, so they join as host instead of a guest. */
export function salesMeetJoinUrl(meetLink = '', hostEmail = '') {
  const link = text(meetLink);
  if (!/^https:\/\/meet\.google\.com\//i.test(link)) return '';
  const email = emailOf(hostEmail);
  if (!email.endsWith('@asoldi.com') || isUnacceptableMeetingHostEmail(email)) return link;
  const continueUrl = encodeURIComponent(link);
  const hd = encodeURIComponent('asoldi.com');
  return `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(email)}&hd=${hd}&continue=${continueUrl}`;
}

/** A meeting that has started, or starts within 15 minutes, keeps its current Meet room. */
export function salesMeetingIsInProgress(meetingAt = '', durationMinutes = 60, nowMs = Date.now()) {
  const start = new Date(meetingAt || '').getTime();
  if (!Number.isFinite(start)) return false;
  const minutes = Number(durationMinutes);
  const durationMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60 * 1000;
  return nowMs >= start - 15 * 60 * 1000 && nowMs <= start + durationMs + 20 * 60 * 1000;
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
