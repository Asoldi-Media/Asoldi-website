// callLlm: the one call path both facades share. The facade supplies provider adapters (SDK clients,
// fetch), storage (ledger append, spend lookup, cassettes) and config; this module supplies the rules:
//   route resolution and data policy -> budget and loop checks -> provider chain with fallback ->
//   Claude max_tokens retry (once, cap doubled) -> refusal = needs review, no other vendor ->
//   JSON parse and schema validation -> one ledger row per attempt, priced from the served model.
//
// Provider adapter contract: async (call) => response
//   call     = { provider, model, effort, task, kind, system, user, messages, images, schema, tools, maxTokens,
//                attempt, cassetteKey, signal, ctx, claude?: { params, betas, stream } }
//   response = { servedModel, text, data?, content?, stopReason, stopDetails?, usage }
//   stopReason uses Claude's words: end_turn | max_tokens | refusal | tool_use (adapters map 'length' -> max_tokens).
//   Adapters throw errors carrying `status` (HTTP) or `code`; classifyError() decides fallback.

import { BUDGET_RULES } from './constants.js';
import {
  BudgetExceededError,
  InvalidRequestError,
  LoopDetectedError,
  MaxTokensError,
  ProviderDeadError,
  RefusalError,
  SchemaValidationError,
  classifyError,
  isAbortError,
} from './errors.js';
import { assertNotRefused, buildClaudeRequest, claudeMaxTokens, shouldRetryMaxTokens, toolResultMessage, toolUseBlocks } from './claude-shape.js';
import { cassetteKey, cassetteRecord } from './cassette.js';
import { createLoopDetector, estimateInputTokens, estimateOutputTokens, evaluateBudget, expectedCostUsd, loopScopeOf, periodicScopesFor } from './budget.js';
import { parseJsonOutput } from './json.js';
import { buildLedgerRow } from './ledger-row.js';
import { estimateCallUsd } from './prices.js';
import { createRouter } from './route.js';
import { formatRouteEntry } from './route-string.js';
import { getTask } from './tasks-schema.js';
import { IMAGE_RULES } from './images.js';

/** Parsed JSON of a response: the adapter's `data` when it has one (replay, Gemini), else the text. Validated against the schema. */
function readJsonData(response, schema) {
  const raw = response?.data;
  if (raw === undefined) return parseJsonOutput(response?.text, schema);
  if (schema) parseJsonOutput(JSON.stringify(raw), schema);
  return raw;
}

function outcomeKeyOf(result, error) {
  if (error) return `error:${error.code || error.status || error.name}`;
  return `ok:${result?.text?.length || 0}:${String(result?.text || '').slice(0, 200)}`;
}

function nowMs(clock) {
  const value = clock();
  return value instanceof Date ? value.getTime() : Number(value) || Date.now();
}

