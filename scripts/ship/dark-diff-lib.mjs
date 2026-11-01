// Pure helpers for scripts/ship/dark-diff.mjs: normalization, data and secret snapshots, diffs,
// the intended-changes file and the route inventory. Nothing here starts a process or opens a port.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

/* ------------------------------------------------------------------ normalization */

const MONTHS = 'januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember|january|february|march|june|july|october|december';
const STRING_RULES = [
  // Password hashes (bcrypt): salted, so never equal across runs.
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, '<bcrypt>'],
  // ISO date-times, with or without milliseconds and zone.
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<time>'],
  // Compact stamps used in ids and file names (20261101T101500123Z, 2026-11-01T10-15-00-123Z).
  [/\b\d{8}T\d{6,9}Z?\b/gi, '<time>'],
  [/\b\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{1,3})?Z?\b/gi, '<time>'],
  [/\b\d{4}-\d{2}-\d{2}\b/g, '<date>'],
  [new RegExp(`\\b\\d{1,2}\\.\\s?(?:${MONTHS})(?:\\s\\d{4})?\\b`, 'gi'), '<date>'],
  [/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, '<date>'],
  [/\b(kl\.?|at)\s\d{1,2}[:.]\d{2}\b/gi, '$1 <hh:mm>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b[0-9a-f]{24,}\b/gi, '<hex>'],
  // Epoch milliseconds inside text (2001..2049).
  [/\b(?:1[0-9]|2[0-4])\d{11}\b/g, '<ms>'],
  // Prefixed random ids: sc_lq3x9abc12, mh_1a2b3c4d, offer-k2j3h4g5, mem_mvxaxykl_df1b74a2.
  replacePrefixedIds,
  // A random suffix after a time stamp: <ms>-3itwo2, offer-<ms>-x57q34.
  [/(<ms>|<time>)([_-])[a-z0-9]{4,16}(?![a-z0-9])/gi, '$1$2<id>'],
  // More random parts after an id: mem_<id>_72131615.
  [/<id>(?:[_-][a-z0-9]{4,16}(?![a-z0-9]))+/gi, '<id>'],
  // Long base64url tokens (signed links, session tokens).
  replaceTokens,
];

/**
 * Whether the part after "prefix_" or "prefix-" is random. Decided by structure, never by luck of
 * the draw: a value made from Date.now().toString(36) can be all letters for hours at a time
 * (mvxaxykl), and a hex part can be all letters or all digits.
 *  - letters and digits mixed (the old rule, still the common case);
 *  - followed by "_<hex>" or "-<hex>" of 6 or more characters: a time part plus a random part
 *    (mem_mvxaxykl_df1b74a2, biz_mvxaxykl_9a3ae4);
 *  - its first 8 characters read as base 36 give a time inside the run's clock window
 *    (scrub.clockWindow = [fromMs, toMs]): an id stamped while the run was going.
 */
function randomIdPart(token, following, window) {
  if (/\d/.test(token) && /[a-z]/i.test(token)) return true;
  if (token.length <= 12 && /^[_-][0-9a-f]{6,}(?![a-z0-9])/i.test(following)) return true;
  if (window && token.length >= 8 && token.length <= 24) {
    const ms = parseInt(token.slice(0, 8), 36);
    if (Number.isFinite(ms) && ms >= window[0] && ms <= window[1]) return true;
  }
  return false;
}

function replacePrefixedIds(text, scrub) {
  const window = Array.isArray(scrub?.clockWindow) ? scrub.clockWindow : null;
  const re = /\b([a-z]{1,16})([_-])([a-z0-9]{8,})(?![a-z0-9])/gi;
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    const [whole, prefix, sep, token] = match;
    const end = match.index + whole.length;
    if (randomIdPart(token, text.slice(end, end + 40), window)) {
      out += `${text.slice(last, match.index)}${prefix}${sep}<id>`;
      last = end;
    } else {
      // The part may itself be the prefix of an id ("page-location-x1y2z3a4"): scan on from it.
      re.lastIndex = match.index + prefix.length + sep.length;
    }
  }
  return out + text.slice(last);
}

