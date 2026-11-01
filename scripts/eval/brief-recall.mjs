#!/usr/bin/env node
// Recall check for the brief extractor (not part of npm test).
//
//   node scripts/eval/brief-recall.mjs --input <dir> --report <file> [--clients a,b] [--profile replay|test|prod|record]
//                                      [--data-dir <dir>] [--min-recall 0.8] [--strict]
//
// <dir>/<client>/ holds the meetings and what the brief should find:
//   transcripts.json   { meetings: { <name>: { file, meetingId?, purpose?, date? } } }  (or an array of those)
//   expectations.json  { items: [...] } or promises.json { rows: [...] }; each row has an id, a kind
//                      (client_need, both or asoldi_promise), a statement and, when known, a quote
//                      (`quote` or `directive.quote`) and a featureKey.
// The extractor runs through the hub LLM facade with the chosen profile (default `replay`: answers come
// from cassettes in <data-dir>/ai/cassettes/hub and no provider is called; `record` and the live
// profiles call providers with the keys in this process's environment). The report (counts, ids and
// match scores; no transcript text) is written to --report, which must be outside this repository.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChunkCache, createMemoryChunkCache, extractMeeting } from '../../lib/delivery-brief/extract.js';
import { llmMergeItems, reduceItems } from '../../lib/delivery-brief/reduce.js';
import { tokenSet } from '../../lib/delivery-brief/text.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEED_KINDS = new Set(['client_need', 'both']);
const PROMISE_KINDS = new Set(['asoldi_promise', 'both']);

export function parseArgs(argv) {
  const args = { clients: [], profile: 'replay', minRecall: 0.8, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === '--input') args.input = next();
    else if (key === '--report') args.report = next();
    else if (key === '--clients') args.clients = String(next() || '').split(',').map((value) => value.trim()).filter(Boolean);
    else if (key === '--profile') args.profile = next();
    else if (key === '--data-dir') args.dataDir = next();
    else if (key === '--min-recall') args.minRecall = Number(next());
    else if (key === '--strict') args.strict = true;
    else throw new Error(`Unknown argument ${key}`);
  }
  if (!args.input) throw new Error('--input <dir> is required');
  if (!args.report) throw new Error('--report <file> is required');
  return args;
}

