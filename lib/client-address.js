/**
 * The client address for the hub's address-keyed limits on public routes: visitor forms
 * (lib/client-forms.js), analytics collect and commerce (lib/client-analytics-http.js), heartbeats
 * (server.js), site credential enrollment (lib/site-credentials.js) and the CMS sign-in redeem
 * (lib/cms-sso.js).
 *
 * It uses the same rule and the same trusted-hop count as the sign-in limits
 * (lib/auth-hardening.js readClientAddress; security-settings.json loginTrustedHops, set with
 * PUT /api/admin/security/login-address). So when a CDN sits in front of the hosting proxy, one
 * setting makes sign-ins and these limits count each visitor by the same X-Forwarded-For entry,
 * instead of counting every visitor behind the CDN as one address.
 *
 * server.js calls useClientAddressSettingsFrom(getPersistentDataDir()) once at boot, next to the
 * sign-in limiter. Until then, and in tests that never call it, the count is the default (1, the
 * right-most public entry). The setting is read through the mtime cache of data/atomic-json.js
 * (lib/login-limits.js readLoginTrustedHops): at most one stat a second and a parse only when the
 * file changes, so a request costs no file read, and a change made by any hub process applies
 * here within a second.
 *
 * This module takes the data dir as an argument, so importing it never fixes the data dir of a
 * test process.
 */
import { clientIpFromRequest } from './auth-hardening.js';
import { readLoginTrustedHops } from './login-limits.js';

let settingsDataDir = '';

/** Reads the trusted-hop count from <dataDir>/security-settings.json from now on ('' = the default, 1). */
export function useClientAddressSettingsFrom(dataDir) {
  settingsDataDir = String(dataDir || '');
}

/** The trusted-hop count the public limits use now: 1 to 5, or null for the default (1). */
export function publicTrustedHops() {
  return readLoginTrustedHops(settingsDataDir);
}

/** The client address of a request, for an address-keyed limit on a public route. */
export function publicClientAddress(req) {
  return clientIpFromRequest(req, { trustedHops: publicTrustedHops() });
}
