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
  assert.match(loop, /\['follow-up', \(\) => runFirefliesPullFollowUp\(\{ notify: \(payload\) => notifyFirefliesRecording\(payload, readFirefliesWebhookConfig\(\), firefliesClientDeps\(\)\), persistMedia: persistFirefliesMediaInBackground \}\)\]/);
});
