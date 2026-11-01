import { KNOWN_STEP2_EXTRA_SUBSTEPS, insertKnownExtras, makerRunStep2SubstepOrder, normalizeStep2SubstepOrder } from './step2-substeps.js';

export const CLICKABLE_QUEUE_TARGETS = [
  { target: '1', label: 'Steg 1' },
  { target: '1.5', label: 'Steg 1.5' },
  { target: 'generate-text', label: 'Steg 2.1' },
  { target: 'inject-media', label: 'Steg 2.2' },
  { target: 'layout-colors-style', label: 'Layout' },
  { target: 'maps-embed-sync', label: 'Maps' },
  { target: '3', label: 'Steg 5 SEO' },
];

export const GREY_QUEUE_TARGETS = [
  { target: 'cms', label: 'Steg 3 CMS' },
];

export const QUEUE_UNTIL_CHAIN = [
  '1',
  '1.5',
  'generate-text',
  'inject-media',
  'layout-colors-style',
  'maps-embed-sync',
  '3',
];

// Step 2 substeps beyond the legacy four that a Maker may report (and then run) for a run.
export const STEP2_EXTRA_QUEUE_TARGETS = Object.freeze(
  Object.entries(KNOWN_STEP2_EXTRA_SUBSTEPS).map(([target, known]) => Object.freeze({ target, label: known.label }))
);

const ACCEPTED_TARGETS = new Set([
  ...CLICKABLE_QUEUE_TARGETS.map((entry) => entry.target),
  ...GREY_QUEUE_TARGETS.map((entry) => entry.target),
  '2',
]);

function extraTargetsInOrder(step2SubstepOrder = null) {
  return (normalizeStep2SubstepOrder(step2SubstepOrder) || []).filter((id) => KNOWN_STEP2_EXTRA_SUBSTEPS[id]);
}

/**
 * The Step 2 substep order of the runs a queue request names: the ids any linked client's stored
 * makerRun order lists (null when none has one, so the request is checked as before).
 */
export function step2SubstepOrderForQueueRequest({ salesClientIds = [] } = {}, getClientById = () => null) {
  const ids = [];
  for (const rawId of Array.isArray(salesClientIds) ? salesClientIds : []) {
    const client = typeof getClientById === 'function' ? getClientById(String(rawId || '').trim()) : null;
    for (const id of makerRunStep2SubstepOrder(client?.makerRun) || []) if (!ids.includes(id)) ids.push(id);
  }
  return normalizeStep2SubstepOrder(ids);
}

/** The clickable targets for a run whose Maker sent this substep order (CLICKABLE_QUEUE_TARGETS without one). */
export function clickableQueueTargetsForOrder(step2SubstepOrder = null) {
  const extras = extraTargetsInOrder(step2SubstepOrder);
  if (!extras.length) return CLICKABLE_QUEUE_TARGETS;
  return insertKnownExtras(CLICKABLE_QUEUE_TARGETS, extras, {
    idOf: (entry) => entry.target,
    build: (target, known) => ({ target, label: known.label }),
  });
}

/** A queue target the hub passes on; an extra Step 2 substep only for runs whose Maker sent it in its order. */
export function isAcceptedQueueTarget(target = '', { step2SubstepOrder = null } = {}) {
  const value = String(target || '').trim();
  return ACCEPTED_TARGETS.has(value) || extraTargetsInOrder(step2SubstepOrder).includes(value);
}

export function isClickableQueueTarget(target = '') {
  return CLICKABLE_QUEUE_TARGETS.some((entry) => entry.target === String(target || '').trim());
}

export function targetsUntil(target = '', { step2SubstepOrder = null } = {}) {
  const value = String(target || '').trim();
  if (!value) return [];
  // A Maker that sent its substep order runs its extra substeps in the chain, right after the one they follow.
  const chain = insertKnownExtras(QUEUE_UNTIL_CHAIN, extraTargetsInOrder(step2SubstepOrder), { build: (key) => key });
  const index = chain.indexOf(value);
  if (index < 0) return [value];
  return chain.slice(0, index + 1);
}

