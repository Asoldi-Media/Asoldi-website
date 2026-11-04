// Delivery alerts: conditions the delivery loop checks on every tick (also while it is paused).
//
// Conditions (thresholds from automation settings `alerts.*`):
//   host-offline:<hostId>   a Maker host with work routed to it has not been seen for more than
//                           alerts.hostOfflineHours;
//   job-blocked:<jobId>     a job blocked or failed for more than alerts.jobBlockedHours (an admin
//                           retry or cancel ends it; cancel also takes a failed job);
//   loop-stalled            more than 15 minutes since the previous successful tick (so the first
//                           tick after a restart reports an outage); a success from before the
//                           loop was last off or switched on does not count;
//   loop-error:<step>       a tick step failed in the last 15 minutes;
//   maker-auth-failures     more than 30 refused Maker requests in 10 minutes (lib/maker-auth.js
//                           reports these through noteMakerAuthAlert);
//   switch-paused:<path>    an automation switch is paused (a runtime guard or a person).
//
// State: delivery-hot/alerts.json { active, history, mailed, lastDigestDay }, written only when an
// alert starts or clears, a mail goes out or the digest is sent. A new alert sends one mail to
// alerts.to, at most once per key in 6 hours; a daily digest of the active alerts goes out after
// alerts.digestAt (Oslo time), unless every active alert was already mailed on its own that day
// after alerts.digestAt (then the day's digest counts as sent). Mail goes out only while
// delivery.loop is configured for auto (with pilots); in shadow alerts are recorded and shown,
// never mailed. Mail uses lib/email.js, which puts it in the safe-mode outbox when safe mode is
// on. The process also remembers what it mailed, so a state file that cannot be written never
// turns into a mail every tick.
import { join } from 'node:path';
import { PAUSABLE_SWITCHES } from '../data/automation-settings.js';
import { listMakerHosts } from '../data/maker-hosts.js';
import { listJobs } from './delivery-jobs.js';
import { createHostHeartbeatStore } from './maker-host-meta.js';
import { hotPath, readHotJson, updateHotJson } from './hot-store.js';

export const ALERTS_FILE = join('delivery-hot', 'alerts.json');
export const ALERT_DEDUPE_MS = 6 * 60 * 60 * 1000;
export const LOOP_STALL_MS = 15 * 60 * 1000;
export const LOOP_ERROR_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_ALERT_WINDOW_MS = 10 * 60 * 1000;
export const ALERT_HISTORY_MAX = 50;
const ACTIVE_JOB = new Set(['queued', 'claimed', 'running', 'retrying']);
const STUCK_JOB = new Set(['blocked', 'failed']);
const HOUR_MS = 60 * 60 * 1000;

const authAlerts = [];
// What this process mailed: `<alerts file>|<key>` → ms, and `<alerts file>` → digest day. Used
// next to the stored marks, so a failed state write does not send the same mail again.
const mailedMemo = new Map();
const digestMemo = new Map();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function hours(ms) {
  return Math.round((ms / HOUR_MS) * 10) / 10;
}

function getPath(obj, path) {
  return path.split('.').reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), obj);
}

/** createMakerAuth({ onAlert }) hook: remembers the burst in memory (nothing is written here). */
export function noteMakerAuthAlert(info = {}) {
  authAlerts.push({ at: toMs(info.at) || Date.now(), failures: Number(info.failures) || 0, windowMs: Number(info.windowMs) || AUTH_ALERT_WINDOW_MS });
  while (authAlerts.length > 20) authAlerts.shift();
}

export function resetDeliveryAlertsMemoryForTests() {
  authAlerts.length = 0;
  mailedMemo.clear();
  digestMemo.clear();
}

/** Every switch path that can carry a pause. */
export function pausableSwitchPaths() {
  return [...new Set([...PAUSABLE_SWITCHES, 'delivery.loop'])];
}

/**
 * The alerts that hold now. Pure apart from the inputs: { now, settings, jobs, hosts,
 * heartbeats ({hostId: {lastHeartbeatAt}}), previousSuccessAt, recentErrors, authBursts }.
 */
