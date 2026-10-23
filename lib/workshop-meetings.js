/**
 * Tag Fireflies compact refs with purpose sales | workshop | iteration and the booked slot they belong to
 * (lib/fireflies-slots.js: the recording's Meet room decides, time only breaks ties in a shared room).
 * Hover uses that meeting's disk video, never meetings[0] and never expiring URLs.
 */

import { meetingHasStoredVideo } from './fireflies-media.js';
import { placeholderSessionEndMs } from './fireflies-recording-watchdog.js';
import {
  clientMeetingSlots,
  compareTalk,
  duplicateRecordingMap,
  meetingSlotFacts,
  placeholderSupersededBy,
  recordingTalk,
  sameRecordedMeeting,
  slotForPurposePick,
} from './fireflies-slots.js';
import {
  readStoredFirefliesMeeting,
  storedMeetingHasTalk,
  storedMeetingIsPartial,
} from './fireflies-webhook.js';
import { isPlaceholderMeetingId } from './offer-meetings.js';
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

/** sales | workshop | iteration | '' for one recording of this client (lib/fireflies-slots.js meetingSlotFacts). */
export function resolveMeetingPurpose(client = {}, record = {}) {
  return meetingSlotFacts(client, record, { sessionEndMs: placeholderSessionEndMs }).purpose;
}

/** Talk of a client row, read from the stored copy where there is one (sentence count, transcript, length). */
export function storedTalkOf(readStored = readStoredFirefliesMeeting) {
  return (row = {}) => {
    const stored = isPlaceholderMeetingId(row?.meetingId) ? null : readStored(row?.meetingId);
    if (!stored) return recordingTalk(row);
    const storedMinutes = stored.durationMinutes === '' || stored.durationMinutes == null ? null : stored.durationMinutes;
    return recordingTalk({
      ...row,
      sentenceCount: stored.sentenceCount ?? row.sentenceCount,
      transcript: stored.transcript || '',
      summary: stored.summary || row.summary,
      hasTranscript: storedMeetingHasTalk(stored) || Boolean(row.hasTranscript),
      durationMinutes: storedMinutes ?? row.durationMinutes,
    });
  };
}

function realRows(client = {}) {
  return (Array.isArray(client?.meetings) ? client.meetings : [])
    .filter((row) => sanitizeText(row?.meetingId) && !isPlaceholderMeetingId(row.meetingId));
}

/**
 * The recording of one purpose: the slot's id while it is on the card and still of that purpose, else
 * the row of that purpose with the most talk (a copy of a meeting after its primary).
 */
export function meetingIdForPurpose(client = {}, purpose = '', { readStored = readStoredFirefliesMeeting } = {}) {
  const wanted = sanitizeMeetingPurpose(purpose);
  if (!wanted) return '';
  const meetings = realRows(client);
  const slots = clientMeetingSlots(client);
  const purposeOfRow = (row) => meetingSlotFacts(client, row, { slots, sessionEndMs: placeholderSessionEndMs }).purpose;
  const slotId = wanted === 'workshop'
    ? sanitizeText(getWorkshopAction(client)?.firefliesMeetingId)
    : wanted === 'iteration'
      ? sanitizeText(getWorkshopRecord(client).iterationMeeting?.firefliesMeetingId)
      : '';
  // A slot id that is no longer on this client's card (moved, unlinked) is another client's now.
  const slotRow = slotId ? meetings.find((row) => sanitizeText(row.meetingId) === slotId) : null;
  if (slotRow && purposeOfRow(slotRow) === wanted) return slotId;
  const talkOf = storedTalkOf(readStored);
  const duplicates = duplicateRecordingMap(meetings, { talkOf });
  const tagged = meetings
    .filter((row) => purposeOfRow(row) === wanted)
    .sort((a, b) => (
      Number(duplicates.has(sanitizeText(a.meetingId))) - Number(duplicates.has(sanitizeText(b.meetingId)))
      || compareTalk(talkOf(b), talkOf(a))
    ));
  return sanitizeText(tagged[0]?.meetingId);
}

