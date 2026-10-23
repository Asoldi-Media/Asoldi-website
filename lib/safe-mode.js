/**
 * Hub safe mode: state, guards, intent log and the background job plan.
 *
 * server.js installs safe mode once at boot (lib/safe-mode-boot.js). Library code
 * asks `guardExternal(kind, detail)` before an external write; while safe mode is
 * off (asoldi.com) every guard is a pass-through. Nothing here is active until
 * installSafeMode() runs, so unit tests that import a library stay unaffected.
 *
 * Intents (blocked attempts) go to <dataDir>/safe-mode/intents.jsonl with a short,
 * secret-free detail, and to in-memory counters shown on the Superadmin page.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getPersistentDataDir } from '../data/storage-path.js';
import { SAFE_MODE_ALLOW_KEYS, safeModeState } from './runtime-mode.js';
import {
  buildEgressPolicy,
  describeEgressPolicy,
  installEgressGuard,
  isEgressGuardInstalled,
  uninstallEgressGuard,
} from './safe-mode-egress.js';

export class SafeModeBlockedError extends Error {
  constructor(kind = 'external', detail = '') {
    super(`Blocked by hub safe mode (${kind})${detail ? `: ${detail}` : ''}. Allow it with HUB_SAFE_MODE_ALLOW=${kind} if you really mean it.`);
    this.name = 'SafeModeBlockedError';
    this.code = 'ESAFEMODE';
    this.kind = kind;
    this.status = 423;
    this.statusCode = 423;
    this.safeMode = true;
  }
}

const INTENTS_MAX_BYTES = 5 * 1024 * 1024;

let current = null;

function clean(value) {
  return String(value ?? '').trim();
}

/** Strip anything that could carry a secret: query strings, long tokens, auth-looking pairs. */
export function scrubDetail(value = '') {
  let text = clean(typeof value === 'string' ? value : JSON.stringify(value ?? ''));
  text = text.replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, '$1');
  text = text.replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, '$1_$2_***');
  text = text.replace(/\b(api[_-]?key|token|secret|password|pass|authorization|bearer)\b\s*[:=]\s*[^\s,;&"']+/gi, '$1=***');
  text = text.replace(/\b[A-Za-z0-9_\-]{40,}\b/g, '***');
  return text.slice(0, 240);
}

function emptyCounters() {
  return { email: { outboxed: 0, redirected: 0 }, blocked: {}, egress: {} };
}

/**
 * Decide and (when on) activate safe mode for this process. Returns the state.
 * Options: env, ctx (cwd/home for tests), dataDir, log (console-like), egress (default true).
 */
export function installSafeMode({ env = process.env, ctx = {}, dataDir = '', log = console, egress = true } = {}) {
  const state = safeModeState(env, ctx);
  if (!state.on) {
    current = null;
    if (isEgressGuardInstalled()) uninstallEgressGuard();
    return state;
  }
  const resolvedDir = clean(dataDir) || getPersistentDataDir();
  current = {
    state,
    env,
    dataDir: resolvedDir,
    since: new Date().toISOString(),
    counters: emptyCounters(),
    policy: buildEgressPolicy({ allow: state.allow, env }),
  };
  if (egress) {
    installEgressGuard(current.policy, {
      onBlocked: (event) => recordIntent(event.kind, event.detail, { layer: event.layer, host: event.host }),
    });
  }
  if (state.unknownAllow.length && log?.warn) {
    log.warn(`[safe-mode] ignoring unknown HUB_SAFE_MODE_ALLOW keys: ${state.unknownAllow.join(',')}`);
  }
  if (log?.log) {
    log.log(`[safe-mode] ON (${state.reason}) allow=${[...state.allow].join(',') || '(none)'}`);
  }
  return state;
}

/** Tests only: drop the installed state and the egress guard. */
export function resetSafeModeForTests() {
  current = null;
  if (isEgressGuardInstalled()) uninstallEgressGuard();
}

export function isSafeModeActive() {
  return Boolean(current);
}

/** True when the action may run: safe mode is off, or the key is allowed. */
export function safeModeAllows(key) {
  if (!current) return true;
  return current.state.allow.has(key);
}

export function safeModeDataDir() {
  return current?.dataDir || getPersistentDataDir();
}

export function safeModeEnv() {
  return current?.env || process.env;
}

export function safeModeCounters() {
  return current ? current.counters : emptyCounters();
}

export function noteSafeModeEmail(kind) {
  if (!current) return;
  if (kind === 'redirected') current.counters.email.redirected += 1;
  else current.counters.email.outboxed += 1;
}

function intentsPath() {
  return join(safeModeDataDir(), 'safe-mode', 'intents.jsonl');
}

/** Append one blocked attempt. Never throws. */
export function recordIntent(kind, detail = '', extra = {}) {
  if (!current) return null;
  const entry = {
    at: new Date().toISOString(),
    kind: clean(kind) || 'external',
    detail: scrubDetail(detail),
    ...(extra.layer ? { layer: extra.layer } : {}),
    ...(extra.host ? { host: clean(extra.host).toLowerCase() } : {}),
  };
  const bucket = extra.layer ? current.counters.egress : current.counters.blocked;
  bucket[entry.kind] = (bucket[entry.kind] || 0) + 1;
  try {
    const file = intentsPath();
    mkdirSync(join(safeModeDataDir(), 'safe-mode'), { recursive: true });
    if (existsSync(file) && statSync(file).size > INTENTS_MAX_BYTES) {
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // the log is best effort
  }
  return entry;
}

export function readRecentIntents(limit = 50) {
  try {
    const file = intentsPath();
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(500, Number(limit) || 50))).reverse().map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * { allowed } for an external action of `kind`. When blocked, records the intent.
 * Pass-through (allowed) when safe mode is off.
 */
export function guardExternal(kind, detail = '') {
  if (!current) return { allowed: true, safeMode: false };
  if (current.state.allow.has(kind)) return { allowed: true, safeMode: true };
  recordIntent(kind, detail);
  return { allowed: false, safeMode: true };
}

/** Run `realFn` when allowed, otherwise record the intent and return `fakeResult` (value or function). */
export async function safeOr(kind, detail, realFn, fakeResult) {
  if (guardExternal(kind, detail).allowed) return realFn();
  return typeof fakeResult === 'function' ? fakeResult() : fakeResult;
}

/** Throw SafeModeBlockedError (status 423) when blocked. */
export function assertSafeModeAllows(kind, detail = '') {
  if (!guardExternal(kind, detail).allowed) throw new SafeModeBlockedError(kind, scrubDetail(detail));
}

// ── background jobs ──────────────────────────────────────────────────────────

/**
 * Every background loop and startup backfill server.js starts. `safe` is the default
 * while safe mode is on; `key` lets HUB_SAFE_MODE_ALLOW switch an "off" job on.
 */
export const BACKGROUND_JOBS = Object.freeze({
  salesReminders: { safe: 'on', key: '', note: 'emails land in the outbox' },
  workshopDeskEmails: { safe: 'on', key: '', note: 'emails land in the outbox' },
  salesBookingFactsBackfill: { safe: 'on', key: '', note: 'local data only' },
  firefliesMeetLinkBackfill: { safe: 'on', key: '', note: 'local data only' },
  nyAssignmentBackfill: { safe: 'on', key: '', note: 'local data only' },
  firefliesLiveJoin: { safe: 'off', key: 'firefliesLiveJoin', note: 'sends the notetaker into real Meets' },
  firefliesIngest: { safe: 'off', key: 'firefliesIngest', note: 'pulls real transcripts and drives offer AI' },
  inboxBot: { safe: 'off', key: 'inboxRead', note: 'reads the real mailboxes' },
  myphonerWebhookReconcile: { safe: 'off', key: 'myphonerSync', note: 'Myphoner API traffic' },
  myphonerRecordingRetry: { safe: 'off', key: 'myphonerSync', note: 'downloads recordings' },
  salesGeocodeWarmup: { safe: 'off', key: 'geocode', note: 'geocoding API traffic' },
  lanPreviewAutoPublish: { safe: 'off', key: 'prodPublish', note: 'pushes previews to asoldi.com' },
  mapsRanking: { safe: 'off', key: 'mapsRanking', note: 'paid DataForSEO calls' },
  salesRecordingBackfill: { safe: 'off', key: 'startupBackfills', note: 'downloads recordings' },
  salesLinkBackfill: { safe: 'off', key: 'startupBackfills', note: 'paid search calls' },
  ssuWinsBackfill: { safe: 'off', key: 'startupBackfills', note: 'Myphoner API traffic' },
});

/** { jobName: 'on' | 'off' } for the current process (all 'on' when safe mode is off). */
export function backgroundJobPlan(stateOverride = null) {
  const state = stateOverride || current?.state || null;
  const plan = {};
  for (const [name, job] of Object.entries(BACKGROUND_JOBS)) {
    if (!state || !state.on) {
      plan[name] = 'on';
      continue;
    }
    plan[name] = job.safe === 'on' || (job.key && state.allow.has(job.key)) ? 'on' : 'off';
  }
  return plan;
}

/**
 * Start the jobs in `jobMap` ({ name: () => void }) that the plan allows. Unknown
 * names are treated as "off" in safe mode so a new loop has to be classified first.
 */
export function runBackgroundJobs(jobMap = {}, { log = console } = {}) {
  const plan = backgroundJobPlan();
  const started = [];
  const skipped = [];
  for (const [name, start] of Object.entries(jobMap)) {
    const decision = plan[name] || (current ? 'off' : 'on');
    if (decision !== 'on') {
      skipped.push(name);
      continue;
    }
    try {
      start();
      started.push(name);
    } catch (error) {
      log?.error?.(`[jobs] ${name} failed to start:`, error?.message || error);
    }
  }
  if (current && log?.log) {
    log.log(`[safe-mode] jobs on=${started.join(',') || '(none)'} off=${skipped.join(',') || '(none)'}`);
  }
  return { started, skipped };
}

/** Snapshot for GET /api/admin/system/safe-mode and the Superadmin page. */
export function describeSafeMode() {
  if (!current) {
    return { safeMode: false, reason: safeModeState().reason, allow: [], jobs: backgroundJobPlan(), counters: emptyCounters(), since: '', egress: [], keys: SAFE_MODE_ALLOW_KEYS };
  }
  return {
    safeMode: true,
    reason: current.state.reason,
    allow: [...current.state.allow],
    unknownAllow: current.state.unknownAllow,
    jobs: backgroundJobPlan(),
    counters: current.counters,
    since: current.since,
    egress: describeEgressPolicy(current.policy),
    keys: SAFE_MODE_ALLOW_KEYS,
    emailRedirectTo: clean(current.env.EMAIL_REDIRECT_TO) && current.state.allow.has('emailRedirect') ? clean(current.env.EMAIL_REDIRECT_TO) : '',
  };
}
