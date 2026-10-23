/**
 * Copy Fireflies media (video / audio) + transcript to the persistent data dir so admins can review
 * a sales meeting after Fireflies' signed download URLs (~2.6 days) have expired.
 *
 * Files: <dataDir>/fireflies-media/<meetingId>/{video.mp4,audio.mp3,transcript.txt,summary.json}
 * Size cap per file: FIREFLIES_MEDIA_MAX_MB (default 400; 0 disables media downloads).
 * Free-space floor: FIREFLIES_MEDIA_MIN_FREE_MB (default 2048; 0 turns the check off).
 *
 * A file that failed to download is tried again with a doubling pause for two days after the
 * first try, each retry with fresh signed URLs. 'too-large' and 'disabled' are final. The text
 * files are written again once the meeting's final summary exists. Nothing is deleted here.
 */

import fs, { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getPersistentDataDir } from '../data/storage-path.js';
import { isTransientFirefliesError } from './fireflies-graphql.js';

const DEFAULT_MAX_MB = 400;
const DEFAULT_MIN_FREE_MB = 2048;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
export const MEDIA_KINDS = ['video', 'audio'];
/** Downloads are retried for this long after the first try. */
export const MEDIA_RETRY_WINDOW_MS = 2 * 24 * 60 * MINUTE_MS;
const MEDIA_RETRY_BASE_MS = 10 * MINUTE_MS;
const MEDIA_RETRY_MAX_MS = 6 * 60 * MINUTE_MS;
// Stored signed URLs older than this are fetched fresh before a download.
const MEDIA_URL_MAX_AGE_MS = 6 * 60 * MINUTE_MS;
const FINAL_SKIPS = new Set(['too-large', 'disabled']);

function text(value = '') {
  return String(value ?? '').trim();
}

function safeId(value = '') {
  return text(value).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120);
}