function isoAt(clock) {
  return new Date(nowMs(clock)).toISOString();
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && isAbortError(reason)) return reason;
  const error = new Error('The caller aborted the LLM call.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

/** The scaled budget scope of a call: ctx.budgetScope, else devSession (sessionId) or run (runId), else none. */
function scaledScopeOf(ctx) {
  if (ctx.budgetScope) return ctx.budgetScope;
  if (ctx.sessionId) return 'devSession';
  if (ctx.runId) return 'run';
  return null;
}

/** The id the in-memory spend tally uses for a scope. */
function scopeIdOf(scope, ctx) {
  if (scope === 'devSession' || scope === 'iteration') return ctx.sessionId || ctx.taskId || ctx.jobId || '';
  if (scope === 'run') return ctx.runId || '';
  return ctx.runId || ctx.sessionId || ctx.jobId || ctx.taskId || '';
}

/**
 * @param {object} options
 * @param {object} options.tasks       parsed task registry (parseTaskRegistry)
 * @param {object} options.routes      ai-routes config
 * @param {object} options.policy      ai-policy config
 * @param {object} [options.budgets]   ai-budgets config
 * @param {object} [options.env]       env map (AI_PROFILE, AI_ROUTE_*); the core never reads the process environment
 * @param {Record<string, Function>} options.providers adapters by provider name
 * @param {{append:Function}} [options.ledger]
 * @param {Function} [options.spentUsd]  async ({scope, ctx, task}) => USD already spent in that scope. Scopes:
 *   run | devSession | iteration | <budgetScope> (scaled) and clientMonth | makerDay | hubDay | eval (periodic).
 *   Without it the core keeps an in-process tally per run/session (scaled scopes only).
 * @param {Function} [options.onAlert]   (info) => void, budget alerts (work continues)
 * @param {{save:Function}} [options.cassettes]  record profile: save(record)
 * @param {Function} [options.legacyRoute]
 * @param {string} [options.repo]  'maker' | 'hub' (picks the makerDay / hubDay periodic budget)
 */
export function createLlmCore(options = {}) {
  const { providers = {}, ledger = null, spentUsd = null, onAlert = null, cassettes = null, budgets = null, repo = '', clock = () => new Date() } = options;
  const loopDetector = options.loopDetector || createLoopDetector({ ...(budgets?.loop || {}), now: () => nowMs(clock) });
  const router = createRouter(options);
  const dead = new Set();
  // In-process spend per scaled scope, used when the facade gives no spentUsd (bounded LRU).
  const tally = new Map();
  const addSpend = (key, usd) => {
    if (!key || !(usd > 0)) return;
    const total = (tally.get(key) || 0) + usd;
    tally.delete(key);
    tally.set(key, total);
    if (tally.size > 5000) tally.delete(tally.keys().next().value);
  };

  const alert = (info) => {
    if (typeof onAlert !== 'function') return;
    try {
      onAlert(info);
    } catch {
      // Alerts never break a call.
    }
  };

  const appendRow = async (row) => {
    if (!ledger?.append) return;
    try {
      await ledger.append(row);
    } catch {
      // The ledger never breaks a call.
    }
  };

  /**
   * Scaled scope (run / devSession / iteration / ctx.budgetScope): expected cost from ctx.expectedUsd, else from
   * the budgets config with ctx.projectSize (no size = one reference project, so the runaway stop is never off).
   * Periodic scopes alert only.
   */
  async function budgetCheck({ task, route, request, ctx }) {
    const scope = scaledScopeOf(ctx);
    const tallyKey = scope ? `${scope}:${scopeIdOf(scope, ctx)}` : '';
    const empty = { scope, tallyKey, expectedUsd: null, decision: null, periodic: [] };
    if (route.primary.provider === 'replay') return empty;
    let expected = ctx.expectedUsd ?? null;
    const sizeKnown = expected !== null || Boolean(ctx.projectSize);
    if (expected === null && budgets && scope) expected = expectedCostUsd(budgets, scope, { tier: ctx.tier, projectSize: ctx.projectSize || {} });
    const periodicScopes = budgets && typeof spentUsd === 'function' ? periodicScopesFor(budgets, { ctx, task, repo }) : [];
    if (!(expected > 0) && !periodicScopes.length) return { ...empty, expectedUsd: expected };

    const inputTokens = estimateInputTokens({ system: request.system, user: request.user, messages: request.messages, images: request.images?.length || 0 });
    const maxTokens = route.primary.provider === 'claude' ? claudeMaxTokens({ requested: request.maxTokens, taskMaxTokens: route.maxTokens }) : request.maxTokens || route.maxTokens;
    const estimate = estimateCallUsd({ model: route.primary.model, inputTokens, outputTokens: estimateOutputTokens(maxTokens) });
    const alertRatio = budgets?.alertRatio ?? BUDGET_RULES.alertRatio;
    const runawayFactor = budgets?.runawayFactor ?? BUDGET_RULES.runawayFactor;

    let decision = null;
    let spent = null;
    if (expected > 0) {
      spent = typeof spentUsd === 'function' ? Number(await spentUsd({ scope, ctx, task })) || 0 : tally.get(tallyKey) || 0;
      decision = { ...evaluateBudget({ expectedUsd: expected, spentUsd: spent, estimateUsd: estimate, alertRatio, runawayFactor }), sizeKnown };
    }
    const periodic = [];
    for (const item of periodicScopes) {
      const periodSpent = Number(await spentUsd({ scope: item.scope, ctx, task })) || 0;
      const verdict = evaluateBudget({ expectedUsd: item.capUsd, spentUsd: periodSpent, estimateUsd: estimate, alertRatio, runawayFactor, mode: BUDGET_RULES.periodicScopesMode });
      if (verdict.action === 'alert') periodic.push({ scope: item.scope, key: item.key, ...verdict });
    }
    return { scope, tallyKey, expectedUsd: expected, spentUsd: spent, estimateUsd: estimate, decision, periodic };
  }

  async function attemptEntry({ entry, index, route, request, ctx, key, fallbackFrom }) {
    const adapter = providers[entry.provider];
    if (typeof adapter !== 'function') throw new ProviderDeadError(`No adapter for provider "${entry.provider}".`, { provider: entry.provider });
    const rows = [];
    let attempt = 1;
    let maxTokens = entry.provider === 'claude' ? claudeMaxTokens({ requested: request.maxTokens, taskMaxTokens: route.maxTokens }) : request.maxTokens || route.maxTokens;
    for (;;) {
      const call = {
        provider: entry.provider,
        model: entry.model,
        effort: entry.effort,
        task: route.task,
        kind: route.kind,
        system: request.system,
        user: request.user,
        messages: request.messages,
        images: request.images,
        schema: request.schema,
        tools: request.tools,
        maxTokens,
        attempt,
        cassetteKey: key,
        signal: request.signal,
        ctx,
      };
      if (entry.provider === 'claude') {
        call.claude = buildClaudeRequest({ ...call, taskMaxTokens: route.maxTokens, maxTokens: request.maxTokens, attempt, toolChoice: request.toolChoice });
        call.maxTokens = call.claude.maxTokens;
      }
      const started = nowMs(clock);
      let response;
      try {
        response = await adapter(call);
      } catch (error) {
        const row = buildLedgerRow({
          at: isoAt(clock),
          repo,
          task: route.task,
          provider: entry.provider,
          requestedModel: entry.model,
          effort: entry.effort,
          profile: route.profile,
          ctx,
          images: request.images?.length || 0,
          latencyMs: nowMs(clock) - started,
          status: 'error',
          attempt,
          maxTokens: call.maxTokens,
          fallbackFrom,
          policyRedirect: route.policyRedirects[0] || null,
          error,
        });
        await appendRow(row);
        rows.push(row);
        error.ledgerRows = rows;
        throw error;
      }
      const stopReason = String(response?.stopReason || '');
      const refused = stopReason === 'refusal';
      let status = refused ? 'refusal' : stopReason === 'max_tokens' ? 'max_tokens' : 'ok';
      // JSON tasks: parse and validate before the row is written, so a bad answer is logged as schema_invalid.
      let data;
      let parseError = null;
      if (status === 'ok' && route.kind === 'json') {
        try {
          data = readJsonData(response, request.schema);
        } catch (error) {
          parseError = error;
          status = 'schema_invalid';
        }
      }
      const row = buildLedgerRow({
        at: isoAt(clock),
        repo,
        task: route.task,
        provider: entry.provider,
        requestedModel: entry.model,
        servedModel: response?.servedModel || entry.model,
        effort: entry.effort,
        profile: route.profile,
        ctx,
        usage: response?.usage || {},
        response: entry.provider === 'claude' ? { model: response?.servedModel || entry.model, usage: response?.usage || {} } : null,
        images: request.images?.length || 0,
        latencyMs: nowMs(clock) - started,
        status,
        stopReason,
        attempt,
        maxTokens: call.maxTokens,
        fallbackFrom,
        policyRedirect: route.policyRedirects[0] || null,
        needsReview: refused,
      });
      await appendRow(row);
      rows.push(row);
      if (refused) {
        try {
          assertNotRefused(response, { model: entry.model, task: route.task });
        } catch (error) {
          error.ledgerRows = rows;
          throw error;
        }
      }
      if (shouldRetryMaxTokens(stopReason, attempt, entry.provider)) {
        attempt += 1;
        maxTokens = Math.min(128000, call.maxTokens * 2);
        continue;
      }
      if (stopReason === 'max_tokens') {
        const error = new MaxTokensError(`Output hit max_tokens (${call.maxTokens})${entry.provider === 'claude' ? ' after the doubled retry' : ''}.`, { model: entry.model, maxTokens: call.maxTokens });
        error.ledgerRows = rows;
        throw error;
      }
      if (parseError) {
        parseError.ledgerRows = rows;
        throw parseError;
      }
      return { response, rows, attempt, entry, index, data };
    }
  }

  async function runChain({ route, request, ctx, key }) {
    const failures = [];
    const allRows = [];
    let fallbackFrom = null;
    let lastError = null;
    for (let index = 0; index < route.chain.length; index += 1) {
      const entry = route.chain[index];
      const label = formatRouteEntry(entry);
      if (request.signal?.aborted) throw Object.assign(abortError(request.signal), { failures });
      if (dead.has(entry.provider)) {
        failures.push({ entry: label, code: 'provider_dead', skipped: true });
        continue;
      }
      let result;
      try {
        result = await attemptEntry({ entry, index, route, request, ctx, key, fallbackFrom });
      } catch (error) {
        allRows.push(...(error.ledgerRows || []));
        const verdict = request.signal?.aborted ? { kind: 'aborted', fallback: false, dead: false } : classifyError(error);
        failures.push({ entry: label, code: error.code || verdict.kind, status: error.status || null });
        if (verdict.dead) dead.add(entry.provider);
        if (!verdict.fallback) throw Object.assign(error, verdict.kind === 'aborted' ? { failures, allRows, aborted: true } : { failures, allRows });
        fallbackFrom = label;
        lastError = error;
        continue;
      }
      allRows.push(...result.rows);
      return { ...result, failures, allRows };
    }
    if (lastError) throw Object.assign(lastError, { failures, allRows });
    throw new ProviderDeadError(`Every provider for "${route.task}" is unavailable.`, { failures, allRows });
  }

  /**
   * One LLM call. request = { task, system?, user?, messages?, images?, schema?, tools?, toolChoice?, maxTokens?, ctx?, signal?, data? }
   * `data` is the structured payload used only for the person-field check (it is not sent).
   * @returns {Promise<{data?, text, content, stopReason, servedModel, provider, model, usage, route, attempts, needsReview:false}>}
   */
  async function callLlm(request = {}) {
    const spec = getTask(router.tasks, request.task);
    const images = Array.isArray(request.images) ? request.images.filter(Boolean) : [];
    if (images.length && !spec.vision) throw new InvalidRequestError(`Task "${request.task}" is not a vision task; images are not allowed.`);
    if (images.length > IMAGE_RULES.maxImages) throw new InvalidRequestError(`${images.length} images in one call; the limit is ${IMAGE_RULES.maxImages}.`);
    // Everything that is sent (and request.data) is checked for person fields; the system prompt can carry client facts too.
    const payload = { system: request.system, user: request.user, data: request.data, messages: request.messages };
    const route = router.resolveRoute(request.task, request.ctx || {}, { payload });
    const ctx = route.ctx;
    if (images.length && !route.vision) throw new InvalidRequestError('ctx.vision is false, so this call may not carry images.');
    const req = { ...request, images };
    const key = cassetteKey({ task: request.task, system: request.system, user: request.user, messages: request.messages, images, schema: request.schema, tools: request.tools });
    // Loops are only detected inside an explicit scope (run, session, job or task) and a time window: the
    // same request on another day, or from unrelated hub requests, is never a loop.
    const loopScope = loopScopeOf(ctx);
    const loopKey = loopScope ? `${loopScope}:${key}` : '';

    if (loopKey) {
      const loop = loopDetector.before(request.task, loopKey);
      if (loop.loop) {
        const error = new LoopDetectedError(`"${request.task}" repeated ${loop.count} times with no progress; stopped.`, { task: request.task, count: loop.count, loopReason: loop.reason });
        await appendRow(buildLedgerRow({ at: isoAt(clock), repo, task: request.task, provider: route.primary.provider, requestedModel: route.primary.model, profile: route.profile, ctx, status: 'loop_blocked', error }));
        throw error;
      }
    }

    const budget = await budgetCheck({ task: request.task, route, request: req, ctx });
    if (budget.decision?.action === 'stop') {
      const factor = budgets?.runawayFactor ?? BUDGET_RULES.runawayFactor;
      const error = new BudgetExceededError(
        `Runaway spend on "${request.task}": projected $${budget.decision.projectedUsd.toFixed(4)} is over ${factor}x the expected $${budget.expectedUsd.toFixed(4)}${budget.decision.sizeKnown ? '' : ' (no project size given: one reference project)'}.`,
        { scope: budget.scope, expectedUsd: budget.expectedUsd, spentUsd: budget.spentUsd, estimateUsd: budget.estimateUsd, sizeKnown: budget.decision.sizeKnown },
      );
      await appendRow(
        buildLedgerRow({ at: isoAt(clock), repo, task: request.task, provider: route.primary.provider, requestedModel: route.primary.model, profile: route.profile, ctx, status: 'budget_blocked', budget: { scope: budget.scope, ...budget.decision }, error }),
      );
      throw error;
    }
    if (budget.decision?.action === 'alert') alert({ task: request.task, scope: budget.scope, periodic: false, ctx, ...budget.decision });
    for (const item of budget.periodic) alert({ task: request.task, periodic: true, ctx, ...item });

    const spend = (rows) => addSpend(budget.tallyKey, (rows || []).reduce((sum, row) => sum + (Number(row?.usd) || 0), 0));
    let result;
    try {
      result = await runChain({ route, request: req, ctx, key });
    } catch (error) {
      spend(error.allRows || error.ledgerRows);
      if (loopKey && !isAbortError(error) && !error.aborted) loopDetector.after(request.task, loopKey, outcomeKeyOf(null, error));
      throw error;
    }
    spend(result.allRows);
    if (loopKey) loopDetector.after(request.task, loopKey, outcomeKeyOf(result.response, null));
    if (route.record && cassettes?.save) {
      try {
        await cassettes.save(cassetteRecord({ key, task: request.task, provider: result.entry.provider, model: result.entry.model, response: { ...result.response, data: result.data }, recordedAt: isoAt(clock) }));
      } catch {
        // A failed recording never breaks a call.
      }
    }
    return {
      data: result.data,
      text: result.response.text ?? '',
      content: result.response.content,
      stopReason: result.response.stopReason,
      servedModel: result.response.servedModel || result.entry.model,
      provider: result.entry.provider,
      model: result.entry.model,
      usage: result.response.usage || {},
      usd: result.allRows.reduce((sum, row) => sum + row.usd, 0),
      route,
      attempts: result.failures.length + result.rows.length,
      failures: result.failures,
      budget: budget.decision,
      budgetAlerts: budget.periodic,
      cassetteKey: key,
      needsReview: false,
    };
  }

  const json = async (request = {}) => {
    const spec = getTask(router.tasks, request.task);
    if (spec.kind !== 'json') throw new InvalidRequestError(`Task "${request.task}" is kind ${spec.kind}; use ${spec.kind === 'tools' ? 'tools' : 'text'}().`);
    return callLlm(request);
  };
  const text = async (request = {}) => {
    const spec = getTask(router.tasks, request.task);
    if (spec.kind !== 'text') throw new InvalidRequestError(`Task "${request.task}" is kind ${spec.kind}; use ${spec.kind}().`);
    return callLlm(request);
  };

  /**
   * Tool loop (Claude-shaped messages). Calls onToolUse(blocks) for each tool_use turn and appends the
   * results until the model ends its turn or maxTurns is reached. Each turn is one callLlm (ledger, budget, loop).
   */
  async function tools({ task, system, messages = [], tools: toolDefs = [], maxTurns = 8, onToolUse, ctx, signal, toolChoice } = {}) {
    const spec = getTask(router.tasks, task);
    if (spec.kind !== 'tools') throw new InvalidRequestError(`Task "${task}" is kind ${spec.kind}; use ${spec.kind}().`);
    if (typeof onToolUse !== 'function') throw new InvalidRequestError('tools() needs onToolUse(blocks) => results.');
    const history = messages.map((m) => ({ ...m }));
    let last = null;
    let turns = 0;
    for (; turns < maxTurns; turns += 1) {
      last = await callLlm({ task, system, messages: history, tools: toolDefs, ctx, signal, toolChoice });
      const calls = toolUseBlocks(last.content);
      if (last.stopReason !== 'tool_use' || !calls.length) return { ...last, messages: history, turns: turns + 1 };
      history.push({ role: 'assistant', content: last.content });
      const results = await onToolUse(calls);
      history.push(toolResultMessage(Array.isArray(results) ? results : []));
    }
    return { ...last, messages: history, turns, maxTurnsReached: true };
  }

  return Object.freeze({
    callLlm,
    json,
    text,
    tools,
    resolveRoute: router.resolveRoute,
    routeFor: router.routeFor,
    markProviderDead: (provider) => dead.add(provider),
    deadProviders: () => [...dead],
    warnings: router.warnings,
    router,
  });
}

export { RefusalError, SchemaValidationError };
