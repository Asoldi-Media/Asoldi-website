import { isSsuSalesProduct, RECENT_OVERDUE_MS } from './sales-next-actions.js';
import {
  DAMIAN_CALENDAR_ACCOUNT_KEY,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  getWorkshopAction,
  pickDamianCalendarAccountKey,
} from './workshop-action-shared.js';

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

/**
 * Booking is getWorkshopAction only (top-level workshop action).
 * Offer start dates and sales next-actions are ignored.
 */
export function classifyAdminWorkshopBucket(client = {}, nowMs = Date.now()) {
  const action = getWorkshopAction(client);
  if (!action) return ADMIN_BOARD_UNBOOKED_BUCKET;
  const ms = parseMs(action.dueAt);
  if (ms == null) return 'noTime';
  if (ms >= nowMs) return 'upcoming';
  if (nowMs - ms <= RECENT_OVERDUE_MS) return 'recentPastDue';
  return 'pastDue';
}

export function groupAdminBoardClients(clients = [], nowMs = Date.now()) {
  const unbooked = [];
  const recentPastDue = [];
  const upcoming = [];
  const pastDue = [];
  const noTime = [];
  for (const client of filterAdminBoardClients(clients)) {
    const bucket = classifyAdminWorkshopBucket(client, nowMs);
    if (bucket === ADMIN_BOARD_UNBOOKED_BUCKET) unbooked.push(client);
    else if (bucket === 'recentPastDue') recentPastDue.push(client);
    else if (bucket === 'upcoming') upcoming.push(client);
    else if (bucket === 'pastDue') pastDue.push(client);
    else noTime.push(client);
  }
  const byDue = (a, b) => {
    const aMs = parseMs(getWorkshopAction(a)?.dueAt) || 0;
    const bMs = parseMs(getWorkshopAction(b)?.dueAt) || 0;
    return aMs - bMs;
  };
  unbooked.sort(compareNames);
  noTime.sort(compareNames);
  recentPastDue.sort(byDue);
  upcoming.sort(byDue);
  pastDue.sort(byDue);
  return { unbooked, recentPastDue, upcoming, pastDue, noTime };
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
