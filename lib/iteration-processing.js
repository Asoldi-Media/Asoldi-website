/**
 * Iteration recording: archive, extract keep/change items, rebuild the brief, open change
 * requests, and queue an iteration job when a must item is still open.
 *
 * Switch `iteration.processing`, per client through spineModeForClient:
 *   off / paused  writes nothing
 *   shadow        one delivery-audit row, nothing else
 *   auto          the writes below, for a pilot client after the release pass
 *
 * Change requests use source `iteration`. They count against the monthly quota only after
 * go-live, which is the rule create/accept already applies. An approval with no open ask is
 * stored as delivery.events.approvalProposed. That is a proposal: no task and no mail.
 */
import { getAutomationSettings } from '../data/automation-settings.js';
import { applyChangeAction, createChangeRequest } from './change-requests.js';
import { appendDeliveryAudit } from './delivery-audit.js';
import { assembleBrief } from './delivery-brief/assemble.js';
import { createMemoryChunkCache, extractMeeting } from './delivery-brief/extract.js';
import { reduceItems } from './delivery-brief/reduce.js';
import { saveBrief } from './delivery-brief/store.js';
import { enqueueJob, listJobs, requestJob } from './delivery-jobs.js';
import { planStageWrite } from './delivery-state.js';
import { spineModeForClient } from './spine-mode.js';
import { onTranscriptLinked } from './transcript-archive.js';

export const ITERATION_PROCESSING_SWITCH = 'iteration.processing';

const DIRECTIVE_KINDS = new Set(['keep', 'change', 'add', 'remove']);

function text(value, max = 400) {
  return String(value ?? '').trim().slice(0, max);
}

