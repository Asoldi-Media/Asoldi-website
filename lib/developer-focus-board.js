import {
  DEVELOPER_RECENT_OVERDUE_MS,
  DEVELOPER_WIN_GOAL_KEYS,
  getCurrentDeveloperGoalKey,
  normalizeDeveloperGoals,
} from './developer-goals.js';

export const DEVELOPER_FOCUS_CATEGORIES = [
  { id: 'unassigned', label: 'Tildel utvikler', hint: 'Uten utvikler. Når Admin er den eneste utvikleren, tildeles kunden dit.', adminOnly: true },
  { id: 'previewOverdue', label: 'Forfalte previews', hint: 'Møtet er passert og preview er ikke klar.' },
  { id: 'previewNext', label: 'Neste previews', hint: 'Neste møter som trenger en nettside-preview.' },
  { id: 'readyForDeployment', label: 'Klar for deployment', hint: 'Kontrakt signert. Gjør nettsiden klar for deployment.' },
  { id: 'iterationDone', label: 'Iterasjon', hint: 'Jobb gjennom iterasjonsmeldingene fra kunden.' },
  { id: 'publish', label: 'Publish', hint: 'Iterasjon ferdig. Publiser nettsiden.' },
  { id: 'done', label: 'Ferdig', hint: 'Publisert. Venter på at nettsiden markeres ferdig.' },
];

function text(value) {
  return String(value ?? '').trim();
}

function parseMs(value) {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? ms : null;
}

export function developerFocusCategoriesFor({ isAdmin = false } = {}) {
  return DEVELOPER_FOCUS_CATEGORIES.filter((row) => isAdmin || !row.adminOnly);
}

export function normalizeDeveloperFocusCategory(value, { isAdmin = false } = {}) {
  const raw = text(value);
  const id = raw === 'preview' ? 'previewNext' : raw;
  return developerFocusCategoriesFor({ isAdmin }).some((row) => row.id === id) ? id : '';
}

export function developerFocusCategoryFor(item = {}, kind = 'deployment', { isAdmin = false, nowMs = Date.now() } = {}) {
  if (isAdmin && !text(item.developerOwnerId)) return 'unassigned';
  if (kind === 'preview') {
    const ready = normalizeDeveloperGoals(item.developerGoals).readyForPreview;
    const ms = parseMs(item.rankAt);
    if (!ready && ms != null && ms < nowMs) return 'previewOverdue';
    return 'previewNext';
  }
  return getCurrentDeveloperGoalKey(item.developerGoals, DEVELOPER_WIN_GOAL_KEYS) || 'done';
}

/** Recent past due (2 weeks), then upcoming, then older past due, then no time. Same order the old buckets had. */
function timeRank(ms, nowMs) {
  if (ms == null) return 3;
  if (ms >= nowMs) return 1;
  return nowMs - ms <= DEVELOPER_RECENT_OVERDUE_MS ? 0 : 2;
}

export function developerFocusEntry(item = {}, kind = 'deployment', nowMs = Date.now(), options = {}) {
  const category = developerFocusCategoryFor(item, kind, { ...options, nowMs });
  const ms = parseMs(item.rankAt);
  return {
    id: text(item.id),
    name: text(item.businessName),
    item,
    kind,
    category,
    dueAt: ms == null ? '' : new Date(ms).toISOString(),
    overdue: ms != null && ms < nowMs,
    previewReady: kind === 'preview' && normalizeDeveloperGoals(item.developerGoals).readyForPreview,
    timeRank: timeRank(ms, nowMs),
  };
}

function compareNames(a, b) {
  return a.name.localeCompare(b.name, 'nb-NO', { sensitivity: 'base' });
}

/** Preview: next meeting first (soonest upcoming, then newest overdue), then no time. Ready previews last. */
function comparePreviewEntries(a, b) {
  if (a.previewReady !== b.previewReady) return a.previewReady ? 1 : -1;
  const aMs = parseMs(a.dueAt);
  const bMs = parseMs(b.dueAt);
  if ((aMs == null) !== (bMs == null)) return aMs == null ? 1 : -1;
  if (a.overdue !== b.overdue) return a.overdue ? 1 : -1;
  if (aMs != null && bMs != null && aMs !== bMs) return a.overdue ? bMs - aMs : aMs - bMs;
  return compareNames(a, b);
}

function compareEntries(a, b) {
  if (a.category === 'previewNext' && b.category === 'previewNext') return comparePreviewEntries(a, b);
  if (a.category === 'previewOverdue' && b.category === 'previewOverdue') return comparePreviewEntries(a, b);
  if (a.previewReady !== b.previewReady) return a.previewReady ? 1 : -1;
  if (a.timeRank !== b.timeRank) return a.timeRank - b.timeRank;
  if (a.timeRank !== 3) {
    const diff = (parseMs(a.dueAt) || 0) - (parseMs(b.dueAt) || 0);
    if (diff) return diff;
  }
  return compareNames(a, b);
}

/** Developer board queues for the Website bracket. Preview = unsigned list, the rest follow the win goals. */
export function groupDeveloperFocusQueues({ previewItems = [], developmentItems = [] } = {}, nowMs = Date.now(), options = {}) {
  const categories = developerFocusCategoriesFor(options);
  const queues = Object.fromEntries(categories.map((row) => [row.id, []]));
  const add = (item, kind) => {
    const entry = developerFocusEntry(item, kind, nowMs, options);
    if (queues[entry.category]) queues[entry.category].push(entry);
  };
  for (const item of developmentItems) add(item, 'deployment');
  for (const item of previewItems) add(item, 'preview');
  for (const id of Object.keys(queues)) queues[id].sort(compareEntries);
  return queues;
}

/** First tab with something late, else the first one with clients. */
export function defaultDeveloperFocusCategory(queues = {}, options = {}) {
  const ids = developerFocusCategoriesFor(options).map((row) => row.id);
  return ids.find((id) => (queues[id] || []).some((entry) => entry.overdue && !entry.previewReady))
    || ids.find((id) => id !== 'done' && (queues[id] || []).length)
    || ids[0];
}
