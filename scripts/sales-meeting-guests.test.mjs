// Meeting guests on the card (data/sales.js) and a calendar sync that never drops them
// (lib/google-calendar.js). google.calendar is a stub; a socket spy refuses non-loopback traffic.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-meeting-guests-'));
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

const sales = await import('../data/sales.js');
const calendar = await import('../lib/google-calendar.js');
const meet = await import('../lib/google-meet-access.js');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');

test.after(() => {
  net.Socket.prototype.connect = realConnect;
  rmSync(dataDir, { recursive: true, force: true });
  assert.deepEqual(leakedSockets, []);
});

const HOST = 'alexander@asoldi.com';
const OLD_START = '2026-11-17T12:00:00.000Z';
const NEW_START = '2026-11-18T11:00:00.000Z';
const OLA = 'ola@kunde.example';
const KARI = 'kari@partner.example';

// ---------------------------------------------------------------------------
// data/sales.js
// ---------------------------------------------------------------------------

let seq = 0;
function seedCard(extra = {}) {
  seq += 1;
  const id = `guests-${seq}`;
  sales.createSalesClient({
    id,
    businessName: `Biz ${id}`,
    contactPerson: 'Ola Nordmann',
    contactEmail: OLA,
    clientEmail: 'ola.konto@kunde.example',
    product: 'asoldi',
    ownerId: 'sales:rep1',
    meetingMode: 'online',
    agreedTime: true,
    meetingAt: OLD_START,
    meetingAtSource: 'sales',
    ...extra,
  });
  return sales.getSalesClientById(id);
}

test('old cards get an empty guest list without a migration', () => {
  const card = seedCard();
  assert.deepEqual(card.meetingGuests, []);
});

test('normalizeMeetingGuests lowercases, validates, dedupes, applies exclusions and caps at 10', () => {
  const client = { contactEmail: OLA, clientEmail: 'ola.konto@kunde.example', websiteEmail: 'post@kunde.example' };
  const raw = [
    { email: ' Kari@Partner.Example ', name: 'Kari Hansen', addedBy: 'bot', addedAt: '2026-11-17T10:00:00.000Z' },
    { email: KARI, name: 'Duplicate' },
    { email: 'not-an-email' },
    { email: OLA.toUpperCase() },
    { email: 'ola.konto@kunde.example' },
    { email: 'post@kunde.example' },
    { email: 'damian@asoldi.com' },
    { email: 'fred@fireflies.ai' },
    { email: 'x@y.example', addedBy: 'weird' },
  ];
  const out = sales.normalizeMeetingGuests(raw, client);
  assert.deepEqual(out.map((guest) => guest.email), [KARI, 'x@y.example']);
  assert.equal(out[0].name, 'Kari Hansen');
  assert.equal(out[0].addedBy, 'bot');
  assert.equal(out[1].addedBy, 'rep', 'an unknown source falls back to rep');
  const many = Array.from({ length: 15 }, (_, i) => ({ email: `g${i}@partner.example` }));
  const capped = sales.normalizeMeetingGuests(many, client);
  assert.equal(capped.length, 10);
  assert.equal(capped[0].email, 'g0@partner.example', 'the first ten are kept');
});

test('addSalesMeetingGuests reports added, already and rejected, and removeSalesMeetingGuest takes one off', () => {
  const card = seedCard();
  const first = sales.addSalesMeetingGuests(card.id, [{ email: 'Kari@Partner.Example', name: 'Kari Hansen' }], { addedBy: 'bot' });
  assert.deepEqual(first.added, [KARI]);
  assert.equal(first.client.meetingGuests[0].addedBy, 'bot');
  assert.equal(first.client.meetingGuests[0].invitedAt, '');
  assert.ok(first.client.meetingGuests[0].addedAt);

  const second = sales.addSalesMeetingGuests(card.id, [{ email: KARI }, { email: OLA }, { email: 'nope' }, { email: 'a@asoldi.com' }]);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.already, [KARI]);
  assert.deepEqual(second.rejected.map((row) => `${row.email}:${row.reason}`), [`${OLA}:contact`, 'nope:invalid', 'a@asoldi.com:excluded']);

  assert.equal(sales.addSalesMeetingGuests('missing-card', [{ email: KARI }]), null);

  const removed = sales.removeSalesMeetingGuest(card.id, KARI.toUpperCase());
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.client.meetingGuests, []);
  assert.equal(sales.removeSalesMeetingGuest(card.id, KARI).removed, false);
  assert.equal(sales.removeSalesMeetingGuest('missing-card', KARI), null);
});

