// Ledger rows (v2). One row per provider attempt, priced from the model that actually served it.
// Storage (JSONL files, rotation, summaries) is the facade's job; this module only shapes rows.

import { LEDGER_DATA_CLASSES } from './constants.js';
import { normalizeUsage, priceResponse, priceUsage } from './prices.js';

export const LEDGER_VERSION = 2;

export const LEDGER_STATUSES = Object.freeze([
  'ok',
  'error',
  'refusal',
  'max_tokens',
  'schema_invalid',
  'budget_blocked',
  'loop_blocked',
  'policy_blocked',
  'skipped_dead',
]);

/** Fields every v2 row has (contract). */
export const LEDGER_FIELDS = Object.freeze([
  'v',
  'kind',
  'at',
  'repo',
  'task',
  'provider',
  'requestedModel',
  'model',
  'effort',
  'profile',
  'runId',
  'salesClientId',
  'sessionId',
  'tier',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'images',
  'usd',
  'priceVerified',
  'latencyMs',
  'status',
  'stopReason',
  'attempt',
  'maxTokens',
  'fallbackFrom',
  'policyRedirect',
  'needsReview',
  'budget',
  'dataClass',
  'redacted',
]);

/**
 * The two data-policy fields of a row (the ledger is the policy log). `dataClass` is one of
 * LEDGER_DATA_CLASSES and `redacted` is true or false. Both record what the policy decided for the call's
 * payload (route.dataClass.ledger, or the same check on a call that has no route), never the caller's flag.
 * Readers accept older rows that lack them.
 */
export const LEDGER_DATA_FIELDS = Object.freeze(['dataClass', 'redacted']);

/**
 * Problems of one v2 LLM row against the contract: a missing field, a data class outside the fixed list, or a
 * `redacted` that is not true or false. An empty list means the row is complete. Rows of kind `api` and
 * migrated v1 rows are not checked.
 */
export function ledgerRowProblems(row = {}) {
  if (!row || typeof row !== 'object') return ['row is not an object'];
  if (row.kind !== 'llm' || row.v !== LEDGER_VERSION || row.migratedFrom) return [];
  const problems = [];
  for (const field of LEDGER_FIELDS) if (!(field in row)) problems.push(`row lacks ${field}`);
  if ('dataClass' in row && !LEDGER_DATA_CLASSES.includes(row.dataClass)) problems.push(`dataClass "${row.dataClass}" is not one of ${LEDGER_DATA_CLASSES.join(', ')}`);
  if ('redacted' in row && typeof row.redacted !== 'boolean') problems.push('redacted must be true or false');
  return problems;
}

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

function round(value) {
  return Math.round((Number(value) || 0) * 1e10) / 1e10;
}

/**
 * Builds one v2 row. `servedModel` (response.model) prices the row; `requestedModel` is what the route asked for.
 * With `response` given (Claude shape), usage.iterations from a server-side fallback are priced per attempt.
 * `dataClass` and `redacted` come from the policy's result for the call (route.dataClass.ledger). A row built
 * without a data class from the fixed list has no `dataClass` field, and ledgerRowProblems() reports it.
 * `images` is the number of image blocks of the request, those inside messages and tool results included.
 */
export function buildLedgerRow({
  at = new Date().toISOString(),
  repo = '',
  task = '',
  provider = '',
  requestedModel = '',
  servedModel = '',
  effort = null,
  profile = '',
  ctx = {},
  usage = null,
  response = null,
  images = 0,
  latencyMs = 0,
  status = 'ok',
  stopReason = '',
  attempt = 1,
  maxTokens = 0,
  fallbackFrom = null,
  policyRedirect = null,
  needsReview = false,
  budget = null,
  batch = false,
  inferenceGeo = '',
  error = null,
  dataClass = '',
  redacted = false,
} = {}) {
  // A replay serves a recorded response: nothing is spent. The recorded model goes to `replayOf`.
  const replay = provider === 'replay';
  const recorded = str(servedModel || response?.model);
  const model = replay ? str(requestedModel || 'replay') : str(servedModel || response?.model || requestedModel);
  const u = normalizeUsage(usage ?? response?.usage ?? {});
  const priced = replay
    ? { usd: 0, priceVerified: true }
    : response
      ? priceResponse({ requestedModel, response, batch, inferenceGeo })
      : priceUsage({ model, usage: u, batch, inferenceGeo });
  const row = {
    v: LEDGER_VERSION,
    kind: 'llm',
    at: str(at),
    repo: str(repo),
    task: str(task),
    provider: str(provider),
    requestedModel: str(requestedModel || model),
    model,
    effort: effort || null,
    profile: str(profile),
    runId: str(ctx.runId),
    salesClientId: str(ctx.salesClientId),
    sessionId: str(ctx.sessionId),
    tier: str(ctx.tier),
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWrite5mTokens + u.cacheWrite1hTokens,
    images: Number(images) || 0,
    usd: priced.usd,
    priceVerified: priced.priceVerified,
    latencyMs: Math.max(0, Math.round(Number(latencyMs) || 0)),
    status: LEDGER_STATUSES.includes(status) ? status : 'error',
    stopReason: str(stopReason),
    attempt: Number(attempt) || 1,
    maxTokens: Number(maxTokens) || 0,
    fallbackFrom: fallbackFrom || null,
    policyRedirect: policyRedirect || null,
    needsReview: Boolean(needsReview),
    budget: budget || null,
    ...(LEDGER_DATA_CLASSES.includes(dataClass) ? { dataClass } : {}),
    redacted: redacted === true,
  };
  if (batch) row.batch = true;
  if (replay && recorded) row.replayOf = recorded;
  if (error) row.error = { code: str(error.code || error.name || 'error'), message: str(error.message).slice(0, 300) };
  return row;
}

