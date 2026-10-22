import { isoToDatetimeLocalOslo } from './sales-next-actions.js';

/** Keep a full Oslo datetime so the year is already written in the time field. */
export function defaultActionDateTimeLocal(value = '', nowMs = Date.now(), options = {}) {
  const filled = isoToDatetimeLocalOslo(value);
  if (filled) return filled;
  if (options.allowEmpty) return '';
  return isoToDatetimeLocalOslo(new Date(nowMs).toISOString());
}
