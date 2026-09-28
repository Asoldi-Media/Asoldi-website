import { existsSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { google } from 'googleapis';
import { getDataFilePath, writeDataJson } from '../data/storage-path.js';
import {
  calendarDurationForMode,
  CLIENT_MEETING_DURATION_MINUTES,
} from './sales-meeting-duration.js';

const LEGACY_TOKEN_PATH = getDataFilePath('google-calendar-token.json');
const TOKENS_PATH = getDataFilePath('google-calendar-tokens.json');
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events',
];
const DEFAULT_ACCOUNT_KEY = 'default';

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function profileFromIdToken(idToken = '') {
  const parts = sanitizeText(idToken).split('.');
  if (parts.length < 2) return { googleEmail: '', googleName: '' };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      googleEmail: sanitizeText(payload?.email),
      googleName: sanitizeText(payload?.given_name || payload?.name),
    };
  } catch {
    return { googleEmail: '', googleName: '' };
  }
}

function normalizeAccountKey(accountKey) {
  return sanitizeText(accountKey) || DEFAULT_ACCOUNT_KEY;
}

function getConfig() {
  return {
    clientId: sanitizeText(process.env.GOOGLE_OAUTH_CLIENT_ID),
    clientSecret: sanitizeText(process.env.GOOGLE_OAUTH_CLIENT_SECRET),
    redirectUri: sanitizeText(process.env.GOOGLE_OAUTH_REDIRECT_URI),
    calendarId: sanitizeText(process.env.GOOGLE_CALENDAR_ID) || 'primary',
    timeZone: sanitizeText(process.env.GOOGLE_CALENDAR_TIMEZONE) || 'Europe/Oslo',
  };
}

/** Sales Google logins must write to that account's primary calendar, not a shared admin calendar id. */
export function calendarIdForAccount(accountKey = '') {
  const key = normalizeAccountKey(accountKey);
  if (key.startsWith('sales:') || key.startsWith('developer:')) return 'primary';
  return sanitizeText(process.env.GOOGLE_CALENDAR_ID) || 'primary';
}

export function findConnectedCalendarAccountKeysByGoogleEmail(email = '') {
  const needle = sanitizeText(email).toLowerCase();
  if (!needle) return [];
  const map = readTokensMap();
  return Object.entries(map)
    .filter(([, token]) => isTokenConnected(token) && sanitizeText(token?.googleEmail).toLowerCase() === needle)
    .map(([key]) => key);
}

