// WS6.7: the hub's synced copy of the CMS feature registry (lib/cms-features.js,
// data/cms-feature-tree.json), the sync script, and parity with the delivery vocabulary and the
// SEO feature map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vocab from '../packages/suite/core/delivery/vocab.js';
import { featureRegistryStatus, loadFeatureRegistry } from '../lib/cms-features.js';
import { SEO_FEATURE_ALIASES, SEO_FEATURE_KEYS, SEO_TIER_SERVICES, seoKeysForTier } from '../lib/seo-ops/features.js';
import {
  META_FILE,
  SYNC_FILES,
  sha256Text,
  syncCmsFeatureTree,
  vocabularyProblems,
} from './sync-cms-feature-tree.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const { registry } = loadFeatureRegistry();
const tree = JSON.parse(read('data/cms-feature-tree.json'));

function cmsLayout(dir, { treeText = read('data/cms-feature-tree.json') } = {}) {
  const files = {
    'server/feature-tree.json': treeText,
    'server/features.js': read('lib/cms-features.js'),
    'test/fixtures/feature-matrix.json': read('scripts/fixtures/cms-feature-matrix.json'),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function tempDirs(t) {
  const source = mkdtempSync(join(tmpdir(), 'cms-tree-source-'));
  const target = mkdtempSync(join(tmpdir(), 'cms-tree-target-'));
  t.after(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  return { source, target };
}

test('the hub copy of the feature registry loads and matches the hashes the sync recorded', () => {
  assert.deepEqual(featureRegistryStatus(), { ok: true, error: null });
  assert.ok(registry);
  const meta = JSON.parse(read(META_FILE));
  assert.equal(meta.registryVersion, tree.registryVersion);
  assert.equal(meta.keyCount, tree.nodes.length);
  for (const [path, row] of Object.entries(meta.files)) {
    if (!row.from) continue;
    assert.equal(sha256Text(read(path)), row.sha256, `${path} was edited by hand; run node scripts/sync-cms-feature-tree.mjs`);
  }
  for (const file of SYNC_FILES.filter((f) => !f.optional)) assert.ok(meta.files[file.to]?.from, file.to);
});

test('the synced tree agrees with the delivery vocabulary (tiers, services, add-ons, aliases, anchors)', () => {
  assert.deepEqual(vocabularyProblems(tree, registry), []);
  for (const tierId of vocab.TIER_IDS) assert.deepEqual([...registry.TIER_SERVICES[tierId]].sort(), [...vocab.TIER_SERVICES[tierId]].sort(), tierId);
  assert.equal(registry.normalizeFeatureKey('blog.localPosts'), 'blog.autoPosts');
  assert.equal(vocab.canonicalFeatureKey('blog.localPosts'), registry.normalizeFeatureKey('blog.localPosts'));
  // Automatic posts: only the seo bundle carries them, so blog on every tier never brings them.
  for (const [service, bundle] of registry.BUNDLES) {
    if (bundle.keys.has('blog.autoPosts')) assert.equal(service, 'seo');
  }
});

test('the version 1 vocabulary (blog.localPosts as the key, blog.posts folded into blog) is reported as a mismatch', () => {
  const v1 = {
    ...vocab,
    SERVICE_FEATURE_ANCHORS: { blog: ['blog'], seo: ['blog.localPosts'], backlinks: ['seo.linkNetwork'] },
    SERVICE_EXCLUSIVE_FEATURES: { 'blog.localPosts': ['seo'] },
    FEATURE_KEY_ALIASES: { 'blog.posts': 'blog', 'blog.autoPosts': 'blog.localPosts' },
  };
  const problems = vocabularyProblems(tree, registry, v1);
  assert.ok(problems.some((p) => p.includes('blog.posts')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('blog.localPosts')), problems.join('\n'));
  const wrongTier = { ...vocab, TIER_SERVICES: { ...vocab.TIER_SERVICES, 'tier-1-standard': ['site', 'changes'] } };
  assert.ok(vocabularyProblems(tree, registry, wrongTier).some((p) => p.startsWith('tierServices.tier-1-standard')));
});

test('the SEO feature map gives every tier the same SEO and blog keys as the registry', () => {
  for (const key of SEO_FEATURE_KEYS) assert.ok(registry.FEATURE_NODES.some((node) => node.key === key), key);
  for (const [alias, target] of Object.entries(SEO_FEATURE_ALIASES)) assert.equal(tree.aliases[alias], target, alias);
  for (const tierId of Object.keys(SEO_TIER_SERVICES)) {
    const resolved = registry.resolveFeatures({ tierId });
    const fromTree = new Set(SEO_FEATURE_KEYS.filter((key) => resolved.effective.has(key)));
    // The SEO map sends one report: advanced replaces basic.
    if (fromTree.has('seo.reports.advanced')) fromTree.delete('seo.reports.basic');
    assert.deepEqual([...seoKeysForTier(tierId)].sort(), [...fromTree].sort(), tierId);
  }
});

test('the sync copies the files, records their hashes and changes nothing on a second run', async (t) => {
  const { source, target } = tempDirs(t);
  cmsLayout(source);
  const first = await syncCmsFeatureTree({ sourceDir: source, targetRoot: target });
  assert.equal(first.ok, true, first.problems.join('\n'));
  assert.deepEqual(first.changed.sort(), ['data/cms-feature-tree.json', 'data/cms-feature-tree.meta.json', 'lib/cms-features.js', 'scripts/fixtures/cms-feature-matrix.json']);
  assert.equal(read('lib/cms-features.js').replace(/\r\n/g, '\n'), readFileSync(join(target, 'lib/cms-features.js'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(target, META_FILE), 'utf8'));
  assert.equal(meta.files['lib/cms-features.js'].sha256, sha256Text(read('lib/cms-features.js')));
  const metaBefore = readFileSync(join(target, META_FILE), 'utf8');
  const second = await syncCmsFeatureTree({ sourceDir: source, targetRoot: target });
  assert.deepEqual(second.changed, []);
  assert.equal(readFileSync(join(target, META_FILE), 'utf8'), metaBefore);
  assert.equal((await syncCmsFeatureTree({ sourceDir: source, targetRoot: target, check: true })).ok, true);
  // A hub-authored optional file the CMS does not have yet is kept, not removed.
  mkdirSync(join(target, 'lib'), { recursive: true });
  writeFileSync(join(target, 'lib/cms-spec-schema.js'), 'export const CMS_SPEC_SCHEMA_VERSION = 1;\n');
  const third = await syncCmsFeatureTree({ sourceDir: source, targetRoot: target });
  assert.deepEqual(third.kept, ['lib/cms-spec-schema.js']);
  assert.ok(existsSync(join(target, 'lib/cms-spec-schema.js')));
  // A new registry version in the CMS is a drift for --check and is copied by a sync.
  cmsLayout(source, { treeText: read('data/cms-feature-tree.json').replace('"registryVersion": "2.3.0"', '"registryVersion": "2.3.1"') });
  const drift = await syncCmsFeatureTree({ sourceDir: source, targetRoot: target, check: true });
  assert.equal(drift.ok, false);
  assert.ok(drift.changed.includes('data/cms-feature-tree.json'));
  assert.equal(JSON.parse(readFileSync(join(target, 'data/cms-feature-tree.json'), 'utf8')).registryVersion, '2.3.0', '--check writes nothing');
});

test('a tree that does not build, or that disagrees with the vocabulary, stops the sync with nothing written', async (t) => {
  const { source, target } = tempDirs(t);
  const broken = JSON.parse(read('data/cms-feature-tree.json'));
  delete broken.nodes.find((node) => node.key === 'shop').label;
  cmsLayout(source, { treeText: JSON.stringify(broken, null, 2) });
  const bad = await syncCmsFeatureTree({ sourceDir: source, targetRoot: target });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join('\n'), /does not build/);
  assert.equal(existsSync(join(target, 'data/cms-feature-tree.json')), false);
  assert.equal(existsSync(join(target, 'lib/cms-features.js')), false);

  const otherTiers = JSON.parse(read('data/cms-feature-tree.json'));
  otherTiers.tierServices['tier-2-seo'] = otherTiers.tierServices['tier-2-seo'].filter((id) => id !== 'backlinks');
  cmsLayout(source, { treeText: JSON.stringify(otherTiers, null, 2) });
  const mismatch = await syncCmsFeatureTree({ sourceDir: source, targetRoot: target });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.problems.join('\n'), /tierServices\.tier-2-seo/);
  assert.equal(existsSync(join(target, META_FILE)), false);

  rmSync(join(source, 'server', 'features.js'));
  const missing = await syncCmsFeatureTree({ sourceDir: source, targetRoot: target });
  assert.deepEqual(missing.problems, ['missing in the CMS source: server/features.js']);
});

// Parity with website-cms. By default the check reads the commit the copy was synced from
// (sourceCommit in data/cms-feature-tree.meta.json) with git, from ../website-cms or CMS_SOURCE_DIR,
// so it does not depend on the branch that checkout is on. It is skipped, with the reason, when that
// checkout or that commit is not there. CMS_SOURCE_REF compares with another branch or tag instead;
// a ref named that way must exist.
const cmsSource = process.env.CMS_SOURCE_DIR || join(root, '..', 'website-cms');
const parityRef = process.env.CMS_SOURCE_REF || JSON.parse(read(META_FILE)).sourceCommit || '';

function paritySkipReason(sourceDir = cmsSource, ref = parityRef, explicitRef = Boolean(process.env.CMS_SOURCE_REF)) {
  if (!existsSync(sourceDir)) return 'website-cms not checked out next to this repo (set CMS_SOURCE_DIR)';
  if (!ref) return 'the sync recorded no source commit (set CMS_SOURCE_REF)';
  if (explicitRef) return false;
  try {
    execFileSync('git', ['-C', sourceDir, 'cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' });
    return false;
  } catch {
    return `the website-cms checkout has no commit ${ref.slice(0, 12)}, which the copy was synced from (fetch it, or set CMS_SOURCE_REF)`;
  }
}

test('the hub copy equals the website-cms registry it was synced from', { skip: paritySkipReason() }, async () => {
  const result = await syncCmsFeatureTree({ sourceDir: cmsSource, ref: parityRef, check: true });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.changed, [], 'run node scripts/sync-cms-feature-tree.mjs');
});

test('the parity check is skipped with its reason when the website-cms checkout lacks the synced commit', (t) => {
  const { source } = tempDirs(t);
  assert.match(String(paritySkipReason(join(source, 'absent'), 'abc', false)), /not checked out/);
  assert.match(String(paritySkipReason(source, '', false)), /no source commit/);
  // A folder that is not a git checkout (or a clone without the commit) cannot show the commit.
  assert.match(String(paritySkipReason(source, '0123456789abcdef0123456789abcdef01234567', false)), /has no commit 0123456789ab/);
  assert.equal(paritySkipReason(source, 'v9.9.9', true), false, 'an explicit ref is always compared');
});
