#!/usr/bin/env node
/**
 * Records a rotated (retired) secret as a salted hash so the secret scan can still
 * recognise it in commits after the live value has changed.
 *
 *   echo -n "<value>" | node scripts/security/retire-secret.mjs --label "hub admin password 2026-10" --stdin
 *   node scripts/security/retire-secret.mjs --label "FIREFLIES_WEBHOOK_TOKEN (retired)" --env-file ../asoldi-website/.env --key FIREFLIES_WEBHOOK_TOKEN
 *   node scripts/security/retire-secret.mjs --list
 *
 * File: ~/.asoldi-secrets/retired.json (or ASOLDI_RETIRED_SECRETS), mode 0600, user-only ACL on
 * Windows. It holds a random per-machine salt and { label, length, hash } entries, never a
 * value, and never lives in a repo. Nothing here prints a value.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvText, retiredHash } from './secret-scan-lib.mjs';

export const MIN_RETIRED_LENGTH = 8;

export function retiredFilePath(env = process.env) {
  return env.ASOLDI_RETIRED_SECRETS || join(homedir(), '.asoldi-secrets', 'retired.json');
}

export function readRetiredFile(file) {
  if (!existsSync(file)) return { version: 1, algo: 'hmac-sha256', salt: randomBytes(32).toString('hex'), entries: [] };
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed.salt !== 'string' || !Array.isArray(parsed.entries)) {
    throw new Error(`${file} is not a retired-secrets file`);
  }
  return parsed;
}

function restrictToUser(file) {
  if (process.platform !== 'win32') return;
  try {
    const user = process.env.USERNAME;
    if (!user) return;
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
  } catch {
    // Best effort: the file still lives under the user's profile.
  }
}

export function writeRetiredFile(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  restrictToUser(file);
}

/** Adds the values (deduplicated by hash). Returns [{ label, length, added }]. */
export function addRetiredValues(file, label, values, { now = new Date() } = {}) {
  const data = readRetiredFile(file);
  const known = new Set(data.entries.map((entry) => entry.hash));
  const results = [];
  for (const raw of values) {
    const value = String(raw ?? '').replace(/\r?\n$/, '');
    if (value.length < MIN_RETIRED_LENGTH) {
      results.push({ label, length: value.length, added: false, reason: 'too-short' });
      continue;
    }
    const hash = retiredHash(data.salt, value);
    if (known.has(hash)) {
      results.push({ label, length: value.length, added: false, reason: 'already-present' });
      continue;
    }
    known.add(hash);
    data.entries.push({ label: String(label).slice(0, 120), length: value.length, hash, addedAt: now.toISOString() });
    results.push({ label, length: value.length, added: true });
  }
  writeRetiredFile(file, data);
  return results;
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2), { env = process.env, stdinText } = {}) {
  const file = retiredFilePath(env);
  if (argv.includes('--list')) {
    if (!existsSync(file)) {
      console.log(`${file}: no retired secrets yet.`);
      return 0;
    }
    const data = readRetiredFile(file);
    for (const entry of data.entries) console.log(`${entry.addedAt}  ${entry.label}  (${entry.length} chars)`);
    return 0;
  }
  const label = argValue(argv, '--label');
  if (!label) {
    console.error('retire-secret: --label is required (a name, never the value).');
    return 2;
  }
  let values = [];
  if (argv.includes('--stdin')) {
    const text = stdinText ?? readFileSync(0, 'utf8');
    values = text.split(/\r?\n/).filter((line) => line.length);
  } else if (argValue(argv, '--env-file') && argValue(argv, '--key')) {
    const map = parseEnvText(readFileSync(resolve(argValue(argv, '--env-file')), 'utf8'));
    const key = argValue(argv, '--key');
    if (!map[key]) {
      console.error(`retire-secret: ${key} is not set in that file.`);
      return 2;
    }
    values = argv.includes('--split') ? map[key].split(/[,;\s]+/).filter(Boolean) : [map[key]];
  } else {
    console.error('retire-secret: give --stdin or --env-file <path> --key <NAME>.');
    return 2;
  }
  if (!values.length) {
    console.error('retire-secret: no value given.');
    return 2;
  }
  for (const row of addRetiredValues(file, label, values)) {
    console.log(`${row.added ? 'added' : `skipped (${row.reason})`}: ${row.label} (${row.length} chars)`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`retire-secret: ${error?.message || error}`);
    process.exit(2);
  }
}
