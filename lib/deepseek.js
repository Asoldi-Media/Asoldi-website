/**
 * Minimal DeepSeek chat client (OpenAI-compatible API). Used for all AI work in the offer flow:
 *  - filling the offer email nuances from a Fireflies transcript
 *  - summarizing an edited offer email into the contract scope
 *
 * Env: DEEPSEEK_API_KEY (required), DEEPSEEK_MODEL (default deepseek-chat).
 */

import { runAiCall } from './safe-mode-hooks.js';

const API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 90_000;

function text(value = '') {
  return String(value ?? '').trim();
}

export function readDeepseekConfig(env = process.env) {
  return {
    apiKey: text(env.DEEPSEEK_API_KEY),
    model: text(env.DEEPSEEK_MODEL) || DEFAULT_MODEL,
  };
}

export function isDeepseekConfigured(config = readDeepseekConfig()) {
  return Boolean(config.apiKey);
}

export class DeepseekError extends Error {
  constructor(message, { status = 0, code = 'deepseek-error' } = {}) {
    super(message);
    this.name = 'DeepseekError';
    this.status = status;
    this.code = code;
  }
}

/** Pull the first JSON object out of a model reply (handles ```json fences and leading prose). */
export function extractJsonObject(raw = '') {
  const source = String(raw || '').trim();
  if (!source) return null;
  const unfenced = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    // fall through
  }
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Ask for a JSON object. `system` should describe the exact shape; we also pass response_format json_object.
 * Returns the parsed object. Throws DeepseekError on config / network / parse problems.
 */
export async function deepseekChatJson({
  system = '',
  user = '',
  temperature = 0.4,
  maxTokens = 2000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  config = readDeepseekConfig(),
} = {}) {
  if (!isDeepseekConfigured(config)) {
    throw new DeepseekError('DeepSeek er ikke konfigurert (DEEPSEEK_API_KEY mangler).', { status: 503, code: 'not-configured' });
  }
  // Hub safe mode: replay a cassette or return a deterministic stub unless aiCalls is allowed.
  return runAiCall({
    provider: 'deepseek',
    request: { model: config.model, system, user, temperature, maxTokens },
    real: () => deepseekChatJsonLive({ system, user, temperature, maxTokens, timeoutMs, fetchImpl, config }),
    stub: () => ({ safeModeStub: true }),
    fail: () => new DeepseekError('DeepSeek er blokkert av safe mode (HUB_SAFE_MODE_ALLOW=aiCalls).', { status: 503, code: 'safe-mode' }),
  });
}

async function deepseekChatJsonLive({ system, user, temperature, maxTokens, timeoutMs, fetchImpl, config }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${system}\n\nSvar KUN med ett gyldig JSON-objekt, uten forklaring rundt.` },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    throw new DeepseekError(aborted ? 'DeepSeek svarte ikke i tide.' : `DeepSeek-kall feilet: ${text(error?.message) || error}`, {
      status: aborted ? 504 : 502,
      code: aborted ? 'timeout' : 'network',
    });
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = text(payload?.error?.message) || `DeepSeek svarte ${response.status}`;
    throw new DeepseekError(message, { status: response.status === 401 ? 503 : 502, code: 'http' });
  }
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(typeof content === 'string' ? content : JSON.stringify(content ?? ''));
  if (!parsed || typeof parsed !== 'object') {
    throw new DeepseekError('DeepSeek returnerte ikke gyldig JSON.', { status: 502, code: 'bad-json' });
  }
  return parsed;
}
