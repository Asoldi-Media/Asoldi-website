// Booking core shared by the admin iteration route (POST /api/admin/sales/:id/workshop/iteration-meeting)
// and the client self-booking routes (lib/routes/client-booking-routes.js): free slots from the workshop
// calendar, the iteration meeting with its calendar event and mail, and the workshop booking through the
// workshop confirmation. Calendar writes go through lib/google-calendar.js (a safe-mode intent while safe
// mode is on) and mails through lib/email.js (the safe-mode outbox).
import * as sales from '../data/sales.js';
import { getAutomationSettings } from '../data/automation-settings.js';
import * as emailLib from './email.js';
import { queryWorkshopFreeBusy } from './google-calendar.js';
import { buildSalesCalendarInvite } from './sales-email.js';
import { resolveDamianWorkshopAccountKey } from './workshop-action.js';
import {
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  WORKSHOP_DURATION_MINUTES,
  getWorkshopAction,
  normalizeWorkshopAction,
  workshopInviteHostOk,
} from './workshop-action-shared.js';
import { rejectActionAfterDueDate } from './workshop-desk-actions.js';
import {
  ITERATION_DURATION_MINUTES,
  buildIterationSyntheticMeetingClient,
  iterationEmailShouldSend,
  iterationInvitesClient,
  syncIterationCalendar,
  tryBuildSalesIterationEmail,
} from './workshop-iteration.js';
import {
  ITERATION_DEFAULT_NAME,
  getWorkshopRecord,
  mergeWorkshopRecord,
  normalizeIterationMeeting,
} from './workshop-record.js';
import { osloCalendarYmd, osloWallToIso } from './website-due.js';

export { clientBookingLink } from './client-booking.js';