function isConfigured(config = getConfig()) {
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

function createOAuthClient(config = getConfig()) {
  if (!isConfigured(config)) {
    throw new Error('Google Calendar OAuth is not configured. Missing GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI.');
  }
  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

function readTokensMap() {
  let map = {};
  if (existsSync(TOKENS_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') map = parsed;
    } catch {
      map = {};
    }
  }
  // One-time migration: fold a legacy single-account token into the map.
  if (!map[DEFAULT_ACCOUNT_KEY] && existsSync(LEGACY_TOKEN_PATH)) {
    try {
      const legacy = JSON.parse(readFileSync(LEGACY_TOKEN_PATH, 'utf8'));
      if (legacy && typeof legacy === 'object') {
        map[DEFAULT_ACCOUNT_KEY] = legacy;
        writeDataJson(TOKENS_PATH, map);
      }
    } catch {
      // Ignore malformed legacy token.
    }
  }
  return map;
}

function readToken(accountKey) {
  const map = readTokensMap();
  const token = map[normalizeAccountKey(accountKey)];
  return token && typeof token === 'object' ? token : null;
}

function saveToken(accountKey, token) {
  const key = normalizeAccountKey(accountKey);
  const map = readTokensMap();
  const payload = {
    ...(map[key] || {}),
    ...(token || {}),
    updatedAt: new Date().toISOString(),
  };
  map[key] = payload;
  writeDataJson(TOKENS_PATH, map);
  return payload;
}

function isTokenConnected(token) {
  return Boolean(token?.refresh_token || token?.access_token);
}

/** Copy an existing connected token onto one or more alias account keys. */
export function shareGoogleCalendarToken(fromAccountKey, aliasAccountKeys = []) {
  const sourceKey = normalizeAccountKey(fromAccountKey);
  const token = readToken(sourceKey);
  if (!isTokenConnected(token)) {
    return { shared: false, sharedTo: [] };
  }
  const sharedTo = [];
  const aliases = Array.isArray(aliasAccountKeys) ? aliasAccountKeys : [];
  for (const raw of aliases) {
    const aliasKey = normalizeAccountKey(raw);
    if (!aliasKey || aliasKey === sourceKey) continue;
    const existing = readToken(aliasKey) || {};
    const merged = {
      ...existing,
      ...token,
    };
    if (!merged.refresh_token && existing.refresh_token) {
      merged.refresh_token = existing.refresh_token;
    }
    saveToken(aliasKey, merged);
    sharedTo.push(aliasKey);
  }
  return { shared: sharedTo.length > 0, sharedTo };
}

/**
 * Pick which Google token bucket to use for sync.
 * Prefer the current owner (assigned sales person), then the person saving, then the previous event account.
 */
export function resolveCalendarSyncAccountKey({
  ownerId = '',
  actorAccountKey = '',
  fallbackAccountKeys = [],
  previousAccountKey = '',
} = {}) {
  // Owner (assigned sales person) first, then the person saving. Preferring the
  // previous calendar kept writing assigned meetings onto the admin calendar.
  const candidates = [
    sanitizeText(ownerId),
    sanitizeText(actorAccountKey),
    sanitizeText(previousAccountKey),
    ...(Array.isArray(fallbackAccountKeys) ? fallbackAccountKeys.map((key) => sanitizeText(key)) : []),
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    const key = normalizeAccountKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isTokenConnected(readToken(key))) return key;
  }

  return normalizeAccountKey(sanitizeText(ownerId) || sanitizeText(actorAccountKey) || sanitizeText(previousAccountKey));
}

async function getAuthorizedClient(accountKey) {
  const config = getConfig();
  const oauthClient = createOAuthClient(config);
  const token = readToken(accountKey);
  if (!token) {
    throw new Error('Google Calendar account is not connected yet.');
  }
  oauthClient.setCredentials(token);
  oauthClient.on('tokens', (tokens) => {
    if (!tokens) return;
    saveToken(accountKey, tokens);
  });
  await oauthClient.getAccessToken();
  return { oauthClient, config };
}

function safeIso(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  return new Date(time).toISOString();
}

function meetingDurationMinutes(client = {}) {
  return calendarDurationForMode(client?.meetingMode);
}

function formatMeetingDate(iso = '', timeZone = 'Europe/Oslo') {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'Avtales nærmere';
  return new Date(ms).toLocaleString('nb-NO', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: sanitizeText(timeZone) || 'Europe/Oslo',
  });
}

export function buildEventSummary(client) {
  const businessName = sanitizeText(client?.businessName);
  const isOnline = sanitizeText(client?.meetingMode) === 'online';
  const modeLabel = isOnline ? 'Online møte' : 'Fysisk møte';
  return businessName ? `Asoldi · ${modeLabel} · ${businessName}` : `Asoldi · ${modeLabel}`;
}

export function buildGoogleCalendarInvitationSubject(client, timeZone = '') {
  const summary = buildEventSummary(client);
  const zone = sanitizeText(timeZone) || getConfig().timeZone;
  const ms = new Date(client?.meetingAt).getTime();
  if (!Number.isFinite(ms)) return `Invitasjon: ${summary}`;
  const when = new Date(ms).toLocaleString('nb-NO', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: zone,
  });
  return `Invitasjon: ${summary} @ ${when}`;
}

/** Fireflies notetaker. Inviting this address makes that calendar owner's Fireflies join and record video. */
export function firefliesNotetakerEmail() {
  const configured = sanitizeText(process.env.FIREFLIES_NOTETAKER_EMAIL);
  if (configured === '0' || configured.toLowerCase() === 'off') return '';
  return configured || 'fred@fireflies.ai';
}

export function isFirefliesAttendeeEmail(email = '') {
  const value = sanitizeText(email).toLowerCase();
  if (!value) return false;
  if (value === firefliesNotetakerEmail().toLowerCase()) return true;
  return value.endsWith('@fireflies.ai');
}

