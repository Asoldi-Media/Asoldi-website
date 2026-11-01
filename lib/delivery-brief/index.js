/**
 * The delivery brief: rebuild, re-assembly after a review, and the delivery-loop step.
 *
 * Switch `brief` ({ enabled, mode }) in automation settings, resolved per client with
 * spineModeForClient('brief', client):
 *   off     nothing is built, the routes answer 404 {code:'brief-disabled'};
 *   shadow  briefs are built and stored, and admins can read them; the Maker gets 404;
 *   auto    the Maker can fetch them too (pilot clients only; everyone else stays in shadow).
 *
 * Every rebuild holds the lease brief:<clientId> (the loop step and the board's rebuild alike), so
 * two runners never pay for the same chunks or interleave their writes; the lease is renewed before
 * each LLM call and before anything is saved, and a rebuild that lost it writes nothing. The privacy
 * erase takes the same lease. Every save assembles the brief inside the client's save lock from the
 * reviews (and, for a re-assembly, the extraction) as they are at that moment, so a review saved while
 * a rebuild runs is never overwritten by the rebuild's older assembly.
 *
 * Loop step `brief-rebuild` (scope client): only for clients with a plan in force, a delivery stage
 * from `signed` on, or a place on the pilot list. It rebuilds when the client's input hash changed and
 * has stayed the same for REBUILD_DEBOUNCE_MS; at most MAX_STARTS_PER_TICK rebuilds start per tick
 * and they share TICK_WALL_MS of wall time. A rebuild that runs out of time keeps its cached chunks
 * and the next tick resumes it without waiting. A chunk whose call failed waits out its backoff
 * (extract.js), so a stuck chunk costs a bounded number of calls. Nothing runs while the loop's own
 * mode (ctx.mode) is off.
 */
import { acquireLease } from '../../data/email-store.js';
import { getAutomationSettings } from '../../data/automation-settings.js';
import { STAGES } from '../../packages/suite/core/delivery/vocab.js';
import { spineModeForClient } from '../spine-mode.js';
import { activeSitePlan } from '../site-plan-model.js';
import { assembleBrief } from './assemble.js';
import { backoffDelayMs, createChunkCache, extractMeeting } from './extract.js';
import { validateDeliveryBrief } from './facts-contract.js';
import { llmMergeItems, reduceItems } from './reduce.js';
import { gatherBriefSources, loadClientProfiles, loadHubSites } from './sources.js';
import {
  assertClientId,
  chunkCacheDir,
  readBriefState,
  readExtraction,
  readReviews,
  registerBriefStore,
  reviewFact,
  saveBrief,
  updateBriefState,
  withFactReview,
  writeExtraction,
} from './store.js';
import { isPlainObject, isoOrEmpty, text } from './text.js';

export const BRIEF_SWITCH = 'brief';
export const REBUILD_DEBOUNCE_MS = 10 * 60 * 1000;
export const MAX_STARTS_PER_TICK = 2;
export const TICK_WALL_MS = 5 * 60 * 1000;
export const LEASE_TTL_MS = TICK_WALL_MS + 60 * 1000;
const SIGNED_STAGE = STAGES.indexOf('signed');
const EMPTY_EXTRACTION = Object.freeze({ items: [], meetings: [], extractedItems: 0, mergeUsd: 0, durationMs: 0 });

/** off | shadow | paused | auto for one client. */
export function briefModeForClient(client, options = {}) {
  return spineModeForClient(BRIEF_SWITCH, client, options);
}

/** A linked meeting with talk that is not live captions (a row flagged live or partial does not count). */
function hasTranscribedMeeting(client) {
  return (Array.isArray(client?.meetings) ? client.meetings : []).some((row) => {
    const id = text(row?.meetingId).toLowerCase();
    if (!id || id.startsWith('live:') || row.isLive === true || row.partial === true) return false;
    return row.hasTranscript === true || Number(row.sentenceCount) > 0;
  });
}

/**
 * The loop builds a brief only for a client who bought something or is a pilot: a plan in force, a
 * delivery stage from `signed` on, or (with a transcribed meeting) a place on the pilot list. Sales
 * leads' meetings are never sent to the model by the loop.
 */
