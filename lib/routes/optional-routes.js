// Route modules a build may or may not contain. Each present module exports
// register(app, deps). This file is identical in every branch that adds it;
// change the list only on the integration branch.
import { existsSync } from 'node:fs';

export const OPTIONAL_ROUTE_MODULES = Object.freeze([
  './signing-routes.js',
  './delivery-jobs-routes.js',
  './privacy-routes.js',
  './brief-routes.js',
  './gate-routes.js',
  './seo-record-routes.js',
  './legal-routes.js',
  './email-hub-routes.js',
  './email-site-routes.js',
  './promotion-routes.js',
]);

export async function registerOptionalRoutes(app, deps, { modules = OPTIONAL_ROUTE_MODULES } = {}) {
  const registered = [];
  for (const relative of modules) {
    const url = new URL(relative, import.meta.url);
    if (!existsSync(url)) continue;
    const mod = await import(url.href);
    if (typeof mod.register !== 'function') throw new Error(`${relative} must export register(app, deps)`);
    await mod.register(app, deps);
    registered.push(relative);
  }
  return registered;
}
