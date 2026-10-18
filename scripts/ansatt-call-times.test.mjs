import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALL_TIMES_VIEWS,
  callTimesCopyHasRepNames,
  matchCallTimesIndividual,
} from '../lib/ansatt-call-times.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME_RE = /\b(b[åa]+rd|bhrat|alexander|gupta|fransson|kvalheim|farkas|both reps)\b/i;

test('all-reps vs individual match, never another named picker', () => {
  assert.equal(matchCallTimesIndividual({ name: 'Bård Ove' }), 'bard');
  assert.equal(matchCallTimesIndividual({ username: 'baard@asoldi.com' }), 'bard');
  assert.equal(matchCallTimesIndividual({ fromEmail: 'baard.fransson@gmail.com' }), 'bard');
  assert.equal(matchCallTimesIndividual({ name: 'Bhrat Gupta' }), 'bhrat');
  assert.equal(matchCallTimesIndividual({ username: 'bhrat@asoldi.com' }), 'bhrat');
  assert.equal(matchCallTimesIndividual({ name: 'Damian' }), null);
  assert.equal(matchCallTimesIndividual({ username: 'alexander@asoldi.com' }), null);
  assert.equal(matchCallTimesIndividual(null), null);
});

test('user-facing copy has no named reps or both-reps language', () => {
  for (const view of Object.values(CALL_TIMES_VIEWS)) {
    assert.equal(callTimesCopyHasRepNames(view), false, view.id);
    assert.match(view.blurb, /per 100/);
  }
  const ui = [
    'app/pages/ansatt/CallTimesSection.tsx',
    'app/pages/ansatt/AnsattAsoldiContent.tsx',
  ].map((rel) => readFileSync(join(root, rel), 'utf8')).join('\n');
  assert.match(ui, /All reps/);
  assert.match(ui, /Individual/);
  assert.doesNotMatch(ui, NAME_RE);
  assert.doesNotMatch(ui, /Both reps/i);
});

test('sales staff can stay on /ansatt', () => {
  const src = readFileSync(join(root, 'app/pages/Ansatt.tsx'), 'utf8');
  assert.doesNotMatch(src, /role === 'sales'[\s\S]{0,80}navigate\('\/sales'/);
});
