// Which booked slot a Fireflies recording belongs to (lib/fireflies-slots.js): the Meet room decides the
// purpose and time only breaks ties (M4); a placeholder is covered only by a recording with talk on its own
// slot and session window, the watchdog's (M5/F15); two recordings of one meeting count once (M6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-ff-slots-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const slots = await import('../lib/fireflies-slots.js');
const watchdog = await import('../lib/fireflies-recording-watchdog.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const SALES_ROOM = 'https://meet.google.com/sal-room-aaa';
const WORKSHOP_ROOM = 'https://meet.google.com/wrk-room-bbb';
const ITERATION_ROOM = 'https://meet.google.com/itr-room-ccc';
const ACTION_ROOM = 'https://meet.google.com/act-room-ddd';
const OTHER_ROOM = 'https://meet.google.com/oth-room-eee';
const SALES_AT = Date.parse('2026-10-20T10:00:00.000Z');
const WORKSHOP_AT = Date.parse('2026-10-22T10:00:00.000Z');

/** One client with a sales meeting, a workshop Møte, an iteration Møte and an extra recorded Møte. */
function bookedClient(overrides = {}) {
  return {
    id: 'c-booked',
    businessName: 'Testfirma AS',
    agreedTime: true,
    meetingAt: iso(SALES_AT),
    meetingMode: 'online',
    calendar: { meetLink: SALES_ROOM, confirmedMeetLink: SALES_ROOM },
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: iso(WORKSHOP_AT), meetLink: WORKSHOP_ROOM, status: 'confirmed' },
    workshop: { iterationMeeting: { format: 'mote', dueAt: iso(WORKSHOP_AT + 7 * 24 * HOUR), meetLink: ITERATION_ROOM } },
    nextActions: [{
      id: 'na-plan',
      goalKey: 'offerSent',
      presetKey: 'custom',
      name: 'Planlegg neste møte',
      format: 'mote',
      addToCalendar: true,
      dueAt: iso(SALES_AT + 2 * 24 * HOUR),
      meetLink: ACTION_ROOM,
    }],
    meetings: [],
    ...overrides,
  };
}

function placeholder(kind, startMs, room, extra = {}) {
  const scope = kind === 'sales' ? 'c-booked' : `c-booked:${kind}`;
  return {
    meetingId: `live:${scope}:${startMs}`,
    startedAt: iso(startMs),
    meetLink: room,
    hasTranscript: false,
    linkedBy: 'live-join',
    purpose: kind,
    forSalesMeeting: kind === 'sales',
    slotKey: `${kind}:${startMs}`,
    recording: { state: 'ended' },
    ...extra,
  };
}

function recording(meetingId, room, startMs, extra = {}) {
  return { meetingId, meetLink: room, startedAt: iso(startMs), hasTranscript: true, linkedBy: 'meet-link', ...extra };
}

test('slots: the sales meeting, workshop, iteration and a recorded Møte each with its rooms; old rooms stay with sales', () => {
  const client = bookedClient({ recordedMeetLinks: [SALES_ROOM, 'https://meet.google.com/old-sale-fff', WORKSHOP_ROOM] });
  const list = slots.clientMeetingSlots(client);
  const byKind = Object.fromEntries(list.map((slot) => [slot.kind, slot]));
  assert.equal(byKind.sales.slotKey, `sales:${SALES_AT}`);
  assert.ok(byKind.sales.rooms.has(SALES_ROOM));
  assert.ok(byKind.sales.historyRooms.has('https://meet.google.com/old-sale-fff'), 'an earlier room no slot books is the sales meeting\'s history');
  assert.equal(byKind.sales.historyRooms.has(WORKSHOP_ROOM), false);
  assert.equal(byKind.sales.rooms.has(WORKSHOP_ROOM), false);
  // An earlier room is a weaker sign: it names the sales meeting for a recording with no purpose, but
  // never overrides the purpose a recording was linked with.
  const oldRoom = recording('ff-old', 'https://meet.google.com/old-sale-fff', SALES_AT + MIN);
  assert.deepEqual(
    [slots.meetingSlotFacts(client, oldRoom).purpose, slots.meetingSlotFacts(client, oldRoom).slotKey, slots.meetingSlotFacts(client, oldRoom).by],
    ['sales', `sales:${SALES_AT}`, 'history'],
  );
  assert.equal(slots.meetingSlotFacts(client, { ...oldRoom, purpose: 'workshop' }).purpose, 'workshop');
  assert.equal(byKind.workshop.slotKey, `workshop:${WORKSHOP_AT}`);
  assert.ok(byKind.workshop.rooms.has(WORKSHOP_ROOM));
  assert.ok(byKind.iteration.rooms.has(ITERATION_ROOM));
  assert.equal(byKind.action.slotKey, 'action:na-plan');
  // A placeholder of a booking that has moved on keeps its own slot.
  const moved = slots.clientMeetingSlots(bookedClient({ meetings: [placeholder('sales', SALES_AT - 24 * HOUR, SALES_ROOM)] }));
  assert.ok(moved.some((slot) => slot.historic && slot.slotKey === `sales:${SALES_AT - 24 * HOUR}`));
});

