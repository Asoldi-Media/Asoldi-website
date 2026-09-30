import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attendeesToReinvite,
  buildEventSummary,
  buildGoogleCalendarInvitationSubject,
  buildMeetingAttendees,
  calendarInviteLeadMs,
  firefliesNotetakerEmail,
  shouldIncludeFireflies,
  withoutAttendeeEmails,
  toCalendarDateTime,
  calendarEventStartMatches,
  shouldForceCalendarRecreate,
} from '../lib/google-calendar.js';
import {
  GOOGLE_CALENDAR_OAUTH_EVENT,
  renderGoogleCalendarOAuthResultHtml,
} from '../lib/google-calendar-oauth-ui.js';

const client = {
  businessName: 'Test Bakeri',
  contactPerson: 'Damian',
  contactEmail: 'daracha777@gmail.com',
  meetingMode: 'online',
  meetingAt: '2026-09-21T08:00:00.000Z',
};

test('silent calendar creates do not include the guest', () => {
  assert.deepEqual(buildMeetingAttendees(client, { includeAttendees: false }), []);
});

test('invite send includes the guest as needsAction', () => {
  const attendees = buildMeetingAttendees(client, { includeAttendees: true });
  assert.equal(attendees.length, 1);
  assert.equal(attendees[0].email, 'daracha777@gmail.com');
  assert.equal(attendees[0].responseStatus, 'needsAction');
});

test('Fireflies is added only when the sales meeting asks for it', () => {
  const plain = buildMeetingAttendees(client, { includeAttendees: true, includeFireflies: false });
  assert.equal(plain.some((entry) => entry.email.endsWith('@fireflies.ai')), false);
  const withBot = buildMeetingAttendees(client, { includeAttendees: true, includeFireflies: true });
  assert.equal(withBot.length, 2);
  assert.equal(withBot[1].email, firefliesNotetakerEmail());
  const botOnly = buildMeetingAttendees(client, { includeAttendees: false, includeFireflies: true });
  assert.equal(botOnly.length, 1);
  assert.equal(botOnly[0].email, firefliesNotetakerEmail());
});

test('silent calendar creates do not add Fred until the invite is actually sent', () => {
  assert.equal(shouldIncludeFireflies({
    isOnline: true,
    addFireflies: true,
    sendUpdates: 'none',
    alreadyOnEvent: false,
  }), false);
  assert.equal(shouldIncludeFireflies({
    isOnline: true,
    addFireflies: true,
    sendUpdates: 'all',
    alreadyOnEvent: false,
  }), true);
  assert.equal(shouldIncludeFireflies({
    isOnline: true,
    addFireflies: false,
    sendUpdates: 'all',
    alreadyOnEvent: false,
  }), false);
  assert.equal(shouldIncludeFireflies({
    isOnline: false,
    addFireflies: true,
    sendUpdates: 'all',
    alreadyOnEvent: false,
  }), false);
});

test('silent updates keep Fred after he was already invited', () => {
  assert.equal(shouldIncludeFireflies({
    isOnline: true,
    addFireflies: false,
    sendUpdates: 'none',
    alreadyOnEvent: true,
  }), true);
  assert.equal(shouldIncludeFireflies({
    isOnline: true,
    addFireflies: true,
    sendUpdates: 'none',
    alreadyOnEvent: false,
  }), false);
});

test('Fred is stripped before a real invite if he was only saved on the event', () => {
  const current = [
    { email: 'daracha777@gmail.com' },
    { email: firefliesNotetakerEmail() },
  ];
  assert.deepEqual(
    attendeesToReinvite(current, ['daracha777@gmail.com', firefliesNotetakerEmail()]),
    ['daracha777@gmail.com', firefliesNotetakerEmail()]
  );
  const leftover = withoutAttendeeEmails(current, [firefliesNotetakerEmail()]);
  assert.equal(leftover.length, 1);
  assert.equal(leftover[0].email, 'daracha777@gmail.com');
});

test('Google invitation subject matches Gmail’s invite prefix', () => {
  const summary = buildEventSummary(client);
  const subject = buildGoogleCalendarInvitationSubject(client, 'Europe/Oslo');
  assert.match(summary, /Online møte/);
  assert.match(subject, /^Invitasjon: Asoldi · Online møte · Test Bakeri @ /);
});

test('calendar invite lead defaults to 8s and can be disabled', () => {
  const previous = process.env.CALENDAR_INVITE_LEAD_MS;
  delete process.env.CALENDAR_INVITE_LEAD_MS;
  assert.equal(calendarInviteLeadMs(), 8000);
  process.env.CALENDAR_INVITE_LEAD_MS = '0';
  assert.equal(calendarInviteLeadMs(), 0);
  if (previous == null) delete process.env.CALENDAR_INVITE_LEAD_MS;
  else process.env.CALENDAR_INVITE_LEAD_MS = previous;
});

test('OAuth success page tells the sales tab the calendar is connected', () => {
  const html = renderGoogleCalendarOAuthResultHtml({
    ok: true,
    googleEmail: 'rep@asoldi.com',
    googleName: 'Rep',
    tokenUpdatedAt: '2026-09-28T09:00:00.000Z',
  });
  assert.match(html, /Google Calendar connected as rep@asoldi\.com/);
  assert.match(html, /BroadcastChannel/);
  assert.match(html, /window\.opener\.postMessage/);
  assert.match(html, /localStorage\.setItem/);
  assert.match(html, new RegExp(GOOGLE_CALENDAR_OAUTH_EVENT));
  assert.match(html, /"connected":true/);
  assert.match(html, /window\.close\(\)/);
});

test('OAuth failure page tells the sales tab the connect did not finish', () => {
  const html = renderGoogleCalendarOAuthResultHtml({
    ok: false,
    error: 'Invalid or expired OAuth state.',
  });
  assert.match(html, /Invalid or expired OAuth state/);
  assert.match(html, /"connected":false/);
  assert.match(html, /BroadcastChannel/);
});

test('calendar event dateTimes are Oslo wall clock without a Z suffix', () => {
  assert.equal(toCalendarDateTime('2026-10-01T13:00:00.000Z', 'Europe/Oslo'), '2026-10-01T15:00:00');
  assert.equal(toCalendarDateTime('2026-10-07T13:00:00.000Z', 'Europe/Oslo'), '2026-10-07T15:00:00');
});

test('calendar start match detects a stale event that never moved', () => {
  const want = '2026-10-01T13:00:00.000Z';
  assert.equal(calendarEventStartMatches({ start: { dateTime: '2026-10-01T15:00:00+02:00' } }, want), true);
  assert.equal(calendarEventStartMatches({ start: { dateTime: '2026-09-14T09:00:00+02:00' } }, want), false);
});

test('an already-created calendar event is recreated when the meeting time changes', () => {
  assert.equal(
    shouldForceCalendarRecreate('2026-09-14T09:00:00.000Z', '2026-10-01T13:00:00.000Z', 'evt-1'),
    true
  );
  assert.equal(
    shouldForceCalendarRecreate('2026-10-01T13:00:00.000Z', '2026-10-01T13:00:00.000Z', 'evt-1'),
    false
  );
  assert.equal(
    shouldForceCalendarRecreate('2026-09-14T09:00:00.000Z', '2026-10-01T13:00:00.000Z', ''),
    false
  );
});
