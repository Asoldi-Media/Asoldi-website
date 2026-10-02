/**
 * Hostinger's HTTP/2 front (hcdn) answers a document request with a black
 * 400 page once the cookie header is about 12KB, and closes the connection
 * (HTTP/2 ENHANCE_YOUR_CALM) above that. Chrome shows ERR_HTTP2_PROTOCOL_ERROR
 * and 0 bytes. The Node process never sees those requests.
 *
 * Auth tokens live in localStorage, so the fat tracking cookies can be expired.
 */

const DROP_PREFIXES = ['sbjs', 'twk'];
const KEEP_NAMES = new Set(['__stripe_mid', '__stripe_sid']);
const VALUE_BYTE_LIMIT = 200;
const TOTAL_BYTE_LIMIT = 6000;
const TOTAL_BYTE_TARGET = 3500;

export function parseCookiePairs(header = '') {
  const out = [];
  for (const part of String(header || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim();
    const value = eq === -1 ? '' : trimmed.slice(eq + 1);
    if (!name) continue;
    out.push({
      name,
      valueBytes: Buffer.byteLength(value),
      pairBytes: Buffer.byteLength(trimmed),
    });
  }
  return out;
}

export function cookieHeaderBytes(header = '') {
  return Buffer.byteLength(String(header || ''));
}

export function cookieNamesToDrop(header = '') {
  const pairs = parseCookiePairs(header);
  const drop = new Set();
  for (const pair of pairs) {
    const lower = pair.name.toLowerCase();
    if (DROP_PREFIXES.some((prefix) => lower.startsWith(prefix))) drop.add(pair.name);
    else if (!KEEP_NAMES.has(pair.name) && pair.valueBytes > VALUE_BYTE_LIMIT) drop.add(pair.name);
  }
  const total = pairs.reduce((sum, pair) => sum + pair.pairBytes, 0);
  if (total > TOTAL_BYTE_LIMIT) {
    const ordered = [...pairs].sort((a, b) => b.pairBytes - a.pairBytes);
    let size = total;
    for (const pair of ordered) {
      if (size <= TOTAL_BYTE_TARGET) break;
      if (KEEP_NAMES.has(pair.name) || drop.has(pair.name)) {
        if (drop.has(pair.name)) size -= pair.pairBytes;
        continue;
      }
      drop.add(pair.name);
      size -= pair.pairBytes;
    }
  }
  return [...drop];
}

export function expireCookieLine(name = '') {
  const safe = String(name || '').replace(/[^\w.\-]/g, '');
  if (!safe) return '';
  return `${safe}=; Max-Age=0; Path=/; Secure; SameSite=Lax`;
}

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
