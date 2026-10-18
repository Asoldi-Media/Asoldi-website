import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clientHasProductNotes,
  defaultSalesFocusCategory,
  getSalesPlaybook,
  groupSalesFocusQueues,
  normalizeSalesFocusCategory,
  salesCategoryClock,
  salesEntryNextDueMs,
  salesFixedRows,
  salesFocusEntries,
  salesGoalRowCounts,
  salesMissedMeeting,
} from '../lib/sales-playbook.js';

/** Thu 22 Oct 2026 14:00 Oslo (CEST). Påminnelse is Wed 21 Oct 09:00 Oslo = 07:00Z. */
const MEETING_AT = '2026-10-22T12:00:00.000Z';
const at = (iso) => Date.parse(iso);

function client(overrides = {}) {
  return {
    id: 'c1',
    product: 'asoldi',
    status: 'active',
    businessName: 'Test AS',
    contactPerson: 'Kari Nordmann',
    contactEmail: 'kari@example.com',
    contactPhone: '+4790000000',
    ownerId: 'sales:abc',
    agreedTime: true,
    meetingAt: MEETING_AT,
    meetingDurationMinutes: 60,
    nextActions: [],
    reminders: { thankYouSentAt: '2026-10-19T10:00:00.000Z' },
    ...overrides,
    progression: {
      meetingHeld: false,
      offerSent: false,
      contractSigned: false,
      paymentReceived: false,
      ...(overrides.progression || {}),
    },
  };
}

function categories(row, nowIso, options) {
  return salesFocusEntries(row, at(nowIso), options).map((entry) => `${entry.category}:${entry.stepId}:${entry.state}`);
}

const UPCOMING_MEETING = 'meetingsToday:readUp:upcoming';

test('påminnelse shows from the day before, red after 09:30 Oslo', () => {
  assert.deepEqual(categories(client(), '2026-10-20T12:00:00.000Z'), [UPCOMING_MEETING]);
  assert.deepEqual(categories(client(), '2026-10-21T06:00:00.000Z'), ['reminders:reminder:upcoming', UPCOMING_MEETING]);
  assert.deepEqual(categories(client(), '2026-10-21T07:10:00.000Z'), ['reminders:reminder:due', UPCOMING_MEETING]);
  assert.deepEqual(categories(client(), '2026-10-21T07:40:00.000Z'), ['reminders:reminder:overdue', UPCOMING_MEETING]);
});

test('a meeting booked after 09:00 says send now instead of red', () => {
  const late = client({
    nextActions: [{
      id: 'na-sms1h-c1',
      goalKey: 'meetingHeld',
      presetKey: 'sms1h',
      name: 'Påminnelse',
      format: 'sms',
      createdAt: '2026-10-21T10:00:00.000Z',
      relativeToMeetingHours: 24,
    }],
  });
  assert.deepEqual(categories(late, '2026-10-21T11:00:00.000Z'), ['reminders:reminder:sendNow', UPCOMING_MEETING]);
});

test('a sent påminnelse leaves Påminnelser; the meeting waits in Møter', () => {
  const sent = client({
    nextActions: [{
      id: 'na-sms1h-c1',
      goalKey: 'meetingHeld',
      presetKey: 'sms1h',
      name: 'Påminnelse',
      format: 'sms',
      doneAt: '2026-10-21T07:05:00.000Z',
      relativeToMeetingHours: 24,
    }],
  });
  assert.deepEqual(categories(sent, '2026-10-21T08:00:00.000Z'), [UPCOMING_MEETING]);
});

test('a forgotten påminnelse stays until the meeting starts, next to Møter', () => {
  assert.deepEqual(categories(client(), '2026-10-22T08:00:00.000Z'), [
    'reminders:reminder:overdue',
    'meetingsToday:readUp:due',
  ]);
  assert.deepEqual(categories(client(), '2026-10-22T12:30:00.000Z'), ['meetingsToday:holdMeeting:due']);
});

