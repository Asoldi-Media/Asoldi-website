// Step 2 substep keys from a Website Maker status handoff.
//
// A Maker that has more than the four legacy Step 2 substeps sends `step2SubstepOrder` next to
// `step2Substeps`. The hub keeps the four legacy keys plus the ids in that order (valid ids only,
// at most 10), stores the order in makerRun.ext so later writes keep the extra keys, shows a chip
// and a queue target for the extra substeps it knows, and scores them. A handoff without the order
// leaves every stored byte as before; the commit before this change, fed the new handoff, keeps four
// substeps (negative control).
//
// node --test scripts/step2-substeps-handoff.test.mjs
// STEP2_SUBSTEPS_BASE_REF=<ref> picks the older commit for the comparison (default 859429c). In a
// checkout without that commit (a shallow clone or an exported tree) the comparisons with it are
// skipped, unless STEP2_SUBSTEPS_BASE_REF is set: then a missing commit fails the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeMakerStep2Substeps } from '../data/sales.js';
import {
  DEVELOPER_PROGRESS_CHIPS,
  chipStepReady,
  developerProgressChips,
  makerProgressPatchFromHandoff,
  mergeDeveloperPipelineStatus,
  mergeMakerRunPatch,
  pipelineStatusFromMakerRun,
  resolveDeveloperProgressClick,
  scoreMakerRunProgress,
} from '../lib/developer-card.js';
import {
  CLICKABLE_QUEUE_TARGETS,
  QUEUE_UNTIL_CHAIN,
  clickableQueueTargetsForOrder,
  isAcceptedQueueTarget,
  step2SubstepOrderForQueueRequest,
  summarizeMakerRunForQueue,
  targetsUntil,
} from '../lib/maker-queue.js';
import { LEGACY_STEP2_SUBSTEP_KEYS, normalizeStep2SubstepOrder } from '../lib/step2-substeps.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const writer = join(root, 'scripts', 'fixtures', 'step2-substeps-writer.mjs');
const BASE_REF_SET = Boolean(String(process.env.STEP2_SUBSTEPS_BASE_REF || '').trim());
const BASE_REF = String(process.env.STEP2_SUBSTEPS_BASE_REF || '859429c').trim();

function baseRefResolves() {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}
// Options for the tests that load the older commit: skipped with a reason when it is not in history.
const BASE = BASE_REF_SET || baseRefResolves()
  ? {}
  : { skip: `commit ${BASE_REF} is not in this checkout's history (shallow or exported tree); set STEP2_SUBSTEPS_BASE_REF to compare` };

const LEGACY = ['generate-text', 'inject-media', 'layout-colors-style', 'maps-embed-sync'];
const ORDER = [...LEGACY, 'bind-cta-data'];

function legacyHandoff(overrides = {}) {
  return {
    steps: { 1: 'ready', 1.5: 'ready', 2: 'ready', 3: 'idle' },
    step2Substeps: { 'generate-text': 'ready', 'inject-media': 'ready', 'layout-colors-style': 'ready', 'maps-embed-sync': 'ready' },
    language: { confirmed: true, code: 'nb' },
    cms: 'idle',
    customSite: { exists: false, previewPath: '' },
    latestReadyStep: '2',
    latestStepStatus: 'ready',
    productionDomain: 'bakeri.example.com',
    websiteDomain: 'bakeri.example.com',
    templateSetId: 'tpl-1',
    intakeStatus: 'configured',
    ...overrides,
  };
}

function newHandoff(overrides = {}) {
  return legacyHandoff({
    step2Substeps: { ...legacyHandoff().step2Substeps, 'bind-cta-data': 'ready' },
    step2SubstepOrder: [...ORDER],
    ...overrides,
  });
}

