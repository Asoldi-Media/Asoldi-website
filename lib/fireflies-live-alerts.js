/**
 * Alerts around booked online meetings, so a meeting never ends without a recording unnoticed.
 * The live-join engine (lib/fireflies-live-sessions.js) runs the sessions; this module reads them.
 *
 *   - Lobby alert, to the rep and to the room's Meet host when that is someone else (Damian's calendar
 *     hosts workshops and iterations): the bot knocked, nobody let it in, and the first-send window is
 *     still open. One e-mail per session, by max(T+3, first accepted knock + 4 minutes), while the hub
 *     can still be helped by someone admitting it. Claimed on the session before the send, so it is
 *     never sent twice, also across restarts and a second hub process.
 *   - Health alert, to the owner: the live-join loop has not ticked for 10 minutes while a booked
 *     meeting is in its window, every tick has failed for 15 minutes, or the Fireflies key is missing
 *     while a booked meeting is within 2 hours. At most once per 12 hours (the ingest alert's
 *     throttle), and run from the ingest tick as well, so a dead live-join loop is never silent.
 *   - The payload of GET /api/admin/fireflies/live-join-status.
 *
 * Mail goes through the sender the caller passes in (the hub mailer, which applies safe mode).
 */
import { firefliesRateLimitStatus } from './fireflies-graphql.js';
import { claimFirefliesLiveJoinAlert, lastFirefliesLiveJoinAlertAt } from './fireflies-ingest.js';
import {
  LIVE_JOIN_DEFAULT_BOOKED_MINUTES,
  LIVE_JOIN_DISPATCH_UNTIL_MS,
  LIVE_JOIN_FIRST_LEAD_MS,
  LIVE_JOIN_VERIFY_TAIL_MS,
  collectLiveSessions,
  firefliesLiveJoinStatus,
  liveSessionKnocksAgain,
  normalizeLiveSession,
  readLiveSessionStore,
  updateLiveSessionStore,
} from './fireflies-live-sessions.js';

const MINUTE_MS = 60_000;
/** The lobby alert goes no sooner than 3 minutes after start, and 4 minutes after the first accepted knock. */
export const LOBBY_ALERT_AFTER_START_MS = 3 * MINUTE_MS;
export const LOBBY_ALERT_AFTER_KNOCK_MS = 4 * MINUTE_MS;
// A send that failed is tried again after this long, while the window lasts.
const LOBBY_ALERT_RETRY_MS = 2 * MINUTE_MS;
/** Health: no tick this long while a booked meeting is in its window. */
export const LIVE_JOIN_STALLED_MS = 10 * MINUTE_MS;
/** Health: every tick has failed this long. */
export const LIVE_JOIN_FAILING_MS = 15 * MINUTE_MS;
/** Health: no Fireflies key while a booked meeting starts within this long (or is running). */
export const LIVE_JOIN_KEY_LEAD_MS = 2 * 60 * MINUTE_MS;
const DEFAULT_ALERT_EMAIL = 'damian@asoldi.com';

function text(value) {
  return String(value ?? '').trim();
}