test('Møter: read up first, then hold, red once the meeting has ended unmarked', () => {
  const readUp = client({
    salesPlaybook: { readUpAt: '2026-10-22T08:30:00.000Z' },
    nextActions: [{ id: 'na-sms1h-c1', presetKey: 'sms1h', goalKey: 'meetingHeld', doneAt: '2026-10-21T07:05:00.000Z' }],
  });
  assert.deepEqual(categories(readUp, '2026-10-22T09:00:00.000Z'), ['meetingsToday:holdMeeting:upcoming']);
  assert.deepEqual(categories(readUp, '2026-10-22T13:30:00.000Z'), ['meetingsToday:holdMeeting:overdue']);
});

test('an unmarked meeting is still in Møter after 48 hours', () => {
  assert.deepEqual(categories(client(), '2026-10-24T13:00:00.000Z'), ['meetingsToday:holdMeeting:overdue']);
});

test('the goal chips decide the category', () => {
  const held = client({ progression: { meetingHeld: true } });
  assert.deepEqual(categories(held, '2026-10-22T14:00:00.000Z'), ['offer:sendOffer:due']);
  const sent = client({
    progression: { meetingHeld: true, offerSent: true },
    contractSentAt: '2026-10-23T10:00:00.000Z',
    nextActions: [{
      id: 'na-contract-checkup-c1',
      goalKey: 'offerSent',
      presetKey: 'contractCheckup',
      dueAt: '2026-10-24T10:00:00.000Z',
    }],
  });
  assert.deepEqual(categories(sent, '2026-10-23T12:00:00.000Z'), ['signature:checkup:upcoming']);
  assert.deepEqual(categories(sent, '2026-10-24T12:00:00.000Z'), ['signature:checkup:overdue']);
  const noCheckupRow = client({ progression: { meetingHeld: true, offerSent: true } });
  assert.deepEqual(categories(noCheckupRow, '2026-10-24T12:00:00.000Z'), ['signature:contractSigned:waiting']);
  const signed = client({ progression: { meetingHeld: true, offerSent: true, contractSigned: true } });
  assert.deepEqual(salesFocusEntries(signed, at('2026-10-24T12:00:00.000Z')).map((row) => row.category), ['won']);
});

test('Kontrakt signert moves the client from Venter signering to Solgt', () => {
  const sent = client({ progression: { meetingHeld: true, offerSent: true }, contractSentAt: '2026-10-23T10:00:00.000Z' });
  assert.deepEqual(categories(sent, '2026-10-25T12:00:00.000Z'), ['signature:signatureFollowUp:upcoming']);
  const entries = salesFocusEntries(sent, at('2026-10-25T12:00:00.000Z'));
  assert.equal(entries[0].focusRowId, 'na-signoppfolging-c1-1');
  assert.equal(entries[0].dueAt, '2026-10-26T10:00:00.000Z');
  const signed = client({
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
    contractSignedAt: '2026-10-25T12:00:00.000Z',
  });
  const [won] = salesFocusEntries(signed, at('2026-10-25T13:00:00.000Z'));
  assert.equal(won.category, 'won');
  assert.equal(won.focusRowId, 'na-oppfolging1mnd-c1');
});

test('Solgt is ordered by the next after-sale action; done cards get a 3-month checkup', () => {
  const now = at('2026-11-30T12:00:00.000Z');
  const progression = { meetingHeld: true, offerSent: true, contractSigned: true };
  const followUp = (id, dueAt) => [{ id: `na-oppfolging1mnd-${id}`, presetKey: 'oppfolging1mnd', goalKey: 'afterSale', dueAt }];
  const soon = client({ id: 'soon', businessName: 'Snart', progression, nextActions: followUp('soon', '2026-11-25T12:00:00.000Z') });
  const later = client({ id: 'later', businessName: 'Senere', progression, nextActions: followUp('later', '2026-12-20T12:00:00.000Z') });
  const nothing = client({
    id: 'nothing',
    businessName: 'Ferdig',
    progression,
    contractSignedAt: '2026-10-01T12:00:00.000Z',
    nextActions: [{ id: 'na-oppfolging1mnd-nothing', presetKey: 'oppfolging1mnd', goalKey: 'afterSale', doneAt: '2026-11-01T10:00:00.000Z' }],
  });
  const queues = groupSalesFocusQueues([nothing, later, soon], now);
  assert.deepEqual(queues.won.map((row) => row.client.id), ['soon', 'later', 'nothing']);
  assert.equal(queues.won[0].overdue, true);
  assert.equal(queues.won[2].state, 'upcoming');
  assert.equal(queues.won[2].focusRowId, 'na-checkup3mnd-nothing-1');
  assert.equal(queues.won[2].dueAt, '2027-01-30T10:00:00.000Z');
});

