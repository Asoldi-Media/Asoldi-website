/**
 * Hostinger hcdn kills the HTTP/2 connection (Failed to fetch / PROTOCOL_ERROR)
 * once the Cookie header is around 12KB. Tawk and Sourcebuster set Domain=.asoldi.com.
 * Expiring with only Path=/ leaves those cookies in place, so the next Sales
 * fetch never reaches Node.
 */

const DROP_PREFIXES = ['sbjs', 'twk'];
const KEEP_NAMES = new Set(['__stripe_mid', '__stripe_sid']);
const VALUE_BYTE_LIMIT = 200;
const TOTAL_BYTE_LIMIT = 6000;
const TOTAL_BYTE_TARGET = 3500;

function utf8Bytes(value = '') {
  const text = String(value || '');
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(text);
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

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
      valueBytes: utf8Bytes(value),
      pairBytes: utf8Bytes(trimmed),
    });
  }
  return out;
}

export function cookieHeaderBytes(header = '') {
  return utf8Bytes(header);
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

export function cookieDomainsForHost(hostname = '') {
  const host = String(hostname || '').replace(/:\d+$/, '').toLowerCase();
  const out = new Set(['']);
  if (!host || host === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return [...out];
  out.add(host);
  out.add(`.${host}`);
  const parts = host.split('.').filter(Boolean);
  if (parts.length >= 2) {
    const root = parts.slice(-2).join('.');
    out.add(root);
    out.add(`.${root}`);
  }
  return [...out];
}

export function expireCookieLine(name = '') {
  const safe = String(name || '').replace(/[^\w.\-]/g, '');
  if (!safe) return '';
  return `${safe}=; Max-Age=0; Path=/; Secure; SameSite=Lax`;
}

export function expireCookieLines(name = '', hostname = '') {
  const base = expireCookieLine(name);
  if (!base) return [];
  return cookieDomainsForHost(hostname).map((domain) => (
    domain ? `${base}; Domain=${domain}` : base
  ));
}
