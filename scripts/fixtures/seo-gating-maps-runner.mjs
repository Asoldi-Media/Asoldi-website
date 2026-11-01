// Child process for scripts/seo-gating-fleet.test.mjs: runs one Maps-ranking pass of the code in
// --code-root (this tree or an extracted base commit) against APP_DATA_DIR and prints the ids that
// were ranked. Every request is answered here: DataForSEO with an empty result, anything else with
// an empty list, so nothing leaves the process.
//   node scripts/fixtures/seo-gating-maps-runner.mjs --code-root <dir>
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const index = process.argv.indexOf('--code-root');
const codeRoot = index === -1 ? '' : process.argv[index + 1];
if (!codeRoot) {
  console.error('usage: seo-gating-maps-runner.mjs --code-root <dir>');
  process.exit(2);
}

const requests = [];
globalThis.fetch = async (input) => {
  const url = String(typeof input === 'string' ? input : input?.url || input);
  requests.push(url);
  const body = /api\.dataforseo\.com/.test(url)
    ? { status_code: 20000, cost: 0, tasks: [{ status_code: 20000, cost: 0, result: [{ items: [], check_url: '', datetime: '2026-10-01 10:00:00 +00:00' }] }] }
    : [];
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

const scheduler = await import(pathToFileURL(join(codeRoot, 'lib', 'maps-ranking-scheduler.js')).href);
const result = await scheduler.runDueMapsRankingJobs({ limit: 100000 });
const file = join(process.env.APP_DATA_DIR, 'client-maps-ranking.json');
const ranked = existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort() : [];
let flushed = null;
try {
  const gating = await import(pathToFileURL(join(codeRoot, 'lib', 'seo-ops', 'job-gating.js')).href);
  await gating.flushDecisionDiff();
  flushed = gating.readDecisionDiff();
} catch {
  flushed = null;
}
console.log(JSON.stringify({ ran: result.ran, ranked, dataforseoCalls: requests.filter((url) => /dataforseo/.test(url)).length, decisionDiff: flushed }));
