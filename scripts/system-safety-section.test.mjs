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
