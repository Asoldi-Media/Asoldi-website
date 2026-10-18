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

export function pickFreeSlots({
  ymd,
  band = 'day',
  durationMin = 30,
  busy = [],
  count = 3,
  now = new Date(),
} = {}) {
  const hours = HOURS[band] || HOURS.day;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
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
} = {}) {
  const origin = now instanceof Date ? now : new Date(now);
  const todayYmd = osloCalendarYmd(Number.isNaN(origin.getTime()) ? new Date().toISOString() : origin.toISOString());
  const weekdays = [];
  for (let i = startInDays; i < startInDays + days; i += 1) {
    const ymd = addUtcDaysYmd(todayYmd, i);
    if (!ymd) break;
    const noon = osloWallToIso(ymd, 12, 0, 0);
    const weekday = noon ? new Date(noon).getUTCDay() : -1;
    if (weekday !== 0 && weekday !== 6) weekdays.push(ymd);
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
