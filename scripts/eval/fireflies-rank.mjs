#!/usr/bin/env node
// Offline evaluation of the Fireflies candidate ranker (lib/fireflies-candidate-rank.js) on a labelled
// set. Not part of npm test. Reads only the files it is given and never calls Fireflies.
//
//   node scripts/eval/fireflies-rank.mjs <labels.json> [--data <dataDir>] [--min-score <n>] [--out <report.json>]
//
// labels.json is either
//   { "clients": [...sales clients], "recordings": [{ "record": {...stored meeting}, "clientId": "<expected>" }] }
// or, with --data <dataDir> (a copy of the hub data dir: sales-clients.json, fireflies-meetings.json),
//   { "labels": [{ "meetingId": "...", "clientId": "<expected>" }] }
// The summary printed and the report hold ids and scores only. Keep labelled sets and reports outside
// the repository (the hub repository is public).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The hub modules resolve a data dir when they load; point them at an empty scratch dir so this
// script never reads or creates anything in the real one.
process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-rank-eval-'));
delete process.env.DATA_DIR;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : '';
}

const labelsPath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
if (!labelsPath) {
  console.error('Usage: node scripts/eval/fireflies-rank.mjs <labels.json> [--data <dataDir>] [--min-score <n>] [--out <report.json>]');
  process.exit(2);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

const labels = readJson(labelsPath);
const dataDir = argValue('--data');
const minScore = Number.isFinite(Number(argValue('--min-score'))) && argValue('--min-score') !== '' ? Number(argValue('--min-score')) : 40;
const outPath = argValue('--out');

let clients = Array.isArray(labels.clients) ? labels.clients : [];
let cases = Array.isArray(labels.recordings) ? labels.recordings.map((row) => ({ record: row.record, expected: String(row.clientId || '') })) : [];
if (dataDir) {
  const salesClients = readJson(join(dataDir, 'sales-clients.json'));
  const meetings = readJson(join(dataDir, 'fireflies-meetings.json'));
  clients = Array.isArray(salesClients) ? salesClients : [];
  cases = (Array.isArray(labels.labels) ? labels.labels : []).map((row) => ({
    record: meetings[String(row.meetingId || '')] || null,
    expected: String(row.clientId || ''),
    meetingId: String(row.meetingId || ''),
  }));
}

const { rankRecordingCandidates } = await import('../../lib/fireflies-candidate-rank.js');

const rows = [];
for (const item of cases) {
  if (!item.record) {
    rows.push({ meetingId: item.meetingId || '', expected: item.expected, missing: true });
    continue;
  }
  // The recording is judged as if no card held it yet.
  const ranked = rankRecordingCandidates(item.record, clients, { minScore, limit: 5 });
  const rank = ranked.findIndex((row) => row.clientId === item.expected) + 1;
  rows.push({
    meetingId: String(item.record.meetingId || item.meetingId || ''),
    expected: item.expected,
    top: ranked[0]?.clientId || '',
    topScore: ranked[0]?.score || 0,
    rank: rank || null,
    candidates: ranked.length,
  });
}

const judged = rows.filter((row) => !row.missing);
const top1 = judged.filter((row) => row.rank === 1).length;
const top3 = judged.filter((row) => row.rank && row.rank <= 3).length;
const report = {
  kind: 'asoldi.fireflies-rank-eval/1',
  minScore,
  total: rows.length,
  judged: judged.length,
  missingRecords: rows.length - judged.length,
  top1,
  top3,
  noCandidate: judged.filter((row) => !row.candidates).length,
  top1Rate: judged.length ? Number((top1 / judged.length).toFixed(4)) : 0,
  target: 0.9,
  misses: judged.filter((row) => row.rank !== 1).map(({ meetingId, expected, top, topScore, rank }) => ({ meetingId, expected, top, topScore, rank })),
};

console.log(`[fireflies-rank] judged ${report.judged} of ${report.total}; top-1 ${top1} (${(report.top1Rate * 100).toFixed(1)}%), top-3 ${top3}, no candidate ${report.noCandidate}; target 90%`);
for (const miss of report.misses.slice(0, 50)) console.log(`  miss ${miss.meetingId}: expected ${miss.expected}, got ${miss.top || '-'} (${miss.topScore}), rank ${miss.rank ?? '-'}`);
if (outPath) {
  writeFileSync(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[fireflies-rank] report -> ${resolve(outPath)}`);
}
process.exitCode = report.top1Rate >= report.target ? 0 : 1;
