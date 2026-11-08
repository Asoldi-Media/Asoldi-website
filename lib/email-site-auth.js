/**
 * Per-site email credential (emailKey) and the provisioning handshake. docs/email-credential.md
 * describes the wire contract for the client CMS.
 *
 * The site key is a public identifier, so it never authenticates an email call. Each site gets its
 * own emailKey: 32 random bytes (base64url) that only the hub and the site's CMS server hold.
 *
 * Provisioning is a pull:
 *  1. The CMS calls POST /api/hub/email/provision-request with x-site-key and its site credential
 *     (x-site-credential, lib/site-credentials.js). For a site with a valid credential and a
 *     pending key, the hub answers { ok: true, keyId, emailKey }; otherwise { ok: true }. A site in
 *     the email rollout without a pending key gets one on such a request: its first key, or, when
 *     it already has one, a new key (a rotation: the current key keeps working until the confirm
 *     and 10 minutes after it), so a CMS that lost its key, or whose owner asks to reconnect,
 *     recovers with its site credential alone. At most 3 credential-valid requests per site and
 *     day count; later ones get { ok: true }.
 *  2. The CMS stores the key as pending and calls POST /api/hub/email/provision/confirm with
 *     x-email-key = the pending key. Only then does the hub commit it; the CMS commits on 200.
 *  3. Rotation (Superadmin) issues a new pending key. The current key keeps working until the
 *     confirm, and for 10 minutes after it.
 * Every CMS → hub email call sends x-email-key. Every hub → CMS call carries
 * x-asoldi-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(emailKey, t + "." + METHOD + " " +
 * path + "\n" + body)>, accepted within ±300 s; path is the request path with its query, so a
 * signature seen on one call opens no other path or query. Hub → CMS calls go only to
 * cmsTarget(site) = https://<site domain>.
 *
 * Keys live in the email secrets (data/email-store.js, secrets/email-secrets.json, mode 0600):
 *   siteKeys[siteId] = { keyId, key, prevKeyId, prevKey, prevValidUntil, pending, seq }
 * Nothing here logs or returns a key, except provisionRequest's answer to a credential-valid CMS.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import {
  patchEmailSecrets,
  patchEmailSite,
  readEmailSettings,
  readEmailSite,
  readEmailSiteKeys,
  withFileLock,
} from '../data/email-store.js';
import { safeModeState } from './runtime-mode.js';
import { enrollProofOrigin } from './site-credentials.js';
import { osloDayKey } from './email-quota.js';

export const EMAIL_KEY_HEADER = 'x-email-key';
export const EMAIL_SIGNATURE_HEADER = 'x-asoldi-signature';
export const EMAIL_KEY_ID_HEADER = 'x-asoldi-key-id';
export const EMAIL_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const PREVIOUS_KEY_GRACE_MS = 10 * 60 * 1000;
export const SIGNATURE_TOLERANCE_SEC = 300;
export const PROVISION_REQUESTS_PER_DAY = 3;
const KEYS_LOCK = 'email-site-keys';

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

/** Constant-time comparison of two key strings (by their digests, so lengths do not matter). */
export function keysMatch(presented, stored) {
  const a = clean(presented, 200);
  const b = clean(stored, 200);
  if (!a || !b) return false;
  return timingSafeEqual(digest(a), digest(b));
}

export function generateEmailKey() {
  return randomBytes(32).toString('base64url');
}

/* ------------------------------------------------------------------ rollout and enablement */

/** True when the hub email platform is switched on (settings.enabled). */
export function emailPlatformEnabled(settings = readEmailSettings()) {
  return settings?.enabled === true;
}

/** True when the rollout lets this site send: mode 'all', or 'allowlist' with the site listed. */
export function siteInRollout(siteId, settings = readEmailSettings()) {
  const id = clean(siteId, 80);
  const rollout = settings?.rollout || {};
  if (!id) return false;
  if (rollout.mode === 'all') return true;
  return rollout.mode === 'allowlist' && Array.isArray(rollout.siteIds) && rollout.siteIds.map(String).includes(id);
}

/* ------------------------------------------------------------------ CMS target */

