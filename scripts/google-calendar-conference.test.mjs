// A re-inserted calendar event keeps its Meet room as conferenceData (CAL-8), and the hub asks
// the Meet API to open rooms on events the host's own OAuth login organizes. google.calendar
// and google.meet are stubs; a socket spy refuses anything non-loopback.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-cal-conference-'));
process.env.APP_DATA_DIR = dataDir;
Object.assign(process.env, {
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'http://127.0.0.1:3001/api/admin/sales/google/oauth/callback',
  GOOGLE_CALENDAR_TIMEZONE: 'Europe/Oslo',
});
delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON;
delete process.env.FIREFLIES_NOTETAKER_EMAIL;

const leakedSockets = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function testNetSpy(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = String((first && typeof first === 'object' ? first.host : args[1]) || 'localhost');
  if (/^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(host)) return realConnect.apply(this, args);
  leakedSockets.push(host);
  process.nextTick(() => this.destroy(Object.assign(new Error(`test spy refused ${host}`), { code: 'ETESTLEAK' })));
  return this;
};

const calendar = await import('../lib/google-calendar.js');
const meet = await import('../lib/google-meet-access.js');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const HOST = 'alexander@asoldi.com';
const ROOM = 'https://meet.google.com/abc-defg-hij';
const OLD_START = '2026-10-26T09:00:00.000Z';
const NEW_START = '2026-10-27T13:00:00.000Z';
const BASE_SCOPES = 'openid https://www.googleapis.com/auth/calendar.events';
const ROOM_CONFERENCE = {
  conferenceId: 'abc-defg-hij',
  conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
  entryPoints: [{ entryPointType: 'video', uri: ROOM, label: 'meet.google.com/abc-defg-hij' }],
  createRequest: { requestId: 'req-old', conferenceSolutionKey: { type: 'hangoutsMeet' }, status: { statusCode: 'success' } },
  signature: 'signature-test',
};
const ROOM_COPY = (() => {
  const copy = structuredClone(ROOM_CONFERENCE);
  delete copy.createRequest;
  return copy;
})();
const ROOM_FROM_CODE = {
  conferenceId: 'abc-defg-hij',
  conferenceSolution: { key: { type: 'hangoutsMeet' } },
  entryPoints: [{ entryPointType: 'video', uri: ROOM, label: 'meet.google.com/abc-defg-hij' }],
};

function writeTokens(scope = BASE_SCOPES) {
  writeFileSync(join(dataDir, 'google-calendar-tokens.json'), JSON.stringify({
    'sales:rep-1': { access_token: 'at-test', refresh_token: 'rt-test', googleEmail: HOST, scope },
  }));
}

function googleError(status, message = 'Google error') {
  return Object.assign(new Error(message), { code: status, response: { status } });
}

function osloWallClock(iso) {
  return { dateTime: calendar.toCalendarDateTime(iso, 'Europe/Oslo'), timeZone: 'Europe/Oslo' };
}

function bookedEvent(id, { start = OLD_START, conferenceData = ROOM_CONFERENCE } = {}) {
  return {
    id,
    summary: 'Asoldi · Online møte · Testfirma AS',
    status: 'confirmed',
    start: osloWallClock(start),
    end: osloWallClock(new Date(Date.parse(start) + 3600e3).toISOString()),
    organizer: { email: HOST },
    creator: { email: HOST },
    attendees: [{ email: 'kari@example.com' }],
    conferenceData,
    hangoutLink: conferenceData?.entryPoints?.[0]?.uri,
  };
}

