function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

const exhaustedUntil = new Map();
const throttledUntil = new Map();

export function listSerpApiKeys(env = process.env) {
  const keys = [];
  const push = (value) => {
    const key = sanitizeText(value);
    if (key && !keys.includes(key)) keys.push(key);
  };
  push(env.SERPAPI_API_KEY);
  push(env.SERP_API_KEY);
  push(env.SERPAPI_API_KEY_2);
  for (const extra of String(env.SERPAPI_API_KEYS || '').split(/[,\n]+/)) push(extra);
  return keys;
}

export function serpApiKeyLabel(key = '') {
  const value = sanitizeText(key);
  if (value.length < 8) return 'short';
  return value.slice(-6);
}

export function serpApiErrorMeansNoCredits(status, payload = {}) {
  const err = `${payload?.error || ''} ${payload?.message || ''}`.toLowerCase();
  if (err.includes('run out of searches') || err.includes('out of searches')) return true;
  if (err.includes('not enough credits') || err.includes("hasn't got enough")) return true;
  if (err.includes('exceeded your searches')) return true;
  return false;
}

export function markSerpApiKeyExhausted(key, ms = 6 * 60 * 60 * 1000) {
  const value = sanitizeText(key);
  if (!value) return;
  exhaustedUntil.set(value, Date.now() + Math.max(60_000, ms));
}

export function markSerpApiKeyThrottled(key, ms = 30_000) {
  const value = sanitizeText(key);
  if (!value) return;
  throttledUntil.set(value, Date.now() + Math.max(5_000, ms));
}

function untilMapReady(map, key) {
  const value = sanitizeText(key);
  const until = Number(map.get(value) || 0);
  if (!until) return false;
  if (Date.now() >= until) {
    map.delete(value);
    return false;
  }
  return true;
}

export function isSerpApiKeyExhausted(key) {
  return untilMapReady(exhaustedUntil, key);
}

export function isSerpApiKeyThrottled(key) {
  return untilMapReady(throttledUntil, key);
}

export function remainingSerpApiCreditKeys(env = process.env) {
  return listSerpApiKeys(env).filter((key) => !isSerpApiKeyExhausted(key));
}

export function usableSerpApiKeys(env = process.env) {
  return remainingSerpApiCreditKeys(env).filter((key) => !isSerpApiKeyThrottled(key));
}

/** Ready keys first, then throttled keys that still have credits. Exhausted keys are omitted. */
export function serpApiKeysInTryOrder(env = process.env) {
  const leftover = remainingSerpApiCreditKeys(env);
  return [
    ...leftover.filter((key) => !isSerpApiKeyThrottled(key)),
    ...leftover.filter((key) => isSerpApiKeyThrottled(key)),
  ];
}

/**
 * Run one logical SerpAPI operation across every remaining key.
 * If the active key is out of searches mid-call, the next key is tried immediately
 * for the same query — Instagram/Facebook/Maps never restart from scratch.
 */
export async function runWithSerpApiFailover(attempt, { env = process.env } = {}) {
  if (typeof attempt !== 'function') {
    return { ok: false, value: undefined, error: null, tried: 0 };
  }
  let lastError = null;
  let tried = 0;
  const seenThisPass = new Set();
  const order = serpApiKeysInTryOrder(env);
  for (const apiKey of order) {
    if (!apiKey || seenThisPass.has(apiKey) || isSerpApiKeyExhausted(apiKey)) continue;
    seenThisPass.add(apiKey);
    tried += 1;
    const outcome = await attempt(apiKey);
    const status = sanitizeText(outcome?.status || '');
    if (status === 'ok') {
      return { ok: true, value: outcome.value, error: null, tried };
    }
    if (status === 'no-credits') {
      markSerpApiKeyExhausted(apiKey);
      continue;
    }
    if (status === 'throttled') {
      markSerpApiKeyThrottled(apiKey, Number(outcome.retryAfterMs) || 30_000);
      continue;
    }
    if (status === 'error') {
      lastError = outcome.error || lastError;
    }
  }
  return { ok: false, value: undefined, error: lastError, tried };
}
