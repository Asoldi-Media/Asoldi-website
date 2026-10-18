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

/** Next weekday slots across several days (skips Sat/Sun). Used when the client cancelled with no new clock. */
export function pickFreeSlotsAhead({
  now = new Date(),
  band = 'day',
  durationMin = 60,
  busy = [],
  count = 3,
  days = 8,
} = {}) {
  const origin = now instanceof Date ? now : new Date(now);
  let ymd = osloCalendarYmd(Number.isNaN(origin.getTime()) ? new Date().toISOString() : origin.toISOString());
  const out = [];
  for (let i = 0; i < days && out.length < count; i += 1) {
    if (i > 0) ymd = addUtcDaysYmd(ymd, 1);
    if (!ymd) break;
    const noon = osloWallToIso(ymd, 12, 0, 0);
    const weekday = noon ? new Date(noon).getUTCDay() : -1;
    if (weekday === 0 || weekday === 6) continue;
    out.push(...pickFreeSlots({
      ymd,
      band,
      durationMin,
      busy,
      count: count - out.length,
      now: origin,
    }));
  }
  return out;
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
