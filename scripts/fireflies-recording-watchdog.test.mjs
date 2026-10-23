// The missing-recording watchdog: a placeholder whose meeting is over gets its transcript linked
// (by the bot's id or by the booked Meet link), turns 'empty' or 'missing', and the team and rep
// hear about a missing recording once. "Try later" errors never make a meeting missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-ff-watchdog-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const ff = await import('../lib/fireflies-webhook.js');
const watchdog = await import('../lib/fireflies-recording-watchdog.js');
const { mergeRecordingState } = await import('../lib/fireflies-recording-state.js');
const { FirefliesApiError } = await import('../lib/fireflies-graphql.js');

const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const quiet = { log() {}, warn() {} };

let seq = 0;
/** A booked sales meeting at `start` on its own invented Meet room, with the hub's placeholder. */
function booking(start, recording = { state: 'dispatched' }) {
  seq += 1;
  const meet = `https://meet.google.com/abc-${String(1000 + seq)}-hij`;
  const clientId = `c-test-${seq}`;
  return {
    id: clientId,
    businessName: `Testfirma ${seq} AS`,
    ownerId: 'sales:rep-1',
    meetings: [{
      meetingId: `live:${clientId}:${start}`,
      title: `Testfirma ${seq} AS · Kari Test`,
      startedAt: iso(start),
      meetLink: meet,
      hasTranscript: false,
      linkedBy: 'live-join',
      forSalesMeeting: true,
      purpose: 'sales',
      slotKey: `sales:${start}`,
      recording: mergeRecordingState(null, { dispatchedAt: iso(start - 2 * MIN), ...recording }),
    }],
  };
}

/** In-memory clients plus the server deps the watchdog needs. */
function hub(clients) {
  const sent = [];
  const linked = [];
  const deps = {
    getClients: () => clients,
    patchPlaceholder: (clientId, meetingId, patch) => {
      const row = clients.find((client) => client.id === clientId)?.meetings.find((item) => item.meetingId === meetingId);
      if (!row) return null;
      row.recording = mergeRecordingState(row.recording, patch);
      return row;
    },
    linkTranscript: (clientId, record) => {
      linked.push({ clientId, meetingId: record.meetingId });
      const client = clients.find((item) => item.id === clientId);
      // The real link drops the placeholder for the same room.
      client.meetings = client.meetings.filter((row) => !row.meetingId.startsWith('live:'));
      client.meetings.push({ meetingId: record.meetingId, meetLink: record.meetingLink, startedAt: record.startedAt, hasTranscript: true });
      return client;
    },
    recipientsFor: async () => ['ansatte@asoldi.com', 'alexander@asoldi.com'],
    sendEmail: async (message) => { sent.push(message); },
  };
  return { sent, linked, deps };
}

/** Fireflies: the transcripts list and transcript(id), from plain objects. */
function fireflies({ list = [], transcripts = {} } = {}) {
  const calls = { list: 0, fetch: [] };
  return {
    calls,
    lookupWith: (nowMs) => (placeholder, client, clients) => watchdog.lookupPlaceholderTranscript(placeholder, {
      apiKey: 'fake-key',
      nowMs,
      clientId: client?.id,
      clients,
      listTranscripts: async () => {
        calls.list += 1;
        if (list instanceof Error) throw list;
        return list.map((row) => ({ ...row }));
      },
      hydrate: async (id) => {
        calls.fetch.push(id);
        const answer = transcripts[id];
        if (answer instanceof Error) return { outcome: 'later', error: answer };
        if (!answer) return { outcome: 'failed', error: new Error('Object not found') };
        return { outcome: 'fetched', record: ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer), { nowMs }) };
      },
    }),
  };
}

/** Fireflies' transcript(id) answer: a meeting's worth of talk (12 sentences) unless `sentences` says less. */
function answer(id, { start, meet, status = 'processed', talk = true, sentences = 12 }) {
  return {
    id,
    title: 'Opptak',
    dateString: iso(start + MIN),
    duration: 45,
    meeting_link: meet,
    is_live: false,
    meeting_info: { summary_status: status, silent_meeting: !talk },
    sentences: talk ? Array.from({ length: sentences }, (_, index) => ({ speaker_name: 'Kari Test', text: `Vi vil ha en ny nettside, del ${index + 1}.` })) : [],
    summary: talk && status === 'processed' ? { overview: 'Ny nettside.' } : {},
  };
}

