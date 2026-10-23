/**
 * Provider health for the AI status card. By default it only reports what the hub knows without a
 * network call: whether a key is set and whether the process marked the provider dead (a 401/403).
 * A probe (free GET calls: Anthropic /v1/models, DeepSeek /user/balance, Gemini models.list) runs only
 * when an admin asks for it, is cached for 10 minutes, and is skipped while hub safe mode blocks AI calls.
 */
import { isSafeModeActive, recordIntent, safeModeAllows } from '../safe-mode.js';
import { anthropicKeyFrom, probeClaude } from './providers/claude.js';
import { probeDeepseek } from './providers/deepseek.js';
import { geminiKeyFrom, probeGemini } from './providers/gemini.js';

const PROBE_TTL_MS = 10 * 60 * 1000;

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

export function createHealth({ env = process.env, probes = { claude: probeClaude, deepseek: probeDeepseek, gemini: probeGemini }, clock = () => Date.now() } = {}) {
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
        result = await probes[provider]({ env });
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
    const out = {};
    for (const provider of ['claude', 'deepseek', 'gemini']) {
      const item = { configured: providerKeyConfigured(provider, env), dead: dead.includes(provider) };
      if (runProbe) item.probe = await probe(provider);
      else if (cache.has(provider)) item.probe = cache.get(provider).result;
      out[provider] = item;
    }
    return out;
  }

  return Object.freeze({ providers, probe, clear: () => cache.clear() });
}
