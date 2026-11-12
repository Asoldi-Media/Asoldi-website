import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-inbox-intents-'));
delete process.env.DEEPSEEK_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const sales = await import('../data/sales.js');
const { backfillInboxReplies, ingestInboxMessage, tickInboxBot, presentInboxForClient } = await import('../lib/inbox-bot/index.js');
const { categorizeEmailHeuristic } = await import('../lib/inbox-bot/categorize.js');
const { classifyInboxRequest } = await import('../lib/inbox-bot/intent.js');
const { inboxBotStage } = await import('../lib/inbox-bot/stage.js');
const { matchSalesClient } = await import('../lib/inbox-bot/match-client.js');
const { mergeWriteDecision, replyIsSafe } = await import('../lib/inbox-bot/decide.js');
const { defaultMoveMeeting } = await import('../lib/inbox-bot/meeting.js');
const threadShim = await import('../lib/inbox-bot/thread.js');
const { listInboxItems } = await import('../lib/inbox-bot/store.js');
const { pickFreeSlots, withinMeetingHours } = await import('../lib/inbox-bot/slots.js');
const { salesFocusEntries } = await import('../lib/sales-playbook.js');
const { osloCalendarYmd } = await import('../lib/website-due.js');
const { buildContractPdf } = await import('../lib/offer-contract-pdf.js');

// Monday 3 March 2031 09:15 Oslo (CET). The booked meeting is Thursday 6 March 10:00 Oslo.
const NOW = new Date('2031-03-03T08:15:00.000Z');
const BOOKED = '2031-03-06T09:00:00.000Z';
const FRIDAY_13 = '2031-03-07T12:00:00.000Z';

let seq = 0;

function seed(stage = 'meeting', overrides = {}) {
  seq += 1;
  const id = `sale-intent-${seq}`;
  const email = `kunde${seq}@intent-test.no`;
  sales.createSalesClient({
    id,
    businessName: `Intent Test ${seq} AS`,
    contactEmail: email,
    clientEmail: `intent${seq}@asoldi-kunde.no`,
    orgNumber: String(900000000 + seq),
    product: 'asoldi',
  });
  const progression = {
    meeting: {},
    offer: { meetingHeld: true },
    signature: { meetingHeld: true, offerSent: true },
    won: { meetingHeld: true, offerSent: true, contractSigned: true },
  }[stage] || {};
  sales.updateSalesClient(id, {
    ownerId: 'sales:rep-1',
    meetingAt: BOOKED,
    agreedTime: true,
    progression,
    reminders: { thankYouSentAt: '2031-02-27T10:00:00.000Z' },
    ...overrides,
  });
  sales.rescheduleSalesReminders(id, NOW.getTime());
  return sales.getSalesClientById(id);
}

function meetingRow(client) {
  return (client.nextActions || []).find((row) => row.presetKey === 'meeting' && !row.doneAt) || null;
}

async function mail(client, text, {
  subject = 'Re: Online møte med Asoldi',
  mailAt = NOW.toISOString(),
  now = NOW,
  decideAi,
  queryBusy = async () => ({ busy: [] }),
  moveMeeting,
  voidMeeting,
  from = client.contactEmail,
  categorize = categorizeEmailHeuristic,
  sendEmail,
  attachments,
  interpretNote,
  realNow,
} = {}) {
  seq += 1;
  const sent = [];
  const result = await ingestInboxMessage({
    id: `intent-msg-${seq}`,
    mailbox: 'alexander@asoldi.com',
    from: `Kunde <${from}>`,
    subject,
    text,
    mailAt,
    ...(attachments ? { attachments, attachmentNames: attachments.map((part) => part.filename) } : {}),
  }, {
    categorize,
    sendEmail: sendEmail || (async (payload) => { sent.push(payload); }),
    queryBusy,
    decideAi,
    moveMeeting,
    voidMeeting,
    now,
    ...(realNow ? { realNow } : {}),
    ...(interpretNote ? { interpretNote } : {}),
  });
  return { result, sent, card: sales.getSalesClientById(client.id), write: result.write || result };
}

/** NOW plus some hours, for a follow-up mail. */
function later(hours = 1) {
  const at = new Date(NOW.getTime() + hours * 3600000);
  return { now: at, mailAt: at.toISOString() };
}

function ymd(iso = '') {
  return osloCalendarYmd(iso);
}

function openTasks(card, presetKey) {
  return (card.nextActions || []).filter((row) => !row.doneAt && row.presetKey === presetKey);
}

function lastRow(clientId) {
  const rows = listInboxItems({ salesClientId: clientId });
  return rows[rows.length - 1];
}

test('stage: meeting before Tilbud, then offer / signature / won, and off for other statuses', () => {
  assert.equal(inboxBotStage(seed('meeting')), 'meeting');
  assert.equal(inboxBotStage(seed('offer')), 'offer');
  assert.equal(inboxBotStage(seed('signature')), 'signature');
  assert.equal(inboxBotStage(seed('won')), 'won');
  assert.equal(inboxBotStage(seed('meeting', { status: 'secondary' })), 'off');
  assert.equal(inboxBotStage({}), 'off');
});

for (const stage of ['offer', 'signature', 'won']) {
  test(`${stage}: no reply, no meeting change, mail logged for a person`, async () => {
    const client = seed(stage);
    const before = sales.getSalesClientById(client.id);
    for (const text of [
      'Kan vi ta onsdag kl 15 i stedet?',
      'Jeg kan dessverre ikke komme på møtet likevel.',
      'Har dere fått kontrakten? Hva er bindingstiden?',
      'Vi er ikke interessert likevel.',
    ]) {
      const { sent, card, write } = await mail(client, text);
      assert.equal(sent.length, 0, text);
      assert.equal(card.meetingAt, before.meetingAt, text);
      assert.equal(card.agreedTime, before.agreedTime, text);
      assert.deepEqual(card.progression, before.progression, text);
      assert.equal(card.nextActions.length, before.nextActions.length, text);
      assert.equal(write.silent, true, text);
      const row = lastRow(client.id);
      assert.equal(row.status, 'needs_human', text);
      assert.equal(row.reason, `stage:${stage}`);
      assert.equal(row.kind, 'silent');
    }
    const shown = presentInboxForClient(client.id);
    assert.ok(shown.needsHuman >= 4);
    assert.equal(shown.activity[0].reason, `stage:${stage}`);
  });
}

test('a thank-you from a Tilbud client is logged without asking a person', async () => {
  const client = seed('offer');
  const { sent } = await mail(client, 'Takk!');
  assert.equal(sent.length, 0);
  assert.equal(lastRow(client.id).status, 'logged');
});

test('reschedule with date and time moves the meeting row and re-keys every reminder', async () => {
  const client = seed('meeting');
  const { sent, card, write } = await mail(client, 'Hei! Kan vi flytte møtet til fredag 7. mars kl 13?');
  assert.equal(write.kind, 'sales_book');
  assert.equal(meetingRow(card).dueAt, FRIDAY_13);
  assert.equal(card.meetingAt, FRIDAY_13);
  assert.equal(card.agreedTime, true);
  assert.equal(card.reminders.reminder24hAt, '2031-03-06T12:00:00.000Z');
  assert.equal(card.reminders.reminder1hAt, '2031-03-07T11:00:00.000Z');
  assert.equal(card.reminders.reminder24hSentAt || '', '');
  assert.equal(card.reminders.reminder1hSentAt || '', '');
  assert.match(meetingRow(card).note, /^Bot: Kunden ba om ny tid/m);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /flyttet møtet til fredag 7\. mars 2031 kl\. 13:00/);
  assert.match(sent[0].subject, /^Re: Online møte med Asoldi/);
});

test('the server move hook is used for the rep, and its confirmation replaces the bot mail', async () => {
  const client = seed('meeting');
  const calls = [];
  const { sent, write } = await mail(client, 'Kan vi ta fredag 7. mars kl 13 i stedet?', {
    moveMeeting: async (card, dueAt, opts) => {
      calls.push({ id: card.id, ownerId: card.ownerId, dueAt, note: opts.note });
      return { ok: true, client: card, confirmationSent: true, error: '' };
    },
  });
  assert.equal(write.kind, 'sales_book');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dueAt, FRIDAY_13);
  assert.equal(calls[0].ownerId, 'sales:rep-1');
  assert.match(calls[0].note, /^Bot:/);
  assert.equal(sent.length, 0);
});

test('a failed move is handed to a person instead of telling the client it is booked', async () => {
  const client = seed('meeting');
  const { sent, write } = await mail(client, 'Kan vi ta fredag 7. mars kl 13 i stedet?', {
    moveMeeting: async () => ({ ok: false, client: null, confirmationSent: false, error: 'calendar' }),
  });
  assert.equal(sent.length, 0);
  assert.equal(write.needsHuman, true);
  assert.equal(lastRow(client.id).status, 'needs_human');
});

test('a confirmation of the booked time changes nothing and sends nothing', async () => {
  const client = seed('meeting');
  for (const text of ['Ja, det passer. Sees torsdag kl 10', 'Ok, takk!', 'Supert, vi sees!', 'Torsdag passer fint']) {
    const { sent, card } = await mail(client, text);
    assert.equal(sent.length, 0, text);
    assert.equal(card.meetingAt, BOOKED, text);
  }
});

