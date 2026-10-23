/**
 * Missing-recording watchdog, one step of the Fireflies ingest tick.
 *
 * Every booked online meeting the bot was sent to keeps a placeholder on client.meetings
 * ('live:…', isPlaceholderMeetingId) until a real transcript replaces it. Capture writes
 * scheduled / dispatched / recording / ended / not-admitted on its `recording` object
 * (lib/fireflies-recording-state.js); this module takes over once the session is over:
 *   - it looks for the transcript by recording.ffMeetingId (the active_meetings id is the
 *     transcript id), else by transcripts(fromDate: start - 1 h, toDate: start + 4 h) matched on
 *     the normalized Meet link. A title match is only offered as a candidate, never linked;
 *   - a transcript with talk is stored and linked to the client, which drops the placeholder;
 *     a finished one with no talk sets 'empty';
 *   - at start + (booked, else 60) + 90 minutes with nothing found it sets 'missing' and sends one
 *     e-mail to the team and the owning rep. A missing meeting is looked for hourly for 48 hours
 *     after its deadline, so a late transcript still links.
 * Lookups run at most every 10 minutes per placeholder, three per tick. A try-later error (rate
 * limit, network, safe mode) never makes a meeting missing.
 */
import { normalizeFirefliesMeetLink } from './fireflies-client-match.js';
import { TERMINAL_RECORDING_STATES, slotKindFromKey } from './fireflies-recording-state.js';
import { hydrateFirefliesTranscript, isTryLaterError } from './fireflies-ingest.js';
import {
  buildFirefliesListRecord,
  fetchRecentFirefliesTranscripts,
  listStoredFirefliesMeetings,
  readStoredFirefliesMeeting,
  storedMeetingHasTalk,
  storedMeetingIsEmptyFinal,
  storedMeetingIsFinal,
  upsertListedFirefliesMeetings,
} from './fireflies-webhook.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
export const DEFAULT_BOOKED_MINUTES = 60;
/** Minutes after the booked end before a meeting with no recording counts as missing. */
export const MISSING_GRACE_MS = 90 * MINUTE_MS;
export const WATCHDOG_CHECK_EVERY_MS = 10 * MINUTE_MS;
export const WATCHDOG_MISSING_CHECK_EVERY_MS = HOUR_MS;
/** A missing meeting is looked for, and alerted about, this long after its deadline. */
export const WATCHDOG_MISSING_WATCH_MS = 48 * HOUR_MS;
const SEARCH_BEFORE_MS = HOUR_MS;
const SEARCH_AFTER_MS = 4 * HOUR_MS;
const MAX_LOOKUPS_PER_TICK = 3;

