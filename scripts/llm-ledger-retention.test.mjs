// AI ledger retention (lib/llm/ledger.js pruneLedgers): <dataDir>/ai/ledger-YYYY-MM.jsonl files are
// kept for this month and the 12 before it, counted by the ledger's own clock and never by the month
// of a row. Everything runs on temporary data dirs with an injected clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEDGER_KEEP_MONTHS, createHubLedger } from '../lib/llm/ledger.js';

const row = (at, usd, extra = {}) => ({
  v: 2,
  kind: 'llm',
  at,
  task: 'offer.fill-from-transcript',
  provider: 'deepseek',
  model: 'deepseek-chat',
  usd,
  status: 'ok',
  attempt: 1,
  salesClientId: 'client-1',
  ...extra,
});

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-ai-ledger-retention-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** One row of 1 USD per month, written straight to the files as an older hub would have left them. */
function seedMonths(dir, months) {
  mkdirSync(join(dir, 'ai'), { recursive: true });
  for (const month of months) writeFileSync(join(dir, 'ai', `ledger-${month}.jsonl`), `${JSON.stringify(row(`${month}-10T12:00:00.000Z`, 1))}\n`);
}

const ledgerFile = (dir, month) => join(dir, 'ai', `ledger-${month}.jsonl`);
/** The ledger months on disk (names ledger-YYYY-MM.jsonl with a month from 01 to 12). */
const ledgerMonths = (dir) => readdirSync(join(dir, 'ai')).map((name) => name.match(/^ledger-(\d{4}-(?:0[1-9]|1[0-2]))\.jsonl$/)?.[1]).filter(Boolean).sort();

test('the ledger keeps this month and the 12 before it by its clock; older ledger files go and other files stay', () => withDir((dir) => {
  assert.equal(LEDGER_KEEP_MONTHS, 13);
  seedMonths(dir, ['2024-12', '2025-08', '2025-09', '2025-10', '2025-11', '2026-09', '2026-10']);
  const others = ['ledger-2020-01.json', 'ledger-2020-13.jsonl', 'ledger-2020-00.jsonl', 'ledger-2020-1.jsonl', 'alerts-2020-01.jsonl', 'spend-summary.json', 'notes.txt'];
  for (const name of others) writeFileSync(join(dir, 'ai', name), 'x\n');
  const ledger = createHubLedger({ dataDir: dir, clock: () => new Date('2026-10-15T08:00:00.000Z'), log: null });
  const result = ledger.pruneLedgers();
  assert.deepEqual(result.removed, ['2024-12', '2025-08', '2025-09']);
  assert.equal(result.oldest, '2025-10');
  assert.deepEqual(ledgerMonths(dir), ['2025-10', '2025-11', '2026-09', '2026-10']);
  for (const name of others) assert.equal(existsSync(join(dir, 'ai', name)), true, `${name} is not a ledger month and stays`);
  assert.deepEqual(ledger.pruneLedgers().removed, [], 'a second prune has nothing to do');
}));

test('clock injection: the kept window moves with the ledger clock, and append prunes once per clock month', () => withDir((dir) => {
  const months = Array.from({ length: 13 }, (_, i) => new Date(Date.UTC(2025, 9 + i, 1)).toISOString().slice(0, 7));
  assert.deepEqual([months[0], months.at(-1)], ['2025-10', '2026-10']);
  seedMonths(dir, months);
  let t = new Date('2026-10-15T08:00:00.000Z');
  const ledger = createHubLedger({ dataDir: dir, clock: () => t, log: null });

  ledger.append(row(t.toISOString(), 0.5));
  assert.deepEqual(ledgerMonths(dir), months, 'October 2026: all 13 months are inside the window');

  t = new Date('2026-11-02T08:00:00.000Z');
  ledger.append(row(t.toISOString(), 0.5));
  assert.equal(existsSync(ledgerFile(dir, '2025-10')), false, 'November 2026: October 2025 is past the window');
  assert.equal(existsSync(ledgerFile(dir, '2025-11')), true);

  // Pruning runs once per clock month: a stale file that appears later in November waits for December.
  seedMonths(dir, ['2020-05']);
  t = new Date('2026-11-20T08:00:00.000Z');
  ledger.append(row(t.toISOString(), 0.5));
  assert.equal(existsSync(ledgerFile(dir, '2020-05')), true, 'no second prune in the same clock month');
  t = new Date('2026-12-01T00:00:00.000Z');
  ledger.append(row(t.toISOString(), 0.5));
  assert.equal(existsSync(ledgerFile(dir, '2020-05')), false);
  assert.equal(existsSync(ledgerFile(dir, '2025-11')), false, 'December 2026 keeps December 2025 onwards');
  assert.equal(existsSync(ledgerFile(dir, '2025-12')), true);
}));

