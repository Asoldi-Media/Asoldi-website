#!/usr/bin/env node
/**
 * Lists the outbound hosts a repository's code can reach, for the subprocessor register
 * (lib/legal/hosts-register.json).
 *
 *   node scripts/legal/scan-hosts.mjs <repo> [--name hub|maker|cms] [--ref <git ref>] [--egress] [--out <file>] [--check <file>]
 *
 * Sources:
 *   - a static scan of the repository's runtime source files: URL literals (https://host/...) and
 *     host option literals (host: 'api.example.org', hostname: '...');
 *   - the pages' HTML: script, iframe, image and media sources, stylesheet, preconnect and preload
 *     links, form actions, CSS url() and inline scripts;
 *   - with --egress, the string hosts of the hub's safe-mode egress allowlist (lib/safe-mode-egress.js
 *     buildEgressRules with an empty env, so no env-derived host is listed).
 *
 * Without --ref the tracked and untracked (not ignored) files of the working tree are read.
 * With --ref every file, the egress allowlist included, is read from that commit through git only,
 * so a checkout with local changes is never touched or read past what the ref holds. A ref other
 * than HEAD is recorded with its commit (`commit`), so the snapshot names the code it came from.
 *
 * Scope: runtime source (.js .mjs .cjs .ts) and pages (.html). In React files (.jsx .tsx) a URL
 * counts in a call-like position (fetch, src, script and iframe sources, map tiles, new URL), as
 * an image, media, icon, embed or stylesheet value (image: '...', logoUrl = '...', url(...)), and
 * as a URL constant in a file that starts an embedded widget with it (initInlineWidget({ url })).
 * Links a person clicks (href) are not outbound. Tests, fixtures, scripts, docs, builds, scratch
 * files, imported templates and vendored code are skipped, and so are comments. Reserved and test
 * domains, loopback and private names, and XML or JSON-LD namespaces are never outbound hosts.
 *
 * --check <file> compares the scan with a committed snapshot and exits 1 when they differ.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SNAPSHOT_VERSION = 1;

const SOURCE_EXT = /\.(js|mjs|cjs|ts)$/i;
const REACT_EXT = /\.(jsx|tsx)$/i;
const HTML_EXT = /\.html?$/i;

const SKIP_PATH = [
  /(^|\/)node_modules\//,
  /(^|\/)(dist|build|out|coverage|admin-dist|vendor|\.next|\.generated-runs)\//,
  /(^|\/)(test|tests|__tests__|fixtures|golden|examples?|inspo|docs)\//,
  /(^|\/)scripts\//,
  /\.(test|spec)\.[a-z]+$/i,
  /\.d\.ts$/i,
  /\.min\.js$/i,
  /(^|\/)(vite|vitest|webpack|tailwind|postcss|eslint|next|jest|playwright)\.config\.[a-z]+$/i,
];

// Pages that are not served: scratch and temporary files, imported template sources (their hosts
// belong to the sites built from them) and dot-files.
const HTML_SKIP_PATH = [
  /(^|\/)(scratch|tmp|temp|template-import|templates?|samples?|mocks?|storybook)\//i,
  /(^|\/)\.[^/]+$/,
];

// Lines that only show an address to a person (form placeholders and hints) are never outbound.
const DISPLAY_ONLY = /\b(placeholder|hint)\s*[=:]/i;

// Hosts an SDK in package.json dependencies calls without naming them in the caller's source.
export const SDK_HOSTS = Object.freeze({
  '@anthropic-ai/sdk': ['api.anthropic.com'],
  '@google/genai': ['generativelanguage.googleapis.com'],
  openai: ['api.openai.com'],
  stripe: ['api.stripe.com'],
  '@stripe/stripe-js': ['js.stripe.com', 'api.stripe.com'],
  '@stripe/react-stripe-js': ['js.stripe.com', 'api.stripe.com'],
  googleapis: ['www.googleapis.com', 'oauth2.googleapis.com'],
  firebase: ['firestore.googleapis.com', 'identitytoolkit.googleapis.com', 'securetoken.googleapis.com'],
  '@supabase/supabase-js': ['*.supabase.co'],
  resend: ['api.resend.com'],
  '@getbrevo/brevo': ['api.brevo.com'],
});

const CALL_CONTEXT = /(fetch\w*\s*\(|\bsrc\s*[=:]|SCRIPT_SRC|tileLayer\s*\(|new\s+URL\s*\(|\.(get|post|put|patch|delete|request)\s*\(|\bimport\s*\()/i;

// React: a URL given as an image, media, icon, embed, script or stylesheet value is loaded by the
// browser (image: 'https://...', backgroundImageUrl: ..., EMBED_URL = ...). A key counts when one
// of its words (camelCase or snake_case parts) is one of these.
const ASSET_WORDS = new Set([
  'image', 'images', 'img', 'logo', 'logos', 'avatar', 'thumbnail', 'thumb', 'poster', 'photo', 'photos',
  'picture', 'video', 'videos', 'icon', 'icons', 'cover', 'background', 'bg', 'banner', 'embed',
  'widget', 'script', 'stylesheet', 'font', 'fonts', 'media', 'src',
]);
const KEYED_URL = /([A-Za-z_$][\w$]*)\s*[:=]\s*\{?\s*[`'"]https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;
const CSS_URL = /url\(\s*['"]?https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;
// React: a file that starts an embedded widget from a URL option (Calendly.initInlineWidget({ url })).
const WIDGET_INIT = /\binit\w*(Widget|Embed|Popup|Badge)\s*\(|\.init\w*\s*\(\s*\{[^}]*\burl\s*:/i;
// A URL literal assigned to a constant (const base = 'https://...').
const URL_CONSTANT = /\b(?:const|let|var)\s+[\w$]+\s*=\s*[`'"]https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/g;

/** True when one of an identifier's words names something the browser loads (ASSET_WORDS). */
export function isAssetKey(name = '') {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_$]+/)
    .some((part) => ASSET_WORDS.has(part.toLowerCase()));
}

