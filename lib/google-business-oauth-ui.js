export const GOOGLE_BUSINESS_OAUTH_EVENT = 'asoldi-google-business';

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

export function googleBusinessOAuthPayload({
  connected = false,
  googleEmail = '',
  locationTitle = '',
  error = '',
} = {}) {
  return {
    type: GOOGLE_BUSINESS_OAUTH_EVENT,
    connected: Boolean(connected),
    googleEmail: sanitize(googleEmail),
    locationTitle: sanitize(locationTitle),
    error: sanitize(error),
  };
}

export function renderGoogleBusinessOAuthResultHtml({
  ok = false,
  googleEmail = '',
  locationTitle = '',
  error = '',
} = {}) {
  const payload = googleBusinessOAuthPayload({
    connected: ok,
    googleEmail,
    locationTitle,
    error: ok ? '' : (error || 'Google Business-tilkoblingen feilet.'),
  });
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const heading = payload.connected
    ? (payload.locationTitle
      ? `Google-bedriftsprofil koblet: ${escapeHtml(payload.locationTitle)}.`
      : (payload.googleEmail
        ? `Google-bedriftsprofil koblet som ${escapeHtml(payload.googleEmail)}.`
        : 'Google-bedriftsprofil koblet.'))
    : escapeHtml(payload.error);
  const detail = payload.connected
    ? 'Du kan lukke dette vinduet.'
    : 'Lukk vinduet og prøv å koble til på nytt.';
  return `<!doctype html>
<html lang="nb">
<head><meta charset="utf-8" /><title>Google Business Profile</title></head>
<body>
  <h3>${heading}</h3>
  <p>${detail}</p>
  <script>
    (function () {
      var payload = ${json};
      try { localStorage.setItem(${JSON.stringify(GOOGLE_BUSINESS_OAUTH_EVENT)}, JSON.stringify(payload)); } catch (e) {}
      try {
        var channel = new BroadcastChannel(${JSON.stringify(GOOGLE_BUSINESS_OAUTH_EVENT)});
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
