// Public self-booking (no sign-in). A signed link from a mail lists free workshop or iteration
// slots and books one. While booking.selfLink is off for the whole hub, both routes answer
// 404 { code:'disabled' } before the token is read.
//
//   GET  /api/public/booking/:token/slots
//   POST /api/public/booking/:token          { start }
//
// register(app, { sales, bookingDeps }). bookingDeps is for tests: { queryBusy, now, dataDir }.
import { getPersistentDataDir } from '../../data/storage-path.js';
import { unsubscribeRateKey } from '../asoldi-unsubscribe.js';
import { appendDeliveryAudit } from '../delivery-audit.js';
import {
  bookingModeForClient,
  bookingSwitchMode,
  bookingTokenUsed,
  clientBookingLink,
  consumeBookingToken,
  releaseBookingToken,
  verifyBookingToken,
} from '../client-booking.js';
import { lifecycleState } from '../delivery-lifecycle.js';
import { rejectActionAfterDueDate } from '../workshop-desk-actions.js';
import { getWorkshopRecord } from '../workshop-record.js';
import { bookedTime, bookingDurationMinutes, bookSlotForClient, freeBookingSlots } from '../meeting-booking.js';

const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_LIMIT = 30;
const CALENDAR_MESSAGE = 'Kalenderen er ikke tilgjengelig akkurat nå. Svar på e-posten vi sendte, så finner vi en tid.';

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function isWebsiteClient(client) {
  const product = text(client?.product, 40).toLowerCase();
  return !product || product === 'asoldi';
}

