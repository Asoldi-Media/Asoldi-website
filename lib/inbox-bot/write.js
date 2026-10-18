import * as sales from '../../data/sales.js';
import * as emailLib from '../email.js';
import { queryWorkshopFreeBusy, upsertMeetingEvent } from '../google-calendar.js';
import { calendarOwnerIdForSync, isAssignedSalesRepOwner, shouldSyncSalesMeetingCalendar } from '../sales-calendar-owner.js';
import { formatMeetingDate } from '../sales-email.js';
import {
  applyWorkshopGoalActionOp,
  getAdminCurrentGoalKey,
} from '../workshop-goal-timeline.js';
import { getWorkshopRecord, mergeWorkshopRecord } from '../workshop-record.js';
import {
  resolveDamianWorkshopAccountKey,
  WORKSHOP_DURATION_MINUTES,
} from '../workshop-action.js';
import {
  looksLikeCallFollowup,
  parseDayHint,
  parseWorkshopTimeHeuristic,
  resolveInboxWorkshopDueAt,
} from '../workshop-time-parse.js';
import { confirmWorkshopAndMail, loadPrepNeedLines } from '../workshop-prep-send.js';
import { applyWorkshopTimeFromInbox } from './apply-workshop-time.js';
import { appendInboxItem, listInboxItems } from './store.js';
import { formatSlotListNb, pickFreeSlots, pickFreeSlotsAhead, slotIsFree } from './slots.js';
import { calendarDurationForMode, CLIENT_MEETING_DURATION_MINUTES } from '../sales-meeting-duration.js';
import { decideInboxWrite, looksLikeWalkAway } from './decide.js';
import { freshReplyText, inboxWriteBlob } from './thread.js';
import { osloCalendarYmd, osloWallToIso } from '../website-due.js';

function sanitize(value = '') {
  return String(value || '').trim();
}

export { freshReplyText, inboxWriteBlob } from './thread.js';

const CANCEL_RE = /\bavlys|\bmå (?:dessverre )?(?:avlyse|utsette)|\bkan ikke\b.{0,30}?\b(?:i ?dag|i ?morgen|likevel|komme|delta|møte)|\bcancel/i;

function blobOf(message = {}) {
  return inboxWriteBlob(message);
}

function salesCalendarMinutes(client = {}) {
  return calendarDurationForMode(client?.meetingMode);
}

