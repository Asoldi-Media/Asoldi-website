// The shared task registry and reference routes, policy and budgets (packages/suite/harness/asoldi/llm.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../packages/suite/core/llm/index.js';
import { ASOLDI_LLM_TASKS, ASOLDI_LLM_ROUTES, ASOLDI_LLM_POLICY, ASOLDI_LLM_BUDGETS, asoldiLlmConfig } from '../packages/suite/harness/asoldi/llm.js';

const NOW = new Date('2026-10-24T00:00:00Z');
// Stand-in for the facades' legacy resolver: tools on Claude, vision on Gemini, text on DeepSeek.
const legacyRoute = (task, ctx, spec) => (spec.kind === 'tools' ? 'claude:claude-haiku-5-5' : spec.vision ? 'gemini:gemini-2.5-flash' : 'deepseek:deepseek-chat');

test('registry, routes, policy and budgets are valid', () => {
  const cfg = asoldiLlmConfig();
  assert.ok(Object.keys(cfg.tasks).length >= 55);
  const routes = core.validateRoutesConfig(ASOLDI_LLM_ROUTES, { tasks: cfg.tasks, now: NOW });
  assert.equal(routes.ok, true, routes.errors.join('\n'));
  assert.equal(core.validatePolicy(ASOLDI_LLM_POLICY).ok, true);
  assert.equal(core.validateBudgetsConfig(ASOLDI_LLM_BUDGETS).ok, true);
  const prices = core.checkModelPrices(routes.models, { now: NOW });
  assert.deepEqual([prices.missing, prices.stale], [[], []], 'one price source covers every routed model');
});

test('price freshness today: every routed model was priced within 120 days (re-read the pricing pages when this fails)', () => {
  const routes = core.validateRoutesConfig(ASOLDI_LLM_ROUTES, { tasks: asoldiLlmConfig().tasks, now: new Date() });
  const prices = core.checkModelPrices(routes.models, { now: new Date() });
  assert.deepEqual(prices.stale, [], 'update verifiedAt in packages/suite/core/llm/prices.js after reading the providers\' pricing pages');
});

test('every task has a repo, and each repo sees only its tasks', () => {
  for (const [key, spec] of Object.entries(ASOLDI_LLM_TASKS.tasks)) assert.ok(Array.isArray(spec.repo) && spec.repo.length, key);
  const hub = asoldiLlmConfig('hub').tasks;
  const maker = asoldiLlmConfig('maker').tasks;
  assert.ok(Object.keys(hub).every((key) => ASOLDI_LLM_TASKS.tasks[key].repo.includes('hub')));
  assert.equal(maker['offer.fill-from-transcript'], undefined);
  assert.ok(maker['dev.plan'] && hub['brief.map']);
  // A repo loading the shared routes file passes unknownTasks:'warn' (it names the other repo's tasks).
  assert.equal(core.validateRoutesConfig(ASOLDI_LLM_ROUTES, { tasks: hub, now: NOW, unknownTasks: 'warn' }).ok, true);
});

test('every task resolves in every profile, and the data policy holds for all of them', () => {
  const cfg = asoldiLlmConfig();
  const r = core.createRouter({ ...cfg, legacyRoute, now: NOW });
  for (const profile of ['prod', 'test', 'replay', 'record', 'legacy']) {
    for (const [task, spec] of Object.entries(cfg.tasks)) {
      const route = r.resolveRoute(task, { profile });
      assert.ok(route.chain.length > 0, `${profile} ${task}`);
      if (['personal', 'transcript'].includes(route.dataClass.effective)) assert.ok(!route.chain.some((e) => e.provider === 'deepseek'), `${profile} ${task} reached DeepSeek`);
      if (route.dataClass.effective !== 'public') assert.ok(!route.chain.some((e) => e.provider === 'gemini'), `${profile} ${task} reached unpaid Gemini`);
      if (spec.vision) assert.ok(route.chain.every((e) => core.PROVIDER_CAPABILITIES[e.provider].vision), `${profile} ${task} vision`);
    }
  }
});

