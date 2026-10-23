// LLM core: pure routing, policy, prices, request shaping, budgets and ledger rows shared by every facade.
// No SDK, no network, no file system, no reads of the process environment. See CONTRACT.md for the frozen contract.

export * from './constants.js';
export * from './errors.js';
export * from './tasks-schema.js';
export { parseRoute, parseRouteEntry, formatRoute, formatRouteEntry, LEGACY_PLACEHOLDER } from './route-string.js';
export { CTX_FIELDS, normalizeCtx, profileView, validateRoutesConfig, validateEnvRoutes, resolveRoute, createRouter, isEffort } from './route.js';
export * from './policy.js';
export * from './prices.js';
export * from './json.js';
export * from './images.js';
export * from './claude-shape.js';
export * from './ledger-row.js';
export * from './cassette.js';
export * from './budget.js';
export { createLlmCore } from './call.js';
export { LLM_CONTRACT, CORE_EXPORTS, FACADE_METHODS, ROUTE_RESULT_FIELDS, ROUTE_SOURCES, contractFingerprint, runContractChecks } from './contract.js';

import { resolveRoute } from './route.js';

/** Same function as resolveRoute (the facade name). */
export const routeFor = resolveRoute;
