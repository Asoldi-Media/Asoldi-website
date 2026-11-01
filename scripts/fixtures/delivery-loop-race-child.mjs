// Child process for scripts/delivery-loop.test.mjs: runs delivery ticks against the data dir in
// APP_DATA_DIR and records when its slow step starts and ends, so the parent can check that two
// processes never tick at the same time. Prints one JSON line with its tick results.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const ticks = Number(process.argv[2] || 8);
const log = join(process.env.APP_DATA_DIR, 'race-log.jsonl');
const { createDeliveryLoop } = await import('../../lib/delivery-loop.js');

const loop = createDeliveryLoop({
  sales: { getSalesClients: () => [] },
  hub: null,
  log: { warn() {}, error() {} },
  steps: [
    {
      name: 'slow',
      scope: 'global',
      run: async () => {
        appendFileSync(log, `${JSON.stringify({ pid: process.pid, edge: 'start', at: performance.timeOrigin + performance.now() })}\n`);
        await new Promise((resolve) => setTimeout(resolve, 120));
        appendFileSync(log, `${JSON.stringify({ pid: process.pid, edge: 'end', at: performance.timeOrigin + performance.now() })}\n`);
        return { wrote: false };
      },
    },
  ],
});

const results = [];
for (let i = 0; i < ticks; i += 1) {
  const result = await loop.tick();
  results.push(result.ran ? 'ran' : result.reason);
  await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 40)));
}
process.stdout.write(`${JSON.stringify({ pid: process.pid, results })}\n`);
