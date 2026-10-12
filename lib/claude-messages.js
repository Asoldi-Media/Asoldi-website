/**
 * Anthropic Messages API with tools. Default model is Claude Haiku 5.5,
 * adaptive thinking, medium effort.
 *
 * Env: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (default claude-haiku-5-5).
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-5-5';
const DEFAULT_TIMEOUT_MS = 90_000;
const ANTHROPIC_VERSION = '2023-06-01';

function text(value = '') {
  return String(value ?? '').trim();
}

export function readAnthropicConfig(env = process.env) {
  return {
    apiKey: text(env.ANTHROPIC_API_KEY),
    model: text(env.ANTHROPIC_MODEL) || DEFAULT_MODEL,
    effort: text(env.ANTHROPIC_EFFORT) || 'medium',
  };
}

export function isAnthropicConfigured(config = readAnthropicConfig()) {
  return Boolean(config.apiKey);
}

export class AnthropicError extends Error {
  constructor(message, { status = 0, code = 'anthropic-error' } = {}) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
    this.code = code;
  }
}

function asContent(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return [];
}

export async function claudeMessages({
  system = '',
  messages = [],
  tools = [],
  maxTokens = 4096,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  config = readAnthropicConfig(),
} = {}) {
  if (!isAnthropicConfigured(config)) {
    throw new AnthropicError('Anthropic er ikke konfigurert (ANTHROPIC_API_KEY mangler).', {
      status: 503,
      code: 'not-configured',
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = {
    model: config.model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: config.effort || 'medium' },
    system,
    messages,
    tools,
  };
  let response;
  try {
    response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    throw new AnthropicError(
      aborted ? 'Claude svarte ikke i tide.' : `Claude-kall feilet: ${text(error?.message) || error}`,
      { status: aborted ? 504 : 502, code: aborted ? 'timeout' : 'network' }
    );
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = text(payload?.error?.message) || `Claude svarte ${response.status}`;
    throw new AnthropicError(message, {
      status: response.status === 401 ? 503 : 502,
      code: 'http',
    });
  }
  return {
    id: text(payload.id),
    stopReason: text(payload.stop_reason),
    content: asContent(payload.content),
    usage: payload.usage && typeof payload.usage === 'object' ? payload.usage : {},
  };
}

export function toolUseBlocks(content = []) {
  return asContent(content).filter((block) => block && block.type === 'tool_use' && block.id);
}

export function toolResultMessage(results = []) {
  return {
    role: 'user',
    content: results.map((entry) => ({
      type: 'tool_result',
      tool_use_id: text(entry.toolUseId),
      content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content ?? {}),
      is_error: Boolean(entry.isError),
    })),
  };
}