/**
 * A run of 32 or more base64url characters is a token when it mixes upper and lower case with a
 * digit, or, without a digit, when each case is at least a quarter of its letters (random text has
 * about half of each; a long camelCase name has far fewer capitals).
 */
function replaceTokens(text) {
  return text.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, (run) => {
    const upper = (run.match(/[A-Z]/g) || []).length;
    const lower = (run.match(/[a-z]/g) || []).length;
    if (!upper || !lower) return run;
    if (/\d/.test(run)) return '<token>';
    const letters = upper + lower;
    return upper >= letters / 4 && lower >= letters / 4 ? '<token>' : run;
  });
}

/**
 * Keys that hold a time. Matched as a whole word or a camelCase / snake_case suffix, so attempts,
 * counts, items, limits, slots, seats, credits, vat and lat keep their numbers.
 */
const TIME_KEY_EXACT = /^(?:at|ts|ms|time|date|exp|iat|nbf|mtime|mtimeMs|ctime|ctimeMs|atime|atimeMs|birthtime|birthtimeMs|expires|until|since|stamp|timestamp|now)$/i;
const TIME_KEY_SUFFIX = /(?:[a-z0-9](?:At|Ms|Time|Date|Ts|Stamp|Timestamp|Until|Since|Expires|Exp)|[A-Za-z0-9]_(?:at|ms|ts|time|date|until|since|expires|exp|stamp|timestamp))$/;

export function isTimeKey(key) {
  const text = String(key || '');
  return TIME_KEY_EXACT.test(text) || TIME_KEY_SUFFIX.test(text);
}
const CODE_KEY = /^(?:code|websiteCode|portalCode|inviteCode|shortCode|offerCode)$/;
const CODE_VALUE = /^[A-Z0-9]{3,10}$/;
const VOLATILE_KEY = /^(?:uptime|elapsed|elapsedMs|durationMs|duration|ms|tookMs|pid|ppid|port|memory|rss|heapUsed|heapTotal)$/i;

/**
 * Replaces the temp paths and ports of one run, so two runs read alike. scrub.learn(value) adds a
 * random short code seen under a code key (offer codes and the like): it is replaced wherever it
 * shows up later in that run (mail text, data files).
 */
