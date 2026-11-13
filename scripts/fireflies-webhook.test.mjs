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
import { firefliesMeetLinksDiffer } from '../lib/fireflies-client-match.js';
import { meetingSlotFacts, placeholderSupersededBy } from '../lib/fireflies-slots.js';
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
  is_live: false,
  meeting_info: { summary_status: 'processed', silent_meeting: false },
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

// Was: any real recording on any owned Meet dropped every stub of a compatible purpose. Now only a
// recording with talk on the stub's own slot (room + session window) does; the reschedule case stays.
test('a live stub is covered only by a recording with talk on its own slot, also after a fresh room', () => {
  const oldMeet = 'https://meet.google.com/old-room-abc';
  const newMeet = 'https://meet.google.com/new-room-abc';
  const meetingAt = '2026-10-08T12:00:00.000Z';
  const startMs = Date.parse(meetingAt);
  const stub = {
    meetingId: `live:gx1r5f:${startMs}`,
    meetLink: oldMeet,
    startedAt: meetingAt,
    linkedBy: 'live-join',
    forSalesMeeting: true,
    purpose: 'sales',
    slotKey: `sales:${startMs}`,
  };
  const client = {
    id: 'gx1r5f',
    agreedTime: true,
    meetingAt,
    // The meeting was moved to a fresh room after the bot knocked on the old one.
    calendar: { meetLink: newMeet },
    recordedMeetLinks: [oldMeet, newMeet],
  };
  const recording = { meetingId: 'ff-new', meetLink: newMeet, startedAt: '2026-10-08T12:03:00.000Z', hasTranscript: true };
  const covers = (rows) => placeholderSupersededBy(stub, rows, {
    factsOf: (row) => meetingSlotFacts({ ...client, meetings: [stub, ...rows] }, row),
  });
  assert.equal(covers([recording])?.meetingId, 'ff-new', 'the new-room recording of the same slot covers the old-room stub');
  assert.equal(covers([{ ...recording, hasTranscript: false }]), null, 'a silent copy does not');
  assert.equal(covers([{ ...recording, partial: true }]), null, 'live captions do not');
  assert.equal(covers([{ ...recording, startedAt: '2026-10-09T12:03:00.000Z' }]), null, 'the room on another day does not');
  assert.equal(covers([{ ...recording, meetLink: 'https://meet.google.com/zzz-zzzz-zzz' }]), null, 'a room of no slot does not');
  assert.equal(placeholderSupersededBy({ ...stub, purpose: 'workshop', slotKey: `workshop:${startMs}` }, [recording], {
    factsOf: (row) => meetingSlotFacts({ ...client, meetings: [stub, recording] }, row),
  }), null, 'a sales recording never covers a workshop stub');
  assert.equal(placeholderSupersededBy(stub, [stub]), null, 'a stub never covers itself');
});

