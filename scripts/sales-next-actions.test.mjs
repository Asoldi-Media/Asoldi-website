import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyNextActionMutation,
  applyProgressionChange,
  applyMeetingHeldOrphanReset,
  classifyNextActionBucket,
  classifySalesPipelineState,
  countSalesPipelineStates,
  decorateNextActions,
  defaultAddToCalendar,
  getActiveNextAction,
  getCalendarNextAction,
  getClientNextActionMs,
  getCurrentGoalKey,
  getFutureGoalKeys,
  getRemainingGoalCount,
  getVisibleGoalKeys,
  groupSalesClientsByNextAction,
  inferMeetingHeld,
  isAutoOfferCheckIn,
  nextDayAtNineAmIso,
  OFFER_CHECKIN_NAME,
  clientHasAssignedSalesRep,
  clientNeedsConfirmationSend,
  salesProgressBlockedReason,
  suggestedDueAtForPreset,
} from '../lib/sales-next-actions.js';

const HOUR_MS = 60 * 60 * 1000;
const MEETING_AT = '2026-09-20T14:00:00.000Z';

function client(overrides = {}) {
  return {
    id: 'c1',
    product: 'asoldi',
    businessName: 'Test AS',
    agreedTime: true,
    meetingAt: MEETING_AT,
    progression: {
      meetingHeld: false,
      offerSent: false,
      contractSigned: false,
      paymentReceived: false,
    },
    nextActions: [],
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

test('booking a meeting does not mark møtet hatt', () => {
  assert.equal(inferMeetingHeld({}), false);
  const decorated = decorateNextActions(client());
  assert.equal(decorated.some((action) => action.presetKey === 'meeting' && !action.doneAt), true);
  assert.equal(getCurrentGoalKey(client()), 'meetingHeld');
});

test('møtet hatt is inferred only after later goals already happened', () => {
  assert.equal(inferMeetingHeld({ offerSent: true }), true);
  assert.equal(inferMeetingHeld({ meetingHeld: false, offerSent: true }), false);
});

test('SMS 24h and Call 2h sit exactly before the meeting', () => {
  const row = client();
  const sms = suggestedDueAtForPreset('sms24h', row);
  const call = suggestedDueAtForPreset('call2h', row);
  assert.equal(Date.parse(sms), Date.parse(MEETING_AT) - 24 * HOUR_MS);
  assert.equal(Date.parse(call), Date.parse(MEETING_AT) - 2 * HOUR_MS);
});

test('send tilbud defaults to one hour from now', () => {
  const now = Date.parse('2026-09-17T10:00:00.000Z');
  const due = suggestedDueAtForPreset('sendOffer', client(), now);
  assert.equal(Date.parse(due), now + HOUR_MS);
});

test('creating SMS 24h keeps it tied to meeting time until edited', () => {
  const created = applyNextActionMutation(client(), {
    op: 'create',
    goalKey: 'meetingHeld',
    presetKey: 'sms24h',
    name: 'SMS 24h',
    dueAt: suggestedDueAtForPreset('sms24h', client()),
  });
  assert.equal(created.error, undefined);
  const sms = created.nextActions.find((action) => action.presetKey === 'sms24h');
  assert.equal(sms.relativeToMeetingHours, 24);
  const movedMeeting = decorateNextActions({
    ...client({ meetingAt: '2026-09-21T14:00:00.000Z' }),
    nextActions: created.nextActions,
  });
  const movedSms = movedMeeting.find((action) => action.presetKey === 'sms24h');
  assert.equal(Date.parse(movedSms.dueAt), Date.parse('2026-09-21T14:00:00.000Z') - 24 * HOUR_MS);
});

test('editing a sub-step time stops following the meeting', () => {
  const created = applyNextActionMutation(client(), {
    op: 'create',
    goalKey: 'meetingHeld',
    presetKey: 'sms24h',
    name: 'SMS 24h',
    dueAt: suggestedDueAtForPreset('sms24h', client()),
  });
  const sms = created.nextActions.find((action) => action.presetKey === 'sms24h');
  const customDue = '2026-09-18T09:00:00.000Z';
  const updated = applyNextActionMutation(
    { ...client(), nextActions: created.nextActions },
    { op: 'update', id: sms.id, name: sms.name, dueAt: customDue }
  );
  const after = updated.nextActions.find((action) => action.id === sms.id);
  assert.equal(after.relativeToMeetingHours, null);
  assert.equal(after.dueAt, customDue);
});

test('next action ranks the client, not raw meeting time', () => {
  const withSms = applyNextActionMutation(client(), {
    op: 'create',
    goalKey: 'meetingHeld',
    presetKey: 'sms24h',
    name: 'SMS 24h',
    dueAt: suggestedDueAtForPreset('sms24h', client()),
  });
  const ranked = { ...client(), nextActions: withSms.nextActions };
  const active = getActiveNextAction(ranked);
  assert.equal(active.presetKey, 'sms24h');
  assert.equal(getClientNextActionMs(ranked), Date.parse(MEETING_AT) - 24 * HOUR_MS);
});

test('recent overdue stays above upcoming for 48 hours, then drops to past due', () => {
  const now = Date.parse('2026-09-17T12:00:00.000Z');
  const upcomingClient = client({
    id: 'up',
    businessName: 'Upcoming',
    meetingAt: '2026-09-18T12:00:00.000Z',
  });
  const recentClient = client({
    id: 'recent',
    businessName: 'Recent overdue',
    meetingAt: '2026-09-17T10:00:00.000Z',
  });
  const overdueClient = client({
    id: 'late',
    businessName: 'Overdue',
    meetingAt: '2026-09-14T12:00:00.000Z',
  });
  const unsetClient = client({
    id: 'none',
    businessName: 'No date',
    agreedTime: false,
    meetingAt: '',
  });
  const grouped = groupSalesClientsByNextAction(
    [unsetClient, overdueClient, recentClient, upcomingClient].map((row) => ({ ...row, nextActions: decorateNextActions(row) })),
    now
  );
  assert.deepEqual(grouped.recentPastDue.map((row) => row.id), ['recent']);
  assert.deepEqual(grouped.upcoming.map((row) => row.id), ['up']);
  assert.deepEqual(grouped.pastDue.map((row) => row.id), ['late']);
  assert.deepEqual(grouped.noNextAction.map((row) => row.id), ['none']);
  assert.equal(classifyNextActionBucket(unsetClient, now), 'noNextAction');
});

test('meeting and offer follow-up reminders default onto Google Calendar', () => {
  assert.equal(defaultAddToCalendar('meeting', client()), true);
  assert.equal(defaultAddToCalendar('sms24h', client()), false);
  assert.equal(defaultAddToCalendar('checkIn', client()), false);
  assert.equal(defaultAddToCalendar('checkIn', client({ progression: { offerSent: true } })), true);
  const afterMeeting = client({ progression: { meetingHeld: true } });
  const checkIn = applyNextActionMutation(afterMeeting, {
    op: 'create',
    goalKey: 'offerSent',
    presetKey: 'checkIn',
    name: 'Oppsjekk',
    dueAt: '2026-09-18T10:00:00.000Z',
    addToCalendar: true,
  });
  assert.equal(checkIn.error, undefined);
  const created = checkIn.nextActions.find((action) => action.presetKey === 'checkIn');
  assert.equal(created.addToCalendar, true);
});

test('future goals stay hidden until the current checkpoint is done', () => {
  const row = client();
  assert.deepEqual(getVisibleGoalKeys(row), ['meetingHeld']);
  assert.equal(getRemainingGoalCount(row), 2);
  const held = applyProgressionChange(row, 'meetingHeld', true);
  const after = { ...row, progression: held.progression, nextActions: held.nextActions };
  assert.deepEqual(getVisibleGoalKeys(after), ['meetingHeld', 'offerSent']);
  assert.equal(getCurrentGoalKey(after), 'offerSent');
  assert.equal(getRemainingGoalCount(after), 1);
});

test('offer and contract cannot skip møtet hatt without fast track', () => {
  const row = client();
  assert.match(salesProgressBlockedReason(row, 'offerSent'), /møtet hatt/i);
  assert.match(salesProgressBlockedReason(row, 'contractSigned'), /møtet hatt/i);
  assert.equal(salesProgressBlockedReason(row, 'contractSigned', { fastTrack: true }), '');
});

test('kontrakt signert is blocked until sendt tilbud', () => {
  const row = client({ progression: { meetingHeld: true, offerSent: false } });
  assert.match(salesProgressBlockedReason(row, 'contractSigned'), /sendt tilbud/i);
});

test('fast track marks later goals done and opens contract', () => {
  const row = client();
  const result = applyProgressionChange(row, 'contractSigned', true, { fastTrack: true });
  assert.equal(result.error, undefined);
  assert.equal(result.progression.meetingHeld, true);
  assert.equal(result.progression.offerSent, true);
  assert.equal(result.progression.contractSigned, true);
  assert.equal(getCurrentGoalKey({ ...row, progression: result.progression }), '');
});

test('creating a next action requires name, time, and confirm payload', () => {
  const missingName = applyNextActionMutation(client(), {
    op: 'create',
    goalKey: 'meetingHeld',
    presetKey: 'custom',
    name: '',
    dueAt: '2026-09-18T10:00:00.000Z',
  });
  assert.match(missingName.error, /Navn/);
  const missingTime = applyNextActionMutation(client(), {
    op: 'create',
    goalKey: 'meetingHeld',
    presetKey: 'custom',
    name: 'Ring igjen',
    dueAt: '',
  });
  assert.match(missingTime.error, /Tid/);
});

test('creating a next action replaces the previous one and ranks by the new time', () => {
  const now = Date.parse('2026-09-19T10:00:00.000Z');
  const pastMeeting = client({
    meetingAt: '2026-09-10T10:00:00.000Z',
  });
  const decorated = decorateNextActions(pastMeeting);
  assert.equal(classifyNextActionBucket({ ...pastMeeting, nextActions: decorated }, now), 'pastDue');
  const replaced = applyNextActionMutation(
    { ...pastMeeting, nextActions: decorated },
    {
      op: 'create',
      goalKey: 'meetingHeld',
      presetKey: 'custom',
      name: 'Ring',
      dueAt: '2026-09-21T09:00:00.000Z',
    },
    now
  );
  assert.equal(replaced.error, undefined);
  assert.equal(replaced.nextActions.some((action) => action.name === 'Ring' && !action.doneAt), true);
  assert.equal(replaced.nextActions.some((action) => action.presetKey === 'meeting' && !action.doneAt), true);
  const ranked = { ...pastMeeting, nextActions: replaced.nextActions };
  assert.equal(getActiveNextAction(ranked).presetKey, 'sms1h');
  assert.equal(classifyNextActionBucket(ranked, now), 'pastDue');
});

test('sold website clients are wins, not action-list rows', () => {
  const sold = client({
    id: 'win',
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
  });
  const grouped = groupSalesClientsByNextAction([sold]);
  assert.equal(grouped.upcoming.length + grouped.recentPastDue.length + grouped.pastDue.length + grouped.noNextAction.length, 0);
});

test('orphan møtet hatt is cleared unless a later goal is already done', () => {
  const orphan = applyMeetingHeldOrphanReset(client({
    progression: { meetingHeld: true, offerSent: false, contractSigned: false },
  }));
  assert.equal(orphan.progression.meetingHeld, false);
  assert.equal(orphan.changed, true);
  const kept = applyMeetingHeldOrphanReset(client({
    progression: { meetingHeld: true, offerSent: true },
    salesMigrations: { meetingHeldOrphansV1: true },
  }));
  assert.equal(kept.progression.meetingHeld, true);
  const later = applyMeetingHeldOrphanReset(client({
    progression: { meetingHeld: true, offerSent: true, contractSigned: false },
  }));
  assert.equal(later.progression.meetingHeld, true);
});

test('future goals can be listed without becoming the current checkpoint', () => {
  const row = client();
  assert.deepEqual(getFutureGoalKeys(row), ['offerSent', 'contractSigned']);
  assert.equal(getCurrentGoalKey(row), 'meetingHeld');
});

test('oppsjekk 1/2 are not current sales goals', () => {
  const row = client({
    progression: { meetingHeld: true, offerSent: false },
  });
  assert.ok(!getVisibleGoalKeys(row).includes('checkIn1'));
  assert.equal(getCurrentGoalKey(row), 'offerSent');
});

test('finn møte tidspunkt is a meetingHeld action with optional note', () => {
  const created = applyNextActionMutation(client(), {
    op: 'create',
    goalKey: 'meetingHeld',
    presetKey: 'findMeetingTime',
    name: 'Finn møte tidspunkt',
    note: 'Vil helst mandag ettermiddag',
    dueAt: '2026-09-22T09:00:00.000Z',
  });
  assert.equal(created.error, undefined);
  const find = created.nextActions.find((action) => action.presetKey === 'findMeetingTime');
  assert.equal(find.note, 'Vil helst mandag ettermiddag');
  assert.equal(created.nextActions.some((action) => action.presetKey === 'meeting' && !action.doneAt), true);
});

test('møtet booket preset defaults to add-to-calendar and marks the client as a calendar contact point', () => {
  const row = client({ agreedTime: false, meetingAt: '' });
  assert.equal(getCalendarNextAction(row), null);
  assert.equal(defaultAddToCalendar('meetingBooked', row), true);
  assert.equal(suggestedDueAtForPreset('meetingBooked', client()), MEETING_AT);

  const created = applyNextActionMutation(row, {
    op: 'create',
    goalKey: 'meetingHeld',
    presetKey: 'meetingBooked',
    name: 'Møtet booket',
    dueAt: '2026-09-23T10:00:00.000Z',
  });
  assert.equal(created.error, undefined);
  const booked = created.nextActions.find((action) => action.presetKey === 'meetingBooked');
  assert.equal(booked.name, 'Møtet booket');
  assert.equal(booked.addToCalendar, true);

  const withAction = client({ agreedTime: false, meetingAt: '', nextActions: created.nextActions });
  assert.equal(getCalendarNextAction(withAction)?.presetKey, 'meetingBooked');

  const toggledOff = applyNextActionMutation(withAction, {
    op: 'update',
    id: booked.id,
    addToCalendar: false,
  });
  assert.equal(toggledOff.error, undefined);
  assert.equal(getCalendarNextAction(client({ agreedTime: false, meetingAt: '', nextActions: toggledOff.nextActions })), null);
});

test('agreed meeting time keeps the meeting on the calendar after the SMS reminder is done', () => {
  assert.equal(getActiveNextAction(client())?.presetKey, 'sms1h');
  assert.equal(getCalendarNextAction(client()), null);
  const sms = decorateNextActions(client()).find((action) => action.presetKey === 'sms1h');
  const done = applyNextActionMutation(client(), { op: 'complete', id: sms.id });
  const after = client({ nextActions: done.nextActions });
  assert.equal(getActiveNextAction(after)?.presetKey, 'meeting');
  assert.equal(getCalendarNextAction(after)?.presetKey, 'meeting');
  const custom = applyNextActionMutation(client({ agreedTime: false, meetingAt: '' }), {
    op: 'create',
    goalKey: 'meetingHeld',
    presetKey: 'custom',
    name: 'Ring tilbake',
    dueAt: '2026-09-23T10:00:00.000Z',
  });
  assert.equal(custom.error, undefined);
  assert.equal(getCalendarNextAction(client({ agreedTime: false, meetingAt: '', nextActions: custom.nextActions })), null);
});

test('already-assigned clients without thank-you still need a confirmation send', () => {
  assert.equal(clientHasAssignedSalesRep(client({ ownerId: 'sales:abc' })), true);
  assert.equal(clientHasAssignedSalesRep(client({ ownerId: 'admin:damian' })), false);
  assert.equal(clientNeedsConfirmationSend(client({ ownerId: 'sales:abc' })), true);
  assert.equal(clientNeedsConfirmationSend(client({
    ownerId: 'sales:abc',
    reminders: { thankYouSentAt: '2026-09-20T10:00:00.000Z' },
  })), false);
  assert.equal(clientNeedsConfirmationSend(client({ ownerId: 'admin:damian' })), false);
});

test('every booked client gets an SMS reminder one hour before the meeting', () => {
  const actions = decorateNextActions(client());
  const sms = actions.find((action) => action.presetKey === 'sms1h');
  const meeting = actions.find((action) => action.presetKey === 'meeting');
  assert.equal(sms.name, 'Påminnelse');
  assert.equal(sms.format, 'sms');
  assert.equal(sms.addToCalendar, false);
  assert.equal(sms.note, 'send sms for å sjekke om kunde fortsatt kan møtes');
  assert.equal(Date.parse(sms.dueAt), Date.parse(MEETING_AT) - HOUR_MS);
  assert.ok(Date.parse(sms.dueAt) < Date.parse(meeting.dueAt));
  assert.equal(getActiveNextAction(client()).presetKey, 'sms1h');
});

test('checkmark removes one action and leaves the others', () => {
  const row = client();
  const sms = decorateNextActions(row).find((action) => action.presetKey === 'sms1h');
  const done = applyNextActionMutation(row, { op: 'complete', id: sms.id });
  assert.equal(done.nextActions.some((action) => action.presetKey === 'sms1h' && !action.doneAt), false);
  assert.equal(done.nextActions.some((action) => action.presetKey === 'meeting' && !action.doneAt), true);
  const again = decorateNextActions({ ...row, nextActions: done.nextActions });
  assert.equal(again.some((action) => action.presetKey === 'sms1h' && !action.doneAt), false);
});

test('checkmark on the meeting also marks møtet hatt and opens sendt tilbud', () => {
  const row = client();
  const meeting = decorateNextActions(row).find((action) => action.presetKey === 'meeting');
  const done = applyNextActionMutation(row, { op: 'complete', id: meeting.id });
  assert.equal(done.error, undefined);
  assert.equal(done.progression.meetingHeld, true);
  const after = { ...row, progression: done.progression, nextActions: done.nextActions };
  assert.equal(getCurrentGoalKey(after), 'offerSent');
  const checkIn = getActiveNextAction(after);
  assert.equal(checkIn?.presetKey, 'checkIn');
  assert.equal(checkIn?.name, OFFER_CHECKIN_NAME);
  assert.equal(done.nextActions.some((action) => action.presetKey === 'meeting' && !action.doneAt), false);
});

test('sold clients can add upsell, upgrade, and follow-up without replacing each other', () => {
  const sold = client({
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
  });
  const due = '2026-09-25T10:00:00.000Z';
  let current = sold;
  for (const presetKey of ['upsell', 'oppgrader', 'oppfolging']) {
    const created = applyNextActionMutation(current, {
      op: 'create',
      presetKey,
      name: presetKey,
      dueAt: due,
    });
    assert.equal(created.error, undefined);
    current = { ...sold, nextActions: created.nextActions };
  }
  const live = current.nextActions.filter((action) => !action.doneAt && action.presetKey !== 'oppfolging1mnd');
  assert.deepEqual(live.map((action) => action.presetKey).sort(), ['oppfolging', 'oppgrader', 'upsell']);
  assert.equal(live.every((action) => action.addToCalendar && action.format === 'mote'), true);
});

test('a sold client gets oppfølging 1mnd as a call, and stays out of the ranked next-action list', () => {
  const sold = client({
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
  });
  const actions = decorateNextActions(sold);
  const follow = actions.find((action) => action.presetKey === 'oppfolging1mnd');
  assert.ok(follow);
  assert.equal(follow.format, 'ring');
  assert.equal(follow.addToCalendar, false);
  assert.match(follow.note, /spørr om review/);
  const delta = Date.parse(follow.dueAt) - Date.now();
  assert.ok(Math.abs(delta - 30 * 24 * HOUR_MS) < 60 * 1000);
  const grouped = groupSalesClientsByNextAction([{ ...sold, nextActions: actions }], Date.now());
  assert.equal(grouped.upcoming.length, 0);
  assert.equal(grouped.recentPastDue.length, 0);
  assert.equal(grouped.pastDue.length, 0);
});

test('møtet hatt adds oppsjekk sett on sendt tilbud for 09:00 next day Oslo', () => {
  const now = Date.parse('2026-09-28T14:00:00.000Z');
  const result = applyProgressionChange(client(), 'meetingHeld', true, { nowMs: now });
  assert.equal(result.error, undefined);
  const action = result.nextActions.find((entry) => isAutoOfferCheckIn(entry));
  assert.ok(action);
  assert.equal(action.goalKey, 'offerSent');
  assert.equal(action.name, OFFER_CHECKIN_NAME);
  assert.equal(action.dueAt, nextDayAtNineAmIso(now));
  assert.equal(action.dueAt, '2026-09-29T07:00:00.000Z');
  const after = { ...client(), progression: result.progression, nextActions: result.nextActions };
  assert.equal(getActiveNextAction(after)?.id, action.id);
  const again = applyProgressionChange(after, 'meetingHeld', true, { nowMs: now + HOUR_MS });
  assert.equal(again.error, undefined);
  assert.equal(again.nextActions.filter((entry) => isAutoOfferCheckIn(entry)).length, 1);
  assert.equal(again.nextActions.find((entry) => isAutoOfferCheckIn(entry)).dueAt, action.dueAt);
});

test('unchecking møtet hatt removes the auto oppsjekk sett', () => {
  const now = Date.parse('2026-09-28T14:00:00.000Z');
  const held = applyProgressionChange(client(), 'meetingHeld', true, { nowMs: now });
  const after = { ...client(), progression: held.progression, nextActions: held.nextActions };
  const undone = applyProgressionChange(after, 'meetingHeld', false, { nowMs: now });
  assert.equal(undone.error, undefined);
  assert.equal(undone.nextActions.some((entry) => isAutoOfferCheckIn(entry)), false);
});

test('next day 09:00 uses Europe/Oslo in winter', () => {
  const now = Date.parse('2026-12-01T15:00:00.000Z');
  assert.equal(nextDayAtNineAmIso(now), '2026-12-02T08:00:00.000Z');
});

test('pipeline counts split confirmation, upcoming meetings, unsent offers, contracts, and wins', () => {
  const now = Date.parse('2026-09-28T12:00:00.000Z');
  const awaitingConfirm = client({
    id: 'confirm',
    agreedTime: true,
    meetingAt: '2026-09-30T10:00:00.000Z',
    reminders: { thankYouSentAt: '' },
  });
  const upcoming = client({
    id: 'future',
    agreedTime: true,
    meetingAt: '2026-09-30T10:00:00.000Z',
    reminders: { thankYouSentAt: '2026-09-27T10:00:00.000Z' },
  });
  const awaitingOffer = client({
    id: 'offer',
    agreedTime: true,
    meetingAt: '2026-09-20T10:00:00.000Z',
    progression: { meetingHeld: true, offerSent: false, contractSigned: false },
  });
  const contract = client({
    id: 'contract',
    progression: { meetingHeld: true, offerSent: true, contractSigned: false },
  });
  const win = client({
    id: 'win',
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
  });
  const archived = client({
    id: 'dead',
    status: 'not-sold',
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
  });
  assert.equal(classifySalesPipelineState(awaitingConfirm, now), 'awaitingMeetingConfirm');
  assert.equal(classifySalesPipelineState(upcoming, now), 'upcomingMeeting');
  assert.equal(classifySalesPipelineState(awaitingOffer, now), 'awaitingOfferSend');
  assert.equal(classifySalesPipelineState(contract, now), 'awaitingContract');
  assert.equal(classifySalesPipelineState(win, now), 'win');
  assert.equal(classifySalesPipelineState(archived, now), '');
  assert.deepEqual(
    countSalesPipelineStates([awaitingConfirm, upcoming, awaitingOffer, contract, win, archived], now),
    {
      awaitingMeetingConfirm: 1,
      upcomingMeeting: 1,
      awaitingOfferSend: 1,
      awaitingContract: 1,
      win: 1,
    }
  );
});
