/**
 * Fireflies recordings belong to the Google Meet they were transcribed in.
 * Title, attendee email and host are never used to pick a client, and clock time only settles a room
 * two clients share (by their booked slots). A person's link wins over all of it, and a client a
 * recording was excluded from never gets it back automatically.
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

/**
 * Clears the legacy live-join stamps on a slot. They only say when Fireflies last accepted a dispatch;
 * whether the bot got in lives in the live-join sessions (lib/fireflies-live-sessions.js), keyed on room and
 * start, so a moved meeting is joined again in the same room.
 */
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
// Links from the title and name matching of old hub versions: cleaned up even without a stored record.
const LEGACY_LINK_BY = new Set(['title', 'title-rehome', 'offer-hydrate', 'name', 'email']);
const UNTRUSTED_AUTO_LINK_BY = new Set(['', 'auto', ...LEGACY_LINK_BY]);

function isTrustedMeetLinkBy(linkedBy = '') {
  return TRUSTED_MEET_LINK_BY.has(text(linkedBy));
}

function isUntrustedAutoLink(linkedBy = '') {
  return UNTRUSTED_AUTO_LINK_BY.has(text(linkedBy));
}

/** A person made this link: a paste on Tilbud ('manual') or an admin / rep / developer account key. */
export function isProtectedHumanLink(linkedBy = '') {
  const value = text(linkedBy);
  if (value === 'manual') return true;
  return /^(admin|sales|developer)(:|$)/i.test(value);
}

/** A client.meetings row a person linked, or whose purpose a person picked: automatic passes leave it alone. */
export function isProtectedMeetingRow(row = {}) {
  return isProtectedHumanLink(row?.linkedBy) || Boolean(text(row?.purposePickedAt));
}

function excludedClientIds(record = {}) {
  return new Set((Array.isArray(record?.excludedClientIds) ? record.excludedClientIds : []).map(text).filter(Boolean));
}

/**
 * Why an automatic link of this recording onto `clientId` must not happen, or '' when it may:
 *   'excluded'  a person said it is not this client's ("Ikke denne kunden");
 *   'pinned'    a person linked it to another client that still exists;
 *   'person'    another card holds it as a person's link (or with a person's purpose pick).
 * `stored` is the stored record (pin, excludedClientIds); a person's own link is never refused.
 */
export function automaticLinkRefusal(meetingId = '', clientId = '', { stored = null, clients = [] } = {}) {
  const id = text(meetingId);
  const target = text(clientId);
  if (!id || !target) return '';
  const list = Array.isArray(clients) ? clients : [];
  if (excludedClientIds(stored).has(target)) return 'excluded';
  const pinned = text(stored?.pin?.clientId);
  if (pinned && pinned !== target && list.some((client) => text(client?.id) === pinned)) return 'pinned';
  const elsewhere = list.some((client) => text(client?.id) !== target
    && (Array.isArray(client?.meetings) ? client.meetings : [])
      .some((row) => text(row?.meetingId) === id && isProtectedMeetingRow(row)));
  return elsewhere ? 'person' : '';
}

/** The room is already this client's and no other client's, so copying it onto an action changes no ownership. */
export function meetRoomIsOnlyClients(meetLink = '', client = {}, clients = []) {
  const room = normalizeFirefliesMeetLink(meetLink);
  if (!room || !clientOwnedMeetLinks(client).includes(room)) return false;
  const hit = indexClientsByMeetLink(clients).get(room);
  return Boolean(hit && !hit.ambiguous && text(hit.client?.id) === text(client?.id));
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

function compactMatch(client, reasons = [], confidence = 'high') {
  return {
    clientId: text(client.id),
    businessName: text(client.businessName),
    score: 100,
    reasons,
    confidence,
  };
}

/** The client a person linked this recording to: on its card, else the pin on the stored record. */
function personsClient(record = {}, clients = [], excluded = new Set()) {
  const meetingId = text(record?.meetingId);
  if (meetingId) {
    const holder = clients.find((client) => (Array.isArray(client?.meetings) ? client.meetings : [])
      .some((row) => text(row?.meetingId) === meetingId && isProtectedMeetingRow(row)));
    if (holder) return holder;
  }
  const pinned = text(record?.pin?.clientId);
  if (!pinned || excluded.has(pinned)) return null;
  return clients.find((client) => text(client?.id) === pinned) || null;
}

/**
 * Which client a recording belongs to: { best, candidates }.
 *   1. a person's link: the client whose card holds it as linked by a person, else the stored pin
 *      (left out with `people: false`, which asks only whose room it is);
 *   2. the client whose booked Meet room Fireflies' meeting_link is;
 *   3. a room two clients share: the one whose booked slot in it the recording started in
 *      (`slotOwner(record, clients)`, lib/fireflies-slots.js slotOwnerAmongClients), else none.
 * Clients in record.excludedClientIds never come out of 2 or 3.
 */
export function matchMeetingToClients(record = {}, clients = [], { slotOwner = null, people = true } = {}) {
  const list = (Array.isArray(clients) ? clients : []).filter((client) => text(client?.id));
  const excluded = excludedClientIds(record);
  const person = people ? personsClient(record, list, excluded) : null;
  if (person) {
    const best = compactMatch(person, ['Koblet til kunden av en person'], 'manual');
    return { best, candidates: [best] };
  }
  const link = recordingMeetLink(record);
  if (!link) return { best: null, candidates: [] };
  const hit = indexClientsByMeetLink(list).get(link);
  if (!hit) return { best: null, candidates: [] };
  if (hit.ambiguous) {
    const allowed = (hit.clients || []).filter((client) => !excluded.has(text(client.id)));
    const owner = typeof slotOwner === 'function' ? slotOwner(record, allowed) : null;
    if (owner) {
      const best = compactMatch(owner, ['Meet-lenken og tiden matcher kundens bookede møte']);
      return { best, candidates: [best] };
    }
    return {
      best: null,
      candidates: allowed.map((client) => compactMatch(client, ['Samme Meet-lenke på flere kunder'])),
    };
  }
  if (excluded.has(text(hit.client.id))) return { best: null, candidates: [] };
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
        protected: isProtectedMeetingRow(row),
      });
      map.set(meetingId, list);
    }
  }
  return map;
}

