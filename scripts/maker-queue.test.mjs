import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GREY_QUEUE_TARGETS,
  isAcceptedQueueTarget,
  isClickableQueueTarget,
  resolveMakerQueueRunRequests,
  summarizeMakerRunForQueue,
} from '../lib/maker-queue.js';

test('linked sales clients enqueue; missing run fails that item', () => {
  const clients = {
    a: { id: 'a', makerRun: { runId: 'run-a' } },
    b: { id: 'b', makerRun: null },
  };
  const result = resolveMakerQueueRunRequests({
    getClientById: (id) => clients[id] || null,
    salesClientIds: ['a', 'b'],
  });
  assert.deepEqual(result.linked, [{ runId: 'run-a', salesClientId: 'a' }]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].salesClientId, 'b');
  assert.equal(result.failures[0].error, 'No Website Maker run is linked.');
});

test('full Step 2 is one accepted target and CMS is not clickable', () => {
  assert.equal(isAcceptedQueueTarget('2'), true);
  assert.equal(isAcceptedQueueTarget('cms'), true);
  assert.equal(isAcceptedQueueTarget('3'), true);
  assert.equal(isClickableQueueTarget('1'), true);
  assert.equal(isClickableQueueTarget('inject-media'), true);
  assert.equal(isClickableQueueTarget('2'), false);
  assert.equal(isClickableQueueTarget('cms'), false);
  assert.equal(isClickableQueueTarget('3'), false);
  assert.ok(GREY_QUEUE_TARGETS.some((entry) => entry.target === 'cms'));
  assert.ok(GREY_QUEUE_TARGETS.some((entry) => entry.target === '3'));
});

test('wizard status comes from Maker run substeps and language lock', () => {
  const summary = summarizeMakerRunForQueue({
    id: 'run-a',
    metadata: { finalizedLanguage: { confirmed: true, code: 'no' } },
    steps: {
      '1': { status: 'ready' },
      '2': { substeps: { 'generate-text': { status: 'ready' } } },
    },
  });
  assert.equal(summary.step1Ready, true);
  assert.equal(summary.languageLocked, true);
  assert.equal(summary.generateTextReady, true);
  const unlocked = summarizeMakerRunForQueue({
    id: 'run-b',
    metadata: {},
    steps: { '1': { status: 'ready' } },
  });
  assert.equal(unlocked.languageLocked, false);
  assert.equal(unlocked.generateTextReady, false);
});
