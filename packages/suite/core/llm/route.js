// Routing: the ai-routes.json schema, its validator, and resolveRoute(task, ctx).
//
// ai-routes.json
// { version: 1,
//   profiles: {
//     legacy: { default: '${legacy}', vision: '${legacy}' },
//     prod:   { default, vision?, tasks?: {task: route}, kinds?: {family: route},
//               escalate?: {task: [route, ...]}, escalateKinds?: {family: [route, ...]},
//               tiers?: { 'tier-3-ecommerce': { default?, vision?, tasks?, kinds?, escalate?, escalateKinds? } } },
//     test:   { ... }, replay: { default: 'replay:strict', vision: 'replay:strict' },
//     record: { inherit: 'test', record: true } } }
//
// Resolution order (first hit wins):
//   1 ctx.route (tests only)          2 env AI_ROUTE_<TASK>          3 env AI_ROUTE_DEFAULT / AI_ROUTE_VISION_DEFAULT
//   4 escalate list when ctx.escalation > 0 (tier list, then profile list; by task, then by family)
//   5 tiers[tier].tasks[task]         6 tasks[task]                  7 tiers[tier].kinds[family]
//   8 kinds[family]                   9 vision route (vision tasks)  10 tier default, then profile default
// Then: capability filter (vision/tools), data policy (redirects), effort fill.
// Profile: ctx.profile beats env AI_PROFILE; AI_TEST_MODE=1 means `test`; the default is `legacy`.

import {
  CLAUDE_RULES,
  DEFAULT_PROFILE,
  EFFORTS,
  PROFILES,
  PROVIDER_CAPABILITIES,
  TIERS,
  DATA_CLASSES,
  normalizeProfile,
  normalizeTier,
} from './constants.js';
import { PolicyBlockedError, RouteConfigError } from './errors.js';
import { applyPolicy, effectiveDataClass, validatePolicy } from './policy.js';
import { checkModelPrices, priceEntry, PRICES } from './prices.js';
import { LEGACY_PLACEHOLDER, formatRoute, formatRouteEntry, parseRoute, sameEntry } from './route-string.js';
import { FAMILY_PATTERN, getTask, taskEnvKey } from './tasks-schema.js';

export { parseRoute, formatRoute, formatRouteEntry, LEGACY_PLACEHOLDER } from './route-string.js';

/** Every ctx field the contract knows. Anything else is ignored (and listed in `ignored`). */
export const CTX_FIELDS = Object.freeze([
  'runId',
  'salesClientId',
  'sessionId',
  'taskId',
  'jobId',
  'step',
  'tier',
  'profile',
  'kind',
  'escalation',
  'maxEscalation',
  'dataClass',
  'synthetic',
  'redacted',
  'vision',
  'route',
  'budgetScope',
  'expectedUsd',
  'projectSize',
  'retryOf',
  'attempt',
]);

