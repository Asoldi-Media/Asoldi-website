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
    lookupWith: (nowMs) => (placeholder) => watchdog.lookupPlaceholderTranscript(placeholder, {
      apiKey: 'fake-key',
      nowMs,
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

function answer(id, { start, meet, status = 'processed', talk = true }) {
  return {
    id,
    title: 'Opptak',
    dateString: iso(start + MIN),
    duration: 45,
    meeting_link: meet,
    is_live: false,
    meeting_info: { summary_status: status, silent_meeting: !talk },
    sentences: talk ? [{ speaker_name: 'Kari Test', text: 'Vi vil ha en ny nettside.' }] : [],
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
  assert.equal(watchdog.planPlaceholderCheck({ ...row, recording: { state: 'empty' } }, { nowMs: start + 200 * MIN }).reason, 'done');
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

test('a finished silent recording on the room sets empty, and a processing one keeps it waiting', async () => {
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
  assert.equal(processing.meetings[0].recording.state, 'dispatched', 'Fireflies is still working: not missing');
  assert.equal(h.sent.length, 0);
  const again = await run(h, fake, start + 400 * MIN);
  assert.equal(again.checked.includes(silent.meetings[0].meetingId), false, 'empty is final');
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
