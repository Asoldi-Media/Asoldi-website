/**
 * Tag Fireflies compact refs with purpose sales | workshop | iteration and the booked slot they belong to
 * (lib/fireflies-slots.js: the recording's Meet room decides, time only breaks ties in a shared room).
 * Hover uses that meeting's disk video, never meetings[0] and never expiring URLs.
 */

import { coveredPlaceholderIds, storedTalkOf } from './fireflies-cover.js';
import { meetingHasStoredVideo } from './fireflies-media.js';
import { PENDING_GRACE_MS, placeholderSessionEndMs, recordingDeadlineMs } from './fireflies-recording-watchdog.js';
import {
  clientMeetingSlots,
  compareTalk,
  duplicateRecordingMap,
  meetingSlotFacts,
  sameRecordedMeeting,
  slotForPurposePick,
  talkCoversPlaceholder,
} from './fireflies-slots.js';
import {
  readStoredFirefliesMeeting,
  storedMeetingHasTalk,
  storedMeetingIsEmptyFinal,
  storedMeetingIsFinal,
  storedMeetingIsPartial,
} from './fireflies-webhook.js';
import { isPlaceholderMeetingId } from './offer-meetings.js';
import { getWorkshopAction } from './workshop-action.js';
import { getWorkshopRecord, sanitizeMeetingPurpose } from './workshop-record.js';

export const MEETING_PURPOSE_WINDOW_MS = 3 * 60 * 60 * 1000;
/** A recording Fireflies has not finished stops counting as "on its way" after this. */
export const PENDING_TRANSCRIPT_MS = 7 * 24 * 60 * 60 * 1000;
const NOT_COMING_RECORDING_STATES = new Set(['missing', 'empty', 'declined', 'not-admitted']);

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

/**
 * Is this meeting's transcript still on its way? Never true forever:
 *   - one with text (transcript, summary or the flag) is here;
 *   - a placeholder waits until its recording state says otherwise (missing, empty, declined, not
 *     admitted), and never past the watchdog's deadline plus its pending grace;
 *   - a real recording waits while Fireflies has not finished it (`stored`: its archive copy), and
 *     never once it is final, given up or a week old.
 */