/** Hosts a React line loads without a call-like position: asset values, CSS url() and widget URL constants. */
function reactAssetHosts(line, { widgetFile = false } = {}) {
  const hosts = [];
  for (const match of line.matchAll(KEYED_URL)) if (isAssetKey(match[1])) hosts.push(match[2]);
  for (const match of line.matchAll(CSS_URL)) hosts.push(match[1]);
  if (widgetFile) for (const match of line.matchAll(URL_CONSTANT)) hosts.push(match[1]);
  return hosts;
}

// Not outbound hosts: reserved and test names (RFC 2606 / 6761), loopback and private names,
// and identifiers that look like URLs but are never fetched (XML, SVG and JSON-LD namespaces).
const IGNORE_EXACT = new Set([
  'localhost',
  'schema.org',
  'www.w3.org',
  'w3.org',
  'purl.org',
  'ogp.me',
  'json-schema.org',
  'xmlns.com',
  'www.sitemaps.org',
  'sitemaps.org',
  'host.docker.internal',
  'gateway.docker.internal',
]);
const IGNORE_SUFFIX = [
  'example.com', 'example.org', 'example.net', '.example', '.test', '.invalid', '.localhost',
  '.local', '.lan', '.internal', '.home.arpa',
];

function clean(value) {
  return String(value ?? '').trim();
}

