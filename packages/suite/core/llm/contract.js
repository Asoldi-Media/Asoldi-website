// The frozen LLM contract (version 1.0.0). Both facades (Maker lib/ai-pipeline/_shared/llm and the hub's
// lib/llm) build on it, and both run runContractChecks() in their test suites. Changing anything here is a
// contract change: bump `version`, update CONTRACT.md and the pinned fingerprint in both repos' tests.

import { createHash } from 'node:crypto';
import {
  BUDGET_RULES,
  CLAUDE_MODELS,
  CLAUDE_RULES,
  DATA_CLASSES,
  EFFORTS,
  PROFILES,
  PROFILE_ALIASES,
  PROVIDERS,
  TASK_KINDS,
  TIERS,
} from './constants.js';
import { ERROR_CODES, RefusalError } from './errors.js';
import { LEDGER_FIELDS, LEDGER_STATUSES, LEDGER_VERSION } from './ledger-row.js';
import { CTX_FIELDS } from './route.js';
import { canonicalJson } from './cassette.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const ROUTE_RESULT_FIELDS = Object.freeze([
  'task',
  'kind',
  'family',
  'vision',
  'profile',
  'tier',
  'source',
  'legacy',
  'record',
  'replay',
  'escalation',
  'dataClass',
  'primary',
  'fallbacks',
  'chain',
  'route',
  'policyRedirects',
  'maxTokens',
  'warnings',
  'ignoredCtx',
  'ctx',
]);

export const ROUTE_SOURCES = Object.freeze(['override', 'env-task', 'env-default', 'escalate', 'tier-task', 'task', 'tier-kind', 'kind', 'profile-vision', 'profile-default']);

/** Names the core module (core/llm/index.js) must export. */
export const CORE_EXPORTS = Object.freeze([
  'createLlmCore',
  'createRouter',
  'resolveRoute',
  'routeFor',
  'parseRoute',
  'formatRoute',
  'validateRoutesConfig',
  'parseTaskRegistry',
  'validateTaskRegistry',
  'taskEnvKey',
  'validatePolicy',
  'applyPolicy',
  'effectiveDataClass',
  'detectPersonFields',
  'providerAllows',
  'PRICES',
  'priceUsage',
  'priceResponse',
  'estimateCallUsd',
  'checkModelPrices',
  'buildClaudeRequest',
  'buildClaudeBatchItem',
  'normalizeClaudeResponse',
  'claudeMaxTokens',
  'toClaudeSchema',
  'imageBlocks',
  'prepareImage',
  'jpegSize',
  'extractJson',
  'validateJson',
  'parseJsonOutput',
  'buildLedgerRow',
  'buildApiSpendRow',
  'readLedgerRow',
  'summarizeLedger',
  'cassetteKey',
  'cassetteRecord',
  'normalizeForReplay',
  'expectedCostUsd',
  'evaluateBudget',
  'validateBudgetsConfig',
  'createLoopDetector',
  'classifyError',
  'RefusalError',
  'BudgetExceededError',
  'LoopDetectedError',
  'PolicyBlockedError',
  'RouteConfigError',
  'ProviderDeadError',
  'MaxTokensError',
  'SchemaValidationError',
  'CassetteMissError',
  'InvalidRequestError',
  'LLM_CONTRACT',
  'runContractChecks',
]);

/** Methods every facade exposes. `routeFor` and `resolveRoute` are the same function. */
export const FACADE_METHODS = Object.freeze(['json', 'text', 'tools', 'callLlm', 'routeFor', 'resolveRoute', 'status']);

