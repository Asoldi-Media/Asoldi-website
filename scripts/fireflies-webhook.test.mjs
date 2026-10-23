import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-fireflies-webhook-'));
process.env.APP_DATA_DIR = dataDir;

const {
  addFirefliesToLiveMeeting,
  authorizeFirefliesWebhook,
  buildFirefliesMeetingRecord,
  buildFirefliesNotifyEmail,
  eventFromPayload,
  fetchActiveFirefliesMeetings,
  fetchFirefliesKeyOwnerEmail,
  fetchFirefliesTranscript,
  fetchFirefliesTranscriptPresence,
  firefliesLiveJoinDuration,
  formatFirefliesActionItems,
  formatFirefliesTranscript,
  isFirefliesBotJoinedEvent,
  isFirefliesTranscriptReadyEvent,
  meetingIdFromPayload,
  mergeStoredFirefliesRecord,
  notifyFirefliesRecording,
  readStoredFirefliesMeeting,
  storeFirefliesMeeting,
  storedMeetingsNeedingHydration,
  verifyFirefliesSignature,
} = await import('../lib/fireflies-webhook.js');
const {
  applyLiveJoinAttempt,
  collectLiveSessions,
  planLiveSessionTick,
  syncLiveSessions,
} = await import('../lib/fireflies-live-sessions.js');
const { resetFirefliesGraphqlStateForTests } = await import('../lib/fireflies-graphql.js');
import {
  firefliesMeetLinksDiffer,
  shouldDropLiveJoinStub,
} from '../lib/fireflies-client-match.js';
import { sessionKeyFor } from '../lib/fireflies-recording-state.js';
import { readFileSync } from 'node:fs';

function liveClient(meetingAt, meetLink = 'https://meet.google.com/abc-defg-hij') {
  return {
    id: 'live-client',
    businessName: 'Testfirma AS',
    contactPerson: 'Kari Test',
    meetingMode: 'online',
    agreedTime: true,
    meetingAt,
    calendar: { meetLink, confirmedMeetLink: meetLink },
    nextActions: [],
    meetings: [],
  };
}

function liveSession(meetingAt, nowMs) {
  const facts = collectLiveSessions([liveClient(meetingAt)], nowMs);
  return syncLiveSessions({}, facts, { nowMs })[facts[0].key];
}

function liveDispatches(session, nowMs, activeMeetings = []) {
  return planLiveSessionTick({ sessions: [session], activeMeetings, nowMs }).actions
    .filter((action) => action.type === 'dispatch');
}

const TRANSCRIPT = {
  id: 'ASxwZxCstx',
  title: 'Asoldi møte med Testbedrift',
  dateString: '2026-03-01T16:01:12Z',
  duration: 42,
  transcript_url: 'https://app.fireflies.ai/view/ASxwZxCstx',
  video_url: 'https://cdn.fireflies.ai/video/ASxwZxCstx.mp4',
  organizer_email: 'alexander@asoldi.com',
  user: { name: 'Alexander', email: 'alexander@asoldi.com' },
  meeting_attendees: [{ name: 'Kunde', email: 'kunde@example.com' }],
  sentences: [
    { speaker_name: 'Alexander', text: 'Hei, takk for møtet.' },
    { speaker_name: 'Kunde', text: 'Takk selv.' },
  ],
  summary: {
    overview: 'Vi gikk gjennom nettsiden.',
    action_items: '- Send tilbud\n- Book oppfølging',
  },
};

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test('V1 and V2 Fireflies payloads expose the meeting id', () => {
  assert.equal(meetingIdFromPayload({ meetingId: 'ASxwZxCstx', eventType: 'Transcription completed' }), 'ASxwZxCstx');
  assert.equal(meetingIdFromPayload({ meeting_id: 'ASxwZxCstx', event: 'meeting.summarized' }), 'ASxwZxCstx');
  assert.equal(eventFromPayload({ event: 'meeting.transcribed' }), 'meeting.transcribed');
  assert.equal(isFirefliesTranscriptReadyEvent('meeting.bot_joined'), false);
  assert.equal(isFirefliesTranscriptReadyEvent('meeting.summarized'), true);
  assert.equal(isFirefliesTranscriptReadyEvent('Transcription completed'), true);
});

