// Hub side of the Maker delivery events (WS8.28): the switch, the recorder used by the status
// callback in server.js and the run fetch with the materials fallback. The payload rules live in
// lib/maker-events.js (pure).
import { getAutomationSettings } from '../data/automation-settings.js';
import { activeSitePlan } from './site-plan-model.js';
import {
  freshMakerMaterials,
  isMakerDeliveryEvent,
  makerRunFromMaterials,
  makerRunPatchForEvent,
} from './maker-events.js';

export { freshMakerMaterials, isMakerDeliveryEvent, makerRunFromMaterials };

/** True while development.makerEvents is `record` (default `off`). */
export function makerEventsRecording(settings = null) {
  try {
    const resolved = settings || getAutomationSettings();
    return resolved?.development?.makerEvents === 'record';
  } catch {
    return false;
  }
}

/** Clients whose delivery is under way: signed website clients and clients with a plan in force. */
function inDelivery(client) {
  if (String(client?.product || '').toLowerCase() === 'ssu') return false;
  return client?.progression?.contractSigned === true || Boolean(activeSitePlan(client));
}

/**
 * Stores one delivery event on the client's makerRun and, for clients in delivery, marks the client
 * for a gate re-check (delivery.dirtyAt). Leads get no delivery record. `runId` is the run the
 * callback was checked against. `sales` is the data module (setSalesMakerRunOwned,
 * setSalesDelivery). Returns the callback's JSON body.
 */
export function recordMakerDeliveryEvent({ event, body = {}, client, sales, runId = '', now = new Date().toISOString() } = {}) {
  if (!isMakerDeliveryEvent(event)) return { ok: true, event, ignored: true, reason: 'not-a-delivery-event' };
  const patch = makerRunPatchForEvent(event, body, { now, runId });
  if (!patch) return { ok: true, event, ignored: true, reason: 'empty-payload' };
  const updated = sales.setSalesMakerRunOwned(client.id, patch);
  if (!updated) return { ok: false, event, reason: 'client-not-found' };
  if (inDelivery(updated)) sales.setSalesDelivery(client.id, { dirtyAt: now });
  return { ok: true, event, recorded: Object.keys(patch) };
}

/**
 * The run fetch for the workshop need-list and the material dots: the live Maker run first (it has
 * the answers); when that fetch fails and development.makerEvents is `record`, a materials snapshot
 * of the linked run younger than 24 h stands in for it. `liveFetch(runId, row)` returns
 * {run} or {failed:true}.
 */
export function makerRunFetchWithMaterials(client, liveFetch, { recording = null, nowMs = null } = {}) {
  return async (runId, row) => {
    let result;
    try {
      result = await liveFetch(runId, row);
    } catch {
      result = { failed: true };
    }
    if (result && !result.failed) return result;
    const on = recording === null ? makerEventsRecording() : recording;
    const snapshot = on ? freshMakerMaterials(client?.makerRun, nowMs ?? Date.now()) : null;
    return snapshot ? { run: makerRunFromMaterials(snapshot) } : result;
  };
}
