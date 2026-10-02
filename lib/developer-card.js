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

export function pipelineStatusFromMakerRun(makerRun = {}) {
  const run = makerRun && typeof makerRun === 'object' ? makerRun : {};
  const steps = run.steps && typeof run.steps === 'object' ? run.steps : {};
  const sub = run.step2Substeps && typeof run.step2Substeps === 'object' ? run.step2Substeps : {};
  return {
    step1Ready: readyStatus(steps['1']),
    step15Ready: readyStatus(steps['1.5']),
    languageLocked: Boolean(run.language?.confirmed),
    generateTextReady: readyStatus(sub['generate-text']),
    injectMediaReady: readyStatus(sub['inject-media']),
    layoutReady: readyStatus(sub['layout-colors-style']),
    mapsReady: readyStatus(sub['maps-embed-sync']),
    cmsReady: readyStatus(run.cms),
    seoReady: readyStatus(steps['3']),
    hasDomain: Boolean(sanitize(run.productionDomain || run.websiteDomain)),
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
  return false;
}

export function makerPreviewStepForTarget(target = '') {
  const value = String(target || '').trim();
  if (value === '1' || value === '1.5' || value === '3') return value;
  return '2';
}

export function makerStepPreviewPath(runId = '', target = '') {
  const id = sanitize(runId);
  if (!id) return '';
  return `/preview/${encodeURIComponent(id)}/step/${encodeURIComponent(makerPreviewStepForTarget(target))}`;
}

export function resolveDeveloperProgressClick(chip, status = {}) {
  const row = chip && typeof chip === 'object' ? chip : {};
  if (row.kind === 'grey' || GREY_QUEUE_TARGETS.some((entry) => entry.target === row.target && row.kind !== 'enqueue')) {
    return { type: 'noop', enqueue: false, target: row.target || '' };
  }
  if (row.kind === 'language') {
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
  if (row.target === '3' && !status.hasDomain && !chipStepReady(row, status)) {
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
  if (chipStepReady(row, status)) {
    return {
      type: 'ready',
      enqueue: false,
      target: row.target,
      previewStep: makerPreviewStepForTarget(row.target),
    };
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

export function makerHandoffFromLiveRun(run = {}) {
  const input = run && typeof run === 'object' ? run : {};
  const steps = input.steps && typeof input.steps === 'object' ? input.steps : {};
  const sub = steps['2']?.substeps && typeof steps['2'].substeps === 'object' ? steps['2'].substeps : {};
  const locked = input.metadata?.finalizedLanguage?.confirmed
    ? input.metadata.finalizedLanguage
    : null;
  const custom = input.customSite && typeof input.customSite === 'object' ? input.customSite : null;
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
    productionDomain: sanitize(input.metadata?.productionDomain),
    websiteDomain: sanitize(input.answers?.websiteDomain || input.metadata?.productionDomain),
  };
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
  const when = String(item?.nextActionAt || item?.meetingAt || '').trim();
  const name = String(item?.nextActionName || '').trim();
  const ms = Date.parse(when);
  const hasTime = Number.isFinite(ms);
  const overdue = hasTime && ms < nowMs;
  const formatted = hasTime
    ? new Date(ms).toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' })
    : '';
  if (formatted && name) return { label: `${name} · ${formatted}`, overdue, tone: overdue ? 'overdue' : 'live' };
  if (formatted) return { label: `Neste møte · ${formatted}`, overdue, tone: overdue ? 'overdue' : 'live' };
  if (name) return { label: name, overdue: false, tone: 'none' };
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
