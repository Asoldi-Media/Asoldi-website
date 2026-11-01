/**
 * The delivery brief: rebuild, re-assembly after a review, and the delivery-loop step.
 *
 * Switch `brief` ({ enabled, mode }) in automation settings, resolved per client with
 * spineModeForClient('brief', client):
 *   off     nothing is built, the routes answer 404 {code:'brief-disabled'};
 *   shadow  briefs are built and stored, and admins can read them; the Maker gets 404;
 *   auto    the Maker can fetch them too (pilot clients only; everyone else stays in shadow).
 *
 * Loop step `brief-rebuild` (scope client): rebuilds when the client's input hash changed and has
 * stayed the same for REBUILD_DEBOUNCE_MS, holding the lease brief:<clientId>; at most
 * MAX_STARTS_PER_TICK rebuilds start per tick and they share TICK_WALL_MS of wall time. A rebuild
 * that runs out of time keeps its cached chunks and the next tick resumes it without waiting.
 * Nothing runs while the loop's own mode (ctx.mode) is off.
 */
import { acquireLease } from '../../data/email-store.js';
import { spineModeForClient } from '../spine-mode.js';
import { activeSitePlan } from '../site-plan-model.js';
import { assembleBrief } from './assemble.js';
import { createChunkCache, extractMeeting } from './extract.js';
import { llmMergeItems, reduceItems } from './reduce.js';
import { gatherBriefSources } from './sources.js';
import {
  assertClientId,
  chunkCacheDir,
  readBriefState,
  readExtraction,
  readReviews,
  registerBriefStore,
  saveBrief,
  updateBriefState,
  writeExtraction,
} from './store.js';
import { isoOrEmpty, text } from './text.js';

export const BRIEF_SWITCH = 'brief';
export const REBUILD_DEBOUNCE_MS = 10 * 60 * 1000;
export const MAX_STARTS_PER_TICK = 2;
export const TICK_WALL_MS = 5 * 60 * 1000;
export const LEASE_TTL_MS = TICK_WALL_MS + 60 * 1000;

/** off | shadow | paused | auto for one client. */
export function briefModeForClient(client, options = {}) {
  return spineModeForClient(BRIEF_SWITCH, client, options);
}

/** A client gets a brief once it has a plan in force or a linked meeting with talk. */
export function clientNeedsBrief(client) {
  if (activeSitePlan(client)) return true;
  return (Array.isArray(client?.meetings) ? client.meetings : []).some((row) => {
    const id = text(row?.meetingId).toLowerCase();
    return id && !id.startsWith('live:') && (row.hasTranscript === true || Number(row.sentenceCount) > 0);
  });
}

async function defaultLlm() {
  const mod = await import('../llm/index.js');
  return mod.getHubLlm();
}

function errorCode(error) {
  return text(error?.code || error?.name || 'error', 60);
}

/**
 * Extracts every meeting (cached chunks are reused), reduces, assembles and saves a new version
 * when the brief changed. Returns { status: 'built'|'unchanged'|'partial', version, hash, inputHash,
 * stats, meetings }. 'partial' means some chunks failed or ran out of time; nothing was saved.
 */
export async function rebuildBrief(client, {
  llm = null,
  dataDir,
  deps = {},
  sources = null,
  deadline = Infinity,
  now = () => Date.now(),
  log = console,
  mergeThreshold,
} = {}) {
  const started = now();
  const clientId = assertClientId(client?.id);
  await registerBriefStore({ dataDir });
  const input = sources || (await gatherBriefSources(client, { deps, log }));
  const cache = deps.chunkCache || createChunkCache(chunkCacheDir(clientId, { dataDir }));
  const model = llm || (await defaultLlm());
  const meetings = [];
  for (const meeting of input.meetings) {
    meetings.push(await extractMeeting({ meeting, llm: model, cache, clientId, featureKeys: input.featureKeys, deadline, now }));
  }
  const meetingStats = meetings.map((meeting) => ({
    meetingId: meeting.meetingId,
    purpose: meeting.purpose,
    chunks: meeting.chunks,
    droppedUnverified: meeting.droppedUnverified,
    droppedInvalid: meeting.droppedInvalid,
    costUsd: meeting.costUsd,
    routes: meeting.routes,
    errors: [...new Set(meeting.errors)].slice(0, 10),
  }));
  if (meetings.some((meeting) => !meeting.complete)) {
    updateBriefState(clientId, {
      partial: true,
      partialInputHash: input.inputHash,
      lastAttemptAt: new Date(now()).toISOString(),
      lastErrors: [...new Set(meetings.flatMap((meeting) => meeting.errors))].slice(0, 10),
    }, { dataDir });
    return { status: 'partial', version: 0, hash: '', inputHash: input.inputHash, meetings: meetingStats };
  }
  let reduced = reduceItems(meetings.flatMap((meeting) => meeting.items));
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
  writeExtraction(clientId, extraction, { dataDir });
  const brief = assembleBrief({ client, sources: input, extraction, reviews: readReviews(clientId, { dataDir }), now: new Date(now()) });
  const saved = saveBrief(clientId, brief, { dataDir, now: new Date(now()) });
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
    lastErrors: [],
  }, { dataDir });
  return { status: saved.changed ? 'built' : 'unchanged', version: saved.version, hash: saved.hash, inputHash: input.inputHash, stats: brief.stats, meetings: meetingStats };
}

