/**
 * Hub → client CMS calls for email: hints (POST /api/cms/email/hub-event) and signed pulls (GET).
 *
 * Every call is signed with the site's committed emailKey (lib/email-site-auth.js):
 *   x-asoldi-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(emailKey, t + "." + body)>
 *   x-asoldi-key-id:    the key id, so a CMS in the middle of a rotation knows which key to try
 * and goes only to cmsTarget(site) (https://<site domain>; never the heartbeat adminUrl).
 * Redirects are not followed. 10 s timeout. A site without a committed key or a public domain is
 * skipped. In safe mode the egress guard decides as for any other outbound call.
 */
import { EMAIL_KEY_ID_HEADER, EMAIL_SIGNATURE_HEADER, cmsTarget, currentEmailKey, signEmailPayload } from './email-site-auth.js';

export const HUB_EVENT_PATH = '/api/cms/email/hub-event';
export const CMS_SUPPRESSIONS_PATH = '/api/cms/email/suppressions';
export const HINT_TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 5 * 1024 * 1024;

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

/** The signature header value for a hint body, signed with the site's emailKey. */
export function signCmsHint(key, body, { now = Date.now() } = {}) {
  return signEmailPayload(key, body, { now });
}

function target(site, options) {
  const origin = cmsTarget(site, options);
  return origin || '';
}

/**
 * POST a hint ({ type, siteId, at, ...payload }) to the site's CMS. Resolves
 * { ok, status } or { ok:false, reason } and never throws: callers fire and forget.
 */
export async function postCmsHint(site, type, payload = {}, { fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now(), settings = null, env = process.env, log = console, timeoutMs = HINT_TIMEOUT_MS } = {}) {
  const siteId = clean(site?.id, 80);
  const kind = clean(type, 60);
  if (!siteId || !kind) return { ok: false, reason: 'bad-input' };
  const key = currentEmailKey(siteId);
  if (!key) return { ok: false, reason: 'no-key' };
  const origin = target(site, { settings, env, log });
  if (!origin) return { ok: false, reason: 'no-target' };
  const body = JSON.stringify({ ...(payload && typeof payload === 'object' ? payload : {}), type: kind, siteId, at: new Date(now).toISOString() });
  try {
    const response = await fetchImpl(`${origin}${HUB_EVENT_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        [EMAIL_SIGNATURE_HEADER]: signCmsHint(key.key, body, { now }),
        [EMAIL_KEY_ID_HEADER]: key.keyId,
        'user-agent': 'asoldi-hub-email/1',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel?.().catch?.(() => {});
    return { ok: response.status >= 200 && response.status < 300, status: response.status };
  } catch (error) {
    return { ok: false, reason: error?.safeMode ? 'safe-mode' : 'unreachable' };
  }
}

/**
 * Signed GET from the site's CMS (the signature covers an empty body). Resolves the parsed JSON,
 * or throws an Error with code 'cms_unreachable' | 'cms_refused' | 'cms_unreadable' | 'no_key' | 'no_target'.
 */
export async function getFromCms(site, path, { fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now(), settings = null, env = process.env, log = console, timeoutMs = HINT_TIMEOUT_MS } = {}) {
  const fail = (code) => Object.assign(new Error(`CMS pull failed: ${code}`), { code });
  const siteId = clean(site?.id, 80);
  const key = currentEmailKey(siteId);
  if (!key) throw fail('no_key');
  const origin = target(site, { settings, env, log });
  if (!origin) throw fail('no_target');
  if (!String(path).startsWith('/api/cms/email/')) throw fail('bad_path');
  let response;
  try {
    response = await fetchImpl(`${origin}${path}`, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        [EMAIL_SIGNATURE_HEADER]: signCmsHint(key.key, '', { now }),
        [EMAIL_KEY_ID_HEADER]: key.keyId,
        'user-agent': 'asoldi-hub-email/1',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw fail('cms_unreachable');
  }
  if (response.status !== 200) {
    await response.body?.cancel?.().catch?.(() => {});
    throw fail('cms_refused');
  }
  const text = await response.text();
  if (text.length > MAX_ANSWER_BYTES) throw fail('cms_unreadable');
  try {
    return JSON.parse(text);
  } catch {
    throw fail('cms_unreadable');
  }
}
