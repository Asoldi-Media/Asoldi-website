// The delivery release suite end to end on two safe-mode hubs (switched on, and the control with every
// switch off), with invented clients and a stand-in Maker host. Then negative controls: the same checks
// on a changed copy of the switched-on data must fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const key of Object.keys(process.env)) if (/^(HUB_SAFE_MODE|APP_DATA_DIR|DATA_DIR|GENERATED_RUNS_DIR|ADMIN_)/.test(key)) delete process.env[key];

const { runReleaseSuite } = await import('./release-suite.mjs');
const { runDeliveryChecks, switchVerdicts } = await import('./golden/checks-hub/index.mjs');
const { verifyReleaseReport, readReleaseKeyFile } = await import('../lib/release-suite.js');
const { RELEASE_GATED_SWITCHES } = await import('../packages/suite/core/delivery/vocab.js');

const root = mkdtempSync(join(tmpdir(), 'release-suite-test-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

const COVERED = ['signing', 'delivery.loop', 'brief']; // gate and emails.postWorkshop run only in shadow here: not covered
let run;

test('the suite passes every switch it covers, marks the rest not covered, and signs the report', { timeout: 900_000 }, async () => {
  const keyFile = join(root, 'release.key');
  run = await runReleaseSuite({ out: join(root, 'out'), keyFile }, { log: () => {} });
  const failing = run.report.metrics.checks.filter((row) => row.status !== 'pass').map((row) => `${row.id}: ${row.findings.join('; ')}`);
  assert.equal(run.exitCode, 0, failing.join('\n') || JSON.stringify(run.report.control));
  const key = readReleaseKeyFile(keyFile);
  assert.deepEqual(verifyReleaseReport(run.report, { key }), { ok: true, problems: [], signature: 'valid' });
  for (const id of RELEASE_GATED_SWITCHES) {
    assert.equal(run.report.switches[id].status, COVERED.includes(id) ? 'pass' : 'not-covered', id);
  }
  assert.equal(run.report.control.ok, true);
  assert.deepEqual([...run.report.metrics.signingPaths].sort(), ['got-client', 'portal-accept', 'preview-accept', 'progression']);
  assert.deepEqual(run.report.metrics.egressHosts, [], 'the hub reached no host but loopback');
  const brief = run.report.metrics.checks.find((row) => row.id === 'delivery.brief').value;
  for (const [clientId, row] of Object.entries(brief)) assert.ok(row.directives >= 1 && row.verified === row.directives, clientId);
  // The report is written outside Git and holds no transcript text.
  const body = readFileSync(run.file, 'utf8');
  assert.doesNotMatch(body, /håndlagde sko|surdeig|fysioterapeuter/);
});

function copyRun() {
  const dir = mkdtempSync(join(tmpdir(), 'release-suite-negative-'));
  const dataDir = join(dir, '.local-data', 'hub');
  cpSync(run.runs.on.dataDir, dataDir, { recursive: true });
  return { ...run.runs.on, dataDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('negative controls: a missing brief, a second pre-workshop mail and an unfinished job each fail their check', { timeout: 120_000 }, async (t) => {
  if (!run) t.skip('the suite did not run');
  const clientId = run.runs.on.plan.clients[0].id;

  const noBrief = copyRun();
  rmSync(join(noBrief.dataDir, 'delivery-briefs', clientId), { recursive: true, force: true });
  const briefRows = await runDeliveryChecks(noBrief);
  assert.equal(briefRows.find((row) => row.id === 'delivery.brief').status, 'fail');
  assert.equal(switchVerdicts(briefRows).brief.status, 'fail');
  noBrief.cleanup();

  const twice = copyRun();
  const index = join(twice.dataDir, 'outbox', 'index.jsonl');
  const rows = readFileSync(index, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const pre = rows.find((row) => row.channel !== 'delivery-shadow');
  appendFileSync(index, `${JSON.stringify({ ...pre, id: `${pre.id}-again` })}\n`);
  const outboxRows = await runDeliveryChecks(twice);
  assert.equal(outboxRows.find((row) => row.id === 'delivery.outbox').status, 'fail');
  assert.equal(switchVerdicts(outboxRows).signing.status, 'fail');
  twice.cleanup();

  const stuck = copyRun();
  const jobsFile = join(stuck.dataDir, 'delivery-jobs.json');
  const jobs = JSON.parse(readFileSync(jobsFile, 'utf8'));
  const list = Array.isArray(jobs) ? jobs : jobs.jobs;
  list[0].status = 'failed';
  writeFileSync(jobsFile, JSON.stringify(jobs));
  const jobRows = await runDeliveryChecks(stuck);
  assert.equal(jobRows.find((row) => row.id === 'delivery.jobs').status, 'fail');
  assert.equal(switchVerdicts(jobRows)['delivery.loop'].status, 'fail');
  stuck.cleanup();

  // A transcript whose words no longer hold a directive's quote fails the quote check.
  const changed = { ...run.runs.on, transcripts: Object.fromEntries(Object.entries(run.runs.on.transcripts).map(([id, meetings]) => [id, meetings.map((meeting) => ({ ...meeting, text: 'Selger: Hei.\nKunde: Ingenting her.' }))])) };
  const quoteRows = await runDeliveryChecks(changed);
  assert.equal(quoteRows.find((row) => row.id === 'delivery.brief').status, 'fail');
  assert.ok(readdirSync(run.runs.on.dataDir).length > 0);
});
