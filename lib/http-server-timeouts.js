/**
 * Hostinger terminates TLS/HTTP2 in front of this Node app and speaks HTTP/1.1
 * to Express. Chrome's ERR_HTTP2_PROTOCOL_ERROR is Node sending 408 / closing a
 * socket the HTTP/2 proxy still has open.
 *
 * A finite keep-alive (even 10 minutes) still dies for a tab left open. Node 18+
 * also starts a connections checker from createServer()/listen() using the
 * timeouts present at that moment — setting them after app.listen() is too late
 * if the checker captured the 5-minute requestTimeout / 60s headersTimeout.
 * 0 disables each timeout. Hostinger's proxy still enforces its own limit.
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