test("can't attend without a new time: the meeting is voided, reminders stop, a Ny møtetid task and a request for a new time go out", async () => {
  const client = seed('meeting');
  const { sent, card, write } = await mail(client, 'Hei, jeg kan dessverre ikke komme på møtet likevel.');
  assert.equal(write.kind, 'sales_cancel');
  assert.equal(card.agreedTime, false);
  assert.equal(card.meetingAt || '', '');
  assert.equal(meetingRow(card)?.dueAt || '', '');
  assert.equal(card.reminders.thankYouSentAt || '', '');
  assert.equal(card.reminders.reminder24hAt || '', '');
  assert.equal(card.reminders.reminder1hAt || '', '');
  assert.ok((card.nextActions || []).some((row) => !row.doneAt && row.presetKey === 'findMeetingTime'));
  assert.equal(salesFocusEntries(card, NOW.getTime())[0]?.category, 'confirm');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Hvilken dag og tid passer bedre/);
  assert.doesNotMatch(sent[0].text, /torsdag 6\. mars/i);
});

test('the void hook gets the cancel and asks Google to notify the client', async () => {
  const client = seed('meeting');
  const calls = [];
  await mail(client, 'Får ikke til møtet, kan vi ta det en annen gang?', {
    voidMeeting: async (card, opts) => {
      calls.push(opts);
      return { ok: true, client: sales.voidSalesMeetingTime(card.id, { note: opts.note }), error: '' };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].notifyClient, true);
});

test('cancel phrasings that name the booked time or day are cancels, not confirmations', async () => {
  for (const text of [
    'Jeg kan ikke torsdag kl 10, beklager',
    'Kan dessverre ikke delta på møtet torsdag',
    'Klarer ikke å møte likevel',
    'Jeg er syk, kan vi utsette?',
    'Det passer ikke likevel',
    "I can't make the meeting on Thursday",
  ]) {
    const client = seed('meeting');
    const { card, sent } = await mail(client, text);
    assert.equal(card.agreedTime, false, text);
    assert.equal(sent.length, 1, text);
  }
});

test('a different day without a time voids the meeting and offers that day', async () => {
  const client = seed('meeting');
  const { card, sent, write } = await mail(client, 'Tirsdag passer bedre for meg.');
  assert.equal(write.kind, 'sales_propose');
  assert.equal(card.agreedTime, false);
  assert.match(sent[0].text, /tirsdag/i);
  assert.ok(write.slots.every((iso) => iso.startsWith('2031-03-11') || iso.startsWith('2031-03-04')));
});

test('answering the offered times with a day books the one slot offered that day', async () => {
  const client = seed('meeting');
  const first = await mail(client, 'Jeg kan dessverre ikke komme på møtet likevel.');
  const slots = first.write.slots;
  assert.ok(slots.length >= 1);
  const weekday = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', timeZone: 'Europe/Oslo' }).format(new Date(slots[0]));
  const { card, write } = await mail(client, `${weekday[0].toUpperCase()}${weekday.slice(1)} passer fint!`, {
    mailAt: new Date(NOW.getTime() + 3600000).toISOString(),
    now: new Date(NOW.getTime() + 3600000),
  });
  assert.equal(write.kind, 'sales_book');
  assert.equal(card.meetingAt, slots[0]);
  assert.equal(card.agreedTime, true);
});

test('a time that is busy for the rep is not booked; other times that day are offered', async () => {
  const client = seed('meeting');
  const { card, sent, write } = await mail(client, 'Kan vi ta fredag 7. mars kl 13 i stedet?', {
    queryBusy: async () => ({ busy: [{ start: FRIDAY_13, end: '2031-03-07T13:00:00.000Z' }] }),
  });
  assert.equal(write.kind, 'sales_propose');
  assert.notEqual(card.meetingAt, FRIDAY_13);
  assert.match(sent[0].text, /opptatt/);
  assert.ok(!write.slots.includes(FRIDAY_13));
});

test('a weekend or night time is never booked', async () => {
  const client = seed('meeting');
  const { card, write } = await mail(client, 'Kan vi ta lørdag kl 10 i stedet?');
  assert.notEqual(write.kind, 'sales_book');
  assert.notEqual(card.meetingAt, '2031-03-08T09:00:00.000Z');
});

test('a time about something else never moves the meeting', async () => {
  const client = seed('meeting');
  const { card, sent } = await mail(client, 'Hei! Jeg sender bildene fredag kl 12.');
  assert.equal(card.meetingAt, BOOKED);
  assert.equal(sent.length, 0);
});

test('basic questions get an answer and keep the meeting', async () => {
  const client = seed('meeting');
  const price = await mail(client, 'Hva koster det egentlig?');
  assert.equal(price.sent.length, 1);
  assert.match(price.sent[0].text, /gratis og uforpliktende/);
  assert.match(price.sent[0].text, /torsdag 6\. mars 2031/);
  assert.equal(price.card.meetingAt, BOOKED);
  const what = await mail(client, 'Hei, hva gjelder dette?');
  assert.match(what.sent[0].text, /utkast til ny nettside/);
});

test('a contract or offer question in the meeting stage goes to a person', async () => {
  const client = seed('meeting');
  const { sent, write } = await mail(client, 'Når får vi kontrakten?');
  assert.equal(sent.length, 0);
  assert.equal(write.needsHuman, true);
  assert.equal(lastRow(client.id).reason, 'question:contract');
});

test('ring meg adds a call task and keeps the meeting', async () => {
  const client = seed('meeting');
  const { card, sent, write } = await mail(client, 'Kan du ringe meg i morgen?');
  assert.equal(write.kind, 'sales_call');
  assert.equal(card.meetingAt, BOOKED);
  assert.match(sent[0].text, /ringer jeg deg i morgen/);
});

test('not interested voids the meeting before the polite follow-up', async () => {
  const client = seed('meeting');
  const { card, sent, write } = await mail(client, 'Vi er ikke interessert likevel, takk.');
  assert.equal(write.kind, 'walk_away');
  assert.equal(card.agreedTime, false);
  assert.match(sent[0].text, /hva som gjorde at det ikke ble aktuelt/);
});

test('the AI can veto a booking but never start one', async () => {
  const vetoed = seed('meeting');
  const veto = await mail(vetoed, 'Kan vi ta fredag 7. mars kl 13 i stedet?', { decideAi: async () => ({ request: 'info', reply: '' }) });
  assert.equal(veto.card.meetingAt, BOOKED);
  assert.equal(veto.sent.length, 0);
  assert.equal(lastRow(vetoed.id).status, 'needs_human');

  const asked = seed('meeting');
  const alone = await mail(asked, 'Hei, hva gjelder dette?', { decideAi: async () => ({ request: 'cancel', reply: 'Helt i orden.' }) });
  assert.equal(alone.card.agreedTime, true);
  assert.equal(alone.sent.length, 0);
});

test('AI replies naming times we did not offer, prices or links are dropped for the plain answer', () => {
  const decided = mergeWriteDecision(
    { request: 'question' },
    { request: 'question', reply: 'Det koster 4990 kr, og vi kan ta det fredag kl 15.' },
    { allowedTimes: [BOOKED] },
  );
  assert.equal(decided.reply, '');
  const ok = mergeWriteDecision(
    { request: 'question' },
    { request: 'question', reply: 'Det er gratis og uforpliktende. Møtet står torsdag kl 10:00.' },
    { allowedTimes: [BOOKED] },
  );
  assert.match(ok.reply, /gratis/);
});

test('an address the AI found in the body never counts as the client writing', async () => {
  const client = seed('meeting');
  const matched = matchSalesClient(sales.getSalesClients(), { from: 'selger@asoldi.com', match: { email: client.contactEmail } });
  assert.equal(matched.via, 'hint');
  const { card, sent } = await mail(client, 'kunden vil flytte til torsdag kl 9', {
    from: 'selger@asoldi.com',
    categorize: async (input) => ({ ...categorizeEmailHeuristic(input), match: { email: client.contactEmail } }),
  });
  assert.equal(card.meetingAt, BOOKED);
  assert.equal(sent.length, 0);
});

test('an old mail is judged against the real clock: a passed time is never booked', async () => {
  const client = seed('meeting', { meetingAt: '2031-03-20T09:00:00.000Z' });
  const { card } = await mail(client, 'Kan vi ta tirsdag kl 14 i stedet?', {
    mailAt: '2031-02-21T08:00:00.000Z',
    now: NOW,
  });
  assert.notEqual(card.meetingAt, '2031-02-25T13:00:00.000Z');
  assert.ok(Date.parse(card.meetingAt || '2100-01-01') > NOW.getTime() || card.agreedTime === false);
});

test('live tick: only the newest mail per sender gets a reply and the card is read fresh', async () => {
  const client = seed('meeting');
  const sent = [];
  const messages = [
    { id: 'tick-old', mailbox: 'alexander@asoldi.com', from: client.contactEmail, subject: 'Re: møtet', text: 'Hva koster det?', mailAt: '2031-03-03T08:00:00.000Z' },
    { id: 'tick-new', mailbox: 'alexander@asoldi.com', from: client.contactEmail, subject: 'Re: møtet', text: 'Hvem er dere?', mailAt: '2031-03-03T08:05:00.000Z' },
  ];
  const result = await tickInboxBot({
    listMessages: async () => ({ skipped: false, messages }),
    clients: () => sales.getSalesClients(),
    sendEmail: async (payload) => { sent.push(payload); },
    queryBusy: async () => ({ busy: [] }),
  });
  assert.equal(result.processed, 2);
  const rows = listInboxItems({ salesClientId: client.id });
  assert.ok(rows.some((row) => row.messageId === 'tick-old' && row.status === 'skipped'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Asoldi er et norsk byrå/);
});

test('classifier table', () => {
  const client = seed('meeting');
  const cases = [
    ['Ok', 'confirm'],
    ['Takk, vi sees torsdag!', 'confirm'],
    ['Kan vi flytte til fredag 7. mars kl 13?', 'reschedule'],
    ['Kan ikke i morgen', 'cancel'],
    ['Jeg kan dessverre ikke komme på møtet', 'cancel'],
    ['Tirsdag passer bedre', 'reschedule_day'],
    ['Hva koster det?', 'question'],
    ['Hvem er dere?', 'question'],
    ['Ring meg', 'call'],
    ['Vet ikke helt ennå hvordan uka blir', 'not_now'],
    ['Ikke interessert akkurat nå, men ta kontakt over nyttår', 'not_now'],
    ['Vi dropper hele greia, ikke interessert', 'not_interested'],
    ['Har dere fått kontrakten?', 'contract'],
    ['Fredag er ikke aktuelt, men mandag 10. mars kl 12 passer.', 'reschedule'],
    ['Tirsdag passer ikke lenger. Ikke aktuelt med møte i morgen, ring meg heller.', 'call'],
    ['', 'empty'],
  ];
  for (const [text, request] of cases) {
    assert.equal(classifyInboxRequest(text, client, { now: NOW }).request, request, text);
  }
});

// ---- Regression tests for the review findings (scenarios, gate, parser-thread-ui, contract) ----

test('the booked day named with a reason it does not work cancels and asks for a new time', async () => {
  for (const text of [
    'Torsdag blir vanskelig.',
    'Jeg er på ferie på torsdag, beklager.',
    'Torsdag er ikke så bra for meg dessverre.',
    'Har dessverre fått et kundemøte som kolliderer på torsdag.',
    'Torsdag har jeg kurs hele dagen.',
    'Torsdag er dessverre fullbooket hos meg.',
    'Torsdag ble dessverre umulig for meg.',
    'Torsdag kl 10 kolliderer med et annet møte.',
    'Hei, jeg ser at torsdag ikke går likevel.',
  ]) {
    const client = seed('meeting');
    const { card, sent, write } = await mail(client, text);
    assert.equal(write.kind, 'sales_cancel', text);
    assert.equal(card.agreedTime, false, text);
    assert.equal(card.reminders.reminder24hAt || '', '', text);
    assert.equal(openTasks(card, 'findMeetingTime').length, 1, text);
    assert.match(sent[0].text, /Hvilken dag og tid passer bedre/, text);
  }
  // The AI now gets its say on these mails instead of a silent "confirm".
  let called = 0;
  await mail(seed('meeting'), 'Torsdag blir vanskelig.', { decideAi: async () => { called += 1; return { request: 'cancel' }; } });
  assert.equal(called, 1);
  // The booked day with no yes and no no is for a person, never logged as a confirmation.
  const vague = seed('meeting');
  const { sent } = await mail(vague, 'Ang. torsdag.');
  assert.equal(sent.length, 0);
  assert.equal(lastRow(vague.id).status, 'needs_human');
  assert.equal(lastRow(vague.id).reason, 'booked-day-unclear');
});

test('turning down every offered time never books one; other days are offered instead', async () => {
  for (const text of [
    'Ingen av de tidene passer, har dere noe neste uke?',
    'Ingen av disse passer dessverre. Mandag er helt fullt hos meg.',
    'Ingen av dem passer, onsdag er jeg bortreist og fredag er jeg på kurs.',
  ]) {
    const client = seed('meeting');
    const first = await mail(client, 'Jeg kan dessverre ikke komme på møtet likevel.');
    const offeredDays = new Set(first.write.slots.map(ymd));
    const { card, sent, write } = await mail(client, text, later(1));
    assert.notEqual(write.kind, 'sales_book', text);
    assert.equal(card.agreedTime, false, text);
    assert.ok(write.slots.length > 0, text);
    assert.ok(write.slots.every((iso) => !offeredDays.has(ymd(iso)) && ymd(iso) !== ymd(BOOKED)), text);
    assert.doesNotMatch(sent[0].text, /satt opp|flyttet/, text);
  }
});

test('a weekend day is never offered or booked: every offered time is Monday to Friday, 08 to 17', async () => {
  for (const text of ['Kan vi ta lørdag kl 11 i stedet?', 'Søndag passer bedre for meg', 'Kan vi ta det på lørdag i stedet?', 'Lørdag formiddag passer bedre for meg.']) {
    const client = seed('meeting');
    const { write, sent } = await mail(client, text);
    assert.notEqual(write.kind, 'sales_book', text);
    assert.ok(write.slots.length > 0, text);
    for (const iso of write.slots) assert.ok(withinMeetingHours(iso), `${text}: ${iso}`);
    assert.match(sent[0].text, /ikke møter i helgen/, text);
  }
  assert.deepEqual(pickFreeSlots({ ymd: '2031-03-08', now: NOW }), []);
});

test('a question that names the booked day or time is answered or flagged, never logged as a confirmation', async () => {
  for (const [text, answer] of [
    ['Er møtet fortsatt torsdag kl 10?', /står som avtalt torsdag 6\. mars 2031/],
    ['Hvordan blir jeg med på torsdag?', /kalenderinvitasjonen/],
    ['Hva koster det? Vi sees torsdag.', /gratis og uforpliktende/],
    ['Hvem er dere? Ser at vi har møte torsdag kl 10.', /norsk byrå/],
  ]) {
    const client = seed('meeting');
    const { card, sent } = await mail(client, text);
    assert.equal(sent.length, 1, text);
    assert.match(sent[0].text, answer, text);
    assert.equal(card.meetingAt, BOOKED, text);
  }
  const unknown = seed('meeting');
  const { sent } = await mail(unknown, 'Må jeg forberede noe til møtet på torsdag?');
  assert.equal(sent.length, 0);
  assert.equal(lastRow(unknown.id).status, 'needs_human');
});

test('"ta kontakt etter sommeren" voids the meeting and promises no day the client did not name', async () => {
  for (const [text, when, due] of [
    ['Ta kontakt etter sommeren.', /etter sommeren/, '2031-08-15'],
    ['Vi har ikke behov for dette nå, men ta gjerne kontakt over sommeren.', /etter sommeren/, '2031-08-15'],
    ['Ikke nå, kanskje til høsten.', /til høsten/, '2031-09-01'],
  ]) {
    const client = seed('meeting');
    const { card, sent, write } = await mail(client, text);
    assert.equal(write.kind, 'sales_call', text);
    assert.equal(card.agreedTime, false, text);
    assert.equal(card.reminders.reminder24hAt || '', '', text);
    assert.match(sent[0].text, when, text);
    assert.doesNotMatch(sent[0].text, /torsdag|ringer jeg deg/, text);
    assert.equal(ymd(openTasks(card, 'findMeetingTime')[0].dueAt), due, text);
  }
  const vague = seed('meeting');
  const { card, sent } = await mail(vague, 'Ikke aktuelt akkurat nå.');
  assert.match(sent[0].text, /tar vi kontakt litt senere/);
  assert.notEqual(ymd(openTasks(card, 'findMeetingTime')[0].dueAt), ymd(BOOKED));
});

test('"kan ikke kl 10, men kl 14 samme dag" books the booked day at the new clock', async () => {
  const client = seed('meeting');
  const { card, write, sent } = await mail(client, 'Jeg kan ikke kl 10, men kl 14 samme dag går fint');
  assert.equal(write.kind, 'sales_book');
  assert.equal(card.meetingAt, '2031-03-06T13:00:00.000Z');
  assert.equal(card.agreedTime, true);
  assert.match(sent[0].text, /torsdag 6\. mars 2031 kl\. 14:00/);
});

test('"kan ikke i morgen" about another day while the meeting stands goes to a person, never asks for a new time', async () => {
  for (const [text, at] of [['Kan ikke i morgen', NOW], ['Kan ikke i dag', new Date('2031-03-05T08:15:00.000Z')]]) {
    const client = seed('meeting');
    const { card, sent } = await mail(client, text, { now: at, mailAt: at.toISOString() });
    assert.equal(sent.length, 0, text);
    assert.equal(card.meetingAt, BOOKED, text);
    assert.equal(card.agreedTime, true, text);
    assert.equal(lastRow(client.id).status, 'needs_human', text);
    assert.equal(lastRow(client.id).reason, 'cancel-other-day', text);
  }
});

test("common can't-come phrasings cancel the meeting, a plain no thanks walks away, and a long cue-less mail about the meeting is for a person", () => {
  const client = seed('meeting');
  for (const text of [
    'Jeg glemte at jeg har legetime da, så det går ikke.',
    'Torsdag går dessverre ikke for meg.',
    'Torsdag funker ikke.',
    'Jeg er bortreist på torsdag.',
    'Hei, på torsdag har jeg ikke tid dessverre',
    'Torsdag er jeg opptatt.',
    "Thursday doesn't work for me.",
  ]) {
    const out = classifyInboxRequest(text, client, { now: NOW });
    assert.equal(out.request, 'cancel', text);
    assert.equal(out.cancel, true, text);
  }
  assert.equal(classifyInboxRequest('Nei takk, vi har nettopp fått ny nettside.', client, { now: NOW }).request, 'not_interested');
  assert.equal(classifyInboxRequest('Vi har snakket sammen internt om møtet og om hvordan vi vil legge opp det hele videre.', client, { now: NOW }).request, 'other');
});

test('the reply goes to the address the client wrote from, with Reply-To the bot mailbox and our own subject', async () => {
  const client = seed('meeting', { websiteEmail: 'post-reply@intent-test.no' });
  const { sent } = await mail(client, 'Hva koster det?', { from: 'post-reply@intent-test.no' });
  assert.equal(sent[0].to, 'post-reply@intent-test.no');
  assert.equal(sent[0].replyTo, 'alexander@asoldi.com');
  assert.equal(sent[0].subject, 'Re: Online møte med Asoldi');
  // No contact address on the card: the cancel still reaches the sender instead of voiding in silence.
  const bare = seed('meeting', { contactEmail: '', websiteEmail: 'post-bare@intent-test.no' });
  const cancelled = await mail(bare, 'Jeg kan dessverre ikke komme på møtet likevel.', { from: 'post-bare@intent-test.no' });
  assert.equal(cancelled.card.agreedTime, false);
  assert.equal(cancelled.sent[0].to, 'post-bare@intent-test.no');
  assert.equal(lastRow(bare.id).status, 'applied');
});

test('a second no after an offer never re-offers the cancelled meeting day', async () => {
  const client = seed('meeting');
  await mail(client, 'Jeg kan ikke torsdag, beklager.');
  const { write, sent } = await mail(client, 'Onsdag passer ikke heller.', later(1));
  assert.ok(write.slots.length > 0);
  assert.ok(write.slots.every((iso) => ymd(iso) !== ymd(BOOKED) && ymd(iso) !== '2031-03-05'));
  assert.doesNotMatch(sent[0].text, /torsdag 6\. mars/);
});

test('"Ja takk" to an offer with nothing booked goes to a person, never a silent confirmation', async () => {
  for (const text of ['Ja, takk', 'Ja takk, det høres bra ut']) {
    const client = seed('meeting');
    await mail(client, 'Jeg kan dessverre ikke komme på møtet likevel.');
    const { sent, card } = await mail(client, text, later(1));
    assert.equal(sent.length, 0, text);
    assert.equal(card.agreedTime, false, text);
    assert.equal(lastRow(client.id).status, 'needs_human', text);
    assert.equal(lastRow(client.id).reason, 'yes-to-offer', text);
  }
});

test('booking the new time closes the open Ny møtetid task', async () => {
  for (const text of ['Fredag passer fint', 'Kan vi ta tirsdag 11. mars kl 14?']) {
    const client = seed('meeting');
    const first = await mail(client, 'Jeg kan dessverre ikke komme på møtet likevel.');
    assert.equal(openTasks(first.card, 'findMeetingTime').length, 1);
    const { card, write } = await mail(client, text, later(1));
    assert.equal(write.kind, 'sales_book', text);
    assert.equal(openTasks(card, 'findMeetingTime').length, 0, text);
  }
});

test('a question next to a reschedule is answered in the same mail, or flagged when the rep confirmation went out', async () => {
  const client = seed('meeting');
  const { sent, write } = await mail(client, 'Hva koster det? Og kan vi ta fredag kl 13 i stedet?');
  assert.equal(write.kind, 'sales_book');
  assert.match(sent[0].text, /flyttet møtet til fredag 7\. mars 2031 kl\. 13:00/);
  assert.match(sent[0].text, /gratis og uforpliktende/);
  assert.doesNotMatch(sent[0].text, /Møtet står som avtalt/);
  const viaRep = seed('meeting');
  const hooked = await mail(viaRep, 'Hva koster det? Og kan vi ta fredag kl 13 i stedet?', {
    moveMeeting: async (card) => ({ ok: true, client: card, confirmationSent: true, error: '' }),
  });
  assert.equal(hooked.sent.length, 0);
  assert.equal(lastRow(viaRep.id).status, 'needs_human');
  assert.equal(lastRow(viaRep.id).reason, 'question-with-booking');
});

test('plain confirmations with emoji or "det stemmer" are confirmations, not for a person', async () => {
  for (const text of ['Ok 👍', 'Ja det går fint!', 'Supert, det passer.', 'Takk, det stemmer. Sees!']) {
    const client = seed('meeting');
    const { sent, card } = await mail(client, text);
    assert.equal(sent.length, 0, text);
    assert.equal(card.meetingAt, BOOKED, text);
    assert.equal(lastRow(client.id).status, 'logged', text);
  }
});

test('"Hva med fredag ettermiddag?" offers Friday afternoon, "neste uke en gang" offers next week', async () => {
  const friday = await mail(seed('meeting'), 'Hva med fredag ettermiddag?');
  assert.equal(friday.write.kind, 'sales_propose');
  assert.ok(friday.write.slots.length > 0);
  assert.ok(friday.write.slots.every((iso) => ymd(iso) === '2031-03-07' && Date.parse(iso) >= Date.parse('2031-03-07T12:00:00.000Z')));
  const week = await mail(seed('meeting'), 'Kan vi ta det neste uke en gang?');
  assert.equal(week.write.kind, 'sales_propose');
  assert.ok(week.write.slots.length > 0);
  assert.ok(week.write.slots.every((iso) => ymd(iso) >= '2031-03-10' && ymd(iso) <= '2031-03-14'));
});

test('a "kan/får/klarer ikke" about something else never cancels; with the AI configured but down, a cancel goes to a person', async () => {
  const client = seed('meeting');
  for (const text of [
    'Hei, jeg kan ikke åpne lenken til møtet, kan du sende den på nytt?',
    'Vi får ikke logget inn på portalen.',
    'Jeg klarer ikke å finne logoen i høy oppløsning, men sender den jeg har.',
    'Jeg rekker ikke å sende bildene før møtet, er det greit?',
    'Kan ikke love noe, men vi ser frem til å se utkastet.',
    'Nettsiden vi har i dag passer ikke lenger til det vi driver med.',
    'Jeg kan ikke se invitasjonen i kalenderen min.',
    'Hei! Jeg kommer ikke på passordet til Google-kontoen, trenger jeg det for møtet?',
  ]) {
    const out = classifyInboxRequest(text, client, { now: NOW });
    assert.equal(out.cancel, false, text);
    assert.notEqual(out.request, 'cancel', text);
  }
  for (const decideAi of [async () => { throw new Error('timeout'); }, async () => ({ request: '', reply: '' })]) {
    const down = seed('meeting');
    const { card, sent } = await mail(down, 'Jeg kan dessverre ikke komme på møtet.', { decideAi });
    assert.equal(card.agreedTime, true);
    assert.equal(card.meetingAt, BOOKED);
    assert.equal(sent.length, 0);
    assert.equal(lastRow(down.id).reason, 'ai-unavailable');
  }
});

test('a time after "takk" about something else never books or moves the meeting', async () => {
  const client = seed('meeting');
  for (const text of [
    'Takk, jeg har lagt det i kalenderen. Tannlegen min er mandag kl 14 forresten.',
    'Takk! Regnskapsføreren vår er her fredag kl 13.',
    'Takk for sist! Ola Hansen. Treffes best fredag kl 9',
    'Takk for sist!\nOla Hansen\nTreffes best fredag kl 9',
    'Supert, takk. Min kollega Kari blir med, hun er ledig etter fredag kl 12.',
  ]) {
    assert.notEqual(classifyInboxRequest(text, client, { now: NOW }).request, 'reschedule', text);
  }
  const { card, sent } = await mail(client, 'Takk! Regnskapsføreren vår er her fredag kl 13.');
  assert.equal(card.meetingAt, BOOKED);
  assert.equal(sent.length, 0);
});

test('model replies that claim a booking, mix days, quote kroner or link a bare domain are dropped; the subject is always ours', async () => {
  for (const reply of [
    'Helt i orden! Jeg har booket deg inn mandag 10. mars, vi sender invitasjon.',
    'Møtet står fredag kl 10:00, vi sees da.',
    'Vi kan ta det klokka 14 på fredag i stedet, det går fint.',
    'Nettsiden koster 1500 kroner i måneden.',
    'Bli med via www.asoldi-mote.no/join så ses vi.',
    'Møtet er avlyst. Ha en fin dag videre!',
  ]) {
    assert.equal(replyIsSafe(reply, { allowedTimes: [BOOKED] }), false, reply);
  }
  assert.equal(replyIsSafe('Det er gratis og uforpliktende. Møtet står torsdag kl 10:00.', { allowedTimes: [BOOKED] }), true);
  const client = seed('meeting');
  const { sent } = await mail(client, 'Jeg kan dessverre ikke komme på torsdag.', {
    decideAi: async () => ({
      request: 'cancel',
      reply: 'Helt i orden! Jeg har booket deg inn mandag 10. mars, vi sender invitasjon.',
      subject: 'Bekreftet: møtet er flyttet til fredag kl 13:00 – se www.asoldi-booking.no',
    }),
  });
  assert.equal(sent[0].subject, 'Re: Online møte med Asoldi');
  assert.doesNotMatch(sent[0].text, /booket/);
});

test('the AI can never turn a contract question or another day into an automatic answer', () => {
  const contract = mergeWriteDecision(
    { request: 'contract', reason: 'question:contract' },
    { request: 'question', reply: 'Det er ingen bindingstid, du kan si opp når du vil.' },
  );
  assert.equal(contract.needsHuman, true);
  const otherDay = mergeWriteDecision(
    { request: 'unclear', reason: 'day-differs-from-booked' },
    { request: 'info', reply: 'Supert, vi sees på fredag!', subject: 'Vi sees fredag' },
  );
  assert.equal(otherDay.needsHuman, true);
  assert.equal(otherDay.subject, undefined);
});

test('a failed void sends nothing and adds no task; a card that leaves the meeting stage during the AI wait gets nothing', async () => {
  for (const text of ['Jeg kan dessverre ikke komme på møtet.', 'Tirsdag passer bedre for meg.', 'Ring meg heller, jeg kan ikke komme på torsdag.', 'Vi er ikke interessert.']) {
    const client = seed('meeting');
    const before = sales.getSalesClientById(client.id).nextActions.length;
    const { card, sent } = await mail(client, text, { voidMeeting: async () => ({ ok: false, client: null, error: 'not-meeting-stage' }) });
    assert.equal(sent.length, 0, text);
    assert.equal(card.agreedTime, true, text);
    assert.equal(card.nextActions.length, before, text);
    assert.equal(lastRow(client.id).status, 'needs_human', text);
    assert.match(lastRow(client.id).reason, /^void-failed:not-meeting-stage/, text);
  }
  const raced = seed('meeting');
  let voids = 0;
  const { sent } = await mail(raced, 'Jeg kan dessverre ikke komme på møtet.', {
    decideAi: async () => {
      sales.updateSalesClient(raced.id, { progression: { meetingHeld: true } });
      return { request: 'cancel' };
    },
    voidMeeting: async () => { voids += 1; return { ok: true }; },
  });
  assert.equal(sent.length, 0);
  assert.equal(voids, 0);
  assert.equal(lastRow(raced.id).reason, 'stage:offer');
});

test('an old mail never voids or moves the meeting, and backfill never acts on a meeting booked after the mail', async () => {
  const client = seed('meeting');
  const old = new Date(NOW.getTime() - 2 * 3600000);
  const { card, sent } = await mail(client, 'Jeg kan dessverre ikke komme på møtet.', { mailAt: old.toISOString(), now: NOW, realNow: NOW });
  assert.equal(card.agreedTime, true);
  assert.equal(sent.length, 0);
  assert.equal(lastRow(client.id).reason, 'stale-mail');

  const moved = seed('meeting');
  sales.updateSalesClient(moved.id, { meetingAt: '2031-03-11T12:00:00.000Z', agreedTime: true });
  const backfillSent = [];
  const out = await backfillInboxReplies({
    apply: true,
    now: NOW,
    clients: [sales.getSalesClientById(moved.id)],
    items: [],
    listImap: async () => ({
      skipped: false,
      messages: [{ id: 'bf-stale-1', mailbox: 'alexander@asoldi.com', from: moved.contactEmail, subject: 'Re: møtet', text: 'Jeg kan dessverre ikke komme på møtet.', mailAt: '2031-03-02T08:00:00.000Z' }],
    }),
    listSent: async () => [],
    categorize: categorizeEmailHeuristic,
    sendEmail: async (payload) => { backfillSent.push(payload); },
    queryBusy: async () => ({ busy: [] }),
  });
  assert.equal(out.results[0].reason, 'stale-mail');
  assert.equal(backfillSent.length, 0);
  assert.equal(sales.getSalesClientById(moved.id).meetingAt, '2031-03-11T12:00:00.000Z');
  assert.equal(sales.getSalesClientById(moved.id).agreedTime, true);
});

async function tickWith(messages) {
  const sent = [];
  const result = await tickInboxBot({
    listMessages: async () => ({ skipped: false, messages: messages.map((row) => ({ mailbox: 'alexander@asoldi.com', subject: 'Re: Online møte', ...row })) }),
    clients: () => sales.getSalesClients(),
    sendEmail: async (payload) => { sent.push(payload); },
    queryBusy: async () => ({ busy: [] }),
  });
  return { result, sent };
}

test('a newer "torsdag passer likevel" in the same batch keeps the meeting and flags the older cancel for a person', async () => {
  const client = seed('meeting');
  const { sent } = await tickWith([
    { id: 'retract-a', from: client.contactEmail, text: 'Jeg kan dessverre ikke komme på torsdag.', mailAt: '2031-03-03T07:00:00.000Z' },
    { id: 'retract-b', from: client.contactEmail, text: 'Glem forrige mail, torsdag passer likevel. Vi sees!', mailAt: '2031-03-03T07:05:00.000Z' },
  ]);
  const card = sales.getSalesClientById(client.id);
  assert.equal(card.meetingAt, BOOKED);
  assert.equal(card.agreedTime, true);
  assert.equal(sent.length, 0);
  const older = listInboxItems({ salesClientId: client.id }).find((row) => row.messageId === 'retract-a');
  assert.equal(older.status, 'needs_human');
});

test('a newer side note never drops an older reschedule request in the same batch', async () => {
  const client = seed('meeting');
  const { sent } = await tickWith([
    { id: 'side-a', from: client.contactEmail, text: 'Jeg kan dessverre ikke komme på torsdag. Kan vi ta fredag 7. mars kl 13 i stedet?', mailAt: '2031-03-03T07:00:00.000Z' },
    { id: 'side-b', from: client.contactEmail, text: 'Forresten, vår adresse er Storgata 1, 0150 Oslo.', mailAt: '2031-03-03T07:02:00.000Z' },
  ]);
  assert.equal(sales.getSalesClientById(client.id).meetingAt, FRIDAY_13);
  assert.equal(sent.length, 1);
});

test('an address on two cards is never acted on; a person sees it', async () => {
  const shared = 'delt@intent-test.no';
  const first = seed('signature', { contactEmail: shared });
  const second = seed('meeting', { contactEmail: shared });
  const matched = matchSalesClient(sales.getSalesClients(), { from: shared });
  assert.equal(matched.via, 'ambiguous');
  assert.equal(matched.client.id, first.id);
  const { sent } = await mail(second, 'Kan vi ta fredag 7. mars kl 13 i stedet?', { from: shared });
  assert.equal(sent.length, 0);
  assert.equal(sales.getSalesClientById(second.id).meetingAt, BOOKED);
  assert.equal(lastRow(first.id).reason, 'ambiguous-sender');
  assert.equal(lastRow(first.id).status, 'needs_human');
});

test('no assigned sales rep: a booking goes to a person', async () => {
  const client = seed('meeting', { ownerId: '' });
  const { card, sent } = await mail(client, 'Kan vi ta fredag 7. mars kl 13 i stedet?');
  assert.equal(card.meetingAt, BOOKED);
  assert.equal(sent.length, 0);
  assert.equal(lastRow(client.id).reason, 'no-assigned-rep');
});

test('a reply that fails after the void is flagged for a person, never lost', async () => {
  const client = seed('meeting');
  const { card, write } = await mail(client, 'Jeg kan dessverre ikke komme på møtet torsdag.', {
    sendEmail: async () => { throw new Error('SMTP 421'); },
  });
  assert.equal(card.agreedTime, false);
  assert.equal(write.needsHuman, true);
  const row = lastRow(client.id);
  assert.equal(row.status, 'needs_human');
  assert.equal(row.reason, 'reply-failed');
  assert.match(row.summary, /SMTP 421/);
  assert.equal(row.offeredSlots.length, 0);
  assert.ok(presentInboxForClient(client.id).needsHuman >= 1);
});

test('client files from an address that is not the card own are never filed on the card', async () => {
  const client = seed('meeting');
  const { result } = await mail(client, 'Her er logoen vår.', {
    from: 'faktura@annet-firma.no',
    attachments: [{ filename: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('png-bytes') }],
    categorize: async (input) => ({ ...(await categorizeEmailHeuristic(input)), kind: 'client_elements', match: { businessName: client.businessName } }),
  });
  assert.equal(result.kind, 'client_elements');
  assert.equal(result.salesClientId, '');
  assert.equal(listInboxItems({ salesClientId: client.id }).some((row) => row.kind === 'client_elements'), false);
});

test('mail from another address than the card own is logged for a person, with its own label', async () => {
  const client = seed('meeting');
  const { sent, card } = await mail(client, 'Jeg kan ikke torsdag, kan vi ta fredag kl 13 i stedet?', {
    from: 'kari.privat@gmail.com',
    categorize: async (input) => ({ ...(await categorizeEmailHeuristic(input)), match: { email: client.contactEmail } }),
  });
  assert.equal(sent.length, 0);
  assert.equal(card.meetingAt, BOOKED);
  assert.equal(lastRow(client.id).status, 'needs_human');
  assert.equal(lastRow(client.id).reason, 'other-address');
  const { tsImport } = await import('tsx/esm/api');
  const panel = await tsImport('../app/pages/Admin/sections/InboxBotPanel.tsx', import.meta.url);
  assert.equal(panel.inboxActivityLabel({ status: 'needs_human', reason: 'other-address' }), 'Trenger svar fra selger — kunden skrev fra en annen adresse');
});

test('backfill re-checks "already handled" right before each mail, so a mail the live tick answered is not answered twice', async () => {
  const client = seed('meeting');
  const message = { id: 'bf-race-1', mailbox: 'alexander@asoldi.com', from: client.contactEmail, subject: 'Re: møtet', text: 'Hva koster det egentlig?', mailAt: NOW.toISOString() };
  const sent = [];
  const out = await backfillInboxReplies({
    apply: true,
    now: NOW,
    clients: [client],
    items: [],
    listImap: async () => ({ skipped: false, messages: [message] }),
    // The live tick answers the mail while backfill is still listing.
    listSent: async () => {
      await ingestInboxMessage(message, { now: NOW, categorize: categorizeEmailHeuristic, sendEmail: async (payload) => { sent.push(payload); }, queryBusy: async () => ({ busy: [] }) });
      return [];
    },
    categorize: categorizeEmailHeuristic,
    sendEmail: async (payload) => { sent.push(payload); },
    queryBusy: async () => ({ busy: [] }),
  });
  assert.equal(out.results[0].reason, 'already-ingested');
  assert.equal(sent.length, 1);
});

test('a reply written one line per thought books the time on its own line', async () => {
  const client = seed('meeting');
  const { card, write } = await mail(client, 'Hei\nTorsdag passer ikke\nFredag kl 13 går fint\nMvh Kari');
  assert.equal(write.kind, 'sales_book');
  assert.equal(card.meetingAt, FRIDAY_13);
});

test('a forwarded mail with no words of the client own still reaches the Kundedata facts filer', async () => {
  const client = seed('meeting');
  const calls = [];
  await mail(client, '-------- Videresendt melding --------\nFra: Regnskap AS <post@regnskap.no>\nDato: 1. mars 2031\nEmne: Info til nettsiden\n\nHei Kari, her er info: Org.nr 987 654 321, adresse Storgata 1, 0155 Oslo. Åpningstider man-fre 09-17.', {
    subject: 'VS: Info til nettsiden',
    interpretNote: async (args) => { calls.push(typeof args === 'string' ? args : JSON.stringify(args)); return { facts: {} }; },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Org\.nr 987 654 321/);
});

/** A tiny PDF that is not our contract (a menu). */
const MENU_PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

async function contractPdfFor(card) {
  return buildContractPdf({ client: sales.getSalesClientById(card.id), tierId: 'tier-1-standard', date: new Date('2031-02-20') });
}

test('a signed contract that is not the first PDF in the mail is still filed as a contract', async () => {
  const client = seed('meeting');
  const { result } = await mail(client, 'Her er signert kontrakt og menyen.', {
    attachments: [
      { filename: 'meny.pdf', mimeType: 'application/pdf', buffer: MENU_PDF },
      { filename: 'Asoldi-kontrakt-Tier-1.pdf', mimeType: 'application/pdf', buffer: await contractPdfFor(client) },
    ],
  });
  assert.equal(result.kind, 'signed_contract');
  assert.equal(listInboxItems({ salesClientId: client.id, kind: 'signed_contract' }).length, 1);
});

test('a contract mail from Venter signering or Solgt keeps the client words for a person; a bare "her er kontrakten" is only logged', async () => {
  const pdf = (buffer) => [{ filename: 'Asoldi-kontrakt-Tier-1.pdf', mimeType: 'application/pdf', buffer }];
  const signature = seed('signature');
  const asked = await mail(signature, 'Her er kontrakten signert. Når starter vi?', { attachments: pdf(await contractPdfFor(signature)) });
  assert.equal(asked.sent.length, 0);
  const row = listInboxItems({ salesClientId: signature.id }).find((item) => item.messageId.endsWith(':write'));
  assert.equal(row.status, 'needs_human');
  assert.equal(row.reason, 'stage:signature');
  assert.match(row.text, /Når starter vi/);

  const won = seed('won');
  const bare = await mail(won, 'Her er kontrakten.', { attachments: pdf(await contractPdfFor(won)) });
  assert.equal(bare.sent.length, 0);
  const quiet = listInboxItems({ salesClientId: won.id }).find((item) => item.messageId.endsWith(':write'));
  assert.equal(quiet.status, 'logged');
});

// ---- Regression tests for the recheck's NEW PROBLEMS ----

const THU = '2031-03-06';
const THU_AT = (hour, minute = 0) => new Date(Date.parse(`${THU}T00:00:00.000Z`) + ((hour - 1) * 60 + minute) * 60000).toISOString();

test('a soft-wrapped mail whose line break moves the clock goes to a person, never books the wrong hour', async () => {
  for (const text of [
    'Hei! Beklager, men det passer ikke for meg å møtes på torsdag\nkl 10 likevel. Kan vi ta fredag kl 13?\n\nMvh Kari',
    'Dessverre kan jeg ikke komme på torsdag\nkl 10. Fredag kl 13 passer bedre.',
    'Kan vi flytte møtet fra torsdag\nkl 10 til fredag kl 13?',
    'Jeg kan ikke torsdag\nkl 10. Fredag passer bedre.',
  ]) {
    const client = seed('meeting');
    assert.equal(classifyInboxRequest(text, client, { now: NOW }).reason, 'time-unclear', text);
    const { card, sent } = await mail(client, text);
    assert.equal(sent.length, 0, text);
    assert.equal(card.meetingAt, BOOKED, text);
    assert.equal(card.agreedTime, true, text);
    assert.equal(lastRow(client.id).status, 'needs_human', text);
    assert.equal(lastRow(client.id).reason, 'time-unclear', text);
  }
  // An AI that reads it as a reschedule still leaves it to a person, under the same reason.
  const withAi = seed('meeting');
  const { card } = await mail(withAi, 'Hei! Beklager, men det passer ikke for meg å møtes på torsdag\nkl 10 likevel. Kan vi ta fredag kl 13?', {
    decideAi: async () => ({ request: 'reschedule', reply: '' }),
  });
  assert.equal(card.meetingAt, BOOKED);
  assert.equal(lastRow(withAi.id).reason, 'time-unclear');
  // The same words on one line, and one thought per capitalised line, still book the time the client asked for.
  for (const text of [
    'Hei! Beklager, men det passer ikke for meg å møtes på torsdag kl 10 likevel. Kan vi ta fredag kl 13?',
    'Hei Alexander. Jeg rekker dessverre ikke møtet på torsdag kl 10,\nmen fredag kl 14 går fint for meg.',
    'Hei\nTorsdag passer ikke\nFredag kl 13 går fint\nMvh Kari',
  ]) {
    const out = classifyInboxRequest(text, seed('meeting'), { now: NOW });
    assert.equal(out.request, 'reschedule', text);
    assert.equal(ymd(out.dueAt), '2031-03-07', text);
  }
});

test('a new clock on the booked day books that day at the new clock, never voids the meeting', async () => {
  const THU930 = new Date('2031-03-06T08:30:00.000Z');
  for (const [text, at, when] of [
    ['Jeg kan ikke torsdag kl 10. Kan vi ta torsdag kl 14 i stedet?', THU_AT(14), NOW],
    ['Hei, jeg rekker ikke kl 10, kan vi ta kl 11 i dag?', THU_AT(11), THU930],
    ['Kan vi flytte møtet til kl 13 samme dag?', THU_AT(13), NOW],
    ['Torsdag kl 10 passer dårlig. Kan vi ta kl 14 samme dag?', THU_AT(14), NOW],
    ['Kan vi ta torsdag kl 14 i stedet?', THU_AT(14), NOW],
    ['Passer det at vi tar det kl 11 på torsdag i stedet?', THU_AT(11), NOW],
    ['Hei!\nTorsdag går fint\nMen kan vi starte kl 10.30 i stedet?\nHilsen Hilde', THU_AT(10, 30), NOW],
    ['Torsdag kl 10 går ikke, men kl 14 passer', THU_AT(14), NOW],
  ]) {
    const client = seed('meeting');
    const out = classifyInboxRequest(text, client, { now: when });
    assert.equal(out.bookedNamed, false, text);
    const { card, write, sent } = await mail(client, text, { now: when, mailAt: when.toISOString() });
    assert.equal(write.kind, 'sales_book', text);
    assert.equal(card.meetingAt, at, text);
    assert.equal(card.agreedTime, true, text);
    assert.equal(openTasks(card, 'findMeetingTime').length, 0, text);
    assert.match(sent[0].text, /flyttet møtet til torsdag 6\. mars 2031/, text);
    assert.doesNotMatch(sent[0].text, /Hvilken dag og tid/, text);
  }
});

test('a new clock on the booked day is checked against the rep calendar, but never against the meeting it replaces', async () => {
  // Online meetings block 60 minutes: 10:30 overlaps only the booked 10:00 meeting itself.
  const own = seed('meeting', { meetingMode: 'online' });
  const ownBusy = async () => ({ busy: [{ start: BOOKED, end: THU_AT(11) }] });
  const moved = await mail(own, 'Kan vi starte kl 10.30 i stedet?', { queryBusy: ownBusy });
  assert.equal(moved.write.kind, 'sales_book');
  assert.equal(moved.card.meetingAt, THU_AT(10, 30));
  // A real meeting at 14:00 the same day: nothing is booked on top, and the 10:00 meeting still stands for a person.
  const busy = seed('meeting');
  const taken = await mail(busy, 'Kan vi ta torsdag kl 14 i stedet?', { queryBusy: async () => ({ busy: [{ start: THU_AT(14), end: THU_AT(15) }] }) });
  assert.equal(taken.sent.length, 0);
  assert.equal(taken.card.meetingAt, BOOKED);
  assert.equal(taken.card.agreedTime, true);
  assert.equal(lastRow(busy.id).status, 'needs_human');
  assert.equal(lastRow(busy.id).reason, 'time-unavailable');
  // A different clock named as a plain yes is not a confirmation of the 10:00 meeting, and not a move either.
  const unsure = seed('meeting');
  const said = await mail(unsure, 'Torsdag kl 14 passer fint.');
  assert.equal(said.sent.length, 0);
  assert.equal(said.card.meetingAt, BOOKED);
  assert.equal(lastRow(unsure.id).reason, 'time-unclear');
});

test('sick or busy on another day while the booked day is named with a yes keeps the meeting', async () => {
  for (const text of ['Jeg er syk i dag, men torsdag skal gå fint.', 'Kan ikke i morgen, men torsdag går fint.']) {
    const client = seed('meeting');
    assert.equal(classifyInboxRequest(text, client, { now: NOW }).request, 'confirm', text);
    const { card, sent } = await mail(client, text);
    assert.equal(sent.length, 0, text);
    assert.equal(card.agreedTime, true, text);
    assert.equal(card.meetingAt, BOOKED, text);
  }
  // The booked day itself in the can't-come words still cancels.
  for (const text of ['Jeg er syk, så torsdag blir vanskelig.', 'Jeg er syk og får ikke deltatt på torsdag.']) {
    assert.equal(classifyInboxRequest(text, seed('meeting'), { now: NOW }).request, 'cancel', text);
  }
});

test('after an offer, a named day with a part of the day never books an offered time outside it', async () => {
  const client = seed('meeting');
  const first = await mail(client, 'Jeg får dessverre ikke til torsdag.');
  assert.ok(first.write.slots.some((iso) => ymd(iso) === '2031-03-05'));
  const { card, write, sent } = await mail(client, 'Onsdag passer, men helst etter lunsj', later(2));
  assert.equal(write.kind, 'sales_propose');
  assert.equal(card.agreedTime, false);
  assert.ok(write.slots.length > 0);
  assert.ok(write.slots.every((iso) => ymd(iso) === '2031-03-05' && Date.parse(iso) >= Date.parse('2031-03-05T11:00:00.000Z')));
  assert.doesNotMatch(sent[0].text, /satt opp|flyttet/);
  // "Neste uke passer" is a week, not the Monday we offered.
  const week = seed('meeting');
  const offered = await mail(week, 'Jeg får dessverre ikke til torsdag.');
  assert.ok(offered.write.slots.some((iso) => ymd(iso) === '2031-03-10'));
  const answer = await mail(week, 'Neste uke passer bra.', later(2));
  assert.notEqual(answer.write.kind, 'sales_book');
  assert.equal(answer.card.agreedTime, false);
});

test('"utsette en uke" offers days around a week after the booked meeting, never before it', async () => {
  const client = seed('meeting');
  const { card, write, sent } = await mail(client, 'Kan vi utsette møtet en uke?');
  assert.equal(write.kind, 'sales_propose');
  assert.equal(card.agreedTime, false);
  assert.ok(write.slots.length > 0);
  assert.ok(write.slots.every((iso) => ymd(iso) >= '2031-03-13' && ymd(iso) <= '2031-03-17'), write.slots.join(','));
  assert.match(sent[0].text, /torsdag 13\. mars/);
});

test('a cancel about budget or need closes politely; it never asks which day suits', async () => {
  const client = seed('meeting');
  const text = 'Må dessverre avlyse. Vi har ikke budsjett til ny nettside i år.';
  assert.equal(classifyInboxRequest(text, client, { now: NOW }).request, 'not_interested');
  const { card, write, sent } = await mail(client, text);
  assert.equal(write.kind, 'walk_away_final');
  assert.equal(card.agreedTime, false);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /Hvilken dag|Passer noe av dette|hva som gjorde/);
  assert.equal(openTasks(card, 'findMeetingTime').length, 1);
  // A plain cancel without such a reason still asks for a new time.
  assert.equal(classifyInboxRequest('Må dessverre avlyse, har fått budsjettmøte torsdag.', client, { now: NOW }).request, 'cancel');
});

test('turning down the offer with a day or a time of their own gets that day or books that time', async () => {
  const monday = seed('meeting');
  await mail(monday, 'Jeg kan dessverre ikke komme på møtet likevel.');
  const asked = await mail(monday, 'Beklager, passer ikke noen av dem. Har dere noe på mandag ettermiddag?', later(1));
  assert.equal(asked.write.kind, 'sales_propose');
  assert.ok(asked.write.slots.length > 0);
  assert.ok(asked.write.slots.every((iso) => ymd(iso) === '2031-03-10' && Date.parse(iso) >= Date.parse('2031-03-10T11:00:00.000Z')));
  const thursday = seed('meeting');
  const first = await mail(thursday, 'Jeg kan dessverre ikke komme på møtet likevel.');
  const booked = await mail(thursday, 'Ingen av tidene passer. Torsdag neste uke kl 14?', later(1));
  assert.equal(booked.write.kind, 'sales_book');
  assert.equal(booked.card.meetingAt, '2031-03-13T13:00:00.000Z');
  assert.ok(!first.write.slots.includes('2031-03-13T13:00:00.000Z'));
});

test('a question about the meeting link needs the link: without one on the card a person answers', async () => {
  for (const text of [
    'Kan du sende meg lenken på nytt? Finner den ikke.',
    'Hei, jeg kan ikke åpne lenken til møtet, kan du sende den på nytt?',
    'Hvor finner jeg lenken? Finner den ikke i innboksen.',
  ]) {
    const client = seed('meeting');
    const { sent, card } = await mail(client, text);
    assert.equal(sent.length, 0, text);
    assert.equal(card.meetingAt, BOOKED, text);
    assert.equal(lastRow(client.id).status, 'needs_human', text);
    assert.equal(lastRow(client.id).reason, 'no-meet-link', text);
  }
  const linked = seed('meeting', { calendar: { meetLink: 'https://meet.google.com/abc-defg-hij' } });
  const { sent } = await mail(linked, 'Kan du sende meg lenken på nytt? Finner den ikke.');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /https:\/\/meet\.google\.com\/abc-defg-hij/);
  // Another platform is the rep's call.
  const teams = seed('meeting', { calendar: { meetLink: 'https://meet.google.com/abc-defg-hij' } });
  const asked = await mail(teams, 'Torsdag kl 10 er fint, men kan vi gjøre det på Teams?');
  assert.equal(asked.sent.length, 0);
  assert.equal(lastRow(teams.id).status, 'needs_human');
});

test('a move that lands but whose calendar or confirmation step failed is flagged for a rep', async () => {
  const client = seed('meeting');
  const { card, sent, write } = await mail(client, 'Kan vi ta fredag 7. mars kl 13 i stedet?', {
    moveMeeting: async (card, dueAt, opts) => ({ ...(await defaultMoveMeeting(card, dueAt, opts)), warning: 'calendar sync failed' }),
  });
  assert.equal(write.kind, 'sales_book');
  assert.equal(card.meetingAt, FRIDAY_13);
  assert.equal(sent.length, 1);
  assert.equal(write.needsHuman, true);
  assert.equal(lastRow(client.id).status, 'needs_human');
  assert.equal(lastRow(client.id).reason, 'move-warning:calendar sync failed');
  assert.match(lastRow(client.id).summary, /sjekk at kalenderen/);
});

test('English reschedules, "vi snakkes" and past-tense "passet bedre" are read like their Norwegian twins', async () => {
  const english = seed('meeting');
  const moved = await mail(english, "Sorry, I can't make it on Thursday. Could we do Friday at 2pm instead?");
  assert.equal(moved.write.kind, 'sales_book');
  assert.equal(moved.card.meetingAt, '2031-03-07T13:00:00.000Z');
  assert.equal(lastRow(english.id).status, 'applied');
  assert.equal(lastRow(english.id).reason, '');
  const talk = seed('meeting');
  const said = await mail(talk, 'Takk for info. Vi snakkes torsdag');
  assert.equal(said.sent.length, 0);
  assert.equal(lastRow(talk.id).status, 'logged');
  assert.equal(said.card.meetingAt, BOOKED);
  const past = seed('meeting');
  const tuesday = await mail(past, 'Neste uke tirsdag kl 9 hadde passet bedre');
  assert.equal(tuesday.write.kind, 'sales_book');
  assert.equal(tuesday.card.meetingAt, '2031-03-11T08:00:00.000Z');
});

test('the thread shim re-exports forwardedBodyText, and our own mail forwarded back is not filed as client facts', async () => {
  assert.equal(typeof threadShim.forwardedBodyText, 'function');
  const client = seed('meeting');
  const calls = [];
  await mail(client, '-------- Videresendt melding --------\nFra: Alexander Asoldi <alexander@asoldi.com>\nDato: 1. mars 2031\nEmne: Påminnelse\n\nHei Kari, møtet vårt er torsdag kl 10. Åpningstider man-fre 09-17.', {
    subject: 'VS: Påminnelse',
    interpretNote: async (args) => { calls.push(args); return { facts: {} }; },
  });
  assert.equal(calls.length, 0);
});

// ---- Regression tests for the second recheck (clock-only moves, unbookable same-day clocks, sick + yes, dates) ----

test('a new clock with no day named moves the meeting on the booked day, never cancels it', async () => {
  for (const [text, at] of [
    ['Kan vi flytte møtet til kl 11?', THU_AT(11)],
    ['Kan vi flytte fra 10 til 11?', THU_AT(11)],
    ['Kan vi flytte fra 10 til kl 11?', THU_AT(11)],
    ['Går det an å flytte til kl 13?', THU_AT(13)],
    ['Kan vi utsette møtet til kl 14?', THU_AT(14)],
    ['Jeg rekker ikke kl 10. Kl 12 da?', THU_AT(12)],
  ]) {
    const client = seed('meeting');
    const out = classifyInboxRequest(text, client, { now: NOW });
    assert.equal(out.request, 'reschedule', text);
    assert.equal(out.dueAt, at, text);
    const { card, write, sent } = await mail(client, text);
    assert.equal(write.kind, 'sales_book', text);
    assert.equal(card.meetingAt, at, text);
    assert.equal(card.agreedTime, true, text);
    assert.equal(openTasks(card, 'findMeetingTime').length, 0, text);
    assert.match(sent[0].text, /flyttet møtet til torsdag 6\. mars 2031/, text);
    assert.doesNotMatch(sent[0].text, /Hvilken dag og tid/, text);
  }
  const client = seed('meeting');
  // "fra 9 til 11" when the meeting is at 10, or a move to the time it already has: a person reads it.
  assert.equal(classifyInboxRequest('Kan vi flytte fra 9 til 11?', client, { now: NOW }).reason, 'time-unclear');
  assert.equal(classifyInboxRequest('Kan vi flytte møtet til kl 10?', client, { now: NOW }).reason, 'time-unclear');
  // A clock about something else, or with another day or week named, is not a same-day move.
  assert.equal(classifyInboxRequest('Jeg kan ikke komme på møtet, er på jobb til kl 17.', client, { now: NOW }).request, 'cancel');
  assert.notEqual(classifyInboxRequest('Kan vi flytte møtet til kl 14 neste uke?', client, { now: NOW }).dueAt, THU_AT(14));
  // On the meeting day, a clock that has already passed never voids the meeting.
  const thu930 = new Date('2031-03-06T08:30:00.000Z');
  const passed = classifyInboxRequest('Kan vi flytte møtet til kl 9?', client, { now: thu930 });
  assert.equal(passed.request, 'unclear');
  assert.equal(passed.reason, 'time-unavailable');
  assert.equal(passed.cancel, false);
});

test('a new clock on the booked day that cannot be booked keeps the meeting and goes to a person; a reply never starts in lower case', async () => {
  for (const [text, opts] of [
    ['Kan vi ta det kl 18 på torsdag? Jobber til 17.', {}],
    ['Går det an å ta det samme dag kl 07.30?', {}],
    ['Kan vi flytte møtet til kl 14?', { queryBusy: async () => ({ busy: [{ start: THU_AT(14), end: THU_AT(15) }] }) }],
  ]) {
    const client = seed('meeting');
    const { card, sent } = await mail(client, text, opts);
    assert.equal(sent.length, 0, text);
    assert.equal(card.agreedTime, true, text);
    assert.equal(card.meetingAt, BOOKED, text);
    assert.equal(openTasks(card, 'findMeetingTime').length, 0, text);
    assert.equal(lastRow(client.id).status, 'needs_human', text);
    assert.equal(lastRow(client.id).reason, 'time-unavailable', text);
    assert.match(lastRow(client.id).summary, /Møtet står fortsatt/, text);
  }
  // Another day that is busy still gets other times, and the reply that opens with the date starts with a capital.
  const friday = seed('meeting');
  const { sent } = await mail(friday, 'Kan vi ta fredag kl 14 i stedet?', { queryBusy: async () => ({ busy: [{ start: '2031-03-07T13:00:00.000Z', end: '2031-03-07T14:00:00.000Z' }] }) });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^Fredag 7\. mars 2031 kl\. 14:00 er dessverre opptatt/);
});

