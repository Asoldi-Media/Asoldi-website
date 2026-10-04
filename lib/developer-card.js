/**
 * T09 developer card helpers. Consumes T01 evaluateWorkshopNeeds output,
 * T03 queue targets, and T07 workshop.summary. Does not copy T01 ask rules
 * and does not enqueue grey / Lang chips.
 */

import { GREY_QUEUE_TARGETS } from './maker-queue.js';

export const WORKSHOP_NOT_HELD_MESSAGE = 'Workshopen er ikke holdt ennå';

export const DEVELOPER_QA_LABELS = {
  textOk: 'Tekst er bra',
  mediaOk: 'Mediafiler er bra',
  responsiveOk: 'Responsivitet er bra',
};

export const DEVELOPER_PROGRESS_CHIPS = [
  { id: 'draft', label: 'Draftfase', kind: 'draft', target: '' },
  { id: '1', label: 'Steg 1', kind: 'enqueue', target: '1' },
  { id: 'lang', label: 'Lang', kind: 'language', target: '' },
  { id: '1.5', label: 'Steg 1.5', kind: 'enqueue', target: '1.5' },
  { id: '2.1', label: 'Steg 2.1', kind: 'enqueue', target: 'generate-text' },
  { id: '2.2', label: 'Steg 2.2', kind: 'enqueue', target: 'inject-media' },
  { id: 'layout', label: 'Layout', kind: 'enqueue', target: 'layout-colors-style' },
  { id: 'maps', label: 'Maps', kind: 'enqueue', target: 'maps-embed-sync' },
  { id: 'cms', label: 'Steg 3 CMS', kind: 'grey', target: 'cms' },
  { id: 'seo', label: 'Steg 4 SEO', kind: 'enqueue', target: '3' },
];

const BINARY_LABELS = {
  logo: 'Logo',
  domain: 'Domene',
};

const COUNT_LABELS = {
  products: 'Produkter',
  media: 'Media',
};

function sanitize(value = '') {
  return String(value ?? '').trim();
}

function readyStatus(value = '') {
  return sanitize(value).toLowerCase() === 'ready';
}

function stepToken(value = '') {
  if (typeof value === 'string') return sanitize(value).toLowerCase();
  if (value && typeof value === 'object') return sanitize(value.status).toLowerCase();
  return '';
}

function impliedPipelineRank(latestReadyStep = '') {
  const key = sanitize(latestReadyStep);
  if (key === '3') return 4;
  if (key === '2') return 3;
  if (key === '1.5') return 2;
  if (key === '1') return 1;
  return 0;
}

export function normalizeDeveloperQa(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    textOk: Boolean(input.textOk),
    mediaOk: Boolean(input.mediaOk),
    responsiveOk: Boolean(input.responsiveOk),
  };
}

export function developerSummaryView(workshop = null) {
  const summary = workshop?.summary && typeof workshop.summary === 'object' ? workshop.summary : null;
  const intro = sanitize(summary?.intro);
  const voice = sanitize(summary?.voice);
  const whatTheyWant = sanitize(summary?.whatTheyWant);
  const functionality = sanitize(summary?.functionality);
  if (!intro && !voice && !whatTheyWant && !functionality) {
    return {
      ready: false,
      message: WORKSHOP_NOT_HELD_MESSAGE,
      intro: '',
      voice: '',
      whatTheyWant: '',
      functionality: '',
    };
  }
  return {
    ready: true,
    message: '',
    intro,
    voice,
    whatTheyWant,
    functionality,
  };
}

export function developerMaterialsView(evaluation = {}) {
  const materials = evaluation?.materials && typeof evaluation.materials === 'object' ? evaluation.materials : {};
  const counts = evaluation?.counts && typeof evaluation.counts === 'object' ? evaluation.counts : {};
  const binaries = [];
  for (const [key, present] of Object.entries(materials)) {
    if (typeof present !== 'boolean') continue;
    const label = BINARY_LABELS[key] || key;
    if (key === 'domain') {
      binaries.push({ key, label, present, mark: present ? 'green' : 'none' });
      continue;
    }
    binaries.push({ key, label, present, mark: present ? 'green' : 'red' });
  }
  const countRows = [];
  for (const key of ['products', 'media']) {
    const value = Number(counts[key]);
    countRows.push({
      key,
      label: COUNT_LABELS[key] || key,
      value: Number.isFinite(value) ? value : 0,
    });
  }
  return { binaries, counts: countRows };
}

