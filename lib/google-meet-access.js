/**
 * Open the Google Meet rooms the hub books, so the Fireflies notetaker walks straight in.
 *
 * The notetaker joins as an anonymous guest. In a room at Google's default access it knocks,
 * and it gets in only if someone already in the room admits it: a rep who is late, alone with
 * the client or does not recognise the knock loses the recording. A room whose
 * config.accessType is OPEN lets anyone with the link in without knocking.
 *
 * The Meet REST API sets that with the meetings.space.settings scope on the room owner's own
 * OAuth token. asoldi.com has no Google Workspace, so a service account cannot act for a
 * mailbox and only 'oauth' tokens are used. Nobody has confirmed yet that Google lets a
 * consumer account open a Calendar-created room, so every outcome is recorded and returned,
 * never thrown, and nothing here holds up mail or a calendar sync.
 *
 * Results are kept per meeting code in <dataDir>/meet-room-access.json.
 */
import { google } from 'googleapis';
import { readJsonCached, updateJsonLocked } from '../data/atomic-json.js';
import { getDataFilePath } from '../data/storage-path.js';
import { guardExternal } from './safe-mode.js';

export const MEET_SETTINGS_SCOPE = 'https://www.googleapis.com/auth/meetings.space.settings';
export const MEET_ROOM_ACCESS_FILE = 'meet-room-access.json';
/** An open room is checked again after this long: a host can change access in Meet. */
export const MEET_ROOM_OPEN_TTL_MS = 6 * 60 * 60 * 1000;
/** A room Google refused is asked about again after this long, so a loop cannot hammer Google. */
export const MEET_ROOM_REFUSED_RETRY_MS = 15 * 60 * 1000;
export const MEET_ROOM_REASONS = ['scope-missing', 'not-owner', 'forbidden', 'not-found', 'safe-mode', 'error'];

// Same short deadline as GOOGLE_CALENDAR_HTTP_TIMEOUT_MS in google-calendar.js.
const MEET_HTTP_TIMEOUT_MS = 4000;
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const MESSAGE_MAX = 300;
const TIMEOUT_LABEL = 'meet-timeout';
const REFUSED_REASONS = new Set(['not-owner', 'forbidden', 'not-found']);
const MEET_CODE_RE = /^(?:https?:\/\/)?meet\.google\.com\/([a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3})(?=$|[/?#])/i;

const NOT_A_ROOM = 'Ikke en Google Meet-lenke.';
const SAFE_MODE_MESSAGE = 'Blokkert av safe mode (calendarWrite): møterommet ble ikke endret.';
const RECONNECT = 'Møteverten må koble til Google på nytt på /sales.';

function text(value = '') {
  return String(value ?? '').trim();
}

function isoAt(ms) {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function cleanIso(value = '') {
  const raw = text(value);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : '';
}

/** 'abc-defg-hij' from https://meet.google.com/abc-defg-hij (query and trailing slash ignored), else ''. */
export function meetingCodeFromLink(link = '') {
  const match = text(link).match(MEET_CODE_RE);
  return match ? match[1].toLowerCase() : '';
}

/** True when a token's granted scope (a token object, a scope string or a list) includes Meet room settings. */
export function tokenHasMeetSettingsScope(tokenOrScope) {
  const raw = typeof tokenOrScope === 'string' || Array.isArray(tokenOrScope) ? tokenOrScope : tokenOrScope?.scope;
  const scopes = Array.isArray(raw) ? raw : text(raw).split(/[\s,]+/);
  return scopes.some((scope) => text(scope) === MEET_SETTINGS_SCOPE);
}

function roomResult(meetingCode, nowMs, fields = {}) {
  return {
    ok: false,
    meetingCode,
    accessType: '',
    changed: false,
    reason: '',
    message: '',
    checkedAt: isoAt(nowMs),
    ...fields,
  };
}

function withDeadline(run, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMEOUT_LABEL)), ms);
  });
  return Promise.race([Promise.resolve().then(run), deadline]).finally(() => clearTimeout(timer));
}

function accessTypeOf(space) {
  return text(space?.config?.accessType).toUpperCase();
}

function httpStatus(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number < 600 ? number : 0;
}

