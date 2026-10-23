// WS0.9: with the push webhook refused until the new secret is pasted into Fireflies, meetings that
// arrive only through the pull ingest still get the notify e-mail (once) and their media copied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-ff-followup-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const ff = await import('../lib/fireflies-webhook.js');
const followUp = await import('../lib/fireflies-pull-followup.js');

const HOUR = 60 * 60 * 1000;
const CONFIG = { apiKey: 'fake-api-key', notifyEmail: 'team@example.com', secrets: [], token: '', retiredSecrets: [], retiredToken: '' };

function transcriptFor(id, { startedAt = Date.now() - HOUR, talk = true, video = true } = {}) {
  return {
    id,
    title: `Møte ${id}`,
    date: startedAt,
    duration: 30,
    meeting_link: `https://meet.google.com/${id.toLowerCase()}`,
    video_url: video ? `https://cdn.example.com/${id}.mp4?sig=fake` : '',
    audio_url: video ? `https://cdn.example.com/${id}.mp3?sig=fake` : '',
    is_live: false,
    meeting_info: { summary_status: talk ? 'processed' : 'skipped' },
    organizer_email: 'host@example.com',
    sentences: talk ? [{ speaker_name: 'Host', text: 'Hei og velkommen.' }] : [],
    summary: talk ? { overview: 'Kort møte.' } : {},
  };
}

/** What ingestRecentFirefliesMeetLinks + hydrateRecentStoredTranscripts leave in fireflies-meetings.json. */
function storeAsPullIngest(id, options) {
  ff.storeFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, transcriptFor(id, options)));
}

function harness({ fetchDelayMs = 0, failFetch = false } = {}) {
  const emails = [];
  const media = [];
  const deps = {
    sendEmail: async (message) => { emails.push(message); },
    fetchTranscript: async (id) => {
      if (fetchDelayMs) await new Promise((resolve) => setTimeout(resolve, fetchDelayMs));
      if (failFetch) throw new Error('Fireflies is down');
      return transcriptFor(id);
    },
    matchClients: async () => ({ best: null, candidates: [] }),
    linkMeeting: async () => {},
  };
  return {
    emails,
    media,
    deps,
    notify: (payload) => ff.notifyFirefliesRecording(payload, CONFIG, deps),
    persistMedia: async (id) => {
      media.push(id);
      ff.updateStoredFirefliesMeeting(id, { media: { savedAt: new Date().toISOString(), video: { bytes: 1 }, audio: { bytes: 1 } } });
    },
  };
}

const quiet = { log() {}, warn() {} };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a meeting that only came through the pull ingest gets one notify e-mail and its media saved', async () => {
  followUp.resetFirefliesFollowUpForTests();
  const h = harness();
  storeAsPullIngest('PULLONLY1');

  const first = await followUp.runFirefliesPullFollowUp({ notify: h.notify, persistMedia: h.persistMedia, log: quiet });
  await settle();
  assert.deepEqual(first.notified, ['PULLONLY1']);
  assert.equal(h.emails.length, 1);
  assert.equal(h.emails[0].to, 'team@example.com');
  assert.deepEqual(h.media, ['PULLONLY1']);
  assert.ok(ff.readStoredFirefliesMeeting('PULLONLY1').media.savedAt);
  assert.equal(ff.wasFirefliesMeetingNotified('PULLONLY1'), true);

  // The next ingest tick does nothing more for it.
  const second = await followUp.runFirefliesPullFollowUp({ notify: h.notify, persistMedia: h.persistMedia, log: quiet });
  await settle();
  assert.deepEqual(second, { notified: [], mediaStarted: [] });
  assert.equal(h.emails.length, 1);
  assert.deepEqual(h.media, ['PULLONLY1']);

  // A webhook for the same meeting after the secret is pasted: no second e-mail.
  const webhook = await ff.notifyFirefliesRecording({ meeting_id: 'PULLONLY1', event: 'Transcription completed' }, CONFIG, { ...h.deps, refreshOnRepeat: false });
  assert.equal(webhook.reason, 'already-notified');
  assert.equal(h.emails.length, 1);
});

test('the webhook and the pull follow-up racing on one meeting send exactly one e-mail', async () => {
  followUp.resetFirefliesFollowUpForTests();
  const h = harness({ fetchDelayMs: 30 });
  storeAsPullIngest('RACE1');
  const [viaWebhook, viaPull] = await Promise.all([
    ff.notifyFirefliesRecording({ meeting_id: 'RACE1', event: 'Transcription completed' }, CONFIG, h.deps),
    followUp.runFirefliesPullFollowUp({ notify: h.notify, persistMedia: h.persistMedia, log: quiet }),
  ]);
  await settle();
  assert.equal(h.emails.length, 1);
  assert.equal([viaWebhook.sent, viaPull.notified.length === 1].filter(Boolean).length >= 1, true);
  assert.equal(ff.wasFirefliesMeetingNotified('RACE1'), true);
});

test('old, undated, transcript-less and live: meetings are not e-mailed; media needs a URL', () => {
  const now = Date.now();
  const recent = new Date(now - HOUR).toISOString();
  const rows = [
    { meetingId: 'OLD', startedAt: new Date(now - 5 * 24 * HOUR).toISOString(), transcript: 'x', videoDownloadUrl: 'https://cdn.example.com/a.mp4' },
    { meetingId: 'UNDATED', transcript: 'x', videoDownloadUrl: 'https://cdn.example.com/b.mp4' },
    { meetingId: 'NOTALK', startedAt: recent, videoDownloadUrl: 'https://cdn.example.com/c.mp4' },
    { meetingId: 'live:abc', startedAt: recent, transcript: 'x', videoDownloadUrl: 'https://cdn.example.com/d.mp4' },
    { meetingId: 'SAVED', startedAt: recent, transcript: 'x', videoDownloadUrl: 'https://cdn.example.com/e.mp4', media: { savedAt: recent } },
    { meetingId: 'NOURL', startedAt: recent, summary: 'x' },
    { meetingId: 'DONE', startedAt: recent, transcript: 'x' },
  ];
  const picked = followUp.firefliesFollowUpCandidates(rows, { nowMs: now, isNotified: (id) => id === 'DONE' });
  assert.deepEqual(picked, { notify: ['SAVED', 'NOURL'], media: ['NOTALK'] });
});

