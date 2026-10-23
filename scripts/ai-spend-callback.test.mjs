// The Maker's run.ai.spend callback -> makerRun.aiSpend, and the AI admin endpoints (WS0.19).
// Data-layer cases run in this process; the HTTP cases boot server.js from an empty folder with a temp
// data dir, safe mode on and the egress recorder enforcing (nothing leaves 127.0.0.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootHub } from './safe-mode/hub-boot.mjs';

const unitDir = mkdtempSync(join(tmpdir(), 'asoldi-ai-spend-unit-'));
process.env.APP_DATA_DIR = unitDir;
writeFileSync(join(unitDir, 'sales-clients.json'), JSON.stringify([
  { id: 'linked', product: 'asoldi', businessName: 'Linked AS', status: 'active', makerRun: { runId: 'run-linked', steps: { 1: 'ready' } } },
  { id: 'unlinked', product: 'asoldi', businessName: 'Unlinked AS', status: 'active' },
], null, 2));

const { normalizeRunAiSpend } = await import('../lib/ai-spend.js');
const sales = await import('../data/sales.js');
const { applyRunAiSpendCallback } = await import('../lib/llm/spend-callback.js');
const { createHubLedger } = await import('../lib/llm/ledger.js');

const diskClient = (dir, id) => JSON.parse(readFileSync(join(dir, 'sales-clients.json'), 'utf8')).find((client) => client.id === id);

test('normalizeRunAiSpend keeps bounded amounts and task keys, and refuses unusable input', () => {
  const clean = normalizeRunAiSpend({ totalUsd: '1.2345678', byTask: { 'step2.copywriter': 1, 'bad key!': 2, 'seo.meta': -1, 'legacy:step2': 0.2 }, calls: 7, profile: 'Legacy', at: '2026-10-23T10:00:00Z', extra: 'dropped' }, { runId: 'r1', receivedAt: '2026-10-23T10:00:01Z' });
  assert.deepEqual(clean, {
    runId: 'r1',
    totalUsd: 1.234568,
    byTask: { 'step2.copywriter': 1, 'legacy:step2': 0.2 },
    at: '2026-10-23T10:00:00.000Z',
    receivedAt: '2026-10-23T10:00:01.000Z',
    calls: 7,
    profile: 'legacy',
  });
  assert.equal(normalizeRunAiSpend({ byTask: { 'a.b': 0.5, 'c.d': 0.25 } }, { runId: 'r' }).totalUsd, 0.75, 'the total falls back to the task sum');
  assert.equal(normalizeRunAiSpend({ totalUsd: 'abc' }), null);
  assert.equal(normalizeRunAiSpend({ totalUsd: -1 }), null);
  assert.equal(normalizeRunAiSpend({ totalUsd: 1e9 }), null);
  assert.equal(normalizeRunAiSpend({}), null);
  assert.equal(normalizeRunAiSpend(null), null);
});

