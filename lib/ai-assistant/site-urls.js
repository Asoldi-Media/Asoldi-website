const KNOWN_TLD =
  'com|net|org|io|no|se|dk|fi|de|nl|at|ch|fr|es|it|uk|co|us|ca|au|nz|ie|be|pl|cz|app|dev|ai|shop|store|site|online|studio|agency|design|media|digital|info|biz|eu|nu';

function compact(value = '') {
  return String(value || '').trim();
}

export function normalizePublicSiteUrl(value = '') {
  let text = compact(value).replace(/[),.;!?]+$/g, '');
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return '';
  }
}

export function extractSiteUrlsFromText(text = '') {
  const raw = String(text || '');
  const found = [];
  const seen = new Set();
  const add = (value) => {
    const url = normalizePublicSiteUrl(value);
    if (!url || seen.has(url)) return;
    seen.add(url);
    found.push(url);
  };
  for (const match of raw.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    add(match[0].replace(/^http:\/\//i, 'https://'));
  }
  const bare = new RegExp(
    `(?<![\\w.@/])(?:www\\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${KNOWN_TLD})(?:\\/[^\\s<>"']*)?`,
    'gi',
  );
  for (const match of raw.matchAll(bare)) {
    add(match[0]);
  }
  return found;
}

export function firstSiteUrlFromText(text = '') {
  return extractSiteUrlsFromText(text)[0] || '';
}

export function siteHostLabel(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

export function looksLikeTypedProductList(text = '') {
  const trimmed = compact(text);
  if (!trimmed) return false;
  const lines = String(text || '').split(/\n/).map((line) => compact(line)).filter(Boolean);
  const pricedLines = lines.filter((line) => /\d/.test(line) && /(?:kr|,-|\/mnd|nok)/i.test(line));
  if (pricedLines.length >= 2) return true;
  if (lines.length >= 4 && pricedLines.length >= 1) return true;
  return false;
}

export function shouldIngestSources({ files = [], urls = [], text = '' } = {}) {
  if (files.length) return true;
  if (urls.length) return false;
  const trimmed = compact(text);
  if (!trimmed) return false;
  if (/^(meny|menu|tiers|normal|vanlig|manuelt|manual)$/i.test(trimmed)) return false;
  return looksLikeTypedProductList(text);
}
