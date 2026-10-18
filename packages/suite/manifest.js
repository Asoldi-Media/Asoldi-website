import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const MANIFEST_FILE = 'suite.manifest.json';

export function listSuiteFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === MANIFEST_FILE) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

// CRLF is normalized so a Windows checkout with autocrlf hashes the same as the source.
export function hashSuite(root) {
  const files = {};
  for (const rel of listSuiteFiles(root)) {
    const text = readFileSync(join(root, rel)).toString('utf8').replace(/\r\n/g, '\n');
    files[rel] = createHash('sha256').update(text).digest('hex');
  }
  return files;
}

export function readManifest(root) {
  const file = join(root, MANIFEST_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function diffSuite(root) {
  const manifest = readManifest(root);
  if (!manifest) return { ok: false, missingManifest: true, changed: [], missing: [], extra: [] };
  const current = hashSuite(root);
  const listed = manifest.files || {};
  const changed = Object.keys(listed).filter((rel) => current[rel] && current[rel] !== listed[rel]);
  const missing = Object.keys(listed).filter((rel) => !current[rel]);
  const extra = Object.keys(current).filter((rel) => !listed[rel]);
  return { ok: !changed.length && !missing.length && !extra.length, missingManifest: false, changed, missing, extra };
}