test('only the callback writer stores makerRun.aiSpend: a set-maker-run patch or a client update cannot', () => {
  const stored = sales.setSalesMakerRunAiSpend('linked', { runId: 'run-linked', totalUsd: 0.5, byTask: { 'step2.copywriter': 0.5 }, at: '2026-10-23T09:00:00Z' });
  assert.equal(stored.stored, true);
  assert.equal(diskClient(unitDir, 'linked').makerRun.aiSpend.totalUsd, 0.5);

  // A rep's set-maker-run body (setSalesMakerRun) carrying aiSpend: ordinary keys apply, aiSpend does not.
  const patched = sales.setSalesMakerRun('linked', { runId: 'run-linked', latestReadyStep: '2', aiSpend: { runId: 'run-linked', totalUsd: 999 } });
  assert.equal(patched.makerRun.latestReadyStep, '2');
  assert.equal(patched.makerRun.aiSpend.totalUsd, 0.5);
  // A direct client update with a makerRun object cannot replace it either.
  const updated = sales.updateSalesClient('linked', { makerRun: { aiSpend: { runId: 'run-linked', totalUsd: 999 } } });
  assert.equal(updated.makerRun.aiSpend.totalUsd, 0.5);
  assert.equal(diskClient(unitDir, 'linked').makerRun.aiSpend.totalUsd, 0.5);
  // Other writes keep the stored value (the normaliser owns the key).
  assert.equal(sales.setSalesMakerRun('linked', { runId: 'run-linked', intakeStatus: 'done' }).makerRun.aiSpend.totalUsd, 0.5);

  // Wrong run, no linked run, older snapshot, invalid amounts, no snapshot time: nothing is stored.
  const at = '2026-10-23T09:30:00Z';
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-other', totalUsd: 3, at }).reason, 'not-linked-run');
  assert.equal(sales.setSalesMakerRunAiSpend('unlinked', { runId: 'run-any', totalUsd: 3, at }).reason, 'not-linked-run');
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-linked', totalUsd: 3, at: '2026-10-22T00:00:00Z' }).reason, 'older');
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-linked', totalUsd: 'x', at }).reason, 'invalid');
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-linked', totalUsd: 3 }).reason, 'missing-at', 'a snapshot without its own time is refused');
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-linked', totalUsd: 3, at: 'yesterday' }).reason, 'missing-at');
  assert.equal(diskClient(unitDir, 'linked').makerRun.aiSpend.totalUsd, 0.5);
  assert.equal(diskClient(unitDir, 'unlinked').makerRun?.aiSpend, undefined);

  // Clearing the run (a new run follows) drops the run's spend from the client; the history keeps it.
  const cleared = sales.replaceSalesMakerRun('linked', { runId: 'run-new', aiSpend: { runId: 'run-new', totalUsd: 999 } });
  assert.equal(cleared.makerRun.aiSpend, undefined);
});

test('a client relinked to another run does not show the previous run\'s spend', () => {
  sales.replaceSalesMakerRun('linked', { runId: 'run-a' });
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-a', totalUsd: 0.7, at: '2026-10-23T09:00:00Z' }).stored, true);
  assert.equal(sales.getSalesClientById('linked').makerRun.aiSpend.runId, 'run-a');
  // A set-maker-run merge to a new run id (the rep relinks the client).
  const relinked = sales.setSalesMakerRun('linked', { runId: 'run-b' });
  assert.equal(relinked.makerRun.runId, 'run-b');
  assert.equal(relinked.makerRun.aiSpend, undefined, 'run-a spend is not shown as run-b spend');
  assert.equal(diskClient(unitDir, 'linked').makerRun.aiSpend, undefined);
  // The new run's own snapshot is stored as usual.
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-b', totalUsd: 0.2, at: '2026-10-23T09:05:00Z' }).stored, true);
  assert.equal(sales.getSalesClientById('linked').makerRun.aiSpend.totalUsd, 0.2);
});

test('at the same snapshot time, the snapshot with more calls wins', () => {
  sales.replaceSalesMakerRun('linked', { runId: 'run-c' });
  const at = '2026-10-23T10:00:00Z';
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-c', totalUsd: 0.9, calls: 9, at }).stored, true);
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-c', totalUsd: 0.4, calls: 4, at }).reason, 'older');
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-c', totalUsd: 0.5, at }).reason, 'older', 'no call count at the same time is not newer');
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-c', totalUsd: 1.1, calls: 11, at }).stored, true);
  assert.equal(sales.getSalesClientById('linked').makerRun.aiSpend.totalUsd, 1.1);
  const ledger = createHubLedger({ dataDir: unitDir });
  ledger.recordMakerSpend('history-only', { runId: 'run-c', totalUsd: 1.1, calls: 11, at: '2026-10-23T10:00:00.000Z' });
  ledger.recordMakerSpend('history-only', { runId: 'run-c', totalUsd: 0.3, calls: 3, at: '2026-10-23T10:00:00.000Z' });
  assert.equal(ledger.makerSpendFor('history-only').runs.find((run) => run.runId === 'run-c').totalUsd, 1.1);
});

