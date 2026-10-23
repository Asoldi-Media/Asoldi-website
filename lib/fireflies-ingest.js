/**
 * The Fireflies pull ingest, one tick a minute from server.js (scheduleFirefliesTranscriptIngest).
 *
 *   list     the newest transcripts every tick (the cheap fast path), plus a paged scan through
 *            a date window (fromDate = last good scan minus a day, 14 days on the first run)
 *            every 10 minutes, or at once when the fast page holds nothing the hub knows, so an
 *            outage longer than one page is caught up;
 *   hydrate  full transcript(id) fetches for rows that are not final and for ids on client
 *            cards with no stored copy, longest-waiting first; final copies are only relinked
 *            when a card shows less than the store;
 *   then the server's own steps (meet-link backfill, relink, follow-up e-mail and media, the
 *   missing-recording watchdog).
 *
 * Every step and every id runs in its own try/catch. "Try later" errors (rate limit, budget
 * reserve, timeout, network, safe mode) stop the step for this tick and never count against a
 * meeting. firefliesIngestStatus() reports the health; the owner gets one e-mail when the pull
 * keeps failing or has not succeeded for 30 minutes.
 */
import { SafeModeBlockedError, safeModeAllows } from './safe-mode.js';
import { firefliesRateLimitStatus, isTransientFirefliesError } from './fireflies-graphql.js';
import { firefliesStoreHealth, readFirefliesStore, updateFirefliesStore } from './fireflies-store.js';
import {
  buildFirefliesListRecord,
  buildFirefliesMeetingRecord,
  fetchFirefliesTranscript,
  fetchRecentFirefliesTranscripts,
  firefliesFetchDue,
  firefliesFetchDueSince,
  listStoredFirefliesMeetings,
  noteFirefliesFetchFailure,
  resolveFirefliesApiKey,
  storeFetchedFirefliesMeeting,
  storedMeetingHasTalk,
  storedMeetingIsFinal,
  storedMeetingsNeedingHydration,
  upsertListedFirefliesMeetings,
} from './fireflies-webhook.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const INGEST_FAST_LIMIT = 20;
export const INGEST_PAGE_LIMIT = 50;
export const INGEST_SCAN_EVERY_MS = 10 * MINUTE_MS;
const INGEST_MAX_PAGES = 20;
const FIRST_SCAN_DAYS = 14;
const SCAN_OVERLAP_MS = DAY_MS;
// The last good list call is written to disk at most this often, so a restart keeps it.
const PERSIST_OK_EVERY_MS = 5 * MINUTE_MS;
export const INGEST_ALERT_AFTER_FAILURES = 10;
export const INGEST_ALERT_STALE_MS = 30 * MINUTE_MS;
export const INGEST_ALERT_EVERY_MS = 12 * 60 * MINUTE_MS;
const DEFAULT_ALERT_EMAIL = 'damian@asoldi.com';

function text(value) {
  return String(value ?? '').trim();
}

function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

function errorText(error) {
  return text(error?.message || error) || 'unknown error';
}

/** "Try later": the budget, the network or safe mode said no. Never a fact about the meeting. */
export function isTryLaterError(error) {
  return isTransientFirefliesError(error)
    || error instanceof SafeModeBlockedError
    || error?.code === 'ESAFEMODE'
    || error?.code === 'no-api-key';
}

export function readFirefliesIngestState() {
  return { ...readFirefliesStore('ingest') };
}

function writeIngestState(patch, nowMs) {
  try {
    updateFirefliesStore('ingest', (state) => {
      let changed = false;
      for (const [key, value] of Object.entries(patch)) {
        if (state[key] !== value) {
          state[key] = value;
          changed = true;
        }
      }
      return changed;
    }, { backups: false, nowMs });
  } catch (error) {
    console.warn(`[fireflies] ingest state not saved: ${errorText(error)}`);
  }
}

/** Where the paged scan starts: a day before the last good scan, or 14 days back on the first run. */
export function firefliesScanFromMs(state = {}, nowMs = Date.now()) {
  const ok = Date.parse(state?.lastIngestOkAt || '');
  return Number.isFinite(ok) ? ok - SCAN_OVERLAP_MS : nowMs - FIRST_SCAN_DAYS * DAY_MS;
}

function collect(results, into) {
  for (const row of results) {
    if (row.isNew) into.newIds.push(row.id);
    else if (row.changed) into.changedIds.push(row.id);
    if (row.queued) into.queuedIds.push(row.id);
  }
}