/**
 * Rehome every stored recording onto the client that booked that Meet.
 * Ownership is Fireflies' meeting_link only; title-linked compact Meet URLs are ignored, and historical
 * rooms stay on the client that still has that URL in recordedMeetLinks.
 *   - A person's link (isProtectedMeetingRow) is never moved or unlinked, and a pin on the stored record
 *     brings the recording back to that client.
 *   - A client the recording was excluded from loses it and never gets it back from here.
 *   - A room two clients share goes to the one whose booked slot fits in time (`slotOwner`); without
 *     one, existing links stay.
 *   - Automatic links in a room no client owns are unlinked. With no stored record there is no
 *     evidence, so only the old hub's title and name links are cleaned up.
 *   - A store with no records while cards hold real ids is unreadable or lost, not proof: nothing runs.
 */
export function planFirefliesMeetLinkBackfill({ clients = [], meetings = [], slotOwner = null } = {}) {
  const homes = currentHomesByMeetingId(clients);
  const storedById = new Map();
  for (const row of Array.isArray(meetings) ? meetings : []) {
    const id = text(row?.meetingId);
    if (id) storedById.set(id, row);
  }
  if (!storedById.size && homes.size) {
    return { moves: [], unlinks: [], scanned: 0, linked: 0, detached: 0, skipped: 'empty-store' };
  }
  const list = (Array.isArray(clients) ? clients : []).filter((client) => text(client?.id));
  const clientById = new Map(list.map((client) => [text(client.id), client]));
  const index = indexClientsByMeetLink(list);
  const ids = new Set([...storedById.keys(), ...homes.keys()]);
  const moves = [];
  const unlinks = [];
  const moveTo = (meetingId, client, link, reason, linkedBy = 'meet-link') => moves.push({
    meetingId,
    toClientId: text(client.id),
    businessName: text(client.businessName),
    meetLink: link,
    reason,
    linkedBy,
  });

  for (const meetingId of ids) {
    const stored = storedById.get(meetingId) || null;
    const current = homes.get(meetingId) || [];

    if (!stored) {
      for (const row of current) {
        if (!row.protected && LEGACY_LINK_BY.has(row.linkedBy)) {
          unlinks.push({ meetingId, fromClientId: row.clientId, reason: 'no-record' });
        }
      }
      continue;
    }

    const excluded = excludedClientIds(stored);
    for (const row of current) {
      if (excluded.has(row.clientId) && !row.protected) {
        unlinks.push({ meetingId, fromClientId: row.clientId, reason: 'excluded' });
      }
    }
    const held = current.filter((row) => !excluded.has(row.clientId) || row.protected);
    if (held.some((row) => row.protected)) continue;

    const link = recordingMeetLink(stored);
    const pinned = text(stored.pin?.clientId);
    const pinnedClient = pinned && !excluded.has(pinned) ? clientById.get(pinned) : null;
    if (pinnedClient) {
      for (const row of held) {
        if (row.clientId !== pinned) unlinks.push({ meetingId, fromClientId: row.clientId, reason: 'pinned' });
      }
      if (!held.some((row) => row.clientId === pinned)) {
        moveTo(meetingId, pinnedClient, link, 'pin', text(stored.pin?.linkedBy) || 'manual');
      }
      continue;
    }

    const hit = link ? index.get(link) : null;
    // The room's own client said "not ours": nothing else is known about whose it is, so links stay.
    if (hit && !hit.ambiguous && excluded.has(text(hit.client?.id))) continue;
    let owner = hit && !hit.ambiguous ? hit.client : null;
    if (hit?.ambiguous && typeof slotOwner === 'function') {
      owner = slotOwner(stored, (hit.clients || []).filter((client) => !excluded.has(text(client.id))));
    }
    const ownerId = text(owner?.id);

    if (ownerId) {
      for (const row of held) {
        if (row.clientId === ownerId) continue;
        unlinks.push({ meetingId, fromClientId: row.clientId, reason: 'meet-link-owner' });
      }
      if (!held.some((row) => row.clientId === ownerId)) moveTo(meetingId, owner, link, 'meet-link');
      continue;
    }

    // A shared room with no fitting slot: the links stay as they are.
    if (hit?.ambiguous) continue;
    for (const row of held) {
      if (isTrustedMeetLinkBy(row.linkedBy) || !isUntrustedAutoLink(row.linkedBy)) continue;
      unlinks.push({
        meetingId,
        fromClientId: row.clientId,
        reason: link ? 'unknown-meet-link' : 'no-meet-link',
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