test('applyRunAiSpendCallback stores the snapshot on the client and in the per-run history', () => {
  sales.replaceSalesMakerRun('linked', { runId: 'run-linked' });
  const ledger = createHubLedger({ dataDir: unitDir });
  const ok = applyRunAiSpendCallback({ sales, client: sales.getSalesClientById('linked'), runId: 'run-linked', body: { event: 'run.ai.spend', totalUsd: 1.25, byTask: { 'step2.copywriter': 1, 'seo.meta': 0.25 }, at: '2026-10-23T11:00:00Z' }, ledger });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stored, true);
  assert.equal(ledger.makerSpendFor('linked').totalUsd, 1.25);
  const newer = applyRunAiSpendCallback({ sales, client: sales.getSalesClientById('linked'), runId: 'run-linked', body: { aiSpend: { totalUsd: 2, at: '2026-10-23T12:00:00Z' } }, ledger });
  assert.equal(newer.body.stored, true);
  assert.equal(ledger.makerSpendFor('linked').totalUsd, 2, 'a newer snapshot of the same run replaces the older one');
  const bad = applyRunAiSpendCallback({ sales, client: sales.getSalesClientById('linked'), runId: 'run-linked', body: { totalUsd: 'NaN', at: '2026-10-23T12:30:00Z' }, ledger });
  assert.equal(bad.status, 400);
  const noTime = applyRunAiSpendCallback({ sales, client: sales.getSalesClientById('linked'), runId: 'run-linked', body: { totalUsd: 3 }, ledger });
  assert.equal(noTime.status, 400);
  assert.match(noTime.body.message, /\bat\b/);
  assert.equal(ledger.makerSpendFor('linked').totalUsd, 2);
});

// The body the Maker sends (website-maker lib/sales-sync.js buildRunAiSpendPayload through
// postSalesCallback): ledger v2 groups { usd, calls } per task and provider, plus run fields the hub ignores.
function makerSpendBody({ runId = 'run-linked', salesClientId = 'linked', at = '2026-10-23T13:00:00.000Z' } = {}) {
  return {
    at,
    runId,
    source: 'sales',
    salesClientId,
    salesOrderId: '',
    event: 'run.ai.spend',
    totalUsd: 0.42,
    byTask: {
      'step2.copywriter': { usd: 0.3, calls: 4 },
      'seo.meta': { usd: 0.12, calls: 2 },
    },
    byProvider: { claude: { usd: 0.4, calls: 5 }, deepseek: { usd: 0.02, calls: 1 } },
    calls: 6,
    unverifiedUsd: 0.01,
    target: '2.1',
    status: 'done',
    ledgerVersion: 2,
  };
}

test('normalizeRunAiSpend reads the Maker\'s { usd, calls } groups and stores a shape that reads back unchanged', () => {
  const stored = normalizeRunAiSpend(makerSpendBody(), { runId: 'run-linked', receivedAt: '2026-10-23T13:00:01Z' });
  assert.deepEqual(stored, {
    runId: 'run-linked',
    totalUsd: 0.42,
    byTask: { 'step2.copywriter': 0.3, 'seo.meta': 0.12 },
    callsByTask: { 'step2.copywriter': 4, 'seo.meta': 2 },
    byProvider: { claude: 0.4, deepseek: 0.02 },
    at: '2026-10-23T13:00:00.000Z',
    receivedAt: '2026-10-23T13:00:01.000Z',
    calls: 6,
    unverifiedUsd: 0.01,
  });
  assert.deepEqual(normalizeRunAiSpend(stored), stored, 'the stored shape normalizes to itself');
  // Without totalUsd the total is the sum of the task groups (not a 400).
  const { totalUsd, ...noTotal } = makerSpendBody();
  assert.equal(totalUsd, 0.42);
  assert.equal(normalizeRunAiSpend(noTotal).totalUsd, 0.42);
  // Bad groups are skipped one by one: no amount, a negative amount, a bad call count.
  const mixed = normalizeRunAiSpend({ totalUsd: 1, byTask: { 'a.ok': { usd: 0.5, calls: 2 }, 'b.none': { calls: 3 }, 'c.neg': { usd: -1 }, 'd.calls': { usd: 0.1, calls: 1.5 }, 'e.num': 0.2 } });
  assert.deepEqual(mixed.byTask, { 'a.ok': 0.5, 'd.calls': 0.1, 'e.num': 0.2 });
  assert.deepEqual(mixed.callsByTask, { 'a.ok': 2 });
});

