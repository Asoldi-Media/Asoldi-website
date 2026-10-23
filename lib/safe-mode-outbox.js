/**
 * Safe-mode outbox: every email the hub would send lands here instead.
 *
 *   <dataDir>/outbox/YYYY-MM-DD/<id>.eml        full MIME (attachments inline)
 *   <dataDir>/outbox/YYYY-MM-DD/<id>.body.json  { html, text } for the preview
 *   <dataDir>/outbox/index.jsonl                one metadata line per email
 *
 * Items older than 30 days are deleted (on write, at most once an hour, and on
 * every list). The preview is served from its own path with a short-lived
 * signature (no staff token), a CSP `sandbox` header, no scripts and no remote
 * loads; the admin page shows it in a sandboxed iframe.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

export const OUTBOX_MAX_AGE_DAYS = 30;
const PURGE_EVERY_MS = 60 * 60 * 1000;
const ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PREVIEW_KEY = randomBytes(32);

/** Header for the preview document: sandboxed (opaque origin, no scripts), nothing remote. */
export const OUTBOX_PREVIEW_CSP = [
  'sandbox',
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

let lastPurgeAt = 0;

function clean(value) {
  return String(value ?? '').trim();
}

export function outboxDir(dataDir) {
  return join(dataDir, 'outbox');
}

function indexPath(dataDir) {
  return join(outboxDir(dataDir), 'index.jsonl');
}

export function isOutboxId(id = '') {
  return ID_RE.test(clean(id));
}

function compactStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function addressList(value) {
  if (value === false || value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;]/);
  return list.map((entry) => clean(typeof entry === 'object' ? entry?.address || '' : entry)).filter(Boolean);
}

function attachmentMeta(list = []) {
  return (Array.isArray(list) ? list : []).map((item) => {
    let size = 0;
    if (Buffer.isBuffer(item?.content)) size = item.content.length;
    else if (typeof item?.content === 'string') size = Buffer.byteLength(item.content, item.encoding === 'base64' ? 'base64' : 'utf8');
    return {
      filename: clean(item?.filename) || 'attachment',
      contentType: clean(item?.contentType || item?.content_type),
      size,
    };
  });
}

/** Never let the MIME builder fetch anything: drop href/url attachments. */
function localAttachments(list = []) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && !item.href && !/^https?:/i.test(clean(item.path)))
    .map((item) => ({ ...item }));
}

async function buildMime(message) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix', disableUrlAccess: true });
  const info = await transport.sendMail({
    from: message.from || 'Asoldi <contact@asoldi.com>',
    to: message.to,
    cc: message.cc || undefined,
    bcc: message.bcc || undefined,
    replyTo: message.replyTo || undefined,
    subject: message.subject || '',
    text: message.text || undefined,
    html: message.html || undefined,
    headers: message.headers && typeof message.headers === 'object' ? message.headers : undefined,
    attachments: localAttachments(message.attachments),
    icalEvent: message.icalEvent && typeof message.icalEvent === 'object' && !message.icalEvent.href ? message.icalEvent : undefined,
    disableUrlAccess: true,
    disableFileAccess: false,
  });
  return Buffer.isBuffer(info?.message) ? info.message : Buffer.from(String(info?.message || ''));
}

/**
 * Write one email. `message`: the sendEmail payload (to, subject, text, html, from,
 * replyTo, bcc, attachments, headers, icalEvent). Returns the index entry.
 */
export async function writeOutboxEmail(dataDir, message = {}, { channel = 'email', transport = '', redirectedTo = '', now = new Date() } = {}) {
  const day = now.toISOString().slice(0, 10);
  const id = `${compactStamp(now)}-${randomUUID()}`;
  const dir = join(outboxDir(dataDir), day);
  mkdirSync(dir, { recursive: true });
  let mime;
  try {
    mime = await buildMime(message);
  } catch (error) {
    mime = Buffer.from(`Subject: ${clean(message.subject)}\nX-Outbox-Error: ${clean(error?.message).slice(0, 200)}\n\n${clean(message.text)}`);
  }
  writeFileSync(join(dir, `${id}.eml`), mime);
  writeFileSync(join(dir, `${id}.body.json`), JSON.stringify({ html: message.html || '', text: message.text || '' }));
  const entry = {
    id,
    at: now.toISOString(),
    day,
    channel,
    transport,
    from: clean(message.from),
    to: addressList(message.to),
    bcc: addressList(message.bcc),
    replyTo: clean(message.replyTo),
    subject: clean(message.subject).slice(0, 300),
    size: mime.length,
    hasHtml: Boolean(message.html),
    hasText: Boolean(message.text),
    attachments: attachmentMeta(message.attachments),
    ...(message.icalEvent ? { ics: true } : {}),
    ...(redirectedTo ? { redirectedTo } : {}),
  };
  appendFileSync(indexPath(dataDir), `${JSON.stringify(entry)}\n`, 'utf8');
  if (now.getTime() - lastPurgeAt > PURGE_EVERY_MS) {
    lastPurgeAt = now.getTime();
    purgeExpiredOutbox(dataDir, { now });
  }
  return entry;
}

