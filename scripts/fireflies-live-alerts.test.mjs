// No booked meeting ends without a recording unnoticed: every session that never got the bot in has a
// placeholder that says why and is followed to 'missing'; the rep hears while the bot knocks; an empty
// recording is reported once; the owner hears when live join is down; "uten opptak" can be set and undone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-live-alerts-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const live = await import('../lib/fireflies-live-sessions.js');
const alerts = await import('../lib/fireflies-live-alerts.js');
const watchdog = await import('../lib/fireflies-recording-watchdog.js');
const ingest = await import('../lib/fireflies-ingest.js');
const { mergeRecordingState } = await import('../lib/fireflies-recording-state.js');
const { resetFirefliesStoreForTests } = await import('../lib/fireflies-store.js');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');
const { LIVE_JOIN_MESSAGES, applyLiveJoinAttempt, readLiveSessionStore, runFirefliesLiveJoinTick, updateLiveSessionStore } = live;

const MIN = 60_000;
const T = Date.parse('2026-11-02T10:00:00.000Z');
const at = (minutes) => T + minutes * MIN;
const iso = (minutes) => new Date(at(minutes)).toISOString();
const ROOM = 'https://meet.google.com/abc-defg-hij';
const ROOM_B = 'https://meet.google.com/bcd-efgh-ijk';
const ROOM_C = 'https://meet.google.com/cde-fghi-jkl';
const quiet = { log() {}, warn() {}, error() {} };

