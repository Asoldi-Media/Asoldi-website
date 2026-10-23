import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-live-sessions-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const live = await import('../lib/fireflies-live-sessions.js');
const { mergeRecordingState } = await import('../lib/fireflies-recording-state.js');
const { liveJoinMeetingId } = await import('../data/sales.js');
const { FIREFLIES_LIVE_JOIN_DURATION_MINUTES } = await import('../lib/fireflies-webhook.js');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');
const {
  applyLiveJoinAttempt,
  collectLiveSessions,
  liveJoinNextAllowedAt,
  planLiveSessionTick,
  readLiveSessionStore,
  runFirefliesLiveJoinTick,
  sessionsNeedingVerification,
  syncLiveSessions,
  updateLiveSessionStore,
} = live;

const STORE_FILE = join(dataDir, 'fireflies-live-sessions.json');
const MIN = 60_000;
const T = Date.parse('2026-11-02T10:00:00.000Z');
const at = (minutes) => T + minutes * MIN;
const iso = (minutes) => new Date(at(minutes)).toISOString();
const ROOM = 'https://meet.google.com/abc-defg-hij';
const ROOM_B = 'https://meet.google.com/bcd-efgh-ijk';
const ROOM_C = 'https://meet.google.com/cde-fghi-jkl';

function salesClient(overrides = {}) {
  return {
    id: 'client-1',
    businessName: 'Testfirma AS',
    contactPerson: 'Kari Test',
    meetingMode: 'online',
    meetingDurationMinutes: 60,
    agreedTime: true,
    meetingAt: iso(0),
    calendar: { meetLink: ROOM, confirmedMeetLink: ROOM },
    reminders: {},
    progression: {},
    nextActions: [],
    meetings: [],
    ...overrides,
  };
}

function sessionFor(client, nowMs = at(-60)) {
  const sessions = collectLiveSessions([client], nowMs);
  assert.equal(sessions.length, 1);
  return syncLiveSessions({}, sessions, { nowMs })[sessions[0].key];
}

function dispatched(session, minutes, kind = 'first', ok = true) {
  return applyLiveJoinAttempt(session, { at: iso(minutes), kind, ok, durationMinutes: 120 });
}

function planAt(minutes, session, { active = null, limiter = null, others = [], meetRooms = false } = {}) {
  const plan = planLiveSessionTick({
    sessions: [session, ...others],
    activeMeetings: active,
    nowMs: at(minutes),
    limiter,
    meetRooms,
  });
  return { ...plan, session: plan.sessions.find((row) => row.key === session.key) };
}

function dispatches(plan) {
  return plan.actions.filter((action) => action.type === 'dispatch');
}

function activeRow(link = ROOM, extra = {}) {
  return { id: 'ff-meeting-1', meetingLink: link, startTime: iso(-2), endTime: iso(118), state: 'active', ...extra };
}

function resetStore() {
  rmSync(STORE_FILE, { force: true });
  for (const name of readdirSync(dataDir)) {
    if (name.startsWith('fireflies-live-sessions.json')) rmSync(join(dataDir, name), { force: true });
  }
  clearJsonCacheForTests();
  live.resetFirefliesLiveJoinEngineForTests();
}

// ── facts ────────────────────────────────────────────────────────────────────

test('an online sales meeting with a real Meet is a session without confirmation or fred@ stamps', () => {
  const [session] = collectLiveSessions([salesClient()], at(-60));
  assert.equal(session.key, `${ROOM}|${T}`);
  assert.equal(session.bookedMinutes, 60);
  assert.equal(session.title, 'Testfirma AS · Kari Test');
  assert.deepEqual(session.slots, [{
    clientId: 'client-1',
    kind: 'sales',
    slotKey: `sales:${T}`,
    stubMeetingId: `live:client-1:${T}`,
    purpose: 'sales',
  }]);
  // Same placeholder id as data/sales.js writes.
  assert.equal(session.slots[0].stubMeetingId, liveJoinMeetingId('client-1', iso(0)));
  assert.equal(collectLiveSessions([salesClient({ meetingMode: 'in-person' })], at(-60)).length, 0);
  assert.equal(collectLiveSessions([salesClient({ agreedTime: false })], at(-60)).length, 0);
  assert.equal(collectLiveSessions([salesClient({ calendar: { meetLink: 'https://meet.google.com/lookup/asoldi-sim-test' } })], at(-60)).length, 0);
  assert.equal(collectLiveSessions([salesClient({ meetingAt: iso(60 * 48) })], at(-60)).length, 0, 'beyond the horizon');
});

test('a ticked "Møtet hatt" or a done Møte stops nothing inside the meeting window', () => {
  const held = salesClient({ progression: { meetingHeld: true } });
  assert.equal(collectLiveSessions([held], at(5)).length, 1, 'held during the meeting: still joined');
  assert.equal(collectLiveSessions([held], at(-60)).length, 0, 'held long before: skipped');
  const action = {
    id: 'act-1',
    presetKey: 'custom',
    goalKey: 'meetingHeld',
    name: 'Oppfølgingsmøte',
    format: 'mote',
    addToCalendar: true,
    dueAt: iso(0),
    meetLink: ROOM_B,
    doneAt: iso(1),
  };
  const client = salesClient({ agreedTime: false, nextActions: [action] });
  const [session] = collectLiveSessions([client], at(2));
  assert.equal(session.slots[0].kind, 'action');
  assert.equal(session.slots[0].slotKey, 'action:act-1');
  assert.equal(session.slots[0].purpose, 'sales');
  assert.equal(session.title, 'Testfirma AS · Kari Test · Oppfølgingsmøte');
  assert.equal(collectLiveSessions([client], at(-120)).length, 0, 'done before its window: skipped');
});

test('workshop and iteration Møter count once booked; a never-booked draft does not', () => {
  const booked = salesClient({
    agreedTime: false,
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: iso(0), meetLink: ROOM_B, calendarEventId: 'evt-1', status: 'draft' },
    workshop: { iterationMeeting: { format: 'mote', dueAt: iso(120), meetLink: ROOM_C, sentAt: iso(-600) } },
  });
  const sessions = collectLiveSessions([booked], at(-30));
  assert.deepEqual(sessions.map((row) => row.slots[0].kind), ['workshop', 'iteration']);
  assert.equal(sessions[0].bookedMinutes, 30);
  assert.equal(sessions[0].slots[0].stubMeetingId, `live:client-1:workshop:${T}`);
  assert.equal(sessions[1].title, 'Testfirma AS · Kari Test · Iterasjon');
  const draft = salesClient({
    agreedTime: false,
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: iso(0), meetLink: ROOM_B, status: 'draft' },
    workshop: { iterationMeeting: { format: 'ring', dueAt: iso(120), meetLink: ROOM_C, sentAt: iso(-600) } },
  });
  assert.equal(collectLiveSessions([draft], at(-30)).length, 0);
});

test('two slots on one Meet and start are one session, so one bot and one call', () => {
  const other = salesClient({ id: 'client-2', businessName: 'Annenfirma AS', contactPerson: 'Ola Test' });
  const action = { id: 'act-2', presetKey: 'custom', name: 'Møte', format: 'mote', addToCalendar: true, dueAt: iso(0), meetLink: ROOM };
  const sessions = collectLiveSessions([salesClient({ nextActions: [action] }), other], at(-10));
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].slots.map((slot) => `${slot.clientId}/${slot.kind}`), ['client-1/sales', 'client-1/action', 'client-2/sales']);
  const plan = planAt(-3, syncLiveSessions({}, sessions, { nowMs: at(-10) })[sessions[0].key]);
  assert.equal(dispatches(plan).length, 1);
});

test('a reschedule is a new session in the same room; the old one is dropped or only watched', () => {
  const first = collectLiveSessions([salesClient()], at(-60));
  let stored = syncLiveSessions({}, first, { nowMs: at(-60) });
  const moved = collectLiveSessions([salesClient({ meetingAt: iso(60) })], at(-50));
  assert.equal(moved[0].meetLink, ROOM, 'the client keeps the room it was e-mailed');
  assert.notEqual(moved[0].key, first[0].key);
  const synced = syncLiveSessions(stored, moved, { nowMs: at(-50), full: true });
  assert.deepEqual(Object.keys(synced), [moved[0].key], 'a never-touched old session is dropped');
  stored = { [first[0].key]: dispatched(stored[first[0].key], -3) };
  const kept = syncLiveSessions(stored, moved, { nowMs: at(5), full: true });
  assert.ok(kept[first[0].key].detachedAt, 'a dispatched old session is kept but detached');
  const plan = planAt(6, kept[first[0].key], { active: [] });
  assert.equal(dispatches(plan).length, 0, 'no more sends for a moved meeting');
});

// ── planner ──────────────────────────────────────────────────────────────────

