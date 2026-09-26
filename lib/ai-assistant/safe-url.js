import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.',
  '0.0.0.0',
  '::1',
  'metadata.google.internal',
]);

export function isPrivateIp(ip = '') {
  const value = String(ip || '').trim().toLowerCase();
  if (!value) return false;
  if (value === '::1' || value === '0.0.0.0') return true;
  if (value.startsWith('127.')) return true;
  if (value.startsWith('10.')) return true;
  if (value.startsWith('192.168.')) return true;
  if (value.startsWith('169.254.')) return true;
  const parts = value.split('.').map((part) => Number(part));
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
  return false;
}

export function parsePublicHttpUrl(raw = '', { allowHttp = false } = {}) {
  const text = String(raw || '').trim();
  if (!text) throw Object.assign(new Error('Mangler URL.'), { status: 400, code: 'missing-url' });
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw Object.assign(new Error('Ugyldig URL.'), { status: 400, code: 'invalid-url' });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('URL med innlogging er ikke tillatt.'), { status: 400, code: 'auth-url' });
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && !(allowHttp && protocol === 'http:')) {
    throw Object.assign(new Error('Bare https-adresser er tillatt.'), { status: 400, code: 'protocol' });
  }
  const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw Object.assign(new Error('Denne adressen kan ikke hentes.'), { status: 400, code: 'blocked-host' });
  }
  if (isIP(host) && isPrivateIp(host)) {
    throw Object.assign(new Error('Interne adresser er blokkert.'), { status: 400, code: 'private-ip' });
  }
  return parsed;
}

export async function assertPublicHttpUrl(raw, options = {}) {
  const parsed = parsePublicHttpUrl(raw, options);
  const host = parsed.hostname.replace(/\.$/, '');
  if (isIP(host)) return parsed;
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if ((records || []).some((row) => isPrivateIp(row.address))) {
      throw Object.assign(new Error('Interne adresser er blokkert.'), { status: 400, code: 'private-dns' });
    }
  } catch (error) {
    if (error?.code === 'private-dns') throw error;
    // DNS failure is handled later by fetch.
  }
  return parsed;
}

export function sameOrigin(url, base) {
  try {
    const a = typeof url === 'string' ? new URL(url) : url;
    const b = typeof base === 'string' ? new URL(base) : base;
    return a.origin === b.origin;
  } catch {
    return false;
  }
}