test('sick with no day named, while the booked day is named with a yes, keeps the meeting', async () => {
  for (const text of [
    'Jeg er syk, men torsdag skal gå fint.',
    'Ligger syk nå, men torsdag går nok fint.',
    'Er syk for tiden, men regner med at torsdag passer fint.',
  ]) {
    const client = seed('meeting');
    assert.equal(classifyInboxRequest(text, client, { now: NOW }).request, 'confirm', text);
    const { card, sent } = await mail(client, text);
    assert.equal(sent.length, 0, text);
    assert.equal(card.agreedTime, true, text);
    assert.equal(card.meetingAt, BOOKED, text);
    assert.equal(lastRow(client.id).status, 'logged', text);
  }
  // A can't-come clause about the meeting itself next to a yes to the booked day is neither: a person reads it.
  const mixed = seed('meeting');
  const { card, sent } = await mail(mixed, 'Jeg kan ikke komme, men torsdag går fint.');
  assert.equal(sent.length, 0);
  assert.equal(card.meetingAt, BOOKED);
  assert.equal(card.agreedTime, true);
  assert.equal(lastRow(mixed.id).reason, 'booked-day-unclear');
});

test('a written-out date that is not the booked date is a new time, never the booked meeting', async () => {
  for (const text of ['Vi må dessverre flytte til torsdag 13. mars kl 10.', 'Torsdag 13. mars kl 10 passer bedre for oss.']) {
    const client = seed('meeting');
    const out = classifyInboxRequest(text, client, { now: NOW });
    assert.equal(out.bookedNamed, false, text);
    const { card, write } = await mail(client, text);
    assert.equal(write.kind, 'sales_book', text);
    assert.equal(card.meetingAt, '2031-03-13T09:00:00.000Z', text);
    assert.equal(card.agreedTime, true, text);
  }
  const client = seed('meeting');
  assert.equal(classifyInboxRequest('Kan vi ta det 13/3 kl 10?', client, { now: NOW }).dueAt, '2031-03-13T09:00:00.000Z');
  // The booked date itself, or a weekday and clock alone, still names the booked meeting.
  assert.equal(classifyInboxRequest('Torsdag 6. mars kl 10 passer fint', client, { now: NOW }).request, 'confirm');
  assert.equal(classifyInboxRequest('Takk! Vi sees på torsdag kl 10.', client, { now: NOW }).request, 'confirm');
});