test('the limit of ten guests is reported as a rejection', () => {
  const card = seedCard();
  const guests = Array.from({ length: 11 }, (_, i) => ({ email: `g${i}@partner.example` }));
  const result = sales.addSalesMeetingGuests(card.id, guests);
  assert.equal(result.added.length, 10);
  assert.deepEqual(result.rejected, [{ email: 'g10@partner.example', reason: 'limit' }]);
});

test('markSalesMeetingGuestsInvited stamps, and voiding the meeting keeps the guests but clears invitedAt', () => {
  const card = seedCard();
  sales.addSalesMeetingGuests(card.id, [{ email: KARI, name: 'Kari Hansen' }]);
  const stamp = '2026-11-17T09:00:00.000Z';
  const marked = sales.markSalesMeetingGuestsInvited(card.id, [KARI], stamp);
  assert.equal(marked.meetingGuests[0].invitedAt, stamp);
  const voided = sales.voidSalesMeetingTime(card.id, { note: 'test', nowMs: Date.parse('2026-11-18T08:00:00.000Z') });
  assert.equal(voided.meetingGuests.length, 1);
  assert.equal(voided.meetingGuests[0].email, KARI);
  assert.equal(voided.meetingGuests[0].invitedAt, '');
  assert.equal(voided.meetingGuests[0].name, 'Kari Hansen');
});

// ---------------------------------------------------------------------------
// lib/google-calendar.js
// ---------------------------------------------------------------------------

test('buildMeetingAttendees puts the guests after the contact, with their name', () => {
  const client = { contactEmail: OLA, contactPerson: 'Ola Nordmann', meetingGuests: [{ email: KARI, name: 'Kari Hansen' }, { email: OLA }] };
  const list = calendar.buildMeetingAttendees(client, { includeAttendees: true, includeFireflies: false });
  assert.deepEqual(list.map((entry) => entry.email), [OLA, KARI]);
  assert.equal(list[1].displayName, 'Kari Hansen');
  assert.deepEqual(calendar.buildMeetingAttendees(client, { includeAttendees: false }), [], 'no guests before the invite goes out');
});

function writeTokens() {
  writeFileSync(join(dataDir, 'google-calendar-tokens.json'), JSON.stringify({
    'sales:rep-1': {
      access_token: 'at-test',
      refresh_token: 'rt-test',
      googleEmail: HOST,
      scope: 'openid https://www.googleapis.com/auth/calendar.events',
    },
  }));
}

function googleError(status, message = 'Google error') {
  return Object.assign(new Error(message), { code: status, response: { status } });
}

function osloWallClock(iso) {
  return { dateTime: calendar.toCalendarDateTime(iso, 'Europe/Oslo'), timeZone: 'Europe/Oslo' };
}

function liveEvent(id, { start = OLD_START, attendees = [], status = 'confirmed' } = {}) {
  return {
    id,
    summary: 'Asoldi · Fysisk møte · Testfirma AS',
    status,
    start: osloWallClock(start),
    end: osloWallClock(new Date(Date.parse(start) + 3600e3).toISOString()),
    organizer: { email: HOST },
    creator: { email: HOST },
    attendees,
  };
}

function fakeCalendar(events = {}) {
  const store = new Map(Object.entries(events).map(([id, event]) => [id, structuredClone(event)]));
  const calls = [];
  let created = 0;
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
      async insert({ requestBody, sendUpdates }) {
        calls.push({ op: 'insert', requestBody: structuredClone(requestBody), sendUpdates });
        created += 1;
        const body = structuredClone(requestBody);
        const event = { ...body, id: `evt-new-${created}`, status: 'confirmed', organizer: { email: HOST }, creator: { email: HOST }, htmlLink: '' };
        store.set(event.id, event);
        return { data: structuredClone(event) };
      },
      async patch({ eventId, requestBody, sendUpdates }) {
        calls.push({ op: 'patch', eventId, requestBody: structuredClone(requestBody), sendUpdates });
        const event = store.get(eventId);
        if (!event) throw googleError(404, 'Not Found');
        const next = { ...event, ...structuredClone(requestBody) };
        store.set(eventId, next);
        return { data: structuredClone(next) };
      },
    },
  };
  return { api, calls, store };
}

function bookedClient(extra = {}) {
  return {
    id: 'c-guests-1',
    businessName: 'Testfirma AS',
    contactPerson: 'Ola Nordmann',
    contactEmail: OLA,
    meetingMode: 'in-person',
    meetingPlace: 'Storgata 1, Oslo',
    meetingAt: NEW_START,
    meetingGuests: [],
    calendar: { eventId: 'evt-1' },
    ...extra,
  };
}

