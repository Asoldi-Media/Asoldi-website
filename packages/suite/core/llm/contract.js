// The frozen LLM contract (version 1.1.0). Both facades (Maker lib/ai-pipeline/_shared/llm and the hub's
// lib/llm) build on it, and both run runContractChecks() in their test suites. Changing anything here is a
// contract change: bump `version`, update CONTRACT.md and the pinned fingerprint in both repos' tests.
// 1.1.0 (2026-10-23, before any facade adopted 1.0.0): Q5 client-data rule for DeepSeek, synthetic/redacted
// checked against the payload, provider task scopes (OpenAI = eval judge), strict Gemini paid-tier rule,
// unknown tiers warn, scoped and windowed loop detection, budgets on by default, Claude-only max_tokens retry,
// caller aborts stop the chain, replay rows cost nothing, open-map schemas skip structured output.

import { createHash } from 'node:crypto';
import {
  BUDGET_RULES,
  CLAUDE_FALLBACK_MODELS,
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
import { PERIODIC_SCOPES } from './budget.js';
import { FIXTURE_RULES } from './policy.js';

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
  'shouldRetryMaxTokens',
  'toClaudeSchema',
  'openObjectPaths',
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
  'maskSecretValues',
  'expectedCostUsd',
  'evaluateBudget',
  'validateBudgetsConfig',
  'createLoopDetector',
  'periodicScopesFor',
  'classifyError',
  'isAbortError',
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
  version: '1.1.0',
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
    maxTokensRetryProviders: [...CLAUDE_RULES.maxTokensRetryProviders],
    streamAboveMaxTokens: CLAUDE_RULES.streamAboveMaxTokens,
    toolChoice: CLAUDE_RULES.toolChoice,
    strictTools: CLAUDE_RULES.strictTools,
    structuredOutput: 'output_config.format json_schema',
    openMapSchemas: 'no output_config.format (prompt JSON, validated client-side); tools with open maps are not strict',
    serverFallback: { models: [...CLAUDE_RULES.serverFallback.models], value: CLAUDE_RULES.serverFallback.value, beta: CLAUDE_RULES.serverFallback.beta, batches: false, servedBy: [...CLAUDE_FALLBACK_MODELS] },
    refusal: { ...CLAUDE_RULES.refusal, error: 'RefusalError' },
    image: { ...CLAUDE_RULES.image },
  },
  policy: {
    neverPersonal: ['deepseek'],
    clientDataOnlySyntheticOrRedacted: ['deepseek'],
    gemini: 'nothing until billingTier paid + paidTierConfirmedAt; allowUnpaidPublic:true opts public data back in',
    providerScopes: 'providers.<name>.tasks / families limit a provider to those tasks',
    personFieldsMakePersonal: true,
    synthetic: 'public, unless the payload holds a real-looking email or phone',
    redacted: 'personal/transcript count as business, unless person fields or a real-looking email or phone remain',
    fixtureValues: { ...FIXTURE_RULES },
    redirectEffort: 'task effort, else the replaced entry effort, else the redirect route effort, else medium',
    defaultRedirect: 'claude:claude-haiku-5-5',
    appliesToProfiles: 'all, legacy included',
  },
  routing: {
    order: [...ROUTE_SOURCES],
    env: ['AI_PROFILE', 'AI_TEST_MODE', 'AI_ROUTE_<TASK>', 'AI_ROUTE_DEFAULT', 'AI_ROUTE_VISION_DEFAULT'],
    ctxProfileBeatsEnv: true,
    unknownTier: 'warning, no tier routes, default budget base',
    escalation: 'escalate[task] or escalateKinds[family], index ctx.escalation (1-based), capped by ctx.maxEscalation',
    resultFields: [...ROUTE_RESULT_FIELDS],
  },
  ctxFields: [...CTX_FIELDS],
  prices: { source: 'core/llm/prices.js', pricedFrom: 'response.model (+ usage.iterations)', maxAgeDays: 120, unverifiedBudgetRate: 'CEILING 5/25 per MTok', replayUsd: 0 },
  budgets: {
    alertRatio: BUDGET_RULES.alertRatio,
    runawayFactor: BUDGET_RULES.runawayFactor,
    unknownSize: 'expected cost of one reference project (the scope base)',
    loopMaxRepeats: BUDGET_RULES.loopMaxRepeats,
    loopMaxIdentical: BUDGET_RULES.loopMaxIdentical,
    loopWindowMinutes: BUDGET_RULES.loopWindowMinutes,
    loopScopeFields: [...BUDGET_RULES.loopScopeFields],
    periodicScopes: { ...PERIODIC_SCOPES },
    periodicScopesMode: BUDGET_RULES.periodicScopesMode,
    hardStop: ['runaway', 'loop'],
  },
  aborts: 'a caller abort stops the chain; no other provider is tried',
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
    'contract.shot': { kind: 'json', vision: true, dataClass: 'public', maxTokens: 2000 },
    'contract.plan': { kind: 'json', vision: false, dataClass: 'business', maxTokens: 8000, family: 'plan' },
    'contract.eval': { kind: 'json', vision: false, dataClass: 'business', maxTokens: 2000, family: 'judge' },
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
    test: { default: 'deepseek:deepseek-flash|openai:gpt-4.1', vision: 'gemini:gemini-2.5-flash-lite|claude:claude-haiku-5-5:low' },
    replay: { default: 'replay:strict', vision: 'replay:strict' },
    record: { inherit: 'test', record: true },
  },
};

