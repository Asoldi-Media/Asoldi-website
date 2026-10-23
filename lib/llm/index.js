/**
 * Hub LLM facade on the shared core (packages/suite/core/llm, contract 1.2.0).
 *
 *   json({task, system, user, images, schema, maxTokens, ctx, data, signal, legacy})
 *   text({...})                  free text
 *   turn({task, system, messages, tools, maxTokens, ctx, legacy})   one Claude-shaped tool turn
 *   tools({task, system, messages, tools, maxTurns, onToolUse, onEndTurn, ctx})   tool loop
 *   native({task, provider, ctx, legacy, run, payload})   provider-specific call (grounded search, video)
 *   callLlm(request)             the core call (non-legacy profiles)
 *   routeFor(task, ctx) === resolveRoute(task, ctx)
 *   status(), spend(query), configuredFor(task), setRoutesOverride(body, by), reload()
 *
 * Profiles. `legacy` (the default) ships dark: a call that brings its `legacy` descriptor (every
 * migrated call site does) runs today's provider request unchanged, and the facade only records it in
 * the ledger (with the route the prod profile would take, as `shadowRoute`). Any other profile, chosen
 * by the data override or env AI_PROFILE, routes through the core: per-task routes, the data policy
 * (transcripts and personal data never reach DeepSeek), budgets, refusal handling and the ledger.
 *
 * Every provider call, legacy or not, goes through the hub safe-mode guard (aiCalls).
 */
import * as core from '../../packages/suite/core/llm/index.js';
import { getPersistentDataDir } from '../../data/storage-path.js';
import { writeJsonAtomic } from '../../data/atomic-json.js';
import { claudeLegacyMessages, readAnthropicConfig, runToolLoop } from '../claude-messages.js';
import { JSON_ONLY_SUFFIX } from '../deepseek.js';
import { guardAiCall } from '../safe-mode-ai.js';
import { isSafeModeActive, safeModeAllows } from '../safe-mode.js';
import {
  LEGACY_TASKS,
  ROUTES_OVERRIDE_FILE,
  legacyEntryFor,
  legacyRouteFor,
  loadHubLlmConfig,
  mergeRoutes,
  overridesChanged,
  routesOverrideProblems,
} from './config.js';
import { createHealth, providerKeyConfigured } from './health.js';
import { createHubLedger } from './ledger.js';
import { createClaudeAdapter } from './providers/claude.js';
import { createDeepseekAdapter } from './providers/deepseek.js';
import { createGeminiAdapter } from './providers/gemini.js';
import { createCassetteStore, createReplayAdapter } from './providers/replay.js';
import { join } from 'node:path';

const PROD_PROFILE = 'prod';

function clean(value) {
  return String(value ?? '').trim();
}

function ctxForRow(ctx) {
  try {
    return core.normalizeCtx(ctx || {}).ctx;
  } catch {
    return {};
  }
}

function snakeUsage(usage = {}) {
  const u = core.normalizeUsage(usage);
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_read_input_tokens: u.cacheReadTokens,
    cache_creation_input_tokens: u.cacheWrite5mTokens + u.cacheWrite1hTokens,
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.dataDir]   default: the hub's persistent data dir
 * @param {object} [options.env]       read live (keys, AI_PROFILE, AI_ROUTE_*); default process.env
 * @param {object} [options.providers] adapter overrides by provider name (tests)
 * @param {Function} [options.fetch]   fetch for the Claude SDK and DeepSeek adapters (tests)
 * @param {object} [options.anthropicClient] / [options.geminiClient]  ready clients (tests)
 */
