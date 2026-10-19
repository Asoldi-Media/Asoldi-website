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
  looksUnsureForNow,
  parseDayHint,
  parseWorkshopTimeHeuristic,
  resolveInboxWorkshopDueAt,
} from '../workshop-time-parse.js';
import { confirmWorkshopAndMail, loadPrepNeedLines } from '../workshop-prep-send.js';
import { applyWorkshopTimeFromInbox } from './apply-workshop-time.js';
import { appendInboxItem, listInboxItems } from './store.js';
import { formatSlotListNb, pickFreeSlots, pickFreeSlotsAhead, slotIsFree } from './slots.js';
import { calendarDurationForMode } from '../sales-meeting-duration.js';
import { clientMeetingAt, decideInboxWrite, looksLikeWalkAway, polishInboxReply } from './decide.js';
import { freshReplyText, inboxWriteBlob } from './thread.js';
import { isAutomatedMail } from '../../packages/suite/core/mail/automated.js';
import { osloCalendarYmd, osloWallToIso } from '../website-due.js';

function sanitize(value = '') {
  return String(value || '').trim();
}

export { freshReplyText, inboxWriteBlob } from './thread.js';
export { isAutomatedMail };

// "ikke aktuelt akkurat nå, ta kontakt om en måned" is a later follow-up, not a walk-away.
const NOT_NOW_RE = /\bakkurat nå\b|\bfor øyeblikket\b|\bper nå\b|\bta (?:gjerne )?kontakt (?:igjen )?(?:om|senere|neste|litt)/i;
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

// A concrete reason ("ferie til", "etter jul", "flytter") makes a far date fine; otherwise we aim sooner.
const DELAY_REASON_RE = /\bferie|\breis|\bbortreist|\bsyk|\bpermisjon|\bbarsel|\bflytt|\båpn|\bsesong|\boperasjon|\bbudsjett|\bregnskap|\better (?:jul|påske|nyttår|sommer|ferien|helgen)/i;

/** "om en måned" with no reason → about three weeks. Soft nudge, not a cap. */
export function pullInVagueDay(day, text = '', { now = new Date() } = {}) {
  if (!day?.ymd || DELAY_REASON_RE.test(text)) return day;
  const origin = now instanceof Date ? now : new Date(now);
  const todayYmd = osloCalendarYmd(origin.toISOString());
  const days = Math.round((Date.parse(`${day.ymd}T12:00:00Z`) - Date.parse(`${todayYmd}T12:00:00Z`)) / 86400000);
  if (days < 14) return day;
  const target = new Date(`${todayYmd}T12:00:00.000Z`);
  target.setUTCDate(target.getUTCDate() + Math.round(days * 0.75));
  const weekday = target.getUTCDay();
  if (weekday === 6 || weekday === 0) target.setUTCDate(target.getUTCDate() + (weekday === 6 ? 2 : 1));
  return { ...day, ymd: target.toISOString().slice(0, 10), pulledInFrom: day.ymd };
}

