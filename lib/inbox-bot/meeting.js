import * as sales from '../../data/sales.js';

/** The booked sales meeting row the rep moves in the panel. */
export function openMeetingRow(client = {}) {
  return (Array.isArray(client?.nextActions) ? client.nextActions : [])
    .find((row) => row?.presetKey === 'meeting' && !row?.doneAt) || null;
}

/** The meeting the card actually holds: nothing once the time is no longer agreed. */
export function bookedMeetingAt(client = {}) {
  if (!client?.agreedTime) return '';
  const at = String(openMeetingRow(client)?.dueAt || client.meetingAt || '');
  return Number.isFinite(Date.parse(at)) ? at : '';
}

function joinNote(previous = '', next = '') {
  return [String(previous || '').trim(), String(next || '').trim()].filter(Boolean).join('\n');
}

/**
 * Data-only move for tests and scripts: the server injects `moveMeeting` with the full rep chain
 * (calendar invite, confirmation mail). Either way the reminder clock follows the new time.
 */
export async function defaultMoveMeeting(client, dueAt, { note = '' } = {}) {
  const row = openMeetingRow(client);
  if (!row?.id) return { ok: false, client, confirmationSent: false, error: 'no-meeting-row' };
  try {
    sales.setSalesNextAction(client.id, { op: 'update', id: row.id, dueAt, note: joinNote(row.note, note) });
    const updated = sales.rescheduleSalesReminders(client.id, Date.now());
    return { ok: true, client: updated || sales.getSalesClientById(client.id), confirmationSent: false, error: '' };
  } catch (error) {
    return { ok: false, client, confirmationSent: false, error: String(error?.message || error) };
  }
}

/** Data-only void: no time agreed, reminders and calendar fields cleared, the Google event left to the server hook. */
export async function defaultVoidMeeting(client, { note = '' } = {}) {
  if (typeof sales.voidSalesMeetingTime !== 'function') {
    return { ok: false, client, error: 'void-unavailable' };
  }
  try {
    const updated = sales.voidSalesMeetingTime(client.id, { note });
    return { ok: Boolean(updated), client: updated || client, error: updated ? '' : 'void-failed' };
  } catch (error) {
    return { ok: false, client, error: String(error?.message || error) };
  }
}
