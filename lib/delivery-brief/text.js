// Small shared helpers for the delivery brief: hashing, canonical JSON, word tokens and similarity.
import { createHash } from 'node:crypto';

export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export function text(value, max = 0) {
  const out = String(value ?? '').trim();
  return max > 0 ? out.slice(0, max) : out;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/** JSON with object keys sorted at every level; undefined values dropped (as JSON.stringify does). */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonicalize(item)));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = canonicalize(value[key]);
  }
  return out;
}

export function hashOf(value) {
  return `sha256:${sha256(canonicalJson(value))}`;
}

/** Whitespace collapsed, case folded, Unicode NFC; diacritics are kept (å stays å). */
export function normalizeSpace(value) {
  return String(value ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const WORD_RE = /[\p{L}\p{N}]+/gu;

/** Lowercase word tokens (letters and digits, diacritics kept). */
export function wordTokens(value) {
  return String(value ?? '').normalize('NFC').toLowerCase().match(WORD_RE) || [];
}

export function tokenSet(value) {
  return new Set(wordTokens(value));
}

/** Jaccard similarity of two token sets (1 for two empty sets). */
export function jaccard(a, b) {
  const left = a instanceof Set ? a : tokenSet(a);
  const right = b instanceof Set ? b : tokenSet(b);
  if (!left.size && !right.size) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function shortId(prefix, ...parts) {
  return `${prefix}-${sha256(parts.map((part) => String(part ?? '')).join('\u0001')).slice(0, 12)}`;
}

export function isoOrEmpty(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}
