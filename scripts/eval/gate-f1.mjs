#!/usr/bin/env node
// Precision, recall and F1 of the delivery gate against expected-line label files.
//
//   node scripts/eval/gate-f1.mjs <dir> [--actual <dir>] [--clients a,b] [--min 0.9] [--json <file>]
//
// <dir> holds one folder per client with gate-expected.json (schema asoldi.gate-expected/1:
// lines [{id, status}]). The gate under test is <actual>/<id>/gate-actual.json (a stored gate,
// for example from a delivery run) when present, otherwise the gate this code evaluates from
// <dir>/<id>/gate-input.json ({client, inputs}). A line counts as right when the gate has the line
// with the expected status; a line the gate adds or a status it gets wrong counts against
// precision, a line it misses against recall. Prints per-line and overall scores and exits 1 when
// the overall F1 is below --min (default 0.9), when no client was scored (an empty or wrong
// directory), or when a client has a label but no gate to score.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(argv, name, fallback = '') {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : String(argv[at + 1] ?? fallback);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function linesOf(gate) {
  const out = new Map();
  for (const line of Array.isArray(gate?.lines) ? gate.lines : []) {
    if (line && typeof line.id === 'string') out.set(line.id, String(line.status || ''));
  }
  return out;
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : 1;
}

function f1(precision, recall) {
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

/** Scores one expected/actual pair into `counts` (per line id). */
export function scoreClient(expected, actual, counts = new Map()) {
  const want = linesOf(expected);
  const got = linesOf(actual);
  const bump = (id, key) => {
    const row = counts.get(id) || { tp: 0, fp: 0, fn: 0 };
    row[key] += 1;
    counts.set(id, row);
  };
  for (const [id, status] of got) {
    if (want.get(id) === status) bump(id, 'tp');
    else bump(id, 'fp');
  }
  for (const [id, status] of want) {
    if (got.get(id) !== status) bump(id, 'fn');
  }
  return counts;
}

export function summarize(counts) {
  const perLine = {};
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const [id, row] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const precision = ratio(row.tp, row.tp + row.fp);
    const recall = ratio(row.tp, row.tp + row.fn);
    perLine[id] = { ...row, precision, recall, f1: f1(precision, recall) };
    tp += row.tp;
    fp += row.fp;
    fn += row.fn;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return { overall: { tp, fp, fn, precision, recall, f1: f1(precision, recall) }, perLine };
}

async function evaluateInput(file) {
  const { evaluateDeliveryGate } = await import(pathToFileURL(resolve(HERE, '..', '..', 'lib', 'delivery-gate.js')).href);
  const body = readJson(file);
  return evaluateDeliveryGate(body.client || {}, body.inputs || {}, { now: '2026-11-01T12:00:00.000Z' });
}

/** Scores every client folder under `dir`. Returns { clients, overall, perLine }. */
export async function gateF1(dir, { actualDir = '', clients: onlyClients = [] } = {}) {
  const counts = new Map();
  const clients = [];
  const only = new Set((Array.isArray(onlyClients) ? onlyClients : []).filter(Boolean));
  const ids = (existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).sort() : []).filter((id) => !only.size || only.has(id));
  for (const id of ids) {
    const folder = join(dir, id);
    if (!statSync(folder).isDirectory()) continue;
    const expectedFile = join(folder, 'gate-expected.json');
    if (!existsSync(expectedFile)) continue;
    const expected = readJson(expectedFile);
    const actualFile = [actualDir && join(actualDir, id, 'gate-actual.json'), actualDir && join(actualDir, `${id}.json`), join(folder, 'gate-actual.json')]
      .find((file) => file && existsSync(file));
    let actual = null;
    let source = '';
    if (actualFile) {
      actual = readJson(actualFile);
      source = 'actual';
    } else if (existsSync(join(folder, 'gate-input.json'))) {
      actual = await evaluateInput(join(folder, 'gate-input.json'));
      source = 'evaluated';
    }
    if (!actual) {
      clients.push({ id, source: 'missing' });
      scoreClient(expected, { lines: [] }, counts);
      continue;
    }
    const own = summarize(scoreClient(expected, actual));
    scoreClient(expected, actual, counts);
    clients.push({ id, source, f1: own.overall.f1 });
  }
  return { clients, ...summarize(counts) };
}

/** Reasons a run proves nothing: no client scored, or a label without a gate. Empty when fine. */
export function gateF1Problems(result) {
  const clients = Array.isArray(result?.clients) ? result.clients : [];
  const problems = [];
  if (!clients.length) problems.push('no client was scored (no <id>/gate-expected.json under the directory)');
  const missing = clients.filter((client) => client.source === 'missing').map((client) => client.id);
  if (missing.length) problems.push(`no gate to score for: ${missing.join(', ')}`);
  return problems;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(argv) {
  const dir = argv.find((entry, index) => !entry.startsWith('--') && !['--actual', '--min', '--json', '--clients'].includes(argv[index - 1]));
  if (!dir) {
    console.error('usage: node scripts/eval/gate-f1.mjs <dir> [--actual <dir>] [--clients a,b] [--min 0.9] [--json <file>]');
    process.exit(2);
  }
  const min = Number(arg(argv, '--min', '0.9'));
  const clients = arg(argv, '--clients').split(',').map((id) => id.trim()).filter(Boolean);
  const result = await gateF1(resolve(dir), { actualDir: arg(argv, '--actual') ? resolve(arg(argv, '--actual')) : '', clients });
  for (const [id, row] of Object.entries(result.perLine)) {
    console.log(`${id.padEnd(18)} P ${pct(row.precision).padStart(6)}  R ${pct(row.recall).padStart(6)}  F1 ${pct(row.f1).padStart(6)}  (tp ${row.tp}, fp ${row.fp}, fn ${row.fn})`);
  }
  for (const client of result.clients) console.log(`client ${client.id}: ${client.source}${Number.isFinite(client.f1) ? ` F1 ${pct(client.f1)}` : ''}`);
  console.log(`overall            P ${pct(result.overall.precision)}  R ${pct(result.overall.recall)}  F1 ${pct(result.overall.f1)}`);
  const json = arg(argv, '--json');
  if (json) writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`);
  const problems = gateF1Problems(result);
  if (problems.length) {
    for (const problem of problems) console.error(`[gate-f1] ${problem}`);
    process.exit(1);
  }
  if (!(result.overall.f1 >= min)) {
    console.error(`[gate-f1] overall F1 ${pct(result.overall.f1)} is below ${pct(min)}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
