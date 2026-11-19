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

// A person the client forwarded the invite to answers it too. Only the card's own address speaks for the client.
const GUEST = 'kari@partner.example';
const { appendInboxItem } = await import('../lib/inbox-bot/store.js');

test("a guest's Avslå changes nothing: no void, no mail, a log row \"Gjest avslo møtet\"", async () => {
  const client = seed({ email: 'ola-g1@kalender.test', eventId: 'evt-g1' });
  const { sent, voids, result } = await ingest(asMessage(calendarMail({
    from: 'Kari Hansen <kari@partner.example>',
    calendar: ics({ uid: 'evt-g1@google.com', attendee: GUEST }),
  })));
  assert.equal(result.write.reason, 'guest-declined');
  assert.equal(voids.length, 0);
  assert.equal(sent.length, 0);
  const card = sales.getSalesClientById(client.id);
  assert.equal(card.agreedTime, true);
  assert.equal(card.meetingAt, BOOKED);
  const item = listInboxItems({ salesClientId: client.id }).at(-1);
  assert.deepEqual([item.kind, item.status, item.reason], ['guest_declined', 'logged', 'guest-declined']);
  assert.equal(item.summary, `Gjest avslo møtet: ${GUEST}`);
  const { buildSalesCardLog } = await import('../lib/sales-card-log.js');
  const rows = buildSalesCardLog({ ...card, inboxBot: presentInboxForClient(client.id) }, NOW.getTime());
  assert.ok(rows.some((row) => row.name === 'Gjest avslo møtet' && row.text.includes(GUEST)));
});

test("a guest's Foreslå ny tid is never booked: a person decides and the meeting stays", async () => {
  const client = seed({ email: 'ola-g2@kalender.test', eventId: 'evt-g2' });
  const { moves, sent, result } = await ingest(asMessage(calendarMail({
    from: 'Kari Hansen <kari@partner.example>',
    subject: 'Nytt tidspunkt foreslått: Asoldi · Online møte',
    calendar: ics({ method: 'COUNTER', partstat: 'TENTATIVE', uid: 'evt-g2@google.com', start: '20310307T130000', attendee: GUEST }),
  })));
  assert.equal(result.write.reason, 'guest-counter');
  assert.equal(moves.length + sent.length, 0);
  assert.equal(sales.getSalesClientById(client.id).meetingAt, BOOKED);
  const item = listInboxItems({ salesClientId: client.id }).at(-1);
  assert.deepEqual([item.status, item.reason], ['needs_human', 'guest-counter']);
});

test("a guest's decline on an event we have since replaced still finds the card through the guest list", async () => {
  const { cardForCalendarAnswer } = await import('../lib/inbox-bot/calendar-answers.js');
  const cards = [
    { id: 'c-1', contactEmail: 'ola@kunde.example', calendar: { eventId: 'new-event' }, meetingGuests: [{ email: GUEST, name: 'Kari Hansen' }] },
    { id: 'c-2', contactEmail: 'per@annet.example', calendar: { eventId: 'other' } },
  ];
  const answer = { kind: 'decline', uid: 'old-deleted-event@google.com', attendee: GUEST, eventAt: BOOKED };
  assert.deepEqual(cardForCalendarAnswer(cards, { text: '' }, answer), { client: cards[0], via: 'attendee' });
  assert.equal(cardForCalendarAnswer(cards, { text: '' }, { ...answer, attendee: 'ukjent@x.example' }).client, null, 'a stranger finds no card');
  assert.equal(cardForCalendarAnswer(cards, { text: '' }, { ...answer, kind: 'counter' }).via, 'guest', 'a proposal is found through the guest list too, and only logged');
  assert.equal(cardForCalendarAnswer(cards, { text: '' }, { ...answer, attendee: 'ola@kunde.example' }).client.id, 'c-1');
  // The whole path: the stored guest declines the replaced event; the client's meeting is untouched.
  const card = seed({ email: 'ola-g3@kalender.test', eventId: 'evt-g3-new' });
  const withGuest = { ...card, meetingGuests: [{ email: GUEST, name: 'Kari Hansen' }] };
  const { voids, sent, result } = await ingest(asMessage(calendarMail({
    from: 'Kari Hansen <kari@partner.example>',
    calendar: ics({ uid: 'evt-g3-old@google.com', attendee: GUEST }),
  })), { clients: [withGuest] });
  assert.equal(result.matched, true);
  assert.equal(result.write.reason, 'guest-declined');
  assert.equal(voids.length + sent.length, 0);
});

/** The client's own earlier mail, left for a person, with the Friday 13:00 it asked for. */
function openRequest(client, { at = '2031-03-07T12:00:00.000Z', receivedAt = '2031-03-03T07:00:00.000Z', candidates = [at], ...extra } = {}) {
  return appendInboxItem({
    kind: 'silent',
    mailbox: 'alexander@asoldi.com',
    messageId: `open-${client.id}:write`,
    salesClientId: client.id,
    receivedAt,
    status: 'needs_human',
    reason: 'ai-disagrees:reschedule',
    text: 'Kan vi skyve til fredag kl 13?',
    wordsDueAt: at,
    wordsCandidates: candidates,
    from: `Ola <${client.contactEmail}>`,
    wordsRequest: 'question',
    aiRequest: 'reschedule',
    ...extra,
  });
}

