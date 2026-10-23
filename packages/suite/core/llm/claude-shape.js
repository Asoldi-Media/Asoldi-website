// Claude Messages API request builder and response reader (no SDK import; facades pass the params to
// @anthropic-ai/sdk). Rules for claude-haiku-5-5 / claude-sonnet-5-5 / claude-opus-5-5:
//   - never temperature, top_p or top_k (400 on these models); params are built from a whitelist
//   - thinking {type:'adaptive'}; depth set by output_config.effort
//   - max_tokens >= 4096 (thinking counts toward it); a max_tokens stop retries once with the cap doubled
//   - structured JSON through output_config.format (json_schema), never an assistant prefill
//   - tools are strict, tool_choice is always auto (forced tool use returns 400 on Sonnet/Opus 5.5)
//   - images: JPEG, <= 1568 px long edge, <= 6 per call, placed before the text
//   - Sonnet/Opus get the server-side refusal fallback (same vendor); Haiku has none; Batches reject it
//   - stop_reason "refusal" is final: needs review, no other vendor is tried

import { CLAUDE_MODELS, CLAUDE_RULES, EFFORTS } from './constants.js';
import { InvalidRequestError, RefusalError } from './errors.js';
import { countImageBlocks, imageBlocks } from './images.js';
import { unwrapSchema } from './json.js';
import { normalizeUsage } from './prices.js';

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** The output cap for attempt N: max(requested or task cap, 4096), doubled per retry, at most 128000. */
export function claudeMaxTokens({ requested = 0, taskMaxTokens = 0, attempt = 1 } = {}) {
  const base = Math.max(CLAUDE_RULES.maxTokensFloor, positiveInt(requested) || positiveInt(taskMaxTokens));
  const factor = CLAUDE_RULES.maxTokensRetryFactor ** Math.max(0, positiveInt(attempt) - 1);
  return Math.min(CLAUDE_RULES.maxOutputTokens, base * factor);
}

/** True when a response stopped on max_tokens and the one doubled retry is still available. */
export function shouldRetryMaxTokens(stopReason, attempt = 1) {
  return stopReason === 'max_tokens' && attempt <= CLAUDE_RULES.maxTokensRetries;
}

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'patternProperties',
  '$schema',
  '$id',
]);
const SUPPORTED_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

/**
 * A schema Claude's structured outputs accept: unsupported constraints removed, every object closed with
 * additionalProperties:false. The original schema is still enforced client-side by validateJson.
 */
export function toClaudeSchema(schema) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
      if (key === 'minItems' && !(value === 0 || value === 1)) continue;
      if (key === 'format' && !SUPPORTED_FORMATS.has(value)) continue;
      if (key === 'additionalProperties') continue;
      if (key === 'properties' || key === '$defs' || key === 'definitions') {
        out[key] = Object.fromEntries(Object.entries(value || {}).map(([k, v]) => [k, walk(v)]));
      } else {
        out[key] = walk(value);
      }
    }
    const isObject = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object')) || out.properties;
    if (isObject) out.additionalProperties = false;
    return out;
  };
  return walk(unwrapSchema(schema));
}

function systemBlocks(system, cache) {
  if (Array.isArray(system)) {
    return system
      .filter((block) => block && block.type === 'text' && String(block.text || '').trim())
      .map((block) => ({ type: 'text', text: String(block.text), ...(block.cache_control ? { cache_control: { ...block.cache_control } } : {}) }));
  }
  const text = String(system ?? '').trim();
  if (!text) return [];
  return [{ type: 'text', text, ...(cache ? { cache_control: { type: 'ephemeral' } } : {}) }];
}

const ROLES = new Set(['user', 'assistant', 'system']);

function copyMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (!message || !ROLES.has(message.role)) throw new InvalidRequestError(`Message role must be user, assistant or system (got ${message?.role}).`);
    const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((b) => ({ ...b })) : null;
    if (content === null) throw new InvalidRequestError('Message content must be a string or a list of blocks.');
    out.push({ role: message.role, content });
  }
  if (!out.length || out[0].role !== 'user') throw new InvalidRequestError('The first message must come from the user.');
  const last = out[out.length - 1];
  if (last.role === 'assistant') throw new InvalidRequestError('An assistant message last is a prefill, which these models reject. End with a user turn.');
  return out;
}

function toolDefinitions(tools = []) {
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') throw new InvalidRequestError('Each tool must be an object.');
    // Server and Anthropic-defined tools carry a `type`; they are passed through untouched.
    if (tool.type && tool.type !== 'custom') return { ...tool };
    if (!tool.name || !tool.input_schema) throw new InvalidRequestError('A custom tool needs name and input_schema.');
    const out = { name: String(tool.name), input_schema: toClaudeSchema(tool.input_schema), strict: true };
    if (tool.description) out.description = String(tool.description);
    return out;
  });
}

function scrubForbidden(params) {
  for (const key of CLAUDE_RULES.forbiddenParams) delete params[key];
  return params;
}

/**
 * Builds Messages API params for one attempt.
 * @param {object} input {model, effort?, kind?, system?, user?, messages?, images?, schema?, tools?, toolChoice?,
 *   maxTokens?, taskMaxTokens?, attempt?, cache?, batch?, serverFallback?, stopSequences?}
 *   Any other field (temperature, top_p, top_k, thinking, ...) is ignored.
 * @returns {{params:object, betas:string[], stream:boolean, maxTokens:number, effort:string, imageCount:number, warnings:string[]}}
 */