async function run(h, ffake, nowMs) {
  return watchdog.runFirefliesRecordingWatchdog({ ...h.deps, apiKey: 'fake-key', nowMs, lookup: ffake.lookupWith(nowMs), log: quiet });
}

test('a placeholder is left alone until its session is over, and then checked at most every 10 minutes', () => {
  const start = Date.parse('2026-10-23T10:00:00.000Z');
  const [row] = booking(start).meetings;
  assert.equal(watchdog.planPlaceholderCheck(row, { nowMs: start + 30 * MIN }).reason, 'in-session');
  const plan = watchdog.planPlaceholderCheck(row, { nowMs: start + 61 * MIN });
  assert.equal(plan.action, 'lookup');
  assert.equal(plan.deadlineMs, start + 150 * MIN, 'start + 60 booked + 90');
  assert.equal(plan.overdue, false);
  assert.equal(watchdog.planPlaceholderCheck(row, { nowMs: start + 65 * MIN, checkedMs: start + 61 * MIN }).reason, 'checked-lately');
  assert.equal(watchdog.planPlaceholderCheck({ ...row, recording: { state: 'ended' } }, { nowMs: start + 20 * MIN }).action, 'lookup', 'the bot left early: look at once');
  assert.equal(watchdog.planPlaceholderCheck({ ...row, recording: { state: 'declined' } }, { nowMs: start + 200 * MIN }).reason, 'done');
  // Empty, like missing, is looked at hourly within the watch: a recording with talk may still turn up.
  const empty = (checkedAt) => ({ ...row, recording: { state: 'empty', checkedAt: iso(checkedAt) } });
  assert.equal(watchdog.planPlaceholderCheck(empty(start + 170 * MIN), { nowMs: start + 200 * MIN }).reason, 'checked-lately');
  assert.equal(watchdog.planPlaceholderCheck(empty(start + 130 * MIN), { nowMs: start + 200 * MIN }).action, 'lookup');
  assert.equal(watchdog.planPlaceholderCheck(empty(start + 130 * MIN), { nowMs: start + (150 + 49 * 60) * MIN }).reason, 'watch-over');
  assert.equal(watchdog.planPlaceholderCheck({ ...row, meetingId: 'FFREAL01' }, { nowMs: start + 200 * MIN }).reason, 'not-a-placeholder');
});

test('found by id: the transcript of the bot capture saw in the room is fetched and linked', async () => {
  const start = Date.parse('2026-10-23T11:00:00.000Z');
  const client = booking(start, { state: 'ended', ffMeetingId: 'FFBYID01' });
  const h = hub([client]);
  const meet = client.meetings[0].meetLink;
  const fake = fireflies({ transcripts: { FFBYID01: answer('FFBYID01', { start, meet }) } });
  const result = await run(h, fake, start + 62 * MIN);
  assert.deepEqual(fake.calls.fetch, ['FFBYID01']);
  assert.equal(fake.calls.list, 0, 'no search needed');
  assert.deepEqual(h.linked, [{ clientId: client.id, meetingId: 'FFBYID01' }]);
  assert.deepEqual(result.linked, [`live:${client.id}:${start}`]);
  assert.equal(h.sent.length, 0);
});

test('found by link: a transcript on the booked room links; one with the same title elsewhere is only a candidate', async () => {
  const start = Date.parse('2026-10-23T12:00:00.000Z');
  const client = booking(start);
  const h = hub([client]);
  const [row] = client.meetings;
  const meet = row.meetLink;
  const fake = fireflies({
    list: [
      { id: 'FFTITLE1', title: row.title, dateString: iso(start), meeting_link: 'https://meet.google.com/zzz-yyyy-xxx' },
      { id: 'FFROOM01', title: 'Opptak', dateString: iso(start + MIN), meeting_link: `${meet}?authuser=0` },
    ],
    transcripts: { FFROOM01: answer('FFROOM01', { start, meet }) },
  });
  await run(h, fake, start + 70 * MIN);
  assert.deepEqual(fake.calls.fetch, ['FFROOM01'], 'the title match is never fetched or linked');
  assert.deepEqual(h.linked.map((entry) => entry.meetingId), ['FFROOM01']);
});

