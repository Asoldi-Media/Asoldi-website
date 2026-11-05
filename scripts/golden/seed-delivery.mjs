#!/usr/bin/env node
// scripts/golden/seed-delivery.mjs
// -----------------------------------------------------------------------------
// Prepares a seeded local data folder (scripts/golden/seed-hub.mjs ran first) for a delivery end-to-end
// run: the delivery overlays per client, the automation switches, local release passes, a Maker host
// token and the brief extraction cache. Only folders below a `.local-data` directory are accepted.
// Run it in its own process, before the hub starts on the folder:
//
//   node scripts/golden/seed-delivery.mjs --data-dir .local-data/e2e --plan <plan.json>
//   node scripts/golden/seed-delivery.mjs --data-dir .local-data/e2e --export-briefs <dir> --plan <plan.json>
//
// The plan (JSON):
//   { "switches": "on" | "off",
//     "releaseKeyFile": "<operator key file>",          optional: the hub gets this release key
//     "makerHost": { "label": "...", "tokenOut": "<file>" },   optional: a Maker host with every
//                                                       scope; MAKER_LOCAL_HUB_TOKEN=<token> goes to
//                                                       tokenOut (owner-only), never to stdout
//     "clients": [{ "id": "<sales client id>", "fixture": "<fixture id>", "tier": "<tier id>",
//                   "language": "nb", "brief": "stub" | "replay" | "live",
//                   "briefReplayDir": "<dir>" }] }
//
// Per client (the overlay): the signing state is reset (no plan, not signed; meeting held and offer
// sent), one sent offer for the client's tier and its portal offer (so every signing path can sign),
// the meeting rows get their purpose from the seeded meeting id (…_sales, …_workshop), and the
// language is set.
// switches "on": every client is a pilot; signing auto, delivery.loop auto, gate shadow, brief auto,
// development.previewJobs on; the local release passes those need are recorded (suite local-e2e).
// switches "off": no settings are written at all (the control run: every spine switch off).
// Brief cache: "stub" writes a deterministic map answer per transcript chunk (it quotes the chunk's
// own lines, so the brief's quote check still runs); "replay" copies recorded answers from
// <briefReplayDir>/<fixture>/chunks/; "live" writes nothing (the hub calls its LLM).
// --export-briefs copies each client's cached answers to <dir>/<fixture>/chunks/ after a live run.
// Prints a JSON summary without secrets.
// -----------------------------------------------------------------------------
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalDataDir } from './seed-hub.mjs';

export const TIER_QUOTES = Object.freeze({
  'tier-1-standard': { tierId: 'starter', selected: [], pages: 5 },
  'tier-2-seo': { tierId: 'seo', selected: [], pages: 7 },
  'tier-3-ecommerce': { tierId: 'nettbutikk', selected: [], pages: 10 },
});
export const E2E_SUITE = 'local-e2e';
// The release passes a switched-on run needs locally (never on a real hub).
export const E2E_RELEASES = Object.freeze(['signing', 'delivery.loop', 'brief']);
const T0 = '2026-10-20T09:00:00.000Z';

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function parseSeedDeliveryArgs(argv = []) {
  const opts = { dataDir: '', plan: '', exportBriefs: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--data-dir') opts.dataDir = value;
    else if (key === '--plan') opts.plan = value;
    else if (key === '--export-briefs') opts.exportBriefs = value;
    else throw new Error(`unknown option ${key}`);
    i += 1;
  }
  if (!opts.dataDir) throw new Error('--data-dir is required');
  if (!opts.plan) throw new Error('--plan is required');
  return opts;
}

/** Lines "Speaker: text" of a chunk with at least `minWords` words, in order. */
export function quotableLines(chunkText, { minWords = 6 } = {}) {
  const out = [];
  for (const raw of String(chunkText || '').split('\n')) {
    const match = raw.match(/^([^:]{1,60}):\s*(.+)$/);
    if (!match) continue;
    const words = match[2].trim().split(/\s+/).filter(Boolean);
    if (words.length < minWords) continue;
    out.push({ speaker: match[1].trim(), words });
  }
  return out;
}

/**
 * The stub map answer for one chunk: a business fact and two directives (one must, one should), each
 * quoting the first words of a line of the chunk. Deterministic: it depends only on the chunk text.
 */
