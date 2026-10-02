import { existsSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { google } from 'googleapis';
import { getDataFilePath, writeDataJson } from '../data/storage-path.js';
import {
  calendarDurationForMode,
  CLIENT_MEETING_DURATION_MINUTES,
} from './sales-meeting-duration.js';
import {
  calendarTokenIsUsable,
  isBlockedCalendarAccountKey,
  isBlockedCalendarGoogleEmail,
  pickCalendarSyncAccountKey,
} from './sales-calendar-owner.js';

const LEGACY_TOKEN_PATH = getDataFilePath('google-calendar-token.json');
const TOKENS_PATH = getDataFilePath('google-calendar-tokens.json');
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.acls',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export function googleCalendarOauthScopes() {
  return [...GOOGLE_SCOPES];
}
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
  if (!calendarTokenIsUsable(token, sourceKey)) {
    return { shared: false, sharedTo: [] };
  }
  const sharedTo = [];
  const aliases = Array.isArray(aliasAccountKeys) ? aliasAccountKeys : [];
  for (const raw of aliases) {
    const aliasKey = normalizeAccountKey(raw);
    if (!aliasKey || aliasKey === sourceKey) continue;
    if (isBlockedCalendarAccountKey(aliasKey)) continue;
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
  preferredAccountKeys = [],
} = {}) {
  const picked = pickCalendarSyncAccountKey({
    ownerId,
    actorAccountKey,
    previousAccountKey,
    fallbackAccountKeys,
    preferredAccountKeys,
    isUsable: (key) => calendarTokenIsUsable(readToken(key), key),
  });
  return normalizeAccountKey(picked);
}

export const GOOGLE_CALENDAR_HTTP_TIMEOUT_MS = 4000;
export const CALENDAR_WEEK_TIMEOUT_MS = 6000;
const GOOGLE_HTTP = { timeout: GOOGLE_CALENDAR_HTTP_TIMEOUT_MS };

export async function getAuthorizedClient(accountKey) {
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
  await withTimeout(Promise.resolve(oauthClient.getAccessToken()), GOOGLE_CALENDAR_HTTP_TIMEOUT_MS, 'google-token-timeout');
  return { oauthClient, config };
}

function safeIso(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  return new Date(time).toISOString();
}

