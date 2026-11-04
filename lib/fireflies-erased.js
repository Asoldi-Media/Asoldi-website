// Recordings a personal-data erase removed (lib/personal-data.js), so Fireflies never brings them back:
//   <dataDir>/privacy/erased-meetings.json  { kind, meetings: { <meetingId>: { erasedAt } } }  (ids only)
// The Fireflies store paths (list pages, full fetches, webhooks, media and link writes in
// lib/fireflies-webhook.js, and the hydration plan in lib/fireflies-ingest.js) skip these ids. Until an
// erase writes the file it does not exist, the set is empty and those paths behave as before.
// An entry is dropped ERASED_MEETING_KEEP_MS after the erase: the ingest only lists recent recordings
// (the newest page and a catch-up scan of days), and the Fireflies store itself keeps a record for a
// year after its last change.
import { join } from 'node:path';
import { readJsonCached, updateJsonLocked } from '../data/atomic-json.js';
import { getPersistentDataDir } from '../data/storage-path.js';

export const ERASED_MEETINGS_FILE = 'privacy/erased-meetings.json';
export const ERASED_MEETINGS_KIND = 'asoldi.erased-meetings/1';
export const ERASED_MEETING_KEEP_MS = 400 * 24 * 60 * 60 * 1000;

const EMPTY = Object.freeze(new Set());
let parsedFrom = null;
let parsedIds = EMPTY;

function text(value) {
  return String(value ?? '').trim();
}

function nowDate(now) {
  if (now instanceof Date) return now;
  const parsed = new Date(now ?? Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function erasedMeetingsPath(dataDir) {
  return join(dataDir || getPersistentDataDir(), ...ERASED_MEETINGS_FILE.split('/'));
}

function meetingsOf(doc) {
  return doc && typeof doc === 'object' && doc.meetings && typeof doc.meetings === 'object' && !Array.isArray(doc.meetings)
    ? doc.meetings
    : {};
}

/** The erased meeting ids (an empty set while no erase has happened). Read from a cached parse. */
export function erasedFirefliesMeetingIds({ dataDir } = {}) {
  const doc = readJsonCached(erasedMeetingsPath(dataDir));
  if (!doc) return EMPTY;
  if (doc !== parsedFrom) {
    parsedFrom = doc;
    parsedIds = new Set(Object.keys(meetingsOf(doc)));
  }
  return parsedIds;
}

export function isErasedFirefliesMeeting(meetingId, options = {}) {
  const id = text(meetingId);
  return Boolean(id) && erasedFirefliesMeetingIds(options).has(id);
}

function withoutOld(meetings, at) {
  const out = {};
  for (const [id, row] of Object.entries(meetings)) {
    const erasedAt = Date.parse(text(row?.erasedAt));
    if (Number.isFinite(erasedAt) && at - erasedAt > ERASED_MEETING_KEEP_MS) continue;
    out[id] = { erasedAt: text(row?.erasedAt) };
  }
  return out;
}

/** Records erased meeting ids (and drops entries past their keep time). Returns the ids added. */
export function recordErasedFirefliesMeetings(ids = [], { dataDir, now = new Date() } = {}) {
  const at = nowDate(now);
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(text).filter((id) => id && !id.toLowerCase().startsWith('live:')))];
  if (!wanted.length) return [];
  const added = [];
  updateJsonLocked(erasedMeetingsPath(dataDir), (current) => {
    const meetings = withoutOld(meetingsOf(current), at.getTime());
    for (const id of wanted) {
      if (meetings[id]) continue;
      meetings[id] = { erasedAt: at.toISOString() };
      added.push(id);
    }
    return { kind: ERASED_MEETINGS_KIND, meetings };
  });
  return added;
}

/** Entries past their keep time: reported (dry run) or dropped. Returns { items: [{ meetingId, erasedAt }] }. */
export function purgeErasedFirefliesMeetings({ dryRun = true, dataDir, now = new Date() } = {}) {
  const at = nowDate(now).getTime();
  const doc = readJsonCached(erasedMeetingsPath(dataDir));
  if (!doc) return { items: [] };
  const items = Object.entries(meetingsOf(doc))
    .filter(([, row]) => {
      const erasedAt = Date.parse(text(row?.erasedAt));
      return Number.isFinite(erasedAt) && at - erasedAt > ERASED_MEETING_KEEP_MS;
    })
    .map(([meetingId, row]) => ({ meetingId, erasedAt: text(row?.erasedAt) }));
  if (!dryRun && items.length) {
    updateJsonLocked(erasedMeetingsPath(dataDir), (current) => ({ kind: ERASED_MEETINGS_KIND, meetings: withoutOld(meetingsOf(current), at) }));
  }
  return { items };
}