// Was: a row with a transcript and a Meet link was never fetched again, so a summary that
// Fireflies finished after the first fetch never arrived. Now only finality decides.
test('only transcripts Fireflies has not finished are fetched again, longest-waiting first', () => {
  const now = Date.parse('2026-10-09T12:30:00.000Z');
  const link = 'https://meet.google.com/abc-defg-hij';
  const rows = storedMeetingsNeedingHydration([
    { meetingId: 'ff-new', title: 'Testfirma AS', startedAt: '2026-10-09T12:05:00.000Z', firstSeenAt: '2026-10-09T12:25:00.000Z', transcript: '' },
    { meetingId: 'live:skip', startedAt: '2026-10-09T12:05:00.000Z' },
    // Talk stored while Fireflies was still writing the summary.
    { meetingId: 'ff-processing', startedAt: '2026-10-09T11:00:00.000Z', firstSeenAt: '2026-10-09T12:00:00.000Z', meetingLink: link, transcript: 'Kari Test: hei', summaryStatus: 'processing' },
    { meetingId: 'ff-processed', startedAt: '2026-10-09T11:00:00.000Z', meetingLink: link, transcript: 'Kari Test: hei', summary: 'Kort.', summaryStatus: 'processed' },
    // Silent: Fireflies finished and there is nothing to fetch, ever.
    { meetingId: 'ff-empty-final', startedAt: '2026-10-09T11:00:00.000Z', meetingLink: link, transcript: '', summaryStatus: 'skipped', silent: true },
    { meetingId: 'ff-waiting', startedAt: '2026-10-09T11:00:00.000Z', summaryStatus: 'processing', fetch: { attempts: 2, nextFetchAt: '2026-10-09T12:40:00.000Z' } },
    { meetingId: 'ff-gave-up', startedAt: '2026-10-01T11:00:00.000Z', summaryStatus: 'processing', fetch: { attempts: 20, gaveUpAt: '2026-10-08T11:00:00.000Z' } },
    // The list showed a new summary_status: one full fetch even past give-up.
    { meetingId: 'ff-queued', startedAt: '2026-10-01T11:00:00.000Z', summaryStatus: 'processing', fetch: { gaveUpAt: '2026-10-08T11:00:00.000Z', queuedAt: '2026-10-09T12:29:00.000Z' } },
    // Stored before the hub kept Fireflies' state. Talk without a summary is the old first fetch
    // during processing: one fetch learns the status (it waited longest). With a summary it is done.
    { meetingId: 'ff-legacy', startedAt: '2026-10-09T11:00:00.000Z', meetingLink: link, transcript: 'Kunde: hei' },
    { meetingId: 'ff-legacy-done', startedAt: '2026-10-09T11:00:00.000Z', meetingLink: link, transcript: 'Kunde: hei', summary: 'Kort.' },
    // Fetched, and Fireflies gave no status: talk that has sat for 30 minutes is final.
    { meetingId: 'ff-no-status', startedAt: '2026-10-09T11:00:00.000Z', fetchedAt: '2026-10-09T11:55:00.000Z', firstSeenAt: '2026-10-09T11:55:00.000Z', transcript: 'Kunde: hei' },
  ], { nowMs: now });
  assert.deepEqual(rows.map((row) => row.meetingId), ['ff-legacy', 'ff-processing', 'ff-new', 'ff-queued']);
});

test('a bot never seen in the room is sent again after the 10-minute lobby wait (after a look at the room)', () => {
  // The old per-slot 6-minute wait is gone: the session planner owns the schedule and the account limiter.
  const meetingAt = '2026-09-26T10:00:00.000Z';
  const start = Date.parse(meetingAt);
  const sent = applyLiveJoinAttempt(liveSession(meetingAt, start - (60 * 60 * 1000)), {
    at: new Date(start - (3 * 60 * 1000)).toISOString(),
    kind: 'first',
    ok: true,
  });
  assert.equal(liveDispatches(sent, start).length, 0);
  assert.deepEqual(liveDispatches(sent, start + (7 * 60 * 1000)).map((row) => row.kind), ['retry']);
  const looked = { ...sent, checkedAt: new Date(start + (6 * 60 * 1000)).toISOString() };
  assert.equal(liveDispatches(looked, start + (7 * 60 * 1000), null).length, 0, 'no second bot without a fresh look');
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
  }, {
    id: 'no-link',
    title: '',
    organizerEmail: '',
    meetingLink: '',
    startTime: '',
    endTime: '',
    state: 'paused',
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
      return liveReply({ data: { transcript: { id: 'ff-active-1', meeting_link: 'https://meet.google.com/abc-defg-hij', is_live: true, dateString: '2026-11-02T09:57:00.000Z' } } });
    },
  });
  assert.match(query, /meeting_link/);
  assert.match(query, /dateString/);
  assert.doesNotMatch(query, /sentences/);
  assert.deepEqual(presence, { id: 'ff-active-1', meetingLink: 'https://meet.google.com/abc-defg-hij', isLive: true, startTime: '2026-11-02T09:57:00.000Z' });
  // A transcript that does not say whether it is live is not called finished.
  const unknown = await fetchFirefliesTranscriptPresence('ff-active-2', {
    apiKey: 'ff-key',
    fetchImpl: async () => liveReply({ data: { transcript: { id: 'ff-active-2', meeting_link: 'https://meet.google.com/abc-defg-hij' } } }),
  });
  assert.equal(unknown.isLive, undefined);
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
// --- Intake: final copies, re-fetch with backoff, one write per tick, notify retries --------------

