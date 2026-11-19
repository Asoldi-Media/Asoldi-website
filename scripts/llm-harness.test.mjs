// The shared task registry and reference routes, policy and budgets (packages/suite/harness/asoldi/llm.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../packages/suite/core/llm/index.js';
import { ASOLDI_LLM_TASKS, ASOLDI_LLM_ROUTES, ASOLDI_LLM_POLICY, ASOLDI_LLM_BUDGETS, AUDIO_VIDEO_TASKS, asoldiLlmConfig } from '../packages/suite/harness/asoldi/llm.js';
import { coreWithoutRules } from './llm-core-copy.mjs';

const NOW = new Date('2026-10-24T00:00:00Z');
// Stand-in for the facades' legacy resolver: tools and vision on Claude, text on DeepSeek.
const legacyRoute = (task, ctx, spec) => (spec.kind === 'tools' || spec.vision ? 'claude:claude-haiku-5-5' : 'deepseek:deepseek-chat');

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
  // The same resolution under a planted copy of the policy whose paid tier is not confirmed (the negative control).
  const unpaid = core.createRouter({ ...cfg, policy: unpaidGeminiPolicy(), legacyRoute, now: NOW });
  let geminiRoutes = 0;
  for (const profile of ['prod', 'test', 'replay', 'record', 'legacy', 'eval']) {
    for (const [task, spec] of Object.entries(cfg.tasks)) {
      const route = r.resolveRoute(task, { profile });
      assert.ok(route.chain.length > 0, `${profile} ${task}`);
      if (route.dataClass.effective !== 'public') assert.ok(!route.chain.some((e) => e.provider === 'deepseek'), `${profile} ${task} sent client data to DeepSeek`);
      if (route.chain.some((e) => e.provider === 'gemini')) {
        geminiRoutes += 1;
        assert.ok(AUDIO_VIDEO_TASKS.includes(task), `${profile} ${task} routes to Gemini but is not an audio or video task`);
      }
      assert.ok(!unpaid.resolveRoute(task, { profile }).chain.some((e) => e.provider === 'gemini'), `${profile} ${task} reached Gemini under a policy without a confirmed paid tier`);
      if (route.chain.some((e) => e.provider === 'openai')) assert.ok(ASOLDI_LLM_POLICY.providers.openai.tasks.includes(task), `${profile} ${task} reached OpenAI outside evaluation`);
      if (spec.vision) assert.ok(route.chain.every((e) => core.PROVIDER_CAPABILITIES[e.provider].vision), `${profile} ${task} vision`);
      // Image rule: a call of this task that carries an image of client data stays on Claude.
      if (spec.vision) {
        const image = r.resolveRoute(task, { profile }, { images: 1 });
        if (image.dataClass.effective !== 'public') assert.deepEqual([...new Set(image.chain.map((e) => e.provider).filter((p) => p !== 'replay'))].filter((p) => p !== 'claude'), [], `${profile} ${task} sent a client image off Claude`);
      }
    }
  }
  assert.ok(geminiRoutes > 0, 'the shipped policy lets the audio and video tasks reach Gemini (paid tier confirmed)');
});

test('Developer automation change requests are in: dev.copy and dev.locate exist, dev.plan is JSON and personal', () => {
  const t = ASOLDI_LLM_TASKS.tasks;
  assert.equal(t['dev.plan'].kind, 'json');
  assert.equal(t['dev.plan'].dataClass, 'personal');
  assert.equal(t['dev.copy'].dataClass, 'personal');
  assert.equal(t['dev.locate'].vision, true);
  assert.equal(t['template-import.qa-vision'].vision, true, 'import key');
  assert.equal(t['siteintel.page-kind-vision'].vision, true, 'site intelligence key');
  for (const key of ['brief.map', 'brief.reduce', 'brief.iteration', 'followups.extract']) assert.equal(t[key].dataClass, 'transcript', key);
  assert.equal(t['change.classify'].dataClass, 'personal');
  assert.equal(t['delivery.brief'], undefined, 'replaced by brief.map/reduce/iteration (delivery)');
});

test('production starting routes follow the owner order (Haiku 5.5 first) and the plan table', () => {
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute, now: NOW });
  const at = (task, ctx = {}) => r.resolveRoute(task, { profile: 'prod', ...ctx });
  assert.equal(at('template-import.classify').route, 'claude:claude-haiku-5-5:low|deepseek:deepseek-flash', 'public template data may fall back to DeepSeek');
  assert.equal(at('cms.page-kinds').route, 'claude:claude-haiku-5-5:low', 'the client site is business data (Q5)');
  assert.equal(at('step2.copy-judge').primary.model, 'claude-haiku-5-5');
  assert.equal(at('step2.copywriter').route, 'claude:claude-haiku-5-5:medium', 'no OpenAI or DeepSeek fallback for client copy (Q5)');
  assert.equal(at('products.import').route, 'claude:claude-haiku-5-5:low');
  assert.equal(at('quickfill.narrative').route, 'claude:claude-haiku-5-5:medium');
  assert.equal(at('step2.copywriter', { tier: 'custom' }).tier, null, 'the hub custom tier routes like no tier');
  assert.equal(at('dev.plan').route, 'claude:claude-haiku-5-5:medium');
  assert.equal(at('dev.plan', { escalation: 1 }).primary.model, 'claude-sonnet-5-5');
  assert.equal(at('dev.plan', { escalation: 2 }).primary.model, 'claude-opus-5-5');
  assert.equal(at('dev.copy', { escalation: 1 }).primary.model, 'claude-sonnet-5-5');
  assert.equal(at('eval.judge').route, 'claude:claude-opus-5-5:high');
  assert.equal(at('offer.fill-from-transcript').route, 'claude:claude-haiku-5-5:low');
  assert.equal(at('infokort.agent').primary.provider, 'claude');
  assert.equal(at('seo.keywords.relevance').primary.effort, 'low');
});