test('placeholder slot keys: their own, else the one the live: id names', () => {
  assert.equal(slots.placeholderSlotKey({ meetingId: 'live:c1:123', slotKey: 'sales:999' }), 'sales:999');
  assert.equal(slots.placeholderSlotKey({ meetingId: `live:c1:${SALES_AT}` }), `sales:${SALES_AT}`);
  assert.equal(slots.placeholderSlotKey({ meetingId: `live:c1:workshop:${WORKSHOP_AT}` }), `workshop:${WORKSHOP_AT}`);
  assert.equal(slots.placeholderSlotKey({ meetingId: `live:c1:iteration:${WORKSHOP_AT}` }), `iteration:${WORKSHOP_AT}`);
  assert.equal(slots.placeholderSlotKey({ meetingId: `live:c1:na-plan:${SALES_AT}` }), 'action:na-plan');
  assert.equal(slots.placeholderSlotKey({ meetingId: 'live:c1:open', purpose: 'sales', startedAt: iso(SALES_AT) }), `sales:${SALES_AT}`);
  assert.equal(slots.placeholderSlotKey({ meetingId: 'live:c1:open' }), '');
  assert.equal(slots.placeholderSlotKey({ meetingId: 'ff-real' }), '');
});

test('M4: the room decides the purpose, time only breaks ties in a shared room', () => {
  const client = bookedClient();
  const facts = (row) => slots.meetingSlotFacts(client, row);
  // (a) the workshop held four hours late in its own room is still the workshop, without the slot key.
  const late = facts(recording('ff-w', WORKSHOP_ROOM, WORKSHOP_AT + 4 * HOUR + 5 * MIN));
  assert.deepEqual([late.purpose, late.slotKey, late.by], ['workshop', '', 'room']);
  // (b) the workshop room near a sales meeting moved to the same day is still the workshop.
  const near = facts(recording('ff-w2', WORKSHOP_ROOM, WORKSHOP_AT + 110 * MIN));
  assert.equal(near.purpose, 'workshop');
  // In its own window the recording gets the slot key.
  assert.equal(facts(recording('ff-w3', WORKSHOP_ROOM, WORKSHOP_AT + 2 * MIN)).slotKey, `workshop:${WORKSHOP_AT}`);
  assert.equal(facts(recording('ff-s', SALES_ROOM, SALES_AT - 25 * MIN)).slotKey, `sales:${SALES_AT}`, '30 minutes early still counts');
  assert.equal(facts(recording('ff-s', SALES_ROOM, SALES_AT - 31 * MIN)).slotKey, '');
  assert.deepEqual(
    [facts(recording('ff-a', ACTION_ROOM, SALES_AT + 2 * 24 * HOUR)).purpose, facts(recording('ff-a', ACTION_ROOM, SALES_AT + 2 * 24 * HOUR)).slotKey],
    ['', 'action:na-plan'],
    'an extra Møte under Tilbud is its own slot, not the sales meeting',
  );
  // (c) a sales recording keeps 'sales' after a follow-up booking on a fresh room: its room stays the client's sales room.
  const followUp = bookedClient({
    meetingAt: iso(SALES_AT + 14 * 24 * HOUR),
    calendar: { meetLink: 'https://meet.google.com/new-sale-ggg' },
    recordedMeetLinks: [SALES_ROOM, 'https://meet.google.com/new-sale-ggg'],
  });
  const kept = slots.meetingSlotFacts(followUp, recording('ff-s', SALES_ROOM, SALES_AT + 3 * MIN, { purpose: 'sales', slotKey: `sales:${SALES_AT}` }));
  assert.deepEqual([kept.purpose, kept.slotKey, kept.forSalesMeeting], ['sales', `sales:${SALES_AT}`, true]);
  // A room two slots share: the nearer start wins.
  const shared = bookedClient({ nextActions: [{ ...bookedClient().nextActions[0], meetLink: SALES_ROOM, goalKey: 'meetingHeld', dueAt: iso(SALES_AT + 3 * 24 * HOUR) }] });
  assert.equal(slots.meetingSlotFacts(shared, recording('ff-x', SALES_ROOM, SALES_AT + 3 * 24 * HOUR + MIN)).slotKey, 'action:na-plan');
  assert.equal(slots.meetingSlotFacts(shared, recording('ff-y', SALES_ROOM, SALES_AT + MIN)).slotKey, `sales:${SALES_AT}`);
  // No room of this client: a purpose it had stays; with none, the nearest booked slot within three hours, never its key.
  assert.equal(facts(recording('ff-z', OTHER_ROOM, SALES_AT, { purpose: 'workshop' })).purpose, 'workshop');
  const timed = facts(recording('ff-t', OTHER_ROOM, SALES_AT + 20 * MIN));
  assert.deepEqual([timed.purpose, timed.slotKey, timed.by], ['sales', '', 'time']);
  assert.equal(facts(recording('ff-far', OTHER_ROOM, SALES_AT + 5 * HOUR)).purpose, '');
  // A person's pick stays whatever the room says.
  const picked = facts(recording('ff-p', SALES_ROOM, SALES_AT, { purpose: 'workshop', purposePickedAt: iso(SALES_AT), slotKey: `workshop:${WORKSHOP_AT}` }));
  assert.deepEqual([picked.purpose, picked.slotKey, picked.by], ['workshop', `workshop:${WORKSHOP_AT}`, 'person']);
});