function googleErrorParts(error) {
  const body = error?.response?.data?.error;
  const listed = (list) => (Array.isArray(list) ? list.map((item) => item?.reason) : []);
  const status = httpStatus(error?.status) || httpStatus(error?.response?.status)
    || httpStatus(error?.code) || httpStatus(body?.code);
  const reasons = [...listed(body?.details), ...listed(body?.errors), ...listed(error?.errors), body?.status]
    .map(text)
    .filter(Boolean);
  return { status, reasons, message: text(body?.message) || text(error?.message) };
}

function withDetail(message, detail) {
  return (detail ? `${message} (${detail})` : message).slice(0, MESSAGE_MAX);
}

/** Map a Meet API failure onto a reason. `phase` is 'get' or 'patch'. */
function classifyMeetError(error, phase) {
  if (text(error?.message) === TIMEOUT_LABEL || ['TimeoutError', 'AbortError'].includes(text(error?.code || error?.name))) {
    return { reason: 'error', message: 'Google Meet svarte ikke i tide.' };
  }
  const { status, reasons, message } = googleErrorParts(error);
  const mentions = (pattern) => reasons.some((reason) => pattern.test(reason)) || pattern.test(message);
  if (mentions(/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficient authentication scopes/i)) {
    return { reason: 'scope-missing', message: `Google-tilkoblingen mangler tilgang til Meet-innstillinger. ${RECONNECT}` };
  }
  if (mentions(/SERVICE_DISABLED|accessNotConfigured|has not been used in project|API has not been enabled/i)) {
    return { reason: 'forbidden', message: 'Google Meet REST API er ikke slått på i Google Cloud-prosjektet.' };
  }
  if (status === 404) return { reason: 'not-found', message: 'Google fant ikke møterommet.' };
  // Reading worked but the change was refused: the classic room created by another account.
  if (status === 403 && phase === 'patch') {
    return { reason: 'not-owner', message: withDetail('Google lot ikke denne kontoen åpne møterommet. Rommet eies trolig av en annen konto.', message) };
  }
  if (status === 403) return { reason: 'forbidden', message: withDetail('Google ga ikke tilgang til møterommet.', message) };
  if (status === 401) return { reason: 'forbidden', message: `Google godtok ikke innloggingen. ${RECONNECT}` };
  if (status >= 400 && status < 500) return { reason: 'forbidden', message: withDetail(`Google avviste endringen (${status}).`, message) };
  return { reason: 'error', message: withDetail('Kunne ikke nå Google Meet.', message) };
}

async function openRoomUnguarded({ auth, meetingCode, meetApi, timeoutMs, nowMs }) {
  const done = (fields) => roomResult(meetingCode, nowMs, fields);
  let api = meetApi;
  if (!api) {
    try {
      api = google.meet({ version: 'v2', auth });
    } catch (error) {
      return done({ reason: 'error', message: withDetail('Kunne ikke starte Google Meet-klienten.', text(error?.message)) });
    }
  }
  const request = { timeout: timeoutMs };
  let space;
  try {
    // The meeting-code alias works for get only; patch needs the space's own name.
    space = (await withDeadline(() => api.spaces.get({ name: `spaces/${meetingCode}` }, request), timeoutMs))?.data || {};
  } catch (error) {
    return done(classifyMeetError(error, 'get'));
  }
  const before = accessTypeOf(space);
  if (before === 'OPEN') return done({ ok: true, accessType: 'OPEN', message: 'Møterommet var allerede åpent.' });
  const name = text(space?.name);
  if (!/^spaces\/[^/\s]+$/.test(name)) {
    return done({ reason: 'error', accessType: before, message: 'Google svarte uten navn på møterommet.' });
  }
  try {
    const patched = (await withDeadline(() => api.spaces.patch({
      name,
      updateMask: 'config.accessType',
      requestBody: { config: { accessType: 'OPEN' } },
    }, request), timeoutMs))?.data || {};
    const after = accessTypeOf(patched) || 'OPEN';
    if (after !== 'OPEN') {
      return done({ reason: 'forbidden', accessType: after, message: `Google beholdt tilgangen ${after}.` });
    }
    return done({
      ok: true,
      accessType: 'OPEN',
      changed: true,
      message: 'Møterommet er åpnet. Fireflies kommer inn uten at noen må slippe den inn.',
    });
  } catch (error) {
    return done({ ...classifyMeetError(error, 'patch'), accessType: before });
  }
}