function msOf(value = '') {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? ms : NaN;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function osloClock(value = '') {
  const ms = msOf(value);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
}

function osloTime(value = '') {
  const ms = msOf(value);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Oslo' });
}

function uniqueEmails(list = []) {
  return [...new Set(list.flat().map((email) => text(email).toLowerCase()).filter((email) => email.includes('@')))];
}

// ── lobby alert ──────────────────────────────────────────────────────────────

function firstAcceptedKnock(session = {}) {
  return (session.attempts || []).find((attempt) => attempt.ok) || null;
}

/**
 * Is the lobby alert due for this session now? { due, reason, dueMs }. Due once the first accepted knock has
 * had its minutes and a look at the room since then has not found the bot, while the first-send window
 * (to T+30) lasts. reason: 'sent' | 'not-needed' | 'seen' | 'no-knock' | 'not-yet' | 'window-over' |
 * 'unverified' | 'retry-later' | ''.
 */
export function planLobbyAlert(input = {}, nowMs = Date.now()) {
  const session = normalizeLiveSession(input);
  if (!session) return { due: false, reason: 'not-needed', dueMs: 0 };
  if (session.lobbyAlertAt) return { due: false, reason: 'sent', dueMs: 0 };
  if (session.detachedAt || session.declinedAt || session.transcriptSeenAt) return { due: false, reason: 'not-needed', dueMs: 0 };
  const knock = firstAcceptedKnock(session);
  if (!knock) return { due: false, reason: session.firstSeenActiveAt ? 'seen' : 'no-knock', dueMs: 0 };
  const startMs = msOf(session.startAt);
  const knockMs = msOf(knock.at);
  // In the room since the knock. A bot seen only before it (an earlier meeting's in a reused room, or one that
  // walked into an open room and left) says nothing about this knock.
  const seenMs = Math.max(msOf(session.lastSeenActiveAt) || 0, msOf(session.firstSeenActiveAt) || 0);
  if (seenMs > knockMs) return { due: false, reason: 'seen', dueMs: 0 };
  const dueMs = Math.max(startMs + LOBBY_ALERT_AFTER_START_MS, knockMs + LOBBY_ALERT_AFTER_KNOCK_MS);
  if (nowMs < dueMs) return { due: false, reason: 'not-yet', dueMs };
  if (nowMs > startMs + LIVE_JOIN_DISPATCH_UNTIL_MS) return { due: false, reason: 'window-over', dueMs };
  // "Not seen" needs a look at the room after the knock: no alert on a guess while Fireflies cannot be asked.
  if (!(msOf(session.checkedAt) > knockMs)) return { due: false, reason: 'unverified', dueMs };
  const failedMs = msOf(session.lobbyAlertFailedAt);
  if (Number.isFinite(failedMs) && nowMs - failedMs < LOBBY_ALERT_RETRY_MS) return { due: false, reason: 'retry-later', dueMs };
  return { due: true, reason: '', dueMs };
}

/**
 * The lobby e-mail (Norwegian, to the rep). `knocksAgain`: the engine still sends the bot again on its own
 * (liveSessionKnocksAgain); without that the e-mail does not promise it.
 */
export function buildLobbyAlertEmail({ client = {}, session = {}, to = [], knocksAgain = true } = {}) {
  const business = text(client.businessName) || 'kunden';
  const when = osloClock(session.startAt);
  const lines = [
    `Fireflies.ai Notetaker banker på i Google Meet-møtet med ${business}${when ? ` kl. ${when}` : ''}, men er ikke sluppet inn ennå.`,
    '',
    'Er du i møtet: slipp den inn. Meet kan vise den under «Med potensielle risikoer».',
    'Ser du to «Fireflies.ai Notetaker», slipp inn bare én.',
    knocksAgain
      ? 'Er ingen i møtet ennå, trenger du ikke gjøre noe: Asoldi sender den inn på nytt.'
      : 'Asoldi sender den ikke inn igjen av seg selv, så slipp den inn nå hvis dere er i møtet.',
    text(session.meetLink) ? '' : null,
    text(session.meetLink) ? `Meet: ${text(session.meetLink)}` : null,
  ].filter((line) => line !== null);
  return {
    to: uniqueEmails(Array.isArray(to) ? to : [to]).join(', '),
    subject: `Slipp inn Fireflies – ${business}`,
    text: lines.join('\n'),
  };
}

function claimLobbyAlert(key, nowMs) {
  let claimed = false;
  updateLiveSessionStore((current) => {
    const fresh = current.sessions[key];
    // Re-checked on fresh data: another process may have sent it, or the bot got in meanwhile.
    if (!fresh || !planLobbyAlert(fresh, nowMs).due) return undefined;
    fresh.lobbyAlertAt = iso(nowMs);
    fresh.lobbyAlertFailedAt = '';
    claimed = true;
    return current;
  }, { nowMs });
  return claimed;
}

function releaseLobbyAlert(key, nowMs) {
  updateLiveSessionStore((current) => {
    const fresh = current.sessions[key];
    if (!fresh) return undefined;
    fresh.lobbyAlertAt = '';
    fresh.lobbyAlertFailedAt = iso(nowMs);
    return current;
  }, { nowMs });
}

const lobbySkipsLogged = new Map();

function logSkipOnce(log, key, reason) {
  if (lobbySkipsLogged.get(key) === reason) return;
  lobbySkipsLogged.set(key, reason);
  if (lobbySkipsLogged.size > 500) lobbySkipsLogged.delete(lobbySkipsLogged.keys().next().value);
  log?.log?.(`[fireflies] lobby alert session=${key} skipped: ${reason}`);
}

/**
 * Send the due lobby alerts. deps:
 *   clients                       the sales clients (fresh);
 *   recipientsFor(client, slot)   the rep's address(es) for that slot, [] when the rep is not known (may be async);
 *   meetHostFor(session)          the e-mail of the login that hosts the room ('' unknown, may be async): only
 *                                 someone in the meeting can admit the bot, and the host is, also when it is
 *                                 not the rep; the same address is sent to once;
 *   mayAlert(client)              false for a client that gets no e-mail (a test client that is not a pilot);
 *   sendEmail(message)            the hub mailer;
 *   enabled                       FIREFLIES_LOBBY_ALERT (default on).
 * Returns { sent, failed, skipped: [{ key, reason }] }.
 */
export async function runFirefliesLobbyAlerts({
  clients = [],
  recipientsFor = () => [],
  meetHostFor = () => '',
  mayAlert = (client) => client?.isTest !== true,
  sendEmail,
  enabled = true,
  nowMs = Date.now(),
  store = null,
  log = console,
} = {}) {
  const summary = { sent: [], failed: [], skipped: [] };
  if (!enabled || typeof sendEmail !== 'function') return summary;
  const byId = new Map((Array.isArray(clients) ? clients : []).map((client) => [text(client?.id), client]));
  for (const session of Object.values((store || readLiveSessionStore()).sessions)) {
    if (!planLobbyAlert(session, nowMs).due) continue;
    try {
      // The sales slot names the meeting when two slots share the room.
      const targets = session.slots
        .map((slot) => ({ slot, client: byId.get(slot.clientId) }))
        .filter((entry) => entry.client)
        .sort((a, b) => Number(b.slot.kind === 'sales') - Number(a.slot.kind === 'sales'));
      const allowed = targets.filter((entry) => mayAlert(entry.client));
      const reps = await Promise.all(allowed.map((entry) => Promise.resolve(recipientsFor(entry.client, entry.slot))));
      const host = allowed.length ? await Promise.resolve(meetHostFor(session)) : '';
      const to = uniqueEmails([...reps, host || []]);
      const skip = !targets.length ? 'no-client' : !allowed.length ? 'excluded' : !to.length ? 'no-rep' : '';
      if (skip) {
        summary.skipped.push({ key: session.key, reason: skip });
        logSkipOnce(log, session.key, skip);
        continue;
      }
      if (!claimLobbyAlert(session.key, nowMs)) continue;
      const email = buildLobbyAlertEmail({ client: allowed[0].client, session, to, knocksAgain: liveSessionKnocksAgain(session, nowMs) });
      try {
        await sendEmail(email);
        summary.sent.push(session.key);
        log?.warn?.(`[fireflies] lobby alert session=${session.key} sent to ${email.to}`);
      } catch (error) {
        releaseLobbyAlert(session.key, nowMs);
        summary.failed.push(session.key);
        log?.warn?.(`[fireflies] lobby alert session=${session.key} not sent: ${text(error?.message) || error}`);
      }
    } catch (error) {
      summary.failed.push(session.key);
      log?.warn?.(`[fireflies] lobby alert session=${session.key} failed: ${text(error?.message) || error}`);
    }
  }
  return summary;
}

// ── owner health alert ───────────────────────────────────────────────────────

function bookedTimes(session = {}) {
  const startMs = msOf(session.startAt);
  const minutes = Number(session.bookedMinutes) > 0 ? Number(session.bookedMinutes) : LIVE_JOIN_DEFAULT_BOOKED_MINUTES;
  return { startMs, endMs: startMs + minutes * MINUTE_MS };
}

/** Booked sessions (collectLiveSessions) the loop should be working on now: first send to the end of the watch. */
function sessionsInWindow(booked = [], nowMs) {
  return booked.filter((session) => {
    const { startMs, endMs } = bookedTimes(session);
    return nowMs >= startMs - LIVE_JOIN_FIRST_LEAD_MS && nowMs <= endMs + LIVE_JOIN_VERIFY_TAIL_MS;
  });
}

function sessionsSoon(booked = [], nowMs) {
  return booked.filter((session) => {
    const { startMs, endMs } = bookedTimes(session);
    return nowMs >= startMs - LIVE_JOIN_KEY_LEAD_MS && nowMs <= endMs;
  });
}

/**
 * Why the owner should hear about live join now ('' when all is well):
 *   'no-api-key'     the Fireflies key is missing and a booked meeting starts within 2 hours (or is on);
 *   'loop-stalled'   no tick for 10 minutes (since `sinceMs` when this process never ticked) while a booked
 *                    meeting is in its window;
 *   'ticks-failing'  every tick has failed for 15 minutes.
 * `booked` comes from the bookings (collectLiveSessions), not the engine's store, so a loop that never ran is
 * seen too. Nothing while safe mode keeps live join off on purpose.
 */
export function firefliesLiveJoinAlertReason({
  status = {},
  booked = [],
  nowMs = Date.now(),
  sinceMs = 0,
  liveJoinEnabled = true,
} = {}) {
  if (!liveJoinEnabled) return '';
  if (status.apiKeyPresent === false && sessionsSoon(booked, nowMs).length) return 'no-api-key';
  const lastTick = msOf(status.lastTickAt);
  const since = Number.isFinite(lastTick) ? lastTick : Number(sinceMs) || 0;
  if (since && nowMs - since > LIVE_JOIN_STALLED_MS && sessionsInWindow(booked, nowMs).length) return 'loop-stalled';
  const failing = msOf(status.failingSince);
  if (Number.isFinite(failing) && nowMs - failing > LIVE_JOIN_FAILING_MS) return 'ticks-failing';
  return '';
}

const LIVE_JOIN_ALERT_COPY = {
  'no-api-key': {
    subject: 'Fireflies: nøkkelen mangler, ingen opptak av møtene',
    lead: 'Fireflies-nøkkelen (FIREFLIES_API_KEY) mangler på serveren, og et booket nettmøte starter innen to timer. Fireflies kan ikke sendes inn i møtet, så det blir ikke noe opptak.',
    fix: 'Legg Fireflies-nøkkelen inn igjen i miljøet til huben. Live-join prøver igjen hvert minutt.',
  },
  'loop-stalled': {
    subject: 'Fireflies: live-join står stille',
    lead: 'Live-join har ikke kjørt på over 10 minutter, og det er bookede nettmøter nå. Fireflies sendes ikke inn i møtene før dette er løst.',
    fix: 'Sjekk at huben kjører og skriver «[fireflies] live-join …» i loggen, og start den på nytt om nødvendig.',
  },
  'ticks-failing': {
    subject: 'Fireflies: live-join feiler',
    lead: 'Hver runde i live-join har feilet i over 15 minutter. Fireflies blir kanskje ikke sendt inn i møtene, eller huben får ikke sjekket at den er der.',
    fix: 'Sjekk at Fireflies-nøkkelen fortsatt er gyldig, at Fireflies svarer, og at datamappen på huben kan skrives til.',
  },
};

/** The owner's live-join health e-mail (Norwegian). */
export function buildLiveJoinAlertEmail({
  reason = '',
  status = {},
  booked = [],
  nowMs = Date.now(),
  to = DEFAULT_ALERT_EMAIL,
} = {}) {
  const copy = LIVE_JOIN_ALERT_COPY[reason] || LIVE_JOIN_ALERT_COPY['loop-stalled'];
  const meetings = (reason === 'no-api-key' ? sessionsSoon(booked, nowMs) : sessionsInWindow(booked, nowMs)).slice(0, 5);
  const lines = [
    copy.lead,
    '',
    ...meetings.map((session) => `- ${osloTime(session.startAt)} · ${text(session.title) || 'Møte'}`),
    meetings.length ? '' : null,
    `Siste runde: ${osloTime(status.lastTickAt) || 'ikke siden oppstart'}`,
    `Siste runde uten feil: ${osloTime(status.lastOkTickAt) || '—'}`,
    `Siste feil: ${text(status.lastError) || '—'}`,
    '',
    copy.fix,
    'Denne e-posten sendes høyst én gang hver 12. time.',
  ].filter((line) => line !== null);
  return { to, subject: copy.subject, text: lines.join('\n') };
}

// When this process first looked: the reference for a live-join loop that never ticked here.
let observerSinceMs = 0;

/**
 * E-mail the owner (FIREFLIES_ALERT_EMAIL, default damian@asoldi.com) when live join is down (see
 * firefliesLiveJoinAlertReason), at most once per 12 hours. Run from both the live-join and the ingest tick.
 * Returns { reason, to } when an e-mail was due, else null.
 */
export async function maybeAlertFirefliesLiveJoin({
  sendEmail,
  clients = [],
  apiKeyPresent,
  liveJoinEnabled = true,
  nowMs = Date.now(),
  env = process.env,
  log = console,
} = {}) {
  if (!observerSinceMs) observerSinceMs = nowMs;
  if (typeof sendEmail !== 'function') return null;
  const status = firefliesLiveJoinStatus({ nowMs, apiKeyPresent });
  const booked = collectLiveSessions(clients, nowMs);
  const reason = firefliesLiveJoinAlertReason({ status, booked, nowMs, sinceMs: observerSinceMs, liveJoinEnabled });
  if (!reason || !claimFirefliesLiveJoinAlert({ nowMs })) return null;
  const email = buildLiveJoinAlertEmail({ reason, status, booked, nowMs, to: text(env.FIREFLIES_ALERT_EMAIL) || DEFAULT_ALERT_EMAIL });
  try {
    await sendEmail(email);
    log?.warn?.(`[fireflies] live-join alert sent reason=${reason} to=${email.to}`);
  } catch (error) {
    log?.warn?.(`[fireflies] live-join alert reason=${reason} not sent: ${text(error?.message) || error}`);
  }
  return { reason, to: email.to };
}

/**
 * GET /api/admin/fireflies/live-join-status: firefliesLiveJoinStatus plus the Fireflies rate-limit state,
 * the health alert's current reason and last send, and whether lobby alerts are on.
 */
export function liveJoinStatusPayload({
  nowMs = Date.now(),
  apiKeyPresent,
  clients = [],
  liveJoinEnabled = true,
  lobbyAlertsEnabled = true,
} = {}) {
  const status = firefliesLiveJoinStatus({ nowMs, apiKeyPresent });
  const booked = collectLiveSessions(clients, nowMs);
  return {
    ...status,
    rateLimit: firefliesRateLimitStatus(nowMs),
    liveJoinEnabled: Boolean(liveJoinEnabled),
    lobbyAlertsEnabled: Boolean(lobbyAlertsEnabled),
    alert: {
      reason: firefliesLiveJoinAlertReason({ status, booked, nowMs, sinceMs: observerSinceMs || nowMs, liveJoinEnabled }),
      lastAlertAt: lastFirefliesLiveJoinAlertAt(),
    },
  };
}

export function resetFirefliesLiveAlertsForTests() {
  observerSinceMs = 0;
  lobbySkipsLogged.clear();
}