test('applyRunAiSpendCallback keeps the Maker\'s per-task spend on the client, in the per-run history and in the spend totals', () => {
  sales.replaceSalesMakerRun('linked', { runId: 'run-linked' });
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-ai-spend-maker-'));
  const ledger = createHubLedger({ dataDir: dir });
  const result = applyRunAiSpendCallback({ sales, client: sales.getSalesClientById('linked'), runId: 'run-linked', body: makerSpendBody(), ledger });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.stored, true);
  const onClient = diskClient(unitDir, 'linked').makerRun.aiSpend;
  assert.deepEqual(onClient.byTask, { 'step2.copywriter': 0.3, 'seo.meta': 0.12 });
  assert.deepEqual(onClient.callsByTask, { 'step2.copywriter': 4, 'seo.meta': 2 });
  assert.deepEqual(onClient.byProvider, { claude: 0.4, deepseek: 0.02 });
  assert.equal(onClient.unverifiedUsd, 0.01);
  const history = JSON.parse(readFileSync(join(dir, 'ai', 'maker-spend.json'), 'utf8')).clients.linked.runs['run-linked'];
  assert.deepEqual(history.byTask, { 'step2.copywriter': 0.3, 'seo.meta': 0.12 });
  const spend = ledger.makerSpendFor('linked');
  assert.equal(spend.totalUsd, 0.42);
  assert.deepEqual(spend.byTask, { 'step2.copywriter': 0.3, 'seo.meta': 0.12 });
  assert.deepEqual(spend.byProvider, { claude: 0.4, deepseek: 0.02 });
  assert.equal(spend.calls, 6);
});

test('Maker spend in a date range: a run counts at its newest snapshot time, and the current run is never added twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-ai-spend-range-'));
  const ledger = createHubLedger({ dataDir: dir });
  const october = { runId: 'run-oct', totalUsd: 3, byTask: { 'step2.copywriter': 3 }, at: '2026-10-15T10:00:00.000Z' };
  ledger.recordMakerSpend('c-range', october);
  const range = (month) => ({ from: `${month}-01T00:00:00.000Z`, to: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1) - 1).toISOString() });
  assert.equal(ledger.makerSpendFor('c-range', range('2026-10')).totalUsd, 3);
  // The client's current snapshot is the same run (already in the history): not counted again, in no month.
  assert.equal(ledger.makerSpendFor('c-range', { ...range('2026-10'), current: october }).totalUsd, 3);
  assert.equal(ledger.makerSpendFor('c-range', { ...range('2026-11'), current: october }).totalUsd, 0);
  assert.equal(ledger.makerSpendFor('c-range', { ...range('2026-09'), current: october }).totalUsd, 0);
  // A current run the history does not have (its history write failed) counts only in its own month.
  const lost = { runId: 'run-lost', totalUsd: 2, byTask: { 'seo.meta': 2 }, at: '2026-11-03T09:00:00.000Z' };
  assert.equal(ledger.makerSpendFor('c-range', { ...range('2026-11'), current: lost }).totalUsd, 2);
  assert.deepEqual(ledger.makerSpendFor('c-range', { ...range('2026-11'), current: lost }).byTask, { 'seo.meta': 2 });
  assert.equal(ledger.makerSpendFor('c-range', { ...range('2026-10'), current: lost }).totalUsd, 3);
  assert.equal(ledger.makerSpendFor('c-range', { current: lost }).totalUsd, 5, 'no range: every run');
});

