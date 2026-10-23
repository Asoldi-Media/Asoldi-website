/**
 * Hub LLM config: the shared registry, routes, policy and budgets (packages/suite/harness/asoldi/llm.js)
 * plus the hub's data-dir overrides. No env change is ever needed to switch the hub:
 *
 *   <dataDir>/ai-routes.override.json   { version: 1, profile?: 'legacy'|'prod'|..., profiles?: { <name>: {...} },
 *                                         updatedAt, updatedBy }   written by PUT /api/admin/ai/routes
 *   <dataDir>/ai-budgets.override.json  { version: 1, ...partial budgets }   (periodic caps, scopes, loop)
 *
 * Profile: env AI_PROFILE when set (local runs and tests), else the override's `profile`, else
 * AI_TEST_MODE=1 -> test, else `legacy`. AI_ROUTE_* env routes are honoured as in the Maker.
 *
 * `legacy` is the default and ships dark: every migrated call site runs today's provider request
 * unchanged (LEGACY_TASKS), and the facade only records it in the ledger.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../../packages/suite/core/llm/index.js';
import { ASOLDI_LLM_BUDGETS, asoldiLlmConfig } from '../../packages/suite/harness/asoldi/llm.js';

export const ROUTES_OVERRIDE_FILE = 'ai-routes.override.json';
export const BUDGETS_OVERRIDE_FILE = 'ai-budgets.override.json';
const OVERRIDE_LEVEL_MAPS = ['tasks', 'kinds', 'escalate', 'escalateKinds'];
const OVERRIDE_LEVEL_ROUTES = ['default', 'vision'];

function clean(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Today's provider per migrated hub call site. `keyEnv` is the key the call site checks today, `model`
 * resolves today's model from env. The legacy profile runs these calls unchanged.
 */
const deepseekLegacy = { provider: 'deepseek', keyEnv: 'DEEPSEEK_API_KEY', model: (env) => clean(env.DEEPSEEK_MODEL) || 'deepseek-chat' };
const geminiLegacy = (modelEnv) => ({ provider: 'gemini', keyEnv: 'GEMINI_API_KEY', model: (env) => clean(env[modelEnv]) || 'gemini-2.5-flash' });
export const LEGACY_TASKS = Object.freeze({
  'offer.fill-from-transcript': deepseekLegacy,
  'offer.reflect-contract': deepseekLegacy,
  'offer.summarize-intent': deepseekLegacy,
  'workshop.summary': deepseekLegacy,
  'workshop.project-document': deepseekLegacy,
  'workshop.transcript-eval': deepseekLegacy,
  'booker.preview-document': deepseekLegacy,
  'assistant.chat': deepseekLegacy,
  'assistant.gather': deepseekLegacy,
  'assistant.products-ingest': deepseekLegacy,
  'inbox.categorize': deepseekLegacy,
  'inbox.decide': deepseekLegacy,
  'assistant.products-image': geminiLegacy('GEMINI_MODEL'),
  'inbox.inspect-contract': geminiLegacy('GEMINI_MODEL'),
  'sales-link.discover': geminiLegacy('SALES_LINK_GEMINI_MODEL'),
  'assistant.media-brief': { provider: 'gemini', keyEnv: 'GEMINI_API_KEY', model: (env) => clean(env.CLIENT_MEDIA_VISION_MODEL) || 'gemini-2.5-flash' },
  'infokort.agent': {
    provider: 'claude',
    keyEnv: 'ANTHROPIC_API_KEY',
    model: (env) => clean(env.ANTHROPIC_MODEL) || 'claude-haiku-5-5',
    effort: (env) => clean(env.ANTHROPIC_EFFORT) || 'medium',
  },
});

/** Today's route for a task as an object { provider, model, effort } (null when the task has none). */
export function legacyEntryFor(task, env = process.env) {
  const spec = LEGACY_TASKS[task];
  if (!spec) return null;
  return { provider: spec.provider, model: spec.model(env), effort: spec.effort ? spec.effort(env) : null, keyEnv: spec.keyEnv };
}

