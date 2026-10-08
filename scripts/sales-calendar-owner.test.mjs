import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKED_CALENDAR_GOOGLE_EMAIL,
  calendarOwnerIdForSync,
  calendarRecordIsOnBlockedMailbox,
  calendarTokenIsUsable,
  isBlockedCalendarAccountKey,
  isBlockedCalendarGoogleEmail,
  isUnacceptableMeetingHostEmail,
  pickCalendarSyncAccountKey,
  salesClientNeedsCalendarMove,
  salesMeetHostIsVerified,
  salesMeetJoinUrl,
  salesMeetNeedsFreshConference,
  salesMeetingIsInProgress,
  sanitizeMyphonerDefaultOwnerKey,
  shouldSyncSalesMeetingCalendar,
} from '../lib/sales-calendar-owner.js';

const damianAdmin = 'admin:damian@asoldi.com';
const damianSales = 'sales:damian-id';
const alexanderSales = 'sales:alexander-id';
const darachaAdmin = 'admin:daracha777@gmail.com';

test('blocked Gmail is never a calendar destination', () => {
  assert.equal(isBlockedCalendarGoogleEmail(BLOCKED_CALENDAR_GOOGLE_EMAIL), true);
  assert.equal(isBlockedCalendarAccountKey(darachaAdmin), true);
  assert.equal(isBlockedCalendarGoogleEmail('damian@asoldi.com'), false);
  assert.equal(
    sanitizeMyphonerDefaultOwnerKey(darachaAdmin, damianAdmin),
    damianAdmin
  );
  assert.equal(sanitizeMyphonerDefaultOwnerKey('', damianAdmin), damianAdmin);
  assert.equal(calendarOwnerIdForSync(darachaAdmin), damianAdmin);
});

test('unassigned admin-hold wins do not create a calendar event', () => {
  assert.equal(shouldSyncSalesMeetingCalendar({
    ownerId: damianAdmin,
    calendar: {},
  }), false);
  assert.equal(shouldSyncSalesMeetingCalendar({
    ownerId: '',
    calendar: { eventId: '' },
  }), false);
});

test('assigned sales reps sync to their own calendar', () => {
  assert.equal(shouldSyncSalesMeetingCalendar({
    ownerId: alexanderSales,
    calendar: {},
  }), true);
  assert.equal(shouldSyncSalesMeetingCalendar({
    ownerId: damianSales,
    calendar: {},
  }), true);
});

test('existing Gmail events are migrated even before a rep is assigned', () => {
  assert.equal(shouldSyncSalesMeetingCalendar({
    ownerId: damianAdmin,
    calendar: { eventId: 'evt-1', accountKey: darachaAdmin },
  }), true);
  assert.equal(calendarRecordIsOnBlockedMailbox({
    calendarId: 'daracha777@gmail.com',
  }), true);
});

test('Damian’s connected token wins; Daracha is never selected', () => {
  const tokens = {
    [darachaAdmin]: { refresh_token: 'gmail', googleEmail: BLOCKED_CALENDAR_GOOGLE_EMAIL },
    [damianAdmin]: { refresh_token: 'work', googleEmail: 'damian@asoldi.com' },
    [alexanderSales]: { refresh_token: 'alex', googleEmail: 'alexander@asoldi.com' },
  };
  const isUsable = (key) => calendarTokenIsUsable(tokens[key], key);

  assert.equal(pickCalendarSyncAccountKey({
    ownerId: damianSales,
    previousAccountKey: darachaAdmin,
    fallbackAccountKeys: [darachaAdmin],
    preferredAccountKeys: [damianAdmin],
    isUsable,
  }), damianAdmin);

  assert.equal(pickCalendarSyncAccountKey({
    ownerId: alexanderSales,
    previousAccountKey: darachaAdmin,
    fallbackAccountKeys: [darachaAdmin, damianAdmin],
    preferredAccountKeys: [alexanderSales],
    isUsable,
  }), alexanderSales);

  assert.equal(pickCalendarSyncAccountKey({
    ownerId: damianAdmin,
    previousAccountKey: darachaAdmin,
    fallbackAccountKeys: [darachaAdmin],
    isUsable,
  }), damianAdmin);
});