export function firefliesMediaRoot() {
  const root = join(getPersistentDataDir(), 'fireflies-media');
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

let videoIdCache = { at: 0, ids: new Set() };
const VIDEO_ID_CACHE_MS = 60_000;

/** One directory pass, reused by the sales list. Per-meeting stat on that list blocks Node. */
export function meetingHasStoredVideo(meetingId) {
  const id = safeId(meetingId);
  if (!id) return false;
  const now = Date.now();
  if (!(videoIdCache.ids instanceof Set) || now - videoIdCache.at > VIDEO_ID_CACHE_MS) {
    const ids = new Set();
    try {
      const root = join(getPersistentDataDir(), 'fireflies-media');
      if (existsSync(root)) {
        for (const name of readdirSync(root, { withFileTypes: true })) {
          if (!name.isDirectory()) continue;
          try {
            if (statSync(join(root, name.name, 'video.mp4')).size > 0) ids.add(name.name);
          } catch {
            // Folder without a video file.
          }
        }
      }
    } catch {
      // List still loads if the media dir cannot be read.
    }
    videoIdCache = { at: now, ids };
  }
  return videoIdCache.ids.has(id);
}

export function invalidateMeetingVideoCache() {
  videoIdCache = { at: 0, ids: new Set() };
}

export function firefliesMediaDir(meetingId) {
  const id = safeId(meetingId);
  if (!id) throw new Error('Missing meeting id for media dir.');
  const dir = join(firefliesMediaRoot(), id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readMediaMaxBytes(env = process.env) {
  const raw = text(env.FIREFLIES_MEDIA_MAX_MB);
  if (raw === '') return DEFAULT_MAX_MB * 1024 * 1024;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return DEFAULT_MAX_MB * 1024 * 1024;
  return Math.round(mb * 1024 * 1024);
}

function unlinkQuiet(path) {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

class SizeCapExceeded extends Error {
  constructor(limit) {
    super(`Media exceeds size cap (${Math.round(limit / 1024 / 1024)} MB).`);
    this.name = 'SizeCapExceeded';
  }
}

/** Stream a URL to disk with a byte cap. Resolves { path, bytes } or { skipped: reason }. */
export async function downloadToFile(url, destPath, { maxBytes, fetchImpl = fetch } = {}) {
  const target = text(url);
  if (!target) return { skipped: 'no-url' };
  if (!maxBytes) return { skipped: 'disabled' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(target, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) return { skipped: `http-${response.status}` };
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return { skipped: 'too-large', declaredBytes: declared };

    let bytes = 0;
    const counter = async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new SizeCapExceeded(maxBytes);
        yield chunk;
      }
    };
    const source = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
    await pipeline(source, counter, createWriteStream(destPath));
    return { path: destPath, bytes };
  } catch (error) {
    unlinkQuiet(destPath);
    if (error instanceof SizeCapExceeded) return { skipped: 'too-large' };
    if (error?.name === 'AbortError') return { skipped: 'timeout' };
    return { skipped: `error: ${text(error?.message) || error}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist everything we have for a meeting. Text files are always written; media honours the cap.
 * `kinds` limits the downloads (a retry only fetches the file that failed).
 * @returns {{ dir, transcriptPath, summaryPath, video: object, audio: object }}
 */
export async function persistFirefliesMedia(record = {}, { maxBytes = readMediaMaxBytes(), fetchImpl = fetch, skipMedia = false, kinds = MEDIA_KINDS } = {}) {
  const dir = firefliesMediaDir(record.meetingId);
  const transcriptPath = join(dir, 'transcript.txt');
  const summaryPath = join(dir, 'summary.json');
  writeFileSync(transcriptPath, String(record.transcript || ''), 'utf8');
  writeFileSync(summaryPath, JSON.stringify({
    meetingId: record.meetingId,
    title: record.title,
    when: record.when,
    startedAt: record.startedAt || '',
    durationMinutes: record.durationMinutes,
    recordedBy: record.recordedBy,
    attendees: record.attendees,
    summary: record.summary,
    actionItems: record.actionItems,
    keywords: record.keywords,
    transcriptUrl: record.transcriptUrl,
    savedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  const result = { dir, transcriptPath, summaryPath, video: { skipped: 'not-attempted' }, audio: { skipped: 'not-attempted' } };
  if (skipMedia) return result;
  if (kinds.includes('video')) result.video = await downloadToFile(record.videoDownloadUrl, join(dir, 'video.mp4'), { maxBytes, fetchImpl });
  if (kinds.includes('audio')) result.audio = await downloadToFile(record.audioUrl, join(dir, 'audio.mp3'), { maxBytes, fetchImpl });
  invalidateMeetingVideoCache();
  return result;
}

export function readMediaMinFreeBytes(env = process.env) {
  const raw = text(env.FIREFLIES_MEDIA_MIN_FREE_MB);
  const mb = raw === '' ? DEFAULT_MIN_FREE_MB : Number(raw);
  return Math.round((Number.isFinite(mb) && mb >= 0 ? mb : DEFAULT_MIN_FREE_MB) * 1024 * 1024);
}

/** Free bytes on the disk that holds `path`, or null when the platform cannot tell (no fs.statfs). */
export function freeDiskBytes(path = getPersistentDataDir()) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stats = fs.statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// Records from before per-file results only had savedAt: those count as saved.
function legacySaved(media = {}) {
  return Boolean(text(media.savedAt)) && !isObject(media.video) && !isObject(media.audio);
}

function fileSaved(state) {
  return Number(state?.bytes) > 0;
}

/** This file still needs a download: never tried, or failed for a reason that may pass. */
function fileWanted(media, kind) {
  const state = isObject(media[kind]) ? media[kind] : null;
  if (!state) return true;
  if (fileSaved(state) || FINAL_SKIPS.has(text(state.skipped))) return false;
  // Once one file is saved, a missing URL means Fireflies has no such file (an audio-only upload).
  if (text(state.skipped) === 'no-url' && MEDIA_KINDS.some((other) => fileSaved(media[other]))) return false;
  return true;
}

/**
 * What the media copy of one stored meeting needs now. `final` is whether Fireflies has finished
 * the meeting (storedMeetingIsFinal). Returns { due, kinds, text, freshUrls, giveUp, reason }:
 *   kinds      files to download now (empty when only the text needs a rewrite);
 *   text       write transcript.txt and summary.json again from the final copy;
 *   freshUrls  fetch the transcript again first: a retry, or stored URLs older than 6 hours;
 *   giveUp     the two-day retry window is over.
 */
export function firefliesMediaPlan(row = {}, { nowMs = Date.now(), final = false } = {}) {
  const none = (reason) => ({ due: false, kinds: [], text: false, freshUrls: false, giveUp: false, reason });
  const id = text(row?.meetingId);
  if (!id || id.toLowerCase().startsWith('live:')) return none('not-a-recording');
  const media = isObject(row.media) ? row.media : {};
  const attempted = Number(media.attempts) > 0 || Boolean(text(media.savedAt));
  const textDue = final && attempted && !media.textFinal;
  const done = (reason) => (textDue ? { ...none(reason), due: true, text: true } : none(reason));
  if (legacySaved(media) || text(media.gaveUpAt)) return done('done');
  const kinds = MEDIA_KINDS.filter((kind) => fileWanted(media, kind));
  if (!kinds.length) return done('done');
  if (final && !text(row.transcript) && !text(row.summary)) return done('empty');
  if (!text(row.videoDownloadUrl) && !text(row.audioUrl)) return done('no-url');
  const first = Date.parse(media.firstAttemptAt || media.savedAt || '');
  if (Number.isFinite(first) && nowMs - first >= MEDIA_RETRY_WINDOW_MS) {
    return { due: true, kinds: [], text: textDue, freshUrls: false, giveUp: true, reason: 'gave-up' };
  }
  const next = Date.parse(media.nextAttemptAt || '');
  if (Number.isFinite(next) && next > nowMs) return done('waiting');
  const fetched = Date.parse(row.fetchedAt || '');
  return {
    due: true,
    kinds,
    text: false,
    freshUrls: Number(media.attempts) > 0 || !Number.isFinite(fetched) || nowMs - fetched > MEDIA_URL_MAX_AGE_MS,
    giveUp: false,
    reason: 'download',
  };
}

function isTryLater(error) {
  return isTransientFirefliesError(error) || ['ESAFEMODE', 'no-api-key'].includes(error?.code);
}

/**
 * Copy one meeting's media now, as far as its plan says. deps:
 *   readRecord(id)            the stored meeting;
 *   refetchRecord(id)         fetch the transcript again (fresh signed URLs) and return the stored record;
 *   updateMedia(id, media)    write the media state onto the stored meeting;
 *   isFinal(record)           storedMeetingIsFinal.
 * media.savedAt is set only when at least one file was saved; otherwise attempts, lastSkip and
 * nextAttemptAt record the try. Returns { status, media }.
 */
export async function saveFirefliesMediaForMeeting(meetingId, {
  readRecord,
  refetchRecord,
  updateMedia,
  isFinal = () => false,
  nowMs = Date.now(),
  maxBytes = readMediaMaxBytes(),
  minFreeBytes = readMediaMinFreeBytes(),
  freeBytes = () => freeDiskBytes(),
  fetchImpl = fetch,
} = {}) {
  const id = text(meetingId);
  let record = id && typeof readRecord === 'function' ? readRecord(id) : null;
  if (!record) return { status: 'missing', media: null };
  const plan = firefliesMediaPlan(record, { nowMs, final: isFinal(record) });
  if (!plan.due) return { status: plan.reason, media: record.media || null };
  const media = { ...(isObject(record.media) ? record.media : {}) };
  const textFor = (copy) => ({ hasTranscript: Boolean(text(copy.transcript)), ...(isFinal(copy) ? { textFinal: true } : {}) });

  if (!plan.kinds.length) {
    if (plan.text) await persistFirefliesMedia(record, { skipMedia: true });
    const next = { ...media, ...(plan.text ? textFor(record) : {}), ...(plan.giveUp ? { gaveUpAt: iso(nowMs), nextAttemptAt: '' } : {}) };
    updateMedia(id, next);
    return { status: plan.giveUp ? 'gave-up' : 'text', media: next };
  }

  if (plan.freshUrls && typeof refetchRecord === 'function') {
    try {
      record = (await refetchRecord(id)) || record;
    } catch (error) {
      // A rate limit or a network blip is no attempt; anything else is tried with the stored URLs.
      if (isTryLater(error)) return { status: 'later', media: record.media || null };
    }
  }

  const attempts = (Number(media.attempts) || 0) + 1;
  const tried = { attempts, firstAttemptAt: text(media.firstAttemptAt) || iso(nowMs), lastAttemptAt: iso(nowMs) };
  const delay = Math.min(MEDIA_RETRY_MAX_MS, MEDIA_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 16));
  const free = typeof freeBytes === 'function' ? freeBytes() : null;
  if (minFreeBytes > 0 && Number.isFinite(free) && free < minFreeBytes) {
    const next = { ...media, ...tried, lastSkip: 'low-disk', nextAttemptAt: iso(nowMs + delay) };
    updateMedia(id, next);
    console.error(`[fireflies] media id=${id} skipped: ${Math.round(free / 1024 / 1024)} MB free on the data disk`);
    return { status: 'low-disk', media: next };
  }

  const result = await persistFirefliesMedia(record, { maxBytes, fetchImpl, kinds: plan.kinds });
  const next = { ...media, ...tried, ...textFor(record) };
  const skips = [];
  for (const kind of plan.kinds) {
    const file = result[kind] || {};
    if (file.path) {
      next[kind] = { bytes: file.bytes };
    } else {
      next[kind] = { skipped: text(file.skipped) || 'unknown' };
      skips.push(next[kind].skipped);
    }
  }
  // savedAt means a file is on disk: kept from an earlier save, set now, or cleared (older
  // records set it even when both downloads were skipped).
  const savedBefore = MEDIA_KINDS.some((kind) => fileSaved(media[kind])) && text(media.savedAt);
  next.savedAt = MEDIA_KINDS.some((kind) => fileSaved(next[kind])) ? (savedBefore || iso(nowMs)) : '';
  next.lastSkip = skips[0] || '';
  next.nextAttemptAt = MEDIA_KINDS.some((kind) => fileWanted(next, kind)) ? iso(nowMs + delay) : '';
  updateMedia(id, next);
  return { status: next.savedAt ? 'saved' : 'retry', media: next };
}

/** What is on disk for a meeting (used by the admin panel + media routes). */
export function describeFirefliesMedia(meetingId) {
  const id = safeId(meetingId);
  if (!id) return { hasVideo: false, hasAudio: false, hasTranscript: false };
  const dir = join(firefliesMediaRoot(), id);
  if (!existsSync(dir)) return { hasVideo: false, hasAudio: false, hasTranscript: false };
  const sizeOf = (name) => {
    const path = join(dir, name);
    try {
      return existsSync(path) ? statSync(path).size : 0;
    } catch {
      return 0;
    }
  };
  return {
    dir,
    hasVideo: sizeOf('video.mp4') > 0,
    videoBytes: sizeOf('video.mp4'),
    hasAudio: sizeOf('audio.mp3') > 0,
    audioBytes: sizeOf('audio.mp3'),
    hasTranscript: sizeOf('transcript.txt') > 0,
    files: readdirSync(dir),
  };
}

export function firefliesMediaFilePath(meetingId, kind = 'video') {
  const id = safeId(meetingId);
  if (!id) return '';
  const name = kind === 'audio' ? 'audio.mp3' : kind === 'transcript' ? 'transcript.txt' : 'video.mp4';
  const path = join(firefliesMediaRoot(), id, name);
  return existsSync(path) ? path : '';
}