const emails = (attendees) => attendees.map((entry) => entry.email);

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

const COLLEAGUE = { email: KARI, displayName: 'Kari Hansen', responseStatus: 'accepted' };
const CONTACT_LIVE = { email: OLA, displayName: 'Ola Nordmann', responseStatus: 'accepted' };

test('a hand-added live attendee survives a patch with includeAttendees, and is reported as foreign', async () => {
  const fake = fakeCalendar({ 'evt-1': liveEvent('evt-1', { start: NEW_START, attendees: [CONTACT_LIVE, COLLEAGUE, { email: HOST, organizer: true, self: true }] }) });
  mock.method(google, 'calendar', () => fake.api);
  const meta = await calendar.upsertMeetingEvent(bookedClient(), 'evt-1', 'sales:rep-1', {
    sendUpdates: 'none',
    includeAttendees: true,
    expectedOwnerEmail: HOST,
  });
  const patch = fake.calls.find((call) => call.op === 'patch');
  assert.ok(patch, 'the event is patched, not recreated');
  assert.deepEqual(emails(patch.requestBody.attendees), [OLA, KARI]);
  assert.equal(patch.requestBody.attendees[1].responseStatus, 'accepted', 'the answer is kept');
  assert.deepEqual(meta.foreignAttendees, [{ email: KARI, name: 'Kari Hansen' }]);
});

test('a time change (forceRecreate) re-inserts contact, card guests and the hand-added attendee', async () => {
  const hand = { email: 'per@third.example', displayName: 'Per', responseStatus: 'tentative' };
  const fake = fakeCalendar({ 'evt-1': liveEvent('evt-1', { attendees: [CONTACT_LIVE, COLLEAGUE, hand] }) });
  mock.method(google, 'calendar', () => fake.api);
  const client = bookedClient({ meetingGuests: [{ email: KARI, name: 'Kari Hansen' }] });
  const meta = await calendar.upsertMeetingEvent(client, 'evt-1', 'sales:rep-1', {
    sendUpdates: 'all',
    includeAttendees: true,
    forceRecreate: true,
    expectedOwnerEmail: HOST,
  });
  assert.deepEqual(fake.calls.map((call) => call.op).slice(0, 3), ['get', 'delete', 'insert']);
  const insert = fake.calls.find((call) => call.op === 'insert');
  assert.deepEqual(emails(insert.requestBody.attendees), [OLA, KARI, 'per@third.example']);
  assert.equal(insert.requestBody.attendees.find((a) => a.email === 'per@third.example').responseStatus, 'tentative');
  assert.deepEqual(meta.foreignAttendees, [{ email: 'per@third.example', name: 'Per' }], 'card guests are not foreign');
});

test('dropAttendeeEmails removes the old contact and a removed guest', async () => {
  const fake = fakeCalendar({ 'evt-1': liveEvent('evt-1', { start: NEW_START, attendees: [CONTACT_LIVE, COLLEAGUE] }) });
  mock.method(google, 'calendar', () => fake.api);
  const client = bookedClient({ contactEmail: 'ny@kunde.example' });
  const meta = await calendar.upsertMeetingEvent(client, 'evt-1', 'sales:rep-1', {
    sendUpdates: 'none',
    includeAttendees: true,
    dropAttendeeEmails: [OLA.toUpperCase(), KARI],
    expectedOwnerEmail: HOST,
  });
  const patch = fake.calls.find((call) => call.op === 'patch');
  assert.deepEqual(emails(patch.requestBody.attendees), ['ny@kunde.example']);
  assert.deepEqual(meta.foreignAttendees, []);
});

test('a silent patch that sends attendees (Fireflies only) cannot wipe the guests', async () => {
  const fred = { email: 'fred@fireflies.ai', responseStatus: 'accepted' };
  const online = liveEvent('evt-1', { start: NEW_START, attendees: [CONTACT_LIVE, COLLEAGUE, fred] });
  const fake = fakeCalendar({ 'evt-1': online });
  mock.method(google, 'calendar', () => fake.api);
  await calendar.upsertMeetingEvent(bookedClient({ meetingMode: 'in-person' }), 'evt-1', 'sales:rep-1', {
    sendUpdates: 'none',
    includeAttendees: false,
    expectedOwnerEmail: HOST,
  });
  const patch = fake.calls.find((call) => call.op === 'patch');
  assert.equal(patch.requestBody.attendees, undefined, 'nothing to send, so the live attendees stand');
});