test('nothing by the deadline: missing, one alert to the team and the rep, and a late transcript still links', async () => {
  const start = Date.parse('2026-10-23T13:00:00.000Z');
  const client = booking(start);
  const h = hub([client]);
  const [row] = client.meetings;
  const fake = fireflies({
    list: [{ id: 'FFTITLE2', title: row.title, dateString: iso(start), meeting_link: 'https://meet.google.com/qqq-wwww-eee', transcript_url: 'https://app.fireflies.ai/view/FFTITLE2' }],
  });
  await run(h, fake, start + 100 * MIN);
  assert.notEqual(row.recording.state, 'missing', 'before the deadline: still waiting');
  assert.ok(row.recording.checkedAt);

  const result = await run(h, fake, start + 151 * MIN);
  assert.equal(row.recording.state, 'missing');
  assert.ok(row.recording.missingAt);
  assert.ok(Date.parse(row.recording.alertedAt) >= Date.parse(row.recording.missingAt));
  assert.deepEqual(result.missing, [row.meetingId]);
  assert.equal(h.sent.length, 1);
  const mail = h.sent[0];
  assert.equal(mail.to, 'ansatte@asoldi.com, alexander@asoldi.com');
  assert.equal(mail.subject, `Fireflies: ingen opptak av salgsmøtet med ${client.businessName}`);
  assert.match(mail.text, /ble ikke sett i møtet/);
  assert.match(mail.text, /Lim inn Fireflies-lenken under Bytt opptak/);
  assert.match(mail.text, /skriv produktnotater/);
  assert.match(mail.text, /Marker møtet som uten opptak/);
  assert.match(mail.text, /https:\/\/app\.fireflies\.ai\/view\/FFTITLE2/, 'the same-title recording is offered, not linked');
  assert.equal(h.linked.length, 0);

  await run(h, fake, start + 155 * MIN);
  assert.equal(fake.calls.list, 2, 'a missing meeting is looked for hourly');
  await run(h, fake, start + 212 * MIN);
  assert.equal(fake.calls.list, 3);
  assert.equal(h.sent.length, 1, 'one e-mail only');

  // The transcript turns up late (another rep's account shared it, or Fireflies was slow).
  const late = fireflies({
    list: [{ id: 'FFLATE01', title: 'Opptak', dateString: iso(start + MIN), meeting_link: row.meetLink }],
    transcripts: { FFLATE01: answer('FFLATE01', { start, meet: row.meetLink }) },
  });
  await run(h, late, start + 280 * MIN);
  assert.deepEqual(h.linked.map((entry) => entry.meetingId), ['FFLATE01']);
});

test('a rate limit or network error never makes a meeting missing', async () => {
  const start = Date.parse('2026-10-23T14:00:00.000Z');
  const first = booking(start);
  const second = booking(start + 5 * MIN);
  const h = hub([first, second]);
  const fake = fireflies({ list: new FirefliesApiError('Too many requests.', { code: 'rate-limited' }) });
  const result = await run(h, fake, start + 160 * MIN);
  assert.ok(result.paused);
  assert.equal(fake.calls.list, 1, 'the tick stops at the first try-later answer');
  for (const client of [first, second]) {
    assert.equal(client.meetings[0].recording.state, 'dispatched');
    assert.equal(client.meetings[0].recording.missingAt, '');
  }
  assert.equal(h.sent.length, 0);
});

