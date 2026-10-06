import { getWorkshopAction } from './workshop-action-shared.js';
import {
  clampIsoToDueDate,
  dueDateDay,
  isIsoAfterDueDate,
  isWeekendDueDate,
  osloCalendarYmd,
  osloWallToIso,
  resolveWebsiteDue,
} from './website-due.js';
import { mergeWorkshopRecord, persistWorkshopRecord } from './workshop-record.js';

export const INFORMASJON_ACTION_ID = 'informasjon-ring';
export const INFORMASJON_NOTE = 'få tak i manglende informasjon';
export const FEEDBACK_ACTION_ID = 'iteration-feedback';
export const FEEDBACK_NOTE = 'ring og be om tidspunkt vi kan se på prosjektet sammen';

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

export function calendarDaysAtNineFromIso(iso = '', days = 0) {
  const start = osloCalendarYmd(iso);
  if (!start) return '';
  const offset = Number(days);
  if (!Number.isFinite(offset)) return '';
  const date = new Date(`${start}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  let ymd = date.toISOString().slice(0, 10);
  while (isWeekendDueDate(ymd)) {
    const next = new Date(`${ymd}T12:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    ymd = next.toISOString().slice(0, 10);
  }
  return osloWallToIso(ymd, 9, 0, 0);
}

export function informasjonDueAtFromSignedAt(signedAt = '') {
  return calendarDaysAtNineFromIso(signedAt, 7);
}

export function clientWebsiteDueYmd(client = {}) {
  const due = resolveWebsiteDue({
    contractSigned: Boolean(client?.progression?.contractSigned),
    contractSignedAt: client?.contractSignedAt,
    dueOverride: client?.websiteDueOverride,
    weeks: client?.websiteDeliveryWeeks,
    workDays: client?.websiteDeliveryWorkDays,
  });
  return dueDateDay(due.dueAt);
}

export function clampValueToDueDate(iso = '', dueYmd = '') {
  if (!iso || !dueYmd) return sanitizeText(iso);
  if (!isIsoAfterDueDate(iso, dueYmd)) return sanitizeText(iso);
  return clampIsoToDueDate(iso, dueYmd);
}

function goalActionsList(client = {}) {
  const rows = Array.isArray(client?.workshop?.goalActions) ? client.workshop.goalActions : [];
  return rows.slice();
}

export function buildInformasjonAction(client = {}, dueAt = '') {
  return {
    id: INFORMASJON_ACTION_ID,
    name: 'Informasjon',
    note: INFORMASJON_NOTE,
    format: 'ring',
    dueAt: dueAt || informasjonDueAtFromSignedAt(client?.contractSignedAt),
    addToCalendar: false,
    goalKey: 'informasjon',
    presetKey: 'informasjon',
    doneAt: '',
    calendarEventId: '',
  };
}

export function buildFeedbackAction() {
  return {
    id: FEEDBACK_ACTION_ID,
    name: 'Få tilbakemelding',
    note: FEEDBACK_NOTE,
    format: 'mote',
    dueAt: '',
    addToCalendar: true,
    goalKey: 'iterated',
    presetKey: 'feedback',
    doneAt: '',
    calendarEventId: '',
  };
}

export function ensureInformasjonAction(client = {}) {
  if (!client?.progression?.contractSigned) return client;
  const dueAt = informasjonDueAtFromSignedAt(client.contractSignedAt);
  if (!dueAt) return client;
  const actions = goalActionsList(client);
  const existing = actions.find((row) => sanitizeText(row?.id) === INFORMASJON_ACTION_ID
    || sanitizeText(row?.presetKey) === 'informasjon');
  if (existing) return client;
  actions.push(buildInformasjonAction(client, dueAt));
  const workshop = persistWorkshopRecord(mergeWorkshopRecord(client.workshop, { goalActions: actions }));
  return { ...client, workshop };
}

export function ensureFeedbackAction(client = {}) {
  const actions = goalActionsList(client);
  const existing = actions.find((row) => sanitizeText(row?.id) === FEEDBACK_ACTION_ID
    || sanitizeText(row?.presetKey) === 'feedback');
  if (existing) return client;
  actions.push(buildFeedbackAction());
  const workshop = persistWorkshopRecord(mergeWorkshopRecord(client.workshop, { goalActions: actions }));
  return { ...client, workshop };
}

export function clampClientActionsToDueDate(client = {}) {
  const dueYmd = clientWebsiteDueYmd(client);
  if (!dueYmd) return client;
  let changed = false;
  const action = getWorkshopAction(client);
  let workshopAction = action;
  if (action?.dueAt && isIsoAfterDueDate(action.dueAt, dueYmd)) {
    workshopAction = { ...action, dueAt: clampIsoToDueDate(action.dueAt, dueYmd) };
    changed = true;
  }
  const record = client.workshop && typeof client.workshop === 'object' ? { ...client.workshop } : {};
  const actions = Array.isArray(record.goalActions) ? record.goalActions.map((row) => {
    if (!row?.dueAt || !isIsoAfterDueDate(row.dueAt, dueYmd)) return row;
    changed = true;
    return { ...row, dueAt: clampIsoToDueDate(row.dueAt, dueYmd) };
  }) : record.goalActions;
  const iteration = record.iterationMeeting && typeof record.iterationMeeting === 'object'
    ? record.iterationMeeting
    : null;
  let iterationMeeting = iteration;
  if (iteration?.dueAt && isIsoAfterDueDate(iteration.dueAt, dueYmd)) {
    iterationMeeting = { ...iteration, dueAt: clampIsoToDueDate(iteration.dueAt, dueYmd) };
    changed = true;
  }
  if (!changed) return client;
  return {
    ...client,
    workshopAction: workshopAction || client.workshopAction,
    workshop: persistWorkshopRecord({
      ...record,
      goalActions: actions,
      iterationMeeting: iterationMeeting || record.iterationMeeting,
    }),
  };
}

export function rejectActionAfterDueDate(iso = '', client = {}) {
  const dueYmd = clientWebsiteDueYmd(client);
  if (!iso || !dueYmd) return '';
  if (!isIsoAfterDueDate(iso, dueYmd)) return '';
  return 'Handlingen kan ikke settes etter leveringsfristen.';
}