const ignoredTargetsLogged = new Set();

function loopbackOrigin(value) {
  let url;
  try {
    url = new URL(clean(value, 300));
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!(host === '127.0.0.1' || host === 'localhost' || host === '::1')) return '';
  return `${url.protocol}//${url.host}`;
}

/**
 * Where hub → CMS calls for a site go: https://<site domain> (never the heartbeat adminUrl), or ''
 * when the site has no public domain. Test seam: settings.devCmsTargets[siteId] (a loopback
 * origin) is used only while lib/runtime-mode.js reports safe mode; outside safe mode it is
 * ignored and a line is logged once per site.
 */
export function cmsTarget(site, { settings = null, env = process.env, log = console } = {}) {
  const siteId = clean(site?.id, 80);
  const cfg = settings || readEmailSettings();
  const override = siteId && cfg?.devCmsTargets && typeof cfg.devCmsTargets === 'object' ? cfg.devCmsTargets[siteId] : '';
  if (override) {
    if (safeModeState(env).on) {
      const origin = loopbackOrigin(override);
      if (origin) return origin;
      if (!ignoredTargetsLogged.has(`bad:${siteId}`)) {
        ignoredTargetsLogged.add(`bad:${siteId}`);
        log?.warn?.(`[email-site-auth] devCmsTargets for ${siteId} is not a loopback origin; ignored`);
      }
    } else if (!ignoredTargetsLogged.has(`off:${siteId}`)) {
      ignoredTargetsLogged.add(`off:${siteId}`);
      log?.warn?.(`[email-site-auth] devCmsTargets for ${siteId} ignored: the hub is not in safe mode`);
    }
  }
  return enrollProofOrigin(site?.domain);
}

/* ------------------------------------------------------------------ key records */

function keyRecord(keys, siteId) {
  const rec = keys?.[siteId];
  return rec && typeof rec === 'object' ? rec : {};
}

function previousKeyLive(rec, now) {
  const until = Date.parse(clean(rec.prevValidUntil, 40));
  return Boolean(rec.prevKey) && Number.isFinite(until) && until > now;
}

/**
 * The site whose committed key (or previous key, inside its grace window) matches.
 * Every stored key is compared, so the answer time does not depend on where a match is.
 * Resolves { siteId, keyId, which: 'current'|'previous' } or null.
 */
export function findSiteByEmailKey(presented, { now = Date.now(), keys = null } = {}) {
  const value = clean(presented, 200);
  if (!EMAIL_KEY_RE.test(value)) return null;
  let all;
  try {
    all = keys || readEmailSiteKeys();
  } catch {
    return null;
  }
  let found = null;
  for (const [siteId, raw] of Object.entries(all || {})) {
    const rec = raw && typeof raw === 'object' ? raw : {};
    const current = keysMatch(value, rec.key);
    const previous = keysMatch(value, rec.prevKey) && previousKeyLive(rec, now);
    if (!found && current) found = { siteId, keyId: clean(rec.keyId, 40), which: 'current' };
    else if (!found && previous) found = { siteId, keyId: clean(rec.prevKeyId, 40), which: 'previous' };
  }
  return found;
}

function findSiteByPendingKey(presented, keys) {
  const value = clean(presented, 200);
  if (!EMAIL_KEY_RE.test(value)) return null;
  let found = null;
  for (const [siteId, raw] of Object.entries(keys || {})) {
    const rec = raw && typeof raw === 'object' ? raw : {};
    const pending = rec.pending && typeof rec.pending === 'object' ? rec.pending : null;
    const isPending = keysMatch(value, pending?.key);
    const isCurrent = keysMatch(value, rec.key);
    if (!found && isPending) found = { siteId, which: 'pending' };
    else if (!found && isCurrent) found = { siteId, which: 'current' };
  }
  return found;
}

/**
 * Express middleware for every CMS → hub email route. Needs a valid x-email-key; x-site-key is
 * never enough. When x-site-key is sent too, it must name the same site. Sets req.emailAuth =
 * { siteId, keyId, which, site }. Refusal: 401 { ok:false, code:'unauthorized' }.
 */