const ff = await import('../lib/fireflies-webhook.js');
const ffStore = await import('../lib/fireflies-store.js');
const MIN = 60 * 1000;
const T = Date.parse('2026-10-23T12:00:00.000Z');
const MEET = 'https://meet.google.com/abc-defg-hij';
const CONFIG = { token: 'team-token', secrets: [], apiKey: 'ff-key', notifyEmail: 'ansatte@asoldi.com' };

/** A transcript(id) answer for an invented meeting. */
function answer(overrides = {}) {
  return {
    id: 'FF-TEST',
    title: 'Testfirma AS · Kari Test',
    dateString: '2026-10-23T11:00:00.000Z',
    duration: 48.8,
    meeting_link: MEET,
    is_live: false,
    meeting_info: { summary_status: 'processed', silent_meeting: false },
    organizer_email: 'damian@asoldi.com',
    user: { name: 'Damian', email: 'damian@asoldi.com' },
    meeting_attendees: [{ name: 'Kari Test', email: 'kari@firma.no' }],
    sentences: [{ speaker_name: 'Kari Test', text: 'Vi trenger en ny nettside.' }],
    summary: { overview: 'Kunden vil ha ny nettside.', action_items: '- Send tilbud' },
    ...overrides,
  };
}

test('transcript(id) asks for is_live and meeting_info, and the record carries the processing state', async () => {
  let body;
  await ff.fetchFirefliesTranscript('FF-Q', {
    apiKey: 'ff-key',
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ data: { transcript: answer() } }) };
    },
  });
  assert.match(body.query, /is_live/);
  assert.match(body.query, /meeting_info\s*\{\s*summary_status\s+silent_meeting\s*\}/);
  const done = ff.buildFirefliesMeetingRecord({}, answer());
  assert.deepEqual([done.isLive, done.summaryStatus, done.silent, done.sentenceCount, done.final], [false, 'processed', false, 1, true]);
  const live = ff.buildFirefliesMeetingRecord({}, answer({ is_live: true, meeting_info: { summary_status: null }, summary: {} }));
  assert.equal(live.isLive, true);
  assert.equal(live.final, false);
  const bare = ff.buildFirefliesMeetingRecord({ meeting_id: 'FF-BARE' }, { id: 'FF-BARE' });
  assert.equal(bare.final, undefined, 'an answer without the state keeps the stored one');
});

test('live and processing copies are never final; a finished silent one is empty-final', () => {
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(ff.storedMeetingIsFinal({ transcript: 'x', isLive: true, summaryStatus: 'processed' }, { nowMs: T }), false);
  assert.equal(ff.storedMeetingIsFinal({ transcript: 'x', summaryStatus: 'processing' }, { nowMs: T }), false);
  for (const status of ['processed', 'skipped', 'failed']) {
    assert.equal(ff.storedMeetingIsFinal({ summaryStatus: status }, { nowMs: T }), true, status);
  }
  // Fetched talk that Fireflies gave no status for: final 30 minutes after the hub had it.
  assert.equal(ff.storedMeetingIsFinal({ transcript: 'x', fetchedAt: iso(T - 29 * MIN), firstSeenAt: iso(T - 29 * MIN) }, { nowMs: T }), false);
  assert.equal(ff.storedMeetingIsFinal({ transcript: 'x', fetchedAt: iso(T - 31 * MIN), firstSeenAt: iso(T - 31 * MIN) }, { nowMs: T }), true);
  // Stored before the hub kept the state: done only with a summary, else one fetch learns it.
  assert.equal(ff.storedMeetingIsFinal({ transcript: 'x', firstSeenAt: iso(T - 300 * MIN) }, { nowMs: T }), false);
  assert.equal(ff.storedMeetingIsFinal({ transcript: 'x', summary: 'Kort.', firstSeenAt: iso(T - 300 * MIN) }, { nowMs: T }), true);
  assert.equal(ff.storedMeetingIsFinal({ firstSeenAt: iso(T - 300 * MIN) }, { nowMs: T }), false, 'no talk and no status');
  // Live captions kept after the call are never final without Fireflies' word.
  assert.equal(ff.storedMeetingIsFinal({ transcript: 'x', partial: true, isLive: false, fetchedAt: iso(T - 300 * MIN), firstSeenAt: iso(T - 300 * MIN) }, { nowMs: T }), false);
  assert.equal(ff.storedMeetingIsFinal({ transcript: 'x', partial: true, summaryStatus: 'skipped' }, { nowMs: T }), true);
  assert.equal(ff.storedMeetingIsEmptyFinal({ summaryStatus: 'skipped', silent: true }, { nowMs: T }), true);
  assert.equal(ff.storedMeetingIsEmptyFinal({ summaryStatus: 'processed', transcript: 'x' }, { nowMs: T }), false);
});

