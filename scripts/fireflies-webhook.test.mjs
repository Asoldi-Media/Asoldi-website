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
  verifyFirefliesSignature,
} = await import('../lib/fireflies-webhook.js');

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

test('live-join window is 3 minutes before through 15 minutes after start', () => {
  const meetingAt = '2026-09-26T10:00:00.000Z';
  const start = Date.parse(meetingAt);
  assert.equal(firefliesLiveJoinWindow({ meetingAt, nowMs: start - (3 * 60 * 1000) }), true);
  assert.equal(firefliesLiveJoinWindow({ meetingAt, nowMs: start - (3 * 60 * 1000) - 1 }), false);
  assert.equal(firefliesLiveJoinWindow({ meetingAt, nowMs: start }), true);
  assert.equal(firefliesLiveJoinWindow({ meetingAt, nowMs: start + (15 * 60 * 1000) }), true);
  assert.equal(firefliesLiveJoinWindow({ meetingAt, nowMs: start + (15 * 60 * 1000) + 1 }), false);
  assert.equal(firefliesLiveJoinWindow({ meetingAt: 'not-a-date', nowMs: start }), false);
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