export function hoverStateForPurpose(client = {}, purpose = '') {
  const meetingId = meetingIdForPurpose(client, purpose);
  if (!meetingId) return { meetingId: '', hasVideo: false };
  return { meetingId, hasVideo: meetingHasStoredVideo(meetingId) };
}

/**
 * Should a slot (workshop or iteration, or a Møte action) keep pointing at `currentId` instead of
 * `candidate`? It does when a person picked the current one, when the candidate is an empty copy and the
 * current one has talk, and when both are one meeting and the candidate has no more talk (a fragment from
 * a rejoin). A current one that is gone from the card, or now of another purpose, gives way; a later
 * meeting of the same purpose takes the slot, as before.
 */
export function slotKeepsMeeting(client = {}, currentId = '', candidate = {}, { talkOf = storedTalkOf() } = {}) {
  const id = sanitizeText(currentId);
  if (!id || id === sanitizeText(candidate?.meetingId)) return false;
  const current = realRows(client).find((row) => sanitizeText(row.meetingId) === id);
  if (!current) return false;
  const wanted = sanitizeText(candidate?.purpose);
  const currentPurpose = meetingSlotFacts(client, current, { sessionEndMs: placeholderSessionEndMs }).purpose;
  if (wanted && currentPurpose && wanted !== currentPurpose) return false;
  if (sanitizeText(current.purposePickedAt) && !sanitizeText(candidate?.purposePickedAt)) return true;
  const currentTalk = talkOf(current);
  const candidateTalk = talkOf(candidate);
  if (!candidateTalk.sentences && currentTalk.sentences) return true;
  if (sameRecordedMeeting(current, candidate)) return compareTalk(candidateTalk, currentTalk) <= 0;
  return false;
}

/**
 * Tag one compact ref before it is linked: purpose, slotKey and forSalesMeeting (meetingSlotFacts, with
 * the row the card already has as `existing`, so a person's pick and the slot it was linked with stay),
 * plus the workshop / iteration slot ids to write. A slot keeps a recording with more talk.
 */
export function applyFirefliesPurpose(client = {}, ref = {}, { existing = null, talkOf = storedTalkOf() } = {}) {
  const base = existing && typeof existing === 'object' ? existing : null;
  const row = {
    ...ref,
    purpose: sanitizeText(base?.purpose) || sanitizeText(ref.purpose),
    forSalesMeeting: base ? Boolean(base.forSalesMeeting) : Boolean(ref.forSalesMeeting),
    slotKey: sanitizeText(base?.slotKey) || sanitizeText(ref.slotKey),
    purposePickedBy: sanitizeText(base?.purposePickedBy || ref.purposePickedBy),
    purposePickedAt: sanitizeText(base?.purposePickedAt || ref.purposePickedAt),
  };
  const facts = meetingSlotFacts(client, row, { sessionEndMs: placeholderSessionEndMs });
  const tagged = {
    ...row,
    purpose: facts.purpose,
    slotKey: facts.slotKey,
    forSalesMeeting: facts.forSalesMeeting,
  };
  const result = {
    ref: tagged,
    workshopAction: null,
    workshop: null,
  };
  const meetingId = sanitizeText(tagged.meetingId);
  if (facts.purpose === 'workshop') {
    const action = getWorkshopAction(client);
    if (action && !slotKeepsMeeting(client, action.firefliesMeetingId, tagged, { talkOf })) {
      result.workshopAction = { ...action, firefliesMeetingId: meetingId };
    }
  }
  if (facts.purpose === 'iteration') {
    const record = getWorkshopRecord(client);
    if (!slotKeepsMeeting(client, record.iterationMeeting?.firefliesMeetingId, tagged, { talkOf })) {
      result.workshop = {
        ...record,
        iterationMeeting: {
          ...record.iterationMeeting,
          firefliesMeetingId: meetingId,
        },
      };
    }
  }
  return result;
}

/**
 * Does the offer lock (lockedOfferMeetingId, set once "Møtet hatt" is ticked) need pointing again? Yes
 * when it is empty, a live-join placeholder, gone from the card, or a copy of a meeting another
 * recording on the card has more talk for.
 */