test('a failing fetch is retried after a pause, not on every ingest tick', async () => {
  followUp.resetFirefliesFollowUpForTests();
  const h = harness({ failFetch: true });
  storeAsPullIngest('FLAKY1');
  const now = Date.now();
  const run = (nowMs) => followUp.runFirefliesPullFollowUp({ notify: h.notify, persistMedia: async () => {}, nowMs, log: quiet });
  assert.deepEqual((await run(now)).notified, []);
  assert.equal(ff.wasFirefliesMeetingNotified('FLAKY1'), false, 'not claimed when the fetch failed');
  let calls = 0;
  const counting = (payload) => { calls += 1; return h.notify(payload); };
  await followUp.runFirefliesPullFollowUp({ notify: counting, nowMs: now + 60_000, log: quiet });
  assert.equal(calls, 0, 'one minute later: still waiting');
  await followUp.runFirefliesPullFollowUp({ notify: counting, nowMs: now + 6 * 60_000, log: quiet });
  assert.equal(calls, 1, 'retried after five minutes');
  assert.equal(h.emails.length, 0);
});

test('server.js runs the follow-up as its own step of the pull ingest tick', () => {
  const server = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
  const loop = server.slice(server.indexOf('function scheduleFirefliesTranscriptIngest'), server.indexOf('function startFirefliesTranscriptIngestLoop'));
  assert.match(loop, /await runFirefliesIngestTick\(\[/);
  assert.match(loop, /\['follow-up', \(\) => runFirefliesPullFollowUp\(\{\s*notify: \(payload\) => notifyFirefliesRecording\(payload, readFirefliesWebhookConfig\(\), \{ \.\.\.firefliesClientDeps\(\), useStored: true, deferUntilFinal: false \}\),\s*persistMedia: persistFirefliesMediaInBackground,\s*\}\)\]/);
});
test('a meeting Fireflies is still processing is e-mailed once processed, or 20 minutes after it was first seen', async () => {
  followUp.resetFirefliesFollowUpForTests();
  const now = Date.now();
  const stored = (id, overrides) => ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, {
    ...transcriptFor(id, { startedAt: now - HOUR }),
    ...overrides,
  }), { nowMs: now });
  stored('PROCESSING1', { meeting_info: { summary_status: 'processing' }, summary: {} });
  stored('LIVE1', { is_live: true, meeting_info: { summary_status: null }, summary: {} });
  stored('DONE1', {});
  const at = (nowMs) => followUp.firefliesFollowUpCandidates(ff.listStoredFirefliesMeetings(), { nowMs, isNotified: () => false }).notify;
  const picked = at(now + 60 * 1000);
  assert.ok(picked.includes('DONE1'), 'processed: at once');
  assert.equal(picked.includes('PROCESSING1'), false, 'processing: wait for the summary');
  assert.equal(picked.includes('LIVE1'), false);
  const later = at(now + 21 * 60 * 1000);
  assert.ok(later.includes('PROCESSING1'), 'twenty minutes after it was first seen: send what there is');
  assert.equal(later.includes('LIVE1'), false, 'a live copy is never e-mailed');
});

test('a failed recording e-mail is sent again by the follow-up ten minutes later', async () => {
  followUp.resetFirefliesFollowUpForTests();
  const sent = [];
  let smtpDown = true;
  const deps = {
    fetchTranscript: async (id) => transcriptFor(id),
    sendEmail: async (message) => {
      if (smtpDown) throw new Error('SMTP down');
      sent.push(message);
    },
    matchClients: async () => ({ best: null, candidates: [] }),
  };
  storeAsPullIngest('RETRY1');
  const now = Date.now();
  const run = (nowMs) => followUp.runFirefliesPullFollowUp({
    notify: (payload) => ff.notifyFirefliesRecording(payload, CONFIG, { ...deps, useStored: true, deferUntilFinal: false, nowMs }),
    persistMedia: async () => {},
    listMeetings: () => ff.listStoredFirefliesMeetings().filter((row) => row.meetingId === 'RETRY1'),
    nowMs,
    log: quiet,
  });
  await run(now);
  assert.equal(ff.readFirefliesNotifyState('RETRY1').state, 'failed');
  smtpDown = false;
  assert.deepEqual((await run(now + 5 * 60 * 1000)).notified, [], 'not before ten minutes');
  assert.deepEqual((await run(now + 11 * 60 * 1000)).notified, ['RETRY1']);
  assert.equal(sent.length, 1);
  assert.equal(ff.readFirefliesNotifyState('RETRY1').state, 'sent');
  assert.equal(ff.readStoredFirefliesMeeting('RETRY1').notifyError, '', 'the error is cleared once it went out');
});

test('an old meeting whose notified entry was pruned is never e-mailed again', () => {
  const now = Date.now();
  const rows = [{ meetingId: 'ANCIENT1', startedAt: new Date(now - 100 * 24 * HOUR).toISOString(), transcript: 'x', summaryStatus: 'processed' }];
  assert.deepEqual(followUp.firefliesFollowUpCandidates(rows, { nowMs: now, isNotified: () => false }).notify, []);
});
