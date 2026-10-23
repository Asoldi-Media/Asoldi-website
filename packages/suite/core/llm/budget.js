// Scaled soft budgets. Caps never block a larger project:
//   - the expected cost of a run or session comes from project size (pages x locales x products x tier);
//   - reaching 100 % of expected gives an alert and the work continues;
//   - a hard stop happens only for a runaway (projected spend > runawayFactor x expected, default 5)
//     or a loop (the same request repeating with no progress);
//   - periodic totals (per client per month, global per day, evaluation) alert only.
//
// ai-budgets.json
// { version: 1, alertRatio: 1, runawayFactor: 5,
//   scopes: { run: { baseUsd: {default, 'tier-1-standard', ...}, referencePages, extraLocaleFactor, productsPerPage },
//             devSession: {...}, iteration: { of: 'devSession', factor: 0.5 } },
//   periodic: { clientMonthUsd: 10, makerDayUsd: 15, hubDayUsd: 5, evalTotalUsd: 200 },
//   loop: { maxRepeats: 3, maxIdentical: 6 } }

import { BUDGET_RULES, TIERS, normalizeTier } from './constants.js';
import { canonicalJson } from './cassette.js';

const SCOPE_FIELDS = ['baseUsd', 'referencePages', 'extraLocaleFactor', 'productsPerPage', 'of', 'factor', 'note'];

export function validateBudgetsConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return { ok: false, errors: ['budgets must be an object'] };
  if (config.version !== 1) errors.push('budgets.version must be 1');
  for (const key of ['alertRatio', 'runawayFactor']) {
    if (config[key] !== undefined && !(Number(config[key]) > 0)) errors.push(`budgets.${key} must be a positive number`);
  }
  if (Number(config.runawayFactor ?? BUDGET_RULES.runawayFactor) <= Number(config.alertRatio ?? BUDGET_RULES.alertRatio)) {
    errors.push('budgets.runawayFactor must be larger than alertRatio');
  }
  const scopes = config.scopes || {};
  for (const [name, scope] of Object.entries(scopes)) {
    if (!scope || typeof scope !== 'object') {
      errors.push(`budgets.scopes.${name} must be an object`);
      continue;
    }
    for (const field of Object.keys(scope)) if (!SCOPE_FIELDS.includes(field)) errors.push(`budgets.scopes.${name}: unknown field "${field}"`);
    if (scope.of) {
      if (!scopes[scope.of]) errors.push(`budgets.scopes.${name}.of: scope "${scope.of}" is not defined`);
      if (!(Number(scope.factor) > 0)) errors.push(`budgets.scopes.${name}.factor must be a positive number`);
      continue;
    }
    const base = scope.baseUsd;
    if (!base || typeof base !== 'object' || !(Number(base.default) > 0)) errors.push(`budgets.scopes.${name}.baseUsd.default must be a positive number`);
    for (const tier of Object.keys(base || {})) if (tier !== 'default' && !TIERS.includes(tier)) errors.push(`budgets.scopes.${name}.baseUsd.${tier}: unknown tier`);
  }
  for (const [key, value] of Object.entries(config.periodic || {})) {
    if (!(Number(value) > 0)) errors.push(`budgets.periodic.${key} must be a positive number`);
  }
  return { ok: errors.length === 0, errors };
}

function sizeUnits(size = {}, scope = {}) {
  const pages = Math.max(1, Number(size.pages) || 1);
  const locales = Math.max(1, Number(size.locales) || 1);
  const products = Math.max(0, Number(size.products) || 0);
  const extraLocale = scope.extraLocaleFactor ?? 0.75;
  const productsPerPage = scope.productsPerPage ?? 20;
  return pages * (1 + (locales - 1) * extraLocale) + products / productsPerPage;
}

/**
 * Expected USD for one scope ('run', 'devSession', 'iteration', ...) of a project.
 *   expected = baseUsd[tier] x max(1, units / referencePages)
 *   units    = pages x (1 + (locales - 1) x extraLocaleFactor) + products / productsPerPage
 * A scope with `of` is a fraction of another scope (an iteration is half a dev session).
 */
export function expectedCostUsd(config = {}, scopeName = 'run', { tier = '', projectSize = {} } = {}) {
  const scopes = config.scopes || {};
  let scope = scopes[scopeName];
  let factor = 1;
  const seen = new Set();
  while (scope?.of) {
    if (seen.has(scopeName)) return null;
    seen.add(scopeName);
    factor *= Number(scope.factor) || 1;
    scopeName = scope.of;
    scope = scopes[scopeName];
  }
  if (!scope?.baseUsd) return null;
  const tierKey = normalizeTier(tier);
  const base = Number(scope.baseUsd[tierKey]) || Number(scope.baseUsd.default) || 0;
  const reference = Math.max(1, Number(scope.referencePages) || 6);
  const scale = Math.max(1, sizeUnits(projectSize, scope) / reference);
  return Math.round(base * scale * factor * 1e6) / 1e6;
}