/**
 * Page through transcripts(fromDate, limit 50, skip) until a page holds only known, unchanged
 * ids (everything older was seen before), a short page, or INGEST_MAX_PAGES.
 */
export async function scanFirefliesTranscripts({
  apiKey,
  fromMs,
  listTranscripts = fetchRecentFirefliesTranscripts,
  nowMs = Date.now(),
  pageLimit = INGEST_PAGE_LIMIT,
  maxPages = INGEST_MAX_PAGES,
} = {}) {
  const summary = { pages: 0, rows: 0, newIds: [], changedIds: [], queuedIds: [], complete: false };
  for (let skip = 0; summary.pages < maxPages; skip += pageLimit) {
    const rows = await listTranscripts({ apiKey, limit: pageLimit, skip, fromDate: fromMs });
    summary.pages += 1;
    summary.rows += rows.length;
    const results = upsertListedFirefliesMeetings(rows.map(buildFirefliesListRecord), { nowMs });
    collect(results, summary);
    if (rows.length < pageLimit || results.every((row) => !row.isNew && !row.changed)) {
      summary.complete = true;
      break;
    }
  }
  return summary;
}

/**
 * The list step: the fast page every tick, and the paged scan when it is due. Throws when the
 * fast page fails (the tick counts that for health); a failing scan only logs and waits.
 */
export async function ingestFirefliesTranscriptList({
  apiKey,
  listTranscripts = fetchRecentFirefliesTranscripts,
  nowMs = Date.now(),
  fastLimit = INGEST_FAST_LIMIT,
  scanEveryMs = INGEST_SCAN_EVERY_MS,
  log = console,
} = {}) {
  if (!text(apiKey)) return { skipped: 'no-api-key' };
  const rows = await listTranscripts({ apiKey, limit: fastLimit });
  const results = upsertListedFirefliesMeetings(rows.map(buildFirefliesListRecord), { nowMs });
  const summary = { listed: rows.length, newIds: [], changedIds: [], queuedIds: [], scan: null };
  collect(results, summary);

  const state = readFirefliesIngestState();
  const lastTry = Math.max(Date.parse(state.lastScanAt || '') || 0, Date.parse(state.lastScanAttemptAt || '') || 0);
  // A full fast page with nothing known on it: more may be waiting beyond it.
  const gap = rows.length >= fastLimit && results.length > 0 && results.every((row) => row.isNew || row.changed);
  if (gap || !lastTry || nowMs - lastTry >= scanEveryMs) {
    const fromMs = firefliesScanFromMs(state, nowMs);
    try {
      summary.scan = await scanFirefliesTranscripts({ apiKey, fromMs, listTranscripts, nowMs });
      writeIngestState({ lastScanAt: iso(nowMs), lastScanAttemptAt: iso(nowMs), lastIngestOkAt: iso(nowMs), lastScanFrom: iso(fromMs) }, nowMs);
    } catch (error) {
      writeIngestState({ lastScanAttemptAt: iso(nowMs) }, nowMs);
      log.warn?.(`[fireflies] recent-transcripts scan from=${iso(fromMs)} ${errorText(error)}`);
    }
  }
  return summary;
}

/** The client card shows less than the stored copy (no transcript, an older summary, no action items). */
export function clientMeetingRefIsStale(ref = {}, stored = {}) {
  if (!stored || !storedMeetingHasTalk(stored)) return false;
  if (!ref?.hasTranscript && text(stored.transcript)) return true;
  const summary = text(stored.summary).slice(0, 2000);
  if (summary && text(ref?.summary) !== summary) return true;
  const items = Array.isArray(stored.actionItems) ? stored.actionItems.length : 0;
  return Boolean(items && !(Array.isArray(ref?.actionItems) && ref.actionItems.length));
}

function isPlaceholderId(id = '') {
  return text(id).toLowerCase().startsWith('live:');
}

/**
 * What this tick fetches and relinks.
 *   fetch:  at most `max` ids, longest-waiting first: stored rows that are not final (or have a
 *           queued fetch), and ids on client cards with no stored copy;
 *   relink: client rows whose stored copy is final and has more than the card shows.
 * clientRows: [{ clientId, row }] with row a client.meetings entry. Placeholders are skipped.
 */