test('first dispatch from T-3 (duration 120), only until T+30 for a session never sent', () => {
  const session = sessionFor(salesClient());
  const early = planAt(-4, session);
  assert.equal(dispatches(early).length, 0);
  assert.equal(early.session.nextAttemptAt, iso(-3));
  const due = planAt(-3, session);
  assert.deepEqual(dispatches(due), [{ type: 'dispatch', key: session.key, kind: 'first', durationMinutes: 120 }]);
  assert.equal(dispatches(planAt(29, session)).length, 1);
  const late = planAt(31, session);
  assert.equal(dispatches(late).length, 0);
  assert.equal(late.session.state, 'not-admitted');
  assert.equal(late.session.message, live.LIVE_JOIN_MESSAGES.neverSent);
});

test('the planner and the transport agree on the 120-minute cap', () => {
  assert.equal(live.LIVE_JOIN_MAX_DURATION_MINUTES, FIREFLIES_LIVE_JOIN_DURATION_MINUTES);
  assert.equal(FIREFLIES_LIVE_JOIN_DURATION_MINUTES, 120);
});

test('verification asks Fireflies only when a session needs it, and finds the bot by normalized link', () => {
  const session = sessionFor(salesClient());
  assert.deepEqual(sessionsNeedingVerification([session], at(-10)), []);
  assert.deepEqual(sessionsNeedingVerification([session], at(-3)), [session.key], 'a look before the first knock');
  const sent = dispatched(session, -3);
  assert.deepEqual(sessionsNeedingVerification([sent], at(-2)), [sent.key]);
  const seen = planAt(-1, sent, { active: [activeRow(`${ROOM.toUpperCase()}?authuser=0`)] });
  assert.equal(seen.session.state, 'recording');
  assert.equal(seen.session.ffMeetingId, 'ff-meeting-1');
  assert.equal(seen.session.ffEndTime, iso(118));
  assert.equal(seen.session.firstSeenActiveAt, iso(-1));
  assert.equal(dispatches(seen).length, 0);
  assert.deepEqual(sessionsNeedingVerification([sent], at(60 + 31)), [], 'not after booked end + 30');
});

test('a bot already in the room (added by hand) is adopted, not doubled', () => {
  const session = sessionFor(salesClient());
  const plan = planAt(-3, session, { active: [activeRow()] });
  assert.equal(dispatches(plan).length, 0);
  assert.equal(plan.session.state, 'recording');
});

test('never seen: retries at T+1, T+5, then every 10 minutes, at most 5 sends, then not-admitted', () => {
  let session = dispatched(sessionFor(salesClient()), -3);
  assert.equal(dispatches(planAt(0, session, { active: [] })).length, 0);
  assert.equal(planAt(0, session, { active: [] }).session.nextAttemptAt, iso(1));
  const unverified = planAt(1, session, { active: null });
  assert.equal(dispatches(unverified).length, 0, 'no retry without a fresh look at the room');
  const retry = planAt(1, session, { active: [] });
  assert.deepEqual(dispatches(retry).map((row) => row.kind), ['retry']);
  assert.equal(retry.session.message, live.LIVE_JOIN_MESSAGES.waiting);
  session = dispatched(session, 1, 'retry');
  assert.equal(planAt(4, session, { active: [] }).session.nextAttemptAt, iso(5));
  assert.equal(dispatches(planAt(5, session, { active: [] })).length, 1);
  session = dispatched(session, 5, 'retry');
  assert.equal(planAt(6, session, { active: [] }).session.nextAttemptAt, iso(15));
  session = dispatched(session, 15, 'retry');
  assert.equal(planAt(16, session, { active: [] }).session.nextAttemptAt, iso(25));
  session = dispatched(session, 25, 'retry');
  const done = planAt(26, session, { active: [] });
  assert.equal(dispatches(done).length, 0, 'five sends is the cap');
  assert.equal(done.session.state, 'dispatched', 'the last knock still has its lobby wait');
  const settled = planAt(35, session, { active: [] });
  assert.equal(settled.session.state, 'not-admitted');
  assert.equal(settled.session.message, live.LIVE_JOIN_MESSAGES.notAdmitted);
  const late = planAt(40, settled.session, { active: [activeRow()] });
  assert.equal(late.session.state, 'recording', 'a late admission still counts');
});

test('when Fireflies cannot be asked who is in the room, a due retry still goes out after 5 minutes', () => {
  const sent = { ...dispatched(sessionFor(salesClient()), -3), checkedAt: iso(-2) };
  assert.equal(dispatches(planAt(1, sent, { active: null })).length, 0, 'last look 3 minutes ago: wait');
  assert.equal(planAt(1, sent, { active: null }).reasons[sent.key], 'unverified');
  assert.deepEqual(dispatches(planAt(3, sent, { active: null })).map((row) => row.kind), ['retry']);
});

test('a failed send does not need a look before the next one, and a bad link stops the schedule', () => {
  const failed = applyLiveJoinAttempt(sessionFor(salesClient()), { at: iso(-3), kind: 'first', ok: false, message: 'network down' });
  assert.equal(dispatches(planAt(1, failed, { active: null })).length, 1);
  const bad = applyLiveJoinAttempt(sessionFor(salesClient()), { at: iso(-3), kind: 'first', ok: false, message: 'unsupported_platform', permanent: true });
  const plan = planAt(1, bad, { active: [] });
  assert.equal(dispatches(plan).length, 0);
  assert.equal(planAt(8, bad, { active: [] }).session.state, 'not-admitted');
});

test('seen then gone early: one rejoin; gone again or near the end: ended', () => {
  let session = dispatched(sessionFor(salesClient()), -3);
  session = planAt(0, session, { active: [activeRow()] }).session;
  session = planAt(18, session, { active: [activeRow()] }).session;
  const blip = planAt(19, session, { active: [] });
  assert.equal(blip.session.state, 'recording', 'one missed look is not "left"');
  const gone = planAt(20, blip.session, { active: [] });
  assert.equal(gone.session.state, 'ended');
  assert.deepEqual(dispatches(gone).map((row) => row.kind), ['rejoin']);
  assert.equal(gone.session.message, live.LIVE_JOIN_MESSAGES.dropped);
  session = applyLiveJoinAttempt(gone.session, { at: iso(20), kind: 'rejoin', ok: true });
  assert.equal(session.state, 'ended', 'a rejoin knock does not claim the bot is on its way in');
  assert.equal(session.message, live.LIVE_JOIN_MESSAGES.rejoined);
  session = planAt(22, session, { active: [activeRow(ROOM, { id: 'ff-meeting-2' })] }).session;
  assert.equal(session.state, 'recording');
  assert.deepEqual(session.ffMeetingIds, ['ff-meeting-1', 'ff-meeting-2']);
  session = planAt(30, session, { active: [] }).session;
  const again = planAt(32, session, { active: [] });
  assert.equal(again.session.state, 'ended');
  assert.equal(dispatches(again).length, 0, 'only one rejoin');

  let late = dispatched(sessionFor(salesClient()), -3);
  late = planAt(0, late, { active: [activeRow()] }).session;
  late = planAt(48, late, { active: [activeRow()] }).session;
  const nearEnd = planAt(51, late, { active: [] });
  assert.equal(nearEnd.session.state, 'ended');
  assert.equal(dispatches(nearEnd).length, 0, 'no rejoin in the last 10 minutes of the booking');
});

test('a bot that sat alone in an open room is sent back again while the first-send window lasts', () => {
  let session = dispatched(sessionFor(salesClient()), -3);
  session = planAt(-2, session, { active: [activeRow()] }).session;
  session = planAt(7, session, { active: [activeRow()] }).session;
  const gone = planAt(9, session, { active: [] });
  assert.deepEqual(dispatches(gone).map((row) => row.kind), ['rejoin']);
  session = applyLiveJoinAttempt(gone.session, { at: iso(9), kind: 'rejoin', ok: true });
  session = planAt(10, session, { active: [activeRow(ROOM, { id: 'ff-meeting-2', startTime: iso(10) })] }).session;
  session = planAt(19, session, { active: [activeRow(ROOM, { id: 'ff-meeting-2', startTime: iso(10) })] }).session;
  const goneAgain = planAt(21, session, { active: [] });
  assert.equal(goneAgain.session.state, 'ended');
  assert.deepEqual(dispatches(goneAgain).map((row) => row.kind), ['rejoin'], 'the bot sent back came in and left: send again');
  session = applyLiveJoinAttempt(goneAgain.session, { at: iso(21), kind: 'rejoin', ok: true });
  assert.equal(dispatches(planAt(25, session, { active: [] })).length, 0, 'its knock still has its lobby wait');
  assert.equal(dispatches(planAt(30, session, { active: [] })).length, 0, 'lobby wait not over at T+30');
  assert.equal(dispatches(planAt(34, session, { active: [] })).length, 0, 'not after T+30');

  // A knock room: the rejoin knock went unanswered for its lobby wait, so one more goes before T+30.
  let knock = dispatched(sessionFor(salesClient()), -3);
  knock = planAt(0, knock, { active: [activeRow()] }).session;
  knock = planAt(3, knock, { active: [activeRow()] }).session;
  const left = planAt(5, knock, { active: [] });
  assert.deepEqual(dispatches(left).map((row) => row.kind), ['rejoin']);
  knock = applyLiveJoinAttempt(left.session, { at: iso(5), kind: 'rejoin', ok: true });
  assert.equal(dispatches(planAt(12, knock, { active: [] })).length, 0, 'inside the lobby wait');
  assert.deepEqual(dispatches(planAt(18, knock, { active: [] })).map((row) => row.kind), ['rejoin']);
});