export function clientNeedsBrief(client, { settings = null } = {}) {
  if (activeSitePlan(client)) return true;
  const stage = STAGES.indexOf(text(client?.delivery?.stage));
  if (SIGNED_STAGE >= 0 && stage >= SIGNED_STAGE) return true;
  const pilots = Array.isArray(settings?.pilotClientIds) ? settings.pilotClientIds : [];
  return pilots.includes(text(client?.id)) && hasTranscribedMeeting(client);
}

async function defaultLlm() {
  const mod = await import('../llm/index.js');
  return mod.getHubLlm();
}

function errorCode(error) {
  return text(error?.code || error?.name || 'error', 60);
}

function codedError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** Throws code brief-invalid when the assembled brief does not match the schema (nothing is saved). */
function assertValidBrief(brief) {
  const check = validateDeliveryBrief(brief, { maxErrors: 10 });
  if (!check.valid) throw codedError('The assembled brief does not match its schema.', 'brief-invalid', { errors: check.errors });
}

/**
 * Assembles, checks and saves inside the client's save lock: the reviews (and, without `extraction`,
 * the stored extraction) are read there, so the saved brief always has the newest of both.
 */
function assembleAndSave({ client, clientId, sources, extraction = null, dataDir, now }) {
  return saveBrief(clientId, () => {
    const brief = assembleBrief({
      client,
      sources,
      extraction: extraction || readExtraction(clientId, { dataDir }) || EMPTY_EXTRACTION,
      reviews: readReviews(clientId, { dataDir }),
      now: new Date(now()),
    });
    assertValidBrief(brief);
    return brief;
  }, { dataDir, now: new Date(now()) });
}

/** Removes cached chunk and merge answers no current meeting or merge uses (after a complete rebuild). */
function pruneChunkCache(cache, keep, log) {
  if (typeof cache?.keys !== 'function' || typeof cache?.delete !== 'function') return 0;
  let removed = 0;
  try {
    for (const key of cache.keys()) {
      if (keep.has(key)) continue;
      cache.delete(key);
      removed += 1;
    }
  } catch (error) {
    log?.warn?.(`[delivery-brief] chunk cache prune failed: ${error?.code || error?.message || 'error'}`);
  }
  return removed;
}

function meetingStatsOf(meetings) {
  return meetings.map((meeting) => ({
    meetingId: meeting.meetingId,
    purpose: meeting.purpose,
    chunks: meeting.chunks,
    droppedUnverified: meeting.droppedUnverified,
    droppedInvalid: meeting.droppedInvalid,
    costUsd: meeting.costUsd,
    routes: meeting.routes,
    errors: [...new Set(meeting.errors)].slice(0, 10),
    ...(meeting.chunks.gaps ? { needsReview: true } : {}),
  }));
}

/**
 * Extracts every meeting (cached chunks are reused), reduces, assembles and saves a new version
 * when the brief changed. Returns { status: 'built'|'unchanged'|'partial'|'lease-lost', version, hash,
 * inputHash, stats, meetings, retryAt? }.
 *   partial     some chunks failed, wait out their backoff or ran out of time; only the rebuild state
 *               is saved (retryAt says when a failed chunk may be asked again; '' means at once).
 *   lease-lost  another runner took the lease while this one ran; nothing was written.
 * Options: lease (a held lease brief:<clientId>; without one the rebuild takes it and throws code
 * brief-busy while another runner holds it), backoffNow (the clock for chunk backoff, ms),
 * ignoreBackoff (a person asked: retry waiting chunks now), retryGaps (ask cached gaps again).
 */
export async function rebuildBrief(client, options = {}) {
  const clientId = assertClientId(client?.id);
  if (options.lease) return rebuildUnderLease(client, clientId, options, options.lease);
  const lease = await acquireLease(`brief:${clientId}`, LEASE_TTL_MS);
  if (!lease) throw codedError('Another rebuild of this brief is running.', 'brief-busy');
  try {
    return await rebuildUnderLease(client, clientId, options, lease);
  } finally {
    await lease.release();
  }
}