const ID_FIELDS = ['runId', 'salesClientId', 'sessionId', 'taskId', 'jobId', 'step', 'budgetScope', 'retryOf'];
const SPECIFIC_SOURCES = new Set(['override', 'env-task', 'escalate', 'tier-task', 'task']);

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function nonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Validates and trims a ctx object to the contract's fields. Throws on a malformed value that comes from code
 * (profile, kind, dataClass, maxEscalation). Values that come from client data never throw: an unknown tier
 * (for example the hub's 'custom' tier) means "no tier override" and adds a warning.
 */
export function normalizeCtx(ctx = {}) {
  const src = ctx && typeof ctx === 'object' ? ctx : {};
  const out = {};
  const warnings = [];
  for (const key of ID_FIELDS) {
    if (src[key] !== undefined && src[key] !== null && src[key] !== '') out[key] = String(src[key]).trim().slice(0, 200);
  }
  if (src.tier !== undefined && src.tier !== null && src.tier !== '') {
    const tier = normalizeTier(src.tier);
    if (tier) out.tier = tier;
    else warnings.push(`ctx.tier "${String(src.tier).slice(0, 40)}" is not one of ${TIERS.join(', ')}; no tier routes, default budget base`);
  }
  if (src.profile) {
    const profile = normalizeProfile(src.profile);
    if (!profile) throw new RouteConfigError(`ctx.profile "${src.profile}" is not one of ${PROFILES.join(', ')} (or production).`);
    out.profile = profile;
  }
  if (src.kind) {
    if (!FAMILY_PATTERN.test(String(src.kind))) throw new RouteConfigError(`ctx.kind "${src.kind}" must be a kebab-case family name.`);
    out.kind = String(src.kind);
  }
  out.escalation = nonNegativeInt(src.escalation) ?? 0;
  if (src.maxEscalation !== undefined && src.maxEscalation !== null) {
    const cap = nonNegativeInt(src.maxEscalation);
    if (cap === null) throw new RouteConfigError('ctx.maxEscalation must be a non-negative integer.');
    out.maxEscalation = cap;
  }
  if (src.dataClass) {
    if (!DATA_CLASSES.includes(src.dataClass)) throw new RouteConfigError(`ctx.dataClass "${src.dataClass}" is not one of ${DATA_CLASSES.join(', ')}.`);
    out.dataClass = src.dataClass;
  }
  if (src.synthetic === true) out.synthetic = true;
  if (src.redacted === true) out.redacted = true;
  if (src.vision === false) out.vision = false;
  if (typeof src.route === 'string' && src.route.trim()) out.route = src.route.trim();
  // 0 or a negative value would switch the runaway stop off; it means "not given".
  const expected = nonNegativeNumber(src.expectedUsd);
  if (expected !== null && expected > 0) out.expectedUsd = expected;
  const attempt = nonNegativeInt(src.attempt);
  if (attempt !== null && attempt > 0) out.attempt = attempt;
  if (src.projectSize && typeof src.projectSize === 'object') {
    const size = {};
    for (const key of ['pages', 'locales', 'products']) {
      const n = nonNegativeNumber(src.projectSize[key]);
      if (n !== null) size[key] = n;
    }
    out.projectSize = size;
  }
  const ignored = Object.keys(src).filter((key) => !CTX_FIELDS.includes(key));
  return { ctx: out, ignored, warnings };
}

function mergeMaps(base = {}, over = {}) {
  return { ...(base || {}), ...(over || {}) };
}

function mergeLevel(base = {}, over = {}) {
  const out = { ...base, ...over };
  for (const key of ['tasks', 'kinds', 'escalate', 'escalateKinds']) out[key] = mergeMaps(base[key], over[key]);
  return out;
}

/** A profile with its `inherit` chain merged in (child wins, maps merged key by key). */
export function profileView(routes, profileName) {
  const profiles = routes?.profiles || {};
  const seen = new Set();
  const stack = [];
  let name = profileName;
  while (name) {
    if (seen.has(name)) throw new RouteConfigError(`ai-routes: profile inheritance loop at "${name}".`);
    seen.add(name);
    const prof = profiles[name];
    if (!prof) throw new RouteConfigError(`ai-routes: profile "${name}" is not defined.`);
    stack.unshift(prof);
    name = prof.inherit || '';
  }
  let view = {};
  for (const prof of stack) {
    const tiers = {};
    for (const tier of new Set([...Object.keys(view.tiers || {}), ...Object.keys(prof.tiers || {})])) {
      tiers[tier] = mergeLevel(view.tiers?.[tier] || {}, prof.tiers?.[tier] || {});
    }
    view = { ...mergeLevel(view, prof), tiers };
  }
  delete view.inherit;
  return view;
}

function routeStrings(level = {}) {
  const out = [];
  for (const key of ['default', 'vision']) if (level[key]) out.push({ at: key, route: level[key] });
  for (const key of ['tasks', 'kinds']) for (const [k, v] of Object.entries(level[key] || {})) out.push({ at: `${key}.${k}`, route: v });
  for (const key of ['escalate', 'escalateKinds']) {
    for (const [k, list] of Object.entries(level[key] || {})) {
      if (!Array.isArray(list)) out.push({ at: `${key}.${k}`, route: null, notList: true });
      else list.forEach((route, i) => out.push({ at: `${key}.${k}[${i}]`, route }));
    }
  }
  return out;
}

/**
 * Validates an ai-routes config. Unknown models, unparseable routes, unknown tasks and stale prices are
 * errors; unverified prices and vision routes that will be filtered are warnings.
 */
export function validateRoutesConfig(routes, { tasks = null, prices = PRICES, now = new Date(), unknownTasks = 'error', stalePrices = 'error' } = {}) {
  const errors = [];
  const warnings = [];
  const models = [];
  if (!routes || typeof routes !== 'object') return { ok: false, errors: ['routes must be an object'], warnings, models };
  if (routes.version !== 1) errors.push('routes.version must be 1');
  const profiles = routes.profiles;
  if (!profiles || typeof profiles !== 'object') {
    errors.push('routes.profiles must be an object');
    return { ok: false, errors, warnings, models };
  }
  for (const [name, prof] of Object.entries(profiles)) {
    const at = `profiles.${name}`;
    if (!PROFILES.includes(name)) errors.push(`${at}: unknown profile (known: ${PROFILES.join(', ')})`);
    if (!prof || typeof prof !== 'object') {
      errors.push(`${at}: must be an object`);
      continue;
    }
    if (prof.inherit && !profiles[prof.inherit]) errors.push(`${at}.inherit: profile "${prof.inherit}" is not defined`);
    let view = null;
    try {
      view = profileView(routes, name);
    } catch (error) {
      errors.push(`${at}: ${error.message}`);
    }
    if (view && !view.default) errors.push(`${at}.default is required (directly or through inherit)`);
    const levels = [{ at, level: prof }];
    for (const [tier, level] of Object.entries(prof.tiers || {})) {
      if (!TIERS.includes(tier)) errors.push(`${at}.tiers.${tier}: unknown tier`);
      levels.push({ at: `${at}.tiers.${tier}`, level: level || {} });
    }
    for (const { at: levelAt, level } of levels) {
      for (const key of ['tasks', 'escalate']) {
        for (const task of Object.keys(level[key] || {})) {
          // A routes file shared by two repos names tasks of both; each repo passes unknownTasks:'warn'.
          if (tasks && !tasks[task]) (unknownTasks === 'warn' ? warnings : errors).push(`${levelAt}.${key}.${task}: task is not in the registry`);
        }
      }
      for (const key of ['kinds', 'escalateKinds']) {
        for (const family of Object.keys(level[key] || {})) if (!FAMILY_PATTERN.test(family)) errors.push(`${levelAt}.${key}.${family}: not a kebab-case family`);
      }
      for (const item of routeStrings(level)) {
        if (item.notList) {
          errors.push(`${levelAt}.${item.at} must be a list of routes`);
          continue;
        }
        let chain;
        try {
          chain = parseRoute(item.route);
        } catch (error) {
          errors.push(`${levelAt}.${item.at}: ${error.message}`);
          continue;
        }
        if (chain[0].provider === 'legacy') {
          if (name !== 'legacy') warnings.push(`${levelAt}.${item.at}: ${LEGACY_PLACEHOLDER} outside the legacy profile`);
          continue;
        }
        for (const entry of chain) if (entry.provider !== 'replay') models.push(entry.model);
        if (tasks && item.at.startsWith('tasks.')) {
          const spec = tasks[item.at.slice('tasks.'.length)];
          if (spec?.vision && !chain.some((e) => PROVIDER_CAPABILITIES[e.provider]?.vision)) {
            warnings.push(`${levelAt}.${item.at}: vision task routed only to text providers; the vision route will be used`);
          }
          if (spec?.kind === 'tools' && !chain.some((e) => PROVIDER_CAPABILITIES[e.provider]?.tools)) {
            errors.push(`${levelAt}.${item.at}: tools task needs a provider with a tool loop (claude)`);
          }
        }
      }
    }
  }
  const priceCheck = checkModelPrices(models, { now, table: prices });
  for (const model of priceCheck.missing) errors.push(`model "${model}" has no price entry`);
  for (const model of priceCheck.stale) (stalePrices === 'warn' ? warnings : errors).push(`model "${model}" price is older than the allowed age; re-read the pricing page`);
  for (const model of priceCheck.unverified) warnings.push(`model "${model}" price is unverified; budgets price it at the ceiling`);
  return { ok: errors.length === 0, errors, warnings, models: [...new Set(models)] };
}

function pickEscalation(view, tierView, task, family, ctx) {
  const requested = ctx.escalation || 0;
  const list =
    tierView.escalate?.[task] || view.escalate?.[task] || (family && (tierView.escalateKinds?.[family] || view.escalateKinds?.[family])) || [];
  const ceiling = ctx.maxEscalation ?? Infinity;
  const applied = Math.min(requested, ceiling, list.length);
  return { requested, applied, available: list.length, ceiling: Number.isFinite(ceiling) ? ceiling : null, exhausted: requested > applied, route: applied > 0 ? list[applied - 1] : null };
}

function pickProfile(ctx, env, warnings) {
  if (ctx.profile) return ctx.profile;
  if (env.AI_PROFILE) {
    const profile = normalizeProfile(env.AI_PROFILE);
    if (profile) return profile;
    warnings.push(`AI_PROFILE="${env.AI_PROFILE}" is unknown; using ${DEFAULT_PROFILE}`);
  }
  if (String(env.AI_TEST_MODE || '') === '1') return 'test';
  return DEFAULT_PROFILE;
}

function fillEffort(entry, spec, specific) {
  // Other vendors have no effort setting of their own; an effort there only comes from the route string.
  if (entry.provider !== 'claude') return { ...entry, effort: entry.effort || null };
  if (specific && entry.effort) return entry;
  return { ...entry, effort: spec.effort || entry.effort || CLAUDE_RULES.defaultEffort };
}

function dedupe(chain) {
  const out = [];
  for (const entry of chain) if (!out.some((e) => sameEntry(e, entry))) out.push(entry);
  return out;
}

/**
 * Resolves the provider chain for one call.
 * @param {string} task registry key
 * @param {object} ctx  see CTX_FIELDS
 * @param {{tasks:object, routes:object, policy:object, env?:object, legacyRoute?:Function, payload?:any}} options
 */
export function resolveRoute(task, ctx = {}, options = {}) {
  const { tasks, routes, policy = {}, env = {}, legacyRoute = null, payload } = options;
  const spec = getTask(tasks, task);
  const { ctx: c, ignored, warnings: ctxWarnings } = normalizeCtx(ctx);
  const warnings = [...ctxWarnings];
  const profile = pickProfile(c, env, warnings);
  const view = profileView(routes, profile);
  const tier = c.tier || '';
  const tierView = (tier && view.tiers?.[tier]) || {};
  const family = c.kind || spec.family || '';
  const vision = spec.vision && c.vision !== false;
  const escalation = pickEscalation(view, tierView, task, family, c);

  const candidates = [
    ['override', c.route],
    ['env-task', env[taskEnvKey(task)]],
    ['env-default', vision ? env.AI_ROUTE_VISION_DEFAULT : env.AI_ROUTE_DEFAULT],
    ['escalate', escalation.route],
    ['tier-task', tierView.tasks?.[task]],
    ['task', view.tasks?.[task]],
    ['tier-kind', family ? tierView.kinds?.[family] : null],
    ['kind', family ? view.kinds?.[family] : null],
    ['profile-vision', vision ? tierView.vision || view.vision : null],
    ['profile-default', tierView.default || view.default],
  ];
  const [source, routeString] = candidates.find(([, value]) => typeof value === 'string' && value.trim()) || [];
  if (!routeString) throw new RouteConfigError(`No route for task "${task}" in profile "${profile}".`, { task, profile });
  if (source !== 'escalate' && escalation.requested > 0 && ['override', 'env-task', 'env-default'].includes(source)) {
    warnings.push(`escalation ${escalation.requested} ignored: route forced by ${source}`);
  }

  let chain = parseRoute(routeString);
  let legacy = false;
  if (chain[0].provider === 'legacy') {
    if (typeof legacyRoute !== 'function') throw new RouteConfigError(`Task "${task}" uses ${LEGACY_PLACEHOLDER} but no legacyRoute resolver was given.`, { task });
    const resolved = legacyRoute(task, c, spec);
    chain = parseRoute(resolved);
    if (chain[0].provider === 'legacy') throw new RouteConfigError(`legacyRoute("${task}") returned the placeholder itself.`, { task });
    legacy = true;
  }

  const needs = vision ? 'vision' : spec.kind === 'tools' ? 'tools' : null;
  if (needs) {
    const capable = chain.filter((entry) => PROVIDER_CAPABILITIES[entry.provider]?.[needs]);
    if (capable.length < chain.length) {
      warnings.push(`dropped ${chain.length - capable.length} route entr${chain.length - capable.length === 1 ? 'y' : 'ies'} without ${needs} support`);
    }
    chain = capable;
    if (!chain.length && needs === 'vision') {
      const visionRoute = tierView.vision || view.vision;
      if (visionRoute) {
        chain = parseRoute(visionRoute).filter((entry) => PROVIDER_CAPABILITIES[entry.provider]?.vision);
        warnings.push('vision task: using the profile vision route');
      }
    }
    if (!chain.length) throw new RouteConfigError(`Task "${task}" needs ${needs} but no route entry supports it in profile "${profile}".`, { task, profile });
  }

  const dataClass = effectiveDataClass({ task: spec, ctx: c, payload });
  const original = dedupe(chain);
  // Policy blocks carry the task, profile and route so the caller can write a policy_blocked ledger row.
  const blockedContext = { task, profile, route: formatRoute(original), primary: { provider: original[0].provider, model: original[0].model }, reasons: [...dataClass.reasons] };
  let policyResult;
  try {
    policyResult = applyPolicy(original, dataClass.effective, policy, { synthetic: dataClass.synthetic, redacted: dataClass.redacted, task, family: family || null });
  } catch (error) {
    if (error?.code === 'policy_blocked') Object.assign(error, blockedContext);
    throw error;
  }
  // A policy redirect route must still be able to do the job (vision, tool loop).
  let allowedChain = needs ? policyResult.chain.filter((entry) => PROVIDER_CAPABILITIES[entry.provider]?.[needs]) : policyResult.chain;
  if (!allowedChain.length) {
    throw new PolicyBlockedError(`Task "${task}" needs ${needs}, but no provider allowed for ${dataClass.effective} data supports it.`, { ...blockedContext, dataClass: dataClass.effective });
  }
  if (policyResult.redirected) {
    // A full redirect keeps the work's depth: task effort, else the replaced entry's, else the redirect's, else medium.
    const replaced = original.find((entry) => entry.effort)?.effort || null;
    allowedChain = allowedChain.map((entry) => ({ ...entry, effort: spec.effort || replaced || entry.effort || null }));
    warnings.push(`data policy replaced the whole route (${dataClass.effective} data): ${policyResult.redirects[0]?.reason || ''}`);
  } else if (policyResult.redirects.length) {
    warnings.push(`data policy dropped ${policyResult.redirects.map((r) => r.from).join(', ')}`);
  }
  // A task-specific route keeps its explicit efforts when the policy only drops some entries (a filtered
  // DeepSeek or Gemini fallback); only a full redirect re-derives the effort (above).
  const specific = SPECIFIC_SOURCES.has(source);
  const finalChain = allowedChain.map((entry) => fillEffort(entry, spec, specific && !policyResult.redirected));
  const view0 = finalChain[0];
  return Object.freeze({
    task,
    kind: spec.kind,
    family: family || null,
    vision,
    profile,
    tier: tier || null,
    source,
    legacy,
    record: Boolean(view.record),
    replay: view0.provider === 'replay',
    escalation: Object.freeze({ requested: escalation.requested, applied: source === 'escalate' ? escalation.applied : 0, available: escalation.available, ceiling: escalation.ceiling, exhausted: escalation.exhausted }),
    dataClass: Object.freeze({ declared: dataClass.declared, call: dataClass.call, effective: dataClass.effective, synthetic: dataClass.synthetic, redacted: dataClass.redacted, reasons: Object.freeze([...dataClass.reasons]) }),
    primary: Object.freeze({ ...view0 }),
    fallbacks: Object.freeze(finalChain.slice(1).map((e) => Object.freeze({ ...e }))),
    chain: Object.freeze(finalChain.map((e) => Object.freeze({ ...e }))),
    route: formatRoute(finalChain),
    policyRedirects: Object.freeze(policyResult.redirects),
    maxTokens: spec.maxTokens,
    warnings: Object.freeze(warnings),
    ignoredCtx: Object.freeze(ignored),
    ctx: Object.freeze(c),
  });
}

/**
 * A router bound to one set of configs. Validates them once; throws RouteConfigError listing every problem.
 * A stale price is only a warning here (a running facade must not stop over it); tests and CI call
 * validateRoutesConfig, where it is an error.
 * `routeFor` is the same function as `resolveRoute` (both names are in the contract).
 */
export function createRouter({ tasks, routes, policy, env = {}, legacyRoute = null, prices = PRICES, now = new Date(), unknownTasks = 'error', stalePrices = 'warn' } = {}) {
  if (!tasks || typeof tasks !== 'object') throw new RouteConfigError('createRouter needs a parsed task registry (tasks).');
  const routeCheck = validateRoutesConfig(routes, { tasks, prices, now, unknownTasks, stalePrices });
  const policyCheck = validatePolicy(policy);
  const envCheck = validateEnvRoutes(env, { tasks, prices });
  const errors = [...routeCheck.errors, ...policyCheck.errors, ...envCheck.errors];
  if (errors.length) throw new RouteConfigError(`Invalid LLM config:\n- ${errors.join('\n- ')}`, { errors });
  const resolve = (task, ctx = {}, extra = {}) => resolveRoute(task, ctx, { tasks, routes, policy, env, legacyRoute, payload: extra.payload });
  return Object.freeze({
    resolveRoute: resolve,
    routeFor: resolve,
    tasks,
    routes,
    policy,
    warnings: Object.freeze([...routeCheck.warnings, ...policyCheck.warnings, ...envCheck.warnings]),
    models: [...new Set([...routeCheck.models, ...envCheck.models])],
  });
}

/**
 * Checks AI_ROUTE_* env overrides the same way as config routes: they must parse and name priced models.
 * An AI_ROUTE_<TASK> that matches no registered task is a warning (it would never be read).
 */
export function validateEnvRoutes(env = {}, { tasks = null, prices = PRICES } = {}) {
  const errors = [];
  const warnings = [];
  const models = [];
  const taskKeys = new Set(Object.keys(tasks || {}).map(taskEnvKey));
  for (const [key, value] of Object.entries(env || {})) {
    if (!key.startsWith('AI_ROUTE_') || typeof value !== 'string' || !value.trim()) continue;
    if (key !== 'AI_ROUTE_DEFAULT' && key !== 'AI_ROUTE_VISION_DEFAULT' && tasks && !taskKeys.has(key)) warnings.push(`${key} matches no registered task`);
    let chain;
    try {
      chain = parseRoute(value);
    } catch (error) {
      errors.push(`${key}: ${error.message}`);
      continue;
    }
    for (const entry of chain) {
      if (entry.provider === 'replay' || entry.provider === 'legacy') continue;
      models.push(entry.model);
      if (!priceEntry(entry.model, prices)) errors.push(`${key}: model "${entry.model}" has no price entry`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, models };
}

export function isEffort(value) {
  return EFFORTS.includes(value);
}