function readyOrPartial(value = '') {
  const status = sanitize(value).toLowerCase();
  return status === 'ready' || status === 'partial';
}

export function scoreMakerRunProgress(makerRun = {}) {
  const run = makerRun && typeof makerRun === 'object' ? makerRun : {};
  const steps = run.steps && typeof run.steps === 'object' ? run.steps : {};
  const sub = run.step2Substeps && typeof run.step2Substeps === 'object' ? run.step2Substeps : {};
  let score = 0;
  if (run.customSite?.exists) score += 100000;
  if (readyStatus(steps['3'])) score += 20000;
  if (readyStatus(steps['2'])) score += 10000;
  else if (readyOrPartial(steps['2'])) score += 8000;
  if (readyStatus(sub['maps-embed-sync'])) score += 400;
  if (readyStatus(sub['layout-colors-style'])) score += 300;
  if (readyStatus(sub['inject-media'])) score += 200;
  if (readyStatus(sub['generate-text'])) score += 100;
  if (readyStatus(steps['1.5'])) score += 50;
  if (readyStatus(steps['1'])) score += 20;
  if (run.language?.confirmed) score += 5;
  return score;
}

export function pipelineStatusFromMakerRun(makerRun = {}) {
  const run = makerRun && typeof makerRun === 'object' ? makerRun : {};
  const steps = run.steps && typeof run.steps === 'object' ? run.steps : {};
  const sub = run.step2Substeps && typeof run.step2Substeps === 'object' ? run.step2Substeps : {};
  const rank = impliedPipelineRank(run.latestReadyStep);
  const step1Ready = readyStatus(stepToken(steps['1'])) || rank >= 1;
  const step15Ready = readyStatus(stepToken(steps['1.5'])) || rank >= 2;
  return {
    step1Ready,
    step15Ready,
    step2Ready: readyOrPartial(stepToken(steps['2'])) || readyStatus(stepToken(sub['generate-text'])) || rank >= 3,
    languageLocked: Boolean(run.language?.confirmed),
    generateTextReady: readyStatus(stepToken(sub['generate-text'])),
    injectMediaReady: readyStatus(stepToken(sub['inject-media'])),
    layoutReady: readyStatus(stepToken(sub['layout-colors-style'])),
    mapsReady: readyStatus(stepToken(sub['maps-embed-sync'])),
    cmsReady: readyStatus(stepToken(run.cms)),
    seoReady: readyStatus(stepToken(steps['3'])) || rank >= 4,
    hasDomain: Boolean(sanitize(run.productionDomain || run.websiteDomain)),
    customSiteExists: Boolean(run.customSite?.exists),
    draftInjected: sanitize(run.intakeStatus).toLowerCase() !== 'pending',
    templateLocked: Boolean(sanitize(run.templateSetId)),
    quickFillDone: Boolean(sanitize(run.quickFillCompletedAt)),
    mediaGatherDone: Boolean(sanitize(run.mediaGatherCompletedAt)),
    languageCode: sanitize(run.language?.code),
  };
}

