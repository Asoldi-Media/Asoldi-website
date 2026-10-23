// No booked meeting ends without a recording unnoticed: every session that never got the bot in has a
// placeholder that says why and is followed to 'missing'; the rep hears while the bot knocks; an empty
// recording is reported once; the owner hears when live join is down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// ── server glue ──────────────────────────────────────────────────────────────

test('server.js writes the placeholders and sends the alerts after every tick, and the ingest tick watches live join', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const between = (from, to) => server.slice(server.indexOf(from), server.indexOf(to, server.indexOf(from) + from.length));
  const tick = between('async function sendDueFirefliesLiveJoins()', 'async function noteFirefliesBotJoinedWebhook(');
  assert.match(tick, /runFirefliesLiveJoinTick\(firefliesLiveJoinDeps\(\)\);\s*if \(summary\?\.skipped\) return summary;/);
  assert.match(tick, /ensureLivePlaceholders\(\{ clients, writePlaceholder: writeUnsentLivePlaceholder \}\)/);
  const unsent = between('function writeUnsentLivePlaceholder(', '/** After every addToLiveMeeting attempt');
  assert.match(unsent, /return writeLivePlaceholder\(\{ slot, session, client, recording \}\);/, 'no liveJoinedAt');
  assert.match(tick, /runFirefliesLobbyAlerts\(\{[^]*mayAlert: firefliesAlertAllowedFor,[^]*\}\)/);
  assert.match(tick, /maybeAlertFirefliesLiveJoinHealth\(clients\)/);
  assert.match(server, /function firefliesLobbyAlertEnabled\(\) \{\s*return parseBoolean\(process\.env\.FIREFLIES_LOBBY_ALERT, true\);/);
  // The team address only when the rep is set but has no e-mail; no rep, no e-mail.
  const recipients = between('function firefliesLobbyRecipientsFor()', 'async function maybeAlertFirefliesLiveJoinHealth(');
  assert.match(recipients, /if \(!sanitizeText\(client\?\.ownerId\)\) return \[\];/);
  assert.match(recipients, /\(await firefliesRepEmailFor\(client, owners\)\) \|\| readFirefliesWebhookConfig\(\)\.notifyEmail/);
  assert.match(server, /await maybeAlertFirefliesIngest\(\{[^\n]*\}\);\s*\/\/[^\n]*\n\s*await maybeAlertFirefliesLiveJoinHealth\(\);/);
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /^FIREFLIES_LOBBY_ALERT=$/m);
});
