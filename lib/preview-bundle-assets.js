import fs from 'fs/promises';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

export function looksLikeAssetFileName(value = '') {
  return /^[a-zA-Z0-9._-]+\.[a-zA-Z0-9]{2,8}$/.test(sanitizeText(value));
}

export function collectRelativeAssetRefs(text = '') {
  const refs = new Set();
  const push = (value = '') => {
    const raw = sanitizeText(value);
    if (!raw) return;
    if (/^localasset:\/\//i.test(raw)) {
      const id = raw.slice('localasset://'.length).split(/[?#]/)[0];
      if (looksLikeAssetFileName(id)) refs.add(`assets/${id}`);
      return;
    }
    const cleaned = raw.replace(/^\.\//, '').replace(/^\/+/, '').split(/[?#]/)[0];
    if (/^assets\//i.test(cleaned) && looksLikeAssetFileName(path.posix.basename(cleaned))) {
      refs.add(cleaned);
    }
  };
  const source = String(text || '');
  for (const match of source.matchAll(/(?:href|src|poster|data-src)=["']([^"']+)["']/gi)) push(match[1]);
  for (const match of source.matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/gi)) push(match[1]);
  for (const match of source.matchAll(/(?:srcset|data-srcset)=["']([^"']+)["']/gi)) {
    for (const part of String(match[1]).split(',')) push(part.trim().split(/\s+/)[0]);
  }
  for (const match of source.matchAll(/\/(?:custom|step\/[^/"'?]+)\/asset\?id=([a-zA-Z0-9._-]+)/gi)) {
    if (looksLikeAssetFileName(match[1])) refs.add(`assets/${match[1]}`);
  }
  return refs;
}

export function rewriteCssForStaticPreview(css = '') {
  return String(css || '')
    .replace(/localasset:\/\/([a-zA-Z0-9._-]+)/gi, '$1')
    .replace(
      /\/preview\/[^"'()\s]+\/(?:custom|step\/[^/'"]+)\/asset\?id=([a-zA-Z0-9._-]+)/gi,
      '$1'
    );
}

export function makerAssetFetchUrls({ makerBase, runId, exportStep = 'latest', assetPath = '' } = {}) {
  const base = sanitizeText(makerBase).replace(/\/+$/, '');
  const id = path.posix.basename(String(assetPath || '').replace(/^\/+/, ''));
  if (!base || !runId || !looksLikeAssetFileName(id)) return [];
  const stepRaw = sanitizeText(exportStep) || 'latest';
  const numeric = stepRaw.replace(/^step-/i, '');
  const urls = [
    `${base}/preview/${encodeURIComponent(runId)}/custom/asset?id=${encodeURIComponent(id)}`,
  ];
  const steps = [];
  if (numeric && numeric !== 'latest' && numeric !== 'custom') steps.push(numeric);
  for (const step of ['3', '2', '1.5', '1']) {
    if (!steps.includes(step)) steps.push(step);
  }
  for (const step of steps) {
    urls.push(
      `${base}/preview/${encodeURIComponent(runId)}/step/${encodeURIComponent(step)}/asset?id=${encodeURIComponent(id)}`
    );
  }
  return [...new Set(urls)];
}

export function findPreviewFileByBasenameSync(roots = [], fileName = '', { maxFiles = 800 } = {}) {
  const wanted = path.basename(sanitizeText(fileName).split(/[?#]/)[0]);
  if (!wanted || wanted === '.' || wanted === '..') return '';
  const queue = [...roots].filter(Boolean).map((root) => path.resolve(root));
  const seen = new Set();
  let visited = 0;
  while (queue.length && visited < maxFiles) {
    const dir = queue.shift();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      visited += 1;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(abs);
        continue;
      }
      if (entry.isFile() && entry.name === wanted) return abs;
    }
  }
  return '';
}

export function inlineLocalStylesheets(html = '', roots = []) {
  return String(html || '').replace(/<link\b([^>]*?)>/gi, (full, attrs) => {
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(attrs)) return full;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href || /^(https?:)?\/\//i.test(href) || href.startsWith('data:')) return full;
    const fileName = path.posix.basename(String(href).split(/[?#]/)[0]);
    if (!looksLikeAssetFileName(fileName) || !/\.css$/i.test(fileName)) return full;
    const cssPath =
      findPreviewFileByBasenameSync(roots, fileName) ||
      [...roots]
        .map((root) => path.join(root, 'assets', fileName))
        .find((candidate) => existsSync(candidate));
    if (!cssPath || !existsSync(cssPath)) return full;
    let css = rewriteCssForStaticPreview(readFileSync(cssPath, 'utf8'));
    css = css.replace(/url\(\s*(['"]?)(?!\/|https?:|data:|assets\/)([^'")]+)\1\s*\)/gi, (_m, quote, raw) => {
      const name = path.posix.basename(String(raw).split(/[?#]/)[0]);
      return `url(${quote || ''}assets/${name}${quote || ''})`;
    });
    return `<style data-preview-css="${fileName}">${css}</style>`;
  });
}

export async function persistInlinedStylesheets(siteRoot, roots = []) {
  const search = [siteRoot, ...(Array.isArray(roots) ? roots : [])].filter(Boolean);
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile() || !/\.html?$/i.test(entry.name)) continue;
      const html = await fs.readFile(abs, 'utf8');
      const inlined = inlineLocalStylesheets(html, search);
      if (inlined !== html) await fs.writeFile(abs, inlined, 'utf8');
    }
  }
  await walk(siteRoot);
}

const SKIP_RECOVER_HOSTS =
  /(^|\.)(asoldi\.com|googleapis\.com|gstatic\.com|google\.com|facebook\.com|twitter\.com|instagram\.com|cloudflare\.com|google-analytics\.com|googletagmanager\.com|w3\.org|schema\.org|css-tricks\.com|github\.com|githubusercontent\.com|wikipedia\.org|developer\.mozilla\.org|stackoverflow\.com|cssfontstack\.com|meowni\.ca)$/i;
const SKIP_RECOVER_PATH =
  /\/(2000\/svg|1999\/xhtml|1999\/xlink|XML\/1998\/namespace)(\b|$)/i;

function stripEmbeddedCssAndJs(html = '') {
  return String(html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
}

export function stripRecoveredStylesheets(html = '') {
  return String(html || '').replace(
    /<style\b[^>]*data-preview-css=["']recovered["'][^>]*>[\s\S]*?<\/style>/gi,
    ''
  );
}
const RECOVER_FETCH_HEADERS = {
  Accept: 'text/css,text/html,*/*;q=0.8',
  'User-Agent': 'Mozilla/5.0 (compatible; AsoldiPreviewRepair/1.0)',
};

function hasLocalStylesheetLinks(html = '') {
  return [...String(html || '').matchAll(/<link\b([^>]*?)>/gi)].some((match) => {
    const attrs = match[1] || '';
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(attrs)) return false;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!href || /^(https?:)?\/\//i.test(href) || href.startsWith('data:')) return false;
    return /\.css(\?|#|$)/i.test(href);
  });
}

export function collectRecoverableStyleOrigins(html = '') {
  return [
    ...new Set(
      collectRecoverableHomepages(html)
        .map((home) => {
          try {
            return new URL(home).origin;
          } catch {
            return '';
          }
        })
        .filter(Boolean)
    ),
  ];
}

export function collectRecoverableHomepages(html = '') {
  const counts = new Map();
  const bump = (value = '') => {
    const url = sanitizeText(value);
    if (!url) return;
    counts.set(url, (counts.get(url) || 0) + 1);
  };
  const scan = stripEmbeddedCssAndJs(html);
  const shortlink =
    scan.match(/<link\b[^>]*rel=["']shortlink["'][^>]*href=["']([^"']+)["']/i)?.[1] ||
    scan.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']shortlink["']/i)?.[1] ||
    '';
  if (shortlink) {
    try {
      const parsed = new URL(shortlink);
      if (/^https?:$/i.test(parsed.protocol) && !SKIP_RECOVER_HOSTS.test(parsed.hostname)) {
        const folder = parsed.pathname.replace(/\/[^/]*\.[a-z0-9]+$/i, '/');
        bump(`${parsed.origin}${folder.endsWith('/') ? folder : `${folder}/`}`);
      }
    } catch {
      // Ignore malformed shortlinks.
    }
  }
  for (const match of scan.matchAll(/https?:\/\/[^"'()\s<>]+/gi)) {
    try {
      const parsed = new URL(match[0]);
      if (!/^https?:$/i.test(parsed.protocol)) continue;
      if (SKIP_RECOVER_HOSTS.test(parsed.hostname)) continue;
      if (SKIP_RECOVER_PATH.test(parsed.pathname)) continue;
      bump(`${parsed.origin}/`);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] && !/\.[a-z0-9]{2,8}$/i.test(parts[0])) bump(`${parsed.origin}/${parts[0]}/`);
      if (parts[1] && !/\.[a-z0-9]{2,8}$/i.test(parts[1])) {
        bump(`${parsed.origin}/${parts[0]}/${parts[1]}/`);
      }
      if (parts[2] && !/\.[a-z0-9]{2,8}$/i.test(parts[2])) {
        bump(`${parsed.origin}/${parts[0]}/${parts[1]}/${parts[2]}/`);
      }
    } catch {
      // Ignore malformed URLs left in template HTML.
    }
  }
  const depth = (url = '') => {
    try {
      return new URL(url).pathname.split('/').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  return [...counts.entries()]
    .sort((left, right) => depth(right[0]) - depth(left[0]) || right[1] - left[1] || right[0].length - left[0].length)
    .map(([url]) => url)
    .slice(0, 8);
}

function stylesheetHrefsFromHtml(html = '', baseUrl = '') {
  const hrefs = [];
  for (const match of String(html || '').matchAll(/<link\b([^>]*?)>/gi)) {
    const attrs = match[1] || '';
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(attrs)) continue;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!href || href.startsWith('data:')) continue;
    try {
      const absolute = new URL(href, baseUrl || undefined);
      if (SKIP_RECOVER_HOSTS.test(absolute.hostname) || SKIP_RECOVER_PATH.test(absolute.pathname)) continue;
      hrefs.push(absolute.toString());
    } catch {
      // skip
    }
  }
  return [...new Set(hrefs)];
}

export async function recoverMissingStylesheets(
  html = '',
  { fetchImpl = fetch, timeoutMs = 20_000, preferredHomepages = [] } = {}
) {
  const original = String(html || '');
  const hadRecovered = /data-preview-css=["']recovered["']/i.test(original);
  const source = stripRecoveredStylesheets(original);
  if (!hasLocalStylesheetLinks(source) && !hadRecovered && !preferredHomepages.length) return original;
  const homes = [
    ...new Set(
      [...(Array.isArray(preferredHomepages) ? preferredHomepages : []), ...collectRecoverableHomepages(source)].filter(
        Boolean
      )
    ),
  ];
  if (!homes.length) return hadRecovered ? source : original;
  const chunks = [];
  const seenCss = new Set();
  for (const home of homes) {
    const homeRes = await fetchImpl(home, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: RECOVER_FETCH_HEADERS,
    }).catch(() => null);
    if (!homeRes?.ok) continue;
    const homeHtml = await homeRes.text();
    for (const absolute of stylesheetHrefsFromHtml(homeHtml, home).slice(0, 30)) {
      if (seenCss.has(absolute)) continue;
      seenCss.add(absolute);
      const cssRes = await fetchImpl(absolute, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: RECOVER_FETCH_HEADERS,
      }).catch(() => null);
      if (!cssRes?.ok) continue;
      const type = String(cssRes.headers?.get?.('content-type') || '').toLowerCase();
      if (type.includes('html')) continue;
      const css = await cssRes.text();
      if (css && !css.trim().startsWith('<')) {
        chunks.push(`/* recovered from ${absolute} */\n${css.replace(/<\/style/gi, '<\\/style')}`);
      }
    }
    if (chunks.length) break;
  }
  if (!chunks.length) return source;
  const style = `<style data-preview-css="recovered">${chunks.join('\n')}</style>`;
  let stripped = source.replace(/<link\b([^>]*?)>/gi, (full, attrs) => {
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(attrs)) return full;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!href || /^(https?:)?\/\//i.test(href) || href.startsWith('data:')) return full;
    return /\.css(\?|#|$)/i.test(href) ? '' : full;
  });
  if (/<head[\s>]/i.test(stripped)) return stripped.replace(/<head([^>]*)>/i, `<head$1>${style}`);
  return `${style}${stripped}`;
}

export async function persistRecoveredStylesheets(siteRoot, { fetchImpl = fetch } = {}) {
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile() || !/\.html?$/i.test(entry.name)) continue;
      const html = await fs.readFile(abs, 'utf8');
      const recovered = await recoverMissingStylesheets(html, { fetchImpl });
      if (recovered !== html) await fs.writeFile(abs, recovered, 'utf8');
    }
  }
  await walk(siteRoot);
}

export async function mergePreviewAssetsIntoSiteRoot(siteRoot, importDir = '') {
  const dest = path.join(siteRoot, 'assets');
  await fs.mkdir(dest, { recursive: true });
  const searchRoot = importDir || siteRoot;
  const queue = [searchRoot];
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(abs);
        continue;
      }
      if (!entry.isFile() || !/\.(css|js|mjs|woff2?|ttf|otf|eot)$/i.test(entry.name)) continue;
      const target = path.join(dest, entry.name);
      if (path.resolve(abs) === path.resolve(target) || existsSync(target)) continue;
      await fs.copyFile(abs, target);
    }
  }
  return dest;
}

export async function findPreviewFileByBasename(roots = [], fileName = '', { maxFiles = 800 } = {}) {
  const wanted = path.basename(sanitizeText(fileName).split(/[?#]/)[0]);
  if (!wanted || wanted === '.' || wanted === '..') return '';
  const queue = [...roots].filter(Boolean).map((root) => path.resolve(root));
  const seen = new Set();
  let visited = 0;
  while (queue.length && visited < maxFiles) {
    const dir = queue.shift();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      visited += 1;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(abs);
        continue;
      }
      if (entry.isFile() && entry.name === wanted) return abs;
    }
  }
  return '';
}

export function assertImportedPreviewHasAssets(siteRoot, importDir = '') {
  const indexPath = path.join(siteRoot, 'index.html');
  if (!existsSync(indexPath)) {
    const error = new Error('Imported ZIP did not contain an index.html site root.');
    error.status = 502;
    throw error;
  }
  const html = readFileSync(indexPath, 'utf8');
  const inlinedCss = new Set(
    [...String(html).matchAll(/data-preview-css=["']([^"']+)["']/gi)].map((match) =>
      path.posix.basename(String(match[1] || '')).toLowerCase()
    )
  );
  const missing = [...collectRelativeAssetRefs(html)].filter((ref) => {
    const base = path.posix.basename(ref).toLowerCase();
    if (/\.css$/i.test(ref) && inlinedCss.has(base)) return false;
    return !existsSync(path.join(siteRoot, ref)) && !(importDir && existsSync(path.join(importDir, ref)));
  });
  const critical = missing.filter((ref) => /\.(css|js)$/i.test(ref));
  if (!critical.length) return { missing, critical };
  const error = new Error(
    `Preview ZIP is missing the website's CSS/JS (${critical.slice(0, 6).join(', ')}). ` +
      'Refusing to replace a public preview with an unstyled HTML shell.'
  );
  error.status = 502;
  error.missing = critical;
  throw error;
}

export async function fillExportZipWithMakerAssets({
  makerBase,
  runId,
  exportStep = 'latest',
  zipBuffer,
  fetchImpl = fetch,
  headers = {},
} = {}) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const entryNames = new Set(entries.map((entry) => entry.entryName.replace(/\\/g, '/')));
  const htmlEntries = entries.filter((entry) => /\.html?$/i.test(entry.entryName));
  if (!htmlEntries.length) return { buffer: zipBuffer, added: 0, missing: [], note: 'no html' };

  const indexEntry =
    htmlEntries
      .filter((entry) => /(^|\/)index\.html$/i.test(entry.entryName))
      .sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length)[0] || htmlEntries[0];
  const indexName = indexEntry.entryName.replace(/\\/g, '/');
  const prefix = indexName.includes('/') ? indexName.slice(0, indexName.lastIndexOf('/') + 1) : '';

  const wanted = new Set();
  for (const entry of htmlEntries) {
    for (const ref of collectRelativeAssetRefs(entry.getData().toString('utf8'))) wanted.add(ref);
  }
  const missing = [...wanted].filter((ref) => !entryNames.has(`${prefix}${ref}`) && !entryNames.has(ref));
  if (!missing.length) return { buffer: zipBuffer, added: 0, missing: [], note: 'complete' };

  const tryUrl = async (url, assetPath) => {
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response?.ok) return null;
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
      if (!/\.html?$/i.test(assetPath) && contentType.includes('text/html')) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) return null;
      return { buffer, contentType };
    } catch {
      return null;
    }
  };

  const fetchAsset = async (assetPath) => {
    const urls = makerAssetFetchUrls({ makerBase, runId, exportStep, assetPath });
    for (const url of urls) {
      const found = await tryUrl(url, assetPath);
      if (found) return found;
    }
    return null;
  };

  let added = 0;
  const queue = [...missing];
  const seen = new Set(queue);
  const MAX_FILES = 500;
  while (queue.length && added < MAX_FILES) {
    const assetPath = queue.shift();
    const found = await fetchAsset(assetPath);
    if (!found) continue;
    let payload = found.buffer;
    if (/\.css$/i.test(assetPath) || String(found.contentType || '').includes('text/css')) {
      payload = Buffer.from(rewriteCssForStaticPreview(payload.toString('utf8')), 'utf8');
      const cssDir = assetPath.includes('/') ? assetPath.slice(0, assetPath.lastIndexOf('/') + 1) : '';
      for (const match of payload.toString('utf8').matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/gi)) {
        const raw = String(match[1] || '').trim().split(/[?#]/)[0];
        if (!raw || /^(https?:)?\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('/')) continue;
        const resolved = path.posix.normalize(path.posix.join(cssDir, raw));
        if (resolved.startsWith('..')) continue;
        const asAssets = resolved.includes('/') ? resolved : `${cssDir}${resolved}`;
        if (!seen.has(asAssets) && !entryNames.has(`${prefix}${asAssets}`)) {
          seen.add(asAssets);
          queue.push(asAssets);
        }
      }
    }
    zip.addFile(`${prefix}${assetPath}`, payload);
    entryNames.add(`${prefix}${assetPath}`);
    added += 1;
  }

  const stillMissing = [...wanted].filter(
    (ref) => !entryNames.has(`${prefix}${ref}`) && !entryNames.has(ref) && /\.(css|js)$/i.test(ref)
  );
  if (stillMissing.length) {
    const error = new Error(
      `Export ZIP is missing CSS/JS (${stillMissing.slice(0, 6).join(', ')}) and Website Maker did not serve those files.`
    );
    error.status = 502;
    error.missing = stillMissing;
    throw error;
  }
  return {
    buffer: added ? zip.toBuffer() : zipBuffer,
    added,
    missing: stillMissing,
    note: added ? 'maker-asset-id' : 'complete',
  };
}
