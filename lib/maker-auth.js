/**
 * Who may call the hub's Maker endpoints (WS0.4, WS8.25). Never open: a request without a valid
 * credential is refused whatever the env holds.
 *
 * verifyMakerRequest(req, { scope }) → { ok, via, hostId?, host?, reason? }
 *   1. a host token from <dataDir>/maker-hosts.json (sha256 match, not revoked, scope allowed),
 *      in x-maker-host-token or in the legacy headers (a Maker whose callback token variable
 *      holds a host token) → via 'host'. A known host whose token is revoked or lacks the scope
 *      is refused right here, whatever else the request carries: the legacy token and the API
 *      key below never stand in for it.
 *   2. x-sales-callback-token / x-maker-callback-token equal to the legacy callback token (env
 *      WEBSITE_MAKER_STATUS_CALLBACK_TOKEN / SALES_MAKER_STATUS_CALLBACK_TOKEN, else
 *      <dataDir>/secrets/maker-callback-token) → via 'legacy'. Runs the hub started hold this
 *      token, and Makers without a host token send it; it keeps working.
 *   3. only where allowApiKey is set (preview push): x-api-key equal to env WEBSITE_MAKER_API_KEY.
 *   Otherwise { ok: false, reason }: missing | mismatch | unknown-host | revoked | scope.
 *
 * requireMakerHost(scope, opts) is the Express middleware: 401 for a missing or wrong credential,
 * 403 for a valid host token without the scope (or a legacy token where hostOnly is set), 429 for
 * a host token that keeps failing. A host request stamps lastSeenAt (at most every 5 min).
 * checkMakerRequest(req, opts) is the same check as a yes/no for callers that answer themselves.
 *
 * Failure limiter (WS8.25): the hub sets no `trust proxy`, so req.ip is the hosting proxy and is
 * useless as a key. A failing host token is keyed on a hash of its first characters instead, and
 * a credential is checked before the limiter is asked, so a valid credential is never refused
 * because something else keeps failing. Only a host token that keeps failing gets 429; a legacy
 * token or API key keeps getting 401 (the Maker's fallbacks act on 401) and keeps no per-key
 * state. More than alertThreshold failures across all requests in the window raises one alert
 * per window. The limiter's work per request and its memory are bounded (see
 * createMakerFailureLimiter), because anyone can send refused requests.
 *
 * hostScopeAllows(req, res, scope) is for a route behind requireMakerHost whose request does more
 * than the route's own scope covers (a client bundle sent through the status callback): a host
 * token must also hold that scope; the legacy token and the API key are not scoped.
 *
 * Counters: in memory under the existing names (maker-callback-rejected, -missing-token), and
 * persisted in security-settings.json counters.makerRejected (batched, at most one write per
 * flushMs). Never the token.
 */
import { createHash } from 'crypto';
import { checkWithFreshSecret, safeEqual } from './auth-hardening.js';
import { noteSecurityEvent } from './security-counters.js';
import { addSecurityCounters } from '../data/security-settings.js';
import { looksLikeMakerHostToken, touchMakerHostLastSeen, verifyMakerHostToken } from '../data/maker-hosts.js';

export const MAKER_HOST_TOKEN_HEADER = 'x-maker-host-token';
export const LEGACY_MAKER_TOKEN_HEADERS = Object.freeze(['x-sales-callback-token', 'x-maker-callback-token']);
export const MAKER_API_KEY_ENV = Object.freeze(['WEBSITE_MAKER_API_KEY', 'WEBSITEMAKER_API_KEY']);
export const FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const FAILURES_PER_KEY = 20;
export const FAILURE_ALERT_THRESHOLD = 30;
export const COUNTER_FLUSH_MS = 30 * 1000;

const KEY_PREFIX_CHARS = 16;

function headerValue(req, name) {
  const raw = req?.headers?.[name];
  return String(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '').trim();
}