test('test profile (Q5): DeepSeek for public, synthetic or redacted data; real client data on Claude Haiku', () => {
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute, now: NOW });
  assert.equal(r.resolveRoute('step15.analyze', { profile: 'test' }).primary.provider, 'deepseek', 'template HTML is public');
  assert.equal(r.resolveRoute('step2.copywriter', { profile: 'test' }).route, 'claude:claude-haiku-5-5:medium', 'real client copy stays on Claude');
  assert.equal(r.resolveRoute('step2.copywriter', { profile: 'test', redacted: true }, { payload: { user: 'Bakery copy, contact [EMAIL]' } }).primary.provider, 'deepseek');
  assert.equal(r.resolveRoute('step2.copywriter', { profile: 'test', redacted: true }, { payload: { user: 'Bakery copy, ring 92 34 56 78' } }).primary.provider, 'claude', 'a failed redaction stays on Claude');
  assert.equal(r.resolveRoute('workshop.summary', { profile: 'test' }).route, 'claude:claude-haiku-5-5:medium');
  assert.equal(r.resolveRoute('workshop.summary', { profile: 'test', synthetic: true }).primary.provider, 'deepseek');
  assert.equal(r.resolveRoute('workshop.summary', { profile: 'test', synthetic: true }, { payload: { user: 'Kari Nordmann kari@firma.no 22 33 44 55' } }).primary.provider, 'claude');
  assert.equal(r.resolveRoute('step2.copywriter', { profile: 'test' }, { payload: { owner: { firstName: 'Kari' } } }).primary.provider, 'claude');
  // step15.judge is business class (it runs inside a client run): a capture goes to Claude, and so does its text call.
  assert.equal(r.resolveRoute('step15.judge', { profile: 'test' }, { images: 1 }).route, 'claude:claude-haiku-5-5:low', 'a client capture stays on Claude');
  assert.equal(r.resolveRoute('step15.judge', { profile: 'test', synthetic: true }, { images: 1 }).route, 'claude:claude-haiku-5-5:low', 'a synthetic capture reads on Claude too: no picture task has a Gemini route');
  assert.equal(r.resolveRoute('step15.judge', { profile: 'test', vision: false }).primary.provider, 'claude', 'its text call leaves DeepSeek');
  assert.equal(r.resolveRoute('step15.judge', { profile: 'test', vision: false, synthetic: true }).primary.provider, 'deepseek');
});

test('reference policy follows Q5 and the loop window is configured', () => {
  assert.deepEqual(ASOLDI_LLM_POLICY.providers.openai.tasks, ['eval.judge', 'siteintel.golden-judge-text', 'siteintel.golden-judge-vision']);
  assert.equal(ASOLDI_LLM_POLICY.providers.gemini.allowUnpaidPublic, false);
  assert.equal(ASOLDI_LLM_POLICY.redirect, 'claude:claude-haiku-5-5');
  assert.equal(ASOLDI_LLM_BUDGETS.loop.windowMinutes, 15);
});

/** A copy of the shipped policy whose Gemini paid tier is not confirmed (billingTier alone does not open it). */
function unpaidGeminiPolicy() {
  return { ...ASOLDI_LLM_POLICY, providers: { ...ASOLDI_LLM_POLICY.providers, gemini: { ...ASOLDI_LLM_POLICY.providers.gemini, paidTierConfirmedAt: null } } };
}

test('Gemini is on for audio and video only: the shipped policy records the paid tier and limits it to those tasks; a copy without the confirmation date refuses the same call', () => {
  const gemini = ASOLDI_LLM_POLICY.providers.gemini;
  assert.equal(gemini.billingTier, 'paid');
  assert.equal(gemini.paidTierConfirmedAt, '2026-11-10');
  assert.equal(gemini.allowUnpaidPublic, false);
  assert.deepEqual(gemini.tasks, [...AUDIO_VIDEO_TASKS, 'sales-link.discover'], 'Gemini is limited to audio and video (and the grounded link search, which is no picture task)');
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute, now: NOW });
  const planted = core.createRouter({ ...asoldiLlmConfig(), policy: unpaidGeminiPolicy(), legacyRoute, now: NOW });
  // The same calls under both policies: business data on routes that name Gemini, in a call without a picture
  // (images: 0; a picture of client data stays on Claude whatever the route says).
  const AV_ROUTE = 'gemini:gemini-2.5-flash-lite|gemini:gemini-2.5-flash';
  const calls = [
    ['assistant.media-brief-av', { profile: 'prod' }, AV_ROUTE],
    ['assistant.media-brief-av', { profile: 'test' }, AV_ROUTE],
    ['media.transcript-av', { profile: 'prod' }, AV_ROUTE],
    ['media.transcript-av', { profile: 'test' }, AV_ROUTE],
  ];
  let run = 0;
  for (const [task, ctx, expected] of calls) {
    const route = r.resolveRoute(task, ctx, { images: 0 });
    run += 1;
    assert.equal(route.dataClass.effective, 'business', task);
    assert.deepEqual(r.resolveRoute(task, ctx, { images: 1 }).chain.map((e) => e.provider), ['claude'], `${task}: if a picture were sent it would go to Claude, not Gemini`);
    assert.equal(route.route, expected, `${task}: Gemini is allowed for business data`);
    assert.equal(core.providerAllows(ASOLDI_LLM_POLICY, 'gemini', 'business', { task }).allowed, true, task);
    // No other task may use Gemini, whatever its route says.
    assert.equal(core.providerAllows(ASOLDI_LLM_POLICY, 'gemini', 'public', { task: 'step15.judge' }).allowed, false, 'a picture task is not on the Gemini list');
    // Negative control: the planted policy copy refuses the same call.
    assert.ok(!planted.resolveRoute(task, ctx, { images: 0 }).chain.some((e) => e.provider === 'gemini'), `${task}: the copy without paidTierConfirmedAt refuses Gemini`);
    assert.equal(core.providerAllows(unpaidGeminiPolicy(), 'gemini', 'business', { task }).allowed, false, task);
  }
  assert.ok(run > 0, 'assertions run');
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

