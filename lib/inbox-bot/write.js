import * as sales from '../../data/sales.js';
import * as emailLib from '../email.js';
import { queryWorkshopFreeBusy } from '../google-calendar.js';
import { calendarOwnerIdForSync, isAssignedSalesRepOwner } from '../sales-calendar-owner.js';
import { formatMeetingDate } from '../sales-email.js';
import { titleCaseFirst } from '../sales-sender.js';
import { recordOpsEvent } from '../ops-events.js';
import { calendarDurationForMode } from '../sales-meeting-duration.js';
import { osloCalendarYmd, osloWallToIso } from '../website-due.js';
import { cachedDateTimeFormat } from '../date-format-cache.js';
import { isAutomatedMail } from '../../packages/suite/core/mail/automated.js';
import { appendInboxItem, listInboxItems, updateInboxItem } from './store.js';
import { formatSlotListNb, isWeekendYmd, pickFreeSlots, pickFreeSlotsAhead, slotIsFree, withinMeetingHours } from './slots.js';
import { decideInboxWrite, polishInboxReply, replyTimesMatch } from './decide.js';
import { classifyInboxRequest } from './intent.js';
import { parseTimeDetail } from '../workshop-time-parse.js';
import { cardOwnAddresses, extractGuestRequest, isExcludedGuestAddress } from './guests.js';
import { bookedMeetingAt, defaultAddMeetingGuests, defaultMoveMeeting, defaultVoidMeeting } from './meeting.js';
import { parseEmailAddress } from './match-client.js';
import { INBOX_BOT_STAGE_LABELS, inboxBotStage } from './stage.js';
import { freshReplyText, inboxWriteBlob } from './thread.js';

export { freshReplyText, inboxWriteBlob } from './thread.js';
export { isAutomatedMail, replyTimesMatch };

const DAY_MS = 86400000;
/** The bot's last slot offer still counts as "the times we offered" for this long. */
const OFFER_MEMORY_MS = 14 * DAY_MS;
/** Older than this on the real clock, a mail never voids or moves a meeting: the card may have changed since. */
const STALE_MAIL_MS = 30 * 60 * 1000;
/** The mailbox the bot reads; replies point back to it so the client's answer reaches the bot. */
const BOT_MAILBOX = 'alexander@asoldi.com';

function sanitize(value = '') {
  return String(value || '').trim();
}
function nowDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function uniq(list = []) {
  return [...new Set(list.filter(Boolean))].sort();
}

function salesCalendarMinutes(client = {}) {
  return calendarDurationForMode(client?.meetingMode);
}

function validEmail(value = '') {
  const email = sanitize(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

/** Who gets the reply: the address the client wrote from (one of the card's own, or a guest), else the card contact. */
function replyTarget(client = {}, message = {}, via = '') {
  const sender = via === 'email' || via === 'guest' ? validEmail(parseEmailAddress(message.from)) : '';
  return sender || validEmail(client?.contactEmail);
}

/**
 * The client-side people a reply keeps in the thread: Cc and To of the incoming mail, minus the reply target,
 * the bot mailbox, our own staff and Fireflies; a guest's reply also goes to the card contact. Max 5.
 */
export function replyCcList(message = {}, { to = '', client = {}, via = '' } = {}) {
  const seen = new Set([sanitize(to).toLowerCase()]);
  const out = [];
  const add = (value) => {
    const address = validEmail(parseEmailAddress(value));
    if (!address || seen.has(address)) return;
    if (isExcludedGuestAddress(address, { from: '', client: {} })) return;
    seen.add(address);
    out.push(address);
  };
  if (via === 'guest') add(client?.contactEmail);
  for (const row of [...(Array.isArray(message.cc) ? message.cc : []), ...(Array.isArray(message.toList) ? message.toList : [])]) add(row?.email);
  return out.slice(0, 5);
}

const joinNb = (list = []) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} og ${list.at(-1)}` : (list[0] || ''));

/** "Kari Hansen (kari@partner.example)" for one guest, the address alone when no name is known. */
function guestLabel(guest = {}, { withEmail = true } = {}) {
  const name = sanitize(guest.name);
  if (!name) return sanitize(guest.email);
  return withEmail ? `${name} (${sanitize(guest.email)})` : name;
}

/** What the reply says about the guests, claiming only what happened. Empty when nobody was asked for. */
function guestLine(env) {
  const guest = env.guest;
  if (!guest) return '';
  const lines = [];
  if (guest.added.length) {
    if (env.bookedNow) {
      const invited = guest.invited || env.movedNow;
      lines.push(invited
        ? `Jeg har også lagt til ${joinNb(guest.added.map((row) => guestLabel(row)))} på invitasjonen.`
        : `Jeg har også lagt til ${joinNb(guest.added.map((row) => guestLabel(row)))} på møtet.`);
    } else {
      lines.push(`${joinNb(guest.added.map((row) => guestLabel(row, { withEmail: false })))} får invitasjonen når vi har satt en tid.`);
    }
  }
  const missing = guestMissingLine(guest);
  if (missing) lines.push(missing);
  return lines.join(' ');
}

/** A name the client gave without an address: ask for it. */
function guestMissingLine(guest = {}) {
  const names = guest.unresolved || [];
  if (!names.length) return '';
  return `Jeg fant ikke e-postadressen til ${joinNb(names)}. Send den gjerne, så legger jeg ${names.length > 1 ? 'dem' : 'vedkommende'} til.`;
}

/** Always our own subject ("Re: <their subject>"), never one the model wrote. */
function replySubject(message = {}) {
  const original = sanitize(message.subject).replace(/^(?:(?:re|sv|svar|vs|fw|fwd|aw|ang)\s*(?:\[\d+\])?\s*:\s*)+/i, '');
  return `Re: ${original || 'møtet'}`;
}

/** Threading headers when the inbound Message-ID is known: In-Reply-To plus the thread's References chain. */
export function threadHeaders(message = {}) {
  const id = sanitize(message.rfcMessageId || message.messageIdHeader);
  if (!/^<[^<>\s]+@[^<>\s]+>$/.test(id)) return null;
  const earlier = (sanitize(message.references).match(/<[^<>\s]+@[^<>\s]+>/g) || []).filter((ref) => ref !== id).slice(-10);
  return { 'In-Reply-To': id, References: [...earlier, id].join(' ') };
}

/** "Alexander fra Asoldi <alexander@asoldi.com>": the bot answers as the mailbox the client wrote to. */
export function mailboxSender(mailbox = '') {
  const email = parseEmailAddress(mailbox) || BOT_MAILBOX;
  return emailLib.formatMailbox(`${titleCaseFirst(email.split('@')[0])} fra Asoldi`, email);
}

/** Classify a fresh reply for a card (kept for callers that only need the request). */
export function classifyInboxWrite(text = '', client = {}, { now = new Date(), offeredSlots = [] } = {}) {
  return classifyInboxRequest(text, client, { now, offeredSlots });
}

// A concrete reason ("ferie til", "etter jul", "flytter") makes a far date fine; otherwise we aim sooner.
const DELAY_REASON_RE = /\bferie|\breis|\bbortreist|\bsyk|\bpermisjon|\bbarsel|\bflytt|\båpn|\bsesong|\boperasjon|\bbudsjett|\bregnskap|\better (?:jul|påske|nyttår|sommer|ferien|helgen)/i;

/** "om en måned" with no reason → about three weeks. Soft nudge, not a cap. */
export function pullInVagueDay(day, text = '', { now = new Date() } = {}) {
  if (!day?.ymd || DELAY_REASON_RE.test(text)) return day;
  const origin = nowDate(now);
  const todayYmd = osloCalendarYmd(origin.toISOString());
  const days = Math.round((Date.parse(`${day.ymd}T12:00:00Z`) - Date.parse(`${todayYmd}T12:00:00Z`)) / DAY_MS);
  if (days < 14) return day;
  const target = new Date(`${todayYmd}T12:00:00.000Z`);
  target.setUTCDate(target.getUTCDate() + Math.round(days * 0.75));
  const weekday = target.getUTCDay();
  if (weekday === 6 || weekday === 0) target.setUTCDate(target.getUTCDate() + (weekday === 6 ? 2 : 1));
  return { ...day, ymd: target.toISOString().slice(0, 10), pulledInFrom: day.ymd };
}

/** Free/busy for the client's assigned sales rep; not ok when nobody is assigned or Google fails. */
export async function loadCalendarBusy(kind, client, {
  queryBusy,
  ymd = '',
  now = new Date(),
} = {}) {
  const busyFn = queryBusy || queryWorkshopFreeBusy;
  const origin = nowDate(now);
  const timeMin = ymd ? `${ymd}T00:00:00.000Z` : origin.toISOString();
  const end = ymd ? new Date(`${ymd}T00:00:00.000Z`) : new Date(origin.getTime());
  end.setUTCDate(end.getUTCDate() + (ymd ? 2 : 14));
  const timeMax = end.toISOString();
  try {
    if (queryBusy) {
      const listed = await queryBusy(kind, { timeMin, timeMax, client });
      return { ok: true, busy: listed?.busy || [] };
    }
    if (!isAssignedSalesRepOwner(client?.ownerId)) return { ok: false, busy: [] };
    const accountKey = calendarOwnerIdForSync(client.ownerId);
    if (!accountKey) return { ok: false, busy: [] };
    const listed = await busyFn(accountKey, { timeMin, timeMax });
    return { ok: true, busy: listed?.busy || [] };
  } catch {
    return { ok: false, busy: [] };
  }
}

/**
 * The bot's reply: from and Reply-To the mailbox the client wrote to, to the sender, our own subject, in the
 * client's thread. The mailer files a read copy in that mailbox's Innboks and Sendt. Never throws.
 */
async function sendClientMail(env, text, { withGuests = true } = {}) {
  const mailFn = env.sendEmail || emailLib.sendEmail;
  const to = env.to;
  if (!to) return { sent: false, warning: 'Kunden mangler e-post på kortet.' };
  if (mailFn === emailLib.sendEmail && !emailLib.canSendEmail()) return { sent: false, warning: 'E-post er ikke konfigurert.' };
  // A reply that starts with a formatted date ("fredag 7. mars 2031 kl. 14:00 er …") still starts with a capital.
  const polished = polishInboxReply(text);
  const capitalised = polished.charAt(0).toLocaleUpperCase('nb-NO') + polished.slice(1);
  const extra = withGuests ? guestLine(env) : '';
  const body = extra ? `${capitalised}\n\n${extra}` : capitalised;
  const headers = env.threadless ? null : threadHeaders(env.message);
  const cc = Array.isArray(env.cc) ? env.cc : [];
  const started = Date.now();
  try {
    await mailFn({
      from: mailboxSender(env.replyTo),
      to,
      ...(cc.length ? { cc } : {}),
      replyTo: env.replyTo,
      subject: env.subject || replySubject(env.message),
      text: body,
      html: `<p>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br />')}</p>`,
      ...(headers ? { headers } : {}),
      copyToInbox: true,
      salesClientId: sanitize(env.client?.id),
    });
    recordOpsEvent('inbox', 'reply.sent', { salesClientId: sanitize(env.client?.id), messageId: sanitize(env.message?.id), ok: true, ms: Date.now() - started });
    return { sent: true, warning: '', to, text: body, at: new Date().toISOString() };
  } catch (error) {
    const warning = `Svaret kunne ikke sendes: ${sanitize(error?.message || error).slice(0, 160)}`;
    recordOpsEvent('inbox', 'reply.sent', { salesClientId: sanitize(env.client?.id), messageId: sanitize(env.message?.id), ok: false, ms: Date.now() - started, error: warning });
    return { sent: false, warning };
  }
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

