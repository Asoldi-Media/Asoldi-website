/**
 * Fireflies recordings belong to the Google Meet they were transcribed in.
 * Title, attendee email, host, and clock time are never used to pick a client.
 */

import { recordedSalesActions } from './sales-next-actions.js';
import { getWorkshopAction } from './workshop-action-shared.js';

function text(value = '') {
  return String(value ?? '').trim();
}

export function normalizeFirefliesMeetLink(value = '') {
  return text(value).toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

export function firefliesMeetLinksDiffer(left = '', right = '') {
  const a = normalizeFirefliesMeetLink(left);
  const b = normalizeFirefliesMeetLink(right);
  if (!a || !b) return Boolean(a || b);
  return a !== b;
}

/** True only when Fred already entered this exact Meet. A later room swap must join again. */
export function firefliesJoinedCurrentMeet({
  joinedAt = '',
  joinedMeetLink = '',
  meetLink = '',
} = {}) {
  if (!text(joinedAt)) return false;
  const joined = normalizeFirefliesMeetLink(joinedMeetLink);
  const current = normalizeFirefliesMeetLink(meetLink);
  if (!joined || !current) return false;
  return joined === current;
}

/** Drop a live: stub once a real recording exists for this client's Meet. */
export function shouldDropLiveJoinStub({
  stub = {},
  recordingMeetLink = '',
  ownedMeetLinks = [],
  keepMeetingId = '',
  recordingPurpose = '',
} = {}) {
  const stubId = text(stub?.meetingId);
  if (!stubId.toLowerCase().startsWith('live:')) return false;
  if (text(keepMeetingId) && stubId === text(keepMeetingId)) return false;
  const owned = new Set(
    (Array.isArray(ownedMeetLinks) ? ownedMeetLinks : []).map((link) => normalizeFirefliesMeetLink(link)).filter(Boolean)
  );
  const recording = normalizeFirefliesMeetLink(recordingMeetLink);
  const stubLink = normalizeFirefliesMeetLink(stub?.meetLink || stub?.meetingLink);
  const stubPurpose = text(stub?.purpose) || (stub?.forSalesMeeting ? 'sales' : '');
  const purpose = text(recordingPurpose);
  if (stubPurpose && purpose && stubPurpose !== purpose) return false;
  if (recording && stubLink && stubLink === recording) return true;
  if (recording && owned.has(recording) && (!stubLink || owned.has(stubLink))) return true;
  return false;
}

export function emptyFirefliesLiveJoinStamp() {
  return {
    firefliesLiveJoinedAt: '',
    firefliesLiveJoinAttemptAt: '',
    firefliesLiveJoinError: '',
    firefliesLiveJoinedMeetLink: '',
  };
}

function isOwnedMeetLink(value = '') {
  const url = text(value);
  if (!/^https:\/\/meet\.google\.com\//i.test(url)) return false;
  if (/asoldi-(sim|email)-test|lookup\/asoldi/i.test(url)) return false;
  return /meet\.google\.com\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}(?:\?|$)/i.test(url)
    || /meet\.google\.com\/[a-z0-9-]{10,}(?:\?|$)/i.test(url);
}

function pushOwnedLink(out, value = '') {
  if (!isOwnedMeetLink(value)) return;
  const link = normalizeFirefliesMeetLink(value);
  if (link) out.add(link);
}

const TRUSTED_MEET_LINK_BY = new Set(['meet-link', 'live-join']);
const UNTRUSTED_AUTO_LINK_BY = new Set([
  '',
  'auto',
  'title',
  'title-rehome',
  'offer-hydrate',
  'name',
  'email',
]);

function isTrustedMeetLinkBy(linkedBy = '') {
  return TRUSTED_MEET_LINK_BY.has(text(linkedBy));
}

function isUntrustedAutoLink(linkedBy = '') {
  return UNTRUSTED_AUTO_LINK_BY.has(text(linkedBy));
}

function isProtectedHumanLink(linkedBy = '') {
  const value = text(linkedBy);
  if (value === 'manual') return true;
  if (/^admin/i.test(value)) return true;
  return false;
}

/** Every Meet URL this client was issued, including rooms later replaced by a reschedule. */
export function collectRecordedMeetLinks(client = {}) {
  const out = new Set();
  for (const value of Array.isArray(client?.recordedMeetLinks) ? client.recordedMeetLinks : []) {
    pushOwnedLink(out, value);
  }
  pushOwnedLink(out, client?.calendar?.meetLink);
  pushOwnedLink(out, getWorkshopAction(client)?.meetLink);
  pushOwnedLink(out, client?.workshopAction?.meetLink);
  pushOwnedLink(out, client?.workshop?.iterationMeeting?.meetLink);
  for (const action of recordedSalesActions(client, { includeDone: true })) {
    pushOwnedLink(out, action?.meetLink);
  }
  for (const action of Array.isArray(client?.nextActions) ? client.nextActions : []) {
    pushOwnedLink(out, action?.meetLink);
  }
  for (const row of Array.isArray(client?.meetings) ? client.meetings : []) {
    if (!isTrustedMeetLinkBy(row?.linkedBy)) continue;
    pushOwnedLink(out, row?.meetLink || row?.meetingLink);
  }
  return [...out];
}

/** Meet rooms this client booked (sales, extra Møte, workshop, iteration) plus kept history. */
export function clientOwnedMeetLinks(client = {}) {
  return collectRecordedMeetLinks(client);
}

export function recordingMeetLink(record = {}) {
  return normalizeFirefliesMeetLink(record.meetingLink || record.meetLink);
}

/**
 * One Meet URL → at most one client. Shared rooms are left unmatched.
 * @returns {Map<string, { client?: object, ambiguous?: boolean, clients?: object[] }>}
 */
export function indexClientsByMeetLink(clients = []) {
  const map = new Map();
  for (const client of Array.isArray(clients) ? clients : []) {
    if (!text(client?.id)) continue;
    for (const link of clientOwnedMeetLinks(client)) {
      const existing = map.get(link);
      if (!existing) {
        map.set(link, { client });
        continue;
      }
      if (existing.ambiguous) {
        if (!existing.clients.some((row) => row.id === client.id)) existing.clients.push(client);
        continue;
      }
      if (existing.client?.id === client.id) continue;
      map.set(link, { ambiguous: true, clients: [existing.client, client] });
    }
  }
  return map;
}

function compactMatch(client, reasons = []) {
  return {
    clientId: text(client.id),
    businessName: text(client.businessName),
    score: 100,
    reasons,
    confidence: 'high',
  };
}

/** Auto-link only when Fireflies' meeting_link is this client's booked Meet. */
export function matchMeetingToClients(record = {}, clients = []) {
  const link = recordingMeetLink(record);
  if (!link) return { best: null, candidates: [] };
  const hit = indexClientsByMeetLink(clients).get(link);
  if (!hit) return { best: null, candidates: [] };
  if (hit.ambiguous) {
    return {
      best: null,
      candidates: (hit.clients || []).map((client) => compactMatch(client, ['Samme Meet-lenke på flere kunder'])),
    };
  }
  const best = compactMatch(hit.client, ['Google Meet-lenken matcher kundens møte']);
  return { best, candidates: [best] };
}

function currentHomesByMeetingId(clients = []) {
  const map = new Map();
  for (const client of Array.isArray(clients) ? clients : []) {
    const clientId = text(client?.id);
    if (!clientId) continue;
    for (const row of Array.isArray(client.meetings) ? client.meetings : []) {
      const meetingId = text(row?.meetingId);
      if (!meetingId || meetingId.toLowerCase().startsWith('live:')) continue;
      const list = map.get(meetingId) || [];
      list.push({
        clientId,
        linkedBy: text(row.linkedBy),
        meetLink: recordingMeetLink(row),
      });
      map.set(meetingId, list);
    }
  }
  return map;
}

/**
 * Rehome every stored recording onto the client that booked that Meet.
 * Ownership is Fireflies' meeting_link only. Title-linked compact Meet URLs are ignored.
 * Historical rooms stay on the client that still has that URL in recordedMeetLinks.
 * Title/auto links with no Fireflies Meet owner are unlinked. Trusted/manual links stay.
 */
export function planFirefliesMeetLinkBackfill({ clients = [], meetings = [] } = {}) {
  const index = indexClientsByMeetLink(clients);
  const homes = currentHomesByMeetingId(clients);
  const storedById = new Map();
  for (const row of Array.isArray(meetings) ? meetings : []) {
    const id = text(row?.meetingId);
    if (id) storedById.set(id, row);
  }
  const ids = new Set([...storedById.keys(), ...homes.keys()]);
  const moves = [];
  const unlinks = [];

  for (const meetingId of ids) {
    const stored = storedById.get(meetingId) || {};
    const current = homes.get(meetingId) || [];
    const link = recordingMeetLink(stored);
    const hit = link ? index.get(link) : null;
    const owner = hit && !hit.ambiguous ? hit.client : null;
    const ownerId = text(owner?.id);

    if (ownerId) {
      for (const row of current) {
        if (row.clientId === ownerId) continue;
        unlinks.push({ meetingId, fromClientId: row.clientId, reason: 'meet-link-owner' });
      }
      if (!current.some((row) => row.clientId === ownerId)) {
        moves.push({
          meetingId,
          toClientId: ownerId,
          businessName: text(owner.businessName),
          meetLink: link,
          reason: 'meet-link',
        });
      }
      continue;
    }

    for (const row of current) {
      if (isProtectedHumanLink(row.linkedBy) || isTrustedMeetLinkBy(row.linkedBy)) continue;
      if (!isUntrustedAutoLink(row.linkedBy)) continue;
      unlinks.push({
        meetingId,
        fromClientId: row.clientId,
        reason: hit?.ambiguous ? 'ambiguous-meet-link' : (link ? 'unknown-meet-link' : 'no-meet-link'),
      });
    }
  }

  return {
    moves,
    unlinks,
    scanned: ids.size,
    linked: moves.length,
    detached: unlinks.length,
  };
}

/** True when this recording is the booked sales meeting, not a later calendar reminder. */
export function recordingMatchesSalesMeeting(client = {}, record = {}) {
  const recordLink = recordingMeetLink(record);
  const salesLink = normalizeFirefliesMeetLink(client?.calendar?.meetLink);
  if (recordLink && salesLink && recordLink === salesLink) return true;
  if (!client?.agreedTime || !text(client.meetingAt)) return false;
  const start = Date.parse(text(record?.startedAt || record?.dateString));
  const when = Date.parse(text(client.meetingAt));
  if (!Number.isFinite(start) || !Number.isFinite(when)) return false;
  return Math.abs(start - when) <= 3 * 60 * 60 * 1000;
}

export function confidenceForScore(score = 0) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}
