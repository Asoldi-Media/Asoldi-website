// Hub side of the Maker delivery events (WS8.28): the switch and the recorder used by the status
// callback in server.js. The payload rules live in lib/maker-events.js (pure).
import { getAutomationSettings } from '../data/automation-settings.js';
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

/**
 * Stores one delivery event on the client's makerRun and marks the client for a gate re-check
 * (delivery.dirtyAt). `sales` is the data module (setSalesMakerRunOwned, setSalesDelivery).
 * Returns the callback's JSON body.
 */
export function recordMakerDeliveryEvent({ event, body = {}, client, sales, now = new Date().toISOString() } = {}) {
  if (!isMakerDeliveryEvent(event)) return { ok: true, event, ignored: true, reason: 'not-a-delivery-event' };
  const patch = makerRunPatchForEvent(event, body, { now });
  if (!patch) return { ok: true, event, ignored: true, reason: 'empty-payload' };
  const updated = sales.setSalesMakerRunOwned(client.id, patch);
  if (!updated) return { ok: false, event, reason: 'client-not-found' };
  if (String(updated.product || '') !== 'ssu') sales.setSalesDelivery(client.id, { dirtyAt: now });
  return { ok: true, event, recorded: Object.keys(patch) };
}