export function makeTextScrubber(replacements = [], { clockWindow = null } = {}) {
  const learned = new Map();
  const pairs = [];
  for (const [from, to] of replacements) {
    if (!from) continue;
    const variants = new Set([from, from.replace(/\\/g, '/'), from.replace(/\//g, '\\'), from.replace(/\\/g, '\\\\'), from.replace(/\//g, '\\\\')]);
    for (const variant of variants) pairs.push([variant, to]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  const scrub = (text) => {
    let out = String(text);
    for (const [from, to] of pairs) out = out.split(from).join(to);
    for (const re of learned.values()) out = out.replace(re, '<code>');
    return out.replace(/\b(127\.0\.0\.1|localhost):\d{2,5}\b/g, '$1:<port>');
  };
  scrub.learn = (value) => {
    const text = String(value);
    if (!learned.has(text)) learned.set(text, new RegExp(`(?<![A-Za-z0-9])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'g'));
  };
  // The clock range of the run (epoch ms): ids stamped from Date.now() inside it are random.
  if (Array.isArray(clockWindow) && clockWindow.every(Number.isFinite)) scrub.clockWindow = [...clockWindow];
  return scrub;
}

export function normalizeString(value, scrub = (s) => s) {
  let out = scrub(String(value));
  for (const rule of STRING_RULES) {
    out = typeof rule === 'function' ? rule(out, scrub) : out.replace(rule[0], rule[1]);
  }
  return out;
}

function looksLikeEpochMs(value) {
  return Number.isFinite(value) && value >= 1.0e12 && value <= 2.5e12;
}

/**
 * Deep normalization: timestamps, dates, random ids and tokens become placeholders, object keys
 * are normalized too (maps keyed by id), keys are sorted and, unless `keepOrder`, arrays are
 * compared as multisets (sorted by their canonical text).
 */
export function normalizeValue(value, { scrub = (s) => s, keepOrder = false, key = '' } = {}) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'number') {
    if (VOLATILE_KEY.test(key)) return '<num>';
    if (isTimeKey(key) || looksLikeEpochMs(value)) return '<ms>';
    return value;
  }
  if (typeof value === 'string') {
    if (VOLATILE_KEY.test(key) && /^\d+$/.test(value)) return '<num>';
    if (CODE_KEY.test(key) && CODE_VALUE.test(value) && /\d/.test(value)) {
      if (typeof scrub.learn === 'function') scrub.learn(value);
      return '<code>';
    }
    return normalizeString(value, scrub);
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => normalizeValue(item, { scrub, keepOrder, key }));
    return keepOrder ? items : items.map((item) => [canonical(item), item]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, item]) => item);
  }
  const entries = Object.entries(value).map(([k, v]) => [normalizeString(k, scrub), k, v]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // Keys that normalize alike (a map keyed by random ids) are grouped, and each group is sorted by
  // content before it gets its #2, #3, … suffixes, so neither the ids nor the insertion order
  // decide which value lands under which key.
  const groups = new Map();
  for (const [nk, k, v] of entries) {
    const next = normalizeValue(v, { scrub, keepOrder, key: k });
    if (!groups.has(nk)) groups.set(nk, []);
    groups.get(nk).push([canonical(next), next]);
  }
  const out = {};
  for (const [nk, items] of groups) {
    if (items.length > 1) items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [, next] of items) {
      let name = nk;
      for (let i = 2; Object.hasOwn(out, name); i += 1) name = `${nk}#${i}`;
      out[name] = next;
    }
  }
  return out;
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/* ------------------------------------------------------------------ deep diff */

/** Leaf-level differences between two normalized values: [{ path, base, head }]. */
export function deepDiff(base, head, path = '$', out = [], limit = 200) {
  if (out.length >= limit) return out;
  if (canonical(base) === canonical(head)) return out;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(base) && isObj(head)) {
    for (const key of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
      deepDiff(base[key], head[key], `${path}.${key}`, out, limit);
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(head) && base.length === head.length) {
    for (let i = 0; i < base.length; i += 1) deepDiff(base[i], head[i], `${path}[${i}]`, out, limit);
    return out;
  }
  out.push({ path, base: excerpt(base), head: excerpt(head) });
  return out;
}

export function excerpt(value, max = 160) {
  if (value === undefined) return '(absent)';
  const text = typeof value === 'string' ? value : canonical(value);
  return text.length > max ? `${text.slice(0, max)}…(${text.length})` : text;
}

/* ------------------------------------------------------------------ data snapshots */

const SKIP_FILE = /(?:\.lock|\.tmp)$|\.\d+\.[0-9a-f]{8}\.tmp$/i;
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.mp3', '.mp4', '.wav', '.m4a', '.ogg', '.webm', '.mov', '.zip', '.gz', '.tgz', '.tar', '.woff', '.woff2']);
const HASH_LIMIT = 64 * 1024 * 1024;

export function listFiles(root, { skipDirs = [] } = {}) {
  const out = [];
  if (!existsSync(root)) return out;
  const skip = new Set(skipDirs.map((d) => d.replace(/\\/g, '/').replace(/\/+$/, '')));
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!skip.has(rel)) walk(full);
      } else if (entry.isFile() && !SKIP_FILE.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Every symbolic link or junction under `root` (relative, '/'-separated); links are not followed. */
export function findLinks(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      let link = entry.isSymbolicLink();
      if (!link && entry.isDirectory()) {
        try {
          link = lstatSync(full).isSymbolicLink();
        } catch {
          link = false;
        }
      }
      if (link) out.push(relative(root, full).split(sep).join('/'));
      else if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * A PDF carries render times in compressed streams, so two renders of the same document differ in
 * bytes. It is compared by its page count (and is present or not).
 */
function pdfComparable(buffer) {
  const text = buffer.toString('latin1');
  const pages = (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  return `pdf pages:${pages}`;
}

/** Comparable content of one data file: normalized JSON, a multiset of JSONL rows, text or a hash. */
export function comparableFile(file, { scrub, keepOrder = false } = {}) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return { kind: 'missing' };
  }
  if (stat.size > HASH_LIMIT) return { kind: 'large', value: `size:${stat.size}` };
  const ext = extname(file).toLowerCase();
  const buffer = readFileSync(file);
  if (ext === '.json') {
    try {
      return { kind: 'json', value: normalizeValue(JSON.parse(buffer.toString('utf8')), { scrub, keepOrder }) };
    } catch {
      return { kind: 'text', value: normalizeString(buffer.toString('utf8'), scrub) };
    }
  }
  if (ext === '.jsonl' || ext === '.ndjson') {
    const rows = buffer.toString('utf8').split('\n').filter((line) => line.trim()).map((line) => {
      try {
        return canonical(normalizeValue(JSON.parse(line), { scrub, keepOrder }));
      } catch {
        return normalizeString(line, scrub);
      }
    });
    return { kind: 'rows', value: rows.sort() };
  }
  if (ext === '.pdf') return { kind: 'hash', value: pdfComparable(buffer) };
  if (BINARY_EXT.has(ext) || buffer.includes(0)) return { kind: 'hash', value: sha256(buffer) };
  return { kind: 'text', value: normalizeString(buffer.toString('utf8'), scrub) };
}

/**
 * A data dir as { normalizedRel: [{ rel, kind, value }] }. Paths are normalized like values, so a
 * file named after a time stamp or an id lines up across runs. `secretDirs` are compared by
 * presence only here (their values are random); `--secrets` checks them byte for byte.
 */
export function snapshotData(root, { scrub, skipDirs = [], secretDirs = ['secrets'], keepOrder = false } = {}) {
  const out = {};
  for (const rel of listFiles(root, { skipDirs })) {
    const top = rel.split('/')[0];
    const key = normalizeString(rel, scrub);
    const content = secretDirs.includes(top)
      ? { kind: 'secret', value: 'present' }
      : comparableFile(join(root, ...rel.split('/')), { scrub, keepOrder });
    (out[key] ||= []).push({ rel, ...content });
  }
  for (const list of Object.values(out)) list.sort((a, b) => (canonical(a.value) < canonical(b.value) ? -1 : 1));
  return out;
}

/** Differences between two data snapshots: [{ kind:'data', key, detail }]. */
export function diffSnapshots(base, head, { limitPerFile = 20 } = {}) {
  const diffs = [];
  for (const key of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
    const a = base[key] || [];
    const b = head[key] || [];
    if (!a.length || !b.length) {
      diffs.push({ kind: 'data', key: `data ${key}`, detail: a.length ? 'only in base' : 'only in head', base: a.length ? a[0].rel : '(absent)', head: b.length ? b[0].rel : '(absent)' });
      continue;
    }
    if (a.length !== b.length) {
      diffs.push({ kind: 'data', key: `data ${key}`, detail: `${a.length} file(s) in base, ${b.length} in head` });
      continue;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (canonical(a[i].value) === canonical(b[i].value)) continue;
      if (a[i].kind === 'json' && b[i].kind === 'json') {
        for (const d of deepDiff(a[i].value, b[i].value, '$', [], limitPerFile)) {
          diffs.push({ kind: 'data', key: `data ${key} ${d.path}`, detail: 'value differs', base: d.base, head: d.head });
        }
      } else if (a[i].kind === 'rows' && b[i].kind === 'rows') {
        const setA = new Set(a[i].value);
        const setB = new Set(b[i].value);
        const onlyA = a[i].value.filter((row) => !setB.has(row));
        const onlyB = b[i].value.filter((row) => !setA.has(row));
        diffs.push({ kind: 'data', key: `data ${key} rows`, detail: `${onlyA.length} row(s) only in base, ${onlyB.length} only in head`, base: excerpt(onlyA[0]), head: excerpt(onlyB[0]) });
      } else {
        diffs.push({ kind: 'data', key: `data ${key}`, detail: 'content differs', base: excerpt(a[i].value), head: excerpt(b[i].value) });
      }
    }
  }
  return diffs;
}

/* ------------------------------------------------------------------ secrets */

/** rel → sha256 of every file under the secret folders (lock and temp files left out). */
export function secretManifest(root, { secretDirs = ['secrets'] } = {}) {
  const out = {};
  for (const dir of secretDirs) {
    for (const rel of listFiles(join(root, dir))) {
      out[`${dir}/${rel}`] = sha256(readFileSync(join(root, dir, ...rel.split('/'))));
    }
  }
  return out;
}

/**
 * Checks one run against the source: every source secret file is still there with the same
 * sha256, and no new file appeared. Returns [{ key, detail }] (never a value or a hash).
 */
export function secretViolations(source, after, { stage = 'after boot' } = {}) {
  const out = [];
  for (const [rel, hash] of Object.entries(source)) {
    if (!(rel in after)) out.push({ rel, change: 'removed', key: `secret ${rel} removed`, detail: `${stage}: the file is gone` });
    else if (after[rel] !== hash) out.push({ rel, change: 'changed', key: `secret ${rel} changed`, detail: `${stage}: the content changed` });
  }
  for (const rel of Object.keys(after)) {
    if (!(rel in source)) out.push({ rel, change: 'new', key: `secret ${rel} new`, detail: `${stage}: a new secret file appeared` });
  }
  return out;
}

/* ------------------------------------------------------------------ intended changes */

export function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 's');
}

/**
 * The intended file: { changes:[{kind?, match, reason}], ignore:[…], allowNewSecrets:[glob],
 * rollbackLost:[glob] }. A missing file means "no change is intended".
 */
export function loadIntended(file) {
  if (!file) return { changes: [], ignore: [], allowNewSecrets: [], rollbackLost: [] };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const list = (value) => (Array.isArray(value) ? value : []).map((entry) => (typeof entry === 'string' ? { match: entry } : entry)).filter((entry) => entry && entry.match);
  return {
    description: String(raw.description || ''),
    changes: list(raw.changes),
    ignore: list(raw.ignore),
    allowNewSecrets: (Array.isArray(raw.allowNewSecrets) ? raw.allowNewSecrets : []).map(String),
    rollbackLost: (Array.isArray(raw.rollbackLost) ? raw.rollbackLost : []).map(String),
  };
}

function entryMatches(entry, diff) {
  if (entry.kind && entry.kind !== diff.kind) return false;
  return globToRegExp(entry.match).test(diff.key);
}

/** Splits differences into listed (intended or ignored) and unlisted; reports intended entries never seen. */
export function classify(diffs, intended) {
  const listed = [];
  const unlisted = [];
  const used = new Set();
  for (const diff of diffs) {
    const hit = [...intended.changes, ...intended.ignore].find((entry) => entryMatches(entry, diff));
    if (hit) {
      used.add(hit);
      listed.push({ ...diff, listedBy: hit.match, reason: hit.reason || '' });
    } else {
      unlisted.push(diff);
    }
  }
  const unused = intended.changes.filter((entry) => !used.has(entry)).map((entry) => entry.match);
  return { listed, unlisted, unused };
}

/* ------------------------------------------------------------------ route inventory */

const ROUTE_RE = /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|'[^']+'|"[^"]+"|`[^`$]+`)/g;

/** Every literal route path in a hub tree: [{ method, path }] (paths with :params kept). */
export function extractRoutes(tree) {
  const files = [join(tree, 'server.js')];
  for (const dir of ['lib', 'data']) {
    for (const rel of listFiles(join(tree, dir))) if (/\.(js|mjs)$/.test(rel)) files.push(join(tree, dir, ...rel.split('/')));
  }
  const seen = new Map();
  for (const file of files) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(ROUTE_RE)) {
      const method = match[1].toUpperCase();
      const raw = match[2];
      const paths = raw.startsWith('[') ? [...raw.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] || m[2]) : [raw.slice(1, -1)];
      for (const path of paths) {
        if (!path.startsWith('/')) continue;
        seen.set(`${method} ${path}`, { method, path });
      }
    }
  }
  return [...seen.values()].sort((a, b) => (`${a.path} ${a.method}` < `${b.path} ${b.method}` ? -1 : 1));
}

/** A concrete URL path for a route pattern: :params and wildcards become a probe value. */
export function probePath(path) {
  return String(path)
    .replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, 'dark-diff-probe')
    .replace(/\*/g, 'dark-diff-probe')
    .replace(/\{\{[^}]+\}\}/g, 'dark-diff-probe');
}