// ---------------------------------------------------------------- AI admin routes in this process
// registerAiAdminRoutes on a bare express app (127.0.0.1, admin check stubbed): this process has no
// safe mode and no AI_PROFILE, like a production hub.
async function adminRoutesApp({ registered, sales: salesStub = null }) {
  const express = (await import('express')).default;
  const { registerAiAdminRoutes } = await import('../lib/llm/routes.js');
  const { createHubLlm } = await import('../lib/llm/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-ai-routes-'));
  const facade = createHubLlm({ dataDir: dir, env: { ANTHROPIC_API_KEY: '' }, log: { warn() {}, log() {} } });
  const app = express();
  app.use(express.json());
  registerAiAdminRoutes(app, { adminAuth: (req, res, next) => next(), sales: salesStub, registered: () => (registered ? facade : null), facade: () => facade });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = async (body) => {
    const res = await fetch(`${base}/api/admin/ai/routes`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const status = async () => (await fetch(`${base}/api/admin/ai/status`)).json();
  const spend = async (query) => (await fetch(`${base}/api/admin/ai/spend?${new URLSearchParams(query)}`)).json();
  return { dir, facade, put, status, spend, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('GET /api/admin/ai/spend?salesClientId= counts the client\'s current run only in the range of its snapshot time', async () => {
  const october = { runId: 'run-oct', totalUsd: 3, byTask: { 'step2.copywriter': 3 }, at: '2026-10-15T10:00:00.000Z' };
  let current = october;
  const app = await adminRoutesApp({ registered: true, sales: { getSalesClientById: (id) => (id === 'c-range' ? { id, makerRun: { runId: current.runId, aiSpend: current } } : null) } });
  try {
    app.facade.ledger.recordMakerSpend('c-range', october);
    const month = (from, to) => app.spend({ salesClientId: 'c-range', from, to });
    assert.equal((await month('2026-10-01T00:00:00Z', '2026-10-31T23:59:59Z')).maker.totalUsd, 3);
    const november = await month('2026-11-01T00:00:00Z', '2026-11-30T23:59:59Z');
    assert.equal(november.maker.totalUsd, 0, 'an October run is not November spend');
    assert.deepEqual(november.maker.runs, []);
    assert.equal(november.totalUsd, 0);
    assert.equal((await month('2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z')).maker.totalUsd, 0);
    // A current run that never reached the per-run history counts in its own month only.
    current = { runId: 'run-new', totalUsd: 2, byTask: { 'seo.meta': 2 }, at: '2026-11-03T09:00:00.000Z' };
    const withNew = await month('2026-11-01T00:00:00Z', '2026-11-30T23:59:59Z');
    assert.equal(withNew.maker.totalUsd, 2);
    assert.deepEqual(withNew.maker.byTask, { 'seo.meta': 2 });
    assert.equal((await month('2026-10-01T00:00:00Z', '2026-10-31T23:59:59Z')).maker.totalUsd, 3);
  } finally {
    await app.close();
  }
});

test('PUT /api/admin/ai/routes: outside safe mode the override may choose legacy or prod only', async () => {
  delete process.env.AI_PROFILE;
  const { registerHubLlm } = await import('../lib/llm-hooks.js');
  const app = await adminRoutesApp({ registered: true });
  try {
    for (const profile of ['record', 'replay', 'test']) {
      const res = await app.put({ profile });
      assert.equal(res.status, 400, profile);
      assert.match(res.body.errors.join(' '), /safe mode/, profile);
    }
    assert.equal(existsSync(join(app.dir, 'ai-routes.override.json')), false, 'nothing was written');
    const prod = await app.put({ profile: 'prod' });
    assert.equal(prod.status, 200);
    assert.equal(prod.body.profile, 'prod');
    // A hand-written override with a local-only profile is not applied either.
    writeFileSync(join(app.dir, 'ai-routes.override.json'), JSON.stringify({ version: 1, profile: 'record' }));
    const after = await app.status();
    assert.equal(after.profile, 'legacy');
    assert.ok(after.warnings.some((line) => /record.*safe mode/.test(line)), JSON.stringify(after.warnings));
  } finally {
    registerHubLlm(null);
    await app.close();
  }
});

test('the data-dir off switch: status shows direct call sites and a profile change is refused until the facade is back on', async () => {
  const { registerHubLlm, hubLlm } = await import('../lib/llm-hooks.js');
  const app = await adminRoutesApp({ registered: true });
  registerHubLlm(app.facade);
  try {
    assert.equal((await app.put({ profile: 'prod' })).status, 200);
    const off = await app.put({ facade: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.profile, 'prod', 'switching the facade keeps the saved profile');
    assert.deepEqual(off.body.facade, { registered: true, enabled: false, callSites: 'direct' });
    assert.equal(hubLlm(), null, 'call sites get no facade while it is off');
    const saved = JSON.parse(readFileSync(join(app.dir, 'ai-routes.override.json'), 'utf8'));
    assert.equal(saved.facade, false);
    const status = await app.status();
    assert.equal(status.facade.callSites, 'direct');
    assert.ok(status.warnings.some((line) => /facade is off/i.test(line)));
    const refused = await app.put({ profile: 'legacy' });
    assert.equal(refused.status, 409);
    assert.equal((await app.put({ profiles: { prod: { note: 'x' } } })).status, 409, 'dropping the saved profile is a profile change too');
    const routesOnly = await app.put({ profile: 'prod', profiles: { prod: { note: 'x' } } });
    assert.equal(routesOnly.status, 200, 'a routes change that keeps the profile is fine');
    assert.equal(JSON.parse(readFileSync(join(app.dir, 'ai-routes.override.json'), 'utf8')).facade, false, 'the off switch is kept unless the body sets it');
    const back = await app.put({ facade: true, profile: 'legacy' });
    assert.equal(back.status, 200);
    assert.equal(back.body.facade.callSites, 'facade');
    assert.equal(hubLlm(), app.facade);
  } finally {
    registerHubLlm(null);
    await app.close();
  }
});

test('with the facade not registered (HUB_LLM_FACADE=0) a profile change is refused and status says the call sites run directly', async () => {
  const app = await adminRoutesApp({ registered: false });
  try {
    const res = await app.put({ profile: 'prod' });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /HUB_LLM_FACADE=0/);
    assert.equal(existsSync(join(app.dir, 'ai-routes.override.json')), false);
    const status = await app.status();
    assert.equal(status.facade.registered, false);
    assert.equal(status.facade.callSites, 'direct');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- the real hub (server.js)
const ADMIN = 'ai-spend-admin';
const ADMIN_PASSWORD = `ai-spend-${Date.now()}-pw`;
const CALLBACK_TOKEN = `maker-callback-${Date.now()}-token-value`;

test('server: run.ai.spend callback, AI spend and status endpoints, and the routes override', { timeout: 180_000 }, async () => {
  const month = new Date().toISOString().slice(0, 7);
  const hub = await bootHub({
    HUB_SAFE_MODE: '1',
    PERSIST_PRODUCTION_ENV: '0',
    ADMIN_USERNAME: ADMIN,
    ADMIN_PASSWORD,
    WEBSITE_MAKER_STATUS_CALLBACK_TOKEN: CALLBACK_TOKEN,
    DEEPSEEK_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
    AI_PROFILE: '',
  }, {
    seed(dir) {
      writeFileSync(join(dir, 'sales-clients.json'), JSON.stringify([
        { id: 'c-spend', product: 'asoldi', businessName: 'Spend AS', status: 'active', makerRun: { runId: 'run-1', steps: { 1: 'ready' } } },
        { id: 'c-free', product: 'asoldi', businessName: 'Free AS', status: 'active' },
      ], null, 2));
      mkdirSync(join(dir, 'ai'), { recursive: true });
      const row = { v: 2, kind: 'llm', at: `${month}-01T08:00:00.000Z`, repo: 'hub', task: 'offer.fill-from-transcript', provider: 'deepseek', requestedModel: 'deepseek-chat', model: 'deepseek-chat', profile: 'legacy', salesClientId: 'c-spend', usd: 0.25, status: 'ok' };
      writeFileSync(join(dir, 'ai', `ledger-${month}.jsonl`), `${JSON.stringify(row)}\n`);
    },
  });
  const logs = () => hub.log();
  try {
    assert.ok(hub.health, `hub did not start:\n${logs().slice(-3000)}`);
    const token = await hub.adminToken(ADMIN, ADMIN_PASSWORD);
    assert.ok(token, 'admin login');
    const admin = { authorization: `Bearer ${token}` };
    const callback = (body, headers = { 'x-sales-callback-token': CALLBACK_TOKEN }) => fetch(`${hub.base}/api/admin/sales/maker-status-callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ event: 'run.ai.spend', salesClientId: 'c-spend', runId: 'run-1', ...body }),
    });
    const onDisk = () => diskClient(hub.dataDir, 'c-spend').makerRun.aiSpend;

    const at = `${month}-02T09:00:00.000Z`;
    assert.equal((await callback({ totalUsd: 9, at }, {})).status, 401, 'no callback token');
    assert.equal((await callback({ totalUsd: 9, at }, { 'x-sales-callback-token': 'wrong-token' })).status, 401);
    assert.equal(onDisk(), undefined);

    const first = await callback({ totalUsd: 1.5, byTask: { 'step2.copywriter': 1.2, 'seo.meta': 0.3 }, calls: 12, at: `${month}-02T10:00:00.000Z` });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.stored, true);
    assert.equal(onDisk().totalUsd, 1.5);
    assert.deepEqual(onDisk().byTask, { 'step2.copywriter': 1.2, 'seo.meta': 0.3 });

    const older = await (await callback({ totalUsd: 0.1, at: `${month}-01T00:00:00.000Z` })).json();
    assert.equal(older.stored, false);
    assert.equal(older.reason, 'older');
    const otherRun = await (await callback({ runId: 'run-x', totalUsd: 50, at })).json();
    assert.equal(otherRun.ignored, true, 'a callback for a run the client is not linked to changes nothing');
    assert.equal((await callback({ totalUsd: 'abc', at })).status, 400);
    const noTime = await callback({ totalUsd: 7 });
    assert.equal(noTime.status, 400, 'a snapshot without its time is refused');
    const unlinked = await (await callback({ salesClientId: 'c-free', runId: 'run-9', totalUsd: 4, at })).json();
    assert.equal(unlinked.stored, false);
    assert.equal(onDisk().totalUsd, 1.5);
    assert.equal(diskClient(hub.dataDir, 'c-free').makerRun?.aiSpend, undefined);

    // A staff set-maker-run body cannot write aiSpend.
    const setRun = await fetch(`${hub.base}/api/admin/sales/c-spend/set-maker-run`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ makerRun: { runId: 'run-1', aiSpend: { runId: 'run-1', totalUsd: 999 } } }),
    });
    assert.equal(setRun.status, 200);
    assert.equal(onDisk().totalUsd, 1.5);

    // Spend for the client: the hub ledger plus the Maker's run.
    assert.equal((await fetch(`${hub.base}/api/admin/ai/spend?salesClientId=c-spend`)).status, 401);
    const spend = await (await fetch(`${hub.base}/api/admin/ai/spend?salesClientId=c-spend&by=task`, { headers: admin })).json();
    assert.equal(spend.hub.totalUsd, 0.25);
    assert.equal(spend.maker.totalUsd, 1.5);
    assert.equal(spend.totalUsd, 1.75);
    assert.deepEqual(Object.keys(spend.hub.groups), ['offer.fill-from-transcript']);
    const newer = await (await callback({ totalUsd: 2, at: `${month}-03T10:00:00.000Z` })).json();
    assert.equal(newer.stored, true);
    const respend = await (await fetch(`${hub.base}/api/admin/ai/spend?salesClientId=c-spend`, { headers: admin })).json();
    assert.equal(respend.maker.totalUsd, 2, 'the run is counted once, with its newest snapshot');
    assert.equal(respend.totalUsd, 2.25);
    // The Maker's own body (ledger v2 groups): the per-task spend reaches the client, the history and the endpoint.
    const makerBody = makerSpendBody({ runId: 'run-1', salesClientId: 'c-spend', at: `${month}-04T10:00:00.000Z` });
    const fromMaker = await callback(makerBody);
    assert.equal(fromMaker.status, 200);
    assert.equal((await fromMaker.json()).stored, true);
    assert.deepEqual(onDisk().byTask, { 'step2.copywriter': 0.3, 'seo.meta': 0.12 });
    const history = JSON.parse(readFileSync(join(hub.dataDir, 'ai', 'maker-spend.json'), 'utf8')).clients['c-spend'].runs['run-1'];
    assert.deepEqual(history.byTask, { 'step2.copywriter': 0.3, 'seo.meta': 0.12 });
    const makerSpend = await (await fetch(`${hub.base}/api/admin/ai/spend?salesClientId=c-spend`, { headers: admin })).json();
    assert.equal(makerSpend.maker.totalUsd, 0.42);
    assert.deepEqual(makerSpend.maker.byTask, { 'step2.copywriter': 0.3, 'seo.meta': 0.12 });
    assert.deepEqual(makerSpend.maker.byProvider, { claude: 0.4, deepseek: 0.02 });
    // A range before the run: neither the history nor the client's current run counts.
    const before = await (await fetch(`${hub.base}/api/admin/ai/spend?salesClientId=c-spend&from=2020-01-01T00:00:00Z&to=2020-01-31T23:59:59Z`, { headers: admin })).json();
    assert.equal(before.maker.totalUsd, 0);
    assert.equal(before.totalUsd, 0);
    assert.equal((await fetch(`${hub.base}/api/admin/ai/spend?from=not-a-date`, { headers: admin })).status, 400);
    assert.equal((await fetch(`${hub.base}/api/admin/ai/spend?by=nonsense`, { headers: admin })).status, 400);

    // Status (no probe, no provider call) and the routes override.
    assert.equal((await fetch(`${hub.base}/api/admin/ai/status`)).status, 401);
    const status = await (await fetch(`${hub.base}/api/admin/ai/status`, { headers: admin })).json();
    assert.equal(status.profile, 'legacy');
    assert.deepEqual(status.facade, { registered: true, enabled: true, callSites: 'facade' });
    assert.equal(status.profileSource, 'default');
    assert.equal(status.safeMode.active, true);
    assert.ok(status.routes.some((row) => row.task === 'offer.fill-from-transcript' && row.route === 'deepseek:deepseek-chat'));
    assert.equal(status.providers.claude.configured, false);
    assert.equal(status.providers.claude.probe, undefined, 'no probe unless asked');

    const put = (body, headers = admin) => fetch(`${hub.base}/api/admin/ai/routes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await put({ profile: 'prod' }, {})).status, 401);
    const bad = await put({ profile: 'bogus' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).errors.join(' '), /bogus/);
    assert.equal((await put({ profiles: { prod: { tasks: { 'offer.fill-from-transcript': 'claude:claude-haiku-9' } } } })).status, 400);
    const ok = await put({ profile: 'prod' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).profile, 'prod');
    const override = JSON.parse(readFileSync(join(hub.dataDir, 'ai-routes.override.json'), 'utf8'));
    assert.equal(override.profile, 'prod');
    assert.equal(override.updatedBy, ADMIN);
    const after = await (await fetch(`${hub.base}/api/admin/ai/status`, { headers: admin })).json();
    assert.equal(after.profile, 'prod');
    assert.equal(after.profileSource, 'override');
    const fill = after.routes.find((row) => row.task === 'offer.fill-from-transcript');
    assert.equal(fill.route, 'claude:claude-haiku-5-5:low');

    // Probing with safe mode on records the blocked attempt instead of calling a provider.
    const probed = await (await fetch(`${hub.base}/api/admin/ai/status?probe=1`, { headers: { ...admin } })).json();
    assert.equal(probed.providers.claude.probe.error, 'not-configured');

    const blocked = logs().split(/\r?\n/).filter((line) => line.startsWith('[egress-guard] blocked'));
    assert.deepEqual(blocked, [], 'the hub tried to reach a non-loopback host');
    const aiEgress = hub.egressRows().filter((row) => /deepseek|anthropic|googleapis/.test(String(row.host || '')));
    assert.deepEqual(aiEgress, []);
    assert.match(logs(), /\[ai\] LLM facade on, profile legacy/);
    assert.ok(existsSync(join(hub.dataDir, 'ai', 'maker-spend.json')));
  } catch (error) {
    console.error(logs().split(/\r?\n/).slice(-60).join('\n'));
    throw error;
  } finally {
    await hub.stop();
  }
});