function salesClient(overrides = {}) {
  return {
    id: 'client-1',
    businessName: 'Testfirma AS',
    contactPerson: 'Kari Test',
    ownerId: 'sales:rep-1',
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

const KEY = `${ROOM}|${T}`;
const STUB = `live:client-1:${T}`;

function resetAll() {
  rmSync(join(dataDir, 'fireflies-live-sessions.json'), { force: true });
  rmSync(join(dataDir, 'fireflies-ingest-state.json'), { force: true });
  clearJsonCacheForTests();
  resetFirefliesStoreForTests();
  live.resetFirefliesLiveJoinEngineForTests();
  alerts.resetFirefliesLiveAlertsForTests();
  ingest.resetFirefliesIngestForTests();
  watchdog.resetFirefliesWatchdogForTests();
}

function engineDeps(state, overrides = {}) {
  return {
    nowMs: state.now,
    log: null,
    listClients: () => state.clients,
    getClient: (id) => state.clients.find((client) => client.id === id) || null,
    apiKey: () => 'test-key',
    fetchActiveMeetings: async () => state.active,
    addToLive: async (input) => {
      state.sent.push(input);
      return state.reply ? state.reply(input) : { ok: true, message: 'ok' };
    },
    ...overrides,
  };
}

async function tickAt(state, minutes, overrides = {}) {
  state.now = at(minutes);
  return runFirefliesLiveJoinTick(engineDeps(state, overrides));
}

/** What server.js writeUnsentLivePlaceholder writes (data/sales.js keeps these fields). */
function rowWriter(clients) {
  return ({ session, slot, recording }) => {
    const client = clients.find((item) => item.id === slot.clientId);
    if (!client || client.meetings.some((row) => row.meetingId === slot.stubMeetingId)) return null;
    client.meetings.push({
      meetingId: slot.stubMeetingId,
      title: session.title,
      startedAt: session.startAt,
      meetLink: session.meetLink,
      hasTranscript: false,
      liveJoinedAt: '',
      source: 'live-join',
      linkedBy: 'live-join',
      forSalesMeeting: slot.kind === 'sales',
      purpose: slot.purpose,
      slotKey: slot.slotKey,
      recording: mergeRecordingState(null, recording),
    });
    return client;
  };
}

/** The watchdog's server deps, on in-memory clients. */
function watchdogHub(clients) {
  const sent = [];
  const deps = {
    getClients: () => clients,
    patchPlaceholder: (clientId, meetingId, patch) => {
      const row = clients.find((client) => client.id === clientId)?.meetings.find((item) => item.meetingId === meetingId);
      if (!row) return null;
      row.recording = mergeRecordingState(row.recording, patch);
      return row;
    },
    linkTranscript: () => {},
    recipientsFor: async () => ['ansatte@asoldi.com', 'alexander@asoldi.com'],
    sendEmail: async (message) => { sent.push(message); },
    apiKey: 'fake-key',
    log: quiet,
  };
  const run = (minutes, list = []) => watchdog.runFirefliesRecordingWatchdog({
    ...deps,
    nowMs: at(minutes),
    lookup: (placeholder) => watchdog.lookupPlaceholderTranscript(placeholder, {
      apiKey: 'fake-key',
      nowMs: at(minutes),
      listTranscripts: async () => list,
      hydrate: async () => ({ outcome: 'failed', error: new Error('Object not found') }),
      storedRows: () => [],
      readStored: () => null,
    }),
  });
  return { sent, run };
}

// ── 1. no silent sessions ───────────────────────────────────────────────────

test('a session never sent says why when it gives up: no key, the rate limit, a refusal, or never tried', async () => {
  resetAll();
  const noKey = { clients: [salesClient()], active: [], sent: [], reply: null };
  await tickAt(noKey, -3, { apiKey: () => '' });
  assert.equal(readLiveSessionStore().sessions[KEY].unsentReason, 'no-api-key');
  await tickAt(noKey, 31, { apiKey: () => '' });
  let session = readLiveSessionStore().sessions[KEY];
  assert.equal(session.state, 'not-admitted');
  assert.equal(session.message, LIVE_JOIN_MESSAGES.neverSentNoKey);
  assert.equal(noKey.sent.length, 0);

  resetAll();
  const limited = { clients: [salesClient()], active: [], sent: [], reply: null };
  updateLiveSessionStore((store) => ({ ...store, limiter: { calls: [-6, -5, -4].map((m) => ({ at: iso(m), key: 'other', kind: 'first' })) } }), { nowMs: at(-4) });
  await tickAt(limited, -3);
  assert.equal(limited.sent.length, 0, 'three calls in the last 20 minutes: no room');
  assert.equal(readLiveSessionStore().sessions[KEY].unsentReason, 'rate-limited');
  updateLiveSessionStore((store) => ({ ...store, limiter: { calls: [] } }), { nowMs: at(31) });
  await tickAt(limited, 31);
  assert.equal(readLiveSessionStore().sessions[KEY].message, LIVE_JOIN_MESSAGES.neverSentLimited);

  resetAll();
  const refused = { clients: [salesClient()], active: [], sent: [], reply: () => ({ ok: false, error: { code: 'unsupported_platform', message: 'unsupported_platform' } }) };
  await tickAt(refused, -3);
  await tickAt(refused, 31);
  session = readLiveSessionStore().sessions[KEY];
  assert.equal(session.state, 'not-admitted');
  assert.match(session.message, /^Fireflies tok ikke imot forespørselen om å bli med i møtet \(unsupported_platform\)/);

  resetAll();
  const down = { clients: [salesClient()], active: [], sent: [], reply: null };
  // The hub was down through the whole first-send window.
  await tickAt(down, 31);
  session = readLiveSessionStore().sessions[KEY];
  assert.equal(session.state, 'not-admitted');
  assert.equal(session.message, LIVE_JOIN_MESSAGES.neverSent);
  assert.equal(live.liveSessionUnsentReason(session), 'never-sent');

  // A knock Fireflies accepted that nobody answered is the "not let in" case.
  const knocked = applyLiveJoinAttempt(session, { at: iso(-3), kind: 'first', ok: true });
  assert.equal(live.liveSessionUnsentReason(knocked), 'not-let-in');
  assert.equal(live.notAdmittedMessage(knocked), LIVE_JOIN_MESSAGES.notAdmitted);
});

test('a session that ends without a bot gets one placeholder per slot: honest state, no liveJoinedAt, never twice', async () => {
  resetAll();
  const client = salesClient();
  const state = { clients: [client], active: [], sent: [], reply: null };
  await tickAt(state, -3, { apiKey: () => '' });
  await tickAt(state, 31, { apiKey: () => '' });
  const writer = rowWriter(state.clients);
  const created = live.ensureLivePlaceholders({ clients: state.clients, writePlaceholder: writer, nowMs: at(31), log: quiet });
  assert.deepEqual(created.map((row) => row.meetingId), [STUB]);
  const [row] = client.meetings;
  assert.equal(row.recording.state, 'not-admitted');
  assert.equal(row.recording.message, LIVE_JOIN_MESSAGES.neverSentNoKey);
  assert.equal(row.recording.dispatchedAt, '', 'nothing was sent');
  assert.equal(row.liveJoinedAt, '', 'no claim that Fireflies was in the meeting');
  assert.equal(row.slotKey, `sales:${T}`);
  assert.deepEqual(readLiveSessionStore().sessions[KEY].placeholderIds, [STUB]);
  assert.deepEqual(live.ensureLivePlaceholders({ clients: state.clients, writePlaceholder: writer, nowMs: at(32), log: quiet }), []);
  // Intake dropped it (a recording was linked, or the rep's paste): it never comes back.
  client.meetings = [];
  assert.deepEqual(live.ensureLivePlaceholders({ clients: state.clients, writePlaceholder: writer, nowMs: at(40), log: quiet }), []);
  assert.equal(client.meetings.length, 0);
});

test('no placeholder when the recording with talk is linked; a silent fragment does not count', async () => {
  resetAll();
  const fragment = { meetingId: 'FFFRAG01', meetLink: ROOM, startedAt: iso(-2), hasTranscript: false };
  const client = salesClient({ meetings: [fragment] });
  const state = { clients: [client], active: [], sent: [], reply: null };
  await tickAt(state, 31, { apiKey: () => '' });
  const writer = rowWriter(state.clients);
  assert.equal(live.ensureLivePlaceholders({ clients: state.clients, writePlaceholder: writer, nowMs: at(31), log: quiet }).length, 1, 'a silent fragment is not the recording');

  resetAll();
  const talk = salesClient({ meetings: [{ meetingId: 'FFTALK01', meetLink: ROOM, startedAt: iso(1), hasTranscript: true }] });
  const linked = { clients: [talk], active: [], sent: [], reply: null };
  await tickAt(linked, 31, { apiKey: () => '' });
  assert.deepEqual(live.ensureLivePlaceholders({ clients: linked.clients, writePlaceholder: rowWriter(linked.clients), nowMs: at(31), log: quiet }), []);
  // Recorded in another room but put on this slot (a person's link, or Track C's matching, which also
  // gives the row its purpose): linked too.
  resetAll();
  const elsewhere = salesClient({ meetings: [{ meetingId: 'FFSLOT01', meetLink: ROOM_C, slotKey: `sales:${T}`, purpose: 'sales', forSalesMeeting: true, startedAt: iso(3), hasTranscript: true }] });
  const slotLinked = { clients: [elsewhere], active: [], sent: [], reply: null };
  await tickAt(slotLinked, 31, { apiKey: () => '' });
  assert.deepEqual(live.ensureLivePlaceholders({ clients: slotLinked.clients, writePlaceholder: rowWriter(slotLinked.clients), nowMs: at(31), log: quiet }), []);
  // A "hallo?" of a few sentences in the room is a fragment, not the recording: the placeholder is written.
  resetAll();
  const hello = salesClient({ meetings: [{ meetingId: 'FFHALLO1', meetLink: ROOM, startedAt: iso(1), hasTranscript: true, sentenceCount: 2 }] });
  const fragmentOnly = { clients: [hello], active: [], sent: [], reply: null };
  await tickAt(fragmentOnly, 31, { apiKey: () => '' });
  assert.equal(live.ensureLivePlaceholders({ clients: fragmentOnly.clients, writePlaceholder: rowWriter(fragmentOnly.clients), nowMs: at(31), log: quiet }).length, 1);
});

test('no placeholder for a moved, declined or old session; a bot the hub did not send gets one too', async () => {
  resetAll();
  const client = salesClient();
  const state = { clients: [client], active: [], sent: [], reply: null };
  await tickAt(state, 31, { apiKey: () => '' });
  // Moved to 11:00 before the placeholder step ran: the 10:00 session is no longer booked.
  const moved = { ...client, meetingAt: iso(60) };
  assert.deepEqual(live.ensureLivePlaceholders({ clients: [moved], writePlaceholder: rowWriter([moved]), nowMs: at(31), log: quiet }), []);
  updateLiveSessionStore((store) => {
    store.sessions[KEY].declinedAt = iso(20);
    return store;
  }, { nowMs: at(31) });
  assert.deepEqual(live.ensureLivePlaceholders({ clients: state.clients, writePlaceholder: rowWriter(state.clients), nowMs: at(31), log: quiet }), []);
  updateLiveSessionStore((store) => {
    store.sessions[KEY].declinedAt = '';
    return store;
  }, { nowMs: at(31) });
  assert.deepEqual(live.ensureLivePlaceholders({ clients: state.clients, writePlaceholder: rowWriter(state.clients), nowMs: at(13 * 60), log: quiet }), [], 'past the collect horizon');

  // A Fireflies bot someone added by hand: adopted, never sent by the hub.
  resetAll();
  const other = salesClient({ id: 'client-2', calendar: { meetLink: ROOM_B, confirmedMeetLink: ROOM_B } });
  const adopted = { clients: [other], active: [{ id: 'FFHAND01', meetingLink: ROOM_B, startTime: iso(-1), endTime: iso(59) }], sent: [], reply: null };
  await tickAt(adopted, -3);
  assert.equal(adopted.sent.length, 0, 'a bot is already in the room');
  const created = live.ensureLivePlaceholders({ clients: adopted.clients, writePlaceholder: rowWriter(adopted.clients), nowMs: at(-3), log: quiet });
  assert.deepEqual(created.map((row) => row.state), ['recording']);
  assert.equal(other.meetings[0].recording.ffMeetingId, 'FFHAND01');
  assert.equal(other.meetings[0].liveJoinedAt, '');
});

test('a reused room: the earlier meeting\'s bot still in it is never taken for this meeting\'s recording', async () => {
  resetAll();
  const client = salesClient();
  // The meeting before in the same room ran over: its bot, in since 08:58, is still there at 09:57.
  const state = { clients: [client], active: [{ id: 'FFPREV01', meetingLink: ROOM, startTime: iso(-62), endTime: iso(58) }], sent: [], reply: null };
  await tickAt(state, -3);
  assert.equal(state.sent.length, 0, 'a bot is in the room: no second one');
  let session = readLiveSessionStore().sessions[KEY];
  assert.equal(session.state, 'recording');
  assert.equal(session.message, LIVE_JOIN_MESSAGES.earlierBot, 'the card says whose bot it is');
  assert.equal(live.recordingForLiveSession(session).ffMeetingId, '');
  live.ensureLivePlaceholders({ clients: state.clients, writePlaceholder: rowWriter(state.clients), nowMs: at(-3), log: quiet });
  const [row] = client.meetings;
  assert.equal(row.recording.state, 'recording');
  assert.equal(row.recording.ffMeetingId, '', 'the earlier meeting\'s id never goes on this placeholder');
  // A late bot_joined webhook for that bot has no start time: it is still the earlier meeting's.
  await live.noteFirefliesBotJoined({ meetingId: 'FFPREV01', fetchPresence: async () => ({ meetingLink: ROOM }), nowMs: at(-2) });
  session = readLiveSessionStore().sessions[KEY];
  assert.equal(live.recordingForLiveSession(session).ffMeetingId, '');
  assert.equal(session.message, LIVE_JOIN_MESSAGES.earlierBot);
  // It leaves at 10:06; this meeting's own bot is sent in and let in.
  await tickAt(state, 5);
  state.active = [];
  await tickAt(state, 8);
  assert.deepEqual(state.sent.map((input) => input.meetingLink), [ROOM], 'sent back once the room is free');
  state.active = [{ id: 'FFOWN001', meetingLink: ROOM, startTime: iso(9), endTime: iso(129) }];
  await tickAt(state, 10);
  session = readLiveSessionStore().sessions[KEY];
  assert.equal(session.message, LIVE_JOIN_MESSAGES.recording);
  assert.equal(live.recordingForLiveSession(session).ffMeetingId, 'FFOWN001', 'its own bot is named');

  // A row written before this rule still names the earlier bot: that recording is only offered.
  const previous = {
    meetingId: 'FFPREV01',
    title: 'Annenfirma AS · Ola Test',
    meetingLink: ROOM,
    startedAt: iso(-62),
    transcript: 'Ola Test: Takk for i dag.',
    summary: 'Oppfølging.',
    summaryStatus: 'processed',
    final: true,
    isLive: false,
    sentenceCount: 80,
    transcriptUrl: 'https://app.fireflies.ai/view/FFPREV01',
  };
  const legacy = { ...row, recording: mergeRecordingState(row.recording, { state: 'ended', ffMeetingId: 'FFPREV01', endedAt: iso(6) }) };
  client.meetings = [legacy];
  const fetched = [];
  const lookupAt = (minutes, stored = true) => (placeholder) => watchdog.lookupPlaceholderTranscript(placeholder, {
    apiKey: 'fake-key',
    nowMs: at(minutes),
    readStored: (id) => (stored && id === 'FFPREV01' ? previous : null),
    storedRows: () => (stored ? [previous] : []),
    listTranscripts: async () => [],
    hydrate: async (id) => {
      fetched.push(id);
      return { outcome: 'fetched', record: previous };
    },
  });
  let found = await lookupAt(70)(legacy);
  assert.equal(found.found, null);
  assert.deepEqual(fetched, [], 'not fetched as this meeting\'s');
  assert.deepEqual(found.candidates.map((entry) => [entry.meetingId, entry.why]), [['FFPREV01', 'room']]);
  found = await lookupAt(70, false)(legacy);
  assert.equal(found.found, null, 'fetched by its id, it still started before this meeting');
  assert.deepEqual(found.candidates.map((entry) => entry.meetingId), ['FFPREV01']);

  const linked = [];
  const sent = [];
  const deps = (minutes) => ({
    getClients: () => [client],
    apiKey: 'fake-key',
    nowMs: at(minutes),
    log: quiet,
    patchPlaceholder: (clientId, meetingId, patch) => {
      const item = client.meetings.find((entry) => entry.meetingId === meetingId);
      if (item) item.recording = mergeRecordingState(item.recording, patch);
    },
    linkTranscript: (clientId, record) => { linked.push(record.meetingId); },
    recipientsFor: async () => ['ansatte@asoldi.com'],
    sendEmail: async (message) => { sent.push(message); },
    lookup: lookupAt(minutes),
  });
  await watchdog.runFirefliesRecordingWatchdog(deps(151));
  assert.deepEqual(linked, [], 'never moved off the meeting it belongs to');
  assert.equal(client.meetings[0].recording.state, 'missing');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /fra samme Meet-rom til en annen tid: «Annenfirma AS · Ola Test»/);
  assert.match(sent[0].text, /https:\/\/app\.fireflies\.ai\/view\/FFPREV01/);
});

/** Two invented clients booked back to back in one reused room: Testfirma at T, Annenfirma at T+60. */
function backToBack() {
  const first = salesClient();
  const next = salesClient({ id: 'client-2', businessName: 'Annenfirma AS', contactPerson: 'Ola Test', ownerId: 'sales:rep-2', meetingAt: iso(60) });
  return { first, next, firstKey: KEY, nextKey: `${ROOM}|${at(60)}` };
}

test('a reused room the other way: a meeting nobody let the bot into never takes the next meeting\'s bot', async () => {
  resetAll();
  const { first, next, firstKey, nextKey } = backToBack();
  const state = { clients: [first, next], active: [], sent: [], reply: null };
  const nextBot = { id: 'FFNEXT01', meetingLink: ROOM, startTime: iso(57), endTime: iso(177) };
  let joined = null;
  for (let minutes = -3; minutes <= 75; minutes += 1) {
    // Nobody lets the first meeting's knocks in; the next meeting's bot is let in at its first send (10:57).
    state.active = minutes >= 57 ? [nextBot] : [];
    if (minutes === 58) {
      joined = await live.noteFirefliesBotJoined({ meetingId: 'FFNEXT01', fetchPresence: async () => ({ meetingLink: ROOM, isLive: true }), nowMs: at(58) });
    }
    await tickAt(state, minutes);
  }
  assert.deepEqual(joined.map((session) => session.key), [nextKey], 'the bot_joined webhook marks only the next meeting');
  const sessions = readLiveSessionStore().sessions;
  assert.equal(sessions[firstKey].state, 'not-admitted');
  assert.deepEqual(sessions[firstKey].ffMeetingIds, [], 'the next meeting\'s bot is never this one\'s');
  assert.equal(live.recordingForLiveSession(sessions[firstKey]).ffMeetingId, '');
  assert.equal(sessions[nextKey].state, 'recording');
  assert.equal(live.recordingForLiveSession(sessions[nextKey]).ffMeetingId, 'FFNEXT01');
  // The same with the next booking not in the hub at all: a bot that started after this booked end is not its own.
  resetAll();
  const alone = { clients: [salesClient()], active: [], sent: [], reply: null };
  for (let minutes = -3; minutes <= 75; minutes += 1) {
    alone.active = minutes >= 62 ? [{ ...nextBot, startTime: iso(62) }] : [];
    await tickAt(alone, minutes);
  }
  assert.equal(readLiveSessionStore().sessions[KEY].state, 'not-admitted');
  assert.deepEqual(readLiveSessionStore().sessions[KEY].ffMeetingIds, []);
});

test('an earlier meeting still in the room when the next one\'s bot comes in keeps its own bot', async () => {
  resetAll();
  const { first, next, firstKey, nextKey } = backToBack();
  const state = { clients: [first, next], active: [], sent: [], reply: null };
  const ownBot = { id: 'FFOWN001', meetingLink: ROOM, startTime: iso(-3), endTime: iso(117) };
  const nextBot = { id: 'FFNEXT01', meetingLink: ROOM, startTime: iso(57), endTime: iso(177) };
  for (let minutes = -3; minutes <= 59; minutes += 1) {
    state.active = minutes < -2 ? [] : minutes >= 57 ? [ownBot, nextBot] : [ownBot];
    await tickAt(state, minutes);
  }
  const sessions = readLiveSessionStore().sessions;
  assert.deepEqual([sessions[firstKey].state, sessions[firstKey].ffMeetingId], ['recording', 'FFOWN001']);
  assert.deepEqual([sessions[nextKey].state, sessions[nextKey].ffMeetingId], ['recording', 'FFNEXT01']);
});

test('the watchdog never moves the next meeting\'s recording in a reused room onto an earlier meeting without one', async () => {
  resetAll();
  const { first, next } = backToBack();
  const firstRow = placeholder('client-1', T, { state: 'not-admitted', dispatchedAt: iso(-3), message: LIVE_JOIN_MESSAGES.notAdmitted });
  const nextRow = placeholder('client-2', at(60), { state: 'ended', dispatchedAt: iso(57), verifiedAt: iso(58), lastSeenAt: iso(115), endedAt: iso(115) });
  first.meetings = [firstRow];
  next.meetings = [nextRow];
  const clients = [first, next];
  const nextRecording = {
    meetingId: 'FFNEXT01',
    title: 'Annenfirma AS · Ola Test',
    meetingLink: ROOM,
    startedAt: iso(57),
    durationMinutes: 58,
    transcript: Array.from({ length: 120 }, (_, index) => `Ola Test: linje ${index}.`).join('\n'),
    summary: 'Salgsmøte.',
    summaryStatus: 'processed',
    final: true,
    isLive: false,
    sentenceCount: 120,
    transcriptUrl: 'https://app.fireflies.ai/view/FFNEXT01',
  };
  const lookupAt = (minutes) => (placeholderRow, client, all) => watchdog.lookupPlaceholderTranscript(placeholderRow, {
    apiKey: 'fake-key',
    nowMs: at(minutes),
    clientId: client.id,
    clients: all,
    readStored: (id) => (id === 'FFNEXT01' ? nextRecording : null),
    storedRows: () => [nextRecording],
    listTranscripts: async () => [{ id: 'FFNEXT01', title: nextRecording.title, dateString: iso(57), meeting_link: ROOM, transcript_url: nextRecording.transcriptUrl }],
    hydrate: async () => ({ outcome: 'fetched', record: nextRecording }),
  });
  // Looked up first, the earlier meeting does not find it; it is offered as the room at another time.
  const early = await lookupAt(215)(firstRow, first, clients);
  assert.equal(early.found, null);
  assert.deepEqual(early.candidates.map((entry) => [entry.meetingId, entry.why]), [['FFNEXT01', 'room']]);
  assert.equal((await lookupAt(215)(nextRow, next, clients)).found?.meetingId, 'FFNEXT01');

  const sent = [];
  const linked = [];
  await watchdog.runFirefliesRecordingWatchdog({
    getClients: () => clients,
    apiKey: 'fake-key',
    nowMs: at(215),
    log: quiet,
    patchPlaceholder: (clientId, meetingId, patch) => {
      const row = clients.find((client) => client.id === clientId)?.meetings.find((item) => item.meetingId === meetingId);
      if (row) row.recording = mergeRecordingState(row.recording, patch);
      return row || null;
    },
    // As the store-backed link: the recording moves to this client and covers its placeholder.
    linkTranscript: (clientId, record, row) => {
      linked.push([clientId, record.meetingId]);
      for (const client of clients) client.meetings = client.meetings.filter((item) => item.meetingId !== record.meetingId);
      const client = clients.find((item) => item.id === clientId);
      client.meetings = client.meetings.filter((item) => item !== row);
      client.meetings.push({ meetingId: record.meetingId, meetLink: ROOM, startedAt: record.startedAt, hasTranscript: true, sentenceCount: 120 });
      return client;
    },
    recipientsFor: async () => ['ansatte@asoldi.com'],
    sendEmail: async (message) => { sent.push(message); },
    lookup: lookupAt(215),
  });
  assert.deepEqual(linked, [['client-2', 'FFNEXT01']]);
  assert.equal(next.meetings.some((row) => row.meetingId === 'FFNEXT01'), true, 'the next meeting keeps its recording');
  assert.equal(firstRow.recording.state, 'missing');
  assert.deepEqual(sent.map((message) => message.subject), ['Fireflies: ingen opptak av salgsmøtet med Testfirma AS']);
});

test('a late or replayed bot_joined for a finished meeting in the room is not this meeting\'s bot let in', async () => {
  resetAll();
  const state = { clients: [salesClient()], active: [], sent: [], reply: null };
  await tickAt(state, -3);
  await tickAt(state, 0);
  // The 09:00 meeting's bot_joined, delivered again at 10:00:30 after it ended.
  const late = await live.noteFirefliesBotJoined({
    meetingId: 'FFOLD009',
    fetchPresence: async () => ({ meetingLink: ROOM, isLive: false, startTime: iso(-60) }),
    nowMs: at(0.5),
  });
  assert.deepEqual(late, []);
  let session = readLiveSessionStore().sessions[KEY];
  assert.deepEqual([session.state, session.firstSeenActiveAt, session.ffMeetingId], ['dispatched', '', '']);
  for (const minutes of [1, 2, 3]) await tickAt(state, minutes);
  session = readLiveSessionStore().sessions[KEY];
  assert.equal(alerts.planLobbyAlert(session, at(3)).due, true, 'the rep is still told to let the bot in');
  assert.deepEqual(state.sent.map((input) => input.meetingLink), [ROOM, ROOM], 'the retry ladder goes on');
  // Still running (the earlier meeting ran over): it is that meeting's bot, never named on this placeholder.
  await live.noteFirefliesBotJoined({
    meetingId: 'FFOLD009',
    fetchPresence: async () => ({ meetingLink: ROOM, isLive: true, startTime: iso(-60) }),
    nowMs: at(3.5),
  });
  session = readLiveSessionStore().sessions[KEY];
  assert.equal(session.message, LIVE_JOIN_MESSAGES.earlierBot);
  assert.equal(live.recordingForLiveSession(session).ffMeetingId, '');
});

test('the watchdog follows a never-sent placeholder to missing with one honest alert', async () => {
  resetAll();
  const client = salesClient();
  const state = { clients: [client], active: [], sent: [], reply: null };
  await tickAt(state, -3, { apiKey: () => '' });
  await tickAt(state, 31, { apiKey: () => '' });
  live.ensureLivePlaceholders({ clients: state.clients, writePlaceholder: rowWriter(state.clients), nowMs: at(31), log: quiet });
  const [row] = client.meetings;
  assert.equal(watchdog.planPlaceholderCheck(row, { nowMs: at(40) }).reason, 'in-session', 'until the booked end');
  const hub = watchdogHub(state.clients);
  await hub.run(61);
  assert.equal(row.recording.state, 'not-admitted');
  assert.equal(row.recording.message, LIVE_JOIN_MESSAGES.neverSentNoKey, 'the waiting check keeps the why');
  assert.ok(row.recording.checkedAt);
  const result = await hub.run(151);
  assert.deepEqual(result.missing, [STUB]);
  assert.equal(row.recording.state, 'missing');
  assert.equal(row.recording.message, 'Ingen Fireflies-opptak etter møtet. Fireflies ble aldri sendt inn.');
  assert.equal(hub.sent.length, 1);
  assert.equal(hub.sent[0].subject, 'Fireflies: ingen opptak av salgsmøtet med Testfirma AS');
  assert.ok(hub.sent[0].text.includes(LIVE_JOIN_MESSAGES.neverSentNoKey), 'says the key was missing');
  assert.doesNotMatch(hub.sent[0].text, /ble sendt inn, men/);
  await hub.run(215);
  assert.equal(hub.sent.length, 1, 'one e-mail');
});

test('without a Fireflies key a meeting no bot was sent to still turns missing with one e-mail; a sent one waits for the key', async () => {
  resetAll();
  const neverSent = salesClient({ meetings: [placeholder('client-1', T, { state: 'not-admitted', sessionKey: KEY, message: LIVE_JOIN_MESSAGES.neverSentNoKey })] });
  const sentIn = salesClient({
    id: 'client-2',
    businessName: 'Annenfirma AS',
    meetings: [placeholder('client-2', T, { state: 'not-admitted', dispatchedAt: iso(-3), message: LIVE_JOIN_MESSAGES.notAdmitted }, { meetLink: ROOM_B })],
  });
  const clients = [neverSent, sentIn];
  const sent = [];
  const run = (minutes) => watchdog.runFirefliesRecordingWatchdog({
    getClients: () => clients,
    apiKey: '',
    nowMs: at(minutes),
    log: quiet,
    patchPlaceholder: (clientId, meetingId, patch) => {
      const row = clients.find((client) => client.id === clientId)?.meetings.find((item) => item.meetingId === meetingId);
      if (row) row.recording = mergeRecordingState(row.recording, patch);
    },
    linkTranscript: () => { throw new Error('nothing is linked without a key'); },
    recipientsFor: async () => ['ansatte@asoldi.com', 'alexander@asoldi.com'],
    sendEmail: async (message) => { sent.push(message); },
    lookup: async () => { throw new Error('nothing is looked up without a key'); },
  });
  await run(61);
  const [row] = neverSent.meetings;
  assert.equal(row.recording.state, 'not-admitted', 'before the deadline it waits');
  assert.equal(row.recording.message, LIVE_JOIN_MESSAGES.neverSentNoKey, 'and keeps the why');
  const result = await run(151);
  assert.deepEqual(result.missing, [row.meetingId]);
  assert.equal(result.health.lookups, 0, 'no Fireflies lookup was made');
  assert.equal(row.recording.state, 'missing');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^Asoldi har ikke noe Fireflies-opptak av salgsmøtet med Testfirma AS/);
  assert.ok(sent[0].text.includes(LIVE_JOIN_MESSAGES.neverSentNoKey), 'says the key was missing');
  assert.match(sent[0].text, /før Fireflies-nøkkelen er på plass igjen/);
  const [other] = sentIn.meetings;
  assert.equal(other.recording.state, 'not-admitted', 'a bot was sent: never called missing unlooked');
  assert.equal(other.recording.missingAt, '');
  await run(215);
  assert.equal(sent.length, 1, 'one e-mail');
});