/**
 * Fred must not be written onto a silent calendar create (MyPhoner / unassigned).
 * Google will not email him, and a later sendUpdates=all treats him as already invited.
 * After he has been invited, keep him on silent updates so the event stays recordable.
 */
export function shouldIncludeFireflies({
  isOnline = false,
  addFireflies = true,
  sendUpdates = 'none',
  alreadyOnEvent = false,
} = {}) {
  if (!isOnline || !firefliesNotetakerEmail()) return false;
  if (sanitizeText(sendUpdates).toLowerCase() === 'all') return addFireflies !== false;
  return Boolean(alreadyOnEvent);
}

export function attendeeEmailListed(attendees = [], email = '') {
  const needle = sanitizeText(email).toLowerCase();
  if (!needle) return false;
  return (Array.isArray(attendees) ? attendees : []).some(
    (entry) => sanitizeText(entry?.email).toLowerCase() === needle
  );
}

/** Emails already on the event that must be removed so Google sends a fresh invite. */
export function attendeesToReinvite(currentAttendees = [], emails = []) {
  const listed = new Set();
  for (const raw of Array.isArray(emails) ? emails : []) {
    const email = sanitizeText(raw).toLowerCase();
    if (email && attendeeEmailListed(currentAttendees, email)) listed.add(email);
  }
  return [...listed];
}

export function withoutAttendeeEmails(attendees = [], emails = []) {
  const drop = new Set(
    (Array.isArray(emails) ? emails : []).map((email) => sanitizeText(email).toLowerCase()).filter(Boolean)
  );
  if (!drop.size) return Array.isArray(attendees) ? attendees : [];
  return (Array.isArray(attendees) ? attendees : []).filter(
    (entry) => !drop.has(sanitizeText(entry?.email).toLowerCase())
  );
}

export function buildMeetingAttendees(client, {
  includeAttendees = true,
  includeFireflies = false,
} = {}) {
  const attendees = [];
  if (includeAttendees) {
    const attendeeEmail = sanitizeText(client?.contactEmail);
    if (attendeeEmail) {
      attendees.push({
        email: attendeeEmail,
        displayName: sanitizeText(client?.contactPerson) || sanitizeText(client?.businessName) || undefined,
        responseStatus: 'needsAction',
      });
    }
  }
  if (includeFireflies) {
    const email = firefliesNotetakerEmail();
    const already = attendees.some((entry) => sanitizeText(entry?.email).toLowerCase() === email.toLowerCase());
    if (email && !already) {
      attendees.push({
        email,
        displayName: 'Fireflies',
        responseStatus: 'needsAction',
      });
    }
  }
  return attendees;
}

