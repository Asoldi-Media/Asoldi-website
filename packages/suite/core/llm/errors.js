// Error classes of the LLM core. Facades throw these; callers branch on `code`, never on messages.

export class LlmError extends Error {
  constructor(message, { code = 'llm_error', ...fields } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    Object.assign(this, fields);
  }
}

/** Broken route, task or policy configuration. Fails at load, not on a live call. */
export class RouteConfigError extends LlmError {
  constructor(message, fields = {}) {
    super(message, { code: 'route_config', ...fields });
    this.name = 'RouteConfigError';
  }
}

/** The caller built a request the contract does not allow (prefill, too many images, wrong mime). */
export class InvalidRequestError extends LlmError {
  constructor(message, fields = {}) {
    super(message, { code: 'invalid_request', ...fields });
    this.name = 'InvalidRequestError';
  }
}

/** No provider in the chain may see this data class. */
export class PolicyBlockedError extends LlmError {
  constructor(message, fields = {}) {
    super(message, { code: 'policy_blocked', ...fields });
    this.name = 'PolicyBlockedError';
  }
}

/**
 * Hard stop. Soft budgets never throw; this is only for a runaway (spend over runawayFactor × expected)
 * or a loop (`reason: 'loop'`, the same request repeating with no progress).
 */
export class BudgetExceededError extends LlmError {
  constructor(message, fields = {}) {
    super(message, { code: 'budget_exceeded', reason: 'runaway', ...fields });
    this.name = 'BudgetExceededError';
  }
}

export class LoopDetectedError extends BudgetExceededError {
  constructor(message, fields = {}) {
    super(message, { ...fields, reason: 'loop' });
    this.name = 'LoopDetectedError';
    this.code = 'loop_detected';
  }
}

/** The provider rejected the key (401/403) or is otherwise unusable for this process. */
export class ProviderDeadError extends LlmError {
  constructor(message, fields = {}) {
    super(message, { code: 'provider_dead', ...fields });
    this.name = 'ProviderDeadError';
  }
}

/**
 * The model declined (stop_reason "refusal"). Final: the item needs review and no other vendor is tried,
 * so safety-declined content is never routed around the provider's safeguards.
 */
export class RefusalError extends LlmError {
  constructor(message, fields = {}) {
    super(message, { code: 'refusal', needsReview: true, crossVendorRetry: false, ...fields });
    this.name = 'RefusalError';
  }
}

/** Output still hit max_tokens after the one doubled retry. */
export class MaxTokensError extends LlmError {
  constructor(message, fields = {}) {
    super(message, { code: 'max_tokens', ...fields });
    this.name = 'MaxTokensError';
  }
}

/** Output was not valid JSON or did not match the schema. */
export class SchemaValidationError extends LlmError {
  constructor(message, fields = {}) {
    super(message, { code: 'schema_invalid', ...fields });
    this.name = 'SchemaValidationError';
  }
}

/** Replay profile and no cassette for this request. */
export class CassetteMissError extends LlmError {
  constructor(message, fields = {}) {
    super(message, { code: 'cassette_miss', ...fields });
    this.name = 'CassetteMissError';
  }
}

/** A transient provider failure (429, 5xx, network, timeout) after the SDK's own retries. */
export class ProviderError extends LlmError {
  constructor(message, fields = {}) {
    super(message, { code: 'provider_error', ...fields });
    this.name = 'ProviderError';
  }
}

export const ERROR_CODES = Object.freeze([
  'llm_error',
  'route_config',
  'invalid_request',
  'policy_blocked',
  'budget_exceeded',
  'loop_detected',
  'provider_dead',
  'refusal',
  'max_tokens',
  'schema_invalid',
  'cassette_miss',
  'provider_error',
]);

const STOPPING = new Set(['refusal', 'budget_exceeded', 'loop_detected', 'policy_blocked', 'route_config', 'invalid_request', 'cassette_miss']);

/**
 * How the router treats a failure from one chain entry.
 *   fallback: try the next entry in the chain
 *   dead: mark this provider dead for the process
 *   needsReview: the item goes to a person or the review queue
 */
export function classifyError(error) {
  const code = String(error?.code || '');
  if (STOPPING.has(code)) {
    return { kind: code, fallback: false, dead: false, needsReview: code === 'refusal' };
  }
  const status = Number(error?.status || error?.statusCode || 0);
  if (code === 'provider_dead' || status === 401 || status === 403) {
    return { kind: 'provider_dead', fallback: true, dead: true, needsReview: false };
  }
  if (code === 'max_tokens' || code === 'schema_invalid') {
    return { kind: code, fallback: true, dead: false, needsReview: false };
  }
  if (status === 429 || status === 408 || status === 409 || status >= 500) {
    return { kind: 'provider_error', fallback: true, dead: false, needsReview: false };
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return { kind: 'bad_request', fallback: true, dead: false, needsReview: false };
  }
  return { kind: code || 'provider_error', fallback: true, dead: false, needsReview: false };
}
