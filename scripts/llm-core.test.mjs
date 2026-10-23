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
    'tpl.analyze': { kind: 'json', vision: false, dataClass: 'public', maxTokens: 8000, family: 'extraction' },
    'eval.judge': { kind: 'json', vision: true, dataClass: 'business', maxTokens: 2000, family: 'judge' },
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
      kinds: { classification: 'claude:claude-haiku-5-5:medium|deepseek:deepseek-flash', extraction: 'claude:claude-haiku-5-5:medium|deepseek:deepseek-flash', agent: 'claude:claude-haiku-5-5:medium' },
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
    openai: { allow: ['public', 'business'], tasks: ['eval.judge'] },
  },
  redirect: 'claude:claude-haiku-5-5',
};

const withGemini = (fields) => ({ ...POLICY, providers: { ...POLICY.providers, gemini: { ...POLICY.providers.gemini, ...fields } } });

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
  for (const tier of ['custom', 'gold']) {
    const route = r.resolveRoute('copy.write', { tier });
    assert.equal(route.tier, null, `${tier}: no tier override`);
    assert.equal(route.source, 'task');
    assert.match(route.warnings.join(' '), /ctx.tier "/, `${tier}: warns instead of throwing`);
  }
});

test('an unknown tier (the hub custom tier) never breaks a live call and budgets use the default base', async () => {
  const seen = [];
  const { llm } = makeCore({ providers: { claude: async () => claudeMessage() }, budgets: BUDGETS, spentUsd: async ({ scope }) => (seen.push(scope), 0) });
  const out = await llm.json({ task: 'plan.edit', user: 'x', ctx: { runId: 'r-custom', tier: 'custom' } });
  assert.equal(out.route.tier, null);
  assert.equal(out.budget.expectedUsd, 2, 'run base default for one reference project');
  assert.deepEqual(seen, ['run']);
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
  assert.equal(r.resolveRoute('tpl.analyze').route, 'deepseek:deepseek-chat');
  assert.equal(r.resolveRoute('tpl.analyze').legacy, true);
  const bare = createRouter({ tasks: TASKS, routes: ROUTES, policy: POLICY });
  assert.throws(() => bare.resolveRoute('plan.edit'), /legacyRoute/);
});

test('the data policy applies under legacy too: client data leaves legacy DeepSeek, at the task effort', () => {
  const route = router().resolveRoute('plan.edit');
  assert.equal(route.legacy, true);
  assert.equal(route.route, 'claude:claude-haiku-5-5:medium', 'real client data goes to Claude even in the legacy profile');
  assert.equal(route.policyRedirects[0].from, 'deepseek:deepseek-chat');
  assert.match(route.warnings.join(' '), /data policy replaced the whole route/);
  assert.equal(router().resolveRoute('cls.page', {}, { payload: { email: 'kari@firma.no' } }).primary.effort, 'low', 'a redirect keeps the task effort');
});

test('vision task: text-only entries are dropped, the vision route is used, with a warning', () => {
  const r = createRouter({ tasks: TASKS, routes: ROUTES, policy: withGemini({ allowUnpaidPublic: true }), env: { AI_PROFILE: 'test', AI_ROUTE_QA_SHOT: 'deepseek:deepseek-flash' }, legacyRoute });
  const route = r.resolveRoute('qa.shot');
  assert.equal(route.primary.provider, 'gemini');
  assert.match(route.warnings.join(' '), /vision/);
  assert.equal(r.resolveRoute('qa.shot', { vision: false }).primary.provider, 'deepseek', 'ctx.vision:false allows a text-only public call');
});

test('tools task needs a tool-loop provider', () => {
  assert.equal(router({ AI_PROFILE: 'test' }).resolveRoute('agent.run').primary.provider, 'claude');
  assert.throws(() => router({ AI_PROFILE: 'test', AI_ROUTE_AGENT_RUN: 'deepseek:deepseek-flash' }).resolveRoute('agent.run'), /needs tools/);
});

test('record inherits test and is flagged; replay routes to replay', () => {
  const rec = router({ AI_PROFILE: 'record' }).resolveRoute('tpl.analyze');
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
  assert.equal(route.route, 'claude:claude-haiku-5-5:medium', 'a full redirect keeps the default effort, not low');
  assert.equal(route.policyRedirects[0].from, 'deepseek:deepseek-flash');
  assert.equal(route.policyRedirects[0].to, 'claude:claude-haiku-5-5');
});

test('policy: DeepSeek never gets personal data, and client data only when synthetic or redacted, even when the config allows it', () => {
  const loose = { ...POLICY, providers: { ...POLICY.providers, deepseek: { allow: ['public', 'business', 'personal', 'transcript'] } } };
  assert.equal(providerAllows(loose, 'deepseek', 'personal').allowed, false);
  assert.equal(providerAllows(loose, 'deepseek', 'transcript').allowed, false);
  assert.equal(providerAllows(loose, 'deepseek', 'transcript', { redacted: true }).allowed, false);
  assert.equal(providerAllows(loose, 'deepseek', 'business').allowed, false, 'real client business data (Q5)');
  assert.equal(providerAllows(loose, 'deepseek', 'business', { redacted: true }).allowed, true);
  assert.equal(providerAllows(loose, 'deepseek', 'public').allowed, true);
  assert.match(core.validatePolicy(loose).warnings.join(' '), /never sends them to deepseek/);
});

test('Q5: a business task with a real payload never reaches DeepSeek or OpenAI (test profile, and prod after a Claude 5xx)', async () => {
  const payload = { user: 'Fjordbakeriet sells sourdough and cinnamon buns in Bergen.' };
  const inTest = router({ AI_PROFILE: 'test' }).resolveRoute('copy.write', {}, { payload });
  assert.deepEqual(inTest.chain.map((e) => e.provider), ['claude']);
  const prod = router({ AI_PROFILE: 'prod' }).resolveRoute('copy.write', {}, { payload });
  assert.deepEqual(prod.chain.map((e) => e.provider), ['claude'], 'the openai fallback is removed: OpenAI is limited to eval.judge');
  const called = [];
  const { llm } = makeCore({
    providers: {
      claude: async () => {
        called.push('claude');
        throw Object.assign(new Error('overloaded'), { status: 529 });
      },
      deepseek: async () => (called.push('deepseek'), { servedModel: 'deepseek-flash', text: '{}', stopReason: 'end_turn', usage: {} }),
      openai: async () => (called.push('openai'), { servedModel: 'gpt-4.1', text: '{}', stopReason: 'end_turn', usage: {} }),
    },
  });
  await assert.rejects(llm.json({ task: 'copy.write', ...payload }), (e) => e.status === 529);
  await assert.rejects(llm.json({ task: 'plan.edit', ...payload }), (e) => e.status === 529, 'prod default claude|deepseek: DeepSeek is dropped for client data');
  assert.deepEqual(called, ['claude', 'claude']);
  const redacted = router({ AI_PROFILE: 'test' }).resolveRoute('copy.write', { redacted: true }, { payload: { user: 'The bakery sells bread. Contact [NAME] at [EMAIL].' } });
  assert.equal(redacted.primary.provider, 'deepseek', 'a redacted payload may use DeepSeek');
  assert.equal(redacted.dataClass.redacted, true);
  assert.equal(router({ AI_PROFILE: 'prod' }).resolveRoute('eval.judge', { route: 'openai:gpt-4.1' }).primary.provider, 'openai', 'OpenAI stays usable as the evaluation judge');
});