test('addGuestsToEvent patches only the attendees with sendUpdates all and skips listed guests', async () => {
  const fake = fakeCalendar({ 'evt-1': liveEvent('evt-1', { attendees: [CONTACT_LIVE, COLLEAGUE] }) });
  mock.method(google, 'calendar', () => fake.api);
  const result = await calendar.addGuestsToEvent('evt-1', 'sales:rep-1', [
    { email: KARI, name: 'Kari Hansen' },
    { email: 'per@third.example', name: 'Per' },
  ]);
  assert.deepEqual(result, { added: ['per@third.example'], reason: '' });
  const patch = fake.calls.find((call) => call.op === 'patch');
  assert.equal(patch.sendUpdates, 'all');
  assert.deepEqual(Object.keys(patch.requestBody), ['attendees']);
  assert.deepEqual(emails(patch.requestBody.attendees), [OLA, KARI, 'per@third.example']);

  const again = await calendar.addGuestsToEvent('evt-1', 'sales:rep-1', [{ email: KARI }]);
  assert.deepEqual(again, { added: [], reason: '' });
  assert.equal(fake.calls.filter((call) => call.op === 'patch').length, 1, 'no second write when everyone is listed');
});

test('addGuestsToEvent leaves a cancelled event alone', async () => {
  const fake = fakeCalendar({ 'evt-1': liveEvent('evt-1', { status: 'cancelled' }) });
  mock.method(google, 'calendar', () => fake.api);
  const result = await calendar.addGuestsToEvent('evt-1', 'sales:rep-1', [{ email: KARI }]);
  assert.deepEqual(result, { added: [], reason: 'cancelled' });
  assert.equal(fake.calls.some((call) => call.op === 'patch'), false);
});

test('removeGuestsFromEvent patches the attendees without the guest and lets Google mail them', async () => {
  const fake = fakeCalendar({ 'evt-1': liveEvent('evt-1', { attendees: [CONTACT_LIVE, COLLEAGUE] }) });
  mock.method(google, 'calendar', () => fake.api);
  const result = await calendar.removeGuestsFromEvent('evt-1', 'sales:rep-1', [KARI.toUpperCase()]);
  assert.deepEqual(result, { removed: [KARI], reason: '' });
  const patch = fake.calls.find((call) => call.op === 'patch');
  assert.equal(patch.sendUpdates, 'all');
  assert.deepEqual(emails(patch.requestBody.attendees), [OLA]);
});

test('a transient events.get failure aborts a move before anything is deleted', async () => {
  const fake = fakeCalendar({ 'evt-1': liveEvent('evt-1', { attendees: [CONTACT_LIVE, COLLEAGUE] }) });
  fake.api.events.get = async ({ eventId }) => {
    fake.calls.push({ op: 'get', eventId });
    throw googleError(503, 'Backend Error');
  };
  mock.method(google, 'calendar', () => fake.api);
  await assert.rejects(
    calendar.upsertMeetingEvent(bookedClient(), 'evt-1', 'sales:rep-1', {
      sendUpdates: 'all', includeAttendees: true, forceRecreate: true, expectedOwnerEmail: HOST,
    }),
    /Backend Error/
  );
  assert.deepEqual(fake.calls.map((call) => call.op), ['get'], 'no delete, no insert without the guests');
});

test('the calendar record remembers the invited contact e-mail', () => {
  const { id } = seedCard();
  const updated = sales.setSalesCalendar(id, { eventId: 'evt-9', invitedContactEmail: 'OLD@Kunde.example' });
  assert.equal(updated.calendar.invitedContactEmail, 'old@kunde.example');
});

test('server: a retried sync still drops the invited contact the card no longer has, and the guest patch honours the gates', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function droppedMeetingAttendees');
  const fn = source.slice(start, source.indexOf('\n}\n', start) + 3);
  const dropped = new Function('sanitizeText', `${fn}; return droppedMeetingAttendees;`)((v) => String(v ?? '').trim());
  const card = { contactEmail: 'new@kunde.example', calendar: { invitedContactEmail: 'old@kunde.example' }, meetingGuests: [] };
  assert.deepEqual(dropped(card, card), ['old@kunde.example']);
  const same = { contactEmail: OLA, calendar: { invitedContactEmail: OLA }, meetingGuests: [] };
  assert.deepEqual(dropped(same, same), []);
  const guestFn = source.slice(source.indexOf('async function syncSalesMeetingGuests'), source.indexOf('async function maybeSyncCalendar'));
  assert.match(guestFn, /shouldSyncSalesMeetingCalendar/);
  assert.match(guestFn, /isUnacceptableMeetingHostEmail\(status\.googleEmail\)/);
  assert.match(guestFn, /invited = result\.added\.length > 0 && !result\.safeMode/);
});