test('email includes a video link, not a video file, plus transcript attachment', () => {
  const record = buildFirefliesMeetingRecord({ event: 'meeting.summarized' }, TRANSCRIPT);
  const email = buildFirefliesNotifyEmail(record, 'ansatte@asoldi.com');
  assert.equal(email.to, 'ansatte@asoldi.com');
  assert.equal(email.videoUrl, 'https://app.fireflies.ai/view/ASxwZxCstx');
  assert.match(email.text, /Video: https:\/\/app\.fireflies\.ai\/view\/ASxwZxCstx/);
  assert.match(email.html, /href="https:\/\/app\.fireflies\.ai\/view\/ASxwZxCstx"/);
  assert.match(email.html, /Åpne video/);
  assert.match(email.subject, /^Fireflies:/);
  assert.equal(email.attachments.length, 1);
  assert.equal(email.attachments[0].filename, 'fireflies-transcript-ASxwZxCstx.txt');
  assert.equal(email.attachments.some((item) => /\.(mp4|webm|mov)$/i.test(item.filename || '')), false);
  assert.deepEqual(record.actionItems, ['Send tilbud', 'Book oppfølging']);
});

test('transcript lines keep speaker names', () => {
  assert.equal(
    formatFirefliesTranscript(TRANSCRIPT),
    'Alexander: Hei, takk for møtet.\nKunde: Takk selv.'
  );
});

test('action items accept a markdown string or a list', () => {
  assert.deepEqual(
    formatFirefliesActionItems({ summary: { action_items: '- Send tilbud\n- Book oppfølging' } }),
    ['Send tilbud', 'Book oppfølging']
  );
  assert.deepEqual(
    formatFirefliesActionItems({ action_items: [{ text: 'Send tilbud' }] }),
    ['Send tilbud']
  );
});

test('webhook token in the URL is enough to authorize', () => {
  const config = { token: 'team-token', secrets: [], apiKey: 'ff-key', notifyEmail: 'ansatte@asoldi.com' };
  const ok = authorizeFirefliesWebhook({ query: { token: 'team-token' }, headers: {}, rawBody: '{}' }, config);
  const bad = authorizeFirefliesWebhook({ query: { token: 'nope' }, headers: {}, rawBody: '{}' }, config);
  assert.deepEqual(ok, { ok: true, via: 'token' });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
});

test('Fireflies X-Hub-Signature verifies', () => {
  const secret = 'fireflies-test-signing-secret';
  const rawBody = '{"meeting_id":"ASxwZxCstx","event":"meeting.transcribed"}';
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const headers = { 'x-hub-signature': `sha256=${digest}` };
  assert.equal(verifyFirefliesSignature(secret, headers, rawBody), true);
  const authorized = authorizeFirefliesWebhook({ headers, query: {}, rawBody }, {
    token: '',
    secrets: [secret],
    apiKey: 'ff-key',
    notifyEmail: 'ansatte@asoldi.com',
  });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.via, 'signature');
});

test('GraphQL fetch asks Fireflies for video and transcript fields', async () => {
  let captured;
  const transcript = await fetchFirefliesTranscript('ASxwZxCstx', {
    apiKey: 'ff-key',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        json: async () => ({ data: { transcript: TRANSCRIPT } }),
      };
    },
  });
  assert.equal(captured.url, 'https://api.fireflies.ai/graphql');
  const body = JSON.parse(captured.options.body);
  assert.equal(body.variables.transcriptId, 'ASxwZxCstx');
  assert.match(body.query, /video_url/);
  assert.match(body.query, /sentences/);
  assert.equal(captured.options.headers.Authorization, 'Bearer ff-key');
  assert.equal(transcript.title, 'Asoldi møte med Testbedrift');
});

