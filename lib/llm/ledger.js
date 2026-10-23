/**
 * Hub AI ledger (v2 rows from the shared core), spend lookups for budgets, and the Maker's run spend.
 *
 *   <dataDir>/ai/ledger-YYYY-MM.jsonl   one row per provider attempt (append-only, UTC month of row.at)
 *   <dataDir>/ai/spend-summary.json     today / this month totals, rewritten after each row
 *   <dataDir>/ai/alerts-YYYY-MM.jsonl   budget alerts (work continues; only a runaway or loop stops)
 *   <dataDir>/ai/maker-spend.json       the Maker's run.ai.spend snapshots per client and run
 *
 * The ledger never breaks a call: write errors are swallowed by the core and logged once here.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLedgerRow, summarizeLedger } from '../../packages/suite/core/llm/index.js';
import { readJsonFresh, updateJsonLocked, writeJsonAtomic } from '../../data/atomic-json.js';

const LEDGER_RE = /^ledger-(\d{4})-(\d{2})\.jsonl$/;
const MAX_RECENT_ALERTS = 50;
const MAX_MAKER_RUNS_PER_CLIENT = 50;

function round(value) {
  return Math.round((Number(value) || 0) * 1e10) / 1e10;
}

function monthKey(iso) {
  return String(iso || '').slice(0, 7);
}

function dayKey(iso) {
  return String(iso || '').slice(0, 10);
}

function emptyAggregate(month) {
  return { month, totalUsd: 0, calls: 0, byDay: {}, byClient: {}, byRun: {}, bySession: {}, byTask: {}, byProvider: {} };
}

function addTo(map, key, usd) {
  if (!key) return;
  map[key] = round((map[key] || 0) + usd);
}

export function createHubLedger({ dataDir, clock = () => new Date(), log = console } = {}) {
  if (!dataDir) throw new Error('createHubLedger needs dataDir');
  const dir = join(dataDir, 'ai');
  const summaryPath = join(dir, 'spend-summary.json');
  const makerSpendPath = join(dir, 'maker-spend.json');
  const recentAlerts = [];
  let aggregate = null;
  let warned = false;

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
      if (!line.trim()) continue;
      try {
        const row = readLedgerRow(JSON.parse(line));
        if (row) out.push(row);
      } catch {
        // a torn last line is skipped
      }
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

  function currentAggregate() {
    const month = monthKey(now().toISOString());
    if (aggregate?.month === month) return aggregate;
    const agg = emptyAggregate(month);
    for (const row of readMonth(month)) aggregateRow(agg, row);
    aggregate = agg;
    return agg;
  }

  function writeSummary() {
    const agg = currentAggregate();
    const today = dayKey(now().toISOString());
    try {
      writeJsonAtomic(summaryPath, {
        version: 1,
        updatedAt: now().toISOString(),
        month: agg.month,
        monthUsd: agg.totalUsd,
        todayUsd: agg.byDay[today] || 0,
        calls: agg.calls,
        byTask: agg.byTask,
        byProvider: agg.byProvider,
      });
    } catch {
      // the summary is a convenience copy; the ledger is the record
    }
  }

  /** Appends one row (the core calls this for every attempt). */
  function append(row) {
    if (!row || typeof row !== 'object') return;
    const at = String(row.at || now().toISOString());
    const month = monthKey(at);
    // Load this month's totals before the write, so the new row is counted exactly once.
    const agg = currentAggregate();
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
    if (agg.month === month) aggregateRow(agg, readLedgerRow(row) || row);
    writeSummary();
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
      if (previous?.at && snapshot.at && String(previous.at) > String(snapshot.at)) return state;
      runs[snapshot.runId] = snapshot;
      const ordered = Object.entries(runs).sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || '')));
      client.runs = Object.fromEntries(ordered.slice(0, MAX_MAKER_RUNS_PER_CLIENT));
      state.clients[clientId] = client;
      stored = true;
      return state;
    });
    return { stored, snapshot };
  }

  /** The Maker's spend for one client: every stored run, with a total. */
  function makerSpendFor(salesClientId, { from = null, to = null } = {}) {
    const client = readMakerSpend().clients[String(salesClientId || '').trim()];
    const runs = Object.values(client?.runs || {}).filter((run) => {
      const at = String(run?.at || '');
      if (from && at && at < new Date(from).toISOString()) return false;
      if (to && at && at > new Date(to).toISOString()) return false;
      return true;
    });
    const byTask = {};
    let totalUsd = 0;
    for (const run of runs) {
      totalUsd = round(totalUsd + (Number(run.totalUsd) || 0));
      for (const [task, usd] of Object.entries(run.byTask || {})) addTo(byTask, task, Number(usd) || 0);
    }
    return { totalUsd, byTask, runs };
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

  function recordAlert(info = {}) {
    const entry = {
      at: now().toISOString(),
      task: String(info.task || ''),
      scope: String(info.scope || ''),
      periodic: Boolean(info.periodic),
      expectedUsd: Number(info.expectedUsd) || 0,
      projectedUsd: Number(info.projectedUsd) || 0,
      salesClientId: String(info.ctx?.salesClientId || ''),
    };
    recentAlerts.unshift(entry);
    recentAlerts.length = Math.min(recentAlerts.length, MAX_RECENT_ALERTS);
    try {
      ensureDir();
      appendFileSync(join(dir, `alerts-${monthKey(entry.at)}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // alerts never break a call
    }
    return entry;
  }

  function summary() {
    const agg = currentAggregate();
    const today = dayKey(now().toISOString());
    return {
      month: agg.month,
      monthUsd: agg.totalUsd,
      todayUsd: agg.byDay[today] || 0,
      calls: agg.calls,
      byTask: { ...agg.byTask },
      byProvider: { ...agg.byProvider },
      alerts: recentAlerts.slice(0, 10),
    };
  }

  return Object.freeze({
    dir,
    append,
    rows,
    spentUsd,
    summary,
    summarize: (list, by) => summarizeLedger(list, by),
    recordAlert,
    recentAlerts: () => recentAlerts.slice(),
    recordMakerSpend,
    makerSpendFor,
    resetCache: () => {
      aggregate = null;
    },
  });
}
