import { isoToDatetimeLocalOslo } from './sales-next-actions.js';

/** Keep a full Oslo datetime so the year is already written in the time field. */
export function defaultActionDateTimeLocal(value = '', nowMs = Date.now()) {
  return isoToDatetimeLocalOslo(value) || isoToDatetimeLocalOslo(new Date(nowMs).toISOString());
}
