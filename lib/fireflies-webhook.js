import { createHmac, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { getDataFilePath, writeDataJson } from '../data/storage-path.js';
import { sendEmail } from './email.js';

const NOTIFIED_PATH = getDataFilePath('fireflies-notified.json');
const MEETINGS_PATH = getDataFilePath('fireflies-meetings.json');
const DEFAULT_NOTIFY_EMAIL = 'ansatte@asoldi.com';
const GRAPHQL_URL = 'https://api.fireflies.ai/graphql';
const FETCH_TIMEOUT_MS = 8000;
const VIEW_URL_PREFIX = 'https://app.fireflies.ai/view/';
// Meeting records feed the offer email + admin review, so keep them a full year (notified-map stays 90 days).
const MEETING_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

const TRANSCRIPT_QUERY = `
query Transcript($transcriptId: String!) {
  transcript(id: $transcriptId) {
    id
    title
    date
    dateString
    duration
    transcript_url
    audio_url
    video_url
    meeting_link
    host_email
    organizer_email
    participants
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

function readJsonMap(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pruneMap(map, cutoffMs = 90 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - cutoffMs;
  for (const [key, value] of Object.entries(map)) {
    const stamp = typeof value === 'string' ? value : value?.at;
    const at = Date.parse(stamp);
    if (Number.isFinite(at) && at < cutoff) delete map[key];
  }
  return map;
}

export function readFirefliesWebhookConfig(env = process.env) {
  const secrets = [
    ...splitSecrets(env.FIREFLIES_WEBHOOK_SECRET),
    ...splitSecrets(env.FIREFLIES_WEBHOOK_SECRETS),
  ];
  return {
    secrets: [...new Set(secrets)],
    token: sanitize(env.FIREFLIES_WEBHOOK_TOKEN),
    apiKey: sanitize(env.FIREFLIES_API_KEY),
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

export function authorizeFirefliesWebhook(
  { headers = {}, query = {}, rawBody = '' } = {},
  config = readFirefliesWebhookConfig()
) {
  if (!isFirefliesWebhookConfigured(config)) {
    return { ok: false, status: 503, reason: 'not-configured' };
  }
  const queryToken = sanitize(query.token || query.secret);
  if (config.token && queryToken && equal(config.token, queryToken)) {
    return { ok: true, via: 'token' };
  }
  if (config.secrets.some((secret) => verifyFirefliesSignature(secret, headers, rawBody))) {
    return { ok: true, via: 'signature' };
  }
  return { ok: false, status: 401, reason: 'unauthorized' };
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

export function wasFirefliesMeetingNotified(meetingId) {
  const id = sanitize(meetingId);
  if (!id) return false;
  return Boolean(readJsonMap(NOTIFIED_PATH)[id]);
}

export function markFirefliesMeetingNotified(meetingId) {
  const id = sanitize(meetingId);
  if (!id) return;
  const map = pruneMap(readJsonMap(NOTIFIED_PATH));
  map[id] = new Date().toISOString();
  writeDataJson(NOTIFIED_PATH, map);
}

export function readStoredFirefliesMeeting(meetingId) {
  const id = sanitize(meetingId);
  if (!id) return null;
  const row = readJsonMap(MEETINGS_PATH)[id];
  return row && typeof row === 'object' ? row : null;
}

export function readStoredFirefliesMeetingMap() {
  return readJsonMap(MEETINGS_PATH);
}

/** Keep transcript/summary when a later metadata-only write would wipe them. */
export function mergeStoredFirefliesRecord(current = {}, next = {}) {
  const prev = current && typeof current === 'object' ? current : {};
  const incoming = next && typeof next === 'object' ? next : {};
  const keepList = (value, fallback) => (Array.isArray(value) && value.length ? value : fallback);
  return {
    ...prev,
    ...incoming,
    meetingId: sanitize(incoming.meetingId || prev.meetingId),
    transcript: sanitize(incoming.transcript) || sanitize(prev.transcript),
    summary: sanitize(incoming.summary) || sanitize(prev.summary),
    actionItems: keepList(incoming.actionItems, Array.isArray(prev.actionItems) ? prev.actionItems : []),
    attendees: keepList(incoming.attendees, Array.isArray(prev.attendees) ? prev.attendees : []),
    attendeeEmails: keepList(incoming.attendeeEmails, Array.isArray(prev.attendeeEmails) ? prev.attendeeEmails : []),
    keywords: keepList(incoming.keywords, Array.isArray(prev.keywords) ? prev.keywords : []),
    match: incoming.match || prev.match || null,
    media: incoming.media || prev.media || null,
    videoDownloadUrl: sanitize(incoming.videoDownloadUrl) || sanitize(prev.videoDownloadUrl),
    audioUrl: sanitize(incoming.audioUrl) || sanitize(prev.audioUrl),
    meetingLink: sanitize(incoming.meetingLink) || sanitize(prev.meetingLink),
    transcriptUrl: sanitize(incoming.transcriptUrl) || sanitize(prev.transcriptUrl),
  };
}

export function storeFirefliesMeeting(record = {}) {
  const id = sanitize(record.meetingId);
  if (!id) return;
  const map = pruneMap(readJsonMap(MEETINGS_PATH), MEETING_RETENTION_MS);
  const current = map[id] && typeof map[id] === 'object' ? map[id] : {};
  map[id] = mergeStoredFirefliesRecord(current, { ...record, at: new Date().toISOString() });
  writeDataJson(MEETINGS_PATH, map);
}

/** Merge a partial update (match, media, refreshed transcript) into a stored meeting. */
export function updateStoredFirefliesMeeting(meetingId, patch = {}) {
  const id = sanitize(meetingId);
  if (!id) return null;
  const map = pruneMap(readJsonMap(MEETINGS_PATH), MEETING_RETENTION_MS);
  const current = map[id] && typeof map[id] === 'object' ? map[id] : { meetingId: id };
  map[id] = { ...current, ...patch, meetingId: id, at: current.at || new Date().toISOString(), updatedAt: new Date().toISOString() };
  writeDataJson(MEETINGS_PATH, map);
  return map[id];
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

export function listStoredFirefliesMeetingsForMeetLink(meetLink = '') {
  const wanted = normalizeMeetLink(meetLink);
  if (!wanted) return [];
  return listStoredFirefliesMeetings().filter((row) => normalizeMeetLink(row.meetingLink) === wanted);
}

export function findStoredFirefliesMeetingForMeetLink(meetLink = '') {
  return listStoredFirefliesMeetingsForMeetLink(meetLink)[0] || null;
}

export function listStoredFirefliesMeetings({ unmatchedOnly = false, clientId = '' } = {}) {
  const wanted = sanitize(clientId);
  return Object.values(readJsonMap(MEETINGS_PATH))
    .filter((row) => row && typeof row === 'object' && sanitize(row.meetingId))
    .filter((row) => (!unmatchedOnly || !sanitize(row.match?.clientId)))
    .filter((row) => (!wanted || sanitize(row.match?.clientId) === wanted))
    .sort((a, b) => Date.parse(b.startedAt || b.at || 0) - Date.parse(a.startedAt || a.at || 0));
}

function graphqlErrorMessage(payload = {}) {
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  return errors.map((item) => sanitize(item?.message)).filter(Boolean).join('; ');
}

export async function fetchFirefliesTranscript(
  meetingId,
  { apiKey, fetchImpl = fetch } = {}
) {
  const id = sanitize(meetingId);
  const key = sanitize(apiKey);
  if (!id) throw new Error('Missing Fireflies meeting id.');
  if (!key) throw new Error('Fireflies API key is not configured.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: TRANSCRIPT_QUERY,
        variables: { transcriptId: id },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(graphqlErrorMessage(payload) || `Fireflies GraphQL failed (${response.status})`);
  }
  const transcript = payload?.data?.transcript;
  if (!transcript || typeof transcript !== 'object') {
    throw new Error(graphqlErrorMessage(payload) || 'Fireflies returned no transcript.');
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

/** Compact reference stored on the sales client (full transcript stays in fireflies-meetings.json). */
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
    linkedAt: new Date().toISOString(),
    linkedBy: sanitize(linkedBy) || 'auto',
    forSalesMeeting: Boolean(record.forSalesMeeting),
    purpose: ['sales', 'workshop', 'iteration'].includes(sanitize(record.purpose))
      ? sanitize(record.purpose)
      : '',
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
  }
  return { match, candidates };
}

function refreshedFields(previous = {}, next = {}) {
  const patch = {};
  if (!sanitize(previous.transcript) && sanitize(next.transcript)) patch.transcript = next.transcript;
  if (!sanitize(previous.summary) && sanitize(next.summary)) patch.summary = next.summary;
  if (!(Array.isArray(previous.actionItems) && previous.actionItems.length) && Array.isArray(next.actionItems) && next.actionItems.length) {
    patch.actionItems = next.actionItems;
  }
  if (!sanitize(previous.videoDownloadUrl) && sanitize(next.videoDownloadUrl)) patch.videoDownloadUrl = next.videoDownloadUrl;
  if (!sanitize(previous.audioUrl) && sanitize(next.audioUrl)) patch.audioUrl = next.audioUrl;
  return patch;
}

export async function notifyFirefliesRecording(
  payload,
  config = readFirefliesWebhookConfig(),
  deps = {}
) {
  const send = deps.sendEmail || sendEmail;
  const fetchTranscript = deps.fetchTranscript || fetchFirefliesTranscript;
  const event = eventFromPayload(payload);
  const meetingId = meetingIdFromPayload(payload);

  if (!isFirefliesTranscriptReadyEvent(event)) {
    return { sent: false, reason: 'ignored-event', event, meetingId };
  }
  if (!meetingId) {
    return { sent: false, reason: 'missing-meeting-id', event };
  }
  if (wasFirefliesMeetingNotified(meetingId)) {
    // Fireflies fires "transcribed" then "summarized": pick up the summary on the later event without a second email.
    let stored = readStoredFirefliesMeeting(meetingId) || { meetingId, event };
    if (config.apiKey && deps.refreshOnRepeat !== false) {
      try {
        const transcript = await fetchTranscript(meetingId, { apiKey: config.apiKey, fetchImpl: deps.fetchImpl });
        const fresh = buildFirefliesMeetingRecord(payload, transcript);
        const patch = refreshedFields(stored, fresh);
        if (Object.keys(patch).length) stored = updateStoredFirefliesMeeting(meetingId, patch) || stored;
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

  let transcript = { id: meetingId };
  if (config.apiKey) {
    transcript = await fetchTranscript(meetingId, { apiKey: config.apiKey, fetchImpl: deps.fetchImpl });
  }

  const record = buildFirefliesMeetingRecord(payload, transcript);
  const attached = await attachMeetingToClient(record, deps);
  record.match = attached.match;
  record.candidates = attached.candidates;
  storeFirefliesMeeting(record);
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
    updateStoredFirefliesMeeting(meetingId, { notifyError });
  }
  markFirefliesMeetingNotified(meetingId);
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
  const stored = readStoredFirefliesMeeting(id) || { meetingId: id };
  const transcript = await fetchTranscript(id, { apiKey: config.apiKey, fetchImpl: deps.fetchImpl });
  const fresh = buildFirefliesMeetingRecord({ meeting_id: id }, transcript);
  return updateStoredFirefliesMeeting(id, {
    ...fresh,
    match: stored.match || null,
    candidates: stored.candidates || [],
    media: stored.media || null,
  });
}

const ADD_TO_LIVE_MUTATION = `
mutation AddToLiveMeeting($meetingLink: String!, $title: String) {
  addToLiveMeeting(meeting_link: $meetingLink, title: $title) {
    success
    message
  }
}
`.trim();

export const FIREFLIES_LIVE_JOIN_RETRY_MS = 6 * 60 * 1000;

/** Fred should enter shortly before start through ~15 minutes after. */
export function firefliesLiveJoinWindow({
  meetingAt,
  nowMs = Date.now(),
  earlyMs = 3 * 60 * 1000,
  lateMs = 15 * 60 * 1000,
} = {}) {
  const meetingMs = new Date(meetingAt).getTime();
  if (!Number.isFinite(meetingMs)) return false;
  return nowMs >= meetingMs - earlyMs && nowMs <= meetingMs + lateMs;
}

/** Stay under Fireflies' 3 live-join calls / 20 minutes. */
export function firefliesLiveJoinShouldWait({
  attemptAt,
  nowMs = Date.now(),
  retryMs = FIREFLIES_LIVE_JOIN_RETRY_MS,
} = {}) {
  const attemptMs = new Date(attemptAt).getTime();
  if (!Number.isFinite(attemptMs)) return false;
  return nowMs - attemptMs < retryMs;
}

/**
 * Send the Fireflies bot into a Meet room by link. Does not depend on calendar sync.
 * Rate-limited by Fireflies to 3 calls / 20 minutes.
 */
const RECENT_TRANSCRIPTS_QUERY = `
query Transcripts($limit: Int) {
  transcripts(limit: $limit) {
    id
    title
    date
    dateString
    duration
    meeting_link
    transcript_url
  }
}
`.trim();

export async function fetchRecentFirefliesTranscripts({
  apiKey,
  limit = 15,
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  const key = sanitize(apiKey);
  if (!key) throw new Error('Fireflies API key is not configured.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 15_000));
  let response;
  try {
    response = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: RECENT_TRANSCRIPTS_QUERY,
        variables: { limit: Math.min(30, Math.max(1, Number(limit) || 15)) },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (Array.isArray(payload?.errors) && payload.errors.length)) {
    throw new Error(graphqlErrorMessage(payload) || `Fireflies transcripts failed (${response.status})`);
  }
  return Array.isArray(payload?.data?.transcripts) ? payload.data.transcripts.filter(Boolean) : [];
}

export async function addFirefliesToLiveMeeting({
  meetingLink = '',
  title = '',
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 20_000,
} = {}) {
  const link = sanitize(meetingLink);
  const key = sanitize(apiKey);
  if (!link) throw new Error('Missing meeting link.');
  if (!key) throw new Error('Fireflies API key is not configured.');

  const controller = new AbortController();
  const waitMs = Number.isFinite(Number(timeoutMs)) ? Math.max(3000, Number(timeoutMs)) : 20_000;
  const timer = setTimeout(() => controller.abort(), waitMs);
  let response;
  try {
    response = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: ADD_TO_LIVE_MUTATION,
        variables: { meetingLink: link, title: sanitize(title) || undefined },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(graphqlErrorMessage(payload) || `Fireflies addToLive failed (${response.status})`);
  }
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error(graphqlErrorMessage(payload) || 'Fireflies addToLive failed.');
  }
  const result = payload?.data?.addToLiveMeeting || {};
  return {
    ok: result.success !== false && !sanitize(result.message).toLowerCase().includes('exceeded'),
    message: sanitize(result.message),
  };
}
