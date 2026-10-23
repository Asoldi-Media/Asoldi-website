// Scaled soft budgets. Caps never block a larger project:
//   - the expected cost of a run or session comes from project size (pages x locales x products x tier);
//   - reaching 100 % of expected gives an alert and the work continues;
//   - a run or session with no project size gets the base expected cost of one reference project, so the
//     runaway stop is never off; facades pass projectSize so larger projects scale up;
//   - a hard stop happens only for a runaway (projected spend > runawayFactor x expected, default 5)
//     or a loop (the same request repeating with no progress inside one run/session and a 15-minute window);
//   - periodic totals (per client per month, global per day, evaluation) alert only.
//
// ai-budgets.json
// { version: 1, alertRatio: 1, runawayFactor: 5,
//   scopes: { run: { baseUsd: {default, 'tier-1-standard', ...}, referencePages, extraLocaleFactor, productsPerPage },
//             devSession: {...}, iteration: { of: 'devSession', factor: 0.5 } },
//   periodic: { clientMonthUsd: 10, makerDayUsd: 15, hubDayUsd: 5, evalTotalUsd: 200 },
//   loop: { maxRepeats: 3, maxIdentical: 6, windowMinutes: 15 } }

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
    if (!(key in PERIODIC_SCOPES)) errors.push(`budgets.periodic.${key}: unknown periodic budget (known: ${Object.keys(PERIODIC_SCOPES).join(', ')})`);
    if (!(Number(value) > 0)) errors.push(`budgets.periodic.${key} must be a positive number`);
  }
  for (const [key, value] of Object.entries(config.loop || {})) {
    if (!['maxRepeats', 'maxIdentical', 'windowMinutes'].includes(key)) errors.push(`budgets.loop.${key}: unknown field`);
    else if (!(Number(value) > 0)) errors.push(`budgets.loop.${key} must be a positive number`);
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

export const IMAGE_TOKEN_ESTIMATE = 1600;

/** Characters of text and the number of image/document blocks in a messages array (base64 is not text). */
function messageSize(messages) {
  let chars = 0;
  let images = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = message?.content;
    if (typeof content === 'string') {
      chars += content.length;
      continue;
    }
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === 'image' || block?.type === 'document') images += 1;
      else if (block?.type === 'text') chars += String(block.text || '').length;
      else if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        const inner = messageSize([{ content: block.content }]);
        chars += inner.chars;
        images += inner.images;
      } else chars += canonicalJson(block ?? '').length;
    }
  }
  return { chars, images };
}

/**
 * Rough input token count before a call: characters / 3.5, plus ~1600 tokens per image at 1568 px.
 * Image and document blocks inside messages count as images, never as their base64 text.
 */
export function estimateInputTokens({ system = '', user = '', messages = null, images = 0 } = {}) {
  const textOf = (value) => (typeof value === 'string' ? value : canonicalJson(value ?? ''));
  let chars = textOf(system).length + textOf(user).length;
  let imageCount = Number(images) || 0;
  if (messages) {
    const size = messageSize(messages);
    chars += size.chars;
    imageCount += size.images;
  }
  return Math.ceil(chars / 3.5) + imageCount * IMAGE_TOKEN_ESTIMATE;
}

/** Output estimate for budgets: half the cap (thinking included). */
export function estimateOutputTokens(maxTokens = 0) {
  return Math.ceil((Number(maxTokens) || 0) * 0.5);
}

function windowMsOf({ windowMs, windowMinutes } = {}) {
  if (Number(windowMs) > 0) return Number(windowMs);
  return (Number(windowMinutes) > 0 ? Number(windowMinutes) : BUDGET_RULES.loopWindowMinutes) * 60_000;
}

function trailingStreak(events) {
  if (!events.length) return 0;
  const last = events[events.length - 1].outcome;
  let streak = 0;
  for (let i = events.length - 1; i >= 0 && events[i].outcome === last; i -= 1) streak += 1;
  return streak;
}

/**
 * Pure loop check over a call history: within one window, the same request (`inputKey`) giving the same
 * outcome (`outcomeKey`: output hash or error code) `maxRepeats` times in a row, or the same request sent
 * `maxIdentical` times, is a loop. Items may carry `at` (ms); then only items within `windowMs` of the
 * newest one count.
 */
