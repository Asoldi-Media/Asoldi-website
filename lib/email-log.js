/**
 * Hub email log (WS7.1): append-only monthly JSONL, an in-memory index, rollups.
 *
 * Files under <dataDir>/email-log/ (monthly, because Hostinger caps the file count):
 * - messages-YYYYMM.jsonl: one line per send attempt that reached Brevo or the outbox.
 * - events-YYYYMM.jsonl:   Brevo webhook events, queued in memory and flushed every 10 s
 *                          in one append (a campaign burst costs one small write).
 * - rollup.json:           per-month, per-site counters for months outside the index window.
 *
 * Lines are whitelisted: no plain recipient address, no HTML, no secrets.
 * The index covers the last 4 months plus the next one. It is rebuilt on boot
 * and whenever that window moves, and it tails every file in the window on each
 * query, so two hub workers see each other's appends. Month files are deleted
 * once the month ended more than 400 days ago (plan 3.5); rollups stay.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { getPersistentDataDir } from '../data/storage-path.js';
import { readJsonFile, writeJsonFileAtomic } from '../data/email-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const EVENT_TYPES = Object.freeze([
  'delivered',
  'opened',
  'click',
  'hardBounce',
  'softBounce',
  'blocked',
  'spam',
  'invalid',
  'unsubscribed',
]);
const EVENT_SET = new Set(EVENT_TYPES);
const MESSAGE_STATUSES = new Set(['accepted', 'outbox', 'failed', 'rejected', 'sandbox']);
const FILE_RE = /^(messages|events)-(\d{6})\.jsonl$/;
const COUNTER_KEYS = ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'unsubscribed', 'complaints', 'blocked'];

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizeEmailAddress(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function hashEmail(email) {
  const normalized = normalizeEmailAddress(email);
  if (!normalized) return '';
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

export function maskEmail(email) {
  const normalized = normalizeEmailAddress(email);
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return normalized ? '***' : '';
  return `${normalized[0]}***${normalized.slice(at)}`;
}

/** Time-sortable message id: em_<base36 ms><8 hex>. */
export function newMessageId(now = Date.now()) {
  return `em_${Number(now).toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`;
}

export function monthKey(input) {
  const date = new Date(typeof input === 'number' ? input : Date.parse(String(input || '')) || Date.now());
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthsBack(now, count) {
  const date = new Date(now);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * The months the index covers at `now`, oldest first: the last `count` months plus
 * the next one, so a worker whose clock is a little behind still sees a file another
 * worker already started for the new month.
 */
export function indexWindow(now, count) {
  const date = new Date(now);
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return [...monthsBack(next.getTime(), count + 1)].reverse();
}

/** Ms timestamp of the last moment of month YYYYMM (UTC). */
function monthEndMs(month) {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(4, 6));
  return Date.UTC(year, index, 1) - 1;
}

function sanitizeConsent(consent) {
  if (!consent || typeof consent !== 'object') return null;
  return {
    basis: text(consent.basis, 40),
    scope: text(consent.scope, 40),
    grade: text(consent.grade, 40),
    textHash: text(consent.textHash, 80),
  };
}

/** Whitelist a message line. A plain `to`/`email` becomes toHash + toMasked and is dropped. */
export function sanitizeMessageRow(row = {}, now = Date.now()) {
  const plain = normalizeEmailAddress(row.to?.email ?? row.to ?? row.email ?? '');
  const createdAt = text(row.createdAt, 40) || new Date(now).toISOString();
  const status = MESSAGE_STATUSES.has(row.status) ? row.status : 'accepted';
  const step = Number.isFinite(Number(row.step)) ? Number(row.step) : null;
  return {
    id: text(row.id, 60) || newMessageId(now),
    siteId: text(row.siteId, 80),
    kind: text(row.kind, 60),
    cls: text(row.cls, 10),
    ref: text(row.ref, 120),
    step,
    campaignId: row.campaignId ? text(row.campaignId, 80) : null,
    dedupeKey: text(row.dedupeKey, 300),
    toHash: text(row.toHash, 80) || hashEmail(plain),
    toMasked: text(row.toMasked, 120) || maskEmail(plain),
    provider: text(row.provider, 20),
    providerMessageId: text(row.providerMessageId, 200),
    status,
    consent: sanitizeConsent(row.consent),
    test: row.test === true,
    error: row.error ? text(row.error, 80) : '',
    createdAt,
  };
}

export function sanitizeEventRow(row = {}, now = Date.now()) {
  const t = text(row.t || row.type || row.event, 40);
  if (!EVENT_SET.has(t)) return null;
  return {
    messageId: text(row.messageId, 60),
    t,
    at: text(row.at, 40) || new Date(now).toISOString(),
    siteId: text(row.siteId, 80),
  };
}

function emptyCounters() {
  return Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0]));
}

