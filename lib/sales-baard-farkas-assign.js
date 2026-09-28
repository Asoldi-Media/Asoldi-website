import { salesBookingFacts } from './sales-booking-facts.js';
import { MYPHONER_ADMIN_OWNER_KEY } from './myphoner-sales-owner.js';

export const BAARD_BOOKER_EMAIL = 'baard.fransson@gmail.com';
export const ALEXANDER_USERNAME = 'alexander@asoldi.com';
export const DAMIAN_USERNAME = 'damian@asoldi.com';
/** Exclusive: booked before this Oslo calendar date (11.08.2026). */
export const BAARD_FARKAS_CUTOFF_YMD = '2026-08-11';

function text(value = '') {
  return String(value ?? '').trim();
}

function emailOf(value = '') {
  return text(value).toLowerCase();
}

function zonedYmd(ms, timeZone = 'Europe/Oslo') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function zonedDateTimeToUtcMs(year, month, day, hour, minute, timeZone = 'Europe/Oslo') {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcGuess))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return utcGuess - (asIfUtc - utcGuess);
}

export function baardFarkasCutoffMs(ymd = BAARD_FARKAS_CUTOFF_YMD) {
  const [year, month, day] = String(ymd).split('-').map((part) => Number(part));
  return zonedDateTimeToUtcMs(year, month, day, 0, 0);
}

export function salesOwnerKeyForUser(user = {}) {
  const id = text(user?.id);
  return id ? `sales:${id}` : '';
}

export function ownerKeysForUser(user = {}) {
  const keys = new Set();
  const idKey = salesOwnerKeyForUser(user);
  if (idKey) keys.add(idKey);
  const username = text(user?.username);
  if (username) {
    keys.add(`sales:${username}`);
    keys.add(`admin:${username}`);
    keys.add(`admin:${emailOf(username)}`);
  }
  return keys;
}

function looksLikeAlexander(user = {}) {
  const username = emailOf(user?.username);
  const name = text(user?.name).toLowerCase();
  if (username === ALEXANDER_USERNAME) return true;
  if (username.startsWith('alexander@')) return true;
  return /alexander/.test(name) && /farka+s/.test(name);
}

function looksLikeDamian(user = {}) {
  return emailOf(user?.username) === DAMIAN_USERNAME;
}

export function findAlexanderSalesUser(users = []) {
  const sales = (Array.isArray(users) ? users : []).filter((user) => text(user?.role).toLowerCase() === 'sales');
  return sales.find((user) => looksLikeAlexander(user)) || null;
}

export function findDamianOwnerUser(users = []) {
  const list = Array.isArray(users) ? users : [];
  const sales = list.find((user) => text(user?.role).toLowerCase() === 'sales' && looksLikeDamian(user));
  if (sales) return sales;
  return list.find((user) => looksLikeDamian(user)) || null;
}

export function damianOwnerKey(users = []) {
  const user = findDamianOwnerUser(users);
  if (user && text(user.role).toLowerCase() === 'sales') return salesOwnerKeyForUser(user);
  if (user?.username) return `admin:${text(user.username)}`;
  return MYPHONER_ADMIN_OWNER_KEY;
}

export function isBaardBooker(client = {}) {
  const my = client?.myphoner && typeof client.myphoner === 'object' ? client.myphoner : {};
  const emails = [
    emailOf(my.bookedByEmail),
    emailOf(my.latestCallUserEmail),
  ].filter(Boolean);
  if (emails.length) return emails.includes(BAARD_BOOKER_EMAIL);
  const name = text(my.bookedByName).toLowerCase();
  return name.includes('bård') || name.includes('baard');
}

export function bookingTimeMs(client = {}) {
  const facts = salesBookingFacts(client);
  const parsed = Date.parse(facts.bookedAt || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function isBaardLeadBeforeCutoff(client = {}, cutoffMs = baardFarkasCutoffMs()) {
  if (!isBaardBooker(client)) return false;
  const booked = bookingTimeMs(client);
  if (booked == null) return false;
  return booked < cutoffMs;
}

export function planBaardFarkasReassign(clients = [], users = [], cutoffMs = baardFarkasCutoffMs()) {
  const alexander = findAlexanderSalesUser(users);
  if (!alexander) {
    return { error: 'Fant ikke sales-brukeren Alexander Farkas (alexander@asoldi.com) i admin Users.' };
  }
  const alexanderKey = salesOwnerKeyForUser(alexander);
  if (!alexanderKey) {
    return { error: 'Alexander Farkas mangler bruker-id.' };
  }
  const alexanderKeys = ownerKeysForUser(alexander);
  const damianKey = damianOwnerKey(users);
  const toAlexander = [];
  const toDamian = [];

  for (const client of Array.isArray(clients) ? clients : []) {
    const ownerId = text(client?.ownerId);
    const keepOnAlexander = isBaardLeadBeforeCutoff(client, cutoffMs);
    if (keepOnAlexander) {
      if (ownerId !== alexanderKey) {
        toAlexander.push({
          id: text(client.id),
          businessName: text(client.businessName),
          fromOwnerId: ownerId,
          toOwnerId: alexanderKey,
          bookedAt: salesBookingFacts(client).bookedAt,
        });
      }
      continue;
    }
    if (alexanderKeys.has(ownerId)) {
      toDamian.push({
        id: text(client.id),
        businessName: text(client.businessName),
        fromOwnerId: ownerId,
        toOwnerId: damianKey,
        bookedAt: salesBookingFacts(client).bookedAt,
      });
    }
  }

  return {
    cutoffYmd: BAARD_FARKAS_CUTOFF_YMD,
    alexander: {
      id: text(alexander.id),
      username: text(alexander.username),
      name: text(alexander.name),
      ownerKey: alexanderKey,
    },
    damianOwnerKey: damianKey,
    toAlexander,
    toDamian,
  };
}

export function baardFarkasPatchEntries(plan = {}) {
  const patches = [];
  for (const row of [...(plan.toAlexander || []), ...(plan.toDamian || [])]) {
    if (!row?.id || !row?.toOwnerId) continue;
    patches.push({
      id: row.id,
      patch: { ownerId: row.toOwnerId },
    });
  }
  return patches;
}
