/**
 * Who may call the hub's Maker endpoints (WS0.4, WS8.25). Never open: a request without a valid
 * credential is refused whatever the env holds.
 *
 * verifyMakerRequest(req, { scope }) → { ok, via, hostId?, host?, reason? }
 *   1. x-maker-host-token: a host token from <dataDir>/maker-hosts.json (sha256 match, not
 *      revoked, scope allowed) → via 'host'.
 *   2. x-sales-callback-token / x-maker-callback-token equal to the legacy callback token (env
 *      WEBSITE_MAKER_STATUS_CALLBACK_TOKEN / SALES_MAKER_STATUS_CALLBACK_TOKEN, else
 *      <dataDir>/secrets/maker-callback-token) → via 'legacy'. Runs the hub started hold this
 *      token, and Makers without a host token send it; it keeps working.
 *   3. the same legacy headers carrying a valid host token → via 'host' (a Maker whose callback
 *      token variable holds a host token).
 *   4. only where allowApiKey is set (preview push): x-api-key equal to env WEBSITE_MAKER_API_KEY.
 *   Otherwise { ok: false, reason }: missing | mismatch | unknown-host | revoked | scope.
 *
 * requireMakerHost(scope, opts) is the Express middleware: 401 for a missing or wrong credential,
 * 403 for a valid host token without the scope (or a legacy token where hostOnly is set), 429 for
 * a credential that keeps failing. A host request stamps lastSeenAt (at most every 5 min).
 *
 * Failure limiter (WS8.25): the hub sets no `trust proxy`, so req.ip is the hosting proxy and is
 * useless as a key. Failures are keyed on a hash of the first characters of the presented
 * credential instead, and a credential is checked before the limiter is asked, so a valid
 * credential is never refused because something else keeps failing. More than
 * alertThreshold failures across all keys in the window raises one alert per window.
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
 */
export function createMakerFailureLimiter({
  windowMs = FAILURE_WINDOW_MS,
  perKey = FAILURES_PER_KEY,
  alertThreshold = FAILURE_ALERT_THRESHOLD,
  now = () => Date.now(),
  onAlert = null,
} = {}) {
  const perKeyStamps = new Map();
  let global = [];
  let alertedAt = -Infinity;
  let lastAlertAt = null;

  const prune = (list, t) => list.filter((stamp) => t - stamp < windowMs);

  function sweep(t) {
    if (perKeyStamps.size < 2000) return;
    for (const [key, list] of perKeyStamps) {
      const kept = prune(list, t);
      if (kept.length) perKeyStamps.set(key, kept);
      else perKeyStamps.delete(key);
    }
  }

  return {
    /** Records a failure. Returns { limited, retryAfterSec, alert } for this key. */
    fail(key) {
      const t = now();
      sweep(t);
      const list = [...prune(perKeyStamps.get(key) || [], t), t];
      perKeyStamps.set(key, list);
      global = [...prune(global, t), t];
      let alert = false;
      if (global.length > alertThreshold && t - alertedAt >= windowMs) {
        alertedAt = t;
        lastAlertAt = new Date(t).toISOString();
        alert = true;
        try {
          onAlert?.({ failures: global.length, windowMs, at: lastAlertAt });
        } catch {
          // An alert hook never breaks the request.
        }
      }
      const limited = list.length > perKey;
      const retryAfterSec = limited ? Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) : 0;
      return { limited, retryAfterSec, alert };
    },
    status() {
      const t = now();
      global = prune(global, t);
      return {
        windowMinutes: Math.round(windowMs / 60000),
        failures: global.length,
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

  /** See the file header. Never throws for a bad request; never counts (requireMakerHost does). */
  function verifyMakerRequest(req, { scope = 'callback', allowApiKey = false } = {}) {
    const hostToken = headerValue(req, MAKER_HOST_TOKEN_HEADER);
    const legacy = LEGACY_MAKER_TOKEN_HEADERS.map((name) => headerValue(req, name)).find(Boolean) || '';
    let reason = 'missing';
    let failedHost = null;

    if (hostToken) {
      const result = verifyMakerHostToken(hostToken, { scope, dataDir, now: now() });
      if (result.ok) return acceptHost(result.host);
      reason = worse(reason, result.reason === 'malformed' ? 'mismatch' : result.reason);
      if (result.reason === 'scope') failedHost = result.host;
    }
    if (legacy) {
      if (legacyMatches(legacy)) return { ok: true, via: 'legacy', source: legacyHolder.source };
      if (looksLikeMakerHostToken(legacy)) {
        const result = verifyMakerHostToken(legacy, { scope, dataDir, now: now() });
        if (result.ok) return acceptHost(result.host);
        reason = worse(reason, result.reason);
        if (result.reason === 'scope') failedHost = result.host;
      } else {
        reason = worse(reason, 'mismatch');
      }
    }
    if (allowApiKey) {
      if (apiKeyMatches(req)) return { ok: true, via: 'api-key' };
      if (headerValue(req, 'x-api-key')) reason = worse(reason, 'mismatch');
    }
    return { ok: false, reason, ...(failedHost ? { hostId: failedHost.hostId } : {}) };
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
    return failures.fail(failureKeyFor(presentedCredential(req)));
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
      const reason = result.ok ? 'host-token-required' : result.reason;
      const verdict = noteRejected(req, reason);
      res.setHeader('Cache-Control', 'no-store');
      // A request without any credential always gets a plain 401 (the post-deploy check reads it);
      // only a presented credential that keeps failing is told to back off.
      if (verdict.limited && reason !== 'missing') {
        res.setHeader('Retry-After', String(verdict.retryAfterSec));
        return res.status(429).json({ message: 'Too many refused Maker requests. Try again later.', code: 'maker-auth-limited' });
      }
      if (reason === 'scope') return res.status(403).json({ message: `This Maker host may not use ${scope}.`, code: 'maker-scope' });
      if (reason === 'host-token-required') {
        return res.status(403).json({ message: 'This endpoint needs a Maker host token (x-maker-host-token).', code: 'maker-host-token-required' });
      }
      return res.status(401).json({ message });
    };
  }

  return {
    verifyMakerRequest,
    requireMakerHost,
    status: () => ({
      legacyTokenSource: legacyHolder ? legacyHolder.source : 'none',
      failures: failures.status(),
    }),
    flushCounters: () => persisted.flush(),
  };
}