export function classifyInboxWrite(text = '', client = {}, { now = new Date() } = {}) {
  const signed = Boolean(client?.progression?.contractSigned);
  const dueAt = parseWorkshopTimeHeuristic(text, { now })?.dueAt || '';
  const day = pullInVagueDay(parseDayHint(text, { now }), text, { now });
  const walkAway = looksLikeWalkAway(text);
  if (looksUnsureForNow(text) && !dueAt && (!walkAway || NOT_NOW_RE.test(text))) {
    return { intent: signed ? 'workshop_call' : 'sales_call', dueAt: '', day, unsure: true };
  }
  if (walkAway && !dueAt) {
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
  else end.setUTCDate(end.getUTCDate() + 11);
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
  if (mailFn === emailLib.sendEmail && !emailLib.canSendEmail()) return { sent: false, warning: 'E-post er ikke konfigurert.' };
  const body = polishInboxReply(text);
  await mailFn({
    to,
    subject,
    text: body,
    html: `<p>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br />')}</p>`,
  });
  return { sent: true, warning: '' };
}

/**
 * Every action the bot adds says so ("Bot: …") with the thread context and the client's own words,
 * so sales can see why it exists and bot actions can be tracked later.
 */
export function botNote(reason = '', ctx = {}) {
  const head = `Bot: ${sanitize(ctx.summary) || sanitize(reason) || 'lagt til fra innboksen.'}`;
  const said = sanitize(ctx.clientText).replace(/\s+/g, ' ');
  return said ? `${head}\nKunden skrev: «${said.length > 300 ? `${said.slice(0, 300)}…` : said}»` : head;
}

/** Never put a bot action in the past (old mail, passed meeting): fall back to the next workday 09:00. */
export function futureDue(dueAt = '', now = new Date()) {
  const origin = now instanceof Date ? now : new Date(now);
  const ms = Date.parse(dueAt);
  return Number.isFinite(ms) && ms > origin.getTime() ? dueAt : workdaysAheadAt9(origin, 1);
}

export function createInboxAdminAction(client, {
  name,
  format = 'ring',
  dueAt = '',
  note = '',
  ctx = {},
} = {}) {
  const record = getWorkshopRecord(client);
  const applied = applyWorkshopGoalActionOp(record, {
    op: 'create',
    goalKey: getAdminCurrentGoalKey(client) || 'haWorkshop',
    presetKey: 'custom',
    name,
    format,
    dueAt: dueAt ? futureDue(dueAt, ctx.now) : '',
    note: botNote(note, ctx),
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

async function bookWorkshop({ client, message, dueAt, classified, confirmWorkshop, loadNeeds, queryBusy, sendEmail, now, ctx = {} }) {
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
      ctx,
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

async function proposeWorkshop({ client, day, queryBusy, occupied = '', sendEmail, now, cancel = false, ctx = {} }) {
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
        startInDays: 1,
      }))
    : [];
  if (cancel) {
    createInboxAdminAction(client, {
      name: 'Ny workshop-tid',
      format: 'ring',
      dueAt: morningDueAt(day) || slots[0] || '',
      note: occupied ? `Foreslått ${formatMeetingDate(occupied)} var opptatt.` : 'Kunden avlyste workshop. Nye tider foreslått på e-post.',
      ctx,
    });
  }
  if (!slots.length) {
    const action = createInboxAdminAction(client, {
      name: 'Sjekk når kunden har tid til workshop',
      format: 'ring',
      dueAt: morningDueAt(day),
      note: occupied ? `Foreslått ${formatMeetingDate(occupied)} var opptatt.` : 'Fant ingen ledig workshop-tid automatisk.',
      ctx,
    });
    const mailed = await sendClientMail(action.client, {
      subject: 'Workshop — vi finner et tidspunkt',
      text: 'Takk, jeg sjekker kalenderen og kommer tilbake med tidspunkter som passer.',
    }, sendEmail);
    return { wrote: true, kind: 'workshop_propose', mailed, action };
  }
  const list = formatSlotListNb(slots);
  const mailed = await sendClientMail(client, {
    subject: occupied ? 'Workshop — det tidspunktet var opptatt' : cancel ? 'Workshop — nye tider' : 'Workshop — foreslåtte tider',
    text: occupied
      ? `${formatMeetingDate(occupied)} er dessverre opptatt. Passer noe av dette bedre: ${list}?`
      : cancel
        ? `Helt i orden, da tar vi den av. Passer noe av dette bedre: ${list}?`
        : `Passer noe av dette til workshop: ${list}?`,
  }, sendEmail);
  return { wrote: true, kind: 'workshop_propose', mailed, slots };
}

async function workshopCall({ client, day, sendEmail, ctx = {} }) {
  const action = createInboxAdminAction(client, {
    name: 'Sjekk når han har tid for workshop',
    format: 'ring',
    dueAt: morningDueAt(day),
    note: 'Kunden vil avtale workshop på telefon.',
    ctx,
  });
  const mailed = await sendClientMail(action.client, {
    subject: 'Re: workshop',
    text: 'Helt i orden. Jeg ringer deg, så avtaler vi workshop når det passer.',
  }, sendEmail);
  return { wrote: true, kind: 'workshop_call', mailed, action };
}

function salesMeetingAction(client) {
  return (Array.isArray(client?.nextActions) ? client.nextActions : [])
    .find((row) => row?.presetKey === 'meeting' && !row?.doneAt);
}

async function bookSales({ client, dueAt, queryBusy, sendEmail, upsert = upsertMeetingEvent, now, ctx = {} }) {
  const listed = await loadCalendarBusy('sales', client, { queryBusy, ymd: dueAt.slice(0, 10) });
  if (!listed.ok || !slotIsFree(dueAt, salesCalendarMinutes(client), listed.busy)) {
    return proposeSales({
      client,
      day: { ymd: dueAt.slice(0, 10), band: 'day' },
      queryBusy,
      occupied: listed.ok ? dueAt : '',
      sendEmail,
      now,
      ctx,
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
    text: `Da setter jeg opp ${formatMeetingDate(dueAt)}. Du får en oppdatert invitasjon — si fra om det likevel ikke passer.`,
  }, sendEmail);
  return { wrote: true, kind: 'sales_book', mailed, previous };
}

function ensureCheckupAction(client, { format = 'ring', dueAt = '', note = '', ctx = {} } = {}) {
  const patch = {
    op: 'create',
    name: 'Oppsjekk møtetid',
    format: ['sms', 'ring', 'email'].includes(format) ? format : 'ring',
    dueAt: futureDue(dueAt || weekFrom(ctx.now), ctx.now),
    addToCalendar: false,
    sticky: false,
    note: botNote(note, ctx),
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

/** First "ikke interessert": ask why and whether a short chat still works. A second no closes politely. */
async function salesDefer({ client, sendEmail, queryBusy, now, decision = {}, saidNoBefore = false, slots: givenSlots = null, ctx = {} }) {
  if (saidNoBefore) {
    const mailed = await sendClientMail(client, {
      subject: decision.subject || 'Re: møtet',
      text: 'Skjønner, takk for at du tok deg tid til å svare. Ta gjerne kontakt om det blir aktuelt senere.',
    }, sendEmail);
    return { wrote: true, kind: 'walk_away_final', mailed };
  }
  const dueAt = weekFrom(now);
  ensureCheckupAction(client, {
    format: decision.checkupFormat || 'ring',
    dueAt,
    note: 'Kunden sa nei til møtet. Bot spurte om grunnen og tilbød en kort prat likevel.',
    ctx,
  });
  const slots = givenSlots || await salesOfferSlots({ client, day: null, queryBusy, now });
  if (!replyTimesMatch(decision.reply, slots)) decision = { ...decision, reply: '' };
  const ask = 'Skjønner, takk for at du sier ifra. Kan jeg spørre hva som gjorde at det ikke ble aktuelt? Hvis det handler om tidspunktet, tar vi gjerne en kort og uforpliktende prat likevel';
  const fallback = slots.length ? `${ask} — passer noe av dette: ${formatSlotListNb(slots)}?` : `${ask} — si fra hvilken dag som passer.`;
  const mailed = await sendClientMail(sales.getSalesClientById(client.id) || client, {
    subject: decision.subject || 'Re: møtet',
    text: withOfferedSlots(decision.reply, slots) || fallback,
  }, sendEmail);
  return { wrote: true, kind: 'walk_away', mailed, checkupDueAt: dueAt, slots };
}

function ensureRescheduleAction(client, { dueAt = '', note = '', ctx = {} } = {}) {
  try {
    return sales.setSalesNextAction(client.id, {
      op: 'create',
      name: 'Ny møtetid',
      presetKey: 'findMeetingTime',
      format: 'ring',
      dueAt: futureDue(dueAt, ctx.now),
      addToCalendar: false,
      sticky: false,
      note: botNote(note, ctx),
    });
  } catch {
    return null;
  }
}

/** "Er opptatt fra ca 11-14" on the day the client asked for → busy blocks so we don't offer those hours. */
export function clientBusyBlocks(text = '', day = null) {
  if (!day?.ymd) return [];
  const out = [];
  for (const match of String(text || '').matchAll(/\bopptatt\s+(?:fra\s+)?(?:ca\.?\s*)?(?:kl\.?\s*)?(\d{1,2})(?:[:.]\d{2})?\s*(?:-|–|til)\s*(\d{1,2})/gi)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (from >= 6 && to <= 22 && to > from) {
      out.push({ start: osloWallToIso(day.ymd, from, 0, 0), end: osloWallToIso(day.ymd, to, 0, 0) });
    }
  }
  return out;
}

async function salesOfferSlots({ client, day, queryBusy, now, clientBusy = [] }) {
  const durationMin = salesCalendarMinutes(client);
  const listed = await loadCalendarBusy('sales', client, { queryBusy, ymd: day?.ymd });
  if (!listed.ok) return [];
  const busy = [...listed.busy, ...clientBusy];
  return day?.ymd
    ? pickFreeSlots({ ymd: day.ymd, band: day.band || 'day', durationMin, busy, now })
    : pickFreeSlotsAhead({ durationMin, busy, now });
}

function osloClock(iso = '') {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Oslo' }).format(new Date(iso));
}

/** The model may only name times we actually offer; anything else drops its reply for the fallback. */
export function replyTimesMatch(text = '', slots = []) {
  const offered = new Set(slots.map(osloClock));
  for (const match of String(text || '').matchAll(/\bkl\.?\s*(\d{1,2})(?:[:.](\d{2}))?|\b(\d{1,2})[:.](\d{2})\b/gi)) {
    const hour = String(match[1] ?? match[3]).padStart(2, '0');
    const minute = String(match[2] ?? match[4] ?? '00').padStart(2, '0');
    if (!offered.has(`${hour}:${minute}`)) return false;
  }
  return true;
}

async function proposeSales({ client, day, queryBusy, occupied = '', sendEmail, now, cancel = false, reply = '', subject = '', slots: given = null, ctx = {} }) {
  const slots = given || await salesOfferSlots({ client, day, queryBusy, now });
  if (!replyTimesMatch(reply, slots)) reply = '';
  if (cancel) {
    ensureRescheduleAction(client, {
      dueAt: morningDueAt(day) || slots[0] || '',
      note: slots.length
        ? `Kunden avlyste. Bot foreslo nye tider: ${formatSlotListNb(slots)}.`
        : 'Kunden avlyste. Fant ingen ledig tid automatisk.',
      ctx,
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
          dueAt: futureDue(dueAt, ctx.now),
          addToCalendar: false,
          sticky: false,
          note: botNote('Fant ingen ledig tid i kalenderen automatisk.', ctx),
        });
      } catch {
        // Goal may not accept a custom action; mail still goes out.
      }
    }
    const mailed = await sendClientMail(sales.getSalesClientById(client.id) || client, {
      subject: 'Møtetid',
      text: 'Takk, jeg sjekker kalenderen og kommer tilbake med tider som passer.',
    }, sendEmail);
    return { wrote: true, kind: 'sales_propose', mailed };
  }
  const list = formatSlotListNb(slots);
  const fallback = occupied
    ? `${formatMeetingDate(occupied)} er dessverre opptatt hos oss. Passer noe av dette bedre: ${list}?`
    : cancel
      ? `Helt i orden, da tar vi den av. Passer noe av dette bedre: ${list}?`
      : `Passer noe av dette: ${list}?`;
  const mailed = await sendClientMail(sales.getSalesClientById(client.id) || client, {
    subject: subject || (occupied ? 'Møtetid — det tidspunktet var opptatt' : cancel ? 'Møtetid — nye tider' : 'Møtetid — foreslåtte tider'),
    text: withOfferedSlots(reply, slots) || fallback,
  }, sendEmail);
  return { wrote: true, kind: 'sales_propose', mailed, slots };
}

function checkupFormatFrom(text = '') {
  const blob = String(text || '').toLowerCase();
  if (/\bsms\b|\bmelding\b|\btekst(?:e|melding)?\b/.test(blob)) return 'sms';
  if (/\be-?post\b|\bmail\b|\bmaile\b/.test(blob)) return 'email';
  return 'ring';
}

function osloParts(iso = '') {
  const ms = Date.parse(iso);
  const date = Number.isFinite(ms) ? new Date(ms) : new Date();
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Europe/Oslo' }).format(date);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Oslo' }).format(date));
  return { ymd: osloCalendarYmd(date.toISOString()), weekend: weekday === 'Sat' || weekday === 'Sun', hour };
}

