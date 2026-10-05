import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  presentCalendarEvent,
  resolveSalesCalendarPreviewAccountKey,
  resolveSalesCalendarWeekSources,
  googleCalendarOauthScopes,
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

test('sales calendar preview uses the filtered owner only for admin', () => {
  assert.equal(
    resolveSalesCalendarPreviewAccountKey({
      actorAccountKey: 'admin:damian@asoldi.com',
      isAdmin: true,
      ownerId: 'sales:alexander',
    }),
    'sales:alexander'
  );
  assert.equal(
    resolveSalesCalendarPreviewAccountKey({
      actorAccountKey: 'sales:alexander',
      isAdmin: false,
      ownerId: 'sales:someone-else',
    }),
    'sales:alexander'
  );
  assert.equal(
    resolveSalesCalendarPreviewAccountKey({
      actorAccountKey: 'admin:damian@asoldi.com',
      isAdmin: true,
      ownerId: 'unassigned',
    }),
    'admin:damian@asoldi.com'
  );
});

test('calendar event details keep the title for sales even when Google embed would say Opptatt', () => {
  const shown = presentCalendarEvent({
    id: 'evt-1',
    summary: 'Asoldi · Online møte · Bakeri',
    start: { dateTime: '2026-09-30T07:00:00.000Z' },
    end: { dateTime: '2026-09-30T07:30:00.000Z' },
    location: 'Meet',
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    htmlLink: 'https://www.google.com/calendar/event?eid=1',
  });
  assert.equal(shown.summary, 'Asoldi · Online møte · Bakeri');
  assert.equal(shown.meetLink, 'https://meet.google.com/abc-defg-hij');
  assert.equal(presentCalendarEvent({ start: { dateTime: '2026-09-30T07:00:00.000Z' } }).summary, 'Opptatt');
});

test('sales calendar oauth asks to read the whole calendar, not only events the app created', () => {
  const scopes = googleCalendarOauthScopes();
  assert.equal(scopes.includes('https://www.googleapis.com/auth/calendar.events'), true);
  assert.equal(scopes.includes('https://www.googleapis.com/auth/calendar.readonly'), true);
  assert.equal(scopes.includes('https://www.googleapis.com/auth/calendar.acls'), true);
  assert.equal(scopes.includes('https://www.googleapis.com/auth/gmail.readonly'), true);
});

test('admin week view uses the filtered rep, or the logged-in admin mailbox', () => {
  assert.deepEqual(
    resolveSalesCalendarWeekSources({
      actorAccountKey: 'admin:damian@asoldi.com',
      isAdmin: true,
      ownerId: 'sales:alexander',
      connectedSources: [
        { accountKey: 'admin:damian@asoldi.com', googleEmail: 'damian@asoldi.com' },
        { accountKey: 'sales:alexander', googleEmail: 'alexander@asoldi.com' },
      ],
    }),
    [{ accountKey: 'sales:alexander', googleEmail: 'alexander@asoldi.com' }]
  );
  assert.deepEqual(
    resolveSalesCalendarWeekSources({
      actorAccountKey: 'admin:damian@asoldi.com',
      isAdmin: true,
      ownerId: '',
      connectedSources: [
        { accountKey: 'admin:damian@asoldi.com', googleEmail: 'damian@asoldi.com' },
        { accountKey: 'sales:alexander', googleEmail: 'alexander@asoldi.com' },
      ],
    }),
    [{ accountKey: 'admin:damian@asoldi.com', googleEmail: 'damian@asoldi.com' }]
  );
  assert.deepEqual(
    resolveSalesCalendarWeekSources({
      actorAccountKey: 'sales:alexander',
      isAdmin: false,
      ownerId: 'sales:someone-else',
      connectedSources: [
        { accountKey: 'sales:alexander', googleEmail: 'alexander@asoldi.com' },
        { accountKey: 'admin:damian@asoldi.com', googleEmail: 'damian@asoldi.com' },
      ],
    }),
    [{ accountKey: 'sales:alexander', googleEmail: 'alexander@asoldi.com' }]
  );
});

test('sales header calendar is an on-site week grid and never iframes Google Calendar', () => {
  const weekSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app/pages/Admin/sections/SalesCalendarWeek.tsx'), 'utf8');
  assert.match(weekSrc, /admin\/sales\/google\/events/);
  assert.match(weekSrc, /CALENDAR_FETCH_TIMEOUT_MS = 8000/);
  assert.equal(weekSrc.includes('<iframe'), false);
  assert.equal(weekSrc.includes('calendar.google.com'), false);
  const salesSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app/pages/Admin/sections/SalesClientsSection.tsx'), 'utf8');
  assert.match(salesSrc, /<SalesCalendarWeek/);
  assert.doesNotMatch(salesSrc, /google\/embed/);
  assert.doesNotMatch(salesSrc, /google\/events/);
  const googleSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/google-calendar.js'), 'utf8');
  assert.match(googleSrc, /primaryOnly: true/);
  assert.match(googleSrc, /CALENDAR_EVENTS_TIMEOUT_MS/);
  assert.match(googleSrc, /CALENDAR_WEEK_TIMEOUT_MS/);
  assert.match(googleSrc, /GOOGLE_CALENDAR_HTTP_TIMEOUT_MS/);
  assert.match(googleSrc, /\.slice\(0, 1\)/);
});

test('calendar embed and week reads never wait on Google ACL or visibility patches', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/google-calendar.js'), 'utf8');
  const embedStart = src.indexOf('export async function prepareSalesCalendarEmbed');
  assert.ok(embedStart >= 0);
  const embedBody = src.slice(embedStart, embedStart + 450);
  assert.match(embedBody, /embedPayloadFromStatus/);
  assert.equal(embedBody.includes('getAuthorizedClient'), false);
  assert.equal(embedBody.includes('ensureEmbedSharing'), false);
  assert.doesNotMatch(src, /await publishAsoldiEventVisibility/);
});

test('sales page load does not call Google Calendar', () => {
  const workspace = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app/pages/sales/SalesWorkspace.tsx'), 'utf8');
  assert.match(workspace, /admin\/sales\/session/);
  assert.doesNotMatch(workspace, /google\/status/);
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../server.js'), 'utf8');
  assert.match(server, /app\.get\('\/api\/health'/);
  assert.match(server, /app\.get\('\/api\/admin\/sales\/session'/);
  assert.equal(server.includes('migrateFutureMeetingsOffBlockedCalendar().catch'), false);
  const salesList = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app/pages/Admin/sections/SalesClientsSection.tsx'), 'utf8');
  assert.match(salesList, /if \(!mapMounted\) return undefined;/);
});