/** Google Calendar v3 events stub with just enough behaviour for upsertMeetingEvent. */
function fakeCalendar({ events = {}, organizer = HOST, refuseConferenceCopy = false, patchKeepsStart = false } = {}) {
  const store = new Map(Object.entries(events).map(([id, event]) => [id, structuredClone(event)]));
  const calls = [];
  let created = 0;
  let minted = 0;
  const conferenceFor = (requestBody, version) => {
    const data = requestBody?.conferenceData;
    if (!data || version !== 1) return null;
    if (data.createRequest) {
      minted += 1;
      const uri = `https://meet.google.com/new-mint-00${minted}`;
      return { conferenceId: `new-mint-00${minted}`, conferenceSolution: { key: { type: 'hangoutsMeet' } }, entryPoints: [{ entryPointType: 'video', uri }] };
    }
    if (refuseConferenceCopy) throw googleError(Number(refuseConferenceCopy), 'Invalid conference data.');
    return structuredClone(data);
  };
  const save = (event, conferenceData) => {
    const next = { ...event };
    if (conferenceData) {
      next.conferenceData = conferenceData;
      next.hangoutLink = conferenceData.entryPoints[0].uri;
    }
    store.set(next.id, next);
    return { data: structuredClone(next) };
  };
  const api = {
    events: {
      async get({ eventId }) {
        calls.push({ op: 'get', eventId });
        const event = store.get(eventId);
        if (!event) throw googleError(404, 'Not Found');
        return { data: structuredClone(event) };
      },
      async delete({ eventId, sendUpdates }) {
        calls.push({ op: 'delete', eventId, sendUpdates });
        const event = store.get(eventId);
        if (!event) throw googleError(410, 'Resource has been deleted');
        store.set(eventId, { ...event, status: 'cancelled' });
        return { data: '' };
      },
      async insert({ requestBody, sendUpdates, conferenceDataVersion }) {
        calls.push({ op: 'insert', requestBody: structuredClone(requestBody), sendUpdates, conferenceDataVersion });
        const conferenceData = conferenceFor(requestBody, conferenceDataVersion);
        created += 1;
        const body = structuredClone(requestBody);
        delete body.conferenceData;
        return save({ ...body, id: `evt-new-${created}`, status: 'confirmed', organizer: { email: organizer }, creator: { email: organizer }, htmlLink: '' }, conferenceData);
      },
      async patch({ eventId, requestBody, sendUpdates, conferenceDataVersion }) {
        calls.push({ op: 'patch', eventId, requestBody: structuredClone(requestBody), sendUpdates, conferenceDataVersion });
        const event = store.get(eventId);
        if (!event) throw googleError(404, 'Not Found');
        const body = structuredClone(requestBody);
        delete body.conferenceData;
        const next = { ...event, ...body };
        if (patchKeepsStart) {
          next.start = event.start;
          next.end = event.end;
        }
        return save(next, requestBody.conferenceData ? conferenceFor(requestBody, conferenceDataVersion) : null);
      },
    },
  };
  return { api, calls, store, ops: () => calls.map((call) => `${call.op}${call.eventId ? `:${call.eventId}` : ''}`) };
}

function fakeMeet() {
  const calls = [];
  return {
    calls,
    spaces: {
      async get(params) {
        calls.push({ kind: 'get', params });
        return { data: { name: 'spaces/sp-test-1', config: { accessType: 'TRUSTED' } } };
      },
      async patch(params) {
        calls.push({ kind: 'patch', params });
        return { data: { name: params.name, config: { accessType: 'OPEN' } } };
      },
    },
  };
}

function bookedClient(extra = {}) {
  return {
    id: 'c-test-1',
    businessName: 'Testfirma AS',
    contactPerson: 'Kari Test',
    contactEmail: 'kari@example.com',
    meetingMode: 'online',
    meetingAt: NEW_START,
    calendar: { eventId: '', meetLink: ROOM, confirmedMeetLink: ROOM },
    ...extra,
  };
}

function useFakes({ calendarApi, meetApi = fakeMeet() }) {
  mock.method(google, 'calendar', () => calendarApi);
  mock.method(google, 'meet', () => meetApi);
  return meetApi;
}

test.beforeEach(() => {
  rmSync(join(dataDir, 'meet-room-access.json'), { force: true });
  clearJsonCacheForTests();
  meet.resetMeetRoomAccessForTests();
  writeTokens();
});

test.afterEach(async () => {
  await meet.settleMeetRoomOpensForTests();
  mock.restoreAll();
});

