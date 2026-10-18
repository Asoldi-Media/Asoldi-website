import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adminFocusCategoryFor,
  defaultAdminFocusCategory,
  groupAdminFocusQueues,
  normalizeAdminFocusCategory,
} from '../lib/admin-focus-board.js';

const NOW = Date.parse('2026-10-18T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function client(id, overrides = {}) {
  return { id, status: 'active', product: 'asoldi', businessName: id, ...overrides };
}

const held = (extra = {}) => ({ heldAt: iso(NOW - 5 * DAY), summary: { intro: 'x' }, ...extra });

test('each admin client lands in the tab for its current goal step', () => {
  assert.equal(adminFocusCategoryFor(client('a', { progression: { contractSigned: true } })), 'unbooked');
  assert.equal(adminFocusCategoryFor(client('b')), 'unlisted');
  assert.equal(adminFocusCategoryFor(client('c', { workshopAction: { dueAt: iso(NOW + DAY), format: 'mote' } })), 'workshop');
  assert.equal(adminFocusCategoryFor(client('d', { workshop: held() })), 'informasjon');
  assert.equal(adminFocusCategoryFor(client('e', { workshop: held({ informasjonAt: iso(NOW) }) })), 'iteration');
  assert.equal(
    adminFocusCategoryFor(client('f', { workshop: held({ informasjonAt: iso(NOW), iteratedAt: iso(NOW) }) })),
    'done',
  );
});

test('workshop tab puts late clients first, then the soonest, then untimed', () => {
  const queues = groupAdminFocusQueues([
    client('later', { workshopAction: { dueAt: iso(NOW + 3 * DAY), format: 'mote' } }),
    client('late', { workshopAction: { dueAt: iso(NOW - DAY), format: 'mote' } }),
    client('soon', { workshopAction: { dueAt: iso(NOW + DAY), format: 'mote' } }),
  ], NOW);
  assert.deepEqual(queues.workshop.map((row) => row.id), ['late', 'soon', 'later']);
  assert.equal(queues.workshop[0].overdue, true);
  assert.equal(defaultAdminFocusCategory(queues), 'workshop');
});

test('unbooked sorts by oldest signing; SSU, not-sold and inactive stay off the board', () => {
  const queues = groupAdminFocusQueues([
    client('new', { progression: { contractSigned: true }, contractSignedAt: iso(NOW - DAY) }),
    client('old', { progression: { contractSigned: true }, contractSignedAt: iso(NOW - 9 * DAY) }),
    client('ssu', { product: 'ssu', progression: { contractSigned: true } }),
    client('gone', { status: 'not-sold', progression: { contractSigned: true } }),
  ], NOW);
  assert.deepEqual(queues.unbooked.map((row) => row.id), ['old', 'new']);
  const total = Object.values(queues).reduce((sum, rows) => sum + rows.length, 0);
  assert.equal(total, 2);
  assert.equal(defaultAdminFocusCategory(queues), 'unbooked');
});

test('normalize keeps only known tabs', () => {
  assert.equal(normalizeAdminFocusCategory('iteration'), 'iteration');
  assert.equal(normalizeAdminFocusCategory('ranked'), '');
});
