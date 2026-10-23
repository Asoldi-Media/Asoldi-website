/**
 * Claude adapter for the shared LLM core (non-legacy profiles), on @anthropic-ai/sdk.
 * The core builds the request (claude-shape.js): no temperature/top_p/top_k, adaptive thinking,
 * output_config.effort, max_tokens floor, strict tools, server-side refusal fallback on Sonnet/Opus.
 * This adapter only sends it (streaming when the core says so) through the hub safe-mode guard.
 *
 * The SDK is loaded on the first Claude call, so a hub on the legacy profile never loads it.
 */
import { ProviderDeadError, normalizeClaudeResponse } from '../../../packages/suite/core/llm/index.js';
import { guardAiCall } from '../../safe-mode-ai.js';

function clean(value) {
  return String(value ?? '').trim();
}

let sdkModule = null;
async function loadAnthropic() {
  if (!sdkModule) sdkModule = await import('@anthropic-ai/sdk');
  return sdkModule.default || sdkModule.Anthropic;
}

export function anthropicKeyFrom(env = process.env) {
  return clean(env.ANTHROPIC_API_KEY);
}

function stubMessage(model, key) {
  return {
    id: `safe-mode-stub-${String(key).slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: '{}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    safeModeStub: true,
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.env]       read at call time (ANTHROPIC_API_KEY)
 * @param {Function} [options.fetch]   passed to the SDK (tests); the SDK uses global fetch otherwise
 * @param {object} [options.client]    a ready SDK client (tests)
 * @param {Function} [options.guard]   safe-mode guard (lib/safe-mode-ai.js guardAiCall)
 */
export function createClaudeAdapter({ env = process.env, fetch: fetchImpl = null, client = null, guard = guardAiCall, timeoutMs = 300_000 } = {}) {
  let sdk = client;
  let sdkKey = '';
  return async function claudeAdapter(call) {
    const apiKey = anthropicKeyFrom(env);
    if (!client && !apiKey) throw new ProviderDeadError('ANTHROPIC_API_KEY is not set on this hub.', { provider: 'claude', status: 401 });
    const { params, betas = [], stream = false } = call.claude || {};
    const real = async () => {
      if (!client && (!sdk || sdkKey !== apiKey)) {
        const Anthropic = await loadAnthropic();
        sdk = new Anthropic({ apiKey, maxRetries: 2, timeout: timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
        sdkKey = apiKey;
      }
      const api = betas.length ? sdk.beta.messages : sdk.messages;
      const body = betas.length ? { ...params, betas } : params;
      const options = call.signal ? { signal: call.signal } : undefined;
      return stream ? api.stream(body, options).finalMessage() : api.create(body, options);
    };
    const message = await guard({
      provider: 'anthropic',
      task: call.task,
      request: params,
      real,
      stub: (key) => stubMessage(params?.model, key),
      fail: () => Object.assign(new Error('Claude is blocked by hub safe mode (HUB_SAFE_MODE_ALLOW=aiCalls).'), { code: 'safe_mode', status: 503 }),
    });
    const normalized = normalizeClaudeResponse(message);
    return message?.safeModeStub ? { ...normalized, guarded: true } : normalized;
  };
}

/** A free key check: GET /v1/models through the SDK (used only when an admin asks for a probe). */
export async function probeClaude({ env = process.env, fetch: fetchImpl = null } = {}) {
  const apiKey = anthropicKeyFrom(env);
  if (!apiKey) return { ok: false, error: 'not-configured' };
  const Anthropic = await loadAnthropic();
  const sdk = new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  try {
    const page = await sdk.models.list({ limit: 20 });
    const ids = (page?.data || []).map((model) => model.id);
    return { ok: true, models: ids.slice(0, 20) };
  } catch (error) {
    return { ok: false, status: Number(error?.status) || 0, error: clean(error?.message).slice(0, 200) || 'probe failed' };
  }
}
