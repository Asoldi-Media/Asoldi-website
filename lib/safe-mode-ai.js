/**
 * Safe-mode guard for LLM calls (DeepSeek, Anthropic, Gemini).
 *
 * Safe mode off, or HUB_SAFE_MODE_ALLOW contains aiCalls: the real call runs. With
 * HUB_SAFE_MODE_AI_RECORD=1 the response is also saved as a cassette.
 *
 * Otherwise the call never leaves the PC:
 *   - a cassette for the same request (dates, UUIDs and long ids stripped) is replayed;
 *   - else HUB_SAFE_MODE_AI decides: 'stub' (default) returns the caller's deterministic
 *     stub, 'replay' or 'error' throws the caller's "not available" error.
 * Every blocked call is recorded as an `aiCalls` intent.
 *
 * Cassettes: <dataDir>/safe-mode/ai-cassettes/<key>.json, or HUB_SAFE_MODE_AI_CASSETTES.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeModeActive, recordIntent, safeModeAllows, safeModeDataDir, safeModeEnv } from './safe-mode.js';

function clean(value) {
  return String(value ?? '').trim();
}

/** Replace volatile values so the same prompt maps to the same cassette. */
export function normalizeForReplay(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, '<date>')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
      .replace(/\b\d{10,}\b/g, '<n>');
  }
  if (Array.isArray(value)) return value.map(normalizeForReplay);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalizeForReplay(value[key]);
    return out;
  }
  return value;
}

export function aiCassetteKey(provider, request = {}) {
  const body = JSON.stringify({ provider: clean(provider), request: normalizeForReplay(request) });
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}

function cassetteDir() {
  return clean(safeModeEnv().HUB_SAFE_MODE_AI_CASSETTES) || join(safeModeDataDir(), 'safe-mode', 'ai-cassettes');
}

export function readCassette(key) {
  if (!/^[0-9a-f]{32}$/.test(key)) return null;
  const file = join(cassetteDir(), `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && 'response' in parsed ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCassette(key, { provider = '', task = '', response }) {
  if (!/^[0-9a-f]{32}$/.test(key)) return false;
  try {
    mkdirSync(cassetteDir(), { recursive: true });
    writeFileSync(join(cassetteDir(), `${key}.json`), JSON.stringify({ provider, task, recordedAt: new Date().toISOString(), response }, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function aiStubMode() {
  const mode = clean(safeModeEnv().HUB_SAFE_MODE_AI).toLowerCase();
  return ['replay', 'error'].includes(mode) ? mode : 'stub';
}

/**
 * Run or replace one LLM call.
 *   provider: 'deepseek' | 'anthropic' | 'gemini'
 *   request:  the provider payload (used for the cassette key; never logged)
 *   real:     () => Promise<result>
 *   stub:     (key) => result   deterministic stand-in
 *   fail:     () => Error       "AI not available" error in the caller's own type
 */
export async function guardAiCall({ provider, task = '', request = {}, real, stub, fail }) {
  if (!isSafeModeActive()) return real();
  const key = aiCassetteKey(provider, request);
  if (safeModeAllows('aiCalls')) {
    const result = await real();
    if (clean(safeModeEnv().HUB_SAFE_MODE_AI_RECORD) === '1') writeCassette(key, { provider, task, response: result });
    return result;
  }
  const cassette = readCassette(key);
  const mode = cassette ? 'replay' : aiStubMode();
  recordIntent('aiCalls', `${provider}${task ? ` ${task}` : ''} ${mode}${cassette ? '' : mode === 'stub' ? '' : ' miss'} ${key.slice(0, 12)}`);
  if (cassette) return cassette.response;
  if (mode !== 'stub' || typeof stub !== 'function') {
    throw typeof fail === 'function' ? fail() : new Error('AI calls are blocked by hub safe mode.');
  }
  return stub(key);
}

/**
 * For call sites that only check "is a key configured": returns '' while AI calls are
 * blocked (and records the intent), so the code takes its normal "not configured" path.
 */
export function aiKeyOrBlank(provider, apiKey, task = '') {
  const key = clean(apiKey);
  if (!key || !isSafeModeActive() || safeModeAllows('aiCalls')) return key;
  recordIntent('aiCalls', `${provider}${task ? ` ${task}` : ''} blocked`);
  return '';
}
