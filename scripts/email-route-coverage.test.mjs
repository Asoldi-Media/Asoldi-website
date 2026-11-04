// Every route of the client CMS → hub email API (lib/routes/email-site-routes.js) is called by a
// test, and every /api/hub/email/ route it adds takes the emailKey or is a listed webhook route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.APP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'asoldi-email-route-coverage-'));
const { EMAIL_SITE_ROUTES, EMAIL_WEBHOOK_ROUTES, registerEmailSiteRoutes } = await import('../lib/routes/email-site-routes.js');

const TESTS = ['email-routes.test.mjs'];
const hub = { getSiteById: () => null, getSiteByKey: () => null, getAllSites: () => [] };

function collect() {
  const routes = [];
  const app = Object.fromEntries(['get', 'post', 'put', 'delete', 'patch'].map((m) => [m, (p, ...handlers) => routes.push({ route: `${m.toUpperCase()} ${p}`, handlers })]));
  const handle = registerEmailSiteRoutes(app, { adminAuth: (_q, _r, n) => n(), hub }, { startJobs: false });
  handle.stop();
  return routes;
}

test('every email site route, the webhook route and the wake route are called by a test', () => {
  const routes = collect().map((r) => r.route);
  assert.ok(routes.length >= EMAIL_SITE_ROUTES.length + 2, `found ${routes.length}`);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sources = TESTS.map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const missing = routes.filter((r) => {
    const pattern = r.split(' ')[1].split(/(:[A-Za-z_]+)/).map((part) => (part.startsWith(':') ? '[^/\'"`\\s?]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
    return !new RegExp(`${pattern}(?=[^A-Za-z0-9_\\-/.]|$)`, 'm').test(sources);
  });
  assert.deepEqual(missing, [], `routes without a test: ${missing.join(', ')}`);
});

test('the listed site routes are exactly the /api/hub/email/ routes behind the emailKey', () => {
  const routes = collect().filter((r) => r.route.split(' ')[1].startsWith('/api/hub/email/'));
  const guarded = routes.filter((r) => r.handlers.some((h) => h?.requiresEmailKey === true)).map((r) => r.route).sort();
  assert.deepEqual(guarded, [...EMAIL_SITE_ROUTES].sort());
  const other = routes.filter((r) => !guarded.includes(r.route)).map((r) => r.route).sort();
  assert.deepEqual(other, [...EMAIL_WEBHOOK_ROUTES].sort(), 'only the webhook route takes another credential');
});
