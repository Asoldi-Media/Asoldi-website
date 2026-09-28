export const GOOGLE_CALENDAR_OAUTH_EVENT = 'asoldi-google-calendar';

function sanitize(value = '') {
  return String(value ?? '').trim();
}

function escapeHtml(value = '') {
  return sanitize(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function googleCalendarOAuthPayload({
  connected = false,
  googleEmail = '',
  googleName = '',
  tokenUpdatedAt = '',
  error = '',
} = {}) {
  return {
    type: GOOGLE_CALENDAR_OAUTH_EVENT,
    connected: Boolean(connected),
    googleEmail: sanitize(googleEmail),
    googleName: sanitize(googleName),
    tokenUpdatedAt: sanitize(tokenUpdatedAt),
    error: sanitize(error),
  };
}

export function renderGoogleCalendarOAuthResultHtml({
  ok = false,
  googleEmail = '',
  googleName = '',
  tokenUpdatedAt = '',
  error = '',
} = {}) {
  const payload = googleCalendarOAuthPayload({
    connected: ok,
    googleEmail,
    googleName,
    tokenUpdatedAt,
    error: ok ? '' : (error || 'Google Calendar connection failed.'),
  });
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const heading = payload.connected
    ? (payload.googleEmail
      ? `Google Calendar connected as ${escapeHtml(payload.googleEmail)}.`
      : 'Google Calendar connected.')
    : escapeHtml(payload.error || 'Google Calendar connection failed.');
  const detail = payload.connected
    ? 'You can close this window.'
    : 'Close this window and try Connect Google Calendar again.';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Google Calendar</title></head>
<body>
  <h3>${heading}</h3>
  <p>${detail}</p>
  <script>
    (function () {
      var payload = ${json};
      try { localStorage.setItem(${JSON.stringify(GOOGLE_CALENDAR_OAUTH_EVENT)}, JSON.stringify(payload)); } catch (e) {}
      try {
        var channel = new BroadcastChannel(${JSON.stringify(GOOGLE_CALENDAR_OAUTH_EVENT)});
        channel.postMessage(payload);
        channel.close();
      } catch (e) {}
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, window.location.origin);
        }
      } catch (e) {}
      window.close();
    })();
  </script>
</body>
</html>`;
}
