import * as sales from '../../data/sales.js';
import * as emailLib from '../email.js';
import { queryWorkshopFreeBusy, upsertMeetingEvent } from '../google-calendar.js';
import { calendarOwnerIdForSync, isAssignedSalesRepOwner, shouldSyncSalesMeetingCalendar } from '../sales-calendar-owner.js';
import { formatMeetingDate } from '../sales-email.js';
import { osloWallToIso } from '../website-due.js';
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
import { appendInboxItem } from './store.js';
import { formatSlotListNb, pickFreeSlots, slotIsFree } from './slots.js';

const SALES_DURATION_MIN = 60;

function sanitize(value = '') {
  return String(value || '').trim();
}

function blobOf(message = {}) {
  return `${message.subject || ''} ${message.text || ''}`;
}

function recipientOf(client = {}) {
  const email = sanitize(client?.contactEmail);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function classifyInboxWrite(text = '', client = {}, { now = new Date() } = {}) {
  const signed = Boolean(client?.progression?.contractSigned);
  const dueAt = parseWorkshopTimeHeuristic(text, { now })?.dueAt || '';
  const day = parseDayHint(text, { now });
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

async function bookWorkshop({ client, message, dueAt, classified, confirmWorkshop, loadNeeds, queryBusy, sendEmail }) {
  const dayYmd = dueAt.slice(0, 10);
  const listed = await loadCalendarBusy('workshop', client, { queryBusy, ymd: dayYmd });
  if (!listed.ok || !slotIsFree(dueAt, WORKSHOP_DURATION_MINUTES, listed.busy)) {
    return proposeWorkshop({
      client,
      day: { ymd: dayYmd, band: 'day' },
      queryBusy,
      occupied: listed.ok ? dueAt : '',
      sendEmail,
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

async function proposeWorkshop({ client, day, queryBusy, occupied = '', sendEmail }) {
  const listed = await loadCalendarBusy('workshop', client, { queryBusy, ymd: day?.ymd });
  const slots = listed.ok
    ? pickFreeSlots({
      ymd: day.ymd,
      band: day.band || 'day',
      durationMin: WORKSHOP_DURATION_MINUTES,
      busy: listed.busy,
    })
    : [];
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
    subject: occupied ? 'Workshop — det tidspunktet var opptatt' : 'Workshop — foreslåtte tider',
    text: occupied
      ? `Takk. ${formatMeetingDate(occupied)} er dessverre opptatt. Passer noe av dette i stedet: ${list}? Svar med et av tidspunktene.`
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

async function bookSales({ client, dueAt, queryBusy, sendEmail, upsert = upsertMeetingEvent }) {
  const listed = await loadCalendarBusy('sales', client, { queryBusy, ymd: dueAt.slice(0, 10) });
  if (!listed.ok || !slotIsFree(dueAt, SALES_DURATION_MIN, listed.busy)) {
    return proposeSales({
      client,
      day: { ymd: dueAt.slice(0, 10), band: 'day' },
      queryBusy,
      occupied: listed.ok ? dueAt : '',
      sendEmail,
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

async function proposeSales({ client, day, queryBusy, occupied = '', sendEmail }) {
  const listed = await loadCalendarBusy('sales', client, { queryBusy, ymd: day?.ymd });
  const slots = listed.ok
    ? pickFreeSlots({
      ymd: day.ymd,
      band: day.band || 'day',
      durationMin: SALES_DURATION_MIN,
      busy: listed.busy,
    })
    : [];
  if (!slots.length) {
    const dueAt = morningDueAt(day);
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
    const mailed = await sendClientMail(sales.getSalesClientById(client.id) || client, {
      subject: 'Møtetid',
      text: 'Den er grei. Vi sjekker kalenderen til selgeren din og kommer tilbake med tider som passer.',
    }, sendEmail);
    return { wrote: true, kind: 'sales_propose', mailed };
  }
  const list = formatSlotListNb(slots);
  const mailed = await sendClientMail(client, {
    subject: occupied ? 'Møtetid — det tidspunktet var opptatt' : 'Møtetid — foreslåtte tider',
    text: occupied
      ? `Takk. ${formatMeetingDate(occupied)} er dessverre opptatt hos oss. Passer noe av dette: ${list}?`
      : `Takk, da flytter vi. Passer noe av dette: ${list}? Svar med et av tidspunktene.`,
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
} = {}) {
  if (via !== 'email' || !client?.id) {
    return { wrote: false, reason: 'unmatched-from' };
  }
  if (sales.isSsuSalesProduct(client.product)) {
    return { wrote: false, reason: 'ssu' };
  }
  const text = blobOf(message);
  const classifiedDue = resolveInboxWorkshopDueAt(text, classified?.dueAt);
  const classified_ = classifyInboxWrite(text, client, { now });
  if (classifiedDue && classified_.intent === 'none') {
    classified_.intent = client.progression?.contractSigned ? 'workshop_book' : 'sales_book';
    classified_.dueAt = classifiedDue;
  }
  if (classified_.intent === 'none') return { wrote: false, reason: 'no-intent' };

  let result;
  if (classified_.intent === 'workshop_call') result = await workshopCall({ client, day: classified_.day, sendEmail });
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
    });
  } else if (classified_.intent === 'workshop_propose') {
    result = await proposeWorkshop({ client, day: classified_.day, queryBusy, sendEmail });
  } else if (classified_.intent === 'sales_call') result = await salesCall({ client, day: classified_.day, sendEmail });
  else if (classified_.intent === 'sales_book') {
    result = await bookSales({ client, dueAt: classified_.dueAt, queryBusy, sendEmail, upsert });
  } else if (classified_.intent === 'sales_propose') {
    result = await proposeSales({ client, day: classified_.day, queryBusy, sendEmail });
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