/**
 * spaces.get on the room's meeting code, then spaces.patch config.accessType=OPEN unless it is
 * open already. `auth` is the room owner's OAuth2 client; `meetApi` stands in for the googleapis
 * Meet client (tests). Resolves { ok, meetingCode, accessType, changed, reason, message,
 * checkedAt }; never rejects.
 */
export async function openMeetRoom({
  auth = null,
  meetLink = '',
  meetApi = null,
  timeoutMs = MEET_HTTP_TIMEOUT_MS,
  nowMs = Date.now(),
} = {}) {
  const meetingCode = meetingCodeFromLink(meetLink);
  if (!meetingCode) return roomResult('', nowMs, { reason: 'error', message: NOT_A_ROOM });
  if (!guardExternal('calendarWrite', `meet.spaces.patch code=${meetingCode}`).allowed) {
    return roomResult(meetingCode, nowMs, { reason: 'safe-mode', message: SAFE_MODE_MESSAGE });
  }
  return openRoomUnguarded({ auth, meetingCode, meetApi, timeoutMs, nowMs });
}

// ── stored status ────────────────────────────────────────────────────────────

function accessFilePath() {
  return getDataFilePath(MEET_ROOM_ACCESS_FILE);
}

function readRooms() {
  try {
    const value = readJsonCached(accessFilePath());
    return value && typeof value === 'object' ? value : {};
  } catch {
    // An unreadable data dir only means "not checked yet".
    return {};
  }
}

function presentEntry(meetingCode, raw) {
  if (!meetingCode || !raw || typeof raw !== 'object') return null;
  const ok = raw.ok === true;
  const reason = text(raw.reason);
  return {
    meetingCode,
    ok,
    accessType: text(raw.accessType).toUpperCase(),
    reason: ok ? '' : (MEET_ROOM_REASONS.includes(reason) ? reason : 'error'),
    message: text(raw.message).slice(0, MESSAGE_MAX),
    checkedAt: cleanIso(raw.checkedAt),
    ownerKey: text(raw.ownerKey),
  };
}

/** Last recorded result for this room: { meetingCode, ok, accessType, reason, message, checkedAt, ownerKey }, or null. */
export function meetRoomAccessStatus(meetLink = '') {
  const meetingCode = meetingCodeFromLink(meetLink);
  return meetingCode ? presentEntry(meetingCode, readRooms()[meetingCode]) : null;
}

function logChange(previous, next) {
  if (previous && previous.ok === next.ok && previous.reason === next.reason && previous.accessType === next.accessType) return;
  if (next.ok) {
    console.log(`[meet-room] ${next.meetingCode} open owner=${next.ownerKey || '-'}`);
  } else {
    console.warn(`[meet-room] ${next.meetingCode} not opened: ${next.reason} owner=${next.ownerKey || '-'} ${next.message}`);
  }
}

function recordRoom(meetingCode, fields, nowMs, previous = null) {
  const ok = fields.ok === true;
  const stored = {
    accessType: text(fields.accessType).toUpperCase(),
    checkedAt: cleanIso(fields.checkedAt) || isoAt(nowMs),
    ok,
    reason: ok ? '' : text(fields.reason) || 'error',
    message: text(fields.message).slice(0, MESSAGE_MAX),
    ownerKey: text(fields.ownerKey),
  };
  try {
    updateJsonLocked(accessFilePath(), (current) => {
      const rooms = current && typeof current === 'object' ? { ...current } : {};
      for (const [code, row] of Object.entries(rooms)) {
        const at = Date.parse(row?.checkedAt || '');
        if (!Number.isFinite(at) || nowMs - at > KEEP_MS) delete rooms[code];
      }
      rooms[meetingCode] = stored;
      return rooms;
    });
  } catch (error) {
    console.warn('[meet-room] could not save the room status', text(error?.message) || error);
  }
  const status = presentEntry(meetingCode, stored);
  logChange(previous, status);
  return status;
}

function storedStillHolds(stored, nowMs) {
  const at = Date.parse(stored?.checkedAt || '');
  if (!Number.isFinite(at) || at > nowMs) return false;
  if (stored.ok) return nowMs - at < MEET_ROOM_OPEN_TTL_MS;
  return REFUSED_REASONS.has(stored.reason) && nowMs - at < MEET_ROOM_REFUSED_RETRY_MS;
}

// ── ensure ───────────────────────────────────────────────────────────────────

const inFlight = new Map();