export const LLM_CONTRACT = deepFreeze({
  id: 'llm-core',
  version: '1.0.0',
  frozenAt: '2026-10-23',
  providers: [...PROVIDERS],
  dataClasses: [...DATA_CLASSES],
  taskKinds: [...TASK_KINDS],
  efforts: [...EFFORTS],
  profiles: [...PROFILES],
  profileAliases: { ...PROFILE_ALIASES },
  defaultProfile: 'legacy',
  tiers: [...TIERS],
  claudeModels: [...CLAUDE_MODELS],
  claude: {
    forbiddenParams: [...CLAUDE_RULES.forbiddenParams],
    thinking: { ...CLAUDE_RULES.thinking },
    defaultEffort: CLAUDE_RULES.defaultEffort,
    maxTokensFloor: CLAUDE_RULES.maxTokensFloor,
    maxTokensRetryFactor: CLAUDE_RULES.maxTokensRetryFactor,
    maxTokensRetries: CLAUDE_RULES.maxTokensRetries,
    streamAboveMaxTokens: CLAUDE_RULES.streamAboveMaxTokens,
    toolChoice: CLAUDE_RULES.toolChoice,
    strictTools: CLAUDE_RULES.strictTools,
    structuredOutput: 'output_config.format json_schema',
    serverFallback: { models: [...CLAUDE_RULES.serverFallback.models], value: CLAUDE_RULES.serverFallback.value, beta: CLAUDE_RULES.serverFallback.beta, batches: false },
    refusal: { ...CLAUDE_RULES.refusal, error: 'RefusalError' },
    image: { ...CLAUDE_RULES.image },
  },
  policy: {
    neverPersonal: ['deepseek'],
    geminiClientDataNeeds: 'billingTier paid + paidTierConfirmedAt',
    personFieldsMakePersonal: true,
    synthetic: 'public',
    redacted: 'business',
    defaultRedirect: 'claude:claude-haiku-5-5:low',
  },
  routing: {
    order: [...ROUTE_SOURCES],
    env: ['AI_PROFILE', 'AI_TEST_MODE', 'AI_ROUTE_<TASK>', 'AI_ROUTE_DEFAULT', 'AI_ROUTE_VISION_DEFAULT'],
    ctxProfileBeatsEnv: true,
    escalation: 'escalate[task] or escalateKinds[family], index ctx.escalation (1-based), capped by ctx.maxEscalation',
    resultFields: [...ROUTE_RESULT_FIELDS],
  },
  ctxFields: [...CTX_FIELDS],
  prices: { source: 'core/llm/prices.js', pricedFrom: 'response.model (+ usage.iterations)', maxAgeDays: 120, unverifiedBudgetRate: 'CEILING 5/25 per MTok' },
  budgets: {
    alertRatio: BUDGET_RULES.alertRatio,
    runawayFactor: BUDGET_RULES.runawayFactor,
    loopMaxRepeats: BUDGET_RULES.loopMaxRepeats,
    loopMaxIdentical: BUDGET_RULES.loopMaxIdentical,
    periodicScopesMode: BUDGET_RULES.periodicScopesMode,
    hardStop: ['runaway', 'loop'],
  },
  ledger: { version: LEDGER_VERSION, fields: [...LEDGER_FIELDS], statuses: [...LEDGER_STATUSES] },
  errors: [...ERROR_CODES],
  facadeMethods: [...FACADE_METHODS],
  coreExports: [...CORE_EXPORTS],
});

export function contractFingerprint(contract = LLM_CONTRACT) {
  return `sha256:${createHash('sha256').update(canonicalJson(contract)).digest('hex')}`;
}

function sameList(a = [], b = []) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

const MINI_TASKS = {
  version: 1,
  tasks: {
    'contract.classify': { kind: 'json', vision: false, dataClass: 'public', maxTokens: 500, effort: 'low', family: 'classification' },
    'contract.transcript': { kind: 'json', vision: false, dataClass: 'transcript', maxTokens: 4000 },
    'contract.vision': { kind: 'json', vision: true, dataClass: 'business', maxTokens: 2000 },
    'contract.plan': { kind: 'json', vision: false, dataClass: 'business', maxTokens: 8000, family: 'plan' },
  },
};

const MINI_ROUTES = {
  version: 1,
  profiles: {
    legacy: { default: '${legacy}', vision: '${legacy}' },
    prod: {
      default: 'claude:claude-haiku-5-5:medium|deepseek:deepseek-flash',
      vision: 'claude:claude-haiku-5-5:medium|gemini:gemini-2.5-flash',
      escalate: { 'contract.plan': ['claude:claude-sonnet-5-5:medium', 'claude:claude-opus-5-5:medium'] },
    },
    test: { default: 'deepseek:deepseek-flash', vision: 'gemini:gemini-2.5-flash-lite' },
    replay: { default: 'replay:strict', vision: 'replay:strict' },
    record: { inherit: 'test', record: true },
  },
};

const MINI_POLICY = {
  version: 1,
  providers: {
    claude: { allow: ['public', 'business', 'personal', 'transcript'] },
    gemini: { allow: ['public', 'business', 'personal', 'transcript'], billingTier: 'unknown', paidTierConfirmedAt: null },
    deepseek: { allow: ['public', 'business'] },
    openai: { allow: ['public', 'business'] },
  },
  redirect: 'claude:claude-haiku-5-5:low',
};

/**
 * Behavioural checks of the contract, shared by both repos' tests. Pass the core module namespace
 * (`import * as core from '<suite>/core/llm/index.js'`) and, once it exists, the repo's facade.
 * @returns {string[]} problems; an empty list means the contract holds
 */