async function rebuildUnderLease(client, clientId, {
  llm = null,
  dataDir,
  deps = {},
  sources = null,
  deadline = Infinity,
  now = () => Date.now(),
  log = console,
  mergeThreshold,
  backoffNow = null,
  ignoreBackoff = false,
  retryGaps = false,
} = {}, lease) {
  const started = now();
  const stamp = Number.isFinite(backoffNow) ? backoffNow : started;
  await registerBriefStore({ log });
  const input = sources || (await gatherBriefSources(client, { deps, log }));
  const cache = deps.chunkCache || createChunkCache(chunkCacheDir(clientId, { dataDir }));
  const model = llm || (await defaultLlm());
  const state = readBriefState(clientId, { dataDir });
  const failures = isPlainObject(state.chunkFailures) ? structuredClone(state.chunkFailures) : {};
  const retry = { failures, nowMs: stamp, ignoreBackoff: ignoreBackoff === true };
  const run = { halted: false, reason: '' };
  const keepAlive = () => lease.renew(LEASE_TTL_MS);
  const lost = (meetingStats = []) => {
    log?.warn?.(`[delivery-brief] ${clientId}: the rebuild lease was taken over; nothing was saved`);
    return { status: 'lease-lost', version: 0, hash: '', inputHash: input.inputHash, meetings: meetingStats };
  };

  const meetings = [];
  for (const meeting of input.meetings) {
    meetings.push(await extractMeeting({
      meeting,
      llm: model,
      cache,
      clientId,
      featureKeys: input.featureKeys,
      deadline,
      now,
      retry,
      run,
      retryGaps: retryGaps === true,
      beforeCall: keepAlive,
    }));
  }
  // Failure records of chunks that are no longer in any transcript are dropped.
  const keys = new Set(meetings.flatMap((meeting) => meeting.keys));
  for (const key of Object.keys(failures)) if (!keys.has(key)) delete failures[key];
  const meetingStats = meetingStatsOf(meetings);
  if (run.reason === 'lease-lost') return lost(meetingStats);

  if (meetings.some((meeting) => !meeting.complete)) {
    if (!(await keepAlive())) return lost(meetingStats);
    const cutShort = meetings.some((meeting) => meeting.chunks.skipped > 0);
    const next = Object.values(failures).map((record) => Date.parse(record?.nextAt || '')).filter(Number.isFinite);
    const retryAt = cutShort || !next.length ? '' : new Date(Math.min(...next)).toISOString();
    updateBriefState(clientId, {
      partial: true,
      partialInputHash: input.inputHash,
      lastAttemptAt: new Date(stamp).toISOString(),
      lastErrors: [...new Set(meetings.flatMap((meeting) => meeting.errors))].slice(0, 10),
      chunkFailures: failures,
      retryAt,
    }, { dataDir });
    return { status: 'partial', version: 0, hash: '', inputHash: input.inputHash, retryAt, meetings: meetingStats };
  }
  let reduced = reduceItems(meetings.flatMap((meeting) => meeting.items));
  if (!(await keepAlive())) return lost(meetingStats);
  const merge = await llmMergeItems(reduced, { llm: model, cache, clientId, deadline, now, ...(mergeThreshold !== undefined ? { threshold: mergeThreshold } : {}) });
  reduced = merge.reduced;
  const extraction = {
    version: 1,
    inputHash: input.inputHash,
    promptHash: input.promptHash,
    items: reduced.items,
    meetings: meetingStats,
    extractedItems: meetings.reduce((sum, meeting) => sum + meeting.items.length + meeting.droppedUnverified, 0),
    mergeUsd: merge.usd,
    merged: merge.merged,
    durationMs: Math.max(0, now() - started),
  };
  // A trial assembly first: a brief that does not match its schema stops here, before anything is written.
  assertValidBrief(assembleBrief({ client, sources: input, extraction, reviews: readReviews(clientId, { dataDir }), now: new Date(now()) }));
  if (!(await keepAlive())) return lost(meetingStats);
  writeExtraction(clientId, extraction, { dataDir });
  const saved = assembleAndSave({ client, clientId, sources: input, extraction, dataDir, now });
  const brief = saved.brief;
  // Cached answers for chunks no current transcript has (an edited transcript, a changed prompt) and
  // merge answers no longer used are removed, so the cache does not grow without bound.
  const keep = new Set(meetings.flatMap((meeting) => meeting.keys));
  if (merge.key) keep.add(merge.key);
  pruneChunkCache(cache, keep, log);
  updateBriefState(clientId, {
    builtInputHash: input.inputHash,
    builtAt: new Date(now()).toISOString(),
    version: saved.version,
    hash: saved.hash,
    partial: false,
    partialInputHash: '',
    pendingHash: '',
    pendingSince: '',
    failures: 0,
    failedInputHash: '',
    failureRetryAt: '',
    lastErrors: [],
    chunkFailures: failures,
    retryAt: '',
  }, { dataDir });
  return { status: saved.changed ? 'built' : 'unchanged', version: saved.version, hash: saved.hash, inputHash: input.inputHash, stats: brief.stats, meetings: meetingStats };
}