async function checkRoom({ meetingCode, accountKey, ownerEmail, nowMs, deps, previous }) {
  // Loaded here, not at the top: google-calendar.js imports this module for its upserts.
  const calendar = deps.calendar || await import('./google-calendar.js');
  const owner = calendar.meetRoomOwnerToken({ accountKey: text(accountKey) || previous?.ownerKey || '', ownerEmail });
  const save = (fields) => recordRoom(meetingCode, { ownerKey: owner.accountKey, ...fields }, nowMs, previous);
  if (!owner.usable) {
    const who = owner.googleEmail || 'Møteverten';
    return save({ reason: 'scope-missing', message: `${who} har ikke koblet til Google med egen innlogging. Koble til Google på /sales.` });
  }
  if (!tokenHasMeetSettingsScope(owner)) {
    return save({ reason: 'scope-missing', message: `Google-tilkoblingen mangler tilgang til Meet-innstillinger. ${RECONNECT}` });
  }
  if (!guardExternal('calendarWrite', `meet.spaces.patch code=${meetingCode}`).allowed) {
    return save({ reason: 'safe-mode', message: SAFE_MODE_MESSAGE });
  }
  let auth;
  try {
    auth = await calendar.getAuthorizedClient(owner.accountKey);
  } catch (error) {
    return save({ reason: 'error', message: withDetail('Kunne ikke logge inn hos Google.', text(error?.message)) });
  }
  if (auth?.authMode !== 'oauth') {
    return save({ reason: 'scope-missing', message: `Bare møtevertens egen Google-innlogging kan åpne rommet. ${RECONNECT}` });
  }
  const result = await openRoomUnguarded({
    auth: auth.oauthClient,
    meetingCode,
    meetApi: deps.meetApi || null,
    timeoutMs: Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : MEET_HTTP_TIMEOUT_MS,
    nowMs,
  });
  return save(result);
}

/**
 * Make sure a booked room is open, with the room owner's own OAuth token. `accountKey` is any
 * calendar account key of the owner; `ownerEmail` (the event organizer, when known) wins over
 * it. Without the meetings.space.settings scope the result is 'scope-missing' and Google is not
 * called. A room found open within 6 hours, or refused by Google within 15 minutes, is not asked
 * about again unless `force`. Resolves the stored status plus `cached`; never rejects.
 */
export function ensureMeetRoomOpen({
  meetLink = '',
  accountKey = '',
  ownerEmail = '',
  force = false,
  nowMs = Date.now(),
  deps = {},
} = {}) {
  const meetingCode = meetingCodeFromLink(meetLink);
  if (!meetingCode) {
    return Promise.resolve({
      meetingCode: '',
      ok: false,
      accessType: '',
      reason: 'error',
      message: NOT_A_ROOM,
      checkedAt: isoAt(nowMs),
      ownerKey: '',
      cached: false,
    });
  }
  const previous = presentEntry(meetingCode, readRooms()[meetingCode]);
  if (!force && storedStillHolds(previous, nowMs)) return Promise.resolve({ ...previous, cached: true });
  const running = inFlight.get(meetingCode);
  if (running) return running;
  const task = Promise.resolve()
    .then(() => checkRoom({ meetingCode, accountKey, ownerEmail, nowMs, deps: deps || {}, previous }))
    .catch((error) => recordRoom(meetingCode, {
      reason: 'error',
      message: withDetail('Kunne ikke sjekke møterommet.', text(error?.message)),
      ownerKey: previous?.ownerKey || text(accountKey),
    }, nowMs, previous))
    .then((status) => ({ ...status, cached: false }))
    .finally(() => inFlight.delete(meetingCode));
  inFlight.set(meetingCode, task);
  return task;
}

const background = new Set();

/** ensureMeetRoomOpen for the calendar upserts: started, not awaited, never rejects. */
export function openMeetRoomSoon(input = {}) {
  const task = ensureMeetRoomOpen(input).catch((error) => {
    console.warn('[meet-room] open failed', text(error?.message) || error);
    return null;
  });
  background.add(task);
  task.finally(() => background.delete(task));
  return task;
}

/** Tests: wait until every background room check started so far has finished. */
export async function settleMeetRoomOpensForTests() {
  while (background.size) await Promise.allSettled([...background]);
}

/** Tests: forget in-flight checks. */
export function resetMeetRoomAccessForTests() {
  inFlight.clear();
  background.clear();
}