export function evaluateAlertConditions({ now = Date.now(), settings = {}, jobs = [], hosts = [], heartbeats = {}, previousSuccessAt = null, recentErrors = [], authBursts = [] } = {}) {
  const alerts = [];
  const offlineMs = (Number(settings?.alerts?.hostOfflineHours) || 2) * HOUR_MS;
  const blockedMs = (Number(settings?.alerts?.jobBlockedHours) || 24) * HOUR_MS;

  for (const host of hosts) {
    if (!host || host.revokedAt || host.revoked) continue;
    const routed = jobs.filter((job) => job.hostId === host.hostId && ACTIVE_JOB.has(job.status));
    if (!routed.length) continue;
    const seen = Math.max(toMs(heartbeats?.[host.hostId]?.lastHeartbeatAt), toMs(host.lastSeenAt));
    const since = seen || Math.min(...routed.map((job) => toMs(job.createdAt) || now));
    if (now - since <= offlineMs) continue;
    alerts.push({
      key: `host-offline:${host.hostId}`,
      kind: 'host-offline',
      message: `Maker-verten ${host.label || host.hostId} har ikke vært i kontakt på ${hours(now - since)} t, og ${routed.length} jobb(er) venter på den.`,
      data: { hostId: host.hostId, jobs: routed.length, since: iso(since) },
    });
  }

  for (const job of jobs) {
    if (!STUCK_JOB.has(job.status)) continue;
    const since = toMs(job.updatedAt || job.doneAt || job.createdAt);
    if (!since || now - since <= blockedMs) continue;
    alerts.push({
      key: `job-blocked:${job.id}`,
      kind: 'job-blocked',
      message: `Jobben ${job.kind} for kunde ${job.salesClientId} har stått som ${job.status} i ${hours(now - since)} t${job.blocking ? ` (${job.blocking})` : ''}.`,
      data: { jobId: job.id, clientId: job.salesClientId, status: job.status, blocking: job.blocking || '' },
    });
  }

  const previous = toMs(previousSuccessAt);
  if (previous && now - previous > LOOP_STALL_MS) {
    alerts.push({
      key: 'loop-stalled',
      kind: 'loop-stalled',
      message: `Leveranse-løkken gikk ikke på ${Math.round((now - previous) / 60000)} min (siste vellykkede runde ${iso(previous)}).`,
      data: { lastSuccessAt: iso(previous) },
    });
  }

  const failedSteps = new Map();
  for (const error of Array.isArray(recentErrors) ? recentErrors : []) {
    if (now - toMs(error?.at) > LOOP_ERROR_WINDOW_MS) continue;
    failedSteps.set(String(error.step || 'tick'), error);
  }
  for (const [step, error] of failedSteps) {
    alerts.push({
      key: `loop-error:${step}`,
      kind: 'loop-error',
      message: `Steget ${step} i leveranse-løkken feilet: ${String(error.error || '').slice(0, 200)}`,
      data: { step },
    });
  }

  const burst = (Array.isArray(authBursts) ? authBursts : []).filter((row) => now - toMs(row.at) <= AUTH_ALERT_WINDOW_MS);
  if (burst.length) {
    const failures = Math.max(...burst.map((row) => Number(row.failures) || 0));
    alerts.push({
      key: 'maker-auth-failures',
      kind: 'maker-auth-failures',
      message: `${failures} avviste Maker-forespørsler på 10 min.`,
      data: { failures },
    });
  }

  for (const path of pausableSwitchPaths()) {
    const paused = getPath(settings, `${path}.paused`);
    if (!isPlainObject(paused)) continue;
    alerts.push({
      key: `switch-paused:${path}`,
      kind: 'switch-paused',
      message: `Bryteren ${path} er satt på pause: ${String(paused.reason || '').slice(0, 200)}`,
      data: { path, at: String(paused.at || ''), by: String(paused.by || '') },
    });
  }
  return alerts;
}

// ---------------------------------------------------------------- state

export function alertsPath({ dataDir } = {}) {
  return hotPath(ALERTS_FILE, { dataDir });
}

export function readAlertState({ dataDir } = {}) {
  const raw = readHotJson(alertsPath({ dataDir }), { fresh: true });
  return {
    active: isPlainObject(raw?.active) ? raw.active : {},
    history: Array.isArray(raw?.history) ? raw.history : [],
    mailed: isPlainObject(raw?.mailed) ? raw.mailed : {},
    lastDigestDay: String(raw?.lastDigestDay || ''),
  };
}

