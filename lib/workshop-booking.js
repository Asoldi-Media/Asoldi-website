import { isSsuSalesProduct } from './sales-next-actions.js';
import {
  DAMIAN_CALENDAR_ACCOUNT_KEY,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  WORKSHOP_TIMEZONE,
  getWorkshopAction,
  pickDamianCalendarAccountKey,
  sanitizeWorkshopFormat,
  workshopIsConfirmed,
} from './workshop-action-shared.js';
import {
  workshopGoalHeld,
  workshopGoalIterated,
} from './workshop-goal-timeline.js';
import { resolveWebsiteDue } from './website-due.js';

export {
  DAMIAN_CALENDAR_ACCOUNT_KEY,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  getWorkshopAction,
  pickDamianCalendarAccountKey,
};

export const ADMIN_BOARD_UNBOOKED_BUCKET = 'unbooked';
export const ADMIN_BOARD_RANKED_BUCKET = 'ranked';
export const ADMIN_BOARD_UNLISTED_BUCKET = 'unlisted';

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function parseMs(value = '') {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function compareNames(a = {}, b = {}) {
  return sanitizeText(a.businessName).localeCompare(sanitizeText(b.businessName), 'nb-NO', { sensitivity: 'base' });
}

function contractIsSigned(client = {}) {
  return Boolean(client?.progression?.contractSigned);
}

export function workshopTidIsSet(client = {}) {
  return Boolean(sanitizeText(getWorkshopAction(client)?.dueAt));
}

/** Active non-SSU MyPhoner winners and hand-added clients. Contract-signed stay in. Not-sold and secondary stay out. */
export function isAdminBoardClient(client = {}) {
  if (!client || typeof client !== 'object') return false;
  if (sanitizeText(client.status).toLowerCase() !== 'active') return false;
  if (isSsuSalesProduct(client.product)) return false;
  return true;
}

export function filterAdminBoardClients(clients = []) {
  return (Array.isArray(clients) ? clients : []).filter(isAdminBoardClient);
}

function earliestDueAt(values = []) {
  let minMs = null;
  let chosen = '';
  for (const value of values) {
    const ms = parseMs(value);
    if (ms == null) continue;
    if (minMs == null || ms < minMs) {
      minMs = ms;
      chosen = sanitizeText(value);
    }
  }
  return chosen;
}

/**
 * Next incomplete Admin action time (workshop, informasjon, iteration, extras).
 * Offer start dates and sales next-actions are ignored.
 */
export function getAdminNextActionDueAt(client = {}) {
  if (workshopGoalHeld(client) && workshopGoalIterated(client)) return '';
  const extras = (Array.isArray(client?.workshop?.goalActions) ? client.workshop.goalActions : [])
    .filter((row) => !sanitizeText(row?.doneAt))
    .map((row) => row?.dueAt);
  if (workshopGoalHeld(client)) {
    return earliestDueAt([...extras, client?.workshop?.iterationMeeting?.dueAt]);
  }
  return earliestDueAt([...extras, getWorkshopAction(client)?.dueAt]);
}

export function getAdminWebsiteDueAt(client = {}) {
  const due = resolveWebsiteDue({
    contractSigned: contractIsSigned(client),
    contractSignedAt: client?.contractSignedAt,
    dueOverride: client?.websiteDueOverride,
    weeks: client?.websiteDeliveryWeeks,
    workDays: client?.websiteDeliveryWorkDays,
  });
  return sanitizeText(due.dueAt);
}

/**
 * Soonest of project due date or next action. Completed workshop+iteration sort last.
 * Untimed cards return null so they sit below timed rows in the ranked list.
 */
export function getAdminRankMs(client = {}) {
  if (workshopGoalHeld(client) && workshopGoalIterated(client)) return Number.MAX_SAFE_INTEGER;
  const actionMs = parseMs(getAdminNextActionDueAt(client));
  const dueMs = parseMs(getAdminWebsiteDueAt(client));
  const times = [actionMs, dueMs].filter((ms) => ms != null);
  if (!times.length) return null;
  return Math.min(...times);
}

export function getAdminCurrentMeetingFormat(client = {}) {
  if (workshopGoalHeld(client)) {
    const format = sanitizeText(client?.workshop?.iterationMeeting?.format);
    return format ? sanitizeWorkshopFormat(format) : '';
  }
  const action = getWorkshopAction(client);
  return action ? sanitizeWorkshopFormat(action.format) : '';
}

/**
 * Three board sections: signed without workshop Tid, workshop Tid set (ranked),
 * unsigned without workshop Tid.
 */
export function classifyAdminWorkshopBucket(client = {}) {
  if (workshopTidIsSet(client)) return ADMIN_BOARD_RANKED_BUCKET;
  if (contractIsSigned(client)) return ADMIN_BOARD_UNBOOKED_BUCKET;
  return ADMIN_BOARD_UNLISTED_BUCKET;
}

export function osloCalendarYmd(ms = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: WORKSHOP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function osloMondayOffset(ms) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: WORKSHOP_TIMEZONE,
    weekday: 'short',
  }).format(new Date(ms));
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return map[weekday] ?? 0;
}

export function osloWeekYmdRange(nowMs = Date.now()) {
  const offset = osloMondayOffset(nowMs);
  const startMs = nowMs - offset * 24 * 60 * 60 * 1000;
  const endMs = startMs + 6 * 24 * 60 * 60 * 1000;
  return { start: osloCalendarYmd(startMs), end: osloCalendarYmd(endMs) };
}