test('Tildel selger is admin only and the client moves on once a seller is set', () => {
  const now = '2026-10-21T08:00:00.000Z';
  const unassigned = client({ ownerId: 'admin', reminders: {} });
  assert.deepEqual(categories(unassigned, now, { isAdmin: true }), ['assign:assign:due']);
  assert.equal(categories(unassigned, now).some((row) => row.startsWith('assign')), false);
  const assigned = client({ reminders: {} });
  assert.equal(categories(assigned, now, { isAdmin: true })[0], 'confirm:confirmation:due');
  assert.equal(normalizeSalesFocusCategory('assign'), '');
  assert.equal(normalizeSalesFocusCategory('assign', { isAdmin: true }), 'assign');
});

test('a booked but unconfirmed meeting waits in Venter møtebekreftelse, red after an hour', () => {
  const booked = client({ reminders: {}, myphoner: { bookedAt: '2026-10-20T10:00:00.000Z' } });
  assert.deepEqual(categories(booked, '2026-10-20T10:30:00.000Z'), ['confirm:confirmation:due', UPCOMING_MEETING]);
  assert.deepEqual(categories(booked, '2026-10-20T11:30:00.000Z'), ['confirm:confirmation:overdue', UPCOMING_MEETING]);
  const [row] = salesFocusEntries(booked, at('2026-10-20T11:30:00.000Z'));
  assert.equal(row.focusRowId, 'fixed:confirmation');
  assert.deepEqual(categories(booked, '2026-10-21T07:10:00.000Z'), ['confirm:confirmation:overdue', 'reminders:reminder:due', UPCOMING_MEETING]);
  assert.deepEqual(categories(booked, '2026-10-25T13:00:00.000Z'), ['confirm:missedCall:upcoming']);
});

test('not-sold clients stay out of every category, even for admins and after a win', () => {
  const now = '2026-10-22T08:00:00.000Z';
  assert.deepEqual(categories(client({ status: 'not-sold', ownerId: 'admin' }), now, { isAdmin: true }), []);
  assert.deepEqual(categories(client({ status: 'not-sold', progression: { meetingHeld: true, offerSent: true, contractSigned: true } }), now), []);
});

test('Sekundær clients follow the same flow as active clients', () => {
  for (const now of ['2026-10-20T08:00:00.000Z', '2026-10-22T08:00:00.000Z', '2026-10-24T08:00:00.000Z']) {
    const active = categories(client({}), now);
    assert.ok(active.length > 0);
    assert.deepEqual(categories(client({ status: 'secondary' }), now), active);
  }
  const held = { progression: { meetingHeld: true } };
  assert.deepEqual(categories(client({ ...held, status: 'secondary' }), '2026-10-24T08:00:00.000Z'), categories(client(held), '2026-10-24T08:00:00.000Z'));
});

test('fixed rows sit in their goal and the counts include stored rows', () => {
  const now = at('2026-10-21T08:00:00.000Z');
  const fresh = client({
    reminders: {},
    nextActions: [{ id: 'na-sms1h-c1', presetKey: 'sms1h', goalKey: 'meetingHeld', doneAt: '2026-10-21T07:05:00.000Z' }],
  });
  const rows = salesFixedRows(fresh, now);
  assert.deepEqual(rows.map((row) => `${row.goalKey}:${row.id}:${row.placement}`), [
    'meetingHeld:fixed:confirmation:start',
    'meetingHeld:fixed:readUp:beforeMeeting',
    'offerSent:fixed:productNotes:end',
    'offerSent:fixed:sendOffer:end',
    'contractSigned:fixed:contractSigned:end',
  ]);
  const counts = salesGoalRowCounts(fresh, now);
  assert.deepEqual(counts.meetingHeld, { done: 1, total: 4 });
  assert.deepEqual(counts.offerSent, { done: 0, total: 2 });
  assert.deepEqual(counts.contractSigned, { done: 0, total: 1 });
  const readUp = client({ salesPlaybook: { readUpAt: '2026-10-21T07:30:00.000Z' } });
  assert.deepEqual(salesGoalRowCounts(readUp, now).meetingHeld, { done: 2, total: 4 });
});

