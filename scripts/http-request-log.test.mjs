import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  cookieNamesToDrop,
  expireCookieLine,
  parseCookiePairs,
} from '../lib/http-request-log.js';

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
});
