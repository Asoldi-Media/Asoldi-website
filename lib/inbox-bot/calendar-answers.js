// Machine mail the bot used to drop silently: a client answering the calendar invite (Avslå / Foreslå ny
// tid) and a bounce saying a mail to the client never arrived. Both are about one sales card, found by the
// event itself first and never by an address that sits on two cards.
import * as sales from '../../data/sales.js';
import { recordOpsEvent } from '../ops-events.js';
import { parseEmailAddress } from './match-client.js';
import { appendInboxItem, listInboxItems } from './store.js';
import { handleCalendarAnswer } from './write.js';

const MEET_CODE_RE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/g;
const SAME_EVENT_MS = 2 * 60 * 1000;
const DAY_MS = 86400000;
const BOUNCE_FROM_RE = /^(?:mailer-daemon|postmaster)@/i;
const BOUNCE_SUBJECT_RE = /undeliverable|delivery status notification|unzustellbar|ikke levert|kunne ikke leveres|returned mail|mail delivery failed|delivery failure|leveringsfeil|undelivered mail/i;
const NOT_A_CLIENT_RE = /@asoldi\.com$|mailer-daemon|postmaster|no-?reply|@(?:google|googlemail|outlook|hotmail-bounce)\.com$/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function text(value = '') {
  return String(value ?? '').trim();
}

function uniq(list = []) {
  return [...new Set(list.filter(Boolean))];
}

function emailsOf(client = {}) {
  return uniq([client.clientEmail, client.contactEmail, client.websiteEmail].map((value) => parseEmailAddress(value)));
}

/** The people the client asked us to add (and the card's own addresses): whoever may answer the invite. */
function guestEmailsOf(client = {}) {
  return uniq((Array.isArray(client.meetingGuests) ? client.meetingGuests : []).map((guest) => parseEmailAddress(guest?.email)));
}

function meetCodeOf(client = {}) {
  return (text(client.calendar?.meetLink || client.calendar?.confirmedMeetLink).toLowerCase().match(MEET_CODE_RE) || [''])[0];
}

function sameInstant(left = '', right = '') {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= SAME_EVENT_MS;
}

/** { kind: 'decline' | 'counter', eventAt, proposedAt, uid, attendee, comment } for a calendar answer, else null. */
export function calendarAnswerOf(message = {}) {
  const reply = message.calendarReply;
  const method = text(message.calendarMethod).toUpperCase();
  if (!reply) return null;
  const base = { uid: text(reply.uid), attendee: parseEmailAddress(reply.attendee), comment: text(reply.comment) };
  if (method === 'COUNTER' && reply.dtstart) return { ...base, kind: 'counter', eventAt: '', proposedAt: reply.dtstart };
  if (method === 'REPLY' && text(reply.partstat).toUpperCase() === 'DECLINED') return { ...base, kind: 'decline', eventAt: text(reply.dtstart), proposedAt: '' };
  return null;
}

/**
 * The card a calendar answer is about: the event's UID (Google writes "<eventId>@google.com"), else the Meet
 * code in the mail at the booked time, else the attendee's own address. { client, via } (via 'ambiguous' when
 * two cards fit, so nothing is changed).
 */
export function cardForCalendarAnswer(clients = [], message = {}, answer = {}) {
  const list = Array.isArray(clients) ? clients : [];
  const uid = text(answer.uid).toLowerCase();
  const byEvent = uid ? list.filter((client) => {
    const eventId = text(client.calendar?.eventId).toLowerCase();
    return eventId && (uid === eventId || uid.startsWith(`${eventId}@`));
  }) : [];
  if (byEvent.length === 1) return { client: byEvent[0], via: 'event' };
  if (byEvent.length > 1) return { client: null, via: 'ambiguous' };
  // A guest's proposal is found through the guest list only: it is logged for a person and changes nothing.
  const attendeeOf = parseEmailAddress(answer.attendee);
  if (answer.kind === 'counter') {
    const byGuest = attendeeOf ? list.filter((client) => guestEmailsOf(client).includes(attendeeOf)) : [];
    return byGuest.length === 1 ? { client: byGuest[0], via: 'guest' } : { client: null, via: byGuest.length > 1 ? 'ambiguous' : '' };
  }
  const codes = new Set(text(message.text).toLowerCase().match(MEET_CODE_RE) || []);
  const byRoom = list.filter((client) => meetCodeOf(client) && codes.has(meetCodeOf(client)) && sameInstant(client.meetingAt, answer.eventAt));
  if (byRoom.length === 1) return { client: byRoom[0], via: 'room' };
  if (byRoom.length > 1) return { client: null, via: 'ambiguous' };
  const attendee = parseEmailAddress(answer.attendee);
  // Own addresses first; a guest's answer on an event we have since replaced (move = delete + insert) still finds the card.
  const byOwn = attendee ? list.filter((client) => emailsOf(client).includes(attendee)) : [];
  const byAttendee = byOwn.length ? byOwn : (attendee ? list.filter((client) => guestEmailsOf(client).includes(attendee)) : []);
  if (byAttendee.length === 1) return { client: byAttendee[0], via: 'attendee' };
  return { client: null, via: byAttendee.length > 1 ? 'ambiguous' : '' };
}