export function calendarInviteLeadMs() {
  const raw = Number(process.env.CALENDAR_INVITE_LEAD_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(Math.trunc(raw), 20000);
  return 8000;
}

// Calendar event body only — keep this short. Client-facing email copy lives in lib/sales-email.js.
function buildEventDescription(client, config = {}) {
  const isOnline = sanitizeText(client?.meetingMode) === 'online';
  const contactPerson = sanitizeText(client?.contactPerson);
  const contactEmail = sanitizeText(client?.contactEmail);
  const contactPhone = sanitizeText(client?.contactPhone);
  const mapQuery = sanitizeText(client?.meetingPlace);
  const mapsUrl = mapQuery
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`
    : '';

  const lines = [
    `Tid: ${formatMeetingDate(client?.meetingAt, config?.timeZone)}`,
    `Varighet: ca. ${CLIENT_MEETING_DURATION_MINUTES} minutter`,
    `Modus: ${isOnline ? 'Online (Google Meet)' : 'Fysisk møte'}`,
    contactPerson ? `Kontakt: ${contactPerson}` : '',
    contactEmail ? `E-post: ${contactEmail}` : '',
    contactPhone ? `Telefon: ${contactPhone}` : '',
  ];

  if (!isOnline) {
    lines.push(`Sted: ${mapQuery || 'Avtales nærmere'}`);
    if (mapsUrl) lines.push(`Kart: ${mapsUrl}`);
  }

  lines.push('', 'Asoldi');
  return lines.filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== '')).join('\n');
}

function extractMeetLink(event) {
  if (event?.hangoutLink) return event.hangoutLink;
  const video = Array.isArray(event?.conferenceData?.entryPoints)
    ? event.conferenceData.entryPoints.find((entry) => entry?.entryPointType === 'video')
    : null;
  return sanitizeText(video?.uri);
}

/** Real Meet URLs look like https://meet.google.com/abc-defg-hij — reject placeholders/tests. */
export function isRealGoogleMeetLink(value = '') {
  const url = sanitizeText(value);
  if (!url) return false;
  if (!/^https:\/\/meet\.google\.com\//i.test(url)) return false;
  if (/asoldi-(sim|email)-test|lookup\/asoldi/i.test(url)) return false;
  return /meet\.google\.com\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}(?:\?|$)/i.test(url)
    || /meet\.google\.com\/[a-z0-9-]{10,}(?:\?|$)/i.test(url);
}

export function getGoogleCalendarStatus(accountKey) {
  const config = getConfig();
  const token = readToken(accountKey);
  return {
    configured: isConfigured(config),
    connected: Boolean(token?.refresh_token || token?.access_token),
    calendarId: calendarIdForAccount(accountKey),
    redirectUri: config.redirectUri,
    tokenUpdatedAt: sanitizeText(token?.updatedAt),
    accountKey: normalizeAccountKey(accountKey),
    googleEmail: sanitizeText(token?.googleEmail),
    googleName: sanitizeText(token?.googleName),
  };
}

export function createGoogleCalendarAuthUrl(state = '') {
  const oauthClient = createOAuthClient(getConfig());
  return oauthClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state: sanitizeText(state),
  });
}

export async function exchangeGoogleCalendarCode(code, accountKey, aliasAccountKeys = []) {
  const oauthClient = createOAuthClient(getConfig());
  const trimmedCode = sanitizeText(code);
  if (!trimmedCode) throw new Error('Missing OAuth code.');
  const { tokens } = await oauthClient.getToken(trimmedCode);
  if (!tokens) throw new Error('Failed to exchange OAuth code for tokens.');

  const existing = readToken(accountKey) || {};
  const merged = {
    ...existing,
    ...tokens,
  };
  if (!merged.refresh_token && existing.refresh_token) {
    merged.refresh_token = existing.refresh_token;
  }
  oauthClient.setCredentials(merged);
  const fromIdToken = profileFromIdToken(merged.id_token);
  merged.googleEmail = fromIdToken.googleEmail || sanitizeText(merged.googleEmail);
  merged.googleName = fromIdToken.googleName || sanitizeText(merged.googleName);
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
    const { data } = await oauth2.userinfo.get();
    merged.googleEmail = sanitizeText(data?.email) || merged.googleEmail;
    merged.googleName = sanitizeText(data?.given_name || data?.name) || merged.googleName;
  } catch {
    // Calendar still works if Google withholds the profile email.
  }
  saveToken(accountKey, merged);
  shareGoogleCalendarToken(accountKey, aliasAccountKeys);
  return getGoogleCalendarStatus(accountKey);
}

export async function deleteMeetingEvent(eventId, accountKey, options = {}) {
  const id = sanitizeText(eventId);
  if (!id) return { deleted: false };
  const { oauthClient } = await getAuthorizedClient(accountKey);
  const calendar = google.calendar({ version: 'v3', auth: oauthClient });
  await calendar.events.delete({
    calendarId: sanitizeText(options?.calendarId) || calendarIdForAccount(accountKey),
    eventId: id,
    sendUpdates: 'none',
  });
  return { deleted: true };
}

export async function upsertMeetingEvent(client, existingEventId = '', accountKey, options = {}) {
  const { oauthClient, config } = await getAuthorizedClient(accountKey);
  const calendar = google.calendar({ version: 'v3', auth: oauthClient });

  const meetingAtIso = safeIso(client?.meetingAt);
  if (!meetingAtIso) throw new Error('Meeting date/time is missing or invalid.');
  const durationMinutes = meetingDurationMinutes(client);
  const endIso = new Date(new Date(meetingAtIso).getTime() + durationMinutes * 60 * 1000).toISOString();

  const isOnline = sanitizeText(client?.meetingMode) === 'online';
  const sendUpdates = sanitizeText(options?.sendUpdates).toLowerCase() === 'all' ? 'all' : 'none';
  const includeAttendees = options?.includeAttendees == null
    ? sendUpdates === 'all'
    : Boolean(options.includeAttendees);
  const forceGuestInvite = Boolean(options?.forceGuestInvite) && includeAttendees;
  const attendeeEmail = sanitizeText(client?.contactEmail);
  const eventId = sanitizeText(existingEventId || client?.calendar?.eventId);
  let existingMeetLink = sanitizeText(client?.calendar?.meetLink);
  let currentAttendees = [];
  let firefliesAlreadyOnEvent = false;

  let response;
  const calendarId = calendarIdForAccount(accountKey);
  if (eventId) {
    try {
      const existing = await calendar.events.get({ calendarId, eventId });
      const liveMeet = sanitizeText(extractMeetLink(existing?.data || {}));
      if (isRealGoogleMeetLink(liveMeet)) existingMeetLink = liveMeet;
      currentAttendees = Array.isArray(existing?.data?.attendees) ? existing.data.attendees : [];
      firefliesAlreadyOnEvent = currentAttendees.some((entry) => isFirefliesAttendeeEmail(entry?.email));
    } catch {
      // Event may be gone; insert below recreates it.
    }
  }

  // Fireflies only on this sales meeting (online). Next-action reminders never call this.
  // Do not add Fred until sendUpdates=all (confirmation after a sales rep is assigned).
  const includeFireflies = shouldIncludeFireflies({
    isOnline,
    addFireflies: options?.addFireflies,
    sendUpdates,
    alreadyOnEvent: firefliesAlreadyOnEvent,
  });
  const attendees = buildMeetingAttendees(client, { includeAttendees, includeFireflies });
  const eventBody = {
    summary: buildEventSummary(client),
    description: buildEventDescription(client, config),
    start: {
      dateTime: meetingAtIso,
      timeZone: config.timeZone,
    },
    end: {
      dateTime: endIso,
      timeZone: config.timeZone,
    },
    attendees,
    location: isOnline
      ? (isRealGoogleMeetLink(existingMeetLink) ? existingMeetLink : undefined)
      : sanitizeText(client?.meetingPlace),
    reminders: {
      useDefault: true,
    },
  };

  if (eventId && currentAttendees.length) {
    const resendEmails = [];
    if (forceGuestInvite && attendeeEmail) resendEmails.push(attendeeEmail);
    if (includeFireflies && sendUpdates === 'all') resendEmails.push(firefliesNotetakerEmail());
    const stripEmails = attendeesToReinvite(currentAttendees, resendEmails);
    if (stripEmails.length) {
      try {
        await calendar.events.patch({
          calendarId,
          eventId,
          sendUpdates: 'none',
          requestBody: {
            attendees: withoutAttendeeEmails(currentAttendees, stripEmails),
          },
        });
      } catch {
        // Event may be gone; insert below recreates it.
      }
    }
  }
  const needsConference = isOnline && !isRealGoogleMeetLink(existingMeetLink);
  if (needsConference) {
    eventBody.conferenceData = {
      createRequest: {
        requestId: randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }
  eventBody.location = isOnline
    ? (isRealGoogleMeetLink(existingMeetLink) ? existingMeetLink : undefined)
    : sanitizeText(client?.meetingPlace);
  if (eventId) {
    try {
      response = await calendar.events.update({
        calendarId,
        eventId,
        requestBody: eventBody,
        sendUpdates,
        conferenceDataVersion: needsConference ? 1 : 0,
      });
    } catch (error) {
      const status = Number(error?.code || error?.response?.status);
      if (status !== 404 && status !== 410) throw error;
      response = await calendar.events.insert({
        calendarId,
        requestBody: eventBody,
        sendUpdates,
        conferenceDataVersion: needsConference ? 1 : 0,
      });
    }
  } else {
    response = await calendar.events.insert({
      calendarId,
      requestBody: eventBody,
      sendUpdates,
      conferenceDataVersion: needsConference ? 1 : 0,
    });
  }

  const event = response?.data || {};
  let meetLink = isOnline ? sanitizeText(extractMeetLink(event)) : '';
  // Some Google responses omit conferenceData on update; refetch once if needed.
  if (isOnline && !isRealGoogleMeetLink(meetLink) && sanitizeText(event.id)) {
    try {
      const refreshed = await calendar.events.get({
        calendarId,
        eventId: event.id,
      });
      meetLink = sanitizeText(extractMeetLink(refreshed?.data || {})) || meetLink;
    } catch {
      // keep meetLink from create/update response
    }
  }
  if (isOnline && !isRealGoogleMeetLink(meetLink) && isRealGoogleMeetLink(existingMeetLink)) {
    meetLink = existingMeetLink;
  }
  if (!isOnline) meetLink = '';
  let listedAttendees = Array.isArray(event.attendees) ? event.attendees : [];
  if (includeFireflies && sendUpdates === 'all' && sanitizeText(event.id) && !attendeeEmailListed(listedAttendees, firefliesNotetakerEmail())) {
    try {
      const refreshed = await calendar.events.get({
        calendarId,
        eventId: event.id,
      });
      listedAttendees = Array.isArray(refreshed?.data?.attendees) ? refreshed.data.attendees : listedAttendees;
    } catch {
      // keep listedAttendees from the create/update response
    }
  }
  const firefliesInvited = includeFireflies
    && sendUpdates === 'all'
    && attendeeEmailListed(listedAttendees, firefliesNotetakerEmail());
  return {
    eventId: sanitizeText(event.id),
    htmlLink: sanitizeText(event.htmlLink),
    meetLink,
    calendarId,
    accountKey: normalizeAccountKey(accountKey),
    syncedAt: new Date().toISOString(),
    firefliesInvited,
  };
}

export async function upsertSalesReminderEvent(client, action = {}, existingEventId = '', accountKey) {
  const { oauthClient, config } = await getAuthorizedClient(accountKey);
  const calendar = google.calendar({ version: 'v3', auth: oauthClient });
  const startIso = safeIso(action?.dueAt);
  if (!startIso) throw new Error('Next action date/time is missing or invalid.');
  const endIso = new Date(new Date(startIso).getTime() + 15 * 60 * 1000).toISOString();
  const actionName = sanitizeText(action?.name) || 'Neste handling';
  const businessName = sanitizeText(client?.businessName);
  const summary = businessName ? `Asoldi · ${actionName} · ${businessName}` : `Asoldi · ${actionName}`;
  const eventBody = {
    summary,
    description: [
      `Handling: ${actionName}`,
      businessName ? `Kunde: ${businessName}` : '',
      sanitizeText(client?.contactPerson) ? `Kontakt: ${client.contactPerson}` : '',
      'Intern salgspåminnelse fra Asoldi.',
    ].filter(Boolean).join('\n'),
    start: { dateTime: startIso, timeZone: config.timeZone },
    end: { dateTime: endIso, timeZone: config.timeZone },
    reminders: { useDefault: true },
  };
  const calendarId = calendarIdForAccount(accountKey);
  const eventId = sanitizeText(existingEventId || action?.calendarEventId);
  let response;
  if (eventId) {
    try {
      response = await calendar.events.update({
        calendarId,
        eventId,
        requestBody: eventBody,
        sendUpdates: 'none',
      });
    } catch (error) {
      const status = Number(error?.code || error?.response?.status);
      if (status !== 404 && status !== 410) throw error;
      response = await calendar.events.insert({
        calendarId,
        requestBody: eventBody,
        sendUpdates: 'none',
      });
    }
  } else {
    response = await calendar.events.insert({
      calendarId,
      requestBody: eventBody,
      sendUpdates: 'none',
    });
  }
  const event = response?.data || {};
  return {
    eventId: sanitizeText(event.id),
    htmlLink: sanitizeText(event.htmlLink),
    calendarId,
    accountKey: normalizeAccountKey(accountKey),
    syncedAt: new Date().toISOString(),
  };
}
