// Fireflies media copies: savedAt only with a file on disk, retries with fresh signed URLs for two
// days, final skips, a free-space floor, and the text files rewritten once the summary is in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-ff-media-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const ff = await import('../lib/fireflies-webhook.js');
const media = await import('../lib/fireflies-media.js');
const { FirefliesApiError } = await import('../lib/fireflies-graphql.js');

const MIN = 60 * 1000;
const T = Date.parse('2026-10-23T14:00:00.000Z');
const GB = 1024 * 1024 * 1024;

function answer(id, sig, { status = 'processed' } = {}) {
  return {
    id,
    title: 'Testfirma AS · Kari Test',
    dateString: '2026-10-23T13:00:00.000Z',
    duration: 40,
    is_live: false,
    meeting_info: { summary_status: status },
    meeting_link: 'https://meet.google.com/abc-defg-hij',
    video_url: `https://cdn.example.com/${id}.mp4?sig=${sig}`,
    audio_url: `https://cdn.example.com/${id}.mp3?sig=${sig}`,
    sentences: [{ speaker_name: 'Kari Test', text: 'Vi vil ha ny nettside.' }],
    summary: status === 'processed' ? { overview: 'Kunden vil ha ny nettside.' } : {},
  };
}

function store(id, sig, nowMs, options) {
  return ff.storeFetchedFirefliesMeeting(ff.buildFirefliesMeetingRecord({ meeting_id: id }, answer(id, sig, options)), { nowMs });
}

/** CDN stub: a URL whose signature is in `expired` answers 403, others the given bytes. */
function cdn({ expired = new Set(), failOnce = false } = {}) {
  const calls = [];
  let failed = false;
  const fetchImpl = async (url) => {
    calls.push(url);
    const sig = new URL(url).searchParams.get('sig');
    if (failOnce && !failed) {
      failed = true;
      return new Response('busy', { status: 503 });
    }
    if (expired.has(sig)) return new Response('expired', { status: 403 });
    const body = url.includes('.mp4') ? 'fake-video-bytes' : 'fake-audio';
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  };
  return { calls, fetchImpl };
}

function deps({ fetchImpl, refetch, freeBytes = () => 10 * GB, nowMs }) {
  return {
    readRecord: (id) => ff.readStoredFirefliesMeeting(id),
    refetchRecord: refetch,
    updateMedia: (id, value) => ff.updateStoredFirefliesMeeting(id, { media: value }),
    isFinal: (record) => ff.storedMeetingIsFinal(record, { nowMs }),
    fetchImpl,
    freeBytes,
    nowMs,
  };
}

test('the media plan: fresh URLs for retries, final skips, a two-day window, no copy of an empty meeting', () => {
  const base = { meetingId: 'P1', transcript: 'x', videoDownloadUrl: 'https://cdn.example.com/a.mp4', audioUrl: 'https://cdn.example.com/a.mp3', summaryStatus: 'processed' };
  const fresh = media.firefliesMediaPlan({ ...base, fetchedAt: new Date(T - MIN).toISOString() }, { nowMs: T, final: true });
  assert.deepEqual([fresh.due, fresh.kinds, fresh.freshUrls], [true, ['video', 'audio'], false]);
  assert.equal(media.firefliesMediaPlan({ ...base, fetchedAt: new Date(T - 7 * 60 * MIN).toISOString() }, { nowMs: T }).freshUrls, true, 'URLs from hours ago are fetched again');
  const retry = media.firefliesMediaPlan({ ...base, media: { attempts: 1, firstAttemptAt: new Date(T - 20 * MIN).toISOString(), nextAttemptAt: new Date(T - MIN).toISOString(), video: { skipped: 'http-403' }, audio: { bytes: 9 }, savedAt: new Date(T - 20 * MIN).toISOString() } }, { nowMs: T });
  assert.deepEqual([retry.due, retry.kinds, retry.freshUrls], [true, ['video'], true], 'only the file that failed, with fresh URLs');
  const waiting = media.firefliesMediaPlan({ ...base, media: { attempts: 1, firstAttemptAt: new Date(T - 5 * MIN).toISOString(), nextAttemptAt: new Date(T + 5 * MIN).toISOString(), video: { skipped: 'timeout' } } }, { nowMs: T });
  assert.equal(waiting.due, false);
  const finalSkip = media.firefliesMediaPlan({ ...base, media: { attempts: 1, savedAt: new Date(T).toISOString(), video: { skipped: 'too-large' }, audio: { bytes: 9 }, textFinal: true } }, { nowMs: T, final: true });
  assert.equal(finalSkip.due, false, 'too-large is final');
  const audioOnly = media.firefliesMediaPlan({ ...base, media: { attempts: 1, savedAt: new Date(T).toISOString(), video: { skipped: 'no-url' }, audio: { bytes: 9 }, textFinal: true } }, { nowMs: T, final: true });
  assert.equal(audioOnly.due, false, 'an upload without video is done once its audio is saved');
  const late = media.firefliesMediaPlan({ ...base, media: { attempts: 6, firstAttemptAt: new Date(T - 49 * 60 * MIN).toISOString(), video: { skipped: 'http-403' }, audio: { skipped: 'http-403' } } }, { nowMs: T });
  assert.deepEqual([late.due, late.giveUp, late.kinds], [true, true, []], 'two days after the first try it gives up');
  const silent = media.firefliesMediaPlan({ meetingId: 'P2', videoDownloadUrl: 'https://cdn.example.com/b.mp4', summaryStatus: 'skipped' }, { nowMs: T, final: true });
  assert.equal(silent.due, false, 'nothing to keep from an empty meeting');
  assert.equal(media.firefliesMediaPlan({ ...base, meetingId: 'live:c1:1792749600000' }, { nowMs: T }).due, false);
  // Saved before the summary existed: the text files are written once more when it is final.
  const textDue = media.firefliesMediaPlan({ ...base, media: { attempts: 1, savedAt: new Date(T).toISOString(), video: { bytes: 9 }, audio: { bytes: 9 } } }, { nowMs: T, final: true });
  assert.deepEqual([textDue.due, textDue.text, textDue.kinds], [true, true, []]);
});