test('a row booked into a later month does not delete this month or last month', () => withDir((dir) => {
  seedMonths(dir, ['2025-10', '2026-09', '2026-10']);
  const ledger = createHubLedger({ dataDir: dir, clock: () => new Date('2026-10-15T08:00:00.000Z'), log: null });
  ledger.append(row('2031-01-01T00:00:00.000Z', 5));
  ledger.append(row('2027-12-31T23:59:59.000Z', 5));
  assert.deepEqual(ledgerMonths(dir), ['2025-10', '2026-09', '2026-10', '2027-12', '2031-01'], 'the rows land in their own months; nothing inside the window goes');
  assert.deepEqual(ledger.pruneLedgers().removed, [], 'the clock, not the booked month, sets the window');
  assert.equal(ledger.summary().monthUsd, 1, 'this month still counts its own row only');
}));

test('the spend summary still totals this month after a prune, and last month stays readable', () => withDir((dir) => {
  seedMonths(dir, ['2025-01', '2025-06']);
  let t = new Date('2026-10-15T08:00:00.000Z');
  const ledger = createHubLedger({ dataDir: dir, clock: () => t, log: null });
  ledger.append(row('2026-09-30T23:00:00.000Z', 2, { task: 'seo.meta' }));
  for (const usd of [0.5, 0.25, 0.125]) ledger.append(row(t.toISOString(), usd));
  assert.deepEqual(ledgerMonths(dir), ['2026-09', '2026-10'], 'the months past the window are gone');

  const summary = ledger.summary();
  assert.equal(summary.month, '2026-10');
  assert.equal(summary.monthUsd, 0.875);
  assert.equal(summary.todayUsd, 0.875);
  assert.equal(summary.calls, 3);
  assert.deepEqual(summary.byTask, { 'offer.fill-from-transcript': 0.875 });
  const file = JSON.parse(readFileSync(join(dir, 'ai', 'spend-summary.json'), 'utf8'));
  assert.equal(file.month, '2026-10');
  assert.equal(file.monthUsd, 0.875);
  assert.equal(file.calls, 3);
  assert.equal(ledger.spentUsd({ scope: 'clientMonth', ctx: { salesClientId: 'client-1' } }), 0.875);
  assert.equal(ledger.spentUsd({ scope: 'hubDay' }), 0.875);

  const kept = ledger.rows({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' });
  assert.equal(kept.length, 4);
  const byTask = ledger.summarize(kept, 'task');
  assert.equal(byTask.totalUsd, 2.875);
  assert.equal(byTask.calls, 4);
  assert.deepEqual(Object.fromEntries(Object.entries(byTask.groups).map(([task, group]) => [task, group.usd])), { 'seo.meta': 2, 'offer.fill-from-transcript': 0.875 });
  assert.equal(ledger.rows().length, 4, 'rows from the pruned months are gone from every range');

  t = new Date('2026-11-01T00:00:00.000Z');
  ledger.append(row(t.toISOString(), 1));
  assert.equal(existsSync(ledgerFile(dir, '2026-10')), true, 'last month stays after the month turns');
  assert.equal(ledger.summary().monthUsd, 1);
  assert.equal(ledger.summary().calls, 1);
}));
