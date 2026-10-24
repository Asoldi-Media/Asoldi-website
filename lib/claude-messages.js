/**
 * Anthropic Messages API with tools, and the tool loop the Infokort agent runs on.
 *
 * claudeMessages / claudeToolLoop are wrappers over the hub LLM facade (lib/llm): with a task key and a
 * registered facade, each turn goes through the facade (AI ledger, routes, budgets). The default `legacy`
 * profile sends exactly the request below (raw fetch, Claude Haiku 5.5, adaptive thinking, medium effort,
 * the caller's tools as written); other profiles build the request in the shared LLM core (SDK, strict
 * tools, no sampling parameters). Without a task or a facade the request below runs directly.
 *
 * Env: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (default claude-haiku-5-5), ANTHROPIC_EFFORT.
 */

import { runAiCall } from './safe-mode-hooks.js';
import { hubLlm } from './llm-hooks.js';

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
  constructor(message, { status = 0, code = 'anthropic-error', cause = undefined } = {}) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function asContent(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return [];
}

/**
 * Today's Claude request, unchanged: config check, hub safe-mode guard (cassette, stub or block), then
 * one raw Messages API call. Returns { id, stopReason, content, usage, model }.
 */
export async function claudeLegacyMessages({
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
  // Hub safe mode: replay a cassette or return a final text-only turn unless aiCalls is allowed.
  return runAiCall({
    provider: 'anthropic',
    request: { model: config.model, system, messages, tools, maxTokens },
    real: () => claudeMessagesLive({ system, messages, tools, maxTokens, timeoutMs, fetchImpl, config }),
    stub: (key) => ({
      id: `safe-mode-stub-${key.slice(0, 12)}`,
      stopReason: 'end_turn',
      content: [{ type: 'text', text: '{}' }],
      usage: { input_tokens: 0, output_tokens: 0 },
      safeModeStub: true,
    }),
    fail: () => new AnthropicError('Claude er blokkert av safe mode (HUB_SAFE_MODE_ALLOW=aiCalls).', { status: 503, code: 'safe-mode' }),
  });
}

/**
 * One Messages API turn. With `task` and a registered facade the turn goes through the facade; otherwise
 * it is today's request (claudeLegacyMessages).
 */
export async function claudeMessages({
  task = '',
  ctx = undefined,
  system = '',
  messages = [],
  tools = [],
  maxTokens = 4096,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  config = readAnthropicConfig(),
} = {}) {
  const legacy = {
    provider: 'claude',
    model: config.model,
    effort: config.effort || 'medium',
    run: () => claudeLegacyMessages({ system, messages, tools, maxTokens, timeoutMs, fetchImpl, config }),
  };
  const facade = hubLlm();
  if (!facade || !task || typeof facade.turn !== 'function') return legacy.run();
  return facade.turn({ task, ctx, system, messages, tools, maxTokens, legacy });
}

async function claudeMessagesLive({ system, messages, tools, maxTokens, timeoutMs, fetchImpl, config }) {
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
    model: text(payload.model),
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

/**
 * A tool loop over any turn function ({system, tools, messages, maxTokens}) => {content, usage, stopReason}.
 * After each turn the assistant content is appended. Then:
 *   - no tool_use blocks: onEndTurn(reply, info) may return { followUp } (a user message, and the loop goes
 *     on) or nothing (the loop stops);
 *   - tool_use blocks: onToolUse(blocks, info) returns the results array, or { results, followUp?, stop? }.
 *     The results go back as one tool_result message, then the optional follow-up user message; `stop`
 *     ends the loop without another turn.
 * `messages` is extended in place and returned. Usage is summed over the turns.
 */
export async function runToolLoop({ turn, system = '', messages = [], tools = [], maxTurns = 8, maxTokens = 4096, onToolUse, onEndTurn } = {}) {
  if (typeof turn !== 'function') throw new TypeError('runToolLoop needs a turn function.');
  if (typeof onToolUse !== 'function') throw new TypeError('runToolLoop needs onToolUse(blocks) => results.');
  const history = Array.isArray(messages) ? messages : [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let last = null;
  let turns = 0;
  let stopped = false;
  while (turns < maxTurns) {
    turns += 1;
    last = await turn({ system, tools, messages: history, maxTokens });
    usage.input_tokens += Number(last?.usage?.input_tokens || 0);
    usage.output_tokens += Number(last?.usage?.output_tokens || 0);
    history.push({ role: 'assistant', content: last?.content });
    const uses = toolUseBlocks(last?.content);
    if (!uses.length) {
      const next = typeof onEndTurn === 'function' ? await onEndTurn(last, { turns }) : null;
      if (next?.followUp) {
        history.push({ role: 'user', content: next.followUp });
        continue;
      }
      stopped = true;
      break;
    }
    const out = await onToolUse(uses, { turns, last });
    const results = Array.isArray(out) ? out : Array.isArray(out?.results) ? out.results : [];
    history.push(toolResultMessage(results));
    if (out && !Array.isArray(out) && out.followUp) history.push({ role: 'user', content: out.followUp });
    if (out && !Array.isArray(out) && out.stop) {
      stopped = true;
      break;
    }
  }
  return { last, messages: history, turns, usage, maxTurnsReached: !stopped && turns >= maxTurns };
}

/**
 * The tool loop for one task. `chat` (tests) replaces the turn function. With a registered facade and no
 * `chat`, the facade runs the loop (each turn through the facade); otherwise each turn is claudeMessages.
 */
export async function claudeToolLoop({ task = '', ctx = undefined, chat = null, ...loop } = {}) {
  const facade = hubLlm();
  if (facade && task && typeof chat !== 'function' && typeof facade.tools === 'function') {
    return facade.tools({ task, ctx, ...loop });
  }
  const turn = typeof chat === 'function' ? chat : (args) => claudeMessages({ ...args, task, ctx });
  return runToolLoop({ ...loop, turn });
}
