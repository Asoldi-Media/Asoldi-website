#!/usr/bin/env node
// Copies the client CMS feature registry into the hub (WS6.7).
//
//   node scripts/sync-cms-feature-tree.mjs [--source ../website-cms] [--ref <git ref>] [--check]
//
// website-cms is the single source of the feature registry. This script copies:
//   server/feature-tree.json        -> data/cms-feature-tree.json
//   server/features.js              -> lib/cms-features.js (same bytes; it finds the tree in ../data)
//   server/cms-spec-schema.js       -> lib/cms-spec-schema.js (only when the CMS has one)
//   test/fixtures/feature-matrix.json -> scripts/fixtures/cms-feature-matrix.json (hand-written golden)
// and writes the sha256 of each copy into data/cms-feature-tree.meta.json.
//
// Before it writes anything it builds the new tree with the new resolver (createFeatureRegistry)
// and checks it against the delivery vocabulary (tier services, service and add-on ids, alias rows,
// the service anchors). Any problem stops the sync with nothing written. Running it twice on the
// same input changes nothing. With --ref the files are read with `git show <ref>:<path>`, so a tag
// or branch can be synced without checking it out. --check only compares and exits 1 on a drift.
//
// Release order: the hub copy ships before any CMS version that adds keys (WS6.51 checklist).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as deliveryVocab from '../packages/suite/core/delivery/vocab.js';

const HUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const META_FILE = 'data/cms-feature-tree.meta.json';

/** Source path in website-cms -> target path in the hub. `optional` files may be missing in the CMS. */
export const SYNC_FILES = Object.freeze([
  { from: 'server/feature-tree.json', to: 'data/cms-feature-tree.json', optional: false },
  { from: 'server/features.js', to: 'lib/cms-features.js', optional: false },
  { from: 'server/cms-spec-schema.js', to: 'lib/cms-spec-schema.js', optional: true },
  { from: 'test/fixtures/feature-matrix.json', to: 'scripts/fixtures/cms-feature-matrix.json', optional: true },
]);

/** Line endings normalised, so a Windows checkout (autocrlf) hashes like the repository blob. */
export function normalizedText(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}

export function sha256Text(text) {
  return `sha256:${createHash('sha256').update(normalizedText(text)).digest('hex')}`;
}

function sameList(a, b) {
  return JSON.stringify([...(a || [])]) === JSON.stringify([...(b || [])]);
}

/**
 * Problems between a feature tree and the delivery vocabulary (empty when they agree).
 * `registry` is createFeatureRegistry(tree) when available (bundle closure for the anchor checks).
 * `vocab` defaults to packages/suite/core/delivery/vocab.js.
 */
