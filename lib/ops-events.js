// Decision log for the inbox bot and the Fireflies live join: what was decided, what Google, Fireflies
// and the mailer answered, and how long it took. One JSON line per event in
// <dataDir>/ops-events/<YYYY-MM>.jsonl, kept 90 days. Ids, reasons, timings and results only: no mail
// bodies, no secrets. Writing never throws and never blocks the caller's work.
import fs from 'node:fs';
import path from 'node:path';
import { getPersistentDataDir } from '../data/storage-path.js';

export const OPS_EVENTS_KEEP_DAYS = 90;
const DAY_MS = 86400000;
const MAX_STRING = 300;
const DROPPED_KEYS = new Set(['text', 'body', 'html', 'reply', 'replyText', 'raw', 'password', 'token', 'apiKey']);

let lastPrunedMonth = '';

export function opsEventsDir() {
  return path.join(getPersistentDataDir(), 'ops-events');
}

function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

function clean(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth > 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => clean(entry, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (DROPPED_KEYS.has(key)) continue;
      const cleaned = clean(entry, depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return undefined;
}

function pruneOld(dir, nowMs) {
  const month = monthKey(nowMs);
  if (lastPrunedMonth === month) return;
  lastPrunedMonth = month;
  const oldest = monthKey(nowMs - OPS_EVENTS_KEEP_DAYS * DAY_MS);
  for (const name of fs.readdirSync(dir)) {
    const match = /^(\d{4}-\d{2})\.jsonl$/.exec(name);
    if (match && match[1] < oldest) fs.rmSync(path.join(dir, name), { force: true });
  }
}

/** Append one event. `system` is 'inbox' or 'fireflies'; `type` like 'mail.decided' or 'bot.sent'. */
export function recordOpsEvent(system, type, data = {}, { nowMs = Date.now() } = {}) {
  try {
    const dir = opsEventsDir();
    fs.mkdirSync(dir, { recursive: true });
    pruneOld(dir, nowMs);
    const row = { at: new Date(nowMs).toISOString(), system: String(system || ''), type: String(type || ''), ...clean(data) };
    fs.appendFileSync(path.join(dir, `${monthKey(nowMs)}.jsonl`), `${JSON.stringify(row)}\n`);
    return row;
  } catch {
    return null;
  }
}

/** Events in [sinceMs, untilMs], oldest first; optionally one system. Unreadable lines are skipped. */
export function readOpsEvents({ system = '', sinceMs = 0, untilMs = Date.now() } = {}) {
  const dir = opsEventsDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  } catch {
    return [];
  }
  const from = monthKey(Math.max(0, sinceMs));
  const to = monthKey(untilMs);
  const rows = [];
  for (const name of names) {
    const month = name.slice(0, 7);
    if (month < from || month > to) continue;
    let content = '';
    try {
      content = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const ms = Date.parse(row.at);
      if (!(ms >= sinceMs && ms <= untilMs)) continue;
      if (system && row.system !== system) continue;
      rows.push(row);
    }
  }
  return rows;
}
