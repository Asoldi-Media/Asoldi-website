import test from 'node:test';
import assert from 'node:assert/strict';
import { isCloudSyncedWorkspace, localModulesDir, modulesNeedRelocate } from './ensure-offline-node-modules.mjs';

test('OneDrive workspace paths are treated as cloud-synced', () => {
  assert.equal(isCloudSyncedWorkspace('/Users/x/Library/CloudStorage/OneDrive-AkerBP/Asoldi-website'), true);
  assert.equal(isCloudSyncedWorkspace('/Users/x/code/Asoldi-website'), false);
});

test('cloud workspaces relocate modules when the folder is missing or not the local cache', () => {
  const localDir = localModulesDir('/tmp/home');
  assert.equal(modulesNeedRelocate({
    cwd: '/Users/x/Library/CloudStorage/OneDrive-AkerBP/Asoldi-website',
    link: '/tmp/does-not-exist-node_modules',
    sentinel: '/tmp/does-not-exist-sentinel',
    localDir,
  }), true);
  assert.equal(modulesNeedRelocate({
    cwd: '/Users/x/code/Asoldi-website',
    link: '/tmp/does-not-exist-node_modules',
    sentinel: '/tmp/does-not-exist-sentinel',
    localDir,
  }), false);
});
