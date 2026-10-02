/**
 * Hostinger (hcdn) terminates HTTP/2 and speaks HTTP/1.1 to this Node app.
 * Its upstream idle is 15 minutes. Node must stay open longer than that.
 * A 10 minute keep-alive was still shorter, so hcdn reused a socket Node had
 * already closed and Chrome showed ERR_HTTP2_PROTOCOL_ERROR until the next
 * 15 minute window. keepAliveTimeout of 0 skips Node's socket timer
 * (`if (keepAliveTimeout)`), which does not advertise a timeout the proxy
 * can line up with.
 *
 * headersTimeout must be longer than keepAliveTimeout. If it is shorter, the
 * idle-header sweeper 408s the socket while hcdn still considers it live.
 * requestTimeout stays 0: a non-zero value has to be >= headersTimeout, which
 * would 408 a live response by destroying the socket (blank JS, or the same
 * protocol error). Do not send Connection: close. HTTP/2 forbids that header,
 * and closing the origin before hcdn finishes a body yields HTTP 200 with
 * Content-Length 0.
 */
export const PROXY_UPSTREAM_IDLE_MS = 15 * 60 * 1000;
export const PROXY_KEEP_ALIVE_MS = 20 * 60 * 1000;
export const PROXY_HEADERS_TIMEOUT_MS = 21 * 60 * 1000;
export const PROXY_REQUEST_TIMEOUT_MS = 0;
export const PROXY_SOCKET_TIMEOUT_MS = 0;
export const PROXY_CONNECTIONS_CHECKING_INTERVAL_MS = 30_000;

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
