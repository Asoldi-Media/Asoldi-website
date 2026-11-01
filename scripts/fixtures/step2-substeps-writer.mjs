// Child process for scripts/step2-substeps-handoff.test.mjs.
// Loads the hub's data layer from --code-root (this tree or an older commit) against APP_DATA_DIR and
// applies Maker status handoffs to one client the way the status callback does
// (setSalesMakerRun(makerProgressPatchFromHandoff(handoff))), then one unrelated client update.
// Prints the stored makerRun as the last line.
//   node step2-substeps-writer.mjs --code-root <dir> <handoff.json> [<handoff.json> ...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--code-root');
const codeRoot = rootIndex === -1 ? process.cwd() : args[rootIndex + 1];
const files = args.filter((_, index) => index !== rootIndex && index !== rootIndex + 1);
const load = (rel) => import(pathToFileURL(join(codeRoot, rel)).href);

const sales = await load('data/sales.js');
const card = await load('lib/developer-card.js');

for (const file of files) {
  const handoff = JSON.parse(readFileSync(file, 'utf8'));
  sales.setSalesMakerRun('s2-client', { runId: 'run-s2', ...card.makerProgressPatchFromHandoff(handoff) });
}
sales.updateSalesClient('s2-client', { notes: 'touched after the handoffs' });
console.log(JSON.stringify(sales.getSalesClientById('s2-client')?.makerRun || null));
