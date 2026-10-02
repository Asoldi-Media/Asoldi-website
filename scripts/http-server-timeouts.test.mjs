import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PROXY_CONNECTIONS_CHECKING_INTERVAL_MS,
  PROXY_HEADERS_TIMEOUT_MS,
  PROXY_KEEP_ALIVE_MS,
  PROXY_REQUEST_TIMEOUT_MS,
  PROXY_SOCKET_TIMEOUT_MS,
  applyCloseProxyConnection,
  applyProxyKeepAlive,
  describeProxyTimeouts,
  proxyHttpServerOptions,
} from '../lib/http-server-timeouts.js';

const here = dirname(fileURLToPath(import.meta.url));

test('origin HTTP connections are not kept alive for Hostinger HTTP/2', () => {
  assert.equal(PROXY_KEEP_ALIVE_MS, 0);
  assert.equal(PROXY_HEADERS_TIMEOUT_MS, 0);
  assert.equal(PROXY_REQUEST_TIMEOUT_MS, 0);
  assert.equal(PROXY_SOCKET_TIMEOUT_MS, 0);
  assert.equal(PROXY_CONNECTIONS_CHECKING_INTERVAL_MS, 0);
  const options = proxyHttpServerOptions();
  assert.equal(options.keepAlive, false);
  assert.equal(options.keepAliveTimeout, 0);
  assert.equal(options.headersTimeout, 0);
  assert.equal(options.requestTimeout, 0);
  assert.equal(options.connectionsCheckingInterval, 0);
  const server = createServer(options);
  applyProxyKeepAlive(server);
  assert.equal(server.keepAliveTimeout, 0);
  assert.equal(server.headersTimeout, 0);
  assert.equal(server.requestTimeout, 0);
  assert.equal(server.timeout, 0);
  assert.match(describeProxyTimeouts(server), /requestTimeout=0/);
  const res = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
  let continued = false;
  applyCloseProxyConnection({}, res, () => {
    continued = true;
  });
  assert.equal(res.headers.Connection, 'close');
  assert.equal(res.headers['Alt-Svc'], 'clear');
  assert.equal(continued, true);
  server.close();
});

test('server.js creates the HTTP server with proxy timeout options before listen', () => {
  const src = readFileSync(join(here, '../server.js'), 'utf8');
  assert.equal(src.includes("from './lib/http-server-timeouts.js'"), true);
  assert.equal(src.includes('proxyHttpServerOptions'), true);
  assert.equal(src.includes('applyCloseProxyConnection'), true);
  assert.equal(src.includes('createServer(proxyHttpServerOptions(), app)'), true);
  assert.equal(src.includes('applyProxyKeepAlive(server)'), true);
  assert.equal(src.includes('server.listen(PORT'), true);
  assert.equal(src.includes('app.listen(PORT'), false);
  const html = readFileSync(join(here, '../app/index.html'), 'utf8');
  assert.match(html, /vite:preloadError/);
});
