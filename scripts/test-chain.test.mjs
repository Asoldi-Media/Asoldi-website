import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// npm test is one long "&&" chain in package.json. These checks keep every test file in it and
// keep each command running every file it names.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts || {};
const TEST_DIRS = ['scripts', 'data'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git']);
const TEST_FILE = /\.test\.(?:mjs|js)$/;
const NAMED_FILE = /(?:scripts|data)\/[\w./-]+\.test\.(?:mjs|js)|scripts\/[\w./-]+\.mjs/g;

function listTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listTestFiles(full, out);
    else if (TEST_FILE.test(entry.name)) out.push(relative(repoRoot, full).split('\\').join('/'));
  }
  return out;
}

function commands(cmd) {
  return String(cmd).split('&&').map((part) => part.trim()).filter(Boolean);
}

/** Files named by "npm test", following "npm run <script>" into the scripts it calls. */
function filesRunByNpmTest() {
  const files = new Set();
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    visited.add(name);
    const cmd = String(scripts[name] || '');
    for (const match of cmd.matchAll(/npm run ([\w:-]+)/g)) visit(match[1]);
    for (const file of cmd.match(NAMED_FILE) || []) files.add(file);
  };
  visit('test');
  return files;
}

test('npm test runs every test file under scripts/ and data/', () => {
  const run = filesRunByNpmTest();
  const onDisk = TEST_DIRS.flatMap((dir) => listTestFiles(join(repoRoot, dir)));
  assert.ok(onDisk.length >= 100, `expected the test suite under ${TEST_DIRS.join(', ')}, found ${onDisk.length} files`);
  assert.deepEqual(onDisk.filter((file) => !run.has(file)).sort(), [], 'add these to the "test" chain in package.json');
});

test('every file the test scripts name exists', () => {
  const missing = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (!/^test(?::|$)/.test(name)) continue;
    for (const file of cmd.match(NAMED_FILE) || []) {
      if (!existsSync(join(repoRoot, file))) missing.push(`${name}: ${file}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('a test command that names several files runs them with node --test', () => {
  // "node a.mjs b.mjs" runs a.mjs alone and hands b.mjs to it as an argument.
  const single = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (!/^test(?::|$)/.test(name)) continue;
    for (const part of commands(cmd)) {
      const named = part.match(NAMED_FILE) || [];
      if (named.length > 1 && !/^node(?:\s+--[\w-]+(?:=\S+)?)*\s+--test\b/.test(part)) single.push(`${name}: ${part}`);
    }
  }
  assert.deepEqual(single, []);
});