/** True when settings ask the loop for auto with pilots (alert mail goes out only then). */
export function alertMailEnabled(settings) {
  const loop = settings?.delivery?.loop;
  return Boolean(loop?.enabled === true && loop.mode === 'auto' && Array.isArray(settings?.pilotClientIds) && settings.pilotClientIds.length);
}

function osloClock(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms))
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function alertMail(alert) {
  return {
    subject: `[Asoldi] Leveransevarsel: ${alert.kind}`,
    text: `${alert.message}\n\nSe /api/admin/system/delivery-alerts for alle aktive varsler.`,
  };
}

function digestMail(active) {
  const lines = active.map((alert) => `- ${alert.message} (siden ${alert.since})`);
  return {
    subject: `[Asoldi] Leveransevarsler: ${active.length} aktive`,
    text: `Aktive leveransevarsler:\n\n${lines.join('\n')}\n`,
  };
}

async function defaultSendMail(message) {
  const { sendEmail } = await import('./email.js');
  return sendEmail(message);
}

/**
 * Applies the conditions to the stored state: new alerts start (and mail), resolved ones clear.
 * Writes only on a change. Returns { started, cleared, mailed, digest, digestCovered?, wrote }.
 */
export async function processAlerts({ now = Date.now(), settings, conditions, dataDir, sendMail = defaultSendMail, log = console } = {}) {
  const current = readAlertState({ dataDir });
  const file = alertsPath({ dataDir });
  const lastMailedAt = (key) => Math.max(toMs(current.mailed[key]), mailedMemo.get(`${file}|${key}`) || 0);
  const byKey = new Map(conditions.map((alert) => [alert.key, alert]));
  const started = conditions.filter((alert) => !current.active[alert.key]);
  const cleared = Object.keys(current.active).filter((key) => !byKey.has(key));
  const mailOn = alertMailEnabled(settings);
  const to = String(settings?.alerts?.to || '').trim();
  const mailed = [];
  if (mailOn && to) {
    for (const alert of started) {
      if (now - lastMailedAt(alert.key) < ALERT_DEDUPE_MS) continue;
      try {
        await sendMail({ to, ...alertMail(alert) });
        mailedMemo.set(`${file}|${alert.key}`, now);
        mailed.push(alert.key);
      } catch (error) {
        log?.warn?.(`[delivery-alerts] alert mail failed: ${String(error?.message || error).slice(0, 200)}`);
      }
    }
  }
  let digest = false;
  let digestCovered = false;
  const clock = osloClock(now);
  const digestAt = /^\d{2}:\d{2}$/.test(String(settings?.alerts?.digestAt || '')) ? settings.alerts.digestAt : '08:00';
  const activeAfter = conditions.map((alert) => ({ ...alert, since: current.active[alert.key]?.since || iso(now) }));
  if (mailOn && to && activeAfter.length && current.lastDigestDay !== clock.day && digestMemo.get(file) !== clock.day && clock.time >= digestAt) {
    // An alert mailed on its own today after the digest time needs no digest: when that holds for
    // every active alert, today's digest counts as sent without a mail (no alert reaches alerts.to
    // twice within a minute, once alone and once as a digest of itself).
    const mailedSinceDigestTime = (key) => {
      const at = lastMailedAt(key);
      if (!at) return false;
      const sent = osloClock(at);
      return sent.day === clock.day && sent.time >= digestAt;
    };
    if (activeAfter.every((alert) => mailedSinceDigestTime(alert.key))) {
      digestMemo.set(file, clock.day);
      digestCovered = true;
    } else {
      try {
        await sendMail({ to, ...digestMail(activeAfter) });
        digestMemo.set(file, clock.day);
        digest = true;
      } catch (error) {
        log?.warn?.(`[delivery-alerts] digest mail failed: ${String(error?.message || error).slice(0, 200)}`);
      }
    }
  }
  if (!started.length && !cleared.length && !mailed.length && !digest && !digestCovered) return { started: [], cleared: [], mailed: [], digest: false, wrote: false };
  updateHotJson(alertsPath({ dataDir }), (raw) => {
    const active = isPlainObject(raw?.active) ? { ...raw.active } : {};
    const history = Array.isArray(raw?.history) ? [...raw.history] : [];
    const mailedAt = isPlainObject(raw?.mailed) ? { ...raw.mailed } : {};
    for (const alert of started) active[alert.key] = { key: alert.key, kind: alert.kind, message: alert.message, data: alert.data || {}, since: iso(now) };
    for (const key of cleared) {
      const row = active[key];
      if (row) history.push({ ...row, clearedAt: iso(now) });
      delete active[key];
    }
    for (const key of mailed) mailedAt[key] = iso(now);
    for (const [key, at] of Object.entries(mailedAt)) if (now - toMs(at) > ALERT_DEDUPE_MS && !active[key]) delete mailedAt[key];
    for (const [memoKey, at] of mailedMemo) if (now - at > ALERT_DEDUPE_MS) mailedMemo.delete(memoKey);
    return {
      version: 1,
      active,
      history: history.slice(-ALERT_HISTORY_MAX),
      mailed: mailedAt,
      lastDigestDay: digest || digestCovered ? clock.day : String(raw?.lastDigestDay || ''),
      updatedAt: iso(now),
    };
  });
  return { started: started.map((alert) => alert.key), cleared, mailed, digest, ...(digestCovered ? { digestCovered: true } : {}), wrote: true };
}