test('a finished silent recording on the room sets empty at the deadline with one alert, and a processing one keeps it waiting', async () => {
  const start = Date.parse('2026-10-23T15:00:00.000Z');
  const silent = booking(start);
  const processing = booking(start + MIN);
  const h = hub([silent, processing]);
  const silentMeet = silent.meetings[0].meetLink;
  const busyMeet = processing.meetings[0].meetLink;
  const fake = fireflies({
    list: [
      { id: 'FFSILENT', title: 'Opptak', dateString: iso(start), meeting_link: silentMeet },
      { id: 'FFBUSY01', title: 'Opptak', dateString: iso(start + MIN), meeting_link: busyMeet },
    ],
    transcripts: {
      FFSILENT: answer('FFSILENT', { start, meet: silentMeet, status: 'skipped', talk: false }),
      FFBUSY01: { ...answer('FFBUSY01', { start, meet: busyMeet, status: 'processing', talk: false }) },
    },
  });
  await run(h, fake, start + 160 * MIN);
  assert.equal(silent.meetings[0].recording.state, 'empty');
  assert.equal(silent.meetings[0].recording.ffMeetingId, 'FFSILENT');
  assert.ok(Date.parse(silent.meetings[0].recording.alertedAt) >= Date.parse(silent.meetings[0].recording.missingAt));
  assert.equal(processing.meetings[0].recording.state, 'dispatched', 'Fireflies is still working: not missing');
  assert.equal(h.sent.length, 1, 'one e-mail, about the empty one');
  assert.equal(h.sent[0].subject, `Fireflies: tomt opptak av salgsmøtet med ${silent.businessName}`);
  assert.match(h.sent[0].text, /Fireflies var med på salgsmøtet med .*, men opptaket er tomt/);
  assert.match(h.sent[0].text, /Marker møtet som uten opptak/);
  // Looked at hourly for a late recording with talk, without a second e-mail.
  const again = await run(h, fake, start + 400 * MIN);
  assert.equal(again.checked.includes(silent.meetings[0].meetingId), true);
  assert.equal(silent.meetings[0].recording.state, 'empty');
  assert.equal(h.sent.filter((mail) => mail.subject.endsWith(silent.businessName)).length, 1);
  assert.equal(fake.calls.fetch.filter((id) => id === 'FFSILENT').length, 1, 'a finished silent copy is never fetched again');
});

test('a meeting that runs past its booking: no lookup while capture sees the bot, and live captions are never linked or stored', async () => {
  const start = Date.parse('2026-10-23T08:00:00.000Z');
  const client = booking(start, { state: 'recording', ffMeetingId: 'FFLONG01', lastSeenAt: iso(start + 64 * MIN) });
  const [row] = client.meetings;
  assert.equal(watchdog.planPlaceholderCheck(row, { nowMs: start + 65 * MIN }).reason, 'in-session', 'capture saw the bot a minute ago');
  assert.equal(watchdog.recordingDeadlineMs(row), start + (64 + 90) * MIN, 'the deadline counts from when the bot was last seen');

  const h = hub([client]);
  const fetched = [];
  let reply = {
    ...answer('FFLONG01', { start, meet: row.meetLink, status: 'processing' }),
    is_live: true,
    duration: null,
    meeting_info: { summary_status: null },
  };
  const lookupAt = (nowMs) => (placeholder) => watchdog.lookupPlaceholderTranscript(placeholder, {
    apiKey: 'fake-key',
    nowMs,
    fetchTranscript: async (id) => { fetched.push(id); return { ...reply }; },
    listTranscripts: async () => [],
  });
  // Capture stopped reporting (a restart), the meeting is still on: the bot's id answers with captions.
  const first = await watchdog.runFirefliesRecordingWatchdog({ ...h.deps, apiKey: 'fake-key', nowMs: start + 80 * MIN, lookup: lookupAt(start + 80 * MIN), log: quiet });
  assert.deepEqual(fetched, ['FFLONG01']);
  assert.deepEqual(h.linked, [], 'captions are not this meeting\'s recording yet');
  assert.equal(ff.readStoredFirefliesMeeting('FFLONG01'), null, 'nor stored, where the other ingest steps would link them');
  assert.equal(client.meetings[0].meetingId, row.meetingId, 'the placeholder stays for capture');
  assert.equal(client.meetings[0].recording.state, 'recording');
  assert.deepEqual(first.missing, []);

  // The call ended and Fireflies has the transcript: found by the id and linked.
  reply = answer('FFLONG01', { start, meet: row.meetLink });
  await watchdog.runFirefliesRecordingWatchdog({ ...h.deps, apiKey: 'fake-key', nowMs: start + 95 * MIN, lookup: lookupAt(start + 95 * MIN), log: quiet });
  assert.deepEqual(h.linked.map((entry) => entry.meetingId), ['FFLONG01']);
});

