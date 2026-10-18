import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerShopPaymentsRoutes, registerShopPaymentsWebhook } from '../lib/shop-payments-routes.js';
import { registerCmsSsoRoutes } from '../lib/cms-sso.js';

const TESTS = ['shop-payments.test.mjs', 'shop-documents.test.mjs', 'cms-sso.test.mjs'];

test('every hub shop, payments-platform and CMS SSO route is called by a test', () => {
  const routes = [];
  const app = Object.fromEntries(['get', 'post', 'put', 'delete', 'patch'].map((m) => [m, (p) => routes.push(`${m.toUpperCase()} ${p}`)]));
  const noop = (_req, _res, next) => next();
  registerShopPaymentsWebhook(app);
  registerShopPaymentsRoutes(app, { adminAuth: noop });
  registerCmsSsoRoutes(app, { adminAuth: noop, getSiteById: () => null });
  assert.ok(routes.length >= 19, `expected the full hub shop surface, found ${routes.length}`);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sources = TESTS.map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const missing = routes.filter((r) => {
    const pattern = r.split(' ')[1].split(/(:[A-Za-z_]+)/).map((part) => (part.startsWith(':') ? '[^/\'"`\\s?]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
    return !new RegExp(`${pattern}(?=[^A-Za-z0-9_\\-/.]|$)`, 'm').test(sources);
  });
  assert.deepEqual(missing, [], `routes without a test: ${missing.join(', ')}`);
});
