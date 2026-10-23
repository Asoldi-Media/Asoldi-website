// Task registry schema. Every LLM call names a task; the task decides call kind, vision, data class,
// output cap, default effort and routing family. One registry shape serves every repo.
//
// { version: 1, tasks: { 'step2.copy-judge': { kind:'json', vision:false, dataClass:'business', maxTokens:4000,
//     effort?:'low', family?:'copy', repo?:['maker'], owner?:'WS4', legacy?:true, note?:'' } } }

import { DATA_CLASSES, EFFORTS, TASK_KINDS } from './constants.js';
import { RouteConfigError } from './errors.js';

export const TASK_KEY_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const FAMILY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_FIELDS = new Set(['kind', 'vision', 'dataClass', 'maxTokens', 'effort', 'family', 'repo', 'owner', 'legacy', 'note']);

export function isTaskKey(value) {
  return typeof value === 'string' && value.length <= 80 && TASK_KEY_PATTERN.test(value);
}

/** `step2.copy-judge` -> `AI_ROUTE_STEP2_COPY_JUDGE`. */
export function taskEnvKey(task) {
  return `AI_ROUTE_${String(task || '').toUpperCase().replace(/[.-]/g, '_')}`;
}

/**
 * Validates a registry. Returns every problem instead of stopping at the first, so a broken
 * config file reports all its mistakes at once.
 * @returns {{ok:boolean, errors:string[], tasks:Record<string, object>}}
 */
export function validateTaskRegistry(registry) {
  const errors = [];
  if (!registry || typeof registry !== 'object') return { ok: false, errors: ['registry must be an object'], tasks: {} };
  if (registry.version !== 1) errors.push(`registry.version must be 1 (got ${JSON.stringify(registry.version)})`);
  const tasks = registry.tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    errors.push('registry.tasks must be an object keyed by task');
    return { ok: false, errors, tasks: {} };
  }
  const out = {};
  for (const [key, spec] of Object.entries(tasks)) {
    const at = `tasks["${key}"]`;
    if (!isTaskKey(key)) errors.push(`${at}: key must match ${TASK_KEY_PATTERN}`);
    if (!spec || typeof spec !== 'object') {
      errors.push(`${at}: must be an object`);
      continue;
    }
    for (const field of Object.keys(spec)) if (!TASK_FIELDS.has(field)) errors.push(`${at}: unknown field "${field}"`);
    if (!TASK_KINDS.includes(spec.kind)) errors.push(`${at}.kind must be one of ${TASK_KINDS.join('|')}`);
    if (typeof spec.vision !== 'boolean') errors.push(`${at}.vision must be a boolean`);
    if (!DATA_CLASSES.includes(spec.dataClass)) errors.push(`${at}.dataClass must be one of ${DATA_CLASSES.join('|')}`);
    if (!Number.isInteger(spec.maxTokens) || spec.maxTokens < 1 || spec.maxTokens > 128000) errors.push(`${at}.maxTokens must be an integer 1..128000`);
    if (spec.effort !== undefined && !EFFORTS.includes(spec.effort)) errors.push(`${at}.effort must be one of ${EFFORTS.join('|')}`);
    if (spec.family !== undefined && !(typeof spec.family === 'string' && FAMILY_PATTERN.test(spec.family))) errors.push(`${at}.family must be a kebab-case word`);
    if (spec.repo !== undefined && !(Array.isArray(spec.repo) && spec.repo.every((r) => typeof r === 'string' && r))) errors.push(`${at}.repo must be a list of repo names`);
    if (spec.legacy !== undefined && typeof spec.legacy !== 'boolean') errors.push(`${at}.legacy must be a boolean`);
    out[key] = Object.freeze({ ...spec });
  }
  return { ok: errors.length === 0, errors, tasks: Object.freeze(out) };
}

/** Like validateTaskRegistry, but throws RouteConfigError listing every problem. */
export function parseTaskRegistry(registry) {
  const result = validateTaskRegistry(registry);
  if (!result.ok) throw new RouteConfigError(`Invalid task registry:\n- ${result.errors.join('\n- ')}`, { errors: result.errors });
  return result.tasks;
}

/** The tasks one repo uses (entries without `repo` belong to every repo). */
export function tasksForRepo(tasks = {}, repo = '') {
  const out = {};
  for (const [key, spec] of Object.entries(tasks)) {
    if (!spec.repo || !repo || spec.repo.includes(repo)) out[key] = spec;
  }
  return out;
}

export function getTask(tasks, key) {
  const spec = tasks && Object.prototype.hasOwnProperty.call(tasks, key) ? tasks[key] : null;
  if (!spec) throw new RouteConfigError(`Unknown LLM task "${key}". Register it in the task registry first.`, { task: key });
  return spec;
}
