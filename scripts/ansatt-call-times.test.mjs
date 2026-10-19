import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALL_TIMES_VIEWS,
  callTimesCopyHasRepNames,
  callTimesCopyHasVolume,
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

test('user-facing copy has no named reps, both-reps language, or volume', () => {
  for (const view of Object.values(CALL_TIMES_VIEWS)) {
    assert.equal(callTimesCopyHasRepNames(view), false, view.id);
    assert.equal(callTimesCopyHasVolume(view), false, callTimesCopyHasVolume(view) ? view.id : view.id);
    assert.match(view.blurb, /per 100/);
  }
  const ui = [
    'app/pages/ansatt/CallTimesSection.tsx',
    'app/pages/ansatt/AnsattAsoldiContent.tsx',
    'app/pages/Ansatt.tsx',
  ].map((rel) => readFileSync(join(root, rel), 'utf8')).join('\n');
  assert.match(ui, /All reps/);
  assert.match(ui, /Individual/);
  assert.doesNotMatch(ui, NAME_RE);
  assert.doesNotMatch(ui, /Both reps/i);
  assert.doesNotMatch(ui, /view\.wins|view\.calls|Meetings booked/);
});

test('booker page is /møte-booker and sales can stay', () => {
  const pathFile = readFileSync(join(root, 'app/pages/ansatt/path.ts'), 'utf8');
  assert.match(pathFile, /export const BOOKER_PATH = '\/møte-booker'/);
  const src = readFileSync(join(root, 'app/pages/Ansatt.tsx'), 'utf8');
  assert.doesNotMatch(src, /role === 'sales'[\s\S]{0,80}navigate\('\/sales'/);
  const app = readFileSync(join(root, 'app/App.tsx'), 'utf8');
  assert.match(app, /path="\/møte-booker"/);
  assert.match(app, /path="\/ansatt"[^>]+Navigate to=\{BOOKER_PATH\}/);
});
