// The alert outbox test runs every tick on a clock of its own. This runs that test file with the
// process clock moved to one minute before and one minute after the default digest time (08:00 Oslo),
// so a step that still read the wall clock (and sent the digest next to the alert mail) fails here
// whatever the time of day the suite runs.
//
// Run: node --test scripts/delivery-alerts-outbox-clock.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// The dark-diff clock: with DARK_DIFF_CLOCK_START (epoch ms) the process clock starts there and runs on.
const CLOCK_PRELOAD = fileURLToPath(new URL('./ship/clock-preload.cjs', import.meta.url));

function runShifted(at, args) {
  // Without the runner's context variable the child prints its own report instead of the runner's
  // internal stream.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  return spawnSync(process.execPath, ['--require', CLOCK_PRELOAD, ...args], {
    cwd: root,
    env: { ...env, DARK_DIFF_CLOCK_START: String(Date.parse(at)) },
    encoding: 'utf8',
    timeout: 180_000,
  });
}

const OSLO_TIME = "console.log(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()))";

for (const [at, oslo] of [['2026-11-05T06:59:00.000Z', '07:59'], ['2026-11-05T07:01:00.000Z', '08:01']]) {
  test(`the alert outbox test passes with the process clock at ${oslo} Oslo time`, () => {
    const clock = runShifted(at, ['-e', OSLO_TIME]);
    assert.equal(clock.status, 0, clock.stderr);
    assert.equal(clock.stdout.trim(), oslo, 'the shifted clock is in place');
    const run = runShifted(at, ['--test-reporter=tap', 'scripts/delivery-alerts-outbox.test.mjs']);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-4000));
    assert.match(run.stdout, /^# pass [1-9]/m, 'the outbox tests ran');
    assert.match(run.stdout, /^# fail 0$/m);
  });
}
