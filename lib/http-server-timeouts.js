/**
 * Hostinger terminates TLS/HTTP2 (and advertises HTTP/3) in front of this Node
 * app and speaks HTTP/1.1 to Express.
 *
 * Chrome's ERR_HTTP2_PROTOCOL_ERROR on Admin/Sales navigation is that proxy
 * reusing a keep-alive origin socket after a stream reset. Raising Node
 * timeouts (even to 0) still leaves keep-alive on; the tab then fails, a new
 * h2 session works, then it fails again.
 *
 * Disable keep-alive and send Connection: close so each request gets a fresh
 * origin socket. Hostinger's proxy still terminates HTTP/2 to Chrome.
 * Alt-Svc: clear asks Chrome not to switch this origin to HTTP/3.
 */
export const PROXY_KEEP_ALIVE_MS = 0;
export const PROXY_HEADERS_TIMEOUT_MS = 0;
export const PROXY_REQUEST_TIMEOUT_MS = 0;
export const PROXY_SOCKET_TIMEOUT_MS = 0;
export const PROXY_CONNECTIONS_CHECKING_INTERVAL_MS = 0;

export function proxyHttpServerOptions() {
  return {
    keepAlive: false,
    keepAliveTimeout: PROXY_KEEP_ALIVE_MS,
    headersTimeout: PROXY_HEADERS_TIMEOUT_MS,
    requestTimeout: PROXY_REQUEST_TIMEOUT_MS,
    connectionsCheckingInterval: PROXY_CONNECTIONS_CHECKING_INTERVAL_MS,
    noDelay: true,
  };
}

export function applyCloseProxyConnection(_req, res, next) {
  res.setHeader('Connection', 'close');
  res.setHeader('Alt-Svc', 'clear');
  next();
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
  if ('keepAlive' in server) {
    server.keepAlive = options.keepAlive;
  }
  return server;
}

export function describeProxyTimeouts(server) {
  if (!server) return '';
  const checking = server.connectionsCheckingInterval;
  return (
    `[http] keepAlive=${server.keepAlive === false ? 'false' : 'true'} ` +
    `keepAliveTimeout=${server.keepAliveTimeout} ` +
    `headersTimeout=${server.headersTimeout} ` +
    `requestTimeout=${server.requestTimeout} ` +
    `timeout=${server.timeout} ` +
    `connectionsCheckingInterval=${checking == null ? 'n/a' : checking}`
  );
}