test('a live or processing copy never replaces finished text, and a list row keeps the metadata it lacks', () => {
  const final = ff.mergeStoredFirefliesRecord({}, ff.buildFirefliesMeetingRecord({ event: 'meeting.summarized' }, answer()), { nowMs: T });
  const listed = ff.mergeStoredFirefliesRecord(final, ff.buildFirefliesListRecord({
    id: 'FF-TEST',
    title: 'Testfirma AS · Kari Test',
    dateString: '2026-10-23T11:00:00.000Z',
    meeting_link: MEET,
    meeting_info: { summary_status: 'processed' },
  }), { nowMs: T });
  for (const key of ['hostEmail', 'recordedBy', 'event', 'startedAt', 'durationMinutes', 'transcript', 'summary', 'attendees']) {
    assert.deepEqual(listed[key], final[key], key);
  }
  const reprocessing = ff.mergeStoredFirefliesRecord(final, ff.buildFirefliesMeetingRecord({}, answer({
    meeting_info: { summary_status: 'processing' },
    sentences: [{ speaker_name: 'Kari Test', text: 'Vi' }],
    summary: {},
  })), { nowMs: T });
  assert.equal(reprocessing.transcript, final.transcript);
  assert.equal(reprocessing.summaryStatus, 'processed', 'the state stays with the text');
  // Pasted while the meeting ran, then the processed copy arrives.
  const partial = ff.mergeStoredFirefliesRecord({}, ff.buildFirefliesMeetingRecord({}, answer({ is_live: true, meeting_info: { summary_status: null }, summary: {} })), { nowMs: T });
  const complete = ff.mergeStoredFirefliesRecord(partial, ff.buildFirefliesMeetingRecord({}, answer({
    sentences: [{ speaker_name: 'Kari Test', text: 'Vi trenger en ny nettside.' }, { speaker_name: 'Damian', text: 'Det ordner vi.' }],
  })), { nowMs: T });
  assert.match(complete.transcript, /Det ordner vi/);
  assert.equal(complete.isLive, false);
  assert.equal(complete.summary, 'Kunden vil ha ny nettside.');
});