/**
 * The core's `${legacy}` resolver: today's provider when the core can route it, else Claude Haiku 5.5
 * (tasks added after the facade, such as the WS8 brief tasks, have no older provider).
 */
export function legacyRouteFor(env = process.env) {
  return (task) => {
    const entry = legacyEntryFor(task, env);
    if (!entry) return 'claude:claude-haiku-5-5';
    const route = [entry.provider, entry.model, entry.effort].filter(Boolean).join(':');
    try {
      core.parseRoute(route);
      return route;
    } catch {
      return entry.provider === 'claude' ? 'claude:claude-haiku-5-5' : `${entry.provider}:${entry.provider === 'gemini' ? 'gemini-2.5-flash' : 'deepseek-chat'}`;
    }
  };
}

function readJsonFile(path) {
  if (!existsSync(path)) return { exists: false, value: null, error: '' };
  try {
    return { exists: true, value: JSON.parse(readFileSync(path, 'utf8')), error: '' };
  } catch (error) {
    return { exists: true, value: null, error: `unreadable JSON: ${clean(error?.message).slice(0, 200)}` };
  }
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Validates the shape of a routes override (before merging). Returns a list of problems. */
export function routesOverrideProblems(override) {
  const errors = [];
  if (!isPlainObject(override)) return ['the override must be a JSON object'];
  if (override.version !== undefined && override.version !== 1) errors.push('version must be 1');
  if (override.profile !== undefined && override.profile !== null && override.profile !== '' && !core.normalizeProfile(override.profile)) {
    errors.push(`profile "${clean(override.profile).slice(0, 40)}" is not one of ${core.PROFILES.join(', ')}`);
  }
  if (override.profiles !== undefined && !isPlainObject(override.profiles)) errors.push('profiles must be an object');
  for (const [name, level] of Object.entries(isPlainObject(override.profiles) ? override.profiles : {})) {
    if (!core.PROFILES.includes(name)) errors.push(`profiles.${name}: unknown profile`);
    if (!isPlainObject(level)) {
      errors.push(`profiles.${name} must be an object`);
      continue;
    }
    for (const key of Object.keys(level)) {
      if (![...OVERRIDE_LEVEL_ROUTES, ...OVERRIDE_LEVEL_MAPS, 'tiers', 'note'].includes(key)) errors.push(`profiles.${name}.${key}: not an override field`);
    }
  }
  return errors;
}

function mergeLevel(base = {}, over = {}) {
  const out = { ...base };
  for (const key of OVERRIDE_LEVEL_ROUTES) if (typeof over[key] === 'string' && over[key].trim()) out[key] = over[key].trim();
  for (const key of OVERRIDE_LEVEL_MAPS) if (isPlainObject(over[key])) out[key] = { ...(base[key] || {}), ...over[key] };
  return out;
}

/** Base routes with the override's profiles merged in (maps merged key by key; tiers per tier). */
export function mergeRoutes(baseRoutes, override) {
  const profiles = { ...(baseRoutes.profiles || {}) };
  for (const [name, level] of Object.entries(isPlainObject(override?.profiles) ? override.profiles : {})) {
    const base = profiles[name] || {};
    const merged = mergeLevel(base, level);
    if (isPlainObject(level.tiers)) {
      merged.tiers = { ...(base.tiers || {}) };
      for (const [tier, tierLevel] of Object.entries(level.tiers)) merged.tiers[tier] = mergeLevel(base.tiers?.[tier] || {}, tierLevel || {});
    }
    profiles[name] = merged;
  }
  return { ...baseRoutes, profiles };
}

function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  return out;
}

/**
 * The hub's config for createLlmCore, with overrides applied and validated. An invalid override is
 * ignored (and reported in `warnings` / `overrides.*.error`), never fatal: the hub keeps its base config.
 */