test('a test client that is not a pilot gets no missing e-mail; its meeting is still marked missing', async () => {
  resetAll();
  const client = salesClient({ id: 'client-t', isTest: true, meetings: [placeholder('client-t', T, { state: 'ended', dispatchedAt: iso(-3) })] });
  const hub = watchdogHub([client]);
  const result = await hub.run(151);
  assert.deepEqual(result.missing, [client.meetings[0].meetingId]);
  assert.equal(client.meetings[0].recording.state, 'missing');
  assert.equal(client.meetings[0].recording.alertedAt, '');
  assert.equal(hub.sent.length, 0);
});

test('a meeting ticked held, or a done Møte, still gets its placeholder when the hub was down through it', async () => {
  resetAll();
  const action = {
    id: 'act-9',
    presetKey: 'custom',
    goalKey: 'meetingHeld',
    name: 'Oppfølgingsmøte',
    format: 'mote',
    addToCalendar: true,
    calendarEventId: 'evt-9',
    dueAt: iso(0),
    meetLink: ROOM_B,
    doneAt: iso(50),
  };
  const client = salesClient({ progression: { meetingHeld: true }, nextActions: [action] });
  const state = { clients: [client], active: [], sent: [], reply: null };
  // The hub comes back 2.5 hours after the start; the rep ticked both right after the call.
  await tickAt(state, 150);
  assert.equal(state.sent.length, 0, 'long past the first-send window: nothing is sent');
  const created = live.ensureLivePlaceholders({ clients: state.clients, writePlaceholder: rowWriter(state.clients), nowMs: at(150), log: quiet });
  assert.deepEqual(created.map((row) => row.meetingId).sort(), [STUB, `live:client-1:act-9:${T}`].sort());
  for (const row of client.meetings) {
    assert.equal(row.recording.state, 'not-admitted');
    assert.equal(row.recording.message, LIVE_JOIN_MESSAGES.neverSent);
  }
  // Before the meeting a ticked "held" still means no bot.
  assert.equal(live.collectLiveSessions([salesClient({ progression: { meetingHeld: true } })], at(-60)).length, 0);
});