test('a notetaker someone takes out of an open room soon after it walks in is sent back once at most', () => {
  let session = dispatched(sessionFor(salesClient()), -3);
  session = planAt(-2, session, { active: [activeRow()] }).session;
  session = planAt(1, session, { active: [activeRow()] }).session;
  // Taken out at 10:01 (the client does not want a recording): sent back once, in case it dropped out.
  const gone = planAt(3, session, { active: [] });
  assert.deepEqual(dispatches(gone).map((row) => row.kind), ['rejoin']);
  session = applyLiveJoinAttempt(gone.session, { at: iso(3), kind: 'rejoin', ok: true });
  const back = activeRow(ROOM, { id: 'ff-meeting-2', startTime: iso(3) });
  session = planAt(4, session, { active: [back] }).session;
  // Taken out again a minute after it walked in: it stays out.
  session = planAt(6, session, { active: [] }).session;
  assert.equal(session.state, 'ended');
  for (const minutes of [8, 15, 17, 22, 28]) {
    const plan = planAt(minutes, session, { active: [] });
    assert.equal(dispatches(plan).length, 0, `no send at T+${minutes}`);
    session = plan.session;
  }
  assert.equal(live.liveSessionKnocksAgain(session, at(8)), false, 'the lobby e-mail does not promise another knock');
});

test('a 30-minute workshop gets its send-backs through the first-send window, like any meeting', () => {
  const workshopClient = salesClient({
    agreedTime: false,
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: iso(0), meetLink: ROOM, status: 'confirmed' },
  });
  let session = dispatched(sessionFor(workshopClient), -3);
  assert.equal(session.bookedMinutes, 30);
  // An open room: the bot sits alone from 09:58 to 10:08, and the one sent back from 10:10 to 10:20.
  session = planAt(-2, session, { active: [activeRow()] }).session;
  session = planAt(8, session, { active: [activeRow()] }).session;
  const first = planAt(10, session, { active: [] });
  assert.deepEqual(dispatches(first).map((row) => row.kind), ['rejoin']);
  session = applyLiveJoinAttempt(first.session, { at: iso(10), kind: 'rejoin', ok: true });
  assert.equal(live.liveSessionKnocksAgain(session, at(12)), true, 'the lobby e-mail can say it is sent in again');
  const back = activeRow(ROOM, { id: 'ff-meeting-2', startTime: iso(10) });
  session = planAt(11, session, { active: [back] }).session;
  session = planAt(20, session, { active: [back] }).session;
  // People come at 10:22: one more is sent in, although the 30-minute booking is in its last 10 minutes.
  const second = planAt(22, session, { active: [] });
  assert.deepEqual(dispatches(second).map((row) => row.kind), ['rejoin']);
  // Past T+30 the last 10 booked minutes are no rejoin time.
  let late = dispatched(sessionFor(workshopClient), -3);
  late = planAt(0, late, { active: [activeRow()] }).session;
  late = planAt(29, late, { active: [activeRow()] }).session;
  assert.equal(dispatches(planAt(31, late, { active: [] })).length, 0);
});

test('a bot that leaves at its own end time is not sent back as a rejoin', () => {
  let session = dispatched(sessionFor(salesClient()), -3);
  session = planAt(0, session, { active: [activeRow(ROOM, { endTime: iso(30) })] }).session;
  session = planAt(29, session, { active: [activeRow(ROOM, { endTime: iso(30) })] }).session;
  const gone = planAt(31, session, { active: [] });
  assert.equal(gone.session.state, 'ended');
  assert.equal(dispatches(gone).length, 0);
});

test('still in the room near its end time: one continuation, while now < T+booked+60', () => {
  let session = dispatched(sessionFor(salesClient()), -3);
  session = planAt(0, session, { active: [activeRow()] }).session;
  assert.equal(dispatches(planAt(110, session, { active: [activeRow()] })).length, 0);
  const plan = planAt(115, session, { active: [activeRow()] });
  assert.deepEqual(dispatches(plan).map((row) => row.kind), ['continuation']);
  const after = applyLiveJoinAttempt(plan.session, { at: iso(115), kind: 'continuation', ok: true });
  assert.equal(after.state, 'recording');
  assert.equal(dispatches(planAt(116, after, { active: [activeRow()] })).length, 0, 'only one');
  let long = dispatched(sessionFor(salesClient()), -3);
  long = planAt(0, long, { active: [activeRow(ROOM, { endTime: iso(125) })] }).session;
  assert.equal(dispatches(planAt(122, long, { active: [activeRow(ROOM, { endTime: iso(125) })] })).length, 0, 'not at or after T+booked+60');
});

test('the limiter: 3 calls per 20 minutes, first dispatches first, retries leave room for upcoming ones', () => {
  const calls = (minutes) => ({ calls: minutes.map((m) => ({ at: iso(m), key: 'x', kind: 'first' })) });
  const session = sessionFor(salesClient());
  const full = planAt(-3, session, { limiter: calls([-15, -10, -5]) });
  assert.equal(dispatches(full).length, 0);
  assert.deepEqual(full.deferred, [{ key: session.key, kind: 'first', reason: 'limit' }]);
  assert.equal(full.session.nextAttemptAt, iso(5), 'free again 20 minutes after the oldest call');
  assert.equal(full.session.message, live.LIVE_JOIN_MESSAGES.limited);

  const retrying = dispatched(sessionFor(salesClient()), -3);
  const upcoming = (id, minutes, link) => sessionFor(salesClient({ id, meetingAt: iso(minutes), calendar: { meetLink: link, confirmedMeetLink: link } }));
  const nextOne = upcoming('client-2', 10, ROOM_B);
  const nextTwo = upcoming('client-3', 15, ROOM_C);
  const allowed = planAt(1, retrying, { active: [], limiter: calls([-3]), others: [nextOne] });
  assert.deepEqual(dispatches(allowed).map((row) => row.kind), ['retry'], '1 call + 1 reserved first < 3');
  const reserved = planAt(1, retrying, { active: [], limiter: calls([-3]), others: [nextOne, nextTwo] });
  assert.equal(dispatches(reserved).length, 0);
  assert.deepEqual(reserved.deferred.map((row) => row.reason), ['reserved']);

  // Two first dispatches and one retry due at once with one call used: the firsts go, the retry waits.
  const firstA = upcoming('client-4', 2, ROOM_B);
  const firstB = upcoming('client-5', 1, ROOM_C);
  const plan = planLiveSessionTick({ sessions: [retrying, firstA, firstB], activeMeetings: [], nowMs: at(1), limiter: calls([-3]) });
  assert.deepEqual(dispatches(plan).map((row) => `${row.kind}:${row.key.split('|')[0]}`), [`first:${ROOM_C}`, `first:${ROOM_B}`]);
  assert.deepEqual(plan.deferred.map((row) => `${row.kind}:${row.reason}`), ['retry:limit']);
});

test('a rate-limit answer blocks every send until its retry-after', () => {
  const session = sessionFor(salesClient());
  let limiter = live.recordLiveJoinCall({}, { key: session.key, kind: 'first', nowMs: at(-4) });
  limiter = live.blockLiveJoinLimiter(limiter, { nowMs: at(-4), retryAfterMs: 6 * MIN, reason: 'exceeded' });
  const plan = planAt(-3, session, { limiter });
  assert.equal(dispatches(plan).length, 0);
  assert.equal(plan.deferred[0].reason, 'blocked');
  assert.equal(plan.session.nextAttemptAt, iso(2));
  assert.equal(dispatches(planAt(2, session, { limiter })).length, 1);
  // Without a retry-after the block lasts until 20 minutes after the oldest call in the window.
  const fallback = live.blockLiveJoinLimiter(live.recordLiveJoinCall({}, { nowMs: at(-10) }), { nowMs: at(-4) });
  assert.equal(fallback.blockedUntil, iso(10));
  assert.equal(liveJoinNextAllowedAt(fallback, at(-4)), iso(10));
});

test('a rate-limited send is not counted as a knock: the session stays a first dispatch', () => {
  const session = applyLiveJoinAttempt(sessionFor(salesClient()), { at: iso(-3), kind: 'first', ok: false, rateLimited: true, message: 'exceeded' });
  assert.equal(session.attempts.length, 1);
  assert.deepEqual(dispatches(planAt(-2, session)).map((row) => row.kind), ['first']);
});

