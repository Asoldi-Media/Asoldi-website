/**
 * Maker access log (WS8.25): one JSON line per Maker request for a client's data (brief,
 * transcripts, run linking), allowed or refused. Ids only: host, client, run, kind, reason and
 * a time. Never a body, a transcript, a name or a token.
 *
 * <dataDir>/maker-access-log/<YYYY-MM>.jsonl, one file per month (append only, mode 0600).
 * Files older than keepMonths (default 12) are dropped the first time a new month is written.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getPersistentDataDir } from '../data/storage-path.js';

export const MAKER_ACCESS_LOG_DIR = 'maker-access-log';
export const MAKER_ACCESS_LOG_KEEP_MONTHS = 12;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const KIND_RE = /^[a-z][a-z0-9.-]{0,39}$/;
const FILE_RE = /^(\d{4})-(\d{2})\.jsonl$/;

function cleanId(value) {
  const id = String(value ?? '').trim();
  return ID_RE.test(id) ? id : '';
}

function monthOf(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

export function makerAccessLogDir(dataDir) {
  return join(dataDir || getPersistentDataDir(), MAKER_ACCESS_LOG_DIR);
}

const prunedMonths = new Set();

/** Drops month files older than keepMonths before `now`'s month. Returns the names removed. */
export function pruneMakerAccessLog({ dataDir, keepMonths = MAKER_ACCESS_LOG_KEEP_MONTHS, now = Date.now() } = {}) {
  const dir = makerAccessLogDir(dataDir);
  if (!existsSync(dir)) return [];
  const current = new Date(now);
  const cutoff = current.getUTCFullYear() * 12 + current.getUTCMonth() - keepMonths;
  const removed = [];
  for (const name of readdirSync(dir)) {
    const match = FILE_RE.exec(name);
    if (!match) continue;
    const index = Number(match[1]) * 12 + Number(match[2]) - 1;
    if (index >= cutoff) continue;
    try {
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch {
      // Next month tries again.
    }
  }
  return removed;
}

/**
 * Appends one access row. entry: { hostId, clientId, kind, allowed, reason?, runId?, ref? }.
 * Never throws (a failed log line must not fail the request); returns the row written or null.
 */
export function appendMakerAccess(entry = {}, { dataDir, now = Date.now(), keepMonths } = {}) {
  const kind = String(entry.kind ?? '').trim();
  const row = {
    at: new Date(now).toISOString(),
    hostId: cleanId(entry.hostId) || null,
    clientId: cleanId(entry.clientId) || null,
    kind: KIND_RE.test(kind) ? kind : 'other',
    allowed: entry.allowed === true,
  };
  const reason = String(entry.reason ?? '').trim();
  if (reason && KIND_RE.test(reason)) row.reason = reason;
  const runId = cleanId(entry.runId);
  if (runId) row.runId = runId;
  const ref = cleanId(entry.ref);
  if (ref) row.ref = ref;
  try {
    const dir = makerAccessLogDir(dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const month = monthOf(now);
    const pruneKey = `${dir}|${month}`;
    if (!prunedMonths.has(pruneKey)) {
      prunedMonths.add(pruneKey);
      pruneMakerAccessLog({ dataDir, keepMonths, now });
    }
    appendFileSync(join(dir, `${month}.jsonl`), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return row;
  } catch (error) {
    console.error(`[maker-access-log] could not append: ${error?.code || error?.message || 'error'}`);
    return null;
  }
}

/** Newest rows first, from the newest month files. Filters: hostId, clientId. */
export function readMakerAccessLog({ dataDir, limit = 200, hostId = '', clientId = '' } = {}) {
  const dir = makerAccessLogDir(dataDir);
  if (!existsSync(dir)) return [];
  const max = Math.max(1, Math.min(Number(limit) || 200, 2000));
  const files = readdirSync(dir).filter((name) => FILE_RE.test(name)).sort().reverse();
  const rows = [];
  for (const name of files) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (hostId && row.hostId !== hostId) continue;
      if (clientId && row.clientId !== clientId) continue;
      rows.push(row);
      if (rows.length >= max) return rows;
    }
  }
  return rows;
}

export function resetMakerAccessLogMemoForTests() {
  prunedMonths.clear();
}