test('a transcript stored while Fireflies is processing is fetched again until processed, then never', () => {
  const id = 'FF-PROC';
  const processing = ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer({
    id, meeting_info: { summary_status: 'processing' }, summary: {},
  })), { nowMs: T });
  assert.equal(processing.summary, '');
  assert.equal(ff.firefliesFetchDue(processing, { nowMs: T }), false, 'paused right after the fetch');
  assert.equal(ff.firefliesFetchDue(processing, { nowMs: T + 2 * MIN }), true, 'due after the first pause');
  // Listed with the status the stored text already has: nothing to queue.
  const [same] = ff.upsertListedFirefliesMeetings([ff.buildFirefliesListRecord({
    id, title: 'Testfirma AS · Kari Test', meeting_info: { summary_status: 'processing' },
  })], { nowMs: T + 10 * 1000 });
  assert.equal(same.queued, false);
  // The next list shows it processed: one full fetch is queued at once.
  const [listed] = ff.upsertListedFirefliesMeetings([ff.buildFirefliesListRecord({
    id, title: 'Testfirma AS · Kari Test', meeting_info: { summary_status: 'processed' },
  })], { nowMs: T + 30 * 1000 });
  assert.equal(listed.queued, true);
  assert.equal(ff.firefliesFetchDue(ff.readStoredFirefliesMeeting(id), { nowMs: T + 30 * 1000 }), true);
  const done = ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer({ id })), { nowMs: T + MIN });
  assert.equal(done.summary, 'Kunden vil ha ny nettside.');
  assert.deepEqual(done.actionItems, ['Send tilbud']);
  assert.equal(done.fetch.queuedAt, '');
  assert.equal(ff.firefliesFetchDue(done, { nowMs: T + 10 * 24 * 60 * MIN }), false, 'final: never fetched again');
});

test('an empty-final transcript is never fetched again', () => {
  const id = 'FF-SILENT';
  const silent = ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer({
    id, sentences: [], summary: {}, meeting_info: { summary_status: 'skipped', silent_meeting: true },
  })), { nowMs: T });
  assert.equal(ff.storedMeetingIsEmptyFinal(silent, { nowMs: T }), true);
  for (const later of [MIN, 60 * MIN, 3 * 24 * 60 * MIN]) {
    assert.equal(ff.firefliesFetchDue(silent, { nowMs: T + later }), false);
  }
  const due = ff.storedMeetingsNeedingHydration(ff.listStoredFirefliesMeetings(), { nowMs: T + 60 * MIN });
  assert.equal(due.some((row) => row.meetingId === id), false);
});

test('a failing id backs off, doubling, and is given up a week after it was first seen', () => {
  const id = 'FF-GONE';
  let row = ff.noteFirefliesFetchFailure(id, Object.assign(new Error('Object not found'), { code: 'object_not_found' }), { nowMs: T });
  assert.equal(row.fetch.attempts, 1);
  const first = Date.parse(row.fetch.nextFetchAt) - T;
  row = ff.noteFirefliesFetchFailure(id, new Error('Object not found'), { nowMs: T + first });
  assert.equal(Date.parse(row.fetch.nextFetchAt) - (T + first), first * 2);
  row = ff.noteFirefliesFetchFailure(id, new Error('Object not found'), { nowMs: T + 8 * 24 * 60 * MIN });
  assert.ok(row.fetch.gaveUpAt);
  assert.equal(ff.firefliesFetchDue(row, { nowMs: T + 9 * 24 * 60 * MIN }), false);
  assert.equal(ff.listStoredFirefliesMeetings().some((meeting) => meeting.meetingId === id), false, 'bookkeeping is not listed as a meeting');
});

test('one ingest tick writes the archive once, and not at all when nothing changed', () => {
  const rows = ['FF-B1', 'FF-B2', 'FF-B3'].map((id) => ff.buildFirefliesListRecord({
    id, title: `Møte ${id}`, dateString: '2026-10-22T10:00:00.000Z', meeting_link: MEET, meeting_info: { summary_status: 'processed' },
  }));
  const writes = () => ffStore.firefliesStoreHealth().meetings.writes;
  const before = writes();
  ff.upsertListedFirefliesMeetings(rows, { nowMs: T });
  assert.equal(writes(), before + 1);
  const again = ff.upsertListedFirefliesMeetings(rows, { nowMs: T + MIN });
  assert.equal(writes(), before + 1, 'the same rows a minute later: no write');
  assert.deepEqual(again.map((row) => row.changed), [false, false, false]);
  const changed = ff.upsertListedFirefliesMeetings([{ ...rows[0], durationMinutes: 47 }, rows[1], rows[2]], { nowMs: T + 2 * MIN });
  assert.equal(writes(), before + 2);
  assert.deepEqual(changed.map((row) => row.changed), [true, false, false]);
});

