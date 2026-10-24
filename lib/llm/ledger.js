/**
 * Hub AI ledger (v2 rows from the shared core), spend lookups for budgets, and the Maker's run spend.
 *
 *   <dataDir>/ai/ledger-YYYY-MM.jsonl   one row per provider attempt (append-only, UTC month of row.at);
 *                                       kept for this month and the 12 before it (pruneLedgers)
 *   <dataDir>/ai/spend-summary.json     today / this month totals, rewritten after each row
 *   <dataDir>/ai/alerts-YYYY-MM.jsonl   budget alerts, one per budget and UTC day (alertKey: the hub day
 *                                       cap once, clientMonth per client, scaled scopes per run or session;
 *                                       work continues; only a runaway or loop stops)
 *   <dataDir>/ai/maker-spend.json       the Maker's run.ai.spend snapshots per client and run
 *
 * Several hub processes may share one data dir. The ledger file is the only record: every total
 * (summary(), spentUsd() for budgets, spend-summary.json) is built from the file as it is on disk. Each
 * process keeps a running total and reads on from the last byte it has counted whenever the file grew,
 * so rows another process appended are counted too. spend-summary.json is written under a file lock
 * from those totals, and alerts are read back from their file.
 *
 * The ledger never breaks a call: write errors are swallowed by the callers and logged once here.
 *
 * Retention: pruneLedgers() deletes ledger-YYYY-MM.jsonl files older than this month and the 12 before
 * it (LEDGER_KEEP_MONTHS), counted by the ledger clock alone, never by the month of a row: a row dated
 * in a later month must not move the window and delete this month's file. This month and last month
 * are never deleted, and files whose name is not a ledger month are left alone. append() runs it once
 * per month of the clock in each process; an error there never breaks the call.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readLedgerRow, summarizeLedger } from '../../packages/suite/core/llm/index.js';
import { readJsonFresh, updateJsonLocked, withFileLock, writeJsonAtomic } from '../../data/atomic-json.js';

const LEDGER_RE = /^ledger-(\d{4})-(\d{2})\.jsonl$/;
const MAX_RECENT_ALERTS = 50;
const MAX_MAKER_RUNS_PER_CLIENT = 50;
const READ_CHUNK = 1 << 20;
/** Ledger months kept: this month by the ledger clock and the 12 before it. */
export const LEDGER_KEEP_MONTHS = 13;

function round(value) {
  return Math.round((Number(value) || 0) * 1e10) / 1e10;
}

function monthKey(iso) {
  return String(iso || '').slice(0, 7);
}

function dayKey(iso) {
  return String(iso || '').slice(0, 10);
}

/** 'YYYY-MM' `delta` months from the UTC month of `date`. */
function shiftMonth(date, delta) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1)).toISOString().slice(0, 7);
}

function emptyAggregate(month) {
  return { month, offset: 0, totalUsd: 0, calls: 0, byDay: {}, byClient: {}, byRun: {}, bySession: {}, byTask: {}, byProvider: {} };
}

function addTo(map, key, usd) {
  if (!key) return;
  map[key] = round((map[key] || 0) + usd);
}

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    return readLedgerRow(JSON.parse(line));
  } catch {
    // a torn line is skipped
    return null;
  }
}

/**
 * The fields that tell one budget apart from another of the same scope. The hub-wide and Maker-wide day
 * caps and the evaluation cap are one budget each; clientMonth is one per client; the scaled scopes (run,
 * devSession, iteration, a task's own budgetScope) are one per run or session.
 */
const PERIODIC_ALERT_FIELDS = Object.freeze({ hubDay: [], makerDay: [], eval: [], clientMonth: ['salesClientId'] });
const SCALED_ALERT_FIELDS = Object.freeze(['salesClientId', 'runId', 'sessionId']);

/** The dedupe key of a budget alert: one alert per budget (scope and its own fields, see above) and UTC day. */
export function alertKey(entry = {}) {
  const fields = PERIODIC_ALERT_FIELDS[entry.scope] || SCALED_ALERT_FIELDS;
  return [dayKey(entry.at), entry.scope, ...fields.map((field) => entry[field])].map((part) => String(part || '')).join('|');
}

