/**
 * T07 desk record on client.workshop (held, notes, summary, iteration).
 * Booking stays on client.workshopAction via getWorkshopAction. This file
 * never writes workshop.action, details.workshopAction, or a second dueAt
 * for the first workshop.
 */

import { sanitizeWorkshopFormat } from './workshop-action-shared.js';
import { sanitizeAdminGoalKey, sanitizeAdminPresetKey } from './workshop-goal-timeline.js';
import { persistTranscriptEval } from './workshop-transcript-eval.js';

export const PROJECT_TODO_CATEGORIES = [
  'Sider og innhold',
  'Funksjon og flyt',
  'Design og merkevare',
  'Media og materiell',
  'Integrasjoner',
  'Åpne beslutninger',
  'Utenfor scope',
];

const PROJECT_CATEGORY_SET = new Set(PROJECT_TODO_CATEGORIES);

export const WORKSHOP_SUMMARY_LANGUAGE = 'nb';
export const ITERATION_DEFAULT_NAME = 'Iterasjonsmøte';
export const MEETING_PURPOSES = ['sales', 'workshop', 'iteration'];

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function parseMs(value = '') {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix = 'ws') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyIterationMeeting() {
  return {
    dueAt: '',
    format: 'mote',
    addToCalendar: false,
    calendarEventId: '',
    meetLink: '',
    sentAt: '',
    firefliesMeetingId: '',
    accountKey: '',
    firefliesInvitedAt: '',
    firefliesLiveJoinedAt: '',
    firefliesLiveJoinAttemptAt: '',
    firefliesLiveJoinError: '',
    firefliesLiveJoinedMeetLink: '',
    confirmationSentAt: '',
  };
}

export function normalizeIterationMeeting(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const format = sanitizeWorkshopFormat(input.format);
  const dueAt = parseMs(input.dueAt) != null ? sanitizeText(input.dueAt) : '';
  const addToCalendar = format === 'mote'
    ? Boolean(dueAt)
    : Object.prototype.hasOwnProperty.call(input, 'addToCalendar')
      ? Boolean(input.addToCalendar)
      : false;
  return {
    dueAt,
    format,
    addToCalendar,
    calendarEventId: sanitizeText(input.calendarEventId),
    meetLink: format === 'mote' ? sanitizeText(input.meetLink) : '',
    sentAt: sanitizeText(input.sentAt),
    firefliesMeetingId: sanitizeText(input.firefliesMeetingId),
    accountKey: sanitizeText(input.accountKey),
    firefliesInvitedAt: format === 'mote' ? sanitizeText(input.firefliesInvitedAt) : '',
    firefliesLiveJoinedAt: format === 'mote' ? sanitizeText(input.firefliesLiveJoinedAt) : '',
    firefliesLiveJoinAttemptAt: sanitizeText(input.firefliesLiveJoinAttemptAt),
    firefliesLiveJoinError: sanitizeText(input.firefliesLiveJoinError),
    firefliesLiveJoinedMeetLink: format === 'mote' ? sanitizeText(input.firefliesLiveJoinedMeetLink) : '',
    confirmationSentAt: sanitizeText(input.confirmationSentAt),
  };
}

function sanitizeProjectCategory(value = '') {
  const raw = sanitizeText(value);
  return PROJECT_CATEGORY_SET.has(raw) ? raw : 'Åpne beslutninger';
}

export function persistProjectTodo(raw = {}, index = 0) {
  const title = sanitizeText(raw?.title).slice(0, 180);
  const detail = sanitizeText(raw?.detail).slice(0, 800);
  if (!title && !detail) return null;
  return {
    id: sanitizeText(raw?.id) || `todo-${index + 1}`,
    category: sanitizeProjectCategory(raw?.category),
    title: title || detail.slice(0, 80),
    detail,
    done: Boolean(raw?.done),
  };
}

export function persistProjectDocument(raw = null) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const todos = Array.isArray(input.todos)
    ? input.todos.map(persistProjectTodo).filter(Boolean)
    : [];
  const goalExplanation = sanitizeText(input.goalExplanation).slice(0, 4000);
  const clientDocumentation = sanitizeText(input.clientDocumentation).slice(0, 8000);
  if (!goalExplanation && !clientDocumentation && !todos.length && !sanitizeText(input.meetingId)) return null;
  return {
    meetingId: sanitizeText(input.meetingId),
    goalExplanation,
    clientDocumentation,
    todos,
    generatedAt: sanitizeText(input.generatedAt) || nowIso(),
    source: sanitizeText(input.source) === 'fallback' ? 'fallback' : 'ai',
  };
}

export function markProjectTodoDone(document, todoId, done) {
  const current = persistProjectDocument(document);
  if (!current) return null;
  const id = sanitizeText(todoId);
  return persistProjectDocument({
    ...current,
    todos: current.todos.map((row) => (row.id === id ? { ...row, done: Boolean(done) } : row)),
  });
}

function normalizeSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intro = sanitizeText(raw.intro);
  const voice = sanitizeText(raw.voice);
  const whatTheyWant = sanitizeText(raw.whatTheyWant);
  const functionality = sanitizeText(raw.functionality);
  if (!intro && !voice && !whatTheyWant && !functionality) return null;
  return {
    intro,
    voice,
    whatTheyWant,
    functionality,
    generatedAt: sanitizeText(raw.generatedAt) || nowIso(),
    source: sanitizeText(raw.source) === 'fallback' ? 'fallback' : 'ai',
    fromNotesOnly: Boolean(raw.fromNotesOnly),
    language: WORKSHOP_SUMMARY_LANGUAGE,
  };
}

function normalizeNoteFile(raw = {}) {
  return {
    id: sanitizeText(raw.id) || makeId('wf'),
    originalName: sanitizeText(raw.originalName) || 'fil',
    mime: sanitizeText(raw.mime) || 'application/octet-stream',
    bytes: Number(raw.bytes) || 0,
  };
}

function normalizeWorkshopNote(raw = {}) {
  const kind = sanitizeText(raw.kind) === 'iteration' ? 'iteration' : 'workshop';
  return {
    id: sanitizeText(raw.id) || makeId('wn'),
    kind,
    at: sanitizeText(raw.at) || nowIso(),
    by: sanitizeText(raw.by),
    text: sanitizeText(raw.text).slice(0, 8000),
    files: Array.isArray(raw.files) ? raw.files.map(normalizeNoteFile) : [],
  };
}

function normalizeIterationLogEntry(raw = {}) {
  return {
    id: sanitizeText(raw.id) || makeId('il'),
    at: sanitizeText(raw.at) || nowIso(),
    by: sanitizeText(raw.by),
    text: sanitizeText(raw.text).slice(0, 8000),
    files: Array.isArray(raw.files) ? raw.files.map(normalizeNoteFile) : [],
    doneAt: sanitizeText(raw.doneAt),
    doneBy: sanitizeText(raw.doneBy),
  };
}

function normalizeHeardFact(raw = {}) {
  return {
    id: sanitizeText(raw.id) || makeId('heard'),
    title: sanitizeText(raw.title) || 'Hørt, ikke lagret',
    detail: sanitizeText(raw.detail),
    source: sanitizeText(raw.source) || 'note',
    quote: sanitizeText(raw.quote).slice(0, 400),
    at: sanitizeText(raw.at) || nowIso(),
  };
}

function normalizeDeskEmails(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    reminder3dSentAt: sanitizeText(input.reminder3dSentAt),
    reminder24hSentAt: sanitizeText(input.reminder24hSentAt),
    data1SentAt: sanitizeText(input.data1SentAt),
    data2SentAt: sanitizeText(input.data2SentAt),
    preWorkshopSentAt: sanitizeText(input.preWorkshopSentAt),
  };
}

function normalizeGoalAction(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const format = sanitizeWorkshopFormat(input.format);
  const dueAt = parseMs(input.dueAt) != null ? sanitizeText(input.dueAt) : '';
  const addToCalendar = Boolean(input.addToCalendar);
  if (!sanitizeText(input.name) && !dueAt && !sanitizeText(input.id)) return null;
  return {
    id: sanitizeText(input.id) || makeId('wga'),
    name: sanitizeText(input.name) || 'Handling',
    note: sanitizeText(input.note).slice(0, 1000),
    format,
    dueAt,
    addToCalendar,
    goalKey: sanitizeAdminGoalKey(input.goalKey),
    presetKey: sanitizeAdminPresetKey(input.presetKey),
    doneAt: sanitizeText(input.doneAt),
    calendarEventId: sanitizeText(input.calendarEventId),
  };
}

/** Strip decoy booking fields. client.workshop is never the workshop clock. */
export function normalizeWorkshopRecord(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const history = Array.isArray(input.summaryHistory)
    ? input.summaryHistory.map(normalizeSummary).filter(Boolean)
    : [];
  const iterationMeeting = input.iterationMeeting && typeof input.iterationMeeting === 'object'
    ? normalizeIterationMeeting(input.iterationMeeting)
    : emptyIterationMeeting();
  return {
    heldAt: parseMs(input.heldAt) != null ? sanitizeText(input.heldAt) : '',
    informasjonAt: parseMs(input.informasjonAt) != null ? sanitizeText(input.informasjonAt) : '',
    iteratedAt: parseMs(input.iteratedAt) != null ? sanitizeText(input.iteratedAt) : '',
    summary: normalizeSummary(input.summary),
    summaryHistory: history.slice(-20),
    notes: Array.isArray(input.notes) ? input.notes.map(normalizeWorkshopNote) : [],
    iterationLog: Array.isArray(input.iterationLog) ? input.iterationLog.map(normalizeIterationLogEntry) : [],
    iterationMeeting,
    heardFacts: Array.isArray(input.heardFacts) ? input.heardFacts.map(normalizeHeardFact) : [],
    goalActions: Array.isArray(input.goalActions)
      ? input.goalActions.map(normalizeGoalAction).filter(Boolean)
      : [],
    deskEmails: normalizeDeskEmails(input.deskEmails),
    projectDocument: persistProjectDocument(input.projectDocument),
    transcriptEval: persistTranscriptEval(input.transcriptEval),
  };
}