export function runContractChecks({ core, facade = null, fingerprint = null } = {}) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const attempt = (name, fn) => {
    try {
      fn();
    } catch (error) {
      fail(`${name}: threw ${error?.name || 'Error'}: ${error?.message || error}`);
    }
  };
  if (!core || typeof core !== 'object') return ['core module namespace is required'];
  for (const name of CORE_EXPORTS) if (!(name in core)) fail(`core does not export ${name}`);
  if (problems.length) return problems;

  if (fingerprint && contractFingerprint(core.LLM_CONTRACT) !== fingerprint) fail(`contract fingerprint changed (expected ${fingerprint}); bump the contract version and update both repos`);
  if (core.LLM_CONTRACT.version !== LLM_CONTRACT.version) fail(`contract version ${core.LLM_CONTRACT.version} != ${LLM_CONTRACT.version}`);

  attempt('claude request never carries sampling params', () => {
    const built = core.buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', temperature: 0, top_p: 0.5, top_k: 3, kind: 'json', maxTokens: 100 });
    for (const key of LLM_CONTRACT.claude.forbiddenParams) if (key in built.params) fail(`buildClaudeRequest emitted ${key}`);
    if (built.params.max_tokens < LLM_CONTRACT.claude.maxTokensFloor) fail('max_tokens below the floor');
    if (built.params.thinking?.type !== 'adaptive') fail('thinking is not adaptive');
    if (!LLM_CONTRACT.efforts.includes(built.params.output_config?.effort)) fail('output_config.effort missing');
    if (core.claudeMaxTokens({ requested: 5000, attempt: 2 }) !== 10000) fail('max_tokens retry does not double the cap');
  });

  attempt('refusal is final and needs review', () => {
    const error = new core.RefusalError('declined');
    if (!(error.needsReview === true && error.crossVendorRetry === false)) fail('RefusalError must carry needsReview:true and crossVendorRetry:false');
    if (core.classifyError(error).fallback !== false) fail('a refusal must not fall back to another provider');
    if (!(error instanceof RefusalError) && error.code !== 'refusal') fail('RefusalError code must be "refusal"');
  });

  attempt('routing contract', () => {
    const tasks = core.parseTaskRegistry(MINI_TASKS);
    const router = core.createRouter({ tasks, routes: MINI_ROUTES, policy: MINI_POLICY, env: { AI_PROFILE: 'test' }, legacyRoute: () => 'deepseek:deepseek-chat' });
    const r = router.resolveRoute('contract.plan', { profile: 'production', escalation: 1, maxEscalation: 1, tier: 3 });
    for (const field of ROUTE_RESULT_FIELDS) if (!(field in r)) fail(`route result lacks ${field}`);
    if (r.profile !== 'prod') fail('ctx.profile "production" must resolve to prod and beat env AI_PROFILE');
    if (r.primary.model !== 'claude-sonnet-5-5' || r.escalation.applied !== 1) fail('escalation index 1 must pick the first escalate route');
    const capped = router.resolveRoute('contract.plan', { profile: 'prod', escalation: 2, maxEscalation: 1 });
    if (capped.primary.model !== 'claude-sonnet-5-5') fail('maxEscalation must cap the escalation index');
    const transcript = router.resolveRoute('contract.transcript', {});
    if (transcript.chain.some((e) => e.provider === 'deepseek')) fail('transcript data reached DeepSeek');
    const vision = router.resolveRoute('contract.vision', { profile: 'test' });
    if (vision.chain.some((e) => e.provider === 'gemini')) fail('business data reached Gemini without a confirmed paid tier');
    const person = router.resolveRoute('contract.classify', { profile: 'test' }, { payload: { contact: { email: 'kari@example.no' } } });
    if (person.dataClass.effective !== 'personal' || person.chain.some((e) => e.provider === 'deepseek')) fail('a payload with person fields must be personal and stay off DeepSeek');
    if (router.routeFor !== router.resolveRoute) fail('routeFor and resolveRoute must be the same function');
  });

  attempt('price from the served model', () => {
    // 50k input tokens: $0.005 on Haiku 5.5 (served), $0.20 on Opus 5.5 (requested).
    const priced = core.priceResponse({ requestedModel: 'claude-opus-5-5', response: { model: 'claude-haiku-5-5', usage: { input_tokens: 50_000, output_tokens: 0 } } });
    if (Math.abs(priced.usd - 0.005) > 1e-9) fail('priceResponse must price from response.model');
  });

  attempt('soft budgets', () => {
    if (core.evaluateBudget({ expectedUsd: 1, spentUsd: 1.2 }).action !== 'alert') fail('over expected must alert, not stop');
    if (core.evaluateBudget({ expectedUsd: 1, spentUsd: 5.1 }).action !== 'stop') fail('over 5x expected must stop (runaway)');
    if (core.evaluateBudget({ expectedUsd: 1, spentUsd: 50, mode: 'alert-only' }).action !== 'alert') fail('periodic scopes must never stop');
  });

  if (facade) {
    for (const method of FACADE_METHODS) if (typeof facade[method] !== 'function') fail(`facade lacks ${method}()`);
    if (facade.routeFor && facade.resolveRoute && facade.routeFor !== facade.resolveRoute) fail('facade.routeFor and facade.resolveRoute must be the same function');
  }
  if (!sameList(LLM_CONTRACT.ledger.fields, core.LLM_CONTRACT.ledger.fields)) fail('ledger fields differ from the contract');
  return problems;
}
