/**
 * Prepare the Google Meet rooms the hub books: staff join without knocking as co-hosts; the client
 * knocks. The only time a room is OPEN (anyone with the link walks in) is the live join's short
 * notetaker window around the start (setMeetRoomAccess, driven by lib/fireflies-live-sessions.js).
 *
 * Co-hosts are spaces.members COHOST (meetings.space.created), which Google allows only on rooms the
 * app made itself (createMeetSpaceWithCohosts); a Calendar-made room records cohostReason
 * 'calendar-room'. Access is TRUSTED plus moderation ON (meetings.space.settings). asoldi.com has no
 * Workspace, so only the room owner's OAuth login can change the space. Failures are stored and
 * returned, never thrown.
 *
 * Results are kept per meeting code in <dataDir>/meet-room-access.json.
 */
import { google } from 'googleapis';
import { readJsonCached, updateJsonLocked } from '../data/atomic-json.js';
import { getDataFilePath } from '../data/storage-path.js';
import { guardExternal } from './safe-mode.js';

export const MEET_SETTINGS_SCOPE = 'https://www.googleapis.com/auth/meetings.space.settings';
/** Needed to add co-hosts (spaces.members.create). Sensitive: each host reconnects once. */
export const MEET_MEMBERS_SCOPE = 'https://www.googleapis.com/auth/meetings.space.created';
/** Invited staff / org can join; anonymous guests (the client on another account) knock. */
export const MEET_STAFF_ACCESS_TYPE = 'TRUSTED';
export const MEET_ROOM_ACCESS_FILE = 'meet-room-access.json';
/** A prepared room is checked again after this long (a caller may ask sooner): a host can change access in Meet. */
export const MEET_ROOM_OPEN_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * A room Google refused, or whose owner has no login with the scope, is asked about again with
 * the same login after this long, so a loop cannot hammer Google. A reconnect lifts a missing
 * scope at once.
 */
export const MEET_ROOM_REFUSED_RETRY_MS = 15 * 60 * 1000;
/** The same login is asked again this long after a check broke (timeout, network, Google busy, a failed login) or met safe mode. */
export const MEET_ROOM_ERROR_RETRY_MS = 3 * 60 * 1000;
export const MEET_ROOM_REASONS = ['scope-missing', 'not-owner', 'forbidden', 'not-found', 'safe-mode', 'error'];

// Same short deadline as GOOGLE_CALENDAR_HTTP_TIMEOUT_MS in google-calendar.js.
const MEET_HTTP_TIMEOUT_MS = 4000;
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const MESSAGE_MAX = 300;
const TIMEOUT_LABEL = 'meet-timeout';
// Answers about this login and this room. Another login (the room's real owner) may do better.
const REFUSED_REASONS = new Set(['not-owner', 'forbidden', 'not-found', 'scope-missing']);
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
function scopeList(tokenOrScope) {
  const raw = typeof tokenOrScope === 'string' || Array.isArray(tokenOrScope) ? tokenOrScope : tokenOrScope?.scope;
  return Array.isArray(raw) ? raw : text(raw).split(/[\s,]+/);
}

export function tokenHasMeetSettingsScope(tokenOrScope) {
  return scopeList(tokenOrScope).some((scope) => text(scope) === MEET_SETTINGS_SCOPE);
}

export function tokenHasMeetMembersScope(tokenOrScope) {
  return scopeList(tokenOrScope).some((scope) => text(scope) === MEET_MEMBERS_SCOPE);
}

function accessIsStaffOnly(accessType = '') {
  const value = text(accessType).toUpperCase();
  return value === 'TRUSTED' || value === 'RESTRICTED';
}

function memberEmailOf(row = {}) {
  const email = text(row?.email).toLowerCase();
  if (email.includes('@')) return email;
  const user = text(row?.user).replace(/^users\//i, '').toLowerCase();
  return user.includes('@') ? user : '';
}

function memberEmailsOf(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((email) => text(email).toLowerCase()).filter((email) => email.includes('@')))];
}

