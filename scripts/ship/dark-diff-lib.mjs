// Pure helpers for scripts/ship/dark-diff.mjs: normalization, data and secret snapshots, diffs,
// the intended-changes file and the route inventory. Nothing here starts a process or opens a port.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  // Prefixed random ids: sc_lq3x9abc12, mh_1a2b3c4d, offer-k2j3h4g5.
  [/\b([a-z]{1,16})([_-])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}(?![a-z0-9])/gi, '$1$2<id>'],
  // A random suffix after a time stamp: <ms>-3itwo2, offer-<ms>-x57q34.
  [/(<ms>|<time>)([_-])[a-z0-9]{4,16}(?![a-z0-9])/gi, '$1$2<id>'],
  // More random parts after an id: mem_<id>_72131615.
  [/<id>(?:[_-][a-z0-9]{4,16}(?![a-z0-9]))+/gi, '<id>'],
  // Long base64url tokens (signed links, session tokens).
  [/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{32,})(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, '<token>'],
];

const TIME_KEY = /(?:^|[a-z_])(?:at|At|AT|time|Time|ts|Ts|date|Date|exp|iat|nbf|ms|Ms|mtime|mtimeMs|expires|Expires|until|Until|since|Since|stamp|Stamp)$/;
const CODE_KEY = /^(?:code|websiteCode|portalCode|inviteCode|shortCode|offerCode)$/;
const CODE_VALUE = /^[A-Z0-9]{3,10}$/;
const VOLATILE_KEY = /^(?:uptime|elapsed|elapsedMs|durationMs|duration|ms|tookMs|pid|ppid|port|memory|rss|heapUsed|heapTotal)$/i;

/**
 * Replaces the temp paths and ports of one run, so two runs read alike. scrub.learn(value) adds a
 * random short code seen under a code key (offer codes and the like): it is replaced wherever it
 * shows up later in that run (mail text, data files).
 */
export function makeTextScrubber(replacements = []) {
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
  return scrub;
}

export function normalizeString(value, scrub = (s) => s) {
  let out = scrub(String(value));
  for (const [pattern, replacement] of STRING_RULES) out = out.replace(pattern, replacement);
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
    if (TIME_KEY.test(key) || looksLikeEpochMs(value)) return '<ms>';
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
  const out = {};
  const entries = Object.entries(value).map(([k, v]) => [normalizeString(k, scrub), k, v]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [nk, k, v] of entries) {
    const next = normalizeValue(v, { scrub, keepOrder, key: k });
    if (Object.hasOwn(out, nk)) {
      // Two keys that normalize alike (two random ids): keep both, in a stable order.
      let i = 2;
      while (Object.hasOwn(out, `${nk}#${i}`)) i += 1;
      out[`${nk}#${i}`] = next;
    } else {
      out[nk] = next;
    }
  }
  // Keys that collided are re-sorted by content so their order does not depend on the ids.
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

/**
 * What an older release dropped or changed after booting on newer data. `written` and `after` are
 * { rel: parsedJson } (raw, not normalized). Arrays of records are matched by their `id` field
 * where they have one, so a reorder is not a loss. Returns [{ key, detail }].
 */
export function rollbackLosses(written, after, { scrub } = {}) {
  const out = [];
  const byId = (value) => {
    if (Array.isArray(value)) {
      const ids = value.map((row) => (row && typeof row === 'object' && typeof row.id === 'string' ? row.id : null));
      if (ids.every(Boolean) && new Set(ids).size === ids.length) {
        return Object.fromEntries(value.map((row) => [`id=${row.id}`, byId(row)]));
      }
      return value.map(byId);
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, byId(v)]));
    return value;
  };
  for (const [rel, value] of Object.entries(written)) {
    if (!(rel in after)) {
      out.push({ key: `rollback ${rel}`, detail: 'file lost' });
      continue;
    }
    const before = leaves(byId(value));
    const now = leaves(byId(after[rel]));
    for (const [path, leaf] of before) {
      const label = normalizeString(`${rel}:${path}`, scrub);
      if (!now.has(path)) out.push({ key: `rollback ${label}`, detail: 'field lost' });
      else if (underReserved(path) && now.get(path) !== leaf) out.push({ key: `rollback ${label}`, detail: 'reserved field changed' });
    }
  }
  return out;
}