function otherRoom(id, minutes, link, { confirmed = true } = {}) {
  return sessionFor(salesClient({
    id,
    meetingAt: iso(minutes),
    calendar: { meetLink: link, confirmedMeetLink: link },
    reminders: confirmed ? { thankYouSentAt: iso(-24 * 60) } : {},
  }), at(minutes - 60));
}

test('the bot is asked to stay 120 minutes whatever else is booked', () => {
  const session = sessionFor(salesClient());
  const durations = (others) => dispatches(planAt(-3, session, { others })).map((row) => row.durationMinutes);
  assert.deepEqual(durations([otherRoom('client-2', 60, ROOM_B)]), [120], 'back to back');
  assert.deepEqual(durations([otherRoom('client-2', 0, ROOM_B)]), [120, 120], 'two at the same time');
  assert.deepEqual(durations([otherRoom('client-2', 30, ROOM_B)]), [120], 'overlapping');
  assert.equal(live.liveJoinDurationMinutes(session, [otherRoom('client-2', 60, ROOM_B)], at(-3)), 120);
  // server.js passes the optional one-bot switch; it is off unless FIREFLIES_LIVE_JOIN_ONE_BOT is set.
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /parseBoolean\(process\.env\.FIREFLIES_LIVE_JOIN_ONE_BOT, false\)/);
  assert.match(server, /oneBot: firefliesLiveJoinOneBot\(\)/);
});

test('two meetings at the same time in other rooms both keep 120 minutes and both get their continuation', () => {
  let a = dispatched(sessionFor(salesClient()), -3);
  let b = dispatched(otherRoom('client-2', 0, ROOM_B), -3);
  const rows = [activeRow(ROOM, { endTime: iso(117) }), activeRow(ROOM_B, { id: 'ff-meeting-b', endTime: iso(117) })];
  for (const minutes of [0, 60, 110]) {
    const plan = planLiveSessionTick({ sessions: [a, b], activeMeetings: rows, nowMs: at(minutes), oneBot: true });
    [a, b] = plan.sessions;
  }
  const plan = planLiveSessionTick({ sessions: [a, b], activeMeetings: rows, nowMs: at(114), oneBot: true });
  assert.deepEqual(dispatches(plan).map((row) => `${row.kind}:${row.durationMinutes}`), ['continuation:120', 'continuation:120']);
});

test('one-bot plans (opt-in): the bot leaves before the next meeting that starts after this one\'s booked time', () => {
  const session = sessionFor(salesClient());
  const duration = (others, minutes = -3) => live.liveJoinDurationMinutes(session, others, at(minutes), { oneBot: true });
  assert.equal(duration([otherRoom('client-2', 60, ROOM_B)]), 59, 'back to back: gone one minute before the next first send');
  assert.equal(duration([otherRoom('client-2', 0, ROOM_B)]), 120, 'a meeting at the same time never shortens this one');
  assert.equal(duration([otherRoom('client-2', 30, ROOM_B)]), 120, 'nor one that overlaps it');
  assert.equal(duration([otherRoom('client-2', 60, ROOM_B, { confirmed: false })]), 120, 'nor a booking nobody was e-mailed');
  assert.equal(duration([otherRoom('client-2', 60, ROOM_B)], 50), 15, 'never under the minimum');
  const plan = planLiveSessionTick({ sessions: [session, otherRoom('client-2', 60, ROOM_B)], nowMs: at(-3), oneBot: true });
  assert.equal(dispatches(plan).find((row) => row.key === session.key).durationMinutes, 59);
});

test('a queued manual send goes through the limiter, is not counted in the cap, and is dropped once the bot is in', () => {
  let session = dispatched(sessionFor(salesClient()), -3);
  for (const minutes of [1, 5, 15, 25]) session = dispatched(session, minutes, 'retry');
  session = { ...session, manualRequestedAt: iso(30) };
  const plan = planAt(30, session, { active: [] });
  assert.deepEqual(dispatches(plan).map((row) => row.kind), ['manual']);
  const after = applyLiveJoinAttempt(plan.session, { at: iso(30), kind: 'manual', ok: true });
  assert.equal(after.manualRequestedAt, '');
  const seen = planAt(31, { ...session, manualRequestedAt: iso(30) }, { active: [activeRow()] });
  assert.equal(seen.session.manualRequestedAt, '');
  assert.equal(dispatches(seen).length, 0);
});

test('Track D hook: open the Meet room once within 30 minutes of start', () => {
  const session = sessionFor(salesClient());
  assert.equal(planAt(-31, session, { meetRooms: true }).actions.length, 0);
  assert.deepEqual(planAt(-30, session, { meetRooms: true }).actions, [{ type: 'open-meet-room', key: session.key }]);
  assert.equal(planAt(-30, session).actions.length, 0, 'no hook, no action');
  assert.equal(planAt(-29, { ...session, meetRoomRequestedAt: iso(-30) }, { meetRooms: true }).actions.length, 0);
});

test('a rep who marked the meeting held without recording stops every automatic send', () => {
  const session = { ...dispatched(sessionFor(salesClient()), -3), declinedAt: iso(0) };
  assert.equal(dispatches(planAt(1, session, { active: [] })).length, 0);
  assert.deepEqual(sessionsNeedingVerification([session], at(1)), []);
});

test('a bot in the room before the first-send window belongs to the earlier meeting there', () => {
  // 13:00 moved to 13:30 in the same room while the 13:00 bot is still in: the 13:30 session must not adopt it.
  const moved = sessionFor(salesClient({ meetingAt: iso(30) }), at(0));
  const early = planAt(5, moved, { active: [activeRow()] });
  assert.equal(early.session.state, 'scheduled');
  assert.equal(early.session.firstSeenActiveAt, '');
  assert.equal(planAt(8, early.session, { active: [] }).session.state, 'scheduled', 'and so nothing "left" either');
  assert.deepEqual(dispatches(planAt(27, early.session, { active: [] })).map((row) => row.kind), ['first'], 'it gets its own T-3 knock');
  // From T-3 the bot in the room is this meeting's too.
  assert.equal(planAt(27, early.session, { active: [activeRow()] }).session.state, 'recording');
});

test('one knock per room: two sessions on one room never send in the same tick', () => {
  // The 10:00 bot drops out at 10:15; the 10:20 meeting in the same room is due its first knock at 10:17.
  let first = dispatched(sessionFor(salesClient()), -3);
  first = planAt(0, first, { active: [activeRow()] }).session;
  first = planAt(15, first, { active: [activeRow()] }).session;
  const second = sessionFor(salesClient({ id: 'client-2', meetingAt: iso(20) }), at(0));
  const plan = planLiveSessionTick({ sessions: [first, second], activeMeetings: [], nowMs: at(17) });
  assert.deepEqual(dispatches(plan).map((row) => `${row.kind}:${row.key}`), [`first:${second.key}`]);
  assert.deepEqual(plan.deferred, [{ key: first.key, kind: 'rejoin', reason: 'room' }]);
  assert.equal(plan.sessions.find((row) => row.key === first.key).nextAttemptAt, iso(21));
});

test('a rep\'s "send again" waits four minutes after a knock', () => {
  resetStore();
  const client = salesClient();
  live.upsertLiveSessionsForClient(client, { nowMs: at(-10) });
  updateLiveSessionStore((store) => {
    store.sessions[`${ROOM}|${T}`] = dispatched(store.sessions[`${ROOM}|${T}`], -3);
    return store;
  }, { nowMs: at(-3) });
  const early = live.requestManualLiveJoin({ client, slotKey: `sales:${T}`, nowMs: at(-2) });
  assert.equal(early.queued, false);
  assert.equal(early.reason, 'just-sent');
  assert.match(early.message, /fire minutter/);
  assert.equal(early.recording.canResend, false);
  assert.equal(live.presentLiveRecordings(client, { nowMs: at(1) })[0].canResend, true, 'four minutes later it may');
  // A request already queued is held by the planner until the room is free.
  const queued = { ...dispatched(sessionFor(client), -3), manualRequestedAt: iso(-2) };
  const held = planAt(-2, queued, { active: [] });
  assert.equal(dispatches(held).length, 0);
  assert.deepEqual(held.deferred, [{ key: queued.key, kind: 'manual', reason: 'room' }]);
  assert.equal(held.session.nextAttemptAt, iso(1));
  assert.deepEqual(dispatches(planAt(1, queued, { active: [] })).map((row) => row.kind), ['manual']);
});

test('a late "send again" is followed through its lobby wait', () => {
  let session = dispatched(sessionFor(salesClient()), -3);
  for (const minutes of [1, 5, 15, 25]) session = dispatched(session, minutes, 'retry');
  session = planAt(36, session, { active: [] }).session;
  assert.equal(session.state, 'not-admitted');
  // The meeting started 45 minutes late; the rep sends Fireflies at T+95 (the resend window runs to T+120).
  const plan = planAt(95, { ...session, manualRequestedAt: iso(95) }, { active: [] });
  assert.deepEqual(dispatches(plan).map((row) => row.kind), ['manual']);
  session = applyLiveJoinAttempt(plan.session, { at: iso(95), kind: 'manual', ok: true });
  assert.equal(session.state, 'dispatched');
  assert.deepEqual(sessionsNeedingVerification([session], at(100)), [session.key]);
  assert.equal(planAt(100, session, { active: [] }).session.state, 'dispatched', 'still inside its lobby wait');
  assert.equal(planAt(96, session, { active: [activeRow(ROOM, { id: 'ff-late', startTime: iso(95), endTime: iso(215) })] }).session.state, 'recording');
  assert.equal(planAt(106, session, { active: [] }).session.state, 'not-admitted');
});