test('the webhook stores the transcript before it links the client', async () => {
  const id = 'FF-ORDER';
  let seenAtLink = null;
  await ff.notifyFirefliesRecording({ meeting_id: id, event: 'meeting.transcribed' }, CONFIG, {
    fetchTranscript: async () => answer({ id }),
    sendEmail: async () => {},
    matchClients: async () => ({ best: { clientId: 'c-order', businessName: 'Testfirma AS' }, candidates: [] }),
    linkMeeting: async () => { seenAtLink = ff.readStoredFirefliesMeeting(id); },
  });
  assert.equal(ff.storedMeetingHasTalk(seenAtLink), true, 'a workshop document job started by the link sees the talk');
  assert.equal(ff.readStoredFirefliesMeeting(id).match.clientId, 'c-order');
});

test('a copy that is not final is stored and linked, and e-mailed once it is final', async () => {
  const id = 'FF-DEFER';
  const sent = [];
  const deps = (reply) => ({
    fetchTranscript: async () => reply,
    sendEmail: async (message) => { sent.push(message); },
    matchClients: async () => ({ best: null, candidates: [] }),
  });
  const first = await ff.notifyFirefliesRecording({ meeting_id: id, event: 'Transcription completed' }, CONFIG, deps(answer({
    id, meeting_info: { summary_status: 'processing' }, summary: {},
  })));
  assert.equal(first.reason, 'not-final');
  assert.equal(sent.length, 0);
  assert.equal(ff.wasFirefliesMeetingNotified(id), false, 'nothing claimed yet');
  assert.match(ff.readStoredFirefliesMeeting(id).transcript, /ny nettside/);
  const second = await ff.notifyFirefliesRecording({ meeting_id: id, event: 'meeting.summarized' }, CONFIG, deps(answer({ id })));
  assert.equal(second.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Sammendrag:\nKunden vil ha ny nettside\./);
  assert.equal(ff.readFirefliesNotifyState(id).state, 'sent');
});

test('a failed recording e-mail is retried up to five sends, ten minutes apart', async () => {
  const id = 'FF-SMTP';
  const failing = {
    fetchTranscript: async () => answer({ id }),
    sendEmail: async () => { throw new Error('SMTP down'); },
    matchClients: async () => ({ best: null, candidates: [] }),
  };
  const result = await ff.notifyFirefliesRecording({ meeting_id: id, event: 'meeting.summarized' }, CONFIG, failing);
  assert.equal(result.reason, 'notify-failed');
  const state = ff.readFirefliesNotifyState(id);
  assert.deepEqual([state.state, state.attempts, state.error], ['failed', 1, 'SMTP down']);
  assert.equal(ff.readStoredFirefliesMeeting(id).notifyError, 'SMTP down');
  const last = Date.parse(state.lastAttemptAt);
  assert.equal(ff.wasFirefliesMeetingNotified(id, { nowMs: last + 9 * MIN }), true, 'not yet');
  assert.equal(ff.claimFirefliesMeetingNotification(id, { nowMs: last + 9 * MIN }), false);
  assert.equal(ff.wasFirefliesMeetingNotified(id, { nowMs: last + 10 * MIN }), false, 'due again');
  let at = last + 10 * MIN;
  for (let send = 2; send <= 5; send += 1) {
    assert.equal(ff.claimFirefliesMeetingNotification(id, { nowMs: at }), true, `send ${send}`);
    ff.markFirefliesMeetingNotified(id, { state: 'failed', error: 'SMTP down', nowMs: at });
    at += 10 * MIN;
  }
  assert.equal(ff.readFirefliesNotifyState(id).attempts, 5);
  assert.equal(ff.claimFirefliesMeetingNotification(id, { nowMs: at + 60 * MIN }), false, 'five sends, then it stops');
  // A claim always blocks a second one: the webhook and the pull follow-up racing.
  assert.equal(ff.claimFirefliesMeetingNotification('FF-RACE2', { nowMs: T }), true);
  assert.equal(ff.claimFirefliesMeetingNotification('FF-RACE2', { nowMs: T }), false);
});

