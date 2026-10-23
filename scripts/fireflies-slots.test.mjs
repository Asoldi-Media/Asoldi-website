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

// Review fixes: a room booked again later, a pick weeks later, a fragment, two booked slots in one room.
test('M4: a room booked again days later never takes a recording off the slot it was linked with', () => {
  // The sales meeting moved to a fresh room two weeks on; a Møte three weeks on reuses the first room.
  const moved = bookedClient({
    meetingAt: iso(SALES_AT + 14 * 24 * HOUR),
    calendar: { meetLink: 'https://meet.google.com/new-sale-ggg', confirmedMeetLink: 'https://meet.google.com/new-sale-ggg' },
    nextActions: [{ ...bookedClient().nextActions[0], dueAt: iso(SALES_AT + 20 * 24 * HOUR), meetLink: SALES_ROOM }],
  });
  const held = recording('ff-s1', SALES_ROOM, SALES_AT + MIN, { purpose: 'sales', forSalesMeeting: true, slotKey: `sales:${SALES_AT}` });
  const facts = slots.meetingSlotFacts(moved, held);
  assert.deepEqual([facts.purpose, facts.slotKey, facts.by], ['sales', `sales:${SALES_AT}`, 'kept']);
  // A recording in that room near the Møte is the Møte's, and a row with nothing yet still takes the room.
  assert.equal(slots.meetingSlotFacts(moved, recording('ff-m', SALES_ROOM, SALES_AT + 20 * 24 * HOUR + MIN)).slotKey, 'action:na-plan');
  assert.equal(slots.meetingSlotFacts(moved, recording('ff-bare', SALES_ROOM, SALES_AT + MIN)).by, 'room');
  // The old clock rule's tag near a slot in its room is still corrected by the room.
  const retag = slots.meetingSlotFacts(bookedClient(), recording('ff-w', WORKSHOP_ROOM, WORKSHOP_AT + 110 * MIN, { purpose: 'sales' }));
  assert.deepEqual([retag.purpose, retag.by], ['workshop', 'room']);
});

test('a purpose pick puts a recording on a booked slot of that purpose only the same day', () => {
  const client = bookedClient();
  assert.equal(slots.slotForPurposePick(client, recording('ff-a', OTHER_ROOM, SALES_AT + 5 * HOUR), 'sales')?.slotKey, `sales:${SALES_AT}`, 'held later that day in another room');
  assert.equal(slots.slotForPurposePick(client, recording('ff-b', SALES_ROOM, SALES_AT + 21 * 24 * HOUR), 'sales'), null, 'a follow-up three weeks on, even in the sales room');
  assert.equal(slots.slotForPurposePick(client, recording('ff-c', OTHER_ROOM, WORKSHOP_AT + 6 * HOUR), 'workshop')?.slotKey, `workshop:${WORKSHOP_AT}`);
  assert.equal(slots.slotForPurposePick(client, { meetingId: 'ff-d', meetLink: SALES_ROOM }, 'sales'), null, 'no start time: no slot');
});

test('a person\'s link in another room inside one slot\'s window is that slot\'s; so is the bot capture saw', () => {
  const stub = placeholder('sales', SALES_AT, SALES_ROOM, { recording: { state: 'ended', ffMeetingId: 'ff-bot' } });
  const client = bookedClient({ meetings: [stub] });
  const pasted = recording('ff-paste', OTHER_ROOM, SALES_AT + 4 * MIN, { linkedBy: 'manual' });
  const linked = slots.meetingSlotFacts(client, pasted);
  assert.deepEqual([linked.purpose, linked.slotKey, linked.by], ['sales', `sales:${SALES_AT}`, 'linked']);
  const automatic = slots.meetingSlotFacts(client, { ...pasted, linkedBy: 'meet-link' });
  assert.deepEqual([automatic.purpose, automatic.slotKey, automatic.by], ['sales', '', 'time'], 'an automatic link in no booked room gets no slot');
  assert.equal(slots.meetingSlotFacts(client, { ...pasted, startedAt: iso(SALES_AT + 5 * HOUR) }).slotKey, '', 'outside every window');
  // Capture saw this bot in the placeholder's session: its recording is that slot's, whatever its meeting_link says.
  const bot = slots.meetingSlotFacts(client, { meetingId: 'ff-bot', meetLink: '', startedAt: iso(SALES_AT + 2 * HOUR), hasTranscript: true });
  assert.deepEqual([bot.slotKey, bot.by], [`sales:${SALES_AT}`, 'bot']);
  assert.equal(slots.placeholderSupersededBy(stub, [{ meetingId: 'ff-bot', startedAt: iso(SALES_AT + 2 * HOUR), hasTranscript: true, sentenceCount: 80 }])?.meetingId, 'ff-bot');
});