function toMs(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  const parsed = Date.parse(now instanceof Date ? now.toISOString() : String(now || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function normalised(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** True when the quote is a whitespace-normalised substring of the transcript. */
export function quoteInTranscript(quote, transcript) {
  const wanted = normalised(quote);
  if (!wanted) return false;
  return normalised(transcript).includes(wanted);
}

function modeFor(client, settings, dataDir) {
  if (!client) return 'off';
  return spineModeForClient(ITERATION_PROCESSING_SWITCH, client, { settings, dataDir });
}

function settingsOf(deps) {
  if (deps.settings) return deps.settings;
  return getAutomationSettings({ dataDir: deps.dataDir });
}

/**
 * Link hook. Auto stores delivery.pendingIteration. Shadow appends one audit row.
 * Off and paused write nothing.
 */
export function notePendingIteration({ clientId, meetingId, sales, settings, dataDir, now } = {}) {
  const id = text(meetingId, 80);
  const client = sales?.getSalesClientById?.(clientId) || null;
  const resolved = settings || (dataDir ? getAutomationSettings({ dataDir }) : null);
  const mode = resolved ? modeFor(client, resolved, dataDir) : 'off';
  if (!client || !id || mode === 'off' || mode === 'paused') return { wrote: false, mode };
  if (mode !== 'auto') {
    appendDeliveryAudit({ kind: 'iteration', clientId: client.id, meetingId: id, reason: 'shadow', at: new Date(toMs(now)).toISOString() }, { dataDir });
    return { wrote: false, mode: 'shadow' };
  }
  sales.setSalesDelivery(client.id, { pendingIteration: id }, { by: 'iteration', reason: 'pending' });
  return { wrote: true, mode: 'auto' };
}

function iterationItem(item) {
  if (item?.type === 'iteration') {
    const keep = item.keepAsIs === true;
    return { id: item.id, kind: keep ? 'keep' : 'change', topic: text(item.area, 120) || 'site', quote: item.quote, must: !keep };
  }
  if (item?.type === 'directive' && DIRECTIVE_KINDS.has(item.kind)) {
    return {
      id: item.id,
      kind: item.kind,
      topic: text(item.area, 120) || 'site',
      quote: item.quote,
      must: item.priority === 'must',
    };
  }
  return null;
}

function briefSources(client, meetingId, transcript, transcriptChars) {
  return {
    parts: { meetings: [], plan: '', bank: '', gate: '', seo: '' },
    meetings: [{
      meetingId: text(meetingId, 80),
      purpose: 'iteration',
      startedAt: '',
      sha256: '',
      chars: transcriptChars,
      transcript: String(transcript || ''),
    }],
    media: [],
    offer: null,
    sitePlan: client?.sitePlan || null,
    offerHash: '',
    promptHash: '',
    inputHash: '',
    changeRequests: [],
    projectDocument: null,
    gate: null,
    seo: null,
    cmsSetup: null,
    availabilityOf: () => 'unknown',
    bank: null,
  };
}

async function rebuildBrief(client, reduced, extracted, { meetingId, transcript, transcriptChars, dataDir, now }) {
  const brief = assembleBrief({
    client,
    sources: briefSources(client, meetingId, transcript, transcriptChars),
    extraction: {
      items: reduced.items,
      meetings: [{
        meetingId: text(meetingId, 80),
        chunks: extracted.chunks,
        droppedUnverified: extracted.droppedUnverified,
        droppedInvalid: extracted.droppedInvalid,
        costUsd: extracted.costUsd,
        routes: extracted.routes,
      }],
      durationMs: 0,
    },
    reviews: {},
    now: new Date(toMs(now)),
  });
  if (dataDir) saveBrief(client.id, brief, { dataDir, now: new Date(toMs(now)) });
  return brief;
}

const classifyLlm = { json: async () => { throw new Error('rule-classify'); } };

async function openChangeRequests(items, client, { dataDir }) {
  const ids = [];
  for (const item of items) {
    if (!item || item.kind === 'keep') continue;
    const title = text(item.topic, 120) || 'Endring';
    const created = await createChangeRequest({
      fields: { type: 'text', title, description: text(item.topic, 500) },
      salesClientId: client.id,
      siteKey: client.id,
      source: 'iteration',
      sourceVerified: false,
      requestedBy: 'iteration',
      client,
      dataDir,
      llm: classifyLlm,
    });
    if (!created?.ok || !created.request?.id) continue;
    const accepted = await applyChangeAction(created.request.id, { action: 'accept' }, { dataDir, by: 'iteration', client });
    if (accepted?.ok) ids.push(created.request.id);
  }
  return ids;
}

function queueIterationJob(client, meetingId, itemIds, { dataDir, now, settings, sales }) {
  const request = {
    kind: 'iteration',
    salesClientId: client.id,
    runId: client.makerRun?.runId || '',
    input: { meetingId: text(meetingId, 80) },
    createdBy: 'iteration',
  };
  const via = requestJob(request, { dataDir, now, client, settings, sales });
  if (via?.job) return { queued: 1, job: via.job };
  if (via?.code === 'duplicate') return { queued: 0, job: via.job || null };
  const direct = enqueueJob(request, { dataDir, now, client, settings, sales });
  if (direct?.code === 'duplicate') return { queued: 0, job: direct.job || null };
  return { queued: direct?.ok ? 1 : 0, job: direct?.job || null };
}

/**
 * @returns {{ mode, transcriptChars, items, dropped, jobs, stage, approvalProposed, changeRequestIds, wrote }}
 */
export async function processIterationMeeting({ clientId, meetingId, transcript = '', now, deps = {} } = {}) {
  const transcriptChars = String(transcript ?? '').length;
  const dataDir = deps.dataDir;
  const sales = deps.sales;
  const settings = settingsOf({ settings: deps.settings, dataDir });
  const client = sales?.getSalesClientById?.(clientId) || null;
  const mode = modeFor(client, settings, dataDir);
  const empty = {
    mode,
    transcriptChars,
    items: [],
    dropped: [],
    jobs: 0,
    stage: client?.delivery?.stage || '',
    approvalProposed: false,
    changeRequestIds: [],
    wrote: false,
  };
  if (!client || mode === 'off' || mode === 'paused') return empty;
  if (mode !== 'auto') {
    appendDeliveryAudit({
      kind: 'iteration',
      clientId: client.id,
      meetingId: text(meetingId, 80),
      reason: 'shadow',
      at: new Date(toMs(now)).toISOString(),
    }, { dataDir });
    return { ...empty, mode: 'shadow' };
  }

  if (!String(transcript ?? '').trim()) {
    // Not stored yet: keep pendingIteration so the next tick retries.
    return { ...empty, stage: client.delivery?.stage || '' };
  }

  const archive = deps.archive || ((input) => onTranscriptLinked(input.clientId, input.meetingId, {
    ref: { purpose: 'iteration' },
    dataDir,
    now,
    settings,
  }));
  try {
    await archive({ clientId: client.id, meetingId, transcript, purpose: 'iteration' });
  } catch {
    // The archive helper already records a skipped switch. The rest of the path still runs.
  }

  const llm = deps.llm || await (async () => {
    const { getHubLlm } = await import('./llm/index.js');
    return getHubLlm();
  })();
  const extracted = await extractMeeting({
    meeting: {
      meetingId: text(meetingId, 80),
      purpose: 'iteration',
      startedAt: new Date(toMs(now)).toISOString(),
      transcript: String(transcript ?? ''),
    },
    llm,
    cache: createMemoryChunkCache(),
    clientId: client.id,
  });

  if ((extracted.complete === false || (extracted.errors || []).length > 0) && !(extracted.items || []).length) {
    // Extraction failed (provider error, gap): nothing was learned, so retry on the next tick.
    return empty;
  }

  const reduced = reduceItems(extracted.items);
  let substringDrops = 0;
  const kept = [];
  for (const item of reduced.active) {
    if (!quoteInTranscript(item.quote, transcript)) {
      substringDrops += 1;
      continue;
    }
    kept.push(item);
  }
  const dropped = [];
  const quoteDrops = (Number(extracted.droppedUnverified) || 0) + substringDrops;
  if (quoteDrops > 0) dropped.push({ reason: 'quote-not-in-transcript', count: quoteDrops });

  try {
    await rebuildBrief(client, { ...reduced, items: reduced.items, active: kept }, extracted, {
      meetingId,
      transcript,
      transcriptChars,
      dataDir,
      now,
    });
  } catch {
    // A brief that does not fit the schema must not stop the change requests or the job.
  }

  const items = kept.map(iterationItem).filter(Boolean);
  const changeRequestIds = await openChangeRequests(items, client, { dataDir });
  const mustItems = items.filter((item) => item.must && item.kind !== 'keep');
  const openQuestions = kept.filter((item) => item.type === 'openQuestion');
  const signals = kept.filter((item) => item.type === 'approvalSignal');
  const queued = mustItems.length
    ? queueIterationJob(client, meetingId, mustItems.map((item) => item.id), { dataDir, now: toMs(now), settings, sales })
    : { queued: 0, job: null };

  const latest = sales.getSalesClientById(client.id) || client;
  const planned = planStageWrite(latest, { jobs: listJobs({ dataDir, clientId: client.id, fresh: true }), now: toMs(now), by: 'iteration', reason: 'stage' });
  const openAsks = mustItems.length + openQuestions.length;
  const propose = signals.length > 0 && openAsks === 0;
  const patch = { pendingIteration: '' };
  if (planned.changed && planned.delivery) {
    patch.stage = planned.delivery.stage;
    patch.overlay = planned.delivery.overlay;
    patch.stageAt = planned.delivery.stageAt;
    patch.history = planned.delivery.history;
  }
  if (propose) {
    patch.events = {
      approvalProposed: {
        at: new Date(toMs(now)).toISOString(),
        by: 'iteration',
        source: 'iteration',
        quote: text(signals[0].quote, 400),
        previewHash: '',
      },
    };
  }
  const saved = sales.setSalesDelivery(client.id, patch, { by: 'iteration', reason: 'processed' });
  const stage = saved?.delivery?.stage || patch.stage || latest.delivery?.stage || '';
  return {
    mode: 'auto',
    transcriptChars,
    items,
    dropped,
    jobs: queued.queued,
    stage,
    approvalProposed: propose,
    changeRequestIds,
    wrote: true,
  };
}
