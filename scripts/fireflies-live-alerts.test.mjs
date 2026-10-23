// No booked meeting ends without a recording unnoticed: every session that never got the bot in has a
// placeholder that says why and is followed to 'missing', and an empty recording is reported once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-live-alerts-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const live = await import('../lib/fireflies-live-sessions.js');
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
  // Recorded in another room but resolved to this slot (by a person, or Track C's matching): linked too.
  resetAll();
  const elsewhere = salesClient({ meetings: [{ meetingId: 'FFSLOT01', meetLink: ROOM_C, slotKey: `sales:${T}`, startedAt: iso(3), hasTranscript: true }] });
  const slotLinked = { clients: [elsewhere], active: [], sent: [], reply: null };
  await tickAt(slotLinked, 31, { apiKey: () => '' });
  assert.deepEqual(live.ensureLivePlaceholders({ clients: slotLinked.clients, writePlaceholder: rowWriter(slotLinked.clients), nowMs: at(31), log: quiet }), []);
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

// ── server glue ──────────────────────────────────────────────────────────────

test('server.js writes the placeholders of sessions that ended without a bot after every tick', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const between = (from, to) => server.slice(server.indexOf(from), server.indexOf(to, server.indexOf(from) + from.length));
  const tick = between('async function sendDueFirefliesLiveJoins()', 'async function noteFirefliesBotJoinedWebhook(');
  assert.match(tick, /runFirefliesLiveJoinTick\(firefliesLiveJoinDeps\(\)\);\s*if \(summary\?\.skipped\) return summary;/);
  assert.match(tick, /ensureLivePlaceholders\(\{ clients, writePlaceholder: writeUnsentLivePlaceholder \}\)/);
  const unsent = between('function writeUnsentLivePlaceholder(', '/** After every addToLiveMeeting attempt');
  assert.match(unsent, /return writeLivePlaceholder\(\{ slot, session, client, recording \}\);/, 'no liveJoinedAt');
});
