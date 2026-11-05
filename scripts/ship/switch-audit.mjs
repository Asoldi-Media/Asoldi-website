#!/usr/bin/env node
/**
 * Switch-off audit: compares the code defaults of two hub trees.
 *
 *   node scripts/ship/switch-audit.mjs <base tree> <head tree> [--json]
 *
 * Prints every automation-settings default leaf that head adds or changes, every SETTINGS_KEYS entry
 * head adds, the e-mail settings defaults head adds, and every process.env name that head's runtime
 * files (server.js, lib/, data/, packages/suite/) read and base's do not.
 *
 * A new leaf counts as off when it is false, 'off', null, '', 0 or an empty list or object, and as
 * shadow when it is 'shadow' (shadow writes nothing live by the hub's own rules; it is listed so a
 * reader can check it). Any other new or changed leaf is CHECK: a person looks at it. Exit 1 when
 * there is a CHECK leaf, 0 otherwise. A tree whose module cannot be loaded is exit 2 (an audit
 * that read nothing would report nothing).
 *
 * The audit loads the trees' own data modules with a temp data folder and in safe mode; it never
 * writes to either tree.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The leaves of a nested object as { 'a.b.c': value }; an empty object or a list is one leaf. */
export function leaves(value, prefix = '', out = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
    for (const [k, v] of Object.entries(value)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = value;
  return out;
}

/** 'off' | 'shadow' | 'CHECK' for a leaf head adds or changes. */
export function stateOf(value) {
  const empty = (v) => (Array.isArray(v) && v.length === 0) || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
  if (value === false || value === 'off' || value === null || value === '' || value === 0 || empty(value)) return 'off';
  if (value === 'shadow') return 'shadow';
  return 'CHECK';
}

/** Rows for the leaves head adds or changes, and the keys it removes. */
export function compareLeaves(base, head) {
  const b = leaves(base);
  const h = leaves(head);
  const rows = [];
  for (const [key, value] of Object.entries(h)) {
    if (key in b && JSON.stringify(b[key]) === JSON.stringify(value)) continue;
    rows.push({ key, value, change: key in b ? 'changed' : 'new', was: key in b ? b[key] : undefined, state: stateOf(value) });
  }
  const removed = Object.keys(b).filter((key) => !(key in h));
  return { rows, removed };
}

const ENV_PATTERN = /process\.env\.([A-Z0-9_]+)|process\.env\[['"]([A-Z0-9_]+)['"]\]|\benv\.([A-Z][A-Z0-9_]{3,})\b/g;

/** The environment variable names the runtime files of a tree read (not tests). */
export function envNames(dir) {
  const names = new Set();
  const scan = (text) => {
    for (const m of text.matchAll(ENV_PATTERN)) names.add(m[1] || m[2] || m[3]);
  };
  const walk = (d) => {
    let entries = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|cjs|ts)$/.test(name) && !/\.test\./.test(name)) scan(readFileSync(p, 'utf8'));
    }
  };
  for (const rel of ['lib', 'data', 'packages/suite']) walk(join(dir, rel));
  try {
    scan(readFileSync(join(dir, 'server.js'), 'utf8'));
  } catch { /* a tree without server.js has no names there */ }
  return names;
}

async function load(dir, rel) {
  try {
    return await import(pathToFileURL(join(dir, rel)).href);
  } catch (error) {
    throw new Error(`cannot load ${rel} from ${dir}: ${String(error?.message || error)}`);
  }
}

const emailDefaults = (m) => (typeof m.defaultEmailSettings === 'function' ? m.defaultEmailSettings() : (m.DEFAULT_EMAIL_SETTINGS || {}));

/** Runs the audit on two trees. Returns { sections, settingsKeys, env, check }. */
export async function auditSwitches(baseDir, headDir) {
  const [ba, he] = [await load(baseDir, 'data/automation-settings.js'), await load(headDir, 'data/automation-settings.js')];
  const [bv, hv] = [await load(baseDir, 'packages/suite/core/delivery/vocab.js'), await load(headDir, 'packages/suite/core/delivery/vocab.js')];
  const [be, hee] = [await load(baseDir, 'data/email-store.js'), await load(headDir, 'data/email-store.js')];
  const sections = [
    { title: 'defaultAutomationSettings()', ...compareLeaves(ba.defaultAutomationSettings?.() || {}, he.defaultAutomationSettings?.() || {}) },
    { title: 'email settings defaults', ...compareLeaves(emailDefaults(be), emailDefaults(hee)) },
  ];
  const baseKeys = leaves(bv.SETTINGS_KEYS || {});
  const settingsKeys = {
    from: bv.VOCAB_VERSION,
    to: hv.VOCAB_VERSION,
    added: Object.entries(leaves(hv.SETTINGS_KEYS || {})).filter(([k]) => !(k in baseKeys)).map(([key, value]) => ({ key, value })),
  };
  const baseEnv = envNames(baseDir);
  const env = [...envNames(headDir)].filter((n) => !baseEnv.has(n)).sort();
  const check = sections.reduce((n, s) => n + s.rows.filter((r) => r.state === 'CHECK').length, 0);
  return { sections, settingsKeys, env, check };
}

export function formatAudit(result) {
  const lines = [];
  const [first, ...rest] = result.sections;
  const section = (s) => {
    lines.push(`== ${s.title}`);
    for (const r of s.rows) lines.push(`  ${r.state.padEnd(6)} ${r.key} = ${JSON.stringify(r.value)} (${r.change === 'new' ? 'new' : `changed from ${JSON.stringify(r.was)}`})`);
    for (const k of s.removed) lines.push(`  removed ${k}`);
  };
  section(first);
  lines.push(`== SETTINGS_KEYS (VOCAB_VERSION ${result.settingsKeys.from} -> ${result.settingsKeys.to})`);
  for (const { key, value } of result.settingsKeys.added) lines.push(`  new ${key} = ${JSON.stringify(value)}`);
  for (const s of rest) section(s);
  lines.push(`== env names read by head runtime files and not by base (${result.env.length})`);
  for (const n of result.env) lines.push(`  ${n}`);
  lines.push(`audit: ${result.check} default(s) to check by hand`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const dirs = argv.filter((a) => !a.startsWith('--')).map((a) => resolve(a));
  if (dirs.length !== 2) {
    console.error('usage: switch-audit.mjs <base tree> <head tree> [--json]');
    return 2;
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'switch-audit-'));
  process.env.APP_DATA_DIR = dataDir;
  process.env.HUB_SAFE_MODE = '1';
  try {
    const result = await auditSwitches(dirs[0], dirs[1]);
    console.log(json ? JSON.stringify(result, null, 2) : formatAudit(result));
    return result.check ? 1 : 0;
  } catch (error) {
    console.error(`switch-audit: ${error?.message || error}`);
    return 2;
  } finally {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* a temp folder with no client data */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
