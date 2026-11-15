// Route modules a build may or may not contain. Each present module exports
// register(app, deps). OPTIONAL_ROUTE_MODULES is the registration order and is
// identical in every branch; change the list only on the integration branch.
//
// The modules are imported statically, and registerOptionalRoutes is synchronous:
// the host loads server.js with require(), which refuses a module graph with a
// top-level await, so nothing here may make server.js wait. A build imports the
// modules it contains below and names them in PRESENT_ROUTE_MODULES
// (scripts/server-require-load.test.mjs fails when a listed file exists and is
// not imported here).
//
// register(app, deps) must add all its routes before it returns. Start-up work
// that has to wait (loading a store, a registry) goes into the promise it
// returns; server.js answers no request until every such promise has settled.
import * as signingRoutes from './signing-routes.js';
import * as deliveryJobsRoutes from './delivery-jobs-routes.js';
import * as privacyRoutes from './privacy-routes.js';
import * as briefRoutes from './brief-routes.js';
import * as gateRoutes from './gate-routes.js';
import * as seoRecordRoutes from './seo-record-routes.js';
import * as legalRoutes from './legal-routes.js';
import * as emailHubRoutes from './email-hub-routes.js';
import * as emailSiteRoutes from './email-site-routes.js';
import * as promotionRoutes from './promotion-routes.js';
import * as planLifecycleRoutes from './plan-lifecycle-routes.js';
import * as clientBookingRoutes from './client-booking-routes.js';
import * as cmsFleetRoutes from './cms-fleet-routes.js';
import * as emailOwnerRoutes from './email-owner-routes.js';
import * as siteRekeyRoutes from './site-rekey-routes.js';
import * as changeRequestRoutes from './change-request-routes.js';
import * as cursorPromptRoutes from './cursor-prompt-routes.js';

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
  './plan-lifecycle-routes.js',
  './client-booking-routes.js',
  './cms-fleet-routes.js',
  './email-owner-routes.js',
  './site-rekey-routes.js',
  './change-request-routes.js',
  './cursor-prompt-routes.js',
  './dev-report-routes.js',
  './legal-clause-routes.js',
]);

/** The listed modules this build contains. */
export const PRESENT_ROUTE_MODULES = Object.freeze({
  './signing-routes.js': signingRoutes,
  './delivery-jobs-routes.js': deliveryJobsRoutes,
  './privacy-routes.js': privacyRoutes,
  './brief-routes.js': briefRoutes,
  './gate-routes.js': gateRoutes,
  './seo-record-routes.js': seoRecordRoutes,
  './legal-routes.js': legalRoutes,
  './email-hub-routes.js': emailHubRoutes,
  './email-site-routes.js': emailSiteRoutes,
  './promotion-routes.js': promotionRoutes,
  './plan-lifecycle-routes.js': planLifecycleRoutes,
  './client-booking-routes.js': clientBookingRoutes,
  './cms-fleet-routes.js': cmsFleetRoutes,
  './email-owner-routes.js': emailOwnerRoutes,
  './site-rekey-routes.js': siteRekeyRoutes,
  './change-request-routes.js': changeRequestRoutes,
  './cursor-prompt-routes.js': cursorPromptRoutes,
});

/**
 * Registers every present module's routes, in list order, before it returns.
 * Returns { registered, ready }: the module names, and a promise that settles
 * when the start-up work the modules returned has finished (it rejects with the
 * first failure). No route is added after this function returns.
 */
export function registerOptionalRoutes(app, deps, { modules = OPTIONAL_ROUTE_MODULES, present = PRESENT_ROUTE_MODULES } = {}) {
  const registered = [];
  const pending = [];
  for (const relative of modules) {
    if (!Object.prototype.hasOwnProperty.call(present, relative)) continue;
    const mod = present[relative];
    if (typeof mod?.register !== 'function') throw new Error(`${relative} must export register(app, deps)`);
    const started = mod.register(app, deps);
    if (typeof started?.then === 'function') pending.push(started);
    registered.push(relative);
  }
  return { registered, ready: Promise.all(pending).then(() => registered) };
}
