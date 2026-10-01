/** Browser origin used by Custom edit / Open in maker. */

export const LOCAL_EDITOR_ORIGIN = 'http://127.0.0.1:3000';
const DEAD_OFFICE_MAKER_HOST = '192.168.68.92';

function withHttpProtocol(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw)) return raw;
  const looksLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw);
  return `${looksLocal ? 'http' : 'https'}://${raw}`;
}

/**
 * Origin the browser should open for editing.
 * The old office host 192.168.68.92 does not answer on this PC; Maker is on 127.0.0.1:3000.
 * A public tunnel URL is left as-is. An empty or invalid value stays empty so a half-typed field is not snapped.
 */
export function editorMakerOrigin(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return LOCAL_EDITOR_ORIGIN;
  const portHealed = raw.replace(
    /^(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)):(?:4000|3001|5173)(?=$)/i,
    '$1:3000'
  );
  try {
    const parsed = new URL(withHttpProtocol(portHealed));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.hostname === DEAD_OFFICE_MAKER_HOST) return LOCAL_EDITOR_ORIGIN;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

export function makerOriginsMatch(left = '', right = '') {
  const a = loopbackOriginKey(left);
  const b = loopbackOriginKey(right);
  return Boolean(a && b && a === b);
}

function loopbackOriginKey(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    let host = parsed.hostname.toLowerCase();
    if (host === 'localhost') host = '127.0.0.1';
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return `${parsed.protocol}//${host}:${port}`;
  } catch {
    return '';
  }
}

export function makerUnreachableIsLocal(message = '') {
  return /Start the Maker tunnel|Start Docker Maker on port 3000|Website Maker is unreachable at https?:\/\/(?:127\.0\.0\.1|localhost|192\.168\.68\.92)(?::\d+)?/i.test(
    String(message || '')
  );
}