test('a later meeting in the same reused room is not this one: only offered, and it never hides the missing alert', async () => {
  const start = Date.parse('2026-10-23T07:00:00.000Z');
  const client = booking(start);
  const [row] = client.meetings;
  // Three hours later the same room held the recorded follow-up, already on the card.
  client.meetings.push({ meetingId: 'FFNEXT01', meetLink: row.meetLink, startedAt: iso(start + 180 * MIN), hasTranscript: true });
  const h = hub([client]);
  const fake = fireflies({
    list: [{ id: 'FFNEXT01', title: 'Opptak', dateString: iso(start + 180 * MIN), meeting_link: row.meetLink, transcript_url: 'https://app.fireflies.ai/view/FFNEXT01' }],
    transcripts: { FFNEXT01: answer('FFNEXT01', { start: start + 180 * MIN, meet: row.meetLink }) },
  });
  const result = await run(h, fake, start + 200 * MIN);
  assert.deepEqual(result.checked, [row.meetingId], 'the later recording does not count as this session');
  assert.deepEqual(fake.calls.fetch, [], 'nor is it fetched as this one');
  assert.deepEqual(h.linked, []);
  assert.equal(row.recording.state, 'missing');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /fra samme Meet-rom til en annen tid/);
  assert.match(h.sent[0].text, /https:\/\/app\.fireflies\.ai\/view\/FFNEXT01/);
});

test('a recording Fireflies is still working on beats an empty fragment; still unfinished hours later it is missing', async () => {
  const start = Date.parse('2026-10-22T09:00:00.000Z');
  const client = booking(start, { state: 'ended' });
  const [row] = client.meetings;
  const h = hub([client]);
  const fake = fireflies({
    list: [
      { id: 'FFFRAG01', title: 'Opptak', dateString: iso(start + MIN), meeting_link: row.meetLink },
      { id: 'FFSLOW01', title: 'Opptak', dateString: iso(start + 2 * MIN), meeting_link: row.meetLink },
    ],
    transcripts: {
      FFFRAG01: answer('FFFRAG01', { start, meet: row.meetLink, status: 'skipped', talk: false }),
      FFSLOW01: answer('FFSLOW01', { start, meet: row.meetLink, status: 'processing', talk: false }),
    },
  });
  await run(h, fake, start + 160 * MIN);
  assert.equal(row.recording.state, 'ended', 'not empty: the real recording is still coming');
  assert.match(row.recording.message, /behandler fortsatt/);
  assert.equal(h.sent.length, 0);

  const deadline = watchdog.recordingDeadlineMs(row);
  await run(h, fake, deadline + watchdog.PENDING_GRACE_MS + MIN);
  assert.equal(row.recording.state, 'missing');
  assert.match(row.recording.message, /aldri ferdig/);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /fortsatt ikke ferdig/);
});

test('lookups that keep failing are counted for the ingest health', async () => {
  const start = Date.parse('2026-10-23T05:00:00.000Z');
  const client = booking(start);
  const h = hub([client]);
  const rejected = Object.assign(new Error('Variable "$fromDate" got an invalid value.'), { code: 'invalid_arguments' });
  const result = await run(h, fireflies({ list: rejected }), start + 70 * MIN);
  assert.deepEqual(result.failed, [client.meetings[0].meetingId]);
  assert.deepEqual(result.health, { missingPlaceholders: 0, lookups: 1, lookupErrors: 1, lastLookupError: rejected.message });
  assert.equal(client.meetings[0].recording.state, 'dispatched', 'a failed lookup decides nothing');
  const paused = await run(hub([booking(start)]), fireflies({ list: new FirefliesApiError('Too many requests.', { code: 'rate-limited' }) }), start + 70 * MIN);
  assert.equal(paused.health.lookups, 0, 'a pause is no lookup');
});

test('"Marker uten opptak" ends the search on a placeholder only', () => {
  const start = Date.parse('2026-10-23T04:00:00.000Z');
  const [row] = booking(start).meetings;
  const decided = watchdog.declinedRecordingPatch(row, { by: 'Kari Test', nowMs: start + 200 * MIN });
  assert.equal(decided.recording.state, 'declined');
  assert.equal(decided.recording.message, 'Markert som uten opptak av Kari Test.');
  const declined = { ...row, recording: mergeRecordingState(row.recording, decided.recording) };
  assert.equal(watchdog.planPlaceholderCheck(declined, { nowMs: start + 300 * MIN }).reason, 'done');
  assert.deepEqual(watchdog.declinedRecordingPatch({ meetingId: 'FFREAL01' }), { error: 'not-a-placeholder' });
});

