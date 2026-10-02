/** Admin workshop goal chips and extra actions. Browser-safe. */

import {
  damianMeetJoinUrl,
  sanitizeWorkshopFormat,
  workshopFormatIsPhone,
} from './workshop-action-shared.js';

export const ADMIN_WORKSHOP_GOALS = ['haWorkshop', 'iterated'];

export const ADMIN_GOAL_LABELS = {
  haWorkshop: 'Ha workshop',
  iterated: 'Iterert',
};

export const ADMIN_GOAL_PRESETS = {
  haWorkshop: ['sms24h', 'call2h', 'custom'],
  iterated: ['sms24h', 'call2h', 'custom'],
};

export const ADMIN_PRESET_LABELS = {
  sms24h: 'SMS 24h',
  call2h: 'Call 2h',
  custom: 'Custom',
};

const HOUR_MS = 60 * 60 * 1000;
const ADMIN_GOAL_SET = new Set(ADMIN_WORKSHOP_GOALS);
const ADMIN_PRESET_SET = new Set(['sms24h', 'call2h', 'custom']);

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function parseMs(value = '') {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

export function sanitizeAdminGoalKey(value = '') {
  const key = sanitizeText(value);
  return ADMIN_GOAL_SET.has(key) ? key : 'haWorkshop';
}

export function sanitizeAdminPresetKey(value = '') {
  const key = sanitizeText(value);
  return ADMIN_PRESET_SET.has(key) ? key : 'custom';
}

export function formatAdminGoalLabel(key = '') {
  return ADMIN_GOAL_LABELS[key] || key;
}

export function formatAdminPresetLabel(key = '') {
  return ADMIN_PRESET_LABELS[key] || 'Custom';
}

export function defaultFormatForAdminPreset(presetKey = '') {
  const key = sanitizeAdminPresetKey(presetKey);
  if (key === 'sms24h') return 'sms';
  if (key === 'call2h') return 'ring';
  return 'sms';
}

export function workshopGoalHeld(client = {}) {
  return Boolean(sanitizeText(client?.workshop?.heldAt) && client?.workshop?.summary);
}

export function workshopGoalIterated(client = {}) {
  return Boolean(sanitizeText(client?.workshop?.iteratedAt));
}

export function getAdminCurrentGoalKey(client = {}) {
  if (!workshopGoalHeld(client)) return 'haWorkshop';
  if (!workshopGoalIterated(client)) return 'iterated';
  return '';
}

export function getAdminVisibleGoalKeys(client = {}, showFuture = false) {
  if (showFuture) return [...ADMIN_WORKSHOP_GOALS];
  const current = getAdminCurrentGoalKey(client);
  const visible = [];
  for (const key of ADMIN_WORKSHOP_GOALS) {
    const done = key === 'haWorkshop' ? workshopGoalHeld(client) : workshopGoalIterated(client);
    if (done || key === current) visible.push(key);
    if (key === current) break;
  }
  return visible;
}

export function getAdminFutureGoalKeys(client = {}) {
  const visible = new Set(getAdminVisibleGoalKeys(client, false));
  return ADMIN_WORKSHOP_GOALS.filter((key) => !visible.has(key));
}

export function getAdminRemainingGoalCount(client = {}) {
  return getAdminFutureGoalKeys(client).length;
}

/**
 * Meet button target. After Ha workshop, never fall back to the workshop Meet.
 * SMS/ring has no join URL — the button stays, click is a no-op.
 * Never uses the sales-meeting calendar Meet.
 */
export function resolveAdminMeetJoin(client = {}) {
  const useIteration = workshopGoalHeld(client);
  const meeting = useIteration
    ? (client?.workshop?.iterationMeeting || {})
    : (client?.workshopAction || {});
  const formatRaw = sanitizeText(meeting.format);
  const phone = workshopFormatIsPhone(formatRaw);
  const meetLink = phone ? '' : sanitizeText(meeting.meetLink);
  const joinUrl = damianMeetJoinUrl(meetLink);
  return {
    source: useIteration ? 'iteration' : 'workshop',
    format: formatRaw ? sanitizeWorkshopFormat(formatRaw) : '',
    meetLink,
    joinUrl,
    canOpen: Boolean(joinUrl),
  };
}

export function getAdminGoalActions(client = {}, goalKey = '') {
  const key = sanitizeAdminGoalKey(goalKey);
  const rows = Array.isArray(client?.workshop?.goalActions) ? client.workshop.goalActions : [];
  return rows.filter((row) => !sanitizeText(row?.doneAt) && sanitizeAdminGoalKey(row?.goalKey) === key);
}

export function referenceDueAtForAdminGoal(client = {}, goalKey = '') {
  if (sanitizeAdminGoalKey(goalKey) === 'iterated') {
    return sanitizeText(client?.workshop?.iterationMeeting?.dueAt);
  }
  return sanitizeText(client?.workshopAction?.dueAt);
}

export function suggestedAdminActionDueAt(presetKey = '', client = {}, goalKey = '') {
  const key = sanitizeAdminPresetKey(presetKey);
  const meetingMs = parseMs(referenceDueAtForAdminGoal(client, goalKey));
  if (key === 'sms24h' && meetingMs != null) return toIso(meetingMs - 24 * HOUR_MS);
  if (key === 'call2h' && meetingMs != null) return toIso(meetingMs - 2 * HOUR_MS);
  return '';
}

export function applyWorkshopGoalActionOp(record = {}, patch = {}) {
  const op = sanitizeText(patch.op);
  const actions = Array.isArray(record?.goalActions) ? record.goalActions.slice() : [];
  if (op === 'create') {
    const goalKey = sanitizeAdminGoalKey(patch.goalKey);
    const presetKey = sanitizeAdminPresetKey(patch.presetKey);
    const format = sanitizeWorkshopFormat(patch.format || defaultFormatForAdminPreset(presetKey));
    const dueAt = parseMs(patch.dueAt) != null ? sanitizeText(patch.dueAt) : '';
    const name = sanitizeText(patch.name) || formatAdminPresetLabel(presetKey);
    if (!name || !dueAt) return { error: 'Sett navn og tid for handlingen.' };
    actions.push({
      id: sanitizeText(patch.id),
      name,
      note: sanitizeText(patch.note),
      format,
      dueAt,
      addToCalendar: Boolean(patch.addToCalendar),
      goalKey,
      presetKey,
      doneAt: '',
      calendarEventId: '',
    });
    return { goalActions: actions };
  }

  const id = sanitizeText(patch.id);
  if (!id) return { error: 'Mangler handling.' };
  const index = actions.findIndex((row) => sanitizeText(row?.id) === id);
  if (index < 0) return { error: 'Fant ikke handlingen.' };

  if (op === 'delete') {
    return { goalActions: actions.filter((row) => sanitizeText(row?.id) !== id) };
  }
  if (op === 'complete') {
    const next = actions.slice();
    next[index] = { ...next[index], doneAt: sanitizeText(patch.doneAt) || new Date().toISOString() };
    return { goalActions: next };
  }
  if (op === 'update') {
    const prev = actions[index];
    const next = actions.slice();
    next[index] = {
      ...prev,
      name: Object.prototype.hasOwnProperty.call(patch, 'name') ? sanitizeText(patch.name) || prev.name : prev.name,
      note: Object.prototype.hasOwnProperty.call(patch, 'note') ? sanitizeText(patch.note) : prev.note,
      format: Object.prototype.hasOwnProperty.call(patch, 'format')
        ? sanitizeWorkshopFormat(patch.format)
        : prev.format,
      dueAt: Object.prototype.hasOwnProperty.call(patch, 'dueAt')
        ? (parseMs(patch.dueAt) != null ? sanitizeText(patch.dueAt) : prev.dueAt)
        : prev.dueAt,
      addToCalendar: Object.prototype.hasOwnProperty.call(patch, 'addToCalendar')
        ? Boolean(patch.addToCalendar)
        : prev.addToCalendar,
    };
    if (!next[index].name || !next[index].dueAt) return { error: 'Sett navn og tid for handlingen.' };
    return { goalActions: next };
  }
  return { error: 'Ukjent handling.' };
}
