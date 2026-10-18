/**
 * Shared MyPhoner booker-call URL + proxy-target checks.
 * Streaming (local file / MyPhoner / CDN) stays in the server routes.
 */

function text(value = '') {
  return String(value ?? '').trim();
}

function normalizeAbsoluteHttpUrl(value = '') {
  const raw = text(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

const PROXY_RECORDING_PATH = /^\/api\/admin\/(?:sales|development)\/[^/]+\/recording$/i;

export function clientRecordingUrl(client = null) {
  if (!client || typeof client !== 'object') return '';
  return text(client.myphoner?.latestRecordingUrl) || text(client.previewDocument?.recordingUrl);
}

export function prepareRecordingStream({
  rawUrl = '',
  myphonerHost = '',
  appHost = '',
  requestHost = '',
} = {}) {
  const recordingUrl = normalizeAbsoluteHttpUrl(rawUrl);
  if (!recordingUrl) {
    return { ok: false, status: 404, message: 'No recording URL is synced for this client.' };
  }

  let target;
  try {
    target = new URL(recordingUrl);
  } catch {
    return { ok: false, status: 400, message: 'Recording URL is invalid.' };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, status: 400, message: 'Recording URL must use http(s).' };
  }

  const allowedHosts = new Set(
    [myphonerHost, appHost, requestHost]
      .map((entry) => text(entry).toLowerCase())
      .filter(Boolean),
  );
  const targetHost = String(target.host || '').toLowerCase();
  const isMyphonerHost = Boolean(text(myphonerHost) && targetHost === text(myphonerHost).toLowerCase());
  const isAppHost = allowedHosts.has(targetHost);
  // App host + Myphoner host are preferred. External CDN URLs are also allowed
  // because Myphoner often serves recordings from signed third-party storage.
  if (!isAppHost && !isMyphonerHost && !/^https?:$/i.test(target.protocol)) {
    return { ok: false, status: 403, message: 'Recording host is not allowed.' };
  }
  if (PROXY_RECORDING_PATH.test(target.pathname)) {
    return { ok: false, status: 400, message: 'Recording URL points to this proxy endpoint.' };
  }

  return {
    ok: true,
    recordingUrl,
    target,
    isMyphonerHost,
    isAppHost,
  };
}
