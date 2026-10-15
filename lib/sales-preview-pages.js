import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const SKIP_DIRS = new Set(['assets', 'uploads', 'node_modules', 'vendor', '.git']);
const pageListCache = new Map();

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

export function normalizePreviewRoute(route = '/') {
  let value = sanitize(route).split(/[?#]/)[0].replace(/\\/g, '/');
  if (!value || value === '.') return '/';
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\/{2,}/g, '/');
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value || '/';
}

export function routeFromPreviewRelativePath(relativePath = '') {
  let value = sanitize(relativePath).replace(/\\/g, '/').replace(/^\/+/, '').split(/[?#]/)[0];
  if (!value || /^index\.html?$/i.test(value)) return '/';
  value = value.replace(/\/index\.html?$/i, '').replace(/\.html?$/i, '');
  return normalizePreviewRoute(`/${value}`);
}

export function labelForPreviewRoute(route = '/') {
  const normalized = normalizePreviewRoute(route);
  if (normalized === '/') return 'Hjem';
  const leaf = normalized.split('/').filter(Boolean).pop() || normalized;
  const spaced = leaf.replace(/[-_]+/g, ' ').trim();
  if (!spaced) return normalized;
  return spaced.replace(/\b[\p{L}\p{N}]/gu, (ch) => ch.toUpperCase());
}

export function previewBaseFromRequestPath(pathname = '', clientId = '') {
  const match = String(pathname || '').match(/^\/sales-preview\/[^/]+/i);
  if (match) return `${match[0]}/`;
  const id = sanitize(clientId);
  return id ? `/sales-preview/${encodeURIComponent(id)}/` : '/sales-preview/';
}

export function previewWantsEmbed(req = {}) {
  const query = req.query || {};
  if (String(query['asoldi-embed'] ?? query.asoldiEmbed ?? '') === '1') return true;
  const dest = String(
    (typeof req.get === 'function' ? req.get('sec-fetch-dest') : '') ||
      req.headers?.['sec-fetch-dest'] ||
      ''
  ).toLowerCase();
  return dest === 'iframe' || dest === 'embed' || dest === 'frame';
}

export function embedSrcFromRequest(req = {}) {
  const raw = String(req.originalUrl || req.url || '/');
  const parsed = new URL(raw, 'https://asoldi.com');
  parsed.searchParams.set('asoldi-embed', '1');
  return `${parsed.pathname}${parsed.search}`;
}

export function hrefForPreviewRoute(previewBase = '/', route = '/') {
  const base = String(previewBase || '/').replace(/\/+$/, '');
  const normalized = normalizePreviewRoute(route);
  const pathname = normalized === '/' ? `${base}/` : `${base}${normalized}`;
  return `${pathname}?asoldi-embed=1`;
}

function decodeXmlText(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function routeFromLoc(loc = '', prefixes = []) {
  let pathname = sanitize(decodeXmlText(loc));
  try {
    pathname = new URL(pathname).pathname;
  } catch {
    // Already a path.
  }
  pathname = pathname.replace(/\/index\.html?$/i, '/') || '/';
  for (const prefix of prefixes) {
    const base = String(prefix || '').replace(/\/+$/, '');
    if (!base) continue;
    if (pathname === base || pathname === `${base}/`) return '/';
    if (pathname.startsWith(`${base}/`)) {
      return normalizePreviewRoute(pathname.slice(base.length));
    }
  }
  return '';
}

function sortPreviewPages(pages = []) {
  const seen = new Set();
  const out = [];
  for (const page of pages) {
    const route = normalizePreviewRoute(page?.route || '/');
    if (seen.has(route)) continue;
    seen.add(route);
    out.push({
      route,
      label: sanitize(page?.label) || labelForPreviewRoute(route),
    });
  }
  out.sort((a, b) => {
    if (a.route === '/') return -1;
    if (b.route === '/') return 1;
    return a.route.localeCompare(b.route);
  });
  if (!seen.has('/')) out.unshift({ route: '/', label: labelForPreviewRoute('/') });
  return out;
}

export function pagesFromSitemapXml(xml = '', prefixes = []) {
  const pages = [];
  String(xml || '').replace(/<loc>\s*([^<]+)\s*<\/loc>/gi, (_m, loc) => {
    const route = routeFromLoc(loc, prefixes);
    if (route) pages.push({ route, label: labelForPreviewRoute(route) });
    return _m;
  });
  return sortPreviewPages(pages);
}

function fileRelToRoute(rel = '') {
  return routeFromPreviewRelativePath(rel);
}

async function walkPreviewHtmlRoutes(root) {
  const routes = [];
  async function walk(dir, rel) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, nextRel);
        continue;
      }
      if (!/\.html?$/i.test(entry.name)) continue;
      routes.push({ route: fileRelToRoute(nextRel), label: labelForPreviewRoute(fileRelToRoute(nextRel)) });
    }
  }
  if (root && existsSync(root)) await walk(root, '');
  return sortPreviewPages(routes);
}