export function stubMapAnswer(chunkText) {
  const lines = quotableLines(chunkText);
  const quoteOf = (line) => line.words.slice(0, Math.min(12, line.words.length)).join(' ');
  const answer = { facts: [], directives: [], iterations: [], promises: [], followUps: [], approvalSignals: [], requests: [], openQuestions: [] };
  const [first, second, third] = lines;
  if (first) answer.facts.push({ path: 'positioning.businessWhat', value: first.words.slice(0, 8).join(' '), quote: quoteOf(first), speaker: first.speaker, confidence: 0.6 });
  if (second) answer.directives.push({ kind: 'add', scope: 'section', area: 'hero', ask: `Vis: ${second.words.slice(0, 6).join(' ')}`, priority: 'must', quote: quoteOf(second), speaker: second.speaker, confidence: 0.6 });
  if (third) answer.directives.push({ kind: 'change', scope: 'page', area: 'page:om-oss', ask: `Ta med: ${third.words.slice(0, 6).join(' ')}`, priority: 'should', quote: quoteOf(third), speaker: third.speaker, confidence: 0.6 });
  return answer;
}

async function hubModules() {
  return {
    sales: await import('../../data/sales.js'),
    settingsStore: await import('../../data/automation-settings.js'),
    makerHosts: await import('../../data/maker-hosts.js'),
    sources: await import('../../lib/delivery-brief/sources.js'),
    chunk: await import('../../lib/delivery-brief/chunk.js'),
    extract: await import('../../lib/delivery-brief/extract.js'),
    store: await import('../../lib/delivery-brief/store.js'),
    verify: await import('../../lib/delivery-brief/verify-quotes.js'),
    features: await import('../../lib/cms-features.js'),
    offers: await import('../../lib/offer-from-quote.js'),
    suite: await import('../../lib/release-suite.js'),
  };
}

function featureKeysOf(mods) {
  return (mods.features.FEATURE_NODES || []).map((node) => String(node?.key || '').trim()).filter(Boolean);
}

/** Every transcript chunk of a client as the brief rebuild sees it: [{ meeting, chunk, key, prompt }]. */
async function clientChunks(mods, client, dataDir) {
  const meetings = await mods.sources.readClientTranscripts(client, { log: { warn() {}, log() {} } });
  const featureKeys = featureKeysOf(mods);
  const cache = mods.extract.createChunkCache(mods.store.chunkCacheDir(client.id, { dataDir }));
  const out = [];
  for (const meeting of meetings) {
    const prompt = mods.extract.promptFor(meeting.purpose, { featureKeys });
    for (const chunk of mods.chunk.chunkTranscript(meeting.transcript)) {
      out.push({ meeting, chunk, prompt, key: cache.key(chunk.sha, prompt.promptHash), cache });
    }
  }
  return out;
}

async function seedBriefCache(mods, client, spec, dataDir) {
  const mode = String(spec.brief || 'stub');
  const rows = await clientChunks(mods, client, dataDir);
  const result = { mode, chunks: rows.length, written: 0, missing: [] };
  for (const row of rows) {
    if (mode === 'stub') {
      const normalized = mods.extract.normalizeMapOutput(stubMapAnswer(row.chunk.text), { featureKeys: featureKeysOf(mods) });
      // Only items whose quote the brief's own check accepts (it runs again when the brief is built).
      const { kept } = mods.verify.verifyItemQuotes(normalized.items.map((item) => ({ ...item, meetingId: row.meeting.meetingId })), new Map([[row.meeting.meetingId, row.meeting.transcript]]));
      const items = kept.map(({ meetingId: _meetingId, quoteVerified: _verified, ...item }) => item);
      row.cache.set(row.key, { key: row.key, chunkSha: row.chunk.sha, promptHash: row.prompt.promptHash, task: row.prompt.task, items, invalid: normalized.invalid, usd: 0, route: 'stub', at: T0 });
      result.written += 1;
    } else if (mode === 'replay') {
      const source = join(resolve(spec.briefReplayDir || ''), String(spec.fixture || client.id), 'chunks', `${row.key}.json`);
      if (!existsSync(source)) {
        result.missing.push(row.key);
        continue;
      }
      mkdirSync(row.cache.dir, { recursive: true });
      copyFileSync(source, join(row.cache.dir, `${row.key}.json`));
      result.written += 1;
    }
  }
  // The recorded merge answers (merge-<hash>.json) go along: the same items ask the same merge.
  if (mode === 'replay') {
    const dir = join(resolve(spec.briefReplayDir || ''), String(spec.fixture || client.id), 'chunks');
    const cacheDir = mods.store.chunkCacheDir(client.id, { dataDir });
    for (const name of existsSync(dir) ? readdirSync(dir).filter((file) => file.startsWith('merge-') && file.endsWith('.json')) : []) {
      mkdirSync(cacheDir, { recursive: true });
      copyFileSync(join(dir, name), join(cacheDir, name));
      result.merges = (result.merges || 0) + 1;
    }
  }
  return result;
}

