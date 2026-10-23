import { createHmac, timingSafeEqual } from 'crypto';
import { readFirefliesStore, storeRecordsDiffer, updateFirefliesStore } from './fireflies-store.js';
import { ensureFirefliesWebhookSecrets, recordFirefliesWebhookVerified } from '../data/webhook-secrets.js';
import { sendEmail } from './email.js';
import { noteSecurityEvent } from './security-counters.js';
import { SafeModeBlockedError, guardExternal, safeModeAllows } from './safe-mode.js';
import { firefliesGraphql, firefliesGraphqlErrorMessage } from './fireflies-graphql.js';

const DEFAULT_NOTIFY_EMAIL = 'ansatte@asoldi.com';
// Covers the whole response including the body (lib/fireflies-graphql.js).
const FETCH_TIMEOUT_MS = 20_000;
const VIEW_URL_PREFIX = 'https://app.fireflies.ai/view/';
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// Meeting records feed the offer email + admin review, so keep them a full year (notified-map stays 90 days).
const MEETING_RETENTION_MS = 365 * DAY_MS;
const NOTIFIED_RETENTION_MS = 90 * DAY_MS;
// Bookkeeping that alone never makes a stored record worth rewriting.
const BOOKKEEPING_FIELDS = ['at', 'updatedAt', 'listedAt'];

/** Fireflies summary_status values after which the transcript and summary stop changing. */
export const FINAL_SUMMARY_STATUSES = new Set(['processed', 'skipped', 'failed']);
/**
 * Fetched talk that Fireflies gave no summary status for counts as final this long after the hub
 * had it as it is (first seen, or since the meeting stopped being live).
 */
export const FINAL_WITHOUT_STATUS_MS = 30 * MINUTE_MS;
/** A transcript that is not final yet is fetched again with a doubling pause, and given up this long after it was first seen. */
export const REFETCH_GIVE_UP_MS = 7 * DAY_MS;
const REFETCH_BASE_MS = 2 * MINUTE_MS;
const REFETCH_LIVE_MS = 3 * MINUTE_MS;
const REFETCH_MAX_MS = 6 * 60 * MINUTE_MS;
/** A failed recording e-mail is sent again up to this many times in all, at least NOTIFY_RETRY_MS apart. */
export const NOTIFY_MAX_SENDS = 5;
export const NOTIFY_RETRY_MS = 10 * MINUTE_MS;
// Still 'sending' after this long: the process died between claim and send.
const NOTIFY_STALE_SENDING_MS = 30 * MINUTE_MS;

const TRANSCRIPT_QUERY = `
query Transcript($transcriptId: String!) {
  transcript(id: $transcriptId) {
    id
    title
    date
    dateString
    duration
    is_live
    transcript_url
    audio_url
    video_url
    meeting_link
    host_email
    organizer_email
    participants
    meeting_info {
      summary_status
      silent_meeting
    }
    meeting_attendees {
      displayName
      email
      name
    }
    user {
      email
      name
    }
    sentences {
      speaker_name
      text
      raw_text
    }
    summary {
      overview
      short_summary
      short_overview
      action_items
      gist
      bullet_gist
      keywords
      outline
    }
  }
}
`.trim();

