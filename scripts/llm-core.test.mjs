// Tests for packages/suite/core/llm (WS0.15 shared LLM core, WS0.33 contract freeze). No network calls:
// every provider is a mock adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../packages/suite/core/llm/index.js';

const {
  parseRoute,
  formatRoute,
  taskEnvKey,
  parseTaskRegistry,
  validateTaskRegistry,
  validateRoutesConfig,
  createRouter,
  resolveRoute,
  priceUsage,
  priceResponse,
  estimateCallUsd,
  checkModelPrices,
  buildClaudeRequest,
  buildClaudeBatchItem,
  claudeMaxTokens,
  normalizeClaudeResponse,
  assertNotRefused,
  toClaudeSchema,
  jpegSize,
  imageBlocks,
  extractJson,
  validateJson,
  parseJsonOutput,
  detectPersonFields,
  effectiveDataClass,
  applyPolicy,
  providerAllows,
  buildLedgerRow,
  readLedgerRow,
  summarizeLedger,
  buildApiSpendRow,
  usageFromChatResponse,
  usageFromGeminiResponse,
  cassetteKey,
  cassetteRecord,
  cassettePath,
  scrubSecrets,
  expectedCostUsd,
  evaluateBudget,
  detectLoop,
  createLoopDetector,
  validateBudgetsConfig,
  createLlmCore,
  classifyError,
  LEDGER_FIELDS,
} = core;

const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

// ---------- fixtures ----------
const TASKS = parseTaskRegistry({
  version: 1,
  tasks: {
    'cls.page': { kind: 'json', vision: false, dataClass: 'public', maxTokens: 1000, effort: 'low', family: 'classification' },
    'copy.write': { kind: 'json', vision: false, dataClass: 'business', maxTokens: 16000, family: 'copy' },
    'brief.read': { kind: 'json', vision: false, dataClass: 'transcript', maxTokens: 4000, family: 'brief' },
    'qa.shot': { kind: 'json', vision: true, dataClass: 'public', maxTokens: 2000, family: 'visual-qa' },
    'qa.client-shot': { kind: 'json', vision: true, dataClass: 'business', maxTokens: 2000, family: 'visual-qa' },
    'plan.edit': { kind: 'json', vision: false, dataClass: 'business', maxTokens: 8000, family: 'plan' },
    'note.text': { kind: 'text', vision: false, dataClass: 'public', maxTokens: 500 },
    'agent.run': { kind: 'tools', vision: false, dataClass: 'public', maxTokens: 4096, family: 'agent' },
  },
});

const ROUTES = {
  version: 1,
  profiles: {
    legacy: { default: '${legacy}', vision: '${legacy}' },
    prod: {
      default: 'claude:claude-haiku-5-5:medium|deepseek:deepseek-flash',
      vision: 'claude:claude-haiku-5-5:medium|gemini:gemini-2.5-flash',
      kinds: { classification: 'claude:claude-haiku-5-5:medium|deepseek:deepseek-flash', agent: 'claude:claude-haiku-5-5:medium' },
      tasks: { 'copy.write': 'claude:claude-haiku-5-5:high|openai:gpt-4.1' },
      escalate: { 'plan.edit': ['claude:claude-sonnet-5-5:medium', 'claude:claude-opus-5-5:medium'] },
      escalateKinds: { classification: ['claude:claude-haiku-5-5:medium'] },
      tiers: { 'tier-3-ecommerce': { tasks: { 'copy.write': 'claude:claude-sonnet-5-5:medium' } } },
    },
    test: { default: 'deepseek:deepseek-flash', vision: 'gemini:gemini-2.5-flash-lite', kinds: { agent: 'claude:claude-haiku-5-5:low' } },
    replay: { default: 'replay:strict', vision: 'replay:strict' },
    record: { inherit: 'test', record: true },
  },
};

const POLICY = {
  version: 1,
  providers: {
    claude: { allow: ['public', 'business', 'personal', 'transcript'] },
    gemini: { allow: ['public', 'business', 'personal', 'transcript'], billingTier: 'unknown', paidTierConfirmedAt: null },
    deepseek: { allow: ['public', 'business'] },
    openai: { allow: ['public', 'business'] },
  },
  redirect: 'claude:claude-haiku-5-5:low',
};

const BUDGETS = {
  version: 1,
  alertRatio: 1,
  runawayFactor: 5,
  scopes: {
    run: { baseUsd: { default: 2, 'tier-1-standard': 1, 'tier-2-seo': 1.5, 'tier-3-ecommerce': 3 }, referencePages: 6, extraLocaleFactor: 0.75, productsPerPage: 20 },
    devSession: { baseUsd: { default: 2.5, 'tier-1-standard': 1.5, 'tier-2-seo': 2.5, 'tier-3-ecommerce': 4 }, referencePages: 6 },
    iteration: { of: 'devSession', factor: 0.5 },
  },
  periodic: { clientMonthUsd: 10 },
};

const legacyRoute = (task, ctx, spec) => (spec.kind === 'tools' ? 'claude:claude-haiku-5-5' : spec.vision ? 'gemini:gemini-2.5-flash' : 'deepseek:deepseek-chat');
const router = (env = {}, extra = {}) => createRouter({ tasks: TASKS, routes: ROUTES, policy: POLICY, env, legacyRoute, ...extra });

// ---------- route strings ----------
test('route parser: single entry with effort', () => {
  assert.deepEqual(parseRoute('claude:claude-haiku-5-5:low'), [{ provider: 'claude', model: 'claude-haiku-5-5', effort: 'low', raw: 'claude:claude-haiku-5-5:low' }]);
});

test('route parser: multiple fallbacks keep order; anthropic is an alias of claude', () => {
  const chain = parseRoute('anthropic:claude-sonnet-5-5:medium | deepseek:deepseek-flash|gemini:gemini-2.5-flash:high');
  assert.deepEqual(chain.map((e) => [e.provider, e.model, e.effort]), [
    ['claude', 'claude-sonnet-5-5', 'medium'],
    ['deepseek', 'deepseek-flash', null],
    ['gemini', 'gemini-2.5-flash', 'high'],
  ]);
  assert.equal(formatRoute(chain), 'claude:claude-sonnet-5-5:medium|deepseek:deepseek-flash|gemini:gemini-2.5-flash:high');
});

test('route parser: rejects unknown provider, Claude model, effort and malformed parts', () => {
  for (const bad of ['', 'mistral:large', 'claude:claude-sonnet-4-6', 'claude:claude-haiku-5-5:turbo', 'deepseek', 'a:b:c:d', 'claude::low']) {
    assert.throws(() => parseRoute(bad), (e) => e.code === 'route_config', bad);
  }
});

test('env key mapping: dots and dashes become underscores', () => {
  assert.equal(taskEnvKey('step2.copy-judge'), 'AI_ROUTE_STEP2_COPY_JUDGE');
  assert.equal(taskEnvKey('template-import.qa-vision'), 'AI_ROUTE_TEMPLATE_IMPORT_QA_VISION');
});

