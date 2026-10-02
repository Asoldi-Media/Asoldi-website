/**
 * Hostinger terminates TLS/HTTP2 in front of this Node app and speaks HTTP/1.1
 * to Express. Node's default keepAliveTimeout is 5s. The proxy keeps the
 * connection ~60–120s, so Chrome reuses an HTTP/2 session whose backend socket
 * Node already closed → ERR_HTTP2_PROTOCOL_ERROR (intermittent, "on and off").
 */
export const PROXY_KEEP_ALIVE_MS = 120 * 1000;
export const PROXY_HEADERS_TIMEOUT_MS = 125 * 1000;

export function applyProxyKeepAlive(server) {
  if (!server) return server;
  server.keepAliveTimeout = PROXY_KEEP_ALIVE_MS;
  server.headersTimeout = PROXY_HEADERS_TIMEOUT_MS;
  return server;
}