export const SLOT_START_HOURS = Object.freeze([9, 10, 11, 13, 14, 15]);
export const BOOKING_WORKDAYS = 10;
export const BUSY_DEADLINE_MS = 7000;
const DAY_MS = 24 * 60 * 60 * 1000;

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nowMs(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  const parsed = Date.parse(sanitizeText(now));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Meeting length in minutes for a booking purpose. */
export function bookingDurationMinutes(purpose) {
  return purpose === 'iteration' ? ITERATION_DURATION_MINUTES : WORKSHOP_DURATION_MINUTES;
}

// ---------------------------------------------------------------- slots

function addDaysYmd(ymd, days) {
  const date = new Date(`${ymd}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function overlaps(startMs, endMs, busy) {
  return busy.some((block) => {
    const from = Date.parse(sanitizeText(block?.start));
    const to = Date.parse(sanitizeText(block?.end));
    return Number.isFinite(from) && Number.isFinite(to) && from < endMs && to > startMs;
  });
}

/**
 * Free slots on the next `workdays` Monday-to-Friday days (Oslo time) from `startInDays` days ahead: start
 * hours 9, 10, 11, 13, 14 and 15 Oslo time, the purpose's meeting length, none in the past and none that
 * overlaps a busy block { start, end }. Returns [{ start, end }] (ISO), sorted.
 */
export function bookingSlots({ busy = [], now, purpose = 'workshop', workdays = BOOKING_WORKDAYS, startInDays = 1 } = {}) {
  const at = nowMs(now);
  const minutes = bookingDurationMinutes(purpose);
  const blocks = Array.isArray(busy) ? busy : [];
  const today = osloCalendarYmd(new Date(at).toISOString());
  const slots = [];
  let counted = 0;
  for (let offset = Math.max(0, Number(startInDays) || 0); counted < workdays && offset < workdays * 3 + 7; offset += 1) {
    const ymd = addDaysYmd(today, offset);
    const noon = osloWallToIso(ymd, 12, 0, 0);
    const weekday = noon ? new Date(noon).getUTCDay() : -1;
    if (weekday === 0 || weekday === 6 || weekday < 0) continue;
    counted += 1;
    for (const hour of SLOT_START_HOURS) {
      const start = osloWallToIso(ymd, hour, 0, 0);
      const startMs = Date.parse(start);
      if (!Number.isFinite(startMs) || startMs <= at) continue;
      const endMs = startMs + minutes * 60_000;
      if (overlaps(startMs, endMs, blocks)) continue;
      slots.push({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
    }
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Busy blocks of the workshop calendar between timeMin and timeMax: { ok, busy }. No connected calendar,
 * an error or no answer within BUSY_DEADLINE_MS gives { ok:false, busy:[] }. `queryBusy` (tests) answers
 * instead of Google.
 */
export async function loadWorkshopBusy({ timeMin, timeMax } = {}, { queryBusy } = {}) {
  try {
    if (typeof queryBusy === 'function') {
      const listed = await queryBusy({ timeMin, timeMax });
      return { ok: listed?.ok !== false, busy: Array.isArray(listed?.busy) ? listed.busy : [] };
    }
    const accountKey = resolveDamianWorkshopAccountKey();
    if (!accountKey) return { ok: false, busy: [] };
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('calendar-freebusy-timeout')), BUSY_DEADLINE_MS);
      timer.unref?.();
    });
    try {
      const listed = await Promise.race([queryWorkshopFreeBusy(accountKey, { timeMin, timeMax }), deadline]);
      return { ok: true, busy: Array.isArray(listed?.busy) ? listed.busy : [] };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, busy: [] };
  }
}

/** The free slots for a purpose from a fresh calendar read: { ok, slots }. */
export async function freeBookingSlots({ purpose = 'workshop', now, workdays = BOOKING_WORKDAYS } = {}, deps = {}) {
  const at = nowMs(now);
  const listed = await loadWorkshopBusy({
    timeMin: new Date(at).toISOString(),
    timeMax: new Date(at + (workdays * 2 + 7) * DAY_MS).toISOString(),
  }, deps);
  if (!listed.ok) return { ok: false, slots: [] };
  return { ok: true, slots: bookingSlots({ busy: listed.busy, now: at, purpose, workdays }) };
}

// ---------------------------------------------------------------- the iteration meeting

/**
 * The iteration mail with its calendar invite (the admin route's mail). The sender comes from
 * `resolveSender()`, asked only once the client has an address and mail is configured; `bcc(recipient)`
 * gives the copy list ('' for none). Returns { sent, warning }.
 */
export async function sendIterationMeetingMail(client, meeting, { resolveSender, bcc } = {}) {
  const recipient = sanitizeText(client?.contactEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { sent: false, warning: 'Iterasjons-e-post ble ikke sendt: kunden mangler e-post.' };
  }
  if (!emailLib.canSendEmail()) {
    return { sent: false, warning: 'Iterasjons-e-post ble ikke sendt: e-post er ikke konfigurert.' };
  }
  const sender = typeof resolveSender === 'function' ? await resolveSender() : {};
  const calendar = { meetLink: meeting.meetLink, eventId: meeting.calendarEventId };
  const built = await tryBuildSalesIterationEmail(client, calendar, {
    sender,
    iteration: {
      dueAt: meeting.dueAt,
      meetLink: meeting.meetLink,
    },
  });
  if (!built) {
    return { sent: false, warning: '' };
  }
  const synthetic = buildIterationSyntheticMeetingClient(client, meeting);
  const invite = buildSalesCalendarInvite(synthetic, calendar, {
    organizerEmail: DAMIAN_WORKSHOP_CALENDAR_EMAIL,
    organizerName: 'Damian',
    durationMinutes: ITERATION_DURATION_MINUTES,
    summary: `Asoldi · ${ITERATION_DEFAULT_NAME} · ${sanitizeText(client.businessName) || 'kunde'}`,
  });
  await emailLib.sendEmail({
    to: recipient,
    from: built.from,
    replyTo: built.replyTo,
    bcc: typeof bcc === 'function' ? bcc(recipient) : '',
    subject: built.subject,
    text: built.text,
    html: built.html,
    attachments: built.attachments,
    icalEvent: invite || undefined,
  });
  return { sent: true };
}

/**
 * The first half of an iteration booking (no calendar or mail yet): the next meeting from the request
 * body over the stored one. { record, nextMeeting, send } and, when the request ends here, `answer`
 * { status, payload } (a missing time, a time after the due date, or a save without sending).
 */
export function prepareIterationMeeting(existing, body = {}) {
  const record = getWorkshopRecord(existing);
  const input = isPlainObject(body) ? body : {};
  const nextMeeting = normalizeIterationMeeting({
    ...record.iterationMeeting,
    dueAt: Object.prototype.hasOwnProperty.call(input, 'dueAt') ? input.dueAt : record.iterationMeeting.dueAt,
    format: Object.prototype.hasOwnProperty.call(input, 'format') ? input.format : record.iterationMeeting.format,
    addToCalendar: Object.prototype.hasOwnProperty.call(input, 'addToCalendar')
      ? input.addToCalendar
      : record.iterationMeeting.addToCalendar,
    calendarEventId: record.iterationMeeting.calendarEventId,
    meetLink: record.iterationMeeting.meetLink,
    firefliesMeetingId: record.iterationMeeting.firefliesMeetingId,
    confirmationSentAt: record.iterationMeeting.confirmationSentAt,
  });
  const send = Boolean(input.send);
  if (send && !nextMeeting.dueAt) {
    return { record, nextMeeting, send, answer: { status: 400, payload: { message: 'Sett tid før du sender iterasjonsmøtet.' } } };
  }
  const late = rejectActionAfterDueDate(nextMeeting.dueAt, existing);
  if (late) return { record, nextMeeting, send, answer: { status: 400, payload: { message: late } } };
  if (!send) {
    const updated = sales.setSalesWorkshop(existing.id, mergeWorkshopRecord(record, {
      iterationMeeting: nextMeeting,
    }));
    return { record, nextMeeting, send, answer: { status: 200, payload: { client: updated, warnings: [] } } };
  }
  return { record, nextMeeting, send };
}

/**
 * The admin iteration route, from the stored record to the end: { status, payload, kick }.
 * payload.client is the raw client. kick is true only where the route starts the recorder's live join.
 * Errors the route answers with httpStatusFromError are thrown for the route to catch.
 */
export async function bookIterationMeeting(existing, body, { sendMail } = {}) {
  const prepared = prepareIterationMeeting(existing, body);
  if (prepared.answer) return { status: prepared.answer.status, payload: prepared.answer.payload, kick: false };
  return sendIterationMeeting(existing, prepared, { sendMail });
}

/**
 * The second half: the calendar event, the mail (`sendMail(client, meeting)` -> { sent, warning }) and the
 * stored meeting. Returns { status, payload, kick } (`kick`: start the recorder's live join for the
 * client). Errors are thrown to the caller.
 */
export async function sendIterationMeeting(existing, prepared, { sendMail } = {}) {
  const { record, nextMeeting, send } = prepared;
  const sync = await syncIterationCalendar({
    client: existing,
    previousMeeting: record.iterationMeeting,
    nextMeeting,
  });
  const warnings = [...(sync.warnings || [])];
  if (sync.error) {
    const meeting = {
      ...sync.meeting,
      confirmationSentAt: record.iterationMeeting.confirmationSentAt,
      sentAt: '',
    };
    const updated = sales.setSalesWorkshop(existing.id, mergeWorkshopRecord(record, {
      iterationMeeting: meeting,
    }));
    return {
      status: 409,
      payload: {
        message: sync.error,
        warnings,
        client: updated || existing,
        emailSent: false,
      },
      kick: false,
    };
  }
  let meeting = {
    ...sync.meeting,
    confirmationSentAt: record.iterationMeeting.confirmationSentAt,
  };
  let emailSent = false;
  if (iterationEmailShouldSend(record.iterationMeeting, meeting, { send }) && iterationInvitesClient(meeting)) {
    const hostOk = workshopInviteHostOk({
      googleEmail: DAMIAN_WORKSHOP_CALENDAR_EMAIL,
      organizerEmail: DAMIAN_WORKSHOP_CALENDAR_EMAIL,
      meetLink: meeting.meetLink,
      firefliesInvited: Boolean(meeting.firefliesInvitedAt),
    });
    if (!hostOk) {
      const updated = sales.setSalesWorkshop(existing.id, mergeWorkshopRecord(record, {
        iterationMeeting: {
          ...meeting,
          confirmationSentAt: record.iterationMeeting.confirmationSentAt,
          sentAt: '',
        },
      }));
      return {
        status: 409,
        payload: {
          message: 'Google Meet ble ikke opprettet med damian@asoldi.com som eier. E-posten ble ikke sendt.',
          warnings,
          client: updated || existing,
          emailSent: false,
        },
        kick: false,
      };
    }
    try {
      const mailed = await sendMail(existing, meeting);
      emailSent = Boolean(mailed.sent);
      if (mailed.warning) warnings.push(mailed.warning);
      if (emailSent) meeting = { ...meeting, confirmationSentAt: new Date().toISOString() };
    } catch (error) {
      warnings.push(`Iterasjons-e-post feilet: ${sanitizeText(error?.message) || 'ukjent feil'}`);
    }
  }
  const updated = sales.setSalesWorkshop(existing.id, mergeWorkshopRecord(record, {
    iterationMeeting: meeting,
  }));
  const client = updated || existing;
  return { status: 200, payload: { client, warnings, emailSent }, kick: true };
}

// ---------------------------------------------------------------- client self-booking

/** The client's scheduling sender (the rep's mailbox as Reply-To when the inbox bot reads it). */
export async function clientSchedulingSender(client, { settings, deps = {} } = {}) {
  const { ownerMailboxFor, schedulingSender } = await import('./delivery-emails.js');
  let base = {};
  const mailbox = await ownerMailboxFor(client, deps);
  if (mailbox && mailbox.endsWith('@asoldi.com')) {
    const { buildSalesSender } = await import('./sales-sender.js');
    base = buildSalesSender({ username: mailbox });
  }
  return schedulingSender(client, base, { settings: settings || getAutomationSettings(), deps });
}

/**
 * Books the workshop at `dueAt` through the workshop confirmation (calendar event with a Meet room, the
 * "Workshop bekreftet" mail with the invite). A booking that moves an earlier time moves its event.
 * `bookingLink` adds the line to choose another time. Returns what confirmWorkshopAndMail returns.
 */
export async function bookWorkshopSlot(client, dueAt, { sender = {}, bookingLink = '', needLines = [] } = {}) {
  const { confirmWorkshopAndMail } = await import('./workshop-prep-send.js');
  const previous = getWorkshopAction(client) || normalizeWorkshopAction({});
  const next = normalizeWorkshopAction({
    ...previous,
    name: 'Workshop',
    format: 'mote',
    dueAt,
    addToCalendar: true,
    status: 'draft',
    confirmationSentAt: '',
  });
  return confirmWorkshopAndMail(client, previous, next, {
    sender,
    needLines,
    includeNeeds: Array.isArray(needLines) && needLines.length > 0,
    ...(bookingLink ? { bookingLink } : {}),
  });
}

/** True when this call recorded a safe-mode calendar write (the stand-in, not a live Google call). */
async function safeModeWroteCalendar(started) {
  try {
    const { isSafeModeActive, readRecentIntents } = await import('./safe-mode.js');
    if (!isSafeModeActive()) return false;
    return readRecentIntents(40).some((row) => row.kind === 'calendarWrite' && Date.parse(row.at) >= started - 1000);
  } catch {
    return false;
  }
}

/** The time the client has booked for a purpose ('' when none). */
export function bookedTime(client, purpose) {
  if (purpose === 'iteration') return sanitizeText(getWorkshopRecord(client).iterationMeeting?.dueAt);
  return sanitizeText(getWorkshopAction(client)?.dueAt);
}

/**
 * A client's own booking from a self-booking link: `start` must still be one of the free slots (a fresh
 * calendar read), then the workshop or the iteration meeting is booked. deps: { queryBusy, loadNeeds,
 * bookingLink(purpose), settings, now }. Returns { ok, status, code?, booking, warnings, slots? }.
 */
export async function bookSlotForClient(client, { purpose = 'workshop', start = '' } = {}, deps = {}) {
  const wanted = Date.parse(sanitizeText(start));
  const free = await freeBookingSlots({ purpose, now: deps.now }, deps);
  if (!free.ok) return { ok: false, status: 503, code: 'calendar-unavailable', warnings: [] };
  const slot = Number.isFinite(wanted) ? free.slots.find((row) => Date.parse(row.start) === wanted) : null;
  if (!slot) return { ok: false, status: 409, code: 'slot-taken', slots: free.slots, warnings: [] };
  const sender = await clientSchedulingSender(client, { settings: deps.settings, deps });
  const booking = { purpose, start: slot.start, end: slot.end };
  if (purpose === 'iteration') {
    const started = Date.now();
    const result = await bookIterationMeeting(client, { dueAt: slot.start, format: 'mote', addToCalendar: true, send: true }, {
      sendMail: (current, meeting) => sendIterationMeetingMail(current, meeting, { resolveSender: async () => sender, bcc: () => '' }),
    });
    if (result.status === 200) {
      return { ok: true, status: 200, booking, emailSent: result.payload.emailSent === true, warnings: result.payload.warnings || [] };
    }
    // shortcut: the safe-mode calendar stand-in fails the host check (empty owner, stand-in Meet link),
    // so the shared route returns 409 after the write. The client booking still sends the confirmation.
    // Upgrade when the stand-in carries the workshop host and a real Meet link.
    if (result.status === 409 && await safeModeWroteCalendar(started)) {
      const meeting = {
        ...(getWorkshopRecord(result.payload?.client || client).iterationMeeting || {}),
        dueAt: slot.start,
        format: 'mote',
        addToCalendar: true,
      };
      let mailed = { sent: false, warning: '' };
      try {
        mailed = await sendIterationMeetingMail(client, meeting, { resolveSender: async () => sender, bcc: () => '' });
      } catch (error) {
        return { ok: false, status: 500, code: 'mail-failed', message: sanitizeText(error?.message).slice(0, 300), warnings: result.payload?.warnings || [] };
      }
      const warnings = [...(result.payload?.warnings || [])];
      if (mailed.warning) warnings.push(mailed.warning);
      if (!mailed.sent) {
        return { ok: false, status: 502, code: 'calendar-failed', message: mailed.warning || sanitizeText(result.payload?.message), warnings };
      }
      const live = sales.getSalesClientById(client.id) || result.payload?.client || client;
      const record = getWorkshopRecord(live);
      sales.setSalesWorkshop(client.id, mergeWorkshopRecord(record, {
        iterationMeeting: {
          ...record.iterationMeeting,
          dueAt: slot.start,
          confirmationSentAt: record.iterationMeeting?.confirmationSentAt || new Date().toISOString(),
        },
      }));
      return { ok: true, status: 200, booking, emailSent: true, warnings };
    }
    return {
      ok: false,
      status: result.status === 400 ? 400 : 502,
      code: 'not-bookable',
      message: sanitizeText(result.payload?.message),
      warnings: result.payload?.warnings || [],
    };
  }
  let needLines = [];
  if (typeof deps.loadNeeds === 'function') {
    try {
      needLines = await deps.loadNeeds(client);
    } catch {
      needLines = [];
    }
  }
  const link = typeof deps.bookingLink === 'function' ? sanitizeText(deps.bookingLink('workshop')) : '';
  const result = await bookWorkshopSlot(client, slot.start, { sender, bookingLink: link, needLines });
  if (result?.ok === false && !result?.sent) {
    return { ok: false, status: 502, code: 'calendar-failed', message: sanitizeText(result.warning), warnings: result.warnings || [] };
  }
  return { ok: true, status: 200, booking, emailSent: Boolean(result?.sent), warnings: [...(result?.warnings || []), ...(result?.warning ? [result.warning] : [])] };
}