/** Throws when `path` is inside this repository (reports may hold client data). */
export function assertOutsideRepo(path, root = repoRoot) {
  const target = resolve(path);
  const rel = relative(root, target);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error(`The report must be written outside the repository: ${target}`);
  return target;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadClient(dir) {
  const spec = readJson(join(dir, 'transcripts.json'));
  const entries = Array.isArray(spec) ? spec.map((row) => [row.purpose || 'sales', row]) : Object.entries(spec.meetings || {});
  const meetings = entries.map(([name, row]) => ({
    meetingId: String(row.meetingId || `${name}`),
    purpose: String(row.purpose || name),
    startedAt: String(row.date || row.startedAt || ''),
    transcript: readFileSync(join(dir, row.file), 'utf8'),
  }));
  let rows = [];
  if (existsSync(join(dir, 'expectations.json'))) {
    const raw = readJson(join(dir, 'expectations.json'));
    rows = Array.isArray(raw.items) ? raw.items : [];
  }
  if (!rows.length && existsSync(join(dir, 'promises.json'))) rows = readJson(join(dir, 'promises.json')).rows || [];
  const expectations = rows
    .filter((row) => row && (NEED_KINDS.has(row.kind) || PROMISE_KINDS.has(row.kind)))
    .map((row) => ({ id: String(row.id || row.ref || ''), kind: row.kind, statement: String(row.statement || ''), quote: String(row.quote || row.directive?.quote || ''), featureKey: String(row.featureKey || '') }));
  return { meetings, expectations };
}

function overlap(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function itemText(item) {
  return [item.quote, item.ask, item.text, item.value].filter(Boolean).join(' ');
}

/** Scores one client's expectations against the brief items. Returns { needs, promises, rows }. */
export function scoreClient(expectations, items, { quoteMin = 0.6, statementMin = 0.5 } = {}) {
  const active = items.filter((item) => item.status !== 'superseded');
  const promises = active.filter((item) => item.type === 'promise');
  const rows = [];
  for (const expected of expectations) {
    const pool = expected.kind === 'asoldi_promise' ? promises.filter((item) => !expected.featureKey || item.featureKey === expected.featureKey) : active;
    let best = { score: 0, id: '' };
    for (const item of pool) {
      const score = expected.quote ? Math.max(overlap(expected.quote, item.quote), overlap(expected.quote, itemText(item))) : overlap(expected.statement, itemText(item));
      if (score > best.score) best = { score, id: item.id };
    }
    const threshold = expected.quote ? quoteMin : statementMin;
    const matched = expected.kind === 'asoldi_promise' && !expected.quote && expected.featureKey ? pool.length > 0 : best.score >= threshold;
    rows.push({ id: expected.id, kind: expected.kind, matched, score: Math.round(best.score * 100) / 100, briefItemId: matched ? best.id : '', basis: expected.quote ? 'quote' : 'statement' });
  }
  const recall = (set) => {
    const list = rows.filter((row) => set.has(row.kind));
    return { total: list.length, recalled: list.filter((row) => row.matched).length, recall: list.length ? Math.round((list.filter((row) => row.matched).length / list.length) * 1000) / 1000 : null };
  };
  return { needs: recall(NEED_KINDS), promises: recall(new Set(['asoldi_promise'])), rows };
}

async function facadeFor(profile, dataDir, providers) {
  const { createHubLlm } = await import('../../lib/llm/index.js');
  return createHubLlm({ dataDir, env: { ...process.env, AI_PROFILE: profile }, ...(providers ? { providers } : {}) });
}

/** Runs the check. `llm` replaces the facade, `providers` its provider adapters (tests). Returns the report. */
export async function runRecall(args, { llm = null, providers = null, log = console } = {}) {
  const reportPath = assertOutsideRepo(args.report);
  const inputDir = resolve(args.input);
  const dataDir = args.dataDir ? resolve(args.dataDir) : mkdtempSync(join(tmpdir(), 'brief-recall-'));
  const model = llm || (await facadeFor(args.profile, dataDir, providers));
  const clients = readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(inputDir, entry.name, 'transcripts.json')))
    .map((entry) => entry.name)
    .filter((name) => !args.clients.length || args.clients.includes(name))
    .sort();
  const report = { generatedAt: new Date().toISOString(), profile: llm ? 'injected' : args.profile, minRecall: args.minRecall, clients: [] };
  for (const name of clients) {
    const started = Date.now();
    const { meetings, expectations } = loadClient(join(inputDir, name));
    const cache = args.dataDir ? createChunkCache(join(dataDir, 'brief-recall-chunks', name)) : createMemoryChunkCache();
    const results = [];
    for (const meeting of meetings) results.push(await extractMeeting({ meeting, llm: model, cache, clientId: name }));
    let reduced = reduceItems(results.flatMap((result) => result.items));
    reduced = (await llmMergeItems(reduced, { llm: model, cache, clientId: name })).reduced;
    const score = scoreClient(expectations, reduced.items);
    const row = {
      client: name,
      meetings: meetings.length,
      complete: results.every((result) => result.complete),
      chunks: results.reduce((sum, result) => sum + result.chunks.total, 0),
      items: reduced.active.length,
      droppedUnverified: results.reduce((sum, result) => sum + result.droppedUnverified, 0),
      costUsd: Math.round(results.reduce((sum, result) => sum + result.costUsd, 0) * 1e6) / 1e6,
      durationMs: Date.now() - started,
      needs: score.needs,
      promises: score.promises,
      pass: (score.needs.recall === null || score.needs.recall >= args.minRecall) && (score.promises.recall === null || score.promises.recall >= args.minRecall),
      rows: score.rows,
    };
    report.clients.push(row);
    log.log?.(`[brief-recall] ${name}: needs ${row.needs.recalled}/${row.needs.total}, promises ${row.promises.recalled}/${row.promises.total}, ${row.pass ? 'pass' : 'below threshold'}`);
  }
  report.pass = report.clients.every((row) => row.pass);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runRecall(args);
    console.log(`[brief-recall] report: ${resolve(args.report)}`);
    if (args.strict && !report.pass) process.exitCode = 1;
  } catch (error) {
    console.error(`[brief-recall] ${error?.message || error}`);
    process.exitCode = 2;
  }
}