/** RFC3339 local wall clock for Google Calendar (do not mix a Zulu instant with timeZone). */
export function toCalendarDateTime(iso = '', timeZone = 'Europe/Oslo') {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const zone = sanitizeText(timeZone) || 'Europe/Oslo';
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function calendarEventStartMatches(event = {}, meetingAtIso = '', slackMs = 60 * 1000) {
  const got = new Date(event?.start?.dateTime || event?.start?.date || '').getTime();
  const want = new Date(meetingAtIso).getTime();
  if (!Number.isFinite(got) || !Number.isFinite(want)) return false;
  return Math.abs(got - want) <= slackMs;
}

export const SALES_REMINDER_DURATION_MINUTES = 15;

function meetingDurationMinutes(client = {}) {
  return calendarDurationForMode(client?.meetingMode);
}

export function resolveMeetingEventDurationMinutes(client = {}, options = {}) {
  const override = Number(options?.durationMinutes);
  if (Number.isFinite(override) && override > 0) return Math.round(override);
  return meetingDurationMinutes(client);
}

export function resolveSalesReminderDurationMinutes(options = {}) {
  const override = Number(options?.durationMinutes);
  if (Number.isFinite(override) && override > 0) return Math.round(override);
  return SALES_REMINDER_DURATION_MINUTES;
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

export function isAsoldiCalendarSummary(summary = '') {
  return /^asoldi\s*·/i.test(sanitizeText(summary));
}

/** Google’s week grid needs this much height or the hour rows collapse into equal-height cards. */
export const GOOGLE_CALENDAR_EMBED_HEIGHT_PX = 920;

export function buildGoogleCalendarEmbedUrl({ src = '', timeZone = 'Europe/Oslo' } = {}) {
  const calendarSrc = sanitizeText(src);
  if (!calendarSrc || calendarSrc.toLowerCase() === 'primary') return '';
  const params = new URLSearchParams({
    src: calendarSrc,
    ctz: timeZone || 'Europe/Oslo',
    mode: 'WEEK',
    wkst: '2',
    height: String(GOOGLE_CALENDAR_EMBED_HEIGHT_PX),
    bgcolor: '#ffffff',
    showTitle: '0',
    showNav: '1',
    showDate: '1',
    showPrint: '0',
    showTabs: '0',
    showCalendars: '0',
    showTz: '0',
    hl: 'no',
  });
  return `https://calendar.google.com/calendar/embed?${params.toString()}`;
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

export function resolveSalesCalendarPreviewAccountKey({
  actorAccountKey = '',
  isAdmin = false,
  ownerId = '',
} = {}) {
  const actor = sanitizeText(actorAccountKey);
  const owner = sanitizeText(ownerId);
  if (isAdmin && owner && owner !== 'unassigned') return owner;
  return actor;
}

/** One connected Google mailbox per @asoldi.com address, never the blocked Gmail. */
export function listConnectedAsoldiCalendarSources() {
  const map = readTokensMap();
  const byEmail = new Map();
  for (const [key, token] of Object.entries(map)) {
    if (!calendarTokenIsUsable(token, key)) continue;
    const email = sanitizeText(token?.googleEmail).toLowerCase();
    if (!email.endsWith('@asoldi.com')) continue;
    if (isBlockedCalendarGoogleEmail(email) || isBlockedCalendarAccountKey(key)) continue;
    const existing = byEmail.get(email);
    if (!existing || (key.startsWith('sales:') && !String(existing.accountKey).startsWith('sales:'))) {
      byEmail.set(email, { accountKey: key, googleEmail: email });
    }
  }
  return [...byEmail.values()].sort((a, b) => a.googleEmail.localeCompare(b.googleEmail));
}

/**
 * Admin + a sales filter → that rep only.
 * Admin with no filter → every connected @asoldi.com mailbox (Damian + Alexander).
 * Sales session → the logged-in rep only.
 */
export function resolveSalesCalendarWeekSources({
  actorAccountKey = '',
  isAdmin = false,
  ownerId = '',
  connectedSources = [],
} = {}) {
  const actor = sanitizeText(actorAccountKey);
  const owner = sanitizeText(ownerId);
  const connected = (Array.isArray(connectedSources) ? connectedSources : [])
    .map((row) => ({
      accountKey: sanitizeText(row?.accountKey),
      googleEmail: sanitizeText(row?.googleEmail).toLowerCase(),
    }))
    .filter((row) => row.accountKey);

  if (isAdmin && owner && owner !== 'unassigned') {
    const match = connected.find((row) => row.accountKey === owner)
      || connected.find((row) => owner.toLowerCase().includes(row.googleEmail));
    return [{ accountKey: owner, googleEmail: match?.googleEmail || '' }];
  }
  if (isAdmin && connected.length) return connected;
  return actor ? [{ accountKey: actor, googleEmail: '' }] : [];
}

export function presentCalendarEvent(event = {}) {
  const startDate = sanitizeText(event?.start?.date);
  const endDate = sanitizeText(event?.end?.date);
  const startDateTime = sanitizeText(event?.start?.dateTime);
  const endDateTime = sanitizeText(event?.end?.dateTime);
  const allDay = Boolean(startDate && !startDateTime);
  const summary = sanitizeText(event?.summary);
  const entryPoints = Array.isArray(event?.conferenceData?.entryPoints)
    ? event.conferenceData.entryPoints
    : [];
  const meetFromConference = sanitizeText(
    entryPoints.find((entry) => sanitizeText(entry?.entryPointType) === 'video')?.uri
  );
  return {
    id: sanitizeText(event?.id),
    summary: summary || 'Opptatt',
    start: allDay ? startDate : startDateTime,
    end: allDay ? endDate : endDateTime,
    allDay,
    location: sanitizeText(event?.location),
    meetLink: sanitizeText(event?.hangoutLink) || meetFromConference,
    htmlLink: sanitizeText(event?.htmlLink),
    status: sanitizeText(event?.status),
    calendarId: sanitizeText(event?.organizer?.email || event?.calendarId),
  };
}

async function readableCalendarIds(calendarApi, fallbackId = 'primary') {
  const fallback = sanitizeText(fallbackId) || 'primary';
  try {
    const listed = await calendarApi.calendarList.list({ maxResults: 50 }, GOOGLE_HTTP);
    const ids = [];
    for (const item of Array.isArray(listed.data?.items) ? listed.data.items : []) {
      const role = sanitizeText(item?.accessRole).toLowerCase();
      if (role === 'freebusyreader' || role === 'none') continue;
      const id = sanitizeText(item?.id);
      if (id) ids.push(id);
    }
    return ids.length ? [...new Set(ids)] : [fallback];
  } catch {
    return [fallback];
  }
}

async function listEventsOnCalendar(calendarApi, calendarId, { timeMin, timeMax, timeZone }) {
  const items = [];
  let pageToken = '';
  do {
    const response = await calendarApi.events.list({
      calendarId,
      timeMin: sanitizeText(timeMin),
      timeMax: sanitizeText(timeMax),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone,
      maxResults: 250,
      showDeleted: false,
      pageToken: pageToken || undefined,
    }, GOOGLE_HTTP);
    for (const item of Array.isArray(response.data?.items) ? response.data.items : []) {
      if (sanitizeText(item?.status).toLowerCase() === 'cancelled') continue;
      items.push({ ...item, calendarId });
    }
    pageToken = sanitizeText(response.data?.nextPageToken);
  } while (pageToken && items.length < 250);
  return items;
}

export const CALENDAR_EVENTS_TIMEOUT_MS = 5000;

export async function listCalendarEvents(accountKey, { timeMin, timeMax, primaryOnly = false } = {}) {
  const { oauthClient, config } = await getAuthorizedClient(accountKey);
  const calendar = google.calendar({ version: 'v3', auth: oauthClient });
  const fallbackId = calendarIdForAccount(accountKey);
  const calendarIds = primaryOnly
    ? ['primary']
    : await readableCalendarIds(calendar, fallbackId);
  const items = [];
  const seen = new Set();
  for (const calendarId of calendarIds) {
    const batch = await listEventsOnCalendar(calendar, calendarId, {
      timeMin,
      timeMax,
      timeZone: config.timeZone,
    });
    for (const item of batch) {
      const key = `${calendarId}:${sanitizeText(item.id)}`;
      if (!sanitizeText(item.id) || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= 500) break;
    }
    if (items.length >= 500) break;
  }
  items.sort((a, b) => {
    const aStart = Date.parse(a?.start?.dateTime || a?.start?.date || 0);
    const bStart = Date.parse(b?.start?.dateTime || b?.start?.date || 0);
    return aStart - bStart;
  });
  const token = readToken(accountKey);
  return {
    calendarId: fallbackId,
    googleEmail: sanitizeText(token?.googleEmail),
    googleName: sanitizeText(token?.googleName),
    timeZone: config.timeZone,
    events: items.map(presentCalendarEvent),
  };
}

let calendarWeekReads = 0;
const MAX_CALENDAR_WEEK_READS = 2;

export async function loadSalesCalendarWeek({ sources = [], timeMin, timeMax } = {}) {
  if (calendarWeekReads >= MAX_CALENDAR_WEEK_READS) {
    return {
      connected: false,
      accountKey: '',
      googleEmail: '',
      googleEmails: [],
      events: [],
      warnings: ['Kalenderen er opptatt. Lukk og åpne Calendar på nytt.'],
    };
  }
  calendarWeekReads += 1;
  try {
    return await withTimeout(
      loadSalesCalendarWeekInner({ sources, timeMin, timeMax }),
      CALENDAR_WEEK_TIMEOUT_MS,
      'calendar-week-timeout'
    );
  } catch (error) {
    if (sanitizeText(error?.message) === 'calendar-week-timeout') {
      return {
        connected: true,
        accountKey: '',
        googleEmail: '',
        googleEmails: [],
        events: [],
        warnings: ['Google brukte for lang tid. Prøv igjen.'],
      };
    }
    throw error;
  } finally {
    calendarWeekReads -= 1;
  }
}

async function loadSalesCalendarWeekInner({ sources = [], timeMin, timeMax } = {}) {
  const listedSources = (Array.isArray(sources) ? sources : [])
    .map((row) => ({
      accountKey: sanitizeText(row?.accountKey),
      googleEmail: sanitizeText(row?.googleEmail).toLowerCase(),
    }))
    .filter((row) => row.accountKey);

  const events = [];
  const warnings = [];
  const emails = [];
  let connectedCount = 0;
  let firstEmail = '';
  let firstAccountKey = '';

  await Promise.all(listedSources.map(async (source) => {
    const status = getGoogleCalendarStatus(source.accountKey);
    if (!status.connected) return;
    connectedCount += 1;
    try {
      const listed = await withTimeout(
        listCalendarEvents(source.accountKey, { timeMin, timeMax, primaryOnly: true }),
        CALENDAR_EVENTS_TIMEOUT_MS,
        'calendar-events-timeout'
      );
      const email = listed.googleEmail || status.googleEmail || source.googleEmail || '';
      if (!firstEmail) firstEmail = email;
      if (!firstAccountKey) firstAccountKey = source.accountKey;
      if (email) emails.push(email);
      for (const event of listed.events || []) {
        events.push({
          ...event,
          ownerEmail: email,
          ownerAccountKey: source.accountKey,
        });
      }
    } catch (error) {
      const msg = sanitizeText(error?.message);
      if (msg === 'calendar-events-timeout' || msg === 'google-token-timeout') {
        warnings.push(`Google brukte for lang tid (${status.googleEmail || source.accountKey}). Prøv igjen.`);
      } else {
        warnings.push(`Kunne ikke hente kalenderen for ${status.googleEmail || source.accountKey}.`);
      }
    }
  }));

  events.sort((a, b) => Date.parse(a?.start || 0) - Date.parse(b?.start || 0));
  return {
    connected: connectedCount > 0,
    accountKey: firstAccountKey,
    googleEmail: firstEmail,
    googleEmails: [...new Set(emails)],
    events,
    warnings,
  };
}

async function resolvePrimaryCalendarId(calendarApi, fallbackId = '') {
  try {
    const response = await calendarApi.calendars.get({ calendarId: 'primary' }, GOOGLE_HTTP);
    return sanitizeText(response.data?.id) || sanitizeText(fallbackId);
  } catch {
    return sanitizeText(fallbackId);
  }
}

async function insertCalendarAcl(calendarApi, calendarId, rule) {
  try {
    await calendarApi.acl.insert({
      calendarId,
      requestBody: rule,
    }, GOOGLE_HTTP);
    return 'ok';
  } catch (error) {
    const status = Number(error?.code || error?.response?.status);
    if (status === 409) return 'ok';
    if (status === 403) return 'forbidden';
    return 'error';
  }
}

async function ensureEmbedSharing(calendarApi, calendarId) {
  const publicShare = await insertCalendarAcl(calendarApi, calendarId, {
    role: 'freeBusyReader',
    scope: { type: 'default' },
  });
  const domainShare = await insertCalendarAcl(calendarApi, calendarId, {
    role: 'freeBusyReader',
    scope: { type: 'domain', value: 'asoldi.com' },
  });
  if (publicShare === 'ok' || domainShare === 'ok') return '';
  if (publicShare === 'forbidden' && domainShare === 'forbidden') {
    return 'Google tillot ikke kalenderdeling. Legg til scope calendar.acls og koble på nytt, eller del kalenderen som «Se bare opptatt» i Google.';
  }
  return '';
}

export const CALENDAR_EMBED_TIMEOUT_MS = 8000;
export const VISIBILITY_PATCH_TTL_MS = 6 * 60 * 60 * 1000;
const VISIBILITY_PATCH_MAX = 15;
const lastVisibilityPatchAt = new Map();
let visibilityPatchRunning = false;

function withTimeout(promise, ms, label = 'timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function embedPayloadFromStatus(accountKey, extra = {}) {
  const status = getGoogleCalendarStatus(accountKey);
  const config = getConfig();
  const key = normalizeAccountKey(accountKey);
  const embedSrc = status.googleEmail || extra.calendarId || '';
  return {
    connected: Boolean(status.connected),
    accountKey: key,
    googleEmail: status.googleEmail,
    googleName: status.googleName,
    calendarId: extra.calendarId || status.calendarId || '',
    embedUrl: buildGoogleCalendarEmbedUrl({ src: embedSrc, timeZone: config.timeZone }),
    shareWarning: extra.shareWarning || '',
    timeZone: config.timeZone,
    message: extra.message || '',
  };
}

async function publishAsoldiEventVisibility(calendarApi, calendarId, timeZone = 'Europe/Oslo') {
  const timeMin = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString();
  const items = await listEventsOnCalendar(calendarApi, calendarId, { timeMin, timeMax, timeZone });
  let patched = 0;
  for (const item of items) {
    if (patched >= VISIBILITY_PATCH_MAX) break;
    if (!isAsoldiCalendarSummary(item?.summary)) continue;
    if (sanitizeText(item?.visibility).toLowerCase() === 'public') continue;
    const eventId = sanitizeText(item?.id);
    if (!eventId) continue;
    try {
      await calendarApi.events.patch({
        calendarId,
        eventId,
        sendUpdates: 'none',
        requestBody: { visibility: 'public' },
      });
      patched += 1;
    } catch {
      // Event may be gone or read-only.
    }
  }
  return patched;
}

function scheduleAsoldiEventVisibility(calendarApi, calendarId, timeZone, cacheKey) {
  const key = sanitizeText(cacheKey) || 'default';
  const last = lastVisibilityPatchAt.get(key) || 0;
  if (visibilityPatchRunning) return;
  if (Date.now() - last < VISIBILITY_PATCH_TTL_MS) return;
  lastVisibilityPatchAt.set(key, Date.now());
  visibilityPatchRunning = true;
  setImmediate(() => {
    publishAsoldiEventVisibility(calendarApi, calendarId, timeZone)
      .catch((error) => {
        lastVisibilityPatchAt.delete(key);
        console.warn('[google-calendar] visibility patch failed', sanitizeText(error?.message) || error);
      })
      .finally(() => {
        visibilityPatchRunning = false;
      });
  });
}

async function prepareSalesCalendarEmbedInner(accountKey) {
  const status = getGoogleCalendarStatus(accountKey);
  const config = getConfig();
  const key = normalizeAccountKey(accountKey);
  if (!status.connected) {
    return embedPayloadFromStatus(accountKey);
  }
  const { oauthClient } = await getAuthorizedClient(accountKey);
  const calendar = google.calendar({ version: 'v3', auth: oauthClient });
  const calendarId = await resolvePrimaryCalendarId(calendar, status.googleEmail);
  const apiCalendarId = calendarId || 'primary';
  const shareWarning = await ensureEmbedSharing(calendar, apiCalendarId);
  scheduleAsoldiEventVisibility(calendar, apiCalendarId, config.timeZone, key);
  const embedSrc = status.googleEmail || calendarId;
  return {
    connected: true,
    accountKey: key,
    googleEmail: status.googleEmail,
    googleName: status.googleName,
    calendarId: apiCalendarId,
    embedUrl: buildGoogleCalendarEmbedUrl({ src: embedSrc, timeZone: config.timeZone }),
    shareWarning,
    timeZone: config.timeZone,
    message: '',
  };
}

export async function prepareSalesCalendarEmbed(accountKey) {
  // Local only. Calling Google here (token refresh, ACL, visibility patches)
  // hung Node and made Admin/Sales fail with ERR_HTTP2_PROTOCOL_ERROR while
  // the cached homepage still loaded.
  return embedPayloadFromStatus(accountKey);
}

/** Week grid / free-busy Google calls. Off so Admin/Sales list cannot hang Node. */
export const SALES_WEEK_CALENDAR_DISABLED = true;

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
  try {
    await prepareSalesCalendarEmbed(accountKey);
  } catch {
    // Connection still succeeds if embed sharing cannot be applied yet.
  }
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
    sendUpdates: sanitizeText(options?.sendUpdates).toLowerCase() === 'all' ? 'all' : 'none',
  });
  return { deleted: true };
}

