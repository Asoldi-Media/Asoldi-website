import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { get } from 'node:http';
import {
  PROXY_CONNECTIONS_CHECKING_INTERVAL_MS,
  PROXY_HEADERS_TIMEOUT_MS,
  PROXY_KEEP_ALIVE_MS,
  PROXY_MAX_HEADER_BYTES,
  PROXY_REQUEST_TIMEOUT_MS,
  PROXY_SOCKET_TIMEOUT_MS,
  PROXY_UPSTREAM_IDLE_MS,
  applyProxyKeepAlive,
  describeProxyTimeouts,
  proxyHttpServerOptions,
} from '../lib/http-server-timeouts.js';

const here = dirname(fileURLToPath(import.meta.url));

test('proxy keep-alive outlasts Hostinger 15 minute idle without closing the body', () => {
  assert.equal(PROXY_UPSTREAM_IDLE_MS, 15 * 60 * 1000);
  assert.ok(PROXY_KEEP_ALIVE_MS > PROXY_UPSTREAM_IDLE_MS);
  assert.ok(PROXY_HEADERS_TIMEOUT_MS > PROXY_KEEP_ALIVE_MS);
  assert.equal(PROXY_REQUEST_TIMEOUT_MS, 0);
  assert.equal(PROXY_SOCKET_TIMEOUT_MS, 0);
  assert.ok(PROXY_CONNECTIONS_CHECKING_INTERVAL_MS > 0);
  const options = proxyHttpServerOptions();
  assert.equal(options.keepAlive, true);
  assert.equal(options.keepAliveTimeout, PROXY_KEEP_ALIVE_MS);
  assert.equal(options.headersTimeout, PROXY_HEADERS_TIMEOUT_MS);
  assert.equal(options.requestTimeout, 0);
  assert.equal(options.connectionsCheckingInterval, PROXY_CONNECTIONS_CHECKING_INTERVAL_MS);
  assert.equal(options.maxHeaderSize, PROXY_MAX_HEADER_BYTES);
  assert.ok(PROXY_MAX_HEADER_BYTES > 16_384);
  const server = createServer(options);
  applyProxyKeepAlive(server);
  assert.equal(server.keepAliveTimeout, PROXY_KEEP_ALIVE_MS);
  assert.equal(server.headersTimeout, PROXY_HEADERS_TIMEOUT_MS);
  assert.equal(server.requestTimeout, 0);
  assert.equal(server.timeout, 0);
  assert.match(describeProxyTimeouts(server), /requestTimeout=0/);
  server.close();
});

test('a finished response is not cut off', async () => {
  const server = createServer(proxyHttpServerOptions(), (_req, res) => {
    res.end('ok');
  });
  applyProxyKeepAlive(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const body = await new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
  assert.equal(body, 'ok');
  await new Promise((resolve) => server.close(resolve));
});

test('server.js creates the HTTP server with proxy timeout options before listen', () => {
  const src = readFileSync(join(here, '../server.js'), 'utf8');
  assert.equal(src.includes("from './lib/http-server-timeouts.js'"), true);
  assert.equal(src.includes('proxyHttpServerOptions'), true);
  assert.equal(src.includes('applyCloseProxyConnection'), false);
  assert.equal(src.includes('createServer(proxyHttpServerOptions(), app)'), true);
  assert.equal(src.includes("app.set('etag', false)"), true);
  assert.equal(src.includes('sendFile(indexPath, { etag: false, lastModified: false })'), true);
  assert.equal(src.includes('applyProxyKeepAlive(server)'), true);
  assert.equal(src.includes('server.listen(PORT'), true);
  assert.equal(src.includes('app.listen(PORT'), false);
  const html = readFileSync(join(here, '../app/index.html'), 'utf8');
  assert.equal(html.includes('vite:preloadError'), false);
});
