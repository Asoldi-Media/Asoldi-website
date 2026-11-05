#!/usr/bin/env node
/**
 * Segment runner: runs every "&&" segment of a package.json script on its own (cwd = the checkout),
 * so one failing segment does not hide the others.
 *
 *   node scripts/ship/segments.mjs <checkout> <log folder> [script=test]
 *   node scripts/ship/segments.mjs <checkout> --find <text> [script=test]
 *
 * The first form prints one line per segment and the names of the failing tests, writes the full
 * output of each failing segment to <log folder>/seg-<n>.log, and ends with the totals. Exit 0 when
 * every segment passed, 1 otherwise, 2 for bad arguments. A script with no segment is exit 2.
 * The second form prints the segment that contains <text> (for example a test file name) and exits.
 * An "npm run <script>" segment is expanded into the segments of that script.
 *
 * Run it through the same wrapper as the full suite (a clean data folder, safe mode, no .env).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The "&&" segments of a package script, with "npm run <name>" parts expanded. */
export function expandScript(scripts, name, seen = new Set()) {
  const cmd = scripts?.[name];
  if (typeof cmd !== 'string') throw new Error(`package.json has no script "${name}"`);
  if (seen.has(name)) throw new Error(`script "${name}" runs itself`);
  const nextSeen = new Set(seen).add(name);
  return cmd.split(' && ').flatMap((part) => {
    const m = part.trim().match(/^npm run (?:-s )?([\w:-]+)$/);
    return m ? expandScript(scripts, m[1], nextSeen) : [part.trim()];
  });
}

/** The counts and failing test names in the output of a node:test run. */
export function parseOutput(out) {
  let pass = 0;
  let fail = 0;
  for (const m of out.matchAll(/^ℹ pass (\d+)/gm)) pass += Number(m[1]);
  for (const m of out.matchAll(/^ℹ fail (\d+)/gm)) fail += Number(m[1]);
  const names = [...new Set([...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))];
  return { pass, fail, names };
}

export function main(argv = process.argv.slice(2)) {
  const [root, second, third] = argv;
  if (!root || !second) {
    console.error('usage: segments.mjs <checkout> <log folder> [script]  |  segments.mjs <checkout> --find <text> [script]');
    return 2;
  }
  const find = second === '--find';
  const name = (find ? argv[3] : third) || 'test';
  let segments;
  try {
    const pkg = JSON.parse(readFileSync(join(resolve(root), 'package.json'), 'utf8'));
    segments = expandScript(pkg.scripts, name);
  } catch (error) {
    console.error(`segments: ${error.message}`);
    return 2;
  }
  if (!segments.length) {
    console.error(`segments: script "${name}" has no segment`);
    return 2;
  }
  if (find) {
    const hit = segments.find((s) => s.includes(third));
    process.stdout.write(hit || '');
    return hit ? 0 : 1;
  }
  const logdir = resolve(second);
  mkdirSync(logdir, { recursive: true });
  let failed = 0;
  let passTotal = 0;
  let failTotal = 0;
  segments.forEach((segment, n) => {
    const started = Date.now();
    const r = spawnSync(segment, { cwd: resolve(root), shell: true, encoding: 'utf8', env: process.env, maxBuffer: 1 << 28 });
    const out = `${r.stdout}${r.stderr}`;
    const ok = r.status === 0;
    const counts = parseOutput(out);
    passTotal += counts.pass;
    failTotal += counts.fail;
    if (!ok) {
      failed += 1;
      writeFileSync(join(logdir, `seg-${n}.log`), `${segment}\n\n${out}`);
    }
    console.log(`${ok ? 'PASS' : 'FAIL'} #${n} ${Math.round((Date.now() - started) / 1000)}s  ${segment.slice(0, 110)}`);
    for (const f of counts.names) console.log(`     ✖ ${f}`);
  });
  console.log(`segments: ${segments.length}, failed: ${failed}; node:test pass ${passTotal}, fail ${failTotal}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
