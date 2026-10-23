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
} from './errors.js';
import { assertNotRefused, buildClaudeRequest, claudeMaxTokens, shouldRetryMaxTokens, toolResultMessage, toolUseBlocks } from './claude-shape.js';
import { cassetteKey, cassetteRecord } from './cassette.js';
import { createLoopDetector, estimateInputTokens, estimateOutputTokens, evaluateBudget, expectedCostUsd } from './budget.js';
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

/**
 * @param {object} options
 * @param {object} options.tasks       parsed task registry (parseTaskRegistry)
 * @param {object} options.routes      ai-routes config
 * @param {object} options.policy      ai-policy config
 * @param {object} [options.budgets]   ai-budgets config
 * @param {object} [options.env]       env map (AI_PROFILE, AI_ROUTE_*); the core never reads the process environment
 * @param {Record<string, Function>} options.providers adapters by provider name
 * @param {{append:Function}} [options.ledger]
 * @param {Function} [options.spentUsd]  async ({scope, ctx}) => USD already spent in that scope
 * @param {Function} [options.onAlert]   (info) => void, budget alerts (work continues)
 * @param {{save:Function}} [options.cassettes]  record profile: save(record)
 * @param {Function} [options.legacyRoute]
 * @param {string} [options.repo]
 */
export function createLlmCore(options = {}) {
  const {
    providers = {},
    ledger = null,
    spentUsd = null,
    onAlert = null,
    cassettes = null,
    budgets = null,
    repo = '',
    clock = () => new Date(),
    loopDetector = createLoopDetector(),
  } = options;
  const router = createRouter(options);
  const dead = new Set();

  const appendRow = async (row) => {
    if (!ledger?.append) return;
    try {
      await ledger.append(row);
    } catch {
      // The ledger never breaks a call.
    }
  };

  async function budgetCheck({ task, route, request, ctx }) {
    const scope = ctx.budgetScope || (ctx.sessionId ? 'devSession' : 'run');
    let expected = ctx.expectedUsd ?? null;
    if (expected === null && budgets && ctx.projectSize) expected = expectedCostUsd(budgets, scope, { tier: ctx.tier, projectSize: ctx.projectSize });
    if (!(expected > 0) || typeof spentUsd !== 'function' || route.primary.provider === 'replay') return { scope, expectedUsd: expected, decision: null };
    const inputTokens = estimateInputTokens({ system: request.system, user: request.user, messages: request.messages, images: request.images?.length || 0 });
    const maxTokens = route.primary.provider === 'claude' ? claudeMaxTokens({ requested: request.maxTokens, taskMaxTokens: route.maxTokens }) : request.maxTokens || route.maxTokens;
    const estimate = estimateCallUsd({ model: route.primary.model, inputTokens, outputTokens: estimateOutputTokens(maxTokens) });
    const spent = Number(await spentUsd({ scope, ctx, task })) || 0;
    const decision = evaluateBudget({
      expectedUsd: expected,
      spentUsd: spent,
      estimateUsd: estimate,
      alertRatio: budgets?.alertRatio ?? BUDGET_RULES.alertRatio,
      runawayFactor: budgets?.runawayFactor ?? BUDGET_RULES.runawayFactor,
    });
    return { scope, expectedUsd: expected, spentUsd: spent, estimateUsd: estimate, decision };
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
      if (shouldRetryMaxTokens(stopReason, attempt)) {
        attempt += 1;
        maxTokens = Math.min(entry.provider === 'claude' ? 128000 : Infinity, call.maxTokens * 2);
        continue;
      }
      if (stopReason === 'max_tokens') {
        const error = new MaxTokensError(`Output hit max_tokens (${call.maxTokens}) after the doubled retry.`, { model: entry.model, maxTokens: call.maxTokens });
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
    let fallbackFrom = null;
    let lastError = null;
    for (let index = 0; index < route.chain.length; index += 1) {
      const entry = route.chain[index];
      const label = formatRouteEntry(entry);
      if (dead.has(entry.provider)) {
        failures.push({ entry: label, code: 'provider_dead', skipped: true });
        continue;
      }
      let result;
      try {
        result = await attemptEntry({ entry, index, route, request, ctx, key, fallbackFrom });
      } catch (error) {
        const verdict = classifyError(error);
        failures.push({ entry: label, code: error.code || verdict.kind, status: error.status || null });
        if (verdict.dead) dead.add(entry.provider);
        if (!verdict.fallback) throw Object.assign(error, { failures });
        fallbackFrom = label;
        lastError = error;
        continue;
      }
      return { ...result, failures };
    }
    if (lastError) throw Object.assign(lastError, { failures });
    throw new ProviderDeadError(`Every provider for "${route.task}" is unavailable.`, { failures });
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
    const payload = { user: request.user, data: request.data, messages: request.messages };
    const route = router.resolveRoute(request.task, request.ctx || {}, { payload });
    const ctx = route.ctx;
    if (images.length && !route.vision) throw new InvalidRequestError('ctx.vision is false, so this call may not carry images.');
    const req = { ...request, images };
    const key = cassetteKey({ task: request.task, system: request.system, user: request.user, messages: request.messages, images, schema: request.schema, tools: request.tools });
    const loopKey = `${ctx.runId || ctx.sessionId || ''}:${key}`;

    const loop = loopDetector.before(request.task, loopKey);
    if (loop.loop) {
      const error = new LoopDetectedError(`"${request.task}" repeated ${loop.count} times with no progress; stopped.`, { task: request.task, count: loop.count });
      await appendRow(buildLedgerRow({ at: isoAt(clock), repo, task: request.task, provider: route.primary.provider, requestedModel: route.primary.model, profile: route.profile, ctx, status: 'loop_blocked', error }));
      throw error;
    }

    const budget = await budgetCheck({ task: request.task, route, request: req, ctx });
    if (budget.decision?.action === 'stop') {
      const error = new BudgetExceededError(
        `Runaway spend on "${request.task}": projected $${budget.decision.projectedUsd.toFixed(4)} is over ${BUDGET_RULES.runawayFactor}x the expected $${budget.expectedUsd.toFixed(4)}.`,
        { scope: budget.scope, expectedUsd: budget.expectedUsd, spentUsd: budget.spentUsd, estimateUsd: budget.estimateUsd },
      );
      await appendRow(
        buildLedgerRow({ at: isoAt(clock), repo, task: request.task, provider: route.primary.provider, requestedModel: route.primary.model, profile: route.profile, ctx, status: 'budget_blocked', budget: { scope: budget.scope, ...budget.decision }, error }),
      );
      throw error;
    }
    if (budget.decision?.action === 'alert' && typeof onAlert === 'function') {
      try {
        onAlert({ task: request.task, scope: budget.scope, ctx, ...budget.decision });
      } catch {
        // Alerts never break a call.
      }
    }

    let result;
    try {
      result = await runChain({ route, request: req, ctx, key });
    } catch (error) {
      loopDetector.after(request.task, loopKey, outcomeKeyOf(null, error));
      throw error;
    }
    loopDetector.after(request.task, loopKey, outcomeKeyOf(result.response, null));
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
      usd: result.rows.reduce((sum, row) => sum + row.usd, 0),
      route,
      attempts: result.failures.length + result.rows.length,
      failures: result.failures,
      budget: budget.decision,
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