export function resolveMakerQueueRunRequests({
  getClientById,
  salesClientIds = [],
  runIds = [],
} = {}) {
  const linked = [];
  const failures = [];
  const seen = new Set();
  const lookup = typeof getClientById === 'function' ? getClientById : () => null;

  for (const rawId of Array.isArray(salesClientIds) ? salesClientIds : []) {
    const salesClientId = String(rawId || '').trim();
    if (!salesClientId) continue;
    const client = lookup(salesClientId);
    const runId = String(client?.makerRun?.runId || '').trim();
    if (!runId) {
      failures.push({ salesClientId, error: 'No Website Maker run is linked.' });
      continue;
    }
    const key = `sales:${salesClientId}:${runId}`;
    if (seen.has(key) || seen.has(`run:${runId}`)) continue;
    seen.add(key);
    seen.add(`run:${runId}`);
    linked.push({ runId, salesClientId });
  }

  for (const rawId of Array.isArray(runIds) ? runIds : []) {
    const runId = String(rawId || '').trim();
    if (!runId) continue;
    if (seen.has(`run:${runId}`)) continue;
    seen.add(`run:${runId}`);
    linked.push({ runId, salesClientId: '' });
  }

  return { linked, failures };
}

function readyStatus(value = '') {
  return String(value || '').trim().toLowerCase() === 'ready';
}

/**
 * The queue summary of a live Maker run. `step2SubstepOrder` (the order the run's Maker sent, as stored
 * for its client) adds a ready flag for each known extra Step 2 substep in it; without one the summary
 * has exactly the fields it always had.
 */
export function summarizeMakerRunForQueue(run = {}, { step2SubstepOrder = null } = {}) {
  const steps = run?.steps && typeof run.steps === 'object' ? run.steps : {};
  const locked = run?.metadata?.finalizedLanguage?.confirmed
    ? run.metadata.finalizedLanguage
    : null;
  const domain = String(run?.metadata?.productionDomain || run?.answers?.websiteDomain || '').trim();
  const sub = steps?.['2']?.substeps && typeof steps['2'].substeps === 'object' ? steps['2'].substeps : {};
  const step2Status = String(steps?.['2']?.status || '').trim().toLowerCase();
  const step2Ready = readyStatus(step2Status) || step2Status === 'partial' || readyStatus(sub['generate-text']?.status);
  return {
    runId: String(run?.id || '').trim(),
    step1Ready: readyStatus(steps?.['1']?.status),
    step15Ready: readyStatus(steps?.['1.5']?.status),
    step2Ready,
    languageLocked: Boolean(locked),
    generateTextReady: readyStatus(sub['generate-text']?.status),
    injectMediaReady: readyStatus(sub['inject-media']?.status),
    layoutReady: readyStatus(sub['layout-colors-style']?.status),
    mapsReady: readyStatus(sub['maps-embed-sync']?.status),
    ...Object.fromEntries(
      extraTargetsInOrder(step2SubstepOrder).map((id) => [KNOWN_STEP2_EXTRA_SUBSTEPS[id].readyFlag, readyStatus(sub[id]?.status)])
    ),
    seoReady: readyStatus(steps?.['3']?.status),
    hasDomain: Boolean(domain),
    websiteDomain: domain,
    finalizedLanguage: locked,
    draftInjected: String(run?.metadata?.intakeStatus || '').trim().toLowerCase() !== 'pending',
    templateLocked: Boolean(String(run?.metadata?.templateSetId || '').trim()),
    quickFillDone: Boolean(String(run?.metadata?.quickFillCompletedAt || '').trim()),
    mediaGatherDone: Boolean(String(run?.metadata?.mediaGatherCompletedAt || '').trim()),
    customSiteExists: Boolean(run?.customSite?.exists),
    latestReadyStep: latestQueueReadyStep(steps),
  };
}

function latestQueueReadyStep(steps = {}) {
  const order = ['3', '2', '1.5', '1'];
  for (const key of order) {
    const status = String(steps?.[key]?.status || '').trim().toLowerCase();
    const textReady = key === '2'
      ? readyStatus(steps?.['2']?.substeps?.['generate-text']?.status)
      : false;
    const ready = key === '2'
      ? status === 'ready' || status === 'partial' || textReady
      : status === 'ready';
    if (ready) return key;
  }
  return '';
}