function resetClient(mods, spec) {
  const client = mods.sales.getSalesClientById(spec.id);
  if (!client) throw new Error(`seed-delivery: no sales client ${spec.id} (run seed-hub first)`);
  const meetings = (Array.isArray(client.meetings) ? client.meetings : []).map((row) => {
    const purpose = String(row?.meetingId || '').match(/_(sales|demo|workshop|iteration)$/)?.[1] || '';
    return purpose ? { ...row, purpose } : row;
  });
  // The fields a fixture may carry from its signed past: signing starts from the offer.
  const record = {
    ...client,
    progression: { meetingHeld: true, offerSent: true, contractSigned: false },
    meetings,
    language: spec.language || client.language || 'nb',
    contractSentAt: T0,
  };
  for (const key of ['sitePlan', 'contractSignedAt', 'hubSite', 'makerRun', 'delivery', 'workshop', 'workshopAction']) delete record[key];
  return record;
}

function offerFor(mods, spec, client) {
  const quote = TIER_QUOTES[spec.tier];
  if (!quote) throw new Error(`seed-delivery: unknown tier ${spec.tier} for ${spec.id}`);
  const built = mods.offers.buildOfferFromMeetingQuote(quote);
  const email = String(client.contactEmail || '').trim();
  return {
    sales: {
      id: `so-e2e-${spec.id}`,
      salesClientId: spec.id,
      ownerId: '',
      status: 'sent',
      tierId: built.tierId,
      billing: built.billing,
      products: built.products,
      alternatives: built.alternatives,
      plan: built.plan,
      pricing: built.pricing,
      email: { subject: 'Tilbud på nettside', preheader: '', html: '<p>Tilbud</p>' },
      sentAt: T0,
      sentTo: email,
      createdAt: T0,
      updatedAt: T0,
    },
    portal: {
      id: `po-e2e-${spec.id}`,
      code: '',
      ownerId: '',
      salesClientId: spec.id,
      salesOfferId: `so-e2e-${spec.id}`,
      planId: spec.tier,
      planName: spec.tier,
      price: '',
      businessName: '',
      targetEmail: email,
      createdAt: T0,
      updatedAt: T0,
    },
  };
}