function osloParts(iso = '') {
  const ms = Date.parse(iso);
  const date = Number.isFinite(ms) ? new Date(ms) : new Date();
  const weekday = cachedDateTimeFormat('en-US', { weekday: 'short', timeZone: 'Europe/Oslo' }).format(date);
  const hour = Number(cachedDateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Oslo' }).format(date));
  return { ymd: osloCalendarYmd(date.toISOString()), weekend: weekday === 'Sat' || weekday === 'Sun', hour };
}

function addDaysYmd(ymd = '', days = 1) {
  const next = new Date(`${ymd}T12:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function workdaysAheadAt9(now = new Date(), count = 1) {
  const origin = nowDate(now);
  let ymd = osloParts(origin.toISOString()).ymd;
  let left = Math.max(1, count);
  while (left > 0) {
    ymd = addDaysYmd(ymd, 1);
    if (!isWeekendYmd(ymd)) left -= 1;
  }
  return osloWallToIso(ymd, 9, 0, 0);
}

/** Never put a bot action in the past (old mail, passed meeting): fall back to the next workday 09:00. */
export function futureDue(dueAt = '', now = new Date()) {
  const origin = nowDate(now);
  const ms = Date.parse(dueAt);
  return Number.isFinite(ms) && ms > origin.getTime() ? dueAt : workdaysAheadAt9(origin, 1);
}

function weekFrom(now = new Date()) {
  const ymd = osloCalendarYmd(nowDate(now).toISOString());
  return osloWallToIso(addDaysYmd(ymd, 7), 9, 0, 0);
}

function morningDueAt(day) {
  if (!day?.ymd) return '';
  const hour = day.band === 'afternoon' ? 13 : 9;
  return osloWallToIso(day.ymd, hour, 0, 0);
}

/** A follow-up never lands on a day the client declined (the cancelled meeting day) or a weekend. */
function avoidDays(dueAt = '', avoid = new Set()) {
  let ymd = osloCalendarYmd(dueAt);
  if (!ymd || (!avoid.has(ymd) && !isWeekendYmd(ymd))) return dueAt;
  while (avoid.has(ymd) || isWeekendYmd(ymd)) ymd = addDaysYmd(ymd, 1);
  return osloWallToIso(ymd, 9, 0, 0);
}

/** Western Easter Sunday (Gregorian), as YYYY-MM-DD. */
function easterYmd(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const SEASONS = [
  { re: /(?:etter|over)\s+sommer(?:en|ferien)?/i, label: 'etter sommeren', at: (year) => `${year}-08-15` },
  { re: /til\s+høsten|i\s+høst/i, label: 'til høsten', at: (year) => `${year}-09-01` },
  { re: /(?:over|etter)\s+(?:jul|nyttår)/i, label: 'etter nyttår', at: (year) => `${year}-01-06` },
  { re: /(?:over|etter)\s+påske/i, label: 'etter påske', at: (year) => addDaysYmd(easterYmd(year), 2) },
  { re: /neste\s+måned|next\s+month/i, label: 'neste måned', next: true },
];

/** "ta kontakt etter sommeren" → the follow-up date and the words we use for it, or null. */
export function seasonFollowUp(text = '', now = new Date()) {
  const todayYmd = osloCalendarYmd(nowDate(now).toISOString());
  const year = Number(todayYmd.slice(0, 4));
  for (const season of SEASONS) {
    if (!season.re.test(String(text || ''))) continue;
    let ymd = season.next
      ? `${todayYmd.slice(0, 5)}${String(Number(todayYmd.slice(5, 7)) % 12 + 1).padStart(2, '0')}-01`
      : season.at(year);
    if (season.next && todayYmd.slice(5, 7) === '12') ymd = `${year + 1}-01-01`;
    if (!season.next && ymd <= todayYmd) ymd = season.at(year + 1);
    while (isWeekendYmd(ymd)) ymd = addDaysYmd(ymd, 1);
    return { dueAt: osloWallToIso(ymd, 9, 0, 0), label: season.label };
  }
  return null;
}

/** "i morgen" / "på torsdag" / "mandag 2. november" for a follow-up date. */
function whenPhraseNb(dueAt = '', now = new Date()) {
  const origin = nowDate(now);
  const dueYmd = osloCalendarYmd(dueAt);
  const todayYmd = osloCalendarYmd(origin.toISOString());
  const days = Math.round((Date.parse(`${dueYmd}T12:00:00Z`) - Date.parse(`${todayYmd}T12:00:00Z`)) / DAY_MS);
  if (days <= 0) return 'i dag';
  if (days === 1) return 'i morgen';
  const date = new Date(Date.parse(dueAt));
  if (days < 7) return `på ${new Intl.DateTimeFormat('nb-NO', { weekday: 'long', timeZone: 'Europe/Oslo' }).format(date)}`;
  return new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Oslo' }).format(date);
}

function weekdayNb(ymd = '') {
  const iso = osloWallToIso(ymd, 12, 0, 0);
  return iso ? new Intl.DateTimeFormat('nb-NO', { weekday: 'long', timeZone: 'Europe/Oslo' }).format(new Date(iso)) : '';
}

function checkupFormatFrom(text = '') {
  const blob = String(text || '').toLowerCase();
  if (/\bsms\b|\bmelding\b|\btekst(?:e|melding)?\b/.test(blob)) return 'sms';
  if (/\be-?post\b|\bmail\b|\bmaile\b/.test(blob)) return 'email';
  return 'ring';
}

function openFindTimeAction(client = {}) {
  return (Array.isArray(client?.nextActions) ? client.nextActions : [])
    .find((row) => !row?.doneAt && row.presetKey === 'findMeetingTime') || null;
}

function ensureCheckupAction(client, { format = 'ring', dueAt = '', note = '', ctx = {} } = {}) {
  const patch = {
    name: 'Oppsjekk møtetid',
    format: ['sms', 'ring', 'email'].includes(format) ? format : 'ring',
    dueAt: futureDue(dueAt || weekFrom(ctx.now), ctx.now),
    addToCalendar: false,
    sticky: false,
    note: botNote(note, ctx),
  };
  try {
    return sales.setSalesNextAction(client.id, { op: 'create', ...patch, presetKey: 'findMeetingTime' });
  } catch {
    return null;
  }
}

/** One open "Ny møtetid" task for the rep; a second cancel refreshes it instead of stacking another. */
function ensureRescheduleAction(client, { dueAt = '', note = '', ctx = {} } = {}) {
  const live = sales.getSalesClientById(client.id) || client;
  const due = futureDue(dueAt, ctx.now);
  const existing = openFindTimeAction(live);
  try {
    if (existing?.id) {
      return sales.setSalesNextAction(client.id, { op: 'update', id: existing.id, dueAt: due, note: botNote(note, ctx) });
    }
    return sales.setSalesNextAction(client.id, {
      op: 'create',
      name: 'Ny møtetid',
      presetKey: 'findMeetingTime',
      format: 'ring',
      dueAt: due,
      addToCalendar: false,
      sticky: false,
      note: botNote(note, ctx),
    });
  } catch {
    return null;
  }
}

/** The new time is booked: an open "Ny møtetid" task would send the rep after a time the client already has. */
function closeFindTimeActions(clientId = '') {
  const live = sales.getSalesClientById(clientId);
  const open = (live?.nextActions || []).filter((row) => !row?.doneAt && row.presetKey === 'findMeetingTime');
  for (const row of open) {
    try {
      sales.setSalesNextAction(clientId, { op: 'complete', id: row.id });
    } catch {
      // Best effort: the booking already stands.
    }
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

function daysUntil(ymd = '', now = new Date()) {
  const todayYmd = osloCalendarYmd(nowDate(now).toISOString());
  return Math.round((Date.parse(`${ymd}T12:00:00Z`) - Date.parse(`${todayYmd}T12:00:00Z`)) / DAY_MS);
}

/**
 * Free weekday times from the assigned rep's calendar: on the named day (or the named week),
 * else the next weekdays. Never an excluded day, never Saturday or Sunday.
 */
async function salesOfferSlots({ client, day, queryBusy, now, clientBusy = [], excludeYmds = [] }) {
  const durationMin = salesCalendarMinutes(client);
  const excluded = new Set(excludeYmds.filter(Boolean));
  // A week ("noe neste uke?") stays the anchor even when its Monday is excluded; the excluded days are skipped inside it.
  const named = day?.ymd && (day.week || !excluded.has(day.ymd)) ? day : null;
  if (named?.week) {
    const ahead = await loadCalendarBusy('sales', client, { queryBusy, now });
    if (!ahead.ok) return [];
    const startInDays = Math.max(0, daysUntil(named.ymd, now));
    const inWeek = pickFreeSlotsAhead({ durationMin, busy: [...ahead.busy, ...clientBusy], now, excludeYmds: [...excluded], startInDays, days: 5 });
    if (inWeek.length) return inWeek;
    return pickFreeSlotsAhead({ durationMin, busy: [...ahead.busy, ...clientBusy], now, excludeYmds: [...excluded] });
  }
  const listed = await loadCalendarBusy('sales', client, { queryBusy, ymd: named?.ymd || '', now });
  if (!listed.ok) return [];
  const busy = [...listed.busy, ...clientBusy];
  if (named) {
    const onDay = pickFreeSlots({ ymd: named.ymd, band: named.band || 'day', afterHour: named.afterHour ?? null, durationMin, busy, now });
    if (onDay.length) return onDay;
    const ahead = await loadCalendarBusy('sales', client, { queryBusy, now });
    if (!ahead.ok) return [];
    return pickFreeSlotsAhead({ durationMin, busy: [...ahead.busy, ...clientBusy], now, excludeYmds: [...excluded, named.ymd] });
  }
  return pickFreeSlotsAhead({ durationMin, busy, now, excludeYmds: [...excluded] });
}

/** The bot's latest slot offer to this client, so "mandag passer" books the Monday we offered. */
export function lastOfferedSlots(clientId = '', { now = new Date() } = {}) {
  const nowMs = nowDate(now).getTime();
  const rows = listInboxItems({ salesClientId: clientId })
    .filter((row) => Array.isArray(row.offeredSlots) && row.offeredSlots.length)
    .filter((row) => nowMs - Date.parse(row.receivedAt) < OFFER_MEMORY_MS);
  const latest = rows[rows.length - 1];
  return latest ? latest.offeredSlots.filter((iso) => Date.parse(iso) > nowMs) : [];
}

/** Plain answers for the questions we know, when no model reply is available. `meetingLine: false` drops the meeting sentence. */
export function faqReply(text = '', client = {}, { now = new Date(), slots = [], meetingLine = true } = {}) {
  const blob = String(text || '').toLowerCase();
  const booked = bookedMeetingAt(client);
  const bookedFuture = booked && Date.parse(booked) > nowDate(now).getTime();
  const name = sanitize(client.businessName);
  const standing = bookedFuture ? `Møtet står som avtalt ${formatMeetingDate(booked)}.` : '';
  const line = !meetingLine ? '' : (standing
    || (slots.length ? `Passer noe av dette for et møte: ${formatSlotListNb(slots)}?` : 'Si gjerne fra hvilken dag som passer, så setter vi opp et møte.'));
  const link = bookedFuture ? sanitize(client.calendar?.meetLink || client.calendar?.confirmedMeetLink) : '';
  const join = (...parts) => parts.filter(Boolean).join(' ');
  // Another platform or a physical meeting is the rep's call; the bot never promises it.
  if (OTHER_PLATFORM_RE.test(blob)) return '';
  if (/koste|pris|betale|gratis|uforplikt/.test(blob)) {
    return join('Møtet og utkastet er gratis og uforpliktende. Prisen avhenger av hva dere trenger, så den går vi gjennom på møtet, og etterpå får dere et skriftlig tilbud.', line);
  }
  if (/lenke|link|invitasjon|google meet|hvordan (?:blir|foregår|går) møtet|hvordan (?:blir|kommer|kan) (?:jeg|vi) (?:med|inn)|hvordan logger|hvor (?:er|blir) møtet|digitalt|online/.test(blob)) {
    // "Send lenken på nytt" / "finner ikke lenken" needs the link itself; without one on the card a person answers.
    if (!link && asksForLink(blob)) return '';
    const where = link ? `Lenken til møtet er ${link}, og den står også i kalenderinvitasjonen.` : 'Lenken til møtet står i kalenderinvitasjonen.';
    return join('Møtet er online.', where, meetingLine ? (standing || line) : '');
  }
  if (/hva gjelder|hva er dette|hva handler|hvem er (?:dere|du)|hvem er asoldi|hva skjer på møtet|hva er møtet|what is this|who are you/.test(blob)) {
    return join(`Det gjelder et kort online møte der vi viser et gratis og uforpliktende utkast til ny nettside${name ? ` for ${name}` : ''}. Asoldi er et norsk byrå som lager nettsider for lokale bedrifter.`, line);
  }
  // "Er møtet fortsatt torsdag kl 10?", "Hvilken dag var det vi hadde møte igjen?", "står det kl 10 eller 11?":
  // the booked time is the answer. How long it lasts is never stated here ("hvor lenge varer møtet?" goes to a person).
  if (standing && !/hvor lenge|varighet|varer/.test(blob) && BOOKED_TIME_QUESTION_RE.test(blob)) {
    return standing;
  }
  return '';
}

/** The client asks when the booked meeting is (day, clock or both); the card's own time answers it. */
const BOOKED_TIME_QUESTION_RE = /(?:er|blir|står) (?:møtet|det) (?:fortsatt|fremdeles|som avtalt)|stemmer det at (?:møtet|vi)|når er møtet|når (?:var|er) det (?:vi|møtet)|når skal vi (?:ha )?møte|hvilk(?:en|et) (?:dag|tid|tidspunkt|klokkeslett) (?:var|er|ble|blir) (?:det (?:vi|møtet)|møtet)|hvilk(?:en|et) (?:dag|tid|tidspunkt|klokkeslett) (?:hadde|har|skal) vi(?: møtet| møte)?|hvilk(?:en|et) (?:dag|tid|tidspunkt|klokkeslett) var det igjen|hva (?:var|er) (?:tidspunktet|klokkeslettet) (?:for|på) møtet|hva var tid(?:en|a|spunktet) igjen|(?:står|var|er) det (?:kl\.? ?)?\d{1,2}(?:[:.]\d{2})? eller (?:kl\.? ?)?\d{1,2}/;

/** Teams, Zoom or meeting in person: not something the bot can promise. */
const OTHER_PLATFORM_RE = /(?<![\p{L}])(?:teams|zoom|skype|whereby|fysisk|in\s+person|møtes\s+(?:hos|på\s+kontoret))(?![\p{L}])/iu;

/** The client asks for the meeting link itself (send it again, cannot find it, cannot open it); "takk for lenken" does not. */
function asksForLink(text = '') {
  return String(text || '').split(/(?<=[.!?\n])/).some((part) => (
    /(?<![\p{L}])(?:lenke\p{L}*|link\p{L}*|invitasjon\p{L}*)(?![\p{L}])/iu.test(part)
    && (/\?\s*$/.test(part) || /(?<![\p{L}])(?:send\p{L}*|på\s+nytt|igjen|finner|fant|får\s+ikke|fikk\s+ikke|kan\s+ikke|klarer\s+ikke|fungerer\s+ikke|virker\s+ikke|åpne\p{L}*|mangler|ikke\s+fått|hvor)(?![\p{L}])/iu.test(part))
  ));
}

/** A sentence about the time itself ("kan vi ta fredag kl 13?", "could we do Friday at 2pm instead?"), not a separate question. */
const SCHEDULING_SENTENCE_RE = /(?<![\p{L}])(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag|kl|klokka|i\s+morgen|i\s+dag|neste\s+uke|i\s+stedet|istedet|flytte|passer|tidspunkt\p{L}*|møtetid|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|next\s+week|instead|reschedule|move\s+(?:it|the\s+meeting)|at\s+\d{1,2})(?![\p{L}])|\d{1,2}[:.]\d{2}|\d\s*(?:am|pm)(?![\p{L}])/iu;

/** Questions next to a booking ("Hva koster det? Og kan vi ta fredag kl 13?") and the plain answer we have for them. */
function sideQuestions(text = '', client = {}, now = new Date()) {
  const asks = String(text || '').split(/(?<=[?!.])\s+|\n+/).map((part) => part.trim())
    .filter((part) => /\?\s*$/.test(part) && !SCHEDULING_SENTENCE_RE.test(part));
  if (!asks.length) return { asked: false, answer: '' };
  return { asked: true, answer: faqReply(asks.join(' '), client, { now, meetingLine: false }) };
}

function stageSummary(stage = '') {
  return `Ikke besvart av bot: kunden er i ${INBOX_BOT_STAGE_LABELS[stage] || stage}.`;
}

const NEEDS_HUMAN_SUMMARY = {
  'question:contract': 'Trenger svar fra selger: spørsmål om tilbud eller kontrakt.',
  'question:unknown': 'Trenger svar fra selger: spørsmål boten ikke kan svare på.',
  'day-differs-from-booked': 'Trenger svar fra selger: kunden nevner en annen dag enn møtet.',
  'day-without-meeting': 'Trenger svar fra selger: kunden nevner en dag, men ingen møtetid er avtalt.',
  'booked-day-unclear': 'Trenger svar fra selger: kunden nevner møtedagen, men det er uklart om den passer.',
  'decline-all': 'Trenger svar fra selger: ingen av tidene passet kunden.',
  'yes-to-offer': 'Trenger svar fra selger: kunden sa ja, men valgte ingen av tidene.',
  'cancel-other-day': 'Trenger svar fra selger: kunden kan ikke en annen dag enn møtet, og møtet står fortsatt.',
  'unsure-with-meeting': 'Trenger svar fra selger: kunden er usikker, men møtet står fortsatt.',
  'stale-mail': 'Trenger svar fra selger: e-posten er gammel, så boten endret ikke møtet.',
  'no-assigned-rep': 'Trenger svar fra selger: kortet har ingen selger, så boten booket ikke.',
  'other-address': 'Trenger svar fra selger: kunden skrev fra en annen adresse enn den på kortet.',
  'ambiguous-sender': 'Trenger svar fra selger: adressen står på flere kort.',
  'older-same-thread': 'Trenger svar fra selger: en eldre e-post fra kunden ble ikke besvart.',
  'question-with-booking': 'Bot flyttet møtet, men kunden spurte også om noe boten ikke svarte på.',
  'time-unclear': 'Trenger svar fra selger: uklart hvilket tidspunkt kunden mener, så boten endret ikke møtet.',
  'time-unavailable': 'Trenger svar fra selger: kunden ba om et annet klokkeslett samme dag, men det er utenfor møtetid, opptatt eller passert. Møtet står fortsatt.',
  'info-about-meeting': 'Trenger svar fra selger: kunden sendte informasjon som nevner en dag, et klokkeslett eller møtet.',
  'move-warning': 'Bot flyttet møtet, men et steg etterpå feilet (kalender eller bekreftelse): sjekk at kalenderen og kunden har riktig tid.',
  'no-meet-link': 'Trenger svar fra selger: kunden spør etter møtelenken, men kortet har ingen lenke.',
  'ai-unavailable': 'Trenger svar fra selger: AI-sjekken svarte ikke, så boten gjorde ingenting.',
  'book-failed': 'Trenger svar fra selger: boten fikk ikke flyttet møtet.',
  'void-failed': 'Trenger svar fra selger: boten fikk ikke tatt bort møtet, og kunden har ikke fått svar.',
  'guest-unknown-address': 'Trenger svar fra selger: kunden vil ha med en person boten ikke fant e-postadressen til.',
  'guest-add-failed': 'Trenger svar fra selger: boten fikk ikke lagt til gjesten på møtet.',
  'guest-cancel': 'Trenger svar fra selger: en gjest på møtet vil avlyse eller avslå, så boten lot møtet stå.',
  'guest-counter': 'Trenger svar fra selger: en gjest foreslo en ny tid i kalenderen, så boten lot møtet stå.',
};

export function needsHumanSummary(reason = '') {
  const key = String(reason || '');
  if (key.startsWith('guest-unknown-address:')) {
    return `Trenger svar fra selger: kunden vil ha med ${key.slice('guest-unknown-address:'.length)} på møtet, men boten fant ingen e-postadresse.`;
  }
  if (NEEDS_HUMAN_SUMMARY[key]) return NEEDS_HUMAN_SUMMARY[key];
  const head = key.split(':')[0];
  if (NEEDS_HUMAN_SUMMARY[head]) return NEEDS_HUMAN_SUMMARY[head];
  if (key.startsWith('ai-')) return 'Trenger svar fra selger: uklart hva kunden vil.';
  return 'Trenger svar fra selger.';
}

/** The request would void or move the booked meeting (or book one). */
function changesMeeting(heuristic = {}) {
  return Boolean(heuristic.cancel) || heuristic.request === 'reschedule';
}

/** Too old to act on: backfill, a tick after downtime, or the meeting was confirmed or cancelled after the client wrote. */
function mailIsStale({ message = {}, live = {}, clockMs = Date.now(), backfill = false } = {}) {
  if (backfill) return true;
  const mailMs = Date.parse(message.mailAt);
  if (!Number.isFinite(mailMs)) return false;
  if (clockMs - mailMs > STALE_MAIL_MS) return true;
  return [live.reminders?.thankYouSentAt, live.salesPlaybook?.cancelledAt].some((stamp) => {
    const at = Date.parse(stamp);
    return Number.isFinite(at) && at > mailMs && at <= clockMs;
  });
}

function futureYmd(iso = '', now = new Date()) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > nowDate(now).getTime() ? osloCalendarYmd(iso) : '';
}

/** Mail from an address that is not the card's own (or is on two cards): never answered, a person checks it. */
function logOtherSender({ log, fresh, via, origin }) {
  const reason = via === 'ambiguous' ? 'ambiguous-sender' : 'other-address';
  const quiet = classifyInboxRequest(fresh, {}, { now: origin });
  const silent = quiet.request === 'confirm' || quiet.request === 'empty';
  log({
    kind: 'silent',
    intent: quiet.request,
    reason,
    status: silent ? 'logged' : 'needs_human',
    summary: silent ? 'Kunden takket fra en annen adresse. Ingen svar trengs.' : needsHumanSummary(reason),
  });
  return { wrote: false, reason, needsHuman: !silent, logged: true, request: quiet.request };
}

/** Tilbud, Venter signering, Solgt and off-board cards: logged for a person, never answered. */
function logLaterStage({ log, fresh, stage, origin, contractFiled, guestAsked = false }) {
  const quiet = classifyInboxRequest(fresh, {}, { now: origin });
  // The contract PDF itself is filed on the card; a bare "her er kontrakten" needs no answer.
  const filed = contractFiled && quiet.request === 'contract' && !quiet.question;
  // A request to add a person is never dropped silently: past Tilbud a rep decides.
  const silent = !guestAsked && (quiet.request === 'confirm' || quiet.request === 'empty' || filed);
  const reason = `stage:${stage}`;
  log({
    kind: 'silent',
    intent: quiet.request,
    reason,
    status: silent ? 'logged' : 'needs_human',
    summary: stageSummary(stage),
  });
  return { wrote: false, reason, silent: true, logged: true, request: quiet.request };
}

/** One inbox row per mail plus its decision event (lib/ops-events.js), with the client's words kept for the card. */
function inboxLog({ message, live, stage, fresh = '', backfill = false, extras = {} }) {
  return (given = {}) => {
    // Guests asked for in this mail and the time the words named ride on every row of the mail.
    const row = { ...extras, ...given };
    if (row.kind !== 'guest_add' && row.kind !== 'guest_declined') {
      const notes = [];
      if (extras.guestsAdded?.length) notes.push(`Gjest lagt til: ${extras.guestsAdded.join(', ')}.`);
      if (extras.guestsUnresolved?.length && !String(row.reason || '').startsWith('guest-unknown-address')) notes.push(`Gjest uten adresse: ${extras.guestsUnresolved.join(', ')}.`);
      if (notes.length && row.summary) row.summary = `${row.summary} ${notes.join(' ')}`;
    }
    const saved = appendInboxItem({
      mailbox: message.mailbox,
      messageId: `${message.id}:write`,
      salesClientId: live.id,
      from: message.from,
      subject: message.subject,
      text: fresh,
      receivedAt: message.mailAt || new Date().toISOString(),
      stage,
      ...row,
    });
    const mailMs = Date.parse(message.mailAt || '');
    recordOpsEvent('inbox', 'mail.decided', {
      salesClientId: live.id,
      messageId: sanitize(message.id),
      words: sanitize(row.wordsRequest || row.intent),
      ai: sanitize(row.aiRequest),
      action: sanitize(row.kind),
      status: sanitize(row.status),
      reason: sanitize(row.reason),
      stage,
      replied: Boolean(row.replyText),
      backfill: Boolean(backfill),
      lagMs: Number.isFinite(mailMs) ? Math.max(0, Date.now() - mailMs) : null,
    });
    return saved;
  };
}

/**
 * Meeting-stage reply: categorize what the client asks for, then answer it, book the new time
 * for the assigned rep, or cancel the meeting and ask for a new time. Tilbud, Venter signering,
 * Solgt and off-board cards get no reply and no card change; the mail is logged for a person.
 * When in doubt (old mail, unclear words, a failed step) the mail goes to a person instead.
 */
export async function handleInboxWrite({
  client,
  message,
  via,
  queryBusy,
  sendEmail = emailLib.sendEmail,
  now = new Date(),
  realNow,
  decideAi,
  moveMeeting = defaultMoveMeeting,
  voidMeeting = defaultVoidMeeting,
  addMeetingGuests = defaultAddMeetingGuests,
  backfill = false,
  contractFiled = false,
} = {}) {
  if (!client?.id) return { wrote: false, reason: 'unmatched-from' };
  if (isAutomatedMail(message)) return { wrote: false, reason: 'automated' };
  if (/@asoldi\.com$/i.test(parseEmailAddress(message.from))) return { wrote: false, reason: 'internal-sender' };

  let live = sales.getSalesClientById(client.id) || client;
  const fresh = freshReplyText(message.text);
  const origin = nowDate(now);
  const clockMs = Number.isFinite(Date.parse(realNow)) ? Date.parse(realNow) : Date.now();
  // Relative words ("i morgen") read from the mail's date; "already passed" is judged against the real clock.
  const realNowDate = new Date(Math.max(origin.getTime(), clockMs));
  const todayYmd = osloCalendarYmd(realNowDate.toISOString());
  const stage = inboxBotStage(live);

  const rowExtras = {};
  const log = inboxLog({ message, live, stage, fresh, backfill, extras: rowExtras });
  const toPerson = (reason, request) => {
    log({ kind: 'silent', intent: request, reason, status: 'needs_human', summary: needsHumanSummary(reason) });
    return { wrote: false, reason, needsHuman: true, logged: true, request };
  };

  // The card's own address and a guest the client asked us to add both write as the client.
  if (via !== 'email' && via !== 'guest') return logOtherSender({ log, fresh, via, origin });
  // "Fint om du legger Kari på inviten": read first, so the rest of the mail is classified on its own.
  const guestAsk = extractGuestRequest(fresh, { from: message.from, cc: message.cc, toList: message.toList, client: live, threadText: message.text });
  const body = guestAsk.asked ? guestAsk.strippedText : fresh;
  if (guestAsk.asked) {
    rowExtras.guestsRequested = guestAsk.guests.map((guest) => guest.email);
    rowExtras.guestsUnresolved = guestAsk.unresolved;
  }
  if (stage !== 'meeting') return logLaterStage({ log, fresh: body, stage, origin, contractFiled, guestAsked: guestAsk.asked });
  // Adding a person changes the card: never from a backfill or an old mail.
  if (guestAsk.asked && guestAsk.guests.length && (backfill || mailIsStale({ message, live, clockMs, backfill }))) {
    return toPerson('stale-mail', 'guest');
  }

  const guest = guestAsk.asked ? { added: [], already: [], rejected: [], unresolved: guestAsk.unresolved, invited: false, warning: '' } : null;
  if (guest && guestAsk.guests.length) {
    const named = guestAsk.guests.map((row) => guestLabel(row)).join(', ');
    let added;
    try {
      added = await addMeetingGuests(live, guestAsk.guests, { note: botNote(`Kunden ba om å legge til ${named} på møtet.`, { clientText: fresh }) });
    } catch (error) {
      added = { ok: false, error: String(error?.message || error) };
    }
    if (!added?.ok) return toPerson(`guest-add-failed:${sanitize(added?.error).replace(/\s+/g, ' ').slice(0, 120) || 'unknown'}`, 'guest');
    const nameOf = new Map(guestAsk.guests.map((row) => [row.email, row.name]));
    guest.added = (added.added || []).map((email) => ({ email, name: nameOf.get(email) || '' }));
    guest.already = (added.already || []).map((email) => ({ email, name: nameOf.get(email) || '' }));
    guest.rejected = Array.isArray(added.rejected) ? added.rejected : [];
    guest.invited = Boolean(added.invited);
    guest.warning = sanitize(added.warning);
    live = added.client || sales.getSalesClientById(live.id) || live;
    rowExtras.guestsAdded = guest.added.map((row) => guestLabel(row, { withEmail: false }));
    rowExtras.guestsAlready = guest.already.map((row) => row.email);
    rowExtras.guestsRejected = guest.rejected;
  }
  // What a person still has to look at about the guests, once the rest of the mail is handled.
  const guestFlag = !guest ? ''
    : guest.rejected.length ? `guest-add-failed:${sanitize(guest.rejected[0]?.reason) || 'rejected'}`
      : guest.unresolved.length ? `guest-unknown-address:${guest.unresolved.join(', ')}` : '';

  const offered = lastOfferedSlots(live.id, { now: realNowDate });
  const heuristic = classifyInboxRequest(body, live, { now: origin, offeredSlots: offered });
  // The time the words named, kept on every row: a decline of the booked meeting books it when the mail went to a person.
  rowExtras.wordsRequest = heuristic.request || '';
  const namedAt = wordsTimeOf(heuristic, body, origin, realNowDate);
  rowExtras.wordsDueAt = namedAt.dueAt;
  rowExtras.wordsCandidates = namedAt.candidates;
  if (heuristic.dueAt && Date.parse(heuristic.dueAt) <= realNowDate.getTime()) {
    // A clock on the meeting day that passed while the mail waited: the meeting still stands, a person answers.
    const bookedAt = bookedMeetingAt(live);
    if (bookedAt && Date.parse(bookedAt) > realNowDate.getTime() && osloCalendarYmd(heuristic.dueAt) === osloCalendarYmd(bookedAt)) {
      return toPerson('time-unavailable', heuristic.request);
    }
    heuristic.request = 'reschedule_day';
    heuristic.intent = 'sales_propose';
    heuristic.dueAt = '';
    heuristic.day = null;
  }
  if (heuristic.day?.ymd && heuristic.day.ymd < todayYmd) heuristic.day = null;

  if (contractFiled && heuristic.request === 'contract' && !heuristic.question) {
    log({ kind: 'none', intent: 'contract', reason: 'contract-filed', status: 'logged', summary: 'Kunden sendte kontrakten. Lagt på kortet, ingen svar.' });
    return { wrote: false, reason: 'contract-filed', logged: true, request: 'contract' };
  }
  const booked = bookedMeetingAt(live);
  const bookedFuture = Boolean(booked) && Date.parse(booked) > realNowDate.getTime();
  const replyTo = sanitize(message.mailbox).toLowerCase() || BOT_MAILBOX;
  const to = replyTarget(live, message, via);
  // What every reply of this mail shares. `bookedNow` follows the meeting through a move or a void.
  const sendBase = {
    message,
    sendEmail,
    now: realNowDate,
    log,
    toPerson,
    to,
    cc: replyCcList(message, { to, client: live, via }),
    replyTo,
    guest,
    guestFlag,
    guestSender: via === 'guest',
    bookedNow: bookedFuture,
    movedNow: false,
  };
  if (heuristic.request === 'confirm' || heuristic.request === 'empty' || (guest && onlyPleasantries(body, heuristic))) {
    if (!guest) {
      log({ kind: 'none', intent: heuristic.request, reason: 'meeting-echo', status: 'logged', summary: 'Kunden bekreftet eller takket. Ingen svar trengs.' });
      return { wrote: false, reason: 'meeting-echo', logged: true, request: heuristic.request };
    }
    // A mail that only asks for a guest: nothing else to answer, so say what happened.
    return answerGuestOnly({ ...sendBase, client: live, heuristic, booked, bookedFuture, decision: { request: 'guest', needsHuman: false, reply: '', aiRequest: '' }, ctx: { summary: '', clientText: fresh, now: realNowDate } });
  }

  // A guest on the meeting may confirm, ask and propose a new time, but never cancel or decline it for the client.
  if (via === 'guest' && guestWouldCancel(heuristic, bookedFuture)) return toPerson('guest-cancel', heuristic.request);
  if (changesMeeting(heuristic) && mailIsStale({ message, live, clockMs, backfill })) return toPerson('stale-mail', heuristic.request);
  // "Kan ikke i morgen" about another day while the meeting stands: asking for a new time would confuse.
  if (heuristic.request === 'cancel' && !heuristic.cancel && bookedFuture) return toPerson('cancel-other-day', 'cancel');
  if (heuristic.request === 'not_now' && !heuristic.cancel && bookedFuture) return toPerson('unsure-with-meeting', 'not_now');

  const history = listInboxItems({ salesClientId: live.id }).slice(-8).map((row) => ({
    at: row.receivedAt,
    kind: row.kind,
    summary: row.summary,
    text: row.text || '',
  }));
  const offeredDays = offered.map((iso) => osloCalendarYmd(iso));
  // Never offer the booked day, the day the client just cancelled, or a day they said they cannot do.
  const excludeYmds = uniq([
    ...heuristic.excludedDays,
    bookedFuture ? osloCalendarYmd(booked) : '',
    futureYmd(live.salesPlaybook?.cancelledMeetingAt, realNowDate),
    ...(heuristic.request === 'cancel' && !heuristic.cancel ? offeredDays : []),
  ]);
  // A no about budget or need ("no-need") is closed politely; it is never offered times.
  const wantsSlots = (['reschedule_day', 'cancel', 'not_interested'].includes(heuristic.request) && heuristic.reason !== 'no-need')
    || (heuristic.request === 'question' && !bookedFuture);
  const offerSlots = wantsSlots
    ? await salesOfferSlots({
      client: live,
      day: heuristic.request === 'reschedule_day' ? heuristic.day : null,
      queryBusy,
      now: realNowDate,
      // "Ingen av disse passer": a day the client asks for again never gets the same times back.
      clientBusy: [...clientBusyBlocks(body, heuristic.day), ...(heuristic.reason === 'decline-all' ? offered.map(slotBlock) : [])],
      excludeYmds,
    })
    : [];
  const decision = await decideInboxWrite({
    client: live,
    // The AI reads the mail without the guest sentence too, or it would answer "legg Kari på inviten" as a question.
    message: guestAsk.asked ? { ...message, text: textWithout(message.text, fresh, body) } : message,
    heuristic,
    history,
    now: realNowDate,
    decideAi,
    offerTimes: offerSlots,
  });

  // A rep may have moved the card on (or moved the meeting) while we waited for the AI or the calendar.
  const current = sales.getSalesClientById(live.id) || live;
  const stageNow = inboxBotStage(current);
  if (stageNow !== 'meeting') {
    const reason = `stage:${stageNow}`;
    log({ kind: 'silent', intent: heuristic.request, reason, stage: stageNow, status: 'needs_human', summary: stageSummary(stageNow) });
    return { wrote: false, reason, silent: true, logged: true, request: heuristic.request };
  }
  if (changesMeeting(heuristic) && bookedMeetingAt(current) !== booked) return toPerson('stale-mail', heuristic.request);
  if (via === 'guest' && (decision.request === 'cancel' || decision.request === 'not_interested')) return toPerson('guest-cancel', decision.request);

  const ctx = { summary: decision.checkupNote, clientText: body, now: realNowDate };
  const env = {
    ...sendBase,
    client: current,
    heuristic,
    decision,
    offerSlots,
    booked,
    bookedFuture,
    excludeYmds,
    queryBusy,
    ctx,
    // A move in this mail sends the new invite to the guests too: the reply may say so.
    moveMeeting: async (...args) => {
      const moved = await moveMeeting(...args);
      if (moved?.ok) {
        env.bookedNow = true;
        env.movedNow = true;
      }
      return moved;
    },
    voidMeeting,
  };

  if (decision.needsHuman) {
    const reason = decision.reason || 'unclear';
    log({ kind: 'silent', intent: decision.request, reason, status: 'needs_human', summary: needsHumanSummary(reason), aiRequest: decision.aiRequest || '', wordsRequest: heuristic.request || '' });
    return { wrote: false, reason, needsHuman: true, logged: true, request: decision.request };
  }

  switch (decision.request) {
    case 'reschedule': return bookSales(env, heuristic.dueAt);
    case 'reschedule_day': return proposeDay(env);
    case 'cancel': return cancelAndAsk(env);
    case 'call':
    case 'not_now': return salesCall(env);
    case 'not_interested': return salesDefer(env);
    case 'question': return answerQuestion(env);
    case 'info': return answerInfo(env);
    default: return toPerson('unclear', decision.request);
  }
}

/** A calendar answer and the booked time are the same meeting when they are this close. */
const SAME_EVENT_MS = 2 * 60 * 1000;

/** The card's own address the calendar answer came from, else the card contact. */
function calendarReplyTarget(client = {}, answer = {}) {
  const own = [client.clientEmail, client.contactEmail, client.websiteEmail].map((value) => parseEmailAddress(value)).filter(Boolean);
  const attendee = parseEmailAddress(answer.attendee);
  return validEmail(own.includes(attendee) ? attendee : '') || validEmail(client.contactEmail) || validEmail(client.clientEmail);
}

/**
 * The client answered the calendar invite instead of writing. "Avslå" (REPLY, DECLINED) cancels the booked
 * time like "jeg kan ikke komme" and offers free times; "Foreslå ny tid" (COUNTER) books the proposed time
 * through the same checks as a mailed new time. Only for the card's current booked time, in the meeting
 * stage, before the meeting starts; anything else is logged for a person. Never throws past its hooks.
 * `answer`: { kind: 'decline' | 'counter', eventAt, proposedAt, attendee }.
 */
export async function handleCalendarAnswer({
  client,
  message,
  answer = {},
  queryBusy,
  sendEmail = emailLib.sendEmail,
  now = new Date(),
  realNow,
  moveMeeting = defaultMoveMeeting,
  voidMeeting = defaultVoidMeeting,
} = {}) {
  const live = (client?.id && sales.getSalesClientById(client.id)) || client;
  if (!live?.id) return { wrote: false, reason: 'unmatched' };
  const stage = inboxBotStage(live);
  const clockMs = Number.isFinite(Date.parse(realNow)) ? Date.parse(realNow) : Date.now();
  const realNowDate = new Date(Math.max(nowDate(now).getTime(), clockMs));
  const counter = answer.kind === 'counter';
  // Only the card's own address speaks for the client; a guest (or anyone else) on the event never voids or books.
  const attendee = parseEmailAddress(answer.attendee);
  const ownAddresses = [live.clientEmail, live.contactEmail, live.websiteEmail].map((value) => parseEmailAddress(value)).filter(Boolean);
  const fromGuest = Boolean(attendee) && !ownAddresses.includes(attendee);
  const label = fromGuest
    ? (counter ? `En gjest (${attendee}) foreslo en ny tid i kalenderen.` : `En gjest (${attendee}) avslo møteinvitasjonen.`)
    : (counter ? 'Kunden foreslo en ny tid i kalenderen.' : 'Kunden avslo møteinvitasjonen.');
  const log = inboxLog({ message, live, stage, fresh: label });
  const booked = bookedMeetingAt(live);
  const logOnly = (reason, summary, status = 'logged', kind = 'none') => {
    log({ kind, intent: answer.kind, reason, status, summary });
    return { wrote: false, reason, logged: true, needsHuman: status === 'needs_human' };
  };
  if (fromGuest) {
    return counter
      ? logOnly('guest-counter', `${label} Møtet står, og ingen er svart.`, 'needs_human')
      : logOnly('guest-declined', `Gjest avslo møtet: ${attendee}`, 'logged', 'guest_declined');
  }
  if (stage !== 'meeting') return logOnly(`stage:${stage}`, `${label} ${stageSummary(stage)}`, 'needs_human');
  if (!booked || !(Math.abs(Date.parse(booked) - Date.parse(answer.eventAt)) <= SAME_EVENT_MS)) {
    return logOnly('calendar-other-time', `${label} Det gjaldt ikke møtetiden som står på kortet nå.`);
  }
  if (Date.parse(booked) <= realNowDate.getTime()) {
    return logOnly('calendar-after-start', `${label} Møtet hadde allerede startet; ingenting endret.`, 'needs_human');
  }
  const ctx = { summary: '', clientText: label, now: realNowDate };
  const bookedYmd = osloCalendarYmd(booked);
  const heuristic = counter
    ? { request: 'reschedule', intent: 'sales_book', dueAt: answer.proposedAt, day: { ymd: osloCalendarYmd(answer.proposedAt), band: 'day' }, excludedDays: [], cancel: true, reason: '' }
    : { request: 'cancel', intent: 'sales_cancel', dueAt: '', day: null, excludedDays: [bookedYmd], cancel: true, reason: 'calendar-decline' };
  const excludeYmds = uniq([bookedYmd]);
  // The client's own new-time request is still open (the mail went to a person): the decline books it.
  const open = counter ? null : openRequestedTime(live, { nowMs: realNowDate.getTime(), booked });
  const offerSlots = counter ? [] : await salesOfferSlots({
    client: live,
    day: open ? { ymd: osloCalendarYmd(open.dueAt), band: 'day' } : null,
    queryBusy,
    now: realNowDate,
    excludeYmds,
  });
  const toPerson = (reason, request) => {
    log({ kind: 'silent', intent: request, reason, status: 'needs_human', summary: needsHumanSummary(reason) });
    return { wrote: false, reason, needsHuman: true, logged: true, request };
  };
  const env = {
    client: live,
    message,
    heuristic,
    decision: { request: heuristic.request, needsHuman: false, reply: '', aiRequest: '', checkupNote: '' },
    offerSlots,
    booked,
    bookedFuture: true,
    excludeYmds,
    queryBusy,
    sendEmail,
    now: realNowDate,
    ctx,
    log,
    toPerson,
    moveMeeting,
    voidMeeting,
    to: calendarReplyTarget(live, answer),
    replyTo: sanitize(message.mailbox).toLowerCase() || BOT_MAILBOX,
    // A Google notification is no thread to answer in: a fresh mail with our own subject.
    subject: 'Ny tid for møtet med Asoldi',
    threadless: true,
    // The client declined in their own calendar: no second cancellation from ours.
    voidOptions: { notifyClient: false, declined: !counter },
    requestedAt: open?.dueAt || '',
  };
  if (counter) {
    if (!Number.isFinite(Date.parse(answer.proposedAt)) || Date.parse(answer.proposedAt) <= realNowDate.getTime()) {
      return toPerson('time-unavailable', 'reschedule');
    }
    return bookSales(env, answer.proposedAt);
  }
  if (open && await canBookAt(env, open.dueAt)) {
    const wish = { request: 'reschedule', intent: 'sales_book', dueAt: open.dueAt, day: { ymd: osloCalendarYmd(open.dueAt), band: 'day' }, excludedDays: [], cancel: true, reason: 'open-request' };
    const booking = await bookSales({
      ...env,
      heuristic: wish,
      decision: { request: 'reschedule', needsHuman: false, reply: '', aiRequest: '', checkupNote: '' },
      voidOptions: undefined,
      ctx: { ...env.ctx, clientText: `${label} Kunden ba tidligere om ${formatMeetingDate(open.dueAt)}.` },
    }, open.dueAt);
    if (booking?.wrote && !booking.needsHuman && open.item?.id) updateInboxItem(open.item.id, { status: 'applied', reason: 'booked-from-decline' });
    return booking;
  }
  return declineAndOffer(env);
}

const OPEN_REQUEST_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * A new time the client asked for in the last 72 hours that went to a person (needs_human with the time the
 * words named), if the booked meeting is not that time already and the meeting was not re-confirmed since.
 */
function openRequestedTime(client = {}, { nowMs = Date.now(), booked = '' } = {}) {
  const confirmedMs = Date.parse(client.reminders?.thankYouSentAt);
  const own = cardOwnAddresses(client);
  const rows = listInboxItems({ salesClientId: client.id }).filter((item) => (
    item.status === 'needs_human'
    && String(item.messageId || '').endsWith(':write')
    // Only a mail whose point was a new time, sent from the card's own address (not a guest, not a bare date in a question).
    && (item.wordsRequest === 'reschedule' || item.aiRequest === 'reschedule')
    && own.includes(parseEmailAddress(item.from))
    && Number.isFinite(Date.parse(item.wordsDueAt))
    && Date.parse(item.wordsDueAt) > nowMs
    && nowMs - Date.parse(item.receivedAt) < OPEN_REQUEST_WINDOW_MS
    && !(Number.isFinite(confirmedMs) && confirmedMs > Date.parse(item.receivedAt))
    // Two different times named: which one is meant is not ours to guess.
    && (item.wordsCandidates || []).every((iso) => Math.abs(Date.parse(iso) - Date.parse(item.wordsDueAt)) <= SAME_EVENT_MS)
  ));
  const item = rows.at(-1);
  if (!item) return null;
  if (booked && Math.abs(Date.parse(booked) - Date.parse(item.wordsDueAt)) <= SAME_EVENT_MS) return null;
  return { dueAt: item.wordsDueAt, item };
}

/** The checks bookSales runs before it moves the meeting, without moving anything. */
async function canBookAt(env, dueAt) {
  const ms = Date.parse(dueAt);
  if (!Number.isFinite(ms) || ms <= env.now.getTime() || !withinMeetingHours(dueAt)) return false;
  if (!isAssignedSalesRepOwner(env.client.ownerId)) return false;
  const minutes = salesCalendarMinutes(env.client);
  const listed = await loadCalendarBusy('sales', env.client, { queryBusy: env.queryBusy, ymd: osloCalendarYmd(dueAt), now: env.now });
  return !listed.ok || slotIsFree(dueAt, minutes, busyWithoutBooked(listed.busy, env.booked, minutes));
}

async function declineAndOffer(env) {
  const when = formatMeetingDate(env.booked);
  const voided = await voidBooked(env, `Kunden avslo møteinvitasjonen for ${when}. Bot tok bort møtetiden og sendte ledige tider.`);
  if (!voided.ok && !voided.skipped) return voidFailed(env, voided);
  const slots = env.offerSlots;
  ensureRescheduleAction(env.client, {
    dueAt: slots[0] || '',
    note: slots.length ? `Kunden avslo invitasjonen. Bot foreslo: ${formatSlotListNb(slots)}.` : 'Kunden avslo invitasjonen. Bot ba om ny tid.',
    ctx: env.ctx,
  });
  const wanted = env.requestedAt ? ` Du ba tidligere om ${formatMeetingDate(env.requestedAt)}, men den tiden er dessverre ikke ledig.` : '';
  const lead = `Takk for beskjed. Jeg ser at ${when} ikke passet, så jeg har tatt bort den tiden.${wanted}`;
  const text = slots.length
    ? `${lead} Passer noe av dette: ${formatSlotListNb(slots)}? Du kan også svare med en dag og tid som passer bedre.`
    : `${lead} Hvilken dag og tid passer bedre for deg?`;
  const mailed = await sendClientMail(env, text);
  return finish(env, {
    kind: 'sales_declined',
    mailed,
    offeredSlots: slots,
    summary: `Kunden avslo møteinvitasjonen for ${when}. Bot tok bort møtet og sendte ledige tider.`,
    extra: { slots, voided: !voided.skipped && Boolean(voided.ok) },
  });
}

/** A one-minute busy block at an offered time, so the same time is not offered twice. */
function slotBlock(iso = '') {
  return { start: iso, end: new Date(Date.parse(iso) + 60000).toISOString() };
}

/** Busy blocks without the booked meeting's own event, which a new clock that day may overlap. */
function busyWithoutBooked(busy = [], booked = '', durationMin = 30) {
  const start = Date.parse(booked);
  if (!Number.isFinite(start)) return busy;
  const end = start + Number(durationMin) * 60000;
  return busy.flatMap((block) => {
    if (!(Math.abs(Date.parse(block?.start) - start) < 120000)) return [block];
    // Google merges touching events: keep whatever runs past the booked meeting.
    return Date.parse(block?.end) > end ? [{ ...block, start: new Date(end).toISOString() }] : [];
  });
}

/** Void the booked meeting when the request says it no longer holds. Never throws. */
async function voidBooked(env, note) {
  if (!env.heuristic.cancel || !env.booked) return { ok: true, skipped: true };
  // A guest never takes the client's meeting away, whatever the words say.
  if (env.guestSender) return { ok: false, error: 'guest-cancel' };
  let result;
  try {
    result = await env.voidMeeting(env.client, { note: botNote(note, env.ctx), notifyClient: true, ...(env.voidOptions || {}) });
  } catch (error) {
    result = { ok: false, error: String(error?.message || error) };
  }
  if (result?.ok) {
    env.client = result.client || sales.getSalesClientById(env.client.id) || env.client;
    env.bookedNow = false;
  }
  return result || { ok: false, error: 'void-failed' };
}

/** The void did not happen: nothing else is added or sent, so no mail contradicts the card. */
function voidFailed(env, voided = {}) {
  if (voided.error === 'guest-cancel') return env.toPerson('guest-cancel', env.decision.request);
  return env.toPerson(`void-failed:${sanitize(voided.error) || 'unknown'}`, env.decision.request);
}

/**
 * One row per mail. A card change (or an answer) whose reply did not go out, or a flag such as an
 * unanswered side question, is for a person.
 */
function finish(env, { kind, mailed, offeredSlots = [], summary, extra = {}, flag: given = '', optional = false }) {
  const flag = given || env.guestFlag || '';
  const unsent = !mailed?.sent && !optional;
  const needsHuman = unsent || Boolean(flag);
  const reason = flag || (unsent ? 'reply-failed' : (mailed?.sent ? '' : mailed?.warning || ''));
  env.log({
    kind,
    intent: env.decision.request,
    reason,
    status: needsHuman ? 'needs_human' : (mailed?.sent ? 'applied' : 'logged'),
    summary: unsent ? `${summary} Svaret til kunden ble ikke sendt (${mailed?.warning || 'ukjent feil'}).` : (flag ? needsHumanSummary(flag) : summary),
    // Only times the client actually received count as offered.
    offeredSlots: mailed?.sent ? offeredSlots : [],
    replyText: mailed?.sent ? sanitize(mailed.text) : '',
    repliedAt: mailed?.sent ? sanitize(mailed.at) || new Date().toISOString() : '',
    replyTo: mailed?.sent ? sanitize(mailed.to || env.to) : '',
    aiRequest: env.decision.aiRequest || '',
    wordsRequest: env.heuristic.request || '',
  });
  return { wrote: true, kind, mailed, logged: true, needsHuman, request: env.decision.request, ...extra };
}

async function bookSales(env, dueAt) {
  const { client } = env;
  const hadBooked = env.bookedFuture;
  const dayYmd = osloCalendarYmd(dueAt);
  // A new clock on the booked day that cannot be booked: the meeting still stands and its own slot is not
  // something to offer back, so nothing is voided and a person answers.
  const onBookedDay = hadBooked && dayYmd === osloCalendarYmd(env.booked);
  if (!withinMeetingHours(dueAt)) {
    if (onBookedDay) return env.toPerson('time-unavailable', 'reschedule');
    const lead = isWeekendYmd(dayYmd) ? 'Vi har dessverre ikke møter i helgen.' : 'Vi har dessverre ikke møter på det tidspunktet.';
    return proposeDay(env, { day: { ymd: dayYmd, band: 'day' }, lead, keepDay: true });
  }
  // A booking is always for the card's own sales rep; without one, a person books.
  if (!isAssignedSalesRepOwner(client.ownerId)) return env.toPerson('no-assigned-rep', 'reschedule');
  const listed = await loadCalendarBusy('sales', client, { queryBusy: env.queryBusy, ymd: dayYmd, now: env.now });
  const busy = hadBooked ? busyWithoutBooked(listed.busy, env.booked, salesCalendarMinutes(client)) : listed.busy;
  if (listed.ok && !slotIsFree(dueAt, salesCalendarMinutes(client), busy)) {
    if (onBookedDay) return env.toPerson('time-unavailable', 'reschedule');
    return proposeDay(env, { day: { ymd: dayYmd, band: 'day' }, lead: `${formatMeetingDate(dueAt)} er dessverre opptatt hos oss.`, keepDay: true });
  }
  const note = botNote(
    hadBooked ? `Kunden ba om ny tid. Bot flyttet møtet fra ${formatMeetingDate(env.booked)} til ${formatMeetingDate(dueAt)}.` : `Kunden valgte ${formatMeetingDate(dueAt)}. Bot satte opp møtet.`,
    { ...env.ctx, summary: '' },
  );
  let moved;
  try {
    moved = await env.moveMeeting(client, dueAt, { note });
  } catch (error) {
    moved = { ok: false, error: String(error?.message || error) };
  }
  if (!moved?.ok) return env.toPerson(`book-failed:${moved?.error || 'unknown'}`, 'reschedule');
  closeFindTimeActions(client.id);
  const fresh = moved.client || sales.getSalesClientById(client.id) || client;
  const side = sideQuestions(env.ctx.clientText, fresh, env.now);
  // The rep chain already mailed the branded confirmation with the calendar file; one mail is enough.
  let mailed;
  let flag = '';
  if (moved.confirmationSent) {
    mailed = {
      sent: true,
      warning: '',
      viaConfirmation: true,
      text: `Bekreftelse med ny møtetid sendt: ${formatMeetingDate(dueAt)} (med kalenderinvitasjon).`,
      at: new Date().toISOString(),
    };
    if (side.asked) flag = 'question-with-booking';
  } else {
    const confirm = `Det passer fint. Da har jeg ${hadBooked ? 'flyttet møtet til' : 'satt opp møtet'} ${formatMeetingDate(dueAt)}. Si fra om det likevel ikke passer.`;
    mailed = await sendClientMail(env, side.answer ? `${confirm}\n\n${side.answer}` : confirm);
    if (side.asked && !side.answer) flag = 'question-with-booking';
  }
  // The card moved but the calendar sync or the confirmation failed afterwards: a rep checks the Google event.
  const warning = sanitize(moved.warning).replace(/\s+/g, ' ').slice(0, 120);
  if (warning) flag = `move-warning:${warning}`;
  return finish(env, {
    kind: 'sales_book',
    mailed,
    flag,
    summary: `Bot ${hadBooked ? 'flyttet møtet til' : 'satte opp møtet'} ${formatMeetingDate(dueAt)}.`,
    extra: { dueAt, previous: env.booked },
  });
}

async function proposeDay(env, { day = env.heuristic.day, lead = '', keepDay = false } = {}) {
  const { decision } = env;
  const voided = await voidBooked(env, 'Kunden vil ha en annen dag. Bot tok bort den gamle møtetiden og foreslo nye tider.');
  if (!voided.ok && !voided.skipped) return voidFailed(env, voided);
  // A day the client asked for by name stays offerable even if it is the old meeting day.
  const excludeYmds = keepDay && day?.ymd
    ? env.excludeYmds.filter((ymd) => ymd !== day.ymd || env.heuristic.excludedDays.includes(ymd))
    : env.excludeYmds;
  let slots = env.offerSlots;
  if (lead || !slots.length || (day?.ymd && !slots.some((iso) => osloCalendarYmd(iso) === day.ymd))) {
    slots = await salesOfferSlots({ client: env.client, day, queryBusy: env.queryBusy, now: env.now, excludeYmds });
  }
  ensureRescheduleAction(env.client, {
    dueAt: slots[0] || morningDueAt(day),
    note: slots.length ? `Bot foreslo nye tider: ${formatSlotListNb(slots)}.` : 'Fant ingen ledig tid automatisk.',
    ctx: env.ctx,
  });
  const usable = !lead && decision.reply && replyTimesMatch(decision.reply, slots) ? decision.reply : '';
  const weekend = Boolean(day?.ymd) && isWeekendYmd(day.ymd);
  const opener = lead
    || (weekend ? 'Vi har dessverre ikke møter i helgen.' : '')
    || (env.heuristic.reason === 'decline-all' ? 'Skjønner, da prøver vi noen andre tider.' : '')
    || (voided.skipped ? '' : 'Helt i orden, vi finner en ny tid.');
  const onDay = day?.ymd && !isWeekendYmd(day.ymd) ? ` på ${weekdayNb(day.ymd)}` : '';
  const fallback = slots.length
    ? `${opener} Passer noe av dette: ${formatSlotListNb(slots)}?`
    : `${opener} ${onDay ? `Hvilket tidspunkt passer${onDay}?` : 'Hvilken dag og tid passer for deg?'}`;
  const mailed = await sendClientMail(env, usable || fallback.trim());
  return finish(env, { kind: 'sales_propose', mailed, offeredSlots: slots, summary: 'Bot foreslo nye møtetider.', extra: { slots } });
}

async function cancelAndAsk(env) {
  const { decision } = env;
  const voided = await voidBooked(env, 'Kunden kan ikke møte og ga ingen ny tid. Bot tok bort møtetiden og spurte om en ny.');
  if (!voided.ok && !voided.skipped) return voidFailed(env, voided);
  const slots = env.offerSlots;
  ensureRescheduleAction(env.client, {
    dueAt: slots[0] || '',
    note: slots.length ? `Kunden kan ikke møte. Bot ba om ny tid og foreslo: ${formatSlotListNb(slots)}.` : 'Kunden kan ikke møte. Bot ba om ny tid.',
    ctx: env.ctx,
  });
  const usable = decision.reply && replyTimesMatch(decision.reply, slots) ? decision.reply : '';
  const opener = voided.skipped && !env.booked ? 'Skjønner, takk for at du sier ifra.' : 'Helt i orden, takk for at du sier ifra.';
  const fallback = slots.length
    ? `${opener} Hvilken dag og tid passer bedre for deg? Vi har for eksempel ledig ${formatSlotListNb(slots)}.`
    : `${opener} Hvilken dag og tid passer bedre for deg?`;
  const mailed = await sendClientMail(env, usable || fallback);
  return finish(env, {
    kind: 'sales_cancel',
    mailed,
    offeredSlots: slots,
    summary: voided.skipped ? 'Bot ba kunden om en ny tid.' : 'Bot tok bort møtet (kunden kan ikke) og ba om en ny tid.',
    extra: { slots, voided: !voided.skipped && Boolean(voided.ok) },
  });
}

/** Client can't pick a time now or asked to be called: a follow-up on the card, never a meeting time. */
async function salesCall(env) {
  const { heuristic, decision } = env;
  const text = env.ctx.clientText;
  const unsure = decision.request === 'not_now' || Boolean(heuristic.unsure);
  const voided = await voidBooked(env, unsure ? 'Kunden kan ikke nå og vil bli kontaktet senere. Bot tok bort møtetiden.' : 'Kunden vil heller ta det på telefon. Bot tok bort møtetiden.');
  if (!voided.ok && !voided.skipped) return voidFailed(env, voided);
  const format = checkupFormatFrom(text);
  const origin = env.now;
  const current = osloParts(origin.toISOString());
  const day = unsure ? pullInVagueDay(heuristic.day, text, { now: origin }) : heuristic.day;
  // No day named: a season word ("etter sommeren") sets the date; otherwise we promise no date at all.
  const season = unsure && !day?.ymd ? seasonFollowUp(text, origin) : null;
  let dueAt = season?.dueAt || morningDueAt(day);
  if (dueAt && Date.parse(dueAt) <= origin.getTime()) dueAt = '';
  if (dueAt && osloParts(dueAt).weekend && !/lørdag|søndag|helg/i.test(text)) dueAt = workdaysAheadAt9(new Date(dueAt), 1);
  let soon = false;
  if (!dueAt && !unsure) {
    soon = !current.weekend && current.hour >= 8 && current.hour < 15;
    dueAt = soon ? new Date(origin.getTime() + 60 * 60 * 1000).toISOString() : workdaysAheadAt9(origin, 1);
  }
  const later = !dueAt;
  if (later) dueAt = workdaysAheadAt9(origin, 5);
  // Never on the day of the meeting the client just declined.
  if (!day?.ymd) dueAt = avoidDays(dueAt, new Set([osloCalendarYmd(env.booked || ''), ...env.excludeYmds].filter(Boolean)));
  const when = soon ? 'i løpet av dagen' : (season?.label || (later ? 'litt senere' : whenPhraseNb(dueAt, origin)));
  ensureCheckupAction(env.client, {
    format,
    dueAt,
    note: unsure
      ? `Kunden kan ikke avtale møtetid nå. Bot lovet å ta kontakt ${when}.`
      : `Kunden ba oss ringe for å avtale møtetid. Bot lovet å ringe ${when}.`,
    ctx: env.ctx,
  });
  const verb = format === 'sms' ? 'sender jeg deg en melding' : format === 'email' ? 'sender jeg deg en e-post' : 'ringer jeg deg';
  const reply = unsure && (later || season)
    ? `Helt greit, da tar vi kontakt ${when}.`
    : `Helt greit. Da ${verb} ${when}, så tar vi det derfra.`;
  const mailed = await sendClientMail(env, reply);
  return finish(env, { kind: 'sales_call', mailed, summary: `Bot lovet å ta kontakt ${when}.`, extra: { checkupDueAt: dueAt, checkupFormat: format } });
}

/** First "ikke interessert": ask why and whether a short chat still works. A second no closes politely. */
async function salesDefer(env) {
  const { message, decision } = env;
  const voided = await voidBooked(env, 'Kunden sa nei til møtet. Bot tok bort møtetiden.');
  if (!voided.ok && !voided.skipped) return voidFailed(env, voided);
  const saidNoBefore = listInboxItems({ salesClientId: env.client.id }).some((row) => /^walk_away/.test(row.kind || '') && row.messageId !== `${message.id}:write`);
  // "Må avlyse, vi har ikke budsjett": the client already said why; asking again or offering times would confuse.
  if (env.heuristic.reason === 'no-need' && !saidNoBefore) {
    ensureCheckupAction(env.client, {
      format: 'ring',
      dueAt: weekFrom(env.now),
      note: 'Kunden avlyste møtet av en annen grunn enn tidspunktet (budsjett eller behov). Bot tok bort møtetiden og avsluttet høflig.',
      ctx: env.ctx,
    });
    const usable = decision.reply && replyTimesMatch(decision.reply, []) ? decision.reply : '';
    const mailed = await sendClientMail(env, usable || 'Skjønner, takk for at du sier ifra. Da lar vi møtet gå. Ta gjerne kontakt hvis det blir aktuelt senere.');
    return finish(env, { kind: 'walk_away_final', mailed, summary: 'Kunden avlyste (budsjett eller behov). Bot tok bort møtet og avsluttet høflig.' });
  }
  if (saidNoBefore) {
    const mailed = await sendClientMail(env, 'Skjønner, takk for at du tok deg tid til å svare. Ta gjerne kontakt om det blir aktuelt senere.');
    return finish(env, { kind: 'walk_away_final', mailed, summary: 'Kunden sa nei igjen. Bot avsluttet høflig.' });
  }
  const dueAt = weekFrom(env.now);
  ensureCheckupAction(env.client, {
    format: 'ring',
    dueAt,
    note: 'Kunden sa nei til møtet. Bot spurte om grunnen og tilbød en kort prat likevel.',
    ctx: env.ctx,
  });
  const slots = env.offerSlots;
  const usable = decision.reply && replyTimesMatch(decision.reply, slots) ? decision.reply : '';
  const ask = 'Skjønner, takk for at du sier ifra. Kan jeg spørre hva som gjorde at det ikke ble aktuelt? Hvis det handler om tidspunktet, tar vi gjerne en kort og uforpliktende prat likevel';
  const fallback = slots.length ? `${ask} — passer noe av dette: ${formatSlotListNb(slots)}?` : `${ask} — si fra hvilken dag som passer.`;
  const mailed = await sendClientMail(env, usable || fallback);
  return finish(env, { kind: 'walk_away', mailed, offeredSlots: slots, summary: 'Kunden sa nei. Bot spurte om grunnen.', extra: { checkupDueAt: dueAt, slots } });
}

async function answerQuestion(env) {
  const { client, decision } = env;
  // "Kan du sende lenken på nytt?" with no link on the card: any answer we could give is a non-answer.
  const link = env.bookedFuture && sanitize(client.calendar?.meetLink || client.calendar?.confirmedMeetLink);
  if (!link && asksForLink(env.ctx.clientText)) return env.toPerson('no-meet-link', 'question');
  const text = decision.reply || faqReply(env.ctx.clientText, client, { now: env.now, slots: env.offerSlots });
  if (!text) return env.toPerson('question:unknown', 'question');
  const mailed = await sendClientMail(env, text);
  const offeredSlots = text.includes('Passer noe av dette') ? env.offerSlots : [];
  return finish(env, { kind: 'gather', mailed, offeredSlots, summary: 'Bot svarte på spørsmål fra kunden.' });
}

/** A weekday, a clock or the meeting itself named in a mail the words read as facts. */
const MEETING_MENTION_RE = /(?<![\p{L}])(?:(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)(?:en)?|monday|tuesday|wednesday|thursday|friday|møte\p{L}*|meeting)(?![\p{L}])|(?<![\p{L}])(?:kl|klokka|klokken)\.?\s*\d|(?<![\p{N}])\d{1,2}[:.]\d{2}(?![\p{N}])/iu;

async function answerInfo(env) {
  const { decision } = env;
  if (!decision.reply) {
    // "Vi kan møtes fredag kl 13" inside a facts mail must not vanish into Kundedata: a person reads it.
    if (MEETING_MENTION_RE.test(env.ctx.clientText)) return env.toPerson('info-about-meeting', 'info');
    // A name without an address still needs a person, even when the facts are only filed.
    if (env.guestFlag) return env.toPerson(env.guestFlag, 'info');
    env.log({ kind: 'none', intent: 'info', reason: 'info-filed', status: 'logged', summary: 'Kunden sendte informasjon. Lagt i kundedata, ingen svar.' });
    return { wrote: false, reason: 'info-filed', logged: true, request: 'info' };
  }
  const mailed = await sendClientMail(env, decision.reply);
  return finish(env, { kind: 'gather', mailed, summary: 'Bot takket for informasjonen.', optional: true });
}

/** The concrete future time the words of a mail named (and any others they could mean), for a later decline to book. */
function wordsTimeOf(heuristic = {}, body = '', origin = new Date(), realNow = new Date()) {
  const nowMs = nowDate(realNow).getTime();
  const raw = [heuristic.dueAt, ...(Array.isArray(heuristic.candidates) ? heuristic.candidates : [])];
  try {
    const parsed = parseTimeDetail(body, { now: origin }) || {};
    raw.push(parsed.dueAt, ...(Array.isArray(parsed.candidates) ? parsed.candidates : []));
  } catch {
    // The parser never decides anything alone; no time is fine.
  }
  const future = [...new Set(raw
    .filter((iso) => iso && Number.isFinite(Date.parse(iso)) && Date.parse(iso) > nowMs)
    .map((iso) => new Date(iso).toISOString()))];
  return { dueAt: future[0] || '', candidates: future };
}

const PLEASANTRY_RE = /(?<![\p{L}])(?:hei|hallo|hi|hello|dear|takk|tusen|mange|thanks|thank|you|mvh|vennlig|med|beste|hilsen|best|kind|regards|ha|en|fin|god|dag|ses|snakkes)(?![\p{L}])/giu;

/** What is left of a mail after the guest sentence is only a greeting and a name: nothing else to answer. */
function onlyPleasantries(body = '', heuristic = {}) {
  if (/\?/.test(body) || heuristic.dueAt || heuristic.day) return false;
  // A cancel, "no thanks" or "not now" with a guest sentence is still a cancel: never swallowed here.
  if (heuristic.cancel || ['cancel', 'not_interested', 'not_now', 'call', 'reschedule'].includes(heuristic.request) || heuristic.reason === 'decline-all') return false;
  const rest = body.replace(PLEASANTRY_RE, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = rest.split(/\s+/).filter(Boolean);
  // What is left must be a name ("Hei Ola", "Mvh Ola Nordmann"): "kan ikke" or "nei" is an answer, not a greeting.
  return words.length <= 3 && words.every((word) => /^\p{Lu}/u.test(word) && !/^(?:ikke|nei|ingen|aldri|no|not)$/iu.test(word));
}

/** A guest's mail that would take the client's meeting away (cancel, no thanks, decline-all, a day offer that voids). */
function guestWouldCancel(heuristic = {}, bookedFuture = false) {
  if (heuristic.request === 'reschedule') return false;
  return Boolean(heuristic.cancel)
    || ['cancel', 'not_interested'].includes(heuristic.request)
    || (['not_now', 'call'].includes(heuristic.request) && bookedFuture)
    || heuristic.reason === 'decline-all';
}

/** The full mail text with the client's new words replaced by the same words minus the guest sentence. */
function textWithout(full = '', fresh = '', body = '') {
  const source = String(full || '');
  return fresh && source.includes(fresh) ? source.replace(fresh, () => body) : body;
}

/** The mail only asked for a guest: say what happened, and nothing the hook did not do. */
async function answerGuestOnly(env) {
  const { guest } = env;
  const when = env.bookedFuture ? formatMeetingDate(env.booked) : '';
  const present = guest.added.length ? guest.added : guest.already;
  const who = joinNb(present.map((row) => guestLabel(row, { withEmail: false })));
  const parts = [];
  if (present.length) {
    if (!env.bookedFuture) parts.push(`${who} får invitasjonen når vi har satt en tid.`);
    else if (!guest.added.length) parts.push(`${who} står allerede på møteinvitasjonen for ${when}.`);
    else if (guest.invited) parts.push(`Jeg har lagt til ${who} på møteinvitasjonen for ${when}.`);
    else parts.push(`Jeg har lagt til ${who} på møtet for ${when}. Invitasjonen går til ${guest.added.length > 1 ? 'dem' : 'vedkommende'} så snart kalenderen er oppdatert.`);
  }
  const missing = guestMissingLine(guest);
  if (missing) parts.push(missing);
  if (!parts.length && env.guestFlag) return env.toPerson(env.guestFlag, 'guest');
  if (!parts.length) {
    // Everyone named was the sender, a colleague of ours or already there: nothing to add, nothing to answer.
    env.log({ kind: 'none', intent: 'guest', reason: 'guest-nothing-to-add', status: 'logged', summary: 'Kunden ba om å legge til en gjest, men ingen ny adresse var å legge til.' });
    return { wrote: false, reason: 'guest-nothing-to-add', logged: true, request: 'guest' };
  }
  const notInvited = present.length > 0 && guest.added.length > 0 && env.bookedFuture && !guest.invited;
  const flag = env.guestFlag || (notInvited ? `guest-add-failed:${guest.warning || 'invite-not-sent'}` : '');
  const mailed = await sendClientMail(env, `Takk! ${parts.join(' ')}`, { withGuests: false });
  const names = joinNb(present.map((row) => guestLabel(row, { withEmail: false })));
  return finish(env, {
    kind: 'guest_add',
    mailed,
    flag,
    summary: present.length ? `Bot la til ${names} som gjest på møtet.` : 'Kunden ba om å legge til en gjest; boten fant ikke adressen.',
    extra: { guests: present.map((row) => row.email) },
  });
}
