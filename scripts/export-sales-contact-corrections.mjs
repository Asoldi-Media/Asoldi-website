#!/usr/bin/env node
/**
 * Writes the sales contact corrections that used to be bundled in data/sales-contact-corrections.js
 * (removed from the public repo) to a JSON file on a hub data disk, so the hub keeps applying them
 * at boot (data/sales-contact-corrections.js reads <dataDir>/sales-contact-corrections.json).
 *
 *   node scripts/export-sales-contact-corrections.mjs                 # → ~/.asoldi-website-data/…
 *   node scripts/export-sales-contact-corrections.mjs --out <file>    # any path outside the repo
 *   node scripts/export-sales-contact-corrections.mjs --rev <commit>  # default c3c22cf
 *
 * The output holds client contact data: it is refused inside this repo and never printed (only
 * the row count is). To put it on asoldi.com, copy the file to the hub data dir by hand.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_REV = 'c3c22cf';
const SOURCE_PATH = 'data/sales-contact-corrections.js';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The bundled list as it was at `rev` (an array of correction rows). */
export async function readBundledCorrections({ rev = DEFAULT_REV, cwd = repoRoot } = {}) {
  const source = execFileSync('git', ['show', `${rev}:${SOURCE_PATH}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-corrections-'));
  try {
    const file = join(dir, 'corrections.mjs');
    writeFileSync(file, source, { mode: 0o600 });
    const mod = await import(pathToFileURL(file).href);
    const list = mod.SALES_CONTACT_CORRECTIONS;
    if (!Array.isArray(list)) throw new Error(`${rev}:${SOURCE_PATH} has no SALES_CONTACT_CORRECTIONS array`);
    return list.filter((row) => row && typeof row === 'object' && row.businessName);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function exportCorrections({ rev = DEFAULT_REV, out, force = false, cwd = repoRoot } = {}) {
  const target = resolve(out || join(homedir(), '.asoldi-website-data', 'sales-contact-corrections.json'));
  if (isInside(target, repoRoot)) throw new Error('refusing to write client data inside the repo; choose a path outside it');
  if (existsSync(target) && !force) throw new Error(`${target} exists; pass --force to replace it`);
  const rows = await readBundledCorrections({ rev, cwd });
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, exportedFrom: rev, corrections: rows }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
  return { file: target, count: rows.length };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await exportCorrections({ rev: argValue(argv, '--rev') || DEFAULT_REV, out: argValue(argv, '--out'), force: argv.includes('--force') });
    console.log(`Wrote ${result.count} contact corrections to ${result.file}. Do not commit this file.`);
    return 0;
  } catch (error) {
    console.error(`export-sales-contact-corrections: ${error?.message || error}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