test('Oppdater merges into the record as it is after the fetch', async () => {
  const id = 'FF-REFRESH';
  ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer({ id })), { nowMs: T });
  const refreshed = await ff.refreshFirefliesMeeting(id, CONFIG, {
    fetchTranscript: async () => {
      // A media copy and a client link finish while Fireflies answers.
      ff.updateStoredFirefliesMeeting(id, { media: { savedAt: '2026-10-23T12:01:00.000Z', video: { bytes: 10 } }, match: { clientId: 'c-1' } });
      return answer({ id, sentences: [], summary: {}, organizer_email: '', user: null, meeting_attendees: [], meeting_info: { summary_status: 'processing' } });
    },
  });
  assert.equal(refreshed.media.savedAt, '2026-10-23T12:01:00.000Z');
  assert.equal(refreshed.match.clientId, 'c-1');
  assert.match(refreshed.transcript, /ny nettside/, 'an empty answer does not wipe the transcript');
  assert.equal(refreshed.hostEmail, 'damian@asoldi.com');
  assert.deepEqual(refreshed.attendees, ['Kari Test <kari@firma.no>']);
});

test('the transcripts list pages through a date window, at most 50 rows a page', async () => {
  let body;
  await ff.fetchRecentFirefliesTranscripts({
    apiKey: 'ff-key',
    limit: 80,
    skip: 50,
    fromDate: '2026-10-09T00:00:00.000Z',
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ data: { transcripts: [] } }) };
    },
  });
  assert.equal(body.variables.limit, 50);
  assert.equal(body.variables.skip, 50);
  assert.equal(body.variables.fromDate, '2026-10-09T00:00:00.000Z');
  assert.equal('toDate' in body.variables, false, 'a filter that is not used is not sent');
  assert.match(body.query, /is_live/);
  assert.match(body.query, /meeting_info\s*\{\s*summary_status\s*\}/);
});

test('live captions pasted during the call stay partial after it, until the finished copy replaces them', () => {
  const id = 'FF-LIVEPASTE';
  const end = T + 60 * MIN;
  const lines = (count) => Array.from({ length: count }, (_, i) => ({ speaker_name: 'Kari Test', text: `Setning ${i}.` }));
  const live = (count) => ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer({
    id, is_live: true, duration: null, meeting_info: { summary_status: null }, summary: {}, sentences: lines(count),
  }));
  // Pasted on Tilbud 20 minutes in, then polled every 3 minutes while it runs.
  let row = ff.storeFetchedFirefliesMeeting(live(10), { nowMs: T + 20 * MIN });
  assert.equal(row.partial, true);
  assert.equal(Date.parse(row.fetch.nextFetchAt) - (T + 20 * MIN), 3 * MIN);
  for (let m = 23; m <= 59; m += 3) row = ff.storeFetchedFirefliesMeeting(live(m), { nowMs: T + m * MIN });
  assert.equal(row.fetch.attempts, 0, 'polls of a running meeting do not count toward the backoff');

  // Just after the call Fireflies answers with no sentences and no status for a few minutes.
  const t1 = end + MIN;
  row = ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer({
    id, duration: 60, meeting_info: { summary_status: 'default', silent_meeting: false }, sentences: [], summary: {},
  })), { nowMs: t1 });
  assert.equal(row.isLive, false);
  assert.equal(row.partial, true, 'the captions are kept, still marked partial');
  assert.equal(row.liveEndedAt, new Date(t1).toISOString());
  for (const later of [0, 30 * MIN, 5 * 60 * MIN]) {
    assert.equal(ff.storedMeetingIsFinal(row, { nowMs: t1 + later }), false, `never final from captions (+${later / MIN} min)`);
    assert.equal(ff.storedMeetingIsPartial(row), true);
  }
  assert.equal(Date.parse(row.fetch.nextFetchAt) - t1, 2 * MIN, 'the first fetch after the call waits the shortest step');

  // Fireflies has the full transcript while it writes the summary: it replaces the captions.
  const full = [{ speaker_name: 'Kari Test', text: 'Hele møtet.' }, { speaker_name: 'Damian', text: 'Takk for i dag.' }];
  row = ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer({
    id, meeting_info: { summary_status: 'processing' }, summary: {}, sentences: full,
  })), { nowMs: end + 4 * MIN });
  assert.equal(row.partial, undefined);
  assert.equal(row.transcript, 'Kari Test: Hele møtet.\nDamian: Takk for i dag.');
  assert.equal(ff.storedMeetingIsFinal(row, { nowMs: end + 5 * MIN }), false, 'still processing');
  row = ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer({ id, sentences: full })), { nowMs: end + 6 * MIN });
  assert.equal(ff.storedMeetingIsFinal(row, { nowMs: end + 6 * MIN }), true);
  assert.equal(row.summary, 'Kunden vil ha ny nettside.');
});

