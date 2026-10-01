import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_FORMATS,
  FORMAT_LABELS,
  applyNextActionMutation,
  sanitizeActionFormat,
  applyProgressionChange,
  applyMeetingHeldOrphanReset,
  actionFollowsNeighbor,
  classifyNextActionBucket,
  classifySalesPipelineState,
  countSalesPipelineStates,
  decorateNextActions,
  defaultAddToCalendar,
  getActiveNextAction,
  getCalendarNextAction,
  clientMeetingAtIso,
  getClientNextActionMs,
  getCurrentGoalKey,
  getFutureGoalKeys,
  getRemainingGoalCount,
  getVisibleGoalKeys,
  groupSalesClientsByNextAction,
  inferMeetingHeld,
  isAutoOfferCheckIn,
  nextDayAtNineAmIso,
  normalizeSecondaryInterest,
  OFFER_CHECKIN_NAME,
  secondaryInterestLabel,
  clientHasAssignedSalesRep,
  clientNeedsConfirmationSend,
  meetingTimeHasPassed,
  confirmationShouldSendOnChange,
  osloWallClockToIso,
  isoToDatetimeLocalOslo,
  datetimeLocalOsloToIso,
  osloWeekRange,
  groupCalendarEventsByOsloDay,
  osloMinutesFromMidnight,
  salesCalendarHourSpan,
  layoutTimedCalendarEvents,
  resolveMeetingAtOnMyphonerMerge,
  assignmentStampForOwnerChange,
  clientIsNewlyAssigned,
  NEW_SALES_ASSIGNMENT_MS,
  MEETING_TIME_BACKFILL_TARGETS,
  canStickAction,
  salesProgressBlockedReason,
  suggestedDueAtForPreset,
  clientMatchesMeetingModeFilter,
  clientNextActionInDateRange,
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
  const ranked = client();
  const active = getActiveNextAction(ranked);
  assert.equal(active.presetKey, 'sms1h');
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