function text(value) {
  return String(value ?? '').trim();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function isPlaceholderId(id = '') {
  return text(id).toLowerCase().startsWith('live:');
}

function startMs(row = {}) {
  return Date.parse(text(row.startedAt));
}

export function placeholderBookedMinutes(row = {}) {
  for (const value of [row.bookedMinutes, row.durationMinutes]) {
    const minutes = Number(value);
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
  }
  return DEFAULT_BOOKED_MINUTES;
}

/** start + booked minutes + 90: after this, no transcript means the recording is missing. */
export function recordingDeadlineMs(row = {}) {
  return startMs(row) + placeholderBookedMinutes(row) * MINUTE_MS + MISSING_GRACE_MS;
}

/** A real (non-placeholder) row on the client already covers this session. */
function sessionLinked(client = {}, placeholder = {}) {
  const ffId = text(placeholder.recording?.ffMeetingId);
  const link = normalizeFirefliesMeetLink(placeholder.meetLink);
  const start = startMs(placeholder);
  return (Array.isArray(client.meetings) ? client.meetings : []).some((row) => {
    const id = text(row?.meetingId);
    if (!id || isPlaceholderId(id)) return false;
    if (ffId && id === ffId) return true;
    if (!link || normalizeFirefliesMeetLink(row.meetLink) !== link) return false;
    const at = Date.parse(text(row.startedAt));
    return Number.isFinite(at) && at >= start - SEARCH_BEFORE_MS && at <= start + SEARCH_AFTER_MS;
  });
}

/**
 * What to do for one placeholder now: { action: 'skip', reason } or
 * { action: 'lookup', deadlineMs, overdue }. `checkedMs` is the last lookup this process made.
 */
export function planPlaceholderCheck(row = {}, { nowMs = Date.now(), checkedMs = 0 } = {}) {
  const skip = (reason) => ({ action: 'skip', reason });
  if (!isPlaceholderId(row?.meetingId)) return skip('not-a-placeholder');
  const state = text(row.recording?.state);
  if (TERMINAL_RECORDING_STATES.has(state) && state !== 'missing') return skip('done');
  const start = startMs(row);
  if (!Number.isFinite(start) || start > nowMs) return skip('not-started');
  const sessionEnd = start + placeholderBookedMinutes(row) * MINUTE_MS;
  if (state !== 'ended' && state !== 'missing' && nowMs < sessionEnd) return skip('in-session');
  const deadlineMs = recordingDeadlineMs(row);
  const last = Math.max(Number(checkedMs) || 0, Date.parse(text(row.recording?.checkedAt)) || 0);
  // Long past the deadline: one look decides it (without an e-mail); after that, nothing.
  if (nowMs - deadlineMs > WATCHDOG_MISSING_WATCH_MS && (state === 'missing' || last)) return skip('watch-over');
  const every = state === 'missing' ? WATCHDOG_MISSING_CHECK_EVERY_MS : WATCHDOG_CHECK_EVERY_MS;
  if (last && nowMs - last < every) return skip('checked-lately');
  return { action: 'lookup', deadlineMs, overdue: nowMs >= deadlineMs };
}

function normalizedTitle(value = '') {
  return text(value).toLowerCase().replace(/\s+/g, ' ');
}

function bestWithTalk(rows = []) {
  return rows
    .filter((row) => storedMeetingHasTalk(row))
    .sort((a, b) => (Number(b.sentenceCount) || text(b.transcript).length) - (Number(a.sentenceCount) || text(a.transcript).length))[0] || null;
}

/**
 * Find this session's transcript. Returns { found, empty, pending, candidates }:
 *   found       a stored record with talk (by id, or on the booked Meet link in the window);
 *   empty       a finished record on the room with no talk;
 *   pending     a record exists but Fireflies is not done with it;
 *   candidates  [{ meetingId, title, startedAt, transcriptUrl }] with the hub's title but another room.
 * Throws try-later errors so the caller can stop for this tick.
 */
export async function lookupPlaceholderTranscript(placeholder = {}, {
  apiKey,
  nowMs = Date.now(),
  listTranscripts = fetchRecentFirefliesTranscripts,
  hydrate = (id) => hydrateFirefliesTranscript(id, { apiKey, nowMs }),
  readStored = readStoredFirefliesMeeting,
  storedRows = () => listStoredFirefliesMeetings(),
} = {}) {
  const link = normalizeFirefliesMeetLink(placeholder.meetLink);
  const start = startMs(placeholder);
  const from = start - SEARCH_BEFORE_MS;
  const to = start + SEARCH_AFTER_MS;
  const inWindow = (row) => {
    const at = Date.parse(text(row?.startedAt));
    return Number.isFinite(at) && at >= from && at <= to;
  };
  const outcome = { found: null, empty: null, pending: false, candidates: [] };
  const settle = (record) => {
    if (!record) return;
    if (storedMeetingHasTalk(record)) {
      if (!outcome.found || (Number(record.sentenceCount) || 0) > (Number(outcome.found.sentenceCount) || 0)) outcome.found = record;
    } else if (storedMeetingIsEmptyFinal(record, { nowMs })) {
      outcome.empty = outcome.empty || record;
    } else {
      outcome.pending = true;
    }
  };
  const fetchOne = async (id) => {
    const known = readStored(id);
    if (known && storedMeetingIsFinal(known, { nowMs })) return known;
    const result = await hydrate(id);
    if (result?.outcome === 'later') throw result.error || new Error('Fireflies asked to wait.');
    return result?.outcome === 'fetched' ? result.record : known;
  };

  // 1. What the archive already holds: the id capture saw, or this room at this time.
  const ffId = text(placeholder.recording?.ffMeetingId);
  const onRoom = (row) => link && normalizeFirefliesMeetLink(row?.meetingLink) === link && inWindow(row);
  const storedBest = bestWithTalk([...(ffId && readStored(ffId) ? [readStored(ffId)] : []), ...storedRows().filter(onRoom)]);
  if (storedBest) {
    outcome.found = storedBest;
    return outcome;
  }

  // 2. The id capture saw in active_meetings is the transcript id.
  if (ffId) settle(await fetchOne(ffId));
  if (outcome.found) return outcome;

  // 3. Ask Fireflies for everything around the booked time and match on the Meet link.
  const rows = await listTranscripts({ apiKey, limit: 50, fromDate: from, toDate: to });
  upsertListedFirefliesMeetings(rows.map(buildFirefliesListRecord), { nowMs });
  const title = normalizedTitle(placeholder.title);
  for (const row of rows) {
    const id = text(row?.id);
    if (!id || id === ffId) continue;
    if (link && normalizeFirefliesMeetLink(row.meeting_link) === link) {
      settle(await fetchOne(id));
    } else if (title && normalizedTitle(row.title) === title) {
      const record = buildFirefliesListRecord(row);
      outcome.candidates.push({ meetingId: id, title: record.title, startedAt: record.startedAt, transcriptUrl: record.transcriptUrl });
    }
  }
  return outcome;
}

function osloTime(value = '') {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('nb-NO', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Oslo' });
}

function meetingNoun(placeholder = {}) {
  const kind = slotKindFromKey(placeholder.slotKey) || text(placeholder.purpose);
  if (kind === 'sales' || placeholder.forSalesMeeting) return 'salgsmøtet';
  if (kind === 'workshop') return 'workshopen';
  if (kind === 'iteration') return 'iterasjonsmøtet';
  return 'møtet';
}

function stateLine(state = '') {
  if (state === 'not-admitted') return 'Fireflies-boten ble sendt inn, men ble aldri sluppet inn i møtet.';
  if (state === 'recording' || state === 'ended') return 'Fireflies var i møtet, men opptaket har ikke kommet inn.';
  if (state === 'dispatched') return 'Fireflies-boten ble sendt inn, men ble ikke sett i møtet.';
  return 'Fireflies har ikke noe opptak fra Meet-rommet i møtetiden.';
}

/** The one e-mail about a missing recording (Norwegian, to the team and the owning rep). */
export function buildMissingRecordingEmail({ client = {}, placeholder = {}, to = [], previousState = '', candidates = [] } = {}) {
  const business = text(client.businessName) || 'kunden';
  const noun = meetingNoun(placeholder);
  const when = osloTime(placeholder.startedAt);
  const lines = [
    `Det finnes ikke noe Fireflies-opptak av ${noun} med ${business}${when ? ` (${when})` : ''}.`,
    stateLine(previousState),
    text(placeholder.meetLink) ? `Meet: ${text(placeholder.meetLink)}` : '',
    '',
    'Hva du kan gjøre:',
    '- Har noen opptaket i Fireflies (for eksempel i en egen konto)? Lim inn Fireflies-lenken under Bytt opptak på Tilbud.',
    '- Finnes det ikke noe opptak: skriv produktnotater på kundekortet, så kan tilbudet skrives fra dem.',
    '- Ble møtet holdt uten opptak med vilje, eller ble det ikke holdt? Marker møtet som uten opptak på kundekortet.',
    ...candidates.slice(0, 3).map((row) => `Fireflies har et opptak med samme tittel fra et annet Meet-rom: «${row.title}»${row.startedAt ? ` (${osloTime(row.startedAt)})` : ''}. Er det dette møtet, lim inn lenken: ${row.transcriptUrl}`),
    '',
    'Asoldi ser etter opptaket hver time i 48 timer til. Kommer det, kobles det til kunden av seg selv.',
  ].filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''));
  return {
    to: [...new Set((Array.isArray(to) ? to : [to]).map((email) => text(email).toLowerCase()).filter(Boolean))].join(', '),
    subject: `Fireflies: ingen opptak av ${noun} med ${business}`,
    text: lines.join('\n'),
  };
}