test('M5/F15: a fragment of a few sentences never covers a placeholder; an old open placeholder goes with talk of its purpose', () => {
  const stub = placeholder('sales', SALES_AT, SALES_ROOM);
  const client = bookedClient({ meetings: [stub] });
  const covers = (rows) => slots.placeholderSupersededBy(stub, rows, {
    factsOf: (row) => slots.meetingSlotFacts({ ...client, meetings: [stub, ...rows] }, row),
  });
  const hallo = recording('ff-hallo', SALES_ROOM, SALES_AT - 2 * MIN, { sentenceCount: 1, durationMinutes: 1 });
  assert.equal(covers([hallo]), null, 'a "hallo?" in the open room is not the meeting');
  assert.equal(covers([{ ...hallo, sentenceCount: 2, durationMinutes: 6 }]), null, 'minutes alone are not talk');
  assert.equal(covers([{ ...hallo, sentenceCount: slots.COVER_MIN_SENTENCES }])?.meetingId, 'ff-hallo');
  assert.equal(covers([{ ...hallo, sentenceCount: '', transcript: 'Kari: hei\nSelger: hei' }]), null, 'two transcript lines are counted too');
  assert.equal(covers([{ ...hallo, sentenceCount: '' }])?.meetingId, 'ff-hallo', 'talk nobody counted (an old row) still covers');
  assert.deepEqual(slots.recordingTalk({ hasTranscript: true }), { sentences: 1, minutes: 0, known: false });
  const open = { meetingId: 'live:c-booked:open', linkedBy: 'live-join', purpose: 'sales', forSalesMeeting: true, hasTranscript: false };
  assert.equal(slots.placeholderSupersededBy(open, [{ ...hallo, purpose: 'sales', sentenceCount: 40 }])?.meetingId, 'ff-hallo');
  assert.equal(slots.placeholderSupersededBy(open, [{ ...hallo, purpose: 'workshop', sentenceCount: 40 }]), null);
});

test('M6: recordings of two booked slots in one room are never one meeting; the card\'s duplicateOf is used as it is', () => {
  const sales = recording('ff-sales', SALES_ROOM, SALES_AT, { sentenceCount: 300, durationMinutes: 60, slotKey: `sales:${SALES_AT}` });
  const next = recording('ff-next', SALES_ROOM, SALES_AT + 65 * MIN, { sentenceCount: 500, durationMinutes: 40, slotKey: 'action:na-plan' });
  assert.equal(slots.duplicateRecordingMap([sales, next]).size, 0, 'the sales meeting and the Møte booked right after it');
  const rejoin = recording('ff-rejoin', SALES_ROOM, SALES_AT + 62 * MIN, { sentenceCount: 4, durationMinutes: 3, slotKey: '' });
  const map = slots.duplicateRecordingMap([sales, rejoin, next]);
  assert.equal(map.size, 1, 'a fragment with no slot joins one of them, never both');
  assert.equal(map.get('ff-rejoin'), 'ff-sales');
  // The browser ranks by row fields; rows from the card already carry the server's answer.
  const card = [
    { ...sales, meetingId: 'ff-a', sentenceCount: '', duplicateOf: 'ff-b' },
    { ...sales, meetingId: 'ff-b', sentenceCount: '', startedAt: iso(SALES_AT + 5 * MIN), duplicateOf: '' },
  ];
  assert.deepEqual([...slots.duplicateRecordingIds(card)], ['ff-a']);
  assert.deepEqual([...slots.duplicateRecordingIds(card.map(({ duplicateOf, ...row }) => row))], ['ff-b'], 'raw rows are worked out here');
});