test('without an order the normalizer keeps exactly the four legacy keys', () => {
  assert.deepEqual(LEGACY_STEP2_SUBSTEP_KEYS, LEGACY);
  const out = normalizeMakerStep2Substeps({ 'generate-text': 'ready', 'bind-cta-data': 'ready', extra: 'x' });
  assert.deepEqual(Object.keys(out), LEGACY);
  assert.deepEqual(out, { 'generate-text': 'ready', 'inject-media': 'idle', 'layout-colors-style': 'idle', 'maps-embed-sync': 'idle' });
});

test('with an order the given ids are kept after the legacy four; an unknown future id survives too', () => {
  const out = normalizeMakerStep2Substeps({ 'bind-cta-data': 'ready', 'future-step': 'running' }, [...ORDER, 'future-step']);
  assert.deepEqual(Object.keys(out), [...ORDER, 'future-step']);
  assert.equal(out['bind-cta-data'], 'ready');
  assert.equal(out['future-step'], 'running');
  assert.equal(out['generate-text'], 'idle');
});

test('only valid ids from an order count, without repeats and at most ten keys in all', () => {
  assert.equal(normalizeStep2SubstepOrder('bind-cta-data'), null);
  assert.equal(normalizeStep2SubstepOrder([]), null);
  assert.deepEqual(normalizeStep2SubstepOrder(['bind-cta-data', 'Bind-CTA', '../x', 'ab', 'a'.repeat(41), 'bind-cta-data', 7]), ['bind-cta-data']);
  const many = Array.from({ length: 20 }, (_, i) => `step-${String(i).padStart(2, '0')}`);
  assert.equal(Object.keys(normalizeMakerStep2Substeps({}, many)).length, 10);
});

test('a status handoff with the order is stored: five substeps and the order in ext; later writes keep them', () => {
  const patch = makerProgressPatchFromHandoff(newHandoff());
  assert.deepEqual(patch.step2SubstepOrder, ORDER);
  const merged = mergeMakerRunPatch({ runId: 'run-s2' }, { runId: 'run-s2', ...patch });
  assert.deepEqual(Object.keys(merged.step2Substeps), ORDER);
  // A later handoff from a page reading the live run (four keys, no order) keeps the stored 2.5 state.
  const later = mergeMakerRunPatch({ ...merged, ext: { step2SubstepOrder: ORDER } }, { runId: 'run-s2', step2Substeps: legacyHandoff().step2Substeps });
  assert.equal(later.step2Substeps['bind-cta-data'], 'ready');
});

test('without the order a handoff patch and merge are exactly as before', () => {
  const patch = makerProgressPatchFromHandoff(legacyHandoff());
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'step2SubstepOrder'), false);
  const merged = mergeMakerRunPatch({ runId: 'run-s2' }, { runId: 'run-s2', ...patch });
  assert.deepEqual(Object.keys(merged.step2Substeps), LEGACY);
});

test('the developer card shows 2.5 after Maps, marks it ready, scores it and can enqueue it', () => {
  const stored = { runId: 'run-s2', step2Substeps: { ...legacyHandoff().step2Substeps, 'bind-cta-data': 'idle' }, ext: { step2SubstepOrder: ORDER } };
  const chips = developerProgressChips(stored);
  const ids = chips.map((chip) => chip.id);
  assert.equal(ids[ids.indexOf('maps') + 1], '2.5');
  const chip = chips.find((row) => row.id === '2.5');
  assert.deepEqual(chip, { id: '2.5', label: 'CTA og priser', kind: 'enqueue', target: 'bind-cta-data' });

  const idleStatus = { ...pipelineStatusFromMakerRun(stored), draftInjected: true };
  assert.equal(idleStatus.bindCtaDataReady, false);
  const click = resolveDeveloperProgressClick(chip, idleStatus);
  assert.equal(click.type, 'enqueue-until');
  assert.equal(click.untilTarget, 'bind-cta-data');

  const ready = { ...stored, step2Substeps: { ...stored.step2Substeps, 'bind-cta-data': 'ready' } };
  const readyStatus = pipelineStatusFromMakerRun(ready);
  assert.equal(chipStepReady(chip, readyStatus), true);
  assert.equal(resolveDeveloperProgressClick(chip, readyStatus).type, 'ready');
  assert.equal(scoreMakerRunProgress(ready) - scoreMakerRunProgress(stored), 500);
  assert.equal(mergeDeveloperPipelineStatus(readyStatus, null).bindCtaDataReady, true);
});

