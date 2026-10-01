import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAMIAN_CALENDAR_ACCOUNT_KEY,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  WORKSHOP_DURATION_MINUTES,
  buildWorkshopCalendarPlan,
  buildWorkshopInvitePayload,
  buildWorkshopPrivatePayload,
  getWorkshopAction,
  normalizeWorkshopAction,
  pickDamianCalendarAccountKey,
  offerStartDateCreatesEvent,
  tryBuildSalesWorkshopEmail,
  workshopDeleteSendUpdates,
  workshopEmailShouldSend,
  workshopInvitesClient,
  workshopNeedsCalendarEvent,
} from '../lib/workshop-action.js';
import {
  buildMeetingAttendees,
  presentWorkshopBusyBlock,
  resolveMeetingEventDurationMinutes,
  resolveSalesReminderDurationMinutes,
  SALES_REMINDER_DURATION_MINUTES,
  shouldIncludeFireflies,
} from '../lib/google-calendar.js';
import { workshopStartSentence } from '../lib/offer-email.js';

const DUE = '2026-10-08T12:00:00.000Z';
const client = {
  businessName: 'Test Bakeri',
  contactPerson: 'Damian',
  contactEmail: 'daracha777@gmail.com',
  details: { meetingQuote: { startDate: '2026-11-01' } },
  nextActions: [{
    id: 'na-1',
    presetKey: 'custom',
    format: 'mote',
    dueAt: DUE,
    addToCalendar: true,
    name: 'Oppfølging',
  }],
  workshop: { action: { format: 'mote', dueAt: '2026-12-01T10:00:00.000Z' } },
};

test('workshop Møte builds a 30-minute invite with the client, Fireflies, Meet, and sendUpdates all', () => {
  const action = normalizeWorkshopAction({ format: 'mote', dueAt: DUE, name: 'Workshop' });
  const plan = buildWorkshopCalendarPlan(action, client);
  const invite = buildWorkshopInvitePayload(client, action);
  assert.equal(plan.createEvent, true);
  assert.equal(plan.kind, 'invite');
  assert.equal(invite.durationMinutes, 30);
  assert.equal(invite.sendUpdates, 'all');
  assert.equal(invite.meetingMode, 'online');
  assert.equal(invite.includeMeet, true);
  assert.equal(invite.options.durationMinutes, WORKSHOP_DURATION_MINUTES);
  assert.equal(invite.options.addFireflies, true);
  assert.match(invite.options.summary, /Workshop/);
  assert.equal(invite.client.meetingMode, 'online');
  assert.equal(invite.client.meetingAt, DUE);
  assert.equal(invite.client.calendar?.eventId || '', action.calendarEventId);
  const includeFireflies = shouldIncludeFireflies({
    isOnline: true,
    addFireflies: true,
    sendUpdates: 'all',
    alreadyOnEvent: false,
  });
  const attendees = buildMeetingAttendees(invite.client, { includeAttendees: true, includeFireflies });
  assert.equal(attendees.some((entry) => entry.email === 'daracha777@gmail.com'), true);
  assert.equal(attendees.some((entry) => String(entry.email).endsWith('@fireflies.ai')), true);
  assert.equal(resolveMeetingEventDurationMinutes({ meetingMode: 'online' }, invite.options), 30);
  assert.notEqual(resolveMeetingEventDurationMinutes({ meetingMode: 'online' }, {}), 30);
});

test('workshop SMS/ring with the calendar switch on is a 30-minute private Damian event', () => {
  const action = normalizeWorkshopAction({
    format: 'sms-ring',
    dueAt: DUE,
    addToCalendar: true,
    name: 'Workshop',
  });
  const plan = buildWorkshopCalendarPlan(action, client);
  const privateEvent = buildWorkshopPrivatePayload(client, action);
  assert.equal(workshopInvitesClient(action), false);
  assert.equal(workshopNeedsCalendarEvent(action), true);
  assert.equal(plan.createEvent, true);
  assert.equal(plan.kind, 'private');
  assert.equal(privateEvent.sendUpdates, 'none');
  assert.equal(privateEvent.durationMinutes, 30);
  assert.deepEqual(privateEvent.attendees, []);
  assert.equal(privateEvent.includeMeet, false);
  assert.equal(privateEvent.includeFireflies, false);
  assert.equal(resolveSalesReminderDurationMinutes(privateEvent.options), 30);
});

test('workshop switch off or empty time builds no event', () => {
  const off = normalizeWorkshopAction({
    format: 'sms-ring',
    dueAt: DUE,
    addToCalendar: false,
    calendarEventId: 'evt-sms',
  });
  const cleared = normalizeWorkshopAction({
    format: 'mote',
    dueAt: '',
    calendarEventId: 'evt-meet',
  });
  const offPlan = buildWorkshopCalendarPlan(off, client, off);
  const clearPlan = buildWorkshopCalendarPlan(cleared, client, { format: 'mote', dueAt: DUE, calendarEventId: 'evt-meet' });
  assert.equal(workshopNeedsCalendarEvent(off), false);
  assert.equal(offPlan.createEvent, false);
  assert.equal(offPlan.deleteEvent, true);
  assert.equal(offPlan.deleteSendUpdates, 'none');
  assert.equal(clearPlan.createEvent, false);
  assert.equal(clearPlan.deleteEvent, true);
  assert.equal(workshopDeleteSendUpdates({ format: 'mote' }), 'all');
  assert.equal(workshopDeleteSendUpdates({ format: 'sms-ring' }), 'none');
});

