#!/usr/bin/env node
// Vendors packages/suite into website-maker/lib/suite and stamps a sha256 manifest in both.
// Edit packages/suite only; the copy in website-maker is overwritten on every sync.
// A copy that holds files packages/suite does not have (website-maker's own core/llm, say) is never
// deleted silently: the sync lists them and stops, unless --force is passed.
//   node scripts/sync-suite.mjs [targetDir] [--force]
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FILE, hashSuite, listSuiteFiles } from '../packages/suite/manifest.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages', 'suite');
const target = resolve(args.find((arg) => !arg.startsWith('--')) || join(root, '..', 'website-maker', 'lib', 'suite'));

if (!existsSync(join(target, '..'))) {
  console.error(`[sync-suite] parent of ${target} does not exist`);
  process.exit(1);
}
if (existsSync(target) && !existsSync(join(target, MANIFEST_FILE))) {
  console.error(`[sync-suite] ${target} exists but is not a vendored suite copy; refusing to overwrite`);
  process.exit(1);
}
// listSuiteFiles skips node_modules and the manifest file on both sides.
const sourceFiles = new Set(listSuiteFiles(source));
const onlyInTarget = existsSync(target) ? listSuiteFiles(target).filter((rel) => !sourceFiles.has(rel)) : [];
if (onlyInTarget.length && !force) {
  console.error(`[sync-suite] ${target} has ${onlyInTarget.length} file(s) that packages/suite does not have; a sync would delete them:`);
  for (const rel of onlyInTarget) console.error(`  ${rel}`);
  console.error('[sync-suite] nothing changed. Add them to packages/suite first, or pass --force to delete them.');
  process.exit(1);
}

const manifest = { source: 'asoldi-website/packages/suite', syncedAt: new Date().toISOString(), files: hashSuite(source) };
const body = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(source, MANIFEST_FILE), body);
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true, filter: (path) => !/[\\/]node_modules([\\/]|$)/.test(path) });
writeFileSync(join(target, MANIFEST_FILE), body);
console.log(`[sync-suite] ${Object.keys(manifest.files).length} files -> ${target}`);