/** Writes the overlay, switches, passes, host and brief cache. Returns the summary (no secrets). */
export async function seedDelivery(opts) {
  const dataDir = assertLocalDataDir(opts.dataDir);
  if (resolve(String(process.env.APP_DATA_DIR || '')) !== dataDir) {
    throw new Error('seed-delivery: APP_DATA_DIR must be the --data-dir before the hub data modules load (run it as its own process)');
  }
  const plan = typeof opts.plan === 'string' ? readJson(resolve(opts.plan)) : opts.plan;
  if (!plan || !Array.isArray(plan.clients)) throw new Error('seed-delivery: the plan lists no clients');
  const mods = await hubModules();
  const summary = { dataDir, switches: plan.switches === 'on' ? 'on' : 'off', clients: [], releases: [], makerHost: null, releaseKey: null };

  // Clients and offers.
  const salesOffersFile = join(dataDir, 'sales-offers.json');
  const portalOffersFile = join(dataDir, 'client-offers.json');
  const ids = new Set(plan.clients.map((spec) => spec.id));
  const salesOffers = (readJson(salesOffersFile, []) || []).filter((offer) => !ids.has(offer?.salesClientId));
  const portalOffers = (readJson(portalOffersFile, []) || []).filter((offer) => !ids.has(offer?.salesClientId));
  for (const spec of plan.clients) {
    const record = resetClient(mods, spec);
    const clients = readJson(join(dataDir, 'sales-clients.json'), []);
    const list = Array.isArray(clients) ? clients : clients.clients || [];
    const index = list.findIndex((entry) => entry?.id === spec.id);
    list[index] = record;
    writeJson(join(dataDir, 'sales-clients.json'), Array.isArray(clients) ? list : { ...clients, clients: list });
    const offer = offerFor(mods, spec, record);
    salesOffers.push(offer.sales);
    portalOffers.push(offer.portal);
    summary.clients.push({ id: spec.id, fixture: spec.fixture || '', tier: spec.tier, language: record.language });
  }
  writeJson(salesOffersFile, salesOffers);
  writeJson(portalOffersFile, portalOffers);

  // Switches and local release passes.
  if (summary.switches === 'on') {
    for (const id of E2E_RELEASES) {
      const result = mods.settingsStore.recordReleasePass(id, { suite: E2E_SUITE, evidence: 'local delivery end-to-end data folder', by: 'seed-delivery', dataDir });
      if (!result.ok) throw new Error(`seed-delivery: ${result.error}`);
      summary.releases.push(id);
    }
    const saved = mods.settingsStore.saveAutomationSettings({
      pilotClientIds: plan.clients.map((spec) => spec.id),
      signing: { enabled: true, mode: 'auto' },
      delivery: { loop: { enabled: true, mode: 'auto' } },
      gate: { enabled: true, mode: 'shadow' },
      brief: { enabled: true, mode: 'auto' },
      development: { previewJobs: true },
    }, { dataDir, by: 'seed-delivery', reason: 'local delivery end-to-end run', source: 'seed' });
    if (!saved.ok) throw new Error(`seed-delivery: settings refused: ${JSON.stringify(saved.errors)}`);
  }
  if (plan.releaseKeyFile) {
    const key = mods.suite.readReleaseKeyFile(resolve(plan.releaseKeyFile));
    if (!key) throw new Error('seed-delivery: the release key file holds no key');
    summary.releaseKey = mods.suite.writeReleaseKeyFile(mods.suite.releaseKeyPath({ dataDir }), key);
  }

  // Maker host.
  if (plan.makerHost?.tokenOut) {
    const { host, token } = mods.makerHosts.createMakerHost({ label: plan.makerHost.label || 'Delivery end-to-end Maker', createdBy: 'seed-delivery' }, { dataDir });
    const out = resolve(plan.makerHost.tokenOut);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `MAKER_LOCAL_HUB_TOKEN=${token}\n`, { mode: 0o600 });
    try {
      chmodSync(out, 0o600);
    } catch {
      // Windows keeps its own ACLs
    }
    summary.makerHost = { hostId: host.hostId, scopes: host.scopes };
  }

  // Brief cache (after the clients are written: it reads their meetings). transcriptsOut gets the
  // transcripts as the brief reads them (local runs only: the checks verify quotes against them).
  const transcripts = {};
  for (const spec of plan.clients) {
    const client = readJson(join(dataDir, 'sales-clients.json'), []).find((entry) => entry?.id === spec.id);
    const row = summary.clients.find((entry) => entry.id === spec.id);
    row.brief = await seedBriefCache(mods, client, spec, dataDir);
    const meetings = await mods.sources.readClientTranscripts(client, { log: { warn() {}, log() {} } });
    transcripts[spec.id] = meetings.map((meeting) => ({ meetingId: meeting.meetingId, purpose: meeting.purpose, text: meeting.transcript }));
    row.meetings = meetings.map((meeting) => ({ meetingId: meeting.meetingId, purpose: meeting.purpose, chars: String(meeting.transcript || '').length }));
  }
  if (plan.transcriptsOut) {
    mkdirSync(dirname(resolve(plan.transcriptsOut)), { recursive: true });
    writeFileSync(resolve(plan.transcriptsOut), JSON.stringify(transcripts), { mode: 0o600 });
  }
  return summary;
}

/** Copies each client's cached map answers to <out>/<fixture>/chunks/ (after a live run). */
export function exportBriefCaches(opts) {
  const dataDir = assertLocalDataDir(opts.dataDir);
  const plan = typeof opts.plan === 'string' ? readJson(resolve(opts.plan)) : opts.plan;
  const out = resolve(opts.exportBriefs);
  const rows = [];
  for (const spec of plan.clients || []) {
    const dir = join(dataDir, 'delivery-briefs', spec.id, 'chunks');
    const target = join(out, String(spec.fixture || spec.id), 'chunks');
    const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
    mkdirSync(target, { recursive: true });
    let gaps = 0;
    for (const name of files) {
      const entry = readJson(join(dir, name), {});
      if (entry?.gap) gaps += 1;
      copyFileSync(join(dir, name), join(target, name));
    }
    rows.push({ id: spec.id, fixture: spec.fixture || '', chunks: files.length, gaps });
  }
  return { out, clients: rows };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let opts;
  try {
    opts = parseSeedDeliveryArgs(process.argv.slice(2));
    opts.dataDir = assertLocalDataDir(opts.dataDir);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.env.APP_DATA_DIR = opts.dataDir;
  process.env.DATA_DIR = '';
  process.env.PERSIST_PRODUCTION_ENV = '0';
  const run = opts.exportBriefs ? Promise.resolve().then(() => exportBriefCaches(opts)) : seedDelivery(opts);
  run.then(
    (summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`),
    (error) => {
      process.stderr.write(`[seed-delivery] ${error?.message || error}\n`);
      process.exit(1);
    },
  );
}

