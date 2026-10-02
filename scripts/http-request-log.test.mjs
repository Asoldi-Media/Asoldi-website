import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  cookieNamesToDrop,
  expireCookieLine,
  expireCookieLines,
  parseCookiePairs,
} from '../lib/http-request-log.js';
import { cookieDomainsForHost } from '../lib/fat-cookies.js';

const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../server.js'), 'utf8');

test('fat tracking cookies are expired and small ones stay', () => {
  const header = [
    'sbjs_current=typ%3Dtypein%26extra%3D' + 'x'.repeat(400),
    'twk_uuid_abc=' + 'y'.repeat(500),
    '__stripe_mid=short',
    'ok=fine',
  ].join('; ');
  const names = cookieNamesToDrop(header);
  assert.ok(names.includes('sbjs_current'));
  assert.ok(names.includes('twk_uuid_abc'));
  assert.equal(names.includes('__stripe_mid'), false);
  assert.equal(names.includes('ok'), false);
  assert.equal(expireCookieLine('sbjs_current'), 'sbjs_current=; Max-Age=0; Path=/; Secure; SameSite=Lax');
  assert.equal(expireCookieLine('a b'), 'ab=; Max-Age=0; Path=/; Secure; SameSite=Lax');
  assert.equal(parseCookiePairs('').length, 0);
});

test('a cookie header over 6KB drops the largest pairs', () => {
  const header = `bulk=${'a'.repeat(7000)}; small=1`;
  const names = cookieNamesToDrop(header);
  assert.deepEqual(names, ['bulk']);
});

test('every response can expire oversized cookies and /api/health shows the sizes', () => {
  assert.match(server, /cookieNamesToDrop\(cookie\)/);
  assert.match(server, /httpRequestSummary\(\)/);
  assert.match(server, /app\.post\('\/api\/diag\/browser'/);
  assert.match(server, /expireCookieLines\(name, req\.hostname\)/);
});

test('expiring tracking cookies also sets Domain=asoldi.com so Tawk/Sourcebuster actually die', () => {
  const domains = cookieDomainsForHost('asoldi.com');
  assert.deepEqual(domains, ['', 'asoldi.com', '.asoldi.com']);
  const lines = expireCookieLines('twk_uuid_abc', 'asoldi.com');
  assert.ok(lines.some((line) => line.endsWith('; Domain=asoldi.com')));
  assert.ok(lines.some((line) => line.endsWith('; Domain=.asoldi.com')));
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app/index.html'), 'utf8');
  assert.match(html, /Domain=/);
  const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app/App.tsx'), 'utf8');
  assert.match(app, /expireFatCookies/);
  const sales = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app/pages/Admin/sections/SalesClientsSection.tsx'), 'utf8');
  assert.match(sales, /expireFatCookies/);
  assert.match(sales, /asoldi-sales-list-v1/);
  const manage = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app/pages/Admin/sections/ManageClientsSection.tsx'), 'utf8');
  assert.match(manage, /active=\{view === 'sales'\}/);
  const pkg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8');
  assert.match(pkg, /--max-http-header-size=65536/);
});