export function buildClaudeRequest(input = {}) {
  const warnings = [];
  const model = String(input.model || '').toLowerCase();
  if (!CLAUDE_MODELS.includes(model)) throw new InvalidRequestError(`Claude model "${input.model}" is not allowed. Use ${CLAUDE_MODELS.join(', ')}.`);
  const effort = input.effort === undefined || input.effort === null || input.effort === '' ? CLAUDE_RULES.defaultEffort : String(input.effort);
  if (!EFFORTS.includes(effort)) throw new InvalidRequestError(`Effort "${input.effort}" must be one of ${EFFORTS.join('|')}.`);
  const kind = input.kind || 'text';
  const attempt = positiveInt(input.attempt) || 1;
  const maxTokens = claudeMaxTokens({ requested: input.maxTokens, taskMaxTokens: input.taskMaxTokens, attempt });
  const cache = input.cache !== false;

  let messages;
  let imageCount = 0;
  if (Array.isArray(input.messages) && input.messages.length) {
    if (input.images?.length) throw new InvalidRequestError('Pass images inside messages, or use user + images, not both.');
    messages = copyMessages(input.messages);
    imageCount = countImageBlocks(messages);
    if (imageCount > CLAUDE_RULES.image.maxImages) throw new InvalidRequestError(`${imageCount} images in one call; the limit is ${CLAUDE_RULES.image.maxImages}.`);
  } else {
    const text = String(input.user ?? '').trim();
    if (!text) throw new InvalidRequestError('A request needs user text or messages.');
    const blocks = imageBlocks(input.images || []);
    imageCount = blocks.length;
    messages = [{ role: 'user', content: [...blocks, { type: 'text', text }] }];
  }

  const params = {
    model,
    max_tokens: maxTokens,
    thinking: { ...CLAUDE_RULES.thinking },
    output_config: { effort },
    messages,
  };
  const system = systemBlocks(input.system, cache);
  if (system.length) params.system = system;

  const schema = kind === 'json' ? unwrapSchema(input.schema) : null;
  if (schema) params.output_config.format = { type: 'json_schema', schema: toClaudeSchema(schema) };

  if (Array.isArray(input.tools) && input.tools.length) {
    params.tools = toolDefinitions(input.tools);
    const requested = input.toolChoice || {};
    if (requested.type && requested.type !== 'auto' && requested.type !== 'none') {
      warnings.push(`tool_choice "${requested.type}" is not allowed on these models; using auto`);
    }
    params.tool_choice = requested.type === 'none' ? { type: 'none' } : { type: CLAUDE_RULES.toolChoice };
    if (requested.disable_parallel_tool_use === true && params.tool_choice.type === 'auto') params.tool_choice.disable_parallel_tool_use = true;
  }

  if (Array.isArray(input.stopSequences) && input.stopSequences.length) params.stop_sequences = input.stopSequences.map(String);

  const betas = [];
  const fallback = CLAUDE_RULES.serverFallback;
  if (!input.batch && input.serverFallback !== false && fallback.models.includes(model)) {
    params.fallbacks = fallback.value;
    betas.push(fallback.beta);
  }

  return {
    params: scrubForbidden(params),
    betas,
    stream: !input.batch && maxTokens > CLAUDE_RULES.streamAboveMaxTokens,
    maxTokens,
    effort,
    imageCount,
    warnings,
  };
}

/** One Message Batches item. Batches reject the server-side fallback, so it is never set here. */
export function buildClaudeBatchItem(customId, input = {}) {
  const id = String(customId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new InvalidRequestError('custom_id must be 1-64 characters of letters, digits, _ or -.');
  const built = buildClaudeRequest({ ...input, batch: true });
  return { custom_id: id, params: built.params, betas: built.betas };
}

/** Normalized view of an Anthropic Message (SDK object or raw JSON). */
export function normalizeClaudeResponse(message = {}) {
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((block) => block && block.type === 'text')
    .map((block) => String(block.text || ''))
    .join('');
  const usage = message.usage || {};
  return {
    id: String(message.id || ''),
    servedModel: String(message.model || ''),
    text,
    content,
    stopReason: String(message.stop_reason || ''),
    stopDetails: message.stop_details || null,
    usage: { ...normalizeUsage(usage), ...(Array.isArray(usage.iterations) ? { iterations: usage.iterations } : {}) },
    fallbackServed: Array.isArray(usage.iterations) && usage.iterations.some((it) => it?.type === 'fallback_message'),
  };
}

/** Throws RefusalError for a refused response; returns the response otherwise. */
export function assertNotRefused(response, { model = '', task = '' } = {}) {
  if (response?.stopReason !== 'refusal') return response;
  throw new RefusalError(`The model declined the ${task || 'request'}; it needs review.`, {
    model: response.servedModel || model,
    task,
    category: response.stopDetails?.category ?? null,
    explanation: response.stopDetails?.explanation ?? null,
  });
}

export function toolUseBlocks(content = []) {
  return (Array.isArray(content) ? content : []).filter((block) => block && block.type === 'tool_use' && block.id);
}

export function toolResultMessage(results = []) {
  return {
    role: 'user',
    content: results.map((entry) => ({
      type: 'tool_result',
      tool_use_id: String(entry.toolUseId || entry.tool_use_id || ''),
      content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content ?? {}),
      ...(entry.isError || entry.is_error ? { is_error: true } : {}),
    })),
  };
}
