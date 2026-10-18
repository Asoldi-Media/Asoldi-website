import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultActionDateTimeLocal } from '../lib/action-datetime-input.js';

const now = Date.parse('2026-10-18T13:10:00.000Z');

test('an empty action time already has this year so the picker does not ask for it', () => {
  assert.equal(defaultActionDateTimeLocal('', now), '2026-10-18T15:10');
});

test('an existing action time keeps its own year and clock', () => {
  assert.equal(defaultActionDateTimeLocal('2027-01-15T10:00', now), '2027-01-15T10:00');
});
