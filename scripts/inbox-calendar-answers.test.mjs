// A client clicking "Avslå" / "Foreslå ny tid" on the invite, and a bounce, used to be dropped as machine
// mail. Now a decline cancels and offers times, a proposal is booked, and a bounce flags the card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-inbox-calendar-'));
delete process.env.DEEPSEEK_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const sales = await import('../data/sales.js');
const { ingestInboxMessage } = await import('../lib/inbox-bot/index.js');
const { defaultVoidMeeting } = await import('../lib/inbox-bot/meeting.js');
const { listInboxItems, presentInboxForClient } = await import('../lib/inbox-bot/store.js');
const { bounceRecipients, calendarAnswerOf } = await import('../lib/inbox-bot/calendar-answers.js');
const { parseIcsEvent, icsDateToIso } = await import('../packages/suite/core/mail/ics.js');
const { parseRfc822 } = await import('../packages/suite/core/mail/mime.js');
const { osloCalendarYmd } = await import('../lib/website-due.js');

// Monday 3 March 2031 09:15 Oslo; the meeting is Thursday 6 March 10:00 Oslo (09:00 UTC).
const NOW = new Date('2031-03-03T08:15:00.000Z');
const BOOKED = '2031-03-06T09:00:00.000Z';
let seq = 0;

function seed({ email, eventId = '', meetLink = 'https://meet.google.com/abc-defg-hij' } = {}) {
  seq += 1;
  const id = `cal-${seq}`;
  sales.createSalesClient({ id, businessName: `Kalender ${seq} AS`, contactEmail: email || `kunde${seq}@kalender.test`, product: 'asoldi' });
  sales.updateSalesClient(id, {
    ownerId: 'sales:rep-1',
    meetingAt: BOOKED,
    agreedTime: true,
    reminders: { thankYouSentAt: '2031-02-27T10:00:00.000Z' },
    calendar: { eventId, meetLink, accountKey: 'sales:rep-1' },
  });
  sales.rescheduleSalesReminders(id, NOW.getTime());
  return sales.getSalesClientById(id);
}