export function isBounceMail(message = {}) {
  return BOUNCE_FROM_RE.test(parseEmailAddress(message.from))
    || /multipart\/report/i.test(text(message.contentType))
    || BOUNCE_SUBJECT_RE.test(text(message.subject));
}

/** The addresses a bounce says never got the mail: Final-/Original-Recipient lines, else the bounce text. */
export function bounceRecipients(message = {}) {
  const status = text(message.deliveryStatus);
  const listed = [...status.matchAll(/^(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+?)>?\s*$/gim)]
    .map((match) => match[1].toLowerCase());
  if (listed.length) return uniq(listed).filter((email) => !NOT_A_CLIENT_RE.test(email));
  if (!isBounceMail(message)) return [];
  // shortcut: without a delivery-status part every address in the bounce text is a candidate; only the ones
  // on a sales card are flagged, so a quoted signature address is harmless. Upgrade to per-provider parsing if
  // that ever flags the wrong card.
  return uniq((text(message.text).match(EMAIL_RE) || []).map((email) => email.toLowerCase())).filter((email) => !NOT_A_CLIENT_RE.test(email)).slice(0, 5);
}

/** Subject of the mail that bounced ("Undeliverable: Invitasjon: …" → "Invitasjon: …"). */
function bouncedSubject(message = {}) {
  return text(message.subject).replace(/^(?:undeliverable|unzustellbar|ikke levert|returned mail|delivery status notification \(failure\))\s*:?\s*/i, '').slice(0, 140);
}

/**
 * A client answered the invite: decline cancels and offers times, a proposed time is booked. Logged for a
 * person when no single card fits. Backfill never changes a meeting.
 */
export async function ingestCalendarAnswer(message = {}, answer = {}, {
  clients = sales.getSalesClients(),
  backfill = false,
  ...writeOpts
} = {}) {
  const matched = cardForCalendarAnswer(clients, message, answer);
  recordOpsEvent('inbox', 'calendar.answer', { kind: answer.kind, via: matched.via, salesClientId: text(matched.client?.id), backfill: Boolean(backfill) });
  if (!matched.client) {
    appendInboxItem({
      kind: answer.kind === 'counter' ? 'calendar_counter' : 'calendar_decline',
      mailbox: message.mailbox,
      messageId: `${message.id}:calendar`,
      from: message.from,
      subject: message.subject,
      receivedAt: message.mailAt || new Date().toISOString(),
      status: 'unmatched',
      reason: matched.via === 'ambiguous' ? 'ambiguous-sender' : 'calendar-unmatched',
      summary: answer.kind === 'counter' ? 'Forslag til ny tid i kalenderen, uten et kort som passer.' : 'Avslått kalenderinvitasjon, uten et kort som passer.',
    });
    return { kind: 'calendar', matched: false, reason: matched.via || 'unmatched' };
  }
  if (backfill) return { kind: 'calendar', matched: true, skipped: true, reason: 'backfill' };
  const eventAt = answer.kind === 'counter' ? text(matched.client.meetingAt) : answer.eventAt;
  const write = await handleCalendarAnswer({ ...writeOpts, client: matched.client, message, answer: { ...answer, eventAt } });
  return { kind: 'calendar', matched: true, write, salesClientId: matched.client.id };
}

/**
 * A mail to a client bounced: flag every card with that address (once per card and address a day) and tell
 * the card's rep through `notifyRep(client, { address, summary })`. Never throws past `notifyRep`.
 */
export async function ingestBounce(message = {}, recipients = [], {
  clients = sales.getSalesClients(),
  notifyRep,
  nowMs = Date.now(),
} = {}) {
  const flagged = [];
  for (const address of recipients) {
    for (const client of (clients || []).filter((card) => emailsOf(card).includes(address))) {
      const recent = listInboxItems({ salesClientId: client.id }).some((item) => (
        item.kind === 'bounce' && (item.found || []).includes(address) && nowMs - Date.parse(item.receivedAt) < DAY_MS
      ));
      if (recent) continue;
      const original = bouncedSubject(message);
      const summary = `E-post til ${address} kom ikke fram${original ? ` («${original}»)` : ''}. Sjekk adressen på kortet.`;
      appendInboxItem({
        kind: 'bounce',
        mailbox: message.mailbox,
        messageId: `${message.id}:bounce:${address}`,
        salesClientId: client.id,
        from: message.from,
        subject: message.subject,
        receivedAt: message.mailAt || new Date(nowMs).toISOString(),
        status: 'logged',
        reason: `bounce:${address}`,
        found: [address],
        summary,
      });
      flagged.push({ salesClientId: client.id, address });
      if (typeof notifyRep === 'function') {
        try {
          await notifyRep(client, { address, summary });
        } catch (error) {
          console.warn(`[inbox-bot] bounce notice failed client=${client.id}: ${text(error?.message || error)}`);
        }
      }
    }
  }
  recordOpsEvent('inbox', 'bounce', { recipients: recipients.length, flagged: flagged.map((row) => row.salesClientId) });
  return { kind: 'bounce', flagged };
}
