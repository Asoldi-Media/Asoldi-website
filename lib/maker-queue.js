export const CLICKABLE_QUEUE_TARGETS = [
  { target: '1', label: 'Steg 1' },
  { target: '1.5', label: 'Steg 1.5' },
  { target: 'generate-text', label: 'Steg 2.1' },
  { target: 'inject-media', label: 'Steg 2.2' },
  { target: 'layout-colors-style', label: 'Layout' },
  { target: 'maps-embed-sync', label: 'Maps' },
  { target: '3', label: 'Steg 4 SEO' },
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

const ACCEPTED_TARGETS = new Set([
  ...CLICKABLE_QUEUE_TARGETS.map((entry) => entry.target),
  ...GREY_QUEUE_TARGETS.map((entry) => entry.target),
  '2',
]);

export function isAcceptedQueueTarget(target = '') {
  return ACCEPTED_TARGETS.has(String(target || '').trim());
}

export function isClickableQueueTarget(target = '') {
  return CLICKABLE_QUEUE_TARGETS.some((entry) => entry.target === String(target || '').trim());
}

export function targetsUntil(target = '') {
  const value = String(target || '').trim();
  if (!value) return [];
  const index = QUEUE_UNTIL_CHAIN.indexOf(value);
  if (index < 0) return [value];
  return QUEUE_UNTIL_CHAIN.slice(0, index + 1);
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

export function summarizeMakerRunForQueue(run = {}) {
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