test('a bot that leaves an early-ended meeting gets one quiet rejoin, and the card says ended again', () => {
  let session = dispatched(sessionFor(salesClient()), -3);
  session = planAt(-2, session, { active: [activeRow()] }).session;
  session = planAt(29, session, { active: [activeRow()] }).session;
  const gone = planAt(31, session, { active: [] });
  assert.deepEqual(dispatches(gone).map((row) => row.kind), ['rejoin']);
  session = applyLiveJoinAttempt(gone.session, { at: iso(31), kind: 'rejoin', ok: true });
  assert.equal(session.state, 'ended');
  assert.equal(session.message, live.LIVE_JOIN_MESSAGES.rejoined);
  session = planAt(35, session, { active: [] }).session;
  assert.equal(session.state, 'ended');
  assert.equal(session.message, live.LIVE_JOIN_MESSAGES.rejoined, 'the knock still has its lobby wait');
  session = planAt(44, session, { active: [] }).session;
  assert.equal(session.state, 'ended');
  assert.equal(session.message, live.LIVE_JOIN_MESSAGES.ended);
  assert.equal(dispatches(planAt(45, session, { active: [] })).length, 0);
});

test('at the same start, a meeting the client was e-mailed gets the last free send first', () => {
  const unconfirmed = dispatched(sessionFor(salesClient()), -3);
  const confirmed = dispatched(otherRoom('client-2', 0, ROOM_B), -3);
  assert.equal(unconfirmed.confirmed, false);
  assert.equal(confirmed.confirmed, true);
  const limiter = { calls: [{ at: iso(-3), key: unconfirmed.key, kind: 'first' }, { at: iso(-3), key: confirmed.key, kind: 'first' }] };
  const plan = planLiveSessionTick({ sessions: [unconfirmed, confirmed], activeMeetings: [], nowMs: at(1), limiter });
  assert.deepEqual(dispatches(plan).map((row) => row.key), [confirmed.key]);
  assert.deepEqual(plan.deferred.map((row) => `${row.key}:${row.reason}`), [`${unconfirmed.key}:limit`]);
});

test('a continuation bot is announced until it is the one in the room', () => {
  let session = dispatched(sessionFor(salesClient()), -3);
  const oldBot = activeRow(ROOM, { startTime: iso(-3), endTime: iso(117) });
  session = planAt(0, session, { active: [oldBot] }).session;
  const due = planAt(114, session, { active: [oldBot] });
  assert.deepEqual(dispatches(due).map((row) => row.kind), ['continuation']);
  session = applyLiveJoinAttempt(due.session, { at: iso(114), kind: 'continuation', ok: true });
  assert.equal(session.message, live.LIVE_JOIN_MESSAGES.continuation);
  assert.equal(planAt(115, session, { active: [oldBot] }).session.message, live.LIVE_JOIN_MESSAGES.continuation);
  const newBot = activeRow(ROOM, { id: 'ff-meeting-2', startTime: iso(115), endTime: iso(235) });
  const both = planAt(116, session, { active: [oldBot, newBot] }).session;
  assert.equal(both.message, live.LIVE_JOIN_MESSAGES.recording);
  assert.equal(both.ffMeetingId, 'ff-meeting-2');
});

test('a send an older hub (or a lost store) made is followed up, not reported as never sent', () => {
  const stub = `live:client-1:${T}`;
  const client = salesClient({
    calendar: { meetLink: ROOM, confirmedMeetLink: ROOM, firefliesLiveJoinedAt: iso(-3), firefliesLiveJoinedMeetLink: ROOM },
    meetings: [{ meetingId: stub, liveJoinedAt: iso(-3), hasTranscript: false }],
  });
  const [fact] = collectLiveSessions([client], at(40));
  assert.equal(fact.legacyDispatchedAt, iso(-3));
  assert.deepEqual(fact.placeholderIds, [stub]);
  const session = syncLiveSessions({}, [fact], { nowMs: at(40) })[fact.key];
  assert.equal(session.state, 'dispatched');
  assert.equal(session.dispatchedAt, iso(-3));
  assert.deepEqual(session.attempts.map((row) => `${row.kind}:${row.ok}`), ['first:true']);
  assert.deepEqual(sessionsNeedingVerification([session], at(40)), [session.key], 'it is looked for');
  assert.equal(planAt(40, session, { active: [activeRow()] }).session.state, 'recording');
  const missed = planAt(40, session, { active: [] }).session;
  assert.equal(missed.state, 'not-admitted');
  assert.equal(missed.message, live.LIVE_JOIN_MESSAGES.notAdmitted);
  // A stamp from another day or another room is not this meeting's send.
  const stale = salesClient({ calendar: { meetLink: ROOM, confirmedMeetLink: ROOM, firefliesLiveJoinedAt: iso(-24 * 60), firefliesLiveJoinedMeetLink: ROOM } });
  assert.equal(collectLiveSessions([stale], at(-10))[0].legacyDispatchedAt, '');
  const elsewhere = salesClient({ calendar: { meetLink: ROOM, confirmedMeetLink: ROOM, firefliesLiveJoinedAt: iso(-3), firefliesLiveJoinedMeetLink: ROOM_B } });
  assert.equal(collectLiveSessions([elsewhere], at(0))[0].legacyDispatchedAt, '');
});

test('one malformed client record is skipped, not the whole tick or the card list', () => {
  const broken = salesClient({ id: 'client-broken' });
  Object.defineProperty(broken, 'workshopAction', { get() { throw new Error('bad record'); } });
  const good = salesClient({ id: 'client-2', calendar: { meetLink: ROOM_B, confirmedMeetLink: ROOM_B } });
  const sessions = collectLiveSessions([broken, good], at(-10));
  assert.deepEqual(sessions.map((row) => row.slots[0].clientId), ['client-2']);
  assert.deepEqual(live.presentLiveRecordings(broken, { nowMs: at(-10), store: { sessions: {} } }), []);
  assert.equal(live.currentSessionKeyForSlot(broken, { kind: 'sales' }, at(-10)), '');
});

test('capture never overwrites intake\'s missing/empty or a rep\'s declined', () => {
  const session = dispatched(sessionFor(salesClient()), -3);
  const recording = planAt(0, session, { active: [activeRow()] }).session;
  const row = (state) => ({ recording: { state, message: `intake ${state}` } });
  const merged = (current, patch) => mergeRecordingState(current.recording, patch);
  assert.equal(live.placeholderRecordingPatch({}, session).state, 'dispatched', 'no state on the row yet: capture writes it');
  for (const state of ['missing', 'empty', 'declined']) {
    const patch = live.placeholderRecordingPatch(row(state), session);
    assert.equal('state' in patch, false, state);
    assert.equal(merged(row(state), patch).state, state);
    assert.equal(merged(row(state), patch).message, `intake ${state}`);
    assert.equal(merged(row(state), patch).dispatchedAt, iso(-3), 'capture still adds its facts');
  }
  // The bot back in the room, or a rep's accepted "send again", outrank intake; never a rep's declined.
  assert.equal(merged(row('missing'), live.placeholderRecordingPatch(row('missing'), recording)).state, 'recording');
  assert.equal(merged(row('empty'), live.placeholderRecordingPatch(row('empty'), session, { reopen: true })).state, 'dispatched');
  assert.equal(merged(row('declined'), live.placeholderRecordingPatch(row('declined'), recording, { reopen: true })).state, 'declined');
  // The card follows the same rule.
  const client = salesClient({ meetings: [{ meetingId: `live:client-1:${T}`, ...row('missing') }] });
  const store = { sessions: { [session.key]: recording } };
  assert.equal(live.presentLiveRecordings(client, { nowMs: at(1), store })[0].state, 'recording');
  assert.equal(live.presentLiveRecordings(client, { nowMs: at(1), store: { sessions: { [session.key]: session } } })[0].state, 'missing');
});