// ---------- resolution ----------
test('resolution order: ctx.route > env task > env default > config', () => {
  const r = router({ AI_PROFILE: 'prod', AI_ROUTE_DEFAULT: 'claude:claude-opus-5-5:high', AI_ROUTE_COPY_WRITE: 'claude:claude-sonnet-5-5:low' });
  assert.equal(r.resolveRoute('copy.write').route, 'claude:claude-sonnet-5-5:low');
  assert.equal(r.resolveRoute('copy.write').source, 'env-task');
  assert.equal(r.resolveRoute('plan.edit').source, 'env-default');
  assert.equal(r.resolveRoute('plan.edit').primary.model, 'claude-opus-5-5');
  const forced = r.resolveRoute('plan.edit', { route: 'claude:claude-haiku-5-5:max' });
  assert.equal(forced.source, 'override');
  assert.equal(forced.primary.effort, 'max');
});

test('tier overrides beat task routes; numeric tiers normalize', () => {
  const r = router({ AI_PROFILE: 'prod' });
  assert.equal(r.resolveRoute('copy.write').primary.model, 'claude-haiku-5-5');
  const tiered = r.resolveRoute('copy.write', { tier: 3 });
  assert.equal(tiered.tier, 'tier-3-ecommerce');
  assert.equal(tiered.source, 'tier-task');
  assert.equal(tiered.primary.model, 'claude-sonnet-5-5');
  assert.throws(() => r.resolveRoute('copy.write', { tier: 'gold' }), /ctx.tier/);
});

test('family (kind) routes; ctx.kind overrides the task family', () => {
  const r = router({ AI_PROFILE: 'prod' });
  assert.equal(r.resolveRoute('cls.page').source, 'kind');
  assert.equal(r.resolveRoute('note.text').source, 'profile-default');
  assert.equal(r.resolveRoute('note.text', { kind: 'agent' }).route, 'claude:claude-haiku-5-5:medium');
});

test('escalation: index picks the ladder, maxEscalation caps it, env forcing wins', () => {
  const r = router({ AI_PROFILE: 'prod' });
  assert.equal(r.resolveRoute('plan.edit').primary.model, 'claude-haiku-5-5');
  const one = r.resolveRoute('plan.edit', { escalation: 1 });
  assert.equal(one.source, 'escalate');
  assert.equal(one.primary.model, 'claude-sonnet-5-5');
  assert.equal(r.resolveRoute('plan.edit', { escalation: 2 }).primary.model, 'claude-opus-5-5');
  const capped = r.resolveRoute('plan.edit', { escalation: 5, maxEscalation: 1 });
  assert.equal(capped.primary.model, 'claude-sonnet-5-5');
  assert.equal(capped.escalation.applied, 1);
  assert.equal(capped.escalation.exhausted, true);
  assert.equal(r.resolveRoute('cls.page', { escalation: 1 }).primary.effort, 'medium', 'escalateKinds by family');
  const forced = router({ AI_PROFILE: 'prod', AI_ROUTE_PLAN_EDIT: 'claude:claude-haiku-5-5:low' }).resolveRoute('plan.edit', { escalation: 1 });
  assert.equal(forced.source, 'env-task');
  assert.match(forced.warnings.join(' '), /escalation 1 ignored/);
});

test('profile choice: ctx.profile beats env; production alias; AI_TEST_MODE; unknown env profile warns', () => {
  assert.equal(router({ AI_PROFILE: 'test' }).resolveRoute('plan.edit', { profile: 'production' }).profile, 'prod');
  assert.equal(router({ AI_TEST_MODE: '1' }).resolveRoute('plan.edit').profile, 'test');
  assert.equal(router({}).resolveRoute('plan.edit').profile, 'legacy');
  const odd = router({ AI_PROFILE: 'turbo' }).resolveRoute('plan.edit');
  assert.equal(odd.profile, 'legacy');
  assert.match(odd.warnings.join(' '), /AI_PROFILE="turbo" is unknown/);
  assert.throws(() => router().resolveRoute('plan.edit', { profile: 'turbo' }), /ctx.profile/);
});

test('legacy placeholder resolves through legacyRoute and needs it', () => {
  const r = router();
  assert.equal(r.resolveRoute('plan.edit').route, 'deepseek:deepseek-chat');
  assert.equal(r.resolveRoute('plan.edit').legacy, true);
  const bare = createRouter({ tasks: TASKS, routes: ROUTES, policy: POLICY });
  assert.throws(() => bare.resolveRoute('plan.edit'), /legacyRoute/);
});

test('vision task: text-only entries are dropped, the vision route is used, with a warning', () => {
  const r = router({ AI_PROFILE: 'test', AI_ROUTE_QA_SHOT: 'deepseek:deepseek-flash' });
  const route = r.resolveRoute('qa.shot');
  assert.equal(route.primary.provider, 'gemini');
  assert.match(route.warnings.join(' '), /vision/);
  assert.equal(r.resolveRoute('qa.shot', { vision: false }).primary.provider, 'deepseek', 'ctx.vision:false allows a text-only call');
});

test('tools task needs a tool-loop provider', () => {
  assert.equal(router({ AI_PROFILE: 'test' }).resolveRoute('agent.run').primary.provider, 'claude');
  assert.throws(() => router({ AI_PROFILE: 'test', AI_ROUTE_AGENT_RUN: 'deepseek:deepseek-flash' }).resolveRoute('agent.run'), /needs tools/);
});

test('record inherits test and is flagged; replay routes to replay', () => {
  const rec = router({ AI_PROFILE: 'record' }).resolveRoute('plan.edit');
  assert.equal(rec.record, true);
  assert.equal(rec.primary.provider, 'deepseek');
  const rep = router({ AI_PROFILE: 'replay' }).resolveRoute('brief.read');
  assert.equal(rep.replay, true);
  assert.equal(rep.route, 'replay:strict');
});

test('effort: task default beats a generic route, a task-specific route beats the task default', () => {
  const r = router({ AI_PROFILE: 'prod' });
  assert.equal(r.resolveRoute('cls.page').primary.effort, 'low', 'classification task effort low over kind route medium');
  assert.equal(r.resolveRoute('copy.write').primary.effort, 'high', 'task route effort');
  assert.equal(r.resolveRoute('note.text').primary.effort, 'medium');
  assert.equal(r.resolveRoute('cls.page', { route: 'claude:claude-haiku-5-5:max' }).primary.effort, 'max');
});

test('ctx is trimmed to contract fields; unknown keys are listed', () => {
  const r = router({ AI_PROFILE: 'prod' }).resolveRoute('plan.edit', { runId: 'r1', salesClientId: 'sc', purpose: 'x', escalation: '1' });
  assert.deepEqual(r.ignoredCtx, ['purpose']);
  assert.equal(r.ctx.runId, 'r1');
  assert.equal(r.escalation.applied, 1);
  for (const field of core.ROUTE_RESULT_FIELDS) assert.ok(field in r, field);
  assert.ok(Object.isFrozen(r));
});