export function requireEmailKey({ getSiteById, getSiteByKey = null, now = () => Date.now() } = {}) {
  if (typeof getSiteById !== 'function') throw new Error('requireEmailKey: getSiteById required');
  const guard = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const refuse = () => res.status(401).json({ ok: false, code: 'unauthorized' });
    const match = findSiteByEmailKey(req.get(EMAIL_KEY_HEADER), { now: now() });
    if (!match) return refuse();
    const site = getSiteById(match.siteId);
    if (!site?.id) return refuse();
    const siteKey = clean(req.get('x-site-key'), 200);
    if (siteKey && getSiteByKey) {
      const named = getSiteByKey(siteKey);
      if (!named || String(named.id) !== String(site.id)) return refuse();
    }
    req.emailAuth = { siteId: String(site.id), keyId: match.keyId, which: match.which, site };
    return next();
  };
  guard.requiresEmailKey = true;
  return guard;
}

/**
 * Every route an Express app registered under /api/hub/email/, as { method, path, guarded }:
 * guarded when requireEmailKey's middleware is in its chain. Route tests use it to prove that
 * every CMS-facing email route needs the emailKey (the public ones are listed by the caller).
 */
export function emailRouteGuards(app) {
  const stack = app?._router?.stack || app?.router?.stack || [];
  const out = [];
  for (const layer of stack) {
    const route = layer?.route;
    if (!route || typeof route.path !== 'string' || !route.path.startsWith('/api/hub/email/')) continue;
    const guarded = (route.stack || []).some((entry) => entry?.handle?.requiresEmailKey === true);
    for (const method of Object.keys(route.methods || {}).filter((m) => route.methods[m])) out.push({ method: method.toUpperCase(), path: route.path, guarded });
  }
  return out;
}

/* ------------------------------------------------------------------ issue, provision, confirm, rotate */

/**
 * Issues a new pending key for a site (replacing an unconfirmed one). The committed key is
 * untouched until the CMS confirms the new one. Resolves { keyId }.
 */
export async function issuePending(siteId, { now = Date.now() } = {}) {
  const id = clean(siteId, 80);
  if (!id) throw new Error('issuePending: siteId required');
  return withFileLock(KEYS_LOCK, async () => {
    const rec = keyRecord(readEmailSiteKeys({ strict: true }), id);
    const seq = (Number(rec.seq) || 0) + 1;
    const pending = { keyId: `ek_${seq}`, key: generateEmailKey(), issuedAt: new Date(now).toISOString() };
    await patchEmailSecrets({ siteKeys: { [id]: { seq, pending } } });
    await patchEmailSite(id, { auth: { pendingKeyId: pending.keyId, pendingIssuedAt: pending.issuedAt } });
    return { keyId: pending.keyId };
  });
}

/** Superadmin "rotate": a new pending key; the current one stays valid until the confirm plus 10 min. */
export async function rotateSiteKey(siteId, options = {}) {
  return issuePending(siteId, options);
}

/**
 * The provision-request decision for a site. `credentialState` comes from siteCredentialState().
 * Resolves { emailKey?, keyId?, reason } where only a credential-valid request within the daily
 * limit gets a key: the pending one, or, for a site in the rollout without a pending key, a new
 * one (its first key, or a rotation of the key it has; reason 'rotation').
 */
