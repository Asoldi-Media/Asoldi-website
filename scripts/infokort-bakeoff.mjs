/**
 * Live Claude Infokort bake-off against cards the Cursor tool already got right.
 * Does not write to asoldi.com. Needs ANTHROPIC_API_KEY and SerpAPI in env.
 *
 *   node scripts/infokort-bakeoff.mjs
 */
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runInfokortAgent, scoreInfokortMatch } from '../lib/infokort-agent.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(root, '.env') });
dotenv.config({ path: join(root, '.env.local') });

const CASES = [
  {
    name: 'Deles Are Terjesen',
    input: {
      businessName: 'Deles Are Terjesen',
      orgNumber: '925992720',
      contactPhone: '47 13 13 80',
      industry: 'reklamebyrå',
      meetingPlace: 'Meieriveien 5',
      websiteDomain: '',
      details: {},
    },
    expected: {
      industry: 'markedsplass',
      websiteDomain: 'tass.no',
      orgNumber: '925992720',
      meetingPlace: 'Vasøyveien 103, 7167 Vallersund',
      instagramUrl: 'https://www.instagram.com/tass.norge/',
      facebookUrl: 'https://www.facebook.com/tassnorge/',
      googleBusinessProfile: 'https://maps.google.com/?cid=5208062932965149043',
    },
  },
  {
    name: 'BAKKES BILPLEIE',
    input: {
      businessName: 'BAKKES BILPLEIE',
      orgNumber: '937366221',
      meetingPlace: 'Bråvann platå 64, 4624 KRISTIANSAND S',
      industry: '',
      websiteDomain: '',
      details: {},
    },
    expected: {
      industry: 'bilverksted',
      websiteDomain: '',
      orgNumber: '937366221',
      meetingPlace: 'Bråvann platå 64, 4624 KRISTIANSAND S',
      instagramUrl: '',
      facebookUrl: '',
      googleBusinessProfile: '',
    },
  },
];

const results = [];
for (const row of CASES) {
  process.stdout.write(`infokort bakeoff ${row.name}...\n`);
  const started = Date.now();
  const run = await runInfokortAgent(row.input);
  const score = run.ok
    ? scoreInfokortMatch(row.expected, run.submission)
    : { ok: false, failed: [run.skipped || 'agent-failed'], checks: {} };
  results.push({
    name: row.name,
    ok: score.ok,
    failed: score.failed,
    rounds: run.rounds,
    ms: Date.now() - started,
    industry: run.submission?.industry || '',
    websiteDomain: run.submission?.websiteDomain || '',
    brief: run.submission?.clientBrief?.short || '',
    usage: run.usage || {},
  });
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((row) => !row.ok);
if (failed.length) {
  console.error(`bakeoff failed: ${failed.map((row) => `${row.name} (${row.failed.join(',')})`).join('; ')}`);
  process.exit(1);
}
console.log('bakeoff passed');