// ---------- config validation ----------
test('routes validation: unknown model price, unknown task, stale and unverified prices', () => {
  const bad = { version: 1, profiles: { prod: { default: 'openai:gpt-9', tasks: { 'no.such-task': 'claude:claude-haiku-5-5' } } } };
  const result = validateRoutesConfig(bad, { tasks: TASKS });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /gpt-9" has no price entry/);
  assert.match(result.errors.join('\n'), /no.such-task: task is not in the registry/);
  assert.equal(validateRoutesConfig(bad, { tasks: TASKS, unknownTasks: 'warn' }).errors.some((e) => /no.such-task/.test(e)), false);
  const stale = validateRoutesConfig(ROUTES, { tasks: TASKS, now: new Date('2027-06-01T00:00:00Z') });
  assert.match(stale.errors.join('\n'), /claude-haiku-5-5" price is older/);
  const running = createRouter({ tasks: TASKS, routes: ROUTES, policy: POLICY, legacyRoute, now: new Date('2027-06-01T00:00:00Z') });
  assert.match(running.warnings.join('\n'), /claude-haiku-5-5" price is older/, 'a running facade only warns about a stale price');
  const fresh = validateRoutesConfig(ROUTES, { tasks: TASKS, now: new Date('2026-10-24T00:00:00Z') });
  assert.equal(fresh.ok, true, fresh.errors.join('\n'));
  assert.match(fresh.warnings.join('\n'), /deepseek-flash" price is unverified/);
  assert.throws(() => createRouter({ tasks: TASKS, routes: bad, policy: POLICY }), (e) => e.code === 'route_config' && e.errors.length >= 2);
});

test('routes validation: profile inheritance loops and unknown profiles are errors', () => {
  const loop = { version: 1, profiles: { test: { inherit: 'record', default: 'deepseek:deepseek-flash' }, record: { inherit: 'test' } } };
  assert.match(validateRoutesConfig(loop).errors.join('\n'), /inheritance loop/);
  assert.match(validateRoutesConfig({ version: 1, profiles: { turbo: { default: 'deepseek:deepseek-flash' } } }).errors.join('\n'), /unknown profile/);
});

test('task registry: all problems reported at once', () => {
  const result = validateTaskRegistry({ version: 1, tasks: { 'Bad Key': { kind: 'chat', vision: 'no', dataClass: 'secret', maxTokens: 0, effort: 'turbo', extra: 1 } } });
  assert.equal(result.ok, false);
  for (const fragment of ['key must match', '.kind', '.vision', '.dataClass', '.maxTokens', '.effort', 'unknown field "extra"']) {
    assert.ok(result.errors.some((e) => e.includes(fragment)), fragment);
  }
  assert.throws(() => parseTaskRegistry({ version: 2, tasks: {} }), /version must be 1/);
  assert.throws(() => router().resolveRoute('missing.task'), /Unknown LLM task/);
});

// ---------- data policy ----------
test('policy redirects a transcript task away from DeepSeek', () => {
  const route = router({ AI_PROFILE: 'test' }).resolveRoute('brief.read');
  assert.equal(route.dataClass.effective, 'transcript');
  assert.ok(!route.chain.some((e) => e.provider === 'deepseek'));
  assert.equal(route.route, 'claude:claude-haiku-5-5:low');
  assert.equal(route.policyRedirects[0].from, 'deepseek:deepseek-flash');
  assert.equal(route.policyRedirects[0].to, 'claude:claude-haiku-5-5:low');
});

test('policy: DeepSeek never gets personal data even when the config allows it', () => {
  const loose = { ...POLICY, providers: { ...POLICY.providers, deepseek: { allow: ['public', 'business', 'personal', 'transcript'] } } };
  assert.equal(providerAllows(loose, 'deepseek', 'personal').allowed, false);
  assert.equal(providerAllows(loose, 'deepseek', 'transcript').allowed, false);
  assert.equal(providerAllows(loose, 'deepseek', 'business').allowed, true);
  assert.match(core.validatePolicy(loose).warnings.join(' '), /never sends them to deepseek/);
});

test('policy: Gemini sees client data only with a confirmed paid tier', () => {
  assert.equal(providerAllows(POLICY, 'gemini', 'public').allowed, true);
  assert.equal(providerAllows(POLICY, 'gemini', 'business').allowed, false);
  const paidNoDate = { ...POLICY, providers: { ...POLICY.providers, gemini: { ...POLICY.providers.gemini, billingTier: 'paid' } } };
  assert.equal(providerAllows(paidNoDate, 'gemini', 'business').allowed, false);
  const paid = { ...POLICY, providers: { ...POLICY.providers, gemini: { ...POLICY.providers.gemini, billingTier: 'paid', paidTierConfirmedAt: '2026-10-23' } } };
  assert.equal(providerAllows(paid, 'gemini', 'transcript').allowed, true);
  const route = router({ AI_PROFILE: 'test' }).resolveRoute('qa.client-shot');
  assert.equal(route.primary.provider, 'claude');
  assert.equal(route.policyRedirects[0].from, 'gemini:gemini-2.5-flash-lite');
});

test('person fields make a payload personal; dates, prices and org numbers do not', () => {
  assert.equal(detectPersonFields({ contact: { email: 'kari@example.no' } }).found, true);
  assert.deepEqual(detectPersonFields({ owner: { firstName: 'Kari' } }).fields, ['owner.firstName']);
  assert.ok(detectPersonFields('Ring oss på 92 34 56 78').patterns.includes('phone'));
  assert.ok(detectPersonFields('Call +47 923 45 678').patterns.includes('phone'));
  assert.ok(detectPersonFields('mail: post@firma.no').patterns.includes('email'));
  const clean = detectPersonFields({ name: 'Fjordbakeriet AS', products: [{ name: 'Sko', price: '1 299' }], orgNr: '923 456 789', at: '2026-10-23T10:02:11Z', date: '2026 10 23', firstName: '', id: 'run_12345678abc' });
  assert.equal(clean.found, false, JSON.stringify(clean));
  const withImage = detectPersonFields({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'Ab+12345678/Cd' } }, { type: 'text', text: 'Check the hero' }] }] });
  assert.equal(withImage.found, false, 'image blocks are not scanned');
});

test('effective data class: ctx.dataClass raises it, synthetic and redacted lower it', () => {
  const spec = TASKS['copy.write'];
  assert.equal(effectiveDataClass({ task: spec, ctx: {} }).effective, 'business');
  assert.equal(effectiveDataClass({ task: spec, ctx: { dataClass: 'personal' } }).effective, 'personal');
  assert.equal(effectiveDataClass({ task: spec, ctx: {}, payload: { phone: '+47 92345678' } }).effective, 'personal');
  assert.equal(effectiveDataClass({ task: TASKS['brief.read'], ctx: { redacted: true } }).effective, 'business');
  assert.equal(effectiveDataClass({ task: TASKS['brief.read'], ctx: { synthetic: true } }).effective, 'public');
  const synthetic = router({ AI_PROFILE: 'test' }).resolveRoute('brief.read', { synthetic: true });
  assert.equal(synthetic.primary.provider, 'deepseek', 'synthetic fixtures may use the test profile');
});

test('policy: a redirect that cannot see images is not used for a vision task', () => {
  const policy = { ...POLICY, redirect: 'deepseek:deepseek-flash' };
  const r = createRouter({ tasks: TASKS, routes: ROUTES, policy, env: { AI_PROFILE: 'test' } });
  assert.throws(() => r.resolveRoute('qa.client-shot'), (e) => e.code === 'policy_blocked' && /needs vision/.test(e.message));
});