test('createLlmCore builds from the shared config for each repo (the routes name both repos\' tasks)', () => {
  for (const repo of ['hub', 'maker']) {
    const cfg = asoldiLlmConfig(repo);
    assert.equal(cfg.repo, repo);
    assert.equal(cfg.unknownTasks, 'warn');
    const llm = core.createLlmCore({ ...cfg, providers: {}, legacyRoute, now: NOW });
    assert.equal(typeof llm.json, 'function', repo);
    assert.ok(Object.keys(llm.router.tasks).every((key) => ASOLDI_LLM_TASKS.tasks[key].repo.includes(repo)), repo);
  }
  assert.match(core.createLlmCore({ ...asoldiLlmConfig('hub'), providers: {}, now: NOW }).warnings.join('\n'), /eval\.judge: task is not in the registry/, 'the Maker task routes become warnings in the hub');
  assert.equal(asoldiLlmConfig().unknownTasks, undefined, 'the all-repo config stays strict');
});

test('public tasks that may read a client\'s live site: callers pass ctx.dataClass business and DeepSeek is dropped', () => {
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute, now: NOW });
  const liveSite = ['template-import.classify', 'template-import.qa-vision', 'step15.analyze', 'step15.curate', 'step15.finalize', 'step15.nav-resolve', 'siteintel.golden-judge-text', 'siteintel.golden-judge-vision'];
  for (const task of liveSite) {
    assert.equal(ASOLDI_LLM_TASKS.tasks[task].dataClass, 'public', task);
    assert.match(ASOLDI_LLM_TASKS.tasks[task].note || '', /client's live site/, task);
    for (const profile of ['prod', 'test', 'legacy']) {
      const route = r.resolveRoute(task, { profile, dataClass: 'business' });
      assert.equal(route.dataClass.effective, 'business', `${profile} ${task}`);
      assert.ok(!route.chain.some((e) => e.provider === 'deepseek'), `${profile} ${task}: ${route.route}`);
      // With a capture of the client's site in the call, nothing but Claude is left.
      if (ASOLDI_LLM_TASKS.tasks[task].vision) {
        const image = r.resolveRoute(task, { profile, dataClass: 'business' }, { images: 1 });
        assert.ok(image.chain.every((e) => e.provider === 'claude'), `${profile} ${task}: ${image.route}`);
      }
    }
  }
  assert.equal(r.resolveRoute('template-import.classify', { profile: 'prod' }).route, 'claude:claude-haiku-5-5:low|deepseek:deepseek-flash', 'a template source stays public');
  assert.equal(r.resolveRoute('template-import.classify', { profile: 'prod', dataClass: 'business' }).route, 'claude:claude-haiku-5-5:low', 'a live client site does not');
  assert.equal(ASOLDI_LLM_TASKS.tasks['sales-link.discover'].dataClass, 'business', 'name, city, phone and address of a real business');
  assert.equal(r.resolveRoute('sales-link.discover', { profile: 'prod' }).route, 'claude:claude-haiku-5-5:low');
});

test('reference policy records the CMS local-blog-job DeepSeek call as a known exception (SEO)', () => {
  assert.equal(core.validatePolicy(ASOLDI_LLM_POLICY).ok, true);
  const [exception] = ASOLDI_LLM_POLICY.exceptions;
  assert.equal(exception.id, 'cms-local-blog-job');
  assert.equal(exception.provider, 'deepseek');
  assert.equal(exception.owner, 'WS9');
  assert.match(exception.where, /local-blog-job/);
});

// The CMS hookup arbiters, the CMS spec written from the delivery brief, the claims check and the meeting
// keyword pass. Owners are area words, never planning ids.
const NEWER_TASKS = Object.freeze({
  'step2.cta-classify': { repo: ['maker'], dataClass: 'business', family: 'arbiter', effort: 'low', owner: 'branding' },
  'cms.shell-arbiter': { repo: ['maker'], dataClass: 'business', family: 'arbiter', effort: 'low', owner: 'publish' },
  'cms.cta-arbiter': { repo: ['maker'], dataClass: 'business', family: 'arbiter', effort: 'low', owner: 'publish' },
  'cms.spec-writer': { repo: ['maker'], dataClass: 'transcript', family: 'brief', effort: 'medium', owner: 'CMS' },
  'cms-spec.email': { repo: ['maker'], dataClass: 'transcript', family: 'brief', effort: 'medium', owner: 'email' },
  'seo.claims-extract': { repo: ['maker'], dataClass: 'business', family: 'compliance', effort: 'medium', owner: 'SEO' },
  'seo.agreed-extract': { repo: ['hub'], dataClass: 'transcript', family: 'brief', effort: 'medium', owner: 'SEO' },
});

test('newer tasks are registered for their repo with a data class, a family, an effort and an area owner', () => {
  const t = ASOLDI_LLM_TASKS.tasks;
  for (const [key, want] of Object.entries(NEWER_TASKS)) {
    assert.ok(t[key], `${key} is registered`);
    const { repo, dataClass, family, effort, owner } = t[key];
    assert.deepEqual({ repo, dataClass, family, effort, owner }, want, key);
    assert.equal(t[key].kind, 'json', key);
    assert.equal(t[key].vision, false, key);
  }
  const hub = asoldiLlmConfig('hub').tasks;
  const maker = asoldiLlmConfig('maker').tasks;
  for (const [key, { repo }] of Object.entries(NEWER_TASKS)) {
    assert.equal(Boolean(maker[key]), repo.includes('maker'), `${key} in the Maker config`);
    assert.equal(Boolean(hub[key]), repo.includes('hub'), `${key} in the hub config`);
  }
});