/** Lower-case host, or '' when it is not a public DNS name worth listing. */
export function normalizeScannedHost(raw = '') {
  let host = clean(raw).toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) return '';
  if (!/^[a-z0-9*]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return '';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return '';
  if (!/\.[a-z]{2,}$/.test(host)) return '';
  if (IGNORE_EXACT.has(host)) return '';
  if (IGNORE_SUFFIX.some((suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`))) return '';
  return host;
}

/** Source with comments blanked (strings and template literals kept). Approximate, line-preserving. */
export function stripComments(source = '') {
  let out = '';
  let i = 0;
  const n = source.length;
  let quote = '';
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = '';
      else if (ch === '\n' && quote !== '`') quote = '';
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const URL_RE = /\bhttps?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?![a-z0-9.-]*\$\{)/gi;
const HOST_OPTION_RE = /\bhost(?:name)?\s*:\s*['"]([a-z0-9][a-z0-9.-]*\.[a-z]{2,})['"]/gi;

/** Hosts one file's source mentions in an outbound position. */
export function hostsInSource(source = '', file = '') {
  if (HTML_EXT.test(file)) return hostsInHtml(source);
  const react = REACT_EXT.test(file);
  const text = stripComments(String(source || ''));
  const widgetFile = react && WIDGET_INIT.test(text);
  const found = new Set();
  for (const line of text.split('\n')) {
    if (!/https?:\/\/|host/i.test(line)) continue;
    if (DISPLAY_ONLY.test(line)) continue;
    if (react && !CALL_CONTEXT.test(line)) {
      for (const raw of reactAssetHosts(line, { widgetFile })) {
        const host = normalizeScannedHost(raw);
        if (host) found.add(host);
      }
      continue;
    }
    for (const match of line.matchAll(URL_RE)) {
      const host = normalizeScannedHost(match[1]);
      if (host) found.add(host);
    }
    if (!react) {
      for (const match of line.matchAll(HOST_OPTION_RE)) {
        const host = normalizeScannedHost(match[1]);
        if (host) found.add(host);
      }
    }
  }
  return found;
}

// HTML elements whose URL attributes the browser loads by itself.
const HTML_LOADING_TAGS = /<(script|iframe|frame|img|source|video|audio|embed|track|object|form|link)\b([^>]*)>/gi;
const HTML_URL_ATTRS = /\b(src|data|action|poster|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
// <link rel> values that make the browser connect: stylesheets, preconnect and preloads, icons, manifests.
const LOADING_LINK_REL = /\b(stylesheet|preconnect|dns-prefetch|preload|prefetch|modulepreload|icon|apple-touch-icon|manifest)\b/i;
const HTML_URL_HOST = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;

function hostsInText(text, found) {
  for (const match of String(text || '').matchAll(HTML_URL_HOST)) {
    const host = normalizeScannedHost(match[1]);
    if (host) found.add(host);
  }
}

/**
 * Hosts an HTML page makes the browser reach: script, iframe, image and media sources, object
 * data, form actions, stylesheet, preconnect, preload, icon and manifest links, CSS url() in style
 * blocks and attributes, and the outbound URLs of inline scripts. Links a person clicks
 * (<a href>, canonical and alternate links) and comments are not counted.
 */
export function hostsInHtml(source = '') {
  const html = String(source || '').replace(/<!--[\s\S]*?-->/g, ' ');
  const found = new Set();
  for (const tag of html.matchAll(HTML_LOADING_TAGS)) {
    const name = tag[1].toLowerCase();
    const attrs = tag[2] || '';
    if (name === 'link') {
      const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      if (!rel || !LOADING_LINK_REL.test(rel[1] ?? rel[2] ?? rel[3] ?? '')) continue;
    }
    for (const attr of attrs.matchAll(HTML_URL_ATTRS)) {
      const key = attr[1].toLowerCase();
      if (key === 'href' && name !== 'link') continue;
      hostsInText(attr[2] ?? attr[3] ?? attr[4] ?? '', found);
    }
  }
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>|\bstyle\s*=\s*"([^"]*)"/gi)) {
    for (const url of String(style[1] ?? style[2] ?? '').matchAll(/url\(\s*['"]?([^'")\s]+)/gi)) hostsInText(url[1], found);
    for (const imported of String(style[1] ?? '').matchAll(/@import\s+['"]([^'"]+)['"]/gi)) hostsInText(imported[1], found);
  }
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(script[1] || '') || /type\s*=\s*["']?application\/(ld\+)?json/i.test(script[1] || '')) continue;
    for (const host of hostsInSource(script[2] || '', 'inline.js')) found.add(host);
  }
  return found;
}

export function isScannedPath(path = '') {
  const file = String(path || '').replace(/\\/g, '/');
  if (HTML_EXT.test(file)) return !SKIP_PATH.some((re) => re.test(file)) && !HTML_SKIP_PATH.some((re) => re.test(file));
  if (!SOURCE_EXT.test(file) && !REACT_EXT.test(file)) return false;
  return !SKIP_PATH.some((re) => re.test(file));
}

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: options.encoding ?? 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function listFiles(repo, ref) {
  if (ref) return git(repo, ['ls-tree', '-r', '-z', '--name-only', ref]).split('\0').filter(Boolean);
  const tracked = git(repo, ['ls-files', '-z']).split('\0').filter(Boolean);
  const others = git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  return [...new Set([...tracked, ...others])];
}

function readFiles(repo, ref, files) {
  const out = new Map();
  if (!files.length) return out;
  if (!ref) {
    for (const file of files) {
      const full = join(repo, file);
      if (!existsSync(full)) continue;
      try {
        out.set(file, readFileSync(full, 'utf8'));
      } catch {
        // unreadable files are skipped
      }
    }
    return out;
  }
  const input = files.map((file) => `${ref}:${file}`).join('\n');
  const raw = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], { input, maxBuffer: 512 * 1024 * 1024 });
  let offset = 0;
  for (const file of files) {
    const headerEnd = raw.indexOf(10, offset);
    if (headerEnd === -1) break;
    const header = raw.subarray(offset, headerEnd).toString('utf8');
    offset = headerEnd + 1;
    const parts = header.split(' ');
    if (parts[1] === 'missing' || parts.length < 3) continue;
    const size = Number(parts[2]);
    out.set(file, raw.subarray(offset, offset + size).toString('utf8'));
    offset += size + 1;
  }
  return out;
}

/** Hosts the runtime dependencies in a package.json text call through their SDK (SDK_HOSTS). */
export function sdkHostsForPackage(packageJsonText = '') {
  let parsed = null;
  try {
    parsed = JSON.parse(String(packageJsonText || ''));
  } catch {
    return [];
  }
  const out = new Set();
  for (const name of Object.keys(parsed?.dependencies || {})) {
    for (const host of SDK_HOSTS[name] || []) out.add(host);
  }
  return [...out];
}

const EGRESS_MODULE = 'lib/safe-mode-egress.js';

/**
 * Copies a module and the relative modules it imports, as they are at `ref`, into a new temporary
 * directory, and returns the copy's path (null when the module is not at that ref).
 */
function moduleTreeAtRef(repo, ref, entry) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-hosts-'));
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const source = readFiles(repo, ref, [path]).get(path);
    if (source === undefined) {
      if (path === entry) {
        rmSync(dir, { recursive: true, force: true });
        return null;
      }
      continue;
    }
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), source);
    for (const match of source.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const specifier = match[1] || match[2] || match[3];
      queue.push(posix.normalize(posix.join(posix.dirname(path), specifier)));
    }
  }
  return dir;
}

/**
 * String host patterns of the safe-mode egress allowlist of a hub checkout (empty env). With `ref`
 * the allowlist module is read from that commit, so local changes never count.
 */
export async function egressAllowlistHosts(repo, { ref = '' } = {}) {
  let copy = null;
  let file = join(repo, EGRESS_MODULE);
  if (ref) {
    copy = moduleTreeAtRef(repo, ref, EGRESS_MODULE);
    if (!copy) return [];
    file = join(copy, EGRESS_MODULE);
  } else if (!existsSync(file)) {
    return [];
  }
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } finally {
    if (copy) rmSync(copy, { recursive: true, force: true });
  }
  if (typeof mod.buildEgressRules !== 'function') return [];
  const out = new Set();
  for (const rule of mod.buildEgressRules({})) {
    if (rule.key === 'lan' || rule.key === 'publicRead') continue;
    for (const pattern of rule.hosts || []) {
      if (typeof pattern !== 'string') continue;
      const wildcard = pattern.startsWith('*.');
      const host = normalizeScannedHost(wildcard ? pattern.slice(2) : pattern);
      if (host) out.add(wildcard ? `*.${host}` : host);
    }
  }
  return [...out];
}