test('Q5: ctx.synthetic / ctx.redacted cannot carry real person data past the policy', () => {
  const real = 'Kari Nordmann kari@firma.no 22 33 44 55';
  const synthetic = router({ AI_PROFILE: 'test' }).resolveRoute('brief.read', { synthetic: true }, { payload: { user: real } });
  assert.equal(synthetic.dataClass.synthetic, false);
  assert.equal(synthetic.dataClass.effective, 'transcript');
  assert.ok(!synthetic.chain.some((e) => e.provider === 'deepseek' || e.provider === 'gemini'));
  assert.match(synthetic.dataClass.reasons.join(' '), /synthetic flag ignored/);
  const leftover = router({ AI_PROFILE: 'test' }).resolveRoute('cls.page', { redacted: true }, { payload: { user: 'Svar til ola@firma.no' } });
  assert.equal(leftover.dataClass.redacted, false);
  assert.equal(leftover.dataClass.effective, 'personal');
  assert.ok(!leftover.chain.some((e) => e.provider === 'deepseek'));
  const nameLeft = effectiveDataClass({ task: TASKS['copy.write'], ctx: { redacted: true }, payload: { owner: { firstName: 'Kari' } } });
  assert.equal(nameLeft.redacted, false, 'a person-name field with a value means the redaction failed');
  const placeholders = effectiveDataClass({ task: TASKS['copy.write'], ctx: { redacted: true, dataClass: 'personal' }, payload: { owner: { firstName: '[NAME]' }, phone: '<PHONE>' } });
  assert.equal(placeholders.redacted, true);
  assert.equal(placeholders.effective, 'business', 'personal data with every person field redacted counts as business');
  const transcript = effectiveDataClass({ task: TASKS['brief.read'], ctx: { redacted: true }, payload: { owner: { firstName: '[NAME]' }, phone: '<PHONE>' } });
  assert.equal(transcript.redacted, false, 'redaction never lowers a transcript');
  assert.equal(transcript.effective, 'transcript');
  const fixtures = router({ AI_PROFILE: 'test' }).resolveRoute('brief.read', { synthetic: true }, { payload: { user: 'Kari Testesen kari@example.no, ola@demo.test, +47 000 00 000, 12345678, +1 555 0142' } });
  assert.equal(fixtures.dataClass.synthetic, true, 'reserved fixture values are allowed in synthetic data');
  assert.equal(fixtures.primary.provider, 'deepseek');
  assert.equal(core.isFixturePhone('22 33 44 55'), false);
  assert.equal(core.isFixtureEmailDomain('firma.no'), false);
  assert.equal(core.isFixtureEmailDomain('mail.example.com'), true);
});

test('policy: Gemini gets nothing until the paid tier is confirmed (public only with allowUnpaidPublic)', () => {
  assert.equal(providerAllows(POLICY, 'gemini', 'public').allowed, false, 'strict Q5 default');
  assert.equal(providerAllows(withGemini({ allowUnpaidPublic: true }), 'gemini', 'public').allowed, true);
  assert.equal(providerAllows(withGemini({ allowUnpaidPublic: true }), 'gemini', 'business').allowed, false);
  assert.equal(providerAllows(POLICY, 'gemini', 'business').allowed, false);
  assert.equal(providerAllows(withGemini({ billingTier: 'paid' }), 'gemini', 'business').allowed, false);
  const paid = withGemini({ billingTier: 'paid', paidTierConfirmedAt: '2026-10-23' });
  assert.equal(providerAllows(paid, 'gemini', 'transcript').allowed, true);
  assert.equal(providerAllows(paid, 'gemini', 'public').allowed, true);
  const route = router({ AI_PROFILE: 'test' }).resolveRoute('qa.client-shot');
  assert.equal(route.primary.provider, 'claude');
  assert.equal(route.policyRedirects[0].from, 'gemini:gemini-2.5-flash-lite');
  assert.equal(router({ AI_PROFILE: 'test' }).resolveRoute('qa.shot').primary.provider, 'claude', 'public screenshots too');
  assert.equal(core.validatePolicy(withGemini({ allowUnpaidPublic: 'yes' })).ok, false);
});

test('policy: provider task scopes (OpenAI only as the evaluation judge)', () => {
  assert.equal(providerAllows(POLICY, 'openai', 'business', { task: 'eval.judge', family: 'judge' }).allowed, true);
  assert.equal(providerAllows(POLICY, 'openai', 'public', { task: 'copy.write', family: 'copy' }).allowed, false);
  assert.equal(providerAllows(POLICY, 'openai', 'public').allowed, false, 'no task context: a scoped provider is not used');
  const byFamily = { ...POLICY, providers: { ...POLICY.providers, openai: { allow: ['public'], families: ['judge'] } } };
  assert.equal(providerAllows(byFamily, 'openai', 'public', { task: 'x.y', family: 'judge' }).allowed, true);
  assert.equal(core.validatePolicy({ ...POLICY, providers: { openai: { allow: ['public'], tasks: ['Bad Key'] } } }).ok, false);
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
  assert.equal(withImage.found, false, 'the base64 source of an image block is not scanned');
});

test('effective data class: ctx.dataClass raises it, synthetic lowers it, redacted lowers only personal', () => {
  const spec = TASKS['copy.write'];
  assert.equal(effectiveDataClass({ task: spec, ctx: {} }).effective, 'business');
  assert.equal(effectiveDataClass({ task: spec, ctx: { dataClass: 'personal' } }).effective, 'personal');
  assert.equal(effectiveDataClass({ task: spec, ctx: {}, payload: { phone: '+47 92345678' } }).effective, 'personal');
  assert.equal(effectiveDataClass({ task: spec, ctx: { dataClass: 'personal', redacted: true } }).effective, 'business');
  assert.equal(effectiveDataClass({ task: TASKS['brief.read'], ctx: { redacted: true } }).effective, 'transcript', 'redaction never lowers a transcript');
  assert.equal(effectiveDataClass({ task: spec, ctx: { dataClass: 'transcript', redacted: true } }).effective, 'transcript', 'nor a ctx transcript class');
  assert.equal(effectiveDataClass({ task: TASKS['brief.read'], ctx: { synthetic: true } }).effective, 'public');
  const synthetic = router({ AI_PROFILE: 'test' }).resolveRoute('brief.read', { synthetic: true });
  assert.equal(synthetic.primary.provider, 'deepseek', 'synthetic fixtures may use the test profile');
});