test('already-notified webhook updates the client when the transcript arrives later', async () => {
  const linked = [];
  const payload = { meeting_id: 'late-talk', event: 'meeting.transcribed' };
  const config = { token: 'team-token', secrets: [], apiKey: 'ff-key', notifyEmail: 'ansatte@asoldi.com' };
  const match = { best: { clientId: 'c-late', businessName: 'Late AS' }, candidates: [] };
  await notifyFirefliesRecording(payload, config, {
    fetchTranscript: async () => ({ id: 'late-talk', title: 'Møte', sentences: [] }),
    sendEmail: async () => {},
    matchClients: async () => match,
    linkMeeting: async (clientId, ref) => { linked.push({ clientId, hasTranscript: Boolean(ref.hasTranscript) }); },
  });
  await notifyFirefliesRecording({ meeting_id: 'late-talk', event: 'meeting.summarized' }, config, {
    fetchTranscript: async () => TRANSCRIPT,
    sendEmail: async () => {},
    matchClients: async () => match,
    linkMeeting: async (clientId, ref) => { linked.push({ clientId, hasTranscript: Boolean(ref.hasTranscript) }); },
  });
  assert.equal(linked[0].hasTranscript, false);
  assert.equal(linked.at(-1).clientId, 'c-late');
  assert.equal(linked.at(-1).hasTranscript, true);
});

test('notify emails once and returns video + transcript for downstream scripts', async () => {
  const sent = [];
  const payload = { meeting_id: 'ASxwZxCstx', event: 'meeting.summarized' };
  const config = { token: 'team-token', secrets: [], apiKey: 'ff-key', notifyEmail: 'ansatte@asoldi.com' };
  const first = await notifyFirefliesRecording(payload, config, {
    fetchTranscript: async () => TRANSCRIPT,
    sendEmail: async (message) => { sent.push(message); },
  });
  const second = await notifyFirefliesRecording(payload, config, {
    fetchTranscript: async () => TRANSCRIPT,
    sendEmail: async (message) => { sent.push(message); },
  });
  assert.equal(first.sent, true);
  assert.equal(first.videoUrl, 'https://app.fireflies.ai/view/ASxwZxCstx');
  assert.match(first.transcript, /Alexander: Hei, takk for møtet/);
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'already-notified');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ansatte@asoldi.com');
});

test('bot-joined events are ignored', async () => {
  const result = await notifyFirefliesRecording(
    { meeting_id: 'ASxwZxCstx', event: 'meeting.bot_joined' },
    { token: 'team-token', secrets: [], apiKey: 'ff-key', notifyEmail: 'ansatte@asoldi.com' },
    { sendEmail: async () => { throw new Error('should not email'); } }
  );
  assert.deepEqual(result, {
    sent: false,
    reason: 'ignored-event',
    event: 'meeting.bot_joined',
    meetingId: 'ASxwZxCstx',
  });
});

test('the bot_joined pre-hook never keeps the webhook from answering, and a bad record never fails a card', () => {
  const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const hook = serverSrc.slice(serverSrc.indexOf('async function noteFirefliesBotJoinedWebhook'));
  const body = hook.slice(0, hook.search(/\r?\n\}\r?\n/));
  // A body of `null` parses fine but has no fields: it must not throw before the notify path's own try.
  assert.match(body, /if \(!payload \|\| typeof payload !== 'object'\) return;/);
  const tryAt = body.indexOf('try {');
  assert.ok(tryAt > 0 && tryAt < body.indexOf('eventFromPayload(payload)'), 'the event is read inside the try');
  assert.ok(tryAt < body.indexOf('meetingIdFromPayload(payload)'));
  const handler = serverSrc.slice(serverSrc.indexOf('async function handleFirefliesWebhook'));
  assert.ok(handler.indexOf('await noteFirefliesBotJoinedWebhook(payload)') < handler.indexOf('notifyFirefliesRecording('));
  // jsonSalesClient builds liveRecordings behind a try, so one malformed client cannot fail the sales list.
  assert.match(serverSrc, /liveRecordings: liveRecordingsForClient\(client\)/);
  const cardFn = serverSrc.slice(serverSrc.indexOf('function liveRecordingsForClient'), serverSrc.indexOf('function jsonSalesClient'));
  assert.match(cardFn, /try \{[^]*presentLiveRecordings\([^]*\} catch/);
});

test('live join goes in from 3 minutes before start and, if never sent, stops 30 minutes after', () => {
  // The per-slot window moved into the session planner (lib/fireflies-live-sessions.js).
  const meetingAt = '2026-09-26T10:00:00.000Z';
  const start = Date.parse(meetingAt);
  const session = liveSession(meetingAt, start - (60 * 60 * 1000));
  assert.equal(liveDispatches(session, start - (3 * 60 * 1000) - 1).length, 0);
  assert.deepEqual(liveDispatches(session, start - (3 * 60 * 1000)).map((row) => row.kind), ['first']);
  assert.equal(liveDispatches(session, start + (30 * 60 * 1000)).length, 1);
  assert.equal(liveDispatches(session, start + (30 * 60 * 1000) + 1).length, 0);
});