const lastLookups = new Map();

function lookupKey(clientId, meetingId) {
  return `${clientId}|${meetingId}`;
}

function alerted(recording = {}) {
  const alertedAt = Date.parse(text(recording.alertedAt));
  const missingAt = Date.parse(text(recording.missingAt));
  return Number.isFinite(alertedAt) && Number.isFinite(missingAt) && alertedAt >= missingAt;
}

/**
 * Check every placeholder whose session is over. deps:
 *   getClients()                                   sales clients (fresh each call);
 *   linkTranscript(clientId, record, placeholder)  store-backed client link (server.js linkStoredTranscriptToClient);
 *   patchPlaceholder(clientId, meetingId, recording)  merge into the row's recording (sales.patchSalesClientMeeting);
 *   recipientsFor(client)                          [team address, owning rep's e-mail] (may be async);
 *   sendEmail(message)                             the hub mailer.
 * Returns { checked, linked, empty, missing, alerted, health: { missingPlaceholders } }.
 */
export async function runFirefliesRecordingWatchdog({
  getClients,
  apiKey,
  linkTranscript,
  patchPlaceholder,
  recipientsFor = () => [],
  sendEmail,
  nowMs = Date.now(),
  maxLookups = MAX_LOOKUPS_PER_TICK,
  lookup = (placeholder) => lookupPlaceholderTranscript(placeholder, { apiKey, nowMs }),
  log = console,
} = {}) {
  const summary = { checked: [], linked: [], empty: [], missing: [], alerted: [], paused: '' };
  const due = [];
  for (const client of getClients()) {
    for (const row of Array.isArray(client?.meetings) ? client.meetings : []) {
      if (!isPlaceholderId(row?.meetingId)) continue;
      const key = lookupKey(client.id, row.meetingId);
      const plan = planPlaceholderCheck(row, { nowMs, checkedMs: lastLookups.get(key) });
      if (plan.action !== 'lookup' || sessionLinked(client, row)) continue;
      due.push({ client, row, plan, key });
    }
  }
  // The newest deadlines first, so a meeting that just ended is never queued behind old ones.
  due.sort((a, b) => b.plan.deadlineMs - a.plan.deadlineMs);

  for (const { client, row, plan, key } of due) {
    if (summary.checked.length >= maxLookups || summary.paused) break;
    const meetingId = text(row.meetingId);
    const previousState = text(row.recording?.state);
    lastLookups.set(key, nowMs);
    if (lastLookups.size > 2000) lastLookups.delete(lastLookups.keys().next().value);
    summary.checked.push(meetingId);
    let result;
    try {
      result = await lookup(row);
    } catch (error) {
      if (isTryLaterError(error)) {
        // Fireflies or the network asked us to wait: nothing is decided about this meeting.
        summary.paused = text(error?.message) || 'try later';
        log.warn?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} paused: ${summary.paused}`);
        break;
      }
      log.warn?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} ${text(error?.message) || error}`);
      continue;
    }
    try {
      if (result.found) {
        // The link drops the placeholder; should it stay (another slot), it says what was found.
        await linkTranscript(client.id, result.found, row);
        if (previousState) {
          patchPlaceholder(client.id, meetingId, {
            // A late transcript: the meeting is no longer missing.
            ...(previousState === 'missing' ? { state: 'ended' } : {}),
            ffMeetingId: text(result.found.meetingId),
            checkedAt: iso(nowMs),
            message: 'Opptaket er funnet og koblet til kunden.',
          });
        }
        summary.linked.push(meetingId);
        log.log?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} linked ${text(result.found.meetingId)}`);
        continue;
      }
      if (result.empty) {
        patchPlaceholder(client.id, meetingId, {
          state: 'empty',
          ffMeetingId: text(result.empty.meetingId),
          checkedAt: iso(nowMs),
          message: 'Fireflies var med, men opptaket er tomt (ingen tale, eller for kort).',
        });
        summary.empty.push(meetingId);
        continue;
      }
      const candidateNote = result.candidates.length
        ? ` Mulig opptak med samme tittel i et annet Meet-rom: ${result.candidates.map((row2) => row2.meetingId).join(', ')}.`
        : '';
      if (result.pending || !plan.overdue) {
        // Capture owns the earlier states; a row without one keeps its throttle in memory.
        if (previousState) {
          patchPlaceholder(client.id, meetingId, {
            checkedAt: iso(nowMs),
            message: result.pending ? 'Fireflies behandler fortsatt opptaket.' : `Venter på opptaket fra Fireflies.${candidateNote}`,
          });
        }
        continue;
      }
      const recording = row.recording || {};
      const missingAt = previousState === 'missing' && text(recording.missingAt) ? text(recording.missingAt) : iso(nowMs);
      patchPlaceholder(client.id, meetingId, {
        state: 'missing',
        missingAt,
        checkedAt: iso(nowMs),
        message: `Ingen Fireflies-opptak etter møtet.${candidateNote}`,
      });
      if (previousState !== 'missing') summary.missing.push(meetingId);
      // One e-mail, while the deadline is recent. alertedAt is claimed before the send.
      const fresh = nowMs - plan.deadlineMs <= WATCHDOG_MISSING_WATCH_MS;
      if (fresh && typeof sendEmail === 'function' && !alerted({ ...recording, missingAt })) {
        const email = buildMissingRecordingEmail({
          client,
          placeholder: row,
          to: await recipientsFor(client),
          previousState: previousState === 'missing' ? '' : previousState,
          candidates: result.candidates,
        });
        if (email.to) {
          patchPlaceholder(client.id, meetingId, { alertedAt: iso(nowMs) });
          try {
            await sendEmail(email);
            summary.alerted.push(meetingId);
            log.warn?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} missing, alert sent to ${email.to}`);
          } catch (error) {
            patchPlaceholder(client.id, meetingId, { alertedAt: '' });
            log.warn?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} alert not sent: ${text(error?.message) || error}`);
          }
        }
      }
    } catch (error) {
      log.warn?.(`[fireflies] watchdog client=${client.id} meeting=${meetingId} ${text(error?.message) || error}`);
    }
  }

  let missingPlaceholders = 0;
  for (const client of getClients()) {
    for (const row of Array.isArray(client?.meetings) ? client.meetings : []) {
      if (isPlaceholderId(row?.meetingId) && text(row.recording?.state) === 'missing') missingPlaceholders += 1;
    }
  }
  return { ...summary, health: { missingPlaceholders } };
}

export function resetFirefliesWatchdogForTests() {
  lastLookups.clear();
}
