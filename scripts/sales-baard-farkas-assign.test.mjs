import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BAARD_BOOKER_EMAIL_HASHES,
  bookerEmailHash,
  isBaardBookerEmail,
  baardFarkasCutoffMs,
  baardFarkasPatchEntries,
  findAlexanderSalesUser,
  isBaardLeadBeforeCutoff,
  planBaardFarkasReassign,
} from '../lib/sales-baard-farkas-assign.js';

// A made-up booker address: the source holds only the real one's hash.
const BAARD_BOOKER_EMAIL = 'booker.one@example.test';
BAARD_BOOKER_EMAIL_HASHES.add(bookerEmailHash(BAARD_BOOKER_EMAIL));

const cutoff = baardFarkasCutoffMs('2026-08-11');

function client(overrides = {}) {
  return {
    id: 'c1',
    businessName: 'Test AS',
    ownerId: 'sales:other',
    createdAt: '2026-07-01T10:00:00.000Z',
    myphoner: {
      bookedByEmail: BAARD_BOOKER_EMAIL,
      bookedByName: 'Bård Fransson',
      bookedAt: '2026-08-10T12:00:00.000Z',
    },
    ...overrides,
    myphoner: {
      bookedByEmail: BAARD_BOOKER_EMAIL,
      bookedByName: 'Bård Fransson',
      bookedAt: '2026-08-10T12:00:00.000Z',
      ...(overrides.myphoner || {}),
    },
  };
}

const users = [
  { id: 'alex-1', username: 'alexander@asoldi.com', name: 'Alexander Farkas', role: 'sales' },
  { id: 'dam-1', username: 'damian@asoldi.com', name: 'Damian', role: 'sales' },
];

test('cutoff is midnight 11 Aug 2026 in Oslo', () => {
  assert.equal(new Date(cutoff).toISOString(), '2026-08-10T22:00:00.000Z');
});

test('Bård lead before 11.08 stays in, same-day and later are out', () => {
  assert.equal(isBaardLeadBeforeCutoff(client({ myphoner: { bookedAt: '2026-08-10T21:59:00.000Z' } }), cutoff), true);
  assert.equal(isBaardLeadBeforeCutoff(client({ myphoner: { bookedAt: '2026-08-10T22:00:00.000Z' } }), cutoff), false);
  assert.equal(isBaardLeadBeforeCutoff(client({
    myphoner: { bookedByEmail: 'other@nettle.test', bookedAt: '2026-07-01T12:00:00.000Z' },
  }), cutoff), false);
});

test('Alexander is resolved from admin sales users', () => {
  const user = findAlexanderSalesUser(users);
  assert.equal(user.id, 'alex-1');
});

test('plan moves Bård-before-cutoff to Alexander and other Alexander leads to Damian', () => {
  const plan = planBaardFarkasReassign([
    client({ id: 'keep', ownerId: 'sales:other' }),
    client({
      id: 'already',
      ownerId: 'sales:alex-1',
      myphoner: { bookedAt: '2026-07-01T10:00:00.000Z' },
    }),
    client({
      id: 'too-late',
      ownerId: 'sales:alex-1',
      myphoner: { bookedAt: '2026-08-12T10:00:00.000Z' },
    }),
    client({
      id: 'not-baard',
      ownerId: 'sales:alex-1',
      myphoner: { bookedByEmail: 'someone@nettle.test', bookedByName: 'Kari', bookedAt: '2026-07-01T10:00:00.000Z' },
    }),
  ], users, cutoff);
  assert.equal(plan.error, undefined);
  assert.equal(plan.alexander.ownerKey, 'sales:alex-1');
  assert.equal(plan.damianOwnerKey, 'sales:dam-1');
  assert.deepEqual(plan.toAlexander.map((row) => row.id), ['keep']);
  assert.deepEqual(plan.toDamian.map((row) => row.id).sort(), ['not-baard', 'too-late']);
  assert.equal(baardFarkasPatchEntries(plan).length, 3);
});

test('the booker address is matched by hash: a listed address matches in any case, others do not, and the source keeps no address', async () => {
  assert.equal(isBaardBookerEmail(BAARD_BOOKER_EMAIL), true);
  assert.equal(isBaardBookerEmail('  Booker.One@Example.TEST '), true);
  assert.equal(isBaardBookerEmail('booker.two@example.test'), false);
  assert.equal(isBaardBookerEmail(''), false);
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../lib/sales-baard-farkas-assign.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /[w.+-]+@(?!asoldi.com)[w-]+.[a-z]{2,}/i, 'no personal address in the source');
});
