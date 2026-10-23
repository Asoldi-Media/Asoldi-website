/**
 * One transport for every Fireflies GraphQL call the hub makes: live join, join verification
 * and transcript intake all share one API key and one rate budget.
 *
 * Fireflies reports a rate limit as HTTP 200 with errors[].code 'too_many_requests' (or as
 * HTTP 429) plus a retry-after. Once that happens every caller on the same bucket waits until
 * the retry-after instead of hammering on. Buckets: 'api' (the general per-minute budget) and
 * 'join' (addToLiveMeeting, 3 calls per 20 minutes per user). Lanes: 'live' calls (dispatch and
 * verification) may use the last of the general budget; 'ingest' calls stop while it is nearly
 * spent, so a burst of transcript fetches never delays a bot going into a meeting.
 *
 * The abort timer covers the whole response including the body, so a stalled body cannot hold
 * a loop for minutes.
 */

export const FIREFLIES_GRAPHQL_URL = 'https://api.fireflies.ai/graphql';

/** Requests per minute the ingest lane leaves for live-join and verification calls. */
export const INGEST_RESERVE = 10;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 30 * 60_000;
const BUCKETS = ['api', 'join'];

function emptyBudget() {
  return { limit: null, remaining: null, resetAt: 0, seenAt: 0 };
}

const state = {
  pausedUntil: { api: 0, join: 0 },
  budget: { api: emptyBudget(), join: emptyBudget() },
  lastRateLimitAt: 0,
  lastError: '',
};

export class FirefliesApiError extends Error {
  constructor(message, { code = 'error', status = 0, retryAfterMs = 0, bucket = 'api' } = {}) {
    super(message);
    this.name = 'FirefliesApiError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.bucket = bucket;
  }
}

/** True for an error that only means "try again later" (rate limit, reserve, timeout, network). */
export function isTransientFirefliesError(error) {
  return error instanceof FirefliesApiError && ['rate-limited', 'reserve', 'timeout', 'network'].includes(error.code);
}

function text(value = '') {
  return String(value ?? '').trim();
}

