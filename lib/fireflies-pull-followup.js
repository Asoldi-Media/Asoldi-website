/**
 * Fireflies follow-up for meetings that arrive through the 60-second pull ingest.
 *
 * The push webhook is refused until its new disk secret is pasted into the Fireflies dashboard
 * (data/webhook-secrets.js), and the pull ingest only stores transcripts and links them to
 * clients. Two things used to happen only in the webhook path:
 *   - the "recording ready" e-mail (notifyFirefliesRecording), and
 *   - copying video and audio to the data dir before Fireflies' signed URLs expire.
 * This runs both for recent pulled meetings, once each. The e-mail goes through the same
 * fireflies-notified.json claim as the webhook, so a webhook for the same meeting (after the
 * paste) never sends a second one.
 *
 * Wired from the ingest loop in server.js with one call; the webhook path is unchanged.
 */
import { listStoredFirefliesMeetings, storedMeetingHasTalk, wasFirefliesMeetingNotified } from './fireflies-webhook.js';

const MINUTE_MS = 60 * 1000;
export const FOLLOW_UP_MAX_AGE_MS = 2 * 24 * 60 * MINUTE_MS;
const NOTIFY_MAX_ATTEMPTS = 5;
const NOTIFY_RETRY_MS = 5 * MINUTE_MS;
const MEDIA_MAX_ATTEMPTS = 3;
const MEDIA_RETRY_MS = 10 * MINUTE_MS;

// Per process: a meeting whose fetch or download keeps failing is not retried every minute.
const notifyAttempts = new Map();
const mediaAttempts = new Map();

function text(value) {
  return String(value ?? '').trim();
}

function startedAtMs(row) {
  return Date.parse(row?.startedAt || row?.dateString || '');
}

/** Recent real meetings only: an old or undated meeting is never e-mailed or downloaded now. */
function isRecent(row, nowMs, maxAgeMs) {
  const id = text(row?.meetingId);
  if (!id || id.toLowerCase().startsWith('live:')) return false;
  const started = startedAtMs(row);
  return Number.isFinite(started) && started >= nowMs - maxAgeMs && started <= nowMs + 60 * MINUTE_MS;
}

function mayTry(attempts, id, nowMs, maxAttempts, retryMs) {
  const row = attempts.get(id);
  if (!row) return true;
  return row.count < maxAttempts && nowMs - row.lastAt >= retryMs;
}

function noteTry(attempts, id, nowMs) {
  const row = attempts.get(id) || { count: 0, lastAt: 0 };
  attempts.set(id, { count: row.count + 1, lastAt: nowMs });
  if (attempts.size > 500) attempts.delete(attempts.keys().next().value);
}

/** Meetings that still need the e-mail, and meetings whose media is not saved yet. */
export function firefliesFollowUpCandidates(meetings = [], {
  nowMs = Date.now(),
  maxAgeMs = FOLLOW_UP_MAX_AGE_MS,
  isNotified = wasFirefliesMeetingNotified,
} = {}) {
  const notify = [];
  const media = [];
  for (const row of Array.isArray(meetings) ? meetings : []) {
    if (!row || !isRecent(row, nowMs, maxAgeMs)) continue;
    const id = text(row.meetingId);
    // The webhook fires when the transcript is ready; the pull path waits for the same moment.
    if (storedMeetingHasTalk(row) && !isNotified(id)) notify.push(id);
    if (!row.media?.savedAt && (text(row.videoDownloadUrl) || text(row.audioUrl))) media.push(id);
  }
  return { notify, media };
}

/**
 * notify(payload) is notifyFirefliesRecording with the server's client deps; persistMedia(id)
 * copies one meeting's media (server.js persistFirefliesMediaInBackground, which dedupes in-flight
 * downloads and records media.savedAt). Downloads are started, not awaited, so a long video does
 * not hold up the transcript ingest.
 */
export async function runFirefliesPullFollowUp({
  notify,
  persistMedia,
  listMeetings = () => listStoredFirefliesMeetings(),
  isNotified = wasFirefliesMeetingNotified,
  nowMs = Date.now(),
  maxAgeMs = FOLLOW_UP_MAX_AGE_MS,
  maxNotify = 3,
  maxMedia = 2,
  log = console,
} = {}) {
  const summary = { notified: [], mediaStarted: [] };
  const { notify: notifyIds } = firefliesFollowUpCandidates(listMeetings(), { nowMs, maxAgeMs, isNotified });
  for (const id of notifyIds) {
    if (typeof notify !== 'function' || summary.notified.length >= maxNotify) break;
    if (!mayTry(notifyAttempts, id, nowMs, NOTIFY_MAX_ATTEMPTS, NOTIFY_RETRY_MS)) continue;
    noteTry(notifyAttempts, id, nowMs);
    try {
      const result = await notify({ meetingId: id, event: 'Transcription completed' });
      summary.notified.push(id);
      log.log?.(`[fireflies] pull follow-up id=${id} sent=${Boolean(result?.sent)} reason=${result?.reason || ''}`);
    } catch (error) {
      log.warn?.(`[fireflies] pull follow-up id=${id} ${text(error?.message) || error}`);
    }
  }

  // Read again: the e-mail step stored fresh video/audio URLs for the meetings it handled.
  const { media: mediaIds } = firefliesFollowUpCandidates(listMeetings(), { nowMs, maxAgeMs, isNotified });
  for (const id of mediaIds) {
    if (typeof persistMedia !== 'function' || summary.mediaStarted.length >= maxMedia) break;
    if (!mayTry(mediaAttempts, id, nowMs, MEDIA_MAX_ATTEMPTS, MEDIA_RETRY_MS)) continue;
    noteTry(mediaAttempts, id, nowMs);
    summary.mediaStarted.push(id);
    Promise.resolve()
      .then(() => persistMedia(id))
      .catch((error) => log.warn?.(`[fireflies] pull follow-up media id=${id} ${text(error?.message) || error}`));
  }
  return summary;
}

export function resetFirefliesFollowUpForTests() {
  notifyAttempts.clear();
  mediaAttempts.clear();
}
