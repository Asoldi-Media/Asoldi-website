// Keyword research jobs: when the hub queues seo.refresh and seo.maintenance.
// Both switches default off. Off queues nothing and does not read the producer state.
// The fixture is synthetic. APP_DATA_DIR is set before any hub module loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.APP_DATA_DIR || mkdtempSync(join(tmpdir(), 'hub-seo-jobs-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';
process.env.PERSIST_PRODUCTION_ENV = '0';

const { planSeoJobs, runSeoJobProducer, keywordJobsOn, keywordJobsStatePath } = await import('../lib/seo-ops/job-producer.js');
const settingsStore = await import('../data/automation-settings.js');
const { lifecycleJobBlock } = await import('../lib/delivery-lifecycle.js');

const FIX = JSON.parse(readFileSync(join(root, 'fixtures', 'seo-jobs', 'seo-jobs-1.json'), 'utf8'));
const ID = FIX.client.salesClientId;
const RUN = FIX.client.runId;
const LIVE_AT = '2026-12-01T00:00:00.000Z';
const PHRASES = [
  'frisør eksempelby',
  'herreklipp eksempelby',
  'barneklipp eksempelby',
  'voksne i nærområdet',
  'familier i nærområdet',
  'blocked phrase',
  'weekend loaves',
  'owner@syn-salon.test',
];
const ON = {
  development: { seoJobs: true },
  seo: { jobGating: { enabled: true, mode: 'auto', paused: null } },
};
const LIFE = {
  ...ON,
  pilotClientIds: [ID, 'syn-cancelled-client', 'syn-paused-client'],
  releases: { 'lifecycle.cancellation': { passedAt: '2026-11-01T00:00:00.000Z', suite: 'test', evidence: 'test', by: 'test' } },
  lifecycle: { cancellation: { enabled: true, mode: 'auto', paused: null }, paymentGraceDays: 14 },
};

function briefFrom(inputs, { version = 8, hash = '', note = '' } = {}) {
  const services = inputs.services.length
    ? [inputs.services[inputs.services.length - 1], ...inputs.services, inputs.services[0]]
    : [];
  const keywords = inputs.agreedKeywords.map((keyword) => ({
    phrase: `  ${keyword.toLocaleUpperCase('nb-NO')}  `,
    status: 'approved',
  }));
  return {
    version,
    hash,
    notes: note,
    contact: { email: 'owner@syn-salon.test' },
    media: { url: 'http://127.0.0.1/syn-salon' },
    sitePlan: { tierId: inputs.tierId, services },
    facts: {
      positioning: {
        audience: inputs.audience.map((value) => `  ${value}  `),
        services: ['weekend loaves'],
      },
    },
    seo: {
      agreedKeywords: [
        ...keywords,
        ...(keywords[0] ? [keywords[0]] : []),
        { phrase: 'blocked phrase', status: 'blocked' },
        { phrase: 'proposed phrase', status: 'proposed' },
      ],
    },
  };
}

function salon(inputs, { live = false, hash = '', version = 8, note = '', ...extra } = {}) {
  return {
    id: ID,
    runId: RUN,
    tierId: inputs.tierId,
    brief: briefFrom(inputs, { hash, version, note }),
    ...(live ? { makerRun: { goLive: { target: 'production', liveVerifiedAt: LIVE_AT } } } : {}),
    ...extra,
  };
}

function recorded(inputs, hash, period = '') {
  return {
    version: 1,
    updatedAt: '2026-11-01T00:00:00.000Z',
    clients: {
      [ID]: {
        seoInputsHash: hash,
        inputs,
        lastRefreshKey: '',
        lastMaintenancePeriod: period,
      },
    },
  };
}

function memory(initial) {
  let state = initial || { version: 1, updatedAt: '', clients: {} };
  return {
    state: () => state,
    async run(clients, { now, settings = ON, enqueue } = {}) {
      return runSeoJobProducer({
        settings,
        now,
        readClients: async () => clients,
        readState: async () => state,
        writeState: async (next) => { state = next; },
        enqueue: enqueue || (async (job) => ({ ok: true, job })),
      });
    },
  };
}