/** A non-reversible key for the limiter: a hash of the credential's first characters, or 'none'. */
export function failureKeyFor(credential) {
  const value = String(credential || '').trim();
  if (!value) return 'none';
  return createHash('sha256').update(value.slice(0, KEY_PREFIX_CHARS), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Failure counts per key in a sliding window, plus a global count for the alert.
 * Pure in-memory; restarts clear it.
 *
 * Anyone can make a request fail, so every call does a fixed amount of work and the memory is
 * capped, however many distinct keys arrive:
 * - a key keeps at most perKey + 1 stamps (enough to tell "more than perKey in the window");
 * - at most maxKeys keys are kept; a new key past the cap drops the key that failed longest ago
 *   (keys are re-inserted on every failure, so the Map's first key is the oldest);
 * - the global count lives in `buckets` fixed slices of the window. It counts the current slice
 *   and the ones before it that still lie inside the window, so it never counts more than the
 *   failures of the last windowMs.
 * fail(null) counts toward the global alert only (no per-key state at all).
 */
export const FAILURE_LIMITER_MAX_KEYS = 2000;
const FAILURE_BUCKETS = 10;

export function createMakerFailureLimiter({
  windowMs = FAILURE_WINDOW_MS,
  perKey = FAILURES_PER_KEY,
  alertThreshold = FAILURE_ALERT_THRESHOLD,
  maxKeys = FAILURE_LIMITER_MAX_KEYS,
  buckets = FAILURE_BUCKETS,
  now = () => Date.now(),
  onAlert = null,
} = {}) {
  const perKeyStamps = new Map();
  const sliceMs = Math.max(1, Math.ceil(windowMs / buckets));
  const sliceIds = new Array(buckets).fill(-Infinity);
  const sliceCounts = new Array(buckets).fill(0);
  let alertedAt = -Infinity;
  let lastAlertAt = null;

  function globalCount(t) {
    const current = Math.floor(t / sliceMs);
    let total = 0;
    for (let i = 0; i < buckets; i += 1) {
      const age = current - sliceIds[i];
      if (age >= 0 && age < buckets) total += sliceCounts[i];
    }
    return total;
  }

  function countGlobal(t) {
    const id = Math.floor(t / sliceMs);
    const slot = ((id % buckets) + buckets) % buckets;
    if (sliceIds[slot] !== id) {
      sliceIds[slot] = id;
      sliceCounts[slot] = 0;
    }
    sliceCounts[slot] += 1;
  }

  function countKey(key, t) {
    let list = perKeyStamps.get(key);
    if (list) {
      perKeyStamps.delete(key);
    } else {
      list = [];
      if (perKeyStamps.size >= maxKeys) perKeyStamps.delete(perKeyStamps.keys().next().value);
    }
    while (list.length && t - list[0] >= windowMs) list.shift();
    list.push(t);
    if (list.length > perKey + 1) list.shift();
    perKeyStamps.set(key, list);
    return list;
  }

  return {
    /** Records a failure. Returns { limited, retryAfterSec, alert } for this key (null: global only). */
    fail(key) {
      const t = now();
      countGlobal(t);
      const list = key ? countKey(key, t) : null;
      let alert = false;
      const failures = globalCount(t);
      if (failures > alertThreshold && t - alertedAt >= windowMs) {
        alertedAt = t;
        lastAlertAt = new Date(t).toISOString();
        alert = true;
        try {
          onAlert?.({ failures, windowMs, at: lastAlertAt });
        } catch {
          // An alert hook never breaks the request.
        }
      }
      const limited = Boolean(list) && list.length > perKey;
      const retryAfterSec = limited ? Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) : 0;
      return { limited, retryAfterSec, alert };
    },
    /** How many keys hold per-key state (never more than maxKeys). */
    trackedKeys: () => perKeyStamps.size,
    status() {
      const t = now();
      return {
        windowMinutes: Math.round(windowMs / 60000),
        failures: globalCount(t),
        alertThreshold,
        alertActive: t - alertedAt < windowMs,
        lastAlertAt,
      };
    },
  };
}

/**
 * Batches persisted counter deltas and writes them at most once per flushMs (plus a timer that
 * flushes the rest). A failed write keeps the delta for the next try.
 */
export function createPersistedMakerCounters({
  dataDir,
  flushMs = COUNTER_FLUSH_MS,
  now = () => Date.now(),
  write = addSecurityCounters,
} = {}) {
  let pending = {};
  let lastFlushAt = -Infinity;
  let timer = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!Object.keys(pending).length) return false;
    const deltas = pending;
    pending = {};
    lastFlushAt = now();
    try {
      write(deltas, { dataDir });
      return true;
    } catch (error) {
      console.error(`[maker-auth] could not save Maker request counters: ${error?.code || error?.message || 'error'}`);
      for (const [name, delta] of Object.entries(deltas)) add(name, delta, { schedule: false });
      return false;
    }
  }

  function add(name, delta, { schedule = true } = {}) {
    const row = pending[name] || { total: 0, byReason: {}, lastAt: null };
    row.total += delta.total || 0;
    for (const [reason, n] of Object.entries(delta.byReason || {})) row.byReason[reason] = (row.byReason[reason] || 0) + n;
    if (delta.lastAt && (!row.lastAt || delta.lastAt > row.lastAt)) row.lastAt = delta.lastAt;
    pending[name] = row;
    if (!schedule) return;
    const t = now();
    if (t - lastFlushAt >= flushMs) {
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, Math.max(10, lastFlushAt + flushMs - t));
      timer.unref?.();
    }
  }

  return {
    rejected(reason) {
      add('makerRejected', { total: 1, byReason: { [reason]: 1 }, lastAt: new Date(now()).toISOString() });
    },
    alert() {
      add('makerFailureAlerts', { total: 1, byReason: {}, lastAt: new Date(now()).toISOString() });
    },
    flush,
    pending: () => JSON.parse(JSON.stringify(pending)),
  };
}