/** Inputs for evaluateAlertConditions from the stores (jobs, hosts, heartbeats). */
export function collectAlertInputs({ dataDir, heartbeats = {} } = {}) {
  let jobs = [];
  let hosts = [];
  try {
    jobs = listJobs({ dataDir });
  } catch {
    jobs = [];
  }
  try {
    hosts = listMakerHosts({ dataDir });
  } catch {
    hosts = [];
  }
  return { jobs, hosts, heartbeats };
}

/** Last heartbeat per host from the heartbeat hot file (written by the heartbeat route). */
export function readHeartbeatFile({ dataDir } = {}) {
  try {
    return createHostHeartbeatStore({ dataDir }).read();
  } catch {
    return {};
  }
}

/** The live alert list for the admin route (nothing is written). */
export function currentAlerts({ dataDir, settings, now = Date.now(), heartbeats = {}, previousSuccessAt = null, recentErrors = [] } = {}) {
  const inputs = collectAlertInputs({ dataDir, heartbeats });
  return evaluateAlertConditions({ now, settings, ...inputs, previousSuccessAt, recentErrors, authBursts: authAlerts });
}

/**
 * The success time the stall check compares with, or null for no check: a tick on a test clock
 * jumps in time, and a success from before the loop was last off (or switched on) is no outage.
 */
function stallBaseline(ctx) {
  if (ctx.loop?.clockOverride) return null;
  const previous = ctx.loop?.previous?.lastSuccessAt || null;
  if (!previous || ctx.now - toMs(previous) <= LOOP_STALL_MS) return previous;
  const offSince = typeof ctx.loop?.offSince === 'function' ? Number(ctx.loop.offSince()) || 0 : 0;
  return offSince && offSince >= toMs(previous) ? null : previous;
}

export const tickSteps = [
  {
    name: 'alerts',
    order: 100,
    scope: 'global',
    whenPaused: true,
    run: async (ctx) => {
      const heartbeats = typeof ctx.deps?.readHeartbeats === 'function' ? ctx.deps.readHeartbeats() : readHeartbeatFile({ dataDir: ctx.dataDir });
      const conditions = currentAlerts({
        dataDir: ctx.dataDir,
        settings: ctx.settings,
        now: ctx.now,
        heartbeats,
        previousSuccessAt: stallBaseline(ctx),
        recentErrors: typeof ctx.loop?.recentErrors === 'function' ? ctx.loop.recentErrors() : [],
      });
      const result = await processAlerts({
        now: ctx.now,
        settings: ctx.settings,
        conditions,
        dataDir: ctx.dataDir,
        sendMail: typeof ctx.deps?.sendMail === 'function' ? ctx.deps.sendMail : defaultSendMail,
        log: ctx.log,
      });
      return { ...result, wrote: result.wrote };
    },
  },
];