test('a placeholder from long ago is decided once, quietly; a linked session is skipped', async () => {
  const start = Date.parse('2026-10-01T10:00:00.000Z');
  const old = booking(start, {});
  old.meetings[0].recording = null;
  const linkedStart = Date.parse('2026-10-23T09:00:00.000Z');
  const done = booking(linkedStart);
  done.meetings.push({ meetingId: 'FFDONE01', meetLink: done.meetings[0].meetLink, startedAt: iso(linkedStart + MIN), hasTranscript: true });
  const h = hub([old, done]);
  const fake = fireflies({ list: [] });
  const nowMs = Date.parse('2026-10-23T16:00:00.000Z');
  const result = await run(h, fake, nowMs);
  assert.deepEqual(result.checked, [old.meetings[0].meetingId], 'the linked session costs no lookup');
  assert.equal(old.meetings[0].recording.state, 'missing');
  assert.equal(h.sent.length, 0, 'no e-mail about a meeting weeks ago');
  const later = await run(h, fake, nowMs + 2 * 60 * MIN);
  assert.deepEqual(later.checked, []);
  assert.equal(later.health.missingPlaceholders, 1);
});

/** Store Fireflies' answer as the pull ingest would (final when its summary is processed or skipped). */
function storeAnswer(id, options, nowMs) {
  return ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer(id, options)), { nowMs });
}

test('a placeholder whose only linked recording is a "hallo?" fragment is still followed, and turns empty once, at the deadline', async () => {
  const start = Date.parse('2026-10-24T10:00:00.000Z');
  const client = booking(start, { state: 'ended' });
  const [row] = client.meetings;
  // The bot sat alone in the open room at T+1, someone said "hallo?" twice, and intake linked it.
  storeAnswer('FFHALLO1', { start, meet: row.meetLink, sentences: 2 }, start + 30 * MIN);
  client.meetings.push({ meetingId: 'FFHALLO1', meetLink: row.meetLink, startedAt: iso(start + MIN), hasTranscript: true, sentenceCount: 2 });
  const h = hub([client]);
  const fake = fireflies({ list: [{ id: 'FFHALLO1', title: 'Opptak', dateString: iso(start + MIN), meeting_link: row.meetLink }] });

  const early = await run(h, fake, start + 70 * MIN);
  assert.deepEqual(early.checked, [row.meetingId], 'the fragment does not count as the meeting\'s recording');
  assert.equal(row.recording.state, 'ended', 'nothing is decided before the deadline');
  assert.match(row.recording.message, /bare et veldig kort opptak/);
  assert.doesNotMatch(row.recording.message, /funnet og koblet/);
  assert.deepEqual(early.linked, []);
  assert.deepEqual(h.linked, [], 'already on the card: not linked again');
  assert.equal(watchdog.missingRecordingRows([client], { nowMs: start + 70 * MIN }).count, 0, 'not listed before its deadline');

  const due = await run(h, fake, start + 151 * MIN);
  assert.equal(row.recording.state, 'empty');
  assert.equal(row.recording.ffMeetingId, 'FFHALLO1');
  assert.match(row.recording.message, /ingen tale, eller for kort/);
  assert.deepEqual(due.empty, [row.meetingId]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].subject, `Fireflies: tomt opptak av salgsmøtet med ${client.businessName}`);
  assert.deepEqual(watchdog.missingRecordingRows([client], { nowMs: start + 152 * MIN }).rows.map((entry) => entry.state), ['empty']);

  await run(h, fake, start + 215 * MIN);
  assert.equal(row.recording.state, 'empty');
  assert.equal(h.sent.length, 1, 'one e-mail');
  assert.deepEqual(h.linked, []);
});

test('a finished recording with only a few sentences is linked for the rep to see, but the meeting still turns empty', async () => {
  const start = Date.parse('2026-10-24T12:00:00.000Z');
  const client = booking(start, { state: 'ended' });
  const [row] = client.meetings;
  const h = hub([client]);
  const linked = [];
  // The real link keeps a placeholder a fragment does not cover.
  h.deps.linkTranscript = (clientId, record) => {
    linked.push(record.meetingId);
    client.meetings.push({ meetingId: record.meetingId, meetLink: record.meetingLink, startedAt: record.startedAt, hasTranscript: true, sentenceCount: 3 });
    return client;
  };
  const fake = fireflies({
    list: [{ id: 'FFSHORT1', title: 'Opptak', dateString: iso(start + MIN), meeting_link: row.meetLink }],
    transcripts: { FFSHORT1: answer('FFSHORT1', { start, meet: row.meetLink, sentences: 3 }) },
  });
  const early = await run(h, fake, start + 62 * MIN);
  assert.deepEqual(linked, ['FFSHORT1'], 'on the card');
  assert.deepEqual(early.linked, [], 'but not the meeting\'s recording');
  assert.equal(row.recording.state, 'ended');
  assert.match(row.recording.message, /bare et veldig kort opptak/);
  assert.equal(h.sent.length, 0);

  await run(h, fake, start + 151 * MIN);
  assert.equal(row.recording.state, 'empty');
  assert.equal(row.recording.ffMeetingId, 'FFSHORT1');
  assert.equal(h.sent.length, 1);
  await run(h, fake, start + 215 * MIN);
  assert.deepEqual(linked, ['FFSHORT1'], 'linked once');
  assert.equal(h.sent.length, 1, 'one e-mail');
});

