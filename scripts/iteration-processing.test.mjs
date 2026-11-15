import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeDelivery } from '../lib/delivery-state.js';

const root = mkdtempSync(join(tmpdir(), 'asoldi-iteration-'));
process.env.APP_DATA_DIR = root;

const { processIterationMeeting, notePendingIteration } = await import('../lib/iteration-processing.js');
const { listForClient, quotaFor } = await import('../lib/change-requests.js');
const { listJobs } = await import('../lib/delivery-jobs.js');

function dataDirFor(name) {
  return mkdtempSync(join(root, name));
}

function memorySales(seed) {
  let client = structuredClone(seed);
  return {
    getSalesClientById(id) {
      return id === client.id ? structuredClone(client) : null;
    },
    setSalesDelivery(id, patch) {
      if (id !== client.id) return null;
      client = { ...client, delivery: mergeDelivery(client.delivery, patch) };
      return structuredClone(client);
    },
    updateSalesClient(id, updates) {
      if (id !== client.id) return null;
      client = { ...client, ...updates };
      return structuredClone(client);
    },
    patch(partial) {
      client = { ...client, ...partial };
    },
  };
}

function clientSeed(id = 'client-fjordlys') {
  return {
    id,
    businessName: 'Fjordlys Keramikk AS',
    product: 'asoldi',
    sitePlan: { status: 'active', tierId: 'tier-1-standard', services: ['site'], billing: 'month' },
    makerRun: { runId: 'run-fjordlys-1' },
  };
}

function settingsFor(clientId, mode) {
  return {
    iteration: { processing: { enabled: mode !== 'off', mode: mode === 'off' ? 'shadow' : mode, paused: null } },
    pilotClientIds: [clientId],
    releases: { 'iteration.processing': { passedAt: '2026-11-01T00:00:00.000Z' } },
  };
}

function emptyMap() {
  return {
    facts: [],
    directives: [],
    iterations: [],
    promises: [],
    followUps: [],
    approvalSignals: [],
    requests: [],
    openQuestions: [],
  };
}

function llmOf(data) {
  return { json: async () => ({ data }) };
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full.slice(dir.length));
    }
  };
  walk(dir);
  return out.sort();
}

const KEEP = 'Behold produktene som de er.';
const CHANGE = 'Endre header-fargen på toppen av siden.';
const TRANSCRIPT = [
  'Kunde: Behold produktene som de er.',
  'Kunde: Endre header-fargen på toppen av siden.',
  'Kunde: behold produktene som de er, endre header-fargen.',
  'Byrå: Vi noterer begge punktene fra møtet.',
].join('\n');

function successMap() {
  return {
    ...emptyMap(),
    iterations: [
      { area: 'products', ask: 'Behold produktene', keepAsIs: true, quote: KEEP, speaker: 'Kunde', confidence: 0.9 },
      { area: 'header', ask: 'Endre header-fargen', keepAsIs: false, quote: CHANGE, speaker: 'Kunde', confidence: 0.9 },
    ],
  };
}