function requestedMembersCovered(stored, requested = []) {
  const need = memberEmailsOf(requested);
  if (!need.length) return true;
  const have = new Set(memberEmailsOf(stored?.memberEmails));
  return need.every((email) => have.has(email));
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
  // Busy or a clash, not a refusal: worth asking again in a few minutes.
  if ([408, 409, 429].includes(status) || mentions(/RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED|rateLimitExceeded|quotaExceeded|ABORTED/)) {
    return { reason: 'error', message: withDetail(`Google Meet ba oss vente${status ? ` (${status})` : ''}.`, message) };
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

const MEET_API = 'https://meet.googleapis.com/v2';

/**
 * spaces.members (GA since Sept 2026; googleapis 173 has no client for it): the client's own when it has one
 * (tests), else REST calls on the room owner's OAuth client. Null when neither is there.
 */
function membersApi(api, auth) {
  const own = api?.spaces?.members;
  if (typeof own?.list === 'function' && typeof own?.create === 'function') return own;
  if (typeof auth?.request !== 'function') return null;
  return {
    list: ({ parent }, options = {}) => auth.request({ url: `${MEET_API}/${parent}/members`, method: 'GET', timeout: options.timeout }),
    create: ({ parent, requestBody }, options = {}) => auth.request({ url: `${MEET_API}/${parent}/members`, method: 'POST', data: requestBody, timeout: options.timeout }),
  };
}

async function listSpaceMembers(members, parent, timeoutMs) {
  if (!members) return [];
  const data = (await withDeadline(
    () => members.list({ parent }, { timeout: timeoutMs }),
    timeoutMs,
  ))?.data;
  return Array.isArray(data?.members) ? data.members : [];
}

async function addSpaceCohost(members, parent, email, timeoutMs) {
  if (!members) {
    return { ok: false, reason: 'scope-missing', message: 'Meet-klienten kan ikke legge til medverter.' };
  }
  try {
    await withDeadline(
      () => members.create({
        parent,
        requestBody: { email, role: 'COHOST' },
      }, { timeout: timeoutMs }),
      timeoutMs,
    );
    return { ok: true };
  } catch (error) {
    const { status, message } = googleErrorParts(error);
    if (status === 409 || /ALREADY_EXISTS|already exists/i.test(message)) return { ok: true, existed: true };
    return { ok: false, ...classifyMeetError(error, 'members') };
  }
}

async function openRoomUnguarded({ auth, meetingCode, meetApi, timeoutMs, nowMs, memberEmails = [] }) {
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
  const name = text(space?.name);
  if (!/^spaces\/[^/\s]+$/.test(name)) {
    return done({ reason: 'error', accessType: before, message: 'Google svarte uten navn på møterommet.' });
  }
  let accessType = before;
  let changed = false;
  if (before === 'OPEN' || !accessIsStaffOnly(before)) {
    try {
      const patched = (await withDeadline(() => api.spaces.patch({
        name,
        updateMask: 'config.accessType,config.moderation',
        requestBody: { config: { accessType: MEET_STAFF_ACCESS_TYPE, moderation: 'ON' } },
      }, request), timeoutMs))?.data || {};
      accessType = accessTypeOf(patched) || MEET_STAFF_ACCESS_TYPE;
      changed = true;
      if (accessType === 'OPEN') {
        return done({
          reason: 'forbidden',
          accessType,
          message: 'Google beholdt rommet åpent for alle med lenken.',
        });
      }
    } catch (error) {
      return done({ ...classifyMeetError(error, 'patch'), accessType: before });
    }
  }
  const cohosts = await addCohosts(membersApi(api, auth), name, memberEmails, timeoutMs);
  if (cohosts.added) changed = true;
  const ok = accessIsStaffOnly(accessType);
  const memberBit = cohosts.added ? ` ${cohosts.added} medvert(er) lagt til.` : '';
  const warnBit = cohosts.note ? ` Medverter: ${cohosts.note}` : '';
  return done({
    ok,
    accessType,
    changed,
    reason: ok ? '' : 'forbidden',
    message: ok
      ? `Møterommet er for vert og medverter. Klienten banker fortsatt.${memberBit}${warnBit}`
      : `Google beholdt tilgangen ${accessType || before}.`,
    ...cohosts.fields,
  });
}

/**
 * Add the requested co-hosts that are not members yet. Google only allows this on rooms the app created
 * (spaces.create); a Calendar-made room answers 403, stored as cohostReason 'calendar-room'.
 * { added, note, fields: { memberEmails, cohostsOk, cohostReason } } (fields empty when none were asked for).
 */
async function addCohosts(members, name, memberEmails = [], timeoutMs = MEET_HTTP_TIMEOUT_MS) {
  const emails = memberEmailsOf(memberEmails);
  if (!emails.length) return { added: 0, note: '', fields: {} };
  let added = 0;
  let note = '';
  let reason = '';
  let have = new Set();
  try {
    have = new Set((await listSpaceMembers(members, name, timeoutMs)).map(memberEmailOf).filter(Boolean));
  } catch (error) {
    ({ message: note, reason } = classifyMeetError(error, 'members'));
  }
  if (!note) {
    for (const email of emails) {
      if (have.has(email)) continue;
      const result = await addSpaceCohost(members, name, email, timeoutMs);
      if (result.ok) {
        added += 1;
        have.add(email);
        continue;
      }
      note = result.message || result.reason;
      reason = result.reason;
      if (['scope-missing', 'forbidden', 'not-owner'].includes(result.reason)) break;
    }
  }
  const cohostsOk = emails.every((email) => have.has(email));
  if (!cohostsOk && ['forbidden', 'not-owner'].includes(reason)) reason = 'calendar-room';
  return { added, note, fields: { memberEmails: [...have], cohostsOk, cohostReason: cohostsOk ? '' : (reason || 'error') } };
}

/**
 * spaces.get, then TRUSTED+moderation so the client still knocks, then co-host members.
 * `auth` is the room owner's OAuth2 client; `meetApi` stands in for the googleapis Meet client
 * (tests). Resolves { ok, meetingCode, accessType, changed, reason, message, checkedAt };
 * never rejects.
 */
export async function openMeetRoom({
  auth = null,
  meetLink = '',
  meetApi = null,
  memberEmails = [],
  timeoutMs = MEET_HTTP_TIMEOUT_MS,
  nowMs = Date.now(),
} = {}) {
  const meetingCode = meetingCodeFromLink(meetLink);
  if (!meetingCode) return roomResult('', nowMs, { reason: 'error', message: NOT_A_ROOM });
  if (!guardExternal('calendarWrite', `meet.spaces.patch code=${meetingCode}`).allowed) {
    return roomResult(meetingCode, nowMs, { reason: 'safe-mode', message: SAFE_MODE_MESSAGE });
  }
  return openRoomUnguarded({ auth, meetingCode, meetApi, timeoutMs, nowMs, memberEmails });
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
  const entry = {
    meetingCode,
    ok,
    accessType: text(raw.accessType).toUpperCase(),
    reason: ok ? '' : (MEET_ROOM_REASONS.includes(reason) ? reason : 'error'),
    message: text(raw.message).slice(0, MESSAGE_MAX),
    checkedAt: cleanIso(raw.checkedAt),
    ownerKey: text(raw.ownerKey),
  };
  if (Array.isArray(raw.memberEmails)) entry.memberEmails = memberEmailsOf(raw.memberEmails);
  if (typeof raw.cohostsOk === 'boolean') {
    entry.cohostsOk = raw.cohostsOk;
    entry.cohostReason = text(raw.cohostReason);
  }
  if (raw.createdByHub === true) entry.createdByHub = true;
  const window = presentWindow(raw.window);
  if (window) entry.window = window;
  return entry;
}

function presentWindow(raw) {
  if (!raw || typeof raw !== 'object' || !['open', 'locked'].includes(text(raw.state))) return null;
  return { state: text(raw.state), at: cleanIso(raw.at), until: cleanIso(raw.until), ok: raw.ok === true, reason: text(raw.reason) };
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
  if (Array.isArray(fields.memberEmails)) stored.memberEmails = memberEmailsOf(fields.memberEmails);
  if (typeof fields.cohostsOk === 'boolean') {
    stored.cohostsOk = fields.cohostsOk;
    stored.cohostReason = text(fields.cohostReason);
  }
  if (fields.createdByHub === true) stored.createdByHub = true;
  const window = presentWindow(fields.window);
  if (window) stored.window = window;
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

function ageMs(stored, nowMs) {
  const at = Date.parse(stored?.checkedAt || '');
  return Number.isFinite(at) && at <= nowMs ? nowMs - at : Infinity;
}

/** The live join opened the room for its notetaker and that window has not run out: leave it open. */
function windowStillOpen(stored, nowMs) {
  return stored?.window?.state === 'open' && Date.parse(stored.window.until || '') > nowMs;
}

/** A prepared (not OPEN) room seen within `maxAgeMs` still holds, whoever's login saw it. */
function openStillHolds(stored, nowMs, maxAgeMs, memberEmails = []) {
  if (windowStillOpen(stored, nowMs)) return true;
  if (!stored?.ok || !accessIsStaffOnly(stored.accessType)) return false;
  const age = ageMs(stored, nowMs);
  if (age >= maxAgeMs) return false;
  if (requestedMembersCovered(stored, memberEmails)) return true;
  // Google never lets an app add co-hosts to a room Calendar made: asking again changes nothing.
  if (stored.cohostReason === 'calendar-room') return true;
  if (!Array.isArray(stored.memberEmails)) return false;
  return age < MEET_ROOM_REFUSED_RETRY_MS;
}

/**
 * A failed check stands for a while, but only for the login that got it: another login may own
 * the room. A newer token (the host reconnected) lifts a missing scope at once.
 */
function failureStillHolds(stored, login, nowMs) {
  if (!stored || stored.ok || stored.ownerKey !== text(login?.accountKey)) return false;
  if (stored.reason === 'scope-missing' && Date.parse(login?.updatedAt || '') > Date.parse(stored.checkedAt)) return false;
  return ageMs(stored, nowMs) < (REFUSED_REASONS.has(stored.reason) ? MEET_ROOM_REFUSED_RETRY_MS : MEET_ROOM_ERROR_RETRY_MS);
}

// ── ensure ───────────────────────────────────────────────────────────────────

const inFlight = new Map();

/** One login's go at the room: { ok, reason, message, accessType, … }; never rejects. */
async function openWithLogin(calendar, login, { meetingCode, nowMs, deps, memberEmails }) {
  if (!login.usable) {
    const who = login.googleEmail || 'Møteverten';
    return { reason: 'scope-missing', message: `${who} har ikke koblet til Google med egen innlogging. Koble til Google på /sales.` };
  }
  if (!tokenHasMeetSettingsScope(login)) {
    return { reason: 'scope-missing', message: `Google-tilkoblingen mangler tilgang til Meet-innstillinger. ${RECONNECT}` };
  }
  if (!guardExternal('calendarWrite', `meet.spaces.patch code=${meetingCode}`).allowed) {
    return { reason: 'safe-mode', message: SAFE_MODE_MESSAGE };
  }
  let auth;
  try {
    auth = await calendar.getAuthorizedClient(login.accountKey);
  } catch (error) {
    return { reason: 'error', message: withDetail('Kunne ikke logge inn hos Google.', text(error?.message)) };
  }
  if (auth?.authMode !== 'oauth') {
    return { reason: 'scope-missing', message: `Bare møtevertens egen Google-innlogging kan åpne rommet. ${RECONNECT}` };
  }
  return openRoomUnguarded({
    auth: auth.oauthClient,
    meetingCode,
    meetApi: deps.meetApi || null,
    timeoutMs: Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : MEET_HTTP_TIMEOUT_MS,
    nowMs,
    memberEmails,
  });
}

async function checkRoom({ meetingCode, accountKey, ownerEmail, force, nowMs, deps, previous, memberEmails }) {
  // Loaded here, not at the top: google-calendar.js imports this module for its upserts.
  const calendar = deps.calendar || await import('./google-calendar.js');
  const owner = calendar.meetRoomOwnerToken({ accountKey: text(accountKey) || previous?.ownerKey || '', ownerEmail });
  if (!force && failureStillHolds(previous, owner, nowMs)) return { ...previous, cached: true };
  const context = { meetingCode, nowMs, deps, memberEmails };
  let login = owner;
  let result = await openWithLogin(calendar, owner, context);
  // A kept room can belong to another mailbox (a client moved to another rep keeps the room).
  // The login that opened it before gets one try before this refusal is stored.
  const known = previous?.ok ? text(previous.ownerKey) : '';
  if (!result.ok && REFUSED_REASONS.has(result.reason) && known && known !== owner.accountKey) {
    const before = calendar.meetRoomOwnerToken({ accountKey: known });
    if (before.usable && before.accountKey !== owner.accountKey && before.googleEmail !== owner.googleEmail) {
      const retried = await openWithLogin(calendar, before, context);
      if (retried.ok) {
        login = before;
        result = retried;
      }
    }
  }
  return recordRoom(meetingCode, { ownerKey: login.accountKey, ...result }, nowMs, previous);
}

function openTtlMs(maxAgeMs) {
  return typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : MEET_ROOM_OPEN_TTL_MS;
}

/**
 * Prepare a booked room (TRUSTED + co-hosts) with the room owner's own OAuth token.
 * `accountKey` is any calendar account key of the owner; `ownerEmail` (the room's host, else
 * the event organizer) wins over it. Without the meetings.space.settings scope the result is
 * 'scope-missing' and Google is not called. Unless `force`: a prepared room found within
 * `maxAgeMs` (6 hours) is not read again, and the same login is not asked again within 15
 * minutes of a refusal or 3 minutes of an error. Resolves the stored status plus `cached`;
 * never rejects.
 */
export function ensureMeetRoomOpen({
  meetLink = '',
  accountKey = '',
  ownerEmail = '',
  memberEmails = [],
  force = false,
  maxAgeMs = MEET_ROOM_OPEN_TTL_MS,
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
  if (!force && openStillHolds(previous, nowMs, openTtlMs(maxAgeMs), memberEmails)) {
    return Promise.resolve({ ...previous, cached: true });
  }
  const running = inFlight.get(meetingCode);
  if (running) return running;
  const task = Promise.resolve()
    .then(() => checkRoom({
      meetingCode,
      accountKey,
      ownerEmail,
      force: Boolean(force),
      nowMs,
      deps: deps || {},
      previous,
      memberEmails,
    }))
    .catch((error) => recordRoom(meetingCode, {
      reason: 'error',
      message: withDetail('Kunne ikke sjekke møterommet.', text(error?.message)),
      ownerKey: previous?.ownerKey || text(accountKey),
    }, nowMs, previous))
    .then((status) => ({ cached: false, ...status }))
    .finally(() => inFlight.delete(meetingCode));
  inFlight.set(meetingCode, task);
  return task;
}

/** The room owner's OAuth client for a Meet change: { login, auth } or { reason, message }. */
async function ownerOAuth({ accountKey = '', ownerEmail = '', meetingCode = '', deps = {}, previous = null }) {
  const calendar = deps.calendar || await import('./google-calendar.js');
  const login = calendar.meetRoomOwnerToken({ accountKey: text(accountKey) || previous?.ownerKey || '', ownerEmail });
  if (!login.usable) return { login, reason: 'scope-missing', message: `${login.googleEmail || 'Møteverten'} har ikke koblet til Google med egen innlogging. Koble til Google på /sales.` };
  if (!tokenHasMeetSettingsScope(login)) return { login, reason: 'scope-missing', message: `Google-tilkoblingen mangler tilgang til Meet-innstillinger. ${RECONNECT}` };
  if (!guardExternal('calendarWrite', `meet.spaces code=${meetingCode || 'new'}`).allowed) return { login, reason: 'safe-mode', message: SAFE_MODE_MESSAGE };
  let auth;
  try {
    auth = await calendar.getAuthorizedClient(login.accountKey);
  } catch (error) {
    return { login, reason: 'error', message: withDetail('Kunne ikke logge inn hos Google.', text(error?.message)) };
  }
  if (auth?.authMode !== 'oauth') return { login, reason: 'scope-missing', message: `Bare møtevertens egen Google-innlogging kan endre rommet. ${RECONNECT}` };
  return { login, auth: auth.oauthClient };
}

/**
 * The live join's notetaker window: OPEN lets anyone with the link walk in (the notetaker needs no one to
 * admit it); TRUSTED makes the room knock-only again. `untilMs`: when an OPEN window may be closed by the
 * ordinary room check at the latest. Resolves { ok, accessType, reason, message }; never rejects.
 */
export async function setMeetRoomAccess({
  meetLink = '',
  accountKey = '',
  ownerEmail = '',
  accessType = MEET_STAFF_ACCESS_TYPE,
  untilMs = 0,
  nowMs = Date.now(),
  deps = {},
} = {}) {
  const meetingCode = meetingCodeFromLink(meetLink);
  if (!meetingCode) return { ok: false, accessType: '', reason: 'error', message: NOT_A_ROOM };
  const target = text(accessType).toUpperCase() === 'OPEN' ? 'OPEN' : MEET_STAFF_ACCESS_TYPE;
  const previous = presentEntry(meetingCode, readRooms()[meetingCode]);
  try {
    const owner = await ownerOAuth({ accountKey, ownerEmail, meetingCode, deps, previous });
    if (!owner.auth) return { ok: false, accessType: '', reason: owner.reason, message: owner.message };
    const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : MEET_HTTP_TIMEOUT_MS;
    const api = deps.meetApi || google.meet({ version: 'v2', auth: owner.auth });
    const space = (await withDeadline(() => api.spaces.get({ name: `spaces/${meetingCode}` }, { timeout: timeoutMs }), timeoutMs))?.data || {};
    const name = text(space?.name);
    if (!/^spaces\/[^/\s]+$/.test(name)) return { ok: false, accessType: accessTypeOf(space), reason: 'error', message: 'Google svarte uten navn på møterommet.' };
    const patched = (await withDeadline(() => api.spaces.patch({
      name,
      updateMask: 'config.accessType',
      requestBody: { config: { accessType: target } },
    }, { timeout: timeoutMs }), timeoutMs))?.data || {};
    const now = accessTypeOf(patched) || target;
    const ok = now === target;
    const window = { state: target === 'OPEN' ? 'open' : 'locked', at: isoAt(nowMs), until: target === 'OPEN' && untilMs ? isoAt(untilMs) : '', ok, reason: ok ? '' : 'forbidden' };
    recordRoom(meetingCode, {
      ...(previous || {}),
      checkedAt: isoAt(nowMs),
      reason: ok ? '' : 'forbidden',
      ok: target === 'OPEN' ? Boolean(previous?.ok) : ok,
      accessType: now,
      ownerKey: owner.login.accountKey,
      message: ok ? (target === 'OPEN' ? 'Åpent for notetakeren.' : 'Bare vert og medverter slipper rett inn igjen.') : `Google beholdt tilgangen ${now}.`,
      window,
    }, nowMs, previous);
    return { ok, accessType: now, reason: ok ? '' : 'forbidden', message: ok ? '' : `Google beholdt tilgangen ${now}.` };
  } catch (error) {
    const failed = classifyMeetError(error, 'patch');
    return { ok: false, accessType: '', reason: failed.reason, message: failed.message };
  }
}

/**
 * A new room made by the hub itself (spaces.create, scope meetings.space.created) so Google lets it add
 * co-hosts: knock-only with moderation, then `memberEmails` as COHOST. The caller attaches the returned
 * link to the calendar event as conferenceData. Resolves { ok, meetLink, meetingCode, name, cohostsOk,
 * cohostReason, reason, message }; never rejects. Not ok means: let Calendar mint the room as before.
 */
export async function createMeetSpaceWithCohosts({
  accountKey = '',
  ownerEmail = '',
  memberEmails = [],
  nowMs = Date.now(),
  deps = {},
} = {}) {
  try {
    const owner = await ownerOAuth({ accountKey, ownerEmail, deps });
    if (!owner.auth) return { ok: false, reason: owner.reason, message: owner.message };
    if (!tokenHasMeetMembersScope(owner.login)) {
      return { ok: false, reason: 'scope-missing', message: `Google-tilkoblingen mangler tilgang til å lage møterom. ${RECONNECT}` };
    }
    const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : MEET_HTTP_TIMEOUT_MS;
    const api = deps.meetApi || google.meet({ version: 'v2', auth: owner.auth });
    const space = (await withDeadline(() => api.spaces.create({
      requestBody: { config: { accessType: MEET_STAFF_ACCESS_TYPE, moderation: 'ON' } },
    }, { timeout: timeoutMs }), timeoutMs))?.data || {};
    const meetLink = text(space.meetingUri);
    const meetingCode = text(space.meetingCode).toLowerCase() || meetingCodeFromLink(meetLink);
    const name = text(space.name);
    if (!meetingCode || !/^spaces\/[^/\s]+$/.test(name)) return { ok: false, reason: 'error', message: 'Google laget ikke et møterom.' };
    const cohosts = await addCohosts(membersApi(api, owner.auth), name, memberEmails, timeoutMs);
    recordRoom(meetingCode, {
      ok: true,
      accessType: accessTypeOf(space) || MEET_STAFF_ACCESS_TYPE,
      ownerKey: owner.login.accountKey,
      createdByHub: true,
      message: `Møterom laget av Asoldi.${cohosts.added ? ` ${cohosts.added} medvert(er) lagt til.` : ''}${cohosts.note ? ` Medverter: ${cohosts.note}` : ''}`,
      ...cohosts.fields,
    }, nowMs, null);
    return {
      ok: true,
      meetLink: meetLink || `https://meet.google.com/${meetingCode}`,
      meetingCode,
      name,
      cohostsOk: cohosts.fields.cohostsOk !== false,
      cohostReason: cohosts.fields.cohostReason || '',
      reason: '',
      message: '',
    };
  } catch (error) {
    const failed = classifyMeetError(error, 'create');
    return { ok: false, reason: failed.reason, message: failed.message };
  }
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