export function planFirefliesHydration({
  storedRows = [],
  clientRows = [],
  readStored = () => null,
  nowMs = Date.now(),
  max = 8,
  maxRelinks = 10,
} = {}) {
  const due = new Map();
  for (const row of storedMeetingsNeedingHydration(storedRows, { nowMs })) {
    due.set(text(row.meetingId), firefliesFetchDueSince(row));
  }
  const relink = [];
  const seen = new Set();
  for (const entry of Array.isArray(clientRows) ? clientRows : []) {
    const id = text(entry?.row?.meetingId);
    const clientId = text(entry?.clientId);
    if (!id || !clientId || isPlaceholderId(id) || seen.has(`${clientId}|${id}`)) continue;
    seen.add(`${clientId}|${id}`);
    if (due.has(id)) continue;
    const stored = readStored(id);
    if (!stored) {
      // On a card but never stored (or lost from the archive): fetch it.
      due.set(id, 0);
      continue;
    }
    if (firefliesFetchDue(stored, { nowMs })) {
      due.set(id, firefliesFetchDueSince(stored));
      continue;
    }
    if (relink.length < maxRelinks && clientMeetingRefIsStale(entry.row, stored)) relink.push({ clientId, meetingId: id });
  }
  const fetch = [...due.entries()].sort((a, b) => a[1] - b[1]).slice(0, Math.max(0, max)).map(([id]) => id);
  return { fetch, relink };
}

/**
 * One full fetch: store the answer (which plans the next fetch, if any) or note the failure.
 * Outcomes: 'fetched' (with record), 'later' (try-later error, nothing counted), 'failed'.
 */
export async function hydrateFirefliesTranscript(meetingId, {
  apiKey,
  fetchTranscript = fetchFirefliesTranscript,
  nowMs = Date.now(),
} = {}) {
  const id = text(meetingId);
  if (!id || isPlaceholderId(id)) return { outcome: 'failed', error: new Error('Not a Fireflies id.') };
  let transcript;
  try {
    transcript = await fetchTranscript(id, { apiKey });
  } catch (error) {
    if (isTryLaterError(error)) return { outcome: 'later', error };
    noteFirefliesFetchFailure(id, error, { nowMs });
    return { outcome: 'failed', error };
  }
  const record = storeFetchedFirefliesMeeting(buildFirefliesMeetingRecord({ meeting_id: id }, transcript), { nowMs });
  return { outcome: 'fetched', record };
}

/**
 * Run the planned fetches. onFetched(record) links the client (server.js). A try-later
 * answer ends the step for this tick; a failure or a link error only skips that id.
 */
export async function runFirefliesHydration(ids = [], { hydrate, onFetched, log = console } = {}) {
  const summary = { fetched: [], failed: [], later: '' };
  for (const id of ids) {
    let result;
    try {
      result = await hydrate(id);
    } catch (error) {
      summary.failed.push(id);
      log.warn?.(`[fireflies] hydrate id=${id} ${errorText(error)}`);
      continue;
    }
    if (result?.outcome === 'later') {
      summary.later = errorText(result.error);
      log.warn?.(`[fireflies] hydrate id=${id} paused: ${summary.later}`);
      break;
    }
    if (result?.outcome !== 'fetched') {
      summary.failed.push(id);
      log.warn?.(`[fireflies] hydrate id=${id} ${errorText(result?.error)}`);
      continue;
    }
    summary.fetched.push(id);
    if (typeof onFetched !== 'function') continue;
    try {
      await onFetched(result.record);
    } catch (error) {
      log.warn?.(`[fireflies] hydrate id=${id} link ${errorText(error)}`);
    }
  }
  return summary;
}

// --- health -----------------------------------------------------------------------------------

const health = {
  firstTickAt: 0,
  lastTickAt: 0,
  lastOkAt: 0,
  lastError: '',
  lastErrorAt: 0,
  consecutiveFailures: 0,
  lastRateLimitedAt: 0,
  missingPlaceholders: 0,
  steps: {},
};

function noteListResult(result, error, nowMs) {
  if (!error) {
    if (result?.skipped) return;
    health.lastOkAt = nowMs;
    health.consecutiveFailures = 0;
    health.lastError = '';
    const persisted = Date.parse(readFirefliesIngestState().lastListOkAt || '') || 0;
    if (nowMs - persisted >= PERSIST_OK_EVERY_MS) writeIngestState({ lastListOkAt: iso(nowMs) }, nowMs);
    return;
  }
  // A rate-limit pause is Fireflies asking to wait, not a failure of the pull.
  if (error?.code === 'rate-limited' || error?.code === 'reserve') {
    health.lastRateLimitedAt = nowMs;
    return;
  }
  health.consecutiveFailures += 1;
  health.lastError = errorText(error).slice(0, 300);
  health.lastErrorAt = nowMs;
}

