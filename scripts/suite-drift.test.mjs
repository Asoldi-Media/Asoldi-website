import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffSuite, readManifest } from '../packages/suite/manifest.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages', 'suite');
const vendored = join(root, '..', 'website-maker', 'lib', 'suite');

test('packages/suite matches its manifest (run node scripts/sync-suite.mjs after editing)', () => {
  const diff = diffSuite(source);
  assert.equal(diff.ok, true, JSON.stringify(diff));
});

test('website-maker copy is the same sync as packages/suite', { skip: !existsSync(vendored) && 'website-maker not checked out next to this repo' }, () => {
  assert.deepEqual(readManifest(vendored)?.files, readManifest(source)?.files);
  const diff = diffSuite(vendored);
  assert.equal(diff.ok, true, JSON.stringify(diff));
});