function clock(bookingDeps) {
  const now = bookingDeps?.now;
  if (typeof now === 'function') return now();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  const parsed = Date.parse(text(now, 60));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function dataDirOf(bookingDeps) {
  return bookingDeps?.dataDir || getPersistentDataDir();
}

// The address the hub's other public limiters use: behind the hosting proxy it is the address the proxy
// appended, not the proxy's own socket.
function clientIp(req) {
  return text(String(unsubscribeRateKey(req) || '').replace(/^::ffff:/, ''), 80) || 'unknown';
}

const MAX_TRACKED_ADDRESSES = 5000;

function limited(hits, ip, now) {
  if (hits.size > MAX_TRACKED_ADDRESSES) {
    for (const [key, stamps] of hits) {
      if (!stamps.some((at) => now - at < WINDOW_MS)) hits.delete(key);
    }
  }
  const recent = (hits.get(ip) || []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= WINDOW_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

/** '' when the client may still book this purpose, else the answer code: a contract taken back, a cancelled or paused plan, or a workshop that has been held. */
function bookingBlock(client, purpose, now) {
  if (client?.progression?.contractSigned !== true) return 'closed';
  const state = lifecycleState(client, { now }).state;
  if (state === 'unsigned' || state === 'cancelled' || state === 'ended' || state === 'paused') return 'closed';
  if (purpose === 'workshop' && text(getWorkshopRecord(client).heldAt, 40)) return 'held';
  return '';
}

/** The free slots a client may pick: an iteration meeting after the website's due date is not offered. */
function pickableSlots(slots, client, purpose) {
  const list = Array.isArray(slots) ? slots : [];
  if (purpose !== 'iteration') return list;
  return list.filter((row) => !rejectActionAfterDueDate(row.start, client));
}

export function register(app, deps = {}) {
  const { sales, bookingDeps = {} } = deps;
  if (!sales) throw new Error('client-booking-routes needs sales');
  const hits = new Map();

  function disabled(res) {
    return res.status(404).json({ code: 'disabled' });
  }

  // The shared checks. Returns { verified, client } or null after it has answered.
  function openBooking(req, res) {
    if (bookingSwitchMode() === 'off') return disabled(res), null;
    const now = clock(bookingDeps);
    const dataDir = dataDirOf(bookingDeps);
    if (limited(hits, clientIp(req), now)) {
      res.status(429).json({ code: 'rate-limited' });
      return null;
    }
    const verified = verifyBookingToken(req.params.token, { dataDir, now });
    if (!verified.ok) {
      res.status(verified.code === 'expired' ? 410 : 404).json({ code: verified.code === 'expired' ? 'expired' : 'invalid' });
      return null;
    }
    if (bookingTokenUsed(verified.nonce, { dataDir })) {
      res.status(410).json({ code: 'used' });
      return null;
    }
    let client = null;
    try {
      client = sales.getSalesClientById(verified.clientId);
    } catch {
      client = null;
    }
    if (!client || !isWebsiteClient(client) || bookingModeForClient(client) !== 'auto') return disabled(res), null;
    const block = bookingBlock(client, verified.purpose, now);
    if (block) {
      res.status(410).json({ code: block });
      return null;
    }
    return { verified, client, now, dataDir };
  }

  app.get('/api/public/booking/:token/slots', async (req, res) => {
    const opened = openBooking(req, res);
    if (!opened) return undefined;
    try {
      const free = await freeBookingSlots({ purpose: opened.verified.purpose, now: opened.now }, bookingDeps);
      if (!free.ok) return res.status(503).json({ code: 'calendar-unavailable', message: CALENDAR_MESSAGE });
      return res.json({
        purpose: opened.verified.purpose,
        businessName: text(opened.client.businessName, 200),
        durationMinutes: bookingDurationMinutes(opened.verified.purpose),
        slots: pickableSlots(free.slots, opened.client, opened.verified.purpose),
        booked: bookedTime(opened.client, opened.verified.purpose),
      });
    } catch {
      return res.status(503).json({ code: 'calendar-unavailable', message: CALENDAR_MESSAGE });
    }
  });

  app.post('/api/public/booking/:token', async (req, res) => {
    const opened = openBooking(req, res);
    if (!opened) return undefined;
    const { verified, client, now, dataDir } = opened;
    const start = text(req.body?.start, 40);
    try {
      const free = await freeBookingSlots({ purpose: verified.purpose, now }, bookingDeps);
      if (!free.ok) return res.status(503).json({ code: 'calendar-unavailable', message: CALENDAR_MESSAGE });
      const wanted = Date.parse(start);
      const pickable = pickableSlots(free.slots, client, verified.purpose);
      const slot = Number.isFinite(wanted) ? pickable.find((row) => Date.parse(row.start) === wanted) : null;
      if (!slot) return res.status(409).json({ code: 'slot-taken', slots: pickable });
      if (!consumeBookingToken(verified.nonce, {
        exp: verified.exp,
        clientId: verified.clientId,
        purpose: verified.purpose,
        start: slot.start,
      }, { dataDir, now })) {
        return res.status(410).json({ code: 'used' });
      }
      let booked;
      try {
        booked = await bookSlotForClient(client, { purpose: verified.purpose, start: slot.start }, {
          ...bookingDeps,
          now,
          bookingLink: (purpose) => clientBookingLink(client, { purpose, dataDir, now }),
        });
      } catch {
        releaseBookingToken(verified.nonce, { dataDir });
        return res.status(500).json({ message: 'Kunne ikke booke tiden.' });
      }
      if (!booked?.ok) {
        releaseBookingToken(verified.nonce, { dataDir });
        if (booked?.status === 409 || booked?.code === 'slot-taken') {
          return res.status(409).json({ code: 'slot-taken', slots: pickableSlots(Array.isArray(booked.slots) ? booked.slots : free.slots, client, verified.purpose) });
        }
        if (booked?.status === 503 || booked?.code === 'calendar-unavailable') {
          return res.status(503).json({ code: 'calendar-unavailable', message: CALENDAR_MESSAGE });
        }
        if (booked?.code === 'not-bookable') {
          return res.status(409).json({ code: 'not-bookable', message: 'Denne tiden kan ikke velges. Svar på e-posten vi sendte, så finner vi en tid.' });
        }
        return res.status(500).json({ message: 'Kunne ikke booke tiden.' });
      }
      appendDeliveryAudit({
        kind: 'booking',
        clientId: text(client.id, 80),
        purpose: verified.purpose,
        start: booked.booking?.start || slot.start,
      }, { dataDir });
      const rescheduleUrl = clientBookingLink(client, { purpose: verified.purpose, dataDir, now: Date.now() });
      return res.json({
        ok: true,
        booking: booked.booking || { purpose: verified.purpose, start: slot.start, end: slot.end },
        rescheduleUrl,
      });
    } catch {
      return res.status(500).json({ message: 'Kunne ikke booke tiden.' });
    }
  });
}
