/**
 * Putting Fireflies recordings on client cards and taking them off. Every link path (webhook, pull
 * ingest, Tilbud paste, calendar session, admin, the meet-link backfill, the watchdog) goes through
 * link(); client.meetings is the one record of who holds a recording, and the stored record's match,
 * pin and excludedClientIds follow the card. server.js wires it to data/sales.js and the open offer.
 *   - An automatic link never takes a recording off a person's link on another card, onto a client it
 *     was excluded from, or away from the client a person pinned it to. A person's link (a 'manual' or
 *     account linkedBy) moves it, pins it there and stays a person's link on later passes.
 *   - Purpose and slot come from the room (lib/fireflies-slots.js); a person's pick stays.
 *   - The card a recording leaves loses it from its workshop / iteration / Møte slots, open offer and
 *     offer lock.
 *   - Placeholders a recording with talk covers are dropped; slots, actions and the offer lock keep the
 *     copy of a meeting with the most talk.
 */
import {
  automaticLinkRefusal,
  isProtectedHumanLink,
  meetRoomIsOnlyClients,
  planFirefliesMeetLinkBackfill,
} from './fireflies-client-match.js';
import { clientMeetingSlots, resolveRecordingSlot, slotOwnerAmongClients } from './fireflies-slots.js';
import {
  listStoredFirefliesMeetings,
  meetingRefForClient,
  readStoredFirefliesMeeting,
  setStoredFirefliesClientLink,
  storedMatchForCard,
  syncStoredFirefliesMatches,
} from './fireflies-webhook.js';
import { isPlaceholderMeetingId } from './offer-meetings.js';
import { attachFirefliesToMatchingAction } from './sales-activity-log.js';
import { decorateNextActions } from './sales-next-actions.js';
import { getWorkshopAction } from './workshop-action.js';
import {
  applyFirefliesPurpose,
  clientMeetingRowsView,
  offerLockIsStale,
  planClientMeetingSync,
  purposePickPatch,
  slotKeepsMeeting,
  storedTalkOf,
} from './workshop-meetings.js';
import { getWorkshopRecord } from './workshop-record.js';

function text(value = '') {
  return String(value ?? '').trim();
}

function errorText(error) {
  return text(error?.message) || String(error);
}

function rowOf(client, meetingId) {
  const id = text(meetingId);
  return (Array.isArray(client?.meetings) ? client.meetings : []).find((row) => text(row?.meetingId) === id) || null;
}

/**
 * deps:
 *   sales                 data/sales.js (getSalesClientById, getSalesClients, findSalesClientByMeetingId,
 *                         linkMeetingToSalesClient, unlinkMeetingFromSalesClient, updateSalesClient,
 *                         patchSalesMeetingRows, pickLockedOfferMeetingId);
 *   stripFromOffer(clientId, meetingId)   take it off the client's open offer;
 *   onWorkshopRecording(clientId)         the workshop slot got a recording (the project document job);
 *   readStored, setStoredClientLink, listStored, syncStoredMatches: the Fireflies archive (lib/fireflies-webhook.js);
 *   log.
 */