/* ------------------------------------------------------------------ rollback */

/** Reserved keys (data persisted only under them stays readable by the older release). */
export const RESERVED_SEGMENTS = new Set([
  'ext', 'delivery', 'sitePlan', 'seo', 'seoRecord', 'brandName', 'legalName', 'language',
  'planSource', 'featureSpec', 'cmsSpec', 'contactEmail', 'shopConnectionRev',
  'goLive', 'materials', 'autopilot', 'previewPush', 'plan', 'pricing', 'dpaVersion',
]);

/** Leaf paths of a JSON value: Map(path → canonical leaf). */
export function leaves(value, path = '$', out = new Map()) {
  if (value && typeof value === 'object') {
    const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
    if (!keys.length) out.set(path, canonical(value));
    for (const key of keys) leaves(value[key], Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, out);
    return out;
  }
  out.set(path, canonical(value));
  return out;
}

function underReserved(path) {
  return path.split(/[.[\]]+/).some((segment) => RESERVED_SEGMENTS.has(segment));
}

function byId(value) {
  if (Array.isArray(value)) {
    const ids = value.map((row) => (row && typeof row === 'object' && typeof row.id === 'string' ? row.id : null));
    if (ids.every(Boolean) && new Set(ids).size === ids.length) {
      return Object.fromEntries(value.map((row) => [`id=${row.id}`, byId(row)]));
    }
    return value.map(byId);
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, byId(v)]));
  return value;
}

