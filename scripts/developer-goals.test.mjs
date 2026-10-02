import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVELOPER_GOAL_KEYS,
  DEVELOPER_RECENT_OVERDUE_MS,
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