function ics({ method = 'REPLY', partstat = 'DECLINED', uid = 'evt-1@google.com', start = '20310306T100000', attendee = 'kunde@kalender.test' } = {}) {
  return [
    'BEGIN:VCALENDAR',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `DTSTART;TZID=Europe/Oslo:${start}`,
    'DTEND;TZID=Europe/Oslo:20310306T103000',
    `UID:${uid}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${partstat};CN=Kunde`,
    ` Person;X-NUM-GUESTS=0:mailto:${attendee}`,
    'SUMMARY:Asoldi · Online møte',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function calendarMail({ from, subject = 'Avslått: Asoldi · Online møte', body = 'Kunden har avslått invitasjonen.', calendar }) {
  return [
    `From: ${from}`,
    'To: alexander@asoldi.com',
    `Subject: ${subject}`,
    'Message-ID: <cal-reply@kalender.test>',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '--b1',
    `Content-Type: text/calendar; charset=utf-8; method=${calendar.match(/METHOD:(\w+)/)[1]}`,
    '',
    calendar,
    '--b1--',
    '',
  ].join('\r\n');
}

function asMessage(raw) {
  seq += 1;
  const parsed = parseRfc822(raw);
  return {
    id: `cal-msg-${seq}`,
    mailbox: 'alexander@asoldi.com',
    mailAt: NOW.toISOString(),
    rfcMessageId: parsed.messageId,
    from: parsed.from,
    subject: parsed.subject,
    text: parsed.text,
    contentType: parsed.contentType,
    calendarMethod: parsed.calendarMethod,
    calendarReply: parsed.calendarReply,
    deliveryStatus: parsed.deliveryStatus,
  };
}

async function ingest(message, opts = {}) {
  const sent = [];
  const voids = [];
  const moves = [];
  const result = await ingestInboxMessage(message, {
    sendEmail: async (payload) => { sent.push(payload); },
    queryBusy: async () => ({ busy: [] }),
    voidMeeting: async (card, options) => { voids.push(options); return defaultVoidMeeting(card, options); },
    moveMeeting: async (card, dueAt, options) => {
      moves.push({ dueAt, options });
      return { ok: true, client: sales.updateSalesClient(card.id, { meetingAt: dueAt, agreedTime: true }), confirmationSent: false };
    },
    now: NOW,
    ...opts,
  });
  return { result, sent, voids, moves };
}

test('ICS: unfolded ATTENDEE, PARTSTAT and an Oslo DTSTART read as UTC', () => {
  const event = parseIcsEvent(ics());
  assert.equal(event.method, 'REPLY');
  assert.equal(event.partstat, 'DECLINED');
  assert.equal(event.attendee, 'kunde@kalender.test');
  assert.equal(event.dtstart, BOOKED, '10:00 Oslo in winter is 09:00 UTC');
  assert.equal(event.uid, 'evt-1@google.com');
  assert.equal(icsDateToIso('20310706T100000', 'Europe/Oslo'), '2031-07-06T08:00:00.000Z', 'summer time is UTC+2');
  assert.equal(icsDateToIso('20310306T090000Z'), BOOKED);
  assert.equal(icsDateToIso('20310306T100000', 'W. Europe Standard Time'), BOOKED, 'Outlook\'s Windows zone name');
});

test('the MIME parser exposes the calendar answer of a REPLY part', () => {
  const parsed = parseRfc822(calendarMail({ from: 'Kunde <kunde@kalender.test>', calendar: ics() }));
  assert.equal(parsed.calendarMethod, 'REPLY');
  assert.equal(parsed.calendarReply.partstat, 'DECLINED');
  assert.equal(parsed.calendarReply.dtstart, BOOKED);
  assert.deepEqual(calendarAnswerOf({ calendarMethod: 'REPLY', calendarReply: { partstat: 'ACCEPTED', dtstart: BOOKED } }), null, 'a yes changes nothing');
});

test('Avslå on the booked meeting: void without a second cancellation, free times from Alexander, "Avslo møtet" on the card', async () => {
  const client = seed({ email: 'kunde@kalender.test', eventId: 'evt-1' });
  const { sent, voids } = await ingest(asMessage(calendarMail({ from: 'Kunde <kunde@kalender.test>', calendar: ics({ uid: 'evt-1@google.com' }) })));
  assert.deepEqual(voids.map((row) => [row.notifyClient, row.declined]), [[false, true]]);
  const card = sales.getSalesClientById(client.id);
  assert.equal(card.agreedTime, false);
  assert.equal(card.salesPlaybook.declinedMeetingAt, BOOKED);
  assert.ok(card.salesPlaybook.declinedAt);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'kunde@kalender.test');
  assert.equal(sent[0].from, 'Alexander fra Asoldi <alexander@asoldi.com>');
  assert.equal(sent[0].subject, 'Ny tid for møtet med Asoldi');
  assert.equal(sent[0].headers, undefined, 'not threaded into a calendar notification');
  assert.match(sent[0].text, /ikke passet, så jeg har tatt bort den tiden\. Passer noe av dette/);
  const item = listInboxItems({ salesClientId: client.id }).at(-1);
  assert.deepEqual([item.kind, item.status], ['sales_declined', 'applied']);
  assert.equal(item.replyText, sent[0].text);
  assert.ok(item.offeredSlots.length > 0);
  assert.ok(item.offeredSlots.every((iso) => osloCalendarYmd(iso) !== '2031-03-06'), 'never the declined day');
});

test('a Google notification decline (sender is Google) is matched by the Meet code and the booked time', async () => {
  const client = seed({ email: 'post@eureka.test', meetLink: 'https://meet.google.com/vkg-qmtg-jom' });
  const raw = calendarMail({
    from: '"post@eureka.test (Google Kalender)" <calendar-notification@google.com>',
    body: 'post@eureka.test har avslått invitasjonen.\nhttps://meet.google.com/vkg-qmtg-jom',
    calendar: ics({ uid: 'other-id@google.com', attendee: 'post@eureka.test' }),
  });
  const { voids, sent } = await ingest(asMessage(raw));
  assert.equal(voids.length, 1);
  assert.equal(sent[0].to, 'post@eureka.test');
  assert.equal(sales.getSalesClientById(client.id).agreedTime, false);
});

test('a decline for an older time changes nothing; the backfill never changes a meeting', async () => {
  const client = seed({ email: 'gammel@kalender.test', eventId: 'evt-old' });
  const old = await ingest(asMessage(calendarMail({ from: 'Kunde <gammel@kalender.test>', calendar: ics({ uid: 'evt-old@google.com', start: '20310304T100000', attendee: 'gammel@kalender.test' }) })));
  assert.equal(old.voids.length, 0);
  assert.equal(old.sent.length, 0);
  assert.equal(listInboxItems({ salesClientId: client.id }).at(-1).reason, 'calendar-other-time');
  const backfill = await ingest(asMessage(calendarMail({ from: 'Kunde <gammel@kalender.test>', calendar: ics({ uid: 'evt-old@google.com', attendee: 'gammel@kalender.test' }) })), { backfill: true });
  assert.equal(backfill.voids.length, 0);
  assert.equal(sales.getSalesClientById(client.id).agreedTime, true);
});

test('"Foreslå ny tid" (COUNTER) books the proposed time through the normal checks', async () => {
  const client = seed({ email: 'forslag@kalender.test', eventId: 'evt-counter' });
  const { moves, sent } = await ingest(asMessage(calendarMail({
    from: 'Kunde <forslag@kalender.test>',
    subject: 'Nytt tidspunkt foreslått: Asoldi · Online møte',
    calendar: ics({ method: 'COUNTER', partstat: 'TENTATIVE', uid: 'evt-counter@google.com', start: '20310307T130000', attendee: 'forslag@kalender.test' }),
  })));
  assert.deepEqual(moves.map((row) => row.dueAt), ['2031-03-07T12:00:00.000Z']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /flyttet møtet til/);
  assert.equal(listInboxItems({ salesClientId: client.id }).at(-1).kind, 'sales_book');
});

test('a delivery-status bounce flags every card with that address once a day and tells the rep once', async () => {
  const client = seed({ email: 'post@byggfirma.test' });
  const raw = [
    'From: Mail Delivery Subsystem <mailer-daemon@google.com>',
    'To: alexander@asoldi.com',
    'Subject: Delivery Status Notification (Failure)',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="r1"',
    '',
    '--r1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Adressen ble ikke funnet.',
    '--r1',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; googlemail.com',
    '',
    'Final-Recipient: rfc822; post@byggfirma.test',
    'Action: failed',
    'Status: 5.1.1',
    '--r1--',
    '',
  ].join('\r\n');
  const message = asMessage(raw);
  assert.deepEqual(bounceRecipients(message), ['post@byggfirma.test']);
  const notices = [];
  const notifyRep = async (card, info) => notices.push({ id: card.id, ...info });
  await ingest(message, { notifyRep });
  await ingest(asMessage(raw), { notifyRep });
  const bounces = listInboxItems({ salesClientId: client.id }).filter((item) => item.kind === 'bounce');
  assert.equal(bounces.length, 1, 'the second bounce the same day adds nothing');
  assert.equal(notices.length, 1);
  assert.match(notices[0].summary, /post@byggfirma\.test kom ikke fram/);
  const presented = presentInboxForClient(client.id);
  assert.equal(presented.bounce.address, 'post@byggfirma.test');
  assert.equal(presented.needsHuman, 0, 'a bounce has its own pill, not "E-post venter svar"');
});

test('a rep\'s own Fireflies or Fathom is recognised from its own mails; a recap of the hub account is not', async () => {
  const { foreignNotetakerOf } = await import('../lib/inbox-bot/notetaker-watch.js');
  const fred = '"Fred from Fireflies.ai" <fred@fireflies.ai>';
  const inAlex = (from, subject, text) => ({ mailbox: 'alexander@asoldi.com', from, subject, text });
  assert.deepEqual(foreignNotetakerOf(inAlex(fred, 'Your meeting recap - Asoldi · Online møte', 'Alexander Farkas\n\n(alexander@asoldi.com)\ninvited Fireflies to your meeting')), { tool: 'Fireflies', mailbox: 'alexander@asoldi.com' });
  assert.ok(foreignNotetakerOf(inAlex(fred, 'Your meeting recap', 'Your meeting recap\nis ready\n\nInvited by Alexander Farkas\n\nalexander@asoldi.com')));
  assert.ok(foreignNotetakerOf(inAlex(fred, "Your Fireflies bot wasn't admitted to your meeting", 'Hi Alexander,\n\nYour Fireflies notetaker bot tried to join')));
  assert.deepEqual(foreignNotetakerOf(inAlex('Fathom <no-reply@fathom.video>', 'Reminder: Your AI notetaker will join your upcoming meeting', '')), { tool: 'Fathom', mailbox: 'alexander@asoldi.com' });
  assert.equal(foreignNotetakerOf(inAlex(fred, 'Your meeting recap', 'Invited by Damian Hegdal\n\ndamian@asoldi.com')), null, 'the hub key owner\'s recording');
  assert.equal(foreignNotetakerOf({ mailbox: 'damian@asoldi.com', from: fred, subject: 'Your meeting recap', text: 'Invited by Damian\n\ndamian@asoldi.com' }), null);
  assert.equal(foreignNotetakerOf(inAlex('Kunde <kunde@kalender.test>', 'Re: møtet', 'Your Fireflies bot')), null, 'only Fireflies itself counts');

  const notices = [];
  const recap = (n) => ({ id: `recap-${n}`, mailbox: 'alexander@asoldi.com', mailAt: NOW.toISOString(), from: fred, subject: 'Your meeting recap', text: 'Invited by Alexander Farkas\n\nalexander@asoldi.com' });
  await ingestInboxMessage(recap(1), { notifyOwner: async (found) => notices.push(found), now: NOW });
  await ingestInboxMessage(recap(2), { notifyOwner: async (found) => notices.push(found), now: NOW });
  assert.deepEqual(notices, [{ tool: 'Fireflies', mailbox: 'alexander@asoldi.com' }], 'told once a day');
});

test('an Exchange bounce without a delivery-status part still names the address from its text', () => {
  const message = {
    from: '<postmaster@byggfirma.test>',
    subject: 'Undeliverable: Invitasjon: Asoldi · Online møte',
    contentType: 'multipart/mixed',
    text: 'Delivery has failed to these recipients or groups:\npost@byggfirma.test\nThe email address you entered couldn\'t be found.\nalexander@asoldi.com',
  };
  assert.deepEqual(bounceRecipients(message), ['post@byggfirma.test']);
  assert.deepEqual(bounceRecipients({ from: 'Kunde <kunde@kalender.test>', subject: 'Re: møtet', text: 'Skriv til ola@kalender.test' }), [], 'a normal mail is no bounce');
});