test('a meeting whose knocks nobody answered says so in its missing alert', () => {
  const placeholder = {
    meetingId: STUB,
    startedAt: iso(0),
    slotKey: `sales:${T}`,
    recording: { state: 'not-admitted', dispatchedAt: iso(-3), message: LIVE_JOIN_MESSAGES.notAdmitted },
  };
  const email = watchdog.buildMissingRecordingEmail({ client: { businessName: 'Testfirma AS' }, placeholder, previousState: 'not-admitted', previousRecording: placeholder.recording, to: ['ansatte@asoldi.com'] });
  assert.match(email.text, /ble sendt inn, men ble aldri sluppet inn i møtet/);
  // A later waiting note on a never-sent row is not quoted as the why.
  const waiting = { state: 'not-admitted', message: 'Fireflies behandler fortsatt opptaket.' };
  const plain = watchdog.buildMissingRecordingEmail({ client: { businessName: 'Testfirma AS' }, placeholder: { ...placeholder, recording: waiting }, previousState: 'not-admitted', previousRecording: waiting });
  assert.match(plain.text, /Fireflies ble aldri sendt inn i møtet\./);
});

// ── 3. empty ─────────────────────────────────────────────────────────────────

test('a silent fragment before the deadline decides nothing; the recording with talk that follows is linked, no e-mail', async () => {
  const start = at(0);
  const client = {
    id: 'client-e',
    businessName: 'Testfirma E AS',
    ownerId: 'sales:rep-1',
    meetings: [{
      meetingId: `live:client-e:${start}`,
      title: 'Testfirma E AS · Kari Test',
      startedAt: iso(0),
      meetLink: ROOM_C,
      hasTranscript: false,
      slotKey: `sales:${start}`,
      purpose: 'sales',
      forSalesMeeting: true,
      recording: mergeRecordingState(null, { state: 'ended', dispatchedAt: iso(-3), endedAt: iso(8) }),
    }],
  };
  const sent = [];
  const linked = [];
  const silent = { meetingId: 'FFSIL001', meetingLink: ROOM_C, startedAt: iso(-3), transcript: '', silent: true, summaryStatus: 'skipped', final: true, isLive: false };
  const talk = { meetingId: 'FFTALK02', meetingLink: ROOM_C, startedAt: iso(10), transcript: 'Kari Test: Vi vil ha en ny nettside.', summaryStatus: 'processed', final: true, isLive: false, sentenceCount: 40 };
  const listed = (record) => ({ id: record.meetingId, title: 'Opptak', dateString: record.startedAt, meeting_link: record.meetingLink });
  let stored = [silent];
  const deps = (minutes) => ({
    getClients: () => [client],
    apiKey: 'fake-key',
    nowMs: at(minutes),
    log: quiet,
    patchPlaceholder: (clientId, meetingId, patch) => {
      const row = client.meetings.find((item) => item.meetingId === meetingId);
      if (row) row.recording = mergeRecordingState(row.recording, patch);
    },
    linkTranscript: (clientId, record) => {
      linked.push(record.meetingId);
      client.meetings = client.meetings.filter((row) => !row.meetingId.startsWith('live:'));
      return client;
    },
    recipientsFor: async () => ['ansatte@asoldi.com'],
    sendEmail: async (message) => { sent.push(message); },
    lookup: (placeholder) => watchdog.lookupPlaceholderTranscript(placeholder, {
      apiKey: 'fake-key',
      nowMs: at(minutes),
      listTranscripts: async () => stored.map(listed),
      readStored: (id) => stored.find((row) => row.meetingId === id) || null,
      storedRows: () => stored,
    }),
  });
  await watchdog.runFirefliesRecordingWatchdog(deps(12));
  const [row] = client.meetings;
  assert.equal(row.recording.state, 'ended', 'not empty yet');
  assert.match(row.recording.message, /bare et tomt opptak/);
  assert.equal(sent.length, 0);
  stored = [silent, talk];
  await watchdog.runFirefliesRecordingWatchdog(deps(62));
  assert.deepEqual(linked, ['FFTALK02']);
  assert.equal(sent.length, 0);
});

test('an empty alert that could not be sent is tried again on the hourly look, and goes once', async () => {
  const start = at(0);
  const client = {
    id: 'client-f',
    businessName: 'Testfirma F AS',
    ownerId: 'sales:rep-1',
    meetings: [{
      meetingId: `live:client-f:${start}`,
      startedAt: iso(0),
      meetLink: ROOM_B,
      slotKey: `workshop:${start}`,
      purpose: 'workshop',
      hasTranscript: false,
      recording: mergeRecordingState(null, { state: 'ended', dispatchedAt: iso(-3) }),
    }],
  };
  const silent = { meetingId: 'FFSIL002', meetingLink: ROOM_B, startedAt: iso(1), transcript: '', silent: true, summaryStatus: 'skipped', final: true };
  let failing = true;
  const sent = [];
  const deps = (minutes) => ({
    getClients: () => [client],
    apiKey: 'fake-key',
    nowMs: at(minutes),
    log: quiet,
    patchPlaceholder: (clientId, meetingId, patch) => {
      const row = client.meetings.find((item) => item.meetingId === meetingId);
      if (row) row.recording = mergeRecordingState(row.recording, patch);
    },
    linkTranscript: () => {},
    recipientsFor: async () => ['ansatte@asoldi.com', 'alexander@asoldi.com'],
    sendEmail: async (message) => {
      if (failing) throw new Error('SMTP down');
      sent.push(message);
    },
    lookup: (placeholder) => watchdog.lookupPlaceholderTranscript(placeholder, {
      apiKey: 'fake-key',
      nowMs: at(minutes),
      listTranscripts: async () => [{ id: silent.meetingId, title: 'Opptak', dateString: silent.startedAt, meeting_link: ROOM_B }],
      readStored: (id) => (id === silent.meetingId ? silent : null),
      storedRows: () => [silent],
    }),
  });
  await watchdog.runFirefliesRecordingWatchdog(deps(151));
  const [row] = client.meetings;
  assert.equal(row.recording.state, 'empty');
  assert.equal(row.recording.alertedAt, '', 'released for another try');
  failing = false;
  await watchdog.runFirefliesRecordingWatchdog(deps(215));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Fireflies: tomt opptak av workshopen med Testfirma F AS');
  assert.equal(sent[0].to, 'ansatte@asoldi.com, alexander@asoldi.com');
  await watchdog.runFirefliesRecordingWatchdog(deps(280));
  assert.equal(sent.length, 1, 'once');
});

// ── 2. lobby alert ───────────────────────────────────────────────────────────

function knockedSession({ knockAt = -3, checkedAt = 3, seen = false, client = salesClient() } = {}) {
  live.upsertLiveSessionsForClient(client, { nowMs: at(-10) });
  updateLiveSessionStore((store) => {
    let session = applyLiveJoinAttempt(store.sessions[KEY], { at: iso(knockAt), kind: 'first', ok: true });
    session = { ...session, checkedAt: iso(checkedAt), ...(seen ? { firstSeenActiveAt: iso(1), state: 'recording' } : {}) };
    store.sessions[KEY] = session;
    return store;
  }, { nowMs: at(knockAt) });
  return readLiveSessionStore().sessions[KEY];
}

test('the lobby alert is due by max(T+3, first knock + 4 min) once a look found no bot, inside the first-send window', () => {
  resetAll();
  const session = knockedSession();
  assert.equal(alerts.planLobbyAlert(session, at(2)).reason, 'not-yet');
  assert.equal(alerts.planLobbyAlert(session, at(3)).due, true);
  assert.equal(alerts.planLobbyAlert(session, at(3)).dueMs, at(3));
  assert.equal(alerts.planLobbyAlert(session, at(31)).reason, 'window-over');
  assert.equal(alerts.planLobbyAlert({ ...session, checkedAt: iso(-3) }, at(4)).reason, 'unverified', 'no look since the knock');
  assert.equal(alerts.planLobbyAlert({ ...session, firstSeenActiveAt: iso(1) }, at(4)).reason, 'seen');
  assert.equal(alerts.planLobbyAlert({ ...session, declinedAt: iso(1) }, at(4)).reason, 'not-needed');
  assert.equal(alerts.planLobbyAlert({ ...session, lobbyAlertAt: iso(3) }, at(4)).reason, 'sent');
  // The first send failed and the T+1 retry was the first knock: due 4 minutes after it.
  const failedFirst = applyLiveJoinAttempt(live.normalizeLiveSession({ ...session, attempts: [] }), { at: iso(-3), kind: 'first', ok: false, message: 'timeout', uncertain: false });
  const late = { ...applyLiveJoinAttempt(failedFirst, { at: iso(1), kind: 'retry', ok: true }), checkedAt: iso(5) };
  assert.equal(alerts.planLobbyAlert(late, at(4)).reason, 'not-yet');
  assert.equal(alerts.planLobbyAlert(late, at(5)).due, true);
  assert.equal(alerts.planLobbyAlert({ ...late, attempts: late.attempts.slice(0, 1) }, at(5)).reason, 'no-knock');
});