function insertsOf(fake) {
  return fake.calls.filter((call) => call.op === 'insert');
}

test('a time change deletes and re-inserts the event with a copy of the room’s conferenceData', async () => {
  const fake = fakeCalendar({ events: { 'evt-1': bookedEvent('evt-1') } });
  useFakes({ calendarApi: fake.api });
  const meta = await calendar.upsertMeetingEvent(bookedClient({ calendar: { eventId: 'evt-1', meetLink: ROOM, confirmedMeetLink: ROOM } }), 'evt-1', 'sales:rep-1', {
    sendUpdates: 'all',
    includeAttendees: true,
    forceRecreate: true,
    lockedMeetLink: ROOM,
    expectedOwnerEmail: HOST,
  });
  assert.deepEqual(fake.ops().slice(0, 3), ['get:evt-1', 'delete:evt-1', 'insert']);
  const [insert] = insertsOf(fake);
  assert.equal(insert.conferenceDataVersion, 1);
  assert.deepEqual(insert.requestBody.conferenceData, ROOM_COPY, 'the old conference, without its createRequest');
  assert.equal(insert.requestBody.location, ROOM);
  assert.equal(insert.requestBody.start.dateTime, '2026-10-27T14:00:00');
  assert.equal(meta.meetLink, ROOM);
  assert.equal(meta.eventId, 'evt-new-1');
  assert.equal(fake.store.get('evt-new-1').hangoutLink, ROOM, 'the new event is joined to the same room');
});

test('a patch that leaves the old start is replaced by an insert that keeps the room', async () => {
  const fake = fakeCalendar({ events: { 'evt-2': bookedEvent('evt-2') }, patchKeepsStart: true });
  useFakes({ calendarApi: fake.api });
  const meta = await calendar.upsertMeetingEvent(bookedClient({ calendar: { eventId: 'evt-2', meetLink: ROOM, confirmedMeetLink: ROOM } }), 'evt-2', 'sales:rep-1', {
    sendUpdates: 'none',
    lockedMeetLink: ROOM,
  });
  assert.ok(fake.ops().includes('patch:evt-2'));
  assert.ok(fake.ops().includes('delete:evt-2'));
  const [insert] = insertsOf(fake);
  assert.equal(insert.conferenceDataVersion, 1);
  assert.deepEqual(insert.requestBody.conferenceData, ROOM_COPY);
  assert.equal(meta.meetLink, ROOM);
});

test('an event that is gone (or lived on another mailbox) is re-inserted with the room built from its code', async () => {
  const fake = fakeCalendar();
  useFakes({ calendarApi: fake.api });
  const gone = await calendar.upsertMeetingEvent(bookedClient(), 'evt-gone', 'sales:rep-1', { sendUpdates: 'none', lockedMeetLink: ROOM });
  assert.deepEqual(fake.ops().slice(0, 3), ['get:evt-gone', 'patch:evt-gone', 'insert']);
  assert.deepEqual(insertsOf(fake)[0].requestBody.conferenceData, ROOM_FROM_CODE);
  assert.equal(insertsOf(fake)[0].conferenceDataVersion, 1);
  assert.equal(gone.meetLink, ROOM);

  // Owner move: server.js deletes the event on the old mailbox and asks for a fresh insert.
  const moved = await calendar.upsertMeetingEvent(bookedClient(), '', 'sales:rep-1', { sendUpdates: 'all', includeAttendees: true, lockedMeetLink: ROOM });
  const second = insertsOf(fake)[1];
  assert.deepEqual(second.requestBody.conferenceData, ROOM_FROM_CODE);
  assert.equal(second.sendUpdates, 'all');
  assert.equal(moved.meetLink, ROOM);
});