/**
 * What an older release dropped or changed on newer data. `written` (the data head wrote), `after`
 * (the same data after base ran on it) and `control` (after head ran the same requests on another
 * copy) are { rel: parsedJson }, raw. Arrays of records are matched by their `id` field where they
 * have one, so a reorder or an added record is not a loss.
 *
 * With a control, a field counts as lost only when head keeps it and base does not; a reserved
 * field counts as changed when base leaves it different from head; and any other field counts as
 * changed when head left its value as it was and base did not (an older release that drops a field
 * and then writes it back empty). Times and ids are normalized before values are compared.
 * Without a control, every field of `written` must survive and reserved fields must stay as they
 * were. Returns [{ key, detail }].
 */
export function rollbackLosses(written, after, { scrub, control = null } = {}) {
  const out = [];
  const norm = (leaf) => normalizeString(leaf, scrub || ((s) => s));
  for (const [rel, value] of Object.entries(written)) {
    if (control && !(rel in control)) continue;
    if (!(rel in after)) {
      out.push({ key: `rollback ${rel}`, detail: 'file lost' });
      continue;
    }
    const before = leaves(byId(value));
    const now = leaves(byId(after[rel]));
    const kept = control ? leaves(byId(control[rel])) : null;
    for (const [path, leaf] of before) {
      if (kept && !kept.has(path)) continue;
      const label = normalizeString(`${rel}:${path}`, scrub);
      if (!now.has(path)) {
        out.push({ key: `rollback ${label}`, detail: 'field lost' });
        continue;
      }
      const expected = kept ? kept.get(path) : leaf;
      if (underReserved(path)) {
        if (norm(now.get(path)) !== norm(expected)) out.push({ key: `rollback ${label}`, detail: 'reserved field changed' });
      } else if (kept && norm(expected) === norm(leaf) && norm(now.get(path)) !== norm(leaf)) {
        out.push({ key: `rollback ${label}`, detail: 'value changed' });
      }
    }
  }
  return out;
}
