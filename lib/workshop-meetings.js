/**
 * Tag Fireflies compact refs with purpose sales | workshop | iteration.
 * Hover uses that meeting's disk video, never meetings[0] and never expiring URLs.
 */

import { meetingHasStoredVideo } from './fireflies-media.js';
import { recordingMatchesSalesMeeting } from './fireflies-client-match.js';
import { getWorkshopAction } from './workshop-action.js';
import { getWorkshopRecord, sanitizeMeetingPurpose } from './workshop-record.js';

export const MEETING_PURPOSE_WINDOW_MS = 3 * 60 * 60 * 1000;

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function parseMs(value = '') {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function recordStartMs(record = {}) {
  return parseMs(record.startedAt || record.when || record.dateString || record.meetingAt);
}

export function bookedMeetingSlots(client = {}) {
  const workshop = getWorkshopAction(client);
  const iteration = getWorkshopRecord(client).iterationMeeting;
  const extras = (Array.isArray(client?.nextActions) ? client.nextActions : [])
    .filter((action) => (
      sanitizeText(action?.presetKey) !== 'meeting'
      && sanitizeText(action?.format) === 'mote'
      && Boolean(action?.addToCalendar)
      && (parseMs(action?.dueAt) != null || sanitizeText(action?.firefliesMeetingId) || sanitizeText(action?.meetLink))
    ))
    .map((action) => ({
      purpose: sanitizeText(action.goalKey) === 'meetingHeld' ? 'sales' : '',
      dueAt: sanitizeText(action.dueAt),
      meetingId: sanitizeText(action.firefliesMeetingId),
      actionId: sanitizeText(action.id),
      meetLink: sanitizeText(action.meetLink),
    }));
  return [
    {
      purpose: 'sales',
      dueAt: client?.agreedTime ? sanitizeText(client.meetingAt) : '',
      meetingId: '',
    },
    ...extras,
    {
      purpose: 'workshop',
      dueAt: sanitizeText(workshop?.dueAt),
      meetingId: sanitizeText(workshop?.firefliesMeetingId),
    },
    {
      purpose: 'iteration',
      dueAt: sanitizeText(iteration?.dueAt),
      meetingId: sanitizeText(iteration?.firefliesMeetingId),
    },
  ].filter((slot) => parseMs(slot.dueAt) != null || slot.meetingId || sanitizeText(slot.meetLink));
}

export function resolveMeetingPurpose(client = {}, record = {}) {
  const tagged = sanitizeMeetingPurpose(record.purpose);
  if (tagged) return tagged;
  const start = recordStartMs(record);
  const slots = bookedMeetingSlots(client)
    .map((slot) => {
      const due = parseMs(slot.dueAt);
      if (start == null || due == null) return null;
      const diff = Math.abs(start - due);
      if (diff > MEETING_PURPOSE_WINDOW_MS) return null;
      return { ...slot, diff };
    })
    .filter(Boolean)
    .sort((a, b) => a.diff - b.diff);
  if (slots[0]) return slots[0].purpose;
  if (recordingMatchesSalesMeeting(client, record)) return 'sales';
  return '';
}

export function meetingIdForPurpose(client = {}, purpose = '') {
  const wanted = sanitizeMeetingPurpose(purpose);
  if (!wanted) return '';
  const slots = bookedMeetingSlots(client);
  const slot = slots.find((row) => row.purpose === wanted);
  if (slot?.meetingId) return slot.meetingId;
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const tagged = meetings.find((row) => sanitizeMeetingPurpose(row.purpose) === wanted);
  if (tagged?.meetingId) return sanitizeText(tagged.meetingId);
  if (wanted === 'sales') {
    const sales = meetings.find((row) => row.forSalesMeeting || recordingMatchesSalesMeeting(client, row));
    return sanitizeText(sales?.meetingId);
  }
  return '';
}

export function hoverStateForPurpose(client = {}, purpose = '') {
  const meetingId = meetingIdForPurpose(client, purpose);
  if (!meetingId) return { meetingId: '', hasVideo: false };
  return { meetingId, hasVideo: meetingHasStoredVideo(meetingId) };
}

export function applyFirefliesPurpose(client = {}, ref = {}) {
  const purpose = resolveMeetingPurpose(client, ref) || (ref.forSalesMeeting ? 'sales' : '');
  const tagged = {
    ...ref,
    purpose,
    forSalesMeeting: purpose === 'sales' || Boolean(ref.forSalesMeeting),
  };
  const result = {
    ref: tagged,
    workshopAction: null,
    workshop: null,
  };
  if (purpose === 'workshop') {
    const action = getWorkshopAction(client);
    if (action) {
      result.workshopAction = { ...action, firefliesMeetingId: sanitizeText(tagged.meetingId) };
    }
  }
  if (purpose === 'iteration') {
    const record = getWorkshopRecord(client);
    result.workshop = {
      ...record,
      iterationMeeting: {
        ...record.iterationMeeting,
        firefliesMeetingId: sanitizeText(tagged.meetingId),
      },
    };
  }
  return result;
}

export function presentClientMeetings(client = {}) {
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  return meetings.map((ref) => {
    const purpose = resolveMeetingPurpose(client, ref);
    const rest = { ...ref };
    delete rest.videoDownloadUrl;
    return {
      ...rest,
      purpose,
      hasVideo: meetingHasStoredVideo(ref.meetingId),
    };
  });
}

export function bookedSlotTimesForMatch(client = {}) {
  return bookedMeetingSlots(client)
    .map((slot) => parseMs(slot.dueAt))
    .filter((ms) => ms != null);
}