test('env route overrides are checked at load like config routes', () => {
  assert.throws(() => router({ AI_ROUTE_PLAN_EDIT: 'openai:gpt-9' }), /AI_ROUTE_PLAN_EDIT: model "gpt-9" has no price entry/);
  assert.throws(() => router({ AI_ROUTE_DEFAULT: 'claude:claude-3-opus' }), /AI_ROUTE_DEFAULT/);
  assert.match(router({ AI_ROUTE_NO_SUCH_TASK: 'claude:claude-haiku-5-5' }).warnings.join('\n'), /AI_ROUTE_NO_SUCH_TASK matches no registered task/);
});

test('policy: nothing allowed and the redirect blocked too -> PolicyBlockedError', () => {
  const strict = { version: 1, providers: { deepseek: { allow: ['public'] } }, redirect: 'deepseek:deepseek-flash' };
  assert.throws(() => applyPolicy(parseRoute('deepseek:deepseek-flash'), 'personal', strict), (e) => e.code === 'policy_blocked');
});

// ---------- prices: 10+ hand-computed cases ----------
test('price 1: Haiku 5.5 plain call', () => {
  close(priceUsage({ model: 'claude-haiku-5-5', usage: { inputTokens: 10_000, outputTokens: 2_000 } }).usd, 0.002);
});

test('price 2: Haiku 5.5 cache read and 5-minute write', () => {
  // 5k*0.10 + 50k*0.01 + 10k*0.125 + 1k*0.50 = 2750 micro-dollars
  close(priceUsage({ model: 'claude-haiku-5-5', usage: { input_tokens: 5_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000, output_tokens: 1_000 } }).usd, 0.00275);
});

test('price 3: Haiku 5.5 long-context card when the prompt (input + cache) is over 100k', () => {
  // 110k prompt: 90k*0.50 + 20k*0.05 + 2k*2.50 = 51000 micro-dollars
  const priced = priceUsage({ model: 'claude-haiku-5-5', usage: { inputTokens: 90_000, cacheReadTokens: 20_000, outputTokens: 2_000 } });
  close(priced.usd, 0.051);
  assert.equal(priced.longContext, true);
});

test('price 4: Haiku 5.5 exactly at the 100k threshold stays on the standard card', () => {
  close(priceUsage({ model: 'claude-haiku-5-5', usage: { inputTokens: 100_000, outputTokens: 1_000 } }).usd, 0.0105);
});

test('price 5: Sonnet 5.5 input and output', () => {
  close(priceUsage({ model: 'claude-sonnet-5-5', usage: { inputTokens: 1_000_000, outputTokens: 100_000 } }).usd, 3);
});

test('price 6: Sonnet 5.5 cache read 0.05x and 1-hour write 2x', () => {
  const usage = { cache_read_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 } };
  close(priceUsage({ model: 'claude-sonnet-5-5', usage }).usd, 4.1);
});

test('price 7: Opus 5.5 with the batch discount', () => {
  close(priceUsage({ model: 'claude-opus-5-5', usage: { inputTokens: 200_000, outputTokens: 50_000 } }).usd, 1.8);
  close(priceUsage({ model: 'claude-opus-5-5', usage: { inputTokens: 200_000, outputTokens: 50_000 }, batch: true }).usd, 0.9);
});

test('price 8: Opus 5.5 with US-only inference (1.1x)', () => {
  close(priceUsage({ model: 'claude-opus-5-5', usage: { inputTokens: 100_000, outputTokens: 10_000 }, inferenceGeo: 'us' }).usd, 0.66);
});

test('price 9: Gemini 2.5 Pro long-context card over 200k', () => {
  close(priceUsage({ model: 'gemini-2.5-pro', usage: { inputTokens: 250_000, outputTokens: 10_000 } }).usd, 0.775);
  close(priceUsage({ model: 'gemini-2.5-pro', usage: { inputTokens: 100_000, outputTokens: 10_000 } }).usd, 0.225);
});

test('price 10: Gemini 2.5 Flash and OpenAI cached input', () => {
  close(priceUsage({ model: 'gemini-2.5-flash', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }).usd, 2.8);
  close(priceUsage({ model: 'gpt-4.1', usage: usageFromChatResponse({ usage: { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 400_000 } } }) }).usd, 1.4);
});

test('price 11: unverified and unknown models are flagged; unknown is priced at the ceiling', () => {
  const ds = priceUsage({ model: 'deepseek-flash', usage: { inputTokens: 1_000_000 } });
  assert.equal(ds.priceVerified, false);
  assert.equal(ds.priceKnown, true);
  const unknown = priceUsage({ model: 'mystery-model', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } });
  assert.equal(unknown.priceKnown, false);
  close(unknown.usd, 30);
  close(estimateCallUsd({ model: 'deepseek-flash', inputTokens: 1_000_000, outputTokens: 0 }), 5, 1e-9);
  close(estimateCallUsd({ model: 'claude-haiku-5-5', inputTokens: 1_000_000, outputTokens: 0 }), 0.5, 1e-9);
});

test('price 12: priced from response.model, and per attempt from usage.iterations', () => {
  close(priceResponse({ requestedModel: 'claude-opus-5-5', response: { model: 'claude-haiku-5-5', usage: { input_tokens: 50_000 } } }).usd, 0.005);
  // Declined Sonnet attempt (1k in) at Sonnet rates + serving Opus attempt (1k in, 500 out) at Opus rates.
  const priced = priceResponse({
    requestedModel: 'claude-sonnet-5-5',
    response: { model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 500, iterations: [{ type: 'message', input_tokens: 1000, output_tokens: 0 }, { type: 'fallback_message', input_tokens: 1000, output_tokens: 500 }] } },
  });
  close(priced.usd, 0.016);
  assert.equal(priced.attempts, 2);
});

test('price table: every Claude price was read from the live page; ages are checked', () => {
  for (const model of core.CLAUDE_MODELS) assert.equal(core.PRICES[model].verifiedAt, '2026-10-23', model);
  const check = checkModelPrices(['claude-haiku-5-5', 'deepseek-flash', 'nope'], { now: new Date('2026-11-01T00:00:00Z') });
  assert.deepEqual(check, { ok: false, missing: ['nope'], unverified: ['deepseek-flash'], stale: [] });
  assert.deepEqual(checkModelPrices(['claude-haiku-5-5'], { now: new Date('2027-03-01T00:00:00Z') }).stale, ['claude-haiku-5-5']);
});

// ---------- Claude request builder ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    out.add(k);
    keysDeep(v, out);
  }
  return out;
}

