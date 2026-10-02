/**
 * Hostinger terminates TLS/HTTP2 in front of this Node app and speaks HTTP/1.1
 * to Express. Do not send Connection: close — HTTP/2 forbids that header, and
 * closing the origin socket before hcdn finishes reading a JS/CSS body yields
 * HTTP 200 with Content-Length 0 (blank asoldi.com).
 *
 * Timeouts stay 0 so Node does not 408 an idle proxy socket. keepAlive stays
 * on so static assets can actually transfer.
 */
export const PROXY_KEEP_ALIVE_MS = 0;
export const PROXY_HEADERS_TIMEOUT_MS = 0;
export const PROXY_REQUEST_TIMEOUT_MS = 0;
export const PROXY_SOCKET_TIMEOUT_MS = 0;
export const PROXY_CONNECTIONS_CHECKING_INTERVAL_MS = 0;

export function proxyHttpServerOptions() {
  return {
    keepAlive: true,
    keepAliveTimeout: PROXY_KEEP_ALIVE_MS,
    headersTimeout: PROXY_HEADERS_TIMEOUT_MS,
    requestTimeout: PROXY_REQUEST_TIMEOUT_MS,
    connectionsCheckingInterval: PROXY_CONNECTIONS_CHECKING_INTERVAL_MS,
    noDelay: true,
  };
}

export function applyProxyKeepAlive(server) {
  if (!server) return server;
  const options = proxyHttpServerOptions();
  server.keepAliveTimeout = options.keepAliveTimeout;
  server.headersTimeout = options.headersTimeout;
  server.requestTimeout = options.requestTimeout;
  server.timeout = PROXY_SOCKET_TIMEOUT_MS;
  if ('connectionsCheckingInterval' in server) {
    server.connectionsCheckingInterval = options.connectionsCheckingInterval;
  }
  return server;
}

export function describeProxyTimeouts(server) {
  if (!server) return '';
  const checking = server.connectionsCheckingInterval;
  return (
    `[http] keepAliveTimeout=${server.keepAliveTimeout} ` +
    `headersTimeout=${server.headersTimeout} ` +
    `requestTimeout=${server.requestTimeout} ` +
    `timeout=${server.timeout} ` +
    `connectionsCheckingInterval=${checking == null ? 'n/a' : checking}`
  );
}
