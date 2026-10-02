/**
 * Recent HTTP traffic for /api/health. Cookie expiry lives in fat-cookies.js
 * because Hostinger hcdn closes the connection before this process sees a
 * 12KB Cookie header.
 */

export {
  cookieHeaderBytes,
  cookieNamesToDrop,
  expireCookieLine,
  expireCookieLines,
  parseCookiePairs,
} from './fat-cookies.js';

const recent = [];
const RECENT_LIMIT = 80;

export function noteHttpRequest(entry = {}) {
  recent.push({
    at: new Date().toISOString(),
    method: String(entry.method || ''),
    path: String(entry.path || '').slice(0, 180),
    status: Number(entry.status) || 0,
    ms: Number(entry.ms) || 0,
    cookieBytes: Number(entry.cookieBytes) || 0,
    cookies: Array.isArray(entry.cookies) ? entry.cookies.slice(0, 24) : [],
    dropped: Array.isArray(entry.dropped) ? entry.dropped.slice(0, 24) : [],
  });
  if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
}

export function recentHttpRequests() {
  return recent.slice(-30);
}

export function httpRequestSummary() {
  const rows = recentHttpRequests();
  const maxCookieBytes = rows.reduce((max, row) => Math.max(max, row.cookieBytes || 0), 0);
  return { maxCookieBytes, recent: rows };
}