function assertSafe(input) {
  const raw = JSON.stringify(input);
  assert.ok(Buffer.byteLength(raw) <= FIX.limits.maxPayloadBytes, raw.length);
  assert.equal(input.contract, FIX.contract);
  assert.equal('salesClientId' in input, false);
  assert.equal('runId' in input, false);
  for (const phrase of PHRASES) assert.equal(raw.includes(phrase), false, phrase);
  assert.equal(/https?:\/\//i.test(raw), false);
  assert.equal(raw.includes('127.0.0.1'), false);
  assert.equal(raw.includes('localhost'), false);
  assert.equal(raw.includes('@'), false);
}

test('defaults leave both keyword switches off', () => {
  const defaults = settingsStore.defaultAutomationSettings();
  assert.equal(defaults.development.seoJobs, false);
  assert.equal(defaults.seo.jobGating.enabled, false);
  assert.equal(keywordJobsOn(defaults), false);
  assert.equal(keywordJobsOn(ON), true);
  assert.equal(keywordJobsOn({ development: { seoJobs: true }, seo: { jobGating: { enabled: true, mode: 'shadow', paused: null } } }), true);
  assert.equal(keywordJobsOn({ development: { seoJobs: true }, seo: { jobGating: { enabled: true, mode: 'shadow', paused: { reason: 'hold' } } } }), false);
});

test('planSeoJobs records the fixture hash and does not mutate its inputs', () => {
  const state = { version: 1, updatedAt: '', clients: {} };
  const before = structuredClone(state);
  const plan = planSeoJobs({ clients: [salon(FIX.firstSight.inputs)], settings: ON, now: FIX.maintenance[0].now, state });
  assert.deepEqual(state, before);
  assert.equal(plan.enqueue.length, 0);
  assert.equal(plan.state.clients[ID].seoInputsHash, FIX.firstSight.expect.recordedHash);
  assert.deepEqual(plan.state.clients[ID].inputs, FIX.firstSight.inputs);
});

test('switches off queue nothing and do not touch the producer state', async () => {
  const clients = [salon(FIX.firstSight.inputs), salon(FIX.firstSight.inputs, { id: 'syn-other-client' })];
  assert.ok(clients.length > 0);
  let reads = 0;
  let stateReads = 0;
  let writes = 0;
  let queued = 0;
  const result = await runSeoJobProducer({
    settings: settingsStore.defaultAutomationSettings(),
    now: FIX.maintenance[0].now,
    readClients: async () => { reads += 1; return clients; },
    readState: async () => { stateReads += 1; throw new Error('state read'); },
    writeState: async () => { writes += 1; throw new Error('state write'); },
    enqueue: async () => { queued += 1; throw new Error('enqueue'); },
  });
  assert.deepEqual(result, { ran: false });
  assert.equal(reads, 0);
  assert.equal(stateReads, 0);
  assert.equal(writes, 0);
  assert.equal(queued, 0);
  assert.equal(FIX.switchesOff.expect.ran, false);
  assert.equal(FIX.switchesOff.expect.stateRead, false);
  assert.equal(FIX.switchesOff.expect.queueWrites, 0);
  assert.equal(FIX.switchesOff.expect.storeWrites, 0);
  const onlyJobs = await runSeoJobProducer({
    settings: { development: { seoJobs: true }, seo: { jobGating: { enabled: false, mode: 'shadow', paused: null } } },
    readState: async () => { throw new Error('state read'); },
    enqueue: async () => { throw new Error('enqueue'); },
  });
  const onlyGating = await runSeoJobProducer({
    settings: { development: { seoJobs: false }, seo: { jobGating: { enabled: true, mode: 'auto', paused: null } } },
    readState: async () => { throw new Error('state read'); },
    enqueue: async () => { throw new Error('enqueue'); },
  });
  assert.equal(onlyJobs.ran, false);
  assert.equal(onlyGating.ran, false);
});

test('first sight records the fixture hash and queues nothing', async () => {
  const runner = memory();
  const result = await runner.run([salon(FIX.firstSight.inputs)], { now: FIX.maintenance[0].now });
  assert.equal(result.ran, true);
  assert.ok(result.clientsRead > 0);
  assert.equal(result.enqueued.length, FIX.firstSight.expect.jobs);
  assert.equal(result.state.clients[ID].seoInputsHash, FIX.firstSight.expect.recordedHash);
  assert.deepEqual(result.state.clients[ID].inputs, FIX.firstSight.inputs);
});

test('each fixture refresh matches the payload byte for byte', async () => {
  for (const row of FIX.refresh) {
    const runner = memory(recorded(row.before, row.seoInputsHashBefore));
    let seen = [];
    const result = await runner.run([
      salon(row.after, { hash: row.expect.input.briefHash, version: row.expect.input.briefVersion }),
    ], {
      now: FIX.maintenance[0].now,
      enqueue: async (job) => {
        seen = [...seen, job];
        return { ok: true, job };
      },
    });
    assert.equal(result.clientsRead > 0, true, row.id);
    assert.equal(result.enqueued.length, row.expect.jobs, row.id);
    assert.equal(seen[0].kind, row.expect.kind, row.id);
    assert.equal(seen[0].salesClientId, ID, row.id);
    assert.equal(seen[0].runId, RUN, row.id);
    assert.equal(JSON.stringify(result.enqueued[0]), JSON.stringify(row.expect.input), row.id);
    assert.deepEqual(result.enqueued[0], row.expect.input, row.id);
    assert.equal(result.state.clients[ID].seoInputsHash, row.seoInputsHashAfter, row.id);
    assert.equal(result.state.clients[ID].lastRefreshKey, row.expect.input.dedupeKey, row.id);
    assertSafe(result.enqueued[0]);
  }
});

test('a note-only edit and a second tick queue nothing', async () => {
  const runner = memory(recorded(FIX.noteOnly.inputs, FIX.firstSight.expect.recordedHash));
  const noted = await runner.run([
    salon(FIX.noteOnly.inputs, { live: false, note: 'Opening hours moved to the visit page.' }),
  ], { now: FIX.maintenance[0].now });
  assert.ok(noted.clientsRead > 0);
  assert.equal(noted.enqueued.length, FIX.noteOnly.expect.jobs);
  assert.equal(noted.state.clients[ID].seoInputsHash, FIX.firstSight.expect.recordedHash);

  const refresh = FIX.refresh[0];
  const again = memory(recorded(refresh.before, refresh.seoInputsHashBefore));
  const first = await again.run([
    salon(refresh.after, { hash: refresh.expect.input.briefHash, version: refresh.expect.input.briefVersion }),
  ], { now: FIX.maintenance[0].now });
  assert.equal(first.enqueued.length, 1);
  const second = await again.run([
    salon(refresh.after, { hash: refresh.expect.input.briefHash, version: refresh.expect.input.briefVersion }),
  ], { now: FIX.maintenance[0].now });
  assert.equal(second.enqueued.length, FIX.secondTick.expect.jobs);
  assert.equal(second.state.clients[ID].seoInputsHash, refresh.seoInputsHashAfter);
});

test('a duplicate answer does not advance the hash', async () => {
  const row = FIX.refresh[0];
  const runner = memory(recorded(row.before, row.seoInputsHashBefore));
  let calls = 0;
  const result = await runner.run([
    salon(row.after, { hash: row.expect.input.briefHash, version: row.expect.input.briefVersion }),
  ], {
    now: FIX.maintenance[0].now,
    enqueue: async (job) => {
      calls += 1;
      return { ok: false, status: 409, code: 'duplicate', job: { input: { dedupeKey: job.input.dedupeKey } } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.enqueued.length, FIX.duplicateActive.expect.jobs);
  assert.equal(FIX.duplicateActive.expect.hashAdvanced, false);
  assert.equal(result.state.clients[ID].seoInputsHash, row.seoInputsHashBefore);
  assert.equal(result.state.clients[ID].lastRefreshKey, '');
  assert.equal(runner.state().clients[ID].seoInputsHash, row.seoInputsHashBefore);
});

test('maintenance follows the fixture month, tier and go-live rules', async () => {
  const runner = memory();
  const base = FIX.firstSight.inputs;
  for (const row of FIX.maintenance) {
    if (row.id === 'contract-ended') continue;
    const inputs = { ...base, tierId: row.client.tierId, services: [...base.services], agreedKeywords: [...base.agreedKeywords], audience: [...base.audience] };
    const current = salon(inputs, { live: row.client.live === true, hash: 'sha256:' + 'ab'.repeat(32) });
    if (row.id === 'tier2-live-december' || row.id === 'same-month-again' || row.id === 'next-month') {
      const result = await runner.run([current], { now: row.now });
      assert.ok(result.clientsRead > 0, row.id);
      assert.equal(result.enqueued.length, row.expect.jobs, row.id);
      if (row.expect.input) {
        assert.equal(JSON.stringify(result.enqueued[0]), JSON.stringify(row.expect.input), row.id);
        assertSafe(result.enqueued[0]);
      }
      if (row.expect.period) assert.equal(result.enqueued[0].period, row.expect.period, row.id);
      assert.equal(result.state.clients[ID].seoInputsHash, FIX.firstSight.expect.recordedHash, row.id);
    } else {
      const fresh = memory();
      const result = await fresh.run([current], { now: row.now });
      assert.ok(result.clientsRead > 0, row.id);
      assert.equal(result.enqueued.length, row.expect.jobs, row.id);
    }
  }

  const custom = salon(
    { ...base, tierId: 'custom', services: [...base.services], agreedKeywords: [...base.agreedKeywords], audience: [...base.audience] },
    { live: true, id: 'syn-custom-client' },
  );
  const tier2 = salon(base, { live: true, id: 'syn-tier2-client' });
  const mixed = await memory().run([custom, tier2], { now: FIX.maintenance[0].now });
  assert.deepEqual(mixed.enqueued.map((input) => input.tierId), ['tier-2-seo']);
});

test('a cancelled, ended or paused contract queues nothing', async () => {
  const endedRow = FIX.maintenance.find((row) => row.id === 'contract-ended');
  const ended = salon(FIX.firstSight.inputs, {
    live: true,
    sitePlan: { tierId: endedRow.client.tierId, status: 'ended', services: ['site', 'seo'] },
  });
  assert.equal(lifecycleJobBlock(ended, 'seo.maintenance', { settings: LIFE, now: endedRow.now }), 'contract-ended');
  assert.equal(lifecycleJobBlock(ended, 'seo.refresh', { settings: LIFE, now: endedRow.now }), 'contract-ended');
  const endedRun = await memory().run([ended], { now: endedRow.now, settings: LIFE });
  assert.ok(endedRun.clientsRead > 0);
  assert.equal(endedRun.enqueued.length, endedRow.expect.jobs);

  const cancelled = salon(FIX.firstSight.inputs, {
    live: true,
    id: 'syn-cancelled-client',
    delivery: { events: { cancelled: { at: '2026-11-01T00:00:00.000Z' }, serviceEndsAt: '2027-06-01T00:00:00.000Z' } },
  });
  assert.equal(lifecycleJobBlock(cancelled, 'seo.maintenance', { settings: LIFE, now: endedRow.now }), 'contract-ended');
  const cancelledRun = await memory().run([cancelled], { now: endedRow.now, settings: LIFE });
  assert.equal(cancelledRun.enqueued.length, 0);

  const paused = salon(FIX.firstSight.inputs, {
    live: true,
    id: 'syn-paused-client',
    delivery: { events: { pausedAt: '2026-11-01T00:00:00.000Z' } },
  });
  assert.equal(lifecycleJobBlock(paused, 'seo.refresh', { settings: LIFE, now: endedRow.now }), 'paused');
  const pausedRun = await memory().run([paused], { now: endedRow.now, settings: LIFE });
  assert.equal(pausedRun.enqueued.length, 0);
});

test('one enqueue failure does not block the others and retries next tick', async () => {
  const ids = ['hearthloom', 'larkspur', 'copperkettle'];
  const clients = ids.map((id) => salon(FIX.firstSight.inputs, { id, live: false }));
  const runner = memory();
  const seen = await runner.run(clients, { now: FIX.maintenance[0].now });
  assert.equal(seen.enqueued.length, 0);
  assert.equal(seen.clientsRead, 3);
  const changed = ids.map((id) => salon(
    { ...FIX.refresh[0].after, services: [...FIX.refresh[0].after.services], agreedKeywords: [...FIX.refresh[0].after.agreedKeywords], audience: [...FIX.refresh[0].after.audience] },
    { id, live: false, hash: FIX.refresh[0].expect.input.briefHash, version: 8 },
  ));
  let queued = [];
  const failed = await runner.run(changed, {
    now: FIX.maintenance[0].now,
    enqueue: async (job) => {
      if (job.salesClientId === 'larkspur') throw new Error('queue full');
      queued = [...queued, job.salesClientId];
      return { ok: true };
    },
  });
  assert.equal(failed.clientsRead, 3);
  assert.deepEqual(queued, ['hearthloom', 'copperkettle']);
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.errors[0].clientId, 'larkspur');
  assert.equal(failed.errors[0].kind, 'seo.refresh');
  assert.equal(runner.state().clients.larkspur.seoInputsHash, seen.state.clients.larkspur.seoInputsHash);
  assert.equal(runner.state().clients.hearthloom.seoInputsHash, FIX.refresh[0].seoInputsHashAfter);
  let retried = [];
  const next = await runner.run(changed, {
    now: FIX.maintenance[0].now,
    enqueue: async (job) => {
      retried = [...retried, job.salesClientId];
      return { ok: true };
    },
  });
  assert.deepEqual(retried, ['larkspur']);
  assert.equal(next.enqueued.length, 1);
  assert.equal(next.errors.length, 0);
});

test('the delivery tick calls the producer only when both switches are on', () => {
  const source = readFileSync(join(root, '..', 'lib', 'delivery-loop.js'), 'utf8');
  const lines = source.split('\n').filter((line) => line.includes('runSeoJobProducer'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /development\?\.seoJobs === true/);
  assert.match(lines[0], /seo\?\.jobGating\?\.enabled === true/);
  assert.match(lines[0], /!settings\.seo\.jobGating\.paused/);
  const producer = readFileSync(join(root, '..', 'lib', 'seo-ops', 'job-producer.js'), 'utf8');
  assert.equal(producer.includes('fetch('), false);
  assert.equal(producer.includes('http.request'), false);
});

test('switches off leave the queue, the client files and a route answer unchanged', async () => {
  const clients = [
    { id: 'hearthloom', product: 'asoldi', businessName: 'Hearthloom Bakery', status: 'active', progression: { contractSigned: true } },
    { id: 'larkspur', product: 'asoldi', businessName: 'Larkspur Dental', status: 'active', progression: { contractSigned: true } },
  ];
  const sites = [
    { id: 'site-hearth', site_key: 'hearthloom', name: 'Hearthloom', domain: 'hearthloom.example', websitePlan: 'tier-1-standard' },
  ];
  assert.ok(clients.length > 0);
  assert.ok(sites.length > 0);
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify(clients, null, 2));
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(sites, null, 2));
  writeFileSync(join(dataDir, 'delivery-jobs.json'), `${JSON.stringify({ version: 1, jobs: [] }, null, 2)}\n`);
  const statePath = keywordJobsStatePath(dataDir);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({ version: 1, clients: { hearthloom: { seoInputsHash: 'sha256:abc', inputs: {}, lastRefreshKey: '', lastMaintenancePeriod: '' } } }, null, 2)}\n`);
  const saved = settingsStore.saveAutomationSettings(
    { delivery: { loop: { enabled: true, mode: 'shadow' } } },
    { by: 'test', dataDir },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  settingsStore.invalidateAutomationSettingsCache();

  const express = (await import('express')).default;
  const routes = await import('../lib/routes/delivery-jobs-routes.js');
  const { createDeliveryLoop, resetDeliveryLoopForTests } = await import('../lib/delivery-loop.js');
  const app = express();
  const pass = (_req, _res, next) => next();
  routes.register(app, {
    adminAuth: pass,
    makerAuth: { requireMakerHost: () => pass },
    developmentAuth: (req, _res, next) => { req.developmentUser = { isAdmin: true, accountKey: 'test' }; next(); },
    sales: {
      getSalesClients: () => clients,
      getSalesClientById: (id) => clients.find((row) => row.id === id) || null,
    },
    hub: {},
    getDataDir: () => dataDir,
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const answer = async () => {
    const res = await fetch(`${base}/api/admin/delivery/jobs`);
    return { status: res.status, body: await res.text() };
  };
  const files = () => ({
    queue: readFileSync(join(dataDir, 'delivery-jobs.json')),
    sites: readFileSync(join(dataDir, 'sites.json')),
    clients: readFileSync(join(dataDir, 'sales-clients.json')),
    state: readFileSync(statePath),
  });
  try {
    const beforeFiles = files();
    const beforeAnswer = await answer();
    assert.equal(beforeAnswer.status, 200);
    const off = await runSeoJobProducer({
      settings: settingsStore.getAutomationSettings({ dataDir, fresh: true }),
      now: FIX.maintenance[0].now,
      dataDir,
      readClients: async () => clients,
      readState: async () => { throw new Error('state read'); },
      writeState: async () => { throw new Error('state write'); },
      enqueue: async () => { throw new Error('enqueue'); },
    });
    assert.deepEqual(off, { ran: false });
    const loop = createDeliveryLoop({
      dataDir,
      steps: [],
      sales: {
        getSalesClients: () => clients,
        getSalesClientById: (id) => clients.find((row) => row.id === id) || null,
      },
      log: { warn() {}, error() {}, log() {} },
      now: () => Date.parse(FIX.maintenance[0].now),
      acquireLease: async () => ({ renew: async () => true, release: async () => true }),
    });
    const tick = await loop.tick();
    assert.equal(tick.ran, true);
    assert.ok(tick.clients > 0);
    const afterFiles = files();
    const afterAnswer = await answer();
    assert.deepEqual(afterFiles.queue, beforeFiles.queue);
    assert.deepEqual(afterFiles.sites, beforeFiles.sites);
    assert.deepEqual(afterFiles.clients, beforeFiles.clients);
    assert.deepEqual(afterFiles.state, beforeFiles.state);
    assert.equal(afterAnswer.status, beforeAnswer.status);
    assert.equal(afterAnswer.body, beforeAnswer.body);
  } finally {
    resetDeliveryLoopForTests();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a corrupt state file is kept as a sibling bak and then read as empty', async () => {
  const path = join(dataDir, 'seo-ops', 'keyword-jobs-repair.json');
  mkdirSync(dirname(path), { recursive: true });
  const broken = '{not-json';
  writeFileSync(path, broken);
  const result = await runSeoJobProducer({
    settings: ON,
    now: FIX.maintenance[0].now,
    dataDir,
    statePath: path,
    readClients: async () => [salon(FIX.firstSight.inputs)],
    enqueue: async () => ({ ok: true }),
  });
  assert.equal(result.ran, true);
  assert.equal(result.stateReport, 'corrupt');
  assert.equal(result.clientsRead, 1);
  assert.equal(result.enqueued.length, 0);
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), broken);
  const repaired = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(repaired.version, 1);
  assert.equal(repaired.clients[ID].seoInputsHash, FIX.firstSight.expect.recordedHash);
  assert.equal(existsSync(`${path}.bak`), true);
  writeFileSync(path, 'still-broken');
  await runSeoJobProducer({
    settings: ON,
    now: FIX.maintenance[0].now,
    dataDir,
    statePath: path,
    readClients: async () => [salon(FIX.firstSight.inputs)],
    enqueue: async () => ({ ok: true }),
  });
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), broken);
});
