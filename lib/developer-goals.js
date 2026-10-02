const DAY_MS = 24 * 60 * 60 * 1000;

export const DEVELOPER_GOAL_KEYS = [
  'readyForPreview',
  'readyForDeployment',
  'iterationDone',
  'publish',
];

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

export function getCurrentDeveloperGoalKey(goals = {}) {
  const normalized = normalizeDeveloperGoals(goals);
  return DEVELOPER_GOAL_KEYS.find((key) => !normalized[key]) || '';
}

export function getVisibleDeveloperGoalKeys(goals = {}, showFuture = false) {
  const normalized = normalizeDeveloperGoals(goals);
  if (showFuture) return [...DEVELOPER_GOAL_KEYS];
  const current = getCurrentDeveloperGoalKey(normalized);
  const visible = [];
  for (const key of DEVELOPER_GOAL_KEYS) {
    if (normalized[key] || key === current) visible.push(key);
    if (key === current) break;
  }
  return visible;
}

export function getFutureDeveloperGoalKeys(goals = {}) {
  const visible = new Set(getVisibleDeveloperGoalKeys(goals, false));
  return DEVELOPER_GOAL_KEYS.filter((key) => !visible.has(key));
}

export function getRemainingDeveloperGoalCount(goals = {}) {
  return getFutureDeveloperGoalKeys(goals).length;
}

export function applyDeveloperGoalToggle(current, key) {
  const goals = normalizeDeveloperGoals(current);
  const mapped = String(key || '').trim();
  const index = DEVELOPER_GOAL_KEYS.indexOf(mapped);
  if (index < 0) return { error: 'Ugyldig utviklermål.' };
  if (goals[mapped]) {
    for (let i = index; i < DEVELOPER_GOAL_KEYS.length; i += 1) {
      goals[DEVELOPER_GOAL_KEYS[i]] = false;
    }
    return { goals };
  }
  const currentKey = getCurrentDeveloperGoalKey(goals);
  if (mapped !== currentKey) {
    return { error: 'Fullfør nåværende mål først' };
  }
  goals[mapped] = true;
  return { goals };
}

export function showDeveloperDeployChips(goals = {}) {
  return Boolean(normalizeDeveloperGoals(goals).readyForPreview);
}