function sanitize(value = '') {
  return String(value ?? '').trim();
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function splitSecrets(value = '') {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((entry) => sanitize(entry))
    .filter(Boolean);
}

function equal(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function newestStampMs(values = []) {
  const stamps = values.map((value) => Date.parse(String(value || ''))).filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : NaN;
}

/** Drops entries whose newest stamp is older than the cutoff. True when something was removed. */
function pruneByStamp(map, cutoffMs, nowMs, stampsOf) {
  const cutoff = nowMs - cutoffMs;
  let removed = false;
  for (const [key, value] of Object.entries(map)) {
    const newest = newestStampMs(stampsOf(value));
    if (Number.isFinite(newest) && newest < cutoff) {
      delete map[key];
      removed = true;
    }
  }
  return removed;
}

// A record lives a year after it was last stored, linked or fetched, not after it was first seen.
function pruneMeetings(map, nowMs) {
  return pruneByStamp(map, MEETING_RETENTION_MS, nowMs, (row) => (isObject(row)
    ? [row.at, row.updatedAt, row.fetchedAt, row.firstSeenAt, row.match?.linkedAt]
    : []));
}

function pruneNotified(map, nowMs) {
  return pruneByStamp(map, NOTIFIED_RETENTION_MS, nowMs, (value) => (typeof value === 'string'
    ? [value]
    : [value?.at, value?.lastAttemptAt]));
}

/** FIREFLIES_API_KEY, or FIREFLIES_API (the name set in hPanel) as an alias. */
export function resolveFirefliesApiKey(env = process.env) {
  const primary = sanitize(env.FIREFLIES_API_KEY);
  if (primary) return { apiKey: primary, source: 'FIREFLIES_API_KEY' };
  const alias = sanitize(env.FIREFLIES_API);
  if (alias) return { apiKey: alias, source: 'FIREFLIES_API' };
  return { apiKey: '', source: '' };
}

/**
 * Trusted webhook credentials come only from the data disk (data/webhook-secrets.js).
 * The env values FIREFLIES_WEBHOOK_SECRET(S) and FIREFLIES_WEBHOOK_TOKEN are retired:
 * they are kept as `retired*` only so a request that uses them is recognised and refused.
 * Pass `webhookSecrets` (or null) to skip the disk in tests.
 */
export function readFirefliesWebhookConfig(env = process.env, { webhookSecrets } = {}) {
  const data = webhookSecrets === undefined ? ensureFirefliesWebhookSecrets() : webhookSecrets;
  const retiredSecrets = [
    ...splitSecrets(env.FIREFLIES_WEBHOOK_SECRET),
    ...splitSecrets(env.FIREFLIES_WEBHOOK_SECRETS),
  ];
  const { apiKey, source: apiKeySource } = resolveFirefliesApiKey(env);
  return {
    secrets: data?.secret ? [sanitize(data.secret)] : [],
    token: sanitize(data?.token),
    acceptQueryToken: data ? data.acceptQueryToken !== false : false,
    retiredSecrets: [...new Set(retiredSecrets)],
    retiredToken: sanitize(env.FIREFLIES_WEBHOOK_TOKEN),
    apiKey,
    apiKeySource,
    notifyEmail: sanitize(env.FIREFLIES_NOTIFY_EMAIL) || DEFAULT_NOTIFY_EMAIL,
  };
}

export function isFirefliesWebhookConfigured(config = readFirefliesWebhookConfig()) {
  return Boolean(config.token || config.secrets.length);
}

export function verifyFirefliesSignature(secret, headers = {}, rawBody = '') {
  const header = sanitize(headers['x-hub-signature'] || headers['X-Hub-Signature']);
  const key = sanitize(secret);
  if (!key || !header) return false;
  const expectedHex = createHmac('sha256', key).update(String(rawBody || ''), 'utf8').digest('hex');
  const expected = `sha256=${expectedHex}`;
  const given = `sha256=${header.replace(/^sha256=/i, '').toLowerCase()}`;
  return equal(expected, given);
}

/** Pure decision: which credential (if any) the request carries. */
export function decideFirefliesWebhookAuth({ headers = {}, query = {}, rawBody = '' } = {}, config = {}) {
  const secrets = Array.isArray(config.secrets) ? config.secrets : [];
  const retiredSecrets = Array.isArray(config.retiredSecrets) ? config.retiredSecrets : [];
  const queryToken = sanitize(query?.token || query?.secret);
  if (secrets.some((secret) => verifyFirefliesSignature(secret, headers, rawBody))) {
    return { ok: true, via: 'signature' };
  }
  if (config.token && config.acceptQueryToken !== false && queryToken && equal(config.token, queryToken)) {
    return { ok: true, via: 'token' };
  }
  const retiredToken = sanitize(config.retiredToken);
  if (
    (retiredToken && queryToken && equal(retiredToken, queryToken))
    || retiredSecrets.some((secret) => verifyFirefliesSignature(secret, headers, rawBody))
  ) {
    return { ok: false, status: 401, reason: 'retired-credential' };
  }
  if (!isFirefliesWebhookConfigured({ token: config.token, secrets })) {
    return { ok: false, status: 503, reason: 'not-configured' };
  }
  return { ok: false, status: 401, reason: 'unauthorized' };
}

function recordFirefliesWebhookVerdict(verdict, config) {
  if (verdict.ok) {
    // Only disk credentials verify. Record which one, and only while it is still the stored one.
    const credential = verdict.via === 'token' ? config.token : config.secrets[0];
    recordFirefliesWebhookVerified(`data-${verdict.via}`, { credential });
    return;
  }
  if (verdict.reason === 'retired-credential') {
    noteSecurityEvent('fireflies-webhook-retired-credential');
    console.warn('[fireflies] refused a webhook that used a retired env credential');
  } else if (verdict.reason === 'unauthorized') {
    noteSecurityEvent('fireflies-webhook-rejected');
  }
}

/**
 * Called without `config` by the live webhook route: reads the disk credentials and
 * records the outcome (last verified source, rejection counters). Tests pass a config.
 */
export function authorizeFirefliesWebhook(request = {}, config) {
  const live = config === undefined;
  const effective = live ? readFirefliesWebhookConfig() : config;
  const verdict = decideFirefliesWebhookAuth(request, effective);
  if (live) recordFirefliesWebhookVerdict(verdict, effective);
  return verdict;
}

export function meetingIdFromPayload(payload = {}) {
  return sanitize(
    payload.meeting_id
    || payload.meetingId
    || payload.transcript_id
    || payload.transcriptId
    || payload.id
  );
}

export function eventFromPayload(payload = {}) {
  return sanitize(payload.event || payload.eventType || payload.event_type);
}

export function isFirefliesTranscriptReadyEvent(event = '') {
  const value = sanitize(event).toLowerCase();
  if (!value) return true;
  if (value === 'meeting.bot_joined' || value === 'bot_joined') return false;
  return (
    value === 'meeting.transcribed'
    || value === 'meeting.summarized'
    || value === 'transcription completed'
    || value.includes('transcri')
    || value.includes('summar')
  );
}

function inviteeLine(entry = {}) {
  if (typeof entry === 'string') return sanitize(entry);
  const name = sanitize(entry.name || entry.displayName || entry.display_name);
  const email = sanitize(entry.email);
  if (name && email) return `${name} <${email}>`;
  return name || email;
}

export function formatFirefliesTranscript(meeting = {}) {
  const sentences = asList(meeting.sentences);
  if (sentences.length) {
    return sentences.map((item) => {
      const speaker = sanitize(item?.speaker_name || item?.speakerName || 'Ukjent');
      const text = sanitize(item?.text || item?.raw_text || item?.rawText);
      return text ? `${speaker}: ${text}` : '';
    }).filter(Boolean).join('\n');
  }
  return sanitize(meeting.transcript || meeting.transcript_text);
}

export function formatFirefliesSummary(meeting = {}) {
  const summary = meeting.summary;
  if (typeof summary === 'string') return sanitize(summary);
  if (!summary || typeof summary !== 'object') {
    return sanitize(meeting.overview || meeting.short_summary);
  }
  return sanitize(
    summary.overview
    || summary.short_summary
    || summary.short_overview
    || summary.gist
    || summary.bullet_gist
    || summary.outline
  );
}

export function formatFirefliesActionItems(meeting = {}) {
  const raw = meeting.summary?.action_items ?? meeting.action_items ?? meeting.actionItems;
  if (Array.isArray(raw)) {
    return raw.map((item) => (
      typeof item === 'string' ? sanitize(item) : sanitize(item?.text || item?.description || item?.title)
    )).filter(Boolean);
  }
  const text = sanitize(raw);
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => line.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
}

function formatWhen(meeting = {}) {
  const iso = sanitize(meeting.dateString);
  const ms = iso ? Date.parse(iso) : Number(meeting.date);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('nb-NO', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Europe/Oslo',
  });
}

function fallbackViewUrl(meetingId) {
  const id = sanitize(meetingId);
  return id ? `${VIEW_URL_PREFIX}${encodeURIComponent(id)}` : '';
}

export function firefliesViewUrl(meeting = {}) {
  return sanitize(meeting.transcript_url || meeting.transcriptUrl) || fallbackViewUrl(meetingIdFromPayload(meeting));
}

export function firefliesVideoUrl(meeting = {}) {
  return firefliesViewUrl(meeting) || sanitize(meeting.video_url || meeting.videoUrl);
}

function recordedByLine(meeting = {}) {
  const user = meeting.user && typeof meeting.user === 'object' ? meeting.user : {};
  return inviteeLine({
    name: user.name,
    email: user.email || meeting.organizer_email || meeting.host_email,
  }) || sanitize(meeting.organizer_email || meeting.host_email);
}

function attendeeLines(meeting = {}) {
  const fromObjects = asList(meeting.meeting_attendees || meeting.attendees).map(inviteeLine).filter(Boolean);
  if (fromObjects.length) return fromObjects;
  return asList(meeting.participants).map(inviteeLine).filter(Boolean);
}

function attendeeEmails(meeting = {}) {
  const out = new Set();
  for (const entry of [...asList(meeting.meeting_attendees || meeting.attendees), ...asList(meeting.participants)]) {
    const source = typeof entry === 'string' ? entry : sanitize(entry?.email);
    const matches = String(source || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    for (const email of matches) out.add(email.toLowerCase());
  }
  return [...out];
}

function startedAtIso(meeting = {}) {
  const iso = sanitize(meeting.dateString);
  const ms = iso ? Date.parse(iso) : Number(meeting.date);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

function summaryStatusOf(meeting = {}) {
  const info = isObject(meeting.meeting_info) ? meeting.meeting_info : null;
  if (!info || info.summary_status == null) return undefined;
  return sanitize(info.summary_status).toLowerCase();
}

/**
 * Fireflies' processing state, only for the fields the answer carried: an unknown field stays
 * undefined so a merge keeps the stored value. `final` means Fireflies has finished this copy.
 */
function processingState(meeting = {}) {
  const isLive = typeof meeting.is_live === 'boolean' ? meeting.is_live : undefined;
  const summaryStatus = summaryStatusOf(meeting);
  const info = isObject(meeting.meeting_info) ? meeting.meeting_info : {};
  return {
    isLive,
    summaryStatus,
    silent: typeof info.silent_meeting === 'boolean' ? info.silent_meeting : undefined,
    sentenceCount: Array.isArray(meeting.sentences) ? meeting.sentences.length : undefined,
    final: isLive === undefined && summaryStatus === undefined
      ? undefined
      : isLive !== true && FINAL_SUMMARY_STATUSES.has(summaryStatus),
  };
}

export function buildFirefliesMeetingRecord(payload = {}, transcript = {}) {
  const meeting = { ...payload, ...transcript };
  const meetingId = meetingIdFromPayload(transcript) || meetingIdFromPayload(payload);
  const title = sanitize(meeting.title || meeting.meeting_title) || 'Fireflies-møte';
  const recordedBy = recordedByLine(meeting);
  const attendees = attendeeLines(meeting);
  const transcriptUrl = firefliesViewUrl({ ...meeting, id: meetingId });
  const videoDownloadUrl = sanitize(meeting.video_url || meeting.videoUrl);
  const audioUrl = sanitize(meeting.audio_url || meeting.audioUrl);
  const meetingLink = sanitize(meeting.meeting_link || meeting.meetingLink);
  const videoUrl = transcriptUrl || videoDownloadUrl || meetingLink;
  const user = meeting.user && typeof meeting.user === 'object' ? meeting.user : {};
  return {
    meetingId,
    event: eventFromPayload(payload),
    title,
    when: formatWhen(meeting),
    startedAt: startedAtIso(meeting),
    durationMinutes: meeting.duration == null || meeting.duration === '' ? '' : Number(meeting.duration),
    recordedBy,
    hostEmail: sanitize(meeting.organizer_email || meeting.host_email || user.email).toLowerCase(),
    attendees,
    attendeeEmails: attendeeEmails(meeting),
    videoUrl,
    videoDownloadUrl,
    transcriptUrl,
    audioUrl,
    meetingLink,
    transcript: formatFirefliesTranscript(meeting),
    summary: formatFirefliesSummary(meeting),
    actionItems: formatFirefliesActionItems(meeting),
    keywords: asList(meeting.summary?.keywords || meeting.keywords).map((item) => sanitize(item)).filter(Boolean),
    ...processingState(meeting),
  };
}

/**
 * A row from the transcripts list: metadata only. Its summary_status is kept as
 * listedSummaryStatus, because the stored text still comes from the last full fetch.
 */
export function buildFirefliesListRecord(row = {}) {
  const meetingId = sanitize(row?.id || row?.meetingId);
  const meetingLink = sanitize(row?.meeting_link || row?.meetingLink);
  const transcriptUrl = firefliesViewUrl({ ...row, id: meetingId });
  return {
    meetingId,
    title: sanitize(row?.title) || 'Fireflies-møte',
    when: formatWhen(row),
    startedAt: startedAtIso(row),
    durationMinutes: row?.duration == null || row?.duration === '' ? '' : Number(row.duration),
    meetingLink,
    transcriptUrl,
    videoUrl: transcriptUrl || meetingLink,
    listedSummaryStatus: summaryStatusOf(row) || '',
  };
}

function confidenceLabel(confidence = '') {
  if (confidence === 'high') return 'høy sikkerhet';
  if (confidence === 'medium') return 'middels sikkerhet – bekreft i admin';
  return '';
}

export function buildFirefliesNotifyEmail(record = {}, notifyEmail = DEFAULT_NOTIFY_EMAIL) {
  const title = sanitize(record.title) || 'Fireflies-møte';
  const recordedBy = sanitize(record.recordedBy);
  const attendees = Array.isArray(record.attendees) ? record.attendees.filter(Boolean) : [];
  const videoUrl = sanitize(record.videoUrl);
  const videoDownloadUrl = sanitize(record.videoDownloadUrl);
  const transcript = sanitize(record.transcript);
  const summary = sanitize(record.summary);
  const actionItems = Array.isArray(record.actionItems) ? record.actionItems.filter(Boolean) : [];
  const match = record.match && typeof record.match === 'object' ? record.match : null;
  const matchLine = match?.clientId
    ? `Koblet til kunde: ${sanitize(match.businessName) || match.clientId} (${confidenceLabel(match.confidence)})`
    : 'Kunde: ikke funnet automatisk — koble manuelt under Tilbud i admin.';
  const lines = [
    `Møte: ${title}`,
    record.when ? `Tid: ${record.when}` : '',
    recordedBy ? `Salgsrep (Fireflies): ${recordedBy}` : '',
    attendees.length ? `Deltakere: ${attendees.join(', ')}` : '',
    matchLine,
    videoUrl ? `Video: ${videoUrl}` : 'Video: ingen lenke i webhooken — åpne opptaket i Fireflies.',
    videoDownloadUrl && videoDownloadUrl !== videoUrl ? `Video-nedlasting (utløper ~24t): ${videoDownloadUrl}` : '',
    record.transcriptUrl && record.transcriptUrl !== videoUrl ? `Fireflies: ${record.transcriptUrl}` : '',
    '',
    summary ? `Sammendrag:\n${summary}` : '',
    actionItems.length ? `Action items:\n${actionItems.map((item) => `- ${item}`).join('\n')}` : '',
    transcript ? `Transkript:\n${transcript}` : 'Ingen transkript i denne webhooken.',
  ].filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''));

  const videoHtml = videoUrl
    ? `<p style="margin:16px 0 8px;">
        <a href="${escapeHtml(videoUrl)}" style="display:inline-block;background:#FF5B00;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:700;">Åpne video</a>
      </p>
      <p style="margin:0 0 16px;"><a href="${escapeHtml(videoUrl)}">${escapeHtml(videoUrl)}</a></p>`
    : '<p style="margin:0 0 16px;">Ingen videolenke i webhooken — åpne opptaket i Fireflies.</p>';

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.45;">
      <p style="margin:0 0 12px;"><strong>${escapeHtml(title)}</strong></p>
      ${record.when ? `<p style="margin:0 0 8px;">Tid: ${escapeHtml(record.when)}</p>` : ''}
      ${recordedBy ? `<p style="margin:0 0 8px;">Salgsrep: ${escapeHtml(recordedBy)}</p>` : ''}
      ${attendees.length ? `<p style="margin:0 0 8px;">Deltakere: ${escapeHtml(attendees.join(', '))}</p>` : ''}
      <p style="margin:0 0 8px;">${escapeHtml(matchLine)}</p>
      ${videoHtml}
      ${summary ? `<h3 style="margin:16px 0 8px;font-size:15px;">Sammendrag</h3><pre style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(summary)}</pre>` : ''}
      ${actionItems.length ? `<h3 style="margin:16px 0 8px;font-size:15px;">Action items</h3><ul>${actionItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
      ${transcript ? `<h3 style="margin:16px 0 8px;font-size:15px;">Transkript</h3><p style="margin:0 0 8px;color:#5b5b5b;">Full tekst ligger også som vedlegg.</p>` : ''}
    </div>
  `;

  const attachments = transcript
    ? [{
      filename: `fireflies-transcript-${sanitize(record.meetingId) || 'meeting'}.txt`,
      content: Buffer.from(transcript, 'utf8'),
      contentType: 'text/plain; charset=utf-8',
    }]
    : [];

  return {
    to: notifyEmail,
    subject: `Fireflies: ${title}${recordedBy ? ` — ${recordedBy}` : ''}`,
    text: lines.join('\n'),
    html,
    attachments,
    meetingId: sanitize(record.meetingId),
    videoUrl,
    transcript: record.transcript,
    summary,
    actionItems,
  };
}

/**
 * One entry of fireflies-notified.json: { at, state: 'sending' | 'sent' | 'failed', attempts,
 * lastAttemptAt, error }. Older files hold a bare ISO string, which means sent.
 */
function normalizeNotifyEntry(value) {
  if (typeof value === 'string') {
    const at = sanitize(value);
    return at ? { at, state: 'sent', attempts: 1, lastAttemptAt: at, error: '' } : null;
  }
  if (!isObject(value)) return null;
  return {
    at: sanitize(value.at),
    state: ['sending', 'sent', 'failed'].includes(value.state) ? value.state : 'sent',
    attempts: Math.max(0, Math.round(Number(value.attempts) || 0)),
    lastAttemptAt: sanitize(value.lastAttemptAt || value.at),
    error: sanitize(value.error).slice(0, 300),
  };
}

export function readFirefliesNotifyState(meetingId) {
  const id = sanitize(meetingId);
  if (!id) return null;
  return normalizeNotifyEntry(readFirefliesStore('notified')[id]);
}

/**
 * May the recording e-mail go out (again) now? Never sent; a failed send with sends left, at
 * least NOTIFY_RETRY_MS after the last one; or a 'sending' claim whose process died.
 */
export function firefliesNotifyDue(entry, { nowMs = Date.now() } = {}) {
  if (!entry) return true;
  if (entry.state === 'sent' || entry.attempts >= NOTIFY_MAX_SENDS) return false;
  const last = Date.parse(entry.lastAttemptAt || entry.at || '');
  const since = Number.isFinite(last) ? nowMs - last : Infinity;
  if (entry.state === 'failed') return since >= NOTIFY_RETRY_MS;
  return since >= NOTIFY_STALE_SENDING_MS;
}

/** True while the e-mail is sent, being sent, or failed and not due for another try. */
export function wasFirefliesMeetingNotified(meetingId, { nowMs = Date.now() } = {}) {
  const id = sanitize(meetingId);
  if (!id) return false;
  const entry = readFirefliesNotifyState(id);
  return Boolean(entry) && !firefliesNotifyDue(entry, { nowMs });
}

/** Record how a claimed send ended: state 'sent' (the default) or 'failed' with the error. */
export function markFirefliesMeetingNotified(meetingId, { state = 'sent', error = '', nowMs = Date.now() } = {}) {
  const id = sanitize(meetingId);
  if (!id) return;
  updateFirefliesStore('notified', (map) => {
    pruneNotified(map, nowMs);
    const entry = normalizeNotifyEntry(map[id]);
    map[id] = {
      at: entry?.at || isoAt(nowMs),
      state: state === 'failed' ? 'failed' : 'sent',
      attempts: Math.max(1, entry?.attempts || 0),
      lastAttemptAt: entry?.lastAttemptAt || isoAt(nowMs),
      error: state === 'failed' ? sanitize(error).slice(0, 300) : '',
    };
    return true;
  }, { nowMs });
}

/**
 * Claims the e-mail for this meeting ('sending') and returns true, or returns false when it is
 * sent, being sent, or not due for another try. Check and write happen under the file lock
 * with no await between them, so the webhook, the pull follow-up
 * (lib/fireflies-pull-followup.js) and a second hub process cannot both send it.
 */
export function claimFirefliesMeetingNotification(meetingId, { nowMs = Date.now() } = {}) {
  const id = sanitize(meetingId);
  if (!id) return false;
  let claimed = false;
  updateFirefliesStore('notified', (map) => {
    const pruned = pruneNotified(map, nowMs);
    const entry = normalizeNotifyEntry(map[id]);
    if (!firefliesNotifyDue(entry, { nowMs })) return pruned;
    map[id] = {
      at: entry?.at || isoAt(nowMs),
      state: 'sending',
      attempts: (entry?.attempts || 0) + 1,
      lastAttemptAt: isoAt(nowMs),
      error: '',
    };
    claimed = true;
    return true;
  }, { nowMs });
  return claimed;
}

function meetingsMap() {
  return readFirefliesStore('meetings');
}

export function readStoredFirefliesMeeting(meetingId) {
  const id = sanitize(meetingId);
  if (!id) return null;
  const row = meetingsMap()[id];
  return isObject(row) ? { ...row } : null;
}

export function readStoredFirefliesMeetingMap() {
  return { ...meetingsMap() };
}

/** When the hub first saw this meeting (ms, NaN when unknown). */
export function firefliesFirstSeenMs(row = {}) {
  const seen = Date.parse(row?.firstSeenAt || '');
  if (Number.isFinite(seen)) return seen;
  // Records from before firstSeenAt: the earliest stamp they carry.
  const stamps = [row?.startedAt, row?.at].map((value) => Date.parse(value || '')).filter(Number.isFinite);
  return stamps.length ? Math.min(...stamps) : NaN;
}

/** Since when the hub has had this copy as it is: first seen, or when the meeting stopped being live (ms). */
export function firefliesSettledSinceMs(row = {}) {
  const seen = firefliesFirstSeenMs(row);
  const ended = Date.parse(row?.liveEndedAt || '');
  if (Number.isFinite(ended) && (!Number.isFinite(seen) || ended > seen)) return ended;
  return seen;
}

/**
 * The stored text is Fireflies' live captions: the meeting is running, or it ended and the
 * finished copy has not replaced them yet. Never final, never e-mailed, never linked to a new client.
 */
export function storedMeetingIsPartial(row = {}) {
  if (!isObject(row)) return false;
  if (row.isLive === true) return true;
  return row.partial === true && !FINAL_SUMMARY_STATUSES.has(sanitize(row.summaryStatus).toLowerCase());
}

/**
 * Fireflies has finished this copy: not live, and summary_status is processed, skipped or failed.
 * Without a status: live captions kept after the call never are; a row stored before the hub
 * kept Fireflies' state is final only with a summary (otherwise one fetch learns its status);
 * fetched talk is final FINAL_WITHOUT_STATUS_MS after the hub had it as it is.
 */
export function storedMeetingIsFinal(row = {}, { nowMs = Date.now() } = {}) {
  if (!isObject(row) || row.isLive === true) return false;
  const status = sanitize(row.summaryStatus).toLowerCase();
  if (FINAL_SUMMARY_STATUSES.has(status)) return true;
  if (status && status !== 'default') return false;
  if (row.partial === true || !storedMeetingHasTalk(row)) return false;
  if (!sanitize(row.fetchedAt)) return Boolean(sanitize(row.summary));
  const settled = firefliesSettledSinceMs(row);
  return Number.isFinite(settled) && nowMs - settled >= FINAL_WITHOUT_STATUS_MS;
}

/** Final with no talk (silent, or too short to transcribe): never fetched again. */
export function storedMeetingIsEmptyFinal(row = {}, { nowMs = Date.now() } = {}) {
  return storedMeetingIsFinal(row, { nowMs }) && !storedMeetingHasTalk(row);
}

function realTitle(value = '') {
  const title = sanitize(value);
  return title && title !== 'Fireflies-møte' ? title : '';
}

/**
 * Merge a newer copy of a meeting into the stored one. Metadata that the newer copy lacks
 * (host, recorder, event, attendees, start, duration, links) is kept. Transcript and summary
 * come from the newer copy unless the stored one is final and the newer one is not (a live or
 * still-processing copy never replaces finished text); the processing state moves with the text.
 * Live captions stay marked `partial` until a copy that is not live brings its own text, so the
 * empty answer Fireflies gives for a few minutes after the call never turns them into a final copy.
 */
export function mergeStoredFirefliesRecord(current = {}, next = {}, { nowMs = Date.now() } = {}) {
  const prev = isObject(current) ? current : {};
  const incoming = isObject(next) ? next : {};
  const keepList = (value, fallback) => (Array.isArray(value) && value.length ? value : fallback);
  const prevList = (key) => (Array.isArray(prev[key]) ? prev[key] : []);
  const replaces = !(incoming.final === false && storedMeetingIsFinal(prev, { nowMs }));
  const text = (key) => {
    const value = sanitize(incoming[key]);
    const kept = sanitize(prev[key]);
    return value && (replaces || !kept) ? value : kept;
  };
  const list = (key) => {
    const value = Array.isArray(incoming[key]) && incoming[key].length ? incoming[key] : null;
    return value && (replaces || !prevList(key).length) ? value : prevList(key);
  };
  const state = (key) => (replaces && incoming[key] !== undefined ? incoming[key] : prev[key]);
  const known = Object.keys(prev).length > 0;
  // Captions stay partial until a copy that is not live brings its own text, or Fireflies says it
  // is done (then the captions are all there is).
  const takesTranscript = Boolean(sanitize(incoming.transcript)) && (replaces || !sanitize(prev.transcript));
  const prevPartial = prev.partial === true || (prev.partial === undefined && prev.isLive === true && Boolean(sanitize(prev.transcript)));
  const partial = takesTranscript
    ? incoming.isLive === true
    : prevPartial && !FINAL_SUMMARY_STATUSES.has(sanitize(state('summaryStatus')).toLowerCase());
  const liveEndedAt = prev.isLive === true && incoming.isLive === false ? isoAt(nowMs) : sanitize(prev.liveEndedAt);
  return {
    ...prev,
    ...incoming,
    meetingId: sanitize(incoming.meetingId || prev.meetingId),
    event: sanitize(incoming.event) || sanitize(prev.event),
    title: realTitle(incoming.title) || realTitle(prev.title) || sanitize(incoming.title) || sanitize(prev.title),
    when: sanitize(incoming.when) || sanitize(prev.when),
    startedAt: sanitize(incoming.startedAt) || sanitize(prev.startedAt),
    durationMinutes: incoming.durationMinutes === '' || incoming.durationMinutes == null
      ? (prev.durationMinutes ?? '')
      : incoming.durationMinutes,
    recordedBy: sanitize(incoming.recordedBy) || sanitize(prev.recordedBy),
    hostEmail: sanitize(incoming.hostEmail) || sanitize(prev.hostEmail),
    transcript: text('transcript'),
    summary: text('summary'),
    actionItems: list('actionItems'),
    keywords: list('keywords'),
    attendees: keepList(incoming.attendees, prevList('attendees')),
    attendeeEmails: keepList(incoming.attendeeEmails, prevList('attendeeEmails')),
    isLive: state('isLive'),
    summaryStatus: state('summaryStatus'),
    silent: state('silent'),
    sentenceCount: state('sentenceCount'),
    final: state('final'),
    // Only on the rows they apply to: unset fields are not written and change nothing.
    partial: partial ? true : undefined,
    liveEndedAt: liveEndedAt || undefined,
    firstSeenAt: sanitize(prev.firstSeenAt)
      || (known && Number.isFinite(firefliesFirstSeenMs(prev)) ? isoAt(firefliesFirstSeenMs(prev)) : '')
      || sanitize(incoming.firstSeenAt)
      || isoAt(nowMs),
    match: incoming.match || prev.match || null,
    media: incoming.media || prev.media || null,
    videoUrl: sanitize(incoming.videoUrl) || sanitize(prev.videoUrl),
    videoDownloadUrl: sanitize(incoming.videoDownloadUrl) || sanitize(prev.videoDownloadUrl),
    audioUrl: sanitize(incoming.audioUrl) || sanitize(prev.audioUrl),
    meetingLink: sanitize(incoming.meetingLink) || sanitize(prev.meetingLink),
    transcriptUrl: sanitize(incoming.transcriptUrl) || sanitize(prev.transcriptUrl),
  };
}

/** Merge one record into the map. Bookkeeping alone is no change; a change stamps `at`. */
function upsertInto(map, record, nowMs) {
  const id = sanitize(record?.meetingId);
  if (!id) return null;
  const current = isObject(map[id]) ? map[id] : null;
  const next = mergeStoredFirefliesRecord(current || {}, record, { nowMs });
  const changed = !current || storeRecordsDiffer(current, next, BOOKKEEPING_FIELDS);
  if (changed) {
    next.at = isoAt(nowMs);
    map[id] = next;
  }
  return { id, isNew: !current, changed, previous: current, record: map[id] };
}

/** Store (merge) one meeting record. Returns the stored record, or null without an id. */
export function storeFirefliesMeeting(record = {}, { nowMs = Date.now() } = {}) {
  if (!sanitize(record?.meetingId)) return null;
  let stored = null;
  updateFirefliesStore('meetings', (map) => {
    const pruned = pruneMeetings(map, nowMs);
    const result = upsertInto(map, record, nowMs);
    stored = result.record;
    return pruned || result.changed;
  }, { nowMs });
  return stored ? { ...stored } : null;
}

/** Store several records in one write (one per ingest tick), and only when one of them changed. */
export function upsertStoredFirefliesMeetings(records = [], { nowMs = Date.now() } = {}) {
  const results = [];
  const rows = (Array.isArray(records) ? records : []).filter((row) => sanitize(row?.meetingId));
  if (!rows.length) return results;
  updateFirefliesStore('meetings', (map) => {
    let changed = pruneMeetings(map, nowMs);
    for (const record of rows) {
      const result = upsertInto(map, record, nowMs);
      results.push(result);
      if (result.changed) changed = true;
    }
    return changed;
  }, { nowMs });
  return results;
}

/**
 * Store a page of the transcripts list (buildFirefliesListRecord rows) in one write. When a
 * row's summary_status changed since it was last listed, one full fetch is queued
 * (fetch.queuedAt) unless the stored text is already complete. Per row:
 * { id, isNew, changed, queued, record }.
 */
export function upsertListedFirefliesMeetings(listRecords = [], { nowMs = Date.now() } = {}) {
  const results = [];
  const rows = (Array.isArray(listRecords) ? listRecords : []).filter((row) => sanitize(row?.meetingId));
  if (!rows.length) return results;
  updateFirefliesStore('meetings', (map) => {
    let changed = pruneMeetings(map, nowMs);
    for (const listed of rows) {
      const id = sanitize(listed.meetingId);
      const current = isObject(map[id]) ? map[id] : null;
      const next = mergeStoredFirefliesRecord(current || {}, listed, { nowMs });
      next.listedAt = isoAt(nowMs);
      const status = sanitize(listed.listedSummaryStatus).toLowerCase();
      let queued = false;
      // New since the last listing, and not what the stored text already reflects.
      if (current && status
        && status !== sanitize(current.listedSummaryStatus).toLowerCase()
        && status !== sanitize(current.summaryStatus).toLowerCase()) {
        if (FINAL_SUMMARY_STATUSES.has(status) && current.isLive !== true && sanitize(current.transcript) && sanitize(current.summary)) {
          // The stored text is already complete: take the status, no fetch needed.
          next.summaryStatus = status;
          next.final = true;
        } else {
          next.fetch = { ...(isObject(current.fetch) ? current.fetch : {}), queuedAt: isoAt(nowMs) };
          queued = true;
        }
      }
      const rowChanged = !current || storeRecordsDiffer(current, next, BOOKKEEPING_FIELDS);
      if (rowChanged) {
        next.at = isoAt(nowMs);
        map[id] = next;
        changed = true;
      }
      results.push({ id, isNew: !current, changed: rowChanged, queued, record: map[id] });
    }
    return changed;
  }, { nowMs });
  return results;
}

function nextFetchState(row, { final = false, error = '' } = {}, nowMs) {
  if (final && !error) {
    return { attempts: 0, lastAttemptAt: isoAt(nowMs), nextFetchAt: '', lastError: '', gaveUpAt: '', queuedAt: '' };
  }
  const prev = isObject(row?.fetch) ? row.fetch : {};
  // A running meeting is polled at a fixed pace, and those polls do not count: the first fetch
  // after the call starts the doubling pause from its shortest step.
  const live = row?.isLive === true && !error;
  const attempts = (Number(prev.attempts) || 0) + (live ? 0 : 1);
  const delay = live
    ? REFETCH_LIVE_MS
    : Math.min(REFETCH_MAX_MS, REFETCH_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 16));
  const seen = firefliesFirstSeenMs(row);
  const gaveUp = Number.isFinite(seen) && nowMs - seen >= REFETCH_GIVE_UP_MS;
  return {
    attempts,
    lastAttemptAt: isoAt(nowMs),
    nextFetchAt: gaveUp ? '' : isoAt(nowMs + delay),
    lastError: sanitize(error).slice(0, 200),
    gaveUpAt: gaveUp ? isoAt(nowMs) : '',
    queuedAt: '',
  };
}

/**
 * Store a full transcript(id) answer and plan the next fetch: none once final, otherwise a
 * doubling pause (a short fixed one while the meeting is live) until REFETCH_GIVE_UP_MS.
 */
export function storeFetchedFirefliesMeeting(record = {}, { nowMs = Date.now() } = {}) {
  const id = sanitize(record?.meetingId);
  if (!id) return null;
  let stored = null;
  updateFirefliesStore('meetings', (map) => {
    pruneMeetings(map, nowMs);
    upsertInto(map, { ...record, fetchedAt: isoAt(nowMs) }, nowMs);
    const row = map[id];
    row.fetch = nextFetchState(row, { final: storedMeetingIsFinal(row, { nowMs }) }, nowMs);
    stored = row;
    return true;
  }, { nowMs });
  return stored ? { ...stored } : null;
}

/** A full fetch failed for a reason that is not "try later": count it and pause before the next one. */
export function noteFirefliesFetchFailure(meetingId, error, { nowMs = Date.now() } = {}) {
  const id = sanitize(meetingId);
  if (!id) return null;
  let stored = null;
  updateFirefliesStore('meetings', (map) => {
    pruneMeetings(map, nowMs);
    const row = isObject(map[id]) ? map[id] : { meetingId: id, firstSeenAt: isoAt(nowMs) };
    const message = sanitize(error?.message || error) || 'fetch failed';
    row.fetch = nextFetchState(row, { error: message }, nowMs);
    map[id] = row;
    stored = row;
    return true;
  }, { nowMs });
  return stored ? { ...stored } : null;
}

/** Merge a partial update (match, media, refreshed transcript) into a stored meeting. */
export function updateStoredFirefliesMeeting(meetingId, patch = {}, { nowMs = Date.now() } = {}) {
  const id = sanitize(meetingId);
  if (!id) return null;
  let stored = null;
  updateFirefliesStore('meetings', (map) => {
    let changed = pruneMeetings(map, nowMs);
    const known = isObject(map[id]);
    const current = known ? map[id] : { meetingId: id, firstSeenAt: isoAt(nowMs) };
    const next = { ...current, ...patch, meetingId: id, at: current.at || isoAt(nowMs), updatedAt: isoAt(nowMs) };
    if (!known || storeRecordsDiffer(current, next, BOOKKEEPING_FIELDS)) {
      map[id] = next;
      changed = true;
    }
    stored = map[id];
    return changed;
  }, { nowMs });
  return stored ? { ...stored } : null;
}

/** Ids from a pasted title, a raw id, or a Fireflies view link (`…/view/title::ID`). */
export function firefliesIdsFromPaste(query = '') {
  const raw = sanitize(query);
  const ids = [];
  const add = (value) => {
    let decoded = String(value || '');
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep the raw slug when it is not percent-encoded.
    }
    const id = sanitize(decoded);
    if (id && !ids.includes(id)) ids.push(id);
  };
  const view = raw.match(/fireflies\.ai\/view\/([^?\s#]+)/i);
  if (view) {
    add(view[1]);
    const tail = view[1].split('::').pop();
    if (tail && tail !== view[1]) add(tail);
  } else if (raw.includes('::')) {
    add(raw);
    add(raw.split('::').pop());
  } else if (/^[A-Za-z0-9_-]{8,}$/.test(raw)) {
    add(raw);
  }
  return ids;
}

/** GraphQL `transcript(id)` wants the CUID after `::`, not the titled view slug. */
export function firefliesGraphqlIdsFromPaste(query = '') {
  const out = [];
  for (const id of firefliesIdsFromPaste(query)) {
    const graphqlId = id.includes('::') ? sanitize(id.split('::').pop()) : id;
    if (graphqlId && !out.includes(graphqlId)) out.push(graphqlId);
  }
  return out;
}

export function storedMeetingHasTalk(meeting = {}) {
  return Boolean(sanitize(meeting?.transcript) || sanitize(meeting?.summary));
}

/** Match a pasted Fireflies title, id, or view link against meetings the webhook already stored. */
export function rankMeetingsByTitle(meetings = [], query = '') {
  const needle = sanitize(query).toLowerCase().replace(/\s+/g, ' ');
  const pastedIds = firefliesIdsFromPaste(query).map((id) => id.toLowerCase());
  if (needle.length < 3 && !pastedIds.length) return [];
  return (Array.isArray(meetings) ? meetings : [])
    .map((row) => {
      const title = sanitize(row?.title).toLowerCase().replace(/\s+/g, ' ');
      const id = sanitize(row?.meetingId).toLowerCase();
      const view = sanitize(row?.transcriptUrl).toLowerCase();
      let score = 0;
      if (pastedIds.some((candidate) => candidate && (candidate === id || view.includes(candidate)))) score = 100;
      else if (id && needle && id === needle) score = 100;
      else if (title && needle && title === needle) score = 90;
      else if (title && needle && !pastedIds.length && title.includes(needle)) score = 70;
      else if (title && needle && !pastedIds.length && needle.includes(title) && title.length >= 8) score = 50;
      return score ? { row, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || Date.parse(b.row?.startedAt || 0) - Date.parse(a.row?.startedAt || 0))
    .map((entry) => entry.row);
}

function normalizeMeetLink(value = '') {
  return sanitize(value).toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * Should a full transcript(id) fetch run for this stored row now? A queued one (the list showed
 * a new summary_status) always runs once; otherwise rows that are not final, not given up and
 * past their nextFetchAt. Final rows, empty-final ones included, are never fetched again.
 * `onDemand`: a person is waiting (Fyll ut), so the pause is skipped unless the last fetch failed.
 */
export function firefliesFetchDue(row = {}, { nowMs = Date.now(), onDemand = false } = {}) {
  const id = sanitize(row?.meetingId);
  if (!id || id.toLowerCase().startsWith('live:')) return false;
  const fetch = isObject(row.fetch) ? row.fetch : {};
  if (sanitize(fetch.queuedAt)) return true;
  if (sanitize(fetch.gaveUpAt) || storedMeetingIsFinal(row, { nowMs })) return false;
  if (onDemand && !sanitize(fetch.lastError)) return true;
  const next = Date.parse(fetch.nextFetchAt || '');
  return !Number.isFinite(next) || next <= nowMs;
}

/** Since when a fetch has been due: the budget goes to the longest-waiting rows first. */
export function firefliesFetchDueSince(row = {}) {
  const fetch = isObject(row?.fetch) ? row.fetch : {};
  const due = Date.parse(fetch.queuedAt || fetch.nextFetchAt || '');
  if (Number.isFinite(due)) return due;
  const seen = firefliesFirstSeenMs(row);
  return Number.isFinite(seen) ? seen : 0;
}

/** Stored rows that need a full fetch now, longest-waiting first. */
export function storedMeetingsNeedingHydration(meetings = [], { nowMs = Date.now() } = {}) {
  return (Array.isArray(meetings) ? meetings : [])
    .filter((row) => firefliesFetchDue(row, { nowMs }))
    .sort((a, b) => firefliesFetchDueSince(a) - firefliesFetchDueSince(b));
}

export function listStoredFirefliesMeetingsForMeetLink(meetLink = '') {
  const wanted = normalizeMeetLink(meetLink);
  if (!wanted) return [];
  return listStoredFirefliesMeetings().filter((row) => normalizeMeetLink(row.meetingLink) === wanted);
}

export function findStoredFirefliesMeetingForMeetLink(meetLink = '') {
  return listStoredFirefliesMeetingsForMeetLink(meetLink)[0] || null;
}

// Only fetch bookkeeping for an id Fireflies never answered for: not a meeting to list.
function isFetchStub(row = {}) {
  return !sanitize(row.title) && !sanitize(row.startedAt) && !storedMeetingHasTalk(row);
}

/**
 * Stored meetings, newest first. `holders` (Map meetingId → clientId, from the client cards) is who holds
 * each one: with it, `unmatchedOnly` means on no client's card and `clientId` means on that client's.
 * Without it both fall back to the stored match.
 */
export function listStoredFirefliesMeetings({ unmatchedOnly = false, clientId = '', includeStubs = false, holders = null } = {}) {
  const wanted = sanitize(clientId);
  const holderOf = holders instanceof Map
    ? (row) => sanitize(holders.get(sanitize(row.meetingId)))
    : (row) => sanitize(row.match?.clientId);
  return Object.values(meetingsMap())
    .filter((row) => isObject(row) && sanitize(row.meetingId))
    .filter((row) => includeStubs || !isFetchStub(row))
    .filter((row) => (!unmatchedOnly || !holderOf(row)))
    .filter((row) => (!wanted || holderOf(row) === wanted))
    .map((row) => ({ ...row }))
    .sort((a, b) => Date.parse(b.startedAt || b.at || 0) - Date.parse(a.startedAt || a.at || 0));
}

const MATCH_KEY_FIELDS = ['clientId', 'businessName', 'linkedBy', 'purpose', 'slotKey', 'confidence'];

/** What a stored match says, for comparing (linkedAt, score and reasons aside); '' for none. */
function storedMatchKey(match) {
  if (!isObject(match) || !sanitize(match.clientId)) return '';
  return MATCH_KEY_FIELDS.map((key) => sanitize(match[key])).join('|');
}

function nextStoredMatch(current, match, nowMs) {
  if (!isObject(match) || !sanitize(match.clientId)) return null;
  const sameClient = isObject(current) && sanitize(current.clientId) === sanitize(match.clientId);
  return {
    ...match,
    linkedAt: (sameClient && sanitize(current.linkedAt)) || sanitize(match.linkedAt) || isoAt(nowMs),
  };
}

/** The stored match for the row a client card holds: what the card says (purpose and slot included). */
export function storedMatchForCard(client = {}, row = {}) {
  return {
    clientId: sanitize(client?.id),
    businessName: sanitize(client?.businessName),
    confidence: sanitize(row?.confidence) || 'manual',
    score: Number(row?.score) || 0,
    reasons: Array.isArray(row?.reasons) ? row.reasons.slice(0, 6) : [],
    linkedBy: sanitize(row?.linkedBy) || 'auto',
    purpose: sanitize(row?.purpose),
    slotKey: sanitize(row?.slotKey),
  };
}

function excludedIdsOf(row = {}) {
  return asList(row.excludedClientIds).map((id) => sanitize(id)).filter(Boolean);
}

/** The record with a client link applied (setStoredFirefliesClientLink), or null when nothing changes. */
function withClientLink(row, { match, pin, exclude = '', include = '' }, nowMs) {
  const next = { ...row };
  if (match !== undefined && storedMatchKey(row.match) !== storedMatchKey(match)) {
    next.match = nextStoredMatch(row.match, match, nowMs);
  }
  if (pin !== undefined) {
    const wanted = isObject(pin) && sanitize(pin.clientId)
      ? { clientId: sanitize(pin.clientId), linkedBy: sanitize(pin.linkedBy), at: sanitize(pin.at) || isoAt(nowMs) }
      : null;
    const same = wanted
      ? isObject(row.pin) && sanitize(row.pin.clientId) === wanted.clientId && sanitize(row.pin.linkedBy) === wanted.linkedBy
      : !isObject(row.pin);
    if (!same) next.pin = wanted;
  }
  const before = excludedIdsOf(row);
  const excluded = new Set(before);
  if (sanitize(exclude)) excluded.add(sanitize(exclude));
  if (sanitize(include)) excluded.delete(sanitize(include));
  if ([...excluded].join('|') !== before.join('|')) next.excludedClientIds = [...excluded];
  return storeRecordsDiffer(row, next, BOOKKEEPING_FIELDS) ? next : null;
}

/**
 * Keep a stored meeting in step with the client card that holds it, in one write and only when
 * something changes:
 *   match    { clientId, businessName, linkedBy, purpose, slotKey, confidence, score, reasons } or null;
 *   pin      a person's link { clientId, linkedBy, at } or null (left as it is when not given);
 *   exclude  a client id this recording is not ("Ikke denne kunden"): no automatic link gives it back;
 *   include  a client id a person linked it to again, taken off the excluded list.
 * Only a record that exists is touched, unless `create` (an exclusion for a card row whose recording
 * was never stored: a bare record keeps it, and a later copy from Fireflies merges into it). The cached
 * read decides whether a locked write is needed at all. Returns a copy of the stored record, or null.
 */
export function setStoredFirefliesClientLink(meetingId, change = {}, { nowMs = Date.now(), create = false } = {}) {
  const id = sanitize(meetingId);
  if (!id) return null;
  const blank = () => ({ meetingId: id, firstSeenAt: isoAt(nowMs), at: isoAt(nowMs) });
  const cached = meetingsMap()[id];
  if (!isObject(cached) && !create) return null;
  if (isObject(cached) && !withClientLink(cached, change, nowMs)) return { ...cached };
  let stored = null;
  updateFirefliesStore('meetings', (map) => {
    const known = isObject(map[id]);
    const row = known ? map[id] : (create ? blank() : null);
    if (!row) return false;
    const next = withClientLink(row, change, nowMs);
    if (!next) {
      stored = known ? row : null;
      return false;
    }
    next.updatedAt = isoAt(nowMs);
    map[id] = next;
    stored = next;
    return true;
  }, { nowMs });
  return stored ? { ...stored } : null;
}

/**
 * Make each stored meeting's match name the client that holds it ([{ meetingId, match }], match null
 * for none), in one write and only when one of them says something else (checked on the cached read
 * first). Records that do not exist are left alone. Returns { changed }.
 */
export function syncStoredFirefliesMatches(entries = [], { nowMs = Date.now() } = {}) {
  const cached = meetingsMap();
  const wanted = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = sanitize(entry?.meetingId);
    const row = id ? cached[id] : null;
    const match = isObject(entry?.match) ? entry.match : null;
    if (isObject(row) && storedMatchKey(row.match) !== storedMatchKey(match)) wanted.set(id, match);
  }
  let changed = 0;
  if (!wanted.size) return { changed };
  updateFirefliesStore('meetings', (map) => {
    for (const [id, match] of wanted) {
      const row = isObject(map[id]) ? map[id] : null;
      if (!row || storedMatchKey(row.match) === storedMatchKey(match)) continue;
      map[id] = { ...row, match: nextStoredMatch(row.match, match, nowMs), updatedAt: isoAt(nowMs) };
      changed += 1;
    }
    return changed > 0;
  }, { nowMs });
  return { changed };
}

export async function fetchFirefliesTranscript(
  meetingId,
  { apiKey, fetchImpl = fetch, lane = 'ingest' } = {}
) {
  const id = sanitize(meetingId);
  const key = sanitize(apiKey);
  if (!id) throw new Error('Missing Fireflies meeting id.');
  if (!key) throw new Error('Fireflies API key is not configured.');
  if (!guardExternal('firefliesIngest', `transcript ${id}`).allowed) throw new SafeModeBlockedError('firefliesIngest', 'transcript fetch');

  const { data, errors } = await firefliesGraphql({
    query: TRANSCRIPT_QUERY,
    variables: { transcriptId: id },
    apiKey: key,
    fetchImpl,
    timeoutMs: FETCH_TIMEOUT_MS,
    lane,
  });
  const transcript = data?.transcript;
  if (!transcript || typeof transcript !== 'object') {
    // Not a "try later" error (lib/fireflies-graphql.js throws those): the id has no transcript now.
    const code = sanitize(errors[0]?.code || errors[0]?.extensions?.code) || 'not-found';
    throw Object.assign(new Error(firefliesGraphqlErrorMessage(errors) || 'Fireflies returned no transcript.'), { code });
  }
  return transcript;
}

function publicMeetingFields(record = {}) {
  return {
    meetingId: record.meetingId || '',
    event: record.event || '',
    title: record.title || '',
    when: record.when || '',
    startedAt: record.startedAt || '',
    durationMinutes: record.durationMinutes,
    recordedBy: record.recordedBy || '',
    hostEmail: record.hostEmail || '',
    attendees: Array.isArray(record.attendees) ? record.attendees : [],
    attendeeEmails: Array.isArray(record.attendeeEmails) ? record.attendeeEmails : [],
    match: record.match || null,
    media: record.media || null,
    videoUrl: record.videoUrl || '',
    videoDownloadUrl: record.videoDownloadUrl || '',
    transcriptUrl: record.transcriptUrl || '',
    audioUrl: record.audioUrl || '',
    meetingLink: record.meetingLink || '',
    transcript: record.transcript || '',
    summary: record.summary || '',
    actionItems: Array.isArray(record.actionItems) ? record.actionItems : [],
    keywords: Array.isArray(record.keywords) ? record.keywords : [],
  };
}

/** Sentences in a stored record: Fireflies' count, else the transcript's lines; '' when unknown. */
function recordSentenceCount(record = {}) {
  const counted = record.sentenceCount === '' || record.sentenceCount == null ? NaN : Number(record.sentenceCount);
  if (Number.isFinite(counted)) return Math.max(0, counted);
  const transcript = sanitize(record.transcript);
  return transcript ? transcript.split('\n').filter((line) => line.trim()).length : '';
}

/**
 * Compact reference stored on the sales client (full transcript stays in fireflies-meetings.json).
 * Purpose and slot are worked out when it is linked (server.js linkFirefliesMeeting).
 */
export function meetingRefForClient(record = {}, match = {}, { linkedBy = 'auto' } = {}) {
  return {
    meetingId: sanitize(record.meetingId),
    title: sanitize(record.title) || 'Fireflies-møte',
    when: sanitize(record.when),
    startedAt: sanitize(record.startedAt),
    durationMinutes: record.durationMinutes === '' || record.durationMinutes == null ? '' : Number(record.durationMinutes),
    meetLink: sanitize(record.meetLink || record.meetingLink),
    transcriptUrl: sanitize(record.transcriptUrl),
    videoUrl: sanitize(record.videoUrl),
    confidence: sanitize(match.confidence) || 'manual',
    score: Number(match.score) || 0,
    reasons: Array.isArray(match.reasons) ? match.reasons.slice(0, 6) : [],
    summary: sanitize(record.summary).slice(0, 2000),
    actionItems: Array.isArray(record.actionItems) ? record.actionItems.slice(0, 20) : [],
    hasTranscript: Boolean(sanitize(record.transcript)),
    sentenceCount: recordSentenceCount(record),
    linkedAt: new Date().toISOString(),
    linkedBy: sanitize(linkedBy) || 'auto',
    forSalesMeeting: Boolean(record.forSalesMeeting),
    purpose: ['sales', 'workshop', 'iteration'].includes(sanitize(record.purpose))
      ? sanitize(record.purpose)
      : '',
    slotKey: sanitize(record.slotKey),
  };
}

/**
 * Try to attach the meeting to a sales client. `deps.matchClients(record)` returns { best, candidates };
 * `deps.linkMeeting(clientId, ref)` persists the reference on the client. Both are wired by server.js.
 */
async function attachMeetingToClient(record, deps = {}) {
  if (typeof deps.matchClients !== 'function') return { match: null, candidates: [] };
  let result;
  try {
    result = await deps.matchClients(record);
  } catch (error) {
    return { match: null, candidates: [], error: sanitize(error?.message) };
  }
  const best = result?.best || null;
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  if (!best?.clientId) return { match: null, candidates };
  const match = {
    clientId: best.clientId,
    businessName: best.businessName || '',
    confidence: best.confidence || 'medium',
    score: best.score || 0,
    reasons: best.reasons || [],
    linkedBy: 'auto',
    linkedAt: new Date().toISOString(),
  };
  if (typeof deps.linkMeeting === 'function') {
    try {
      await deps.linkMeeting(best.clientId, meetingRefForClient(record, match));
    } catch (error) {
      return { match: null, candidates, error: sanitize(error?.message) };
    }
    // The link keeps the stored match in step with the card (purpose, slot, a person's link): hand that
    // one back, so the caller does not write this bare automatic match over it.
    const synced = readStoredFirefliesMeeting(record.meetingId)?.match;
    if (isObject(synced) && sanitize(synced.clientId) === sanitize(best.clientId)) return { match: synced, candidates };
  }
  return { match, candidates };
}

/**
 * Store the meeting, link it to its client, then e-mail the team once.
 *
 * deps (wired by server.js): fetchTranscript, sendEmail, matchClients, linkMeeting;
 * refreshOnRepeat: false skips the re-fetch for an already-notified meeting; useStored: true
 * uses a stored copy with talk instead of fetching again (the pull ingest just stored it);
 * deferUntilFinal: false sends even while Fireflies is still processing (the pull follow-up
 * decides that itself); nowMs for tests. By default a copy that is not final is stored and
 * linked but not e-mailed yet, so the e-mail carries the summary.
 */
export async function notifyFirefliesRecording(
  payload,
  config = readFirefliesWebhookConfig(),
  deps = {}
) {
  const send = deps.sendEmail || sendEmail;
  const fetchTranscript = deps.fetchTranscript || fetchFirefliesTranscript;
  const event = eventFromPayload(payload);
  const meetingId = meetingIdFromPayload(payload);
  const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();

  if (!isFirefliesTranscriptReadyEvent(event)) {
    return { sent: false, reason: 'ignored-event', event, meetingId };
  }
  if (!meetingId) {
    return { sent: false, reason: 'missing-meeting-id', event };
  }
  if (wasFirefliesMeetingNotified(meetingId, { nowMs })) {
    // Fireflies fires "transcribed" then "summarized": pick up the summary on the later event without a second email.
    let stored = readStoredFirefliesMeeting(meetingId) || { meetingId, event };
    if (config.apiKey && deps.refreshOnRepeat !== false) {
      try {
        const transcript = await fetchTranscript(meetingId, { apiKey: config.apiKey, fetchImpl: deps.fetchImpl });
        // Merged into the stored record: a live or partial copy is replaced, final text is never wiped.
        stored = storeFetchedFirefliesMeeting(buildFirefliesMeetingRecord(payload, transcript), { nowMs }) || stored;
        const ownerId = sanitize(stored.match?.clientId);
        if (ownerId && typeof deps.linkMeeting === 'function' && storedMeetingHasTalk(stored)) {
          try {
            await deps.linkMeeting(ownerId, meetingRefForClient(stored, stored.match, {
              linkedBy: sanitize(stored.match?.linkedBy) || 'auto',
            }));
          } catch {
            // Keep the stored transcript even if the client write fails.
          }
        } else if (!ownerId) {
          const attached = await attachMeetingToClient(stored, deps);
          if (attached.match) stored = updateStoredFirefliesMeeting(meetingId, { match: attached.match, candidates: attached.candidates }) || stored;
        }
      } catch {
        // keep what we have
      }
    }
    return { sent: false, reason: 'already-notified', refreshed: true, ...publicMeetingFields(stored) };
  }

  let record = null;
  const known = deps.useStored ? readStoredFirefliesMeeting(meetingId) : null;
  if (known && storedMeetingHasTalk(known)) {
    record = known;
  } else {
    let transcript = { id: meetingId };
    if (config.apiKey) {
      transcript = await fetchTranscript(meetingId, { apiKey: config.apiKey, fetchImpl: deps.fetchImpl });
    }
    const built = buildFirefliesMeetingRecord(payload, transcript);
    // Stored before the client link: linking a workshop recording starts the project
    // document, which reads the stored talk at once.
    record = (config.apiKey ? storeFetchedFirefliesMeeting(built, { nowMs }) : storeFirefliesMeeting(built, { nowMs })) || built;
  }
  const attached = await attachMeetingToClient(record, deps);
  if (attached.match || attached.candidates.length) {
    record = updateStoredFirefliesMeeting(sanitize(record.meetingId) || meetingId, {
      ...(attached.match ? { match: attached.match } : {}),
      candidates: attached.candidates,
    }) || { ...record, match: attached.match || record.match || null };
  }
  if (config.apiKey && deps.deferUntilFinal !== false && !storedMeetingIsFinal(record, { nowMs })) {
    // Fireflies is still on it: the pull follow-up sends the e-mail once the summary is in.
    return { sent: false, reason: 'not-final', ...publicMeetingFields(record), candidates: attached.candidates };
  }
  // Claimed before the send is awaited: the other path may have reached this point meanwhile.
  if (!claimFirefliesMeetingNotification(meetingId, { nowMs })) {
    return { sent: false, reason: 'already-notified', ...publicMeetingFields(readStoredFirefliesMeeting(meetingId) || record) };
  }
  const email = buildFirefliesNotifyEmail(record, config.notifyEmail);
  // The stored meeting + client link are the primary output (they feed the offer email and the admin
  // Tilbud page). A failing notify email must not fail the webhook or make Fireflies retry the event.
  let notifyError = '';
  try {
    await send({
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments,
    });
  } catch (error) {
    notifyError = sanitize(error?.message) || 'notify-failed';
  }
  try {
    // 'failed' leaves the claim open for the pull follow-up's next try (firefliesNotifyDue).
    markFirefliesMeetingNotified(meetingId, notifyError ? { state: 'failed', error: notifyError, nowMs } : { state: 'sent', nowMs });
    if (notifyError || sanitize(record.notifyError)) updateStoredFirefliesMeeting(sanitize(record.meetingId) || meetingId, { notifyError });
  } catch (error) {
    console.error(`[fireflies] notify id=${meetingId} could not record the send: ${sanitize(error?.message) || error}`);
  }
  return {
    sent: !notifyError,
    ...(notifyError ? { reason: 'notify-failed', error: notifyError } : {}),
    to: email.to,
    ...publicMeetingFields(record),
    candidates: attached.candidates,
  };
}

/** Re-pull transcript/summary from Fireflies for a stored meeting (admin "Oppdater" button). */
export async function refreshFirefliesMeeting(meetingId, config = readFirefliesWebhookConfig(), deps = {}) {
  const id = sanitize(meetingId);
  if (!id) throw new Error('Missing meeting id.');
  if (!config.apiKey) throw new Error('Fireflies API key is not configured.');
  const fetchTranscript = deps.fetchTranscript || fetchFirefliesTranscript;
  const transcript = await fetchTranscript(id, { apiKey: config.apiKey, fetchImpl: deps.fetchImpl });
  // Merged into the record as it is after the await: a match or media saved meanwhile stays,
  // and an empty answer (Fireflies reprocessing) does not wipe the stored text.
  return storeFetchedFirefliesMeeting(buildFirefliesMeetingRecord({ meeting_id: id }, transcript));
}

// When to send, retry and verify lives in lib/fireflies-live-sessions.js; this section only talks to Fireflies.
const ADD_TO_LIVE_MUTATION = `
mutation AddToLiveMeeting($meetingLink: String!, $title: String, $duration: Int) {
  addToLiveMeeting(meeting_link: $meetingLink, title: $title, duration: $duration) {
    success
    message
  }
}
`.trim();

/**
 * Minutes the bot stays. Fireflies defaults to 60 counted from the dispatch, which cut recordings near T+57.
 * 120 is the documented maximum (15 the minimum); a larger value is refused as invalid_arguments.
 */
export const FIREFLIES_LIVE_JOIN_DURATION_MINUTES = 120;
export const FIREFLIES_LIVE_JOIN_MIN_DURATION_MINUTES = 15;

export function firefliesLiveJoinDuration(minutes = FIREFLIES_LIVE_JOIN_DURATION_MINUTES) {
  const value = Math.round(Number(minutes));
  if (!Number.isFinite(value) || value <= 0) return FIREFLIES_LIVE_JOIN_DURATION_MINUTES;
  return Math.min(FIREFLIES_LIVE_JOIN_DURATION_MINUTES, Math.max(FIREFLIES_LIVE_JOIN_MIN_DURATION_MINUTES, value));
}

const RECENT_TRANSCRIPTS_QUERY = `
query Transcripts($limit: Int, $skip: Int, $fromDate: DateTime, $toDate: DateTime) {
  transcripts(limit: $limit, skip: $skip, fromDate: $fromDate, toDate: $toDate) {
    id
    title
    date
    dateString
    duration
    meeting_link
    transcript_url
    is_live
    meeting_info {
      summary_status
    }
  }
}
`.trim();

function listDate(value) {
  if (value === '' || value == null) return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * One page of the transcripts list, newest first (Fireflies allows at most 50 per page).
 * fromDate/toDate (ISO or ms) bound the window and skip pages through it; variables left
 * out are not sent, so Fireflies applies no such filter.
 */
export async function fetchRecentFirefliesTranscripts({
  apiKey,
  limit = 15,
  skip = 0,
  fromDate = '',
  toDate = '',
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  const key = sanitize(apiKey);
  if (!key) throw new Error('Fireflies API key is not configured.');
  if (!guardExternal('firefliesIngest', 'recent transcripts').allowed) throw new SafeModeBlockedError('firefliesIngest', 'recent transcripts');
  const { data, errors } = await firefliesGraphql({
    query: RECENT_TRANSCRIPTS_QUERY,
    variables: {
      limit: Math.min(50, Math.max(1, Number(limit) || 15)),
      skip: Number(skip) > 0 ? Math.floor(Number(skip)) : undefined,
      fromDate: listDate(fromDate),
      toDate: listDate(toDate),
    },
    apiKey: key,
    fetchImpl,
    timeoutMs,
  });
  // A partial answer (data plus errors) still lists what Fireflies could return.
  if (!Array.isArray(data?.transcripts)) {
    throw new Error(firefliesGraphqlErrorMessage(errors) || 'Fireflies transcripts failed.');
  }
  return data.transcripts.filter(Boolean);
}

/**
 * Send the Fireflies bot into a Meet room by link. Does not depend on calendar sync. Success only means
 * "dispatched": the bot still has to be let in from the lobby. Rate-limited by Fireflies to 3 calls per
 * 20 minutes for the whole account. No language is passed: the account default transcribes Norwegian
 * today, and some clients speak English.
 */
export async function addFirefliesToLiveMeeting({
  meetingLink = '',
  title = '',
  durationMinutes = FIREFLIES_LIVE_JOIN_DURATION_MINUTES,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 20_000,
} = {}) {
  const link = sanitize(meetingLink);
  const key = sanitize(apiKey);
  if (!link) throw new Error('Missing meeting link.');
  if (!key) throw new Error('Fireflies API key is not configured.');
  if (!guardExternal('firefliesLiveJoin', 'addToLiveMeeting').allowed) {
    return { ok: false, message: 'Blocked by hub safe mode (firefliesLiveJoin).', safeMode: true };
  }

  const { data, errors } = await firefliesGraphql({
    query: ADD_TO_LIVE_MUTATION,
    variables: {
      meetingLink: link,
      title: sanitize(title).slice(0, 256) || undefined,
      duration: firefliesLiveJoinDuration(durationMinutes),
    },
    apiKey: key,
    fetchImpl,
    timeoutMs,
    lane: 'live',
    bucket: 'join',
  });
  if (errors.length) {
    // Keep Fireflies' code (unsupported_platform, invalid_arguments, ...) so the caller can tell a bad link from a blip.
    const error = new Error(firefliesGraphqlErrorMessage(errors) || 'Fireflies addToLive failed.');
    error.code = sanitize(errors[0]?.code || errors[0]?.extensions?.code);
    throw error;
  }
  const result = data?.addToLiveMeeting;
  // Only an explicit success counts: an empty or odd answer must not stamp the meeting as joined.
  const message = sanitize(result?.message);
  return {
    ok: result?.success === true && !message.toLowerCase().includes('exceeded'),
    message: message || (result ? '' : 'Fireflies gave no answer to the live-join request.'),
  };
}

/**
 * Read-only queries the live-join loop makes (who is in a room, a webhook's meeting, the key owner). They run
 * under the loop's own key firefliesLiveJoin, or without it under firefliesIngest; a refusal is logged as
 * firefliesIngest, the kind the egress guard gives any Fireflies query.
 */
function guardFirefliesLiveRead(detail = '') {
  const kind = safeModeAllows('firefliesLiveJoin') ? 'firefliesLiveJoin' : 'firefliesIngest';
  if (!guardExternal(kind, detail).allowed) throw new SafeModeBlockedError('firefliesIngest', detail);
}

function isoOrEmpty(value = '') {
  const ms = Date.parse(sanitize(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

const ACTIVE_MEETINGS_QUERY = `
query ActiveMeetings {
  active_meetings(input: { states: [active, paused] }) {
    id
    title
    organizer_email
    meeting_link
    start_time
    end_time
    state
  }
}
`.trim();

/**
 * Meetings of the key owner that have the bot in the room right now (active or paused). A bot still waiting
 * in the Meet lobby is, as far as anyone has seen, not listed. The id is the later transcript id and
 * end_time is start plus the duration passed to addToLiveMeeting.
 */
export async function fetchActiveFirefliesMeetings({ apiKey, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const key = sanitize(apiKey);
  if (!key) throw new Error('Fireflies API key is not configured.');
  guardFirefliesLiveRead('active meetings');
  const { data, errors } = await firefliesGraphql({
    query: ACTIVE_MEETINGS_QUERY,
    apiKey: key,
    fetchImpl,
    timeoutMs,
    lane: 'live',
  });
  if (!Array.isArray(data?.active_meetings)) {
    throw new Error(firefliesGraphqlErrorMessage(errors) || 'Fireflies active meetings failed.');
  }
  return data.active_meetings
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      id: sanitize(row.id),
      title: sanitize(row.title),
      organizerEmail: sanitize(row.organizer_email).toLowerCase(),
      meetingLink: sanitize(row.meeting_link),
      startTime: isoOrEmpty(row.start_time),
      endTime: isoOrEmpty(row.end_time),
      state: sanitize(row.state).toLowerCase() || 'active',
    }))
    .filter((row) => row.meetingLink);
}

const TRANSCRIPT_PRESENCE_QUERY = `
query TranscriptPresence($transcriptId: String!) {
  transcript(id: $transcriptId) {
    id
    meeting_link
    is_live
    dateString
  }
}
`.trim();

/**
 * Which room a Fireflies meeting id belongs to, when it started, and whether it is still running (cheap; for
 * bot_joined). isLive is undefined when Fireflies does not say.
 */
export async function fetchFirefliesTranscriptPresence(meetingId, { apiKey, fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  const id = sanitize(meetingId);
  const key = sanitize(apiKey);
  if (!id) throw new Error('Missing Fireflies meeting id.');
  if (!key) throw new Error('Fireflies API key is not configured.');
  guardFirefliesLiveRead(`transcript presence ${id}`);
  const { data, errors } = await firefliesGraphql({
    query: TRANSCRIPT_PRESENCE_QUERY,
    variables: { transcriptId: id },
    apiKey: key,
    fetchImpl,
    timeoutMs,
    lane: 'live',
  });
  const transcript = data?.transcript;
  if (!transcript || typeof transcript !== 'object') {
    throw new Error(firefliesGraphqlErrorMessage(errors) || 'Fireflies returned no meeting.');
  }
  return {
    id: sanitize(transcript.id) || id,
    meetingLink: sanitize(transcript.meeting_link),
    isLive: typeof transcript.is_live === 'boolean' ? transcript.is_live : undefined,
    startTime: sanitize(transcript.dateString),
  };
}

const KEY_OWNER_QUERY = 'query KeyOwner { user { email } }';

/** E-mail of the user who owns the API key ('' when Fireflies does not say). */
export async function fetchFirefliesKeyOwnerEmail({ apiKey, fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  const key = sanitize(apiKey);
  if (!key) throw new Error('Fireflies API key is not configured.');
  guardFirefliesLiveRead('key owner');
  const { data, errors } = await firefliesGraphql({
    query: KEY_OWNER_QUERY,
    apiKey: key,
    fetchImpl,
    timeoutMs,
    lane: 'live',
  });
  if (!data?.user) throw new Error(firefliesGraphqlErrorMessage(errors) || 'Fireflies returned no user.');
  return sanitize(data.user.email).toLowerCase();
}

/** V2 `meeting.bot_joined` (or V1-style `bot_joined`): the bot is in the room. */
export function isFirefliesBotJoinedEvent(event = '') {
  const value = sanitize(event).toLowerCase();
  return value === 'meeting.bot_joined' || value === 'bot_joined';
}