test('policy: a redirect that cannot see images is not used for a vision task', () => {
  const policy = { ...POLICY, redirect: 'deepseek:deepseek-flash' };
  const r = createRouter({ tasks: TASKS, routes: ROUTES, policy, env: { AI_PROFILE: 'test' } });
  assert.throws(() => r.resolveRoute('qa.shot'), (e) => e.code === 'policy_blocked' && /needs vision/.test(e.message));
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

// Key-shaped strings are built at runtime so the repo holds no literal that a secret scanner flags.
const FAKE_KEY = ['sk', 'ant', 'x'.repeat(16)].join('-');
const FAKE_BEARER = `${'Bear'}er ${'b'.repeat(16)}`;

test('cassette records hold no keys or tokens, and keep the model output keys as recorded', () => {
  const record = cassetteRecord({
    key: 'k',
    task: 't',
    provider: 'claude',
    model: 'claude-haiku-5-5',
    response: {
      text: `used key ${FAKE_KEY} and ${FAKE_BEARER}`,
      data: { fields: [{ name: 'password', type: 'password' }], token: 'csrf-field', note: `leaked ${FAKE_KEY}` },
      content: [{ type: 'tool_use', id: 'tu', name: 'form', input: { password: { label: 'Passord' }, auth: 'none' } }],
      usage: { input_tokens: 1 },
      apiKey: 'x',
    },
  });
  const text = JSON.stringify(record);
  assert.ok(!text.includes(FAKE_KEY));
  assert.ok(!text.includes(FAKE_BEARER));
  assert.ok(!('apiKey' in record.response));
  assert.equal(record.response.data.token, 'csrf-field', 'a key named token inside the model data is data');
  assert.deepEqual(record.response.data.fields, [{ name: 'password', type: 'password' }]);
  assert.match(record.response.data.note, /<redacted>/);
  assert.deepEqual(record.response.content[0].input, { password: { label: 'Passord' }, auth: 'none' });
  assert.deepEqual(scrubSecrets({ headers: { Authorization: 'x', 'x-api-key': 'y', ok: 1 } }), { headers: { ok: 1 } });
  assert.deepEqual(core.maskSecretValues({ password: 'p', key: FAKE_KEY }), { password: 'p', key: '<redacted>' });
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

test('loop detection: same request, same outcome 3 times in a row, or 6 sends, inside one window', () => {
  const same = [1, 2, 3].map(() => ({ task: 't', inputKey: 'k', outcomeKey: 'o' }));
  assert.equal(detectLoop(same).loop, true);
  assert.equal(detectLoop([...same.slice(0, 2), { task: 't', inputKey: 'k', outcomeKey: 'o2' }]).loop, false);
  const varied = Array.from({ length: 6 }, (_, i) => ({ task: 't', inputKey: 'k', outcomeKey: `o${i}` }));
  assert.equal(detectLoop(varied).reason, 'identical-requests');
  const daily = [0, 1, 2, 3].map((day) => ({ task: 't', inputKey: 'k', outcomeKey: 'o', at: day * 86_400_000 }));
  assert.equal(detectLoop(daily).loop, false, 'the same request on four days is not a loop');
  let t = 0;
  const detector = createLoopDetector({ now: () => t });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(detector.before('t', 'k').loop, false);
    detector.after('t', 'k', 'same');
    t += 1000;
  }
  assert.equal(detector.before('t', 'k').loop, true);
  assert.equal(detector.before('t', 'other').loop, false);
  t += 16 * 60_000;
  assert.equal(detector.before('t', 'k').loop, false, 'the block expires with the window');
  const short = createLoopDetector({ now: () => t, windowMinutes: 1 });
  for (let i = 0; i < 3; i += 1) short.after('t', 'k', 'same');
  t += 61_000;
  assert.equal(short.before('t', 'k').loop, false, 'windowMinutes from ai-budgets.json');
});

test('budgets: a run with no project size still stops at more than 5x the base; periodic totals alert and never stop', async () => {
  const budgets = { ...BUDGETS, periodic: { clientMonthUsd: 10, hubDayUsd: 5 } };
  const alerts = [];
  let calls = 0;
  const spent = { run: 0, clientMonth: 0, hubDay: 0 };
  const { llm, rows } = makeCore({
    providers: { claude: async () => (calls += 1, claudeMessage()) },
    budgets,
    repo: 'hub',
    spentUsd: async ({ scope }) => spent[scope] ?? 0,
    onAlert: (info) => alerts.push(info),
  });
  spent.run = 1_000_000;
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'x', ctx: { runId: 'r1', salesClientId: 'sc1' } }), (e) => e.code === 'budget_exceeded' && e.expectedUsd === 2 && e.sizeKnown === false);
  assert.equal(calls, 0);
  assert.equal(rows.at(-1).status, 'budget_blocked');
  spent.run = 0;
  spent.clientMonth = 500;
  spent.hubDay = 50;
  const out = await llm.json({ task: 'plan.edit', user: 'y', ctx: { runId: 'r1', salesClientId: 'sc1' } });
  assert.equal(calls, 1, 'periodic totals far over their caps never stop a call');
  assert.deepEqual(out.budgetAlerts.map((a) => a.scope).sort(), ['clientMonth', 'hubDay']);
  assert.ok(alerts.some((a) => a.periodic && a.scope === 'clientMonth' && a.action === 'alert'));
  // A hub call with no run or session: no scaled scope, periodic only.
  const loose = await llm.json({ task: 'plan.edit', user: 'z', ctx: {} });
  assert.equal(loose.budget, null);
  assert.equal(core.periodicScopesFor(budgets, { ctx: {}, task: 'eval.judge', repo: 'maker' }).length, 0);
  assert.deepEqual(core.periodicScopesFor({ periodic: { evalTotalUsd: 200, makerDayUsd: 15 } }, { ctx: {}, task: 'eval.judge', repo: 'maker' }).map((p) => p.scope), ['makerDay', 'eval']);
  assert.equal(validateBudgetsConfig({ ...budgets, periodic: { weeklyUsd: 3 } }).ok, false);
  assert.equal(validateBudgetsConfig({ ...budgets, loop: { maxRepeats: 3, windowMinutes: 0 } }).ok, false);
});

test('budgets: without a spentUsd hook the core tallies spend per run, so a runaway still stops', async () => {
  let calls = 0;
  const { llm } = makeCore({ providers: { claude: async () => (calls += 1, claudeMessage({ usage: { input_tokens: 0, output_tokens: 200_000 } })) } });
  // $0.10 per call on Haiku (200k output); expected $0.05 -> stop once projected spend is over $0.25.
  for (let i = 0; i < 3; i += 1) await llm.json({ task: 'plan.edit', user: `step ${i}`, ctx: { runId: 'tally', expectedUsd: 0.05 } });
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'step 9', ctx: { runId: 'tally', expectedUsd: 0.05 } }), (e) => e.code === 'budget_exceeded');
  assert.equal(calls, 3);
  await llm.json({ task: 'plan.edit', user: 'other run', ctx: { runId: 'fresh', expectedUsd: 0.05 } });
  assert.equal(calls, 4, 'the tally is per run');
});