test('a placeholder is written once per session: one intake dropped never comes back', () => {
  resetStore();
  const client = salesClient();
  const [key] = live.upsertLiveSessionsForClient(client, { nowMs: at(-10) });
  const slot = { stubMeetingId: `live:client-1:${T}` };
  assert.equal(live.shouldCreateLivePlaceholder(readLiveSessionStore().sessions[key], slot, client), false, 'not before a dispatch');
  updateLiveSessionStore((store) => {
    store.sessions[key] = dispatched(store.sessions[key], -3);
    return store;
  }, { nowMs: at(-3) });
  assert.equal(live.shouldCreateLivePlaceholder(readLiveSessionStore().sessions[key], slot, client), true);
  live.noteLivePlaceholderCreated(key, slot.stubMeetingId, { nowMs: at(-3) });
  assert.deepEqual(readLiveSessionStore().sessions[key].placeholderIds, [slot.stubMeetingId]);
  assert.equal(live.shouldCreateLivePlaceholder(readLiveSessionStore().sessions[key], slot, client), false, 'dropped later: stays dropped');
  // An older hub's placeholder (or its stamp) counts as written.
  const legacy = salesClient({ meetings: [{ meetingId: slot.stubMeetingId, liveJoinedAt: iso(-3) }] });
  const [fact] = collectLiveSessions([legacy], at(5));
  assert.equal(live.shouldCreateLivePlaceholder(syncLiveSessions({}, [fact], { nowMs: at(5) })[fact.key], slot, legacy), false);
  // Nor when the client already has this meeting's recording.
  const linked = salesClient({ meetings: [{ meetingId: 'ff-real', hasTranscript: true, meetLink: ROOM, startedAt: iso(1) }] });
  assert.equal(live.shouldCreateLivePlaceholder(dispatched(sessionFor(linked), -3), slot, linked), false);
});

// ── store ────────────────────────────────────────────────────────────────────

test('a corrupt store reads as empty, is kept aside, and a new one is written', () => {
  resetStore();
  writeFileSync(STORE_FILE, '{ not json');
  clearJsonCacheForTests();
  assert.deepEqual(readLiveSessionStore().sessions, {});
  const session = sessionFor(salesClient());
  updateLiveSessionStore((store) => ({ ...store, sessions: { [session.key]: session } }), { nowMs: at(-60) });
  assert.ok(readLiveSessionStore().sessions[session.key]);
  assert.ok(readdirSync(dataDir).some((name) => name.startsWith('fireflies-live-sessions.json.corrupt-')));
});

test('a one-client upsert never drops another client\'s sessions or slots', () => {
  resetStore();
  const shared = salesClient({ id: 'client-2' });
  live.upsertLiveSessionsForClient(shared, { nowMs: at(-60) });
  const elsewhere = salesClient({ id: 'client-3', meetingAt: iso(120), calendar: { meetLink: ROOM_C, confirmedMeetLink: ROOM_C } });
  live.upsertLiveSessionsForClient(elsewhere, { nowMs: at(-60) });
  live.upsertLiveSessionsForClient(salesClient(), { nowMs: at(-59) });
  const store = readLiveSessionStore();
  assert.equal(Object.keys(store.sessions).length, 2);
  assert.deepEqual(store.sessions[`${ROOM}|${T}`].slots.map((slot) => slot.clientId).sort(), ['client-1', 'client-2']);
});

// ── engine ───────────────────────────────────────────────────────────────────

function engineDeps(state, overrides = {}) {
  return {
    nowMs: state.now,
    log: null,
    listClients: () => state.clients,
    apiKey: () => 'test-key',
    fetchActiveMeetings: async () => {
      state.verifyCalls += 1;
      return state.active;
    },
    addToLive: async (input) => {
      state.sent.push(input);
      return state.reply ? state.reply(input) : { ok: true, message: 'ok' };
    },
    onDispatch: (event) => state.dispatchEvents.push(event),
    onSessionChange: (event) => state.changeEvents.push(event),
    ...overrides,
  };
}

function engineState(clients) {
  return { now: at(-3), clients, active: [], sent: [], verifyCalls: 0, dispatchEvents: [], changeEvents: [], reply: null };
}

test('engine: a room that is not open yet is asked about again next tick; an open one only once', async () => {
  resetStore();
  const state = engineState([salesClient()]);
  const asked = [];
  let answer = { ok: false, reason: 'scope-missing' };
  const deps = () => engineDeps(state, {
    openMeetRoom: async (session) => {
      asked.push(session.meetLink);
      return answer;
    },
  });
  state.now = at(-30);
  await runFirefliesLiveJoinTick(deps());
  assert.equal(readLiveSessionStore().sessions[`${ROOM}|${T}`].meetRoomRequestedAt, '');
  state.now = at(-29);
  answer = { ok: true, accessType: 'OPEN' };
  await runFirefliesLiveJoinTick(deps());
  assert.equal(readLiveSessionStore().sessions[`${ROOM}|${T}`].meetRoomRequestedAt, iso(-29));
  state.now = at(-28);
  await runFirefliesLiveJoinTick(deps());
  assert.deepEqual(asked, [ROOM, ROOM]);
  assert.equal(state.sent.length, 0, 'opening the room sends no bot');
  // server.js hands the engine the Meet-room opener with the room host's login.
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /openMeetRoom: openLiveSessionMeetRoom,/);
  const opener = server.slice(server.indexOf('async function openLiveSessionMeetRoom'), server.indexOf('function firefliesLiveJoinOneBot'));
  assert.match(opener, /ensureMeetRoomOpen\(\{[\s\S]*meetLink: session\.meetLink[\s\S]*maxAgeMs: 15 \* 60 \* 1000/);
});

test('engine: dispatch at T-3 with duration 120, look every minute, retry at T+1, then record the sighting', async () => {
  resetStore();
  const state = engineState([salesClient()]);
  const first = await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(first.dispatched.length, 1);
  assert.deepEqual(state.sent, [{ meetingLink: ROOM, title: 'Testfirma AS · Kari Test', durationMinutes: 120 }]);
  assert.equal(state.dispatchEvents[0].attempt.ok, true);
  assert.equal(state.dispatchEvents[0].session.state, 'dispatched');
  let store = readLiveSessionStore();
  assert.equal(store.limiter.calls.length, 1);
  assert.equal(store.sessions[`${ROOM}|${T}`].dispatchedAt, iso(-3));

  state.now = at(-2);
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.sent.length, 1, 'no second knock before T+1');
  assert.equal(state.verifyCalls, 2);

  state.now = at(1);
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.sent.length, 2);

  state.now = at(2);
  state.active = [activeRow()];
  await runFirefliesLiveJoinTick(engineDeps(state));
  store = readLiveSessionStore();
  assert.equal(store.sessions[`${ROOM}|${T}`].state, 'recording');
  assert.ok(state.changeEvents.some((event) => event.session.state === 'recording'));
});

test('engine: a rate-limit answer blocks the limiter; a safe-mode refusal is not counted', async () => {
  resetStore();
  const state = engineState([salesClient()]);
  state.reply = () => {
    const error = new Error('Too many requests');
    error.code = 'rate-limited';
    error.retryAfterMs = 5 * MIN;
    throw error;
  };
  await runFirefliesLiveJoinTick(engineDeps(state));
  let store = readLiveSessionStore();
  assert.equal(store.limiter.blockedUntil, iso(2));
  state.now = at(-2);
  state.reply = null;
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.sent.length, 1, 'blocked: nothing sent');

  resetStore();
  const safe = engineState([salesClient()]);
  safe.reply = () => ({ ok: false, safeMode: true, message: 'Blocked by hub safe mode (firefliesLiveJoin).' });
  await runFirefliesLiveJoinTick(engineDeps(safe));
  store = readLiveSessionStore();
  assert.equal(store.limiter.calls.length, 0);
  assert.equal(store.sessions[`${ROOM}|${T}`].attempts.length, 0);
});

test('engine: a retry planned before the bot_joined webhook said the bot is in is not sent', async () => {
  resetStore();
  const state = engineState([salesClient()]);
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.sent.length, 1, 'the first knock at 09:57');
  live.resetFirefliesLiveJoinEngineForTests();
  state.now = at(1);
  await runFirefliesLiveJoinTick(engineDeps(state, {
    // The rep lets the bot in while the look is out, so the look answers a moment too early.
    fetchActiveMeetings: async () => {
      await live.noteFirefliesBotJoined({ meetingId: 'ff-bot-1', fetchPresence: async () => ({ meetingLink: ROOM, isLive: true }), nowMs: at(1) });
      return [];
    },
  }));
  assert.equal(state.sent.length, 1, 'no second bot at the door of a meeting being recorded');
  const session = readLiveSessionStore().sessions[`${ROOM}|${T}`];
  assert.deepEqual([session.state, session.message, session.attempts.length], ['recording', live.LIVE_JOIN_MESSAGES.recording, 1]);
});

