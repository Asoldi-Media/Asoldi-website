import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVELOPER_GOAL_KEYS,
  DEVELOPER_PREVIEW_GOAL_KEYS,
  DEVELOPER_RECENT_OVERDUE_MS,
  DEVELOPER_WIN_GOAL_KEYS,
  applyDeveloperGoalToggle,
  formatDeveloperGoalLabel,
  getCurrentDeveloperGoalKey,
  getRemainingDeveloperGoalCount,
  getVisibleDeveloperGoalKeys,
  normalizeDeveloperGoals,
  showDeveloperDeployChips,
} from '../lib/developer-goals.js';

test('developer Forfalt window is two weeks, not 48 hours', () => {
  assert.equal(DEVELOPER_RECENT_OVERDUE_MS, 14 * 24 * 60 * 60 * 1000);
});

test('developer goals start at ready for preview and lock later chips', () => {
  const empty = normalizeDeveloperGoals();
  assert.deepEqual(DEVELOPER_GOAL_KEYS, [
    'readyForPreview',
    'readyForDeployment',
    'iterationDone',
    'publish',
  ]);
  assert.equal(getCurrentDeveloperGoalKey(empty), 'readyForPreview');
  assert.deepEqual(getVisibleDeveloperGoalKeys(empty), ['readyForPreview']);
  assert.equal(getRemainingDeveloperGoalCount(empty), 3);
  assert.equal(formatDeveloperGoalLabel('readyForPreview'), 'Klar for preview');
  assert.equal(showDeveloperDeployChips(empty), false);
  const blocked = applyDeveloperGoalToggle(empty, 'publish');
  assert.equal(blocked.error, 'Fullfør nåværende mål først');
});

test('developer goals mark sequential chips and undo later ones', () => {
  const first = applyDeveloperGoalToggle({}, 'readyForPreview');
  assert.equal(first.goals.readyForPreview, true);
  assert.equal(getCurrentDeveloperGoalKey(first.goals), 'readyForDeployment');
  assert.equal(showDeveloperDeployChips(first.goals), true);
  const second = applyDeveloperGoalToggle(first.goals, 'readyForDeployment');
  assert.equal(second.goals.readyForDeployment, true);
  const undone = applyDeveloperGoalToggle(second.goals, 'readyForPreview');
  assert.equal(undone.goals.readyForPreview, false);
  assert.equal(undone.goals.readyForDeployment, false);
});

test('sales wins start at deployment and the preview list only has Klar for preview', () => {
  const empty = normalizeDeveloperGoals();
  assert.deepEqual(DEVELOPER_WIN_GOAL_KEYS, ['readyForDeployment', 'iterationDone', 'publish']);
  assert.deepEqual(DEVELOPER_PREVIEW_GOAL_KEYS, ['readyForPreview']);
  assert.equal(getCurrentDeveloperGoalKey(empty, DEVELOPER_WIN_GOAL_KEYS), 'readyForDeployment');
  assert.deepEqual(getVisibleDeveloperGoalKeys(empty, false, DEVELOPER_WIN_GOAL_KEYS), ['readyForDeployment']);
  const marked = applyDeveloperGoalToggle(empty, 'readyForDeployment', DEVELOPER_WIN_GOAL_KEYS);
  assert.equal(marked.error, undefined);
  assert.equal(marked.goals.readyForDeployment, true);
  assert.equal(marked.goals.readyForPreview, false);
  const blockedPreview = applyDeveloperGoalToggle(empty, 'readyForPreview', DEVELOPER_WIN_GOAL_KEYS);
  assert.equal(blockedPreview.error, 'Ugyldig utviklermål.');
  const blockedLater = applyDeveloperGoalToggle(empty, 'publish', DEVELOPER_PREVIEW_GOAL_KEYS);
  assert.equal(blockedLater.error, 'Ugyldig utviklermål.');
  const preview = applyDeveloperGoalToggle(empty, 'readyForPreview', DEVELOPER_PREVIEW_GOAL_KEYS);
  assert.equal(preview.goals.readyForPreview, true);
  assert.equal(getCurrentDeveloperGoalKey(preview.goals, DEVELOPER_PREVIEW_GOAL_KEYS), '');
});