test('a makerRun without extra substeps gets the same chips, status keys and score as before', () => {
  const stored = { runId: 'run-s2', step2Substeps: legacyHandoff().step2Substeps, steps: legacyHandoff().steps };
  assert.equal(developerProgressChips(stored), DEVELOPER_PROGRESS_CHIPS);
  assert.equal(developerProgressChips({ ...stored, step2Substeps: { ...stored.step2Substeps, 'bind-cta-data': 'ready' } }), DEVELOPER_PROGRESS_CHIPS,
    'a fifth key alone, with no order, adds no chip');
  const status = pipelineStatusFromMakerRun(stored);
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'bindCtaDataReady'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(mergeDeveloperPipelineStatus(status, status), 'bindCtaDataReady'), false);
  assert.equal(scoreMakerRunProgress(stored), 10000 + 400 + 300 + 200 + 100 + 50 + 20, 'Step 2 ready, four substeps, 1.5 and 1');
});

test('the queue knows the 2.5 target and puts it after Maps only for a Maker that sent the order', () => {
  assert.equal(isAcceptedQueueTarget('bind-cta-data'), false, 'without an order the target is unknown, as before');
  assert.equal(isAcceptedQueueTarget('bind-cta-data', { step2SubstepOrder: ORDER }), true);
  assert.equal(isAcceptedQueueTarget('maps-embed-sync'), true);
  const clients = {
    withOrder: { makerRun: { runId: 'r2', ext: { step2SubstepOrder: ORDER } } },
    withoutOrder: { makerRun: { runId: 'r1' } },
  };
  const lookup = (id) => clients[id] || null;
  assert.deepEqual(step2SubstepOrderForQueueRequest({ salesClientIds: ['withOrder', 'withoutOrder'] }, lookup), ORDER);
  assert.equal(step2SubstepOrderForQueueRequest({ salesClientIds: ['withoutOrder', 'missing'] }, lookup), null);
  assert.equal(step2SubstepOrderForQueueRequest({ runIds: ['r9'] }, lookup), null);
  assert.deepEqual(targetsUntil('3'), [...QUEUE_UNTIL_CHAIN]);
  assert.deepEqual(targetsUntil('3', { step2SubstepOrder: ORDER }), ['1', '1.5', ...ORDER, '3']);
  assert.deepEqual(targetsUntil('bind-cta-data', { step2SubstepOrder: ORDER }), ['1', '1.5', ...ORDER]);
  assert.equal(clickableQueueTargetsForOrder(null), CLICKABLE_QUEUE_TARGETS);
  const targets = clickableQueueTargetsForOrder(ORDER).map((entry) => entry.target);
  assert.equal(targets[targets.indexOf('maps-embed-sync') + 1], 'bind-cta-data');

  const oldRun = { id: 'r1', steps: { 2: { status: 'ready', substeps: { 'maps-embed-sync': { status: 'ready' } } } } };
  assert.equal(Object.prototype.hasOwnProperty.call(summarizeMakerRunForQueue(oldRun), 'bindCtaDataReady'), false);
  const newRun = { id: 'r2', steps: { 2: { status: 'ready', substeps: { 'maps-embed-sync': { status: 'ready' }, 'bind-cta-data': { status: 'ready' } } } } };
  assert.equal(
    JSON.stringify(summarizeMakerRunForQueue(newRun)),
    JSON.stringify(summarizeMakerRunForQueue(oldRun)).replace('"runId":"r1"', '"runId":"r2"'),
    'without an order a run that reports 2.5 gets the same summary fields as before'
  );
  assert.equal(summarizeMakerRunForQueue(newRun, { step2SubstepOrder: ORDER }).bindCtaDataReady, true);
  assert.equal(summarizeMakerRunForQueue(oldRun, { step2SubstepOrder: ORDER }).bindCtaDataReady, false);
});

