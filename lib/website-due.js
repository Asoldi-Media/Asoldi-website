/**
 * Website delivery clock.
 * Tier 1 and 2 are 14 work days, tier 3 is 21 work days.
 * Work days are Monday–Friday in Europe/Oslo. The signed calendar day is not counted.
 * An admin date override replaces the package clock and must not be Saturday or Sunday.
 */

import { CUSTOM_TIER_ID, isCustomTierId, resolveTier, workDaysFromDeliveryWeeks } from './website-tiers.js';

const MONTHS_NB = ['jan.', 'feb.', 'mars', 'apr.', 'mai', 'juni', 'juli', 'aug.', 'sep.', 'okt.', 'nov.', 'des.'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WORK_DAY_TZ = 'Europe/Oslo';
const LEGACY_WEEK_COUNTS = new Set([2, 3, 4]);

export function normalizeDueDate(value = '') {
  const match = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function osloCalendarYmd(value = '') {
  const day = normalizeDueDate(value);
  if (day) return day;
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_DAY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function utcNoonWeekday(ymd = '') {
  const day = normalizeDueDate(ymd);
  if (!day) return -1;
  return new Date(`${day}T12:00:00.000Z`).getUTCDay();
}

export function isWeekendDueDate(value = '') {
  const day = normalizeDueDate(value) || osloCalendarYmd(value);
  const weekday = utcNoonWeekday(day);
  return weekday === 0 || weekday === 6;
}

export function weekendDueDateMessage(value = '') {
  const day = normalizeDueDate(value);
  if (!day) return '';
  if (!isWeekendDueDate(day)) return '';
  return 'Leveringsfrist kan ikke være lørdag eller søndag.';
}

function addCalendarDaysYmd(ymd = '', days = 1) {
  const date = new Date(`${normalizeDueDate(ymd)}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

/**
 * Advance n Monday–Friday days after the Oslo calendar day of `iso`.
 * The start day itself is not counted. The result is never Saturday or Sunday.
 */
export function addWorkDays(iso = '', days = 0) {
  const start = osloCalendarYmd(iso);
  const count = Math.round(Number(days));
  if (!start || !Number.isFinite(count) || count <= 0) return '';
  let ymd = start;
  let added = 0;
  while (added < count) {
    ymd = addCalendarDaysYmd(ymd, 1);
    const weekday = utcNoonWeekday(ymd);
    if (weekday !== 0 && weekday !== 6) added += 1;
  }
  return `${ymd}T12:00:00.000Z`;
}

function workDaysForTierId(tierId = '') {
  const tier = resolveTier(tierId);
  if (!tier) return 0;
  if (tier.tierNumber >= 3) return 21;
  if (tier.tierNumber >= 1) return 14;
  return 0;
}

function legacyWeeksToWorkDays(weeks = 0) {
  const count = Math.round(Number(weeks) || 0);
  if (LEGACY_WEEK_COUNTS.has(count)) return count * 5;
  return count > 0 ? count : 0;
}

export function deliveryWeeksForOffer({ tierId = '', products = [] } = {}) {
  const list = Array.isArray(products) ? products : [];
  const fromProducts = list.reduce((max, item) => Math.max(max, Number(item?.deliveryWeeks) || 0), 0);
  if (fromProducts > 0) return fromProducts;
  const tier = resolveTier(tierId);
  if (tier?.deliveryWeeks) return tier.deliveryWeeks;
  if (isCustomTierId(tierId) || list.some((item) => item?.kind === 'custom')) return 4;
  return 0;
}

export function deliveryWorkDaysForOffer({ tierId = '', products = [] } = {}) {
  const list = Array.isArray(products) ? products : [];
  const fromWorkDays = list.reduce((max, item) => Math.max(max, Number(item?.deliveryWorkDays) || 0), 0);
  if (fromWorkDays > 0) return fromWorkDays;
  const custom = isCustomWebsiteOffer({ tierId, products });
  if (custom) {
    const fromWeeks = list.reduce((max, item) => Math.max(max, Number(item?.deliveryWeeks) || 0), 0);
    if (fromWeeks > 0) return legacyWeeksToWorkDays(fromWeeks);
    return 20;
  }
  return workDaysForTierId(tierId);
}

export function isCustomWebsiteOffer({ tierId = '', products = [] } = {}) {
  const list = Array.isArray(products) ? products : [];
  return isCustomTierId(tierId) || list.some((item) => item?.kind === 'custom');
}

/**
 * Developer / admin clock. Custom with no date does not start a countdown.
 * Offer emails still use deliveryWorkDaysForOffer (20 for a custom with no count).
 */
export function workDaysForDeveloperBoard({ tierId = '', products = [], dueOverride = '' } = {}) {
  if (isCustomWebsiteOffer({ tierId, products }) && !normalizeDueDate(dueOverride)) return 0;
  return deliveryWorkDaysForOffer({ tierId, products });
}

/** @deprecated use workDaysForDeveloperBoard — kept so callers that still pass `weeks` into resolveWebsiteDue get work days. */
export function weeksForDeveloperBoard(args = {}) {
  return workDaysForDeveloperBoard(args);
}

export function addWeeks(iso = '', weeks = 0) {
  const ms = Date.parse(String(iso || ''));
  const count = Number(weeks);
  if (!Number.isFinite(ms) || !(count > 0)) return '';
  const date = new Date(ms);
  date.setUTCDate(date.getUTCDate() + Math.round(count) * 7);
  return date.toISOString();
}

function dateParts(value = '') {
  const raw = String(value || '').trim();
  const day = normalizeDueDate(raw) || osloCalendarYmd(raw);
  const ms = Date.parse(day ? `${day}T12:00:00Z` : raw);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth(),
    year: date.getUTCFullYear(),
  };
}

/** UTC calendar day of a dueAt / ISO value, same day as formatDueDateNb. */
export function dueDateDay(value = '') {
  const parts = dateParts(value);
  if (!parts) return '';
  return `${parts.year}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function formatDueDateNb(value = '') {
  const parts = dateParts(value);
  if (!parts) return '';
  return `${parts.day}. ${MONTHS_NB[parts.month]} ${parts.year}`;
}

export function formatDueDateEn(value = '') {
  const parts = dateParts(value);
  if (!parts) return '';
  return `${parts.day} ${MONTHS_EN[parts.month]} ${parts.year}`;
}

function resolveWorkDayCount({ workDays = 0, weeks = 0, tierId = '', products = [] } = {}) {
  const fromWork = Math.round(Number(workDays) || 0);
  if (fromWork > 0) return fromWork;
  if (tierId || (Array.isArray(products) && products.length)) {
    const fromOffer = deliveryWorkDaysForOffer({ tierId, products });
    if (fromOffer > 0) return fromOffer;
  }
  return workDaysFromDeliveryWeeks(weeks);
}

export function offerDeliveryPhraseNb({
  tierId = '',
  products = [],
  dueDate = '',
  workDays = 0,
} = {}) {
  const date = normalizeDueDate(dueDate);
  if (date) return formatDueDateNb(date);
  const days = resolveWorkDayCount({ workDays, tierId, products });
  if (!days) return 'avtales ved signert kontrakt';
  return `${days} arbeidsdager fra signert kontrakt`;
}

export function contractDeliverySentence({
  weeks = 0,
  workDays = 0,
  dueDate = '',
  tierId = '',
  products = [],
} = {}) {
  const date = normalizeDueDate(dueDate);
  if (date) return `Delivery date: ${formatDueDateEn(date)}.`;
  const days = resolveWorkDayCount({ workDays, weeks, tierId, products });
  const safe = days > 0 ? days : 20;
  return `Delivery time: ${safe} working days from the signed contract.`;
}

export function resolveWebsiteDue({
  contractSigned = false,
  contractSignedAt = '',
  dueOverride = '',
  weeks = 0,
  workDays = 0,
  tierId = '',
  products = [],
} = {}) {
  const override = normalizeDueDate(dueOverride);
  const signed = Boolean(contractSigned);
  const signedAt = String(contractSignedAt || '').trim();
  const count = resolveWorkDayCount({ workDays, weeks, tierId, products });
  const duration = count ? `${count} arbeidsdager fra signert kontrakt` : '';

  if (override) {
    return {
      started: true,
      dueAt: `${override}T12:00:00.000Z`,
      weeks: count,
      workDays: count,
      override: true,
      label: `Frist: ${formatDueDateNb(override)}`,
    };
  }
  if (signed && signedAt && count) {
    const dueAt = addWorkDays(signedAt, count);
    return {
      started: true,
      dueAt,
      weeks: count,
      workDays: count,
      override: false,
      label: dueAt ? `Frist: ${formatDueDateNb(dueAt)}` : 'Kontrakt signert',
    };
  }
  if (!signed && duration) {
    return {
      started: false,
      dueAt: '',
      weeks: count,
      workDays: count,
      override: false,
      label: `Frist: ${duration}`,
    };
  }
  if (signed) {
    return {
      started: false,
      dueAt: '',
      weeks: count,
      workDays: count,
      override: false,
      label: 'Kontrakt signert · sett leveringsfrist',
    };
  }
  return {
    started: false,
    dueAt: '',
    weeks: 0,
    workDays: 0,
    override: false,
    label: 'Ingen frist ennå',
  };
}

function osloDateTimeParts(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: WORK_DAY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return map;
}

function isoFromOsloWall(ymd = '', hour = 12, minute = 0, second = 0) {
  const day = normalizeDueDate(ymd);
  if (!day) return '';
  let guess = Date.parse(`${day}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.000Z`);
  if (!Number.isFinite(guess)) return `${day}T12:00:00.000Z`;
  for (let i = 0; i < 6; i += 1) {
    const parts = osloDateTimeParts(guess);
    const gotDay = `${parts.year}-${parts.month}-${parts.day}`;
    const dayDelta = Date.parse(`${day}T12:00:00.000Z`) - Date.parse(`${gotDay}T12:00:00.000Z`);
    const timeDelta = (Number(hour) - Number(parts.hour)) * 3600000
      + (Number(minute) - Number(parts.minute)) * 60000
      + (Number(second) - Number(parts.second)) * 1000;
    const next = guess + dayDelta + timeDelta;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

export function isIsoAfterDueDate(iso = '', dueAtOrYmd = '') {
  const actionDay = osloCalendarYmd(iso);
  const dueDay = normalizeDueDate(dueAtOrYmd) || osloCalendarYmd(dueAtOrYmd);
  if (!actionDay || !dueDay) return false;
  return actionDay > dueDay;
}

export function osloWallToIso(ymd = '', hour = 12, minute = 0, second = 0) {
  return isoFromOsloWall(ymd, hour, minute, second);
}

export function clampIsoToDueDate(iso = '', dueAtOrYmd = '') {
  const dueDay = normalizeDueDate(dueAtOrYmd) || osloCalendarYmd(dueAtOrYmd);
  if (!dueDay) return String(iso || '');
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return `${dueDay}T12:00:00.000Z`;
  if (!isIsoAfterDueDate(iso, dueDay)) return new Date(ms).toISOString();
  const parts = osloDateTimeParts(ms);
  return isoFromOsloWall(dueDay, Number(parts.hour), Number(parts.minute), Number(parts.second));
}

export { CUSTOM_TIER_ID };