function readIndex(dataDir) {
  const file = indexPath(dataDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((entry) => entry && isOutboxId(entry.id));
}

/** Delete items older than maxAgeDays: their day folders and index lines. Returns counts. */
export function purgeExpiredOutbox(dataDir, { now = new Date(), maxAgeDays = OUTBOX_MAX_AGE_DAYS } = {}) {
  const root = outboxDir(dataDir);
  if (!existsSync(root)) return { removedDays: 0, removedEntries: 0 };
  const cutoffMs = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
  let removedDays = 0;
  for (const name of readdirSync(root)) {
    if (!DAY_RE.test(name) || name >= cutoffDay) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    removedDays += 1;
  }
  const entries = readIndex(dataDir);
  const keep = entries.filter((entry) => Date.parse(entry.at) >= cutoffMs && clean(entry.day) >= cutoffDay);
  const removedEntries = entries.length - keep.length;
  if (removedEntries > 0) {
    writeFileSync(indexPath(dataDir), keep.map((entry) => JSON.stringify(entry)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
  }
  return { removedDays, removedEntries };
}

export function listOutbox(dataDir, { limit = 50, now = new Date() } = {}) {
  purgeExpiredOutbox(dataDir, { now });
  const entries = readIndex(dataDir);
  const max = Math.max(1, Math.min(500, Number(limit) || 50));
  return { total: entries.length, items: entries.slice(-max).reverse() };
}

export function readOutboxItem(dataDir, id = '') {
  if (!isOutboxId(id)) return null;
  const entry = readIndex(dataDir).find((item) => item.id === id);
  if (!entry || !DAY_RE.test(clean(entry.day))) return null;
  const dir = join(outboxDir(dataDir), entry.day);
  let body = { html: '', text: '' };
  try {
    body = JSON.parse(readFileSync(join(dir, `${id}.body.json`), 'utf8'));
  } catch {
    // body missing: preview falls back to empty
  }
  const emlPath = join(dir, `${id}.eml`);
  return { ...entry, html: clean(body.html) ? String(body.html) : '', text: String(body.text || ''), emlPath: existsSync(emlPath) ? emlPath : '' };
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** Document served to the sandboxed iframe. The CSP header does the isolation; this adds a meta copy. */
export function outboxPreviewDocument(item) {
  const meta = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(OUTBOX_PREVIEW_CSP.replace(/^sandbox; /, ''))}">`;
  if (item?.html) {
    if (/<head[^>]*>/i.test(item.html)) return item.html.replace(/<head[^>]*>/i, (head) => `${head}${meta}`);
    return `<!doctype html><html><head>${meta}</head><body>${item.html}</body></html>`;
  }
  return `<!doctype html><html><head>${meta}<style>body{font:14px/1.5 system-ui,sans-serif;margin:16px;white-space:pre-wrap}</style></head><body>${escapeHtml(item?.text || '(empty email)')}</body></html>`;
}

function previewSignature(id, exp) {
  return createHmac('sha256', PREVIEW_KEY).update(`${id}.${exp}`).digest('base64url');
}

/** Short-lived preview path (no staff token in the URL). */
export function signedPreviewPath(id, { now = Date.now(), ttlMs = PREVIEW_TTL_MS } = {}) {
  const exp = String(now + ttlMs);
  return `/api/safe-mode/outbox-preview/${encodeURIComponent(id)}?exp=${exp}&sig=${previewSignature(id, exp)}`;
}

export function verifyPreviewSignature(id, exp, sig, { now = Date.now() } = {}) {
  if (!isOutboxId(id)) return false;
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < now || expMs > now + PREVIEW_TTL_MS + 60_000) return false;
  const expected = Buffer.from(previewSignature(id, String(exp)));
  const given = Buffer.from(clean(sig));
  return expected.length === given.length && timingSafeEqual(expected, given);
}