/**
 * The decision before a call.
 *   action 'ok'    -> go on
 *   action 'alert' -> go on, and tell someone (once per scope is the caller's choice)
 *   action 'stop'  -> runaway: throw BudgetExceededError
 * Periodic scopes (mode 'alert-only') never stop.
 */
export function evaluateBudget({ expectedUsd, spentUsd = 0, estimateUsd = 0, alertRatio = BUDGET_RULES.alertRatio, runawayFactor = BUDGET_RULES.runawayFactor, mode = 'scaled' } = {}) {
  const expected = Number(expectedUsd);
  const projected = Math.max(0, Number(spentUsd) || 0) + Math.max(0, Number(estimateUsd) || 0);
  if (!(expected > 0)) return { action: 'ok', reason: 'no-expected-cost', projectedUsd: projected, expectedUsd: null, ratio: null };
  const ratio = projected / expected;
  const thresholds = { alertUsd: expected * alertRatio, runawayUsd: expected * runawayFactor };
  if (mode !== 'alert-only' && ratio > runawayFactor) {
    return { action: 'stop', reason: 'runaway', projectedUsd: projected, expectedUsd: expected, ratio, thresholds };
  }
  if (ratio >= alertRatio) return { action: 'alert', reason: 'over-expected', projectedUsd: projected, expectedUsd: expected, ratio, thresholds };
  return { action: 'ok', reason: '', projectedUsd: projected, expectedUsd: expected, ratio, thresholds };
}

/** Rough input token count before a call: characters / 3.5, plus ~1600 tokens per image at 1568 px. */
export function estimateInputTokens({ system = '', user = '', messages = null, images = 0 } = {}) {
  const textOf = (value) => (typeof value === 'string' ? value : canonicalJson(value ?? ''));
  let chars = textOf(system).length + textOf(user).length;
  if (messages) chars += textOf(messages).length;
  return Math.ceil(chars / 3.5) + (Number(images) || 0) * 1600;
}

/** Output estimate for budgets: half the cap (thinking included). */
export function estimateOutputTokens(maxTokens = 0) {
  return Math.ceil((Number(maxTokens) || 0) * 0.5);
}

/**
 * Pure loop check over a call history: the same request (`inputKey`) giving the same outcome
 * (`outcomeKey`: output hash or error code) `maxRepeats` times in a row, or the same request sent
 * `maxIdentical` times in total, is a loop.
 */
export function detectLoop(history = [], { maxRepeats = BUDGET_RULES.loopMaxRepeats, maxIdentical = BUDGET_RULES.loopMaxIdentical } = {}) {
  const byInput = new Map();
  for (const item of history) {
    const key = `${item.task}|${item.inputKey}`;
    const state = byInput.get(key) || { total: 0, streak: 0, lastOutcome: null };
    state.total += 1;
    state.streak = state.lastOutcome !== null && state.lastOutcome === item.outcomeKey ? state.streak + 1 : 1;
    state.lastOutcome = item.outcomeKey;
    byInput.set(key, state);
    if (state.streak >= maxRepeats) return { loop: true, reason: 'same-outcome', key, count: state.streak };
    if (state.total >= maxIdentical) return { loop: true, reason: 'identical-requests', key, count: state.total };
  }
  return { loop: false, reason: '', key: null, count: 0 };
}

/**
 * In-memory loop detector for one process or session. `before()` says whether sending this request again
 * would continue a loop; `after()` records the outcome.
 */
export function createLoopDetector({ maxRepeats = BUDGET_RULES.loopMaxRepeats, maxIdentical = BUDGET_RULES.loopMaxIdentical, maxEntries = 5000 } = {}) {
  const states = new Map();
  const keyOf = (task, inputKey) => `${task}|${inputKey}`;
  return {
    before(task, inputKey) {
      const state = states.get(keyOf(task, inputKey));
      if (!state) return { loop: false, count: 0 };
      if (state.streak >= maxRepeats) return { loop: true, reason: 'same-outcome', count: state.streak };
      if (state.total >= maxIdentical) return { loop: true, reason: 'identical-requests', count: state.total };
      return { loop: false, count: state.total };
    },
    after(task, inputKey, outcomeKey) {
      const key = keyOf(task, inputKey);
      const state = states.get(key) || { total: 0, streak: 0, lastOutcome: null };
      state.total += 1;
      state.streak = state.lastOutcome !== null && state.lastOutcome === outcomeKey ? state.streak + 1 : 1;
      state.lastOutcome = outcomeKey;
      states.delete(key);
      states.set(key, state);
      if (states.size > maxEntries) states.delete(states.keys().next().value);
      return state;
    },
    reset() {
      states.clear();
    },
  };
}