export function emptyWorkshopRecord() {
  return {
    heldAt: '',
    informasjonAt: '',
    iteratedAt: '',
    summary: null,
    summaryHistory: [],
    notes: [],
    iterationLog: [],
    iterationMeeting: emptyIterationMeeting(),
    heardFacts: [],
    goalActions: [],
    deskEmails: normalizeDeskEmails(),
    projectDocument: null,
    transcriptEval: null,
  };
}

export function persistWorkshopRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const next = normalizeWorkshopRecord(raw);
  const hasMeeting = Boolean(
    next.iterationMeeting.dueAt
    || next.iterationMeeting.calendarEventId
    || next.iterationMeeting.sentAt
    || next.iterationMeeting.firefliesMeetingId,
  );
  const hasDeskEmail = Boolean(
    next.deskEmails.reminder3dSentAt
    || next.deskEmails.reminder24hSentAt
    ||     next.deskEmails.data1SentAt
    || next.deskEmails.data2SentAt
    || next.deskEmails.preWorkshopSentAt,
  );
  const hasAny = Boolean(
    next.heldAt
    || next.informasjonAt
    || next.iteratedAt
    || next.summary
    || next.summaryHistory.length
    || next.notes.length
    || next.iterationLog.length
    || next.heardFacts.length
    || next.goalActions.length
    || hasMeeting
    || hasDeskEmail
    || next.projectDocument
    || next.transcriptEval,
  );
  return hasAny ? next : null;
}

export function mergeWorkshopRecord(current, patch = {}) {
  const base = normalizeWorkshopRecord(current || {});
  const next = patch && typeof patch === 'object' ? patch : {};
  return normalizeWorkshopRecord({
    ...base,
    ...next,
    summary: Object.prototype.hasOwnProperty.call(next, 'summary') ? next.summary : base.summary,
    summaryHistory: Array.isArray(next.summaryHistory) ? next.summaryHistory : base.summaryHistory,
    notes: Array.isArray(next.notes) ? next.notes : base.notes,
    iterationLog: Array.isArray(next.iterationLog) ? next.iterationLog : base.iterationLog,
    iterationMeeting: Object.prototype.hasOwnProperty.call(next, 'iterationMeeting')
      ? { ...base.iterationMeeting, ...(next.iterationMeeting || {}) }
      : base.iterationMeeting,
    heardFacts: Array.isArray(next.heardFacts) ? next.heardFacts : base.heardFacts,
    goalActions: Array.isArray(next.goalActions) ? next.goalActions : base.goalActions,
    deskEmails: Object.prototype.hasOwnProperty.call(next, 'deskEmails')
      ? { ...base.deskEmails, ...(next.deskEmails || {}) }
      : base.deskEmails,
    projectDocument: Object.prototype.hasOwnProperty.call(next, 'projectDocument')
      ? next.projectDocument
      : base.projectDocument,
    transcriptEval: Object.prototype.hasOwnProperty.call(next, 'transcriptEval')
      ? next.transcriptEval
      : base.transcriptEval,
  });
}

export function getWorkshopRecord(client = {}) {
  return normalizeWorkshopRecord(client?.workshop || {});
}

export function workshopMeetingHappened(client = {}) {
  const format = sanitizeWorkshopFormat(client?.workshopAction?.format);
  return format === 'mote' && parseMs(client?.workshopAction?.dueAt) != null;
}

export function sanitizeMeetingPurpose(value = '') {
  const raw = sanitizeText(value).toLowerCase();
  return MEETING_PURPOSES.includes(raw) ? raw : '';
}

/** Browser-safe hover target. Never falls back to meetings[0]. hasVideo comes from GET /admin/sales. */
export function clientMeetingHover(client = {}, purpose = '') {
  const wanted = sanitizeMeetingPurpose(purpose);
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const slotId = wanted === 'workshop'
    ? sanitizeText(client?.workshopAction?.firefliesMeetingId)
    : wanted === 'iteration'
      ? sanitizeText(client?.workshop?.iterationMeeting?.firefliesMeetingId)
      : '';
  const tagged = meetings.find((row) => sanitizeMeetingPurpose(row?.purpose) === wanted);
  const sales = wanted === 'sales'
    ? meetings.find((row) => row?.forSalesMeeting || sanitizeMeetingPurpose(row?.purpose) === 'sales')
    : null;
  const meetingId = slotId || sanitizeText(tagged?.meetingId) || sanitizeText(sales?.meetingId);
  const row = meetings.find((entry) => sanitizeText(entry?.meetingId) === meetingId);
  return {
    meetingId,
    hasVideo: Boolean(row?.hasVideo),
  };
}