test('budgets: image blocks in messages count ~1600 tokens each, not their base64 length', () => {
  const base64 = 'A'.repeat(300_000);
  const messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } }, { type: 'text', text: 'x'.repeat(35) }] }];
  assert.equal(core.estimateInputTokens({ messages }), 1600 + 10);
  const toolResult = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', data: base64 } }] }] }];
  assert.equal(core.estimateInputTokens({ messages: toolResult }), 1600);
  assert.equal(core.estimateInputTokens({ user: 'x'.repeat(70), images: 2 }), 20 + 3200);
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
  const out = await llm.json({ task: 'tpl.analyze', user: 'Template HTML' });
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
  await assert.rejects(llm.json({ task: 'tpl.analyze', user: 'Template HTML' }), (e) => e.code === 'refusal' && e.needsReview === true && e.crossVendorRetry === false);
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
  assert.equal((await llm.json({ task: 'tpl.analyze', user: 'One' })).provider, 'deepseek');
  assert.equal((await llm.json({ task: 'tpl.analyze', user: 'Two' })).provider, 'deepseek');
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
  await assert.rejects(llm.json({ task: 'tpl.analyze', user: 'x', schema }), (e) => e.code === 'schema_invalid' && e.failures.length === 2);
  assert.deepEqual(rows.map((r) => [r.provider, r.status]), [['claude', 'schema_invalid'], ['deepseek', 'schema_invalid']]);
  answers.deepseek = '{"n":3}';
  const out = await llm.json({ task: 'tpl.analyze', user: 'y', schema });
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
  assert.deepEqual(seen.slice(2), ['claude-haiku-5-5'], 'real client business text stays on Claude (Q5)');
  await llm.json({ task: 'tpl.analyze', user: 'Template HTML' });
  await llm.json({ task: 'plan.edit', user: 'The bakery sells bread; contact [EMAIL]', ctx: { redacted: true } });
  await llm.json({ task: 'brief.read', user: 'Fixture transcript with ola@demo.test', ctx: { synthetic: true } });
  assert.deepEqual(seen.slice(3), ['deepseek', 'deepseek', 'deepseek'], 'public, redacted and synthetic data may use DeepSeek');
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

test('callLlm: the same request failing the same way three times in a row is a loop', async () => {
  const answers = { text: 'not json' };
  const { llm, rows } = makeCore({ providers: { claude: async () => claudeMessage({ text: answers.text }) } });
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  for (let i = 0; i < 3; i += 1) await assert.rejects(llm.json({ task: 'plan.edit', user: 'retry me', schema, ctx: { runId: 'r1' } }), (e) => e.code === 'schema_invalid');
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'retry me', schema, ctx: { runId: 'r1' } }), (e) => e.code === 'loop_detected' && e.reason === 'loop');
  assert.equal(rows.at(-1).status, 'loop_blocked');
  answers.text = '{"ok":true}';
  assert.deepEqual((await llm.json({ task: 'plan.edit', user: 'retry me', schema, ctx: { runId: 'r2' } })).data, { ok: true }, 'another run is another scope');
  assert.deepEqual((await llm.json({ task: 'plan.edit', user: 'a different request', schema, ctx: { runId: 'r1' } })).data, { ok: true });
});

test('callLlm: record profile saves a secret-free cassette', async () => {
  const saved = [];
  const { llm } = makeCore({
    env: { AI_PROFILE: 'record' },
    providers: { deepseek: async () => ({ servedModel: 'deepseek-flash', text: '{"a":1}', stopReason: 'end_turn', usage: { inputTokens: 5 } }) },
    cassettes: { save: (record) => saved.push(record) },
  });
  const out = await llm.json({ task: 'tpl.analyze', user: 'hello' });
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

// ---------- review fixes (2026-10-23) ----------
test('callLlm: unscoped calls are never loop-blocked; a scoped retry loop is, and its block expires', async () => {
  let now = Date.parse('2026-10-24T10:00:00Z');
  const { llm } = makeCore({ providers: { claude: async () => claudeMessage({ text: '{"category":"lead"}' }) }, clock: () => now });
  for (let day = 0; day < 8; day += 1) {
    const out = await llm.json({ task: 'cls.page', user: `Inbox mail received ${new Date(now).toISOString().slice(0, 10)}: same text` });
    assert.equal(out.provider, 'claude', `day ${day + 1}`);
    now += 86_400_000;
  }
  for (let i = 0; i < 10; i += 1) await llm.json({ task: 'cls.page', user: 'same text, same minute' });
  // Caller-marked retries of the same request that keep giving the same answer are a loop.
  for (let i = 0; i < 3; i += 1) await llm.json({ task: 'cls.page', user: 'retry me', ctx: { jobId: 'job-1', retryOf: 'call-1' } });
  await assert.rejects(llm.json({ task: 'cls.page', user: 'retry me', ctx: { jobId: 'job-1', retryOf: 'call-1' } }), (e) => e.code === 'loop_detected');
  now += 16 * 60_000;
  assert.equal((await llm.json({ task: 'cls.page', user: 'retry me', ctx: { jobId: 'job-1', retryOf: 'call-1' } })).provider, 'claude', 'the block expired with the window');
});

test('loops (Q6): successful repeats inside one run are legitimate work and never blocked', async () => {
  let calls = 0;
  const { llm } = makeCore({ providers: { claude: async () => (calls += 1, claudeMessage({ text: '{"icon":"phone"}' })) } });
  // The same section repeated on several pages: the same icon request, answered the same way every time.
  for (let i = 0; i < 12; i += 1) assert.deepEqual((await llm.json({ task: 'cls.page', user: 'Icon for: Telefon', ctx: { runId: 'run-icons' } })).data, { icon: 'phone' });
  assert.equal(calls, 12);
  // Attempt counters mark retries too: the same answer three times on attempt 2+ is no progress.
  for (let i = 2; i <= 4; i += 1) await llm.json({ task: 'cls.page', user: 'Icon for: Kart', ctx: { runId: 'run-icons', attempt: i } });
  await assert.rejects(llm.json({ task: 'cls.page', user: 'Icon for: Kart', ctx: { runId: 'run-icons', attempt: 5 } }), (e) => e.code === 'loop_detected');
  // A success between failures ends the streak.
  const detector = createLoopDetector({ now: () => 0 });
  detector.after('t', 'k', 'error:529');
  detector.after('t', 'k', 'error:529');
  detector.after('t', 'k', 'ok:1', { progress: true });
  detector.after('t', 'k', 'error:529');
  assert.equal(detector.before('t', 'k').loop, false);
});

test('loops: requests that differ only by a UUID or date are different requests; each model is its own key', async () => {
  const seen = [];
  const { llm } = makeCore({
    providers: {
      claude: async (call) => (seen.push(call.model), claudeMessage({ model: call.model, text: 'not json' })),
      deepseek: async () => ({ servedModel: 'deepseek-flash', text: 'not json', stopReason: 'end_turn', usage: {} }),
    },
  });
  const schema = { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] };
  const pages = ['3f1c2a9e-4b7d-4c1e-9a2b-1d2e3f4a5b6c', '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', '0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'];
  for (const id of pages) {
    await assert.rejects(llm.json({ task: 'cls.page', user: `Page ${id}: Om oss`, schema, ctx: { runId: 'run-import' } }), (e) => e.code === 'schema_invalid', id);
  }
  for (const day of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) {
    await assert.rejects(llm.json({ task: 'cls.page', user: `Changes on ${day}`, schema, ctx: { runId: 'run-import' } }), (e) => e.code === 'schema_invalid', day);
  }
  // The exact same request failing a fourth time is a loop...
  for (let i = 0; i < 2; i += 1) await assert.rejects(llm.json({ task: 'cls.page', user: `Page ${pages[0]}: Om oss`, schema, ctx: { runId: 'run-import' } }), (e) => e.code === 'schema_invalid');
  await assert.rejects(llm.json({ task: 'cls.page', user: `Page ${pages[0]}: Om oss`, schema, ctx: { runId: 'run-import' } }), (e) => e.code === 'loop_detected');
  // ...but the next step up the escalation ladder (another model or effort: here Haiku low -> medium) is a new request.
  await assert.rejects(llm.json({ task: 'cls.page', user: `Page ${pages[0]}: Om oss`, schema, ctx: { runId: 'run-import', escalation: 1 } }), (e) => e.code === 'schema_invalid');
  assert.equal(seen.length, 4 + 4 + 2 + 1);
});

test('loops: replay calls are never loop-checked', async () => {
  let calls = 0;
  const { llm } = makeCore({
    env: { AI_PROFILE: 'replay' },
    providers: {
      replay: async () => {
        calls += 1;
        throw new core.CassetteMissError('no cassette');
      },
    },
  });
  for (let i = 0; i < 6; i += 1) await assert.rejects(llm.json({ task: 'plan.edit', user: 'golden', ctx: { runId: 'golden-1' } }), (e) => e.code === 'cassette_miss');
  assert.equal(calls, 6);
});

test('callLlm: only Claude retries a max_tokens stop with a doubled cap; other vendors fall back', async () => {
  const caps = [];
  const { llm, rows } = makeCore({
    env: { AI_PROFILE: 'test' },
    providers: {
      deepseek: async (call) => (caps.push(call.maxTokens), { servedModel: 'deepseek-flash', text: '{"partial":', stopReason: 'max_tokens', usage: {} }),
      claude: async () => claudeMessage({ text: '{"ok":1}' }),
    },
  });
  const out = await llm.json({ task: 'tpl.analyze', user: 'Template', ctx: { route: 'deepseek:deepseek-flash|claude:claude-haiku-5-5' } });
  assert.deepEqual(caps, [8000], 'DeepSeek is not retried at 16000');
  assert.equal(out.provider, 'claude');
  assert.deepEqual(rows.map((r) => [r.provider, r.status, r.maxTokens]), [['deepseek', 'max_tokens', 8000], ['claude', 'ok', 8000]]);
  assert.equal(core.shouldRetryMaxTokens('max_tokens', 1, 'gemini'), false);
});

test('callLlm: a caller abort stops the chain; no other provider is tried', async () => {
  const called = [];
  const { llm } = makeCore({
    providers: {
      claude: async () => {
        called.push('claude');
        const error = new Error('Request was aborted.');
        error.name = 'APIUserAbortError';
        throw error;
      },
      deepseek: async () => (called.push('deepseek'), { servedModel: 'deepseek-flash', text: '{}', stopReason: 'end_turn', usage: {} }),
    },
  });
  await assert.rejects(llm.json({ task: 'tpl.analyze', user: 'x' }), (e) => e.name === 'APIUserAbortError' && e.aborted === true);
  assert.deepEqual(called, ['claude']);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(llm.json({ task: 'tpl.analyze', user: 'y', signal: controller.signal }), (e) => e.name === 'AbortError');
  assert.deepEqual(called, ['claude'], 'an already-aborted signal calls no provider');
  assert.equal(classifyError(Object.assign(new Error('x'), { name: 'AbortError' })).fallback, false);
  assert.equal(classifyError(Object.assign(new Error('x'), { status: 503 })).fallback, true);
});

test('callLlm: replay attempts cost nothing; the recorded model goes to replayOf', async () => {
  const { llm, rows } = makeCore({
    env: { AI_PROFILE: 'replay' },
    providers: { replay: async () => ({ servedModel: 'claude-opus-5-5', text: '{"a":1}', stopReason: 'end_turn', usage: { inputTokens: 25_000, outputTokens: 2_500 } }) },
  });
  const out = await llm.json({ task: 'plan.edit', user: 'hello', ctx: { runId: 'golden-1' } });
  assert.equal(out.usd, 0);
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].priceVerified, true);
  assert.equal(rows[0].provider, 'replay');
  assert.equal(rows[0].replayOf, 'claude-opus-5-5');
  assert.notEqual(rows[0].model, 'claude-opus-5-5');
});

