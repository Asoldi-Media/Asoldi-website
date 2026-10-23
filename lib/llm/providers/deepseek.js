/**
 * DeepSeek adapter for the shared LLM core (non-legacy profiles). It reuses the one DeepSeek HTTP call in
 * lib/deepseek.js, without the caller's temperature (the facade sends none on non-legacy routes) and
 * without the legacy prompt suffix (the facade adds its own JSON instruction). Text only: the core never
 * routes images or tool loops here. Every call goes through the hub safe-mode guard.
 */
import { DeepseekError, deepseekChatRaw, deepseekUsage, readDeepseekConfig } from '../../deepseek.js';
import { guardAiCall } from '../../safe-mode-ai.js';

function clean(value) {
  return String(value ?? '').trim();
}

function asAdapterError(error) {
  // The core decides fallback and dead providers from the provider's own HTTP status.
  if (error instanceof DeepseekError && error.httpStatus) return Object.assign(error, { status: error.httpStatus });
  return error;
}

export function createDeepseekAdapter({ env = process.env, fetch: fetchImpl = null, guard = guardAiCall, timeoutMs = 90_000 } = {}) {
  return async function deepseekAdapter(call) {
    const config = readDeepseekConfig(env);
    if (!config.apiKey) throw Object.assign(new DeepseekError('DEEPSEEK_API_KEY is not set on this hub.', { status: 401, code: 'provider_dead' }));
    const request = { model: call.model, system: call.system, user: call.user, maxTokens: call.maxTokens, kind: call.kind };
    const raw = await guard({
      provider: 'deepseek',
      task: call.task,
      request,
      real: async () => {
        try {
          return await deepseekChatRaw({
            system: call.system,
            user: call.user,
            maxTokens: call.maxTokens,
            timeoutMs,
            config,
            model: call.model,
            jsonSuffix: false,
            jsonMode: call.kind === 'json',
            signal: call.signal,
            ...(fetchImpl ? { fetchImpl } : {}),
          });
        } catch (error) {
          throw asAdapterError(error);
        }
      },
      stub: () => ({ content: '{}', payload: {}, model: call.model, finishReason: 'stop', safeModeStub: true }),
      fail: () => Object.assign(new Error('DeepSeek is blocked by hub safe mode (HUB_SAFE_MODE_ALLOW=aiCalls).'), { code: 'safe_mode', status: 503 }),
    });
    return {
      servedModel: clean(raw?.model) || call.model,
      text: String(raw?.content ?? ''),
      stopReason: raw?.finishReason === 'length' ? 'max_tokens' : raw?.finishReason === 'content_filter' ? 'refusal' : 'end_turn',
      usage: deepseekUsage(raw?.payload),
      ...(raw?.safeModeStub ? { guarded: true } : {}),
    };
  };
}

/** A free key check: GET /user/balance (used only when an admin asks for a probe). */
export async function probeDeepseek({ env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const config = readDeepseekConfig(env);
  if (!config.apiKey) return { ok: false, error: 'not-configured' };
  try {
    const response = await fetchImpl('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${config.apiKey}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, status: response.status, error: clean(body?.error?.message).slice(0, 200) || `HTTP ${response.status}` };
    return { ok: true, available: body?.is_available !== false };
  } catch (error) {
    return { ok: false, error: clean(error?.message).slice(0, 200) || 'probe failed' };
  }
}