export function detectLoop(history = [], { maxRepeats = BUDGET_RULES.loopMaxRepeats, maxIdentical = BUDGET_RULES.loopMaxIdentical, windowMs = null, windowMinutes = null } = {}) {
  const items = Array.isArray(history) ? history : [];
  const newest = items.reduce((max, item) => (Number.isFinite(item?.at) ? Math.max(max, item.at) : max), -Infinity);
  const span = windowMsOf({ windowMs, windowMinutes });
  const byInput = new Map();
  for (const item of items) {
    if (Number.isFinite(item?.at) && Number.isFinite(newest) && newest - item.at > span) continue;
    const key = `${item.task}|${item.inputKey}`;
    const events = byInput.get(key) || [];
    events.push({ outcome: item.outcomeKey });
    byInput.set(key, events);
    const streak = trailingStreak(events);
    if (streak >= maxRepeats) return { loop: true, reason: 'same-outcome', key, count: streak };
    if (events.length >= maxIdentical) return { loop: true, reason: 'identical-requests', key, count: events.length };
  }
  return { loop: false, reason: '', key: null, count: 0 };
}

/**
 * In-memory loop detector. Callers key requests by scope (run, session, job or task id) plus the request;
 * the core skips the detector for calls without such a scope. Only calls within the window count, so a
 * block expires on its own and the same request on another day is never a loop.
 *   before(task, key) -> {loop, reason, count}: would sending this request again continue a loop?
 *   after(task, key, outcome) records the outcome.
 */
export function createLoopDetector({
  maxRepeats = BUDGET_RULES.loopMaxRepeats,
  maxIdentical = BUDGET_RULES.loopMaxIdentical,
  windowMs = null,
  windowMinutes = null,
  maxEntries = 5000,
  now = () => Date.now(),
} = {}) {
  const span = windowMsOf({ windowMs, windowMinutes });
  const states = new Map();
  const keyOf = (task, inputKey) => `${task}|${inputKey}`;
  const fresh = (key) => {
    const events = states.get(key);
    if (!events) return [];
    const t = Number(now());
    const kept = events.filter((event) => t - event.at <= span);
    if (kept.length) states.set(key, kept);
    else states.delete(key);
    return kept;
  };
  return {
    before(task, inputKey) {
      const events = fresh(keyOf(task, inputKey));
      if (!events.length) return { loop: false, reason: '', count: 0 };
      const streak = trailingStreak(events);
      if (streak >= maxRepeats) return { loop: true, reason: 'same-outcome', count: streak };
      if (events.length >= maxIdentical) return { loop: true, reason: 'identical-requests', count: events.length };
      return { loop: false, reason: '', count: events.length };
    },
    after(task, inputKey, outcomeKey) {
      const key = keyOf(task, inputKey);
      const events = fresh(key);
      events.push({ at: Number(now()), outcome: outcomeKey });
      while (events.length > maxIdentical + maxRepeats) events.shift();
      states.delete(key);
      states.set(key, events);
      if (states.size > maxEntries) states.delete(states.keys().next().value);
      return { count: events.length, streak: trailingStreak(events) };
    },
    reset() {
      states.clear();
    },
  };
}

/** The scope id loop detection and in-memory spend use: the first of runId, sessionId, jobId, taskId. */
export function loopScopeOf(ctx = {}) {
  for (const field of BUDGET_RULES.loopScopeFields) if (ctx?.[field]) return `${field}:${ctx[field]}`;
  return '';
}

/** Periodic budget keys in ai-budgets.json and the spend scope each one asks `spentUsd` for. */
export const PERIODIC_SCOPES = Object.freeze({
  clientMonthUsd: 'clientMonth',
  makerDayUsd: 'makerDay',
  hubDayUsd: 'hubDay',
  evalTotalUsd: 'eval',
});

/**
 * The periodic scopes that apply to one call. They alert only, never stop.
 *   clientMonth: the call names a salesClientId    makerDay / hubDay: by repo
 *   eval: task key starts with "eval." or ctx.budgetScope is "eval"
 */
export function periodicScopesFor(config = {}, { ctx = {}, task = '', repo = '' } = {}) {
  const out = [];
  for (const [key, scope] of Object.entries(PERIODIC_SCOPES)) {
    const capUsd = Number(config?.periodic?.[key]);
    if (!(capUsd > 0)) continue;
    const applies =
      (scope === 'clientMonth' && Boolean(ctx.salesClientId)) ||
      (scope === 'makerDay' && repo === 'maker') ||
      (scope === 'hubDay' && repo === 'hub') ||
      (scope === 'eval' && (String(task).startsWith('eval.') || ctx.budgetScope === 'eval'));
    if (applies) out.push({ key, scope, capUsd });
  }
  return out;
}
