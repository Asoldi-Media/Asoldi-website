/**
 * Google API calls go out through gaxios. Without a timeout the socket stays
 * open until the OS gives up, which on Linux is about 15 minutes. Hostinger's
 * HTTP/2 proxy is stuck on that same inbound request for those 15 minutes, so
 * Chrome reports ERR_HTTP2_PROTOCOL_ERROR for the whole site, then it recovers
 * when the dead socket finally drops.
 *
 * `transporter.defaults.timeout` is merged into every request on that OAuth
 * client, including token refresh, and gaxios turns it into AbortSignal.timeout
 * so the socket is actually closed.
 */
export const GOOGLE_REQUEST_DEADLINE_MS = 8000;

export function applyGoogleRequestDeadline(oauthClient, timeoutMs = GOOGLE_REQUEST_DEADLINE_MS) {
  const parsed = Number(timeoutMs);
  const timeout = Number.isFinite(parsed) && parsed > 0 ? parsed : GOOGLE_REQUEST_DEADLINE_MS;
  const transporter = oauthClient?.transporter;
  if (transporter) {
    if (!transporter.defaults || typeof transporter.defaults !== 'object') {
      transporter.defaults = {};
    }
    transporter.defaults.timeout = timeout;
  }
  return oauthClient;
}
