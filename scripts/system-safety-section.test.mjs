// Superadmin → System safety: email HTML is shown only in a sandboxed iframe, never injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const section = readFileSync(new URL('../app/pages/Admin/sections/SystemSafetySection.tsx', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../app/pages/Admin/Admin.tsx', import.meta.url), 'utf8');

test('the outbox preview is a sandbox="" iframe with no script or same-origin allowances', () => {
  assert.match(section, /<iframe[^>]*sandbox=""/);
  assert.match(section, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(section, /dangerouslySetInnerHTML|innerHTML/);
  assert.doesNotMatch(section, /allow-scripts|allow-same-origin|srcDoc/);
});

test('the section reads only the safe-mode admin endpoints', () => {
  for (const path of ['/admin/system/safe-mode', '/admin/system/outbox']) assert.ok(section.includes(path), path);
});

test('Admin has a System safety tab', () => {
  assert.match(admin, /tab === 'system'/);
  assert.match(admin, /label="System safety"/);
  assert.match(admin, /<SystemSafetySection \/>/);
});

test('browser bundle: no module the app imports pulls in server-only safe-mode code', async () => {
  const { readdirSync, statSync, existsSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(name)) files.push(full);
    }
  };
  walk(path.join(root, 'app'));
  const seen = new Set();
  const resolve = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(from), spec);
    for (const candidate of [base, `${base}.js`, `${base}.ts`, `${base}.tsx`]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const next = resolve(file, match[1] || match[2]);
      if (next) visit(next);
    }
  };
  files.forEach(visit);
  const serverOnly = [...seen].map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter((rel) => /^lib\/(safe-mode(?!-hooks)[^/]*|runtime-mode|load-env)\.js$/.test(rel));
  assert.deepEqual(serverOnly, [], 'the browser app must reach safe mode only through lib/safe-mode-hooks.js');
});