test('after the checkup, Venter signering follows up every 3 days', () => {
  const checked = client({
    progression: { meetingHeld: true, offerSent: true },
    contractSentAt: '2026-10-23T10:00:00.000Z',
    nextActions: [{
      id: 'na-contract-checkup-c1',
      goalKey: 'offerSent',
      presetKey: 'contractCheckup',
      dueAt: '2026-10-24T10:00:00.000Z',
      doneAt: '2026-10-24T10:05:00.000Z',
    }],
  });
  assert.deepEqual(categories(checked, '2026-10-25T12:00:00.000Z'), ['signature:signatureFollowUp:upcoming']);
  assert.deepEqual(categories(checked, '2026-10-27T11:00:00.000Z'), ['signature:signatureFollowUp:overdue']);
  const followedUp = client({
    ...checked,
    nextActions: [
      ...checked.nextActions,
      { id: 'na-signoppfolging-c1-1', goalKey: 'contractSigned', presetKey: 'signatureFollowUp', dueAt: '2026-10-27T10:05:00.000Z', doneAt: '2026-10-27T11:00:00.000Z' },
    ],
  });
  const [next] = salesFocusEntries(followedUp, at('2026-10-27T12:00:00.000Z'));
  assert.equal(next.focusRowId, 'na-signoppfolging-c1-2');
  assert.equal(next.dueAt, '2026-10-30T11:00:00.000Z');
});

test('SSU and not-sold are off the board; no meeting time waits on the Møte row', () => {
  const now = '2026-10-22T08:00:00.000Z';
  assert.deepEqual(categories(client({ product: 'ssu' }), now), []);
  assert.deepEqual(categories(client({ status: 'not-sold' }), now), []);
  const noTime = client({ agreedTime: false, meetingAt: '', myphoner: { bookedAt: '2026-10-22T07:30:00.000Z' } });
  assert.deepEqual(categories(noTime, now), ['confirm:holdMeeting:due']);
  assert.deepEqual(categories(noTime, '2026-10-22T08:31:00.000Z'), ['confirm:holdMeeting:overdue']);
});

test('Møter lists every upcoming meeting; Klargjør tilbud is due 24 hours after the meeting', () => {
  assert.deepEqual(categories(client({ meetingAt: '2026-10-29T12:00:00.000Z' }), '2026-10-22T08:00:00.000Z'), [UPCOMING_MEETING]);
  const held = client({ progression: { meetingHeld: true } });
  const [offer] = salesFocusEntries(held, at('2026-10-22T14:00:00.000Z'));
  assert.equal(`${offer.category}:${offer.state}`, 'offer:due');
  assert.equal(offer.dueAt, '2026-10-23T12:00:00.000Z');
  assert.equal(salesFocusEntries(held, at('2026-10-23T12:30:00.000Z'))[0].state, 'overdue');
});

test('queues put red first, then the soonest', () => {
  const now = at('2026-10-21T08:00:00.000Z');
  const tomorrowLate = client({ id: 'late', businessName: 'Sen', meetingAt: '2026-10-22T15:00:00.000Z' });
  const tomorrowEarly = client({ id: 'early', businessName: 'Tidlig', meetingAt: '2026-10-22T07:00:00.000Z' });
  const booked = client({
    id: 'booked',
    businessName: 'Nybooket',
    meetingAt: '2026-10-22T09:00:00.000Z',
    nextActions: [{
      id: 'na-sms1h-booked',
      goalKey: 'meetingHeld',
      presetKey: 'sms1h',
      createdAt: '2026-10-21T07:50:00.000Z',
      relativeToMeetingHours: 24,
    }],
  });
  const queues = groupSalesFocusQueues([tomorrowLate, booked, tomorrowEarly], now);
  assert.equal(queues.reminders.length, 3);
  assert.equal(queues.reminders.every((row) => row.overdue), false);
  assert.equal(queues.reminders.filter((row) => row.overdue).length, 2);
  assert.equal(queues.reminders[2].client.id, 'booked');
  assert.equal(defaultSalesFocusCategory(queues), 'reminders');
  assert.equal(defaultSalesFocusCategory({ reminders: [], meetingsToday: [], offer: [{ overdue: false }], signature: [] }), 'offer');
});