function workdaysAheadAt9(now = new Date(), count = 1) {
  const origin = now instanceof Date ? now : new Date(now);
  let ymd = osloParts(origin.toISOString()).ymd;
  let left = Math.max(1, count);
  while (left > 0) {
    const next = new Date(`${ymd}T12:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    ymd = next.toISOString().slice(0, 10);
    if (!osloParts(osloWallToIso(ymd, 12, 0, 0)).weekend) left -= 1;
  }
  return osloWallToIso(ymd, 9, 0, 0);
}

/** "i morgen" / "på torsdag" / "mandag 2. november" for a follow-up date. */
function whenPhraseNb(dueAt = '', now = new Date()) {
  const origin = now instanceof Date ? now : new Date(now);
  const dueYmd = osloCalendarYmd(dueAt);
  const todayYmd = osloCalendarYmd(origin.toISOString());
  const days = Math.round((Date.parse(`${dueYmd}T12:00:00Z`) - Date.parse(`${todayYmd}T12:00:00Z`)) / 86400000);
  if (days <= 0) return 'i dag';
  if (days === 1) return 'i morgen';
  const date = new Date(Date.parse(dueAt));
  if (days < 7) return `på ${new Intl.DateTimeFormat('nb-NO', { weekday: 'long', timeZone: 'Europe/Oslo' }).format(date)}`;
  return new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Oslo' }).format(date);
}

/** Client can't pick a time now or asked to be called: a follow-up on the card, never a meeting time. */
async function salesCall({ client, day, sendEmail, now = new Date(), text = '', unsure = false, ctx = {} }) {
  const format = checkupFormatFrom(text);
  const origin = now instanceof Date ? now : new Date(now);
  const current = osloParts(origin.toISOString());
  let dueAt = morningDueAt(day);
  if (dueAt && Date.parse(dueAt) <= origin.getTime()) dueAt = '';
  if (dueAt && osloParts(dueAt).weekend && !/lørdag|søndag|helg/i.test(text)) dueAt = workdaysAheadAt9(new Date(dueAt), 1);
  let soon = false;
  if (!dueAt && !unsure) {
    soon = !current.weekend && current.hour >= 8 && current.hour < 15;
    dueAt = soon ? new Date(origin.getTime() + 60 * 60 * 1000).toISOString() : workdaysAheadAt9(origin, 1);
  }
  if (!dueAt) dueAt = workdaysAheadAt9(origin, 3);
  const when = soon ? 'i løpet av dagen' : whenPhraseNb(dueAt, origin);
  ensureCheckupAction(client, {
    format,
    dueAt,
    note: unsure
      ? `Kunden kan ikke avtale møtetid nå. Bot lovet å ta kontakt ${when}.`
      : `Kunden ba oss ringe for å avtale møtetid. Bot lovet å ringe ${when}.`,
    ctx,
  });
  const verb = format === 'sms' ? 'sender jeg deg en melding' : format === 'email' ? 'sender jeg deg en e-post' : 'ringer jeg deg';
  const mailed = await sendClientMail(sales.getSalesClientById(client.id) || client, {
    subject: 'Re: møtet',
    text: `Helt greit. Da ${verb} ${when}, så tar vi det derfra.`,
  }, sendEmail);
  return { wrote: true, kind: 'sales_call', mailed, checkupDueAt: dueAt, checkupFormat: format };
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
  if (isAutomatedMail(message)) {
    return { wrote: false, reason: 'automated' };
  }
  const text = blobOf(message);
  const classifiedDue = resolveInboxWorkshopDueAt(text, classified?.dueAt, { now });
  const classified_ = classifyInboxWrite(text, client, { now });
  if (classifiedDue && classified_.intent === 'none') {
    classified_.intent = client.progression?.contractSigned ? 'workshop_book' : 'sales_book';
    classified_.dueAt = classifiedDue;
  }
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const todayYmd = osloCalendarYmd(new Date(nowMs).toISOString());
  // A time or day that has already passed is never booked; offer new times instead.
  if (classified_.dueAt && Date.parse(classified_.dueAt) <= nowMs) {
    classified_.dueAt = '';
    classified_.day = null;
    if (/_book$/.test(classified_.intent)) classified_.intent = classified_.intent.replace(/_book$/, '_propose');
  }
  if (classified_.day?.ymd && classified_.day.ymd < todayYmd) classified_.day = null;
  const history = listInboxItems({ salesClientId: client.id }).slice(-8).map((row) => ({
    at: row.receivedAt,
    from: row.from,
    subject: row.subject,
    kind: row.kind,
    summary: row.summary,
    text: row.text || '',
  }));
  let dayText = freshReplyText(message.text);
  // "Kan ikke i dag likevel" after "kan vi ta fredag? opptatt 11-14": the day lives in the earlier mail.
  if (classified_.cancel && !classified_.dueAt && !classified_.day) {
    for (const row of [...history].reverse()) {
      const at = Date.parse(row.at);
      if (!row.text || !Number.isFinite(at) || at < nowMs - 3 * 86400000 || at > nowMs) continue;
      const day = parseDayHint(row.text, { now: new Date(at) });
      if (day && day.ymd >= todayYmd) {
        classified_.day = day;
        dayText = row.text;
        break;
      }
    }
  }
  const signed = Boolean(client.progression?.contractSigned);
  const meetingAt = clientMeetingAt(client);
  const meetingPassed = Boolean(meetingAt) && Date.parse(meetingAt) < nowMs;
  const needsTimes = classified_.intent === 'sales_propose' || classified_.intent === 'walk_away'
    || (meetingPassed && (classified_.intent === 'none' || classified_.intent === 'gather'));
  const offerSlots = !signed && needsTimes
    ? await salesOfferSlots({ client, day: classified_.day, queryBusy, now, clientBusy: clientBusyBlocks(dayText, classified_.day) })
    : null;
  const decision = await decideInboxWrite({
    client,
    message,
    heuristic: classified_,
    history,
    now,
    decideAi,
    offerTimes: offerSlots ? formatSlotListNb(offerSlots) : '',
  });
  classified_.intent = decision.intent || classified_.intent;
  if (decision.walkAway) classified_.intent = 'walk_away';
  const ctx = { summary: decision.checkupNote, clientText: freshReplyText(message.text), now };
  if (classified_.intent === 'none' || classified_.intent === 'gather') {
    if (decision.reply && replyTimesMatch(decision.reply, offerSlots || [])) {
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
        text: freshReplyText(message.text),
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
      queryBusy,
      now,
      saidNoBefore: history.some((row) => /^walk_away/.test(row.kind || '')),
      slots: offerSlots,
      decision,
      ctx,
    });
  } else if (classified_.intent === 'workshop_call') result = await workshopCall({ client, day: classified_.day, sendEmail, ctx });
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
      ctx,
    });
  } else if (classified_.intent === 'workshop_propose') {
    result = await proposeWorkshop({
      client,
      day: classified_.day,
      queryBusy,
      sendEmail,
      now,
      cancel: Boolean(classified_.cancel),
      ctx,
    });
  } else if (classified_.intent === 'sales_call') {
    result = await salesCall({
      client,
      day: classified_.day,
      sendEmail,
      now,
      text: freshReplyText(message.text),
      unsure: Boolean(classified_.unsure) || looksUnsureForNow(freshReplyText(message.text)),
      ctx,
    });
  }
  else if (classified_.intent === 'sales_book') {
    result = await bookSales({ client, dueAt: classified_.dueAt, queryBusy, sendEmail, upsert, now, ctx });
  } else if (classified_.intent === 'sales_propose') {
    result = await proposeSales({
      client,
      day: classified_.day,
      queryBusy,
      sendEmail,
      now,
      cancel: Boolean(classified_.cancel),
      reply: decision.reply,
      subject: decision.subject,
      slots: offerSlots,
      ctx,
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
    text: freshReplyText(message.text),
    receivedAt: message.mailAt || new Date().toISOString(),
    status: result.mailed?.sent ? 'applied' : 'logged',
  });
  return result;
}