export function createHubLlm(options = {}) {
  const {
    dataDir = getPersistentDataDir(),
    env = process.env,
    providers: providerOverrides = {},
    fetch: fetchImpl = null,
    anthropicClient = null,
    geminiClient = null,
    clock = () => new Date(),
    log = console,
  } = options;
  const ledger = options.ledger || createHubLedger({ dataDir, clock, log });
  const health = options.health || createHealth({ env });
  const cassettes = createCassetteStore({ dataDir });
  const adapters = {
    claude: createClaudeAdapter({ env, fetch: fetchImpl, client: anthropicClient }),
    deepseek: createDeepseekAdapter({ env, fetch: fetchImpl }),
    gemini: createGeminiAdapter({ env, client: geminiClient }),
    replay: createReplayAdapter({ store: cassettes }),
    ...providerOverrides,
  };
  const warnedAlerts = new Set();
  const iso = () => {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  };

  function onAlert(info = {}) {
    const entry = ledger.recordAlert(info);
    const key = `${entry.scope}:${entry.salesClientId}:${entry.at.slice(0, 10)}`;
    if (!warnedAlerts.has(key)) {
      warnedAlerts.add(key);
      log?.warn?.(`[ai] budget alert: ${entry.scope}${entry.salesClientId ? ` (${entry.salesClientId})` : ''} projected $${entry.projectedUsd.toFixed(4)} of $${entry.expectedUsd.toFixed(4)}; work continues`);
    }
  }

  function build() {
    const config = loadHubLlmConfig({ dataDir, env, now: new Date(iso()) });
    const coreOptions = {
      ...config,
      providers: adapters,
      ledger: { append: (row) => ledger.append(row) },
      spentUsd: (args) => ledger.spentUsd(args),
      onAlert,
      cassettes,
      legacyRoute: legacyRouteFor(env),
      repo: 'hub',
      unknownTasks: 'warn',
      clock,
    };
    try {
      return { config, core: core.createLlmCore(coreOptions), error: '' };
    } catch (error) {
      // A bad AI_ROUTE_* env value: keep the hub up on the config without env routes.
      const message = clean(error?.message).slice(0, 1000) || 'LLM core failed to build';
      try {
        return { config: { ...config, env: { AI_PROFILE: config.profile } }, core: core.createLlmCore({ ...coreOptions, env: { AI_PROFILE: config.profile } }), error: message };
      } catch {
        return { config, core: null, error: message };
      }
    }
  }

  let state = build();
  function current() {
    if (overridesChanged(state.config)) state = build();
    return state;
  }

  function taskSpec(task) {
    return core.getTask(current().config.tasks, task);
  }

  function isPassthrough(st, request) {
    return st.config.profile === 'legacy' && typeof request?.legacy?.run === 'function';
  }

  function payloadOf(request) {
    return { system: request.system, user: request.user, data: request.data, messages: request.messages };
  }

  /** The route the prod profile would take for this call (data policy included), for the ledger and status. */
  function shadowRoute(st, task, ctx, payload) {
    if (!st.core) return '';
    try {
      return st.core.resolveRoute(task, { ...ctxForRow(ctx), profile: PROD_PROFILE }, payload ? { payload } : {}).route;
    } catch (error) {
      return error?.code === 'policy_blocked' ? 'policy_blocked' : '';
    }
  }

  function periodicAlerts(st, task, ctx) {
    const budgets = st.config.budgets;
    for (const item of core.periodicScopesFor(budgets, { ctx, task, repo: 'hub' })) {
      const spent = Number(ledger.spentUsd({ scope: item.scope, ctx, task })) || 0;
      const verdict = core.evaluateBudget({ expectedUsd: item.capUsd, spentUsd: spent, estimateUsd: 0, mode: 'alert-only' });
      if (verdict.action === 'alert') onAlert({ task, periodic: true, ctx, scope: item.scope, ...verdict });
    }
  }

  /**
   * Today's request, run as is, recorded as one ledger row. Errors are recorded and rethrown unchanged,
   * so call sites see exactly what they saw before the facade.
   */
  async function passthrough(st, request, { images = 0 } = {}) {
    const { task, legacy } = request;
    const ctx = ctxForRow(request.ctx);
    const started = Date.now();
    let out;
    let failure = null;
    try {
      out = await legacy.run();
    } catch (error) {
      failure = error;
    }
    const servedModel = clean(out?.servedModel || out?.model) || clean(legacy.model);
    const stopReason = clean(out?.stopReason);
    const row = core.buildLedgerRow({
      at: iso(),
      repo: 'hub',
      task,
      provider: legacy.provider,
      requestedModel: legacy.model,
      servedModel,
      effort: legacy.effort || null,
      profile: 'legacy',
      ctx,
      usage: out?.usage || {},
      images: images || legacy.images || 0,
      latencyMs: Date.now() - started,
      status: failure ? 'error' : stopReason === 'refusal' ? 'refusal' : stopReason === 'max_tokens' ? 'max_tokens' : 'ok',
      stopReason,
      maxTokens: Number(request.maxTokens) || 0,
      error: failure,
    });
    row.passthrough = true;
    if (out?.guarded || out?.safeModeStub) row.safeMode = 'guarded';
    const shadow = shadowRoute(st, task, request.ctx, request.shadowPayload || payloadOf(request));
    if (shadow) row.shadowRoute = shadow;
    try {
      ledger.append(row);
      periodicAlerts(st, task, ctx);
    } catch {
      // the ledger never breaks a call
    }
    if (failure) throw failure;
    return { out: out || {}, row, servedModel };
  }

  async function prepareImages(images = []) {
    const list = Array.isArray(images) ? images.filter(Boolean) : [];
    const out = [];
    for (const image of list) {
      if (image.url) {
        out.push(image);
        continue;
      }
      const buffer = image.buffer ? Buffer.from(image.buffer) : image.base64 ? Buffer.from(String(image.base64).replace(/^data:[^,]*,/, ''), 'base64') : null;
      const size = buffer ? core.jpegSize(buffer) : null;
      const mime = clean(image.mime || image.media_type).toLowerCase();
      if (size && Math.max(size.width, size.height) <= core.IMAGE_RULES.maxLongEdge && (!mime || mime === 'image/jpeg')) {
        out.push({ mime: 'image/jpeg', base64: buffer.toString('base64') });
      } else {
        const prepared = await core.prepareImage(buffer || image);
        out.push({ mime: prepared.mime, base64: prepared.base64 });
      }
    }
    return out;
  }

  async function coreCall(kind, request) {
    const st = current();
    if (!st.core) throw new core.RouteConfigError(`The hub LLM core is not available: ${st.error}`);
    const { legacy, shadowPayload, ...rest } = request;
    const call = { ...rest };
    if (kind === 'json' && !request.schema && call.system !== undefined) call.system = `${call.system}\n\n${JSON_ONLY_SUFFIX}`;
    if (Array.isArray(call.images) && call.images.length) call.images = await prepareImages(call.images);
    return st.core[kind === 'call' ? 'callLlm' : kind](call);
  }

  async function runKind(kind, request = {}) {
    const spec = taskSpec(request.task);
    if (spec.kind !== kind) throw new core.InvalidRequestError(`Task "${request.task}" is kind ${spec.kind}; use ${spec.kind}().`);
    const st = current();
    if (isPassthrough(st, request)) {
      const { out, row, servedModel } = await passthrough(st, request, { images: request.images?.length || 0 });
      return {
        data: out.data,
        text: out.text ?? '',
        content: out.content,
        stopReason: out.stopReason || 'end_turn',
        servedModel,
        provider: request.legacy.provider,
        model: servedModel,
        usage: out.usage || {},
        usd: row.usd,
        route: routeView(st, request.task, request.ctx, request.legacy),
        passthrough: true,
        raw: out.raw,
        needsReview: false,
      };
    }
    return coreCall(kind, request);
  }

  const json = (request) => runKind('json', request);
  const text = (request) => runKind('text', request);

  async function callLlm(request = {}) {
    const spec = taskSpec(request.task);
    if (isPassthrough(current(), request)) return spec.kind === 'tools' ? turn(request) : runKind(spec.kind, request);
    return coreCall('call', request);
  }

  /** One Claude-shaped tool turn: { id, stopReason, content, usage, model }. */
  async function turn(request = {}) {
    const spec = taskSpec(request.task);
    if (spec.kind !== 'tools') throw new core.InvalidRequestError(`Task "${request.task}" is kind ${spec.kind}; turn() is for tool tasks.`);
    const st = current();
    if (isPassthrough(st, request)) {
      const { out, servedModel } = await passthrough(st, request);
      return { ...out, model: out.model || servedModel };
    }
    const result = await coreCall('call', { task: request.task, system: request.system, messages: request.messages, tools: request.tools, maxTokens: request.maxTokens, ctx: request.ctx, signal: request.signal });
    return { id: '', stopReason: result.stopReason, content: result.content || [], usage: snakeUsage(result.usage), model: result.servedModel };
  }

  /**
   * Tool loop (lib/claude-messages.js runToolLoop) with every turn through turn(). On the legacy profile
   * each turn is today's Claude request (ANTHROPIC_MODEL, ANTHROPIC_EFFORT, the tools as written).
   */
  async function tools({ task, ctx, system = '', messages = [], tools: defs = [], maxTurns = 8, maxTokens = 4096, onToolUse, onEndTurn, signal } = {}) {
    taskSpec(task);
    return runToolLoop({
      system,
      messages,
      tools: defs,
      maxTurns,
      maxTokens,
      onToolUse,
      onEndTurn,
      turn: (args) => {
        const config = readAnthropicConfig(env);
        return turn({
          task,
          ctx,
          signal,
          ...args,
          legacy: { provider: 'claude', model: config.model, effort: config.effort || 'medium', run: () => claudeLegacyMessages({ ...args, config }) },
        });
      },
    });
  }

  /**
   * A provider-specific call the core cannot shape (Gemini with Google Search grounding, Gemini video).
   * Legacy profile: today's call (request.legacy). Other profiles: runs `run(entry)` only when the task's
   * route, after the data policy, still has `provider`; otherwise throws code 'route_unavailable' and no
   * provider is called.
   */
  async function native(request = {}) {
    const { task, provider } = request;
    taskSpec(task);
    const st = current();
    if (isPassthrough(st, request)) {
      const { out, row, servedModel } = await passthrough(st, request);
      return { ...out, provider: request.legacy.provider, model: servedModel, usd: row.usd, passthrough: true };
    }
    if (!st.core) throw new core.RouteConfigError(`The hub LLM core is not available: ${st.error}`);
    const route = st.core.resolveRoute(task, request.ctx || {}, { payload: request.payload || {} });
    const entry = route.chain.find((item) => item.provider === provider);
    if (!entry || typeof request.run !== 'function') {
      throw Object.assign(new Error(`"${task}" needs ${provider}, which its route (${route.route}) does not allow for ${route.dataClass.effective} data.`), { code: 'route_unavailable', status: 503, route: route.route });
    }
    const started = Date.now();
    let out;
    let failure = null;
    try {
      out = await guardAiCall({
        provider,
        task,
        request: { task, model: entry.model, key: request.guardKey || '' },
        real: () => request.run(entry),
        fail: () => Object.assign(new Error(`${provider} is blocked by hub safe mode (HUB_SAFE_MODE_ALLOW=aiCalls).`), { code: 'safe_mode', status: 503 }),
      });
    } catch (error) {
      failure = error;
    }
    const row = core.buildLedgerRow({
      at: iso(),
      repo: 'hub',
      task,
      provider,
      requestedModel: entry.model,
      servedModel: clean(out?.servedModel) || entry.model,
      effort: entry.effort,
      profile: route.profile,
      ctx: route.ctx,
      usage: out?.usage || {},
      latencyMs: Date.now() - started,
      status: failure ? 'error' : 'ok',
      policyRedirect: route.policyRedirects[0] || null,
      error: failure,
    });
    try {
      ledger.append(row);
    } catch {
      // the ledger never breaks a call
    }
    if (failure) throw failure;
    return { ...out, provider, model: clean(out?.servedModel) || entry.model, usd: row.usd, route };
  }

  function routeView(st, task, ctx = {}, fallback = null) {
    const entry = legacyEntryFor(task, env) || { provider: clean(fallback?.provider), model: clean(fallback?.model), effort: fallback?.effort || null };
    const spec = core.getTask(st.config.tasks, task);
    return Object.freeze({
      task,
      kind: spec.kind,
      family: spec.family || null,
      vision: Boolean(spec.vision),
      profile: 'legacy',
      tier: null,
      source: 'legacy-passthrough',
      legacy: true,
      record: false,
      replay: false,
      escalation: Object.freeze({ requested: 0, applied: 0, available: 0, ceiling: null, exhausted: false }),
      dataClass: Object.freeze({ declared: spec.dataClass, call: null, effective: spec.dataClass, synthetic: false, redacted: false, reasons: Object.freeze([]) }),
      primary: Object.freeze({ provider: entry.provider, model: entry.model, effort: entry.effort }),
      fallbacks: Object.freeze([]),
      chain: Object.freeze([Object.freeze({ provider: entry.provider, model: entry.model, effort: entry.effort })]),
      route: [entry.provider, entry.model, entry.effort].filter(Boolean).join(':'),
      policyRedirects: Object.freeze([]),
      maxTokens: spec.maxTokens,
      warnings: Object.freeze(['legacy profile: today\'s provider runs unchanged; see shadowRoute for the prod route']),
      ignoredCtx: Object.freeze([]),
      ctx: Object.freeze(ctxForRow(ctx)),
      shadowRoute: shadowRoute(st, task, ctx, null),
    });
  }

  /**
   * The route a call takes. Legacy profile and a migrated task: today's provider (with the prod route as
   * shadowRoute). Otherwise the core's resolution, data policy included.
   */
  const resolveRoute = (task, ctx = {}, extra = {}) => {
    const st = current();
    core.getTask(st.config.tasks, task);
    if (st.config.profile === 'legacy' && LEGACY_TASKS[task] && !ctx?.profile) return routeView(st, task, ctx);
    if (!st.core) throw new core.RouteConfigError(`The hub LLM core is not available: ${st.error}`);
    return st.core.resolveRoute(task, ctx, extra);
  };

  function deadProviders() {
    return current().core?.deadProviders?.() || [];
  }

  /** Whether `task` can run now: today's key on the legacy profile, else a configured live provider on its route. */
  function configuredFor(task) {
    const st = current();
    if (!Object.prototype.hasOwnProperty.call(st.config.tasks, task)) return false;
    if (st.config.profile === 'legacy' && LEGACY_TASKS[task]) return Boolean(clean(env[LEGACY_TASKS[task].keyEnv]));
    if (!st.core) return false;
    let route;
    try {
      route = st.core.resolveRoute(task, {});
    } catch {
      return false;
    }
    const dead = new Set(deadProviders());
    return route.chain.some((entry) => providerKeyConfigured(entry.provider, env) && !dead.has(entry.provider));
  }

  function routesSummary(st) {
    return Object.entries(st.config.tasks).map(([task, spec]) => {
      const item = { task, kind: spec.kind, dataClass: spec.dataClass, vision: Boolean(spec.vision), owner: spec.owner || '' };
      try {
        const route = resolveRoute(task, {});
        item.route = route.route;
        item.source = route.source;
        item.shadowRoute = route.shadowRoute || '';
      } catch (error) {
        item.route = '';
        item.error = clean(error?.message).slice(0, 200);
      }
      item.configured = configuredFor(task);
      return item;
    });
  }

  async function status({ probe = false } = {}) {
    const st = current();
    const policy = st.config.policy || {};
    return {
      contract: core.LLM_CONTRACT.version,
      profile: st.config.profile,
      profileSource: st.config.profileSource,
      legacyPassthrough: st.config.profile === 'legacy',
      overrides: {
        routes: { ...st.config.overrides.routes, path: undefined, mtimeMs: undefined },
        budgets: { ...st.config.overrides.budgets, path: undefined, mtimeMs: undefined },
      },
      providers: await health.providers({ dead: deadProviders(), runProbe: Boolean(probe) }),
      gemini: { billingTier: policy.providers?.gemini?.billingTier || 'unknown', paidTierConfirmedAt: policy.providers?.gemini?.paidTierConfirmedAt || null },
      safeMode: { active: isSafeModeActive(), aiCallsAllowed: !isSafeModeActive() || safeModeAllows('aiCalls') },
      routes: routesSummary(st),
      spend: ledger.summary(),
      budgets: { periodic: { ...(st.config.budgets?.periodic || {}) }, alertRatio: st.config.budgets?.alertRatio ?? 1, runawayFactor: st.config.budgets?.runawayFactor ?? 5 },
      warnings: [...st.config.warnings, ...(st.core?.warnings || [])].slice(0, 50),
      error: st.error || '',
    };
  }

  /** Hub ledger spend in [from, to], grouped by task | client | provider | model | runId; plus the Maker's runs for one client. */
  function spend({ from = null, to = null, by = 'task', salesClientId = '' } = {}) {
    const key = { client: 'salesClientId', task: 'task', provider: 'provider', model: 'model', run: 'runId', runId: 'runId' }[by] || 'task';
    const clientId = clean(salesClientId);
    const rows = ledger.rows({ from, to }).filter((row) => !clientId || row.salesClientId === clientId);
    const hub = core.summarizeLedger(rows, key);
    const maker = clientId ? ledger.makerSpendFor(clientId, { from, to }) : null;
    return {
      from: from ? new Date(from).toISOString() : null,
      to: to ? new Date(to).toISOString() : null,
      by: key,
      salesClientId: clientId || null,
      hub: { totalUsd: hub.totalUsd, calls: hub.calls, groups: hub.groups },
      maker,
      totalUsd: Math.round((hub.totalUsd + (maker?.totalUsd || 0)) * 1e10) / 1e10,
    };
  }

  /**
   * Writes <dataDir>/ai-routes.override.json after validating it against the shared registry and prices.
   * body = { profile?: string|null, profiles?: { <profile>: { default?, vision?, tasks?, kinds?, escalate?, escalateKinds?, tiers? } } }
   * @returns {{ok:true, status} | {ok:false, errors:string[]}}
   */
  function setRoutesOverride(body = {}, { by = '' } = {}) {
    const st = current();
    const next = {
      version: 1,
      ...(body.profile ? { profile: core.normalizeProfile(body.profile) || clean(body.profile) } : {}),
      ...(body.profiles !== undefined ? { profiles: body.profiles } : {}),
    };
    const problems = routesOverrideProblems(next);
    if (!problems.length) {
      // The override replaces the previous one, so it is checked against the shared base routes.
      const check = core.validateRoutesConfig(mergeRoutes(baseRoutes(), next), {
        tasks: st.config.tasks,
        now: new Date(iso()),
        unknownTasks: 'warn',
        stalePrices: 'warn',
      });
      problems.push(...check.errors);
    }
    if (problems.length) return { ok: false, errors: problems };
    writeJsonAtomic(join(dataDir, ROUTES_OVERRIDE_FILE), { ...next, updatedAt: iso(), updatedBy: clean(by).slice(0, 120) });
    state = build();
    return { ok: true, profile: state.config.profile, profileSource: state.config.profileSource, warnings: state.config.warnings };
  }

  function reload() {
    state = build();
    return state.config.profile;
  }

  return Object.freeze({
    json,
    text,
    tools,
    turn,
    native,
    callLlm,
    resolveRoute,
    routeFor: resolveRoute,
    status,
    spend,
    configuredFor,
    setRoutesOverride,
    reload,
    ledger,
    profile: () => current().config.profile,
    deadProviders,
  });
}

let baseRoutesCache = null;
function baseRoutes() {
  if (!baseRoutesCache) baseRoutesCache = loadHubLlmConfig({ dataDir: '' }).routes;
  return baseRoutesCache;
}

let singleton = null;

/** The process-wide facade (server boot registers it in lib/llm-hooks.js). */
export function getHubLlm() {
  if (!singleton) singleton = createHubLlm();
  return singleton;
}