test('the client declines the invite while a new time they asked for is still open: that time is booked, nothing is voided', async () => {
  const client = seed({ email: 'ola-o1@kalender.test', eventId: 'evt-o1' });
  const open = openRequest(client);
  const { moves, voids, sent } = await ingest(asMessage(calendarMail({
    from: 'Ola <ola-o1@kalender.test>',
    calendar: ics({ uid: 'evt-o1@google.com', attendee: 'ola-o1@kalender.test' }),
  })));
  assert.deepEqual(moves.map((row) => row.dueAt), ['2031-03-07T12:00:00.000Z']);
  assert.equal(voids.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /fredag 7\. mars 2031 kl\. 13:00/i, 'the reply names the time');
  assert.equal(sent[0].subject, 'Ny tid for møtet med Asoldi');
  assert.equal(listInboxItems({ salesClientId: client.id }).find((row) => row.id === open.id).status, 'applied', 'the open request is closed');
});

test('a decline with an open request that cannot be booked keeps void + offer, the requested day first', async () => {
  const client = seed({ email: 'ola-o2@kalender.test', eventId: 'evt-o2' });
  openRequest(client);
  const { moves, voids, sent } = await ingest(asMessage(calendarMail({
    from: 'Ola <ola-o2@kalender.test>',
    calendar: ics({ uid: 'evt-o2@google.com', attendee: 'ola-o2@kalender.test' }),
  })), {
    // The rep is busy exactly then (13:00-14:00 Oslo on Friday).
    queryBusy: async () => ({ busy: [{ start: '2031-03-07T12:00:00.000Z', end: '2031-03-07T13:00:00.000Z' }] }),
  });
  assert.equal(moves.length, 0);
  assert.equal(voids.length, 1);
  const item = listInboxItems({ salesClientId: client.id }).at(-1);
  assert.equal(item.kind, 'sales_declined');
  assert.ok(item.offeredSlots.length > 0);
  assert.equal(osloCalendarYmd(item.offeredSlots[0]), '2031-03-07', 'Friday, the day they asked for, comes first');
  assert.match(sent[0].text, /Du ba tidligere om fredag 7\. mars 2031 kl\. 13:00/i);
});

test('an old, ambiguous or already booked open request does not turn a decline into a booking', async () => {
  const stale = seed({ email: 'ola-o3@kalender.test', eventId: 'evt-o3' });
  openRequest(stale, { receivedAt: '2031-02-27T07:00:00.000Z' });
  const first = await ingest(asMessage(calendarMail({ from: 'Ola <ola-o3@kalender.test>', calendar: ics({ uid: 'evt-o3@google.com', attendee: 'ola-o3@kalender.test' }) })));
  assert.deepEqual([first.moves.length, first.voids.length], [0, 1], 'older than 72 hours');
  const two = seed({ email: 'ola-o4@kalender.test', eventId: 'evt-o4' });
  openRequest(two, { candidates: ['2031-03-07T12:00:00.000Z', '2031-03-10T12:00:00.000Z'] });
  const second = await ingest(asMessage(calendarMail({ from: 'Ola <ola-o4@kalender.test>', calendar: ics({ uid: 'evt-o4@google.com', attendee: 'ola-o4@kalender.test' }) })));
  assert.deepEqual([second.moves.length, second.voids.length], [0, 1], 'two different times named: not ours to guess');
  const same = seed({ email: 'ola-o5@kalender.test', eventId: 'evt-o5' });
  openRequest(same, { at: BOOKED });
  const third = await ingest(asMessage(calendarMail({ from: 'Ola <ola-o5@kalender.test>', calendar: ics({ uid: 'evt-o5@google.com', attendee: 'ola-o5@kalender.test' }) })));
  assert.deepEqual([third.moves.length, third.voids.length], [0, 1], 'the request is the very meeting being declined');
});

test('a decline never books a date from a mail that was not a move request, or from a guest', async () => {
  const cases = [
    ['unclear', { wordsRequest: 'unclear', aiRequest: '', reason: 'unclear' }],
    ['question', { wordsRequest: 'question', aiRequest: 'question', reason: 'ai-disagrees:question' }],
    ['guest sender', { from: 'Kari Hansen <kari@partner.example>' }],
  ];
  for (const [index, [label, extra]] of cases.entries()) {
    const email = `ola-n${index}@kalender.test`;
    const client = seed({ email, eventId: `evt-n${index}` });
    openRequest(client, extra);
    const { moves, voids } = await ingest(asMessage(calendarMail({
      from: `Ola <${email}>`,
      calendar: ics({ uid: `evt-n${index}@google.com`, attendee: email }),
    })));
    assert.deepEqual([moves.length, voids.length], [0, 1], label);
  }
});