test('claude-shape: open maps and untyped objects skip structured output (they would be closed to {})', () => {
  const map = { type: 'object', properties: { translations: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['translations'] };
  const built = buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', kind: 'json', schema: map });
  assert.equal('format' in built.params.output_config, false);
  assert.equal(built.jsonMode, 'prompt');
  assert.match(built.warnings.join(' '), /open objects at \/properties\/translations/);
  const untyped = buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', kind: 'json', schema: { type: 'object', properties: { meta: { type: 'object' } } } });
  assert.equal('format' in untyped.params.output_config, false);
  assert.deepEqual(core.openObjectPaths({ type: 'object', properties: { list: { type: 'array', items: { $ref: '#/$defs/m' } } }, $defs: { m: { type: 'object', additionalProperties: true } } }), ['/$defs/m']);
  const closed = buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', kind: 'json', schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true } });
  assert.equal(closed.jsonMode, 'structured', 'declared properties with additionalProperties:true close without data loss');
  assert.equal(closed.params.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(core.openObjectPaths({ type: 'object', properties: { e: { enum: [{ type: 'object' }] } } }), [], 'enum values are not schemas');
  const tool = buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', kind: 'tools', tools: [{ name: 'save', input_schema: map }] });
  assert.equal(tool.params.tools[0].strict, false);
  assert.deepEqual(tool.params.tools[0].input_schema.properties.translations.additionalProperties, { type: 'string' });
});

test('callLlm: a map schema reaches Claude without format and the map survives client-side validation', async () => {
  let params;
  const { llm } = makeCore({ providers: { claude: async (call) => ((params = call.claude.params), claudeMessage({ text: '{"translations":{"hero":"Hei","cta":"Bestill"}}' })) } });
  const schema = { type: 'object', properties: { translations: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['translations'] };
  const out = await llm.json({ task: 'plan.edit', user: 'Translate', schema });
  assert.equal('format' in params.output_config, false);
  assert.deepEqual(out.data.translations, { hero: 'Hei', cta: 'Bestill' });
});

test('prices: server-side fallback models are priced and verified (Opus 5, Opus 4.8, Sonnet 5)', () => {
  for (const model of core.CLAUDE_FALLBACK_MODELS) {
    assert.equal(core.PRICES[model].verifiedAt, '2026-10-23', model);
    assert.equal(core.PRICES[model].fallbackOnly, true, model);
  }
  // Declined Opus 5.5 attempt (1k in) + Opus 5 fallback (1k in, 1k out): 4000 + 5000 + 25000 micro-dollars.
  const priced = priceResponse({
    requestedModel: 'claude-opus-5-5',
    response: { model: 'claude-opus-5', usage: { input_tokens: 1000, output_tokens: 1000, iterations: [{ type: 'message', input_tokens: 1000, output_tokens: 0 }, { type: 'fallback_message', input_tokens: 1000, output_tokens: 1000 }] } },
  });
  close(priced.usd, 0.034);
  assert.equal(priced.priceVerified, true);
  close(priceUsage({ model: 'claude-sonnet-5', usage: { inputTokens: 1_000_000, cacheReadTokens: 1_000_000 } }).usd, 2.2);
  close(priceUsage({ model: 'claude-opus-4-8', usage: { cacheWrite1hTokens: 1_000_000, outputTokens: 100_000 } }).usd, 12.5);
  assert.throws(() => parseRoute('claude:claude-opus-5'), (e) => e.code === 'route_config', 'routes still name only the 5.5 models');
});

test('person-field detection is linear: hostile and large strings finish fast', () => {
  const svgPath = Array.from({ length: 9000 }, (_, i) => `${(i * 7) % 997}.${i % 10} ${(i * 13) % 991}`).join(' ').slice(0, 64_000);
  const cases = {
    letters: 'a'.repeat(200_000),
    atDots: `a@${'a.'.repeat(25_000)}`,
    manyAts: 'a@'.repeat(100_000),
    svgPath: `<path d="M${svgPath}"/>`,
    digits: '1'.repeat(200_000),
    plusDigits: '+12345678901234567890'.repeat(9000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const started = performance.now();
    const found = detectPersonFields({ html: text });
    const ms = performance.now() - started;
    assert.ok(ms < 50, `${name}: ${ms.toFixed(1)} ms`);
    if (name === 'svgPath' || name === 'letters' || name === 'atDots') assert.equal(found.found, false, `${name}: ${JSON.stringify(found)}`);
  }
});

test('phone detection skips compact dates and number runs; still finds real numbers', () => {
  assert.equal(detectPersonFields('Endret 20261023 kl 10').found, false, 'YYYYMMDD is a date');
  assert.equal(detectPersonFields('<path d="M12 34 56 78 90 12 34 56"/>').found, false, 'SVG coordinates are not phones');
  assert.equal(detectPersonFields('points="0.12345678,4"').found, false);
  assert.deepEqual(detectPersonFields('Ring 92345678.').realPatterns, ['phone']);
  assert.deepEqual(detectPersonFields('Tlf: 92 34 56 78, e-post post@firma.no').realPatterns.sort(), ['email', 'phone']);
  assert.deepEqual(detectPersonFields({ contact: 'kari@example.no' }).realPatterns, [], 'a fixture email is a pattern, not a real one');
});

// ---------- review fixes, round 2 (2026-10-23) ----------
test('Q5: a person-field scan that hits its limits fails closed (no synthetic/redacted downgrade)', () => {
  const r = router({ AI_PROFILE: 'test' });
  // 1) Redacted business payload with a real email and phone after 420k characters (data repeats the user text).
  const filler = 'x'.repeat(420_000);
  const late = r.resolveRoute('copy.write', { redacted: true }, { payload: { user: `${filler} kari@firma.no 912 34 567`, data: { user: filler } } });
  assert.equal(late.dataClass.redacted, false);
  assert.equal(late.primary.provider, 'claude');
  // 2) Synthetic payload with 6000 items before contact.email.
  const items = Array.from({ length: 6000 }, (_, i) => ({ n: i, label: `item ${i}` }));
  const many = r.resolveRoute('cls.page', { synthetic: true }, { payload: { data: { items, contact: { email: 'kari@firma.no' } } } });
  assert.equal(many.dataClass.synthetic, false);
  assert.ok(!many.chain.some((e) => e.provider === 'deepseek'));
  // 3) 10,001 CSS @media rules (310k characters) before a real email.
  const css = '@media (min-width:1px){a{b:c}}'.repeat(10_001);
  const media = effectiveDataClass({ task: TASKS['copy.write'], ctx: { redacted: true }, payload: { user: `${css} kari@firma.no` } });
  assert.deepEqual(media.personFields.realPatterns, ['email']);
  assert.equal(media.redacted, false);
  // At the limits: truncated, personal, and both flags refused.
  const small = { maxChars: 1000, maxNodes: 50, maxDepth: 8 };
  assert.deepEqual(detectPersonFields({ user: 'x'.repeat(1001) }, small).truncatedBy, ['chars']);
  assert.deepEqual(detectPersonFields({ list: Array.from({ length: 60 }, () => ({})) }, small).truncatedBy, ['nodes']);
  let deep = { leaf: 'x' };
  for (let i = 0; i < 20; i += 1) deep = { child: deep };
  assert.deepEqual(detectPersonFields(deep, small).truncatedBy, ['depth']);
  assert.equal(detectPersonFields({ list: Array.from({ length: 49_000 }, (_, i) => `text ${i}`) }).truncated, false, 'strings do not count as nodes');
  const huge = { user: `${'x'.repeat(core.PERSON_SCAN_LIMITS.maxChars)} more` };
  for (const flag of ['synthetic', 'redacted']) {
    const out = effectiveDataClass({ task: TASKS['cls.page'], ctx: { [flag]: true }, payload: huge });
    assert.equal(out[flag], false, flag);
    assert.equal(out.effective, 'personal', flag);
    assert.match(out.reasons.join(' '), /truncated/, flag);
  }
  // Shared references and typed arrays are not walked twice or byte by byte.
  const shared = { text: 'hello' };
  assert.equal(detectPersonFields({ a: shared, b: shared, c: new Uint8Array(1_000_000) }).truncated, false);
});

test('Q5: a redacted transcript never reaches DeepSeek (names in free text cannot be detected)', () => {
  const r = router({ AI_PROFILE: 'test' });
  const route = r.resolveRoute('brief.read', { redacted: true }, { payload: { user: 'Kari Nordmann (daglig leder) sa at Ola Hansen skal levere bildene.' } });
  assert.equal(route.dataClass.effective, 'transcript');
  assert.equal(route.dataClass.redacted, false);
  assert.match(route.dataClass.reasons.join(' '), /only by synthetic/);
  assert.ok(!route.chain.some((e) => e.provider === 'deepseek'));
  assert.ok(!r.resolveRoute('copy.write', { redacted: true, dataClass: 'transcript' }, { payload: { user: 'redacted' } }).chain.some((e) => e.provider === 'deepseek'));
  assert.equal(r.resolveRoute('brief.read', { synthetic: true }, { payload: { user: 'Kari Testesen sa hei.' } }).primary.provider, 'deepseek', 'synthetic transcripts may still use DeepSeek');
});

test('person fields: image and document blocks skip only their binary source', () => {
  const media = detectPersonFields({ type: 'image', caption: 'Ring Kari på 912 34 567', alt: 'kari@firma.no', source: { type: 'base64', media_type: 'image/jpeg', data: '/12345678/+4791234567' } });
  assert.deepEqual(media.realPatterns.sort(), ['email', 'phone']);
  const textDoc = effectiveDataClass({ task: TASKS['copy.write'], ctx: { redacted: true }, payload: { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Kontakt: kari@firma.no' } }] }] } });
  assert.equal(textDoc.redacted, false, 'a text-source document is scanned');
  for (const source of [{ type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ12345678' }, { type: 'url', url: 'https://example.com/a.pdf' }, { type: 'file', file_id: 'file_12345678' }]) {
    assert.equal(detectPersonFields({ type: 'document', title: 'Brochure', source }).found, false, source.type);
  }
  assert.equal(detectPersonFields('<img src="data:image/png;base64,iVBOR/12345678/w0KGgo=" alt="Logo">').found, false, 'inline base64 data URLs are binary');
  assert.ok(detectPersonFields('<img src="data:image/png;base64,iVBOR" alt="Ring 912 34 567">').realPatterns.includes('phone'), 'text around a data URL is still scanned');
});

test('person fields: IDN email domains, dashed numbers and 47-prefixed numbers', () => {
  assert.deepEqual(detectPersonFields('post@blåbærkafé.no').realPatterns, ['email']);
  assert.deepEqual(detectPersonFields('bjørn@xn--blbrkaf-gua.no').realPatterns, ['email']);
  assert.deepEqual(detectPersonFields('kari@example.no').realPatterns, [], 'a fixture domain stays a fixture');
  for (const text of ['Ring 912-34-567', 'Ring 91-23-45-67', 'tlf 4791234567', 'tlf 004791234567']) {
    assert.deepEqual(detectPersonFields(text).realPatterns, ['phone'], text);
  }
  for (const text of ['2026-10-23', 'ISBN 978-82-123-4567-8', 'code 12-34-56-78-90', 'id A4791234567', 'n 147912345678']) {
    assert.equal(detectPersonFields(text).found, false, text);
  }
  assert.equal(detectPersonFields('tlf 4700000000').realPatterns.length, 0, 'fixture national part');
});

test('person-field detection stays linear without a candidate cap', () => {
  const cases = {
    manyAts: 'a@'.repeat(100_000),
    fixtures: 'kari@example.no '.repeat(20_000),
    media: '@media (min-width:1px){a{b:c}}'.repeat(10_000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const started = performance.now();
    detectPersonFields(text);
    const ms = performance.now() - started;
    assert.ok(ms < 100, `${name}: ${ms.toFixed(1)} ms`);
  }
});

test('route effort: a task-specific route keeps its effort when the policy drops only a fallback', () => {
  const tasks = parseTaskRegistry({ version: 1, tasks: { 'deep.task': { kind: 'json', vision: false, dataClass: 'business', maxTokens: 4000, effort: 'high' } } });
  const routes = (route) => ({ version: 1, profiles: { prod: { default: 'claude:claude-haiku-5-5', tasks: { 'deep.task': route } }, test: { default: 'deepseek:deepseek-flash' } } });
  const at = (route, profile = 'prod') => createRouter({ tasks, routes: routes(route), policy: POLICY }).resolveRoute('deep.task', { profile });
  assert.equal(at('claude:claude-haiku-5-5:low|deepseek:deepseek-flash').route, 'claude:claude-haiku-5-5:low', 'DeepSeek dropped, the explicit effort stays');
  assert.equal(at('claude:claude-haiku-5-5:low').route, 'claude:claude-haiku-5-5:low');
  assert.equal(at('claude:claude-haiku-5-5|deepseek:deepseek-flash').route, 'claude:claude-haiku-5-5:high', 'no explicit effort: the task effort');
  assert.equal(at('claude:claude-haiku-5-5:low', 'test').route, 'claude:claude-haiku-5-5:high', 'a full redirect (test profile, DeepSeek only) takes the task effort');
});

test('claude-shape: oneOf is sent as anyOf, not is dropped, recursive schemas skip structured output', () => {
  const union = toClaudeSchema({ type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'integer' }], not: { const: 'x' } }, e: { enum: [{ type: 'object' }] } }, required: ['v'] });
  assert.deepEqual(union.properties.v, { anyOf: [{ type: 'string' }, { type: 'integer' }] });
  assert.deepEqual(union.properties.e.enum, [{ type: 'object' }], 'enum values are copied, not treated as schemas');
  const both = toClaudeSchema({ anyOf: [{ type: 'string' }], oneOf: [{ type: 'number' }, { type: 'boolean' }] });
  assert.deepEqual(both, { anyOf: [{ type: 'string' }], allOf: [{ anyOf: [{ type: 'number' }, { type: 'boolean' }] }] });
  const nav = { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/$defs/item' } } }, required: ['items'], $defs: { item: { type: 'object', properties: { label: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/item' } } }, required: ['label'] } } };
  assert.deepEqual(core.recursiveRefPaths(nav), ['/$defs/item/properties/children/items']);
  assert.deepEqual(core.recursiveRefPaths({ type: 'object', properties: { a: { $ref: '#/$defs/x' }, b: { $ref: '#/$defs/x' } }, $defs: { x: { type: 'string' } } }), [], 'a shared non-recursive def is fine');
  assert.deepEqual(core.recursiveRefPaths({ type: 'object', properties: { self: { $ref: '#' } } }), ['/properties/self']);
  assert.equal(core.recursiveRefPaths({ $defs: { a: { $ref: '#/$defs/b' }, b: { type: 'array', items: { $ref: '#/$defs/a' } } }, $ref: '#/$defs/a' }).length, 1, 'indirect cycle');
  const built = buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', kind: 'json', schema: nav });
  assert.equal('format' in built.params.output_config, false);
  assert.equal(built.jsonMode, 'prompt');
  assert.match(built.warnings.join(' '), /recursive \$ref/);
  const tool = buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', kind: 'tools', tools: [{ name: 'setNav', input_schema: nav }] });
  assert.equal(tool.params.tools[0].strict, false);
  const flat = buildClaudeRequest({ model: 'claude-haiku-5-5', user: 'x', kind: 'json', schema: { type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'null' }] } } } });
  assert.equal(flat.jsonMode, 'structured', 'a non-recursive union still uses structured output');
  assert.ok(flat.params.output_config.format.schema.properties.v.anyOf);
});

