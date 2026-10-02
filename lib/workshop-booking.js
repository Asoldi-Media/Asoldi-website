import { isSsuSalesProduct, RECENT_OVERDUE_MS } from './sales-next-actions.js';
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
  getAdminCurrentGoalKey,
  getAdminGoalActions,
  workshopGoalHeld,
  workshopGoalIterated,
} from './workshop-goal-timeline.js';

export {
  DAMIAN_CALENDAR_ACCOUNT_KEY,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  getWorkshopAction,
  pickDamianCalendarAccountKey,
};

export const ADMIN_BOARD_UNBOOKED_BUCKET = 'unbooked';

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
 * Next incomplete Admin action time (workshop, iteration, or an extra SMS/call).
 * Offer start dates and sales next-actions are ignored.
 */
export function getAdminNextActionDueAt(client = {}) {
  if (workshopGoalHeld(client) && workshopGoalIterated(client)) return '';
  const current = getAdminCurrentGoalKey(client);
  const extras = getAdminGoalActions(client, current || 'haWorkshop').map((row) => row?.dueAt);
  if (current === 'iterated') {
    return earliestDueAt([...extras, client?.workshop?.iterationMeeting?.dueAt]);
  }
  return earliestDueAt([...extras, getWorkshopAction(client)?.dueAt]);
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
 * Rank like Sales: upcoming, last-48h overdue, older overdue.
 * Unbooked stays its own bucket. After Ha workshop, iteration/extras own the clock.
 */
export function classifyAdminWorkshopBucket(client = {}, nowMs = Date.now()) {
  if (workshopGoalHeld(client) && workshopGoalIterated(client)) return 'done';
  const action = getWorkshopAction(client);
  if (!workshopGoalHeld(client) && !action) return ADMIN_BOARD_UNBOOKED_BUCKET;
  const ms = parseMs(getAdminNextActionDueAt(client));
  if (ms == null) return 'noTime';
  if (ms >= nowMs) return 'upcoming';
  if (nowMs - ms <= RECENT_OVERDUE_MS) return 'recentPastDue';
  return 'pastDue';
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
  const currentBucket = classifyAdminWorkshopBucket(client, nowMs);
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
    const dueMs = parseMs(getAdminNextActionDueAt(client));
    if (dueMs == null) return false;
    const dueYmd = osloCalendarYmd(dueMs);
    if (when === 'today' && dueYmd !== osloCalendarYmd(nowMs)) return false;
    if (when === 'week') {
      const week = osloWeekYmdRange(nowMs);
      if (dueYmd < week.start || dueYmd > week.end) return false;
    }
    if (when === 'overdue' && currentBucket !== 'recentPastDue' && currentBucket !== 'pastDue') return false;
  }
  return true;
}

export function groupAdminBoardClients(clients = [], nowMs = Date.now()) {
  const unbooked = [];
  const recentPastDue = [];
  const upcoming = [];
  const pastDue = [];
  const noTime = [];
  const done = [];
  for (const client of filterAdminBoardClients(clients)) {
    const bucket = classifyAdminWorkshopBucket(client, nowMs);
    if (bucket === ADMIN_BOARD_UNBOOKED_BUCKET) unbooked.push(client);
    else if (bucket === 'recentPastDue') recentPastDue.push(client);
    else if (bucket === 'upcoming') upcoming.push(client);
    else if (bucket === 'pastDue') pastDue.push(client);
    else if (bucket === 'done') done.push(client);
    else noTime.push(client);
  }
  const byDue = (a, b) => {
    const aMs = parseMs(getAdminNextActionDueAt(a)) || 0;
    const bMs = parseMs(getAdminNextActionDueAt(b)) || 0;
    return aMs - bMs;
  };
  unbooked.sort(compareNames);
  noTime.sort(compareNames);
  done.sort(compareNames);
  recentPastDue.sort(byDue);
  upcoming.sort(byDue);
  pastDue.sort(byDue);
  return { unbooked, recentPastDue, upcoming, pastDue, noTime, done };
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
