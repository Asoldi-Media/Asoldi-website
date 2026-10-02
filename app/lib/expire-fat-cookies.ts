import { cookieNamesToDrop, expireCookieLines } from '../../lib/fat-cookies.js';

export function expireFatCookies() {
  if (typeof document === 'undefined') return 0;
  const names = cookieNamesToDrop(document.cookie || '');
  const host = typeof location !== 'undefined' ? location.hostname : '';
  for (const name of names) {
    for (const line of expireCookieLines(name, host)) {
      document.cookie = line;
      document.cookie = line.replace('; Secure; SameSite=Lax', '');
    }
  }
  return names.length;
}

if (typeof document !== 'undefined') expireFatCookies();
