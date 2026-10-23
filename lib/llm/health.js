/**
 * Provider health for the AI status card. By default it only reports what the hub knows without a
 * network call: whether a key is set and whether the process marked the provider dead (a 401/403).
 * A probe (free GET calls: Anthropic /v1/models, DeepSeek /user/balance, Gemini models.list) runs only
 * when an admin asks for it, is cached for 10 minutes, and is skipped while hub safe mode blocks AI calls.
 * The three probes run side by side and each gives up after 15 seconds, so one provider that does not
 * answer cannot hold the status request.
 */
import { isSafeModeActive, recordIntent, safeModeAllows } from '../safe-mode.js';
import { anthropicKeyFrom, probeClaude } from './providers/claude.js';
import { probeDeepseek } from './providers/deepseek.js';
import { geminiKeyFrom, probeGemini } from './providers/gemini.js';

const PROBE_TTL_MS = 10 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 15_000;

/** Resolves with the probe's result, or with a timeout result after `timeoutMs`. */
function withProbeTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function clean(value) {
  return String(value ?? '').trim();
}

export function providerKeyConfigured(provider, env = process.env) {
  if (provider === 'claude') return Boolean(anthropicKeyFrom(env));
  if (provider === 'deepseek') return Boolean(clean(env.DEEPSEEK_API_KEY));
  if (provider === 'gemini') return Boolean(geminiKeyFrom(env));
  if (provider === 'replay') return true;
  return false;
}

export function createHealth({
  env = process.env,
  probes = { claude: probeClaude, deepseek: probeDeepseek, gemini: probeGemini },
  clock = () => Date.now(),
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const cache = new Map();

  async function probe(provider) {
    const hit = cache.get(provider);
    if (hit && clock() - hit.atMs < PROBE_TTL_MS) return hit.result;
    let result;
    if (!providerKeyConfigured(provider, env)) result = { ok: false, error: 'not-configured' };
    else if (isSafeModeActive() && !safeModeAllows('aiCalls')) {
      recordIntent('aiCalls', `${provider} status probe blocked`);
      result = { ok: false, error: 'safe-mode' };
    } else {
      try {
        result = await withProbeTimeout(probes[provider]({ env, timeoutMs }), timeoutMs);
      } catch (error) {
        result = { ok: false, error: clean(error?.message).slice(0, 200) || 'probe failed' };
      }
    }
    const entry = { atMs: clock(), result: { ...result, checkedAt: new Date(clock()).toISOString() } };
    cache.set(provider, entry);
    return entry.result;
  }

  /** { claude: { configured, dead, probe? }, deepseek: {...}, gemini: {...} } */
  async function providers({ dead = [], runProbe = false } = {}) {
    const names = ['claude', 'deepseek', 'gemini'];
    const probed = runProbe ? await Promise.all(names.map((provider) => probe(provider))) : [];
    const out = {};
    names.forEach((provider, index) => {
      const item = { configured: providerKeyConfigured(provider, env), dead: dead.includes(provider) };
      if (runProbe) item.probe = probed[index];
      else if (cache.has(provider)) item.probe = cache.get(provider).result;
      out[provider] = item;
    });
    return out;
  }

  return Object.freeze({ providers, probe, clear: () => cache.clear() });
}