export function vocabularyProblems(tree, registry = null, vocab = deliveryVocab) {
  const {
    FEATURE_KEY_ALIASES,
    ONE_TIME_ADDON_IDS,
    SERVICE_EXCLUSIVE_FEATURES,
    SERVICE_FEATURE_ANCHORS,
    SERVICE_IDS,
    TIER_SERVICES,
  } = vocab;
  const problems = [];
  const services = (tree?.services || []).map((s) => s.id);
  const addOns = (tree?.oneTimeAddOns || []).map((s) => s.id);
  if (!sameList([...services].sort(), [...SERVICE_IDS].sort())) {
    problems.push(`service ids differ: tree [${services.join(',')}] vocabulary [${SERVICE_IDS.join(',')}]`);
  }
  if (!sameList([...addOns].sort(), [...ONE_TIME_ADDON_IDS].sort())) {
    problems.push(`one-time add-on ids differ: tree [${addOns.join(',')}] vocabulary [${ONE_TIME_ADDON_IDS.join(',')}]`);
  }
  const tierIds = new Set([...Object.keys(tree?.tierServices || {}), ...Object.keys(TIER_SERVICES)]);
  for (const tierId of tierIds) {
    const fromTree = tree?.tierServices?.[tierId];
    const fromVocab = TIER_SERVICES[tierId];
    if (!fromTree || !fromVocab || !sameList([...fromTree].sort(), [...fromVocab].sort())) {
      problems.push(`tierServices.${tierId} differs: tree [${(fromTree || []).join(',')}] vocabulary [${(fromVocab || []).join(',')}]`);
    }
  }
  const treeAliases = tree?.aliases || {};
  for (const [alias, target] of Object.entries(FEATURE_KEY_ALIASES)) {
    if (treeAliases[alias] !== target) problems.push(`alias ${alias} -> ${target} is not in the tree (tree says ${treeAliases[alias] || 'nothing'})`);
  }
  if (registry) {
    for (const [service, keys] of Object.entries(SERVICE_FEATURE_ANCHORS)) {
      const bundle = registry.BUNDLES.get(service);
      for (const key of keys) {
        if (!bundle || !bundle.keys.has(key)) problems.push(`service ${service} must entitle ${key} (SERVICE_FEATURE_ANCHORS)`);
      }
    }
    for (const [key, owners] of Object.entries(SERVICE_EXCLUSIVE_FEATURES)) {
      for (const [service, bundle] of registry.BUNDLES) {
        if (bundle.keys.has(key) && !owners.includes(service)) {
          problems.push(`${key} is in the ${service} bundle; only ${owners.join(',')} may entitle it (SERVICE_EXCLUSIVE_FEATURES)`);
        }
      }
    }
  }
  return problems;
}

function sameMetaContent(text, meta) {
  let stored;
  try {
    stored = JSON.parse(text || 'null');
  } catch {
    return false;
  }
  const pick = (m) => JSON.stringify({ registryVersion: m?.registryVersion, v: m?.v, keyCount: m?.keyCount, files: m?.files });
  return Boolean(stored) && pick(stored) === pick(meta);
}