test('a recording a person said is not this client\'s, or pinned to another client, is never found or offered', async () => {
  const start = Date.parse('2026-10-24T14:00:00.000Z');
  const client = booking(start);
  const other = booking(start + 6 * 60 * MIN);
  const [row] = client.meetings;
  storeAnswer('FFNOTME1', { start, meet: row.meetLink }, start + 30 * MIN);
  ff.setStoredFirefliesClientLink('FFNOTME1', { exclude: client.id }, { nowMs: start + 40 * MIN });
  storeAnswer('FFPINNED', { start: start + 2 * MIN, meet: row.meetLink }, start + 30 * MIN);
  ff.setStoredFirefliesClientLink('FFPINNED', { pin: { clientId: other.id, linkedBy: 'admin:ansatt', at: iso(start + 40 * MIN) } }, { nowMs: start + 40 * MIN });
  const h = hub([client, other]);
  const fake = fireflies({
    list: [
      { id: 'FFNOTME1', title: row.title, dateString: iso(start + MIN), meeting_link: row.meetLink, transcript_url: 'https://app.fireflies.ai/view/FFNOTME1' },
      { id: 'FFPINNED', title: row.title, dateString: iso(start + 3 * MIN), meeting_link: row.meetLink, transcript_url: 'https://app.fireflies.ai/view/FFPINNED' },
    ],
  });
  const result = await run(h, fake, start + 151 * MIN);
  assert.ok(result.checked.includes(row.meetingId));
  assert.deepEqual(h.linked, []);
  assert.equal(row.recording.state, 'missing');
  assert.doesNotMatch(row.recording.message, /FFNOTME1|FFPINNED/);
  const mail = h.sent.find((message) => message.subject.endsWith(client.businessName));
  assert.ok(mail);
  assert.doesNotMatch(mail.text, /FFNOTME1|FFPINNED/, 'neither is offered as a candidate');
});

test('a link the hub refuses is not a link: no "funnet og koblet", and a missing meeting stays missing', async () => {
  const start = Date.parse('2026-10-24T16:00:00.000Z');
  const client = booking(start, { state: 'missing', missingAt: iso(start + 150 * MIN), alertedAt: iso(start + 150 * MIN), message: 'Ingen Fireflies-opptak etter møtet.' });
  const [row] = client.meetings;
  const h = hub([client]);
  const tried = [];
  h.deps.linkTranscript = (clientId, record) => {
    tried.push(record.meetingId);
    return null;
  };
  const fake = fireflies({
    list: [{ id: 'FFREFUSE', title: 'Opptak', dateString: iso(start + MIN), meeting_link: row.meetLink }],
    transcripts: { FFREFUSE: answer('FFREFUSE', { start, meet: row.meetLink }) },
  });
  const result = await run(h, fake, start + 215 * MIN);
  assert.deepEqual(tried, ['FFREFUSE']);
  assert.deepEqual(result.linked, []);
  assert.equal(row.recording.state, 'missing');
  assert.doesNotMatch(row.recording.message, /funnet og koblet/);
  assert.equal(h.sent.length, 0, 'already reported once');
});

