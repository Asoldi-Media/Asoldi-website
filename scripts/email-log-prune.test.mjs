// The scheduled e-mail log prune: a background job (lib/safe-mode.js BACKGROUND_JOBS, started from
// server.js) that removes month files of the client-site e-mail log once their month ended more
// than 400 days ago, and touches nothing while no log exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-log-prune-'));
process.env.APP_DATA_DIR = dataDir;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const emailLog = await import('../lib/email-log.js');
const { BACKGROUND_JOBS } = await import('../lib/safe-mode.js');

const DAY = 24 * 60 * 60 * 1000;
/** The last millisecond of September 2025. */
const SEPTEMBER_END = Date.parse('2025-10-01T00:00:00.000Z') - 1;
const quiet = { log() {}, error() {} };

function writeMonth(dir, month, rows) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `messages-${month}.jsonl`), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}

test('without an e-mail log the prune creates nothing: no log folder, no lease, no lock file', async () => {
  const before = readdirSync(dataDir).sort();
  let leases = 0;
  const result = await emailLog.runEmailLogPrune({ now: Date.now(), acquire: async () => { leases += 1; return null; }, logger: quiet });
  assert.deepEqual(result, { ran: false, reason: 'no-log' });
  assert.equal(leases, 0, 'no lease was asked for');
  assert.deepEqual(readdirSync(dataDir).sort(), before, 'the data dir is unchanged');
  assert.equal(existsSync(join(dataDir, 'email-log')), false);
  assert.equal(existsSync(join(dataDir, 'email-locks')), false);
});

test('the prune removes a month file 401 days after its month ended and keeps it at 399 days', async () => {
  const dir = emailLog.emailLogDir();
  writeMonth(dir, '202509', [{ id: 'sep1', siteId: 's', kind: 'welcome', createdAt: '2025-09-02T00:00:00.000Z' }]);
  const kept = await emailLog.runEmailLogPrune({ now: SEPTEMBER_END + 399 * DAY, logger: quiet });
  assert.equal(kept.ran, true);
  assert.equal(kept.removed, 0);
  assert.equal(existsSync(join(dir, 'messages-202509.jsonl')), true, '399 days: kept');
  const removed = await emailLog.runEmailLogPrune({ now: SEPTEMBER_END + 401 * DAY, logger: quiet });
  assert.equal(removed.ran, true);
  assert.equal(removed.removed, 1);
  assert.equal(existsSync(join(dir, 'messages-202509.jsonl')), false, '401 days: removed');
  const rollup = JSON.parse(readFileSync(join(dir, 'rollup.json'), 'utf8'));
  assert.equal(rollup.months['202509'].messages, 1, 'the month keeps its rollup');
});

test('a second hub worker that holds the prune lease makes this one skip', async () => {
  const busy = await emailLog.runEmailLogPrune({ now: Date.now(), acquire: async () => null, logger: quiet });
  assert.deepEqual(busy, { ran: false, busy: true });
});

test('the loop runs the prune after its first delay, then on its interval, and never throws', async () => {
  const runs = [];
  const loop = emailLog.startEmailLogPruneLoop({ firstDelayMs: 5, everyMs: 20, logger: quiet, run: async () => { runs.push(Date.now()); throw new Error('disk gone'); } });
  try {
    const deadline = Date.now() + 5000;
    while (runs.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    loop.stop();
  }
  assert.ok(runs.length >= 2, `${runs.length} runs`);
  const after = runs.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(runs.length, after, 'stop() ends the loop');
});

test('the prune is a classified background job and server.js starts it exactly once', () => {
  assert.deepEqual(BACKGROUND_JOBS.emailLogPrune, { safe: 'on', key: '', note: 'local data only: e-mail log months older than 400 days' });
  const source = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('function startBackgroundJobs() {');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.equal(body.split('emailLogPrune: () => startEmailLogPruneLoop(),').length - 1, 1);
  assert.equal(source.split('startEmailLogPruneLoop(').length - 1, 1, 'started only from the job map');
});