test('WS4 change requests are in: dev.copy and dev.locate exist, dev.plan is JSON and personal', () => {
  const t = ASOLDI_LLM_TASKS.tasks;
  assert.equal(t['dev.plan'].kind, 'json');
  assert.equal(t['dev.plan'].dataClass, 'personal');
  assert.equal(t['dev.copy'].dataClass, 'personal');
  assert.equal(t['dev.locate'].vision, true);
  assert.equal(t['template-import.qa-vision'].vision, true, 'WS1 key');
  assert.equal(t['siteintel.page-kind-vision'].vision, true, 'WS2 key');
  for (const key of ['brief.map', 'brief.reduce', 'brief.iteration', 'followups.extract']) assert.equal(t[key].dataClass, 'transcript', key);
  assert.equal(t['change.classify'].dataClass, 'personal');
  assert.equal(t['delivery.brief'], undefined, 'replaced by brief.map/reduce/iteration (WS8)');
});

test('production starting routes follow the owner order (Haiku 5.5 first) and the plan table', () => {
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute, now: NOW });
  const at = (task, ctx = {}) => r.resolveRoute(task, { profile: 'prod', ...ctx });
  assert.equal(at('cms.page-kinds').route, 'claude:claude-haiku-5-5:low|deepseek:deepseek-flash');
  assert.equal(at('step2.copy-judge').primary.model, 'claude-haiku-5-5');
  assert.equal(at('step2.copywriter').route, 'claude:claude-haiku-5-5:medium|openai:gpt-4.1');
  assert.equal(at('dev.plan').route, 'claude:claude-haiku-5-5:medium');
  assert.equal(at('dev.plan', { escalation: 1 }).primary.model, 'claude-sonnet-5-5');
  assert.equal(at('dev.plan', { escalation: 2 }).primary.model, 'claude-opus-5-5');
  assert.equal(at('dev.copy', { escalation: 1 }).primary.model, 'claude-sonnet-5-5');
  assert.equal(at('eval.judge').route, 'claude:claude-opus-5-5:high');
  assert.equal(at('offer.fill-from-transcript').route, 'claude:claude-haiku-5-5:low');
  assert.equal(at('infokort.agent').primary.provider, 'claude');
  assert.equal(at('seo.keywords.relevance').primary.effort, 'low');
});

test('test profile: DeepSeek for text, Claude Haiku when the data is personal, synthetic data allowed', () => {
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute, now: NOW });
  assert.equal(r.resolveRoute('step2.copywriter', { profile: 'test' }).primary.provider, 'deepseek');
  assert.equal(r.resolveRoute('workshop.summary', { profile: 'test' }).route, 'claude:claude-haiku-5-5:low');
  assert.equal(r.resolveRoute('workshop.summary', { profile: 'test', synthetic: true }).primary.provider, 'deepseek');
  assert.equal(r.resolveRoute('step2.copywriter', { profile: 'test' }, { payload: { owner: { firstName: 'Kari' } } }).primary.provider, 'claude');
});

test('reference budgets: expected cost by tier and size, hard stop only for a runaway', () => {
  const b = ASOLDI_LLM_BUDGETS;
  assert.equal(core.expectedCostUsd(b, 'devSession', { tier: 1, projectSize: { pages: 5 } }), 1.5);
  assert.equal(core.expectedCostUsd(b, 'devSession', { tier: 3, projectSize: { pages: 5 } }), 4);
  assert.equal(core.expectedCostUsd(b, 'iteration', { tier: 3, projectSize: { pages: 5 } }), 2);
  assert.equal(core.expectedCostUsd(b, 'run', { tier: 3, projectSize: { pages: 24, locales: 2, products: 400 } }), 31);
  assert.equal(core.evaluateBudget({ expectedUsd: 31, spentUsd: 100 }).action, 'alert');
  assert.equal(core.evaluateBudget({ expectedUsd: 31, spentUsd: 160 }).action, 'stop');
});