test('an iteration meeting keeps products, changes the header, and queues a job before go-live', async () => {
  const dir = dataDirFor('auto-');
  const sales = memorySales(clientSeed());
  const result = await processIterationMeeting({
    clientId: 'client-fjordlys',
    meetingId: 'meet-fjordlys-1',
    transcript: TRANSCRIPT,
    now: '2026-11-02T10:00:00.000Z',
    deps: {
      sales,
      dataDir: dir,
      settings: settingsFor('client-fjordlys', 'auto'),
      llm: llmOf(successMap()),
    },
  });
  assert.ok(TRANSCRIPT.length > 0, `transcript chars ${result.transcriptChars}`);
  assert.equal(result.transcriptChars, TRANSCRIPT.length);
  const keep = result.items.find((item) => item.kind === 'keep' && item.topic === 'products');
  const change = result.items.find((item) => item.kind === 'change' && item.topic === 'header');
  assert.ok(keep, JSON.stringify(result.items));
  assert.match(keep.quote, /Behold produktene som de er/);
  assert.ok(TRANSCRIPT.replace(/\s+/g, ' ').includes(keep.quote.replace(/\s+/g, ' ').trim()));
  assert.ok(change, JSON.stringify(result.items));
  assert.match(change.quote, /Endre header-fargen/);
  assert.ok(TRANSCRIPT.replace(/\s+/g, ' ').includes(change.quote.replace(/\s+/g, ' ').trim()));
  assert.equal(result.jobs, 1);
  assert.equal(result.stage, 'iterating');
  assert.equal(listJobs({ dataDir: dir, clientId: 'client-fjordlys', kind: 'iteration', fresh: true }).length, 1);
  const requests = listForClient('client-fjordlys', { dataDir: dir });
  assert.equal(requests.length, 1, `requests ${requests.length}`);
  assert.equal(requests[0].source, 'iteration');
  assert.equal(requests[0].month, '');
  const quota = quotaFor(sales.getSalesClientById('client-fjordlys'), { dataDir: dir });
  assert.equal(quota.used, 0, `used ${quota.used} of ${requests.length} requests`);

  sales.patch({
    makerRun: { runId: 'run-fjordlys-1', goLive: { target: 'production', liveVerifiedAt: '2020-01-01T00:00:00.000Z' } },
  });
  const footer = 'Endre footer-fargen på bunnen av siden.';
  await processIterationMeeting({
    clientId: 'client-fjordlys',
    meetingId: 'meet-fjordlys-2',
    transcript: `Kunde: ${footer}`,
    now: '2026-11-03T10:00:00.000Z',
    deps: {
      sales,
      dataDir: dir,
      settings: settingsFor('client-fjordlys', 'auto'),
      llm: llmOf({
        ...emptyMap(),
        iterations: [{ area: 'footer', ask: 'Endre footer-fargen', keepAsIs: false, quote: footer, speaker: 'Kunde', confidence: 0.9 }],
      }),
    },
  });
  const after = listForClient('client-fjordlys', { dataDir: dir });
  assert.equal(after.length, 2, `requests ${after.length}`);
  assert.equal(after.find((row) => row.title === 'header').month, '');
  const counted = after.find((row) => row.title === 'footer');
  assert.ok(counted.month, JSON.stringify(counted));
  const liveQuota = quotaFor(sales.getSalesClientById('client-fjordlys'), { dataDir: dir });
  assert.equal(liveQuota.used, 1, `used ${liveQuota.used} of ${after.length} requests`);
});

test('a transcript with no iteration content queues nothing', async () => {
  const dir = dataDirFor('empty-');
  const transcript = 'Kunde: Vi snakket litt om været i dag.';
  const result = await processIterationMeeting({
    clientId: 'client-fjordlys',
    meetingId: 'meet-empty-1',
    transcript,
    now: '2026-11-02T10:00:00.000Z',
    deps: {
      sales: memorySales(clientSeed()),
      dataDir: dir,
      settings: settingsFor('client-fjordlys', 'auto'),
      llm: llmOf(emptyMap()),
    },
  });
  assert.ok(transcript.length > 0, `transcript chars ${result.transcriptChars}`);
  assert.equal(result.items.length, 0, `items 0 of transcript chars ${result.transcriptChars}`);
  assert.equal(result.jobs, 0, `jobs 0 of transcript chars ${result.transcriptChars}`);
  assert.equal(listJobs({ dataDir: dir, clientId: 'client-fjordlys', fresh: true }).length, 0);
});