test('if Google refuses the kept conference, the insert falls back to the link in location', async () => {
  for (const status of [400, 403]) {
    const fake = fakeCalendar({ refuseConferenceCopy: status });
    useFakes({ calendarApi: fake.api });
    const meta = await calendar.upsertMeetingEvent(bookedClient(), '', 'sales:rep-1', { sendUpdates: 'all', includeAttendees: true, lockedMeetLink: ROOM });
    const [refused, plain] = insertsOf(fake);
    assert.equal(refused.conferenceDataVersion, 1, `${status}`);
    assert.equal(plain.conferenceDataVersion, 0);
    assert.equal(plain.requestBody.conferenceData, undefined);
    assert.equal(plain.requestBody.location, ROOM);
    assert.equal(insertsOf(fake).length, 2, 'one refused attempt, one plain insert');
    assert.equal(meta.meetLink, ROOM);
    assert.equal(meta.eventId, 'evt-new-1');
    await meet.settleMeetRoomOpensForTests();
    mock.restoreAll();
  }
  // Any other failure is the sync's own error, as before: no second insert.
  const broken = fakeCalendar({ refuseConferenceCopy: 500 });
  useFakes({ calendarApi: broken.api });
  await assert.rejects(
    () => calendar.upsertMeetingEvent(bookedClient(), '', 'sales:rep-1', { sendUpdates: 'all', includeAttendees: true, lockedMeetLink: ROOM }),
    /Invalid conference data/,
  );
  assert.equal(insertsOf(broken).length, 1);
});

test('a booking without a room still mints a new one, and forceNewMeet never copies the old room', async () => {
  const fake = fakeCalendar({ events: { 'evt-3': bookedEvent('evt-3') } });
  useFakes({ calendarApi: fake.api });
  const fresh = await calendar.upsertMeetingEvent(bookedClient({ calendar: {} }), '', 'sales:rep-1', {
    sendUpdates: 'all',
    includeAttendees: true,
    expectedOwnerEmail: HOST,
  });
  const [mint] = insertsOf(fake);
  assert.equal(mint.conferenceDataVersion, 1);
  assert.ok(mint.requestBody.conferenceData.createRequest.requestId);
  assert.equal(fresh.meetLink, 'https://meet.google.com/new-mint-001');
  assert.equal(fresh.meetHostVerifiedEmail, HOST);

  const forced = await calendar.upsertMeetingEvent(bookedClient({ calendar: { eventId: 'evt-3', meetLink: ROOM } }), 'evt-3', 'sales:rep-1', {
    sendUpdates: 'all',
    includeAttendees: true,
    forceRecreate: true,
    forceNewMeet: true,
    expectedOwnerEmail: HOST,
  });
  const remint = insertsOf(fake)[1];
  assert.ok(remint.requestBody.conferenceData.createRequest, 'a new room is requested');
  assert.equal(remint.requestBody.conferenceData.conferenceId, undefined);
  assert.equal(forced.meetLink, 'https://meet.google.com/new-mint-002');
});

test('an offline meeting never gets a conference', async () => {
  const fake = fakeCalendar();
  useFakes({ calendarApi: fake.api });
  const meta = await calendar.upsertMeetingEvent(bookedClient({ meetingMode: 'physical', meetingPlace: 'Storgata 1, Oslo' }), '', 'sales:rep-1', { sendUpdates: 'none' });
  const [insert] = insertsOf(fake);
  assert.equal(insert.requestBody.conferenceData, undefined);
  assert.equal(insert.conferenceDataVersion, 0);
  assert.equal(meta.meetLink, '');
});

test('a recorded Møte whose event is gone is re-inserted with its room as a conference', async () => {
  const fake = fakeCalendar();
  useFakes({ calendarApi: fake.api });
  const action = { id: 'act-1', name: 'Møte', dueAt: NEW_START, meetLink: ROOM, calendarEventId: 'evt-gone' };
  const meta = await calendar.upsertRecordedSalesActionEvent(bookedClient(), action, '', 'sales:rep-1');
  assert.deepEqual(fake.ops().slice(0, 2), ['patch:evt-gone', 'insert']);
  const [insert] = insertsOf(fake);
  assert.equal(insert.conferenceDataVersion, 1);
  assert.deepEqual(insert.requestBody.conferenceData, ROOM_FROM_CODE);
  assert.equal(insert.requestBody.location, ROOM);
  assert.equal(meta.meetLink, ROOM);
});