test('callLlm: a nav tree schema reaches Claude without format and is validated client-side (oneOf enforced)', async () => {
  let params;
  const answers = { text: '{"items":[{"label":"Hjem","children":[{"label":"Om oss","children":[]}]}]}' };
  const { llm } = makeCore({ providers: { claude: async (call) => ((params = call.claude.params), claudeMessage({ text: answers.text })) } });
  const schema = { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/$defs/item' } } }, required: ['items'], $defs: { item: { type: 'object', properties: { label: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/item' } } }, required: ['label'] } } };
  const out = await llm.json({ task: 'plan.edit', user: 'Nav', schema });
  assert.equal('format' in params.output_config, false);
  assert.equal(out.data.items[0].children[0].label, 'Om oss');
  answers.text = '{"v":3}';
  const oneOf = { type: 'object', properties: { v: { oneOf: [{ type: 'integer' }, { type: 'number' }] } }, required: ['v'] };
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'Union', schema: oneOf }), (e) => e.code === 'schema_invalid', '3 matches both shapes: exactly-one is enforced client-side');
  assert.ok(params.output_config.format.schema.properties.v.anyOf, 'the API got anyOf');
});

test('images in messages: tool results count toward 6, and base64 blocks must be JPEG within 1568 px', async () => {
  const jpeg = (w, h) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: tinyJpeg(w, h).toString('base64') } });
  const results = (n, block = jpeg(800, 600)) => [{ role: 'user', content: Array.from({ length: n }, (_, i) => ({ type: 'tool_result', tool_use_id: `t${i}`, content: [block] })) }];
  assert.equal(core.countImageBlocks(results(8)), 8);
  assert.equal(core.checkMessageImages(results(6)), 6);
  assert.throws(() => buildClaudeRequest({ model: 'claude-haiku-5-5', kind: 'tools', messages: results(8) }), /8 images in one call/);
  assert.throws(() => core.checkMessageImages(results(1, jpeg(2000, 1000))), /2000px on the long edge/);
  assert.throws(() => core.checkMessageImages([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }]), /image\/jpeg/);
  assert.throws(() => core.checkMessageImages([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'bm90IGEganBlZw==' } }] }]), /not a readable/);
  assert.throws(() => core.checkMessageImages([{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://example.com/a.jpg' } }] }]), /https/);
  const { llm } = makeCore({ providers: { claude: async () => assert.fail('no call expected') } });
  const shots = Array.from({ length: 8 }, (_, i) => ({ type: 'tool_result', tool_use_id: `x${i}`, content: [jpeg(800, 600)] }));
  await assert.rejects(llm.tools({ task: 'agent.run', messages: [{ role: 'user', content: shots }], tools: [{ name: 'shot', input_schema: { type: 'object', properties: { url: { type: 'string' } } } }], onToolUse: async () => [] }), (e) => e.code === 'invalid_request');
});

test('budgets: a core without a budgets config still stops a runaway; malformed configs fail at creation', async () => {
  let calls = 0;
  const providers = { claude: async () => (calls += 1, claudeMessage()) };
  const { llm, rows } = makeCore({ providers, spentUsd: async ({ scope }) => (scope === 'run' || scope === 'step2' ? 1_000_000 : 0) });
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'x', ctx: { runId: 'r1' } }), (e) => e.code === 'budget_exceeded' && e.expectedUsd === 2);
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'x', ctx: { runId: 'r1', expectedUsd: 0 } }), (e) => e.code === 'budget_exceeded', 'expectedUsd 0 is "not given", not "no limit"');
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'x', ctx: { runId: 'r1', budgetScope: 'step2' } }), (e) => e.code === 'budget_exceeded', 'an unknown budgetScope falls back to the run');
  assert.equal(calls, 0);
  assert.equal(rows.at(-1).status, 'budget_blocked');
  assert.throws(() => makeCore({ providers, budgets: { version: 1, alertRatio: 5, runawayFactor: 2 } }), (e) => e.code === 'route_config' && /runawayFactor must be larger/.test(e.message));
  assert.throws(() => makeCore({ providers, budgets: { version: 1, scopes: { run: { baseUsd: {} } } } }), /baseUsd.default/);
  assert.equal(core.withDefaultBudgets(null), core.DEFAULT_BUDGETS);
  assert.deepEqual(core.withDefaultBudgets({ version: 1, periodic: { hubDayUsd: 5 } }).scopes, core.DEFAULT_BUDGETS.scopes);
  assert.equal(core.normalizeCtx({ expectedUsd: 0 }).ctx.expectedUsd, undefined);
  assert.equal(core.normalizeCtx({ expectedUsd: -1 }).ctx.expectedUsd, undefined);
  assert.deepEqual(core.normalizeCtx({ retryOf: 'c1', attempt: 2 }).ctx, { escalation: 0, retryOf: 'c1', attempt: 2 });
});