/**
 * deps:
 *   legacyHolder – createHubSecretHolder() of the legacy callback token (env or disk); null = none
 *   dataDir      – the hub data dir (maker-hosts.json, security-settings.json)
 *   env          – for WEBSITE_MAKER_API_KEY (preview push only)
 */
export function createMakerAuth({
  legacyHolder = null,
  dataDir,
  env = process.env,
  now = () => Date.now(),
  limiter = null,
  counters = null,
  onAlert = null,
} = {}) {
  const persisted = counters || createPersistedMakerCounters({ dataDir, now });
  const failures =
    limiter ||
    createMakerFailureLimiter({
      now,
      onAlert: (info) => {
        noteSecurityEvent('maker-auth-failure-alert');
        persisted.alert();
        console.warn(`[maker-auth] ${info.failures} refused Maker requests in ${Math.round(info.windowMs / 60000)} min`);
        try {
          onAlert?.(info);
        } catch {
          // best effort
        }
      },
    });

  function legacyMatches(token) {
    if (!legacyHolder || !token) return false;
    // A token rotated in another hub process is accepted at once (one re-read of the file).
    return checkWithFreshSecret(legacyHolder, (current) => safeEqual(token, current));
  }

  function apiKeyMatches(req) {
    const configured = MAKER_API_KEY_ENV.map((name) => String(env?.[name] ?? '').trim()).find(Boolean) || '';
    const provided = headerValue(req, 'x-api-key');
    return Boolean(configured && provided) && safeEqual(provided, configured);
  }

  function acceptHost(host) {
    touchMakerHostLastSeen(host.hostId, { dataDir, now: now(), host });
    return { ok: true, via: 'host', hostId: host.hostId, host };
  }

  // Most specific failure wins when several credentials were sent.
  const REASON_RANK = ['missing', 'malformed', 'mismatch', 'unknown-host', 'revoked', 'scope'];
  const worse = (a, b) => (REASON_RANK.indexOf(b) > REASON_RANK.indexOf(a) ? b : a);
  // A known host's own token that is revoked or lacks the scope settles the request: no other
  // credential sent with it (the legacy run token every hub-started run carries, the API key)
  // may stand in for it, or revoking a host and narrowing its scopes would change nothing for a
  // Maker that sends both. An unknown host id or a wrong secret is not final, so a Maker still
  // works through the legacy token when maker-hosts.json was lost or restored from a backup.
  const FINAL_HOST_REASONS = new Set(['revoked', 'scope']);

  /** See the file header. Never throws for a bad request; never counts (requireMakerHost does). */
  function verifyMakerRequest(req, { scope = 'callback', allowApiKey = false } = {}) {
    const hostToken = headerValue(req, MAKER_HOST_TOKEN_HEADER);
    const legacy = LEGACY_MAKER_TOKEN_HEADERS.map((name) => headerValue(req, name)).find(Boolean) || '';
    let reason = 'missing';

    // 1. Host tokens first: the dedicated header, then a host token in the legacy header.
    const hostCandidates = [hostToken, looksLikeMakerHostToken(legacy) ? legacy : ''].filter(Boolean);
    for (const candidate of new Set(hostCandidates)) {
      const result = verifyMakerHostToken(candidate, { scope, dataDir, now: now() });
      if (result.ok) return acceptHost(result.host);
      if (FINAL_HOST_REASONS.has(result.reason)) return { ok: false, reason: result.reason, hostId: result.hostId };
      reason = worse(reason, result.reason === 'malformed' ? 'mismatch' : result.reason);
    }
    // 2. The legacy token (env or disk).
    if (legacy) {
      if (legacyMatches(legacy)) return { ok: true, via: 'legacy', source: legacyHolder.source };
      if (!looksLikeMakerHostToken(legacy)) reason = worse(reason, 'mismatch');
    }
    // 3. Preview push only: the Maker API key (env).
    if (allowApiKey) {
      if (apiKeyMatches(req)) return { ok: true, via: 'api-key' };
      if (headerValue(req, 'x-api-key')) reason = worse(reason, 'mismatch');
    }
    return { ok: false, reason };
  }

  function presentedCredential(req) {
    return (
      headerValue(req, MAKER_HOST_TOKEN_HEADER) ||
      LEGACY_MAKER_TOKEN_HEADERS.map((name) => headerValue(req, name)).find(Boolean) ||
      headerValue(req, 'x-api-key')
    );
  }

  /** Counts a refused request (memory + persisted). Returns the limiter verdict. */
  function noteRejected(req, reason) {
    noteSecurityEvent(reason === 'missing' ? 'maker-callback-missing-token' : 'maker-callback-rejected');
    persisted.rejected(reason);
    const credential = presentedCredential(req);
    // Only a host token is told to back off, so only a host token gets per-key state. A stale
    // legacy run token (every run created before a token rotation keeps sending it) or a wrong API
    // key keeps getting a plain 401, which is what the Maker's own fallbacks act on; a request
    // without any credential always gets 401 too (the post-deploy check reads it). All of them
    // still count toward the global alert.
    const hostShaped = looksLikeMakerHostToken(credential);
    const verdict = failures.fail(hostShaped ? failureKeyFor(credential) : null);
    return { ...verdict, limited: verdict.limited && hostShaped };
  }

  /**
   * verifyMakerRequest plus the refusal counters, for callers that answer the refusal themselves
   * (a yes/no check). Same rules as requireMakerHost; a host request stamps lastSeenAt.
   */
  function checkMakerRequest(req, { scope = 'callback', allowApiKey = false, count = true } = {}) {
    const result = verifyMakerRequest(req, { scope, allowApiKey });
    if (!result.ok && count) noteRejected(req, result.reason);
    return result;
  }

  /**
   * Express middleware. opts: { message, allowApiKey, hostOnly }. On success req.makerAuth is the
   * verify result (via, hostId, host).
   */
  function requireMakerHost(scope, { message = 'Unauthorized callback.', allowApiKey = false, hostOnly = false } = {}) {
    return (req, res, next) => {
      const result = verifyMakerRequest(req, { scope, allowApiKey });
      if (result.ok && (!hostOnly || result.via === 'host')) {
        req.makerAuth = result;
        return next();
      }
      return refuse(req, res, result.ok ? 'host-token-required' : result.reason, { scope, message });
    };
  }

  /** Counts a refusal and answers it: 429, 403 (scope, host token required) or 401. */
  function refuse(req, res, reason, { scope, message = 'Unauthorized callback.' }) {
    const verdict = noteRejected(req, reason);
    res.setHeader('Cache-Control', 'no-store');
    if (verdict.limited) {
      res.setHeader('Retry-After', String(verdict.retryAfterSec));
      return res.status(429).json({ message: 'Too many refused Maker requests. Try again later.', code: 'maker-auth-limited' });
    }
    if (reason === 'scope') return res.status(403).json({ message: `This Maker host may not use ${scope}.`, code: 'maker-scope' });
    if (reason === 'host-token-required') {
      return res.status(403).json({ message: 'This endpoint needs a Maker host token (x-maker-host-token).', code: 'maker-host-token-required' });
    }
    return res.status(401).json({ message });
  }

  /**
   * For a route that already passed requireMakerHost: true when this request may also use
   * `scope`. A host token needs that scope as well (403 maker-scope otherwise, counted like any
   * scope refusal); the legacy token and the API key carry no scopes. Without req.makerAuth the
   * request is refused with 401 (fail closed). On false the answer has been sent.
   */
  function hostScopeAllows(req, res, scope) {
    const auth = req?.makerAuth;
    if (auth?.ok && auth.via !== 'host') return true;
    if (auth?.ok && Array.isArray(auth.host?.scopes) && auth.host.scopes.includes(scope)) return true;
    refuse(req, res, auth?.ok ? 'scope' : 'missing', { scope });
    return false;
  }

  return {
    verifyMakerRequest,
    checkMakerRequest,
    requireMakerHost,
    hostScopeAllows,
    status: () => ({
      legacyTokenSource: legacyHolder ? legacyHolder.source : 'none',
      failures: failures.status(),
    }),
    flushCounters: () => persisted.flush(),
  };
}