/**
 * Run one tick: steps are [name, run] pairs, each in its own try/catch. The 'list' step decides
 * health. A step result with a `health` object (the watchdog's counts) is copied into it.
 */
export async function runFirefliesIngestTick(steps = [], { nowMs = Date.now(), log = console } = {}) {
  if (!health.firstTickAt) health.firstTickAt = nowMs;
  health.lastTickAt = nowMs;
  const results = {};
  for (const [name, run] of steps) {
    const started = Date.now();
    try {
      results[name] = await run();
      health.steps[name] = { at: iso(nowMs), ok: true, error: '', ms: Date.now() - started };
      if (name === 'list') noteListResult(results[name], null, nowMs);
      if (results[name]?.health && typeof results[name].health === 'object') {
        if (Number.isFinite(results[name].health.missingPlaceholders)) health.missingPlaceholders = results[name].health.missingPlaceholders;
      }
    } catch (error) {
      health.steps[name] = { at: iso(nowMs), ok: false, error: errorText(error).slice(0, 300), ms: Date.now() - started };
      log.warn?.(`[fireflies] ingest step=${name} ${errorText(error)}`);
      if (name === 'list') noteListResult(null, error, nowMs);
    }
  }
  return results;
}

/** Health of the pull ingest for the admin pages and the owner alert. */
export function firefliesIngestStatus({ nowMs = Date.now(), env = process.env } = {}) {
  const keyConfigured = Boolean(resolveFirefliesApiKey(env).apiKey);
  const state = readFirefliesIngestState();
  let pendingHydrations = 0;
  let unfinishedSummaries = 0;
  let gaveUp = 0;
  for (const row of listStoredFirefliesMeetings({ includeStubs: true })) {
    if (row.fetch?.gaveUpAt) {
      gaveUp += 1;
      continue;
    }
    if (storedMeetingIsFinal(row, { nowMs })) continue;
    pendingHydrations += 1;
    if (storedMeetingHasTalk(row)) unfinishedSummaries += 1;
  }
  const persistedOk = Date.parse(state.lastListOkAt || '') || 0;
  return {
    keyConfigured,
    safeModeBlocked: keyConfigured && !safeModeAllows('firefliesIngest'),
    lastTickAt: iso(health.lastTickAt),
    lastOkAt: iso(Math.max(health.lastOkAt, persistedOk)),
    lastError: health.lastError,
    lastErrorAt: iso(health.lastErrorAt),
    consecutiveFailures: health.consecutiveFailures,
    lastRateLimitedAt: iso(health.lastRateLimitedAt),
    rateLimit: firefliesRateLimitStatus(nowMs),
    pendingHydrations,
    unfinishedSummaries,
    gaveUp,
    missingPlaceholders: health.missingPlaceholders,
    lastScanAt: text(state.lastScanAt),
    lastIngestOkAt: text(state.lastIngestOkAt),
    lastHealthAlertAt: text(state.lastHealthAlertAt),
    steps: { ...health.steps },
    store: firefliesStoreHealth(),
  };
}

/** Why the owner should hear about the ingest now ('' when all is well). */
export function firefliesIngestAlertReason(status = {}, { nowMs = Date.now() } = {}) {
  if (!status.keyConfigured || status.safeModeBlocked) return '';
  if (status.store?.meetings?.source === 'unreadable') return 'store-unreadable';
  if (status.consecutiveFailures > INGEST_ALERT_AFTER_FAILURES) return 'failures';
  const since = Date.parse(status.lastOkAt || '') || health.firstTickAt;
  if (since && nowMs - since > INGEST_ALERT_STALE_MS) return 'stale';
  return '';
}

function osloTime(value = '') {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Oslo' });
}