export function meetingTranscriptPending(meeting = {}, { stored = null, nowMs = Date.now() } = {}) {
  if (sanitizeText(meeting.transcript) || sanitizeText(meeting.summary) || meeting.hasTranscript) return false;
  const linked = Date.parse(meeting.linkedAt || meeting.liveJoinedAt || meeting.startedAt || '');
  const linkedRecently = !Number.isFinite(linked) || nowMs - linked < PENDING_TRANSCRIPT_MS;
  if (isPlaceholderMeetingId(meeting.meetingId)) {
    if (NOT_COMING_RECORDING_STATES.has(sanitizeText(meeting.recording?.state))) return false;
    const deadline = recordingDeadlineMs(meeting);
    return Number.isFinite(deadline) ? nowMs < deadline + PENDING_GRACE_MS : linkedRecently;
  }
  if (stored) {
    if (storedMeetingIsFinal(stored, { nowMs }) || sanitizeText(stored.fetch?.gaveUpAt)) return false;
    const seen = Date.parse(stored.firstSeenAt || stored.startedAt || '');
    return !Number.isFinite(seen) || nowMs - seen < PENDING_TRANSCRIPT_MS;
  }
  return linkedRecently;
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

/** Sentences in a stored copy: Fireflies' count, else the transcript's lines; '' when it has neither. */
function storedSentenceCount(stored = null) {
  const counted = stored?.sentenceCount;
  if (counted !== '' && counted != null && Number.isFinite(Number(counted))) return Math.max(0, Number(counted));
  const lines = sanitizeText(stored?.transcript).split('\n').filter((line) => line.trim()).length;
  return lines || '';
}

// Talk of a client row read from its stored copy; it lives with the "covered" rule it feeds.
export { storedTalkOf };

function realRows(client = {}) {
  return (Array.isArray(client?.meetings) ? client.meetings : [])
    .filter((row) => sanitizeText(row?.meetingId) && !isPlaceholderMeetingId(row.meetingId));
}

/** The card's real rows with their purpose and slot as the rules give them now. */
function taggedRealRows(client = {}, slots = clientMeetingSlots(client)) {
  return realRows(client).map((row) => {
    const facts = meetingSlotFacts(client, row, { slots, sessionEndMs: placeholderSessionEndMs });
    return { ...row, purpose: facts.purpose, slotKey: facts.slotKey, forSalesMeeting: facts.forSalesMeeting };
  });
}

/**
 * The recording of one purpose: the slot's id while it is on the card, still of that purpose and not a
 * shorter copy of another recording (a fragment from a rejoin), else the row of that purpose with the
 * most talk (a copy of a meeting after its primary).
 */
export function meetingIdForPurpose(client = {}, purpose = '', { readStored = readStoredFirefliesMeeting } = {}) {
  const wanted = sanitizeMeetingPurpose(purpose);
  if (!wanted) return '';
  const meetings = taggedRealRows(client);
  const talkOf = storedTalkOf(readStored);
  const duplicates = duplicateRecordingMap(meetings, { talkOf });
  const slotId = wanted === 'workshop'
    ? sanitizeText(getWorkshopAction(client)?.firefliesMeetingId)
    : wanted === 'iteration'
      ? sanitizeText(getWorkshopRecord(client).iterationMeeting?.firefliesMeetingId)
      : '';
  // A slot id that is no longer on this client's card (moved, unlinked) is another client's now.
  const slotRow = slotId ? meetings.find((row) => sanitizeText(row.meetingId) === slotId) : null;
  if (slotRow && slotRow.purpose === wanted && !duplicates.has(slotId)) return slotId;
  const tagged = meetings
    .filter((row) => row.purpose === wanted)
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
 * when it is empty, a live-join placeholder, gone from the card, a recording with no talk (a silent
 * fragment from before the client came), a copy of a meeting another recording on the card has more
 * talk for, or a fragment of a few sentences (a "hallo?") while a sales recording with real talk is on
 * the card (lib/fireflies-slots.js talkCoversPlaceholder).
 */
export function offerLockIsStale(client = {}, { talkOf = storedTalkOf() } = {}) {
  const lock = sanitizeText(client?.lockedOfferMeetingId);
  if (!lock || isPlaceholderMeetingId(lock)) return true;
  const rows = realRows(client);
  const locked = rows.find((row) => sanitizeText(row.meetingId) === lock);
  if (!locked) return true;
  const lockedTalk = talkOf(locked);
  if (!(Number(lockedTalk?.sentences) > 0)) return true;
  const fragment = !talkCoversPlaceholder(lockedTalk);
  const salesRow = (row) => row.purpose === 'sales' || row.forSalesMeeting
    || (Boolean(sanitizeText(locked.slotKey)) && sanitizeText(row.slotKey) === sanitizeText(locked.slotKey));
  return rows.some((row) => (
    sanitizeText(row.meetingId) !== lock
    && compareTalk(talkOf(row), lockedTalk) > 0
    && (sameRecordedMeeting(row, locked) || (fragment && salesRow(row) && talkCoversPlaceholder(talkOf(row))))
  ));
}

/**
 * The row patch for a person's purpose pick. A purpose puts the recording on the booked slot of that
 * purpose the same day (lib/fireflies-slots.js slotForPurposePick: its room, else the nearest in time),
 * so it covers that slot's placeholder; a recording days from any such slot gets the purpose and no slot.
 * '' clears the pick and takes the automatic purpose and slot again.
 */
export function purposePickPatch(client = {}, row = {}, purpose = '', { by = '', nowMs = Date.now() } = {}) {
  const wanted = sanitizeMeetingPurpose(purpose);
  if (wanted) {
    const slot = slotForPurposePick(client, row, wanted, { sessionEndMs: placeholderSessionEndMs });
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

/**
 * The card's rows as the hub sees them now: each with its purpose, slotKey and forSalesMeeting
 * (meetingSlotFacts), placeholder, hasTranscript, partial (live captions), emptyFinal (Fireflies has
 * finished it and nothing was said), pendingTranscript (still on its way: meetingTranscriptPending),
 * sentenceCount (the stored copy's, so the browser ranks copies as the server does) and duplicateOf (the
 * primary of the same meeting, or ''). `superseded` lists the placeholders a recording covers
 * (lib/fireflies-cover.js, the rule capture and the watchdog use too).
 */
export function clientMeetingRowsView(client = {}, { storedOf = readStoredFirefliesMeeting, nowMs = Date.now() } = {}) {
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  const slots = clientMeetingSlots(client);
  const rows = meetings.map((ref) => {
    const placeholder = isPlaceholderMeetingId(ref?.meetingId);
    const stored = placeholder ? null : storedOf(ref?.meetingId);
    const facts = meetingSlotFacts(client, ref, { slots, sessionEndMs: placeholderSessionEndMs });
    const counted = storedSentenceCount(stored);
    const hasTranscript = !placeholder && (Boolean(ref?.hasTranscript) || storedMeetingHasTalk(stored));
    return {
      row: {
        ...ref,
        purpose: facts.purpose,
        slotKey: facts.slotKey,
        forSalesMeeting: facts.forSalesMeeting,
        placeholder,
        hasTranscript,
        partial: storedMeetingIsPartial(stored),
        emptyFinal: Boolean(stored) && storedMeetingIsEmptyFinal(stored, { nowMs }),
        pendingTranscript: meetingTranscriptPending({ ...ref, hasTranscript }, { stored, nowMs }),
        sentenceCount: counted === '' ? (ref?.sentenceCount ?? '') : counted,
      },
      stored,
    };
  });
  const storedById = new Map(rows.map((entry) => [sanitizeText(entry.row.meetingId), entry.stored]));
  const talkOf = storedTalkOf((id) => storedById.get(sanitizeText(id)) || null);
  const duplicates = duplicateRecordingMap(rows.map((entry) => entry.row), { talkOf });
  for (const entry of rows) entry.row.duplicateOf = duplicates.get(sanitizeText(entry.row.meetingId)) || '';
  const list = rows.map((entry) => entry.row);
  const superseded = coveredPlaceholderIds(list, {
    storedOf: (id) => storedById.get(sanitizeText(id)) || null,
    sessionEndMs: placeholderSessionEndMs,
  });
  return { rows: list, superseded };
}

/** The primary of a duplicate slot id when it has the slot's purpose, else ''. */
function slotPrimary(view, slotId = '', purpose = '') {
  const id = sanitizeText(slotId);
  const row = id ? view.rows.find((entry) => sanitizeText(entry.meetingId) === id) : null;
  const primaryId = sanitizeText(row?.duplicateOf);
  if (!primaryId) return '';
  const primary = view.rows.find((entry) => sanitizeText(entry.meetingId) === primaryId);
  return primary && (!purpose || primary.purpose === purpose) ? primaryId : '';
}

/**
 * What a card should store for its rows now: { patches: [{ meetingId, patch }], drop: [placeholder ids],
 * slots: { workshopMeetingId?, iterationMeetingId?, actions? } }.
 * Rows linked before these rules get the purpose, slot and sentence count the rules give (a person's
 * pick is never touched); placeholders a recording with talk now covers are listed to drop; a workshop,
 * iteration or Møte action slot that names a shorter copy of a meeting moves to the copy with the most talk.
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
    // '' (not counted) is not 0: Number('') would make a silent copy's 0 look stored already.
    const beforeCount = before.sentenceCount === '' || before.sentenceCount == null ? null : Number(before.sentenceCount);
    if (row.sentenceCount !== '' && Number(row.sentenceCount) !== beforeCount) {
      patch.sentenceCount = Number(row.sentenceCount);
    }
    if (Object.keys(patch).length) patches.push({ meetingId: id, patch });
  }
  const slots = {};
  const workshopId = slotPrimary(view, getWorkshopAction(client)?.firefliesMeetingId, 'workshop');
  if (workshopId) slots.workshopMeetingId = workshopId;
  const iterationId = slotPrimary(view, getWorkshopRecord(client).iterationMeeting?.firefliesMeetingId, 'iteration');
  if (iterationId) slots.iterationMeetingId = iterationId;
  const held = new Set((Array.isArray(client?.nextActions) ? client.nextActions : [])
    .map((action) => sanitizeText(action?.firefliesMeetingId)).filter(Boolean));
  const actions = [];
  for (const action of Array.isArray(client?.nextActions) ? client.nextActions : []) {
    const primaryId = slotPrimary(view, action?.firefliesMeetingId);
    if (!primaryId || held.has(primaryId)) continue;
    held.add(primaryId);
    actions.push({ actionId: sanitizeText(action.id), meetingId: primaryId });
  }
  if (actions.length) slots.actions = actions;
  return { patches, drop: [...view.superseded], slots };
}

/**
 * The card's Fireflies rows: purpose, slotKey, placeholder, duplicateOf, emptyFinal, pendingTranscript and
 * the stored transcript flags (clientMeetingRowsView). Placeholders get no Fireflies link, and one is
 * hidden once a recording with talk covers its slot; one whose recording never came stays (the watchdog
 * marks it missing). `media: false` skips the disk check for a video.
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