export function draftPhaseView({ makerRun = {}, liveRun = null } = {}) {
  const stored = makerRun && typeof makerRun === 'object' ? makerRun : {};
  const meta = liveRun?.metadata && typeof liveRun.metadata === 'object' ? liveRun.metadata : {};
  const liveIntake = sanitize(meta.intakeStatus).toLowerCase();
  const storedIntake = sanitize(stored.intakeStatus).toLowerCase();
  const intake = liveRun ? liveIntake : storedIntake;
  const steps = liveRun?.steps && typeof liveRun.steps === 'object' ? liveRun.steps : {};
  const progressed = ['1', '1.5', '2', '3'].some((key) => {
    const token = stepToken(steps[key]);
    return key === '2' ? token === 'ready' || token === 'partial' : token === 'ready';
  }) || Boolean(sanitize(stored.latestReadyStep));
  const hasRun = Boolean(sanitize(stored.runId || liveRun?.id));
  return {
    templateLocked: Boolean(sanitize(meta.templateSetId || stored.templateSetId)),
    quickFillDone: Boolean(sanitize(meta.quickFillCompletedAt || stored.quickFillCompletedAt)),
    mediaGatherDone: Boolean(sanitize(meta.mediaGatherCompletedAt || stored.mediaGatherCompletedAt)),
    clientDataReady: Boolean(sanitize(meta.quickFillCompletedAt || stored.quickFillCompletedAt))
      && Boolean(sanitize(meta.mediaGatherCompletedAt || stored.mediaGatherCompletedAt)),
    injected: intake === 'configured' || progressed || (hasRun && intake !== 'pending'),
    intake,
  };
}

export function chipLiveProgress(chip = {}, run = null) {
  const target = sanitize(chip?.target);
  const steps = run?.steps && typeof run.steps === 'object' ? run.steps : {};
  const sub2 = steps['2']?.substeps && typeof steps['2'].substeps === 'object' ? steps['2'].substeps : {};
  const sub3 = steps['3']?.substeps && typeof steps['3'].substeps === 'object' ? steps['3'].substeps : {};
  const node = target === '1'
    ? steps['1']
    : target === '1.5'
      ? steps['1.5']
      : target === '3'
        ? (sub3['seo-harden'] || sub3['seo-meta'] || steps['3'])
        : sub2[target];
  if (!node || typeof node !== 'object') return { running: false, pct: null };
  const progress = node.progress && typeof node.progress === 'object' ? node.progress : null;
  const processed = Number(progress?.processed);
  const total = Number(progress?.total);
  const pct = Number.isFinite(processed) && Number.isFinite(total) && total > 0
    ? Math.max(4, Math.min(100, Math.round((processed / total) * 100)))
    : null;
  return {
    running: stepToken(node) === 'running',
    pct,
  };
}

const PIPELINE_STATUS_FLAGS = [
  'step1Ready',
  'step15Ready',
  'step2Ready',
  'languageLocked',
  'generateTextReady',
  'injectMediaReady',
  'layoutReady',
  'mapsReady',
  'cmsReady',
  'seoReady',
  'hasDomain',
  'customSiteExists',
  'draftInjected',
  'templateLocked',
  'quickFillDone',
  'mediaGatherDone',
];

export function mergeDeveloperPipelineStatus(persisted = {}, live = null) {
  const stored = persisted && typeof persisted === 'object' ? persisted : {};
  const incoming = live && typeof live === 'object' ? live : null;
  const out = {};
  for (const key of PIPELINE_STATUS_FLAGS) {
    out[key] = Boolean(stored[key]) || Boolean(incoming?.[key]);
  }
  return out;
}

function mergeStepToken(previous = '', incoming = '') {
  const prev = stepToken(previous);
  const next = stepToken(incoming);
  if ((prev === 'ready' || prev === 'partial') && (!next || next === 'idle')) return prev;
  return next || prev || 'idle';
}