const MINI_POLICY = {
  version: 1,
  providers: {
    claude: { allow: ['public', 'business', 'personal', 'transcript'] },
    gemini: { allow: ['public', 'business', 'personal', 'transcript'], billingTier: 'unknown', paidTierConfirmedAt: null },
    // A loose config: the core must still keep personal data and unredacted client data off DeepSeek.
    deepseek: { allow: ['public', 'business', 'personal', 'transcript'] },
    openai: { allow: ['public', 'business'], tasks: ['contract.eval'] },
  },
  redirect: 'claude:claude-haiku-5-5',
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
    const shot = router.resolveRoute('contract.shot', { profile: 'test' });
    if (shot.chain.some((e) => e.provider === 'gemini')) fail('public data reached unpaid Gemini without allowUnpaidPublic');
    const person = router.resolveRoute('contract.classify', { profile: 'test' }, { payload: { contact: { email: 'kari@example.no' } } });
    if (person.dataClass.effective !== 'personal' || person.chain.some((e) => e.provider === 'deepseek')) fail('a payload with person fields must be personal and stay off DeepSeek');
    // Q5: real client business data never reaches DeepSeek or a provider scoped to other tasks.
    const client = router.resolveRoute('contract.plan', { profile: 'test' }, { payload: { user: 'Fjordbakeriet sells sourdough in Bergen.' } });
    if (client.chain.some((e) => e.provider === 'deepseek' || e.provider === 'openai')) fail('real client business data reached DeepSeek or OpenAI');
    if (client.primary.effort !== 'medium') fail('a full policy redirect must keep the task effort (medium default), not drop to low');
    const redacted = router.resolveRoute('contract.plan', { profile: 'test', redacted: true }, { payload: { user: 'The bakery sells bread. Contact: [EMAIL]' } });
    if (redacted.primary.provider !== 'deepseek') fail('a redacted payload with no person data left may use DeepSeek');
    const leaky = router.resolveRoute('contract.transcript', { profile: 'test', redacted: true }, { payload: { user: 'Ring Kari på 92 34 56 78' } });
    if (leaky.chain.some((e) => e.provider === 'deepseek')) fail('ctx.redacted must not bypass a phone number left in the payload');
    const fake = router.resolveRoute('contract.transcript', { profile: 'test', synthetic: true }, { payload: { user: 'kari@firma.no' } });
    if (fake.chain.some((e) => e.provider === 'deepseek')) fail('ctx.synthetic must not bypass a real-looking email in the payload');
    const fixture = router.resolveRoute('contract.transcript', { profile: 'test', synthetic: true }, { payload: { user: 'kari@example.no, +47 000 00 000' } });
    if (fixture.primary.provider !== 'deepseek') fail('synthetic fixtures with reserved values may use the test profile');
    const evalCall = router.resolveRoute('contract.eval', { profile: 'test', route: 'openai:gpt-4.1' });
    if (evalCall.primary.provider !== 'openai') fail('a provider scoped to a task must stay usable for that task');
    const custom = router.resolveRoute('contract.plan', { profile: 'prod', tier: 'custom' });
    if (custom.tier !== null || !custom.warnings.some((w) => /ctx.tier/.test(w))) fail('an unknown tier must warn and route without a tier, never throw');
    if (router.routeFor !== router.resolveRoute) fail('routeFor and resolveRoute must be the same function');
  });

  attempt('claude-only max_tokens retry, aborts stop, open maps skip structured output', () => {
    if (core.shouldRetryMaxTokens('max_tokens', 1, 'deepseek') !== false) fail('only Claude retries a max_tokens stop with a doubled cap');
    if (core.shouldRetryMaxTokens('max_tokens', 1, 'claude') !== true) fail('Claude retries a max_tokens stop once');
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (core.classifyError(abort).fallback !== false) fail('a caller abort must not fall back to another provider');
    const map = core.buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', kind: 'json', schema: { type: 'object', properties: { t: { type: 'object', additionalProperties: { type: 'string' } } } } });
    if (map.params.output_config.format) fail('a schema with an open map must not be sent as structured output (it would be closed to {})');
  });

  attempt('replay rows cost nothing', () => {
    const row = core.buildLedgerRow({ provider: 'replay', requestedModel: 'strict', servedModel: 'claude-opus-5-5', usage: { inputTokens: 100_000, outputTokens: 10_000 } });
    if (row.usd !== 0 || row.replayOf !== 'claude-opus-5-5') fail('a replay row must cost 0 and keep the recorded model in replayOf');
  });

  attempt('loop detection is scoped and windowed', () => {
    let t = 0;
    const detector = core.createLoopDetector({ now: () => t });
    for (let i = 0; i < 3; i += 1) detector.after('x', 'k', 'same');
    if (!detector.before('x', 'k').loop) fail('three identical outcomes in a row inside the window must be a loop');
    t += (LLM_CONTRACT.budgets.loopWindowMinutes + 1) * 60_000;
    if (detector.before('x', 'k').loop) fail('a loop block must expire with the window');
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
