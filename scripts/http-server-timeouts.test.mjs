import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PROXY_HEADERS_TIMEOUT_MS,
  PROXY_KEEP_ALIVE_MS,
  applyProxyKeepAlive,
} from '../lib/http-server-timeouts.js';

const here = dirname(fileURLToPath(import.meta.url));

test('proxy keep-alive is longer than Node default 5s and headersTimeout is higher', () => {
  assert.ok(PROXY_KEEP_ALIVE_MS >= 60 * 1000);
  assert.ok(PROXY_HEADERS_TIMEOUT_MS > PROXY_KEEP_ALIVE_MS);
  const server = {};
  applyProxyKeepAlive(server);
  assert.equal(server.keepAliveTimeout, PROXY_KEEP_ALIVE_MS);
  assert.equal(server.headersTimeout, PROXY_HEADERS_TIMEOUT_MS);
});

test('server.js applies proxy keep-alive on the listening HTTP server', () => {
  const src = readFileSync(join(here, '../server.js'), 'utf8');
  assert.equal(src.includes("import { applyProxyKeepAlive } from './lib/http-server-timeouts.js';"), true);
  assert.equal(src.includes('applyProxyKeepAlive(server)'), true);
  assert.equal(src.includes('app.listen(PORT'), true);
});