export function mergeMakerRunPatch(previous = {}, patch = {}) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const next = patch && typeof patch === 'object' ? patch : {};
  const prevSteps = prev.steps && typeof prev.steps === 'object' ? prev.steps : {};
  const nextSteps = next.steps && typeof next.steps === 'object' ? next.steps : null;
  const prevSub = prev.step2Substeps && typeof prev.step2Substeps === 'object' ? prev.step2Substeps : {};
  const nextSub = next.step2Substeps && typeof next.step2Substeps === 'object' ? next.step2Substeps : null;
  const stepKeys = ['1', '1.5', '2', '3'];
  const subKeys = ['generate-text', 'inject-media', 'layout-colors-style', 'maps-embed-sync'];
  const steps = {};
  for (const key of stepKeys) {
    steps[key] = mergeStepToken(prevSteps[key], nextSteps ? nextSteps[key] : prevSteps[key]);
  }
  const step2Substeps = {};
  for (const key of subKeys) {
    step2Substeps[key] = mergeStepToken(prevSub[key], nextSub ? nextSub[key] : prevSub[key]);
  }
  const prevCustom = prev.customSite && typeof prev.customSite === 'object' ? prev.customSite : {};
  const nextCustom = next.customSite && typeof next.customSite === 'object' ? next.customSite : null;
  return {
    ...prev,
    ...next,
    steps,
    step2Substeps,
    language: next.language && typeof next.language === 'object'
      ? {
          confirmed: Boolean(next.language.confirmed),
          code: sanitize(next.language.code) || sanitize(prev.language?.code),
        }
      : prev.language,
    customSite: {
      exists: Boolean(nextCustom?.exists) || Boolean(prevCustom.exists && !nextCustom),
      previewPath: sanitize(nextCustom?.previewPath) || sanitize(prevCustom.previewPath),
    },
    latestReadyStep: sanitize(next.latestReadyStep) || sanitize(prev.latestReadyStep),
    clientBundleId: sanitize(next.clientBundleId) || sanitize(prev.clientBundleId),
    cms: sanitize(next.cms) || sanitize(prev.cms),
    templateSetId: sanitize(next.templateSetId) || sanitize(prev.templateSetId),
    intakeStatus: sanitize(next.intakeStatus) || sanitize(prev.intakeStatus),
    quickFillCompletedAt: sanitize(next.quickFillCompletedAt) || sanitize(prev.quickFillCompletedAt),
    mediaGatherCompletedAt: sanitize(next.mediaGatherCompletedAt) || sanitize(prev.mediaGatherCompletedAt),
  };
}

export function chipStepReady(chip, status = {}) {
  const id = String(chip?.id || '');
  if (id === '1') return Boolean(status.step1Ready);
  if (id === '1.5') return Boolean(status.step15Ready);
  if (id === '2.1') return Boolean(status.generateTextReady);
  if (id === '2.2') return Boolean(status.injectMediaReady);
  if (id === 'layout') return Boolean(status.layoutReady);
  if (id === 'maps') return Boolean(status.mapsReady);
  if (id === 'seo') return Boolean(status.seoReady);
  if (id === 'lang') return Boolean(status.languageLocked);
  if (id === 'draft') return Boolean(status.draftInjected);
  return false;
}

export function developerChipVisual(chip, status = {}, resolved = {}) {
  if (chip?.kind === 'grey') return 'grey';
  if (chip?.kind === 'draft') return status.draftInjected ? 'ready' : 'idle';
  if (chipStepReady(chip, status)) return 'ready';
  if (resolved?.type === 'disabled' || resolved?.type === 'noop') return 'grey';
  return 'idle';
}

export function makerPreviewStepForTarget(target = '') {
  const value = String(target || '').trim();
  if (value === 'custom') return 'custom';
  if (value === '1' || value === '1.5' || value === '3') return value;
  return '2';
}

export function resolveLatestMakerPreviewStep(status = {}) {
  if (status.customSiteExists) return 'custom';
  if (status.seoReady) return '3';
  if (status.step2Ready || status.generateTextReady || status.injectMediaReady || status.layoutReady || status.mapsReady) {
    return '2';
  }
  if (status.step15Ready) return '1.5';
  if (status.step1Ready) return '1';
  return '';
}

export function makerLatestPreviewPath(runId = '', step = '') {
  const id = sanitize(runId);
  const target = sanitize(step);
  if (!id || !target) return '';
  if (target === 'custom') return `/preview/${encodeURIComponent(id)}/custom/view?route=/`;
  return `/preview/${encodeURIComponent(id)}/step/${encodeURIComponent(target)}/view?route=/`;
}

export function makerStepPreviewPath(runId = '', target = '') {
  const id = sanitize(runId);
  if (!id) return '';
  return `/preview/${encodeURIComponent(id)}/step/${encodeURIComponent(makerPreviewStepForTarget(target))}`;
}