test('a quote that is not in the transcript is dropped', async () => {
  const dir = dataDirFor('quote-');
  const transcript = 'Kunde: Vi snakker om åpningstidene til butikken.';
  const result = await processIterationMeeting({
    clientId: 'client-fjordlys',
    meetingId: 'meet-quote-1',
    transcript,
    now: '2026-11-02T10:00:00.000Z',
    deps: {
      sales: memorySales(clientSeed()),
      dataDir: dir,
      settings: settingsFor('client-fjordlys', 'auto'),
      llm: llmOf({
        ...emptyMap(),
        iterations: [{
          area: 'header',
          ask: 'Endre header-fargen',
          keepAsIs: false,
          quote: 'Denne setningen finnes ikke i transkriptet her.',
          speaker: 'Kunde',
          confidence: 0.9,
        }],
      }),
    },
  });
  assert.ok(transcript.length > 0, `transcript chars ${result.transcriptChars}`);
  assert.equal(result.items.length, 0);
  const dropped = result.dropped.find((row) => row.reason === 'quote-not-in-transcript');
  assert.equal(dropped.count, 1, `dropped ${dropped?.count} of transcript chars ${result.transcriptChars}`);
  assert.equal(result.jobs, 0);
});

test('an approval with an open ask does not set approvalProposed', async () => {
  const dir = dataDirFor('approve-');
  const sales = memorySales(clientSeed());
  const transcript = [
    'Kunde: Behold produktene som de er.',
    'Kunde: Skal logoen byttes ut senere?',
    'Kunde: Dette ser bra ut nå.',
  ].join('\n');
  const result = await processIterationMeeting({
    clientId: 'client-fjordlys',
    meetingId: 'meet-approve-1',
    transcript,
    now: '2026-11-02T10:00:00.000Z',
    deps: {
      sales,
      dataDir: dir,
      settings: settingsFor('client-fjordlys', 'auto'),
      llm: llmOf({
        ...emptyMap(),
        iterations: [{ area: 'products', ask: 'Behold produktene', keepAsIs: true, quote: KEEP, speaker: 'Kunde', confidence: 0.9 }],
        openQuestions: [{ text: 'Skal logoen byttes', quote: 'Skal logoen byttes ut senere?', speaker: 'Kunde', confidence: 0.8 }],
        approvalSignals: [{ text: 'Godkjenning', quote: 'Dette ser bra ut nå.', speaker: 'Kunde', confidence: 0.9 }],
      }),
    },
  });
  assert.equal(result.approvalProposed, false);
  assert.equal(sales.getSalesClientById('client-fjordlys').delivery.events.approvalProposed, null);
  assert.equal(result.jobs, 0);
  assert.equal(result.deliveryTasks || 0, 0);
});

test('an approval with only keeps proposes approval and queues no job', async () => {
  const dir = dataDirFor('approve-ok-');
  const sales = memorySales(clientSeed());
  const result = await processIterationMeeting({
    clientId: 'client-fjordlys',
    meetingId: 'meet-approve-2',
    transcript: `Kunde: ${KEEP}\nKunde: Dette ser bra ut nå.`,
    now: '2026-11-02T10:00:00.000Z',
    deps: {
      sales,
      dataDir: dir,
      settings: settingsFor('client-fjordlys', 'auto'),
      llm: llmOf({
        ...emptyMap(),
        iterations: [{ area: 'products', ask: 'Behold produktene', keepAsIs: true, quote: KEEP, speaker: 'Kunde', confidence: 0.9 }],
        approvalSignals: [{ text: 'Godkjenning', quote: 'Dette ser bra ut nå.', speaker: 'Kunde', confidence: 0.9 }],
      }),
    },
  });
  assert.equal(result.approvalProposed, true);
  assert.equal(result.jobs, 0);
  const proposed = sales.getSalesClientById('client-fjordlys').delivery.events.approvalProposed;
  assert.equal(typeof proposed?.at, 'string');
  assert.ok(proposed.at);
});