function eventCounterKey(t) {
  if (t === 'delivered') return 'delivered';
  if (t === 'opened') return 'opened';
  if (t === 'click') return 'clicked';
  if (t === 'hardBounce' || t === 'softBounce' || t === 'invalid') return 'bounced';
  if (t === 'blocked') return 'blocked';
  if (t === 'spam') return 'complaints';
  if (t === 'unsubscribed') return 'unsubscribed';
  return '';
}

function emptyIndex() {
  return {
    builtAt: 0,
    months: [],
    messages: new Map(),
    dedupe: new Map(),
    sites: new Map(),
    offsets: new Map(),
  };
}

function siteCounters(index, siteId) {
  const key = siteId || '';
  if (!index.sites.has(key)) index.sites.set(key, emptyCounters());
  return index.sites.get(key);
}

function applyMessage(index, row, dedupeCutoff) {
  if (!row || !row.id) return;
  if (index.messages.has(row.id)) return;
  const createdMs = Date.parse(row.createdAt) || 0;
  index.messages.set(row.id, {
    siteId: row.siteId || '',
    kind: row.kind || '',
    ref: row.ref || '',
    step: row.step ?? null,
    campaignId: row.campaignId || null,
    status: row.status || '',
    createdMs,
    flags: new Set(),
  });
  if (row.status !== 'failed' && row.status !== 'rejected') siteCounters(index, row.siteId).sent += 1;
  if (row.dedupeKey && row.status !== 'failed' && row.status !== 'rejected' && createdMs >= dedupeCutoff) {
    index.dedupe.set(row.dedupeKey, createdMs);
  }
}

function applyEvent(index, row) {
  if (!row) return;
  const message = index.messages.get(row.messageId);
  const key = eventCounterKey(row.t);
  if (!key || !message) return;
  // Unique per message, so opens and clicks are rates, not raw hit counts.
  if (message.flags.has(key)) return;
  message.flags.add(key);
  siteCounters(index, message.siteId)[key] += 1;
}

/** Read whole lines appended after `offset`. A torn last line is left for the next read. */
function readNewLines(path, offset) {
  if (!existsSync(path)) return { lines: [], offset: 0 };
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { lines: [], offset: size < offset ? 0 : offset };
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    const lastNewline = buffer.lastIndexOf(0x0a, read - 1);
    if (lastNewline < 0) return { lines: [], offset };
    const chunk = buffer.subarray(0, lastNewline).toString('utf8');
    return { lines: chunk.split('\n'), offset: offset + lastNewline + 1 };
  } finally {
    closeSync(fd);
  }
}

