export const CLICKABLE_QUEUE_TARGETS = [
  { target: '1', label: 'Steg 1' },
  { target: '1.5', label: 'Steg 1.5' },
  { target: 'generate-text', label: 'Steg 2.1' },
  { target: 'inject-media', label: 'Steg 2.2' },
];

export const GREY_QUEUE_TARGETS = [
  { target: 'layout-colors-style', label: 'Layout' },
  { target: 'maps-embed-sync', label: 'Maps' },
  { target: '2', label: 'Steg 2' },
  { target: 'cms', label: 'Steg 3 CMS' },
  { target: '3', label: 'Steg 4 SEO' },
];

const ACCEPTED_TARGETS = new Set([
  ...CLICKABLE_QUEUE_TARGETS.map((entry) => entry.target),
  ...GREY_QUEUE_TARGETS.map((entry) => entry.target),
]);

export function isAcceptedQueueTarget(target = '') {
  return ACCEPTED_TARGETS.has(String(target || '').trim());
}

export function isClickableQueueTarget(target = '') {
  return CLICKABLE_QUEUE_TARGETS.some((entry) => entry.target === String(target || '').trim());
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

export function summarizeMakerRunForQueue(run = {}) {
  const steps = run?.steps && typeof run.steps === 'object' ? run.steps : {};
  const locked = run?.metadata?.finalizedLanguage?.confirmed
    ? run.metadata.finalizedLanguage
    : null;
  return {
    runId: String(run?.id || '').trim(),
    step1Ready: String(steps?.['1']?.status || '').toLowerCase() === 'ready',
    languageLocked: Boolean(locked),
    generateTextReady: String(steps?.['2']?.substeps?.['generate-text']?.status || '').toLowerCase() === 'ready',
    finalizedLanguage: locked,
  };
}
