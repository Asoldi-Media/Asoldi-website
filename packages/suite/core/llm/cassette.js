// Replay cassettes: a stable key per request and a secret-free record of the response.
// The key ignores what changes between otherwise identical runs (dates, timestamps, UUIDs, run ids),
// so a replay run is deterministic. Reading and writing files is the facade's job.

import { createHash } from 'node:crypto';

export const CASSETTE_VERSION = 1;

const VOLATILE = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<datetime>'],
  [/\b\d{4}-\d{2}-\d{2}\b/g, '<date>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b1[5-9]\d{11}\b/g, '<epoch-ms>'],
  [/\brun[_-]?[0-9a-z]{6,}\b/gi, '<run-id>'],
];

/** Text with dates, timestamps, UUIDs, epoch-ms values and run ids replaced by placeholders. */
export function normalizeForReplay(text = '') {
  let out = String(text ?? '');
  for (const [pattern, placeholder] of VOLATILE) out = out.replace(pattern, placeholder);
  return out;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** JSON with object keys sorted, so key order never changes a hash. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function imageDigest(image = {}) {
  if (image.url) return `url:${image.url}`;
  const data = Buffer.isBuffer(image.buffer) ? image.buffer : image.base64 ? String(image.base64).replace(/\s+/g, '') : '';
  return `sha256:${sha256(data)}`;
}

function messagesDigest(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const content = typeof message?.content === 'string' ? normalizeForReplay(message.content) : (message?.content || []).map((block) => {
      if (block?.type === 'text') return { type: 'text', text: normalizeForReplay(block.text) };
      if (block?.type === 'image') return { type: 'image', digest: sha256(canonicalJson(block.source || {})) };
      return block;
    });
    return { role: message?.role, content };
  });
}

/**
 * Replay key = sha256(task | system | user | messages | image hashes | schema | tools), with volatile values
 * normalized. The model is stored in the record, not the key, so the replay profile (route replay:strict)
 * finds cassettes recorded under any route. Pass includeModel:true to key by model as well.
 */
export function cassetteKey({ task = '', model = '', system = '', user = '', messages = null, images = [], schema = null, tools = null, includeModel = false } = {}) {
  const parts = {
    v: CASSETTE_VERSION,
    task: String(task),
    model: includeModel ? String(model) : undefined,
    system: normalizeForReplay(Array.isArray(system) ? system.map((b) => b?.text || '').join('\n') : system),
    user: normalizeForReplay(user),
    messages: messages ? messagesDigest(messages) : null,
    images: (Array.isArray(images) ? images : []).map(imageDigest),
    schema: schema || null,
    tools: tools || null,
  };
  return sha256(canonicalJson(parts));
}

/** Relative cassette path: `<scope>/<key>.json`. Scope is a short folder name (run kind, fixture id). */
export function cassettePath(scope, key) {
  const safeScope = String(scope || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
  if (!/^[0-9a-f]{64}$/.test(String(key))) throw new Error('cassette key must be a sha256 hex string');
  return `${safeScope}/${key}.json`;
}

const SECRET_KEY = /^(?:api[-_]?key|x-api-key|authorization|auth|token|access[-_]?token|secret|password|cookie|set-cookie)$/i;
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._-]{10,})/g;

/** Deep copy with secret-looking keys removed and key-looking values masked. For transport and metadata. */
export function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = scrubSecrets(child);
    }
    return out;
  }
  return maskSecretValues(value);
}

/**
 * Deep copy with key-looking values masked and every key kept. For model output (text, JSON data, content
 * blocks, tool inputs): a field named "password" in a form spec is data, and replay must return it as recorded.
 */
export function maskSecretValues(value) {
  if (Array.isArray(value)) return value.map(maskSecretValues);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = maskSecretValues(child);
    return out;
  }
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '<redacted>');
  return value;
}

/** The record a facade writes for one call (record profile) and reads back (replay profile). */
export function cassetteRecord({ key, task = '', provider = '', model = '', response = {}, recordedAt = new Date().toISOString() } = {}) {
  return {
    v: CASSETTE_VERSION,
    key: String(key),
    task: String(task),
    provider: String(provider),
    model: String(model),
    recordedAt: String(recordedAt),
    response: {
      servedModel: String(response.servedModel || model),
      text: maskSecretValues(response.text ?? ''),
      data: maskSecretValues(response.data),
      content: maskSecretValues(response.content),
      stopReason: String(response.stopReason || 'end_turn'),
      usage: scrubSecrets(response.usage || {}),
    },
  };
}