/**
 * Re-assembles from the stored extraction (no LLM call), e.g. after a review. Returns the same shape
 * as rebuildBrief, or { status: 'no-extraction' } when the client was never extracted but has meetings.
 */
export async function reassembleBrief(client, { dataDir, deps = {}, now = () => Date.now(), log = console } = {}) {
  const clientId = assertClientId(client?.id);
  const sources = await gatherBriefSources(client, { deps, log });
  const stored = readExtraction(clientId, { dataDir });
  if (!stored && sources.meetings.length) return { status: 'no-extraction', version: 0, hash: '', inputHash: sources.inputHash };
  const extraction = stored || { items: [], meetings: [], extractedItems: 0, mergeUsd: 0, durationMs: 0 };
  const brief = assembleBrief({ client, sources, extraction, reviews: readReviews(clientId, { dataDir }), now: new Date(now()) });
  const saved = saveBrief(clientId, brief, { dataDir, now: new Date(now()) });
  return { status: saved.changed ? 'built' : 'unchanged', version: saved.version, hash: saved.hash, inputHash: sources.inputHash, stats: brief.stats };
}

// ---------------------------------------------------------------- loop step

let tick = { key: undefined, starts: 0, deadline: 0 };

function tickBudget(ctx) {
  const key = ctx.tickId ?? ctx.now ?? ctx;
  if (tick.key !== key) tick = { key, starts: 0, deadline: Date.now() + TICK_WALL_MS };
  return tick;
}

export function resetBriefTickForTests() {
  tick = { key: undefined, starts: 0, deadline: 0 };
}

function nowMsOf(ctx) {
  if (typeof ctx.now === 'number') return ctx.now;
  if (ctx.now instanceof Date) return ctx.now.getTime();
  const parsed = Date.parse(String(ctx.now ?? ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * The `brief-rebuild` step. ctx: { now, settings, mode, log, dataDir?, llm?, briefDeps?, tickId? }.
 * Returns { wrote, status }.
 */
export async function runBriefRebuildStep(ctx = {}, client = null) {
  if (!client || !['shadow', 'auto'].includes(ctx.mode)) return { wrote: false, status: 'loop-off' };
  const mode = briefModeForClient(client, ctx.settings ? { settings: ctx.settings } : {});
  if (mode !== 'shadow' && mode !== 'auto') return { wrote: false, status: `brief-${mode}` };
  if (!clientNeedsBrief(client)) return { wrote: false, status: 'no-input' };
  const clientId = assertClientId(client.id);
  const dataDir = ctx.dataDir;
  const nowMs = nowMsOf(ctx);
  const sources = await gatherBriefSources(client, { deps: ctx.briefDeps || {}, log: ctx.log || console });
  const state = readBriefState(clientId, { dataDir });
  const resume = state.partial === true && state.partialInputHash === sources.inputHash;
  if (!resume && state.builtInputHash === sources.inputHash) return { wrote: false, status: 'unchanged' };
  if (!resume) {
    const since = state.pendingHash === sources.inputHash ? Date.parse(state.pendingSince || '') : NaN;
    if (!Number.isFinite(since)) {
      updateBriefState(clientId, { pendingHash: sources.inputHash, pendingSince: new Date(nowMs).toISOString() }, { dataDir });
      return { wrote: true, status: 'debounce' };
    }
    if (nowMs - since < REBUILD_DEBOUNCE_MS) return { wrote: false, status: 'debounce' };
  }
  const budget = tickBudget(ctx);
  if (budget.starts >= MAX_STARTS_PER_TICK || Date.now() >= budget.deadline) return { wrote: false, status: 'deferred' };
  const lease = await acquireLease(`brief:${clientId}`, LEASE_TTL_MS);
  if (!lease) return { wrote: false, status: 'leased' };
  budget.starts += 1;
  try {
    const result = await rebuildBrief(client, {
      llm: ctx.llm || null,
      dataDir,
      deps: ctx.briefDeps || {},
      sources,
      // The wall-time budget is real time; ctx.now (which may be a test clock) only drives the debounce.
      deadline: budget.deadline,
      log: ctx.log || console,
    });
    return { wrote: true, status: result.status, version: result.version };
  } catch (error) {
    updateBriefState(clientId, {
      failures: (Number(state.failures) || 0) + 1,
      lastErrors: [errorCode(error)],
      lastAttemptAt: isoOrEmpty(new Date(nowMs)),
    }, { dataDir });
    (ctx.log || console).warn?.(`[delivery-brief] rebuild failed for ${clientId}: ${errorCode(error)}`);
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