test('budgets: a budgetScope without an id is never pooled across runs or clients', async () => {
  let calls = 0;
  // $0.10 per call (200k output tokens on Haiku); expected $0.05, so a pooled tally would stop after 3 calls.
  const { llm } = makeCore({ providers: { claude: async () => (calls += 1, claudeMessage({ usage: { input_tokens: 0, output_tokens: 200_000 } })) } });
  for (let client = 0; client < 6; client += 1) {
    await llm.json({ task: 'plan.edit', user: `client ${client}`, ctx: { budgetScope: 'step2', salesClientId: `sc-${client}`, expectedUsd: 0.05 } });
  }
  assert.equal(calls, 6, 'six clients with budgetScope "step2" and no run id run independently');
  for (let i = 0; i < 3; i += 1) await llm.json({ task: 'plan.edit', user: `step ${i}`, ctx: { budgetScope: 'step2', runId: 'run-a', expectedUsd: 0.05 } });
  await assert.rejects(llm.json({ task: 'plan.edit', user: 'step 9', ctx: { budgetScope: 'step2', runId: 'run-a', expectedUsd: 0.05 } }), (e) => e.code === 'budget_exceeded', 'with an id the scope is tallied');
});

test('ledger: policy blocks and dead-provider skips are written as rows', async () => {
  const strict = { version: 1, providers: { claude: { allow: ['public'] }, deepseek: { allow: ['public', 'business'] } }, redirect: 'claude:claude-haiku-5-5' };
  const rows = [];
  const llm = createLlmCore({ tasks: TASKS, routes: ROUTES, policy: strict, env: { AI_PROFILE: 'prod' }, providers: {}, ledger: { append: (row) => rows.push(row) }, repo: 'hub' });
  await assert.rejects(llm.json({ task: 'brief.read', user: 'Transcript', ctx: { runId: 'r-policy', salesClientId: 'sc-1' } }), (e) => e.code === 'policy_blocked');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'policy_blocked');
  assert.equal(rows[0].task, 'brief.read');
  assert.equal(rows[0].profile, 'prod');
  assert.equal(rows[0].provider, 'claude');
  assert.equal(rows[0].runId, 'r-policy');
  assert.equal(rows[0].policyRedirect.dataClass, 'transcript');
  assert.equal(rows[0].usd, 0);
  for (const field of LEDGER_FIELDS) assert.ok(field in rows[0], field);

  const deadRows = [];
  let claudeCalls = 0;
  const { llm: dead } = makeCore({
    ledger: { append: (row) => deadRows.push(row) },
    providers: {
      claude: async () => {
        claudeCalls += 1;
        throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
      },
      deepseek: async () => ({ servedModel: 'deepseek-flash', text: '{"ok":true}', stopReason: 'end_turn', usage: {} }),
    },
  });
  await dead.json({ task: 'tpl.analyze', user: 'One' });
  await dead.json({ task: 'tpl.analyze', user: 'Two' });
  assert.equal(claudeCalls, 1);
  assert.deepEqual(deadRows.map((r) => [r.provider, r.status]), [['claude', 'error'], ['deepseek', 'ok'], ['claude', 'skipped_dead'], ['deepseek', 'ok']]);
  assert.equal(deadRows[3].fallbackFrom, 'claude:claude-haiku-5-5:medium');
  assert.equal(deadRows[2].usd, 0);
  const missing = [];
  const { llm: noAdapter } = makeCore({ ledger: { append: (row) => missing.push(row) }, providers: { deepseek: async () => ({ servedModel: 'deepseek-flash', text: '{}', stopReason: 'end_turn', usage: {} }) } });
  await noAdapter.json({ task: 'tpl.analyze', user: 'x' });
  assert.deepEqual(missing.map((r) => [r.provider, r.status, r.error?.code || null]), [['claude', 'error', 'provider_dead'], ['deepseek', 'ok', null]]);
});

test('policy: exceptions record known calls outside the core and are validated', () => {
  const ok = { ...POLICY, exceptions: [{ id: 'cms-local-blog-job', provider: 'deepseek', where: 'website-cms server/local-blog-job.js', dataClass: 'business', owner: 'WS9', reason: 'direct call until the relay exists' }] };
  assert.equal(core.validatePolicy(ok).ok, true);
  const bad = core.validatePolicy({ ...POLICY, exceptions: [{ id: 'Bad Id', provider: 'mistral', dataClass: 'secret' }] });
  assert.equal(bad.ok, false);
  for (const fragment of ['.id must be', '.provider must be', '.where is required', '.owner is required', '.reason is required', 'unknown class']) {
    assert.ok(bad.errors.some((e) => e.includes(fragment)), fragment);
  }
  assert.equal(core.validatePolicy({ ...POLICY, exceptions: 'none' }).ok, false);
});
