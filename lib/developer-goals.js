const DAY_MS = 24 * 60 * 60 * 1000;

export const DEVELOPER_GOAL_KEYS = [
  'readyForPreview',
  'readyForDeployment',
  'iterationDone',
  'publish',
];

/** Lower developer list: only the preview step. */
export const DEVELOPER_PREVIEW_GOAL_KEYS = ['readyForPreview'];

/** Development list for sales wins. Preview stays on the other list. */
export const DEVELOPER_WIN_GOAL_KEYS = [
  'readyForDeployment',
  'iterationDone',
  'publish',
];

function resolveGoalKeys(keys) {
  return Array.isArray(keys) && keys.length ? keys : DEVELOPER_GOAL_KEYS;
}

export const DEVELOPER_GOAL_LABELS = {
  readyForPreview: 'Klar for preview',
  readyForDeployment: 'Klar for deployment',
  iterationDone: 'Iterasjon ferdig',
  publish: 'Publish',
};

/** Developer Forfalt window. Sales stays at 48 hours. */
export const DEVELOPER_RECENT_OVERDUE_MS = 14 * DAY_MS;

function emptyDeveloperGoals() {
  return {
    readyForPreview: false,
    readyForDeployment: false,
    iterationDone: false,
    publish: false,
  };
}

export function normalizeDeveloperGoals(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const out = emptyDeveloperGoals();
  for (const key of DEVELOPER_GOAL_KEYS) {
    out[key] = Boolean(input[key]);
  }
  return out;
}

export function formatDeveloperGoalLabel(key = '') {
  return DEVELOPER_GOAL_LABELS[key] || key;
}

export function getCurrentDeveloperGoalKey(goals = {}, keys) {
  const normalized = normalizeDeveloperGoals(goals);
  return resolveGoalKeys(keys).find((key) => !normalized[key]) || '';
}

export function getVisibleDeveloperGoalKeys(goals = {}, showFuture = false, keys) {
  const list = resolveGoalKeys(keys);
  const normalized = normalizeDeveloperGoals(goals);
  if (showFuture) return [...list];
  const current = getCurrentDeveloperGoalKey(normalized, list);
  const visible = [];
  for (const key of list) {
    if (normalized[key] || key === current) visible.push(key);
    if (key === current) break;
  }
  return visible;
}

export function getFutureDeveloperGoalKeys(goals = {}, keys) {
  const list = resolveGoalKeys(keys);
  const visible = new Set(getVisibleDeveloperGoalKeys(goals, false, list));
  return list.filter((key) => !visible.has(key));
}

export function getRemainingDeveloperGoalCount(goals = {}, keys) {
  return getFutureDeveloperGoalKeys(goals, keys).length;
}

export function applyDeveloperGoalToggle(current, key, keys) {
  const list = resolveGoalKeys(keys);
  const goals = normalizeDeveloperGoals(current);
  const mapped = String(key || '').trim();
  const index = list.indexOf(mapped);
  if (index < 0) return { error: 'Ugyldig utviklermål.' };
  if (goals[mapped]) {
    for (let i = index; i < list.length; i += 1) {
      goals[list[i]] = false;
    }
    return { goals };
  }
  const currentKey = getCurrentDeveloperGoalKey(goals, list);
  if (mapped !== currentKey) {
    return { error: 'Fullfør nåværende mål først' };
  }
  goals[mapped] = true;
  return { goals };
}

export function showDeveloperDeployChips(goals = {}) {
  return Boolean(normalizeDeveloperGoals(goals).readyForPreview);
}
