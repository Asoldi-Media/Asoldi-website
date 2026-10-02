/**
 * Hostinger terminates TLS/HTTP2 in front of this Node app and speaks HTTP/1.1
 * to Express. Chrome's ERR_HTTP2_PROTOCOL_ERROR after a few minutes is Node
 * closing a socket the proxy still thinks is open.
 *
 * Hostinger runs Node 22. Since Node 18 the default requestTimeout is 300000
 * (5 minutes). When that fires, Node sends 408 and destroys the socket while
 * Chrome's HTTP/2 session is still up. keepAliveTimeout must also stay longer
 * than the proxy (~60–300s). 0 disables a timeout.
 */
export const PROXY_KEEP_ALIVE_MS = 10 * 60 * 1000;
export const PROXY_HEADERS_TIMEOUT_MS = PROXY_KEEP_ALIVE_MS + 5 * 1000;
export const PROXY_REQUEST_TIMEOUT_MS = 0;
export const PROXY_SOCKET_TIMEOUT_MS = 0;

export function applyProxyKeepAlive(server) {
  if (!server) return server;
  server.keepAliveTimeout = PROXY_KEEP_ALIVE_MS;
  server.headersTimeout = PROXY_HEADERS_TIMEOUT_MS;
  server.requestTimeout = PROXY_REQUEST_TIMEOUT_MS;
  server.timeout = PROXY_SOCKET_TIMEOUT_MS;
  return server;
}

export function describeProxyTimeouts(server) {
  if (!server) return '';
  return (
    `[http] keepAliveTimeout=${server.keepAliveTimeout}ms ` +
    `headersTimeout=${server.headersTimeout}ms ` +
    `requestTimeout=${server.requestTimeout} ` +
    `timeout=${server.timeout}`
  );
}