export function createFirefliesLinker({
  sales,
  stripFromOffer = () => {},
  onWorkshopRecording = () => {},
  readStored = readStoredFirefliesMeeting,
  setStoredClientLink = setStoredFirefliesClientLink,
  listStored = listStoredFirefliesMeetings,
  syncStoredMatches = syncStoredFirefliesMatches,
  log = console,
} = {}) {
  const talkOfStored = () => storedTalkOf(readStored);

  /**
   * Write what the card says onto the stored record: the match, and for a person's link a pin (and the
   * client off its excluded list). A store that cannot be written never fails the link itself.
   */
  function syncStored(clientId, meetingId, { human = false, actor = '' } = {}) {
    const id = text(meetingId);
    if (!id || isPlaceholderMeetingId(id) || !readStored(id)) return null;
    const client = sales.getSalesClientById(clientId);
    const row = rowOf(client, id);
    if (!row) return null;
    try {
      return setStoredClientLink(id, {
        match: storedMatchForCard(client, row),
        ...(human ? { pin: { clientId: client.id, linkedBy: text(actor) || text(row.linkedBy) }, include: client.id } : {}),
      });
    } catch (error) {
      log.warn?.(`[fireflies] match id=${id} client=${text(clientId)} not stored: ${errorText(error)}`);
      return null;
    }
  }

  /** Take a recording out of the client's workshop / iteration slot and Møte actions. */
  function clearSlots(clientId, meetingId) {
    const client = sales.getSalesClientById(clientId);
    const wanted = text(meetingId);
    if (!client || !wanted) return;
    const patch = {};
    if (Array.isArray(client.nextActions) && client.nextActions.some((action) => text(action.firefliesMeetingId) === wanted)) {
      patch.nextActions = client.nextActions.map((action) => (
        text(action.firefliesMeetingId) === wanted ? { ...action, firefliesMeetingId: '' } : action
      ));
    }
    if (text(client.workshopAction?.firefliesMeetingId) === wanted) {
      patch.workshopAction = { ...client.workshopAction, firefliesMeetingId: '' };
    }
    const iteration = client.workshop?.iterationMeeting;
    if (text(iteration?.firefliesMeetingId) === wanted) {
      patch.workshop = {
        ...client.workshop,
        iterationMeeting: { ...iteration, firefliesMeetingId: '' },
      };
    }
    if (Object.keys(patch).length) sales.updateSalesClient(clientId, patch);
  }

  /** The lock a stale offer lock (offerLockIsStale) should point at now, or null when it stays. */
  function nextOfferLock(client, talkOf) {
    if (!client?.progression?.meetingHeld || !offerLockIsStale(client, { talkOf })) return null;
    const next = sales.pickLockedOfferMeetingId(client, { talkOf });
    return next === text(client.lockedOfferMeetingId) ? null : next;
  }

  /**
   * The offer lock follows the sales recording once "Møtet hatt" is ticked: a stale lock points at the
   * best real one with talk (sales.pickLockedOfferMeetingId), or is cleared.
   */
  function repointLock(clientId, { talkOf = talkOfStored() } = {}) {
    const client = sales.getSalesClientById(clientId);
    const next = nextOfferLock(client, talkOf);
    if (next == null) return client;
    return sales.updateSalesClient(client.id, { lockedOfferMeetingId: next }) || client;
  }

  /** A recording left this client (moved, unlinked, excluded, a placeholder dropped): out of its slots, offer and lock. */
  function detach(clientId, meetingId) {
    clearSlots(clientId, meetingId);
    stripFromOffer(clientId, meetingId);
    repointLock(clientId);
  }

  /** Drop the placeholders a recording with talk on their own slot now covers (lib/workshop-meetings.js). */
  function dropCovered(clientId) {
    const client = sales.getSalesClientById(clientId);
    if (!client) return client;
    const { superseded } = clientMeetingRowsView(client, { storedOf: readStored });
    for (const id of superseded) {
      sales.unlinkMeetingFromSalesClient(clientId, id);
      detach(clientId, id);
    }
    return superseded.size ? (sales.getSalesClientById(clientId) || client) : client;
  }

  /**
   * Why linking `ref` onto this client automatically must not happen ('excluded' | 'pinned' | 'person',
   * lib/fireflies-client-match.js automaticLinkRefusal), or '' when it may. A person's link is never refused.
   */
  function refusal(clientId, ref = {}) {
    const id = text(ref?.meetingId);
    if (!id || isPlaceholderMeetingId(id) || isProtectedHumanLink(ref?.linkedBy)) return '';
    return automaticLinkRefusal(id, text(clientId), { stored: readStored(id), clients: sales.getSalesClients() });
  }

  /**
   * Put a Fireflies recording on a client card (a live-join placeholder is written as it is):
   * { client, refused }. `client` is the client as it is now (unchanged when the link is refused, null
   * when it does not exist); `refused` says why an automatic link must not happen (refusal()), else ''.
   */
  function tryLink(clientId, ref) {
    const client = sales.getSalesClientById(clientId);
    const meetingId = text(ref?.meetingId);
    if (!client || !meetingId) return { client: client || null, refused: '' };
    if (isPlaceholderMeetingId(meetingId)) return { client: sales.linkMeetingToSalesClient(client.id, ref) || client, refused: '' };
    const human = isProtectedHumanLink(ref.linkedBy);
    const clients = sales.getSalesClients();
    const holders = clients.filter((entry) => entry.id !== client.id && rowOf(entry, meetingId));
    const refused = human ? '' : automaticLinkRefusal(meetingId, client.id, { stored: readStored(meetingId), clients });
    if (refused) return { client, refused };
    const existing = rowOf(client, meetingId);
    // A later automatic pass (a summary that came in, a relink) keeps a person's link a person's link.
    const kept = !human && existing && isProtectedHumanLink(existing.linkedBy)
      ? { linkedBy: existing.linkedBy, confidence: existing.confidence, score: existing.score, reasons: existing.reasons }
      : {};
    const talkOf = talkOfStored();
    const applied = applyFirefliesPurpose(client, { ...ref, ...kept }, { existing, talkOf });
    sales.linkMeetingToSalesClient(client.id, applied.ref);
    for (const holder of holders) detach(holder.id, meetingId);
    const latest = dropCovered(client.id) || client;
    const slots = clientMeetingSlots(latest);
    const slot = (applied.ref.slotKey && slots.find((entry) => entry.slotKey === applied.ref.slotKey))
      || resolveRecordingSlot(latest, applied.ref, { slots }).slot;
    const attached = attachFirefliesToMatchingAction(decorateNextActions(latest), applied.ref, {
      slot,
      keepCurrent: (action) => slotKeepsMeeting(latest, action.firefliesMeetingId, applied.ref, { talkOf }),
      copyMeetLink: meetRoomIsOnlyClients(applied.ref.meetLink, latest, clients),
    });
    const patch = {};
    if (attached.actionId) patch.nextActions = attached.actions;
    if (applied.workshopAction) {
      patch.workshopAction = {
        ...(latest?.workshopAction || {}),
        firefliesMeetingId: applied.workshopAction.firefliesMeetingId,
      };
    }
    if (applied.workshop) patch.workshop = applied.workshop;
    if (Object.keys(patch).length) sales.updateSalesClient(client.id, patch);
    repointLock(client.id, { talkOf });
    syncStored(client.id, meetingId, { human, actor: ref.linkedBy });
    const fresh = sales.getSalesClientById(client.id);
    if (applied.ref?.purpose === 'workshop') onWorkshopRecording(client.id);
    return { client: fresh, refused: '' };
  }

  /** tryLink's client: the client as it is now, or null when it does not exist. */
  function link(clientId, ref) {
    return tryLink(clientId, ref).client;
  }

  /** Take a recording off a client card, with its slots, offer and lock. */
  function unlink(clientId, meetingId) {
    const updated = sales.unlinkMeetingFromSalesClient(clientId, meetingId);
    detach(clientId, meetingId);
    return sales.getSalesClientById(clientId) || updated;
  }

  /**
   * A person's purpose pick for one recording on the card (lib/workshop-meetings.js purposePickPatch):
   * the row keeps it on every automatic pass, the workshop / iteration slot follows it, the offer lock
   * leaves a recording that is not the sales meeting and goes to the one picked as it (with talk), the
   * placeholder of the slot it now covers goes, and the stored record is pinned to this client.
   */
  function setPurpose(clientId, meetingId, purpose, { by = '', actor = '', nowMs = Date.now() } = {}) {
    const client = sales.getSalesClientById(clientId);
    const id = text(meetingId);
    const row = rowOf(client, id);
    if (!client || !row || isPlaceholderMeetingId(id)) return client || null;
    const picked = text(purpose);
    const patch = purposePickPatch(client, row, purpose, { by, nowMs });
    sales.patchSalesMeetingRows([{ clientId: client.id, meetingId: id, patch }]);
    const latest = sales.getSalesClientById(client.id) || client;
    const slotPatch = {};
    const workshop = getWorkshopAction(latest);
    if (workshop) {
      const holds = text(workshop.firefliesMeetingId) === id;
      if (patch.purpose === 'workshop' && picked && !holds) slotPatch.workshopAction = { ...latest.workshopAction, firefliesMeetingId: id };
      if (patch.purpose !== 'workshop' && holds) slotPatch.workshopAction = { ...latest.workshopAction, firefliesMeetingId: '' };
    }
    const record = getWorkshopRecord(latest);
    const iterationHolds = text(record.iterationMeeting?.firefliesMeetingId) === id;
    if (patch.purpose === 'iteration' && picked && !iterationHolds) {
      slotPatch.workshop = { ...record, iterationMeeting: { ...record.iterationMeeting, firefliesMeetingId: id } };
    } else if (patch.purpose !== 'iteration' && iterationHolds) {
      slotPatch.workshop = { ...record, iterationMeeting: { ...record.iterationMeeting, firefliesMeetingId: '' } };
    }
    const lock = text(latest.lockedOfferMeetingId);
    const talkOf = talkOfStored();
    if (patch.purpose !== 'sales' && lock === id) slotPatch.lockedOfferMeetingId = '';
    if (patch.purpose === 'sales' && picked && latest.progression?.meetingHeld && lock !== id
      && Number(talkOf(rowOf(latest, id) || row)?.sentences) > 0) {
      slotPatch.lockedOfferMeetingId = id;
    }
    if (Object.keys(slotPatch).length) sales.updateSalesClient(client.id, slotPatch);
    dropCovered(client.id);
    repointLock(client.id, { talkOf });
    syncStored(client.id, id, { human: true, actor });
    if (patch.purpose === 'workshop') onWorkshopRecording(client.id);
    return sales.getSalesClientById(client.id);
  }

  /**
   * "Ikke denne kunden": take a recording off this client (with its slots, offer and lock) and record
   * that it is not this client's, so no automatic pass puts it back. A card row whose recording was
   * never stored gets a bare stored record that keeps the exclusion. Returns { ok, status, client }:
   * status 404 (no such client, or neither stored nor on the card) or 503 (the exclusion was not saved).
   */
  function exclude(clientId, meetingId) {
    const client = sales.getSalesClientById(clientId);
    const id = text(meetingId);
    if (!client || !id) return { ok: false, status: 404, client: client || null };
    const record = readStored(id);
    const onCard = Boolean(rowOf(client, id));
    if (!record && !onCard) return { ok: false, status: 404, client };
    if (onCard) unlink(client.id, id);
    const latest = () => sales.getSalesClientById(client.id) || client;
    try {
      const saved = setStoredClientLink(id, {
        exclude: client.id,
        ...(text(record?.pin?.clientId) === client.id ? { pin: null } : {}),
        ...(text(record?.match?.clientId) === client.id ? { match: null } : {}),
      }, { create: true });
      if (!saved) return { ok: false, status: 503, client: latest() };
    } catch (error) {
      log.warn?.(`[fireflies] exclude id=${id} client=${client.id} not stored: ${errorText(error)}`);
      return { ok: false, status: 503, client: latest() };
    }
    return { ok: true, status: 200, client: latest() };
  }

  /**
   * The admin's unlink: off the card that holds it (with full cleanup), and kept off that client
   * (excludedClientIds) until a person links it again; the stored match and pin go. Returns the stored record.
   */
  function unlinkFromHolder(meetingId) {
    const id = text(meetingId);
    const holder = sales.findSalesClientByMeetingId(id);
    if (holder) unlink(holder.id, id);
    try {
      return setStoredClientLink(id, { match: null, pin: null, ...(holder ? { exclude: holder.id } : {}) }) || readStored(id);
    } catch (error) {
      log.warn?.(`[fireflies] unlink id=${id} not stored: ${errorText(error)}`);
      return readStored(id);
    }
  }

  /** Point a slot that names a shorter copy of a meeting at the copy with the most talk (planClientMeetingSync). */
  function moveSlotsToPrimary(clientId, { workshopMeetingId = '', iterationMeetingId = '', actions = [] } = {}) {
    const client = sales.getSalesClientById(clientId);
    if (!client) return false;
    const patch = {};
    if (workshopMeetingId && client.workshopAction) {
      patch.workshopAction = { ...client.workshopAction, firefliesMeetingId: workshopMeetingId };
    }
    if (iterationMeetingId) {
      const record = getWorkshopRecord(client);
      patch.workshop = { ...record, iterationMeeting: { ...record.iterationMeeting, firefliesMeetingId: iterationMeetingId } };
    }
    if (actions.length && Array.isArray(client.nextActions)) {
      const byId = new Map(actions.map((entry) => [text(entry.actionId), text(entry.meetingId)]));
      patch.nextActions = client.nextActions.map((action) => (
        byId.has(text(action.id)) ? { ...action, firefliesMeetingId: byId.get(text(action.id)) } : action
      ));
    }
    if (!Object.keys(patch).length) return false;
    sales.updateSalesClient(client.id, patch);
    if (patch.workshopAction) onWorkshopRecording(client.id);
    return true;
  }

  /**
   * Cards linked before the purpose and slot rules (or whose bookings moved) get what the rules say now:
   * row facts in one write, covered placeholders dropped, slots on a shorter copy moved to the primary,
   * and a stale offer lock (a placeholder, a recording that left, a silent fragment) pointed at the sales
   * recording with talk. A person's pick stays. Returns { patched, dropped, slotsMoved, locksMoved }.
   */
  function syncCards(clients = sales.getSalesClients()) {
    const patches = [];
    const drops = [];
    const slotMoves = [];
    for (const client of clients) {
      if (!(client.meetings || []).length) continue;
      try {
        const plan = planClientMeetingSync(client, { readStored });
        for (const entry of plan.patches) patches.push({ clientId: client.id, ...entry });
        for (const meetingId of plan.drop) drops.push({ clientId: client.id, meetingId });
        if (Object.keys(plan.slots || {}).length) slotMoves.push({ clientId: client.id, slots: plan.slots });
      } catch (error) {
        log.warn?.(`[fireflies] meeting facts client=${text(client.id)} ${errorText(error)}`);
      }
    }
    const patched = patches.length ? sales.patchSalesMeetingRows(patches) : 0;
    for (const row of drops) unlink(row.clientId, row.meetingId);
    let slotsMoved = 0;
    for (const entry of slotMoves) {
      if (moveSlotsToPrimary(entry.clientId, entry.slots)) slotsMoved += 1;
    }
    // Locks from before these rules (or a move made by the old hub): one read, a write only on change.
    const current = patched || drops.length || slotsMoved ? sales.getSalesClients() : clients;
    const talkOf = talkOfStored();
    let locksMoved = 0;
    for (const client of current) {
      try {
        const next = nextOfferLock(client, talkOf);
        if (next == null) continue;
        sales.updateSalesClient(client.id, { lockedOfferMeetingId: next });
        locksMoved += 1;
      } catch (error) {
        log.warn?.(`[fireflies] offer lock client=${text(client.id)} ${errorText(error)}`);
      }
    }
    return { patched, dropped: drops.length, slotsMoved, locksMoved };
  }

  /**
   * Every stored meeting's match names the card that holds it, or nothing (one write). Skipped when no
   * card holds a recording at all: that is an empty or unreadable sales file, not proof.
   */
  function syncMatches(clients = sales.getSalesClients()) {
    const held = new Map();
    for (const client of clients) {
      for (const row of client.meetings || []) {
        const id = text(row.meetingId);
        if (id && !isPlaceholderMeetingId(id) && !held.has(id)) held.set(id, storedMatchForCard(client, row));
      }
    }
    if (!held.size) return { changed: 0 };
    const entries = listStored({ includeStubs: true })
      .map((row) => ({ meetingId: row.meetingId, match: held.get(text(row.meetingId)) || null }));
    return syncStoredMatches(entries);
  }

  /**
   * Rehome stored recordings onto the client whose booked Meet room they were recorded in
   * (planFirefliesMeetLinkBackfill: a person's link and pin win, an exclusion holds, no evidence is no
   * unlink, a store with no records while cards hold recordings is skipped, and so is one that was lost at
   * the start of the tick: `archiveLost`), then bring every card in line (syncCards) and every stored match
   * with its card (syncMatches). Returns the plan plus what syncCards changed.
   */
  function backfill({ archiveLost = false } = {}) {
    const clients = sales.getSalesClients();
    const plan = planFirefliesMeetLinkBackfill({ clients, meetings: listStored(), slotOwner: slotOwnerAmongClients, archiveLost });
    if (plan.skipped) return { ...plan, patched: 0, dropped: 0, slotsMoved: 0, locksMoved: 0 };
    for (const row of plan.unlinks) unlink(row.fromClientId, row.meetingId);
    for (const row of plan.moves) {
      const stored = readStored(row.meetingId);
      const client = sales.getSalesClientById(row.toClientId);
      if (!client) continue;
      const record = stored?.meetingId
        ? { ...stored, meetLink: stored.meetingLink || row.meetLink }
        : { meetingId: row.meetingId, meetLink: row.meetLink, title: 'Fireflies-møte' };
      const linkedBy = text(row.linkedBy) || 'meet-link';
      const person = isProtectedHumanLink(linkedBy);
      link(client.id, meetingRefForClient(record, {
        clientId: client.id,
        businessName: client.businessName,
        confidence: person ? 'manual' : 'high',
        reasons: [person ? 'Koblet til kunden av en person' : 'Google Meet-lenken matcher kundens møte'],
        linkedBy,
      }, { linkedBy }));
    }
    const moved = plan.unlinks.length || plan.moves.length;
    const cards = syncCards(moved ? sales.getSalesClients() : clients);
    const changed = moved || cards.patched || cards.dropped || cards.slotsMoved || cards.locksMoved;
    syncMatches(changed ? sales.getSalesClients() : clients);
    return { ...plan, ...cards };
  }

  return {
    link,
    tryLink,
    unlink,
    setPurpose,
    exclude,
    unlinkFromHolder,
    refusal,
    detach,
    dropCovered,
    repointLock,
    clearSlots,
    syncCards,
    syncMatches,
    backfill,
  };
}
