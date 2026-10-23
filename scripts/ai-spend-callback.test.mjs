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

  // Wrong run, no linked run, older snapshot, invalid amounts: nothing is stored.
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-other', totalUsd: 3 }).reason, 'not-linked-run');
  assert.equal(sales.setSalesMakerRunAiSpend('unlinked', { runId: 'run-any', totalUsd: 3 }).reason, 'not-linked-run');
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-linked', totalUsd: 3, at: '2026-10-22T00:00:00Z' }).reason, 'older');
  assert.equal(sales.setSalesMakerRunAiSpend('linked', { runId: 'run-linked', totalUsd: 'x' }).reason, 'invalid');
  assert.equal(diskClient(unitDir, 'linked').makerRun.aiSpend.totalUsd, 0.5);
  assert.equal(diskClient(unitDir, 'unlinked').makerRun?.aiSpend, undefined);

  // Clearing the run (a new run follows) drops the run's spend from the client; the history keeps it.
  const cleared = sales.replaceSalesMakerRun('linked', { runId: 'run-new', aiSpend: { runId: 'run-new', totalUsd: 999 } });
  assert.equal(cleared.makerRun.aiSpend, undefined);
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
  const bad = applyRunAiSpendCallback({ sales, client: sales.getSalesClientById('linked'), runId: 'run-linked', body: { totalUsd: 'NaN' }, ledger });
  assert.equal(bad.status, 400);
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

    assert.equal((await callback({ totalUsd: 9 }, {})).status, 401, 'no callback token');
    assert.equal((await callback({ totalUsd: 9 }, { 'x-sales-callback-token': 'wrong-token' })).status, 401);
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
    const otherRun = await (await callback({ runId: 'run-x', totalUsd: 50 })).json();
    assert.equal(otherRun.ignored, true, 'a callback for a run the client is not linked to changes nothing');
    assert.equal((await callback({ totalUsd: 'abc' })).status, 400);
    const unlinked = await (await callback({ salesClientId: 'c-free', runId: 'run-9', totalUsd: 4 })).json();
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
    assert.equal((await fetch(`${hub.base}/api/admin/ai/spend?from=not-a-date`, { headers: admin })).status, 400);
    assert.equal((await fetch(`${hub.base}/api/admin/ai/spend?by=nonsense`, { headers: admin })).status, 400);

    // Status (no probe, no provider call) and the routes override.
    assert.equal((await fetch(`${hub.base}/api/admin/ai/status`)).status, 401);
    const status = await (await fetch(`${hub.base}/api/admin/ai/status`, { headers: admin })).json();
    assert.equal(status.profile, 'legacy');
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