test('offer startDate alone never creates a workshop event or invite', () => {
  assert.equal(offerStartDateCreatesEvent('2026-11-01'), false);
  assert.equal(offerStartDateCreatesEvent(''), false);
  const plan = buildWorkshopCalendarPlan({}, {
    details: { meetingQuote: { startDate: '2026-11-01' } },
    workshopAction: null,
  });
  assert.equal(plan.createEvent, false);
  assert.equal(workshopNeedsCalendarEvent({}), false);
});

test('getWorkshopAction reads only client.workshopAction', () => {
  assert.equal(getWorkshopAction({
    details: { meetingQuote: { startDate: '2026-11-01' }, workshopAction: { format: 'mote', dueAt: DUE } },
    nextActions: client.nextActions,
    workshop: { action: { format: 'mote', dueAt: DUE } },
  }), null);
  const stored = getWorkshopAction({
    workshopAction: { name: 'Workshop', format: 'sms-ring', dueAt: DUE, addToCalendar: true },
    details: { meetingQuote: { startDate: '2026-11-01' } },
    nextActions: client.nextActions,
  });
  assert.equal(stored.format, 'sms-ring');
  assert.equal(stored.dueAt, DUE);
  assert.equal(stored.addToCalendar, true);
});

test('Damian calendar key prefers admin:damian@asoldi.com and is empty without that mailbox', () => {
  assert.equal(DAMIAN_CALENDAR_ACCOUNT_KEY, 'admin:damian@asoldi.com');
  assert.equal(pickDamianCalendarAccountKey([]), '');
  assert.equal(pickDamianCalendarAccountKey(['sales:alexander']), 'sales:alexander');
  assert.equal(
    pickDamianCalendarAccountKey(['sales:other-damian', 'admin:damian@asoldi.com']),
    'admin:damian@asoldi.com',
  );
});

test('sales reminders stay 15 minutes and silent', () => {
  assert.equal(SALES_REMINDER_DURATION_MINUTES, 15);
  assert.equal(resolveSalesReminderDurationMinutes({}), 15);
  assert.equal(resolveSalesReminderDurationMinutes({ durationMinutes: 30 }), 30);
  const attendees = buildMeetingAttendees(client, { includeAttendees: false, includeFireflies: false });
  assert.deepEqual(attendees, []);
});

test('workshopStartSentence is still date-only and ignores the booked clock', () => {
  assert.equal(workshopStartSentence(''), 'Startdato for workshop: Vi avtaler startdato for workshop senere.');
  assert.match(workshopStartSentence('2026-10-15'), /15\. oktober 2026/);
  assert.equal(workshopStartSentence(DUE).startsWith('Startdato for workshop: Vi avtaler'), true);
});

test('workshop email send follows time/format changes, not the offer date', () => {
  const booked = normalizeWorkshopAction({ format: 'mote', dueAt: DUE });
  const moved = normalizeWorkshopAction({ format: 'mote', dueAt: '2026-10-09T12:00:00.000Z' });
  const sms = normalizeWorkshopAction({ format: 'sms-ring', dueAt: DUE, addToCalendar: true });
  assert.equal(workshopEmailShouldSend({}, booked), true);
  assert.equal(workshopEmailShouldSend(booked, booked), false);
  assert.equal(workshopEmailShouldSend(booked, moved), true);
  assert.equal(workshopEmailShouldSend(booked, sms), true);
  assert.equal(workshopEmailShouldSend(booked, { format: 'mote', dueAt: '' }), false);
});

test('busy blocks never keep a Google title', () => {
  const block = presentWorkshopBusyBlock({
    start: '2026-10-08T10:00:00.000Z',
    end: '2026-10-08T10:30:00.000Z',
    summary: 'Hemmelig kundemøte',
    title: 'Hemmelig kundemøte',
  });
  assert.equal(block.summary, 'Opptatt');
  assert.equal(JSON.stringify(block).includes('Hemmelig'), false);
  assert.equal(DAMIAN_WORKSHOP_CALENDAR_EMAIL, 'damian@asoldi.com');
});

test('T08 workshop email builder is used when it exists', async () => {
  const built = await tryBuildSalesWorkshopEmail({
    contactPerson: 'Damian',
    businessName: 'Test Bakeri',
    workshopAction: { format: 'mote', dueAt: DUE, meetLink: 'https://meet.google.com/aaa-bbbb-ccc' },
  }, { meetLink: 'https://meet.google.com/aaa-bbbb-ccc' });
  if (built) {
    assert.match(built.subject, /workshop/i);
    assert.match(built.html, /Meet|telefon eller SMS/i);
    assert.equal(built.html.includes('envelope.png') || built.html.includes('asoldi-envelope'), false);
  }
});