test('a recording of the next booked meeting in the same room is that meeting\'s: offered here, found there', async () => {
  const start = Date.parse('2026-10-25T10:00:00.000Z');
  const room = 'https://meet.google.com/abc-2001-hij';
  const clientId = 'c-shared-room';
  const next = start + 60 * MIN;
  const stub = (meetingId, slotKey, at, purpose) => ({
    meetingId,
    title: 'Testfirma Delt AS · Kari Test',
    startedAt: iso(at),
    meetLink: room,
    hasTranscript: false,
    linkedBy: 'live-join',
    purpose,
    forSalesMeeting: purpose === 'sales',
    slotKey,
    recording: mergeRecordingState(null, { state: 'ended', dispatchedAt: iso(at - 2 * MIN) }),
  });
  const sales = stub(`live:${clientId}:${start}`, `sales:${start}`, start, 'sales');
  const followUp = stub(`live:${clientId}:act-next:${next}`, 'action:act-next', next, '');
  const client = {
    id: clientId,
    businessName: 'Testfirma Delt AS',
    ownerId: 'sales:rep-1',
    agreedTime: true,
    meetingAt: iso(start),
    meetingMode: 'online',
    calendar: { meetLink: room },
    nextActions: [{ id: 'act-next', presetKey: 'custom', goalKey: 'offerSent', name: 'Oppfølging', format: 'mote', addToCalendar: true, dueAt: iso(next), meetLink: room }],
    meetings: [sales, followUp],
  };
  // The follow-up started two minutes early, inside the sales meeting's hour too.
  const fake = fireflies({
    list: [{ id: 'FFNEXT02', title: 'Opptak', dateString: iso(next - 2 * MIN), meeting_link: room, transcript_url: 'https://app.fireflies.ai/view/FFNEXT02' }],
    transcripts: { FFNEXT02: answer('FFNEXT02', { start: next - 3 * MIN, meet: room }) },
  });
  const lookup = fake.lookupWith(next + 70 * MIN);
  const forSales = await lookup(sales, client, [client]);
  assert.equal(forSales.found, null, 'the card would put it on the follow-up, so it is not the sales meeting\'s recording');
  assert.deepEqual(forSales.candidates.map((row) => [row.meetingId, row.why]), [['FFNEXT02', 'room']]);
  const forFollowUp = await lookup(followUp, client, [client]);
  assert.equal(forFollowUp.found?.meetingId, 'FFNEXT02');
});

test('what lands while the lookup waits on Fireflies wins: a rep\'s "uten opptak", the recording linked, another pass\'s e-mail', async () => {
  const start = Date.parse('2026-10-24T10:00:00.000Z');
  const nowMs = start + 160 * MIN;
  const empty = fireflies({ list: [] });
  // The rep marks the meeting "uten opptak" while the lookup is out.
  const marked = booking(start);
  const h1 = hub([marked]);
  await watchdog.runFirefliesRecordingWatchdog({
    ...h1.deps,
    apiKey: 'fake-key',
    nowMs,
    log: quiet,
    lookup: async (placeholder, client, clients) => {
      const decided = watchdog.declinedRecordingPatch(placeholder, { by: 'Kari Test', nowMs });
      h1.deps.patchPlaceholder(client.id, placeholder.meetingId, decided.recording);
      return empty.lookupWith(nowMs)(placeholder, client, clients);
    },
  });
  assert.equal(marked.meetings[0].recording.state, 'declined', 'the rep\'s mark stands');
  assert.equal(h1.sent.length, 0);
  assert.equal(watchdog.missingRecordingRows([marked], { nowMs }).count, 0);

  // The recording is linked (the placeholder dropped) while the lookup is out.
  const linked = booking(start);
  const h2 = hub([linked]);
  await watchdog.runFirefliesRecordingWatchdog({
    ...h2.deps,
    apiKey: 'fake-key',
    nowMs,
    log: quiet,
    lookup: async (placeholder, client, clients) => {
      linked.meetings = [{ meetingId: 'FFLATE09', meetLink: placeholder.meetLink, startedAt: iso(start + MIN), hasTranscript: true }];
      return empty.lookupWith(nowMs)(placeholder, client, clients);
    },
  });
  assert.equal(h2.sent.length, 0, 'no e-mail for a meeting whose recording is in');

  // Another hub process sent the e-mail while this one waited for the addresses.
  const told = booking(start);
  const h3 = hub([told]);
  await watchdog.runFirefliesRecordingWatchdog({
    ...h3.deps,
    apiKey: 'fake-key',
    nowMs,
    log: quiet,
    lookup: empty.lookupWith(nowMs),
    recipientsFor: async () => {
      h3.deps.patchPlaceholder(told.id, told.meetings[0].meetingId, { alertedAt: iso(nowMs) });
      return ['ansatte@asoldi.com'];
    },
  });
  assert.equal(told.meetings[0].recording.state, 'missing');
  assert.equal(h3.sent.length, 0, 'one e-mail across both');
});
