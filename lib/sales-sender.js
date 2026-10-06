import { formatMailbox, parseMailbox, readResendConfig } from './email.js';

function sanitize(value = '') {
  return String(value ?? '').trim();
}

function compactLetters(value = '') {
  return sanitize(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function isGenericBrandName(value = '') {
  const compact = compactLetters(value);
  return !compact
    || compact === 'asoldi'
    || compact === 'asoldicom'
    || compact === 'admin'
    || compact === 'contact'
    || compact === 'user';
}

export function isGenericAsoldiMailbox(address = '') {
  const email = parseMailbox(address).address;
  return !email
    || email === 'contact@asoldi.com'
    || email === 'asoldi@asoldi.com'
    || email === 'admin@asoldi.com';
}

export function isPersonAsoldiMailbox(address = '') {
  const email = parseMailbox(address).address;
  return email.endsWith('@asoldi.com') && !isGenericAsoldiMailbox(email);
}

export function titleCaseFirst(value = '') {
  const raw = sanitize(value);
  if (!raw) return '';
  return `${raw.charAt(0).toUpperCase()}${raw.slice(1)}`;
}

function firstToken(value = '') {
  const raw = sanitize(value);
  if (!raw) return '';
  if (raw.includes('@')) return titleCaseFirst(raw.split('@')[0]);
  return titleCaseFirst(raw.split(/\s+/)[0]);
}

export function firstNameFromProfile(profile = {}) {
  const named = firstToken(profile.name);
  if (named && !isGenericBrandName(named)) return named;
  const googleNamed = firstToken(profile.googleName);
  if (googleNamed && !isGenericBrandName(googleNamed)) return googleNamed;
  const username = firstToken(profile.username);
  if (username && !isGenericBrandName(username)) return username;
  return 'Asoldi';
}

export function asoldiAddress(value = '', fallback = '') {
  const address = parseMailbox(value).address;
  if (address.endsWith('@asoldi.com') && !isGenericAsoldiMailbox(address)) return address;
  const fallbackAddress = parseMailbox(fallback).address;
  if (fallbackAddress.endsWith('@asoldi.com') && !isGenericAsoldiMailbox(fallbackAddress)) {
    return fallbackAddress;
  }
  if (fallbackAddress.endsWith('@asoldi.com')) return fallbackAddress;
  return 'contact@asoldi.com';
}

export function normalizeAsoldiFromEmail(value = '') {
  const address = parseMailbox(value).address;
  return address.endsWith('@asoldi.com') ? address : '';
}

export function fallbackFromHeader() {
  return sanitize(readResendConfig().from) || 'Asoldi <contact@asoldi.com>';
}

function mailboxFromUsername(username = '') {
  const address = parseMailbox(username).address || sanitize(username).toLowerCase();
  if (address.endsWith('@asoldi.com') && !isGenericAsoldiMailbox(address)) return address;
  return '';
}

function mailboxFromFirstName(name = '') {
  const local = compactLetters(firstToken(name));
  if (!local || isGenericBrandName(local)) return '';
  return `${local}@asoldi.com`;
}

/**
 * Phone number as stored on a user: digits with an optional leading "+". Norwegian 8-digit numbers get
 * the +47 country code so "92331098" and "+47 92331098" end up identical. Returns '' when unusable.
 */
export function normalizePhoneNumber(value = '') {
  const raw = sanitize(value);
  if (!raw) return '';
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  const plus = digits.startsWith('+');
  digits = digits.replace(/\D/g, '');
  if (!digits) return '';
  if (!plus && digits.length === 8) return `+47${digits}`;
  if (!plus && digits.startsWith('47') && digits.length === 10) return `+${digits}`;
  if (digits.length < 6 || digits.length > 15) return '';
  return `+${digits}`;
}

/** "+4792331098" → "+47 923 31 098" (Norwegian grouping); other countries keep a plain "+cc rest". */
export function formatPhoneNumber(value = '') {
  const normalized = normalizePhoneNumber(value);
  if (!normalized) return '';
  if (normalized.startsWith('+47') && normalized.length === 11) {
    const local = normalized.slice(3);
    // Mobile (4x/9x) reads as 3-2-3, landlines as 2-2-2-2.
    if (/^[49]/.test(local)) return `+47 ${local.slice(0, 3)} ${local.slice(3, 5)} ${local.slice(5)}`;
    return `+47 ${local.slice(0, 2)} ${local.slice(2, 4)} ${local.slice(4, 6)} ${local.slice(6)}`;
  }
  return normalized;
}

export function buildSalesSender(profile = {}, fallbackFrom = fallbackFromHeader()) {
  const name = firstNameFromProfile(profile);
  const fromEmail = mailboxFromUsername(profile.username)
    || mailboxFromUsername(profile.googleEmail)
    || mailboxFromUsername(profile.fromEmail)
    || mailboxFromFirstName(name)
    || asoldiAddress('', fallbackFrom);
  return {
    name,
    fullName: (!isGenericBrandName(profile.name) && sanitize(profile.name)) || name,
    fromEmail,
    from: formatMailbox(`${name} fra Asoldi`, fromEmail),
    replyTo: fromEmail,
    // Shown as {{signerPhone}} in every sales email; '' falls back to the office number in the templates.
    phone: formatPhoneNumber(profile.phone),
  };
}