export function resolveDeveloperProgressClick(chip, status = {}) {
  const row = chip && typeof chip === 'object' ? chip : {};
  if (row.kind === 'draft') {
    return { type: 'draft', enqueue: false, target: '' };
  }
  if (row.kind === 'grey' || GREY_QUEUE_TARGETS.some((entry) => entry.target === row.target && row.kind !== 'enqueue')) {
    return { type: 'noop', enqueue: false, target: row.target || '' };
  }
  if (row.kind === 'language') {
    if (status.draftInjected === false) {
      return {
        type: 'disabled',
        enqueue: false,
        reason: 'Fullfør draftfasen først. Velg mal og kundedata, og injiser i klientkjøringen.',
      };
    }
    if (!status.step1Ready) {
      return {
        type: 'disabled',
        enqueue: false,
        reason: 'Run Step 1 first, then detect & lock the website language',
      };
    }
    return { type: 'language', enqueue: false, target: '' };
  }
  if (row.kind !== 'enqueue') {
    return { type: 'noop', enqueue: false, target: '' };
  }
  if (chipStepReady(row, status)) {
    return {
      type: 'ready',
      enqueue: false,
      target: row.target,
      previewStep: makerPreviewStepForTarget(row.target),
    };
  }
  if (status.draftInjected === false) {
    return {
      type: 'disabled',
      enqueue: false,
      reason: 'Fullfør draftfasen først. Velg mal og kundedata, og injiser i klientkjøringen.',
      target: row.target,
    };
  }
  if (row.target === '3' && !status.hasDomain) {
    return {
      type: 'disabled',
      enqueue: false,
      reason: 'Set a website domain before Step 4 SEO',
      target: row.target,
    };
  }
  if (row.target === '1.5' && !status.step1Ready) {
    return { type: 'disabled', enqueue: false, reason: 'Requires Step 1 success first', target: row.target };
  }
  if (row.target === '1.5' && !status.languageLocked) {
    return { type: 'disabled', enqueue: false, reason: 'Detect & lock the website language first', target: row.target };
  }
  return { type: 'enqueue-until', enqueue: true, target: row.target, untilTarget: row.target };
}

export function makerCustomEditPath(runId = '') {
  const id = sanitize(runId);
  return id ? `/run/${encodeURIComponent(id)}?panel=custom` : '';
}

export function makerCustomEditUrl(baseUrl = '', runId = '') {
  const base = sanitize(baseUrl).replace(/\/+$/, '');
  const path = makerCustomEditPath(runId);
  return base && path ? `${base}${path}` : '';
}

export function makerCustomPreviewPath(runId = '', customSite = null) {
  const id = sanitize(runId);
  const stored = sanitize(customSite?.previewPath);
  if (customSite && customSite.exists === false) return '';
  if (stored) return stored.startsWith('/') ? stored : `/${stored}`;
  if (customSite?.exists && id) return `/preview/${encodeURIComponent(id)}/custom`;
  return '';
}

function nestedStepStatus(step) {
  if (typeof step === 'string') return sanitize(step) || 'idle';
  if (step && typeof step === 'object') return sanitize(step.status) || 'idle';
  return 'idle';
}

function latestPipelineReadyStep(steps = {}) {
  const order = ['3', '2', '1.5', '1'];
  for (const key of order) {
    const status = nestedStepStatus(steps[key]).toLowerCase();
    const ready = key === '2' ? status === 'ready' || status === 'partial' : status === 'ready';
    if (ready) return key;
  }
  return '';
}

