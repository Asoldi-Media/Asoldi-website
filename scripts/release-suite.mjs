#!/usr/bin/env node
// scripts/release-suite.mjs
// -----------------------------------------------------------------------------
// The pre-release suite for the delivery spine and its mails. It runs the delivery end-to-end
// (scripts/golden/delivery-e2e.mjs) twice on a hub booted in safe mode on a throwaway `.local-data`
// folder with the invented clients of scripts/golden/fixtures-delivery/:
//   - switched on: every client a pilot; signing, delivery.loop and brief in auto, the gate in shadow,
//     preview jobs on; each client signs through another path; a stand-in Maker host claims the
//     preview jobs; the brief extraction comes from a stub cache (no LLM call);
//   - the control, every switch off: the run may add nothing but today's pre-workshop mail.
// The delivery checks (scripts/golden/checks-hub/) decide each release-gated switch: pass, fail, or
// not-covered (no check covers it, so it gets no pass). The report is signed with the release key
// and written to <out>/report.json; nothing leaves the PC (the hub refuses every non-loopback host).
//
//   node scripts/release-suite.mjs [--out <dir>] [--key-file <file>] [--fixtures <dir>]
//
// --out       default $GENERATED_RUNS_DIR/release-suite/<time>, else .golden-reports/release-suite/<time>
//             (both outside Git). The report and the data folders stay there for inspection.
// --key-file  the release key (64 hex); created owner-only when missing. Default
//             .golden-reports/release-suite.key. A hub verifies reports with the same key
//             (PUT /api/admin/automation/release-key installs it).
// Exit 0 when the control passed and no covered switch failed; 1 otherwise; 2 when the suite could
// not run.
// -----------------------------------------------------------------------------
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminToken, bootDeliveryHub, createStubWorker, runDeliveryScenario, SIGNING_PATHS } from './golden/delivery-e2e.mjs';
import { egressFindings, egressHosts, runDeliveryChecks, switchVerdicts } from './golden/checks-hub/index.mjs';
import { ensureReleaseKeyFile, RELEASE_REPORT_SCHEMA, signReleaseReport } from '../lib/release-suite.js';
import { VOCAB_VERSION } from '../packages/suite/core/delivery/vocab.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..');
export const DEFAULT_FIXTURES = join(REPO, 'scripts', 'golden', 'fixtures-delivery');

export function parseArgs(argv = []) {
  const opts = { out: '', keyFile: '', fixtures: DEFAULT_FIXTURES };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--out') opts.out = value;
    else if (key === '--key-file') opts.keyFile = value;
    else if (key === '--fixtures') opts.fixtures = value;
    else throw new Error(`unknown option ${key}`);
    i += 1;
  }
  return opts;
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

export function defaultOutDir(env = process.env, now = new Date()) {
  const runs = String(env.GENERATED_RUNS_DIR || '').trim();
  return runs ? join(resolve(runs), 'release-suite', stamp(now)) : join(REPO, '.golden-reports', 'release-suite', stamp(now));
}