export async function provisionRequest({ site, credentialState, now = Date.now(), settings = null } = {}) {
  const siteId = clean(site?.id, 80);
  if (!siteId) return { reason: 'unknown-site' };
  if (credentialState !== 'valid') return { reason: 'no-credential' };
  const cfg = settings || readEmailSettings();
  const day = osloDayKey(now);
  const counted = await withFileLock('email-provision-requests', async () => {
    const row = readEmailSite(siteId);
    const counter = row.auth?.provisionRequests && typeof row.auth.provisionRequests === 'object' ? row.auth.provisionRequests : {};
    const used = counter.day === day ? Number(counter.count) || 0 : 0;
    if (used >= PROVISION_REQUESTS_PER_DAY) return false;
    await patchEmailSite(siteId, { auth: { provisionRequests: { day, count: used + 1 }, lastProvisionRequestAt: new Date(now).toISOString() } });
    return true;
  });
  if (!counted) return { reason: 'daily-limit' };
  let rec = keyRecord(readEmailSiteKeys({ strict: true }), siteId);
  let issued = '';
  if (!rec.pending?.key && siteInRollout(siteId, cfg)) {
    issued = rec.key ? 'rotation' : 'first';
    await issuePending(siteId, { now });
    rec = keyRecord(readEmailSiteKeys({ strict: true }), siteId);
  }
  if (rec.pending?.key && rec.pending?.keyId) {
    return { emailKey: String(rec.pending.key), keyId: String(rec.pending.keyId), reason: issued === 'rotation' ? 'rotation' : 'pending' };
  }
  return { reason: 'not-in-rollout' };
}

/**
 * Confirm: the presented x-email-key must be a pending key the hub issued. It becomes the current
 * key; the old current key stays valid for 10 minutes. A repeated confirm with the current key
 * answers ok (the CMS may not have seen the first answer). Anything else: { ok:false }.
 * A value that is not shaped like a key, or that matches no pending or current key on an unlocked
 * read, is refused without taking the key lock, so unknown values never queue behind issue and
 * rotate. A match is checked again under the lock.
 */