/** A Maker spend group's USD amount: a stored number or a { usd, calls } group. */
function makerGroupUsd(value) {
  const n = Number(value && typeof value === 'object' ? value.usd : value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function createHubLedger({ dataDir, clock = () => new Date(), log = console } = {}) {
  if (!dataDir) throw new Error('createHubLedger needs dataDir');
  const dir = join(dataDir, 'ai');
  const summaryPath = join(dir, 'spend-summary.json');
  const makerSpendPath = join(dir, 'maker-spend.json');
  const alertKeys = new Set();
  let alertKeysDay = '';
  let aggregate = null;
  let warned = false;
  let prunedForMonth = '';

  const now = () => {
    const value = clock();
    return value instanceof Date ? value : new Date(value);
  };

  function ensureDir() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  function fileFor(month) {
    return join(dir, `ledger-${month}.jsonl`);
  }

  function readMonth(month) {
    const path = fileFor(month);
    if (!existsSync(path)) return [];
    const out = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const row = parseLine(line);
      if (row) out.push(row);
    }
    return out;
  }

  function aggregateRow(agg, row) {
    const usd = Number(row.usd) || 0;
    agg.totalUsd = round(agg.totalUsd + usd);
    agg.calls += 1;
    addTo(agg.byDay, dayKey(row.at), usd);
    addTo(agg.byClient, row.salesClientId, usd);
    addTo(agg.byRun, row.runId, usd);
    addTo(agg.bySession, row.sessionId, usd);
    addTo(agg.byTask, row.task, usd);
    addTo(agg.byProvider, row.provider, usd);
  }

  /**
   * Counts the complete lines between agg.offset and the end of the file. A line still being written
   * (no newline yet) waits for the next read; newlines never occur inside a UTF-8 multi-byte character.
   */
  function readOn(agg, path, size) {
    let fd;
    try {
      fd = openSync(path, 'r');
    } catch {
      return;
    }
    try {
      let pending = Buffer.alloc(0);
      let position = agg.offset;
      while (position < size) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK, size - position));
        const read = readSync(fd, chunk, 0, chunk.length, position);
        if (read <= 0) break;
        position += read;
        const data = pending.length ? Buffer.concat([pending, chunk.subarray(0, read)]) : chunk.subarray(0, read);
        const end = data.lastIndexOf(0x0a);
        if (end === -1) {
          pending = data;
          continue;
        }
        for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
          const row = parseLine(line);
          if (row) aggregateRow(agg, row);
        }
        pending = data.subarray(end + 1);
        agg.offset = position - pending.length;
      }
    } finally {
      closeSync(fd);
    }
  }

  /** This month's totals as they are on disk now (rows from every process). */
  function currentAggregate() {
    const month = monthKey(now().toISOString());
    if (aggregate?.month !== month) aggregate = emptyAggregate(month);
    const path = fileFor(month);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    // A shorter file was replaced or restored: count it again from the start.
    if (size < aggregate.offset) aggregate = emptyAggregate(month);
    if (size > aggregate.offset) readOn(aggregate, path, size);
    return aggregate;
  }

  function summaryFrom(agg) {
    const today = dayKey(now().toISOString());
    return {
      month: agg.month,
      monthUsd: agg.totalUsd,
      todayUsd: agg.byDay[today] || 0,
      calls: agg.calls,
      byTask: { ...agg.byTask },
      byProvider: { ...agg.byProvider },
    };
  }

  /** Rewrites spend-summary.json under its lock from the totals on disk, so the last writer is never behind. */
  function writeSummary() {
    try {
      ensureDir();
      withFileLock(summaryPath, () => {
        writeJsonAtomic(summaryPath, { version: 1, updatedAt: now().toISOString(), ...summaryFrom(currentAggregate()) });
      });
    } catch {
      // the summary is a convenience copy; the ledger is the record
    }
  }

  /**
   * Deletes the ledger files of months before the kept window (this month by the ledger clock and the
   * 12 before it). It takes no month: the clock alone decides, so a row booked into a later month
   * cannot delete this month's file. This month and last month are never deleted; files whose name is
   * not a ledger month (ledger-YYYY-MM.jsonl, month 01 to 12) are ignored. Returns { removed, oldest }.
   */
  function pruneLedgers() {
    const at = now();
    if (!Number.isFinite(at.getTime())) return { removed: [], oldest: '' };
    const oldest = shiftMonth(at, -(LEDGER_KEEP_MONTHS - 1));
    // Last month stays even if the window is ever set shorter than two months.
    const previous = shiftMonth(at, -1);
    const keepFrom = oldest < previous ? oldest : previous;
    const removed = [];
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const match = name.match(LEDGER_RE);
      if (!match) continue;
      const monthNumber = Number(match[2]);
      if (monthNumber < 1 || monthNumber > 12) continue;
      const month = `${match[1]}-${match[2]}`;
      if (month >= keepFrom) continue;
      try {
        unlinkSync(join(dir, name));
        removed.push(month);
      } catch {
        // another process removed it first, or the disk refused: the next month tries again
      }
    }
    prunedForMonth = shiftMonth(at, 0);
    return { removed: removed.sort(), oldest };
  }

  /** Runs pruneLedgers() once per month of the ledger clock (never on the month of a row). */
  function pruneOncePerMonth() {
    try {
      const at = now();
      if (Number.isFinite(at.getTime()) && shiftMonth(at, 0) !== prunedForMonth) pruneLedgers();
    } catch {
      // retention never breaks a call
    }
  }

  /** Appends one row (the core calls this for every attempt). */
  function append(row) {
    if (!row || typeof row !== 'object') return;
    const at = String(row.at || now().toISOString());
    const month = monthKey(at);
    try {
      ensureDir();
      appendFileSync(fileFor(month), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    } catch (error) {
      if (!warned) {
        warned = true;
        log?.warn?.(`[ai-ledger] could not write ${fileFor(month)}: ${error?.message || error}`);
      }
      throw error;
    }
    writeSummary();
    pruneOncePerMonth();
  }

  /** Rows with `at` in [from, to] (ISO strings or Dates), oldest first. */
  function rows({ from = null, to = null } = {}) {
    const fromIso = from ? new Date(from).toISOString() : '';
    const toIso = to ? new Date(to).toISOString() : '';
    let months = [];
    if (existsSync(dir)) {
      months = readdirSync(dir)
        .map((name) => name.match(LEDGER_RE))
        .filter(Boolean)
        .map((m) => `${m[1]}-${m[2]}`)
        .sort();
    }
    const out = [];
    for (const month of months) {
      if (fromIso && month < monthKey(fromIso)) continue;
      if (toIso && month > monthKey(toIso)) continue;
      for (const row of readMonth(month)) {
        if (fromIso && row.at < fromIso) continue;
        if (toIso && row.at > toIso) continue;
        out.push(row);
      }
    }
    return out;
  }

  function readMakerSpend() {
    const value = readJsonFresh(makerSpendPath);
    return value && typeof value === 'object' && value.clients && typeof value.clients === 'object' ? value : { version: 1, clients: {} };
  }

  /**
   * Stores one Maker run's spend snapshot (run.ai.spend). A snapshot older than the stored one for the
   * same run is ignored (callbacks can arrive out of order). Returns { stored, snapshot }.
   */
  function recordMakerSpend(salesClientId, snapshot) {
    const clientId = String(salesClientId || '').trim();
    if (!clientId || !snapshot?.runId) return { stored: false, snapshot: null };
    let stored = false;
    updateJsonLocked(makerSpendPath, (current) => {
      const state = current && typeof current === 'object' && current.clients && typeof current.clients === 'object' ? current : { version: 1, clients: {} };
      const client = state.clients[clientId] && typeof state.clients[clientId] === 'object' ? state.clients[clientId] : { runs: {} };
      const runs = client.runs && typeof client.runs === 'object' ? client.runs : {};
      const previous = runs[snapshot.runId];
      if (previous?.at && snapshot.at) {
        const fewerCallsAtSameTime = String(previous.at) === String(snapshot.at) && Number.isInteger(previous.calls) && (!Number.isInteger(snapshot.calls) || snapshot.calls < previous.calls);
        if (String(previous.at) > String(snapshot.at) || fewerCallsAtSameTime) return state;
      }
      runs[snapshot.runId] = snapshot;
      const ordered = Object.entries(runs).sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || '')));
      client.runs = Object.fromEntries(ordered.slice(0, MAX_MAKER_RUNS_PER_CLIENT));
      state.clients[clientId] = client;
      stored = true;
      return state;
    });
    return { stored, snapshot };
  }

  /**
   * The Maker's spend for one client: the stored runs whose snapshot time is in [from, to], with totals.
   * A run's spend counts at its newest snapshot's `at`. `current` is the client's makerRun.aiSpend: it is
   * added only when the per-run history has no row for its run at all (the history write is a copy and
   * may have failed) and its own `at` is in the range, so a run is never counted twice or outside its time.
   */
  function makerSpendFor(salesClientId, { from = null, to = null, current = null } = {}) {
    const client = readMakerSpend().clients[String(salesClientId || '').trim()];
    const history = client?.runs && typeof client.runs === 'object' ? client.runs : {};
    const fromIso = from ? new Date(from).toISOString() : '';
    const toIso = to ? new Date(to).toISOString() : '';
    const inRange = (run) => {
      const at = String(run?.at || '');
      if (fromIso && at && at < fromIso) return false;
      if (toIso && at && at > toIso) return false;
      return true;
    };
    const runs = Object.values(history).filter(inRange);
    if (current?.runId && !Object.hasOwn(history, current.runId) && inRange(current)) runs.push(current);
    const byTask = {};
    const byProvider = {};
    let totalUsd = 0;
    let calls = 0;
    for (const run of runs) {
      totalUsd = round(totalUsd + (Number(run.totalUsd) || 0));
      if (Number.isInteger(run.calls)) calls += run.calls;
      for (const [task, value] of Object.entries(run.byTask || {})) addTo(byTask, task, makerGroupUsd(value));
      for (const [provider, value] of Object.entries(run.byProvider || {})) addTo(byProvider, provider, makerGroupUsd(value));
    }
    return { totalUsd, calls, byTask, byProvider, runs };
  }

  /**
   * The core's spentUsd hook. Scaled scopes (run, devSession, iteration, budgetScope) sum this month's
   * rows for the run or session; periodic scopes: clientMonth (hub rows + the Maker's runs this month),
   * hubDay (today, UTC), makerDay / eval (0: the hub has no Maker or evaluation calls).
   */
  function spentUsd({ scope, ctx = {} } = {}) {
    const agg = currentAggregate();
    if (scope === 'hubDay') return agg.byDay[dayKey(now().toISOString())] || 0;
    if (scope === 'clientMonth') {
      if (!ctx.salesClientId) return 0;
      const monthStart = `${agg.month}-01T00:00:00.000Z`;
      return round((agg.byClient[ctx.salesClientId] || 0) + makerSpendFor(ctx.salesClientId, { from: monthStart }).totalUsd);
    }
    if (scope === 'makerDay' || scope === 'eval') return 0;
    if (ctx.sessionId && (scope === 'devSession' || scope === 'iteration' || !ctx.runId)) return agg.bySession[ctx.sessionId] || 0;
    if (ctx.runId) return agg.byRun[ctx.runId] || 0;
    return 0;
  }

  function alertsPathFor(month) {
    return join(dir, `alerts-${month}.jsonl`);
  }

  function readAlerts(month) {
    const path = alertsPathFor(month);
    if (!existsSync(path)) return [];
    const out = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn line is skipped
      }
    }
    return out;
  }

  /**
   * Records a budget alert once per budget and UTC day (alertKey). Later alerts
   * with the same key, from this process or another, are not written again. Returns the entry with
   * `recorded: true` when it was written now.
   */
  function recordAlert(info = {}) {
    const entry = {
      at: now().toISOString(),
      task: String(info.task || ''),
      scope: String(info.scope || ''),
      periodic: Boolean(info.periodic),
      expectedUsd: Number(info.expectedUsd) || 0,
      projectedUsd: Number(info.projectedUsd) || 0,
      salesClientId: String(info.ctx?.salesClientId || ''),
      runId: String(info.ctx?.runId || ''),
      sessionId: String(info.ctx?.sessionId || ''),
    };
    const key = alertKey(entry);
    const day = dayKey(entry.at);
    if (alertKeysDay !== day) {
      alertKeys.clear();
      alertKeysDay = day;
    }
    if (alertKeys.has(key)) return { ...entry, recorded: false };
    let recorded = false;
    try {
      ensureDir();
      const path = alertsPathFor(monthKey(entry.at));
      withFileLock(path, () => {
        if (readAlerts(monthKey(entry.at)).some((existing) => alertKey(existing) === key)) return;
        appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        recorded = true;
      });
      alertKeys.add(key);
    } catch {
      // alerts never break a call
    }
    return { ...entry, recorded };
  }

  /** The newest alerts of this month (from the file, so every process's alerts are shown). */
  function recentAlerts(limit = MAX_RECENT_ALERTS) {
    try {
      return readAlerts(monthKey(now().toISOString())).reverse().slice(0, limit);
    } catch {
      return [];
    }
  }

  function summary() {
    return { ...summaryFrom(currentAggregate()), alerts: recentAlerts(10) };
  }

  return Object.freeze({
    dir,
    append,
    rows,
    spentUsd,
    summary,
    summarize: (list, by) => summarizeLedger(list, by),
    recordAlert,
    recentAlerts,
    recordMakerSpend,
    makerSpendFor,
    pruneLedgers,
    resetCache: () => {
      aggregate = null;
      alertKeys.clear();
    },
  });
}
