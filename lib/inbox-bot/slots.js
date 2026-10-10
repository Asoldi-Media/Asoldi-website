import { osloWallToIso } from '../website-due.js';

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