export async function confirmProvision(presented, { now = Date.now(), siteId = '' } = {}) {
  if (!EMAIL_KEY_RE.test(clean(presented, 200))) return { ok: false, reason: 'unknown-key' };
  let unlocked = null;
  try {
    unlocked = readEmailSiteKeys();
  } catch {
    unlocked = null;
  }
  if (unlocked && !findSiteByPendingKey(presented, unlocked)) return { ok: false, reason: 'unknown-key' };
  return withFileLock(KEYS_LOCK, async () => {
    let keys;
    try {
      keys = readEmailSiteKeys({ strict: true });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    const match = findSiteByPendingKey(presented, keys);
    if (!match || (siteId && match.siteId !== String(siteId))) return { ok: false, reason: 'unknown-key' };
    const rec = keyRecord(keys, match.siteId);
    if (match.which === 'current') return { ok: true, siteId: match.siteId, keyId: clean(rec.keyId, 40), already: true };
    const at = new Date(now).toISOString();
    const next = {
      keyId: rec.pending.keyId,
      key: rec.pending.key,
      prevKeyId: rec.key ? clean(rec.keyId, 40) : '',
      prevKey: rec.key ? rec.key : '',
      prevValidUntil: rec.key ? new Date(now + PREVIOUS_KEY_GRACE_MS).toISOString() : '',
      pending: null,
    };
    await patchEmailSecrets({ siteKeys: { [match.siteId]: next } });
    const row = readEmailSite(match.siteId);
    await patchEmailSite(match.siteId, {
      auth: {
        keyId: next.keyId,
        confirmedAt: at,
        provisionedAt: row.auth?.provisionedAt || at,
        pendingKeyId: '',
        pendingIssuedAt: '',
      },
    });
    return { ok: true, siteId: match.siteId, keyId: next.keyId, rotated: Boolean(next.prevKey) };
  });
}

/** The committed key of a site, for signing hub → CMS calls. Internal: never returned by a route. */
export function currentEmailKey(siteId) {
  let keys;
  try {
    keys = readEmailSiteKeys();
  } catch {
    return null;
  }
  const rec = keyRecord(keys, clean(siteId, 80));
  return rec.key ? { keyId: clean(rec.keyId, 40), key: String(rec.key) } : null;
}

/** Status for Superadmin and tests: ids and times only. */
export function siteKeyStatus(siteId, { now = Date.now() } = {}) {
  let keys = {};
  try {
    keys = readEmailSiteKeys();
  } catch {
    keys = {};
  }
  const rec = keyRecord(keys, clean(siteId, 80));
  let row = {};
  try {
    row = readEmailSite(siteId);
  } catch {
    row = {};
  }
  return {
    keyId: rec.key ? clean(rec.keyId, 40) : '',
    confirmed: Boolean(rec.key),
    confirmedAt: clean(row.auth?.confirmedAt, 40),
    pendingKeyId: rec.pending?.key ? clean(rec.pending.keyId, 40) : '',
    pendingIssuedAt: rec.pending?.key ? clean(rec.pending.issuedAt, 40) : '',
    previousKeyValidUntil: previousKeyLive(rec, now) ? clean(rec.prevValidUntil, 40) : '',
  };
}

/* ------------------------------------------------------------------ signatures (hub → CMS) */

function hmacHex(key, text) {
  return createHmac('sha256', String(key)).update(text).digest('hex');
}

/**
 * The text a hub → CMS signature covers: t + "." + METHOD + " " + path + "\n" + body, where path is
 * the request path with its query exactly as sent (for a GET the body is empty).
 */
export function emailSignedText(t, { method = 'POST', path = '', body = '' } = {}) {
  return `${t}.${String(method || 'POST').toUpperCase()} ${String(path ?? '')}\n${String(body ?? '')}`;
}

/** The path with its query of a URL as a fetch sends it (the part a signature covers). */
export function signedPathOf(url) {
  const target = new URL(String(url));
  return `${target.pathname}${target.search}`;
}

/**
 * The x-asoldi-signature value for a call: t=<unix seconds>,v1=<hex HMAC-SHA256(key,
 * emailSignedText(t, { method, path, body }))>.
 */
export function signEmailPayload(key, body = '', { now = Date.now(), method = 'POST', path = '' } = {}) {
  if (!key) throw new Error('signEmailPayload: key required');
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${hmacHex(key, emailSignedText(t, { method, path, body }))}`;
}

function parseSignature(header) {
  const out = { t: NaN, v1: [] };
  for (const part of clean(header, 1000).split(',')) {
    const [name, ...rest] = part.split('=');
    const value = rest.join('=').trim();
    if (name.trim() === 't' && /^\d{1,12}$/.test(value)) out.t = Number(value);
    if (name.trim() === 'v1' && /^[a-f0-9]{64}$/.test(value)) out.v1.push(value);
  }
  return out;
}

/**
 * Reference verifier (the CMS side of the contract, used by the hub tests): true when the header
 * signs exactly this method, path and body with `key` and its time is within ±toleranceSec of now.
 */
export function verifyEmailSignature({ header, body = '', method = 'POST', path = '', key, now = Date.now(), toleranceSec = SIGNATURE_TOLERANCE_SEC } = {}) {
  if (!key) return false;
  const parsed = parseSignature(header);
  if (!Number.isFinite(parsed.t) || !parsed.v1.length) return false;
  if (Math.abs(Math.floor(now / 1000) - parsed.t) > toleranceSec) return false;
  const expected = Buffer.from(hmacHex(key, emailSignedText(parsed.t, { method, path, body })), 'utf8');
  return parsed.v1.some((candidate) => {
    const given = Buffer.from(candidate, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * A reference CMS for tests: holds a committed key (and optionally a pending one) and checks hub
 * calls the way a client CMS must. check({ headers, body, method, url | path, now }) → { ok, reason }.
 */
export function createReferenceCmsVerifier({ key = '', pendingKey = '' } = {}) {
  const state = { key, pendingKey, received: [] };
  return {
    state,
    commit() {
      if (state.pendingKey) state.key = state.pendingKey;
      state.pendingKey = '';
    },
    check({ headers = {}, body = '', method = 'POST', url = '', path = '', now = Date.now() } = {}) {
      const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value[0] : value]));
      const header = lower[EMAIL_SIGNATURE_HEADER];
      if (!header) return { ok: false, reason: 'missing-signature' };
      const signedPath = url ? signedPathOf(url) : path;
      if (!verifyEmailSignature({ header, body, method, path: signedPath, key: state.key, now })) return { ok: false, reason: 'bad-signature' };
      state.received.push(String(body));
      return { ok: true, reason: 'ok' };
    },
  };
}

/** The email-route middleware under the name the contract uses: emailAuth({ getSiteById, getSiteByKey }). */
export const emailAuth = requireEmailKey;