test('engine: a send is stamped and counted when it goes out, not when its tick began', async () => {
  resetStore();
  const state = engineState([salesClient()]);
  // A tick that began at 10:00 sends at 10:00:30, after a room open and a look.
  state.now = at(0);
  await runFirefliesLiveJoinTick(engineDeps(state, { clock: () => at(0.5) }));
  let store = readLiveSessionStore();
  assert.equal(store.sessions[`${ROOM}|${T}`].attempts[0].at, iso(0.5));
  assert.deepEqual(store.limiter.calls.map((call) => call.at), [iso(0.5)]);

  // A tick stuck since 10:00 resumes at 10:02:30, after the tick that took over sent three: the limit holds.
  resetStore();
  const stuck = engineState([salesClient()]);
  updateLiveSessionStore((current) => ({
    ...current,
    limiter: { calls: ['a', 'b', 'c'].map((key) => ({ at: iso(2.5), key, kind: 'first' })) },
  }), { nowMs: at(2.5) });
  stuck.now = at(0);
  await runFirefliesLiveJoinTick(engineDeps(stuck, { clock: () => at(2.5) }));
  assert.equal(stuck.sent.length, 0, 'no fourth call inside 20 minutes');
  store = readLiveSessionStore();
  assert.equal(store.limiter.calls.length, 3);

  // An "exceeded" answer with no retry-after blocks for a minute, not a whole window.
  resetStore();
  const exceeded = engineState([salesClient()]);
  exceeded.reply = () => ({ ok: false, error: { message: 'Rate limit exceeded' } });
  await runFirefliesLiveJoinTick(engineDeps(exceeded));
  assert.equal(readLiveSessionStore().limiter.blockedUntil, iso(-2));
});

test('engine: a send another hub process has out stands this one back (one knock, not two)', async () => {
  resetStore();
  live.upsertLiveSessionsForClient(salesClient(), { nowMs: at(-10) });
  updateLiveSessionStore((store) => {
    store.sessions[`${ROOM}|${T}`].dispatchingAt = iso(-3.5);
    return store;
  }, { nowMs: at(-10) });
  const state = engineState([salesClient()]);
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.sent.length, 0);
  assert.equal(readLiveSessionStore().limiter.calls.length, 0, 'a send that did not happen is not counted');
  state.now = at(-1);
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.sent.length, 1, 'a mark older than 2 minutes no longer holds the session');
  assert.equal(readLiveSessionStore().sessions[`${ROOM}|${T}`].dispatchingAt, '');
});

test('engine: one failing session does not stop the others', async () => {
  resetStore();
  const other = salesClient({ id: 'client-2', calendar: { meetLink: ROOM_B, confirmedMeetLink: ROOM_B } });
  const state = engineState([salesClient(), other]);
  state.reply = (input) => {
    if (input.meetingLink === ROOM) throw new Error('boom');
    return { ok: true, message: 'ok' };
  };
  const summary = await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.sent.length, 2);
  const store = readLiveSessionStore();
  assert.equal(store.sessions[`${ROOM_B}|${T}`].state, 'dispatched');
  assert.equal(store.sessions[`${ROOM}|${T}`].attempts[0].ok, false);
  assert.ok(summary.dispatched.some((row) => row.ok === false));
});

test('engine: no API key means no look and no send; a stuck tick is let go after 2 minutes', async () => {
  resetStore();
  const state = engineState([salesClient()]);
  await runFirefliesLiveJoinTick(engineDeps(state, { apiKey: () => '' }));
  assert.equal(state.sent.length, 0);
  assert.equal(state.verifyCalls, 0);

  resetStore();
  const releases = [];
  const hang = () => new Promise((resolve) => { releases.push(resolve); });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const stuck = engineState([salesClient()]);
  const first = runFirefliesLiveJoinTick(engineDeps(stuck, { addToLive: hang }));
  await settle();
  assert.deepEqual(await runFirefliesLiveJoinTick(engineDeps({ ...stuck, now: at(-2) })), { skipped: 'running' });
  // Four minutes later the watchdog lets a new tick start (it hangs too: the first answer never came back).
  const second = runFirefliesLiveJoinTick(engineDeps({ ...stuck, now: at(1), active: [] }, { addToLive: hang }));
  await settle();
  assert.equal(releases.length, 2);
  releases[0]({ ok: true, message: 'ok' });
  await first;
  assert.equal(live.firefliesLiveJoinStatus({ nowMs: at(1) }).running, true, 'the late tick does not clear the new one');
  releases[1]({ ok: true, message: 'ok' });
  await second;
  assert.equal(live.firefliesLiveJoinStatus({ nowMs: at(1) }).running, false);
});

test('engine: a tick kicked seconds after a look reuses it, unless that tick may send', async () => {
  resetStore();
  const soon = salesClient({ id: 'client-2', meetingAt: iso(2), calendar: { meetLink: ROOM_B, confirmedMeetLink: ROOM_B } });
  const state = engineState([salesClient(), soon]);
  state.now = at(-1) - 20_000;
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.verifyCalls, 1);
  assert.equal(state.sent.length, 1, 'the 10:00 knock');
  state.now = at(-1) - 10_000;
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.verifyCalls, 1, 'a card save 10 s later: nothing due, no second look');
  state.now = at(-1);
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.verifyCalls, 2, 'the 10:02 first knock is due: look first, even 20 s after the last look');
  assert.equal(state.sent.length, 2);
  state.now = at(0);
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.verifyCalls, 3, 'the minute loop looks again');
});

test('engine: a rep\'s "declined" saved after the tick read the clients still stops the send', async () => {
  resetStore();
  const state = engineState([salesClient()]);
  const declined = salesClient({ meetings: [{ meetingId: `live:client-1:${T}`, recording: { state: 'declined' } }] });
  await runFirefliesLiveJoinTick(engineDeps(state, { getClient: () => declined }));
  assert.equal(state.sent.length, 0);
  const session = readLiveSessionStore().sessions[`${ROOM}|${T}`];
  assert.equal(session.declinedAt, iso(-3));
  assert.equal(readLiveSessionStore().limiter.calls.length, 0);
});

test('a bot_joined webhook marks the session on that room as recording', async () => {
  resetStore();
  live.upsertLiveSessionsForClient(salesClient(), { nowMs: at(-10) });
  const changed = await live.noteFirefliesBotJoined({
    meetingId: 'ff-meeting-9',
    nowMs: at(0),
    fetchPresence: async (id) => ({ id, meetingLink: `${ROOM}?pli=1` }),
  });
  assert.equal(changed.length, 1);
  const session = readLiveSessionStore().sessions[`${ROOM}|${T}`];
  assert.equal(session.state, 'recording');
  assert.equal(session.ffMeetingId, 'ff-meeting-9');
  // A bot joining the room 30 minutes before a later meeting there is that earlier meeting's bot.
  live.upsertLiveSessionsForClient(salesClient({ meetingAt: iso(60) }), { nowMs: at(0) });
  const early = await live.noteFirefliesBotJoined({
    meetingId: 'ff-meeting-10',
    nowMs: at(30),
    fetchPresence: async (id) => ({ id, meetingLink: ROOM }),
  });
  assert.deepEqual(early.map((row) => row.key), [`${ROOM}|${T}`]);
  assert.equal(readLiveSessionStore().sessions[`${ROOM}|${at(60)}`].state, 'scheduled');
});

// ── card data and the manual route ───────────────────────────────────────────

test('liveRecordings shows the card state from T-30 to T+booked+2h', () => {
  resetStore();
  const client = salesClient();
  assert.deepEqual(live.presentLiveRecordings(client, { nowMs: at(-31) }), []);
  const [row] = live.presentLiveRecordings(client, { nowMs: at(-30) });
  assert.equal(row.slotKey, `sales:${T}`);
  assert.equal(row.kind, 'sales');
  assert.equal(row.state, 'scheduled');
  assert.equal(row.nextAttemptAt, iso(-3));
  assert.equal(row.canResend, false, 'resend opens 15 minutes before start');
  assert.equal(live.presentLiveRecordings(client, { nowMs: at(-10) })[0].canResend, true);
  assert.equal(live.presentLiveRecordings(client, { nowMs: at(-10), liveJoinEnabled: false })[0].message, live.LIVE_JOIN_MESSAGES.safeMode);
  assert.deepEqual(live.presentLiveRecordings(client, { nowMs: at(60 + 121) }), []);
  for (const field of ['slotKey', 'kind', 'startAt', 'meetLink', 'state', 'attempts', 'lastAttemptAt', 'verifiedAt', 'message', 'nextAttemptAt', 'canResend']) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, field), field);
  }
});

/**
 * The bot sat alone in the open room from T+1 and left at T+11; by T+13 intake has linked `linked` to the
 * card. Returns the engine's state after the T+13 tick and the session as stored.
 */
async function botLeftAloneWith(linked) {
  resetStore();
  const client = salesClient();
  const state = engineState([client]);
  await runFirefliesLiveJoinTick(engineDeps(state));
  const bot = activeRow(ROOM, { startTime: iso(1) });
  for (const minutes of [1, 6, 11]) {
    state.now = at(minutes);
    state.active = [bot];
    await runFirefliesLiveJoinTick(engineDeps(state));
  }
  client.meetings.push(linked);
  state.now = at(13);
  state.active = [];
  await runFirefliesLiveJoinTick(engineDeps(state));
  return { state, client, session: readLiveSessionStore().sessions[`${ROOM}|${T}`] };
}

