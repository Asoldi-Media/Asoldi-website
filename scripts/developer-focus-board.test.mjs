import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultDeveloperFocusCategory,
  developerFocusCategoriesFor,
  groupDeveloperFocusQueues,
  normalizeDeveloperFocusCategory,
} from '../lib/developer-focus-board.js';

const NOW = Date.parse('2026-10-18T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function item(id, overrides = {}) {
  return { id, businessName: id, developerOwnerId: 'dev:1', developerGoals: {}, rankAt: '', ...overrides };
}

test('Ikke tildelt is admin only', () => {
  assert.equal(developerFocusCategoriesFor({ isAdmin: false }).some((row) => row.id === 'unassigned'), false);
  assert.equal(normalizeDeveloperFocusCategory('unassigned', { isAdmin: false }), '');
  assert.equal(normalizeDeveloperFocusCategory('unassigned', { isAdmin: true }), 'unassigned');
});

test('deployment items follow the first unticked win goal; preview stays in Preview', () => {
  const queues = groupDeveloperFocusQueues({
    developmentItems: [
      item('deploy'),
      item('iterate', { developerGoals: { readyForDeployment: true } }),
      item('publish', { developerGoals: { readyForDeployment: true, iterationDone: true } }),
      item('done', { developerGoals: { readyForDeployment: true, iterationDone: true, publish: true } }),
      item('free', { developerOwnerId: '' }),
    ],
    previewItems: [item('prev')],
  }, NOW, { isAdmin: true });
  assert.deepEqual(queues.readyForDeployment.map((row) => row.id), ['deploy']);
  assert.deepEqual(queues.iterationDone.map((row) => row.id), ['iterate']);
  assert.deepEqual(queues.publish.map((row) => row.id), ['publish']);
  assert.deepEqual(queues.done.map((row) => row.id), ['done']);
  assert.deepEqual(queues.unassigned.map((row) => row.id), ['free']);
  assert.deepEqual(queues.preview.map((row) => row.id), ['prev']);
});

test('order: past due within two weeks, upcoming, older past due, no time; ready previews last', () => {
  const queues = groupDeveloperFocusQueues({
    previewItems: [
      item('none'),
      item('old-late', { rankAt: iso(NOW - 20 * DAY) }),
      item('soon', { rankAt: iso(NOW + DAY) }),
      item('recent-late', { rankAt: iso(NOW - 2 * DAY) }),
      item('ready', { rankAt: iso(NOW - DAY), developerGoals: { readyForPreview: true } }),
    ],
  }, NOW, { isAdmin: false });
  assert.deepEqual(queues.preview.map((row) => row.id), ['recent-late', 'soon', 'old-late', 'none', 'ready']);
  assert.equal(defaultDeveloperFocusCategory(queues, { isAdmin: false }), 'preview');
});
