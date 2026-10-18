import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSuiteFiles } from '../packages/suite/manifest.js';

const root = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'packages', 'suite');
const OPTIONAL_DEPS = new Set(['sharp', 'image-size', 'adm-zip', 'xlsx']);
const files = listSuiteFiles(root).filter((rel) => rel.endsWith('.js'));

function specifiers(source) {
  const out = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) out.push({ spec: match[1], dynamic: false });
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push({ spec: match[1], dynamic: false });
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: match[1], dynamic: true });
  // Lazy createRequire() loads count as dynamic: they run on first use, not at import.
  for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: match[1], dynamic: true });
  return out;
}

function layerOf(rel) {
  return rel.startsWith('core/') ? 'core' : rel.startsWith('harness/') ? 'harness' : 'tool';
}

test('core imports only node:*, other core files, and optional deps by dynamic import', () => {
  const bad = [];
  for (const rel of files.filter((file) => layerOf(file) === 'core')) {
    for (const { spec, dynamic } of specifiers(readFileSync(join(root, rel), 'utf8'))) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(rel), spec));
        if (!target.startsWith('core/')) bad.push(`${rel} -> ${spec}`);
        continue;
      }
      if (dynamic && OPTIONAL_DEPS.has(spec)) continue;
      bad.push(`${rel} -> ${spec}${dynamic ? ' (dynamic)' : ''}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('harness imports only core and its own harness folder', () => {
  const bad = [];
  for (const rel of files.filter((file) => layerOf(file) === 'harness')) {
    const own = rel.split('/').slice(0, 2).join('/');
    for (const { spec } of specifiers(readFileSync(join(root, rel), 'utf8'))) {
      const target = spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(rel), spec)) : spec;
      if (!(target.startsWith('core/') || target.startsWith(`${own}/`))) bad.push(`${rel} -> ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('core/media has no fs/os/child_process and no network call besides gemini.js', () => {
  const bad = [];
  for (const rel of files.filter((file) => file.startsWith('core/media/'))) {
    const source = readFileSync(join(root, rel), 'utf8');
    if (/node:fs|['"]fs['"]|node:child_process|node:os/.test(source)) bad.push(`${rel}: fs/os/child_process`);
    if (/\bfetch\(/.test(source) && rel !== 'core/media/gemini.js') bad.push(`${rel}: fetch`);
  }
  assert.deepEqual(bad, []);
});

test('core holds no Asoldi names; Asoldi wording lives in the harness', () => {
  const bad = files
    .filter((file) => layerOf(file) === 'core')
    .filter((rel) => /asoldi|kundedata|alexander@|damian@/i.test(readFileSync(join(root, rel), 'utf8')));
  assert.deepEqual(bad, []);
});
