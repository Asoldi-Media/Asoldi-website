/**
 * URLs this hub hands to the Website Maker while safe mode is on (and prodPublish is not
 * allowed): the preview push target and the status callback.
 *
 * The Maker pushes zips and posts status to whatever URL it is given, and on a 401/404 it
 * logs in to that origin with PROD_ADMIN_PASSWORD. A local hub with the live .env has
 * APP_URL=https://asoldi.com, so these URLs must never be built from APP_URL or from an
 * env value that points off this machine or LAN.
 *
 * Order: an explicit full URL env (only when its host is local), then
 * HUB_PUBLIC_URL_FOR_MAKER (only when local), then http://host.docker.internal:<PORT>.
 * The Maker usually runs in Docker, where 127.0.0.1 is the container itself, so
 * host.docker.internal is the default. Never returns ''.
 */
import { isLoopbackHost, isPrivateLanHost, normalizeHost } from './safe-mode-egress.js';

export const MAKER_PREVIEW_PUSH_PATH = '/api/admin/sales/maker-preview-push';
export const MAKER_STATUS_CALLBACK_PATH = '/api/admin/sales/maker-status-callback';

function clean(value) {
  return String(value ?? '').trim();
}

/** Loopback, host.docker.internal, private LAN ranges and .local/.lan/.internal names. */
export function isLocalHubHost(host = '') {
  const value = normalizeHost(host);
  if (!value) return false;
  return isLoopbackHost(value) || isPrivateLanHost(value);
}

/** The URL (no trailing slash) when it is http(s) on a local host, else ''. */
export function localHttpUrl(raw = '') {
  const text = clean(raw);
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!isLocalHubHost(url.hostname)) return '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** Base URL the Maker can reach this hub on. */
export function safeModeHubBaseForMaker(env = process.env) {
  const configured = localHttpUrl(env?.HUB_PUBLIC_URL_FOR_MAKER);
  if (configured) return configured;
  const port = Number.parseInt(clean(env?.PORT), 10);
  return `http://host.docker.internal:${Number.isFinite(port) && port > 0 ? port : 3000}`;
}

export function safeModeMakerPreviewPushUrl(env = process.env) {
  return localHttpUrl(env?.SALES_PREVIEW_PUSH_URL) || `${safeModeHubBaseForMaker(env)}${MAKER_PREVIEW_PUSH_PATH}`;
}

export function safeModeMakerCallbackUrl(env = process.env) {
  return localHttpUrl(env?.WEBSITE_MAKER_STATUS_CALLBACK_URL || env?.SALES_MAKER_STATUS_CALLBACK_URL)
    || `${safeModeHubBaseForMaker(env)}${MAKER_STATUS_CALLBACK_PATH}`;
}

/** Every http(s) URL in a JSON-able value whose host is not local (for tests and the soak). */
export function nonLocalUrlsIn(value) {
  const found = [];
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    try {
      if (!isLocalHubHost(new URL(match[0]).hostname)) found.push(match[0]);
    } catch {
      found.push(match[0]);
    }
  }
  return found;
}
