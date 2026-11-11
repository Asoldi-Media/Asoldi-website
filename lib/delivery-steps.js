// Tick step registry for the delivery loop (lib/delivery-loop.js).
//
// A step module exports
//   tickSteps = [{ name, order, scope: 'client' | 'global', everyMs?, whenPaused?, run }]
// where run(ctx, client?) resolves to { wrote, ... }. ctx = { now, settings, safeMode, log, sales,
// hub, mode, dataDir, clients, audit, shadow }. A 'client' step runs once per client in scope with
// ctx.mode = spineModeForClient('delivery.loop', client); a 'global' step runs once per tick.
// In shadow a step writes only delivery-audit records (ctx.shadow(key, record) dedupes them).
//
// The modules below are imported when they exist, so a build without one simply has no such
// step. This list is the same in every branch; change it only on the integration branch.
import { existsSync } from 'node:fs';

export const TICK_STEP_MODULES = Object.freeze([
  './delivery-gate.js',
  './delivery-brief/index.js',
  './delivery-retention.js',
  './delivery-jobs.js',
  './delivery-emails.js',
  './delivery-alerts.js',
  './seo-ops/record.js',
  './delivery-lifecycle.js',
]);

const SCOPES = new Set(['client', 'global']);
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Throws when a step does not follow the contract. Returns the normalized step. */
export function assertTickStep(step, source = '') {
  const where = source ? ` (${source})` : '';
  if (!step || typeof step !== 'object') throw new Error(`tick step must be an object${where}`);
  if (!NAME_RE.test(String(step.name || ''))) throw new Error(`tick step name must match ${NAME_RE}${where}`);
  if (!SCOPES.has(step.scope)) throw new Error(`tick step ${step.name}: scope must be client or global${where}`);
  if (typeof step.run !== 'function') throw new Error(`tick step ${step.name}: run must be a function${where}`);
  const everyMs = step.everyMs === undefined ? 0 : Number(step.everyMs);
  if (!Number.isFinite(everyMs) || everyMs < 0) throw new Error(`tick step ${step.name}: everyMs must be a positive number${where}`);
  const order = step.order === undefined ? 50 : Number(step.order);
  return Object.freeze({
    name: String(step.name),
    order: Number.isFinite(order) ? order : 50,
    scope: step.scope,
    everyMs,
    whenPaused: step.whenPaused === true,
    run: step.run,
    source,
  });
}

/** Steps sorted by order, then name. Two steps with one name: the first registered wins. */
export function sortTickSteps(steps) {
  const seen = new Set();
  const out = [];
  for (const step of steps) {
    if (seen.has(step.name)) continue;
    seen.add(step.name);
    out.push(step);
  }
  return out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/**
 * Imports the step modules that exist and returns their steps (sorted). A module that fails to
 * import or exports a bad step is reported in `errors` and skipped; the others still load.
 */
export async function loadTickSteps({ modules = TICK_STEP_MODULES, base = import.meta.url } = {}) {
  const steps = [];
  const loaded = [];
  const errors = [];
  for (const relative of modules) {
    const url = new URL(relative, base);
    if (!existsSync(url)) continue;
    try {
      const mod = await import(url.href);
      const list = Array.isArray(mod.tickSteps) ? mod.tickSteps : [];
      for (const step of list) steps.push(assertTickStep(step, relative));
      loaded.push(relative);
    } catch (error) {
      errors.push({ module: relative, error: String(error?.message || error).slice(0, 300) });
    }
  }
  return { steps: sortTickSteps(steps), loaded, errors };
}