test('live join is per Meet room and start: a room swap or a new time is a new session', () => {
  const oldMeet = 'https://meet.google.com/abc-defg-hij';
  const newMeet = 'https://meet.google.com/bcd-efgh-ijk';
  const at = '2026-10-08T13:00:00.000Z';
  assert.notEqual(sessionKeyFor(oldMeet, at), sessionKeyFor(newMeet, at));
  assert.notEqual(sessionKeyFor(oldMeet, at), sessionKeyFor(oldMeet, '2026-10-08T13:30:00.000Z'));
  assert.equal(sessionKeyFor(oldMeet, at), sessionKeyFor(`${oldMeet}?authuser=0`, at));
  assert.equal(firefliesMeetLinksDiffer(oldMeet, newMeet), true);
  assert.equal(firefliesMeetLinksDiffer(oldMeet, `${oldMeet}?authuser=0`), false);
  const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  // The stamps now mean "last accepted dispatch" and start clean for a new room or time.
  assert.match(serverSrc, /firefliesLiveJoinedMeetLink/);
  assert.match(serverSrc, /meetLinkChanged \|\| calendarMeta\.replacedForeignMeet \|\| startChanged/);
  assert.equal(serverSrc.includes('firefliesJoinedCurrentMeet('), false, 'an accepted dispatch no longer blocks later sends');
  assert.equal(serverSrc.includes('firefliesNeedsFreshMeetOnReschedule('), false);
  assert.equal(serverSrc.includes('sanitizeText(previousClient?.meetingAt) !== sanitizeText(nextClient?.meetingAt)'), false);
});

test('a moved meeting keeps its room and is joined again at the new time', () => {
  const meet = 'https://meet.google.com/abc-defg-hij';
  const before = collectLiveSessions([liveClient('2026-10-15T15:00:00.000Z', meet)], Date.parse('2026-10-15T14:00:00.000Z'));
  const after = collectLiveSessions([liveClient('2026-10-15T15:30:00.000Z', meet)], Date.parse('2026-10-15T14:00:00.000Z'));
  assert.equal(after[0].meetLink, before[0].meetLink);
  assert.notEqual(after[0].key, before[0].key);
  // The bot went into the 15:00 session; the 15:30 session is still sent in at 15:27.
  const moved = syncLiveSessions({ [before[0].key]: applyLiveJoinAttempt(syncLiveSessions({}, before, {})[before[0].key], {
    at: '2026-10-15T14:57:00.000Z',
    kind: 'first',
    ok: true,
  }) }, after, { nowMs: Date.parse('2026-10-15T15:05:00.000Z') });
  const next = moved[after[0].key];
  assert.equal(liveDispatches(next, Date.parse('2026-10-15T15:27:00.000Z')).length, 1);
  const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const syncFn = serverSrc.slice(serverSrc.indexOf('async function maybeSyncCalendar'), serverSrc.indexOf('async function maybeSyncNextActionCalendars'));
  assert.equal(syncFn.includes('forceNewMeet'), false, 'no fresh room just because the bot had been sent');
  const workshopSrc = readFileSync(new URL('../lib/workshop-action.js', import.meta.url), 'utf8');
  assert.equal(workshopSrc.includes('forceNewMeet'), false);
});

test('live stubs drop when the real recording is on any owned Meet', () => {
  const oldMeet = 'https://meet.google.com/idy-uiyh-efh';
  const newMeet = 'https://meet.google.com/uss-ynky-nfw';
  const stub = {
    meetingId: 'live:gx1r5f:open',
    meetLink: oldMeet,
    linkedBy: 'live-join',
    forSalesMeeting: true,
    purpose: 'sales',
  };
  assert.equal(shouldDropLiveJoinStub({
    stub,
    recordingMeetLink: newMeet,
    ownedMeetLinks: [oldMeet, newMeet],
    recordingPurpose: 'sales',
  }), true);
  assert.equal(shouldDropLiveJoinStub({
    stub: { ...stub, purpose: 'workshop', forSalesMeeting: false },
    recordingMeetLink: newMeet,
    ownedMeetLinks: [oldMeet, newMeet],
    recordingPurpose: 'sales',
  }), false);
  assert.equal(shouldDropLiveJoinStub({
    stub,
    recordingMeetLink: newMeet,
    ownedMeetLinks: [oldMeet, newMeet],
    keepMeetingId: stub.meetingId,
    recordingPurpose: 'sales',
  }), false);
});