export function offerLockIsStale(client = {}, { talkOf = storedTalkOf() } = {}) {
  const lock = sanitizeText(client?.lockedOfferMeetingId);
  if (!lock || isPlaceholderMeetingId(lock)) return true;
  const rows = realRows(client);
  const locked = rows.find((row) => sanitizeText(row.meetingId) === lock);
  if (!locked) return true;
  return rows.some((row) => (
    sanitizeText(row.meetingId) !== lock
    && sameRecordedMeeting(row, locked)
    && compareTalk(talkOf(row), talkOf(locked)) > 0
  ));
}

/**
 * The row patch for a person's purpose pick. A purpose puts the recording on the slot of that purpose
 * (lib/fireflies-slots.js slotForPurposePick: its room, else the nearest in time), so it covers that
 * slot's placeholder; '' clears the pick and takes the automatic purpose and slot again.
 */
export function purposePickPatch(client = {}, row = {}, purpose = '', { by = '', nowMs = Date.now() } = {}) {
  const wanted = sanitizeMeetingPurpose(purpose);
  if (wanted) {
    const slot = slotForPurposePick(client, row, wanted);
    return {
      purpose: wanted,
      forSalesMeeting: wanted === 'sales',
      slotKey: sanitizeText(slot?.slotKey),
      purposePickedBy: sanitizeText(by),
      purposePickedAt: new Date(nowMs).toISOString(),
    };
  }
  const facts = meetingSlotFacts(client, {
    ...row,
    purpose: '',
    forSalesMeeting: false,
    slotKey: '',
    purposePickedBy: '',
    purposePickedAt: '',
  }, { sessionEndMs: placeholderSessionEndMs });
  return {
    purpose: facts.purpose,
    forSalesMeeting: facts.forSalesMeeting,
    slotKey: facts.slotKey,
    purposePickedBy: '',
    purposePickedAt: '',
  };
}

/** A recording that can stand in for a placeholder: talk on disk that is not live captions. */
function storedCountsAsTalk(row = {}, stored = null) {
  if (isPlaceholderMeetingId(row?.meetingId)) return false;
  const talk = stored ? storedMeetingHasTalk(stored) : Boolean(row?.hasTranscript);
  return talk && !storedMeetingIsPartial(stored);
}

function slotFactsOf(row = {}) {
  return { slotKey: sanitizeText(row.slotKey), by: sanitizeText(row.purposePickedAt) ? 'person' : '' };
}

/**
 * The card's rows as the hub sees them now: each with its purpose, slotKey and forSalesMeeting
 * (meetingSlotFacts), placeholder, hasTranscript, partial (live captions), sentenceCount and duplicateOf
 * (the primary of the same meeting, or ''). `superseded` lists the placeholders a recording with talk
 * covers (placeholderSupersededBy).
 */
export function clientMeetingRowsView(client = {}, { storedOf = readStoredFirefliesMeeting } = {}) {
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const slots = clientMeetingSlots(client);
  const rows = meetings.map((ref) => {
    const placeholder = isPlaceholderMeetingId(ref?.meetingId);
    const stored = placeholder ? null : storedOf(ref?.meetingId);
    const facts = meetingSlotFacts(client, ref, { slots, sessionEndMs: placeholderSessionEndMs });
    const counted = stored?.sentenceCount;
    return {
      row: {
        ...ref,
        purpose: facts.purpose,
        slotKey: facts.slotKey,
        forSalesMeeting: facts.forSalesMeeting,
        placeholder,
        hasTranscript: !placeholder && (Boolean(ref?.hasTranscript) || storedMeetingHasTalk(stored)),
        partial: storedMeetingIsPartial(stored),
        sentenceCount: counted === '' || counted == null || !Number.isFinite(Number(counted))
          ? (ref?.sentenceCount ?? '')
          : Number(counted),
      },
      stored,
    };
  });
  const talkOf = storedTalkOf((id) => rows.find((entry) => sanitizeText(entry.row.meetingId) === sanitizeText(id))?.stored || null);
  const duplicates = duplicateRecordingMap(rows.map((entry) => entry.row), { talkOf });
  for (const entry of rows) entry.row.duplicateOf = duplicates.get(sanitizeText(entry.row.meetingId)) || '';
  const list = rows.map((entry) => entry.row);
  const storedById = new Map(rows.map((entry) => [sanitizeText(entry.row.meetingId), entry.stored]));
  const superseded = new Set();
  for (const row of list) {
    if (!row.placeholder) continue;
    const by = placeholderSupersededBy(row, list, {
      factsOf: slotFactsOf,
      countsAsTalk: (candidate) => storedCountsAsTalk(candidate, storedById.get(sanitizeText(candidate.meetingId)) || null),
      sessionEndMs: placeholderSessionEndMs,
    });
    if (by) superseded.add(sanitizeText(row.meetingId));
  }
  return { rows: list, superseded };
}

