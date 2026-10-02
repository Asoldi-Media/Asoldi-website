import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PROXY_HEADERS_TIMEOUT_MS,
  PROXY_KEEP_ALIVE_MS,
  PROXY_REQUEST_TIMEOUT_MS,
  PROXY_SOCKET_TIMEOUT_MS,
  applyProxyKeepAlive,
  describeProxyTimeouts,
} from '../lib/http-server-timeouts.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIVE_MINUTES_MS = 5 * 60 * 1000;

test('proxy timeouts outlast Node 22 default 5-minute requestTimeout and the reverse proxy', () => {
  assert.equal(PROXY_REQUEST_TIMEOUT_MS, 0);
  assert.equal(PROXY_SOCKET_TIMEOUT_MS, 0);
  assert.ok(PROXY_KEEP_ALIVE_MS > FIVE_MINUTES_MS);
  assert.ok(PROXY_HEADERS_TIMEOUT_MS > PROXY_KEEP_ALIVE_MS);
  const server = createServer();
  applyProxyKeepAlive(server);
  assert.equal(server.keepAliveTimeout, PROXY_KEEP_ALIVE_MS);
  assert.equal(server.headersTimeout, PROXY_HEADERS_TIMEOUT_MS);
  assert.equal(server.requestTimeout, 0);
  assert.equal(server.timeout, 0);
  assert.match(describeProxyTimeouts(server), /requestTimeout=0/);
  server.close();
});

test('server.js applies proxy keep-alive on the listening HTTP server', () => {
  const src = readFileSync(join(here, '../server.js'), 'utf8');
  assert.equal(src.includes("from './lib/http-server-timeouts.js'"), true);
  assert.equal(src.includes('applyProxyKeepAlive(server)'), true);
  assert.equal(src.includes('describeProxyTimeouts(server)'), true);
  assert.equal(src.includes('app.listen(PORT'), true);
});