test('recent Fireflies rows without a Meet link still need a full fetch', () => {
  const now = Date.parse('2026-10-09T12:30:00.000Z');
  const rows = storedMeetingsNeedingHydration([
    {
      meetingId: 'ff-new',
      title: 'Kaperdal',
      startedAt: '2026-10-09T12:05:00.000Z',
      meetingLink: '',
      transcript: '',
    },
    {
      meetingId: 'live:skip',
      startedAt: '2026-10-09T12:05:00.000Z',
    },
    {
      meetingId: 'ff-old',
      startedAt: '2026-10-01T12:05:00.000Z',
      meetingLink: '',
    },
    {
      meetingId: 'ff-ready',
      startedAt: '2026-10-09T11:00:00.000Z',
      meetingLink: 'https://meet.google.com/nxn-gmfc-roz',
      transcript: 'Kunde: hei',
    },
  ], { nowMs: now });
  assert.deepEqual(rows.map((row) => row.meetingId), ['ff-new']);
});

test('a bot never seen in the room is sent again at T+1, then T+5 (after a look at the room)', () => {
  // The old per-slot 6-minute wait is gone: the session planner owns the schedule and the account limiter.
  const meetingAt = '2026-09-26T10:00:00.000Z';
  const start = Date.parse(meetingAt);
  const sent = applyLiveJoinAttempt(liveSession(meetingAt, start - (60 * 60 * 1000)), {
    at: new Date(start - (3 * 60 * 1000)).toISOString(),
    kind: 'first',
    ok: true,
  });
  assert.equal(liveDispatches(sent, start).length, 0);
  assert.deepEqual(liveDispatches(sent, start + (60 * 1000)).map((row) => row.kind), ['retry']);
  assert.equal(liveDispatches(sent, start + (60 * 1000), null).length, 0, 'no second bot without a fresh look');
});