export function makerHandoffFromLiveRun(run = {}) {
  const input = run && typeof run === 'object' ? run : {};
  const steps = input.steps && typeof input.steps === 'object' ? input.steps : {};
  const sub = steps['2']?.substeps && typeof steps['2'].substeps === 'object' ? steps['2'].substeps : {};
  const locked = input.metadata?.finalizedLanguage?.confirmed
    ? input.metadata.finalizedLanguage
    : null;
  const custom = input.customSite && typeof input.customSite === 'object' ? input.customSite : null;
  const latestReadyStep = latestPipelineReadyStep(steps);
  return {
    steps: {
      '1': nestedStepStatus(steps['1']),
      '1.5': nestedStepStatus(steps['1.5']),
      '2': nestedStepStatus(steps['2']),
      '3': nestedStepStatus(steps['3']),
    },
    step2Substeps: {
      'generate-text': nestedStepStatus(sub['generate-text']),
      'inject-media': nestedStepStatus(sub['inject-media']),
      'layout-colors-style': nestedStepStatus(sub['layout-colors-style']),
      'maps-embed-sync': nestedStepStatus(sub['maps-embed-sync']),
    },
    language: {
      confirmed: Boolean(locked),
      code: sanitize(locked?.code),
    },
    cms: nestedStepStatus(input.cms || steps.cms),
    customSite: custom
      ? {
          exists: Boolean(custom.exists),
          previewPath: sanitize(custom.previewPath),
        }
      : undefined,
    latestReadyStep,
    latestStepStatus: latestReadyStep ? nestedStepStatus(steps[latestReadyStep]) : '',
    productionDomain: sanitize(input.metadata?.productionDomain),
    websiteDomain: sanitize(input.answers?.websiteDomain || input.metadata?.productionDomain),
    clientBundleId: sanitize(input.metadata?.clientBundleId),
    templateSetId: sanitize(input.metadata?.templateSetId),
    intakeStatus: sanitize(input.metadata?.intakeStatus),
    quickFillCompletedAt: sanitize(input.metadata?.quickFillCompletedAt),
    mediaGatherCompletedAt: sanitize(input.metadata?.mediaGatherCompletedAt),
  };
}

export function makerHandoffSignature(runId = '', handoff = {}) {
  const input = handoff && typeof handoff === 'object' ? handoff : {};
  const steps = input.steps && typeof input.steps === 'object' ? input.steps : {};
  const sub = input.step2Substeps && typeof input.step2Substeps === 'object' ? input.step2Substeps : {};
  return JSON.stringify({
    runId: sanitize(runId),
    steps: {
      '1': nestedStepStatus(steps['1']),
      '1.5': nestedStepStatus(steps['1.5']),
      '2': nestedStepStatus(steps['2']),
      '3': nestedStepStatus(steps['3']),
    },
    sub: {
      'generate-text': nestedStepStatus(sub['generate-text']),
      'inject-media': nestedStepStatus(sub['inject-media']),
      'layout-colors-style': nestedStepStatus(sub['layout-colors-style']),
      'maps-embed-sync': nestedStepStatus(sub['maps-embed-sync']),
    },
    language: {
      confirmed: Boolean(input.language?.confirmed),
      code: sanitize(input.language?.code),
    },
    cms: nestedStepStatus(input.cms),
    domain: sanitize(input.productionDomain || input.websiteDomain),
    latestReadyStep: sanitize(input.latestReadyStep),
    custom: Boolean(input.customSite?.exists),
    templateSetId: sanitize(input.templateSetId),
    intakeStatus: sanitize(input.intakeStatus),
    quickFillCompletedAt: sanitize(input.quickFillCompletedAt),
    mediaGatherCompletedAt: sanitize(input.mediaGatherCompletedAt),
  });
}

export function makerHandoffNeedsPersist(storedMakerRun = {}, runId = '', liveHandoff = {}) {
  const stored = storedMakerRun && typeof storedMakerRun === 'object' ? storedMakerRun : {};
  return makerHandoffSignature(runId, liveHandoff) !== makerHandoffSignature(stored.runId, stored);
}