test('agreed meeting time keeps the meeting on the calendar even while the SMS reminder is next', () => {
  assert.equal(getActiveNextAction(client())?.presetKey, 'sms1h');
  assert.equal(getCalendarNextAction(client())?.presetKey, 'meeting');
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

test('client card meeting time is the meeting, not påminnelse, and stays after møtet hatt', () => {
  assert.equal(getActiveNextAction(client())?.presetKey, 'sms1h');
  assert.equal(clientMeetingAtIso(client()), MEETING_AT);
  const held = applyProgressionChange(client(), 'meetingHeld', true);
  const afterHeld = client({
    progression: held.progression,
    nextActions: held.nextActions,
  });
  assert.equal(getCurrentGoalKey(afterHeld), 'offerSent');
  assert.equal(clientMeetingAtIso(afterHeld), MEETING_AT);
  const offered = applyProgressionChange(afterHeld, 'offerSent', true);
  const afterOffer = client({
    progression: offered.progression,
    nextActions: offered.nextActions,
  });
  assert.equal(getCurrentGoalKey(afterOffer), 'contractSigned');
  assert.equal(clientMeetingAtIso(afterOffer), MEETING_AT);
});

test('past meeting times skip auto confirmation until the time is moved forward', () => {
  const now = Date.parse('2026-09-29T12:00:00.000Z');
  const past = client({ agreedTime: true, meetingAt: '2026-09-20T10:00:00.000Z' });
  const future = client({ agreedTime: true, meetingAt: '2026-09-30T10:00:00.000Z' });
  const unscheduled = client({ agreedTime: false, meetingAt: '' });
  assert.equal(meetingTimeHasPassed(past, now), true);
  assert.equal(meetingTimeHasPassed(future, now), false);
  assert.equal(meetingTimeHasPassed(unscheduled, now), false);
});

test('changing meeting time or IRL/online sends confirmation; name and notes do not', () => {
  const existing = client({
    meetingMode: 'online',
    meetingAt: '2026-09-30T10:00:00.000Z',
    contactPerson: 'Ada',
    contactEmail: 'ada@test.no',
  });
  const modeOnly = { ...existing, meetingMode: 'in-person' };
  const timeChanged = { ...existing, meetingAt: '2026-10-01T10:00:00.000Z' };
  assert.equal(confirmationShouldSendOnChange(existing, modeOnly), true);
  assert.equal(confirmationShouldSendOnChange(existing, timeChanged), true);
  assert.equal(confirmationShouldSendOnChange(existing, existing), false);
  assert.equal(confirmationShouldSendOnChange(existing, existing, { ownerJustAssigned: true }), true);
});

test('saving IRL/online on the meeting action stores meetingMode', () => {
  const start = client({ meetingMode: 'online' });
  const meeting = decorateNextActions(start).find((action) => action.presetKey === 'meeting');
  const moved = applyNextActionMutation(
    { ...start, nextActions: decorateNextActions(start) },
    { op: 'update', id: meeting.id, meetingMode: 'in-person' }
  );
  assert.equal(moved.meetingMode, 'in-person');
  assert.equal(moved.meetingAt, MEETING_AT);
});

test('IRL/online can be saved on a meeting action before a time is set', () => {
  const start = client({ agreedTime: false, meetingAt: '', meetingMode: 'online' });
  const meeting = decorateNextActions(start).find((action) => action.presetKey === 'meeting');
  const moved = applyNextActionMutation(
    { ...start, nextActions: decorateNextActions(start) },
    { op: 'update', id: meeting.id, meetingMode: 'in-person' }
  );
  assert.equal(moved.error, undefined);
  assert.equal(moved.meetingMode, 'in-person');
  assert.equal(moved.meetingAt, undefined);
});

test('renaming or noting the meeting action does not change meetingMode', () => {
  const start = client({ meetingMode: 'in-person' });
  const meeting = decorateNextActions(start).find((action) => action.presetKey === 'meeting');
  const renamed = applyNextActionMutation(
    { ...start, nextActions: decorateNextActions(start) },
    { op: 'update', id: meeting.id, name: 'Kickoff', note: 'Ta med meny' }
  );
  assert.equal(renamed.meetingMode, undefined);
  assert.equal(renamed.nextActions.find((action) => action.id === meeting.id).name, 'Kickoff');
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

test('påminnelse stays 24 hours before the meeting when the meeting moves', () => {
  const start = client({ meetingAt: '2026-09-20T14:00:00.000Z' });
  const meeting = decorateNextActions(start).find((action) => action.presetKey === 'meeting');
  const moved = applyNextActionMutation(
    { ...start, nextActions: decorateNextActions(start) },
    { op: 'update', id: meeting.id, dueAt: '2026-10-01T13:00:00.000Z' }
  );
  assert.equal(moved.meetingAt, '2026-10-01T13:00:00.000Z');
  const sms = moved.nextActions.find((action) => action.presetKey === 'sms1h');
  assert.equal(sms.relativeToMeetingHours, 24);
  assert.equal(Date.parse(sms.dueAt), Date.parse('2026-10-01T13:00:00.000Z') - 24 * HOUR_MS);
});

test('editing påminnelse time cannot unpin it from 24 hours before the meeting', () => {
  const row = { ...client(), nextActions: decorateNextActions(client()) };
  const sms = row.nextActions.find((action) => action.presetKey === 'sms1h');
  const moved = applyNextActionMutation(row, {
    op: 'update',
    id: sms.id,
    dueAt: '2026-10-01T13:00:00.000Z',
  });
  const next = moved.nextActions.find((action) => action.presetKey === 'sms1h');
  assert.equal(next.relativeToMeetingHours, 24);
  assert.equal(Date.parse(next.dueAt), Date.parse(MEETING_AT) - 24 * HOUR_MS);
});

test('oslo wall clock backfill targets are 15:00 local on 1 Oct and 7 Oct 2026', () => {
  assert.equal(osloWallClockToIso(2026, 10, 1, 15, 0), '2026-10-01T13:00:00.000Z');
  assert.equal(osloWallClockToIso(2026, 10, 7, 15, 0), '2026-10-07T13:00:00.000Z');
  assert.equal(MEETING_TIME_BACKFILL_TARGETS[0].match({ businessName: 'Pokebutikk Khogiani' }), true);
  assert.equal(MEETING_TIME_BACKFILL_TARGETS[1].match({ contactPerson: 'Deles Are Terjesen' }), true);
});

test('påminnelse cannot be unpinned from the meeting', () => {
  const sms = decorateNextActions(client()).find((action) => action.presetKey === 'sms1h');
  assert.equal(canStickAction(sms), false);
});

test('every booked client gets an SMS reminder 24 hours before the meeting', () => {
  const actions = decorateNextActions(client());
  const sms = actions.find((action) => action.presetKey === 'sms1h');
  const meeting = actions.find((action) => action.presetKey === 'meeting');
  assert.equal(sms.name, 'Påminnelse');
  assert.equal(sms.format, 'sms');
  assert.equal(sms.addToCalendar, false);
  assert.equal(sms.note, 'send sms for å sjekke om kunde fortsatt kan møtes');
  assert.equal(Date.parse(sms.dueAt), Date.parse(MEETING_AT) - 24 * HOUR_MS);
  assert.ok(Date.parse(sms.dueAt) < Date.parse(meeting.dueAt));
  assert.equal(getActiveNextAction(client()).presetKey, 'sms1h');
  assert.equal(actionFollowsNeighbor(sms), true);
});

test('meeting time lives on the meeting action even before a time is set', () => {
  const row = client({ agreedTime: false, meetingAt: '' });
  const meeting = decorateNextActions(row).find((action) => action.presetKey === 'meeting' && !action.doneAt);
  assert.ok(meeting);
  assert.equal(meeting.dueAt, '');
  const deleted = applyNextActionMutation(row, { op: 'delete', id: meeting.id });
  assert.match(deleted.error, /ikke slettes/i);
  const timed = applyNextActionMutation(row, {
    op: 'update',
    id: meeting.id,
    dueAt: '2026-09-24T11:00:00.000Z',
  });
  assert.equal(timed.error, undefined);
  assert.equal(timed.meetingAt, '2026-09-24T11:00:00.000Z');
  assert.equal(timed.agreedTime, true);
});

test('sticky action keeps its gap when the action below moves', () => {
  const sold = client({
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
  });
  const follow = applyNextActionMutation(sold, {
    op: 'create',
    presetKey: 'oppfolging',
    name: 'Oppfølging',
    dueAt: '2026-09-25T12:00:00.000Z',
  });
  const withFollow = { ...sold, nextActions: follow.nextActions };
  const sms = applyNextActionMutation(withFollow, {
    op: 'create',
    presetKey: 'custom',
    name: 'Send sms',
    format: 'sms',
    dueAt: '2026-09-25T11:00:00.000Z',
    sticky: true,
  });
  assert.equal(sms.error, undefined);
  const sticky = sms.nextActions.find((action) => action.name === 'Send sms');
  const anchor = sms.nextActions.find((action) => action.presetKey === 'oppfolging');
  assert.equal(sticky.sticky, true);
  assert.equal(sticky.stickyAnchorId, anchor.id);
  assert.equal(sticky.stickyOffsetMs, HOUR_MS);
  const moved = applyNextActionMutation(
    { ...sold, nextActions: sms.nextActions },
    { op: 'update', id: anchor.id, dueAt: '2026-09-26T12:00:00.000Z' }
  );
  const movedSms = moved.nextActions.find((action) => action.id === sticky.id);
  assert.equal(Date.parse(movedSms.dueAt), Date.parse('2026-09-26T12:00:00.000Z') - HOUR_MS);
});

test('without sticky, changing an action time can reorder the list', () => {
  const sold = client({
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
  });
  const follow = applyNextActionMutation(sold, {
    op: 'create',
    presetKey: 'oppfolging',
    name: 'Oppfølging',
    dueAt: '2026-09-25T12:00:00.000Z',
  });
  const withFollow = { ...sold, nextActions: follow.nextActions };
  const sms = applyNextActionMutation(withFollow, {
    op: 'create',
    presetKey: 'custom',
    name: 'Send sms',
    format: 'sms',
    dueAt: '2026-09-25T11:00:00.000Z',
  });
  const stickyOff = sms.nextActions.find((action) => action.name === 'Send sms');
  assert.equal(stickyOff.sticky, false);
  const later = applyNextActionMutation(
    { ...sold, nextActions: sms.nextActions },
    { op: 'update', id: stickyOff.id, dueAt: '2026-09-25T13:00:00.000Z' }
  );
  const live = later.nextActions.filter((action) => !action.doneAt && action.presetKey !== 'oppfolging1mnd');
  assert.equal(live[0].presetKey, 'oppfolging');
  assert.equal(live[1].name, 'Send sms');
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
      redesign: 0,
      consulting: 0,
      video: 0,
      email: 0,
      social: 0,
    }
  );
});

test('secondary interest is a pipeline state like bekreftelse ikke sendt', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const redesign = client({
    id: 'sec-redesign',
    status: 'secondary',
    secondaryInterest: 'redesign',
    reminders: { thankYouSentAt: '' },
  });
  const video = client({
    id: 'sec-video',
    status: 'secondary',
    secondaryInterest: 'Videoproduksjon',
    agreedTime: true,
    meetingAt: '2026-09-30T10:00:00.000Z',
    reminders: { thankYouSentAt: '' },
  });
  assert.equal(normalizeSecondaryInterest('Sosiale medier'), 'social');
  assert.equal(secondaryInterestLabel('email'), 'E-post');
  assert.equal(classifySalesPipelineState(redesign, now), 'redesign');
  assert.equal(classifySalesPipelineState(video, now), 'video');
  assert.equal(classifySalesPipelineState(client({ status: 'secondary' }), now), 'awaitingMeetingConfirm');
  assert.deepEqual(
    countSalesPipelineStates([redesign, video], now),
    {
      awaitingMeetingConfirm: 0,
      upcomingMeeting: 0,
      awaitingOfferSend: 0,
      awaitingContract: 0,
      win: 0,
      redesign: 1,
      consulting: 0,
      video: 1,
      email: 0,
      social: 0,
    }
  );
});

test('oslo week range starts Monday in Europe/Oslo', () => {
  const wednesday = Date.parse('2026-09-30T12:00:00.000Z');
  const week = osloWeekRange(wednesday, 0);
  assert.deepEqual(week.days, [
    '2026-09-28',
    '2026-09-29',
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
  ]);
  assert.equal(week.timeMin, '2026-09-27T22:00:00.000Z');
  assert.equal(week.timeMax, '2026-10-04T22:00:00.000Z');
  const next = osloWeekRange(wednesday, 1);
  assert.equal(next.days[0], '2026-10-05');
});

test('calendar events group onto the Oslo day, not UTC', () => {
  const week = osloWeekRange(Date.parse('2026-09-30T12:00:00.000Z'), 0);
  const grouped = groupCalendarEventsByOsloDay(
    [
      { start: '2026-09-28T07:00:00.000Z', allDay: false, summary: 'Morning' },
      { start: '2026-09-28', allDay: true, summary: 'All day' },
    ],
    week.days
  );
  assert.equal(grouped[0].date, '2026-09-28');
  assert.equal(grouped[0].events.length, 2);
  assert.equal(grouped[1].events.length, 0);
});

test('sales calendar week grid places a 30 minute meeting in the Oslo hour slot', () => {
  const start = '2026-09-28T07:00:00.000Z';
  const end = '2026-09-28T07:30:00.000Z';
  assert.equal(osloMinutesFromMidnight(start), 9 * 60);
  const span = salesCalendarHourSpan([{ start, end, allDay: false }]);
  assert.equal(span.startHour, 7);
  assert.equal(span.endHour, 20);
  const [block] = layoutTimedCalendarEvents([{ start, end, summary: 'Asoldi · Online møte · Bakeri' }], {
    startHour: 7,
    hourHeight: 48,
  });
  assert.equal(block.top, 2 * 48);
  assert.equal(block.height, 24);
});

test('oslo datetime-local roundtrips the time a rep types in the action step', () => {
  const iso = osloWallClockToIso(2026, 10, 1, 15, 0);
  assert.equal(iso, '2026-10-01T13:00:00.000Z');
  assert.equal(isoToDatetimeLocalOslo(iso), '2026-10-01T15:00');
  assert.equal(datetimeLocalOsloToIso('2026-10-01T15:00'), iso);
});

test('a sales-written meeting time stays after MyPhoner sends the old booking again', () => {
  const start = client({
    meetingAt: '2026-09-20T14:00:00.000Z',
    meetingAtSource: 'myphoner',
    ownerId: 'sales:kari',
  });
  const meeting = decorateNextActions(start).find((action) => action.presetKey === 'meeting');
  const moved = applyNextActionMutation(
    { ...start, nextActions: decorateNextActions(start) },
    { op: 'update', id: meeting.id, dueAt: '2026-10-01T13:00:00.000Z' }
  );
  assert.equal(moved.meetingAt, '2026-10-01T13:00:00.000Z');
  assert.equal(moved.meetingAtSource, 'sales');
  const merged = resolveMeetingAtOnMyphonerMerge(
    {
      ...start,
      meetingAt: moved.meetingAt,
      agreedTime: true,
      meetingAtSource: 'sales',
      ownerId: 'sales:kari',
    },
    '2026-09-20T14:00:00.000Z'
  );
  assert.equal(merged.meetingAt, '2026-10-01T13:00:00.000Z');
  assert.equal(merged.meetingAtSource, 'sales');
  const decorated = decorateNextActions({
    ...start,
    meetingAt: merged.meetingAt,
    agreedTime: true,
    nextActions: moved.nextActions,
  });
  assert.equal(decorated.find((action) => action.presetKey === 'meeting').dueAt, '2026-10-01T13:00:00.000Z');
});

test('MyPhoner can still fill a meeting time when the client is on admin and never written by sales', () => {
  const merged = resolveMeetingAtOnMyphonerMerge(
    {
      meetingAt: '',
      agreedTime: false,
      meetingAtSource: '',
      ownerId: 'admin:damian@asoldi.com',
    },
    '2026-10-01T13:00:00.000Z'
  );
  assert.equal(merged.meetingAt, '2026-10-01T13:00:00.000Z');
  assert.equal(merged.meetingAtSource, 'myphoner');
});

test('Ny lasts twelve hours after admin assigns a sales rep', () => {
  const assigned = assignmentStampForOwnerChange('', 'sales:kari', '2026-09-30T08:00:00.000Z');
  assert.equal(assigned.assignedToRepAt, '2026-09-30T08:00:00.000Z');
  const row = { ownerId: 'sales:kari', assignedToRepAt: assigned.assignedToRepAt };
  const start = Date.parse('2026-09-30T08:00:00.000Z');
  assert.equal(clientIsNewlyAssigned(row, start + NEW_SALES_ASSIGNMENT_MS - 1), true);
  assert.equal(clientIsNewlyAssigned(row, start + NEW_SALES_ASSIGNMENT_MS), false);
  assert.deepEqual(assignmentStampForOwnerChange('sales:kari', 'sales:kari'), {});
});

test('meeting format filter matches IRL vs online', () => {
  const online = client({ meetingMode: 'online' });
  const irl = client({ meetingMode: 'in-person' });
  const unset = client({ meetingMode: '' });
  assert.equal(clientMatchesMeetingModeFilter(online, ''), true);
  assert.equal(clientMatchesMeetingModeFilter(irl, ''), true);
  assert.equal(clientMatchesMeetingModeFilter(online, 'online'), true);
  assert.equal(clientMatchesMeetingModeFilter(irl, 'online'), false);
  assert.equal(clientMatchesMeetingModeFilter(irl, 'in-person'), true);
  assert.equal(clientMatchesMeetingModeFilter(online, 'irl'), false);
  assert.equal(clientMatchesMeetingModeFilter(unset, 'online'), true);
});

test('date filter uses the next action day, not the booked meeting day', () => {
  const row = client({ meetingAt: MEETING_AT });
  const next = getActiveNextAction(row);
  const nextDay = isoToDatetimeLocalOslo(next.dueAt).slice(0, 10);
  const meetingDay = isoToDatetimeLocalOslo(MEETING_AT).slice(0, 10);
  assert.equal(next.presetKey, 'sms1h');
  assert.notEqual(nextDay, meetingDay);
  assert.equal(clientNextActionInDateRange(row, nextDay, nextDay), true);
  assert.equal(clientNextActionInDateRange(row, meetingDay, meetingDay), false);
  assert.equal(clientNextActionInDateRange(row, '', ''), true);
  assert.equal(clientNextActionInDateRange(client({ agreedTime: false, meetingAt: '' }), nextDay, nextDay), false);
});

test('sms-ring is a normal sales format and does not replace sms or ring', () => {
  assert.equal(ACTION_FORMATS.includes('sms-ring'), true);
  assert.equal(ACTION_FORMATS.includes('sms'), true);
  assert.equal(ACTION_FORMATS.includes('ring'), true);
  assert.equal(FORMAT_LABELS['sms-ring'], 'SMS/ring');
  assert.equal(sanitizeActionFormat('sms-ring', 'custom'), 'sms-ring');
});

test('other sales Møte rows can still turn the calendar switch off', () => {
  const start = client({
    nextActions: [{
      id: 'na-custom-mote',
      goalKey: 'meetingHeld',
      presetKey: 'custom',
      name: 'Oppfølging',
      format: 'mote',
      dueAt: MEETING_AT,
      addToCalendar: true,
    }],
  });
  const updated = applyNextActionMutation(
    { ...start, nextActions: decorateNextActions(start) },
    { op: 'update', id: 'na-custom-mote', addToCalendar: false, dueAt: MEETING_AT, name: 'Oppfølging' }
  );
  const row = updated.nextActions.find((action) => action.id === 'na-custom-mote');
  assert.equal(row.format, 'mote');
  assert.equal(row.addToCalendar, false);
});
