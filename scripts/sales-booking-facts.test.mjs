import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBookingFromLead, salesBookingFacts } from '../lib/sales-booking-facts.js';

test('booker name is read when MyPhoner stores the agent as a string', () => {
  const extracted = extractBookingFromLead({
    list_name: 'Asoldi',
    last_event: {
      kind: 'winner',
      created_at: '2026-09-20 08:15:00 UTC',
      user: 'Kari Agent',
      user_email: 'kari@asoldi.com',
    },
  });
  assert.equal(extracted.bookedByName, 'Kari Agent');
  assert.equal(extracted.bookedByEmail, 'kari@asoldi.com');
  assert.equal(extracted.listName, 'Asoldi');
  assert.ok(extracted.bookedAt);
});

test('booker name comes from first/last name on the winner user object', () => {
  const extracted = extractBookingFromLead({
    events: [
      {
        type: 'winner',
        created_at: '2026-09-21T10:00:00Z',
        user: { first_name: 'Lars', last_name: 'Selger', email: 'lars@asoldi.com' },
      },
    ],
  });
  assert.equal(extracted.bookedByName, 'Lars Selger');
  assert.equal(extracted.bookedByEmail, 'lars@asoldi.com');
});

test('sales card falls back to call email when the name is still empty', () => {
  const facts = salesBookingFacts({
    meetingAt: '2026-09-22T09:00:00.000Z',
    myphoner: {
      bookedByEmail: '',
      bookedByName: '',
      latestCallUserEmail: 'agent@asoldi.com',
      bookedAt: '2026-09-21T08:00:00.000Z',
      listName: 'Asoldi',
    },
  });
  assert.equal(facts.booker, 'agent@asoldi.com');
});
