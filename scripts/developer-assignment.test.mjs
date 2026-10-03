import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAcceptDeveloperHandoff,
  canUploadDeveloperHandoff,
  canWorkDevelopmentClient,
  developmentItemVisible,
  planDeveloperReassign,
} from '../lib/developer-assignment.js';
import { mergeDeveloperPipelineStatus, mergeMakerRunPatch, pipelineStatusFromMakerRun } from '../lib/developer-card.js';

const admin = { isAdmin: true, accountKey: 'admin:damian@asoldi.com', username: 'damian@asoldi.com' };
const dev = { role: 'developer', accountKey: 'developer:dev-1', userId: 'dev-1' };

test('admin sees every project and a developer sees only their own', () => {
  const mine = { developerOwnerId: 'developer:dev-1' };
  const other = { developerOwnerId: 'admin:damian@asoldi.com' };
  assert.equal(developmentItemVisible(admin, other), true);
  assert.equal(developmentItemVisible(admin, { developerOwnerId: '' }), true);
  assert.equal(developmentItemVisible(dev, mine), true);
  assert.equal(developmentItemVisible(dev, other), false);
});

test('only the assignee can work, and a handoff locks both sides', () => {
  const assigned = { developerOwnerId: 'developer:dev-1', developerHandoff: { status: '' } };
  assert.equal(canWorkDevelopmentClient(dev, assigned), true);
  assert.equal(canWorkDevelopmentClient(admin, assigned), false);
  assert.equal(canWorkDevelopmentClient(admin, { developerOwnerId: '' }), false);
  const waiting = {
    developerOwnerId: 'developer:dev-1',
    developerHandoff: { status: 'waiting-upload', fromOwnerId: 'admin:damian@asoldi.com', toOwnerId: 'developer:dev-1' },
  };
  assert.equal(canWorkDevelopmentClient(dev, waiting), false);
  assert.equal(canWorkDevelopmentClient(admin, waiting), false);
  assert.equal(canUploadDeveloperHandoff(admin, waiting), true);
  assert.equal(canUploadDeveloperHandoff(dev, waiting), false);
  const ready = {
    developerOwnerId: 'developer:dev-1',
    developerHandoff: { status: 'ready', fromOwnerId: 'admin:damian@asoldi.com', toOwnerId: 'developer:dev-1' },
  };
  assert.equal(canAcceptDeveloperHandoff(dev, ready), true);
  assert.equal(canAcceptDeveloperHandoff(admin, ready), false);
});

test('reassign with a run waits for the previous computer, and without a run switches immediately', () => {
  const withRun = planDeveloperReassign({
    client: { developerOwnerId: 'admin:damian@asoldi.com', makerRun: { runId: 'run-1' } },
    nextOwnerId: 'developer:dev-1',
    now: '2026-10-03T00:00:00.000Z',
  });
  assert.equal(withRun.changed, true);
  assert.equal(withRun.developerOwnerId, 'developer:dev-1');
  assert.equal(withRun.developerHandoff.status, 'waiting-upload');
  assert.equal(withRun.developerHandoff.runId, 'run-1');
  const fresh = planDeveloperReassign({
    client: { developerOwnerId: '', makerRun: { runId: '' } },
    nextOwnerId: 'developer:dev-1',
  });
  assert.equal(fresh.developerHandoff.status, '');
  assert.equal(fresh.developerOwnerId, 'developer:dev-1');
});

test('a finished step stays ready when a later read is idle, and latestReadyStep fills older cards', () => {
  const persisted = pipelineStatusFromMakerRun({
    steps: { '1': 'ready', '1.5': 'ready', '2': 'idle', '3': 'idle' },
  });
  const live = pipelineStatusFromMakerRun({
    steps: { '1': 'idle', '1.5': 'idle', '2': 'idle', '3': 'idle' },
  });
  const merged = mergeDeveloperPipelineStatus(persisted, live);
  assert.equal(merged.step15Ready, true);
  const fromLatest = pipelineStatusFromMakerRun({
    latestReadyStep: '1.5',
    steps: { '1': 'idle', '1.5': 'idle', '2': 'idle', '3': 'idle' },
  });
  assert.equal(fromLatest.step1Ready, true);
  assert.equal(fromLatest.step15Ready, true);
  assert.equal(fromLatest.step2Ready, false);
  const kept = mergeMakerRunPatch(
    { runId: 'run-1', steps: { '1': 'ready', '1.5': 'ready', '2': 'idle', '3': 'idle' }, latestReadyStep: '1.5' },
    { runId: 'run-1', steps: { '1': 'idle', '1.5': 'idle', '2': 'idle', '3': 'idle' } }
  );
  assert.equal(kept.steps['1.5'], 'ready');
});