/** Runs a hub script in its own process from an empty folder (the data modules bind APP_DATA_DIR at load). */
function runHubScript(script, args, dataDir) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-suite-cwd-'));
  const env = { ...process.env, APP_DATA_DIR: dataDir, DATA_DIR: '', PERSIST_PRODUCTION_ENV: '0' };
  for (const key of Object.keys(env)) if (/^(HUB_SAFE_MODE|ADMIN_|GOLDEN_)/.test(key)) delete env[key];
  const out = spawnSync(process.execPath, [join(REPO, script), ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  rmSync(cwd, { recursive: true, force: true });
  if (out.status !== 0) throw new Error(`${script} failed: ${(out.stderr || out.stdout || '').slice(-2000)}`);
  return JSON.parse(out.stdout);
}

function readFixtureIndex(fixtures) {
  return JSON.parse(readFileSync(join(fixtures, 'index.json'), 'utf8')).clients || [];
}

function hostTokenFrom(file) {
  const line = readFileSync(file, 'utf8').split('\n').find((row) => row.startsWith('MAKER_LOCAL_HUB_TOKEN='));
  return line ? line.slice('MAKER_LOCAL_HUB_TOKEN='.length).trim() : '';
}

/** One end-to-end run on a fresh data folder. Returns { plan, timeline, checks, egress }. */
async function runOnce({ out, label, switches, fixtures, keyFile, log }) {
  const root = join(out, label);
  const dataDir = join(root, '.local-data', 'hub');
  mkdirSync(dataDir, { recursive: true });
  const index = readFixtureIndex(fixtures);
  const clients = index.map((entry, i) => ({
    id: `golden_${entry.id}`,
    fixture: entry.id,
    tier: entry.tier,
    language: entry.lang || 'nb',
    signing: SIGNING_PATHS[i % SIGNING_PATHS.length],
    brief: 'stub',
  }));
  const plan = { switches, releaseKeyFile: keyFile, makerHost: { label: 'Release suite stand-in Maker', tokenOut: join(root, 'maker-host.env') }, transcriptsOut: join(root, 'transcripts.json'), clients };
  writeFileSync(join(root, 'plan.json'), `${JSON.stringify({ ...plan, makerHost: { label: plan.makerHost.label } }, null, 2)}\n`);
  runHubScript('scripts/golden/seed-hub.mjs', ['--data-dir', dataDir, '--clients', 'all', '--fixtures-dir', fixtures], dataDir);
  const planFile = join(root, 'plan.private.json');
  writeFileSync(planFile, JSON.stringify(plan));
  const seeded = runHubScript('scripts/golden/seed-delivery.mjs', ['--data-dir', dataDir, '--plan', planFile], dataDir);
  rmSync(planFile, { force: true });
  const hub = await bootDeliveryHub({ hubDir: REPO, dataDir });
  try {
    const token = await adminToken(hub.base, dataDir);
    const worker = createStubWorker({ base: hub.base, hostToken: hostTokenFrom(plan.makerHost.tokenOut) });
    const jobInputs = Object.fromEntries(clients.map((client) => [client.id, { templateSetId: 'stub-template', language: client.language }]));
    const timeline = await runDeliveryScenario({ hub, token, plan, worker, jobInputs, jobTimeoutMs: 5 * 60_000, log });
    const ctx = { dataDir, plan, timeline, transcripts: JSON.parse(readFileSync(plan.transcriptsOut, 'utf8')), labelsDir: '', expect: { continued: {} }, outDir: root };
    const checks = await runDeliveryChecks(ctx);
    const hosts = egressHosts(hub.egressFile);
    return { plan, seeded, timeline, checks, ctx, egress: { hosts, findings: egressFindings(hosts, `${label} hub`) }, log: hub.log() };
  } finally {
    await hub.stop();
    rmSync(plan.makerHost.tokenOut, { force: true });
  }
}

function gitCommit() {
  try {
    return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Runs the suite and writes the signed report. Returns { report, file, exitCode }. */
export async function runReleaseSuite(opts = {}, { log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const out = resolve(opts.out || defaultOutDir());
  const fixtures = resolve(opts.fixtures || DEFAULT_FIXTURES);
  const keyFile = resolve(opts.keyFile || join(REPO, '.golden-reports', 'release-suite.key'));
  mkdirSync(out, { recursive: true });
  const key = ensureReleaseKeyFile(keyFile);
  const started = Date.now();
  const on = await runOnce({ out, label: 'switched-on', switches: 'on', fixtures, keyFile, log });
  const off = await runOnce({ out, label: 'control-off', switches: 'off', fixtures, keyFile, log });
  const controlFindings = [
    ...off.checks.filter((row) => row.status === 'fail').flatMap((row) => row.findings.map((finding) => `${row.id}: ${finding}`)),
    ...off.egress.findings,
  ];
  const verdicts = switchVerdicts(on.checks);
  if (on.egress.findings.length || controlFindings.length) {
    for (const row of Object.values(verdicts)) {
      if (row.status !== 'pass') continue;
      row.status = 'fail';
      row.findings = [...on.egress.findings, ...controlFindings.map((finding) => `control: ${finding}`)].slice(0, 10);
    }
  }
  const report = signReleaseReport({
    schema: RELEASE_REPORT_SCHEMA,
    createdAt: new Date().toISOString(),
    suite: 'delivery-e2e',
    code: { commit: gitCommit(), vocabVersion: VOCAB_VERSION },
    profile: 'stub-brief',
    clients: on.plan.clients.length,
    switches: verdicts,
    control: { ok: controlFindings.length === 0, findings: controlFindings.slice(0, 20) },
    metrics: {
      durationMs: Date.now() - started,
      checks: on.checks.map((row) => ({ id: row.id, status: row.status, findings: row.findings.slice(0, 10), value: row.value })),
      signingPaths: on.plan.clients.map((client) => client.signing),
      ticks: on.timeline.ticks.length,
      egressHosts: Object.keys(on.egress.hosts || {}).sort(),
    },
  }, key);
  const file = join(out, 'report.json');
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  for (const [label, run] of [['switched-on', on], ['control-off', off]]) writeFileSync(join(out, label, 'hub.log'), run.log);
  const failed = Object.entries(verdicts).filter(([, row]) => row.status === 'fail').map(([id]) => id);
  const passed = Object.entries(verdicts).filter(([, row]) => row.status === 'pass').map(([id]) => id);
  log(`[release-suite] report ${file}`);
  log(`[release-suite] passed: ${passed.join(', ') || 'none'}; failed: ${failed.join(', ') || 'none'}; control ${report.control.ok ? 'ok' : 'FAILED'}`);
  return { report, file, exitCode: failed.length || !report.control.ok ? 1 : 0, runs: { on: on.ctx, off: off.ctx } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  runReleaseSuite(opts).then(
    (result) => process.exit(result.exitCode),
    (error) => {
      process.stderr.write(`[release-suite] ${error?.stack || error}\n`);
      process.exit(2);
    },
  );
}