export function clientMatchesAdminBoardFilters(client = {}, filters = {}, nowMs = Date.now()) {
  const bucket = sanitizeText(filters.bucket);
  const format = sanitizeText(filters.format);
  const status = sanitizeText(filters.status);
  const when = sanitizeText(filters.when);
  const action = getWorkshopAction(client);
  const currentBucket = classifyAdminWorkshopBucket(client);
  if (bucket && currentBucket !== bucket) return false;
  if (format) {
    const currentFormat = getAdminCurrentMeetingFormat(client);
    if (!currentFormat || currentFormat !== sanitizeWorkshopFormat(format)) return false;
  }
  if (status === 'held' && !workshopGoalHeld(client)) return false;
  if (status === 'not-held' && workshopGoalHeld(client)) return false;
  if (status === 'confirmed' && !(action && workshopIsConfirmed(action))) return false;
  if (status === 'draft' && !(action && !workshopIsConfirmed(action))) return false;
  if (when) {
    const dueMs = getAdminRankMs(client);
    if (dueMs == null || dueMs === Number.MAX_SAFE_INTEGER) return false;
    const dueYmd = osloCalendarYmd(dueMs);
    if (when === 'today' && dueYmd !== osloCalendarYmd(nowMs)) return false;
    if (when === 'week') {
      const week = osloWeekYmdRange(nowMs);
      if (dueYmd < week.start || dueYmd > week.end) return false;
    }
    if (when === 'overdue' && !(currentBucket === ADMIN_BOARD_RANKED_BUCKET && dueMs < nowMs)) return false;
  }
  return true;
}

export function groupAdminBoardClients(clients = []) {
  const unbooked = [];
  const ranked = [];
  const unlisted = [];
  for (const client of filterAdminBoardClients(clients)) {
    const bucket = classifyAdminWorkshopBucket(client);
    if (bucket === ADMIN_BOARD_UNBOOKED_BUCKET) unbooked.push(client);
    else if (bucket === ADMIN_BOARD_RANKED_BUCKET) ranked.push(client);
    else unlisted.push(client);
  }
  unbooked.sort((a, b) => {
    const aMs = parseMs(a?.contractSignedAt) || 0;
    const bMs = parseMs(b?.contractSignedAt) || 0;
    if (aMs !== bMs) return aMs - bMs;
    return compareNames(a, b);
  });
  ranked.sort((a, b) => {
    const aMs = getAdminRankMs(a);
    const bMs = getAdminRankMs(b);
    const aTimed = aMs != null;
    const bTimed = bMs != null;
    if (aTimed && !bTimed) return -1;
    if (!aTimed && bTimed) return 1;
    if (aTimed && bTimed && aMs !== bMs) return aMs - bMs;
    return compareNames(a, b);
  });
  unlisted.sort(compareNames);
  return { unbooked, ranked, unlisted };
}

export function getAdminNextAction(client = {}) {
  const dueAt = getAdminNextActionDueAt(client);
  if (!dueAt) return null;
  const extras = (Array.isArray(client?.workshop?.goalActions) ? client.workshop.goalActions : [])
    .filter((row) => !sanitizeText(row?.doneAt));
  const extra = extras.find((row) => sanitizeText(row?.dueAt) === dueAt);
  if (extra) {
    return {
      name: sanitizeText(extra.name) || 'Handling',
      format: sanitizeText(extra.format),
      dueAt,
      addToCalendar: Boolean(extra.addToCalendar),
    };
  }
  if (!workshopGoalHeld(client)) {
    const action = getWorkshopAction(client);
    if (action && sanitizeText(action.dueAt) === dueAt) {
      return {
        name: sanitizeText(action.name) || 'Workshop',
        format: sanitizeWorkshopFormat(action.format),
        dueAt,
        addToCalendar: Boolean(action.addToCalendar),
      };
    }
  }
  const iteration = client?.workshop?.iterationMeeting;
  if (iteration && sanitizeText(iteration.dueAt) === dueAt) {
    return {
      name: 'Iterasjonsmøte',
      format: sanitizeWorkshopFormat(iteration.format),
      dueAt,
      addToCalendar: Boolean(iteration.addToCalendar),
    };
  }
  return { name: 'Handling', format: '', dueAt, addToCalendar: false };
}

export function isAdminBoardCalendarQuery(query = {}) {
  const raw = sanitizeText(query?.workshopCalendar).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Titled Damian week embed. Uses findConnectedCalendarAccountKeysByGoogleEmail.
 * Never falls back to the viewer's calendar when Damian is not connected.
 */
export function resolveAdminBoardCalendarAccountKey({
  connectedKeys,
  viewerAccountKey = '',
} = {}) {
  const keys = Array.isArray(connectedKeys) ? connectedKeys : [];
  const picked = pickDamianCalendarAccountKey(keys);
  if (!picked && viewerAccountKey) return '';
  return picked;
}

export function adminBoardViewerIsDamianMailbox({
  accountKey = '',
  username = '',
  googleEmail = '',
} = {}) {
  const key = sanitizeText(accountKey).toLowerCase();
  const mail = sanitizeText(username || googleEmail).toLowerCase();
  return key === DAMIAN_CALENDAR_ACCOUNT_KEY.toLowerCase()
    || mail === DAMIAN_WORKSHOP_CALENDAR_EMAIL.toLowerCase();
}