test("a can't-come cue is never logged as a confirmation, and definite weekdays (torsdagen) count as days", async () => {
  const client = seed('meeting');
  const text = 'Jeg rekker ikke denne torsdagen. Torsdagen etter kl 10 går fint.';
  assert.notEqual(classifyInboxRequest(text, client, { now: NOW }).request, 'confirm');
  const { card, sent } = await mail(client, text);
  assert.equal(sent.length, 0);
  assert.equal(card.meetingAt, BOOKED);
  assert.equal(card.agreedTime, true);
  assert.equal(lastRow(client.id).status, 'needs_human');
  for (const cancel of ['Jeg rekker ikke denne torsdagen.', 'Torsdagen passer ikke likevel.', 'Vi kommer ikke på torsdagen.']) {
    const out = classifyInboxRequest(cancel, client, { now: NOW });
    assert.equal(out.request, 'cancel', cancel);
    assert.equal(out.cancel, true, cancel);
  }
  // A definite weekday that is not the booked day is another day: the meeting is confirmed.
  assert.equal(classifyInboxRequest('Mandagen passer ikke, men torsdag går fint.', client, { now: NOW }).request, 'confirm');
});

test('"vi går ikke videre" walks away, and a facts mail that names a day, a clock or the meeting reaches a person', async () => {
  const client = seed('meeting');
  assert.equal(classifyInboxRequest('Beklager, jeg har ombestemt meg. Vi ønsker ikke å gå videre med dette.', client, { now: NOW }).request, 'not_interested');
  assert.ok(['not_interested', 'not_now'].includes(
    classifyInboxRequest('Hei, jeg har snakket med kompanjongen min og vi kommer ikke til å gå videre med dette nå.', client, { now: NOW }).request,
  ));
  assert.equal(classifyInboxRequest('Vi trekker oss.', client, { now: NOW }).request, 'not_interested');
  // A question or an "if" about it is not a no, and a change of mind about the day is a move.
  assert.notEqual(classifyInboxRequest('Hvis vi velger å ikke gå videre etter møtet, koster det noe?', client, { now: NOW }).request, 'not_interested');
  assert.notEqual(classifyInboxRequest('Jeg har ombestemt meg, kan vi ta fredag i stedet?', client, { now: NOW }).request, 'not_interested');
  const walked = seed('meeting');
  const no = await mail(walked, 'Beklager, jeg har ombestemt meg. Vi ønsker ikke å gå videre med dette.');
  assert.equal(no.write.kind, 'walk_away');
  assert.equal(no.card.agreedTime, false);
  assert.notEqual(lastRow(walked.id).reason, 'info-filed');
  const facts = seed('meeting');
  const info = await mail(facts, 'Hei\nFra: mandag til fredag har vi åpent 10-18.\nDato: vi kan møtes fredag kl 13');
  assert.equal(info.sent.length, 0);
  assert.equal(info.card.meetingAt, BOOKED);
  assert.equal(lastRow(facts.id).status, 'needs_human');
  assert.equal(lastRow(facts.id).reason, 'info-about-meeting');
});