function gitShow(sourceDir, ref, path) {
  try {
    return execFileSync('git', ['-C', sourceDir, 'show', `${ref}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function gitCommit(sourceDir, ref) {
  try {
    return execFileSync('git', ['-C', sourceDir, 'rev-parse', `${ref || 'HEAD'}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Reads one source file from a folder or a git ref; null when it does not exist. */
export function makeSourceReader({ sourceDir, ref = '' }) {
  return (path) => {
    if (ref) return gitShow(sourceDir, ref, path);
    const file = join(sourceDir, path);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };
}

/** Builds the tree with the resolver it came with, in a throwaway folder. Throws on an invalid tree. */
export async function buildRegistryFrom(featuresSource, treeSource) {
  const dir = mkdtempSync(join(tmpdir(), 'cms-feature-sync-'));
  try {
    mkdirSync(join(dir, 'server'), { recursive: true });
    writeFileSync(join(dir, 'server', 'feature-tree.json'), treeSource);
    writeFileSync(join(dir, 'server', 'features.js'), featuresSource);
    const mod = await import(pathToFileURL(join(dir, 'server', 'features.js')).href);
    const tree = JSON.parse(treeSource);
    return { tree, registry: mod.createFeatureRegistry(tree) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Sync (or with check:true, compare). Returns { ok, changed: [paths], unchanged: [paths], kept: [paths],
 * problems: [], meta }. Nothing is written unless every check passes.
 */
export async function syncCmsFeatureTree({
  sourceDir = resolve(HUB_ROOT, '..', 'website-cms'),
  ref = '',
  targetRoot = HUB_ROOT,
  check = false,
  readSource = null,
} = {}) {
  const read = readSource || makeSourceReader({ sourceDir, ref });
  const problems = [];
  const sources = new Map();
  for (const file of SYNC_FILES) {
    const text = read(file.from);
    if (text === null || text === undefined) {
      if (!file.optional) problems.push(`missing in the CMS source: ${file.from}`);
      continue;
    }
    sources.set(file.from, normalizedText(text));
  }
  if (problems.length) return { ok: false, problems, changed: [], unchanged: [], kept: [], meta: null };

  let built;
  try {
    built = await buildRegistryFrom(sources.get('server/features.js'), sources.get('server/feature-tree.json'));
  } catch (error) {
    return { ok: false, problems: [`the tree does not build: ${error.message}`], changed: [], unchanged: [], kept: [], meta: null };
  }
  problems.push(...vocabularyProblems(built.tree, built.registry));
  if (problems.length) return { ok: false, problems, changed: [], unchanged: [], kept: [], meta: null };

  const meta = {
    source: 'website-cms',
    ref: ref || null,
    sourceCommit: readSource ? null : gitCommit(sourceDir, ref),
    registryVersion: built.tree.registryVersion,
    v: built.tree.v,
    keyCount: built.tree.nodes.length,
    files: {},
  };
  const changed = [];
  const unchanged = [];
  const kept = [];
  const writes = [];
  for (const file of SYNC_FILES) {
    const target = join(targetRoot, file.to);
    const current = existsSync(target) ? normalizedText(readFileSync(target, 'utf8')) : null;
    if (!sources.has(file.from)) {
      // An optional file the CMS does not have yet stays as the hub has it.
      if (current !== null) {
        kept.push(file.to);
        // No hash: the hub may still edit its own copy until the CMS takes the file over.
        meta.files[file.to] = { from: null, note: 'hub copy; the CMS has no source file yet' };
      }
      continue;
    }
    const next = sources.get(file.from);
    meta.files[file.to] = { from: file.from, sha256: sha256Text(next) };
    if (current === next) unchanged.push(file.to);
    else {
      changed.push(file.to);
      writes.push({ target, text: next });
    }
  }
  const metaTarget = join(targetRoot, META_FILE);
  const metaText = `${JSON.stringify(meta, null, 2)}\n`;
  const currentMeta = existsSync(metaTarget) ? normalizedText(readFileSync(metaTarget, 'utf8')) : null;
  // --check compares content only; where the copy came from (ref, commit) may differ.
  const metaDiffers = check ? !sameMetaContent(currentMeta, meta) : currentMeta !== metaText;
  if (metaDiffers) {
    changed.push(META_FILE);
    writes.push({ target: metaTarget, text: metaText });
  } else {
    unchanged.push(META_FILE);
  }
  if (!check) {
    for (const { target, text } of writes) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  return { ok: check ? changed.length === 0 : true, problems: [], changed, unchanged, kept, meta };
}

function argValue(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? '' : String(argv[at + 1] || '');
}

async function main(argv) {
  const sourceDir = resolve(argValue(argv, '--source') || resolve(HUB_ROOT, '..', 'website-cms'));
  const ref = argValue(argv, '--ref');
  const check = argv.includes('--check');
  if (!ref && !existsSync(sourceDir)) {
    console.error(`[cms-feature-tree] source not found: ${sourceDir}`);
    return 2;
  }
  const result = await syncCmsFeatureTree({ sourceDir, ref, check });
  if (result.problems.length) {
    console.error(`[cms-feature-tree] stopped, nothing written:\n- ${result.problems.join('\n- ')}`);
    return 1;
  }
  const label = `${result.meta.registryVersion} (${result.meta.keyCount} keys${ref ? `, ${ref}` : ''})`;
  if (check) {
    if (result.changed.length) {
      console.error(`[cms-feature-tree] the hub copy differs from ${label}: ${result.changed.join(', ')}`);
      return 1;
    }
    console.log(`[cms-feature-tree] the hub copy matches ${label}`);
    return 0;
  }
  console.log(`[cms-feature-tree] ${label}: ${result.changed.length ? `updated ${result.changed.join(', ')}` : 'already up to date'}${result.kept.length ? `; kept ${result.kept.join(', ')}` : ''}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`[cms-feature-tree] ${error?.stack || error}`);
    process.exit(1);
  });
}