test('a failed download is retried ten minutes later with freshly signed URLs, and savedAt waits for a file', async () => {
  const id = 'FFMEDIA1';
  store(id, 'old', T - 7 * 60 * MIN);
  let sig = 0;
  const refetches = [];
  const refetch = async (meetingId) => {
    refetches.push(meetingId);
    sig += 1;
    return store(meetingId, `fresh${sig}`, T);
  };
  const first = cdn({ failOnce: true, expired: new Set(['fresh1']) });
  const one = await media.saveFirefliesMediaForMeeting(id, deps({ fetchImpl: first.fetchImpl, refetch, nowMs: T }));
  assert.equal(one.status, 'retry');
  assert.equal(refetches.length, 1, 'stored URLs from hours ago: fetched fresh before the first try');
  const stored = ff.readStoredFirefliesMeeting(id).media;
  assert.equal(stored.savedAt, '', 'no file saved: no savedAt');
  assert.equal(stored.attempts, 1);
  assert.equal(stored.lastSkip, 'http-503');
  assert.ok(first.calls.every((url) => url.includes('sig=fresh1')));

  const early = await media.saveFirefliesMediaForMeeting(id, deps({ fetchImpl: first.fetchImpl, refetch, nowMs: T + 5 * MIN }));
  assert.equal(early.status, 'waiting');
  assert.equal(refetches.length, 1);

  const second = cdn();
  const two = await media.saveFirefliesMediaForMeeting(id, deps({ fetchImpl: second.fetchImpl, refetch, nowMs: T + 11 * MIN }));
  assert.equal(two.status, 'saved');
  assert.equal(refetches.length, 2, 'every retry signs the URLs again');
  assert.ok(second.calls.every((url) => url.includes('sig=fresh2')));
  const saved = ff.readStoredFirefliesMeeting(id).media;
  assert.ok(saved.savedAt);
  assert.equal(saved.video.bytes, 'fake-video-bytes'.length);
  assert.equal(saved.nextAttemptAt, '');
  assert.ok(existsSync(join(dataDir, 'fireflies-media', id, 'video.mp4')));
  assert.equal((await media.saveFirefliesMediaForMeeting(id, deps({ fetchImpl: second.fetchImpl, refetch, nowMs: T + 60 * MIN }))).status, 'done');
});

test('a rate-limited refetch is no attempt, and a full disk is never written to', async () => {
  const id = 'FFMEDIA2';
  store(id, 'old', T - 8 * 60 * MIN);
  const limited = await media.saveFirefliesMediaForMeeting(id, deps({
    fetchImpl: cdn().fetchImpl,
    refetch: async () => { throw new FirefliesApiError('Too many requests.', { code: 'rate-limited' }); },
    nowMs: T,
  }));
  assert.equal(limited.status, 'later');
  assert.equal(ff.readStoredFirefliesMeeting(id).media, null, 'nothing counted');

  const disk = cdn();
  const full = await media.saveFirefliesMediaForMeeting(id, deps({
    fetchImpl: disk.fetchImpl,
    refetch: async (meetingId) => store(meetingId, 'ok', T),
    freeBytes: () => 300 * 1024 * 1024,
    nowMs: T,
  }));
  assert.equal(full.status, 'low-disk');
  assert.equal(disk.calls.length, 0, 'no download with 300 MB free');
  assert.equal(ff.readStoredFirefliesMeeting(id).media.lastSkip, 'low-disk');
});

test('a file over the size cap is a final skip; the text files are written again once the summary is in', async () => {
  const id = 'FFMEDIA3';
  store(id, 'ok', T, { status: 'processing' });
  const result = await media.saveFirefliesMediaForMeeting(id, {
    ...deps({ fetchImpl: cdn().fetchImpl, refetch: async () => ff.readStoredFirefliesMeeting(id), nowMs: T }),
    maxBytes: 12,
  });
  assert.equal(result.status, 'saved', 'the audio fits');
  const first = ff.readStoredFirefliesMeeting(id).media;
  assert.equal(first.video.skipped, 'too-large');
  assert.equal(first.nextAttemptAt, '', 'too-large is final: nothing left to retry');
  assert.equal(first.textFinal, undefined, 'saved while Fireflies was still processing');
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'fireflies-media', id, 'summary.json'), 'utf8')).summary, '');

  store(id, 'ok', T + 5 * MIN);
  const text = await media.saveFirefliesMediaForMeeting(id, deps({ fetchImpl: cdn().fetchImpl, nowMs: T + 6 * MIN }));
  assert.equal(text.status, 'text');
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'fireflies-media', id, 'summary.json'), 'utf8')).summary, 'Kunden vil ha ny nettside.');
  assert.equal(ff.readStoredFirefliesMeeting(id).media.textFinal, true);
  assert.equal((await media.saveFirefliesMediaForMeeting(id, deps({ fetchImpl: cdn().fetchImpl, nowMs: T + 7 * MIN }))).status, 'done');
});