test('the placeholder window is the watchdog\'s: booked start − 30 min to the session end', () => {
  const rows = [
    placeholder('sales', SALES_AT, SALES_ROOM),
    placeholder('sales', SALES_AT, SALES_ROOM, { durationMinutes: 90 }),
    placeholder('sales', SALES_AT, SALES_ROOM, { recording: { state: 'recording', lastSeenAt: iso(SALES_AT + 2 * HOUR) } }),
    placeholder('sales', SALES_AT, SALES_ROOM, { recording: { state: 'ended', endedAt: iso(SALES_AT + 75 * MIN) } }),
  ];
  for (const row of rows) assert.equal(slots.placeholderSessionEndMs(row), watchdog.placeholderSessionEndMs(row));
  assert.equal(slots.SLOT_MATCH_BEFORE_MS, 30 * MIN);
});

test('M5/F15: a placeholder is covered only by a recording with talk on its own slot', () => {
  const salesStub = placeholder('sales', SALES_AT, SALES_ROOM);
  const workshopStub = placeholder('workshop', WORKSHOP_AT, WORKSHOP_ROOM);
  const client = bookedClient({ meetings: [salesStub, workshopStub] });
  const covers = (stub, rows) => slots.placeholderSupersededBy(stub, rows, {
    factsOf: (row) => slots.meetingSlotFacts({ ...client, meetings: [salesStub, workshopStub, ...rows] }, row),
  });
  const salesTalk = recording('ff-sales', SALES_ROOM, SALES_AT + 2 * MIN);
  assert.equal(covers(salesStub, [salesTalk])?.meetingId, 'ff-sales');
  assert.equal(covers(workshopStub, [salesTalk]), null, 'the workshop that was not recorded stays visible next to the sales transcript');
  assert.equal(covers(salesStub, [recording('ff-plan', ACTION_ROOM, SALES_AT + 5 * MIN)]), null, 'a recording of another slot never covers it');
  assert.equal(covers(salesStub, [recording('ff-adhoc', OTHER_ROOM, SALES_AT + 5 * MIN)]), null, 'a recording with no slot never covers it');
  assert.equal(covers(salesStub, [{ ...salesTalk, partial: true }]), null, 'live captions never cover it');
  assert.equal(covers(salesStub, [{ ...salesTalk, hasTranscript: false }]), null, 'a silent recording never covers it');
  assert.equal(covers(salesStub, [{ ...salesTalk, startedAt: iso(SALES_AT + 3 * HOUR) }]), null, 'the room hours later is another meeting');
  // A person who says "this is the workshop" puts it on that slot, wherever and whenever it was held.
  const picked = recording('ff-picked', OTHER_ROOM, WORKSHOP_AT + 6 * HOUR, { purpose: 'workshop', purposePickedAt: iso(WORKSHOP_AT), slotKey: `workshop:${WORKSHOP_AT}` });
  assert.equal(covers(workshopStub, [picked])?.meetingId, 'ff-picked');
});

test('M6: two recordings of one meeting are one, and the one with the most talk is the primary', () => {
  const real = recording('ff-real', SALES_ROOM, SALES_AT, { sentenceCount: 600, durationMinutes: 52 });
  const silent = recording('ff-silent', SALES_ROOM, SALES_AT + 30 * 1000, { sentenceCount: 0, durationMinutes: 1, hasTranscript: false });
  const rejoin = recording('ff-rejoin', SALES_ROOM, SALES_AT + 54 * MIN, { sentenceCount: 12, durationMinutes: 6 });
  const later = recording('ff-later', SALES_ROOM, SALES_AT + 3 * HOUR, { sentenceCount: 300, durationMinutes: 40 });
  const map = slots.duplicateRecordingMap([silent, real, rejoin, later]);
  assert.equal(map.get('ff-silent'), 'ff-real');
  assert.equal(map.get('ff-rejoin'), 'ff-real', 'a bot that rejoined right after the first one left is the same meeting');
  assert.equal(map.has('ff-real'), false);
  assert.equal(map.has('ff-later'), false, 'the same room three hours later is another meeting');
  assert.equal(slots.sameRecordedMeeting(real, recording('ff-other-room', OTHER_ROOM, SALES_AT)), false);
});
