import { firefliesMeetLinksDiffer, normalizeFirefliesMeetLink } from './fireflies-client-match.js';

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

function isRealOwnerMeetLink(value = '') {
  const link = text(value);
  return /^https:\/\/meet\.google\.com\//i.test(link)
    && !/asoldi-(sim|email)-test|lookup\/asoldi/i.test(link);
}

/** Live Google event was created and is hosted by the owning rep. */
export function salesMeetLooksOwnerHosted({
  expectedOwnerEmail = '',
  organizerEmail = '',
  creatorEmail = '',
  hangoutLink = '',
} = {}) {
  const expected = emailOf(expectedOwnerEmail);
  if (!expected || isUnacceptableMeetingHostEmail(expected)) return false;
  if (!isRealOwnerMeetLink(hangoutLink)) return false;
  const organizer = emailOf(organizerEmail);
  const creator = emailOf(creatorEmail);
  if (!organizer || organizer !== expected || isUnacceptableMeetingHostEmail(organizer)) return false;
  if (!creator || creator !== expected || isUnacceptableMeetingHostEmail(creator)) return false;
  return true;
}

/**
 * True when this Google event's Meet was not created by the sales rep who owns the client.
 * The calendar organizer can already be the rep while the Meet room still belongs to the
 * account that first created the conference (shared contact@ or the old Gmail).
 * A missing meetHostVerifiedEmail stamp is not enough to mint a new room when the live
 * event is already owned by that rep — replacing at meeting start sends Fireflies to the
 * old Meet and the people to a new one.
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
  const ownerHosted = salesMeetLooksOwnerHosted({
    expectedOwnerEmail: expected,
    organizerEmail,
    creatorEmail,
    hangoutLink,
  });
  if (!salesMeetHostIsVerified(expected, verifiedHostEmail) && !ownerHosted) return true;
  const link = text(hangoutLink);
  if (link && !isRealOwnerMeetLink(link)) return true;
  const organizer = emailOf(organizerEmail);
  const creator = emailOf(creatorEmail);
  if (organizer && (organizer !== expected || isUnacceptableMeetingHostEmail(organizer))) return true;
  if (creator && (creator !== expected || isUnacceptableMeetingHostEmail(creator))) return true;
  return false;
}

/** Meet URL that went in the confirmation email. Later calendar syncs must not drift off it. */
export function salesConfirmedMeetLink(calendar = {}) {
  const confirmed = text(calendar?.confirmedMeetLink);
  if (isRealOwnerMeetLink(confirmed)) return confirmed;
  const current = text(calendar?.meetLink);
  return isRealOwnerMeetLink(current) ? current : '';
}

function skipSalesInboxMeetLink(value = '') {
  const link = normalizeFirefliesMeetLink(value);
  return Boolean(link);
}

function salesNonSalesMeetSkipSet(client = {}) {
  const skip = new Set();
  const add = (value) => {
    if (skipSalesInboxMeetLink(value)) skip.add(normalizeFirefliesMeetLink(value));
  };
  add(client?.workshopAction?.meetLink);
  add(client?.workshop?.iterationMeeting?.meetLink);
  for (const action of Array.isArray(client?.nextActions) ? client.nextActions : []) {
    add(action?.meetLink);
  }
  return skip;
}

function salesRecordedInboxCandidates(client = {}) {
  const skip = salesNonSalesMeetSkipSet(client);
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(client?.recordedMeetLinks) ? client.recordedMeetLinks : []) {
    if (!isRealOwnerMeetLink(raw)) continue;
    const key = normalizeFirefliesMeetLink(raw);
    if (!key || skip.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(text(raw));
  }
  return out;
}

/**
 * URL the client already has (confirmation mail) or the room we must keep so
 * later assign/confirm does not mint a second one. Does not send mail.
 */
export function salesInboxMeetLink(client = {}) {
  const calendar = client?.calendar || {};
  const stamped = text(calendar.confirmedMeetLink);
  if (isRealOwnerMeetLink(stamped)) return stamped;

  const recorded = salesRecordedInboxCandidates(client);
  const current = isRealOwnerMeetLink(calendar.meetLink) ? text(calendar.meetLink) : '';
  // shortcut: recordedMeetLinks is oldest-first; a later swap is appended. If
  // that order is ever reversed, restore from the confirmation ICS instead.
  if (recorded.length >= 2 && current && !firefliesMeetLinksDiffer(recorded[recorded.length - 1], current)) {
    return recorded.find((link) => firefliesMeetLinksDiffer(link, current)) || recorded[0];
  }
  if (recorded.length) return recorded[0];
  return current;
}

/** Stamp the inbox/existing room onto the sales card. Never sends email. */
export function planConfirmedMeetBackfill(client = {}) {
  const inbox = salesInboxMeetLink(client);
  if (!isRealOwnerMeetLink(inbox)) return null;
  const calendar = client?.calendar || {};
  if (
    !firefliesMeetLinksDiffer(calendar.confirmedMeetLink, inbox)
    && !firefliesMeetLinksDiffer(calendar.meetLink, inbox)
  ) {
    return null;
  }
  return { meetLink: inbox, confirmedMeetLink: inbox };
}

/** Sales week grid / event details must show the inbox room, not a later Google hangout. */
export function overlaySalesInboxMeetOnEvents(events = [], clients = []) {
  const byEventId = new Map();
  for (const client of Array.isArray(clients) ? clients : []) {
    const eventId = text(client?.calendar?.eventId);
    const inbox = salesInboxMeetLink(client);
    if (!eventId || !isRealOwnerMeetLink(inbox)) continue;
    byEventId.set(eventId, inbox);
  }
  if (!byEventId.size) return Array.isArray(events) ? events : [];
  return (Array.isArray(events) ? events : []).map((event) => {
    const inbox = byEventId.get(text(event?.id));
    if (!inbox) return event;
    const location = text(event?.location);
    const locationIsMeet = isRealOwnerMeetLink(location) || !location;
    return {
      ...event,
      meetLink: inbox,
      location: locationIsMeet ? inbox : event.location,
    };
  });
}

/**
 * Keep the room the client already has. forceOwnerMeet is only when we still
 * need to mint one for a first confirmation.
 */
export function preserveEmailedMeetOnSync({
  forceOwnerMeet = false,
  thankYouSentAt = '',
  meetingAt = '',
  durationMinutes = 60,
  nowMs = Date.now(),
  meetLink = '',
  confirmedMeetLink = '',
} = {}) {
  if (forceOwnerMeet) return false;
  if (text(thankYouSentAt) || isRealOwnerMeetLink(confirmedMeetLink) || isRealOwnerMeetLink(meetLink)) {
    return true;
  }
  return salesMeetingIsInProgress(meetingAt, durationMinutes, nowMs);
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
