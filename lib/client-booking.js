// Signed self-booking links: a client books its own workshop or iteration slot from a link in a mail,
// without signing in. Behind the `booking.selfLink` switch (per client through spineModeForClient):
//
//   off     no link in any mail, and the public booking routes answer 404 { code:'disabled' }.
//   shadow  no link either; a delivery-audit row notes each mail that would have carried one.
//   auto    pilot clients get the link.
//
// Token: `v1.<payload>.<signature>`, both base64url. The payload is { c: client id, p: purpose
// ('workshop' | 'iteration'), e: expiry (ms), n: a random nonce }, the signature HMAC-SHA256 with the
// key <dataDir>/secrets/booking-signing.key (the disk secret store; made on first use). A token is
// single-use: booking with it records its nonce in <dataDir>/booking-tokens.json, and the booking
// answer carries a fresh link to change the time.
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { effectiveSwitchMode, getAutomationSettings } from '../data/automation-settings.js';
import { readJsonFresh, updateJsonLocked } from '../data/atomic-json.js';
import { getPersistentDataDir } from '../data/storage-path.js';
import { readOrCreateDiskSecret, safeEqual } from './auth-hardening.js';
import { appendDeliveryAudit } from './delivery-audit.js';
import { publicBaseUrl } from './email-relay.js';
import { spineModeForClient } from './spine-mode.js';

export const BOOKING_SWITCH = 'booking.selfLink';
export const BOOKING_PURPOSES = Object.freeze(['workshop', 'iteration']);
export const BOOKING_SECRET_NAME = 'booking-signing.key';
export const BOOKING_TOKEN_TTL_MS = 21 * 24 * 60 * 60 * 1000;
export const BOOKING_LEDGER_FILE = 'booking-tokens.json';
export const BOOKING_LEDGER_MAX = 5000;
export const BOOKING_LEDGER_KEEP_MS = 60 * 24 * 60 * 60 * 1000;
const TOKEN_MAX = 600;
const NONCE_RE = /^[0-9a-f]{32}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nowMs(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  const parsed = Date.parse(text(now, 60));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function dataDirOf(dataDir) {
  return dataDir || getPersistentDataDir();
}

// ---------------------------------------------------------------- modes

/** The switch for the whole hub: off, shadow, paused or auto. */
export function bookingSwitchMode({ settings } = {}) {
  try {
    return effectiveSwitchMode(BOOKING_SWITCH, { settings: settings || getAutomationSettings() });
  } catch {
    return 'off';
  }
}

/** off, shadow or auto for one client (a paused switch counts as shadow; unreadable settings as off). */
export function bookingModeForClient(client, { settings } = {}) {
  let mode;
  try {
    mode = spineModeForClient(BOOKING_SWITCH, client || {}, { settings: settings || getAutomationSettings() });
  } catch {
    return 'off';
  }
  if (mode === 'auto') return 'auto';
  if (mode === 'shadow' || mode === 'paused') return 'shadow';
  return 'off';
}

// ---------------------------------------------------------------- tokens

function signingKey(dataDir) {
  return readOrCreateDiskSecret(dataDirOf(dataDir), BOOKING_SECRET_NAME, 32);
}

function sign(body, dataDir) {
  return createHmac('sha256', signingKey(dataDir)).update(`v1.${body}`).digest('base64url');
}

/** A signed booking token for one client and purpose. Throws for an unknown purpose or client id. */
export function createBookingToken({ clientId, purpose, ttlMs = BOOKING_TOKEN_TTL_MS } = {}, { dataDir, now } = {}) {
  const id = text(clientId, 80);
  if (!CLIENT_ID_RE.test(id)) throw new Error('A booking token needs a client id.');
  if (!BOOKING_PURPOSES.includes(purpose)) throw new Error(`Unknown booking purpose: ${JSON.stringify(purpose)}`);
  const ttl = Math.max(60_000, Math.min(Number(ttlMs) || BOOKING_TOKEN_TTL_MS, 90 * 24 * 60 * 60 * 1000));
  const payload = { c: id, p: purpose, e: nowMs(now) + ttl, n: randomBytes(16).toString('hex') };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `v1.${body}.${sign(body, dataDir)}`;
}

/**
 * { ok:true, clientId, purpose, exp, nonce } for a token this hub signed that has not expired, else
 * { ok:false, code:'invalid' | 'expired' }. Never throws.
 */
export function verifyBookingToken(token, { dataDir, now } = {}) {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw || raw.length > TOKEN_MAX) return { ok: false, code: 'invalid' };
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
    return { ok: false, code: 'invalid' };
  }
  let expected;
  try {
    expected = sign(parts[1], dataDir);
  } catch {
    return { ok: false, code: 'invalid' };
  }
  if (!safeEqual(parts[2], expected)) return { ok: false, code: 'invalid' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'invalid' };
  }
  if (!isPlainObject(payload)) return { ok: false, code: 'invalid' };
  const clientId = text(payload.c, 80);
  const purpose = text(payload.p, 20);
  const exp = Number(payload.e);
  const nonce = text(payload.n, 64);
  if (!CLIENT_ID_RE.test(clientId) || !BOOKING_PURPOSES.includes(purpose) || !Number.isFinite(exp) || !NONCE_RE.test(nonce)) {
    return { ok: false, code: 'invalid' };
  }
  if (exp <= nowMs(now)) return { ok: false, code: 'expired', clientId, purpose };
  return { ok: true, clientId, purpose, exp, nonce };
}

