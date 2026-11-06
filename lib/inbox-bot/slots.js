import { osloCalendarYmd, osloWallToIso } from '../website-due.js';

const HOURS = {
  morning: [9, 10, 11],
  afternoon: [13, 14, 15],
  day: [9, 10, 11, 13, 14, 15],
};

export function slotIsFree(dueAt, durationMin, busy = []) {
  const start = Date.parse(dueAt);
  const end = start + Number(durationMin) * 60 * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return !(Array.isArray(busy) ? busy : []).some((block) => {
    const from = Date.parse(block?.start);
    const to = Date.parse(block?.end);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    return from < end && to > start;
  });
}

/** Bookable hours for a client-named start: weekdays, 08:00 to 17:00 Oslo. */
export function withinMeetingHours(dueAt = '') {
  const ms = Date.parse(dueAt);
  if (!Number.isFinite(ms)) return false;
  const date = new Date(ms);
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Europe/Oslo' }).format(date);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Oslo' }).format(date));
  const minute = Number(new Intl.DateTimeFormat('en-GB', { minute: '2-digit', timeZone: 'Europe/Oslo' }).format(date));
  return hour >= 8 && (hour < 17 || (hour === 17 && minute === 0));
}

/** Saturday or Sunday in Oslo. */
export function isWeekendYmd(ymd = '') {
  const noon = osloWallToIso(ymd, 12, 0, 0);
  if (!noon) return false;
  const weekday = new Date(noon).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function pickFreeSlots({
  ymd,
  band = 'day',
  afterHour = null,
  durationMin = 30,
  busy = [],
  count = 3,
  now = new Date(),
} = {}) {
  const earliest = Number(afterHour);
  const hours = (HOURS[band] || HOURS.day).filter((hour) => !Number.isFinite(earliest) || afterHour == null || hour >= earliest);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  // Never a Saturday or Sunday, even when the client names one; the caller falls back to weekdays.
  if (isWeekendYmd(ymd)) return [];
  const out = [];
  for (const hour of hours) {
    const dueAt = osloWallToIso(ymd, hour, 0, 0);
    if (!dueAt || Date.parse(dueAt) <= nowMs) continue;
    if (!slotIsFree(dueAt, durationMin, busy)) continue;
    out.push(dueAt);
    if (out.length >= count) break;
  }
  return out;
}

function addUtcDaysYmd(ymd = '', days = 1) {
  const date = new Date(`${ymd}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

/**
 * Soonest sensible weekday slots, one per day (skips Sat/Sun).
 * startInDays 2 = the preview can be ready and the client has seen the mail; a client-named day still books earlier.
 */
export function pickFreeSlotsAhead({
  now = new Date(),
  band = 'day',
  durationMin = 60,
  busy = [],
  count = 3,
  days = 8,
  startInDays = 2,
  excludeYmds = [],
} = {}) {
  const origin = now instanceof Date ? now : new Date(now);
  const todayYmd = osloCalendarYmd(Number.isNaN(origin.getTime()) ? new Date().toISOString() : origin.toISOString());
  const excluded = new Set(Array.isArray(excludeYmds) ? excludeYmds : []);
  const weekdays = [];
  for (let i = startInDays; i < startInDays + days; i += 1) {
    const ymd = addUtcDaysYmd(todayYmd, i);
    if (!ymd) break;
    const noon = osloWallToIso(ymd, 12, 0, 0);
    const weekday = noon ? new Date(noon).getUTCDay() : -1;
    if (weekday !== 0 && weekday !== 6 && !excluded.has(ymd)) weekdays.push(ymd);
  }
  const free = weekdays.map((ymd) => pickFreeSlots({ ymd, band, durationMin, busy, count, now: origin }));
  // One per day first so the client gets a spread; only a fully booked week doubles up.
  const out = free.map((daySlots) => daySlots[0]).filter(Boolean).slice(0, count);
  for (const iso of free.flat()) {
    if (out.length >= count) break;
    if (!out.includes(iso)) out.push(iso);
  }
  return out.sort();
}

export function formatSlotListNb(slots = []) {
  return slots.map((iso) => new Intl.DateTimeFormat('nb-NO', {
    timeZone: 'Europe/Oslo',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))).join(', ');
}
