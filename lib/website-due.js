/**
 * Website delivery clock.
 * Tier 1 and 2 are 2 weeks, tier 3 is 3 weeks, a custom offer with no week count is 4 weeks.
 * The calendar date starts when sales marks the contract signed, or immediately when admin sets a date.
 */

import { CUSTOM_TIER_ID, isCustomTierId, resolveTier } from './website-tiers.js';

const MONTHS_NB = ['jan.', 'feb.', 'mars', 'apr.', 'mai', 'juni', 'juli', 'aug.', 'sep.', 'okt.', 'nov.', 'des.'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

export function deliveryWeeksForOffer({ tierId = '', products = [] } = {}) {
  const list = Array.isArray(products) ? products : [];
  const fromProducts = list.reduce((max, item) => Math.max(max, Number(item?.deliveryWeeks) || 0), 0);
  if (fromProducts > 0) return fromProducts;
  const tier = resolveTier(tierId);
  if (tier?.deliveryWeeks) return tier.deliveryWeeks;
  if (isCustomTierId(tierId) || list.some((item) => item?.kind === 'custom')) return 4;
  return 0;
}

export function isCustomWebsiteOffer({ tierId = '', products = [] } = {}) {
  const list = Array.isArray(products) ? products : [];
  return isCustomTierId(tierId) || list.some((item) => item?.kind === 'custom');
}

/**
 * Developer board clock. Tier 1 and 2 stay 2 weeks, tier 3 stays 3 weeks.
 * A custom offer does not start the 4-week fallback here; admin sets the date.
 * Offer emails and contracts still use deliveryWeeksForOffer.
 */
export function weeksForDeveloperBoard({ tierId = '', products = [], dueOverride = '' } = {}) {
  if (isCustomWebsiteOffer({ tierId, products }) && !normalizeDueDate(dueOverride)) return 0;
  return deliveryWeeksForOffer({ tierId, products });
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
  const day = normalizeDueDate(raw);
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

export function offerDeliveryPhraseNb({ tierId = '', products = [], dueDate = '' } = {}) {
  const date = normalizeDueDate(dueDate);
  if (date) return formatDueDateNb(date);
  const weeks = deliveryWeeksForOffer({ tierId, products });
  if (!weeks) return 'avtales ved signert kontrakt';
  return `${weeks} uker fra signert kontrakt`;
}

export function contractDeliverySentence({ weeks = 0, dueDate = '', tierId = '', products = [] } = {}) {
  const date = normalizeDueDate(dueDate);
  if (date) return `Delivery date: ${formatDueDateEn(date)}.`;
  const count = Number(weeks) > 0 ? Math.round(Number(weeks)) : deliveryWeeksForOffer({ tierId, products });
  const safe = count > 0 ? count : 4;
  return `Delivery time: ${safe} weeks from the signed contract.`;
}

export function resolveWebsiteDue({
  contractSigned = false,
  contractSignedAt = '',
  dueOverride = '',
  weeks = 0,
} = {}) {
  const override = normalizeDueDate(dueOverride);
  const signed = Boolean(contractSigned);
  const signedAt = String(contractSignedAt || '').trim();
  const count = Number(weeks) > 0 ? Math.round(Number(weeks)) : 0;
  const duration = count ? `${count} uker fra signert kontrakt` : '';

  if (override) {
    return {
      started: true,
      dueAt: `${override}T12:00:00.000Z`,
      weeks: count,
      override: true,
      label: `Frist: ${formatDueDateNb(override)}`,
    };
  }
  if (signed && signedAt && count) {
    const dueAt = addWeeks(signedAt, count);
    return {
      started: true,
      dueAt,
      weeks: count,
      override: false,
      label: dueAt ? `Frist: ${formatDueDateNb(dueAt)}` : 'Kontrakt signert',
    };
  }
  if (!signed && duration) {
    return {
      started: false,
      dueAt: '',
      weeks: count,
      override: false,
      label: `Frist: ${duration}`,
    };
  }
  if (signed) {
    return {
      started: false,
      dueAt: '',
      weeks: count,
      override: false,
      label: 'Kontrakt signert · sett leveringsfrist',
    };
  }
  return {
    started: false,
    dueAt: '',
    weeks: 0,
    override: false,
    label: 'Ingen frist ennå',
  };
}

export { CUSTOM_TIER_ID };