export async function listSalesPreviewPages(root = '', { clientId = '', extraPrefixes = [] } = {}) {
  const prefixes = [
    `/sales-preview/${encodeURIComponent(sanitize(clientId))}`,
    ...extraPrefixes.map((value) => String(value || '').replace(/\/+$/, '')),
  ].filter(Boolean);
  const sitemapPath = root ? path.join(root, 'sitemap.xml') : '';
  if (sitemapPath && existsSync(sitemapPath)) {
    const xml = await fs.readFile(sitemapPath, 'utf8').catch(() => '');
    const fromSitemap = pagesFromSitemapXml(xml, prefixes);
    if (fromSitemap.length > 1) return fromSitemap;
  }
  return walkPreviewHtmlRoutes(root);
}

export async function listSalesPreviewPagesCached(root = '', options = {}) {
  let stamp = '0';
  try {
    const sitemap = path.join(root, 'sitemap.xml');
    if (existsSync(sitemap)) {
      stamp = String((await fs.stat(sitemap)).mtimeMs);
    } else {
      stamp = String((await fs.stat(root)).mtimeMs);
    }
  } catch {
    stamp = 'missing';
  }
  const key = `${root}|${stamp}|${sanitize(options.clientId)}`;
  const hit = pageListCache.get(key);
  if (hit) return hit;
  const pages = await listSalesPreviewPages(root, options);
  pageListCache.set(key, pages);
  if (pageListCache.size > 80) {
    const first = pageListCache.keys().next().value;
    pageListCache.delete(first);
  }
  return pages;
}

export function renderSalesPreviewChrome({
  previewBase = '/',
  pages = [],
  currentRoute = '/',
  iframeSrc = '',
  title = 'Forhåndsvisning',
} = {}) {
  const listed = sortPreviewPages(pages);
  const current = normalizePreviewRoute(currentRoute);
  const options = listed
    .map((page) => {
      const href = hrefForPreviewRoute(previewBase, page.route);
      const selected = page.route === current ? ' selected' : '';
      return `<option value="${escapeHtml(href)}"${selected}>${escapeHtml(page.label)}</option>`;
    })
    .join('');
  const frameSrc = escapeHtml(iframeSrc || hrefForPreviewRoute(previewBase, current));
  const base = String(previewBase || '/').replace(/\/+$/, '');
  return `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
<meta name="googlebot" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
<title>${escapeHtml(title)}</title>
<style>
  html,body{margin:0;height:100%;background:#111}
  #asoldi-preview-chrome{position:fixed;top:0;left:0;right:0;z-index:2147483647;height:52px;display:flex;align-items:center;gap:12px;padding:0 16px;background:#111;border-bottom:2px solid #FF5B00;color:#fff;font-family:Inter,system-ui,sans-serif;box-sizing:border-box}
  #asoldi-preview-chrome label{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#FF5B00;flex:0 0 auto}
  #asoldi-preview-pages{flex:1 1 auto;min-width:0;max-width:520px;height:32px;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:#1a1a1a;color:#fff;font-size:14px;padding:0 10px}
  #asoldi-preview-frame{position:fixed;top:52px;left:0;right:0;bottom:0;width:100%;height:calc(100% - 52px);border:0;background:#fff}
</style>
</head>
<body>
<header id="asoldi-preview-chrome">
  <label for="asoldi-preview-pages">Sider</label>
  <select id="asoldi-preview-pages">${options}</select>
</header>
<iframe id="asoldi-preview-frame" title="${escapeHtml(title)}" src="${frameSrc}"></iframe>
<script>
(function(){
  var frame=document.getElementById("asoldi-preview-frame");
  var select=document.getElementById("asoldi-preview-pages");
  var base=${JSON.stringify(base)};
  function routeFromPath(pathname){
    if(!pathname) return "/";
    if(pathname===base || pathname===base+"/") return "/";
    if(pathname.indexOf(base+"/")===0){
      var rest=pathname.slice(base.length);
      return rest.replace(/\\/+$/,"") || "/";
    }
    return "/";
  }
  function hrefFor(route){
    var path=route==="/"?base+"/":base+route;
    return path+"?asoldi-embed=1";
  }
  select.addEventListener("change",function(){ frame.src=this.value; });
  frame.addEventListener("load",function(){
    try{
      var route=routeFromPath(frame.contentWindow.location.pathname);
      var want=hrefFor(route);
      if(select.value!==want){
        for(var i=0;i<select.options.length;i++){
          if(select.options[i].value===want){ select.value=want; break; }
        }
      }
    }catch(e){}
  });
})();
</script>
</body>
</html>`;
}