/**
 * What a card should store for its rows now: { patches: [{ meetingId, patch }], drop: [placeholder ids] }.
 * Rows linked before these rules get the purpose, slot and sentence count the rules give (a person's
 * pick is never touched); placeholders a recording with talk now covers are listed to drop.
 */
export function planClientMeetingSync(client = {}, { readStored = readStoredFirefliesMeeting } = {}) {
  const view = clientMeetingRowsView(client, { storedOf: readStored });
  const byId = new Map((Array.isArray(client?.meetings) ? client.meetings : []).map((row) => [sanitizeText(row?.meetingId), row]));
  const patches = [];
  for (const row of view.rows) {
    if (row.placeholder) continue;
    const id = sanitizeText(row.meetingId);
    const before = byId.get(id) || {};
    const patch = {};
    if (!sanitizeText(before.purposePickedAt)) {
      if (row.purpose !== sanitizeText(before.purpose)) patch.purpose = row.purpose;
      if (row.slotKey !== sanitizeText(before.slotKey)) patch.slotKey = row.slotKey;
      if (row.forSalesMeeting !== Boolean(before.forSalesMeeting)) patch.forSalesMeeting = row.forSalesMeeting;
    }
    if (row.sentenceCount !== '' && Number(row.sentenceCount) !== Number(before.sentenceCount ?? NaN)) {
      patch.sentenceCount = Number(row.sentenceCount);
    }
    if (Object.keys(patch).length) patches.push({ meetingId: id, patch });
  }
  return { patches, drop: [...view.superseded] };
}

/**
 * The card's Fireflies rows: purpose, slotKey, placeholder, duplicateOf and the stored transcript flags
 * (clientMeetingRowsView). Placeholders get no Fireflies link, and one is hidden once a recording with
 * talk covers its slot; one whose recording never came stays (the watchdog marks it missing).
 * `media: false` skips the disk check for a video.
 */
export function presentClientMeetings(client = {}, storedMap = null, { media = true } = {}) {
  const map = storedMap && typeof storedMap === 'object' ? storedMap : null;
  const storedOf = (id) => {
    const key = sanitizeText(id);
    if (!key || isPlaceholderMeetingId(key)) return null;
    if (map) return map[key] && typeof map[key] === 'object' ? map[key] : null;
    return readStoredFirefliesMeeting(key);
  };
  const view = clientMeetingRowsView(client, { storedOf });
  return view.rows
    .filter((row) => !view.superseded.has(sanitizeText(row.meetingId)))
    .map((row) => {
      const stored = storedOf(row.meetingId);
      const rest = { ...row };
      delete rest.videoDownloadUrl;
      return {
        ...rest,
        transcriptUrl: row.placeholder ? '' : (sanitizeText(rest.transcriptUrl) || sanitizeText(stored?.transcriptUrl)),
        hasVideo: !row.placeholder && media ? meetingHasStoredVideo(row.meetingId) : false,
      };
    });
}

export function bookedSlotTimesForMatch(client = {}) {
  return bookedMeetingSlots(client)
    .map((slot) => parseMs(slot.dueAt))
    .filter((ms) => ms != null);
}