function parseLine(line) {
  if (!line || !line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function createEmailLog({
  dir = () => join(getPersistentDataDir(), 'email-log'),
  now = () => Date.now(),
  flushMs = 10_000,
  indexMonths = 4,
  // Plan 3.5 keeps the hub message log for 400 days as evidence.
  keepDays = 400,
  dedupeDays = 90,
} = {}) {
  const resolveDir = () => {
    const value = typeof dir === 'function' ? dir() : dir;
    mkdirSync(value, { recursive: true });
    return value;
  };
  let index = null;
  let queue = [];
  let timer = null;

  const fileFor = (kind, month) => join(resolveDir(), `${kind}-${month}.jsonl`);
  const dedupeCutoff = () => now() - dedupeDays * DAY_MS;

  function tailFile(idx, kind, month) {
    const path = fileFor(kind, month);
    const key = `${kind}-${month}`;
    const { lines, offset } = readNewLines(path, idx.offsets.get(key) || 0);
    idx.offsets.set(key, offset);
    const cutoff = dedupeCutoff();
    for (const line of lines) {
      const row = parseLine(line);
      if (!row) continue;
      if (kind === 'messages') applyMessage(idx, row, cutoff);
      else applyEvent(idx, row);
    }
  }

  /** Rebuild from the monthly files in the index window (boot, and whenever the window moves). */
  function rebuildIndex() {
    const idx = emptyIndex();
    idx.months = indexWindow(now(), indexMonths);
    for (const month of idx.months) tailFile(idx, 'messages', month);
    for (const month of idx.months) tailFile(idx, 'events', month);
    idx.builtAt = now();
    index = idx;
    return index;
  }

  /**
   * Pick up lines other processes appended since the last read. The window is
   * recomputed every time: when it moved (a new month, even after a whole month
   * without a query), the index is rebuilt, so months that left the window are
   * evicted and the counters match a fresh boot exactly.
   */
  function refresh() {
    if (!index) return rebuildIndex();
    const window = indexWindow(now(), indexMonths);
    if (window.join(',') !== index.months.join(',')) return rebuildIndex();
    for (const month of index.months) tailFile(index, 'messages', month);
    for (const month of index.months) tailFile(index, 'events', month);
    const cutoff = dedupeCutoff();
    for (const [key, at] of index.dedupe) if (at < cutoff) index.dedupe.delete(key);
    return index;
  }

  function readIndex() {
    return refresh();
  }

  /**
   * Lines are filed by the time of the append, not by the row's createdAt: the
   * current month is always in every worker's window, so a skewed or back-dated
   * createdAt can never hide a dedupe key.
   */
  function appendMessage(row) {
    const t = now();
    const clean = sanitizeMessageRow(row, t);
    if (!clean.siteId || !clean.kind) throw new Error('appendMessage: siteId and kind are required');
    appendFileSync(fileFor('messages', monthKey(t)), `${JSON.stringify(clean)}\n`, 'utf8');
    refresh();
    return clean;
  }

  function hasDedupeKey(key) {
    if (!key) return false;
    return refresh().dedupe.has(String(key));
  }

  function appendEvent(row) {
    const clean = sanitizeEventRow(row, now());
    if (!clean) return null;
    queue.push(clean);
    if (flushMs > 0 && !timer) {
      timer = setInterval(() => {
        try {
          flushEvents();
        } catch (error) {
          console.error('[email-log] flush failed', error?.code || error?.message || error);
        }
      }, flushMs);
      timer.unref?.();
    }
    return clean;
  }

  /** One append per month file for the whole queued batch. */
  function flushEvents() {
    if (!queue.length) return 0;
    const batch = queue;
    queue = [];
    const byMonth = new Map();
    const t = now();
    const window = new Set(indexWindow(t, indexMonths));
    for (const row of batch) {
      // Filed by event time (rollups count a month's events with its messages), unless that
      // month is outside the index window: then by now, so the event is never invisible.
      const eventMonth = monthKey(row.at);
      const month = window.has(eventMonth) ? eventMonth : monthKey(t);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(JSON.stringify(row));
    }
    try {
      for (const [month, lines] of byMonth) appendFileSync(fileFor('events', month), `${lines.join('\n')}\n`, 'utf8');
    } catch (error) {
      queue = batch.concat(queue);
      throw error;
    }
    refresh();
    return batch.length;
  }

  function pendingEvents() {
    return queue.length;
  }

  /** Counters per ref and in total, filtered by site and optionally kind, campaign, refs, time. */
  function statsFor({ siteId = '', kind = '', campaignId = '', refs = [], from = '', to = '' } = {}) {
    const idx = refresh();
    const refSet = new Set((Array.isArray(refs) ? refs : String(refs || '').split(',')).map((r) => String(r).trim()).filter(Boolean));
    const fromMs = from ? Date.parse(from) || 0 : 0;
    const toMs = to ? Date.parse(to) || Infinity : Infinity;
    const byRef = {};
    const totals = emptyCounters();
    for (const message of idx.messages.values()) {
      if (siteId && message.siteId !== siteId) continue;
      if (kind && message.kind !== kind) continue;
      if (campaignId && message.campaignId !== campaignId) continue;
      if (refSet.size && !refSet.has(message.ref)) continue;
      if (message.createdMs < fromMs || message.createdMs > toMs) continue;
      if (message.status === 'failed' || message.status === 'rejected') continue;
      const row = (byRef[message.ref || ''] ||= emptyCounters());
      row.sent += 1;
      totals.sent += 1;
      for (const flag of message.flags) {
        row[flag] += 1;
        totals[flag] += 1;
      }
    }
    return { byRef, totals };
  }

  function siteTotals(siteId) {
    const idx = refresh();
    return { ...(idx.sites.get(String(siteId || '')) || emptyCounters()) };
  }

  function listMonthFiles() {
    const out = [];
    for (const name of readdirSync(resolveDir())) {
      const match = name.match(FILE_RE);
      if (match) out.push({ name, kind: match[1], month: match[2] });
    }
    return out;
  }

  function rollupMonth(month) {
    const idx = emptyIndex();
    tailFile(idx, 'messages', month);
    tailFile(idx, 'events', month);
    const sites = {};
    for (const [siteId, counters] of idx.sites) sites[siteId] = counters;
    return { sites, messages: idx.messages.size };
  }

  function readRollups() {
    const raw = readJsonFile(join(resolveDir(), 'rollup.json'), { months: {} });
    return raw && typeof raw === 'object' && raw.months && typeof raw.months === 'object' ? raw : { months: {} };
  }

  /**
   * Months outside the index window get a rollup. A month file is deleted only
   * when the month's last day is more than keepDays (400) old, so every line is
   * kept at least 400 days; the rollup stays.
   */
  function pruneLogs(at = now()) {
    const window = new Set(indexWindow(at, indexMonths));
    const keepAfter = at - keepDays * DAY_MS;
    const rollups = readRollups();
    let rolledUp = 0;
    let removed = 0;
    const months = [...new Set(listMonthFiles().map((file) => file.month))].sort();
    for (const month of months) {
      if (!window.has(month) && !rollups.months[month]) {
        rollups.months[month] = rollupMonth(month);
        rolledUp += 1;
      }
    }
    if (rolledUp) writeJsonFileAtomic(join(resolveDir(), 'rollup.json'), rollups);
    for (const file of listMonthFiles()) {
      if (monthEndMs(file.month) >= keepAfter) continue;
      try {
        unlinkSync(join(resolveDir(), file.name));
        removed += 1;
      } catch {
        // retried on the next prune
      }
      if (index) index.offsets.delete(`${file.kind}-${file.month}`);
    }
    return { removed, rolledUp };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return flushEvents();
  }

  return {
    appendMessage,
    appendEvent,
    flushEvents,
    pendingEvents,
    readIndex,
    rebuildIndex,
    refresh,
    hasDedupeKey,
    statsFor,
    siteTotals,
    pruneLogs,
    readRollups,
    stop,
  };
}

let defaultLog = null;
function log() {
  if (!defaultLog) defaultLog = createEmailLog();
  return defaultLog;
}

export const appendMessage = (row) => log().appendMessage(row);
export const appendEvent = (row) => log().appendEvent(row);
export const flushEvents = () => log().flushEvents();
export const readIndex = () => log().readIndex();
export const hasDedupeKey = (key) => log().hasDedupeKey(key);
export const statsFor = (query) => log().statsFor(query);
export const pruneLogs = (at) => log().pruneLogs(at);
export const stopEmailLog = () => (defaultLog ? defaultLog.stop() : 0);
