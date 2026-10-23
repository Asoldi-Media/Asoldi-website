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
  firefliesLiveJoinShouldWait,
  firefliesLiveJoinWindow,
  buildFirefliesNotifyEmail,
  eventFromPayload,
  fetchFirefliesTranscript,
  formatFirefliesActionItems,
  formatFirefliesTranscript,
  isFirefliesTranscriptReadyEvent,
  meetingIdFromPayload,
  mergeStoredFirefliesRecord,
  notifyFirefliesRecording,
  readStoredFirefliesMeeting,
  storeFirefliesMeeting,
  storedMeetingsNeedingHydration,
  verifyFirefliesSignature,
} = await import('../lib/fireflies-webhook.js');
import {
  firefliesJoinedCurrentMeet,
  firefliesMeetLinksDiffer,
  firefliesNeedsFreshMeetOnReschedule,
  shouldDropLiveJoinStub,
} from '../lib/fireflies-client-match.js';
import { readFileSync } from 'node:fs';

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

test('live-join window is 3 minutes before through 2 hours after start', () => {
  const meetingAt = '2026-09-26T10:00:00.000Z';
  const start = Date.parse(meetingAt);
  assert.equal(firefliesLiveJoinWindow({ meetingAt, nowMs: start - (3 * 60 * 1000) }), true);
  assert.equal(firefliesLiveJoinWindow({ meetingAt, nowMs: start - (3 * 60 * 1000) - 1 }), false);
  assert.equal(firefliesLiveJoinWindow({ meetingAt, nowMs: start }), true);
  assert.equal(firefliesLiveJoinWindow({ meetingAt, nowMs: start + (90 * 60 * 1000) }), true);
  assert.equal(firefliesLiveJoinWindow({ meetingAt, nowMs: start + (2 * 60 * 60 * 1000) }), true);
  assert.equal(firefliesLiveJoinWindow({ meetingAt, nowMs: start + (2 * 60 * 60 * 1000) + 1 }), false);
  assert.equal(firefliesLiveJoinWindow({ meetingAt: 'not-a-date', nowMs: start }), false);
});

test('live-join is per Meet URL so a later room swap joins again', () => {
  const oldMeet = 'https://meet.google.com/eue-pfvs-zot';
  const newMeet = 'https://meet.google.com/ssy-ndai-cpy';
  assert.equal(firefliesJoinedCurrentMeet({
    joinedAt: '2026-10-08T12:57:35.071Z',
    joinedMeetLink: oldMeet,
    meetLink: oldMeet,
  }), true);
  assert.equal(firefliesJoinedCurrentMeet({
    joinedAt: '2026-10-08T12:57:35.071Z',
    joinedMeetLink: oldMeet,
    meetLink: newMeet,
  }), false);
  assert.equal(firefliesJoinedCurrentMeet({
    joinedAt: '',
    joinedMeetLink: '',
    meetLink: newMeet,
  }), false);
  assert.equal(firefliesJoinedCurrentMeet({
    joinedAt: '2026-10-08T13:57:35.114Z',
    joinedMeetLink: '',
    meetLink: newMeet,
  }), false);
  assert.equal(firefliesMeetLinksDiffer(oldMeet, newMeet), true);
  assert.equal(firefliesMeetLinksDiffer(oldMeet, `${oldMeet}?authuser=0`), false);
  const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(serverSrc, /firefliesJoinedCurrentMeet\(/);
  assert.match(serverSrc, /firefliesLiveJoinedMeetLink/);
  assert.match(serverSrc, /meetLinkChanged \|\| calendarMeta\.replacedForeignMeet/);
  assert.match(serverSrc, /firefliesNeedsFreshMeetOnReschedule\(/);
  assert.equal(serverSrc.includes('sanitizeText(previousClient?.meetingAt) !== sanitizeText(nextClient?.meetingAt)'), false);
});

test('a later start after Fred entered this Meet needs a new room', () => {
  const meet = 'https://meet.google.com/bru-bphr-ekz';
  const joined = {
    joinedAt: '2026-10-15T14:57:10.901Z',
    joinedMeetLink: meet,
    meetLink: meet,
    previousMeetingAt: '2026-10-15T15:00:00.000Z',
    nextMeetingAt: '2026-10-15T15:30:00.000Z',
  };
  assert.equal(firefliesNeedsFreshMeetOnReschedule(joined), true);
  assert.equal(firefliesNeedsFreshMeetOnReschedule({
    ...joined,
    joinedAt: '',
    joinedMeetLink: '',
  }), false);
  assert.equal(firefliesNeedsFreshMeetOnReschedule({
    ...joined,
    nextMeetingAt: joined.previousMeetingAt,
  }), false);
  assert.equal(firefliesNeedsFreshMeetOnReschedule({
    ...joined,
    meetLink: 'https://meet.google.com/ssy-ndai-cpy',
  }), false);
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
    // No status at all (stored before it was): talk that has sat for 30 minutes is final.
    { meetingId: 'ff-legacy', startedAt: '2026-10-09T11:00:00.000Z', meetingLink: link, transcript: 'Kunde: hei' },
  ], { nowMs: now });
  assert.deepEqual(rows.map((row) => row.meetingId), ['ff-processing', 'ff-new', 'ff-queued']);
});

test('live-join retries wait 6 minutes after an attempt', () => {
  const attemptAt = '2026-09-26T10:00:00.000Z';
  const now = Date.parse(attemptAt);
  assert.equal(firefliesLiveJoinShouldWait({ attemptAt, nowMs: now + (6 * 60 * 1000) - 1 }), true);
  assert.equal(firefliesLiveJoinShouldWait({ attemptAt, nowMs: now + (6 * 60 * 1000) }), false);
  assert.equal(firefliesLiveJoinShouldWait({ attemptAt: '', nowMs: now }), false);
});

test('addToLiveMeeting posts the Meet link to Fireflies GraphQL', async () => {
  let captured;
  const result = await addFirefliesToLiveMeeting({
    meetingLink: 'https://meet.google.com/pfk-wrzo-qfy',
    title: 'Asoldi · Online møte · Test',
    apiKey: 'ff-key',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        json: async () => ({ data: { addToLiveMeeting: { success: true, message: 'ok' } } }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://api.fireflies.ai/graphql');
  const body = JSON.parse(captured.options.body);
  assert.match(body.query, /addToLiveMeeting/);
  assert.equal(body.variables.meetingLink, 'https://meet.google.com/pfk-wrzo-qfy');
  assert.equal(captured.options.headers.Authorization, 'Bearer ff-key');
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
  assert.equal(ff.storedMeetingIsFinal({ transcript: 'x', firstSeenAt: iso(T - 29 * MIN) }, { nowMs: T }), false);
  assert.equal(ff.storedMeetingIsFinal({ transcript: 'x', firstSeenAt: iso(T - 31 * MIN) }, { nowMs: T }), true);
  assert.equal(ff.storedMeetingIsFinal({ firstSeenAt: iso(T - 300 * MIN) }, { nowMs: T }), false, 'no talk and no status');
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
