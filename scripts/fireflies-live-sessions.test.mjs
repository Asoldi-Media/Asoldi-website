import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-live-sessions-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const live = await import('../lib/fireflies-live-sessions.js');
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
  assert.equal(session.state, 'dispatched');
  session = planAt(22, session, { active: [activeRow(ROOM, { id: 'ff-meeting-2' })] }).session;
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

test('the bot leaves one minute before the next booked meeting is sent in', () => {
  const session = sessionFor(salesClient());
  const next = sessionFor(salesClient({ id: 'client-2', meetingAt: iso(60), calendar: { meetLink: ROOM_B, confirmedMeetLink: ROOM_B } }));
  const plan = planAt(-3, session, { others: [next] });
  assert.equal(dispatches(plan)[0].durationMinutes, 59);
  const soon = sessionFor(salesClient({ id: 'client-3', meetingAt: iso(10), calendar: { meetLink: ROOM_C, confirmedMeetLink: ROOM_C } }));
  assert.equal(dispatches(planAt(-3, session, { others: [soon] }))[0].durationMinutes, 15, 'never under the minimum');
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
  const state = engineState([salesClient()]);
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.sent.length, 1);
  // The rep presses "send again" while the next tick is looking at the room.
  state.now = at(-2);
  await runFirefliesLiveJoinTick(engineDeps(state, {
    fetchActiveMeetings: async () => {
      const queued = live.requestManualLiveJoin({ client: salesClient(), slotKey: `sales:${T}`, nowMs: at(-2) });
      assert.equal(queued.queued, true);
      return [];
    },
  }));
  let session = readLiveSessionStore().sessions[`${ROOM}|${T}`];
  assert.equal(session.manualRequestedAt, iso(-2), 'the tick wrote its look without dropping the request');
  assert.equal(session.checkedAt, iso(-2));
  state.now = at(-1);
  await runFirefliesLiveJoinTick(engineDeps(state));
  assert.equal(state.sent.length, 2);
  session = readLiveSessionStore().sessions[`${ROOM}|${T}`];
  assert.deepEqual(session.attempts.map((row) => row.kind), ['first', 'manual']);
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