test('claude-shape: never temperature, top_p or top_k (property test, 200 random inputs)', () => {
  const rand = rng(20261023);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  for (let i = 0; i < 200; i += 1) {
    const input = {
      model: pick(core.CLAUDE_MODELS),
      user: `case ${i}`,
      kind: pick(['json', 'text', 'tools']),
      effort: pick([undefined, ...core.EFFORTS]),
      maxTokens: Math.floor(rand() * 40000),
      system: pick(['', 'You are terse.', [{ type: 'text', text: 'sys' }]]),
      batch: rand() < 0.3,
    };
    if (rand() < 0.8) input.temperature = rand() * 2;
    if (rand() < 0.8) input.top_p = rand();
    if (rand() < 0.8) input.top_k = Math.floor(rand() * 50);
    if (rand() < 0.5) input.thinking = pick([{ type: 'disabled' }, { type: 'enabled', budget_tokens: 2048 }]);
    if (rand() < 0.4) input.schema = { type: 'object', properties: { temperature: { type: 'number', minimum: 0 } }, required: ['temperature'] };
    if (rand() < 0.3) input.tools = [{ name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string', maxLength: 9 } } } }];
    const built = buildClaudeRequest(input);
    for (const key of ['temperature', 'top_p', 'top_k']) assert.equal(key in built.params, false, `case ${i}: ${key}`);
    const topKeys = new Set(Object.keys(built.params));
    for (const key of ['temperature', 'top_p', 'top_k', 'budget_tokens']) assert.equal(topKeys.has(key), false);
    assert.deepEqual(built.params.thinking, { type: 'adaptive' });
    assert.ok(built.params.max_tokens >= 4096);
    assert.ok(core.EFFORTS.includes(built.params.output_config.effort));
    const nonSchemaKeys = keysDeep({ ...built.params, output_config: { effort: built.params.output_config.effort }, tools: undefined });
    assert.equal(nonSchemaKeys.has('top_p') || nonSchemaKeys.has('top_k') || nonSchemaKeys.has('budget_tokens'), false);
  }
});

test('claude-shape: max_tokens floor 4096, doubled per retry, capped at 128000, stream above 16000', () => {
  assert.equal(claudeMaxTokens({ taskMaxTokens: 1000 }), 4096);
  assert.equal(claudeMaxTokens({ taskMaxTokens: 1000, attempt: 2 }), 8192);
  assert.equal(claudeMaxTokens({ requested: 6000, taskMaxTokens: 1000 }), 6000);
  assert.equal(claudeMaxTokens({ requested: 100000, attempt: 2 }), 128000);
  assert.equal(buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', maxTokens: 1000, kind: 'json' }).params.max_tokens, 4096);
  const big = buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', maxTokens: 20000 });
  assert.equal(big.stream, true);
  assert.equal(buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', maxTokens: 20000, batch: true }).stream, false);
});

test('claude-shape: effort default medium, explicit effort kept, invalid effort rejected', () => {
  assert.equal(buildClaudeRequest({ model: 'claude-opus-5-5', user: 'x' }).params.output_config.effort, 'medium');
  assert.equal(buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', effort: 'low' }).params.output_config.effort, 'low');
  assert.throws(() => buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', effort: 'turbo' }), (e) => e.code === 'invalid_request');
  assert.throws(() => buildClaudeRequest({ model: 'claude-sonnet-4-6', user: 'x' }), /not allowed/);
});

test('claude-shape: JSON schema goes to output_config.format, closed and without unsupported constraints', () => {
  const schema = { name: 'Judgement', schema: { type: 'object', properties: { score: { type: 'integer', minimum: 0, maximum: 10 }, tags: { type: 'array', items: { type: 'string', maxLength: 20 }, minItems: 2, maxItems: 5 }, pattern: { type: 'string', pattern: '^a' } }, required: ['score'], additionalProperties: true } };
  const built = buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', kind: 'json', schema });
  assert.deepEqual(built.params.output_config.format, {
    type: 'json_schema',
    schema: { type: 'object', properties: { score: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } }, pattern: { type: 'string' } }, required: ['score'], additionalProperties: false },
  });
  assert.equal(schema.schema.properties.score.maximum, 10, 'the caller schema is not mutated');
  assert.equal('format' in buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', kind: 'text', schema }).params.output_config, false);
});

test('claude-shape: no assistant prefill; first message must be the user', () => {
  assert.throws(() => buildClaudeRequest({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: '{' }] }), /prefill/);
  assert.throws(() => buildClaudeRequest({ model: 'claude-haiku-5-5', messages: [{ role: 'assistant', content: 'a' }] }), /first message/);
  assert.throws(() => buildClaudeRequest({ model: 'claude-haiku-5-5', user: '' }), /user text or messages/);
});

test('claude-shape: tools are strict and tool_choice is always auto', () => {
  const built = buildClaudeRequest({ model: 'claude-sonnet-5-5', user: 'x', kind: 'tools', tools: [{ name: 'find', description: 'd', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }, { type: 'web_search_20260209', name: 'web_search' }], toolChoice: { type: 'any', disable_parallel_tool_use: true } });
  assert.equal(built.params.tools[0].strict, true);
  assert.equal(built.params.tools[0].input_schema.additionalProperties, false);
  assert.deepEqual(built.params.tools[1], { type: 'web_search_20260209', name: 'web_search' });
  assert.deepEqual(built.params.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.match(built.warnings[0], /not allowed/);
});

test('claude-shape: server-side refusal fallback on Sonnet/Opus only, never on Haiku or Batches', () => {
  const sonnet = buildClaudeRequest({ model: 'claude-sonnet-5-5', user: 'x' });
  assert.equal(sonnet.params.fallbacks, 'default');
  assert.deepEqual(sonnet.betas, ['server-side-fallback-2026-07-01']);
  assert.equal('fallbacks' in buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x' }).params, false);
  const item = buildClaudeBatchItem('job_1', { model: 'claude-opus-5-5', user: 'x' });
  assert.equal(item.custom_id, 'job_1');
  assert.equal('fallbacks' in item.params, false);
  assert.throws(() => buildClaudeBatchItem('bad id!', { model: 'claude-opus-5-5', user: 'x' }), /custom_id/);
});

test('claude-shape: system prompt is cached; images go before the text', () => {
  const jpeg = tinyJpeg(800, 600);
  const built = buildClaudeRequest({ model: 'claude-haiku-5-5', system: 'Stable prefix', user: 'Describe', images: [{ mime: 'image/jpeg', base64: jpeg.toString('base64') }] });
  assert.deepEqual(built.params.system, [{ type: 'text', text: 'Stable prefix', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(built.params.messages[0].content.map((b) => b.type), ['image', 'text']);
  assert.equal(built.imageCount, 1);
});

test('claude-shape: refusal response -> RefusalError, needs review, no cross-vendor retry', () => {
  const response = normalizeClaudeResponse({ id: 'm1', model: 'claude-haiku-5-5', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' }, content: [], usage: { input_tokens: 10, output_tokens: 0 } });
  assert.throws(() => assertNotRefused(response, { task: 'dev.plan' }), (e) => e.code === 'refusal' && e.needsReview === true && e.crossVendorRetry === false && e.category === 'cyber');
  assert.equal(classifyError(new core.RefusalError('x')).fallback, false);
});

// ---------- images ----------
function tinyJpeg(width, height) {
  // SOI, APP0 (JFIF, 16 bytes), SOF0 (17 bytes), EOI. Enough for the size reader.
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

test('images: JPEG size from the SOF marker', () => {
  assert.deepEqual(jpegSize(tinyJpeg(1568, 900)), { width: 1568, height: 900 });
  assert.equal(jpegSize(Buffer.from('\x89PNG\r\n')), null);
});

test('images: JPEG only, <= 1568 px long edge, <= 6 per call', () => {
  const ok = { mime: 'image/jpeg', base64: tinyJpeg(1568, 1000).toString('base64') };
  assert.equal(imageBlocks([ok]).length, 1);
  assert.throws(() => imageBlocks(Array(7).fill(ok)), /limit is 6/);
  assert.throws(() => imageBlocks([{ mime: 'image/png', base64: 'iVBORw0KGgo=' }]), /image\/jpeg/);
  assert.throws(() => imageBlocks([{ mime: 'image/jpeg', base64: tinyJpeg(2000, 1000).toString('base64') }]), /2000px/);
  assert.throws(() => imageBlocks([{ url: 'http://example.com/a.jpg' }]), /https/);
  assert.deepEqual(imageBlocks([{ url: 'https://example.com/a.jpg' }])[0].source, { type: 'url', url: 'https://example.com/a.jpg' });
});

test('images: prepareImage converts and shrinks to a valid block (sharp)', async (t) => {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    t.skip('sharp not installed');
    return;
  }
  const png = await sharp({ create: { width: 3000, height: 2000, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 0.5 } } }).png().toBuffer();
  const prepared = await core.prepareImage(png);
  assert.equal(prepared.mime, 'image/jpeg');
  assert.equal(prepared.width, 1568);
  assert.equal(prepared.height, 1045);
  assert.equal(imageBlocks([prepared]).length, 1);
});

// ---------- JSON ----------
test('json: extraction from fences, prose and arrays', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":{"b":[1,2]}} thanks'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJson('Result:\n[1, 2, 3]'), [1, 2, 3]);
  assert.equal(extractJson('no json here'), undefined);
});

test('json: schema validation covers the subset the facades rely on', () => {
  const schema = {
    type: 'object',
    properties: {
      kind: { enum: ['hero', 'footer'] },
      score: { type: 'integer', minimum: 0, maximum: 10 },
      tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' }, maxItems: 2 },
      at: { type: 'string', format: 'date' },
      ref: { $ref: '#/$defs/item' },
      either: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['kind', 'score'],
    additionalProperties: false,
    $defs: { item: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  };
  assert.equal(validateJson({ kind: 'hero', score: 3, tags: ['a'], at: '2026-10-23', ref: { id: 'x' }, either: null }, schema).valid, true);
  const bad = validateJson({ kind: 'nav', score: 11.5, tags: ['A', 'b', 'c'], at: '23.10.2026', ref: {}, either: 4, extra: 1 }, schema);
  const paths = bad.errors.map((e) => e.path);
  for (const path of ['/kind', '/score', '/tags', '/tags/0', '/at', '/ref/id', '/either', '/extra']) assert.ok(paths.includes(path), path);
  assert.throws(() => parseJsonOutput('{"kind":"nav"}', { name: 'X', schema }), (e) => e.code === 'schema_invalid' && e.errors.length > 0);
  assert.deepEqual(parseJsonOutput('{"kind":"hero","score":1}', schema), { kind: 'hero', score: 1 });
});

// ---------- ledger ----------
test('ledger: v2 row priced from the served model, with every contract field', () => {
  const row = buildLedgerRow({ at: '2026-10-24T10:02:11.120Z', repo: 'maker', task: 'step2.copy-judge', provider: 'claude', requestedModel: 'claude-opus-5-5', servedModel: 'claude-haiku-5-5', effort: 'medium', profile: 'prod', ctx: { runId: 'r1', salesClientId: 'sc_1', tier: 'tier-3-ecommerce' }, usage: { inputTokens: 50_000 }, images: 2, latencyMs: 4120.4 });
  for (const field of LEDGER_FIELDS) assert.ok(field in row, field);
  assert.equal(row.v, 2);
  assert.equal(row.model, 'claude-haiku-5-5');
  assert.equal(row.requestedModel, 'claude-opus-5-5');
  close(row.usd, 0.005);
  assert.equal(row.priceVerified, true);
  assert.equal(row.latencyMs, 4120);
});

test('ledger: v1 rows read as v2; summaries; API spend rows; usage readers', () => {
  const v1 = { at: '2026-10-01T00:00:00Z', provider: 'deepseek', model: 'deepseek-chat', purpose: 'copywriter', runId: 'r1', step: '2', inputTokens: 100, outputTokens: 50, usd: 0.000082 };
  const v2 = readLedgerRow(v1);
  assert.equal(v2.v, 2);
  assert.equal(v2.task, 'legacy:copywriter');
  assert.equal(v2.priceVerified, false);
  assert.equal(v2.migratedFrom, 1);
  const summary = summarizeLedger([v1, buildLedgerRow({ task: 'legacy:copywriter', provider: 'claude', servedModel: 'claude-haiku-5-5', usage: { inputTokens: 10_000 } })], 'task');
  assert.equal(summary.calls, 2);
  close(summary.groups['legacy:copywriter'].usd, 0.001082);
  close(summary.groups['legacy:copywriter'].unverifiedUsd, 0.000082);
  const api = buildApiSpendRow({ provider: 'dataforseo', task: 'seo.keywords.research', usd: 0.0123, ctx: { salesClientId: 'sc' } });
  assert.equal(api.kind, 'api');
  assert.deepEqual(usageFromChatResponse({ usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 600 } }), { inputTokens: 400, outputTokens: 200, cacheReadTokens: 600, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 });
  assert.equal(usageFromGeminiResponse({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 } }).outputTokens, 50);
});

// ---------- cassettes ----------
test('cassette keys ignore dates, UUIDs and run ids, but not content', () => {
  const a = cassetteKey({ task: 't', system: 's', user: 'Run 0f1e2d3c-4b5a-4697-8877-665544332211 at 2026-10-24T10:02:11Z on 2026-10-24 (1761300000000)' });
  const b = cassetteKey({ task: 't', system: 's', user: 'Run 11111111-2222-3333-4444-555555555555 at 2027-01-01T00:00:00Z on 2027-01-01 (1799999999999)' });
  assert.equal(a, b);
  assert.notEqual(a, cassetteKey({ task: 't', system: 's', user: 'Different text' }));
  assert.equal(cassetteKey({ task: 't', user: 'u', model: 'a' }), cassetteKey({ task: 't', user: 'u', model: 'b' }));
  assert.notEqual(cassetteKey({ task: 't', user: 'u', model: 'a', includeModel: true }), cassetteKey({ task: 't', user: 'u', model: 'b', includeModel: true }));
  assert.equal(cassettePath('golden fixture', a), `golden_fixture/${a}.json`);
  assert.throws(() => cassettePath('x', '../etc'), /sha256/);
});

test('cassette records hold no keys or tokens', () => {
  const record = cassetteRecord({ key: 'k', task: 't', provider: 'claude', model: 'claude-haiku-5-5', response: { text: 'used key sk-ant-abcdefghijklmnop and Bearer abcdefghijklmnop', usage: { input_tokens: 1 }, apiKey: 'x' } });
  const text = JSON.stringify(record);
  assert.ok(!text.includes('sk-ant-abcdefghijklmnop'));
  assert.ok(!text.includes('Bearer abcdefghijklmnop'));
  assert.deepEqual(scrubSecrets({ headers: { Authorization: 'x', 'x-api-key': 'y', ok: 1 } }), { headers: { ok: 1 } });
});

// ---------- budgets ----------
test('budgets: expected cost scales with pages, locales, products and tier', () => {
  close(expectedCostUsd(BUDGETS, 'run', { tier: 'tier-3-ecommerce', projectSize: { pages: 6 } }), 3);
  close(expectedCostUsd(BUDGETS, 'run', { tier: 3, projectSize: { pages: 12, locales: 2 } }), 10.5); // 12 x 1.75 = 21 units -> 3.5 x $3
  close(expectedCostUsd(BUDGETS, 'run', { tier: 1, projectSize: { pages: 6, products: 240 } }), 3); // 6 + 12 units -> 3 x $1
  close(expectedCostUsd(BUDGETS, 'devSession', { tier: 2, projectSize: { pages: 3 } }), 2.5);
  close(expectedCostUsd(BUDGETS, 'iteration', { tier: 2, projectSize: { pages: 3 } }), 1.25);
  assert.equal(expectedCostUsd(BUDGETS, 'nope', {}), null);
  assert.equal(validateBudgetsConfig(BUDGETS).ok, true);
  assert.equal(validateBudgetsConfig({ version: 1, alertRatio: 5, runawayFactor: 2, scopes: { run: { baseUsd: {} } } }).ok, false);
});

test('budgets: 100 % alerts and continues; only a runaway (> 5x) stops; periodic scopes never stop', () => {
  assert.equal(evaluateBudget({ expectedUsd: 2, spentUsd: 1, estimateUsd: 0.5 }).action, 'ok');
  assert.equal(evaluateBudget({ expectedUsd: 2, spentUsd: 1.9, estimateUsd: 0.1 }).action, 'alert');
  assert.equal(evaluateBudget({ expectedUsd: 2, spentUsd: 9.9, estimateUsd: 0.1 }).action, 'alert');
  const stop = evaluateBudget({ expectedUsd: 2, spentUsd: 9.9, estimateUsd: 0.2 });
  assert.equal(stop.action, 'stop');
  assert.equal(stop.reason, 'runaway');
  assert.equal(evaluateBudget({ expectedUsd: 2, spentUsd: 100, mode: 'alert-only' }).action, 'alert');
  assert.equal(evaluateBudget({ spentUsd: 100 }).action, 'ok');
});

test('loop detection: same request, same outcome 3 times, or 6 sends', () => {
  const same = [1, 2, 3].map(() => ({ task: 't', inputKey: 'k', outcomeKey: 'o' }));
  assert.equal(detectLoop(same).loop, true);
  assert.equal(detectLoop([...same.slice(0, 2), { task: 't', inputKey: 'k', outcomeKey: 'o2' }]).loop, false);
  const varied = Array.from({ length: 6 }, (_, i) => ({ task: 't', inputKey: 'k', outcomeKey: `o${i}` }));
  assert.equal(detectLoop(varied).reason, 'identical-requests');
  const detector = createLoopDetector();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(detector.before('t', 'k').loop, false);
    detector.after('t', 'k', 'same');
  }
  assert.equal(detector.before('t', 'k').loop, true);
  assert.equal(detector.before('t', 'other').loop, false);
});

// ---------- callLlm with mock providers ----------
function claudeMessage({ model = 'claude-haiku-5-5', text = '{"ok":true}', stop = 'end_turn', usage = { input_tokens: 1000, output_tokens: 200 }, content } = {}) {
  return normalizeClaudeResponse({ id: 'msg', model, stop_reason: stop, content: content || [{ type: 'text', text }], usage });
}

function makeCore({ env = { AI_PROFILE: 'prod' }, providers, ...rest } = {}) {
  const rows = [];
  const llm = createLlmCore({ tasks: TASKS, routes: ROUTES, policy: POLICY, env, legacyRoute, providers, ledger: { append: (row) => rows.push(row) }, repo: 'test', clock: () => new Date('2026-10-24T10:00:00Z'), ...rest });
  return { llm, rows };
}

test('callLlm: Claude JSON call without sampling params, parsed, ledger priced from the served model', async () => {
  const calls = [];
  const { llm, rows } = makeCore({
    providers: {
      claude: async (call) => {
        calls.push(call);
        return claudeMessage({ model: 'claude-haiku-5-5', text: '```json\n{"score":4}\n```', usage: { input_tokens: 20_000, output_tokens: 1_000 } });
      },
    },
  });
  const out = await llm.json({ task: 'cls.page', system: 'Classify.', user: 'Page text', schema: { name: 'S', schema: { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'] } }, ctx: { runId: 'r1', temperature: 0 } });
  assert.deepEqual(out.data, { score: 4 });
  assert.equal(calls.length, 1);
  const params = calls[0].claude.params;
  assert.equal('temperature' in params, false);
  assert.equal(params.max_tokens, 4096, 'classification task 1000 -> floor 4096');
  assert.equal(params.output_config.effort, 'low', 'classification effort low');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task, 'cls.page');
  assert.equal(rows[0].model, 'claude-haiku-5-5');
  close(rows[0].usd, 0.0025);
  assert.equal(out.route.ctx.runId, 'r1');
});

test('callLlm: a max_tokens stop retries once on the same model with the cap doubled', async () => {
  const caps = [];
  const { llm, rows } = makeCore({
    providers: {
      claude: async (call) => {
        caps.push(call.claude.params.max_tokens);
        return caps.length === 1 ? claudeMessage({ text: '{"partial":', stop: 'max_tokens' }) : claudeMessage({ text: '{"done":true}' });
      },
    },
  });
  const out = await llm.json({ task: 'plan.edit', user: 'Plan', maxTokens: 5000 });
  assert.deepEqual(caps, [5000, 10000], 'the per-call cap (above the 4096 floor) is doubled once');
  assert.deepEqual(out.data, { done: true });
  assert.deepEqual(rows.map((r) => [r.status, r.attempt, r.maxTokens]), [['max_tokens', 1, 5000], ['ok', 2, 10000]]);
});

test('callLlm: a second max_tokens stop falls back to the next provider', async () => {
  let deepseekCalls = 0;
  const { llm } = makeCore({
    providers: {
      claude: async () => claudeMessage({ stop: 'max_tokens', text: '{' }),
      deepseek: async () => {
        deepseekCalls += 1;
        return { servedModel: 'deepseek-flash', text: '{"ok":1}', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    },
  });
  const out = await llm.json({ task: 'plan.edit', user: 'Plan' });
  assert.equal(out.provider, 'deepseek');
  assert.equal(deepseekCalls, 1);
  assert.deepEqual(out.failures.map((f) => f.code), ['max_tokens']);
});

test('callLlm: refusal -> needs review, no other vendor is tried', async () => {
  let deepseekCalls = 0;
  const { llm, rows } = makeCore({
    providers: {
      claude: async () => normalizeClaudeResponse({ model: 'claude-haiku-5-5', stop_reason: 'refusal', stop_details: { category: 'general_harms' }, content: [], usage: { input_tokens: 100, output_tokens: 0 } }),
      deepseek: async () => {
        deepseekCalls += 1;
        return { servedModel: 'deepseek-flash', text: '{}', stopReason: 'end_turn', usage: {} };
      },
    },
  });
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'Plan' }), (e) => e.code === 'refusal' && e.needsReview === true && e.crossVendorRetry === false);
  assert.equal(deepseekCalls, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'refusal');
  assert.equal(rows[0].needsReview, true);
});

test('callLlm: a 401 marks the provider dead and falls back within the same call', async () => {
  let claudeCalls = 0;
  const { llm } = makeCore({
    providers: {
      claude: async () => {
        claudeCalls += 1;
        throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
      },
      deepseek: async () => ({ servedModel: 'deepseek-flash', text: '{"ok":true}', stopReason: 'end_turn', usage: {} }),
    },
  });
  assert.equal((await llm.json({ task: 'plan.edit', user: 'One' })).provider, 'deepseek');
  assert.equal((await llm.json({ task: 'plan.edit', user: 'Two' })).provider, 'deepseek');
  assert.equal(claudeCalls, 1, 'dead provider is skipped on later calls');
  assert.deepEqual(llm.deadProviders(), ['claude']);
});

test('callLlm: invalid JSON falls back; invalid on the last provider throws SchemaValidationError', async () => {
  const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
  const answers = { deepseek: '{"n":"x"}' };
  const { llm, rows } = makeCore({
    providers: {
      claude: async () => claudeMessage({ text: 'not json' }),
      deepseek: async () => ({ servedModel: 'deepseek-flash', text: answers.deepseek, stopReason: 'end_turn', usage: {} }),
    },
  });
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'x', schema }), (e) => e.code === 'schema_invalid' && e.failures.length === 2);
  assert.deepEqual(rows.map((r) => [r.provider, r.status]), [['claude', 'schema_invalid'], ['deepseek', 'schema_invalid']]);
  answers.deepseek = '{"n":3}';
  const out = await llm.json({ task: 'plan.edit', user: 'y', schema });
  assert.deepEqual(out.data, { n: 3 });
  assert.equal(out.provider, 'deepseek');
  assert.deepEqual(rows.slice(2).map((r) => r.status), ['schema_invalid', 'ok']);
});

test('callLlm: transcript data never reaches DeepSeek under the test profile', async () => {
  const seen = [];
  const { llm } = makeCore({
    env: { AI_PROFILE: 'test' },
    providers: {
      deepseek: async () => {
        seen.push('deepseek');
        return { servedModel: 'deepseek-flash', text: '{}', stopReason: 'end_turn', usage: {} };
      },
      claude: async (call) => {
        seen.push(call.model);
        return claudeMessage({ text: '{"ok":1}' });
      },
    },
  });
  await llm.json({ task: 'brief.read', user: 'Transcript ...' });
  await llm.json({ task: 'plan.edit', user: 'Contact Kari on kari@example.no' });
  assert.deepEqual(seen, ['claude-haiku-5-5', 'claude-haiku-5-5']);
  await llm.json({ task: 'plan.edit', user: 'Plain business text' });
  assert.deepEqual(seen, ['claude-haiku-5-5', 'claude-haiku-5-5', 'deepseek']);
});

test('callLlm: soft budget alerts and continues; a runaway stops before the provider is called', async () => {
  const alerts = [];
  let calls = 0;
  const providers = { claude: async () => (calls += 1, claudeMessage()) };
  const spent = { value: 1.999 }; // + this call's estimate crosses the $2 expected cost
  const { llm, rows } = makeCore({ providers, budgets: BUDGETS, spentUsd: async () => spent.value, onAlert: (info) => alerts.push(info) });
  await llm.json({ task: 'plan.edit', user: 'x', ctx: { runId: 'r', expectedUsd: 2 } });
  assert.equal(calls, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].action, 'alert');
  spent.value = 10.5;
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'y', ctx: { runId: 'r', expectedUsd: 2 } }), (e) => e.code === 'budget_exceeded' && e.reason === 'runaway');
  assert.equal(calls, 1);
  assert.equal(rows.at(-1).status, 'budget_blocked');
  // Expected cost from project size when no expectedUsd is given: tier-3 run, 6 pages = $3; $14 spent is under 5x.
  spent.value = 14;
  await llm.json({ task: 'plan.edit', user: 'z', ctx: { runId: 'r', tier: 3, projectSize: { pages: 6 } } });
  assert.equal(calls, 2);
});

test('callLlm: the same request with the same outcome three times is a loop', async () => {
  const { llm, rows } = makeCore({ providers: { claude: async () => claudeMessage({ text: '{"same":1}' }) } });
  for (let i = 0; i < 3; i += 1) await llm.json({ task: 'plan.edit', user: 'retry me', ctx: { runId: 'r1' } });
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'retry me', ctx: { runId: 'r1' } }), (e) => e.code === 'loop_detected' && e.reason === 'loop');
  assert.equal(rows.at(-1).status, 'loop_blocked');
  await llm.json({ task: 'plan.edit', user: 'retry me', ctx: { runId: 'r2' } });
});