test('newer tasks start on Haiku 5.5 in production with no DeepSeek, even for synthetic or redacted data', () => {
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute, now: NOW });
  for (const [task, { effort, family }] of Object.entries(NEWER_TASKS)) {
    const haiku = `claude:claude-haiku-5-5:${effort}`;
    for (const ctx of [{}, { synthetic: true }, { redacted: true }, { tier: 3 }]) {
      const route = r.resolveRoute(task, { profile: 'prod', ...ctx });
      assert.equal(route.route, haiku, `${task} prod ${JSON.stringify(ctx)}`);
    }
    const escalated = r.resolveRoute(task, { profile: 'prod', escalation: 1 }).route;
    assert.equal(escalated, family === 'arbiter' ? 'claude:claude-haiku-5-5:medium' : 'claude:claude-sonnet-5-5:medium', `${task} escalation`);
    assert.ok(!escalated.includes('deepseek'), `${task} escalation`);
  }
});

test('newer tasks in the test profile: DeepSeek only for synthetic data or a clean redaction of business data, real data on Claude at the task effort', () => {
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute, now: NOW });
  for (const [task, { effort, dataClass }] of Object.entries(NEWER_TASKS)) {
    assert.equal(r.resolveRoute(task, { profile: 'test' }).route, `claude:claude-haiku-5-5:${effort}`, `${task} real data`);
    assert.equal(r.resolveRoute(task, { profile: 'test', synthetic: true }).primary.provider, 'deepseek', `${task} synthetic`);
    const escaped = r.resolveRoute(task, { profile: 'test', synthetic: true }, { payload: { user: 'Kari Nordmann kari@firma.no 22 33 44 55' } });
    assert.equal(escaped.primary.provider, 'claude', `${task}: a synthetic flag on real-looking data is ignored`);
    // Redaction never lowers a transcript; a clean redaction of business data may use DeepSeek (core data policy).
    const redacted = r.resolveRoute(task, { profile: 'test', redacted: true }, { payload: { user: 'Shop copy, contact [EMAIL]' } });
    assert.equal(redacted.primary.provider, dataClass === 'transcript' ? 'claude' : 'deepseek', `${task} redacted`);
    for (const profile of ['legacy', 'replay', 'record']) assert.ok(r.resolveRoute(task, { profile }).chain.length > 0, `${task} ${profile}`);
  }
});

test('newer tasks route by family, so the shared routes name none of them and neither repo gets a new unknown-task warning', () => {
  const named = new Set(
    Object.values(ASOLDI_LLM_ROUTES.profiles).flatMap((profile) => [
      ...Object.keys(profile.tasks || {}),
      ...Object.keys(profile.escalate || {}),
      ...Object.values(profile.tiers || {}).flatMap((tier) => [...Object.keys(tier.tasks || {}), ...Object.keys(tier.escalate || {})]),
    ]),
  );
  for (const task of Object.keys(NEWER_TASKS)) assert.equal(named.has(task), false, task);
  for (const repo of ['hub', 'maker']) {
    const warnings = core.createLlmCore({ ...asoldiLlmConfig(repo), providers: {}, legacyRoute, now: NOW }).warnings.join('\n');
    for (const task of Object.keys(NEWER_TASKS)) assert.doesNotMatch(warnings, new RegExp(task.replace(/[.-]/g, '\$&')), `${repo}: ${task}`);
  }
});

test('opt-in budget scopes for the CMS hookup, an SEO pass and the meeting keyword pass scale like the run', () => {
  const b = ASOLDI_LLM_BUDGETS;
  assert.equal(core.validateBudgetsConfig(b).ok, true);
  assert.equal(core.expectedCostUsd(b, 'cmsHookup', { tier: 1, projectSize: { pages: 6 } }), 0.3);
  assert.equal(core.expectedCostUsd(b, 'cmsHookup', { tier: 3, projectSize: { pages: 6 } }), 0.5);
  assert.equal(core.expectedCostUsd(b, 'cmsHookup', { tier: 3, projectSize: { pages: 12 } }), 1);
  assert.equal(core.expectedCostUsd(b, 'seoPass', { tier: 2, projectSize: { pages: 6, locales: 1 } }), 0.4);
  assert.equal(core.expectedCostUsd(b, 'meetingKeywords', {}), 0.2);
  // Alert at 100 % and go on; stop only above 5x expected (a runaway).
  assert.equal(core.evaluateBudget({ expectedUsd: 0.5, spentUsd: 0.6 }).action, 'alert');
  assert.equal(core.evaluateBudget({ expectedUsd: 0.5, spentUsd: 2.4 }).action, 'alert');
  assert.equal(core.evaluateBudget({ expectedUsd: 0.5, spentUsd: 2.6 }).action, 'stop');
});

// ---------- keyword research tasks, change classification, the judge and the planner, the eval profile ----------

const SEO_TASKS = Object.freeze({
  'seo.scope': { repo: ['maker'], dataClass: 'business', family: 'seo', effort: 'low', owner: 'SEO' },
  'seo.facts-nouns': { repo: ['maker'], dataClass: 'business', family: 'seo', effort: 'low', owner: 'SEO' },
  'seo.page-map': { repo: ['maker'], dataClass: 'business', family: 'seo', effort: 'medium', owner: 'SEO' },
});

