/**
 * Chronological client log: sales actions + Fireflies recordings, grouped by goal.
 * Does not write Kundedata or invent history that was already purged.
 */

import { isPlaceholderMeetingId } from './offer-meetings.js';
import {
  AFTER_SALE_GOAL,
  clientIsSalesWin,
  decorateNextActions,
  formatActionFormatLabel,
  formatGoalLabel,
  getCurrentGoalKey,
  getSalesGoalKeys,
} from './sales-next-actions.js';
import { getWorkshopAction } from './workshop-action-shared.js';
import { getWorkshopRecord } from './workshop-record.js';

const MEETING_PURPOSE_WINDOW_MS = 3 * 60 * 60 * 1000;

const EXTRA_SECTION_LABELS = {
  workshop: 'Workshop',
  iteration: 'Iterasjon',
};

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function parseMs(value = '') {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function normalizeMeetLink(value = '') {
  return sanitizeText(value).toLowerCase().replace(/[?#].*$/, '');
}

export function firefliesUrlForMeeting(meeting = {}) {
  const view = sanitizeText(meeting.transcriptUrl || meeting.transcript_url);
  if (/^https:\/\/app\.fireflies\.ai\//i.test(view)) return view;
  const id = sanitizeText(meeting.meetingId);
  return id ? `https://app.fireflies.ai/view/${encodeURIComponent(id)}` : 'https://app.fireflies.ai/';
}

function meetingHasTalk(meeting = {}) {
  return Boolean(meeting.hasTranscript || sanitizeText(meeting.transcript) || sanitizeText(meeting.summary));
}

export function isSupersededLiveStub(meeting = {}, meetings = []) {
  if (!isPlaceholderMeetingId(meeting?.meetingId)) return false;
  const link = normalizeMeetLink(meeting.meetLink || meeting.meetingLink);
  const purpose = sanitizeText(meeting.purpose);
  return (Array.isArray(meetings) ? meetings : []).some((row) => {
    if (isPlaceholderMeetingId(row?.meetingId) || !meetingHasTalk(row)) return false;
    const otherLink = normalizeMeetLink(row.meetLink || row.meetingLink);
    if (link && otherLink && link === otherLink) return true;
    if (purpose && purpose === sanitizeText(row.purpose)) return true;
    return Boolean(meeting.forSalesMeeting && row.forSalesMeeting);
  });
}

function pickMeetingForAction(meetings = [], action = {}, usedMeetingIds = new Set()) {
  const candidates = (Array.isArray(meetings) ? meetings : []).filter((row) => {
    const id = sanitizeText(row.meetingId);
    if (!id || usedMeetingIds.has(id) || isSupersededLiveStub(row, meetings)) return false;
    return meetingMatchesAction(row, action);
  });
  return candidates.find((row) => meetingHasTalk(row) && !isPlaceholderMeetingId(row.meetingId))
    || candidates.find((row) => !isPlaceholderMeetingId(row.meetingId))
    || candidates[0]
    || null;
}

export function meetingMatchesAction(meeting = {}, action = {}) {
  const meetingId = sanitizeText(meeting.meetingId || meeting.firefliesMeetingId);
  if (meetingId && sanitizeText(action.firefliesMeetingId) === meetingId) return true;
  const meetA = normalizeMeetLink(meeting.meetLink || meeting.meetingLink);
  const meetB = normalizeMeetLink(action.meetLink);
  if (meetA && meetB && meetA === meetB) return true;
  const start = parseMs(meeting.startedAt || meeting.when);
  const due = parseMs(action.dueAt);
  if (start == null || due == null) return false;
  if (Math.abs(start - due) > MEETING_PURPOSE_WINDOW_MS) return false;
  return sanitizeText(action.format) === 'mote' || sanitizeText(action.presetKey) === 'meeting';
}

function meetingStartMs(meeting = {}) {
  return parseMs(meeting.startedAt || meeting.when || meeting.dueAt);
}

function lastCompletedSalesGoal(client = {}) {
  const keys = getSalesGoalKeys(client.product);
  return [...keys].reverse().find((key) => client.progression?.[key]) || '';
}

export function goalKeyForUnattachedMeeting(client = {}, meeting = {}, actions = []) {
  const purpose = sanitizeText(meeting.purpose).toLowerCase();
  if (purpose === 'workshop') return 'workshop';
  if (purpose === 'iteration') return 'iteration';
  if (purpose === 'sales') return 'meetingHeld';
  const start = meetingStartMs(meeting);
  const booked = client?.agreedTime ? parseMs(client.meetingAt) : null;
  if (start != null && booked != null && Math.abs(start - booked) <= MEETING_PURPOSE_WINDOW_MS) {
    return 'meetingHeld';
  }
  const mote = (Array.isArray(actions) ? actions : [])
    .filter((action) => sanitizeText(action.format) === 'mote' || sanitizeText(action.presetKey) === 'meeting')
    .map((action) => {
      const due = parseMs(action.dueAt);
      if (start == null || due == null) return null;
      const diff = Math.abs(start - due);
      if (diff > MEETING_PURPOSE_WINDOW_MS) return null;
      return { goalKey: action.goalKey, diff };
    })
    .filter(Boolean)
    .sort((a, b) => a.diff - b.diff);
  if (mote[0]) return mote[0].goalKey;
  return getCurrentGoalKey(client) || lastCompletedSalesGoal(client) || 'meetingHeld';
}

function presentMeeting(meeting = {}, action = null) {
  const meetingId = sanitizeText(meeting.meetingId);
  return {
    meetingId,
    title: sanitizeText(meeting.title) || 'Fireflies-møte',
    when: sanitizeText(meeting.when) || '',
    startedAt: sanitizeText(meeting.startedAt),
    firefliesUrl: firefliesUrlForMeeting(meeting),
    hasTranscript: Boolean(meeting.hasTranscript || sanitizeText(meeting.transcript)),
    hasVideo: Boolean(meeting.hasVideo),
    purpose: sanitizeText(meeting.purpose),
    actionId: sanitizeText(action?.id),
    actionName: sanitizeText(action?.name),
  };
}

function actionRow(action = {}, meeting = null) {
  return {
    kind: 'action',
    id: `action:${action.id}`,
    actionId: action.id,
    goalKey: action.goalKey,
    name: sanitizeText(action.name) || 'Handling',
    note: sanitizeText(action.note),
    format: sanitizeText(action.format),
    formatLabel: formatActionFormatLabel(action.format),
    dueAt: sanitizeText(action.dueAt),
    doneAt: sanitizeText(action.doneAt),
    at: sanitizeText(action.dueAt) || sanitizeText(action.doneAt) || sanitizeText(action.createdAt),
    meeting: meeting ? presentMeeting(meeting, action) : null,
  };
}

function meetingRow(meeting = {}, goalKey = '') {
  const presented = presentMeeting(meeting);
  return {
    kind: 'meeting',
    id: `meeting:${presented.meetingId || presented.title}`,
    goalKey,
    name: presented.title,
    note: '',
    format: 'mote',
    formatLabel: formatActionFormatLabel('mote'),
    dueAt: presented.startedAt,
    doneAt: '',
    at: presented.startedAt || presented.when,
    meeting: presented,
  };
}

function noteRow(note = {}, goalKey = '', prefix = 'note') {
  return {
    kind: 'note',
    id: `${prefix}:${note.id || note.at}`,
    goalKey,
    name: goalKey === 'iteration' ? 'Iterasjonsnotat' : 'Workshop-notat',
    note: sanitizeText(note.text),
    format: '',
    formatLabel: '',
    dueAt: sanitizeText(note.at),
    doneAt: sanitizeText(note.doneAt),
    at: sanitizeText(note.at),
    meeting: null,
  };
}

export function activityLogSectionLabel(key = '') {
  if (EXTRA_SECTION_LABELS[key]) return EXTRA_SECTION_LABELS[key];
  return formatGoalLabel(key) || key;
}

function sortRows(rows = []) {
  return [...rows].sort((a, b) => {
    const aMs = parseMs(a.at) ?? 0;
    const bMs = parseMs(b.at) ?? 0;
    if (aMs !== bMs) return aMs - bMs;
    return sanitizeText(a.name).localeCompare(sanitizeText(b.name), 'nb');
  });
}

export function buildClientActivityLog(client = {}) {
  const actions = decorateNextActions(client).filter((action) => sanitizeText(action.presetKey) !== 'sendOffer');
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const usedMeetingIds = new Set();
  const rowsByGoal = new Map();

  function addRow(row) {
    const key = row.goalKey || 'meetingHeld';
    if (!rowsByGoal.has(key)) rowsByGoal.set(key, []);
    rowsByGoal.get(key).push(row);
  }

  for (const action of actions) {
    const meeting = pickMeetingForAction(meetings, action, usedMeetingIds);
    if (meeting?.meetingId) usedMeetingIds.add(sanitizeText(meeting.meetingId));
    addRow(actionRow(action, meeting));
  }

  for (const meeting of meetings) {
    const id = sanitizeText(meeting.meetingId);
    if (id && usedMeetingIds.has(id)) continue;
    if (isSupersededLiveStub(meeting, meetings)) continue;
    if (id) usedMeetingIds.add(id);
    addRow(meetingRow(meeting, goalKeyForUnattachedMeeting(client, meeting, actions)));
  }

  const workshop = getWorkshopAction(client);
  const workshopRecord = getWorkshopRecord(client);
  if (workshop && (parseMs(workshop.dueAt) != null || sanitizeText(workshop.firefliesMeetingId))) {
    const meeting = meetings.find((row) => (
      sanitizeText(row.meetingId) === sanitizeText(workshop.firefliesMeetingId)
      || meetingMatchesAction(row, { ...workshop, format: 'mote', presetKey: 'custom' })
    )) || null;
    if (meeting?.meetingId) usedMeetingIds.add(sanitizeText(meeting.meetingId));
    addRow(actionRow({
      id: 'workshop-action',
      goalKey: 'workshop',
      name: sanitizeText(workshop.name) || 'Workshop',
      note: sanitizeText(workshop.note),
      format: workshop.format || 'mote',
      dueAt: workshop.dueAt,
      doneAt: '',
      createdAt: workshop.dueAt,
    }, meeting));
  }
  for (const note of workshopRecord.notes || []) {
    addRow(noteRow(note, 'workshop', 'workshop-note'));
  }

  const iteration = workshopRecord.iterationMeeting || {};
  if (parseMs(iteration.dueAt) != null || sanitizeText(iteration.firefliesMeetingId)) {
    const meeting = meetings.find((row) => (
      sanitizeText(row.meetingId) === sanitizeText(iteration.firefliesMeetingId)
      || meetingMatchesAction(row, { ...iteration, format: 'mote', presetKey: 'custom' })
    )) || null;
    if (meeting?.meetingId) usedMeetingIds.add(sanitizeText(meeting.meetingId));
    addRow(actionRow({
      id: 'iteration-meeting',
      goalKey: 'iteration',
      name: 'Iterasjonsmøte',
      note: '',
      format: iteration.format || 'mote',
      dueAt: iteration.dueAt,
      doneAt: '',
      createdAt: iteration.dueAt,
    }, meeting));
  }
  for (const entry of workshopRecord.iterationLog || []) {
    addRow(noteRow(entry, 'iteration', 'iteration-note'));
  }

  const salesKeys = getSalesGoalKeys(client.product);
  const keys = [
    ...salesKeys,
    ...(clientIsSalesWin(client) || rowsByGoal.has(AFTER_SALE_GOAL) ? [AFTER_SALE_GOAL] : []),
    ...(rowsByGoal.has('workshop') ? ['workshop'] : []),
    ...(rowsByGoal.has('iteration') ? ['iteration'] : []),
  ];
  const seen = new Set();
  const sections = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = sortRows(rowsByGoal.get(key) || []);
    if (!rows.length) continue;
    sections.push({
      key,
      label: activityLogSectionLabel(key),
      rows,
    });
  }
  return {
    sections,
    actionCount: actions.length,
    meetingCount: meetings.length,
  };
}

export function attachFirefliesToMatchingAction(actions = [], record = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const meetingId = sanitizeText(record.meetingId);
  if (!meetingId) return { actions: list, actionId: '' };
  const already = list.find((action) => sanitizeText(action.firefliesMeetingId) === meetingId);
  if (already) return { actions: list, actionId: already.id };
  const scored = list
    .filter((action) => (
      sanitizeText(action.presetKey) === 'meeting'
      || sanitizeText(action.format) === 'mote'
    ))
    .map((action) => {
      if (!meetingMatchesAction(record, action)) return null;
      const start = meetingStartMs(record);
      const due = parseMs(action.dueAt);
      return { action, diff: start != null && due != null ? Math.abs(start - due) : Number.MAX_SAFE_INTEGER };
    })
    .filter(Boolean)
    .sort((a, b) => a.diff - b.diff);
  const match = scored[0]?.action;
  if (!match) return { actions: list, actionId: '' };
  return {
    actionId: match.id,
    actions: list.map((action) => (
      action.id === match.id
        ? {
            ...action,
            firefliesMeetingId: meetingId,
            meetLink: sanitizeText(action.meetLink) || sanitizeText(record.meetLink || record.meetingLink),
          }
        : action
    )),
  };
}