function liveReply(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

test('addToLiveMeeting posts the Meet link with duration 120 and no language', async () => {
  resetFirefliesGraphqlStateForTests();
  let captured;
  const result = await addFirefliesToLiveMeeting({
    meetingLink: 'https://meet.google.com/abc-defg-hij',
    title: 'Asoldi · Online møte · Test',
    apiKey: 'ff-key',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return liveReply({ data: { addToLiveMeeting: { success: true, message: 'ok' } } });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://api.fireflies.ai/graphql');
  const body = JSON.parse(captured.options.body);
  assert.match(body.query, /addToLiveMeeting\(meeting_link: \$meetingLink, title: \$title, duration: \$duration\)/);
  assert.equal(body.variables.meetingLink, 'https://meet.google.com/abc-defg-hij');
  assert.equal(body.variables.duration, 120);
  assert.equal('language' in body.variables, false);
  assert.doesNotMatch(body.query, /language/);
  assert.equal(captured.options.headers.Authorization, 'Bearer ff-key');
  // Never above Fireflies' documented maximum, never under its minimum.
  assert.equal(firefliesLiveJoinDuration(150), 120);
  assert.equal(firefliesLiveJoinDuration(5), 15);
  assert.equal(firefliesLiveJoinDuration(59), 59);
  assert.equal(firefliesLiveJoinDuration(undefined), 120);
});

test('addToLiveMeeting counts only an explicit success and keeps Fireflies\' error code', async () => {
  resetFirefliesGraphqlStateForTests();
  const empty = await addFirefliesToLiveMeeting({
    meetingLink: 'https://meet.google.com/abc-defg-hij',
    apiKey: 'ff-key',
    fetchImpl: async () => liveReply({ data: { addToLiveMeeting: null } }),
  });
  assert.equal(empty.ok, false);
  const exceeded = await addFirefliesToLiveMeeting({
    meetingLink: 'https://meet.google.com/abc-defg-hij',
    apiKey: 'ff-key',
    fetchImpl: async () => liveReply({ data: { addToLiveMeeting: { success: true, message: 'Limit exceeded' } } }),
  });
  assert.equal(exceeded.ok, false);
  await assert.rejects(
    () => addFirefliesToLiveMeeting({
      meetingLink: 'https://meet.google.com/abc-defg-hij',
      apiKey: 'ff-key',
      fetchImpl: async () => liveReply({ data: null, errors: [{ message: 'The meeting platform is not supported.', code: 'unsupported_platform' }] }),
    }),
    (error) => error.code === 'unsupported_platform',
  );
});

test('active_meetings is read on the live lane and parsed by room', async () => {
  resetFirefliesGraphqlStateForTests();
  let body;
  const rows = await fetchActiveFirefliesMeetings({
    apiKey: 'ff-key',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return liveReply({
        data: {
          active_meetings: [
            {
              id: 'ff-active-1',
              title: 'Testfirma AS · Kari Test',
              organizer_email: 'Damian@Asoldi.com',
              meeting_link: 'https://meet.google.com/abc-defg-hij',
              start_time: '2026-10-23T09:57:02.000Z',
              end_time: '2026-10-23T11:57:02.000Z',
              state: 'active',
            },
            { id: 'no-link', meeting_link: '', state: 'paused' },
            null,
          ],
        },
      });
    },
  });
  assert.match(body.query, /active_meetings\(input: \{ states: \[active, paused\] \}\)/);
  assert.deepEqual(rows, [{
    id: 'ff-active-1',
    title: 'Testfirma AS · Kari Test',
    organizerEmail: 'damian@asoldi.com',
    meetingLink: 'https://meet.google.com/abc-defg-hij',
    startTime: '2026-10-23T09:57:02.000Z',
    endTime: '2026-10-23T11:57:02.000Z',
    state: 'active',
  }]);
  await assert.rejects(
    () => fetchActiveFirefliesMeetings({ apiKey: 'ff-key', fetchImpl: async () => liveReply({ data: null, errors: [{ message: 'nope' }] }) }),
    /nope/,
  );
});

test('a bot_joined event resolves its room with one cheap read; the key owner is one more', async () => {
  resetFirefliesGraphqlStateForTests();
  assert.equal(isFirefliesBotJoinedEvent('meeting.bot_joined'), true);
  assert.equal(isFirefliesBotJoinedEvent('bot_joined'), true);
  assert.equal(isFirefliesBotJoinedEvent('meeting.transcribed'), false);
  let query = '';
  const presence = await fetchFirefliesTranscriptPresence('ff-active-1', {
    apiKey: 'ff-key',
    fetchImpl: async (_url, options) => {
      query = JSON.parse(options.body).query;
      return liveReply({ data: { transcript: { id: 'ff-active-1', meeting_link: 'https://meet.google.com/abc-defg-hij', is_live: true } } });
    },
  });
  assert.match(query, /meeting_link/);
  assert.doesNotMatch(query, /sentences/);
  assert.deepEqual(presence, { id: 'ff-active-1', meetingLink: 'https://meet.google.com/abc-defg-hij', isLive: true });
  const owner = await fetchFirefliesKeyOwnerEmail({
    apiKey: 'ff-key',
    fetchImpl: async () => liveReply({ data: { user: { email: 'Damian@asoldi.com' } } }),
  });
  assert.equal(owner, 'damian@asoldi.com');
});

test('storing a metadata-only Fireflies row does not wipe an existing transcript', () => {
  const merged = mergeStoredFirefliesRecord(
    { meetingId: 'ff-1', transcript: 'Alexander: Hei.', summary: 'Vi avtalte tilbud.' },
    { meetingId: 'ff-1', title: 'Muldvarpen', transcript: '', summary: '', meetingLink: 'https://meet.google.com/aaa-bbbb-ccc' },
  );
  assert.equal(merged.transcript, 'Alexander: Hei.');
  assert.equal(merged.summary, 'Vi avtalte tilbud.');
  assert.equal(merged.title, 'Muldvarpen');
  storeFirefliesMeeting({ meetingId: 'ff-keep', transcript: 'Kunde: Vi trenger nettside.', summary: 'Nettside.' });
  storeFirefliesMeeting({ meetingId: 'ff-keep', title: 'Senere metadata', transcript: '', summary: '' });
  const stored = readStoredFirefliesMeeting('ff-keep');
  assert.equal(stored.transcript, 'Kunde: Vi trenger nettside.');
  assert.equal(stored.title, 'Senere metadata');
});
