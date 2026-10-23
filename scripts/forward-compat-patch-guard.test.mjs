// WS8.44: the forward-compatible passthrough keeps keys a later batch stored, but an incoming patch
// cannot write them. Otherwise a rep could forge makerRun.goLive / previewPush through
// POST /api/admin/sales/:id/set-maker-run (salesAuth), and later batches derive the `live` stage
// from makerRun.goLive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-forward-compat-patch-'));
process.env.APP_DATA_DIR = DATA_DIR;

const storedGoLive = { target: 'production', liveVerifiedAt: '2026-11-02T09:00:00.000Z', by: 'later-batch' };
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([
  { id: 'fresh', product: 'asoldi', businessName: 'Fresh AS', status: 'active', makerRun: { runId: 'run-fresh', steps: { 1: 'ready' } } },
  {
    id: 'stored',
    product: 'asoldi',
    businessName: 'Stored AS',
    status: 'active',
    makerRun: { runId: 'run-stored', steps: { 1: 'ready', dev: 'running' }, goLive: storedGoLive },
  },
], null, 2));

const { FUTURE_MAKERRUN_KEYS, FUTURE_MAKERRUN_STEP_KEYS } = await import('../data/normalize-ext.js');
const { mergeMakerRunPatch, withoutFutureMakerRunKeys } = await import('../lib/developer-card.js');
const sales = await import('../data/sales.js');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const forged = {
  runId: 'run-fresh',
  latestReadyStep: '2',
  goLive: { target: 'production', liveVerifiedAt: '2026-10-23T00:00:00.000Z' },
  previewPush: { pushedAt: '2026-10-23T00:00:00.000Z', url: 'https://forged.example' },
  aiSpend: { usd: 0 },
  dev: { status: 'done' },
  ext: { anything: 'x'.repeat(1000) },
  steps: { 2: 'ready', dev: 'ready', 'dev-verify': 'ready' },
};

test('withoutFutureMakerRunKeys drops every future key and future step token from a patch', () => {
  const clean = withoutFutureMakerRunKeys(forged);
  for (const key of FUTURE_MAKERRUN_KEYS) assert.equal(Object.hasOwn(clean, key), false, key);
  for (const key of FUTURE_MAKERRUN_STEP_KEYS) assert.equal(Object.hasOwn(clean.steps, key), false, `steps.${key}`);
  assert.equal(clean.latestReadyStep, '2');
  assert.equal(clean.steps[2], 'ready');
  assert.ok(forged.goLive, 'the input object is not mutated');
});

test('a set-maker-run style patch carrying goLive, previewPush or dev steps does not persist them', () => {
  const updated = sales.setSalesMakerRun('fresh', forged);
  for (const key of FUTURE_MAKERRUN_KEYS) assert.equal(Object.hasOwn(updated.makerRun, key), false, key);
  assert.equal(updated.makerRun.steps.dev, undefined);
  assert.equal(updated.makerRun.steps['dev-verify'], undefined);
  assert.equal(updated.makerRun.steps[2], 'ready', 'ordinary keys still apply');
  assert.equal(updated.makerRun.latestReadyStep, '2');
  const disk = JSON.parse(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8')).find((client) => client.id === 'fresh');
  assert.equal(disk.makerRun.goLive, undefined);
  assert.equal(disk.makerRun.previewPush, undefined);
});

test('keys a later batch stored survive the merge and a patch cannot overwrite them', () => {
  const updated = sales.setSalesMakerRun('stored', { ...forged, runId: 'run-stored' });
  assert.deepEqual(updated.makerRun.goLive, storedGoLive);
  assert.equal(updated.makerRun.steps.dev, 'running', 'the stored step token is kept, not the forged one');
  assert.equal(updated.makerRun.previewPush, undefined);
  const merged = mergeMakerRunPatch({ goLive: storedGoLive, steps: { dev: 'ready' } }, { goLive: null, steps: { dev: 'idle' } });
  assert.deepEqual(merged.goLive, storedGoLive);
  assert.equal(merged.steps.dev, 'ready');
});

test('the set-maker-run route writes through setSalesMakerRun (and so through the guard)', () => {
  const server = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = server.indexOf("app.post('/api/admin/sales/:id/set-maker-run'");
  const end = server.indexOf('\n});\n', start);
  assert.ok(start > 0 && end > start);
  const body = server.slice(start, end);
  assert.match(body, /sales\.setSalesMakerRun\(client\.id, makerPatch\)/);
  assert.doesNotMatch(body, /updateSalesClient\(/, 'no direct client write that would skip mergeMakerRunPatch');
});