export function loadHubLlmConfig({ dataDir, env = process.env, now = new Date() } = {}) {
  const base = asoldiLlmConfig('hub');
  const warnings = [];
  const routesPath = dataDir ? join(dataDir, ROUTES_OVERRIDE_FILE) : '';
  const budgetsPath = dataDir ? join(dataDir, BUDGETS_OVERRIDE_FILE) : '';
  const overrides = {
    routes: { path: routesPath, exists: false, applied: false, error: '', profile: '', updatedAt: '', updatedBy: '', mtimeMs: routesPath ? mtimeOf(routesPath) : 0 },
    budgets: { path: budgetsPath, exists: false, applied: false, error: '', mtimeMs: budgetsPath ? mtimeOf(budgetsPath) : 0 },
  };

  let routes = base.routes;
  let overrideProfile = '';
  if (routesPath) {
    const file = readJsonFile(routesPath);
    overrides.routes.exists = file.exists;
    if (file.error) overrides.routes.error = file.error;
    else if (file.value) {
      const problems = routesOverrideProblems(file.value);
      const merged = problems.length ? null : mergeRoutes(base.routes, file.value);
      const check = merged ? core.validateRoutesConfig(merged, { tasks: base.tasks, now, unknownTasks: 'warn', stalePrices: 'warn' }) : null;
      if (problems.length || !check?.ok) {
        overrides.routes.error = [...problems, ...(check?.errors || [])].join('; ').slice(0, 1000);
      } else {
        routes = merged;
        overrides.routes.applied = true;
        overrideProfile = core.normalizeProfile(file.value.profile || '') || '';
        overrides.routes.profile = overrideProfile;
        overrides.routes.updatedAt = clean(file.value.updatedAt);
        overrides.routes.updatedBy = clean(file.value.updatedBy);
      }
    }
    if (overrides.routes.error) warnings.push(`${ROUTES_OVERRIDE_FILE} ignored: ${overrides.routes.error}`);
  }

  let budgets = base.budgets || ASOLDI_LLM_BUDGETS;
  if (budgetsPath) {
    const file = readJsonFile(budgetsPath);
    overrides.budgets.exists = file.exists;
    if (file.error) overrides.budgets.error = file.error;
    else if (file.value) {
      const merged = isPlainObject(file.value) ? deepMerge(budgets, { ...file.value, version: 1 }) : null;
      const check = merged ? core.validateBudgetsConfig(merged) : { ok: false, errors: ['the override must be a JSON object'] };
      if (!check.ok) overrides.budgets.error = check.errors.join('; ').slice(0, 1000);
      else {
        budgets = merged;
        overrides.budgets.applied = true;
      }
    }
    if (overrides.budgets.error) warnings.push(`${BUDGETS_OVERRIDE_FILE} ignored: ${overrides.budgets.error}`);
  }

  // Profile: env (local runs, tests) > data override > AI_TEST_MODE > legacy.
  const envProfile = core.normalizeProfile(env.AI_PROFILE || '');
  if (clean(env.AI_PROFILE) && !envProfile) warnings.push(`AI_PROFILE="${clean(env.AI_PROFILE).slice(0, 40)}" is unknown; ignored`);
  let profile = core.DEFAULT_PROFILE;
  let profileSource = 'default';
  if (envProfile) {
    profile = envProfile;
    profileSource = 'env';
  } else if (overrideProfile) {
    profile = overrideProfile;
    profileSource = 'override';
  } else if (clean(env.AI_TEST_MODE) === '1') {
    profile = 'test';
    profileSource = 'env-test-mode';
  }

  // Only the AI routing keys of the environment reach the core.
  const coreEnv = { AI_PROFILE: profile };
  for (const [key, value] of Object.entries(env || {})) {
    if (/^AI_ROUTE_[A-Z0-9_]+$/.test(key) && typeof value === 'string' && value.trim()) coreEnv[key] = value.trim();
  }

  return {
    ...base,
    routes,
    budgets,
    env: coreEnv,
    profile,
    profileSource,
    overrides,
    warnings,
  };
}

/** True when either override file changed on disk since `config` was loaded. */
export function overridesChanged(config) {
  const routes = config?.overrides?.routes;
  const budgets = config?.overrides?.budgets;
  return Boolean(
    (routes?.path && mtimeOf(routes.path) !== routes.mtimeMs) || (budgets?.path && mtimeOf(budgets.path) !== budgets.mtimeMs),
  );
}