test('future Gmail meetings are marked to move; past ones are left', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.equal(salesClientNeedsCalendarMove({
    agreedTime: true,
    meetingAt: future,
    calendar: { eventId: 'evt-1', accountKey: darachaAdmin },
  }), true);
  assert.equal(salesClientNeedsCalendarMove({
    agreedTime: true,
    meetingAt: past,
    calendar: { eventId: 'evt-1', accountKey: darachaAdmin },
  }), false);
  assert.equal(salesClientNeedsCalendarMove({
    agreedTime: true,
    meetingAt: future,
    calendar: { eventId: 'evt-1', accountKey: damianAdmin, googleEmail: 'damian@asoldi.com' },
  }), false);
});

test('a shared mailbox cannot host a sales meeting', () => {
  const meet = 'https://meet.google.com/abc-defg-hij';
  assert.equal(isUnacceptableMeetingHostEmail('contact@asoldi.com'), true);
  assert.equal(isUnacceptableMeetingHostEmail('alexander@asoldi.com'), false);
  assert.equal(calendarTokenIsUsable({
    refresh_token: 'x',
    googleEmail: 'contact@asoldi.com',
  }, alexanderSales), false);
  assert.equal(salesMeetHostIsVerified('alexander@asoldi.com', 'alexander@asoldi.com'), true);
  assert.equal(salesMeetHostIsVerified('alexander@asoldi.com', ''), false);
  assert.equal(salesMeetHostIsVerified('alexander@asoldi.com', 'contact@asoldi.com'), false);
  assert.equal(salesMeetNeedsFreshConference({
    expectedOwnerEmail: 'alexander@asoldi.com',
    verifiedHostEmail: '',
    organizerEmail: 'alexander@asoldi.com',
    creatorEmail: 'alexander@asoldi.com',
    hangoutLink: meet,
  }), true);
  assert.equal(salesMeetNeedsFreshConference({
    expectedOwnerEmail: 'alexander@asoldi.com',
    verifiedHostEmail: 'alexander@asoldi.com',
    organizerEmail: 'alexander@asoldi.com',
    creatorEmail: 'alexander@asoldi.com',
    hangoutLink: meet,
  }), false);
  assert.equal(salesMeetNeedsFreshConference({
    expectedOwnerEmail: 'alexander@asoldi.com',
    organizerEmail: 'alexander@asoldi.com',
    creatorEmail: BLOCKED_CALENDAR_GOOGLE_EMAIL,
    hangoutLink: meet,
  }), true);
  assert.equal(salesMeetNeedsFreshConference({
    expectedOwnerEmail: 'alexander@asoldi.com',
    organizerEmail: 'contact@asoldi.com',
    creatorEmail: 'contact@asoldi.com',
    hangoutLink: meet,
  }), true);
  assert.equal(salesMeetNeedsFreshConference({
    expectedOwnerEmail: 'alexander@asoldi.com',
    organizerEmail: '',
    creatorEmail: '',
    hangoutLink: '',
  }), true);
  const join = salesMeetJoinUrl(meet, 'alexander@asoldi.com');
  assert.match(join, /AccountChooser/);
  assert.match(join, /Email=alexander%40asoldi\.com/);
  assert.equal(salesMeetJoinUrl(meet, 'contact@asoldi.com'), meet);
  const during = new Date('2026-10-07T13:10:00.000Z').getTime();
  assert.equal(salesMeetingIsInProgress('2026-10-07T13:00:00.000Z', 60, during), true);
  assert.equal(salesMeetingIsInProgress('2026-10-08T12:00:00.000Z', 60, during), false);
});

test('a usable token cannot be the blocked Gmail mailbox', () => {
  assert.equal(calendarTokenIsUsable({
    refresh_token: 'x',
    googleEmail: BLOCKED_CALENDAR_GOOGLE_EMAIL,
  }, damianAdmin), false);
  assert.equal(calendarTokenIsUsable({
    refresh_token: 'x',
    googleEmail: 'damian@asoldi.com',
  }, darachaAdmin), false);
  assert.equal(calendarTokenIsUsable({
    refresh_token: 'x',
    googleEmail: 'damian@asoldi.com',
  }, damianAdmin), true);
});
