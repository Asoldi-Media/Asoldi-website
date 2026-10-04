import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DAMIAN_CALENDAR_ACCOUNT_KEY,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  WORKSHOP_DURATION_MINUTES,
  WORKSHOP_FORMATS,
  buildWorkshopCalendarPlan,
  buildWorkshopInvitePayload,
  buildWorkshopPrivatePayload,
  getWorkshopAction,
  normalizeWorkshopAction,
  offerStartDateFromWorkshopDueAt,
  pickDamianCalendarAccountKey,
  offerStartDateCreatesEvent,
  sanitizeWorkshopFormat,
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

test('offer startDate follows the Oslo date of workshop dueAt', () => {
  assert.equal(offerStartDateFromWorkshopDueAt(''), '');
  assert.equal(offerStartDateFromWorkshopDueAt('not-a-date'), '');
  assert.equal(offerStartDateFromWorkshopDueAt(DUE), '2026-10-08');
  assert.equal(offerStartDateFromWorkshopDueAt('2026-10-08T22:30:00.000Z'), '2026-10-09');
  assert.equal(workshopStartSentence(offerStartDateFromWorkshopDueAt(DUE)).includes('8. oktober 2026'), true);
});

test('sms and ring are first-class workshop formats; only Møte invites', () => {
  assert.deepEqual(WORKSHOP_FORMATS, ['sms', 'ring', 'sms-ring', 'mote']);
  assert.equal(sanitizeWorkshopFormat('sms'), 'sms');
  assert.equal(sanitizeWorkshopFormat('ring'), 'ring');
  assert.equal(sanitizeWorkshopFormat('SMS/ring'), 'sms-ring');
  assert.equal(sanitizeWorkshopFormat('mote'), 'mote');
  assert.equal(normalizeWorkshopAction({ format: 'sms', dueAt: DUE }).format, 'sms');
  assert.equal(normalizeWorkshopAction({ format: 'ring', dueAt: DUE }).format, 'ring');
  assert.equal(normalizeWorkshopAction({ format: 'mote', dueAt: DUE }).status, 'draft');
  assert.equal(workshopInvitesClient({ format: 'sms', dueAt: DUE, addToCalendar: true }), false);
  assert.equal(workshopInvitesClient({ format: 'ring', dueAt: DUE, addToCalendar: true }), false);
  assert.equal(workshopInvitesClient({ format: 'mote', dueAt: DUE }), true);
});

test('workshop email send is Admin confirmSend only; Sales persist does not send', () => {
  const booked = normalizeWorkshopAction({ format: 'mote', dueAt: DUE });
  const confirmed = normalizeWorkshopAction({
    format: 'mote',
    dueAt: DUE,
    confirmationSentAt: '2026-10-01T12:00:00.000Z',
  });
  const alreadyOnCalendar = normalizeWorkshopAction({
    format: 'mote',
    dueAt: DUE,
    calendarEventId: 'evt-workshop-1',
  });
  const moved = normalizeWorkshopAction({
    format: 'mote',
    dueAt: '2026-10-09T12:00:00.000Z',
    confirmationSentAt: confirmed.confirmationSentAt,
  });
  const sms = normalizeWorkshopAction({ format: 'sms', dueAt: DUE, addToCalendar: true });
  const ring = normalizeWorkshopAction({ format: 'ring', dueAt: DUE, addToCalendar: true });
  const smsRing = normalizeWorkshopAction({ format: 'sms-ring', dueAt: DUE, addToCalendar: true });
  assert.equal(workshopEmailShouldSend({}, booked), false);
  assert.equal(workshopEmailShouldSend({}, booked, { confirmSend: false }), false);
  assert.equal(workshopEmailShouldSend({}, booked, { confirmSend: true }), true);
  assert.equal(workshopEmailShouldSend(booked, booked, { confirmSend: true }), true);
  assert.equal(workshopEmailShouldSend(confirmed, confirmed, { confirmSend: true }), false);
  assert.equal(workshopEmailShouldSend(alreadyOnCalendar, alreadyOnCalendar, { confirmSend: true }), false);
  assert.equal(workshopEmailShouldSend(confirmed, moved, { confirmSend: true }), true);
  assert.equal(workshopEmailShouldSend({}, sms, { confirmSend: true }), false);
  assert.equal(workshopEmailShouldSend({}, ring, { confirmSend: true }), false);
  assert.equal(workshopEmailShouldSend({}, smsRing, { confirmSend: true }), false);
  assert.equal(workshopEmailShouldSend(confirmed, { format: 'mote', dueAt: '' }, { confirmSend: true }), false);
});

test('Sales persist stays a draft; Admin Save is the send gate', () => {
  const modalSrc = readFileSync(new URL('../app/pages/sales/MeetingNotesModal.tsx', import.meta.url), 'utf8');
  assert.equal(modalSrc.includes('timeFormatLocked'), false);
  assert.equal(modalSrc.includes('Startdato for workshop'), false);
  assert.equal(modalSrc.includes('SalesCalendarWeek'), false);
  assert.equal(modalSrc.includes('confirmSend'), false);

  const salesSrc = readFileSync(new URL('../app/pages/Admin/sections/SalesClientsSection.tsx', import.meta.url), 'utf8');
  assert.match(salesSrc, /toggleHeaderPanel\('calendar'\)/);
  assert.equal(salesSrc.includes('/google/events'), false);
  assert.equal(/workshop-action[\s\S]{0,400}confirmSend:\s*true/.test(salesSrc), false);

  const adminRowSrc = readFileSync(new URL('../app/pages/Admin/sections/WorkshopAdminActionRow.tsx', import.meta.url), 'utf8');
  assert.match(adminRowSrc, /confirmSend:\s*true/);
  assert.match(adminRowSrc, /ADMIN_GOAL_PRESETS/);
  assert.match(adminRowSrc, /WORKSHOP_FORMATS/);

  const adminSrc = readFileSync(new URL('../app/pages/Admin/sections/AdminBoardSection.tsx', import.meta.url), 'utf8');
  assert.equal(adminSrc.includes('SalesCalendarWeek'), false);

  const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(serverSrc, /confirmSend && !requireOfferAdmin/);
  assert.match(serverSrc, /if \(confirmSend\) \{/);
  assert.match(serverSrc, /syncWorkshopCalendar/);
  assert.match(serverSrc, /sendWorkshopBookingEmail/);
  assert.match(serverSrc, /icalEvent: invite \|\| undefined/);
  assert.match(serverSrc, /durationMinutes: WORKSHOP_DURATION_MINUTES/);

  const dataSrc = readFileSync(new URL('../data/sales.js', import.meta.url), 'utf8');
  assert.match(dataSrc, /offerStartDateFromWorkshopDueAt/);
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