test('the booked time is answered from the card, how long it lasts stays with a person, and "ses" / "gleder meg til" + the booked day confirm', async () => {
  for (const text of ['Hvilken dag var det vi hadde møte igjen?', 'Jeg fikk en sms om møtet, men står det kl 10 eller 11?', 'Hei, hvilket tidspunkt var det igjen?']) {
    const client = seed('meeting');
    const { card, sent } = await mail(client, text);
    assert.equal(sent.length, 1, text);
    assert.match(sent[0].text, /torsdag 6\. mars 2031 kl\. 10:00/, text);
    assert.doesNotMatch(sent[0].text, /minutt|varer/, text);
    assert.equal(card.meetingAt, BOOKED, text);
  }
  const length = seed('meeting');
  const asked = await mail(length, 'Hvor lenge varer møtet?');
  assert.equal(asked.sent.length, 0);
  assert.equal(lastRow(length.id).status, 'needs_human');
  for (const text of ['ok, ses på torsdag', 'Takk for hyggelig samtale i dag! Gleder meg til å se utkastet på torsdag.']) {
    const client = seed('meeting');
    assert.equal(classifyInboxRequest(text, client, { now: NOW }).request, 'confirm', text);
    const { sent } = await mail(client, text);
    assert.equal(sent.length, 0, text);
    assert.equal(lastRow(client.id).status, 'logged', text);
  }
});
