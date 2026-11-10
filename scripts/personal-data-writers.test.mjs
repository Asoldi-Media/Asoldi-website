// Every data file written through the hub's JSON write helpers (writeDataJson, writeHotJson,
// updateJsonLocked, writeJsonAtomic, writeTextAtomic, createJsonOnce) is either a registered
// personal-data store (lib/personal-data.js registerStore ... writers) or listed in NON_PERSONAL_WRITERS
// with a reason. A new writer fails this test until it is registered or listed.
// Not covered: plain fs writes (writeFileSync, appendFileSync, streams), such as append-only logs and
// uploaded files; those stores are registered by hand (see docs/privacy-processing-record.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-pd-writers-'));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { NON_PERSONAL_WRITERS, loadStoreModules } = await import('../lib/personal-data.js');

const WRITER_CALL = /\b(writeDataJson|writeHotJson|updateJsonLocked|writeJsonAtomic|writeTextAtomic|createJsonOnce|updateHotJson)\s*\(/g;
// Server code only: the browser bundle (app, src) cannot write the data disk; scripts are tools.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'scripts', 'public', 'app', 'src', 'tmp', 'local', 'assets', 'docs']);
const BACKSLASH = String.fromCharCode(92);

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(full, out);
      continue;
    }
    if (/\.m?js$/.test(entry.name) && !/\.test\.m?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The first argument's source text of the call whose "(" is at `open`. */
function firstArgument(source, open) {
  let depth = 0;
  let quote = '';
  for (let i = open + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === BACKSLASH) i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return source.slice(open + 1, i).trim();
      depth -= 1;
    } else if (ch === ',' && depth === 0) return source.slice(open + 1, i).trim();
  }
  return '';
}

/** The source with comments blanked out (strings kept), so a writer named in a comment is not a call. */
function withoutComments(source) {
  const out = source.split('');
  let state = '';
  for (let i = 0; i < out.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'line') {
      if (ch === '\n') state = '';
      else out[i] = ' ';
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        state = '';
      } else if (ch !== '\n') out[i] = ' ';
    } else if (state) {
      if (ch === BACKSLASH) i += 1;
      else if (ch === state) state = '';
    } else if (ch === '/' && next === '/') {
      state = 'line';
      out[i] = ' ';
    } else if (ch === '/' && next === '*') {
      state = 'block';
      out[i] = ' ';
    } else if (ch === '"' || ch === "'" || ch === '`') state = ch;
  }
  return out.join('');
}

/** '<file>:<first argument>' for every writer call under `base`. */
function scanWriters(base = root) {
  const keys = new Set();
  for (const file of sourceFiles(base)) {
    const rel = relative(base, file).split(sep).join('/');
    const source = withoutComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(WRITER_CALL)) {
      const before = source.slice(Math.max(0, match.index - 20), match.index);
      if (/function\s+$/.test(before)) continue; // the definition itself
      const arg = firstArgument(source, match.index + match[0].length - 1).replace(/\s+/g, ' ');
      if (arg) keys.add(`${rel}:${arg}`);
    }
  }
  return keys;
}

test('every JSON write helper target is a registered store or listed as holding no client personal data', async () => {
  const stores = await loadStoreModules();
  const registered = new Set(stores.flatMap((store) => store.writers));
  const found = scanWriters();
  assert.ok(found.size > 10, `expected the scan to find the hub's writers, found ${found.size}`);
  const missing = [...found].filter((key) => !registered.has(key) && !Object.prototype.hasOwnProperty.call(NON_PERSONAL_WRITERS, key));
  assert.deepEqual(missing, [], 'register these writers (registerStore writers) or list them in NON_PERSONAL_WRITERS with a reason');
});

test('no listed writer is stale, each is listed once, and every allowlist entry has a reason', async () => {
  const stores = await loadStoreModules();
  const found = scanWriters();
  const registered = stores.flatMap((store) => store.writers);
  const listed = [...registered, ...Object.keys(NON_PERSONAL_WRITERS)];
  assert.deepEqual(listed.filter((key) => !found.has(key)), [], 'these writers are no longer in the code');
  assert.deepEqual(Object.keys(NON_PERSONAL_WRITERS).filter((key) => registered.includes(key)), [], 'a writer is registered or allowlisted, not both');
  for (const [key, reason] of Object.entries(NON_PERSONAL_WRITERS)) assert.ok(String(reason).length > 10, key);
});

test('the scan catches a new writer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-pd-scan-'));
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'new-store.js'), [
    "import { writeDataJson } from '../data/storage-path.js';",
    'export function save(v) {',
    '  writeDataJson(NEW_PATH, v);',
    '}',
    'export function writeHotJson(path, v) { return [path, v]; }',
    "writeHotJson(join(dir(), 'hot.json'), {});",
    'updateJsonLocked(LOCKED_PATH, (current) => current);',
    '// writeJsonAtomic(COMMENTED, {}) is a comment, not a call',
    '',
  ].join('\n'));
  assert.deepEqual([...scanWriters(dir)].sort(), ['lib/new-store.js:LOCKED_PATH', 'lib/new-store.js:NEW_PATH', "lib/new-store.js:join(dir(), 'hot.json')"]);
});
