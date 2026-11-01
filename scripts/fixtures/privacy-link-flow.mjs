// Child process for scripts/privacy-dark.test.mjs: one scripted run of the Fireflies link and unlink
// paths against APP_DATA_DIR, with the hub code from --code-root (this tree or an older commit).
// The linker is wired the way that commit's server.js wires it: with the privacy hooks when the code
// has lib/privacy-link-hooks.js, without them otherwise. The clock and Math.random are fixed, so two
// runs that write the same data write the same bytes.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FIXED = Date.parse('2026-11-01T09:00:00.000Z');
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(FIXED);
  }

  static now() {
    return FIXED;
  }
}
globalThis.Date = FixedDate;
let seed = 7;
Math.random = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const index = process.argv.indexOf('--code-root');
const codeRoot = index === -1 ? process.cwd() : process.argv[index + 1];
const load = (rel) => import(pathToFileURL(join(codeRoot, rel)).href);

const sales = await load('data/sales.js');
const webhook = await load('lib/fireflies-webhook.js');
const { createFirefliesLinker } = await load('lib/fireflies-linking.js');
const hooksPath = join(codeRoot, 'lib', 'privacy-link-hooks.js');
const hooks = existsSync(hooksPath) ? await import(pathToFileURL(hooksPath).href) : null;

const linker = createFirefliesLinker({
  sales,
  log: { warn() {} },
  ...(hooks ? {
    onLinked: (clientId, meetingId, info) => hooks.privacyOnLinked(clientId, meetingId, info),
    onUnlinked: (clientId, meetingId) => hooks.privacyOnUnlinked(clientId, meetingId),
  } : {}),
});

const person = (record, clientId) => webhook.meetingRefForClient(record, { clientId, confidence: 'manual', score: 100, reasons: ['Koblet manuelt av admin'], linkedBy: 'admin:flow' }, { linkedBy: 'admin:flow' });
const auto = (record, clientId) => webhook.meetingRefForClient(record, { clientId, confidence: 'high', score: 100, reasons: ['Google Meet-lenken matcher kundens møte'] }, { linkedBy: 'meet-link' });

const steps = [];
const rec1 = webhook.readStoredFirefliesMeeting('flow-rec-1');
const rec2 = webhook.readStoredFirefliesMeeting('flow-rec-2');
linker.link('flow-a', person(rec1, 'flow-a'));
steps.push('admin link');
linker.link('flow-a', auto(rec2, 'flow-a'));
steps.push('automatic link');
linker.setPurpose('flow-a', 'flow-rec-2', 'workshop', { by: 'Flow', actor: 'admin:flow' });
steps.push('purpose');
linker.unlinkFromHolder('flow-rec-1');
steps.push('admin unlink');
linker.link('flow-b', person(rec2, 'flow-b'));
steps.push('move');
linker.exclude('flow-b', 'flow-rec-2');
steps.push('exclude');
linker.link('flow-b', person(rec1, 'flow-b'));
steps.push('relink');
linker.backfill();
steps.push('backfill');
console.log(JSON.stringify({ steps }));
