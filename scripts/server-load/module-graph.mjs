/**
 * The modules server.js loads before it runs: every file reached through static import and
 * export-from declarations, starting at an entry file. A dynamic import() is not followed: it may
 * load a module with a top-level await, a static import may not when the host loads the entry with
 * require() (see require-like-host.cjs).
 *
 * Source is parsed with the TypeScript parser (a dependency of the hub), so comments, strings and
 * template text never count.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import ts from 'typescript';

const ES_MODULE_EXTENSIONS = new Set(['.js', '.mjs']);

function parse(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Code inside these runs later, or in its own async context: an await there is not top-level. */
function startsOwnScope(node) {
  return ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
}

/**
 * Every top-level await in ES module source: `await x`, `for await (...)` and `await using`
 * outside any function. Returns [{ line, text }].
 */
export function topLevelAwaits(source, file = 'module.js') {
  const sourceFile = parse(file, source);
  const found = [];
  const add = (node) => {
    const line = lineOf(sourceFile, node);
    found.push({ line, text: source.split(/\r?\n/)[line - 1].trim().slice(0, 160) });
  };
  const visit = (node) => {
    if (startsOwnScope(node)) return;
    if (ts.isAwaitExpression(node)) add(node);
    else if (ts.isForOfStatement(node) && node.awaitModifier) add(node);
    else if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing) add(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The specifiers of a module's static imports and export-from declarations. */
export function staticSpecifiers(source, file = 'module.js') {
  const sourceFile = parse(file, source);
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Walks the static graph from `entry`. Returns:
 *   files       every project file reached (absolute paths, in the order first seen)
 *   packages    the bare specifiers met (packages and node: built-ins; their own graphs are
 *               covered by the require() load test, not read here)
 *   missing     [{ from, specifier }] relative imports that name no file
 *   awaits      [{ file, line, text }] every top-level await in the reached ES modules
 */
export function staticModuleGraph(entry) {
  const start = resolve(entry);
  const files = [];
  const seen = new Set();
  const packages = new Set();
  const missing = [];
  const awaits = [];
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    // CommonJS and JSON cannot hold a top-level await or a static import.
    if (!ES_MODULE_EXTENSIONS.has(extname(file))) continue;
    const source = readFileSync(file, 'utf8');
    for (const hit of topLevelAwaits(source, file)) awaits.push({ file, ...hit });
    for (const specifier of staticSpecifiers(source, file)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        packages.add(specifier);
        continue;
      }
      const target = resolve(dirname(file), specifier);
      if (existsSync(target) && isFile(target)) queue.push(target);
      else missing.push({ from: file, specifier });
    }
  }
  return { files, packages: [...packages].sort(), missing, awaits };
}