test('keyword research tasks: business data on Haiku 5.5 in production, DeepSeek only in the test profile on synthetic data', () => {
  const t = ASOLDI_LLM_TASKS.tasks;
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute, now: NOW });
  for (const [task, want] of Object.entries(SEO_TASKS)) {
    const { repo, dataClass, family, effort, owner } = t[task] || {};
    assert.deepEqual({ repo, dataClass, family, effort, owner }, want, task);
    assert.equal(t[task].kind, 'json', task);
    assert.equal(t[task].vision, false, task);
    assert.equal(Boolean(asoldiLlmConfig('maker').tasks[task]), true, `${task} in the Maker config`);
    assert.equal(Boolean(asoldiLlmConfig('hub').tasks[task]), false, `${task} not in the hub config`);
    for (const ctx of [{}, { synthetic: true }, { redacted: true }, { tier: 2 }]) {
      assert.equal(r.resolveRoute(task, { profile: 'prod', ...ctx }).route, `claude:claude-haiku-5-5:${want.effort}`, `${task} prod ${JSON.stringify(ctx)}`);
    }
    assert.equal(r.resolveRoute(task, { profile: 'prod', escalation: 1 }).route, 'claude:claude-sonnet-5-5:medium', `${task} escalation`);
    assert.equal(r.resolveRoute(task, { profile: 'test' }).route, `claude:claude-haiku-5-5:${want.effort}`, `${task}: real client facts stay on Claude in the test profile`);
    assert.equal(r.resolveRoute(task, { profile: 'test', synthetic: true }).primary.provider, 'deepseek', `${task}: synthetic data may use DeepSeek in the test profile`);
    for (const profile of ['prod', 'legacy', 'eval', 'record', 'replay']) {
      for (const ctx of [{}, { synthetic: true }]) {
        if (profile === 'legacy' || profile === 'record') continue; // legacy is each call site's own provider; record inherits test
        assert.ok(!r.resolveRoute(task, { profile, ...ctx }).chain.some((e) => e.provider === 'deepseek'), `${task} ${profile}: no DeepSeek outside the test profile`);
      }
    }
    assert.ok(!r.resolveRoute(task, { profile: 'legacy' }).chain.some((e) => e.provider === 'deepseek'), `${task} legacy: client facts leave a DeepSeek call site`);
  }
});

test('change classification, the project document and iteration briefs run on Claude in production and never on DeepSeek with real data', () => {
  const t = ASOLDI_LLM_TASKS.tasks;
  assert.deepEqual([t['change.classify'].dataClass, t['change.classify'].family, t['change.classify'].effort, t['change.classify'].repo], ['personal', 'arbiter', 'low', ['hub']]);
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute, now: NOW });
  assert.equal(r.resolveRoute('change.classify', { profile: 'prod' }).route, 'claude:claude-haiku-5-5:low');
  assert.equal(r.resolveRoute('workshop.project-document', { profile: 'prod' }).route, 'claude:claude-haiku-5-5:medium');
  assert.equal(r.resolveRoute('brief.iteration', { profile: 'prod' }).route, 'claude:claude-haiku-5-5:medium');
  let checked = 0;
  for (const task of ['change.classify', 'workshop.project-document', 'brief.iteration']) {
    for (const profile of ['prod', 'legacy', 'test', 'eval']) {
      // Real data in every profile; in production also a redacted or synthetic payload (no DeepSeek fallback there).
      const production = profile === 'prod' || profile === 'eval';
      for (const ctx of production ? [{}, { redacted: true }, { synthetic: true }] : [{}]) {
        const route = r.resolveRoute(task, { profile, ...ctx }, { payload: { user: 'Kunden ber om et nytt bilde på forsiden og en ny tekst om åpningstider.' } });
        checked += 1;
        assert.ok(!route.chain.some((e) => e.provider === 'deepseek'), `${task} ${profile} ${JSON.stringify(ctx)}: ${route.route}`);
        assert.equal(route.primary.provider, 'claude', `${task} ${profile}`);
      }
    }
  }
  assert.ok(checked > 0);
  // Control: without the policy redirect a personal change request on a DeepSeek-only route has nowhere to go.
  const noRedirect = core.createRouter({ ...asoldiLlmConfig(), policy: { ...ASOLDI_LLM_POLICY, redirect: 'deepseek:deepseek-flash' }, legacyRoute, now: NOW });
  assert.throws(() => noRedirect.resolveRoute('change.classify', { profile: 'test' }), (error) => error.code === 'policy_blocked', 'the provider test fails when the redirect to Claude is removed');
});

test('the judge of the development agent never runs on the planner model, at any escalation step or tier', () => {
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute, now: NOW });
  let compared = 0;
  for (const profile of ['prod', 'eval']) {
    for (const tier of [undefined, 1, 2, 3]) {
      for (let step = 0; step <= 4; step += 1) {
        const ctx = { profile, escalation: step, ...(tier ? { tier } : {}) };
        const plan = r.resolveRoute('dev.plan', ctx);
        const judge = r.resolveRoute('dev.judge', ctx, { images: 1 });
        compared += 1;
        assert.equal(plan.primary.provider, 'claude');
        assert.deepEqual(judge.chain.map((e) => e.provider), ['claude'], 'a client preview is judged by Claude only');
        assert.notEqual(judge.primary.model, plan.primary.model, `${profile} tier ${tier || '-'} step ${step}: judge ${judge.route} vs plan ${plan.route}`);
      }
    }
  }
  assert.ok(compared > 0);
  assert.equal(r.resolveRoute('dev.plan', { profile: 'prod' }).route, 'claude:claude-haiku-5-5:medium');
  assert.equal(r.resolveRoute('dev.judge', { profile: 'prod' }).route, 'claude:claude-sonnet-5-5:medium');
  // Control: the route table before this change had both on Haiku 5.5.
  const before = structuredClone(ASOLDI_LLM_ROUTES);
  delete before.profiles.prod.tasks['dev.judge'];
  const old = core.createRouter({ ...asoldiLlmConfig(), routes: before, legacyRoute, now: NOW });
  assert.equal(old.resolveRoute('dev.judge', { profile: 'prod' }, { images: 1 }).primary.model, old.resolveRoute('dev.plan', { profile: 'prod' }).primary.model, 'without the task route the two share a model');
});