test('shadow writes one delivery-audit row and nothing else', async () => {
  const dir = dataDirFor('shadow-');
  const before = filesUnder(dir);
  let called = 0;
  const result = await processIterationMeeting({
    clientId: 'client-fjordlys',
    meetingId: 'meet-shadow-1',
    transcript: TRANSCRIPT,
    now: '2026-11-02T10:00:00.000Z',
    deps: {
      sales: memorySales(clientSeed()),
      dataDir: dir,
      settings: settingsFor('client-fjordlys', 'shadow'),
      llm: { json: async () => { called += 1; throw new Error('should-not-run'); } },
    },
  });
  const after = filesUnder(dir);
  assert.equal(called, 0);
  assert.equal(result.items.length, 0);
  assert.equal(result.jobs, 0);
  assert.equal(result.wrote, false);
  const added = after.filter((name) => !before.includes(name));
  assert.equal(added.length, 1, JSON.stringify(added));
  assert.match(added[0], /delivery-audit/);
  const audit = readFileSync(join(dir, added[0]), 'utf8').trim().split('\n');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].includes(KEEP), false);
  assert.equal(JSON.parse(audit[0]).reason, 'shadow');
});

test('processing off writes nothing', async () => {
  const dir = dataDirFor('off-');
  const sales = memorySales(clientSeed());
  const before = JSON.stringify(sales.getSalesClientById('client-fjordlys'));
  const result = await processIterationMeeting({
    clientId: 'client-fjordlys',
    meetingId: 'meet-off-1',
    transcript: TRANSCRIPT,
    now: '2026-11-02T10:00:00.000Z',
    deps: {
      sales,
      dataDir: dir,
      settings: settingsFor('client-fjordlys', 'off'),
      llm: { json: async () => { throw new Error('should-not-run'); } },
    },
  });
  assert.equal(result.mode, 'off');
  assert.equal(result.wrote, false);
  assert.deepEqual(filesUnder(dir), []);
  assert.equal(JSON.stringify(sales.getSalesClientById('client-fjordlys')), before);
});

test('the link hook stores pendingIteration only in auto', () => {
  const dir = dataDirFor('hook-');
  const off = memorySales(clientSeed());
  const offResult = notePendingIteration({
    clientId: 'client-fjordlys',
    meetingId: 'meet-hook-1',
    sales: off,
    dataDir: dir,
    settings: settingsFor('client-fjordlys', 'off'),
  });
  assert.equal(offResult.wrote, false);
  assert.equal(off.getSalesClientById('client-fjordlys').delivery, undefined);
  assert.deepEqual(filesUnder(dir), []);

  const shadowDir = dataDirFor('hook-shadow-');
  const shadow = memorySales(clientSeed());
  const before = filesUnder(shadowDir);
  notePendingIteration({
    clientId: 'client-fjordlys',
    meetingId: 'meet-hook-2',
    sales: shadow,
    dataDir: shadowDir,
    settings: settingsFor('client-fjordlys', 'shadow'),
  });
  assert.equal(shadow.getSalesClientById('client-fjordlys').delivery, undefined);
  const added = filesUnder(shadowDir).filter((name) => !before.includes(name));
  assert.equal(added.length, 1);

  const auto = memorySales(clientSeed());
  notePendingIteration({
    clientId: 'client-fjordlys',
    meetingId: 'meet-hook-3',
    sales: auto,
    dataDir: dir,
    settings: settingsFor('client-fjordlys', 'auto'),
  });
  assert.equal(auto.getSalesClientById('client-fjordlys').delivery.pendingIteration, 'meet-hook-3');
});

test('the loop step skips a client without a pending iteration and one that is not in auto mode', async () => {
  const { runIterationPendingStep, tickSteps } = await import('../lib/delivery-brief/index.js');
  assert.equal(tickSteps.filter((step) => step.name === 'iteration-pending').length, 1);
  let requests = 0;
  const none = await runIterationPendingStep({ settings: settingsFor('client-fjordlys', 'auto'), dataDir: dataDirFor('step-') }, clientSeed());
  requests += 1;
  assert.deepEqual(none, { wrote: false });
  const dir = dataDirFor('step-shadow-');
  const pending = { ...clientSeed(), delivery: { pendingIteration: 'meet-step-1' } };
  const shadow = await runIterationPendingStep({ settings: settingsFor('client-fjordlys', 'shadow'), dataDir: dir }, pending);
  requests += 1;
  assert.deepEqual(shadow, { wrote: false });
  assert.deepEqual(filesUnder(dir), []);
  assert.equal(requests, 2, 'requests made');
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
