/**
 * Chronological client log: sales actions + Fireflies recordings, grouped by goal.
 * Does not write Kundedata or invent history that was already purged. A live-join placeholder shows its
 * recording state and no Fireflies link, until a recording with talk covers its slot (lib/fireflies-slots.js);
 * a shorter copy of a recorded meeting is not logged twice.
 */

import {
  clientMeetingSlots,
  duplicateRecordingIds,
  meetingSlotFacts,
  placeholderSlotKey,
  placeholderSupersededBy,
} from './fireflies-slots.js';
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
const MINUTE_MS = 60 * 1000;

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
  return sanitizeText(value).toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/** The recording on app.fireflies.ai; '' for a live-join placeholder, which has none. */
export function firefliesUrlForMeeting(meeting = {}) {
  if (isPlaceholderMeetingId(meeting?.meetingId)) return '';
  const view = sanitizeText(meeting.transcriptUrl || meeting.transcript_url);
  if (/^https:\/\/app\.fireflies\.ai\//i.test(view)) return view;
  const id = sanitizeText(meeting.meetingId);
  return id ? `https://app.fireflies.ai/view/${encodeURIComponent(id)}` : 'https://app.fireflies.ai/';
}

function meetingHasTalk(meeting = {}) {
  return Boolean(meeting.hasTranscript || sanitizeText(meeting.transcript) || sanitizeText(meeting.summary));
}

/**
 * A placeholder a recording with talk on its own slot covers (lib/fireflies-slots.js
 * placeholderSupersededBy). Rows from the card (presentClientMeetings) carry the slot and `partial` for
 * live captions; raw rows get their slot worked out from the client's bookings.
 */
export function isSupersededLiveStub(meeting = {}, meetings = [], client = {}) {
  if (!isPlaceholderMeetingId(meeting?.meetingId)) return false;
  const rows = Array.isArray(meetings) ? meetings : [];
  const slots = clientMeetingSlots({ ...client, meetings: rows });
  return Boolean(placeholderSupersededBy(meeting, rows, {
    factsOf: (row) => meetingSlotFacts({ ...client, meetings: rows }, row, { slots }),
    countsAsTalk: (row) => meetingHasTalk(row) && row?.partial !== true,
  }));
}

/**
 * A recorded Møte's placeholder is that action's booking at the time it carries. A moved Møte keeps its slot
 * key, so the row of the time it was moved from belongs to that earlier meeting, and another action's row to
 * that action, whatever room they share. Other placeholders are matched as before.
 */
function placeholderFitsAction(row = {}, action = {}) {
  if (!isPlaceholderMeetingId(row?.meetingId)) return true;
  const key = placeholderSlotKey(row);
  if (!key.startsWith('action:')) return true;
  if (key !== `action:${sanitizeText(action.id)}`) return false;
  const start = parseMs(row.startedAt || row.when);
  const due = parseMs(action.dueAt);
  return start != null && due != null && Math.abs(start - due) < MINUTE_MS;
}

function pickMeetingForAction(meetings = [], action = {}, usedMeetingIds = new Set(), skip = () => false) {
  const candidates = (Array.isArray(meetings) ? meetings : []).filter((row) => {
    const id = sanitizeText(row.meetingId);
    if (!id || usedMeetingIds.has(id) || skip(row)) return false;
    return placeholderFitsAction(row, action) && meetingMatchesAction(row, action);
  });
  return candidates.find((row) => meetingHasTalk(row) && !isPlaceholderMeetingId(row.meetingId))
    || candidates.find((row) => !isPlaceholderMeetingId(row.meetingId))
    || candidates[0]
    || null;
}

/** The recording of this action: its id, the action's room, or (no room on one side) a Møte within three hours. */
export function meetingMatchesAction(meeting = {}, action = {}) {
  const meetingId = sanitizeText(meeting.meetingId || meeting.firefliesMeetingId);
  if (meetingId && sanitizeText(action.firefliesMeetingId) === meetingId) return true;
  const meetA = normalizeMeetLink(meeting.meetLink || meeting.meetingLink);
  const meetB = normalizeMeetLink(action.meetLink);
  if (meetA && meetB) return meetA === meetB;
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

/**
 * A meeting in the log. A placeholder (the live join's row for a booked meeting) has no Fireflies link
 * (firefliesUrl and url '') and nothing to open: `placeholder` true, with its recordingState and
 * recordingMessage instead. emptyFinal: Fireflies finished the recording and nothing was said.
 */
function presentMeeting(meeting = {}, action = null) {
  const meetingId = sanitizeText(meeting.meetingId);
  const placeholder = isPlaceholderMeetingId(meetingId);
  const recording = placeholder && meeting.recording && typeof meeting.recording === 'object' ? meeting.recording : null;
  const firefliesUrl = firefliesUrlForMeeting(meeting);
  return {
    meetingId,
    title: sanitizeText(meeting.title) || 'Fireflies-møte',
    when: sanitizeText(meeting.when) || '',
    startedAt: sanitizeText(meeting.startedAt),
    firefliesUrl,
    url: firefliesUrl,
    hasTranscript: !placeholder && Boolean(meeting.hasTranscript || sanitizeText(meeting.transcript)),
    hasVideo: !placeholder && Boolean(meeting.hasVideo),
    emptyFinal: !placeholder && meeting.emptyFinal === true,
    purpose: sanitizeText(meeting.purpose),
    slotKey: sanitizeText(meeting.slotKey),
    placeholder,
    recordingState: sanitizeText(recording?.state),
    recordingMessage: sanitizeText(recording?.message),
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

/**
 * The log, grouped by goal. `includeDuplicates`: copies of a meeting are logged too, as meeting rows of their
 * own (the log cover hides them until a rep asks), so one flagged by mistake can still be reached.
 */
export function buildClientActivityLog(client = {}, { includeDuplicates = false } = {}) {
  const actions = decorateNextActions(client).filter((action) => sanitizeText(action.presetKey) !== 'sendOffer');
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const usedMeetingIds = new Set();
  const rowsByGoal = new Map();
  // Copies of one meeting (a rejoin fragment, a second bot): only the one with the most talk is logged.
  // Card rows carry the server's duplicateOf; only raw rows are worked out here.
  const duplicates = duplicateRecordingIds(meetings);
  const skip = (row) => duplicates.has(sanitizeText(row?.meetingId))
    || isSupersededLiveStub(row, meetings, client);
  const skipUnattached = includeDuplicates ? (row) => isSupersededLiveStub(row, meetings, client) : skip;

  function addRow(row) {
    const key = row.goalKey || 'meetingHeld';
    if (!rowsByGoal.has(key)) rowsByGoal.set(key, []);
    rowsByGoal.get(key).push(row);
  }

  for (const action of actions) {
    const meeting = pickMeetingForAction(meetings, action, usedMeetingIds, skip);
    if (meeting?.meetingId) usedMeetingIds.add(sanitizeText(meeting.meetingId));
    addRow(actionRow(action, meeting));
  }

  for (const meeting of meetings) {
    const id = sanitizeText(meeting.meetingId);
    if (id && usedMeetingIds.has(id)) continue;
    if (skipUnattached(meeting)) continue;
    if (id) usedMeetingIds.add(id);
    addRow(meetingRow(meeting, goalKeyForUnattachedMeeting(client, meeting, actions)));
  }

  const workshop = getWorkshopAction(client);
  const workshopRecord = getWorkshopRecord(client);
  if (workshop && (parseMs(workshop.dueAt) != null || sanitizeText(workshop.firefliesMeetingId))) {
    const meeting = meetings.find((row) => !skip(row) && (
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
    const meeting = meetings.find((row) => !skip(row) && (
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
    // Recorded meetings: a placeholder is a booked meeting waiting for one, and a copy is the same meeting.
    meetingCount: meetings.filter((row) => (
      sanitizeText(row?.meetingId)
      && !isPlaceholderMeetingId(row.meetingId)
      && !duplicates.has(sanitizeText(row.meetingId))
    )).length,
  };
}

/**
 * Put a recording on the Møte action it was recorded in: { actions, actionId }.
 *   - `slot` (lib/fireflies-slots.js resolveRecordingSlot) names it: a recorded action's slot is that
 *     action; the workshop's or iteration's slot is no action at all;
 *   - otherwise the nearest Møte within three hours (also in its own room), never one booked in another room;
 *   - an action keeps the recording it has when `keepCurrent(action)` says so (more talk, a person's pick);
 *   - the recording's room goes onto an action without one only with `copyMeetLink` (the room is already
 *     this client's alone), so a pasted room never makes the client own another client's Meet.
 */
export function attachFirefliesToMatchingAction(actions = [], record = {}, {
  slot = null,
  keepCurrent = () => false,
  copyMeetLink = false,
} = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const meetingId = sanitizeText(record.meetingId);
  if (!meetingId) return { actions: list, actionId: '' };
  const already = list.find((action) => sanitizeText(action.firefliesMeetingId) === meetingId);
  if (already) return { actions: list, actionId: already.id };
  const kind = sanitizeText(slot?.kind);
  if (kind === 'workshop' || kind === 'iteration') return { actions: list, actionId: '' };
  let match = null;
  if (kind === 'action') {
    match = list.find((action) => sanitizeText(action.id) === sanitizeText(slot.actionId)) || null;
  } else {
    const scored = list
      .filter((action) => (
        sanitizeText(action.presetKey) === 'meeting'
        || sanitizeText(action.format) === 'mote'
      ))
      .map((action) => {
        if (!meetingMatchesAction(record, action)) return null;
        const start = meetingStartMs(record);
        const due = parseMs(action.dueAt);
        // A booked Møte is one meeting: the same room a day later is another one, not this action's.
        if (start != null && due != null && Math.abs(start - due) > MEETING_PURPOSE_WINDOW_MS) return null;
        return { action, diff: start != null && due != null ? Math.abs(start - due) : Number.MAX_SAFE_INTEGER };
      })
      .filter(Boolean)
      .sort((a, b) => a.diff - b.diff);
    match = scored[0]?.action || null;
  }
  if (!match) return { actions: list, actionId: '' };
  if (sanitizeText(match.firefliesMeetingId) && keepCurrent(match)) return { actions: list, actionId: '' };
  const room = sanitizeText(record.meetLink || record.meetingLink);
  return {
    actionId: match.id,
    actions: list.map((action) => (
      action.id === match.id
        ? {
            ...action,
            firefliesMeetingId: meetingId,
            meetLink: sanitizeText(action.meetLink) || (copyMeetLink ? room : ''),
          }
        : action
    )),
  };
}