test('captions are all there is when Fireflies finishes a meeting without sentences', () => {
  const id = 'FF-LIVESHORT';
  ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer({
    id, is_live: true, meeting_info: { summary_status: null }, summary: {},
  })), { nowMs: T });
  const row = ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer({
    id, sentences: [], summary: {}, meeting_info: { summary_status: 'skipped', silent_meeting: false },
  })), { nowMs: T + 10 * MIN });
  assert.equal(row.partial, undefined, 'Fireflies is done: nothing better is coming');
  assert.equal(ff.storedMeetingIsFinal(row, { nowMs: T + 10 * MIN }), true);
  assert.match(row.transcript, /ny nettside/);
});

test('a row the old ingest stored while Fireflies was processing gets one fetch, then is final', () => {
  const id = 'FF-OLDPROC';
  // As the old ingest left it: talk, no summary, no state, three weeks ago.
  ff.updateStoredFirefliesMeeting(id, {
    title: 'Testfirma AS · Kari Test',
    startedAt: new Date(T - 21 * 24 * 60 * MIN).toISOString(),
    at: new Date(T - 21 * 24 * 60 * MIN).toISOString(),
    meetingLink: MEET,
    transcript: 'Kari Test: Vi trenger en ny nettside.',
    summary: '',
  }, { nowMs: T - 21 * 24 * 60 * MIN });
  const legacy = ff.readStoredFirefliesMeeting(id);
  assert.equal(ff.storedMeetingIsFinal(legacy, { nowMs: T }), false);
  assert.equal(ff.firefliesFetchDue(legacy, { nowMs: T }), true);
  const done = ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer({ id })), { nowMs: T });
  assert.equal(done.summary, 'Kunden vil ha ny nettside.');
  assert.equal(ff.firefliesFetchDue(done, { nowMs: T + 60 * MIN }), false);
  // The same old row with its summary was already complete: no fetch.
  assert.equal(ff.storedMeetingIsFinal({ ...legacy, fetchedAt: undefined, summary: 'Kort.' }, { nowMs: T }), true);
});

test('a person waiting skips the pause, but not a pause after a failed fetch', () => {
  const processing = { meetingId: 'FF-WAIT1', title: 'A', summaryStatus: 'processing', transcript: 'x', fetch: { attempts: 3, nextFetchAt: new Date(T + 60 * MIN).toISOString(), lastError: '' } };
  assert.equal(ff.firefliesFetchDue(processing, { nowMs: T }), false);
  assert.equal(ff.firefliesFetchDue(processing, { nowMs: T, onDemand: true }), true);
  const failing = { ...processing, fetch: { ...processing.fetch, lastError: 'Object not found' } };
  assert.equal(ff.firefliesFetchDue(failing, { nowMs: T, onDemand: true }), false);
  const gaveUp = { ...processing, fetch: { gaveUpAt: new Date(T).toISOString() } };
  assert.equal(ff.firefliesFetchDue(gaveUp, { nowMs: T, onDemand: true }), false);
  assert.equal(ff.firefliesFetchDue({ ...processing, summaryStatus: 'processed' }, { nowMs: T, onDemand: true }), false);
});