export function makerProgressPatchFromHandoff(handoff = {}) {
  const input = handoff && typeof handoff === 'object' ? handoff : {};
  const patch = {};
  if (input.steps && typeof input.steps === 'object') patch.steps = input.steps;
  if (input.step2Substeps && typeof input.step2Substeps === 'object') patch.step2Substeps = input.step2Substeps;
  if (input.language && typeof input.language === 'object') {
    patch.language = {
      confirmed: Boolean(input.language.confirmed),
      code: sanitize(input.language.code),
    };
  }
  if (input.cms != null && input.cms !== '') patch.cms = sanitize(input.cms);
  if (input.customSite && typeof input.customSite === 'object') {
    patch.customSite = {
      exists: Boolean(input.customSite.exists),
      previewPath: sanitize(input.customSite.previewPath),
    };
  }
  if (input.productionDomain != null) patch.productionDomain = sanitize(input.productionDomain);
  if (input.websiteDomain != null) patch.websiteDomain = sanitize(input.websiteDomain);
  if (input.latestReadyStep != null) patch.latestReadyStep = sanitize(input.latestReadyStep);
  if (input.latestStepStatus != null) patch.latestStepStatus = sanitize(input.latestStepStatus);
  if (input.clientBundleId != null) patch.clientBundleId = sanitize(input.clientBundleId);
  if (input.templateSetId != null) patch.templateSetId = sanitize(input.templateSetId);
  if (input.intakeStatus != null) patch.intakeStatus = sanitize(input.intakeStatus);
  if (input.quickFillCompletedAt != null) patch.quickFillCompletedAt = sanitize(input.quickFillCompletedAt);
  if (input.mediaGatherCompletedAt != null) patch.mediaGatherCompletedAt = sanitize(input.mediaGatherCompletedAt);
  return patch;
}

export function developerMediaLibraryView(payload = {}) {
  return {
    fromClient: Array.isArray(payload.fromClient) ? payload.fromClient : [],
    fromMaker: Array.isArray(payload.fromMaker) ? payload.fromMaker : [],
    makerError: sanitize(payload.makerError || payload.message),
  };
}

export function flattenMakerUploadsForLibrary(uploads = {}, source = 'run', extra = {}) {
  const out = [];
  if (!uploads || typeof uploads !== 'object') return out;
  for (const [field, list] of Object.entries(uploads)) {
    const rows = Array.isArray(list) ? list : list ? [list] : [];
    rows.forEach((entry, index) => {
      const raw = typeof entry === 'string' ? entry : (entry?.path || entry?.url || entry?.fileName || '');
      const fileName = sanitize(raw).split(/[/\\]/).pop();
      if (!fileName) return;
      out.push({
        source,
        field,
        index,
        fileName,
        ...extra,
      });
    });
  }
  return out;
}

function previewTimelineView(item = {}, nowMs = Date.now()) {
  if (item?.developerGoals?.readyForPreview) {
    return { label: '', overdue: false, tone: 'none' };
  }
  const when = String(item?.meetingAt || '').trim();
  const ms = Date.parse(when);
  const hasTime = Number.isFinite(ms);
  const overdue = hasTime && ms < nowMs;
  const formatted = hasTime
    ? new Date(ms).toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' })
    : '';
  if (formatted) return { label: formatted, overdue, tone: overdue ? 'overdue' : 'live' };
  return { label: 'Ingen møtetid satt', overdue: false, tone: 'none' };
}

function websiteDueTimelineView(item = {}, nowMs = Date.now()) {
  const label = String(item?.websiteDue?.label || '').trim();
  const dueAt = String(item?.websiteDue?.dueAt || '').trim();
  const dueMs = Date.parse(dueAt);
  const overdue = Boolean(
    item?.websiteDue?.started
    && Number.isFinite(dueMs)
    && dueMs < nowMs
  );
  const tone = overdue ? 'overdue' : (item?.websiteDue?.started && dueAt ? 'live' : 'none');
  return { label: label || 'Ingen frist ennå', overdue, tone };
}

export function developerCardTimeline(item = {}, kind = 'preview', nowMs = Date.now()) {
  if (kind === 'deployment') return websiteDueTimelineView(item, nowMs);
  const preview = previewTimelineView(item, nowMs);
  if (kind === 'preview') return preview;
  if (preview.tone !== 'none') return preview;
  return websiteDueTimelineView(item, nowMs);
}

export function iterationMeetingExists(workshop = null, meetingId = '') {
  const meeting = workshop?.iterationMeeting && typeof workshop.iterationMeeting === 'object'
    ? workshop.iterationMeeting
    : {};
  return Boolean(
    sanitize(meetingId)
    || sanitize(meeting.sentAt)
    || sanitize(meeting.firefliesMeetingId)
    || sanitize(meeting.dueAt)
  );
}
