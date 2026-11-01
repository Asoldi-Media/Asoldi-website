// Child process for scripts/delivery-loop.test.mjs: runs delivery ticks against the data dir in
// APP_DATA_DIR and records when its slow step starts and ends, so the parent can check that two
// processes never tick at the same time. Prints one JSON line with its tick results.
// Arguments: <ticks> [leaseMs] [stepMs] [until-ran]. A step longer than the lease shows that the
// lease is renewed while a tick runs; with until-ran the process keeps trying (every 20-60 ms)
// until it has run <ticks> ticks, so it contends for the lease the whole time the other one ticks.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const ticks = Number(process.argv[2] || 8);
const leaseMs = Number(process.argv[3] || 0) || undefined;
const stepMs = Number(process.argv[4] || 120);
const untilRan = process.argv[5] === 'until-ran';
const log = join(process.env.APP_DATA_DIR, 'race-log.jsonl');
const { createDeliveryLoop } = await import('../../lib/delivery-loop.js');

const loop = createDeliveryLoop({
  sales: { getSalesClients: () => [] },
  hub: null,
  log: { warn() {}, error() {} },
  leaseMs,
  steps: [
    {
      name: 'slow',
      scope: 'global',
      run: async () => {
        appendFileSync(log, `${JSON.stringify({ pid: process.pid, edge: 'start', at: performance.timeOrigin + performance.now() })}\n`);
        await new Promise((resolve) => setTimeout(resolve, stepMs));
        appendFileSync(log, `${JSON.stringify({ pid: process.pid, edge: 'end', at: performance.timeOrigin + performance.now() })}\n`);
        return { wrote: false };
      },
    },
  ],
});

const results = [];
for (let i = 0; i < (untilRan ? 2000 : ticks); i += 1) {
  const result = await loop.tick();
  results.push(result.aborted ? `aborted:${result.aborted}` : result.ran ? 'ran' : result.reason);
  if (untilRan && results.filter((value) => value === 'ran').length >= ticks) break;
  await new Promise((resolve) => setTimeout(resolve, untilRan ? 20 + Math.floor(Math.random() * 40) : Math.floor(Math.random() * 40)));
}
process.stdout.write(`${JSON.stringify({ pid: process.pid, results })}\n`);
