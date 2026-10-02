/**
 * Copy Fireflies media (video / audio) + transcript to the persistent data dir so admins can review
 * a sales meeting after Fireflies' signed download URLs (~24h) have expired.
 *
 * Files: <dataDir>/fireflies-media/<meetingId>/{video.mp4,audio.mp3,transcript.txt,summary.json}
 * Size cap per file: FIREFLIES_MEDIA_MAX_MB (default 400; 0 disables media downloads).
 */

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getPersistentDataDir } from '../data/storage-path.js';

const DEFAULT_MAX_MB = 400;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;

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
 * @returns {{ dir, transcriptPath, summaryPath, video: object, audio: object }}
 */
export async function persistFirefliesMedia(record = {}, { maxBytes = readMediaMaxBytes(), fetchImpl = fetch, skipMedia = false } = {}) {
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
  result.video = await downloadToFile(record.videoDownloadUrl, join(dir, 'video.mp4'), { maxBytes, fetchImpl });
  result.audio = await downloadToFile(record.audioUrl, join(dir, 'audio.mp3'), { maxBytes, fetchImpl });
  invalidateMeetingVideoCache();
  return result;
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