/**
 * Re-assembles from the stored extraction (no LLM call), e.g. after a review. Returns the same shape
 * as rebuildBrief, or { status: 'no-extraction' } when the client was never extracted but has meetings.
 */
export async function reassembleBrief(client, { dataDir, deps = {}, now = () => Date.now(), log = console, sources = null } = {}) {
  const clientId = assertClientId(client?.id);
  const input = sources || (await gatherBriefSources(client, { deps, log }));
  const stored = readExtraction(clientId, { dataDir });
  if (!stored && input.meetings.length) return { status: 'no-extraction', version: 0, hash: '', inputHash: input.inputHash };
  // The extraction and the reviews are read again inside the save lock.
  const saved = assembleAndSave({ client, clientId, sources: input, dataDir, now });
  return { status: saved.changed ? 'built' : 'unchanged', version: saved.version, hash: saved.hash, inputHash: input.inputHash, stats: saved.brief.stats };
}

/**
 * Reviews one fact and re-assembles. The review is checked first (store.factReviewEntry: a single
 * fact path or a transcript fact id), then tried on the brief: a review that would make the brief
 * fail its schema (a list or a text where a number belongs, ...) throws code invalid-review and is
 * not stored.
 */
export async function reviewBriefFact(client, path, review = {}, { dataDir, deps = {}, now = () => Date.now(), log = console } = {}) {
  const clientId = assertClientId(client?.id);
  const candidate = withFactReview(readReviews(clientId, { dataDir }), path, review);
  const sources = await gatherBriefSources(client, { deps, log });
  const trial = assembleBrief({ client, sources, extraction: readExtraction(clientId, { dataDir }) || EMPTY_EXTRACTION, reviews: candidate, now: new Date(now()) });
  const check = validateDeliveryBrief(trial, { maxErrors: 5 });
  if (!check.valid) throw codedError('This review would make the brief invalid.', 'invalid-review', { errors: check.errors });
  reviewFact(clientId, path, review, { dataDir });
  return reassembleBrief(client, { dataDir, deps, now, log, sources });
}

// ---------------------------------------------------------------- loop step

let tick = { key: undefined, starts: 0, deadline: 0, memo: new Map() };

function tickBudget(ctx) {
  const key = ctx.tickId ?? ctx.now ?? ctx;
  if (tick.key !== key) tick = { key, starts: 0, deadline: Date.now() + TICK_WALL_MS, memo: new Map() };
  return tick;
}

export function resetBriefTickForTests() {
  tick = { key: undefined, starts: 0, deadline: 0, memo: new Map() };
}

/**
 * Source readers for one tick: all sites and all portal profiles are read once per tick, not per
 * client, and a client's media manifest is built at most once per debounce period.
 */
function tickDeps(ctx, budget, settings) {
  const base = ctx.briefDeps || {};
  const once = (name, load) => () => {
    if (!budget.memo.has(name)) budget.memo.set(name, Promise.resolve().then(load));
    return budget.memo.get(name);
  };
  return {
    ...base,
    sites: typeof base.sites === 'function' ? base.sites : once('sites', loadHubSites),
    profiles: typeof base.profiles === 'function' ? base.profiles : once('profiles', loadClientProfiles),
    settings: isPlainObject(base.settings) ? base.settings : settings,
    mediaCacheMs: Number.isFinite(base.mediaCacheMs) ? base.mediaCacheMs : REBUILD_DEBOUNCE_MS,
    ...(ctx.dataDir && !base.dataDir ? { dataDir: ctx.dataDir } : {}),
  };
}

