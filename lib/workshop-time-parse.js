import { osloCalendarYmd, osloWallToIso } from './website-due.js';

const WEEKDAYS = {
  sondag: 0,
  søndag: 0,
  mandag: 1,
  tirsdag: 2,
  onsdag: 3,
  torsdag: 4,
  fredag: 5,
  lordag: 6,
  lørdag: 6,
};

function compact(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function addDaysYmd(ymd = '', days = 0) {
  const date = new Date(`${ymd}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

function osloWeekday(ymd = '') {
  const iso = osloWallToIso(ymd, 12, 0, 0);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return -1;
  return new Date(ms).getUTCDay();
}

function nextWeekdayYmd(fromYmd = '', weekday = 1, { nextWeek = false } = {}) {
  let ymd = fromYmd;
  const todayWeekday = osloWeekday(ymd);
  if (nextWeek) {
    // "onsdag neste uke" = that weekday in the next Monday–Sunday week, not "next one + 7".
    const toMonday = ((1 - todayWeekday + 7) % 7) || 7;
    return addDaysYmd(ymd, toMonday + ((Number(weekday) + 6) % 7));
  }
  let delta = (Number(weekday) - todayWeekday + 7) % 7;
  if (delta === 0) delta = 7;
  return addDaysYmd(ymd, delta);
}

export function looksLikeWorkshopScheduling(text = '') {
  const blob = compact(text).toLowerCase();
  if (!blob) return false;
  if (/\b(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag|kl\.?\s*\d{1,2})\b/.test(blob)) return true;
  return /workshop|workshopen|tidspunkt|passer det|kan vi ta|booke møte|møtetid/.test(blob);
}

export function looksLikeCallFollowup(text = '') {
  const blob = compact(text).toLowerCase();
  return /ringe meg|ring meg|kan dere ringe|ta en telefon|avtale nærmere|ikke helt vet|vet ikke helt|usikker på tid/.test(blob);
}

export function looksLikeMeetingMove(text = '') {
  const blob = compact(text).toLowerCase();
  return /kan ikke|klar(er)? ikke|må flytte|passer ikke|annen (dag|tid)|utsatt|avlyse/.test(blob)
    || looksLikeWorkshopScheduling(blob);
}

/** Weekday (and optional morgen/ettermiddag) without a clock. */
export function parseDayHint(text = '', { now = new Date() } = {}) {
  const blob = compact(text).toLowerCase();
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const origin = Number.isFinite(nowMs) ? new Date(nowMs) : new Date();
  const todayYmd = osloCalendarYmd(origin.toISOString());
  const wd = blob.match(/\b(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\b/);
  if (wd) {
    const weekday = WEEKDAYS[wd[1]];
    if (weekday == null) return null;
    const ymd = nextWeekdayYmd(todayYmd, weekday, { nextWeek: /\bneste uke\b/i.test(blob) });
    const band = /morgen/.test(blob) ? 'morning' : /ettermiddag|ettermiddagen/.test(blob) ? 'afternoon' : 'day';
    return ymd ? { ymd, band } : null;
  }
  const rel = blob.match(/\bom\s+(\d+)\s+dager?\b/);
  if (rel) {
    const days = Number(rel[1]);
    if (!Number.isFinite(days) || days < 1 || days > 60) return null;
    const ymd = addDaysYmd(todayYmd, days);
    return ymd ? { ymd, band: 'day' } : null;
  }
  if (/\bi overmorgen\b/.test(blob)) {
    const ymd = addDaysYmd(todayYmd, 2);
    return ymd ? { ymd, band: 'day' } : null;
  }
  if (/\bi morgen\b/.test(blob)) {
    const ymd = addDaysYmd(todayYmd, 1);
    return ymd ? { ymd, band: 'day' } : null;
  }
  return null;
}

/**
 * Pull an Oslo workshop datetime from free text. Requires a clock time.
 * Returns { dueAt, confidence } or null.
 */
export function parseWorkshopTimeHeuristic(text = '', { now = new Date() } = {}) {
  const blob = compact(text);
  if (!blob) return null;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const origin = Number.isFinite(nowMs) ? new Date(nowMs) : new Date();
  const todayYmd = osloCalendarYmd(origin.toISOString());

  const iso = blob.match(/\b(20\d{2}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})\b/);
  if (iso) {
    const dueAt = osloWallToIso(iso[1], Number(iso[2]), Number(iso[3]), 0);
    if (dueAt) return { dueAt, confidence: 0.95 };
  }

  const dmy = blob.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s*(?:kl\.?\s*)?(\d{1,2})(?:[:.](\d{2}))?\b/i);
  if (dmy) {
    const yearRaw = dmy[3] ? Number(dmy[3]) : Number(todayYmd.slice(0, 4));
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const ymd = `${year}-${pad2(dmy[2])}-${pad2(dmy[1])}`;
    const dueAt = osloWallToIso(ymd, Number(dmy[4]), Number(dmy[5] || 0), 0);
    if (dueAt) return { dueAt, confidence: 0.9 };
  }

  const nextWeek = /\bneste uke\b/i.test(blob);
  const wd = blob.match(/\b(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\b(?:[^.\n]{0,40}?)(?:kl\.?\s*)?\b(\d{1,2})(?:[:.](\d{2}))?\b/i);
  if (wd) {
    const weekday = WEEKDAYS[wd[1].toLowerCase()];
    if (weekday == null) return null;
    const hour = Number(wd[2]);
    if (!Number.isFinite(hour) || hour < 6 || hour > 22) return null;
    const minute = Number(wd[3] || 0);
    const ymd = nextWeekdayYmd(todayYmd, weekday, { nextWeek });
    const dueAt = osloWallToIso(ymd, hour, minute, 0);
    if (dueAt) return { dueAt, confidence: nextWeek ? 0.8 : 0.85 };
  }

  return null;
}

export function resolveInboxWorkshopDueAt(text = '', claimedDueAt = '', { now } = {}) {
  const parsed = parseWorkshopTimeHeuristic(text, { now });
  if (parsed?.dueAt) return parsed.dueAt;
  const claimed = compact(claimedDueAt);
  if (!claimed || Number.isNaN(Date.parse(claimed))) return '';
  if (!looksLikeWorkshopScheduling(text)) return '';
  return claimed;
}