function recipientOf(client = {}) {
  const email = sanitize(client?.contactEmail);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function classifyInboxWrite(text = '', client = {}, { now = new Date() } = {}) {
  const signed = Boolean(client?.progression?.contractSigned);
  const dueAt = parseWorkshopTimeHeuristic(text, { now })?.dueAt || '';
  const day = parseDayHint(text, { now });
  if (looksLikeWalkAway(text) && !dueAt) {
    return { intent: 'walk_away', dueAt: '', day: null, cancel: true, walkAway: true };
  }
  if (CANCEL_RE.test(text) && !dueAt) {
    const namedWeekday = /\b(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\b/i.test(text);
    const onlyCancelledDay = !namedWeekday && /\b(?:i ?dag|i ?morgen|today|tomorrow)\b/i.test(text);
    return {
      intent: signed ? 'workshop_propose' : 'sales_propose',
      dueAt: '',
      day: onlyCancelledDay ? null : day,
      cancel: true,
    };
  }
  if (looksLikeCallFollowup(text)) {
    return { intent: signed ? 'workshop_call' : 'sales_call', dueAt, day };
  }
  if (signed) {
    if (dueAt) return { intent: 'workshop_book', dueAt, day };
    if (day) return { intent: 'workshop_propose', dueAt: '', day };
    return { intent: 'none', dueAt: '', day: null };
  }
  if (dueAt) return { intent: 'sales_book', dueAt, day };
  if (day) return { intent: 'sales_propose', dueAt: '', day };
  return { intent: 'none', dueAt: '', day: null };
}

export async function loadCalendarBusy(kind, client, {
  queryBusy,
  ymd = '',
} = {}) {
  const busyFn = queryBusy || queryWorkshopFreeBusy;
  const timeMin = ymd ? `${ymd}T00:00:00.000Z` : new Date().toISOString();
  const end = ymd
    ? new Date(`${ymd}T00:00:00.000Z`)
    : new Date();
  if (ymd) end.setUTCDate(end.getUTCDate() + 2);
  else end.setUTCDate(end.getUTCDate() + 8);
  const timeMax = end.toISOString();
  if (queryBusy) {
    const listed = await queryBusy(kind, { timeMin, timeMax, client });
    return { ok: true, busy: listed?.busy || [] };
  }
  if (kind === 'workshop') {
    const accountKey = resolveDamianWorkshopAccountKey();
    if (!accountKey) return { ok: false, busy: [] };
    const listed = await busyFn(accountKey, { timeMin, timeMax });
    return { ok: true, busy: listed?.busy || [] };
  }
  if (!isAssignedSalesRepOwner(client?.ownerId)) return { ok: false, busy: [] };
  const accountKey = calendarOwnerIdForSync(client.ownerId);
  if (!accountKey) return { ok: false, busy: [] };
  const listed = await busyFn(accountKey, { timeMin, timeMax });
  return { ok: true, busy: listed?.busy || [] };
}

function weekFrom(now = new Date()) {
  const origin = now instanceof Date ? now : new Date(now);
  const ymd = osloCalendarYmd(Number.isNaN(origin.getTime()) ? new Date().toISOString() : origin.toISOString());
  const date = new Date(`${ymd}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 7);
  return osloWallToIso(date.toISOString().slice(0, 10), 9, 0, 0);
}

function withOfferedSlots(text = '', slots = []) {
  const body = String(text || '').trim();
  if (!body || !slots.length) return body;
  if (/\d{1,2}[:.]\d{2}/.test(body) || /passer noe av dette/i.test(body)) return body;
  return `${body} Passer noe av dette: ${formatSlotListNb(slots)}?`;
}

async function sendClientMail(client, { subject, text }, sendEmail) {
  const mailFn = sendEmail || emailLib.sendEmail;
  const to = recipientOf(client);
  if (!to) return { sent: false, warning: 'Kunden mangler e-post på kortet.' };
  if (!sendEmail && !emailLib.canSendEmail()) return { sent: false, warning: 'E-post er ikke konfigurert.' };
  await mailFn({
    to,
    subject,
    text,
    html: `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br />')}</p>`,
  });
  return { sent: true, warning: '' };
}

export function createInboxAdminAction(client, {
  name,
  format = 'ring',
  dueAt = '',
  note = '',
} = {}) {
  const record = getWorkshopRecord(client);
  const applied = applyWorkshopGoalActionOp(record, {
    op: 'create',
    goalKey: getAdminCurrentGoalKey(client) || 'haWorkshop',
    presetKey: 'custom',
    name,
    format,
    dueAt,
    note,
    addToCalendar: false,
    allowEmptyDue: !dueAt,
  });
  if (applied.error) return { error: applied.error, client };
  const updated = sales.setSalesWorkshop(client.id, mergeWorkshopRecord(record, {
    goalActions: applied.goalActions,
  }));
  return { client: updated || client, error: '' };
}

function morningDueAt(day) {
  if (!day?.ymd) return '';
  const hour = day.band === 'afternoon' ? 13 : 9;
  return osloWallToIso(day.ymd, hour, 0, 0);
}

async function bookWorkshop({ client, message, dueAt, classified, confirmWorkshop, loadNeeds, queryBusy, sendEmail, now }) {
  const dayYmd = dueAt.slice(0, 10);
  const listed = await loadCalendarBusy('workshop', client, { queryBusy, ymd: dayYmd });
  if (!listed.ok || !slotIsFree(dueAt, WORKSHOP_DURATION_MINUTES, listed.busy)) {
    return proposeWorkshop({
      client,
      day: { ymd: dayYmd, band: 'day' },
      queryBusy,
      occupied: listed.ok ? dueAt : '',
      sendEmail,
      now,
    });
  }
  const applied = applyWorkshopTimeFromInbox({
    salesClient: client,
    dueAt,
    mailbox: message.mailbox,
    messageId: message.id,
    from: message.from,
    subject: message.subject,
    summary: classified?.summary,
    receivedAt: message.mailAt || new Date().toISOString(),
  });
  if (!applied.applied) return { wrote: false, applied };
  let needLines = [];
  try {
    needLines = await loadNeeds(applied.client);
  } catch {
    needLines = [];
  }
  const mailed = await confirmWorkshop(applied.client, applied.previous, applied.next, {
    needLines,
    includeNeeds: true,
  });
  return { wrote: true, kind: 'workshop_book', mailed, applied };
}

async function proposeWorkshop({ client, day, queryBusy, occupied = '', sendEmail, now, cancel = false, note = '' }) {
  const listed = await loadCalendarBusy('workshop', client, { queryBusy, ymd: day?.ymd });
  const slots = listed.ok
    ? (day?.ymd
      ? pickFreeSlots({
        ymd: day.ymd,
        band: day.band || 'day',
        durationMin: WORKSHOP_DURATION_MINUTES,
        busy: listed.busy,
        now,
      })
      : pickFreeSlotsAhead({
        durationMin: WORKSHOP_DURATION_MINUTES,
        busy: listed.busy,
        now,
      }))
    : [];
  if (cancel) {
    createInboxAdminAction(client, {
      name: 'Ny workshop-tid',
      format: 'ring',
      dueAt: morningDueAt(day) || slots[0] || '',
      note: note || (occupied ? `Foreslått ${formatMeetingDate(occupied)} var opptatt.` : 'Kunden avlyste. Finn ny tid.'),
    });
  }
  if (!slots.length) {
    const action = createInboxAdminAction(client, {
      name: 'Sjekk når kunden har tid til workshop',
      format: 'ring',
      dueAt: morningDueAt(day),
      note: occupied ? `Foreslått ${formatMeetingDate(occupied)} var opptatt.` : 'Ingen ledig slot funnet automatisk.',
    });
    const mailed = await sendClientMail(action.client, {
      subject: 'Workshop — vi finner et tidspunkt',
      text: 'Den er grei. Vi sjekker kalenderen og kommer tilbake med et tidspunkt som passer.',
    }, sendEmail);
    return { wrote: true, kind: 'workshop_propose', mailed, action };
  }
  const list = formatSlotListNb(slots);
  const mailed = await sendClientMail(client, {
    subject: occupied ? 'Workshop — det tidspunktet var opptatt' : cancel ? 'Workshop — nye tider' : 'Workshop — foreslåtte tider',
    text: occupied
      ? `Takk. ${formatMeetingDate(occupied)} er dessverre opptatt. Passer noe av dette i stedet: ${list}? Svar med et av tidspunktene.`
      : cancel
        ? `Takk, da stryker vi den tiden. Passer noe av dette i stedet: ${list}? Svar med et av tidspunktene.`
        : `Takk. Passer noe av dette til workshop: ${list}? Svar med et av tidspunktene.`,
  }, sendEmail);
  return { wrote: true, kind: 'workshop_propose', mailed, slots };
}

async function workshopCall({ client, day, sendEmail }) {
  const action = createInboxAdminAction(client, {
    name: 'Sjekk når han har tid for workshop',
    format: 'ring',
    dueAt: morningDueAt(day),
    note: 'Kunden vil avtale nærmere på telefon. Ikke kalender.',
  });
  const mailed = await sendClientMail(action.client, {
    subject: 'Re: workshop',
    text: 'Den er grei. Vi ringer deg og avtaler workshop-tid da.',
  }, sendEmail);
  return { wrote: true, kind: 'workshop_call', mailed, action };
}

function salesMeetingAction(client) {
  return (Array.isArray(client?.nextActions) ? client.nextActions : [])
    .find((row) => row?.presetKey === 'meeting' && !row?.doneAt);
}

async function bookSales({ client, dueAt, queryBusy, sendEmail, upsert = upsertMeetingEvent, now }) {
  const listed = await loadCalendarBusy('sales', client, { queryBusy, ymd: dueAt.slice(0, 10) });
  if (!listed.ok || !slotIsFree(dueAt, salesCalendarMinutes(client), listed.busy)) {
    return proposeSales({
      client,
      day: { ymd: dueAt.slice(0, 10), band: 'day' },
      queryBusy,
      occupied: listed.ok ? dueAt : '',
      sendEmail,
      now,
    });
  }
  const previous = client;
  const meeting = salesMeetingAction(client);
  let updated;
  if (meeting?.id) {
    updated = sales.setSalesNextAction(client.id, { op: 'update', id: meeting.id, dueAt });
  } else {
    updated = sales.updateSalesClient(client.id, { meetingAt: dueAt, agreedTime: true, meetingAtSource: 'sales' });
  }
  const live = updated || client;
  if (shouldSyncSalesMeetingCalendar({ ownerId: live.ownerId, calendar: live.calendar })) {
    try {
      const event = await upsert(live, live.calendar?.eventId, calendarOwnerIdForSync(live.ownerId), {
        sendUpdates: 'all',
        includeAttendees: true,
        forceGuestInvite: true,
      });
      if (event?.id) {
        sales.setSalesCalendar(live.id, {
          eventId: event.id,
          meetLink: event.hangoutLink || live.calendar?.meetLink || '',
          htmlLink: event.htmlLink || '',
        });
      }
    } catch {
      // Card time is set; Google write is best-effort.
    }
  }
  const mailed = await sendClientMail(sales.getSalesClientById(client.id) || live, {
    subject: 'Møtet er flyttet',
    text: `Den er grei. Vi kan ta møtet ${formatMeetingDate(dueAt)}. Svar hvis det ikke passer.`,
  }, sendEmail);
  return { wrote: true, kind: 'sales_book', mailed, previous };
}

function ensureCheckupAction(client, { format = 'ring', dueAt = '', note = '' } = {}) {
  const patch = {
    op: 'create',
    name: 'Oppsjekk møtetid',
    format: ['sms', 'ring', 'email'].includes(format) ? format : 'ring',
    dueAt: dueAt || weekFrom(),
    addToCalendar: false,
    sticky: false,
    note,
  };
  try {
    return sales.setSalesNextAction(client.id, { ...patch, presetKey: 'findMeetingTime' });
  } catch {
    try {
      return sales.setSalesNextAction(client.id, { ...patch, presetKey: 'custom' });
    } catch {
      return null;
    }
  }
}

async function salesDefer({ client, sendEmail, now, decision = {} }) {
  const dueAt = weekFrom(now);
  ensureCheckupAction(client, {
    format: decision.checkupFormat || 'ring',
    dueAt,
    note: decision.checkupNote || 'Kunden kan ikke avtale møtetid nå.',
  });
  const name = sanitize(client.businessName) || 'dere';
  const mailed = await sendClientMail(sales.getSalesClientById(client.id) || client, {
    subject: decision.subject || 'Re: møtet',
    text: decision.reply || `Skjønner. Synd det ikke passer akkurat nå. Hva er grunnen, om du vil si det? Vi tar en sjekk om en uke og finner en tid som funker. Det er et kort møte (${CLIENT_MEETING_DURATION_MINUTES} min) om nettsiden til ${name}.`,
  }, sendEmail);
  return { wrote: true, kind: 'walk_away', mailed, checkupDueAt: dueAt };
}

function ensureRescheduleAction(client, { dueAt = '', note = '' } = {}) {
  try {
    return sales.setSalesNextAction(client.id, {
      op: 'create',
      name: 'Ny møtetid',
      presetKey: 'findMeetingTime',
      format: 'ring',
      dueAt: dueAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      addToCalendar: false,
      sticky: false,
      note,
    });
  } catch {
    return null;
  }
}

async function proposeSales({ client, day, queryBusy, occupied = '', sendEmail, now, cancel = false, note = '', reply = '', subject = '' }) {
  const durationMin = salesCalendarMinutes(client);
  const listed = await loadCalendarBusy('sales', client, { queryBusy, ymd: day?.ymd });
  const slots = listed.ok
    ? (day?.ymd
      ? pickFreeSlots({
        ymd: day.ymd,
        band: day.band || 'day',
        durationMin,
        busy: listed.busy,
        now,
      })
      : pickFreeSlotsAhead({ durationMin, busy: listed.busy, now }))
    : [];
  if (cancel) {
    ensureRescheduleAction(client, {
      dueAt: morningDueAt(day) || slots[0] || '',
      note: note || 'Kunden avlyste. Finn ny tid.',
    });
  }
  if (!slots.length) {
    const dueAt = morningDueAt(day);
    if (!cancel) {
      try {
        sales.setSalesNextAction(client.id, {
          op: 'create',
          name: 'Finn møtetid med kunden',
          presetKey: 'custom',
          format: 'ring',
          dueAt: dueAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          addToCalendar: false,
          sticky: false,
        });
      } catch {
        // Goal may not accept a custom action; mail still goes out.
      }
    }
    const mailed = await sendClientMail(sales.getSalesClientById(client.id) || client, {
      subject: 'Møtetid',
      text: 'Den er grei. Vi sjekker kalenderen til selgeren din og kommer tilbake med tider som passer.',
    }, sendEmail);
    return { wrote: true, kind: 'sales_propose', mailed };
  }
  const list = formatSlotListNb(slots);
  const lengthNote = client?.meetingMode === 'in-person'
    ? ''
    : ` Møtet er ${CLIENT_MEETING_DURATION_MINUTES} minutter.`;
  const fallback = occupied
    ? `Takk. ${formatMeetingDate(occupied)} er dessverre opptatt hos oss. Passer noe av dette: ${list}?${lengthNote}`
    : cancel
      ? `Takk, da stryker vi den tiden. Passer noe av dette i stedet: ${list}?${lengthNote} Svar med et av tidspunktene.`
      : `Takk, da flytter vi. Passer noe av dette: ${list}?${lengthNote} Svar med et av tidspunktene.`;
  const mailed = await sendClientMail(sales.getSalesClientById(client.id) || client, {
    subject: subject || (occupied ? 'Møtetid — det tidspunktet var opptatt' : cancel ? 'Møtetid — nye tider' : 'Møtetid — foreslåtte tider'),
    text: withOfferedSlots(reply, slots) || fallback,
  }, sendEmail);
  return { wrote: true, kind: 'sales_propose', mailed, slots };
}

async function salesCall({ client, day, sendEmail }) {
  const dueAt = morningDueAt(day) || new Date(Date.now() + 60 * 60 * 1000).toISOString();
  try {
    sales.setSalesNextAction(client.id, {
      op: 'create',
      name: 'Ring og avtale møtetid',
      presetKey: 'custom',
      format: 'ring',
      dueAt,
      addToCalendar: false,
      sticky: false,
    });
  } catch {
    // Goal may not accept a custom action; mail still goes out.
  }
  const mailed = await sendClientMail(sales.getSalesClientById(client.id) || client, {
    subject: 'Re: møtet',
    text: 'Den er grei. Vi ringer deg og avtaler et tidspunkt.',
  }, sendEmail);
  return { wrote: true, kind: 'sales_call', mailed };
}

export async function handleInboxWrite({
  client,
  message,
  classified,
  via,
  confirmWorkshop = confirmWorkshopAndMail,
  loadNeeds = loadPrepNeedLines,
  queryBusy = queryWorkshopFreeBusy,
  sendEmail = emailLib.sendEmail,
  upsert = upsertMeetingEvent,
  now = new Date(),
  decideAi,
} = {}) {
  if (via !== 'email' || !client?.id) {
    return { wrote: false, reason: 'unmatched-from' };
  }
  if (sales.isSsuSalesProduct(client.product)) {
    return { wrote: false, reason: 'ssu' };
  }
  const text = blobOf(message);
  const classifiedDue = resolveInboxWorkshopDueAt(text, classified?.dueAt, { now });
  const classified_ = classifyInboxWrite(text, client, { now });
  if (classifiedDue && classified_.intent === 'none') {
    classified_.intent = client.progression?.contractSigned ? 'workshop_book' : 'sales_book';
    classified_.dueAt = classifiedDue;
  }
  const history = listInboxItems({ salesClientId: client.id }).slice(-8).map((row) => ({
    at: row.receivedAt,
    from: row.from,
    subject: row.subject,
    kind: row.kind,
    summary: row.summary,
  }));
  const decision = await decideInboxWrite({
    client,
    message,
    heuristic: classified_,
    history,
    now,
    decideAi,
  });
  classified_.intent = decision.intent || classified_.intent;
  if (decision.walkAway) classified_.intent = 'walk_away';
  if (classified_.intent === 'none' || classified_.intent === 'gather') {
    if (decision.reply) {
      const mailed = await sendClientMail(client, {
        subject: decision.subject || `Re: ${sanitize(message.subject) || 'møtet'}`,
        text: decision.reply,
      }, sendEmail);
      appendInboxItem({
        kind: 'gather',
        mailbox: message.mailbox,
        messageId: `${message.id}:write`,
        salesClientId: client.id,
        from: message.from,
        subject: message.subject,
        summary: 'Svar med tråd-kontekst',
        receivedAt: message.mailAt || new Date().toISOString(),
        status: mailed.sent ? 'applied' : 'logged',
      });
      return { wrote: true, kind: 'gather', mailed };
    }
    return { wrote: false, reason: 'no-intent' };
  }

  let result;
  if (classified_.intent === 'walk_away') {
    result = await salesDefer({
      client,
      sendEmail,
      now,
      decision: { ...decision, checkupNote: decision.checkupNote || freshReplyText(message.text).slice(0, 240) },
    });
  } else if (classified_.intent === 'workshop_call') result = await workshopCall({ client, day: classified_.day, sendEmail });
  else if (classified_.intent === 'workshop_book') {
    result = await bookWorkshop({
      client,
      message,
      dueAt: classified_.dueAt,
      classified,
      confirmWorkshop,
      loadNeeds,
      queryBusy,
      sendEmail,
      now,
    });
  } else if (classified_.intent === 'workshop_propose') {
    result = await proposeWorkshop({
      client,
      day: classified_.day,
      queryBusy,
      sendEmail,
      now,
      cancel: Boolean(classified_.cancel),
      note: freshReplyText(message.text).slice(0, 240),
    });
  } else if (classified_.intent === 'sales_call') result = await salesCall({ client, day: classified_.day, sendEmail });
  else if (classified_.intent === 'sales_book') {
    result = await bookSales({ client, dueAt: classified_.dueAt, queryBusy, sendEmail, upsert, now });
  } else if (classified_.intent === 'sales_propose') {
    result = await proposeSales({
      client,
      day: classified_.day,
      queryBusy,
      sendEmail,
      now,
      cancel: Boolean(classified_.cancel),
      note: freshReplyText(message.text).slice(0, 240),
      reply: decision.reply,
      subject: decision.subject,
    });
  } else {
    return { wrote: false, reason: 'no-intent' };
  }

  appendInboxItem({
    kind: result.kind || 'write',
    mailbox: message.mailbox,
    messageId: `${message.id}:write`,
    salesClientId: client.id,
    from: message.from,
    subject: message.subject,
    summary: result.kind || 'inbox-write',
    receivedAt: message.mailAt || new Date().toISOString(),
    status: result.mailed?.sent ? 'applied' : 'logged',
  });
  return result;
}
