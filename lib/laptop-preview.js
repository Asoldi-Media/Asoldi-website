/** Public client-facing preview hosted on asoldi.com (Hostinger). */
export const PUBLIC_SALES_ORIGIN = 'https://asoldi.com';
export const LAN_MAKER_ORIGIN = 'http://192.168.68.92:3000';
export const LAN_ASOLDI_ORIGIN = 'http://192.168.68.92:3200';

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

export function isLoopbackHostname(hostname = '') {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(sanitizeText(hostname));
}

export function isPrivateLanHostname(hostname = '') {
  return /^(192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(sanitizeText(hostname));
}

export function isPublicInternetHostname(hostname = '') {
  return /(^|\.)asoldi\.com$/i.test(sanitizeText(hostname));
}

function originFromCandidate(value = '') {
  const raw = sanitizeText(value);
  if (!raw) return '';
  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw);
  const withProtocol = hasProtocol ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

export function buildSalesPreviewPath(clientId = '') {
  const id = sanitizeText(clientId);
  if (!id) return '';
  return `/sales-preview/${encodeURIComponent(id)}/`;
}

export function buildPublicSalesPreviewUrl(clientId = '') {
  const path = buildSalesPreviewPath(clientId);
  return path ? `${PUBLIC_SALES_ORIGIN}${path}` : '';
}

export function toPublicSalesPreviewUrl(value = '', clientId = '') {
  const raw = sanitizeText(value);
  if (/^https:\/\/asoldi\.com\/sales-preview\//i.test(raw)) return raw;
  const id = sanitizeText(clientId);
  if (id) return buildPublicSalesPreviewUrl(id);
  if (!raw) return '';
  if (raw.startsWith('/sales-preview/')) {
    return `${PUBLIC_SALES_ORIGIN}${raw.startsWith('/') ? raw : `/${raw}`}`;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (isLoopbackHostname(parsed.hostname) || isPrivateLanHostname(parsed.hostname)) return '';
    if (/\/sales-preview\//i.test(parsed.pathname)) {
      return `${PUBLIC_SALES_ORIGIN}${parsed.pathname}${parsed.search || ''}${parsed.hash || ''}`;
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

export function clientHasSalesPreviewSnapshot(client = {}) {
  return Boolean(
    sanitizeText(client?.websiteImport?.previewUrl) ||
      sanitizeText(client?.websiteImport?.importRoot) ||
      sanitizeText(client?.websiteImport?.importedAt)
  );
}

export function buildLaptopPreviewEntry(client = {}) {
  const id = sanitizeText(client?.id);
  if (!id || !clientHasSalesPreviewSnapshot(client)) return null;
  const publicPreviewUrl = buildPublicSalesPreviewUrl(id);
  return {
    id,
    businessName: sanitizeText(client?.businessName) || 'Unnamed business',
    status: sanitizeText(client?.status) || 'active',
    runId: sanitizeText(client?.makerRun?.runId),
    importedAt: sanitizeText(client?.websiteImport?.importedAt),
    publicPreviewPublishedAt: sanitizeText(client?.websiteImport?.publicPreviewPublishedAt),
    publicPreviewUrl,
    laptopUrl: publicPreviewUrl,
    livePreviewPath: buildSalesPreviewPath(id),
    makerPreviewUrl: publicPreviewUrl,
  };
}

function pickPrivateLanOrigin(candidates = [], fallback = '') {
  for (const candidate of candidates) {
    const origin = originFromCandidate(candidate);
    if (!origin) continue;
    let hostname = '';
    try {
      hostname = new URL(origin).hostname;
    } catch {
      continue;
    }
    if (isLoopbackHostname(hostname)) continue;
    if (isPublicInternetHostname(hostname)) continue;
    if (isPrivateLanHostname(hostname)) return origin;
  }
  return fallback;
}

export function pickLanMakerOrigin(candidates = []) {
  return pickPrivateLanOrigin(candidates, LAN_MAKER_ORIGIN);
}

export function pickLanAsoldiOrigin(candidates = []) {
  return pickPrivateLanOrigin(candidates, LAN_ASOLDI_ORIGIN);
}

export function isPrivateMakerUrl(value = '') {
  const raw = sanitizeText(value);
  if (!raw) return false;
  try {
    const hostname = new URL(originFromCandidate(raw) || raw).hostname;
    return isLoopbackHostname(hostname) || isPrivateLanHostname(hostname);
  } catch {
    return /localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[0-1])\./i.test(raw);
  }
}

export function lanAsoldiOriginFromMakerUrl(makerUrl = '', fallback = LAN_ASOLDI_ORIGIN) {
  try {
    const parsed = new URL(originFromCandidate(makerUrl) || makerUrl);
    if (isLoopbackHostname(parsed.hostname) || isPrivateLanHostname(parsed.hostname)) {
      return `http://${parsed.hostname}:3200`;
    }
  } catch {
    // Keep the office default when the Maker URL is missing or public.
  }
  return fallback;
}

export function buildMakerExportUrl({
  makerBaseUrl = '',
  runId = '',
  step = 'latest',
  siteFolder = 'site',
  clientId = '',
  persist = false,
} = {}) {
  const origin = originFromCandidate(makerBaseUrl);
  const id = sanitizeText(runId);
  if (!origin || !id) return '';
  const folder = sanitizeText(siteFolder) || 'site';
  const exportStep = sanitizeText(step) || 'latest';
  const baseUrl = sanitizeText(clientId)
    ? buildPublicSalesPreviewUrl(clientId)
    : `${PUBLIC_SALES_ORIGIN}/${encodeURIComponent(folder)}`;
  const url = new URL(`${origin}/api/runs/${encodeURIComponent(id)}/export`);
  url.searchParams.set('step', exportStep);
  url.searchParams.set('baseUrl', baseUrl);
  url.searchParams.set('siteFolder', folder);
  if (persist) url.searchParams.set('persist', '1');
  return url.toString();
}

export function buildPreviewBundleUploadUrl(clientId = '', origin = PUBLIC_SALES_ORIGIN) {
  const id = sanitizeText(clientId);
  if (!id) return '';
  const base = originFromCandidate(origin) || PUBLIC_SALES_ORIGIN;
  return `${base}/api/admin/sales/${encodeURIComponent(id)}/receive-preview-bundle`;
}

export function clientNeedsPublicPreviewSnapshot(client = {}) {
  if (String(client?.product || '').trim().toLowerCase() === 'ssu') return false;
  if (!sanitizeText(client?.id) || !sanitizeText(client?.makerRun?.runId)) return false;
  return !sanitizeText(client?.websiteImport?.importRoot);
}

export const PREVIEW_ROBOTS_TAG = 'noindex, nofollow, noarchive, nosnippet, noimageindex';

const PREVIEW_CRAWLER_RE = /googlebot|google-inspectiontool|adsbot-google|bingbot|slurp|duckduckbot|baiduspider|yandex(?:bot|images)|facebookexternalhit|twitterbot|linkedinbot|applebot|gptbot|chatgpt-user|ccbot|anthropic-ai|claudebot|bytespider|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|ia_archiver|amazonbot|meta-externalagent/i;

export function isPreviewCrawler(userAgent = '') {
  return PREVIEW_CRAWLER_RE.test(String(userAgent || ''));
}

export function isPreviewProtectedPath(pathname = '') {
  const p = String(pathname || '').split('?')[0];
  return (
    p.startsWith('/sales-preview') ||
    p.startsWith('/live-preview') ||
    p === '/previews' ||
    p.startsWith('/previews/') ||
    p.startsWith('/api/public/previews') ||
    p.startsWith('/api/public/sales-preview')
  );
}

export function applySalesPreviewSecurityHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('X-Robots-Tag', PREVIEW_ROBOTS_TAG);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cache-Control', 'no-store');
}

export function injectPreviewRobotsMeta(html = '') {
  let source = String(html ?? '');
  source = source.replace(/<meta\b[^>]*name=["'](?:robots|googlebot|referrer)["'][^>]*>/gi, '');
  const tags = '<meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex"><meta name="googlebot" content="noindex,nofollow,noarchive,nosnippet,noimageindex"><meta name="referrer" content="no-referrer">';
  if (/<head\b[^>]*>/i.test(source)) {
    return source.replace(/<head\b[^>]*>/i, (open) => `${open}${tags}`);
  }
  if (/<html\b[^>]*>/i.test(source)) {
    return source.replace(/<html\b[^>]*>/i, (open) => `${open}<head>${tags}</head>`);
  }
  return `${tags}${source}`;
}

export function injectPreviewBaseHref(html = '', clientId = '') {
  const href = buildSalesPreviewPath(clientId);
  const source = String(html ?? '');
  if (!href) return source;
  const tag = `<base href="${href}">`;
  if (/<base\b[^>]*>/i.test(source)) {
    return source.replace(/<base\b[^>]*>/i, tag);
  }
  if (/<head\b[^>]*>/i.test(source)) {
    return source.replace(/<head\b[^>]*>/i, (open) => `${open}${tag}`);
  }
  if (/<html\b[^>]*>/i.test(source)) {
    return source.replace(/<html\b[^>]*>/i, (open) => `${open}<head>${tag}</head>`);
  }
  return `${tag}${source}`;
}

function escapeHtmlAttr(value = '') {
  return sanitizeText(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

export function injectSalesPreviewContractWidget(html = '', clientId = '') {
  const id = sanitizeText(clientId);
  const source = String(html ?? '');
  if (!id) return source;
  if (/\bsales-preview-contract\.js\b/i.test(source)) return source;
  const tag = `<script src="/sales-preview-contract.js" data-sales-client-id="${escapeHtmlAttr(id)}" charset="utf-8" defer></script>`;
  if (/<\/body>/i.test(source)) return source.replace(/<\/body>/i, `${tag}</body>`);
  return `${source}${tag}`;
}

function decodePreviewRouteParam(raw = '') {
  let decoded = String(raw || '/').replace(/&amp;/g, '&');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the raw route if it is not URI-encoded.
  }
  decoded = decoded.trim() || '/';
  const hashIndex = decoded.indexOf('#');
  const hash = hashIndex >= 0 ? decoded.slice(hashIndex) : '';
  let route = (hashIndex >= 0 ? decoded.slice(0, hashIndex) : decoded).trim() || '/';
  if (!route.startsWith('/')) route = `/${route}`;
  return { route, hash };
}

function makerPreviewAssetRe() {
  return /(?:https?:\/\/[^"'()\s<>]+)?(?:\/sales-preview\/[^/]+)?(?:\.\.\/|\.\/)?\/?preview\/[^"'/?#\s<>]+\/(?:custom|step\/[^/"'?<>]+)\/asset\?id=([a-zA-Z0-9._-]+)(?:&amp;|&[a-zA-Z0-9._=-]*)*/gi;
}

function makerPreviewPageRe() {
  return /(?:https?:\/\/[^"'()\s<>]+)?(?:\/sales-preview\/[^/]+)?(?:\.\.\/|\.\/)?\/?preview\/[^"'/?#\s<>]+\/(?:custom(?:\/view)?|step\/[^/"'?<>]+)(?!\/asset)(?:\?route=([^"'\s<>]*))?/gi;
}

/**
 * Custom-site HTML often bakes in Website Maker preview URLs
 * (`/preview/<run>/custom/asset?id=webflow.js`). Those only work on the
 * operator PC. Rewrite them to files inside the static snapshot.
 */
export function rewriteMakerPreviewRefs(text = '', { rootAbsolute = false } = {}) {
  const assetHref = (id) => (rootAbsolute ? `/assets/${id}` : `assets/${id}`);
  const pageHref = (route, hash) => {
    if (route === '/') return `${rootAbsolute ? '/' : './'}${hash}`;
    return `${rootAbsolute ? route : `.${route}`}${hash}`;
  };
  let out = String(text || '');
  out = out.replace(makerPreviewAssetRe(), (_m, id) => assetHref(id));
  out = out.replace(makerPreviewPageRe(), (_m, routeRaw) => {
    const { route, hash } = decodePreviewRouteParam(routeRaw || '/');
    return pageHref(route, hash);
  });
  return out;
}

/**
 * Exported sites often reference assets with root-absolute paths (/css/x.css).
 * Those escape /sales-preview/<id>/ and hit the main asoldi.com site, so the
 * preview loses its styling. Rewrite them back into the preview folder.
 */
export function rewritePreviewAssetPaths(text = '', clientId = '') {
  const prefix = buildSalesPreviewPath(clientId);
  let out = String(text ?? '');
  if (!prefix) return out;
  out = rewriteMakerPreviewRefs(out, { rootAbsolute: true });
  out = out.replace(/localasset:\/\/([a-zA-Z0-9._-]+)/gi, (_m, id) => `assets/${id}`);
  const fix = (url = '') => {
    const raw = String(url || '');
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith(prefix)) return raw;
    if (raw.startsWith('/sales-preview/')) return raw;
    return `${prefix}${raw.replace(/^\/+/, '')}`;
  };
  out = out.replace(
    /\b(href|src|action|poster|data-src|data-href|data-background)=(["'])(\/[^"']*)\2/gi,
    (match, attr, quote, url) => `${attr}=${quote}${fix(url)}${quote}`
  );
  out = out.replace(/\b(srcset|data-srcset)=(["'])([^"']*)\2/gi, (match, attr, quote, value) => {
    const rewritten = String(value)
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        const [url, ...descriptors] = trimmed.split(/\s+/);
        return [fix(url), ...descriptors].join(' ');
      })
      .join(', ');
    return `${attr}=${quote}${rewritten}${quote}`;
  });
  out = out.replace(
    /url\(\s*(["']?)(\/[^)"']*)\1\s*\)/gi,
    (match, quote, url) => `url(${quote}${fix(url)}${quote})`
  );
  return out;
}

export function isAllowedPreviewBridgeExportUrl(value = '') {
  try {
    const parsed = new URL(sanitizeText(value));
    if (parsed.protocol !== 'http:') return false;
    if (!isLoopbackHostname(parsed.hostname) && !isPrivateLanHostname(parsed.hostname)) return false;
    return /^\/api\/runs\/[^/]+\/export\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isAllowedPreviewBundleUploadUrl(value = '') {
  try {
    const parsed = new URL(sanitizeText(value));
    if (!/^\/api\/admin\/sales\/[^/]+\/receive-preview-bundle\/?$/.test(parsed.pathname)) return false;
    if (parsed.protocol === 'https:' && isPublicInternetHostname(parsed.hostname)) return true;
    if (
      parsed.protocol === 'http:' &&
      (isPrivateLanHostname(parsed.hostname) || isLoopbackHostname(parsed.hostname))
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