// --- Stored data, this tree against the older commit ------------------------------------------------

function untar(buffer, destination) {
  let offset = 0;
  let paxPath = '';
  const text = (start, length) => buffer.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(offset, 100);
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(offset + 345, 155);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const match = body.toString('utf8').match(/\d+ path=([^\n]+)\n/);
      paxPath = match ? match[1] : '';
      continue;
    }
    if (type === 'g') continue;
    const path = paxPath || (prefix ? `${prefix}/${name}` : name);
    paxPath = '';
    if (path.includes('..')) throw new Error(`unsafe path in archive: ${path}`);
    const target = join(destination, path);
    if (type === '5') mkdirSync(target, { recursive: true });
    else if (type === '0' || type === '\0') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
  }
}

let baseRoot = null;
function baseCodeRoot() {
  if (baseRoot) return baseRoot;
  const sha = execFileSync('git', ['rev-parse', '--short=12', `${BASE_REF}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const destination = join(root, 'build', `step2-substeps-${sha}`);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const tar = execFileSync('git', ['archive', '--format=tar', sha, 'data', 'lib', 'packages'], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  untar(tar, destination);
  baseRoot = destination;
  return destination;
}
test.after(() => {
  if (baseRoot) rmSync(baseRoot, { recursive: true, force: true });
});

function newDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-step2-substeps-'));
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([{
    id: 's2-client',
    product: 'asoldi',
    businessName: 'Test Bakeri AS',
    contactPerson: 'Test Person',
    contactEmail: 'post@example.com',
    status: 'active',
  }], null, 2));
  return dataDir;
}

let handoffFiles = 0;
function runWriterIn(dataDir, codeRoot, handoffs) {
  const files = handoffs.map((handoff) => {
    handoffFiles += 1;
    const file = join(dataDir, `handoff-${handoffFiles}.json`);
    writeFileSync(file, JSON.stringify(handoff));
    return file;
  });
  const out = execFileSync(process.execPath, [writer, '--code-root', codeRoot, ...files], {
    cwd: root,
    env: { ...process.env, APP_DATA_DIR: dataDir, DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  const stored = readFileSync(join(dataDir, 'sales-clients.json'), 'utf8');
  return { makerRun: JSON.parse(out.trim().split('\n').pop()), stored };
}

function runWriter(codeRoot, handoffs) {
  const dataDir = newDataDir();
  try {
    return runWriterIn(dataDir, codeRoot, handoffs);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** The stored file with the wall-clock stamps blanked, so two runs compare byte for byte. */
function withoutClock(text) {
  return String(text).replace(/"(updatedAt|statusUpdatedAt|createdAt)":\s*"[^"]*"/g, '"$1": "<t>"');
}

test(`negative control: commit ${BASE_REF}, fed the new handoff, still stores four substeps`, BASE, () => {
  const { makerRun } = runWriter(baseCodeRoot(), [newHandoff()]);
  assert.deepEqual(Object.keys(makerRun.step2Substeps), LEGACY);
  assert.equal(makerRun.ext, undefined);
});

test('this tree, fed the new handoff, stores five substeps and keeps them through later writes', () => {
  const { makerRun } = runWriter(root, [newHandoff(), legacyHandoff({ step2Substeps: { 'generate-text': 'ready' } })]);
  assert.deepEqual(Object.keys(makerRun.step2Substeps), ORDER);
  assert.equal(makerRun.step2Substeps['bind-cta-data'], 'ready');
  assert.deepEqual(makerRun.ext, { step2SubstepOrder: ORDER });
  assert.equal(Object.prototype.hasOwnProperty.call(makerRun, 'step2SubstepOrder'), false, 'the order is stored in ext only');
});

test(`rollback: commit ${BASE_REF} keeps the stored order in ext, and this tree then restores the fifth key`, BASE, () => {
  const dataDir = newDataDir();
  try {
    runWriterIn(dataDir, root, [newHandoff()]);
    const older = runWriterIn(dataDir, baseCodeRoot(), [legacyHandoff()]);
    assert.deepEqual(Object.keys(older.makerRun.step2Substeps), LEGACY, 'the older code keeps its four keys');
    assert.deepEqual(older.makerRun.ext, { step2SubstepOrder: ORDER }, 'ext survives the older code');
    const again = runWriterIn(dataDir, root, [legacyHandoff()]);
    assert.deepEqual(Object.keys(again.makerRun.step2Substeps), ORDER, 'the stored order brings 2.5 back (idle until the next status)');
    assert.equal(again.makerRun.step2Substeps['bind-cta-data'], 'idle');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test(`without step2SubstepOrder the stored client is byte-identical to commit ${BASE_REF}`, BASE, () => {
  const handoffs = [legacyHandoff(), legacyHandoff({ step2Substeps: { 'generate-text': 'ready', 'bind-cta-data': 'ready' } })];
  const before = runWriter(baseCodeRoot(), handoffs);
  const after = runWriter(root, handoffs);
  assert.equal(withoutClock(after.stored), withoutClock(before.stored));
  assert.deepEqual(Object.keys(after.makerRun.step2Substeps), LEGACY);
});

test('a sent order without the extra ids takes them back out: four keys, no stored order, no queue target', () => {
  const dataDir = newDataDir();
  try {
    runWriterIn(dataDir, root, [newHandoff()]);
    const back = runWriterIn(dataDir, root, [legacyHandoff({ step2SubstepOrder: [...LEGACY] })]);
    assert.deepEqual(Object.keys(back.makerRun.step2Substeps), LEGACY);
    assert.equal(back.makerRun.ext, undefined, 'the stored order is removed and the empty ext with it');
    const later = runWriterIn(dataDir, root, [legacyHandoff()]);
    assert.deepEqual(Object.keys(later.makerRun.step2Substeps), LEGACY, 'later handoffs without an order stay at four');
    const lookup = (id) => (id === 's2-client' ? { makerRun: later.makerRun } : null);
    const order = step2SubstepOrderForQueueRequest({ salesClientIds: ['s2-client'] }, lookup);
    assert.equal(order, null);
    assert.equal(isAcceptedQueueTarget('bind-cta-data', { step2SubstepOrder: order }), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  const other = runWriter(root, [legacyHandoff({ step2SubstepOrder: [...LEGACY] })]);
  assert.equal(other.makerRun.ext, undefined, 'a legacy order on a client without a stored one stores nothing');
});

test('other ext keys stay when the stored order is removed', async () => {
  const { withStoredStep2SubstepOrder } = await import('../lib/step2-substeps.js');
  const target = { ext: { step2SubstepOrder: [...ORDER], note: 'kept' } };
  withStoredStep2SubstepOrder(target, { step2SubstepOrder: [...LEGACY] });
  assert.deepEqual(target.ext, { note: 'kept' });
  const untouched = { ext: { step2SubstepOrder: [...ORDER] } };
  withStoredStep2SubstepOrder(untouched, {});
  assert.deepEqual(untouched.ext, { step2SubstepOrder: ORDER }, 'no order sent: the stored one stays');
});

test(`after the extra ids are taken out the stored client is byte-identical to commit ${BASE_REF} without them`, BASE, () => {
  const before = runWriter(baseCodeRoot(), [legacyHandoff(), legacyHandoff()]);
  const after = runWriter(root, [newHandoff(), legacyHandoff({ step2SubstepOrder: [...LEGACY] })]);
  assert.equal(withoutClock(after.stored), withoutClock(before.stored));
});