export function shouldForceCalendarRecreate(previousMeetingAt = '', nextMeetingAt = '', eventId = '') {
  if (!sanitizeText(eventId)) return false;
  const prevMs = new Date(previousMeetingAt || '').getTime();
  const nextMs = new Date(nextMeetingAt || '').getTime();
  if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs)) return false;
  return prevMs !== nextMs;
}

export async function upsertMeetingEvent(client, existingEventId = '', accountKey, options = {}) {
  const { oauthClient, config } = await getAuthorizedClient(accountKey);
  const calendar = google.calendar({ version: 'v3', auth: oauthClient });

  const meetingAtIso = safeIso(client?.meetingAt);
  if (!meetingAtIso) throw new Error('Meeting date/time is missing or invalid.');
  const durationMinutes = resolveMeetingEventDurationMinutes(client, options);
  const zone = config.timeZone;
  const startLocal = toCalendarDateTime(meetingAtIso, zone);
  const endLocal = toCalendarDateTime(
    new Date(new Date(meetingAtIso).getTime() + durationMinutes * 60 * 1000).toISOString(),
    zone
  );

  const isOnline = sanitizeText(client?.meetingMode) === 'online';
  const sendUpdates = sanitizeText(options?.sendUpdates).toLowerCase() === 'all' ? 'all' : 'none';
  const includeAttendees = options?.includeAttendees == null
    ? sendUpdates === 'all'
    : Boolean(options.includeAttendees);
  const forceGuestInvite = Boolean(options?.forceGuestInvite) && includeAttendees;
  const attendeeEmail = sanitizeText(client?.contactEmail);
  let eventId = sanitizeText(existingEventId || client?.calendar?.eventId);
  const forceRecreate = Boolean(options?.forceRecreate);
  let existingMeetLink = sanitizeText(client?.calendar?.meetLink);
  let currentAttendees = [];
  let firefliesAlreadyOnEvent = false;

  let response;
  const calendarId = sanitizeText(options?.calendarId) || calendarIdForAccount(accountKey);
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
  firefliesAlreadyOnEvent = firefliesAlreadyOnEvent || Boolean(options?.keepFireflies);

  if (forceRecreate && eventId) {
    try {
      await calendar.events.delete({
        calendarId,
        eventId,
        sendUpdates: sendUpdates === 'all' ? 'all' : 'none',
      });
    } catch {
      // Insert still writes the new time even if the stale event cannot be deleted.
    }
    eventId = '';
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
    summary: sanitizeText(options?.summary) || buildEventSummary(client),
    description: buildEventDescription(client, config),
    start: {
      dateTime: startLocal,
      timeZone: zone,
    },
    end: {
      dateTime: endLocal,
      timeZone: zone,
    },
    attendees,
    location: isOnline
      ? (isRealGoogleMeetLink(existingMeetLink) ? existingMeetLink : undefined)
      : sanitizeText(client?.meetingPlace),
    reminders: {
      useDefault: true,
    },
    visibility: 'public',
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
      // Patch keeps Meet/conference data. A full update was leaving the old
      // start time on the organizer calendar when the rep rescheduled.
      const patchBody = {
        summary: eventBody.summary,
        description: eventBody.description,
        start: eventBody.start,
        end: eventBody.end,
        location: eventBody.location,
        reminders: eventBody.reminders,
        visibility: 'public',
      };
      if (includeAttendees || includeFireflies) patchBody.attendees = eventBody.attendees;
      if (needsConference) patchBody.conferenceData = eventBody.conferenceData;
      response = await calendar.events.patch({
        calendarId,
        eventId,
        requestBody: patchBody,
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

  let event = response?.data || {};
  if (sanitizeText(event.id)) {
    try {
      const live = await calendar.events.get({ calendarId, eventId: event.id });
      if (live?.data) event = live.data;
    } catch {
      // use the create/update payload
    }
  }
  if (eventId && sanitizeText(event.id) === eventId && !calendarEventStartMatches(event, meetingAtIso)) {
    try {
      await calendar.events.delete({
        calendarId,
        eventId,
        sendUpdates: 'none',
      });
    } catch {
      // Insert still writes the new time even if the stale event cannot be deleted.
    }
    response = await calendar.events.insert({
      calendarId,
      requestBody: eventBody,
      sendUpdates,
      conferenceDataVersion: needsConference ? 1 : 0,
    });
    event = response?.data || {};
  }
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
  const token = readToken(accountKey);
  return {
    eventId: sanitizeText(event.id),
    htmlLink: sanitizeText(event.htmlLink),
    meetLink,
    calendarId,
    accountKey: normalizeAccountKey(accountKey),
    googleEmail: sanitizeText(token?.googleEmail) || sanitizeText(event?.organizer?.email),
    syncedAt: new Date().toISOString(),
    firefliesInvited,
  };
}

export async function upsertSalesReminderEvent(client, action = {}, existingEventId = '', accountKey, options = {}) {
  const { oauthClient, config } = await getAuthorizedClient(accountKey);
  const calendar = google.calendar({ version: 'v3', auth: oauthClient });
  const startIso = safeIso(action?.dueAt);
  if (!startIso) throw new Error('Next action date/time is missing or invalid.');
  const zone = config.timeZone;
  const durationMinutes = resolveSalesReminderDurationMinutes(options);
  const startLocal = toCalendarDateTime(startIso, zone);
  const endLocal = toCalendarDateTime(
    new Date(new Date(startIso).getTime() + durationMinutes * 60 * 1000).toISOString(),
    zone
  );
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
    start: { dateTime: startLocal, timeZone: zone },
    end: { dateTime: endLocal, timeZone: zone },
    reminders: { useDefault: true },
    visibility: 'public',
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

/** Busy block only. Never copy a Google title or guest name. */
export function presentWorkshopBusyBlock(period = {}) {
  return {
    start: sanitizeText(period?.start),
    end: sanitizeText(period?.end),
    allDay: false,
    summary: 'Opptatt',
  };
}

export async function queryWorkshopFreeBusy(accountKey, { timeMin, timeMax } = {}) {
  const { oauthClient, config } = await getAuthorizedClient(accountKey);
  const calendar = google.calendar({ version: 'v3', auth: oauthClient });
  const calendarId = calendarIdForAccount(accountKey);
  const token = readToken(accountKey);
  const googleEmail = sanitizeText(token?.googleEmail);
  const items = [{ id: calendarId }];
  if (googleEmail && googleEmail.toLowerCase() !== calendarId.toLowerCase()) {
    items.push({ id: googleEmail });
  }
  const { data } = await withTimeout(
    calendar.freebusy.query({
      requestBody: {
        timeMin: sanitizeText(timeMin),
        timeMax: sanitizeText(timeMax),
        timeZone: config.timeZone,
        items,
      },
    }, GOOGLE_HTTP),
    CALENDAR_WEEK_TIMEOUT_MS,
    'calendar-freebusy-timeout'
  );
  const calendars = data?.calendars && typeof data.calendars === 'object' ? data.calendars : {};
  const busy = [];
  const seen = new Set();
  for (const entry of Object.values(calendars)) {
    for (const period of Array.isArray(entry?.busy) ? entry.busy : []) {
      const block = presentWorkshopBusyBlock(period);
      const key = `${block.start}|${block.end}`;
      if (!block.start || !block.end || seen.has(key)) continue;
      seen.add(key);
      busy.push(block);
    }
  }
  busy.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return {
    googleEmail,
    timeZone: config.timeZone,
    calendarId,
    busy,
  };
}