/** A row for a paid non-LLM API (DataForSEO and the like). The caller supplies the real cost. */
export function buildApiSpendRow({ at = new Date().toISOString(), repo = '', provider = '', task = '', usd = 0, ctx = {}, status = 'ok', note = '' } = {}) {
  return {
    v: LEDGER_VERSION,
    kind: 'api',
    at: str(at),
    repo: str(repo),
    task: str(task),
    provider: str(provider),
    runId: str(ctx.runId),
    salesClientId: str(ctx.salesClientId),
    sessionId: str(ctx.sessionId),
    tier: str(ctx.tier),
    usd: round(usd),
    priceVerified: true,
    status: str(status),
    ...(note ? { note: str(note).slice(0, 300) } : {}),
  };
}

/**
 * Reads a ledger row of any version as v2. v1 rows (website-maker lib/llm-usage.js:
 * {at, provider, model, purpose, runId, step, inputTokens, outputTokens, usd}) keep their recorded usd
 * and are marked priceVerified:false, with purpose as `legacy:<purpose>` task.
 */
export function readLedgerRow(row = {}) {
  if (!row || typeof row !== 'object') return null;
  if (row.v === LEDGER_VERSION) return row;
  const purpose = str(row.purpose || row.step);
  return {
    v: LEDGER_VERSION,
    kind: 'llm',
    at: str(row.at),
    repo: str(row.repo),
    task: purpose ? `legacy:${purpose}` : 'legacy',
    provider: str(row.provider),
    requestedModel: str(row.model),
    model: str(row.model),
    effort: null,
    profile: 'legacy',
    runId: str(row.runId),
    salesClientId: str(row.salesClientId),
    sessionId: '',
    tier: '',
    inputTokens: Number(row.inputTokens) || 0,
    outputTokens: Number(row.outputTokens) || 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    images: 0,
    usd: round(row.usd),
    priceVerified: false,
    latencyMs: 0,
    status: 'ok',
    stopReason: '',
    attempt: 1,
    maxTokens: 0,
    fallbackFrom: null,
    policyRedirect: null,
    needsReview: false,
    budget: null,
    migratedFrom: Number(row.v) || 1,
  };
}

/** Sum of usd per key ('task' | 'provider' | 'model' | 'salesClientId' | 'runId'). */
export function summarizeLedger(rows = [], by = 'task') {
  const out = { totalUsd: 0, calls: 0, groups: {} };
  for (const raw of rows) {
    const row = readLedgerRow(raw);
    if (!row) continue;
    const key = str(row[by]) || '(none)';
    const group = out.groups[key] || { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, unverifiedUsd: 0 };
    group.usd = round(group.usd + row.usd);
    group.calls += 1;
    group.inputTokens += Number(row.inputTokens) || 0;
    group.outputTokens += Number(row.outputTokens) || 0;
    if (!row.priceVerified) group.unverifiedUsd = round(group.unverifiedUsd + row.usd);
    out.groups[key] = group;
    out.totalUsd = round(out.totalUsd + row.usd);
    out.calls += 1;
  }
  return out;
}

/** Usage from an OpenAI-compatible chat response (DeepSeek, OpenAI). */
export function usageFromChatResponse(response = {}) {
  const u = response?.usage || {};
  const cached = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens) || 0;
  const prompt = Number(u.prompt_tokens || u.input_tokens) || 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: Number(u.completion_tokens || u.output_tokens) || 0,
    cacheReadTokens: cached,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  };
}

/** Usage from a Gemini generateContent response (thinking tokens count as output). */
export function usageFromGeminiResponse(json = {}) {
  const u = json?.usageMetadata || {};
  const cached = Number(u.cachedContentTokenCount) || 0;
  return {
    inputTokens: Math.max(0, (Number(u.promptTokenCount) || 0) - cached),
    outputTokens: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0),
    cacheReadTokens: cached,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  };
}