test('callLlm: record profile saves a secret-free cassette', async () => {
  const saved = [];
  const { llm } = makeCore({
    env: { AI_PROFILE: 'record' },
    providers: { deepseek: async () => ({ servedModel: 'deepseek-flash', text: '{"a":1}', stopReason: 'end_turn', usage: { inputTokens: 5 } }) },
    cassettes: { save: (record) => saved.push(record) },
  });
  const out = await llm.json({ task: 'plan.edit', user: 'hello' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].key, out.cassetteKey);
  assert.equal(saved[0].model, 'deepseek-flash');
  assert.deepEqual(saved[0].response.data, { a: 1 });
});

test('callLlm: image rules and kind checks fail before any provider call', async () => {
  const { llm } = makeCore({ providers: { claude: async () => assert.fail('no call expected') } });
  const img = { mime: 'image/jpeg', base64: tinyJpeg(100, 100).toString('base64') };
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'x', images: [img] }), /not a vision task/);
  await assert.rejects(llm.json({ task: 'qa.shot', user: 'x', images: Array(7).fill(img) }), /limit is 6/);
  await assert.rejects(llm.json({ task: 'note.text', user: 'x' }), /use text/);
  await assert.rejects(llm.text({ task: 'plan.edit', user: 'x' }), /use json/);
});