function nowMsOf(ctx) {
  if (typeof ctx.now === 'number') return ctx.now;
  if (ctx.now instanceof Date) return ctx.now.getTime();
  const parsed = Date.parse(String(ctx.now ?? ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function notYet(nowMs, iso) {
  const at = Date.parse(String(iso || ''));
  return Number.isFinite(at) && nowMs < at;
}

/**
 * The `brief-rebuild` step. ctx: { now, settings, mode, log, dataDir?, llm?, briefDeps?, tickId? }.
 * Returns { wrote, status }.
 */
export async function runBriefRebuildStep(ctx = {}, client = null) {
  if (!client || !['shadow', 'auto'].includes(ctx.mode)) return { wrote: false, status: 'loop-off' };
  const settings = ctx.settings || getAutomationSettings({ dataDir: ctx.dataDir });
  const mode = briefModeForClient(client, { settings });
  if (mode !== 'shadow' && mode !== 'auto') return { wrote: false, status: `brief-${mode}` };
  if (!clientNeedsBrief(client, { settings })) return { wrote: false, status: 'no-input' };
  const clientId = assertClientId(client.id);
  const dataDir = ctx.dataDir;
  const log = ctx.log || console;
  const nowMs = nowMsOf(ctx);
  const budget = tickBudget(ctx);
  const deps = tickDeps(ctx, budget, settings);
  const sources = await gatherBriefSources(client, { deps, log });
  const state = readBriefState(clientId, { dataDir });
  const resume = state.partial === true && state.partialInputHash === sources.inputHash;
  if (!resume && state.builtInputHash === sources.inputHash) return { wrote: false, status: 'unchanged' };
  // A rebuild that failed outright, or a chunk whose call failed, waits out its backoff.
  if (state.failedInputHash === sources.inputHash && notYet(nowMs, state.failureRetryAt)) return { wrote: false, status: 'backoff' };
  if (resume && notYet(nowMs, state.retryAt)) return { wrote: false, status: 'backoff' };
  if (!resume) {
    const since = state.pendingHash === sources.inputHash ? Date.parse(state.pendingSince || '') : NaN;
    if (!Number.isFinite(since)) {
      updateBriefState(clientId, { pendingHash: sources.inputHash, pendingSince: new Date(nowMs).toISOString() }, { dataDir });
      return { wrote: true, status: 'debounce' };
    }
    if (nowMs - since < REBUILD_DEBOUNCE_MS) return { wrote: false, status: 'debounce' };
  }
  if (budget.starts >= MAX_STARTS_PER_TICK || Date.now() >= budget.deadline) return { wrote: false, status: 'deferred' };
  const lease = await acquireLease(`brief:${clientId}`, LEASE_TTL_MS);
  if (!lease) return { wrote: false, status: 'leased' };
  budget.starts += 1;
  try {
    const result = await rebuildBrief(client, {
      llm: ctx.llm || null,
      dataDir,
      deps,
      sources,
      // The wall-time budget is real time; ctx.now (which may be a test clock) drives the debounce
      // and the chunk backoff.
      deadline: budget.deadline,
      log,
      lease,
      backoffNow: nowMs,
    });
    return { wrote: result.status !== 'lease-lost', status: result.status, version: result.version };
  } catch (error) {
    const failures = (Number(state.failures) || 0) + 1;
    updateBriefState(clientId, {
      failures,
      lastErrors: [errorCode(error)],
      lastAttemptAt: isoOrEmpty(new Date(nowMs)),
      failedInputHash: sources.inputHash,
      failureRetryAt: new Date(nowMs + backoffDelayMs(failures)).toISOString(),
    }, { dataDir });
    log.warn?.(`[delivery-brief] rebuild failed for ${clientId}: ${errorCode(error)}`);
    return { wrote: true, status: 'failed', error: errorCode(error) };
  } finally {
    await lease.release();
  }
}

export const tickSteps = Object.freeze([
  Object.freeze({ name: 'brief-rebuild', order: 50, scope: 'client', run: runBriefRebuildStep }),
]);

export { readLatestBrief, readBriefVersion, listBriefVersions, setDirectiveStatus, reviewFact, readReviews } from './store.js';
export { renderBriefMarkdown } from './render-md.js';
