// WS8.43: every id in the delivery vocabulary is documented, and every runbook has symptom, check and fix.
// Part of every delivery batch's definition of done.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vocab from '../packages/suite/core/delivery/vocab.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flow = readFileSync(join(root, 'docs', 'delivery-flow.md'), 'utf8');
const runbooks = readFileSync(join(root, 'docs', 'delivery-runbooks.md'), 'utf8');
const docs = `${flow}\n${runbooks}`;

function undocumented(ids) {
  return [...ids].filter((id) => !docs.includes(`\`${id}\``));
}

test('every job kind, blocking code, warning code, email kind and settings key is documented', () => {
  assert.deepEqual(undocumented(vocab.JOB_KINDS), [], 'job kinds');
  assert.deepEqual(undocumented(vocab.BLOCKING_CODES), [], 'blocking codes');
  assert.deepEqual(undocumented(vocab.WARNING_CODES), [], 'warning codes');
  assert.deepEqual(undocumented(vocab.EMAIL_KIND_IDS), [], 'email kinds');
  assert.deepEqual(undocumented(Object.values(vocab.SETTINGS_KEYS)), [], 'settings keys');
  for (const field of vocab.EMAIL_SETTINGS_FIELDS) {
    assert.ok(docs.includes(`\`emails.<kind>.${field}\``), `emails.<kind>.${field}`);
  }
});

test('every stage, gate line, service, add-on and cancellation effect is documented', () => {
  assert.deepEqual(undocumented([...vocab.STAGES, ...vocab.STAGE_OVERLAYS]), [], 'stages');
  assert.deepEqual(undocumented([...vocab.GATE_LINE_IDS, ...vocab.GATE_INFO_LINES]), [], 'gate lines');
  assert.deepEqual(undocumented(vocab.SERVICE_IDS), [], 'services');
  assert.deepEqual(undocumented(vocab.ONE_TIME_ADDON_IDS), [], 'add-ons');
  assert.deepEqual(undocumented(vocab.CANCELLATION_EFFECTS), [], 'cancellation effects');
  for (const switchId of vocab.RELEASE_GATED_SWITCHES.filter((id) => !id.startsWith('emails.') || id === 'emails.preWorkshop.gate')) {
    assert.ok(docs.includes(`\`${switchId}\``), switchId);
  }
});

test('every blocking code has a fix row in the runbooks', () => {
  const missing = vocab.BLOCKING_CODES.filter((code) => !new RegExp(`^\\| \`${code}\` \\|[^|]+\\|[^|]+\\|`, 'm').test(runbooks));
  assert.deepEqual(missing, []);
});

test('every runbook has the symptom, the check and the fix', () => {
  const sections = runbooks.split(/^## /m).slice(1).filter((section) => !section.startsWith('Blocking codes'));
  assert.ok(sections.length >= 6, `expected at least 6 runbooks, found ${sections.length}`);
  for (const section of sections) {
    const title = section.split('\n')[0];
    for (const part of ['**Symptom.**', '**Check.**', '**Fix.**']) {
      assert.ok(section.includes(part), `${title}: missing ${part}`);
    }
    assert.match(section, /`(GET|PUT|POST|PATCH) \/api\/|`node scripts\/|`FORWARD_COMPAT_REF=/, `${title}: the check names an endpoint or a command`);
  }
});
