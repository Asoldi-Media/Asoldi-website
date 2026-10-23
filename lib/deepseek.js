/**
 * DeepSeek chat client (OpenAI-compatible API) and the JSON wrapper the hub's AI call sites use.
 *
 * deepseekChatJson({ task, ctx, system, user, ... }) is a wrapper over the hub LLM facade (lib/llm):
 *  - with a task key and a registered facade, the call goes through the facade, which records it in
 *    the AI ledger and routes it by the active profile. The default `legacy` profile runs exactly the
 *    request below (same model, temperature, max_tokens and prompt suffix); other profiles route by
 *    config and the data policy (for example Claude Haiku 5.5 for transcripts).
 *  - without a task or without a facade (browser bundle, unit tests, scripts) it runs the request below
 *    directly, as it always did.
 *
 * Env: DEEPSEEK_API_KEY (required), DEEPSEEK_MODEL (default deepseek-chat).
 */

import { runAiCall } from './safe-mode-hooks.js';
import { hubLlm } from './llm-hooks.js';

const API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 90_000;
/** Appended to every legacy DeepSeek system prompt (and to JSON tasks without a schema on other providers). */
export const JSON_ONLY_SUFFIX = 'Svar KUN med ett gyldig JSON-objekt, uten forklaring rundt.';

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
  constructor(message, { status = 0, code = 'deepseek-error', httpStatus = 0, cause = undefined } = {}) {
    super(message);
    this.name = 'DeepseekError';
    this.status = status;
    this.code = code;
    // The provider's own HTTP status (`status` maps 401 to 503 for the hub's routes).
    if (httpStatus) this.httpStatus = httpStatus;
    if (cause !== undefined) this.cause = cause;
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

/** Usage from an OpenAI-compatible response, in the ledger's token names. */
export function deepseekUsage(payload = {}) {
  const u = payload?.usage || {};
  const cached = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens) || 0;
  const prompt = Number(u.prompt_tokens) || 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: Number(u.completion_tokens) || 0,
    cacheReadTokens: cached,
  };
}

/**
 * One raw chat completion. The only DeepSeek HTTP call in the hub: the legacy JSON path below and the
 * facade's DeepSeek adapter (lib/llm/providers/deepseek.js) both use it.
 *   temperature: sent only when it is a number (the facade's non-legacy routes leave it out)
 *   jsonSuffix:  append JSON_ONLY_SUFFIX to the system prompt (legacy behaviour)
 *   jsonMode:    send response_format json_object (every hub DeepSeek call today)
 * @returns {Promise<{content:string, payload:object, model:string, finishReason:string}>}
 */
export async function deepseekChatRaw({
  system = '',
  user = '',
  temperature,
  maxTokens = 2000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  config = readDeepseekConfig(),
  model = '',
  jsonSuffix = true,
  jsonMode = true,
  signal,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener?.('abort', onAbort, { once: true });
  }
  const body = {
    model: model || config.model,
    ...(typeof temperature === 'number' ? { temperature } : {}),
    max_tokens: maxTokens,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    messages: [
      { role: 'system', content: jsonSuffix ? `${system}\n\n${JSON_ONLY_SUFFIX}` : String(system || '') },
      { role: 'user', content: user },
    ],
  };
  let response;
  try {
    response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    if (aborted && signal?.aborted) throw error;
    throw new DeepseekError(aborted ? 'DeepSeek svarte ikke i tide.' : `DeepSeek-kall feilet: ${text(error?.message) || error}`, {
      status: aborted ? 504 : 502,
      code: aborted ? 'timeout' : 'network',
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = text(payload?.error?.message) || `DeepSeek svarte ${response.status}`;
    throw new DeepseekError(message, { status: response.status === 401 ? 503 : 502, code: 'http', httpStatus: response.status });
  }
  const content = payload?.choices?.[0]?.message?.content;
  return {
    content: typeof content === 'string' ? content : JSON.stringify(content ?? ''),
    payload,
    model: text(payload?.model) || body.model,
    finishReason: text(payload?.choices?.[0]?.finish_reason),
  };
}

/**
 * Today's DeepSeek JSON call, unchanged: config check, hub safe-mode guard (cassette, stub or block),
 * then the request with the caller's temperature and the JSON-only suffix.
 * @returns {Promise<{data:object, usage:object, servedModel:string, stopReason:string, guarded?:boolean}>}
 */
export async function deepseekLegacyJson({
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
  let live = null;
  // Hub safe mode: replay a cassette or return a deterministic stub unless aiCalls is allowed.
  const data = await runAiCall({
    provider: 'deepseek',
    request: { model: config.model, system, user, temperature, maxTokens },
    real: async () => {
      const raw = await deepseekChatRaw({ system, user, temperature, maxTokens, timeoutMs, fetchImpl, config });
      const parsed = extractJsonObject(raw.content);
      if (!parsed || typeof parsed !== 'object') {
        throw new DeepseekError('DeepSeek returnerte ikke gyldig JSON.', { status: 502, code: 'bad-json' });
      }
      live = raw;
      return parsed;
    },
    stub: () => ({ safeModeStub: true }),
    fail: () => new DeepseekError('DeepSeek er blokkert av safe mode (HUB_SAFE_MODE_ALLOW=aiCalls).', { status: 503, code: 'safe-mode' }),
  });
  return {
    data,
    usage: live ? deepseekUsage(live.payload) : {},
    servedModel: live?.model || config.model,
    stopReason: live?.finishReason === 'length' ? 'max_tokens' : 'end_turn',
    ...(live ? {} : { guarded: true }),
  };
}

function asDeepseekError(error, task) {
  if (error instanceof DeepseekError) return error;
  const code = text(error?.code) || 'llm-error';
  const status = ['policy_blocked', 'provider_dead', 'route_config', 'llm_unavailable'].includes(code) ? 503 : 502;
  return new DeepseekError(`AI-kallet (${task}) feilet: ${text(error?.message) || code}`, { status, code, cause: error });
}

/**
 * Ask for a JSON object. `system` should describe the exact shape. Returns the parsed object.
 * Throws DeepseekError on config / network / parse problems, and wraps facade errors in it so callers
 * keep one error type. `task` is the hub task key (packages/suite/harness/asoldi/llm.js); `ctx` carries
 * ledger fields such as salesClientId.
 */
export async function deepseekChatJson({
  task = '',
  ctx = undefined,
  data = undefined,
  system = '',
  user = '',
  temperature = 0.4,
  maxTokens = 2000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  config = readDeepseekConfig(),
} = {}) {
  const legacy = {
    provider: 'deepseek',
    model: config.model,
    run: () => deepseekLegacyJson({ system, user, temperature, maxTokens, timeoutMs, fetchImpl, config }),
  };
  const facade = hubLlm();
  if (!facade || !task) return (await legacy.run()).data;
  try {
    const result = await facade.json({ task, system, user, maxTokens, ctx, data, legacy });
    return result.data;
  } catch (error) {
    throw asDeepseekError(error, task);
  }
}