test('the eval profile: production routes plus explicit candidates and judges; OpenAI is a judge only, Gemini is neither', () => {
  const cfg = asoldiLlmConfig();
  const view = core.profileView(ASOLDI_LLM_ROUTES, 'eval');
  assert.ok(core.PROFILES.includes('eval'));
  assert.equal(core.normalizeProfile('eval'), 'eval');
  assert.deepEqual(core.ROUTE_LIST_KEYS, ['candidates', 'judges']);
  const entries = (list) => list.map((route) => core.parseRoute(route));
  for (const key of core.ROUTE_LIST_KEYS) {
    assert.ok(Array.isArray(view[key]) && view[key].length > 0, key);
    for (const chain of entries(view[key])) assert.equal(chain.length, 1, `${key}: one entry, no fallback`);
    assert.equal(new Set(view[key]).size, view[key].length, `${key}: no duplicates`);
  }
  const candidates = entries(view.candidates).map(([entry]) => entry);
  const judges = entries(view.judges).map(([entry]) => entry);
  assert.deepEqual(candidates.map((e) => e.provider).filter((p, i, all) => all.indexOf(p) === i), ['deepseek', 'claude'], 'owner order: DeepSeek, Claude');
  assert.equal(candidates.some((e) => e.provider === 'openai'), false, 'OpenAI is never a candidate');
  assert.deepEqual(judges.map((e) => e.provider).sort(), ['claude', 'openai'], 'the panel has two vendors');
  assert.equal([...candidates, ...judges].some((e) => e.provider === 'gemini'), false, 'Gemini is neither a candidate nor a judge');
  // The policy lets each judge serve eval.judge on synthetic items, and keeps a client image on Claude.
  const r = core.createRouter({ ...cfg, legacyRoute, now: NOW });
  for (const route of view.judges) {
    assert.equal(r.resolveRoute('eval.judge', { profile: 'eval', route, synthetic: true }, { images: 1 }).route, route, `${route} judges a synthetic item`);
    assert.deepEqual(r.resolveRoute('eval.judge', { profile: 'eval', route }, { images: 1 }).chain.map((e) => e.provider), ['claude'], `${route}: a client image stays on Claude`);
  }
  // Every task routes in the profile as in production.
  let same = 0;
  for (const task of Object.keys(cfg.tasks)) {
    assert.equal(r.resolveRoute(task, { profile: 'eval' }).route, r.resolveRoute(task, { profile: 'prod' }).route, task);
    same += 1;
  }
  assert.ok(same > 0);
  // Every listed model is priced, and a list item with a fallback or a placeholder is refused (planted).
  const check = core.validateRoutesConfig(ASOLDI_LLM_ROUTES, { tasks: cfg.tasks, now: NOW });
  for (const entry of [...candidates, ...judges]) assert.ok(check.models.includes(entry.model), entry.model);
  for (const bad of [['claude:claude-haiku-5-5|gemini:gemini-2.5-flash'], ['${legacy}'], [], 'claude:claude-haiku-5-5']) {
    const planted = structuredClone(ASOLDI_LLM_ROUTES);
    planted.profiles.eval.judges = bad;
    assert.equal(core.validateRoutesConfig(planted, { tasks: cfg.tasks, now: NOW }).ok, false, JSON.stringify(bad));
  }
  const unpriced = structuredClone(ASOLDI_LLM_ROUTES);
  unpriced.profiles.eval.candidates.push('gemini:gemini-9-preview');
  assert.match(core.validateRoutesConfig(unpriced, { tasks: cfg.tasks, now: NOW }).errors.join('\n'), /gemini-9-preview" has no price entry/);
});

// ---------- image tasks: business class or higher, except the template-only tasks on this list ----------

/**
 * The image tasks that may stay public, each with its reason. CONTRACT.md holds the same list. A listed task
 * stays public only while its callers send template captures; a caller that sends it a capture of a client
 * run passes ctx.dataClass 'business'.
 */
const TEMPLATE_ONLY_IMAGE_TASKS = Object.freeze({
  'template-import.qa-vision': 'judges render pairs of a template import, where no client run exists',
  'siteintel.golden-judge-vision': 'labels pages of the template library for the site-intelligence golden set and never runs inside a run',
});

function publicImageTaskProblems(registry, list) {
  const problems = [];
  let read = 0;
  let imageTasks = 0;
  for (const [task, spec] of Object.entries(registry.tasks)) {
    read += 1;
    if (!spec.vision) continue;
    imageTasks += 1;
    if (spec.dataClass === 'public' && !Object.prototype.hasOwnProperty.call(list, task)) problems.push(`${task}: a public image task that is not on the template-only list`);
  }
  for (const [task, reason] of Object.entries(list)) {
    if (!(typeof reason === 'string' && reason.trim().length >= 20)) problems.push(`${task}: listed without a reason`);
    if (!registry.tasks[task]) problems.push(`${task}: listed but not registered`);
    else if (!registry.tasks[task].vision) problems.push(`${task}: listed but not an image task`);
  }
  return { problems, read, imageTasks };
}

test('registry: every image task is business class or higher, except the two template-only tasks listed with a reason', () => {
  const result = publicImageTaskProblems(ASOLDI_LLM_TASKS, TEMPLATE_ONLY_IMAGE_TASKS);
  assert.ok(result.read > 0, 'tasks read');
  assert.ok(result.imageTasks > 0, 'image tasks checked');
  assert.deepEqual(result.problems, []);
  assert.equal(Object.keys(TEMPLATE_ONLY_IMAGE_TASKS).length, 2);
  for (const task of Object.keys(TEMPLATE_ONLY_IMAGE_TASKS)) assert.equal(ASOLDI_LLM_TASKS.tasks[task].dataClass, 'public', task);
  // The three image tasks that run inside a client run are business class.
  for (const task of ['step15.judge', 'siteintel.page-kind-vision', 'icon.resolve-vision']) {
    assert.equal(ASOLDI_LLM_TASKS.tasks[task].dataClass, 'business', task);
    assert.match(ASOLDI_LLM_TASKS.tasks[task].note || '', /inside a client run/, task);
  }
  // CONTRACT.md states the same list.
  const contract = readFileSync(new URL('../packages/suite/core/llm/CONTRACT.md', import.meta.url), 'utf8');
  for (const task of Object.keys(TEMPLATE_ONLY_IMAGE_TASKS)) assert.ok(contract.includes(`\`${task}\``), `CONTRACT.md names ${task}`);
  // Two controls built at test time.
  const plantedTask = { ...ASOLDI_LLM_TASKS, tasks: { ...ASOLDI_LLM_TASKS.tasks, 'planted.shot-vision': { kind: 'json', vision: true, dataClass: 'public', maxTokens: 1000, repo: ['maker'] } } };
  assert.deepEqual(publicImageTaskProblems(plantedTask, TEMPLATE_ONLY_IMAGE_TASKS).problems, ['planted.shot-vision: a public image task that is not on the template-only list']);
  const plantedList = { ...TEMPLATE_ONLY_IMAGE_TASKS, 'siteintel.golden-judge-vision': '' };
  assert.deepEqual(publicImageTaskProblems(ASOLDI_LLM_TASKS, plantedList).problems, ['siteintel.golden-judge-vision: listed without a reason']);
});

// ---------- DeepSeek in production: a fallback for synthetic or redacted payloads only ----------

/** Every route string the prod profile can pick for a task: base, tier variants and escalation steps. */
function prodRoutesFor(routes, task, spec) {
  const view = core.profileView(routes, 'prod');
  const levels = [view, ...Object.values(view.tiers || {})];
  const out = [];
  for (const level of levels) {
    const base = level.tasks?.[task] || (spec.family && level.kinds?.[spec.family]) || (spec.vision ? level.vision : null) || level.default;
    if (base) out.push(base);
    for (const route of level.escalate?.[task] || (spec.family && level.escalateKinds?.[spec.family]) || []) out.push(route);
  }
  return out;
}

function deepseekFirstProblems(routes, registry) {
  const problems = [];
  let read = 0;
  for (const [task, spec] of Object.entries(registry.tasks)) {
    if (spec.dataClass === 'public') continue;
    for (const route of prodRoutesFor(routes, task, spec)) {
      read += 1;
      if (core.parseRoute(route)[0].provider === 'deepseek') problems.push(`${task}: ${route}`);
    }
  }
  return { problems, read };
}

test('prod routes: no task above public has DeepSeek first, and the fallback note sits next to the routes that keep it second', () => {
  const result = deepseekFirstProblems(ASOLDI_LLM_ROUTES, ASOLDI_LLM_TASKS);
  assert.ok(result.read > 0, 'routes read');
  assert.deepEqual(result.problems, []);
  const prod = ASOLDI_LLM_ROUTES.profiles.prod;
  assert.match(prod.note, /fallback for synthetic or redacted payloads only; the policy skips this entry for unredacted real-client data/);
  // This change moved no route value: classification and extraction keep DeepSeek second.
  assert.equal(prod.kinds.classification, 'claude:claude-haiku-5-5:low|deepseek:deepseek-flash');
  assert.equal(prod.kinds.extraction, 'claude:claude-haiku-5-5:low|deepseek:deepseek-flash');
  const withDeepseek = Object.entries(prod.kinds).filter(([, route]) => /deepseek/.test(route)).map(([family]) => family);
  assert.deepEqual(withDeepseek, ['classification', 'extraction']);
  // Control: a planted DeepSeek-first business route fails the check.
  const planted = structuredClone(ASOLDI_LLM_ROUTES);
  planted.profiles.prod.kinds.copy = 'deepseek:deepseek-flash|claude:claude-haiku-5-5:medium';
  const caught = deepseekFirstProblems(planted, ASOLDI_LLM_TASKS).problems;
  assert.ok(caught.length > 0 && caught.every((line) => /deepseek:deepseek-flash\|claude/.test(line)), JSON.stringify(caught.slice(0, 3)));
});

/** An unredacted payload of a task's own class: free text that names a person, with no flag. */
const UNREDACTED = Object.freeze({ user: 'Kari Nordmann sa i møtet at hun vil ha et nytt bilde på forsiden. Ola Hansen sender teksten.' });

function deepseekAfterPolicy(coreModule, policy, { payloadCtx = {} } = {}) {
  const cfg = asoldiLlmConfig();
  const r = coreModule.createRouter({ ...cfg, policy, legacyRoute, now: NOW });
  const left = [];
  let resolved = 0;
  let routesRead = 0;
  for (const [task, spec] of Object.entries(cfg.tasks)) {
    if (spec.dataClass !== 'personal' && spec.dataClass !== 'transcript') continue;
    routesRead += prodRoutesFor(ASOLDI_LLM_ROUTES, task, spec).length;
    for (const tier of [undefined, 1, 2, 3]) {
      for (let step = 0; step <= 2; step += 1) {
        const route = r.resolveRoute(task, { profile: 'prod', escalation: step, ...(tier ? { tier } : {}), ...payloadCtx }, { payload: UNREDACTED });
        resolved += 1;
        if (route.chain.some((e) => e.provider === 'deepseek')) left.push(`${task} tier ${tier || '-'} step ${step}: ${route.route}`);
      }
    }
  }
  return { left, resolved, routesRead };
}

test('prod chain after the policy: no personal or transcript task keeps a DeepSeek entry for an unredacted payload', async () => {
  const shipped = deepseekAfterPolicy(core, ASOLDI_LLM_POLICY);
  assert.ok(shipped.resolved > 0, 'tasks resolved');
  assert.ok(shipped.routesRead > 0, 'routes read');
  assert.deepEqual(shipped.left, []);
  // The redacted flag changes nothing for a payload that still names people or is a transcript.
  assert.deepEqual(deepseekAfterPolicy(core, ASOLDI_LLM_POLICY, { payloadCtx: { redacted: true } }).left.filter((line) => /^(offer|workshop|brief|followups|seo\.agreed|cms)/.test(line)), []);

  // Planted control. Hard rule 1 (DeepSeek never gets personal or transcript data) is backed by hard rule 2 and
  // by the allow list of the shipped policy, so the control takes all three away: a copy of the core without
  // the two DeepSeek rules, under a policy whose allow list is wide open. A DeepSeek entry is then left.
  const wide = { ...ASOLDI_LLM_POLICY, providers: { ...ASOLDI_LLM_POLICY.providers, deepseek: { allow: ['public', 'business', 'personal', 'transcript'] } } };
  assert.deepEqual(deepseekAfterPolicy(core, wide).left, [], 'the real core ignores a wide allow list (the hard rules hold)');
  const copy = await coreWithoutRules(['deepseek-never-personal', 'deepseek-client-data']);
  try {
    const escaped = deepseekAfterPolicy(copy.core, wide).left;
    assert.ok(escaped.length > 0, 'without the hard rules a DeepSeek entry is left, so the assertion above fails on the copy');
    assert.ok(escaped.some((line) => /^offer\.fill-from-transcript /.test(line)), JSON.stringify(escaped.slice(0, 3)));
  } finally {
    copy.dispose();
  }
  // Hard rule 1 on its own, at the rule: the copy without it lets personal data through where the real core does not.
  const onlyRuleOne = await coreWithoutRules(['deepseek-never-personal']);
  try {
    for (const dataClass of ['personal', 'transcript']) {
      assert.equal(core.providerAllows(wide, 'deepseek', dataClass, { redacted: true }).allowed, false, dataClass);
      assert.equal(onlyRuleOne.core.providerAllows(wide, 'deepseek', dataClass, { redacted: true }).allowed, true, `${dataClass}: the copy without rule 1`);
    }
  } finally {
    onlyRuleOne.dispose();
  }
});

test('legacy profile: a resolver that returns a DeepSeek model for a personal task ends with no DeepSeek entry; a synthetic payload keeps it', () => {
  const resolver = () => 'deepseek:deepseek-chat';
  const r = core.createRouter({ ...asoldiLlmConfig(), legacyRoute: resolver, now: NOW });
  let cases = 0;
  const real = r.resolveRoute('change.classify', { profile: 'legacy' }, { payload: UNREDACTED });
  cases += 1;
  assert.equal(real.legacy, true);
  assert.equal(real.chain.filter((e) => e.provider === 'deepseek').length, 0, real.route);
  assert.equal(real.route, 'claude:claude-haiku-5-5:low');
  assert.match(real.policyRedirects[0].from, /^deepseek:/);
  assert.equal(cases, 1, 'cases run');
  // Positive control: the same resolver with a synthetic payload keeps the entry.
  const synthetic = r.resolveRoute('change.classify', { profile: 'legacy', synthetic: true }, { payload: { user: 'Fixture client asks for a new picture. Write to post@example.no' } });
  assert.equal(synthetic.route, 'deepseek:deepseek-chat');
});

// ---------- route-table snapshot: what this change may and may not move ----------

const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/llm-route-snapshot.json', import.meta.url), 'utf8'));

/** First choices that differ from the snapshot on purpose, each with its reason. */
const DECLARED_ROUTE_CHANGES = Object.freeze({
  'prod dev.judge': ['claude:claude-sonnet-5-5', 'the judge never runs on the planner model (dev.plan starts on Haiku 5.5)'],
});

function snapshotDifferences(routes, { policy = ASOLDI_LLM_POLICY, declared = DECLARED_ROUTE_CHANGES } = {}) {
  const cfg = asoldiLlmConfig();
  const r = core.createRouter({ ...cfg, routes, policy, legacyRoute, now: NOW });
  const differences = [];
  let compared = 0;
  for (const [profile, table] of Object.entries(SNAPSHOT.profiles)) {
    for (const [task, before] of Object.entries(table)) {
      const spec = cfg.tasks[task];
      if (!spec) {
        differences.push(`${profile} ${task}: the task is gone (task keys are append-only)`);
        continue;
      }
      // An image task is resolved as an image call, which is how it runs.
      const route = r.resolveRoute(task, { profile }, { images: spec.vision ? 1 : 0 });
      const now = `${route.primary.provider}:${route.primary.model}`;
      compared += 1;
      const allowed = declared[`${profile} ${task}`];
      if (allowed ? now !== allowed[0] : now !== before) differences.push(`${profile} ${task}: ${before} -> ${now}`);
    }
  }
  return { differences, compared };
}

test('route-table snapshot: every task that existed before keeps its first choice in the prod and legacy profiles, except the declared changes', () => {
  assert.match(SNAPSHOT.base, /^[0-9a-f]{40}$/);
  const result = snapshotDifferences(ASOLDI_LLM_ROUTES);
  assert.ok(result.compared > 0, 'routes compared');
  assert.equal(result.compared, Object.values(SNAPSHOT.profiles).reduce((sum, table) => sum + Object.keys(table).length, 0));
  assert.deepEqual(result.differences, []);
  for (const [key, [, reason]] of Object.entries(DECLARED_ROUTE_CHANGES)) assert.ok(reason.length >= 20, `${key} has a reason`);
  // Every declared change is a real one (a stale entry fails), and without the list each shows up.
  const undeclared = snapshotDifferences(ASOLDI_LLM_ROUTES, { declared: {} }).differences;
  assert.equal(undeclared.length, Object.keys(DECLARED_ROUTE_CHANGES).length, JSON.stringify(undeclared));
  // Control: a planted change to one existing route fails the snapshot.
  const planted = structuredClone(ASOLDI_LLM_ROUTES);
  planted.profiles.prod.kinds.copy = 'claude:claude-sonnet-5-5:medium';
  const caught = snapshotDifferences(planted).differences;
  assert.ok(caught.some((line) => /^prod step2\.copywriter: claude:claude-haiku-5-5 -> claude:claude-sonnet-5-5$/.test(line)), JSON.stringify(caught.slice(0, 3)));
  // New tasks are not in the snapshot; they are checked by their own tests above.
  for (const task of Object.keys(SEO_TASKS)) assert.equal(SNAPSHOT.profiles.prod[task], undefined, task);
});