test('playbook lists the fixed steps per goal and marks the current goal', () => {
  const playbook = getSalesPlaybook(client({ reminders: {} }), at('2026-10-21T08:00:00.000Z'));
  assert.deepEqual(playbook.goals.map((goal) => goal.key), ['meetingHeld', 'offerSent', 'contractSigned']);
  assert.deepEqual(playbook.goals[0].steps.map((step) => step.id), ['confirmation', 'reminder', 'readUp', 'holdMeeting']);
  assert.deepEqual(playbook.goals[1].steps.map((step) => step.id), ['productNotes', 'sendOffer']);
  assert.deepEqual(playbook.goals[2].steps.map((step) => step.id), ['checkup', 'contractSigned']);
  assert.equal(playbook.currentGoalKey, 'meetingHeld');
  assert.equal(playbook.goals[0].steps[0].state, 'due');
  const confirmed = getSalesPlaybook(client({ reminders: { thankYouSentAt: '2026-10-20T10:00:00.000Z' } }));
  assert.equal(confirmed.goals[0].steps[0].done, true);
});

test('product notes count once the rep wrote anything for the offer', () => {
  assert.equal(clientHasProductNotes(client()), false);
  assert.equal(clientHasProductNotes(client({ details: { meetingQuote: { tierId: 'starter' } } })), false);
  assert.equal(clientHasProductNotes(client({ details: { meetingQuote: { productNotes: 'Nettbutikk' } } })), true);
  assert.equal(clientHasProductNotes(client({ details: { meetingQuote: { selected: ['seo'] } } })), true);
});

test('category ids from the URL are checked', () => {
  assert.equal(normalizeSalesFocusCategory('offer'), 'offer');
  assert.equal(normalizeSalesFocusCategory('nope'), '');
});

test('category clock: Møter counts down to the next meeting that has not started', () => {
  const second = client({ id: 'c2', meetingAt: '2026-10-22T14:00:00.000Z' });
  const nowMs = at('2026-10-22T12:30:00.000Z');
  const queues = groupSalesFocusQueues([client(), second], nowMs);
  assert.deepEqual(salesCategoryClock(queues.meetingsToday, 'meetingsToday', nowMs), {
    kind: 'until',
    atMs: at('2026-10-22T14:00:00.000Z'),
  });
});

test('category clock: late items win, else the next time, else nothing', () => {
  const reminderMs = at('2026-10-21T07:00:00.000Z');
  const early = groupSalesFocusQueues([client()], at('2026-10-21T06:00:00.000Z'));
  assert.deepEqual(salesCategoryClock(early.reminders, 'reminders', at('2026-10-21T06:00:00.000Z')), { kind: 'at', atMs: reminderMs });
  const late = groupSalesFocusQueues([client()], at('2026-10-21T08:00:00.000Z'));
  assert.deepEqual(salesCategoryClock(late.reminders, 'reminders', at('2026-10-21T08:00:00.000Z')), { kind: 'late', atMs: reminderMs });
  assert.equal(salesCategoryClock([], 'offer', at('2026-10-21T08:00:00.000Z')), null);
});

test('entry next due falls back to the earliest open action of the current goal', () => {
  const held = client({
    progression: { meetingHeld: true },
    nextActions: [
      { id: 'a1', goalKey: 'offerSent', presetKey: 'custom', name: 'Ring', format: 'ring', dueAt: '2026-10-24T08:00:00.000Z' },
      { id: 'a2', goalKey: 'offerSent', presetKey: 'custom', name: 'SMS', format: 'sms', dueAt: '2026-10-23T08:00:00.000Z' },
    ],
  });
  const [offer] = salesFocusEntries(held, at('2026-10-22T13:30:00.000Z'));
  assert.equal(offer.category, 'offer');
  assert.equal(salesEntryNextDueMs(offer), at('2026-10-23T08:00:00.000Z'));
});