export function buildFirefliesIngestAlertEmail(status = {}, reason = '', to = DEFAULT_ALERT_EMAIL) {
  const lead = reason === 'store-unreadable'
    ? 'Fireflies-arkivet (fireflies-meetings.json) kan ikke leses, og ingen sikkerhetskopi kan leses. Nye opptak lagres ikke før filen er reparert (se backups/ i datamappen).'
    : 'Asoldi har ikke fått hentet Fireflies-opptak på en stund. Nye møter kommer ikke inn i kundekortet, tilbudet eller workshopen før dette er løst.';
  const paused = text(status.rateLimit?.pausedUntil?.api);
  const lines = [
    lead,
    '',
    `Sist vellykket henting: ${osloTime(status.lastOkAt) || 'ikke siden oppstart'}`,
    `Feil på rad: ${Number(status.consecutiveFailures) || 0}`,
    `Siste feil: ${text(status.lastError) || '—'}`,
    paused ? `Fireflies ba oss vente til: ${osloTime(paused)}` : '',
    `Venter på henting: ${Number(status.pendingHydrations) || 0} · uten ferdig sammendrag: ${Number(status.unfinishedSummaries) || 0} · møter uten opptak: ${Number(status.missingPlaceholders) || 0}`,
    '',
    reason === 'store-unreadable'
      ? 'Legg en lesbar kopi tilbake fra backups/, så fortsetter innhentingen av seg selv.'
      : 'Sjekk at Fireflies-nøkkelen fortsatt er gyldig, og at Fireflies-kontoen ikke er stengt eller over API-grensen. Innhentingen prøver videre hvert minutt.',
    'Denne e-posten sendes høyst én gang hver 12. time.',
  ].filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''));
  return {
    to,
    subject: reason === 'store-unreadable' ? 'Fireflies: arkivet kan ikke leses' : 'Fireflies: opptak hentes ikke inn',
    text: lines.join('\n'),
  };
}

/**
 * E-mail the owner (FIREFLIES_ALERT_EMAIL, default damian@asoldi.com) when the pull keeps
 * failing, has not succeeded for 30 minutes, or the archive cannot be read. At most once per
 * 12 hours across restarts: the stamp is written before the send.
 */
export async function maybeAlertFirefliesIngest({
  sendEmail,
  nowMs = Date.now(),
  env = process.env,
  log = console,
} = {}) {
  if (typeof sendEmail !== 'function') return null;
  const status = firefliesIngestStatus({ nowMs, env });
  const reason = firefliesIngestAlertReason(status, { nowMs });
  if (!reason) return null;
  const last = Date.parse(status.lastHealthAlertAt || '');
  if (Number.isFinite(last) && nowMs - last < INGEST_ALERT_EVERY_MS) return null;
  writeIngestState({ lastHealthAlertAt: iso(nowMs) }, nowMs);
  const email = buildFirefliesIngestAlertEmail(status, reason, text(env.FIREFLIES_ALERT_EMAIL) || DEFAULT_ALERT_EMAIL);
  try {
    await sendEmail(email);
    log.warn?.(`[fireflies] ingest alert sent reason=${reason} to=${email.to}`);
  } catch (error) {
    log.warn?.(`[fireflies] ingest alert reason=${reason} not sent: ${errorText(error)}`);
  }
  return { reason, to: email.to };
}

/**
 * Per-key pause for work that keeps finding nothing to do (an offer letter fill that changes
 * nothing): doubles from baseMs up to maxMs. A new fingerprint (the input changed) ends it.
 */
export function createKeyedBackoff({ baseMs = 10 * MINUTE_MS, maxMs = 6 * 60 * MINUTE_MS, maxKeys = 2000 } = {}) {
  const entries = new Map();
  return {
    due(key, fingerprint = '', nowMs = Date.now()) {
      const entry = entries.get(key);
      return !entry || entry.fingerprint !== fingerprint || nowMs >= entry.nextAt;
    },
    idle(key, fingerprint = '', nowMs = Date.now()) {
      const entry = entries.get(key);
      const delay = entry && entry.fingerprint === fingerprint ? Math.min(maxMs, entry.delay * 2) : baseMs;
      entries.set(key, { fingerprint, delay, nextAt: nowMs + delay });
      if (entries.size > maxKeys) entries.delete(entries.keys().next().value);
    },
    clear(key) {
      entries.delete(key);
    },
  };
}

export function resetFirefliesIngestForTests() {
  Object.assign(health, {
    firstTickAt: 0,
    lastTickAt: 0,
    lastOkAt: 0,
    lastError: '',
    lastErrorAt: 0,
    consecutiveFailures: 0,
    lastRateLimitedAt: 0,
    missingPlaceholders: 0,
    steps: {},
  });
}