/** The commit a ref names in a repository, or '' when the repository does not have it. */
export function resolveCommit(repo, ref) {
  try {
    return git(resolve(repo), ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
  } catch {
    return '';
  }
}

/**
 * { name, ref, commit?, egress, hosts: [{host, via}] } for one repository. `via` lists 'static',
 * 'sdk' and/or 'egress'. Hosts are sorted. `commit` is recorded for a ref other than HEAD.
 */
export async function scanRepoHosts(repo, { name = '', ref = '', egress = false } = {}) {
  const root = resolve(repo);
  const commit = ref && ref !== 'HEAD' ? resolveCommit(root, ref) : '';
  if (ref && ref !== 'HEAD' && !commit) throw new Error(`${root} has no commit ${ref}`);
  const files = listFiles(root, ref).filter(isScannedPath);
  const contents = readFiles(root, ref, files);
  const via = new Map();
  const add = (host, kind) => {
    if (!via.has(host)) via.set(host, new Set());
    via.get(host).add(kind);
  };
  for (const [file, source] of contents) {
    for (const host of hostsInSource(source, file)) add(host, 'static');
  }
  for (const host of sdkHostsForPackage(readFiles(root, ref, ['package.json']).get('package.json'))) add(host, 'sdk');
  if (egress) {
    for (const host of await egressAllowlistHosts(root, { ref })) add(host, 'egress');
  }
  const hosts = [...via.keys()].sort().map((host) => ({ host, via: [...via.get(host)].sort() }));
  return { version: SNAPSHOT_VERSION, name: name || '', ref: ref || '', ...(commit ? { commit } : {}), egress: Boolean(egress), hosts };
}

/** Host names of a snapshot or scan result. */
export function snapshotHosts(snapshot) {
  return (Array.isArray(snapshot?.hosts) ? snapshot.hosts : []).map((entry) => (typeof entry === 'string' ? entry : entry?.host)).filter(Boolean);
}

/** { added, removed } between a committed snapshot and a fresh scan. */
export function diffSnapshots(committed, fresh) {
  const before = new Set(snapshotHosts(committed));
  const after = new Set(snapshotHosts(fresh));
  return {
    added: [...after].filter((host) => !before.has(host)).sort(),
    removed: [...before].filter((host) => !after.has(host)).sort(),
  };
}

export function formatSnapshot(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function parseArgs(argv) {
  const args = { repo: '', name: '', ref: '', egress: false, out: '', check: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--name') args.name = argv[++i] || '';
    else if (arg === '--ref') args.ref = argv[++i] || '';
    else if (arg === '--egress') args.egress = true;
    else if (arg === '--out') args.out = argv[++i] || '';
    else if (arg === '--check') args.check = argv[++i] || '';
    else if (!args.repo) args.repo = arg;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo) {
    console.error('Usage: node scripts/legal/scan-hosts.mjs <repo> [--name hub|maker|cms] [--ref <ref>] [--egress] [--out <file>] [--check <file>]');
    process.exit(2);
  }
  const result = await scanRepoHosts(args.repo, args);
  if (args.check) {
    const committed = JSON.parse(readFileSync(args.check, 'utf8'));
    const { added, removed } = diffSnapshots(committed, result);
    if (added.length || removed.length) {
      console.error(`${args.check} is stale. New hosts: ${added.join(', ') || 'none'}. Gone: ${removed.join(', ') || 'none'}.`);
      process.exit(1);
    }
    console.log(`${args.check} matches (${snapshotHosts(result).length} hosts).`);
    return;
  }
  const text = formatSnapshot(result);
  if (args.out) writeFileSync(args.out, text);
  else process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