function header(response, name) {
  try {
    const headers = response?.headers;
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Remember the budget Fireflies reported: x-ratelimit-{limit,remaining,reset}-api (or the bare
 * names) for the general API, and the -call_join variants for live joins.
 */
function noteBudget(bucket, response, nowMs) {
  const read = (name) => (bucket === 'join'
    ? header(response, `${name}-call_join`)
    : header(response, `${name}-api`) ?? header(response, name));
  const limit = numberOrNull(read('x-ratelimit-limit'));
  const remaining = numberOrNull(read('x-ratelimit-remaining'));
  const reset = numberOrNull(read('x-ratelimit-reset'));
  if (limit === null && remaining === null && reset === null) return;
  const budget = state.budget[bucket];
  if (limit !== null) budget.limit = limit;
  if (remaining !== null) budget.remaining = remaining;
  // x-ratelimit-reset is seconds until the window resets.
  budget.resetAt = reset !== null ? nowMs + Math.max(0, reset) * 1000 : budget.resetAt;
  budget.seenAt = nowMs;
}

/**
 * Milliseconds to wait, from a Retry-After header (seconds or HTTP date), the GraphQL error's
 * extensions.metadata.retryAfter (epoch ms), or a 'retry after <date>' message. 0 when none parse.
 */
export function parseRetryAfterMs({ headerValue = null, error = null, nowMs = Date.now() } = {}) {
  const raw = text(headerValue);
  if (raw) {
    if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  const meta = error?.extensions?.metadata?.retryAfter ?? error?.extensions?.retryAfter;
  const metaMs = numberOrNull(meta);
  if (metaMs !== null) {
    // Epoch milliseconds in Fireflies' error payload; a small number would be seconds.
    if (metaMs > 1e12) return Math.max(0, metaMs - nowMs);
    if (metaMs > 0) return Math.round(metaMs * 1000);
  }
  const match = text(error?.message).match(/retry after\s+(.+?)\.?$/i);
  if (match) {
    const at = Date.parse(match[1]);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  return 0;
}

function errorMessage(errors = []) {
  return errors.map((item) => text(item?.message)).filter(Boolean).join('; ');
}

function isRateLimitError(item) {
  const code = text(item?.code || item?.extensions?.code).toLowerCase();
  return code === 'too_many_requests' || /too many requests/i.test(text(item?.message));
}

function pauseBucket(bucket, ms, nowMs) {
  const wait = Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, ms || DEFAULT_RETRY_AFTER_MS));
  state.pausedUntil[bucket] = Math.max(state.pausedUntil[bucket], nowMs + wait);
  state.lastRateLimitAt = nowMs;
  return state.pausedUntil[bucket] - nowMs;
}

/** Throws FirefliesApiError('rate-limited' | 'reserve') when a call on this lane/bucket must wait now. */
export function assertFirefliesBudget({ lane = 'ingest', bucket = 'api', nowMs = Date.now() } = {}) {
  const name = BUCKETS.includes(bucket) ? bucket : 'api';
  const paused = state.pausedUntil[name] - nowMs;
  if (paused > 0) {
    throw new FirefliesApiError(`Fireflies rate limit: waiting ${Math.ceil(paused / 1000)} s.`, {
      code: 'rate-limited',
      retryAfterMs: paused,
      bucket: name,
    });
  }
  if (lane !== 'live') {
    // Ingest also respects the general budget reported on the last response, while its window lasts.
    const api = state.budget.api;
    if (api.remaining !== null && api.remaining <= INGEST_RESERVE && api.resetAt > nowMs) {
      throw new FirefliesApiError('Fireflies API budget is nearly spent; leaving it to live joins.', {
        code: 'reserve',
        retryAfterMs: api.resetAt - nowMs,
        bucket: 'api',
      });
    }
  }
}

/**
 * POST one GraphQL request. Resolves to { data, errors, status } (data may be partial when errors
 * is not empty). Throws FirefliesApiError on rate limits, timeouts, network errors, non-2xx
 * responses and bodies that are not JSON.
 */
export async function firefliesGraphql({
  query,
  variables = {},
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  lane = 'ingest',
  bucket = 'api',
} = {}) {
  const key = text(apiKey);
  if (!key) throw new FirefliesApiError('Fireflies API key is not configured.', { code: 'no-api-key' });
  const name = BUCKETS.includes(bucket) ? bucket : 'api';
  assertFirefliesBudget({ lane, bucket: name });

  const controller = new AbortController();
  const waitMs = Math.max(3000, Number(timeoutMs) || 15_000);
  const timer = setTimeout(() => controller.abort(), waitMs);
  let response;
  let payload = null;
  try {
    response = await fetchImpl(FIREFLIES_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    payload = typeof response?.json === 'function'
      ? await response.json().catch((error) => {
        // A body cut off by the timer is a timeout, not a bad answer.
        if (controller.signal.aborted) throw error;
        return null;
      })
      : null;
  } catch (error) {
    const aborted = controller.signal.aborted || error?.name === 'AbortError';
    state.lastError = aborted ? 'timeout' : text(error?.message) || 'network';
    throw new FirefliesApiError(
      aborted ? `Fireflies did not answer within ${Math.round(waitMs / 1000)} s.` : `Fireflies request failed: ${text(error?.message) || 'network error'}`,
      { code: aborted ? 'timeout' : 'network', bucket: name },
    );
  } finally {
    clearTimeout(timer);
  }

  const nowMs = Date.now();
  noteBudget(name, response, nowMs);
  if (name === 'join') noteBudget('api', response, nowMs);
  const status = Number(response?.status) || 0;
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const rateError = errors.find(isRateLimitError);
  if (rateError || status === 429) {
    const waited = pauseBucket(name, parseRetryAfterMs({
      headerValue: header(response, 'retry-after'),
      error: rateError,
      nowMs,
    }), nowMs);
    state.lastError = 'rate-limited';
    throw new FirefliesApiError(errorMessage(errors) || 'Fireflies rate limit reached.', {
      code: 'rate-limited',
      status: status || 429,
      retryAfterMs: waited,
      bucket: name,
    });
  }
  if (!response?.ok) {
    state.lastError = `http ${status}`;
    throw new FirefliesApiError(errorMessage(errors) || `Fireflies GraphQL failed (${status || 'no status'})`, {
      code: text(errors[0]?.code || errors[0]?.extensions?.code) || 'http',
      status,
      bucket: name,
    });
  }
  if (!payload || typeof payload !== 'object') {
    state.lastError = 'bad-response';
    throw new FirefliesApiError('Fireflies answered without JSON.', { code: 'bad-response', status, bucket: name });
  }
  state.lastError = errors.length ? errorMessage(errors) : '';
  return { data: payload.data ?? null, errors, status };
}

export function firefliesGraphqlErrorMessage(errors = []) {
  return errorMessage(Array.isArray(errors) ? errors : []);
}

/** Snapshot for health reporting: pauses and the budget last reported by Fireflies. */
export function firefliesRateLimitStatus(nowMs = Date.now()) {
  return {
    pausedUntil: {
      api: state.pausedUntil.api > nowMs ? new Date(state.pausedUntil.api).toISOString() : '',
      join: state.pausedUntil.join > nowMs ? new Date(state.pausedUntil.join).toISOString() : '',
    },
    api: { ...state.budget.api },
    join: { ...state.budget.join },
    lastRateLimitAt: state.lastRateLimitAt ? new Date(state.lastRateLimitAt).toISOString() : '',
    lastError: state.lastError,
  };
}

export function resetFirefliesGraphqlStateForTests() {
  state.pausedUntil = { api: 0, join: 0 };
  state.budget = { api: emptyBudget(), join: emptyBudget() };
  state.lastRateLimitAt = 0;
  state.lastError = '';
}
