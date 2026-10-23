import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// "npm run lint" does not check JavaScript (no checkJs), so a call to a helper that no longer
// exists only shows up when that route runs. This asks the TypeScript checker for unknown names
// alone (TS2304, TS2552) in the server-side JavaScript.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);
const UNKNOWN_NAME = new Set([2304, 2552]);

function listSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (/\.m?js$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

test('server.js, lib and data use only names that are defined', { timeout: 180_000 }, () => {
  const roots = [join(repoRoot, 'server.js'), ...listSources(join(repoRoot, 'lib')), ...listSources(join(repoRoot, 'data'))];
  assert.ok(roots.length >= 100, `expected server.js, lib and data, found ${roots.length} files`);
  const program = ts.createProgram(roots, {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    types: ['node'],
    skipLibCheck: true,
    maxNodeModuleJsDepth: 0,
  });
  const found = [];
  for (const file of roots) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    for (const diagnostic of program.getSemanticDiagnostics(source)) {
      if (!UNKNOWN_NAME.has(diagnostic.code)) continue;
      const { line } = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      found.push(`${relative(repoRoot, file).split('\\').join('/')}:${line + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    }
  }
  assert.deepEqual(found, []);
});