test('kept conference data: a copy of the same room, else one built from the code, else nothing', () => {
  assert.deepEqual(calendar.keptMeetConferenceData(ROOM, ROOM_CONFERENCE), ROOM_COPY);
  assert.deepEqual(calendar.keptMeetConferenceData(`${ROOM}?authuser=1`, null), ROOM_FROM_CODE);
  const otherRoom = { ...ROOM_CONFERENCE, entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/zzz-yyyy-xxx' }] };
  assert.deepEqual(calendar.keptMeetConferenceData(ROOM, otherRoom), ROOM_FROM_CODE, 'never another room’s conference');
  assert.equal(calendar.keptMeetConferenceData('https://meet.google.com/safe-mode', ROOM_CONFERENCE), null);
  assert.equal(calendar.keptMeetConferenceData('', null), null);
});

test('after the upsert, the organizer’s own OAuth login opens the room in the background', async () => {
  writeTokens(`${BASE_SCOPES} ${meet.MEET_SETTINGS_SCOPE}`);
  const fake = fakeCalendar({ events: { 'evt-4': bookedEvent('evt-4') } });
  const meetApi = useFakes({ calendarApi: fake.api });
  await calendar.upsertMeetingEvent(bookedClient({ calendar: { eventId: 'evt-4', meetLink: ROOM } }), 'evt-4', 'sales:rep-1', { sendUpdates: 'none', lockedMeetLink: ROOM });
  await meet.settleMeetRoomOpensForTests();
  assert.deepEqual(meetApi.calls.map((call) => call.kind), ['get', 'patch']);
  assert.equal(meetApi.calls[0].params.name, 'spaces/abc-defg-hij');
  const status = meet.meetRoomAccessStatus(ROOM);
  assert.deepEqual([status.ok, status.accessType, status.ownerKey], [true, 'OPEN', 'sales:rep-1']);

  // The recorded Møte path does the same for its own room.
  const actionRoom = 'https://meet.google.com/mte-room-abc';
  await calendar.upsertRecordedSalesActionEvent(bookedClient(), { id: 'act-2', name: 'Møte', dueAt: NEW_START, meetLink: actionRoom }, '', 'sales:rep-1');
  await meet.settleMeetRoomOpensForTests();
  assert.equal(meet.meetRoomAccessStatus(actionRoom)?.ok, true);
});

test('without the scope the room is recorded as scope-missing, and the sync result is unchanged', async () => {
  const fake = fakeCalendar({ events: { 'evt-5': bookedEvent('evt-5') } });
  const meetApi = useFakes({ calendarApi: fake.api });
  const meta = await calendar.upsertMeetingEvent(bookedClient({ calendar: { eventId: 'evt-5', meetLink: ROOM } }), 'evt-5', 'sales:rep-1', { sendUpdates: 'none', lockedMeetLink: ROOM });
  await meet.settleMeetRoomOpensForTests();
  assert.equal(meetApi.calls.length, 0);
  assert.equal(meet.meetRoomAccessStatus(ROOM)?.reason, 'scope-missing');
  assert.equal(meta.meetLink, ROOM);
  assert.equal(Object.hasOwn(meta, 'meetRoom'), false, 'the calendar meta stays as it was');
});

test('no room is touched for an event another mailbox organizes', async () => {
  writeTokens(`${BASE_SCOPES} ${meet.MEET_SETTINGS_SCOPE}`);
  const fake = fakeCalendar({ organizer: 'damian@asoldi.com' });
  const meetApi = useFakes({ calendarApi: fake.api });
  await calendar.upsertMeetingEvent(bookedClient(), '', 'sales:rep-1', { sendUpdates: 'none', lockedMeetLink: ROOM });
  await meet.settleMeetRoomOpensForTests();
  assert.equal(meetApi.calls.length, 0);
  assert.equal(meet.meetRoomAccessStatus(ROOM), null);
});

test('no test request leaked past the stubs to a real socket', () => {
  assert.deepEqual(leakedSockets, []);
});
