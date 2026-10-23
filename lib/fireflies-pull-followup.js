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
 * paste) never sends a second one. It waits until Fireflies has finished the meeting, so the
 * e-mail carries the summary, or until 20 minutes after the hub first saw it; a live copy is
 * never e-mailed. A send that failed is tried again (firefliesNotifyDue: up to five sends,
 * ten minutes apart). Media follows its own plan (lib/fireflies-media.js firefliesMediaPlan):
 * retries with fresh URLs for two days, and the text files once more when the summary is in.
 *
 * Wired from the ingest loop in server.js as one step.
 */
import { MEDIA_RETRY_WINDOW_MS, firefliesMediaPlan } from './fireflies-media.js';
import {
  firefliesFirstSeenMs,
  listStoredFirefliesMeetings,
  storedMeetingHasTalk,
  storedMeetingIsFinal,
  wasFirefliesMeetingNotified,
} from './fireflies-webhook.js';

const MINUTE_MS = 60 * 1000;
export const FOLLOW_UP_MAX_AGE_MS = 2 * 24 * 60 * MINUTE_MS;
/** A meeting Fireflies has not finished is e-mailed anyway this long after the hub first saw it. */
export const NOTIFY_UNFINISHED_AFTER_MS = 20 * MINUTE_MS;
const NOTIFY_MAX_ATTEMPTS = 5;
const NOTIFY_RETRY_MS = 5 * MINUTE_MS;
// A meeting first seen after an outage still gets its media copied if it is this recent.
const MEDIA_CATCH_UP_MAX_AGE_MS = 30 * 24 * 60 * MINUTE_MS;

// Per process: a meeting whose fetch keeps failing is not retried every minute.
const notifyAttempts = new Map();

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

/**
 * Media is copied for recent meetings, for meetings the hub first saw lately (caught up after an
 * outage, held in the last 30 days), and while a copy is inside its retry window.
 */
function mediaRecent(row, nowMs, maxAgeMs) {
  if (isRecent(row, nowMs, maxAgeMs)) return true;
  const id = text(row?.meetingId);
  if (!id || id.toLowerCase().startsWith('live:')) return false;
  const seen = firefliesFirstSeenMs(row);
  const started = startedAtMs(row);
  if (Number.isFinite(seen) && nowMs - seen <= maxAgeMs && Number.isFinite(started) && nowMs - started <= MEDIA_CATCH_UP_MAX_AGE_MS) return true;
  const first = Date.parse(row?.media?.firstAttemptAt || '');
  return Number.isFinite(first) && nowMs - first <= MEDIA_RETRY_WINDOW_MS + 60 * MINUTE_MS;
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

/** Talk that Fireflies has finished, or that has waited NOTIFY_UNFINISHED_AFTER_MS. Never a live copy. */
export function readyToNotify(row, nowMs = Date.now()) {
  if (!storedMeetingHasTalk(row) || row?.isLive === true) return false;
  if (storedMeetingIsFinal(row, { nowMs })) return true;
  const seen = firefliesFirstSeenMs(row);
  return Number.isFinite(seen) && nowMs - seen >= NOTIFY_UNFINISHED_AFTER_MS;
}

/**
 * Meetings that still need the e-mail, meetings whose media needs a download, and meetings whose
 * text files need writing again now that the final summary is in. Only meetings that started
 * within maxAgeMs are e-mailed: an old meeting whose notified entry was pruned is never sent again.
 */
export function firefliesFollowUpCandidates(meetings = [], {
  nowMs = Date.now(),
  maxAgeMs = FOLLOW_UP_MAX_AGE_MS,
  isNotified = (id) => wasFirefliesMeetingNotified(id, { nowMs }),
} = {}) {
  const notify = [];
  const media = [];
  const textOnly = [];
  for (const row of Array.isArray(meetings) ? meetings : []) {
    if (!row) continue;
    const id = text(row.meetingId);
    if (isRecent(row, nowMs, maxAgeMs) && readyToNotify(row, nowMs) && !isNotified(id)) notify.push(id);
    if (!mediaRecent(row, nowMs, maxAgeMs)) continue;
    const plan = firefliesMediaPlan(row, { nowMs, final: storedMeetingIsFinal(row, { nowMs }) });
    if (plan.due && plan.kinds.length) media.push(id);
    else if (plan.due) textOnly.push(id);
  }
  return { notify, media, text: textOnly };
}

/**
 * notify(payload) is notifyFirefliesRecording with the server's client deps; persistMedia(id)
 * copies one meeting's media as its plan says (server.js persistFirefliesMediaInBackground, which
 * dedupes in-flight downloads and records the media state). Downloads are started, not awaited,
 * so a long video does not hold up the transcript ingest.
 */
export async function runFirefliesPullFollowUp({
  notify,
  persistMedia,
  listMeetings = () => listStoredFirefliesMeetings(),
  isNotified,
  nowMs = Date.now(),
  maxAgeMs = FOLLOW_UP_MAX_AGE_MS,
  maxNotify = 3,
  maxMedia = 2,
  maxText = 5,
  log = console,
} = {}) {
  const summary = { notified: [], mediaStarted: [], textStarted: [] };
  if (!isNotified) isNotified = (id) => wasFirefliesMeetingNotified(id, { nowMs });
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
  const { media: mediaIds, text: textIds } = firefliesFollowUpCandidates(listMeetings(), { nowMs, maxAgeMs, isNotified });
  const start = (id) => Promise.resolve()
    .then(() => persistMedia(id))
    .catch((error) => log.warn?.(`[fireflies] pull follow-up media id=${id} ${text(error?.message) || error}`));
  if (typeof persistMedia !== 'function') return summary;
  // The stored plan paces the retries (media.nextAttemptAt); persistMedia skips an id in flight.
  for (const id of mediaIds.slice(0, maxMedia)) {
    summary.mediaStarted.push(id);
    start(id);
  }
  for (const id of textIds.slice(0, maxText)) {
    summary.textStarted.push(id);
    start(id);
  }
  return summary;
}

export function resetFirefliesFollowUpForTests() {
  notifyAttempts.clear();
}
