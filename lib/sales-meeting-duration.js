/** Client-facing meeting length. Calendar blocks may be longer so slots do not sit back-to-back. */
export const CLIENT_MEETING_DURATION_MINUTES = 30;
export const ONLINE_CALENDAR_DURATION_MINUTES = 60;
export const IN_PERSON_CALENDAR_DURATION_MINUTES = 30;

export function calendarDurationForMode(mode = '') {
  const raw = String(mode || '').toLowerCase();
  if (raw === 'online') return ONLINE_CALENDAR_DURATION_MINUTES;
  return IN_PERSON_CALENDAR_DURATION_MINUTES;
}