test('callLlm: vision call sends JPEG blocks before the text', async () => {
  let content;
  const { llm } = makeCore({ providers: { claude: async (call) => ((content = call.claude.params.messages[0].content), claudeMessage()) } });
  await llm.json({ task: 'qa.shot', user: 'Check', images: [{ mime: 'image/jpeg', base64: tinyJpeg(1200, 800).toString('base64') }] });
  assert.deepEqual(content.map((b) => b.type), ['image', 'text']);
});

test('tools(): loops on tool_use and returns when the model ends its turn', async () => {
  let turn = 0;
  const { llm, rows } = makeCore({
    providers: {
      claude: async (call) => {
        turn += 1;
        assert.equal(call.claude.params.tool_choice.type, 'auto');
        if (turn === 1) return claudeMessage({ stop: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'lookup', input: { q: 'x' } }] });
        assert.equal(call.claude.params.messages.at(-1).content[0].type, 'tool_result');
        return claudeMessage({ text: 'Done.' });
      },
    },
  });
  const out = await llm.tools({ task: 'agent.run', system: 's', messages: [{ role: 'user', content: 'Go' }], tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }], onToolUse: async (blocks) => blocks.map((b) => ({ toolUseId: b.id, content: { hits: 1 } })) });
  assert.equal(out.text, 'Done.');
  assert.equal(out.turns, 2);
  assert.equal(rows.length, 2);
});