// ---------------------------------------------------------------- single use

function ledgerPath(dataDir) {
  return join(dataDirOf(dataDir), BOOKING_LEDGER_FILE);
}

function readLedger(dataDir) {
  const stored = readJsonFresh(ledgerPath(dataDir));
  return isPlainObject(stored) && isPlainObject(stored.used) ? stored : { used: {} };
}

/** True when a booking already used this token's nonce. */
export function bookingTokenUsed(nonce, { dataDir } = {}) {
  return Boolean(readLedger(dataDir).used[text(nonce, 64)]);
}

/**
 * Marks the nonce used. true the first time, false when it was used before (two requests at once:
 * exactly one gets true). Entries 60 days past their token's expiry go, and at most 5000 are kept.
 */
export function consumeBookingToken(nonce, record = {}, { dataDir, now } = {}) {
  const key = text(nonce, 64);
  if (!NONCE_RE.test(key)) return false;
  const at = nowMs(now);
  let first = false;
  updateJsonLocked(ledgerPath(dataDir), (current) => {
    const ledger = isPlainObject(current) && isPlainObject(current.used) ? current : { used: {} };
    if (ledger.used[key]) return undefined;
    first = true;
    const kept = Object.entries(ledger.used)
      .filter(([, row]) => !(Number(row?.exp) + BOOKING_LEDGER_KEEP_MS < at))
      .sort((a, b) => String(a[1]?.at || '').localeCompare(String(b[1]?.at || '')))
      .slice(-(BOOKING_LEDGER_MAX - 1));
    return {
      used: {
        ...Object.fromEntries(kept),
        [key]: {
          at: new Date(at).toISOString(),
          exp: Number(record.exp) || at,
          clientId: text(record.clientId, 80),
          purpose: text(record.purpose, 20),
          start: text(record.start, 40),
        },
      },
    };
  });
  return first;
}

/** Frees a nonce again (a booking that failed after the token was taken). */
export function releaseBookingToken(nonce, { dataDir } = {}) {
  const key = text(nonce, 64);
  if (!NONCE_RE.test(key)) return;
  updateJsonLocked(ledgerPath(dataDir), (current) => {
    const ledger = isPlainObject(current) && isPlainObject(current.used) ? current : { used: {} };
    if (!ledger.used[key]) return undefined;
    const used = { ...ledger.used };
    delete used[key];
    return { used };
  });
}

// ---------------------------------------------------------------- links

function isWebsiteClient(client) {
  const product = text(client?.product, 40).toLowerCase();
  return !product || product === 'asoldi';
}

/**
 * The booking link for a client's mail: `<public base>/book/<token>`, or '' unless the client's booking
 * mode is auto, it is a website client and it has a contact e-mail. In shadow a delivery-audit row notes
 * the link a mail would have carried (pass audit:false to skip it).
 */
export function clientBookingLink(client, { purpose = 'workshop', settings, dataDir, now, audit = true } = {}) {
  if (!client?.id || !BOOKING_PURPOSES.includes(purpose)) return '';
  const mode = bookingModeForClient(client, { settings });
  if (mode === 'off') return '';
  if (!isWebsiteClient(client) || !EMAIL_RE.test(text(client.contactEmail, 200))) return '';
  if (mode === 'shadow') {
    if (audit) appendDeliveryAudit({ kind: 'booking-link-shadow', clientId: text(client.id, 80), purpose }, { dataDir });
    return '';
  }
  try {
    return `${publicBaseUrl()}/book/${createBookingToken({ clientId: client.id, purpose }, { dataDir, now })}`;
  } catch (error) {
    console.warn('[booking] no link:', error?.message || error);
    return '';
  }
}
