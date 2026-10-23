// LLM contract freeze (WS0.33). The same checks run in website-maker against its vendored lib/suite copy
// and its facade; both repos pin the same version and fingerprint. A change to the contract must bump
// LLM_CONTRACT.version and update this pin, CONTRACT.md and the Maker test in one change.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../packages/suite/core/llm/index.js';

const PINNED_VERSION = '1.1.0';
const TASKS = {
  version: 1,
  tasks: {
    'a.json': { kind: 'json', vision: false, dataClass: 'business', maxTokens: 2000 },
    'a.tools': { kind: 'tools', vision: false, dataClass: 'public', maxTokens: 4096 },
  },
};
const ROUTES = { version: 1, profiles: { legacy: { default: 'claude:claude-haiku-5-5:medium' }, prod: { default: 'claude:claude-haiku-5-5:medium|deepseek:deepseek-flash' } } };
const POLICY = { version: 1, providers: { claude: { allow: ['public', 'business', 'personal', 'transcript'] }, deepseek: { allow: ['public', 'business'] } } };

const PINNED_FINGERPRINT = 'sha256:cdb1ee94eb6332b0160681427f4a34bc4cfe9394a567e862ca16e1ba2d34b256';

test('contract version and fingerprint are pinned', () => {
  assert.equal(core.LLM_CONTRACT.version, PINNED_VERSION);
  assert.equal(core.contractFingerprint(), PINNED_FINGERPRINT, 'the frozen contract changed: bump the version and update the pin in both repos');
});

test('the contract object is deeply frozen', () => {
  assert.ok(Object.isFrozen(core.LLM_CONTRACT));
  assert.ok(Object.isFrozen(core.LLM_CONTRACT.claude.image));
  assert.throws(() => {
    'use strict';
    core.LLM_CONTRACT.claude.maxTokensFloor = 1;
  }, TypeError);
});

test('behavioural contract checks pass on the core', () => {
  assert.deepEqual(core.runContractChecks({ core, fingerprint: PINNED_FINGERPRINT }), []);
});

test('the frozen rules say what the owner and the plan decided', () => {
  const c = core.LLM_CONTRACT;
  assert.deepEqual(c.claudeModels, ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.deepEqual(c.claude.forbiddenParams, ['temperature', 'top_p', 'top_k']);
  assert.deepEqual(c.claude.thinking, { type: 'adaptive' });
  assert.equal(c.claude.maxTokensFloor, 4096);
  assert.equal(c.claude.maxTokensRetryFactor, 2);
  assert.equal(c.claude.maxTokensRetries, 1);
  assert.deepEqual(c.claude.refusal, { needsReview: true, crossVendorRetry: false, error: 'RefusalError' });
  assert.deepEqual(c.claude.image, { mime: 'image/jpeg', maxLongEdge: 1568, maxImages: 6, jpegQuality: 80 });
  assert.deepEqual(c.policy.neverPersonal, ['deepseek']);
  assert.deepEqual(c.policy.clientDataOnlySyntheticOrRedacted, ['deepseek'], 'Q5: no real client data to DeepSeek');
  assert.equal(c.policy.appliesToProfiles, 'all, legacy included');
  assert.equal(c.policy.defaultRedirect, 'claude:claude-haiku-5-5');
  assert.deepEqual(c.claude.maxTokensRetryProviders, ['claude']);
  assert.deepEqual(c.claude.serverFallback.servedBy, ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5']);
  assert.equal(c.budgets.loopWindowMinutes, 15);
  assert.deepEqual(c.budgets.loopScopeFields, ['runId', 'sessionId', 'jobId', 'taskId']);
  assert.deepEqual(c.budgets.periodicScopes, { clientMonthUsd: 'clientMonth', makerDayUsd: 'makerDay', hubDayUsd: 'hubDay', evalTotalUsd: 'eval' });
  assert.equal(c.prices.replayUsd, 0);
  assert.equal(c.budgets.runawayFactor, 5);
  assert.equal(c.budgets.alertRatio, 1);
  assert.deepEqual(c.budgets.hardStop, ['runaway', 'loop']);
  assert.equal(c.prices.pricedFrom, 'response.model (+ usage.iterations)');
  assert.deepEqual(c.profiles, ['legacy', 'prod', 'test', 'replay', 'record']);
  assert.deepEqual(c.profileAliases, { production: 'prod' });
  for (const field of ['escalation', 'maxEscalation', 'tier', 'kind', 'profile', 'budgetScope', 'expectedUsd', 'projectSize', 'sessionId']) {
    assert.ok(c.ctxFields.includes(field), field);
  }
});

test('a facade built on createLlmCore satisfies the facade contract', () => {
  const llm = core.createLlmCore({ tasks: core.parseTaskRegistry(TASKS), routes: ROUTES, policy: POLICY, providers: {} });
  const facade = { ...llm, status: async () => ({ profile: 'legacy', providers: {} }) };
  assert.deepEqual(core.runContractChecks({ core, facade }), []);
  const broken = { ...llm, routeFor: () => null };
  delete broken.status;
  const problems = core.runContractChecks({ core, facade: broken });
  assert.ok(problems.some((p) => /lacks status/.test(p)));
  assert.ok(problems.some((p) => /routeFor and facade.resolveRoute/.test(p)));
});

test('a drifted core is caught (missing export, changed rule)', () => {
  const missing = { ...core };
  delete missing.priceResponse;
  assert.match(core.runContractChecks({ core: missing }).join('\n'), /does not export priceResponse/);
  const sloppy = { ...core, buildClaudeRequest: (input) => ({ params: { ...core.buildClaudeRequest(input).params, temperature: 0 } }) };
  assert.match(core.runContractChecks({ core: sloppy }).join('\n'), /emitted temperature/);
  const leaky = { ...core, classifyError: () => ({ fallback: true }) };
  assert.match(core.runContractChecks({ core: leaky }).join('\n'), /must not fall back/);
});

test('one price source: routes naming an unpriced model fail at load', () => {
  const routes = { version: 1, profiles: { prod: { default: 'openai:gpt-9' } } };
  assert.throws(() => core.createRouter({ tasks: core.parseTaskRegistry(TASKS), routes, policy: POLICY }), /gpt-9" has no price entry/);
  assert.equal(core.validateRoutesConfig(ROUTES, { tasks: core.parseTaskRegistry(TASKS), now: new Date('2026-10-24T00:00:00Z') }).ok, true);
});
