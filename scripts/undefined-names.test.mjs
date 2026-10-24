import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// "npm run lint" does not check JavaScript (no checkJs), so a call to a helper that no longer
// exists only shows up when that route runs. This asks the TypeScript checker for unknown names
// alone (TS2304, TS2552) in the server-side JavaScript.
//
// Imports are not followed. An import statement declares its names whether or not the module it
// names is read, and each file is checked in its own module scope, so a name that a file neither
// defines nor imports is still found. Following the imports read every typing the packages ship
// (googleapis alone is over 150 MB of .d.ts) and needed about 2.4 GB, more than a default Node
// heap on Linux. Node's own typings still load, for globals such as process and Buffer.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);
const UNKNOWN_NAME = new Set([2304, 2552]);
const OPTIONS = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  moduleDetection: ts.ModuleDetectionKind.Force,
  target: ts.ScriptTarget.ES2022,
  types: ['node'],
  typeRoots: [join(repoRoot, 'node_modules', '@types')],
  skipLibCheck: true,
  maxNodeModuleJsDepth: 0,
};

function listSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (/\.m?js$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

/** The unknown names in `files`, as "<path from base>:<line> <message>", and the program read. */
function unknownNames(files, base) {
  const host = ts.createCompilerHost(OPTIONS);
  host.resolveModuleNameLiterals = (literals) => literals.map(() => ({ resolvedModule: undefined }));
  const program = ts.createProgram(files, OPTIONS, host);
  const found = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    for (const diagnostic of program.getSemanticDiagnostics(source)) {
      if (!UNKNOWN_NAME.has(diagnostic.code)) continue;
      const { line } = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      found.push(`${relative(base, file).split('\\').join('/')}:${line + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    }
  }
  return { found, program };
}

test('the check finds a call to a function defined nowhere and a name used without its import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-undefined-names-'));
  try {
    const files = {
      'helpers.mjs': "export function cleanText(value) {\n  return String(value ?? '').trim();\n}\n",
      'route.mjs': "import { cleanText } from './helpers.mjs';\nexport function baseUrl(req) {\n  return cleanText(getRequestBaseUrl(req));\n}\n",
      'reader.mjs': "import { readFileSync } from 'node:fs';\nexport function read(path) {\n  return cleanText(readFileSync(path, 'utf8')) + Buffer.byteLength(path) + process.pid;\n}\n",
    };
    const paths = Object.entries(files).map(([name, text]) => {
      writeFileSync(join(dir, name), text);
      return join(dir, name);
    });
    const { found } = unknownNames(paths, dir);
    assert.equal(found.length, 2, found.join('\n'));
    assert.match(found[0], /^route\.mjs:3 Cannot find name 'getRequestBaseUrl'/);
    assert.match(found[1], /^reader\.mjs:3 Cannot find name 'cleanText'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server.js, lib and data use only names that are defined', { timeout: 180_000 }, () => {
  const roots = [join(repoRoot, 'server.js'), ...listSources(join(repoRoot, 'lib')), ...listSources(join(repoRoot, 'data'))];
  assert.ok(roots.length >= 100, `expected server.js, lib and data, found ${roots.length} files`);
  const { found, program } = unknownNames(roots, repoRoot);
  assert.deepEqual(found, []);
  const packageFiles = program.getSourceFiles()
    .map((source) => source.fileName)
    .filter((name) => name.includes('/node_modules/') && !/\/node_modules\/(@types\/node|typescript\/lib)\//.test(name));
  assert.deepEqual(packageFiles.slice(0, 5), [], 'no package typings are read besides Node\'s own');
});