test('the rep gets one lobby e-mail, stamped on the session, also across a restart', async () => {
  resetAll();
  const client = salesClient();
  knockedSession({ client });
  const sent = [];
  const deps = (minutes) => ({
    clients: [client],
    nowMs: at(minutes),
    log: quiet,
    recipientsFor: async () => ['alexander@asoldi.com'],
    sendEmail: async (message) => { sent.push(message); },
  });
  const first = await alerts.runFirefliesLobbyAlerts(deps(3));
  assert.deepEqual(first.sent, [KEY]);
  assert.equal(sent.length, 1);
  const [mail] = sent;
  assert.equal(mail.to, 'alexander@asoldi.com');
  assert.equal(mail.subject, 'Slipp inn Fireflies – Testfirma AS');
  assert.match(mail.text, /^Fireflies\.ai Notetaker banker på i Google Meet-møtet med Testfirma AS kl\. 11:00, men er ikke sluppet inn ennå\./);
  assert.match(mail.text, /slipp den inn\. Meet kan vise den under «Med potensielle risikoer»/);
  assert.match(mail.text, /Er ingen i møtet ennå, trenger du ikke gjøre noe: Asoldi sender den inn på nytt\./);
  assert.match(mail.text, /Meet: https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.equal(readLiveSessionStore().sessions[KEY].lobbyAlertAt, iso(3));
  await alerts.runFirefliesLobbyAlerts(deps(4));
  // A restart: the stamp is on disk.
  clearJsonCacheForTests();
  alerts.resetFirefliesLiveAlertsForTests();
  await alerts.runFirefliesLobbyAlerts(deps(5));
  assert.equal(sent.length, 1, 'never twice');
});

test('a workshop knock also reaches the room\'s host, who is in the meeting; one address gets one copy', async () => {
  resetAll();
  const WORKSHOP_KEY = `${ROOM_B}|${T}`;
  const client = salesClient({
    agreedTime: false,
    workshopAction: { name: 'Workshop', format: 'mote', dueAt: iso(0), meetLink: ROOM_B, status: 'confirmed' },
  });
  live.upsertLiveSessionsForClient(client, { nowMs: at(-10) });
  updateLiveSessionStore((store) => {
    store.sessions[WORKSHOP_KEY] = { ...applyLiveJoinAttempt(store.sessions[WORKSHOP_KEY], { at: iso(-3), kind: 'first', ok: true }), checkedAt: iso(3) };
    return store;
  }, { nowMs: at(-3) });
  // As server.js liveSessionMeetHost: Damian's workshop calendar hosts workshop and iteration rooms.
  const meetHostFor = (session) => (session.slots.some((slot) => slot.kind === 'workshop' || slot.kind === 'iteration') ? 'Damian@asoldi.com' : '');
  const sent = [];
  const base = { nowMs: at(3), log: quiet, meetHostFor, sendEmail: async (message) => { sent.push(message); } };
  await alerts.runFirefliesLobbyAlerts({ ...base, clients: [client], recipientsFor: async () => ['alexander@asoldi.com'] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'alexander@asoldi.com, damian@asoldi.com');

  // The host is the rep: one copy. A client with no rep: the host still hears. A test client: nobody.
  const again = async (patch) => {
    sent.length = 0;
    updateLiveSessionStore((store) => {
      store.sessions[WORKSHOP_KEY] = { ...store.sessions[WORKSHOP_KEY], lobbyAlertAt: '', lobbyAlertKnockAt: '' };
      return store;
    }, { nowMs: at(3) });
    return alerts.runFirefliesLobbyAlerts({ ...base, clients: [client], ...patch });
  };
  await again({ recipientsFor: async () => ['damian@asoldi.com'] });
  assert.deepEqual(sent.map((mail) => mail.to), ['damian@asoldi.com']);
  await again({ recipientsFor: async () => [] });
  assert.deepEqual(sent.map((mail) => mail.to), ['damian@asoldi.com']);
  const testClient = await again({ clients: [{ ...client, isTest: true }], recipientsFor: async () => ['alexander@asoldi.com'] });
  assert.deepEqual(testClient.skipped, [{ key: WORKSHOP_KEY, reason: 'excluded' }]);
  assert.equal(sent.length, 0);

  // server.js hands the lib the room's host: the sales calendar's, or Damian's for workshops and iterations.
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /meetHostFor: \(session\) => liveSessionMeetHost\(session\)\.ownerEmail,/);
  const host = server.slice(server.indexOf('function liveSessionMeetHost('), server.indexOf('async function openLiveSessionMeetRoom('));
  assert.match(host, /if \(slot\.kind === 'workshop' \|\| slot\.kind === 'iteration'\) \{\s*return \{ accountKey: resolveDamianWorkshopAccountKey\(\), ownerEmail: DAMIAN_WORKSHOP_CALENDAR_EMAIL \};/);
});

test('no lobby e-mail for a test client, a client with no rep, when switched off, or when the bot got in', async () => {
  resetAll();
  knockedSession();
  const sent = [];
  const base = {
    nowMs: at(3),
    log: quiet,
    recipientsFor: async () => ['alexander@asoldi.com'],
    sendEmail: async (message) => { sent.push(message); },
  };
  const test1 = await alerts.runFirefliesLobbyAlerts({ ...base, clients: [salesClient({ isTest: true })] });
  assert.deepEqual(test1.skipped, [{ key: KEY, reason: 'excluded' }]);
  const noRep = await alerts.runFirefliesLobbyAlerts({ ...base, clients: [salesClient({ ownerId: '' })], recipientsFor: async () => [] });
  assert.deepEqual(noRep.skipped, [{ key: KEY, reason: 'no-rep' }]);
  await alerts.runFirefliesLobbyAlerts({ ...base, clients: [salesClient()], enabled: false });
  assert.equal(sent.length, 0);
  assert.equal(readLiveSessionStore().sessions[KEY].lobbyAlertAt, '', 'nothing stamped, so it can still go');

  resetAll();
  knockedSession({ seen: true });
  await alerts.runFirefliesLobbyAlerts({ ...base, clients: [salesClient()] });
  assert.equal(sent.length, 0);
});

test('a lobby e-mail that fails is released and tried again two minutes later, while the window lasts', async () => {
  resetAll();
  const client = salesClient();
  knockedSession({ client });
  let failing = true;
  const sent = [];
  const deps = (minutes) => ({
    clients: [client],
    nowMs: at(minutes),
    log: quiet,
    recipientsFor: async () => ['alexander@asoldi.com'],
    sendEmail: async (message) => {
      if (failing) throw new Error('SMTP down');
      sent.push(message);
    },
  });
  const failed = await alerts.runFirefliesLobbyAlerts(deps(3));
  assert.deepEqual(failed.failed, [KEY]);
  let session = readLiveSessionStore().sessions[KEY];
  assert.equal(session.lobbyAlertAt, '');
  assert.equal(session.lobbyAlertFailedAt, iso(3));
  failing = false;
  await alerts.runFirefliesLobbyAlerts(deps(4));
  assert.equal(sent.length, 0, 'not within two minutes');
  // The engine's next look still finds no bot.
  updateLiveSessionStore((store) => {
    store.sessions[KEY].checkedAt = iso(5);
    return store;
  }, { nowMs: at(5) });
  await alerts.runFirefliesLobbyAlerts(deps(5));
  assert.equal(sent.length, 1);
  session = readLiveSessionStore().sessions[KEY];
  assert.equal(session.lobbyAlertAt, iso(5));
});

test('a bot seen only before the knock does not stop the lobby alert; the e-mail promises a new knock only when one is due', async () => {
  resetAll();
  const base = knockedSession();
  // The earlier meeting's bot was in the room until 10:02; this meeting's own bot knocked at 10:03.
  const adopted = applyLiveJoinAttempt(live.normalizeLiveSession({
    ...base,
    attempts: [],
    dispatchedAt: '',
    lastDispatchedAt: '',
    state: 'ended',
    firstSeenActiveAt: iso(-3),
    lastSeenActiveAt: iso(2),
    endedAt: iso(2),
  }), { at: iso(3), kind: 'rejoin', ok: true });
  const looked = { ...adopted, checkedAt: iso(7) };
  assert.equal(alerts.planLobbyAlert(looked, at(7)).due, true);
  assert.equal(alerts.planLobbyAlert({ ...looked, lastSeenActiveAt: iso(6) }, at(7)).reason, 'seen', 'in the room since the knock');
  assert.equal(live.liveSessionKnocksAgain(looked, at(7)), true, 'sent back again at 10:15 if nobody lets it in');

  // The first accepted knock at 10:25 used the last automatic send: the e-mail does not promise another.
  let last = live.normalizeLiveSession({ ...base, attempts: [] });
  for (const minutes of [-3, 1, 5, 15]) {
    last = applyLiveJoinAttempt(last, { at: iso(minutes), kind: minutes < 0 ? 'first' : 'retry', ok: false, message: 'Fireflies svarte ikke' });
  }
  last = { ...applyLiveJoinAttempt(last, { at: iso(25), kind: 'retry', ok: true }), checkedAt: iso(29) };
  assert.equal(alerts.planLobbyAlert(last, at(29)).due, true);
  assert.equal(live.liveSessionKnocksAgain(last, at(29)), false);
  updateLiveSessionStore((store) => {
    store.sessions[KEY] = last;
    return store;
  }, { nowMs: at(29) });
  const sent = [];
  await alerts.runFirefliesLobbyAlerts({
    clients: [salesClient()],
    nowMs: at(29),
    log: quiet,
    recipientsFor: async () => ['alexander@asoldi.com'],
    sendEmail: async (message) => { sent.push(message); },
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Asoldi sender den ikke inn igjen av seg selv, så slipp den inn nå hvis dere er i møtet\./);
  assert.doesNotMatch(sent[0].text, /trenger du ikke gjøre noe/);
});

test('the engine keeps the lobby stamp through its own writes', async () => {
  resetAll();
  const client = salesClient();
  const state = { clients: [client], active: [], sent: [], reply: null };
  await tickAt(state, -3);
  await tickAt(state, 3);
  const sent = [];
  await alerts.runFirefliesLobbyAlerts({
    clients: [client],
    nowMs: at(3),
    log: quiet,
    recipientsFor: async () => ['alexander@asoldi.com'],
    sendEmail: async (message) => { sent.push(message); },
  });
  assert.equal(sent.length, 1);
  await tickAt(state, 5);
  await tickAt(state, 6);
  assert.equal(readLiveSessionStore().sessions[KEY].lobbyAlertAt, iso(3));
});

test('a knock to let the bot in again after it dropped out gets its own lobby e-mail, once per knock', async () => {
  resetAll();
  const client = salesClient();
  const state = { clients: [client], active: [], sent: [], reply: null };
  const mails = [];
  const runAlerts = (minutes) => alerts.runFirefliesLobbyAlerts({
    clients: [client],
    nowMs: at(minutes),
    log: quiet,
    recipientsFor: async () => ['alexander@asoldi.com'],
    sendEmail: async (message) => { mails.push({ at: minutes, ...message }); },
  });
  const bot = { id: 'FFOWN001', meetingLink: ROOM, startTime: iso(1), endTime: iso(121) };
  // A knock room: the rep lets the first bot in at 10:01; it drops out at 10:15 and is never let in again.
  for (let minutes = -3; minutes <= 45; minutes += 1) {
    state.active = minutes >= 1 && minutes < 15 ? [bot] : [];
    await tickAt(state, minutes);
    await runAlerts(minutes);
  }
  const rejoins = readLiveSessionStore().sessions[KEY].attempts.filter((attempt) => attempt.kind === 'rejoin' && attempt.ok);
  assert.deepEqual(rejoins.map((attempt) => attempt.at), [iso(16), iso(29)], 'sent back after it dropped out, and once more before T+30');
  assert.deepEqual(mails.map((mail) => mail.at), [20, 33], 'one e-mail 4 minutes after each knock nobody answers, none for the first');
  const [mail] = mails;
  assert.equal(mail.subject, 'Slipp inn Fireflies igjen – Testfirma AS');
  assert.match(mail.text, /^Fireflies\.ai Notetaker banker på igjen i Google Meet-møtet med Testfirma AS kl\. 11:00, men er ikke sluppet inn\./);
  assert.match(mail.text, /gikk ut før tiden og er sendt inn på nytt\./);
  assert.match(mail.text, /slipp den inn igjen/);
  assert.equal(readLiveSessionStore().sessions[KEY].lobbyAlertKnockAt, rejoins.at(-1).at);
});

test('a continuation knock is due its e-mail while only the old bot is in the room', () => {
  resetAll();
  let session = knockedSession({ seen: true });
  session = applyLiveJoinAttempt(live.normalizeLiveSession({
    ...session,
    lastSeenActiveAt: iso(118),
    ffStartTime: iso(-2),
    checkedAt: iso(118),
  }), { at: iso(115), kind: 'continuation', ok: true });
  session = { ...session, state: 'recording', lastSeenActiveAt: iso(120), checkedAt: iso(120) };
  assert.equal(alerts.planLobbyAlert(session, at(118)).reason, 'not-yet');
  const due = alerts.planLobbyAlert(session, at(119));
  assert.deepEqual([due.due, due.knock?.kind], [true, 'continuation'], 'the bot in the room is the old one');
  const email = alerts.buildLobbyAlertEmail({ client: salesClient(), session, to: ['alexander@asoldi.com'], knock: due.knock });
  assert.match(email.text, /er snart ute av tid og er sendt inn på nytt for å fortsette opptaket/);
  assert.equal(alerts.planLobbyAlert(session, at(126)).reason, 'window-over', 'it has left the lobby by then');
  // The new bot (started after the knock) is in: nothing to do.
  assert.equal(alerts.planLobbyAlert({ ...session, ffStartTime: iso(116) }, at(119)).reason, 'seen');
  // Sent: not again for the same knock.
  assert.equal(alerts.planLobbyAlert({ ...session, lobbyAlertAt: iso(119), lobbyAlertKnockAt: iso(115) }, at(120)).reason, 'sent');
});

// ── 6. owner health alert ────────────────────────────────────────────────────

test('health: a missing key near a meeting, a stalled loop, or failing ticks; nothing while safe mode keeps it off', () => {
  const booked = live.collectLiveSessions([salesClient()], at(-90));
  const ok = { apiKeyPresent: true, lastTickAt: iso(-91), failingSince: '' };
  assert.equal(alerts.firefliesLiveJoinAlertReason({ status: { ...ok, apiKeyPresent: false }, booked, nowMs: at(-90) }), 'no-api-key');
  assert.equal(alerts.firefliesLiveJoinAlertReason({ status: { ...ok, apiKeyPresent: false }, booked, nowMs: at(-130) }), '', 'more than 2 hours ahead');
  assert.equal(alerts.firefliesLiveJoinAlertReason({ status: { ...ok, lastTickAt: iso(-11) }, booked, nowMs: at(0) }), 'loop-stalled');
  assert.equal(alerts.firefliesLiveJoinAlertReason({ status: { ...ok, lastTickAt: iso(-9) }, booked, nowMs: at(0) }), '');
  assert.equal(alerts.firefliesLiveJoinAlertReason({ status: { ...ok, lastTickAt: iso(-40) }, booked, nowMs: at(-20) }), '', 'no meeting in its window');
  assert.equal(alerts.firefliesLiveJoinAlertReason({ status: { ...ok, lastTickAt: '' }, booked, nowMs: at(0), sinceMs: at(-12) }), 'loop-stalled', 'this process never ticked');
  assert.equal(alerts.firefliesLiveJoinAlertReason({ status: { ...ok, lastTickAt: iso(0), failingSince: iso(-16) }, booked, nowMs: at(0) }), 'ticks-failing');
  assert.equal(alerts.firefliesLiveJoinAlertReason({ status: { ...ok, lastTickAt: iso(0), failingSince: iso(-14) }, booked, nowMs: at(0) }), '');
  assert.equal(alerts.firefliesLiveJoinAlertReason({ status: { ...ok, apiKeyPresent: false }, booked, nowMs: at(-90), liveJoinEnabled: false }), '');
});

test('health: the engine reports since when every tick has failed', async () => {
  resetAll();
  const state = { clients: [salesClient()], active: [], sent: [], reply: null };
  await tickAt(state, -3, { fetchActiveMeetings: async () => { throw new Error('Fireflies down'); } });
  let status = live.firefliesLiveJoinStatus({ nowMs: at(-3), apiKeyPresent: true });
  assert.equal(status.failingSince, iso(-3));
  await tickAt(state, -2, { fetchActiveMeetings: async () => { throw new Error('Fireflies down'); } });
  assert.equal(live.firefliesLiveJoinStatus({ nowMs: at(-2), apiKeyPresent: true }).failingSince, iso(-3));
  await tickAt(state, -1);
  status = live.firefliesLiveJoinStatus({ nowMs: at(-1), apiKeyPresent: true });
  assert.equal(status.failingSince, '');
  assert.equal(status.lastOkTickAt, iso(-1));
});

test('health: one owner e-mail per 12 hours, kept on disk through a restart', async () => {
  resetAll();
  const sent = [];
  const send = async (message) => { sent.push(message); };
  const clients = [salesClient()];
  const first = await alerts.maybeAlertFirefliesLiveJoin({ sendEmail: send, clients, apiKeyPresent: false, nowMs: at(-60), env: {}, log: quiet });
  assert.deepEqual(first, { reason: 'no-api-key', to: 'damian@asoldi.com' });
  assert.equal(sent[0].subject, 'Fireflies: nøkkelen mangler, ingen opptak av møtene');
  assert.match(sent[0].text, /FIREFLIES_API_KEY/);
  assert.match(sent[0].text, /Testfirma AS · Kari Test/);
  assert.match(sent[0].text, /høyst én gang hver 12\. time/);
  assert.equal(await alerts.maybeAlertFirefliesLiveJoin({ sendEmail: send, clients, apiKeyPresent: false, nowMs: at(-50), env: {}, log: quiet }), null);
  ingest.resetFirefliesIngestForTests();
  assert.equal(await alerts.maybeAlertFirefliesLiveJoin({ sendEmail: send, clients, apiKeyPresent: false, nowMs: at(-40), env: {}, log: quiet }), null, 'a restart keeps the stamp');
  assert.equal(sent.length, 1);
  assert.ok(ingest.firefliesIngestStatus({ nowMs: at(-40) }).lastLiveJoinAlertAt);
  // FIREFLIES_ALERT_EMAIL, and a new alert after 12 hours.
  const later = { ...salesClient(), meetingAt: iso(13 * 60) };
  const again = await alerts.maybeAlertFirefliesLiveJoin({ sendEmail: send, clients: [later], apiKeyPresent: false, nowMs: at(12 * 60 - 59), env: { FIREFLIES_ALERT_EMAIL: 'alexander@asoldi.com' }, log: quiet });
  assert.deepEqual(again, { reason: 'no-api-key', to: 'alexander@asoldi.com' });
});

test('health: the owner alert stamp is claimed under the store lock, so a hub process that sent it first wins', () => {
  resetAll();
  // This process read the ingest state a moment ago (still cached): no stamp yet.
  assert.equal(ingest.firefliesIngestStatus({ nowMs: at(0) }).lastLiveJoinAlertAt, '');
  // A second hub process on the same data dir claims it inside this one's read-cache second.
  writeFileSync(join(dataDir, 'fireflies-ingest-state.json'), JSON.stringify({ lastLiveJoinAlertAt: iso(0) }));
  assert.equal(ingest.claimFirefliesLiveJoinAlert({ nowMs: at(0) + 500 }), false, 'checked on fresh data');
  assert.equal(ingest.claimFirefliesLiveJoinAlert({ nowMs: at(12 * 60 + 1) }), true, '12 hours later it may go');
  assert.equal(ingest.claimFirefliesLiveJoinAlert({ nowMs: at(12 * 60 + 2) }), false, 'once');
});

test('health: a live-join loop that stopped is reported by the ingest tick watching it', async () => {
  resetAll();
  const sent = [];
  const clients = [salesClient()];
  const state = { clients, active: [], sent: [], reply: null };
  await tickAt(state, -20);
  // The loop died after its T-20 tick; the ingest tick keeps calling.
  assert.equal(await alerts.maybeAlertFirefliesLiveJoin({ sendEmail: async (m) => { sent.push(m); }, clients, apiKeyPresent: true, nowMs: at(-5), log: quiet }), null, 'no meeting in its window yet');
  const result = await alerts.maybeAlertFirefliesLiveJoin({ sendEmail: async (m) => { sent.push(m); }, clients, apiKeyPresent: true, nowMs: at(1), env: {}, log: quiet });
  assert.equal(result?.reason, 'loop-stalled');
  assert.equal(sent[0].subject, 'Fireflies: live-join står stille');
});

// ── 5. status and missing-recordings payloads ───────────────────────────────

test('the live-join status payload carries the engine status, the rate limit and the health alert', () => {
  resetAll();
  const payload = alerts.liveJoinStatusPayload({ nowMs: at(-60), apiKeyPresent: false, clients: [salesClient()], lobbyAlertsEnabled: false });
  for (const field of ['lastTickAt', 'lastError', 'lastOkTickAt', 'failingSince', 'running', 'sessionsInWindow', 'sessions', 'limiter', 'apiKeyPresent', 'safeModeBlocking', 'keyOwnerEmail', 'oneBot']) {
    assert.ok(Object.prototype.hasOwnProperty.call(payload, field), field);
  }
  assert.deepEqual(Object.keys(payload.rateLimit).sort(), ['api', 'join', 'lastError', 'lastRateLimitAt', 'pausedUntil']);
  assert.equal(payload.alert.reason, 'no-api-key');
  assert.equal(payload.alert.lastAlertAt, '');
  assert.equal(payload.lobbyAlertsEnabled, false);
  assert.equal(payload.liveJoinEnabled, true);
});

function placeholder(id, start, recording, extra = {}) {
  return {
    meetingId: `live:${id}:${start}`,
    title: 'Testfirma AS · Kari Test',
    startedAt: new Date(start).toISOString(),
    meetLink: ROOM,
    hasTranscript: false,
    slotKey: `sales:${start}`,
    purpose: 'sales',
    forSalesMeeting: true,
    recording: recording ? mergeRecordingState(null, recording) : null,
    ...extra,
  };
}

test('missing recordings: placeholders with no recording past the deadline, or called missing or empty', () => {
  const now = at(0);
  const day = 24 * 60 * MIN;
  const a = {
    id: 'c-a',
    businessName: 'Testfirma A AS',
    ownerId: 'sales:rep-1',
    meetings: [
      placeholder('c-a', now - 3 * 60 * MIN, { state: 'missing', missingAt: iso(-30), alertedAt: iso(-30), message: 'Ingen Fireflies-opptak etter møtet.' }),
      // Not let in 50 minutes ago: the meeting may still get its recording, so not listed yet.
      placeholder('c-a', now - 50 * MIN, { state: 'not-admitted', message: LIVE_JOIN_MESSAGES.notAdmitted }),
      // Past its deadline before the watchdog wrote 'missing': listed with capture's why.
      placeholder('c-a', now - 270 * MIN, { state: 'not-admitted', message: LIVE_JOIN_MESSAGES.neverSentNoKey }, { slotKey: 'action:a2', purpose: '' }),
      placeholder('c-a', now - 30 * MIN, { state: 'dispatched' }, { slotKey: 'action:a1', purpose: '' }),
      placeholder('c-a', now - 5 * 60 * MIN, { state: 'ended' }, { slotKey: '', purpose: 'workshop', forSalesMeeting: false }),
      // Past the deadline, but Fireflies is still processing a recording from the room.
      placeholder('c-a', now - 192 * MIN, { state: 'ended', message: 'Fireflies behandler fortsatt opptaket.' }, { slotKey: 'action:a3', purpose: '' }),
      placeholder('c-a', now - 2 * day, { state: 'declined' }),
      placeholder('c-a', now - 61 * day, { state: 'missing' }),
    ],
  };
  const b = {
    id: 'c-b',
    businessName: 'Testfirma B AS',
    ownerId: 'sales:rep-2',
    meetings: [
      placeholder('c-b', now - 4 * 60 * MIN, { state: 'empty', ffMeetingId: 'FFSIL003', missingAt: iso(-60), message: 'Fireflies var med, men opptaket er tomt.' }),
      // Superseded: its recording with talk is linked.
      placeholder('c-b', now - 6 * 60 * MIN, { state: 'missing' }),
      { meetingId: 'FFTALK03', meetLink: ROOM, startedAt: new Date(now - 6 * 60 * MIN + MIN).toISOString(), hasTranscript: true },
    ],
  };
  const all = watchdog.missingRecordingRows([a, b], { nowMs: now });
  assert.equal(all.count, 4);
  assert.deepEqual(all.rows.map((row) => [row.clientId, row.state]), [
    ['c-a', 'missing'],
    ['c-b', 'empty'],
    ['c-a', 'not-admitted'],
    ['c-a', 'missing'],
  ]);
  const [missing, empty, notAdmitted, derived] = all.rows;
  assert.equal(notAdmitted.message, LIVE_JOIN_MESSAGES.neverSentNoKey);
  assert.equal(notAdmitted.kind, 'action');
  assert.equal(missing.kind, 'sales');
  assert.equal(missing.alertedAt, iso(-30));
  assert.equal(empty.businessName, 'Testfirma B AS');
  assert.equal(empty.ownerId, 'sales:rep-2');
  assert.equal(derived.kind, 'workshop', 'a legacy row without a slot key');
  assert.equal(derived.message, 'Ingen Fireflies-opptak etter møtet.', 'past its deadline, nothing written yet');
  for (const field of ['clientId', 'businessName', 'ownerId', 'meetingId', 'slotKey', 'kind', 'startedAt', 'meetLink', 'title', 'state', 'message', 'missingAt', 'alertedAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(missing, field), field);
  }
  const rep = watchdog.missingRecordingRows([a, b], { nowMs: now, canAccess: (client) => client.ownerId === 'sales:rep-2' });
  assert.deepEqual(rep.rows.map((row) => row.clientId), ['c-b']);
});

// ── 4. "uten opptak" and its undo ────────────────────────────────────────────

test('declined by meeting id or slot key; a booked slot with no row gets one; never a real recording', () => {
  resetAll();
  const recorded = salesClient({ meetings: [{ meetingId: 'FFREAL02', slotKey: `sales:${T}`, hasTranscript: true }] });
  assert.deepEqual(watchdog.recordingDecision({ client: recorded, meetingId: 'FFREAL02', state: 'declined', nowMs: at(5) }), { error: 'not-found' });
  assert.deepEqual(watchdog.recordingDecision({ client: recorded, meetingId: STUB, state: 'held' }), { error: 'bad-state' });

  const withRow = salesClient({ meetings: [placeholder('client-1', T, { state: 'dispatched', sessionKey: KEY })] });
  const byId = watchdog.recordingDecision({ client: withRow, meetingId: STUB, state: 'declined', by: 'Kari Test', nowMs: at(5) });
  assert.equal(byId.meetingId, STUB);
  assert.equal(byId.sessionKey, KEY);
  assert.equal(byId.declined, true);
  assert.equal(byId.recording.state, 'declined');
  assert.equal(byId.recording.message, 'Markert som uten opptak av Kari Test.');
  assert.equal(byId.create, null);
  assert.equal(watchdog.recordingDecision({ client: withRow, slotKey: `sales:${T}`, state: 'declined', nowMs: at(5) }).meetingId, STUB);

  // A slot with no placeholder yet (the client cancelled before the meeting), here three days out.
  const ahead = salesClient({ meetingAt: iso(3 * 24 * 60) });
  const slotKey = `sales:${at(3 * 24 * 60)}`;
  const created = watchdog.recordingDecision({ client: ahead, slotKey, state: 'declined', by: 'Kari Test', nowMs: at(0) });
  assert.equal(created.meetingId, `live:client-1:${at(3 * 24 * 60)}`);
  assert.equal(created.recording, null);
  assert.equal(created.create.slot.slotKey, slotKey);
  assert.equal(created.create.recording.state, 'declined');
  assert.equal(created.create.recording.sessionKey, `${ROOM}|${at(3 * 24 * 60)}`);
  assert.deepEqual(watchdog.recordingDecision({ client: ahead, slotKey: 'sales:1', state: 'declined', nowMs: at(0) }), { error: 'not-found' });
});

test('a moved Møte is marked on its current booking, never on the row of the time it was moved from', () => {
  resetAll();
  // The rep's Møte was at 11:00 (its never-sent placeholder is on the card) and is now tomorrow at 11:00.
  const tomorrow = at(24 * 60);
  const action = {
    id: 'act-1',
    presetKey: 'custom',
    goalKey: 'meetingHeld',
    name: 'Oppfølgingsmøte',
    format: 'mote',
    addToCalendar: true,
    calendarEventId: 'evt-1',
    dueAt: new Date(tomorrow).toISOString(),
    meetLink: ROOM_B,
  };
  const oldRow = placeholder('client-1:act-1', T, { state: 'not-admitted', sessionKey: `${ROOM_B}|${T}`, message: LIVE_JOIN_MESSAGES.neverSent }, {
    slotKey: 'action:act-1',
    meetLink: ROOM_B,
    forSalesMeeting: false,
  });
  const client = salesClient({ agreedTime: false, nextActions: [action], meetings: [oldRow] });
  const decision = watchdog.recordingDecision({ client, slotKey: 'action:act-1', state: 'declined', by: 'Kari Test', nowMs: at(120) });
  assert.equal(decision.meetingId, `live:client-1:act-1:${tomorrow}`);
  assert.equal(decision.sessionKey, `${ROOM_B}|${tomorrow}`, 'the engine stops the new session, not the old one');
  assert.equal(decision.create?.slot.startAt, new Date(tomorrow).toISOString(), 'the current booking gets its own placeholder');
  // Nothing to undo on the current booking; the earlier meeting is still marked by its own id.
  const open = watchdog.recordingDecision({ client, slotKey: 'action:act-1', state: 'open', nowMs: at(120) });
  assert.deepEqual([open.meetingId, open.sessionKey, open.recording, open.declined], [`live:client-1:act-1:${tomorrow}`, `${ROOM_B}|${tomorrow}`, null, false]);
  assert.equal(watchdog.recordingDecision({ client, meetingId: oldRow.meetingId, state: 'declined', nowMs: at(120) }).meetingId, oldRow.meetingId);
  // Once the Møte is no longer booked, its key finds the newest placeholder it left.
  const gone = { ...client, nextActions: [] };
  assert.equal(watchdog.recordingDecision({ client: gone, slotKey: 'action:act-1', state: 'declined', nowMs: at(120) }).meetingId, oldRow.meetingId);
});

test('"uten opptak" on the live card of a moved Møte stops the bot for that booking and leaves the earlier one missing', async () => {
  resetAll();
  const ui = await import(new URL('../app/pages/Admin/sections/firefliesRecording.ts', import.meta.url).href);
  const { buildClientActivityLog } = await import('../lib/sales-activity-log.js');
  // Two days ago nobody came to the rep's Møte (its placeholder is 'missing'); it is now booked at T.
  const earlier = T - 2 * 24 * 60 * MIN;
  const action = {
    id: 'act-9',
    presetKey: 'custom',
    goalKey: 'meetingHeld',
    name: 'Oppfølgingsmøte',
    format: 'mote',
    addToCalendar: true,
    calendarEventId: 'evt-9',
    dueAt: iso(0),
    meetLink: ROOM_B,
  };
  const oldRow = placeholder('client-1:act-9', earlier, {
    state: 'missing',
    missingAt: new Date(earlier + 3 * 60 * MIN).toISOString(),
    message: 'Ingen Fireflies-opptak etter møtet.',
  }, { slotKey: 'action:act-9', meetLink: ROOM_B, forSalesMeeting: false });
  const client = salesClient({ agreedTime: false, nextActions: [action], meetings: [oldRow] });
  const state = { clients: [client], active: [], sent: [], reply: null };
  await tickAt(state, -20);

  // The client log does not put the earlier meeting's "ingen opptak" on the Møte that is still ahead.
  const logRows = (log) => log.sections.flatMap((section) => section.rows);
  const before = logRows(buildClientActivityLog(client));
  assert.equal(before.find((row) => row.actionId === 'act-9').meeting, null);
  assert.equal(before.find((row) => row.kind === 'meeting')?.meeting.meetingId, oldRow.meetingId);

  // The card's entry is the booking at T; it has no row yet, so the card sends the slot key, not the old row's id.
  const entry = live.presentLiveRecordings(client, { nowMs: at(-20) }).find((item) => item.slotKey === 'action:act-9');
  assert.equal(entry.startAt, iso(0));
  assert.equal(ui.livePlaceholderRow(client, entry), null);
  const decision = watchdog.recordingDecision({ client, slotKey: entry.slotKey, state: 'declined', by: 'Kari Test', nowMs: at(-20) });
  // What the route does with it.
  rowWriter(state.clients)(decision.create);
  live.setLiveSessionDeclined(decision.sessionKey, true, { nowMs: at(-20) });
  const newRow = client.meetings.find((row) => row.meetingId === `live:client-1:act-9:${T}`);
  assert.equal(newRow.recording.state, 'declined');
  assert.equal(ui.livePlaceholderRow(client, entry), newRow, 'once written, the booking\'s own row is the one marked');

  for (const minutes of [-3, 1, 5, 15]) await tickAt(state, minutes);
  assert.equal(state.sent.length, 0, 'Fireflies is never sent into the meeting the client said no to');
  assert.equal(oldRow.recording.state, 'missing', 'the earlier meeting is still reported');
  const after = logRows(buildClientActivityLog(client));
  assert.equal(after.find((row) => row.actionId === 'act-9').meeting.meetingId, newRow.meetingId);
  assert.equal(after.find((row) => row.kind === 'meeting')?.meeting.recordingState, 'missing');
});

test('a slot whose recording with talk is linked is not marked "uten opptak"', () => {
  resetAll();
  const client = salesClient({ meetings: [{ meetingId: 'FFTALK09', meetLink: ROOM, startedAt: iso(2), hasTranscript: true }] });
  assert.deepEqual(watchdog.recordingDecision({ client, slotKey: `sales:${T}`, state: 'declined', nowMs: at(90) }), { error: 'has-recording' });
  // A "hallo?" of a few sentences is no recording of the meeting: the rep may still mark it.
  const fragment = salesClient({ meetings: [{ meetingId: 'FFHALLO9', meetLink: ROOM, startedAt: iso(2), hasTranscript: true, sentenceCount: 3 }] });
  const marked = watchdog.recordingDecision({ client: fragment, slotKey: `sales:${T}`, state: 'declined', nowMs: at(90) });
  assert.equal(marked.declined, true);
  assert.equal(marked.create.recording.state, 'declined');
});

test('open undoes declined: missing stays reported, otherwise capture\'s state comes back', () => {
  resetAll();
  const wasMissing = salesClient({ meetings: [placeholder('client-1', T, { state: 'declined', missingAt: iso(150), alertedAt: iso(150), dispatchedAt: iso(-3) })] });
  const reopened = watchdog.recordingDecision({ client: wasMissing, meetingId: STUB, state: 'open', by: 'Kari Test', nowMs: at(200) });
  assert.equal(reopened.declined, false);
  assert.equal(reopened.recording.state, 'missing');
  const merged = mergeRecordingState(wasMissing.meetings[0].recording, reopened.recording);
  assert.equal(merged.alertedAt, iso(150), 'no second e-mail');
  assert.equal(merged.checkedAt, '', 'the watchdog looks again soon');

  live.upsertLiveSessionsForClient(salesClient(), { nowMs: at(-10) });
  updateLiveSessionStore((store) => {
    store.sessions[KEY] = { ...applyLiveJoinAttempt(store.sessions[KEY], { at: iso(-3), kind: 'first', ok: true }) };
    return store;
  }, { nowMs: at(-3) });
  const declinedEarly = salesClient({ meetings: [placeholder('client-1', T, { state: 'declined', sessionKey: KEY })] });
  const back = watchdog.recordingDecision({ client: declinedEarly, meetingId: STUB, state: 'open', nowMs: at(2) });
  assert.equal(back.recording.state, 'dispatched');
  assert.equal(back.recording.message, LIVE_JOIN_MESSAGES.dispatched);

  const orphan = salesClient({ meetings: [placeholder('client-1', at(-600), { state: 'declined' }, { slotKey: '' })] });
  assert.equal(watchdog.recordingDecision({ client: orphan, meetingId: `live:client-1:${at(-600)}`, state: 'open', nowMs: at(0) }).recording.state, 'not-admitted');
  // Marked three days ahead, before the engine has the session, and opened again: scheduled, not "not let in".
  const aheadStart = at(3 * 24 * 60);
  const ahead = salesClient({ meetingAt: new Date(aheadStart).toISOString() });
  const marked = watchdog.recordingDecision({ client: ahead, slotKey: `sales:${aheadStart}`, state: 'declined', nowMs: at(0) });
  ahead.meetings.push(placeholder('client-1', aheadStart, marked.create.recording));
  const reopenedAhead = watchdog.recordingDecision({ client: ahead, meetingId: marked.meetingId, state: 'open', nowMs: at(1) });
  assert.equal(reopenedAhead.recording.state, 'scheduled');
  assert.equal(reopenedAhead.recording.message, LIVE_JOIN_MESSAGES.scheduled);
  const notDeclined = watchdog.recordingDecision({ client: declinedEarly, meetingId: STUB, state: 'open', nowMs: at(2) });
  assert.equal(notDeclined.recording.state, 'dispatched');
  const plain = salesClient({ meetings: [placeholder('client-1', T, { state: 'ended' })] });
  assert.equal(watchdog.recordingDecision({ client: plain, meetingId: STUB, state: 'open', nowMs: at(2) }).recording, null, 'nothing to undo');
});

test('declined stops the engine for that session, and open lets it send again', async () => {
  resetAll();
  const client = salesClient();
  const state = { clients: [client], active: [], sent: [], reply: null };
  const decision = watchdog.recordingDecision({ client, slotKey: `sales:${T}`, state: 'declined', by: 'Kari Test', nowMs: at(-10) });
  rowWriter(state.clients)({ session: { title: 'Testfirma AS · Kari Test', startAt: iso(0), meetLink: ROOM }, slot: decision.create.slot, recording: decision.create.recording });
  live.upsertLiveSessionsForClient(client, { nowMs: at(-10) });
  assert.equal(live.setLiveSessionDeclined(decision.sessionKey, true, { nowMs: at(-10) }).declinedAt, iso(-10));
  await tickAt(state, -3);
  assert.equal(state.sent.length, 0, 'declined: no knock');
  assert.equal(client.meetings[0].liveJoinedAt, '');

  const open = watchdog.recordingDecision({ client, meetingId: decision.meetingId, state: 'open', nowMs: at(-2) });
  client.meetings[0].recording = mergeRecordingState(client.meetings[0].recording, open.recording);
  live.setLiveSessionDeclined(open.sessionKey, false, { nowMs: at(-2) });
  await tickAt(state, -2);
  assert.equal(state.sent.length, 1, 'opened: the first knock goes');
  assert.equal(readLiveSessionStore().sessions[KEY].declinedAt, '');
});

// ── server glue ──────────────────────────────────────────────────────────────

test('server.js wires the alerts, the placeholders and the routes', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const between = (from, to) => server.slice(server.indexOf(from), server.indexOf(to, server.indexOf(from) + from.length));
  const tick = between('async function sendDueFirefliesLiveJoins()', 'function firefliesLobbyAlertEnabled()');
  assert.match(tick, /runFirefliesLiveJoinTick\(firefliesLiveJoinDeps\(\)\);\s*if \(summary\?\.skipped\) return summary;/);
  assert.match(tick, /ensureLivePlaceholders\(\{ clients, writePlaceholder: writeUnsentLivePlaceholder \}\)/);
  assert.match(tick, /runFirefliesLobbyAlerts\(\{[^]*mayAlert: firefliesAlertAllowedFor,[^]*\}\)/);
  assert.match(tick, /maybeAlertFirefliesLiveJoinHealth\(clients\)/);
  assert.match(server, /function firefliesLobbyAlertEnabled\(\) \{\s*return parseBoolean\(process\.env\.FIREFLIES_LOBBY_ALERT, true\);/);
  // The team address only when the rep is set but has no e-mail; no rep, no e-mail.
  const recipients = between('function firefliesLobbyRecipientsFor()', 'async function maybeAlertFirefliesLiveJoinHealth(');
  assert.match(recipients, /if \(!sanitizeText\(client\?\.ownerId\)\) return \[\];/);
  assert.match(recipients, /\(await firefliesRepEmailFor\(client, owners\)\) \|\| readFirefliesWebhookConfig\(\)\.notifyEmail/);
  const unsent = between('function writeUnsentLivePlaceholder(', '/** After every addToLiveMeeting attempt');
  assert.match(unsent, /return writeLivePlaceholder\(\{ slot, session, client, recording \}\);/, 'no liveJoinedAt');
  // No key still reports the meetings no bot was sent to; test clients that are not pilots get no e-mail.
  const step = between('async function runFirefliesWatchdogStep()', 'let firefliesIngestAt = 0;');
  assert.doesNotMatch(step, /if \(!config\.apiKey\) return/);
  assert.match(step, /apiKey: config\.apiKey,/);
  assert.match(step, /mayAlert: firefliesAlertAllowedFor,/);
  // The watchdog hears a refused link (null) and looks up with the client, so exclusions and pins hold.
  assert.match(step, /linkTranscript: \(clientId, record, placeholder\) => linkStoredTranscriptToClient\(record, \{/);
  assert.doesNotMatch(step, /lookup:/, 'the default lookup passes the client and the clients');
  assert.match(server, /await maybeAlertFirefliesIngest\(\{[^\n]*\}\);\s*\/\/[^\n]*\n\s*await maybeAlertFirefliesLiveJoinHealth\(\);/);
  const status = between("app.get('/api/admin/fireflies/live-join-status'", "app.get('/api/admin/fireflies/missing-recordings'");
  assert.match(status, /requireOfferAdmin\(req, res\)/);
  assert.match(status, /res\.setHeader\('Cache-Control', 'no-store'\)/);
  assert.match(status, /liveJoinStatusPayload\(/);
  const missing = between("app.get('/api/admin/fireflies/missing-recordings'", "app.post('/api/admin/sales/:id/fireflies/recording'");
  assert.match(missing, /salesAuth/);
  assert.match(missing, /canAccess: \(client\) => canAccessSalesClient\(req, client\)/);
  assert.match(missing, /res\.setHeader\('Cache-Control', 'no-store'\)/);
  const route = between("app.post('/api/admin/sales/:id/fireflies/recording'", "app.get('/api/admin/fireflies/meetings/:meetingId'");
  assert.match(route, /if \(decision\.create\) written = Boolean\(writeLivePlaceholder\(\{ \.\.\.decision\.create, client \}\)\);/);
  assert.match(route, /decision\.error === 'has-recording'\) return res\.status\(409\)/);
  // The engine is marked only once the row is written.
  const guard = route.indexOf('if (!written) return res.status(404)');
  assert.ok(guard > -1 && guard < route.indexOf('setLiveSessionDeclined('));
  assert.match(route, /setLiveSessionDeclined\(decision\.sessionKey, decision\.declined\);/);
  assert.match(route, /client: jsonSalesClient\(updated\)/);
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /^FIREFLIES_LOBBY_ALERT=$/m);
});