test('a "hallo?" fragment or live captions on the card are not the meeting\'s recording: the bot is sent back', async () => {
  const ff = await import('../lib/fireflies-webhook.js');
  const lastKind = (state) => state.dispatchEvents.at(-1)?.attempt?.kind;
  // Two sentences from the empty room, linked by intake: not the recording.
  const fragment = await botLeftAloneWith({ meetingId: 'FFHALLO2', meetLink: ROOM, startedAt: iso(1), hasTranscript: true, sentenceCount: 2 });
  assert.equal(fragment.session.transcriptSeenAt, '');
  assert.equal(lastKind(fragment.state), 'rejoin', 'the bot goes back for the real meeting');
  const [card] = live.presentLiveRecordings(fragment.client, { nowMs: at(13) });
  assert.equal(card.hasTranscript, false, 'the card does not say the recording is in');

  // Live captions of a meeting that is still on, linked mid-meeting: not the recording either.
  ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: 'FFCAPT01' }, {
    id: 'FFCAPT01',
    title: 'Opptak',
    dateString: iso(1),
    meeting_link: ROOM,
    is_live: true,
    sentences: Array.from({ length: 30 }, (_, index) => ({ speaker_name: 'Kari Test', text: `Setning ${index + 1}.` })),
  }), { nowMs: at(12) });
  const captions = await botLeftAloneWith({ meetingId: 'FFCAPT01', meetLink: ROOM, startedAt: iso(1), hasTranscript: true, sentenceCount: 30 });
  assert.equal(captions.session.transcriptSeenAt, '');
  assert.equal(lastKind(captions.state), 'rejoin');

  // The meeting's recording (a meeting's worth of talk) stops the rejoin.
  const real = await botLeftAloneWith({ meetingId: 'FFREAL10', meetLink: ROOM, startedAt: iso(1), hasTranscript: true, sentenceCount: 40 });
  assert.equal(real.session.transcriptSeenAt, iso(13));
  assert.notEqual(lastKind(real.state), 'rejoin');
  assert.equal(live.presentLiveRecordings(real.client, { nowMs: at(13) })[0].hasTranscript, true);
});

test('the session rule is the card\'s rule: a slot covered on the card is covered for capture, with or without its row', () => {
  resetStore();
  const [fact] = collectLiveSessions([salesClient()], at(-60));
  const session = syncLiveSessions({}, [fact], { nowMs: at(-60) })[fact.key];
  const stub = `live:client-1:${T}`;
  const placeholder = { meetingId: stub, slotKey: `sales:${T}`, startedAt: iso(0), meetLink: ROOM, hasTranscript: false, recording: { state: 'ended' } };
  const real = { meetingId: 'FFREAL11', meetLink: ROOM, startedAt: iso(2), hasTranscript: true, sentenceCount: 25 };
  for (const meetings of [[real], [placeholder, real]]) {
    assert.equal(live.clientHasTranscriptForSession(salesClient({ meetings }), session), true);
  }
  // Another room at the same time, put there by nobody: not this slot's recording.
  assert.equal(live.clientHasTranscriptForSession(salesClient({ meetings: [{ ...real, meetLink: ROOM_C }] }), session), false);
  // A recording two hours after the booked hour in the same room is a later meeting there.
  assert.equal(live.clientHasTranscriptForSession(salesClient({ meetings: [{ ...real, startedAt: iso(150) }] }), session), false);
  // Its stored copy decides over the row: a silent copy is no recording.
  const silentCopy = (id) => (id === 'FFREAL11' ? { meetingId: id, transcript: '', summary: '', summaryStatus: 'skipped' } : null);
  assert.equal(live.clientHasTranscriptForSession(salesClient({ meetings: [real] }), session, { storedOf: silentCopy }), false);
});

test('a manual send is queued for the slot, not while the bot is in the room', () => {
  resetStore();
  const client = salesClient();
  const missing = live.requestManualLiveJoin({ client, slotKey: 'sales:1', nowMs: at(5) });
  assert.equal(missing.queued, false);
  assert.equal(missing.reason, 'not-found');
  const queued = live.requestManualLiveJoin({ client, slotKey: `sales:${T}`, nowMs: at(5) });
  assert.equal(queued.queued, true);
  assert.equal(queued.recording.canResend, false, 'already queued');
  assert.equal(readLiveSessionStore().sessions[`${ROOM}|${T}`].manualRequestedAt, iso(5));
  const blocked = live.requestManualLiveJoin({ client, slotKey: `sales:${T}`, nowMs: at(5), liveJoinEnabled: false });
  assert.equal(blocked.reason, 'safe-mode');
  updateLiveSessionStore((store) => {
    store.sessions[`${ROOM}|${T}`].state = 'recording';
    store.sessions[`${ROOM}|${T}`].manualRequestedAt = '';
    return store;
  });
  assert.equal(live.requestManualLiveJoin({ client, slotKey: `sales:${T}`, nowMs: at(6) }).reason, 'recording');
});

test('a manual request made while a tick runs survives the tick\'s own writes', async () => {
  resetStore();
  live.upsertLiveSessionsForClient(salesClient(), { nowMs: at(-10) });
  // Five knocks nobody let in: the tick at T+40 only looks, and sends nothing on its own.
  updateLiveSessionStore((store) => {
    let session = store.sessions[`${ROOM}|${T}`];
    for (const [minutes, kind] of [[-3, 'first'], [1, 'retry'], [5, 'retry'], [15, 'retry'], [25, 'retry']]) {
      session = applyLiveJoinAttempt(session, { at: iso(minutes), kind, ok: true });
    }
    store.sessions[session.key] = { ...session, state: 'not-admitted' };
    return store;
  }, { nowMs: at(30) });
  const state = engineState([salesClient()]);
  state.now = at(40);
  // The rep presses "send again" while that tick is looking at the room.
  await runFirefliesLiveJoinTick(engineDeps(state, {
    fetchActiveMeetings: async () => {
      const queued = live.requestManualLiveJoin({ client: salesClient(), slotKey: `sales:${T}`, nowMs: at(40) });
      assert.equal(queued.queued, true);
      return [];
    },
  }));
  assert.equal(state.sent.length, 0);
  let session = readLiveSessionStore().sessions[`${ROOM}|${T}`];
  assert.equal(session.manualRequestedAt, iso(40), 'the tick wrote its look without dropping the request');
  assert.equal(session.checkedAt, iso(40));
  state.now = at(41);
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.sent.length, 1);
  session = readLiveSessionStore().sessions[`${ROOM}|${T}`];
  assert.equal(session.attempts.at(-1).kind, 'manual');
  assert.equal(session.state, 'dispatched');
  assert.equal(session.manualRequestedAt, '');
});

test('the sales session uses the room the client was e-mailed', () => {
  const client = salesClient({ calendar: { meetLink: ROOM_B, confirmedMeetLink: ROOM } });
  assert.equal(collectLiveSessions([client], at(-60))[0].meetLink, ROOM);
});

test('the fred@ owner: damian@asoldi.com until Fireflies says otherwise, asked at most once per 6 hours', async () => {
  const owner = await import('../lib/fireflies-key-owner.js');
  owner.resetFirefliesKeyOwnerForTests();
  assert.equal(owner.firefliesKeyOwnerEmail(), 'damian@asoldi.com');
  assert.equal(owner.firefliesNotetakerAllowedForOrganizer('Damian@asoldi.com'), true);
  assert.equal(owner.firefliesNotetakerAllowedForOrganizer('alexander@asoldi.com'), false);
  assert.equal(owner.firefliesNotetakerAllowedForOrganizer(''), false, 'an unknown organizer gets no fred@');
  let asked = 0;
  const fetchOwnerEmail = async () => {
    asked += 1;
    return 'Eier@firma.no';
  };
  assert.equal(await owner.refreshFirefliesKeyOwnerEmail({ fetchOwnerEmail, nowMs: at(0) }), 'eier@firma.no');
  assert.equal(await owner.refreshFirefliesKeyOwnerEmail({ fetchOwnerEmail, nowMs: at(5 * 60) }), 'eier@firma.no');
  assert.equal(asked, 1);
  assert.equal(owner.firefliesNotetakerAllowedForOrganizer('damian@asoldi.com'), false);
  await owner.refreshFirefliesKeyOwnerEmail({ fetchOwnerEmail: async () => { throw new Error('down'); }, nowMs: at(6 * 60 + 1) });
  assert.equal(owner.firefliesKeyOwnerEmail(), 'eier@firma.no', 'a failed lookup keeps the last owner');
  owner.resetFirefliesKeyOwnerForTests();
});

test('status for a health card', () => {
  const status = live.firefliesLiveJoinStatus({ nowMs: at(0), apiKeyPresent: true });
  assert.equal(status.limiter.limit, 3);
  assert.equal(status.limiter.windowMinutes, 20);
  assert.equal(typeof status.sessionsInWindow, 'number');
  assert.equal(status.safeModeBlocking, false);
  assert.equal(status.keyOwnerEmail, 'damian@asoldi.com');
  assert.ok(existsSync(dataDir));
});