test('an unmarked meeting stays in Møter for 72 hours, then waits for a new time', () => {
  assert.deepEqual(categories(client(), '2026-10-25T11:00:00.000Z'), ['meetingsToday:holdMeeting:overdue']);
  const moved = salesFocusEntries(client(), at('2026-10-25T13:00:00.000Z'));
  assert.deepEqual(moved.map((row) => `${row.category}:${row.stepId}:${row.state}`), ['confirm:missedCall:upcoming']);
  // 72 h after Thu 14:00 is Sun 25 Oct; the call is Mon 26 Oct 10:00 Oslo (CET after the clock change).
  assert.equal(moved[0].dueAt, '2026-10-26T09:00:00.000Z');
  assert.equal(salesMissedMeeting(client(), at('2026-10-25T13:00:00.000Z')).kind, 'auto');
  assert.deepEqual(categories(client(), '2026-10-26T09:40:00.000Z'), ['confirm:missedCall:overdue']);
});

const skipped = (overrides = {}) => client({
  salesPlaybook: { readUpAt: '', missedKind: 'skipped', missedAt: '2026-10-21T08:00:00.000Z', missedMeetingAt: MEETING_AT, missedCalledAt: '', ...overrides },
});

test('Skip moves the client to Venter møtebekreftelse with a call 10:00 the next day', () => {
  const [row] = salesFocusEntries(skipped(), at('2026-10-21T08:10:00.000Z'));
  assert.equal(`${row.category}:${row.stepId}:${row.state}`, 'confirm:missedCall:upcoming');
  assert.equal(row.dueAt, '2026-10-22T08:00:00.000Z');
  assert.equal(salesMissedMeeting(skipped(), at('2026-10-21T08:10:00.000Z')).label, 'Hoppet over');
  const noShow = skipped({ missedKind: 'noShow' });
  assert.equal(salesMissedMeeting(noShow, at('2026-10-21T08:10:00.000Z')).label, 'Møtte ikke opp');
  assert.ok(salesFixedRows(skipped(), at('2026-10-21T08:10:00.000Z')).some((fixed) => fixed.stepId === 'missedCall' && !fixed.done));
});

test('after the call, ring again 10:00 two days later; a new meeting time or a held meeting ends it', () => {
  const called = skipped({ missedCalledAt: '2026-10-22T08:05:00.000Z' });
  const [waiting] = salesFocusEntries(called, at('2026-10-22T09:00:00.000Z'));
  assert.equal(`${waiting.category}:${waiting.stepId}:${waiting.state}`, 'confirm:missedCall:upcoming');
  assert.equal(waiting.dueAt, '2026-10-24T08:00:00.000Z');
  assert.ok(salesFixedRows(called, at('2026-10-22T09:00:00.000Z')).some((row) => row.stepId === 'missedCall' && row.done));
  assert.deepEqual(categories(called, '2026-10-24T08:40:00.000Z'), ['confirm:missedCall:overdue']);
  assert.ok(salesFixedRows(called, at('2026-10-24T08:40:00.000Z')).some((row) => row.stepId === 'missedCall' && !row.done));
  const moved = { ...skipped(), meetingAt: '2026-10-29T12:00:00.000Z' };
  assert.equal(salesMissedMeeting(moved, at('2026-10-22T09:00:00.000Z')), null);
  assert.deepEqual(categories(moved, '2026-10-22T09:00:00.000Z'), [UPCOMING_MEETING]);
  const held = client({ ...skipped(), progression: { meetingHeld: true } });
  assert.equal(salesMissedMeeting(held, at('2026-10-22T09:00:00.000Z')), null);
});

test('the 72-hour rule leaves meetings before 17 Oct 2026 alone', () => {
  const old = client({ meetingAt: '2026-10-16T10:00:00.000Z' });
  assert.equal(salesMissedMeeting(old, at('2026-10-21T10:00:00.000Z')), null);
  assert.deepEqual(categories(old, '2026-10-21T10:00:00.000Z'), []);
  const oldSkipped = client({
    meetingAt: '2026-10-16T10:00:00.000Z',
    salesPlaybook: { readUpAt: '', missedKind: 'skipped', missedAt: '2026-10-17T08:00:00.000Z', missedMeetingAt: '2026-10-16T10:00:00.000Z', missedCalledAt: '' },
  });
  assert.equal(salesMissedMeeting(oldSkipped, at('2026-10-21T10:00:00.000Z')).kind, 'skipped');
});
