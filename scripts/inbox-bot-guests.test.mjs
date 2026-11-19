// A client asking the bot to add a person to the meeting ("Fint om du legger Kari på inviten. (CC)"):
// the request is read from the client's words, Cc is parsed, the colleague stays in the thread, and a guest
// can never cancel the client's meeting. The thread below is anonymised from a real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-inbox-guests-'));
delete process.env.DEEPSEEK_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const sales = await import('../data/sales.js');
const { ingestInboxMessage } = await import('../lib/inbox-bot/index.js');
const { categorizeEmailHeuristic } = await import('../lib/inbox-bot/categorize.js');
const { extractGuestRequest, isExcludedGuestAddress } = await import('../lib/inbox-bot/guests.js');
const { matchSalesClient } = await import('../lib/inbox-bot/match-client.js');
const { handleInboxWrite, replyCcList, needsHumanSummary } = await import('../lib/inbox-bot/write.js');
const { defaultAddMeetingGuests } = await import('../lib/inbox-bot/meeting.js');
const { listInboxItems } = await import('../lib/inbox-bot/store.js');
const { parseAddressList, parseRfc822 } = await import('../packages/suite/core/mail/mime.js');
const { presentGmailMessage } = await import('../lib/gmail-readonly.js');
const { buildMessage, normalizeCcList } = await import('../lib/email.js');
const { composeRawMessage } = await import('../lib/mailbox-copy.js');
const { osloCalendarYmd } = await import('../lib/website-due.js');

// Tuesday 17 Nov 2026 14:53 Oslo. The meeting is Wednesday 18 Nov 12:00 Oslo; Thursday 12:00 is 2026-11-19T11:00Z.
const NOW = new Date('2026-11-17T13:53:00.000Z');
const WEDNESDAY = '2026-11-18T11:00:00.000Z';
const THURSDAY = '2026-11-19T11:00:00.000Z';
const OLA = 'Ola Nordmann <ola@kunde.example>';
const KARI = { name: 'Kari Hansen', email: 'kari@partner.example' };
const BOT = { name: '', email: 'alexander@asoldi.com' };
const SIGNATURE = '\n\n--\nOla Nordmann\nDaglig leder';

let seq = 0;
// Every card gets its own contact, or the mail would match two cards.
let contact = 'ola@kunde.example';

function seed({ booked = true } = {}) {
  seq += 1;
  const id = `guest-${seq}`;
  contact = `ola${seq}@kunde.example`;
  sales.createSalesClient({ id, businessName: `Kunde ${seq} AS`, contactEmail: contact, product: 'asoldi' });
  sales.updateSalesClient(id, {
    ownerId: 'sales:rep-1',
    ...(booked ? { meetingAt: WEDNESDAY, agreedTime: true } : {}),
    reminders: { thankYouSentAt: '2026-11-13T10:00:00.000Z' },
  });
  if (booked) sales.rescheduleSalesReminders(id, NOW.getTime());
  return sales.getSalesClientById(id);
}

/** An incoming mail as the IMAP reader hands it over. */
function mail({ text, from = `Ola Nordmann <${contact}>`, cc = [KARI], toList = [BOT], subject = 'Re: Invitasjon: Asoldi · Online møte' }) {
  seq += 1;
  return {
    id: `guest-msg-${seq}`,
    mailbox: 'alexander@asoldi.com',
    from,
    to: 'alexander@asoldi.com',
    toList,
    cc,
    subject,
    text,
    mailAt: NOW.toISOString(),
    rfcMessageId: `<guest-${seq}@kunde.example>`,
  };
}

/** Run one mail through the whole bot with fakes for every side effect. */
async function run(message, { addResult, decideAi, clients } = {}) {
  const sent = [];
  const adds = [];
  const voids = [];
  const moves = [];
  const result = await ingestInboxMessage(message, {
    clients,
    categorize: categorizeEmailHeuristic,
    sendEmail: async (payload) => { sent.push(payload); },
    queryBusy: async () => ({ busy: [] }),
    addMeetingGuests: async (card, guests, options) => {
      adds.push({ guests, options });
      if (addResult) return addResult(card, guests);
      return { ok: true, client: card, added: guests.map((guest) => guest.email), already: [], rejected: [], invited: true, error: '', warning: '' };
    },
    voidMeeting: async (card, options) => { voids.push(options); return { ok: true, client: card }; },
    moveMeeting: async (card, dueAt, options) => {
      moves.push({ dueAt, options });
      return { ok: true, client: sales.updateSalesClient(card.id, { meetingAt: dueAt, agreedTime: true }), confirmationSent: false };
    },
    decideAi,
    now: NOW,
  });
  return { result, sent, adds, voids, moves };
}

const lastItem = (client) => listInboxItems({ salesClientId: client.id }).at(-1);

test('extractGuestRequest: an address in the text, with or without a name in front of it', () => {
  const ask = extractGuestRequest('Legg til per.olsen@firma.example på møtet', { from: OLA });
  assert.equal(ask.asked, true);
  assert.deepEqual(ask.guests, [{ email: 'per.olsen@firma.example', name: '' }]);
  assert.equal(ask.strippedText, '');
  const named = extractGuestRequest('Hva koster det? Inviter gjerne Per Olsen <per@firma.example> også', { from: OLA });
  assert.deepEqual(named.guests, [{ email: 'per@firma.example', name: 'Per Olsen' }]);
  assert.equal(named.strippedText, 'Hva koster det?');
});

test('extractGuestRequest: a first name resolves against the people on Cc, "(CC)" on its own line is dropped with the sentence', () => {
  const ask = extractGuestRequest('Hei, kan vi skyve til torsdag kl 12?\n\nFint om du legger Kari på inviten. (CC)', { from: OLA, cc: [KARI] });
  assert.equal(ask.asked, true);
  assert.deepEqual(ask.guests, [KARI]);
  assert.deepEqual(ask.unresolved, []);
  assert.equal(ask.strippedText, 'Hei, kan vi skyve til torsdag kl 12?');
  const second = extractGuestRequest('Torsdag kl 12? Ta gjerne med Kari', { from: OLA, cc: [KARI] });
  assert.deepEqual(second.guests, [KARI]);
  assert.equal(second.strippedText, 'Torsdag kl 12?');
});

test('extractGuestRequest: the generic "(CC)" / "på kopi" means everyone on Cc', () => {
  const ask = extractGuestRequest('Kan du legge til kollegaen min på inviten? (CC)', { from: OLA, cc: [KARI] });
  assert.deepEqual(ask.guests, [KARI]);
  const copy = extractGuestRequest('Ok, takk! Sett Kari på kopi', { from: OLA, cc: [KARI] });
  assert.deepEqual(copy.guests, [KARI]);
  assert.equal(copy.strippedText, 'Ok, takk!');
});

test('extractGuestRequest: English cues and "X blir med" / "kan X bli med"', () => {
  assert.deepEqual(extractGuestRequest('Please add Kari to the invite.', { from: OLA, cc: [KARI] }).guests, [KARI]);
  assert.deepEqual(extractGuestRequest('Could you loop in kari@partner.example as well?', { from: OLA }).guests, [{ email: 'kari@partner.example', name: '' }]);
  assert.deepEqual(extractGuestRequest('Kari blir også med', { from: OLA, cc: [KARI] }).guests, [KARI]);
  const mixed = extractGuestRequest('Torsdag kl 12 passer, og kan Kari Hansen også bli med?', { from: OLA, cc: [KARI] });
  assert.deepEqual(mixed.guests, [KARI]);
  assert.equal(mixed.strippedText, 'Torsdag kl 12 passer?');
});

test('extractGuestRequest: "send invitasjonen til Kari også" is a guest, not a request for the meeting link', () => {
  const ask = extractGuestRequest('Send invitasjonen til Kari også', { from: OLA, cc: [KARI] });
  assert.equal(ask.asked, true);
  assert.deepEqual(ask.guests, [KARI]);
  assert.equal(ask.strippedText, '');
});

test('extractGuestRequest: the sender, our staff, Fireflies and the card\'s own addresses are never guests', () => {
  const client = { contactEmail: 'ola@kunde.example', clientEmail: 'post@kunde.example' };
  const ask = extractGuestRequest('Legg meg og ola@kunde.example og post@kunde.example og fred@fireflies.ai og alexander@asoldi.com på inviten', { from: OLA, client });
  assert.deepEqual(ask.guests, []);
  assert.deepEqual(ask.unresolved, []);
  assert.equal(isExcludedGuestAddress('damian@asoldi.com'), true);
  assert.equal(isExcludedGuestAddress('notetaker@fireflies.ai'), true);
  assert.equal(isExcludedGuestAddress('kari@partner.example', { from: OLA }), false);
});

test('extractGuestRequest: a name that resolves to nothing is unresolved; ordinary sentences are left alone', () => {
  const ask = extractGuestRequest('Torsdag kl 12? Ta gjerne med Kari', { from: OLA });
  assert.equal(ask.asked, true);
  assert.deepEqual(ask.guests, []);
  assert.deepEqual(ask.unresolved, ['Kari']);
  for (const plain of ['Kan du legge til rette for et møte?', 'Ta med laptopen', 'Hva koster det?', 'Torsdag passer fint']) {
    const none = extractGuestRequest(plain, { from: OLA, cc: [KARI] });
    assert.equal(none.asked, false, plain);
    assert.equal(none.strippedText, plain);
  }
});

test('extractGuestRequest: a name from the quoted thread resolves when Cc is empty', () => {
  const ask = extractGuestRequest('Ta med Kari', { from: OLA, threadText: 'Ta med Kari\n\nFra: Ola\nCc: Kari Hansen <kari@partner.example>' });
  assert.deepEqual(ask.guests, [KARI]);
});

test('parseAddressList: quoted names with commas, encoded words, several headers', () => {
  assert.deepEqual(parseAddressList('"Hansen, Kari" <Kari@Partner.example>, =?UTF-8?Q?Bj=C3=B8rn_S?= <b@x.example>; plain@x.example'), [
    { name: 'Hansen, Kari', email: 'kari@partner.example' },
    { name: 'Bjørn S', email: 'b@x.example' },
    { name: '', email: 'plain@x.example' },
  ]);
  const parsed = parseRfc822('From: Ola <ola@kunde.example>\r\nTo: alexander@asoldi.com\r\nCc: kari@partner.example\r\nCc: "Per, Olsen" <per@firma.example>\r\nSubject: s\r\n\r\nhei');
  assert.deepEqual(parsed.cc.map((row) => row.email), ['kari@partner.example', 'per@firma.example']);
  assert.deepEqual(parsed.toList, [{ name: '', email: 'alexander@asoldi.com' }]);
});

test('the Gmail reader returns cc and toList too', () => {
  const presented = presentGmailMessage({
    id: 'g1',
    payload: { headers: [{ name: 'From', value: OLA }, { name: 'To', value: 'alexander@asoldi.com' }, { name: 'Cc', value: 'Kari Hansen <kari@partner.example>' }], mimeType: 'text/plain', body: { data: '' } },
  });
  assert.deepEqual(presented.cc, [KARI]);
  assert.deepEqual(presented.toList.map((row) => row.email), ['alexander@asoldi.com']);
});

test('sendEmail cc: SMTP envelope and headers carry it, an absent cc changes nothing', () => {
  assert.deepEqual(normalizeCcList(['a@x.example', 'b@x.example, a@x.example']), ['a@x.example', 'b@x.example']);
  assert.deepEqual(normalizeCcList(undefined), []);
  const plain = buildMessage({ to: 'ola@kunde.example', subject: 's', text: 't', bcc: false });
  assert.equal(plain.cc, undefined);
  const copied = buildMessage({ to: 'ola@kunde.example', cc: ['kari@partner.example'], subject: 's', text: 't', bcc: false });
  assert.deepEqual(copied.cc, ['kari@partner.example']);
  if (copied.envelope) assert.deepEqual(copied.envelope.to, ['ola@kunde.example', 'kari@partner.example']);
});

test('the filed copy of a reply keeps the Cc header', async () => {
  const raw = await composeRawMessage({ from: 'alexander@asoldi.com', to: 'ola@kunde.example', cc: ['kari@partner.example'], subject: 'Re: x', text: 'hei' });
  assert.match(String(raw), /^Cc: kari@partner\.example/m);
});

test('replyCcList: the client side of the thread, never our own people, max 5', () => {
  const message = { cc: [KARI, { name: '', email: 'damian@asoldi.com' }, { name: '', email: 'fred@fireflies.ai' }], toList: [BOT, { name: '', email: 'ola@kunde.example' }, { name: '', email: 'a@x.example' }, { name: '', email: 'b@x.example' }, { name: '', email: 'c@x.example' }, { name: '', email: 'd@x.example' }] };
  assert.deepEqual(replyCcList(message, { to: 'ola@kunde.example', via: 'email' }), ['kari@partner.example', 'a@x.example', 'b@x.example', 'c@x.example', 'd@x.example']);
  assert.deepEqual(replyCcList({ cc: [] }, { to: 'kari@partner.example', via: 'guest', client: { contactEmail: 'ola@kunde.example' } }), ['ola@kunde.example'], 'a guest\'s answer also goes to the card contact');
});

test('a stored guest writes as a guest of the card, after the own-address check', () => {
  const card = { id: 'g-card', contactEmail: 'ola@kunde.example', meetingGuests: [{ email: 'kari@partner.example', name: 'Kari Hansen' }] };
  const other = { id: 'g-other', contactEmail: 'per@annet.example' };
  assert.deepEqual(matchSalesClient([card, other], { from: 'Kari Hansen <Kari@Partner.example>', match: {} }), { client: card, via: 'guest' });
  assert.equal(matchSalesClient([card, other], { from: OLA, match: {} }).via, 'email');
  const twice = { id: 'g-twice', contactEmail: 'x@y.example', meetingGuests: [{ email: 'kari@partner.example' }] };
  assert.equal(matchSalesClient([card, twice], { from: 'kari@partner.example', match: {} }).via, 'ambiguous');
  const ownElsewhere = { id: 'g-own', contactEmail: 'kari@partner.example' };
  assert.equal(matchSalesClient([card, ownElsewhere], { from: 'kari@partner.example', match: {} }).via, 'email', 'her own card wins over being a guest');
});

test('the default guest hook says so when the data layer cannot add guests', async () => {
  if (typeof sales.addSalesMeetingGuests === 'function') return;
  const result = await defaultAddMeetingGuests({ id: 'x' }, [KARI]);
  assert.deepEqual([result.ok, result.error], [false, 'guests-unavailable']);
});

test('incident mail 1: Kari is added from the sentence, the rest is read on its own and the AI never sees the guest sentence', async () => {
  const client = seed();
  const seen = [];
  const { adds, sent, voids } = await run(
    mail({ text: `Hei, kan vi skyve til torsdag kl 12?\n\nFint om du legger Kari på inviten. (CC)${SIGNATURE}` }),
    { decideAi: async (payload) => { seen.push(payload.blob); return {}; } },
  );
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].guests, [KARI]);
  assert.match(adds[0].options.note, /^Bot: Kunden ba om å legge til Kari Hansen \(kari@partner\.example\)/);
  assert.equal(voids.length, 0, 'asking to move is no reason to void');
  for (const blob of seen) assert.doesNotMatch(blob, /legger Kari/);
  const item = lastItem(client);
  assert.deepEqual(item.guestsAdded, ['Kari Hansen']);
  assert.deepEqual(item.guestsRequested, ['kari@partner.example']);
  assert.equal(item.wordsDueAt, THURSDAY, 'the Thursday the client asked for is kept on the row');
  assert.match(item.summary, /Gjest lagt til: Kari Hansen\./);
  assert.ok(sent.every((payload) => !payload.to.includes('kari@')), 'Kari is never the recipient');
});

test('incident mail 1 books Thursday 12:00 and tells the client Kari is on the invitation', async () => {
  const client = seed();
  const { moves, sent, adds } = await run(mail({ text: `Hei, kan vi skyve til torsdag kl 12?\n\nFint om du legger Kari på inviten. (CC)${SIGNATURE}` }));
  assert.deepEqual(adds.map((row) => row.guests), [[KARI]]);
  assert.deepEqual(moves.map((row) => row.dueAt), [THURSDAY]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].cc, ['kari@partner.example'], 'Kari stays in the thread');
  assert.match(sent[0].text, /Jeg har også lagt til Kari Hansen \(kari@partner\.example\) på invitasjonen\./);
  assert.equal(osloCalendarYmd(sales.getSalesClientById(client.id).meetingAt), '2026-11-19');
});

test('incident mail 2 "Torsdag kl 12? Ta gjerne med Kari" with nothing booked adds Kari', async () => {
  const client = seed({ booked: false });
  const { adds, sent } = await run(mail({ text: `Torsdag kl 12? Ta gjerne med Kari${SIGNATURE}` }));
  assert.deepEqual(adds.map((row) => row.guests), [[KARI]]);
  const item = lastItem(client);
  assert.deepEqual(item.guestsAdded, ['Kari Hansen']);
  assert.equal(item.wordsDueAt, THURSDAY);
  assert.ok(sent.every((payload) => !/legg|ta gjerne med/i.test(payload.text)));
});

test('incident mail 2 books Thursday 12:00 for a voided card', async () => {
  seed({ booked: false });
  const { moves } = await run(mail({ text: 'Torsdag kl 12? Ta gjerne med Kari' }));
  assert.deepEqual(moves.map((row) => row.dueAt), [THURSDAY]);
});

// The real thread had a signature with a long title line and no "--": cutting the guest sentence
// must not glue it to the time, and the title line must not count as a sentence.
const LONG_SIGNATURE = '\n\nOla Nordmann\nHead of Finance & Accounting Manager | økonomisjef\n\nKunde Gruppen\n\nMobile: +47 400 00 000';

test('incident mail 2 with a long-title signature still books Thursday 12:00 and adds Kari', async () => {
  seed({ booked: false });
  const { moves, adds } = await run(mail({ text: `Torsdag kl 12? Ta gjerne med Kari${LONG_SIGNATURE}` }));
  assert.deepEqual(adds.map((row) => row.guests), [[KARI]]);
  assert.deepEqual(moves.map((row) => row.dueAt), [THURSDAY]);
});

test('incident mail 1 with a long-title signature books Thursday 12:00', async () => {
  seed();
  const { moves, adds } = await run(mail({ text: `Hei, kan vi skyve til torsdag kl 12?\n\nFint om du legger Kari på inviten. (CC)${LONG_SIGNATURE}` }));
  assert.deepEqual(adds.map((row) => row.guests), [[KARI]]);
  assert.deepEqual(moves.map((row) => row.dueAt), [THURSDAY]);
});

test('extractGuestRequest keeps the line break of a dropped guest sentence', () => {
  const ask = extractGuestRequest(`Torsdag kl 12? Ta gjerne med Kari${LONG_SIGNATURE}`, { from: OLA, cc: [KARI] });
  assert.match(ask.strippedText, /^Torsdag kl 12\?\n\nOla Nordmann\n/);
});

test('a guest-only mail with an address and a long-title signature gets the short thanks, not a person', async () => {
  const client = seed();
  const { sent, moves, voids, adds } = await run(mail({ text: `Kan du legge til kari@partner.example på møtet?${LONG_SIGNATURE}`, cc: [] }));
  assert.equal(adds.length, 1);
  assert.equal(moves.length + voids.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^Takk! Jeg har lagt til/);
  const item = lastItem(client);
  assert.deepEqual([item.kind, item.status], ['guest_add', 'applied']);
});

test('"Nei" left after the guest sentence is not taken for a signature', async () => {
  const client = seed();
  const { sent } = await run(mail({ text: 'Nei\n\nLegg Kari til på inviten' }));
  const item = lastItem(client);
  assert.notEqual(item.kind, 'guest_add', 'a bare "Nei" is an answer, not a greeting');
  assert.ok(sent.every((payload) => !/^Takk! Jeg har lagt til/.test(payload.text)));
});

test('a mail that only asks for a guest gets a short thanks that claims only what happened', async () => {
  const client = seed();
  const { sent, moves, voids } = await run(mail({ text: `Fint om du legger Kari på inviten. (CC)${SIGNATURE.replace('--\nOla Nordmann\nDaglig leder', 'Mvh Ola')}` }));
  assert.equal(moves.length + voids.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, contact);
  assert.deepEqual(sent[0].cc, ['kari@partner.example']);
  assert.match(sent[0].text, /^Takk! Jeg har lagt til Kari Hansen på møteinvitasjonen for .*onsdag/i);
  const item = lastItem(client);
  assert.deepEqual([item.kind, item.status], ['guest_add', 'applied']);
  assert.equal(item.replyText, sent[0].text);
});

test('guest-only with nothing booked: the guest gets the invitation once a time is set', async () => {
  seed({ booked: false });
  const { sent } = await run(mail({ text: 'Legg gjerne til Kari Hansen på møtet. Mvh Ola' }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^Takk! Kari Hansen får invitasjonen når vi har satt en tid\.$/);
});

test('guest-only where the hook could not send the invitation says so and flags a rep', async () => {
  const client = seed();
  const { sent } = await run(mail({ text: 'Legg Kari på inviten. Mvh Ola' }), {
    addResult: (card, guests) => ({ ok: true, client: card, added: guests.map((guest) => guest.email), already: [], rejected: [], invited: false, error: '', warning: 'kalenderen svarte ikke' }),
  });
  assert.doesNotMatch(sent[0].text, /på møteinvitasjonen for/);
  assert.match(sent[0].text, /så snart kalenderen er oppdatert/);
  const item = lastItem(client);
  assert.deepEqual([item.status, item.reason], ['needs_human', 'guest-add-failed:kalenderen svarte ikke']);
});

test('a guest who is already on the invitation is not added twice or announced as new', async () => {
  seed();
  const { sent } = await run(mail({ text: 'Legg Kari på inviten. Mvh Ola' }), {
    addResult: (card) => ({ ok: true, client: card, added: [], already: ['kari@partner.example'], rejected: [], invited: false, error: '', warning: '' }),
  });
  assert.match(sent[0].text, /^Takk! Kari Hansen står allerede på møteinvitasjonen for /);
});

test('an unknown name still lets the rest of the mail through, then flags the missing address', async () => {
  const client = seed();
  const { adds, sent } = await run(mail({ text: 'Hva koster det? Ta med Per Olsen.', cc: [] }));
  assert.equal(adds.length, 0, 'no address, nothing to add');
  const item = lastItem(client);
  assert.equal(item.status, 'needs_human');
  assert.equal(item.reason, 'guest-unknown-address:Per Olsen');
  assert.match(item.summary, /Per Olsen/);
  assert.match(needsHumanSummary('guest-unknown-address:Per Olsen'), /Per Olsen/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /gratis og uforpliktende/, 'the price question was still answered');
  assert.match(sent[0].text, /Jeg fant ikke e-postadressen til Per Olsen/);
});

test('a failing hook hands the whole mail to a person', async () => {
  const client = seed();
  const { sent, moves } = await run(mail({ text: 'Legg Kari på inviten. Kan vi ta fredag kl 13 i stedet?' }), {
    addResult: () => ({ ok: false, error: 'calendar-down' }),
  });
  assert.equal(sent.length + moves.length, 0);
  const item = lastItem(client);
  assert.deepEqual([item.status, item.reason], ['needs_human', 'guest-add-failed:calendar-down']);
});

test('a rejected guest (limit, invalid) is flagged after the mail is answered', async () => {
  const client = seed({ booked: false });
  await run(mail({ text: 'Legg Kari på inviten. Mvh Ola' }), {
    addResult: (card) => ({ ok: true, client: card, added: [], already: [], rejected: [{ email: 'kari@partner.example', reason: 'limit' }], invited: false, error: '', warning: '' }),
  });
  assert.equal(lastItem(client).reason, 'guest-add-failed:limit');
});

test('a booking and a guest in the same mail: the new invite goes to the guest too, and the reply says so', async () => {
  const client = seed();
  const { moves, adds, sent } = await run(mail({ text: 'Kan vi ta fredag kl 13 i stedet? Legg Kari på inviten.' }));
  assert.deepEqual(adds.map((row) => row.guests), [[KARI]], 'added first, so the move sends the invite to her');
  assert.deepEqual(moves.map((row) => row.dueAt), ['2026-11-20T12:00:00.000Z']);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].cc, ['kari@partner.example']);
  assert.match(sent[0].text, /Jeg har også lagt til Kari Hansen \(kari@partner\.example\) på invitasjonen\.$/);
  assert.equal(lastItem(client).kind, 'sales_book');
});

test('stage gate: past the meeting stage no guest is added, a person decides', async () => {
  const client = seed();
  sales.updateSalesClient(client.id, { progression: { ...(client.progression || {}), offerSent: true } });
  const staged = sales.getSalesClientById(client.id);
  const { adds, sent } = await run(mail({ text: 'Legg Kari på inviten. Mvh Ola' }), { clients: [staged] });
  assert.equal(adds.length + sent.length, 0);
  const item = lastItem(client);
  assert.equal(item.status, 'needs_human');
  assert.match(item.reason, /^stage:/);
});

test('guest sender: a question is answered to the guest with the card contact on Cc; a new time can be booked', async () => {
  const client = seed();
  const card = { ...sales.getSalesClientById(client.id), meetingGuests: [{ email: 'kari@partner.example', name: 'Kari Hansen' }] };
  const sent = [];
  const moves = [];
  const result = await handleInboxWrite({
    client: card,
    via: 'guest',
    message: mail({ from: 'Kari Hansen <kari@partner.example>', cc: [], toList: [BOT], text: 'Hva koster det?' }),
    sendEmail: async (payload) => { sent.push(payload); },
    queryBusy: async () => ({ busy: [] }),
    now: NOW,
    realNow: NOW,
  });
  assert.equal(result.wrote, true);
  assert.equal(sent[0].to, 'kari@partner.example');
  assert.deepEqual(sent[0].cc, [contact]);
  const booked = await handleInboxWrite({
    client: card,
    via: 'guest',
    message: mail({ from: 'Kari Hansen <kari@partner.example>', cc: [], text: 'Kan vi ta fredag kl 13 i stedet?' }),
    sendEmail: async (payload) => { sent.push(payload); },
    queryBusy: async () => ({ busy: [] }),
    moveMeeting: async (c, dueAt) => { moves.push(dueAt); return { ok: true, client: c, confirmationSent: false }; },
    now: NOW,
    realNow: NOW,
  });
  assert.equal(booked.wrote, true);
  assert.deepEqual(moves, ['2026-11-20T12:00:00.000Z']);
});

test('guest sender: cancel, no thanks and decline-all go to a person and never void', async () => {
  const client = seed();
  const card = { ...sales.getSalesClientById(client.id), meetingGuests: [{ email: 'kari@partner.example', name: 'Kari Hansen' }] };
  for (const text of ['Jeg kan dessverre ikke komme på møtet', 'Vi er ikke interessert', 'Vi trenger ikke møtet, kan dere avlyse?', 'Ingen av tidene passer', 'Tirsdag passer bedre']) {
    const sent = [];
    const voids = [];
    const result = await handleInboxWrite({
      client: card,
      via: 'guest',
      message: mail({ from: 'Kari Hansen <kari@partner.example>', cc: [], text }),
      sendEmail: async (payload) => { sent.push(payload); },
      voidMeeting: async (c, options) => { voids.push(options); return { ok: true, client: c }; },
      queryBusy: async () => ({ busy: [] }),
      now: NOW,
    });
    assert.deepEqual([result.reason, sent.length, voids.length], ['guest-cancel', 0, 0], text);
  }
  assert.equal(lastItem(client).reason, 'guest-cancel');
  assert.match(needsHumanSummary('guest-cancel'), /gjest/);
});

test('the real hook layer: with addSalesMeetingGuests the default hook stores the guest on the card', async () => {
  if (typeof sales.addSalesMeetingGuests !== 'function') return;
  const client = seed();
  const result = await defaultAddMeetingGuests(client, [KARI]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.added, ['kari@partner.example']);
});

test('sendEmail over Resend carries cc, and nothing changes without one', async () => {
  const { sendEmail } = await import('../lib/email.js');
  const realFetch = globalThis.fetch;
  const bodies = [];
  const saved = { key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM };
  process.env.RESEND_API_KEY = 're_fake_for_tests';
  process.env.RESEND_FROM = 'Asoldi <contact@asoldi.com>';
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'fake' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await sendEmail({ to: 'ola@kunde.example', cc: ['kari@partner.example'], subject: 's', text: 't', from: 'Alexander fra Asoldi <alexander@asoldi.com>' });
    await sendEmail({ to: 'ola@kunde.example', subject: 's', text: 't', from: 'Alexander fra Asoldi <alexander@asoldi.com>' });
  } finally {
    globalThis.fetch = realFetch;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key;
    if (saved.from === undefined) delete process.env.RESEND_FROM; else process.env.RESEND_FROM = saved.from;
  }
  assert.deepEqual(bodies[0].cc, ['kari@partner.example']);
  assert.equal('cc' in bodies[1], false);
});

test('extractGuestRequest: a name written in the client\'s own sentence is not polluted by the thread scan', () => {
  const full = 'Hei! Legg gjerne til Per Olsen <per@x.example> på møtet';
  const ask = extractGuestRequest(full, { from: OLA, threadText: full });
  assert.deepEqual(ask.guests, [{ email: 'per@x.example', name: 'Per Olsen' }]);
  assert.deepEqual(ask.unresolved, []);
  const second = 'Legg Per Olsen <per@x.example> til på møtet.';
  const other = extractGuestRequest(second, { from: OLA, threadText: second });
  assert.deepEqual(other.guests, [{ email: 'per@x.example', name: 'Per Olsen' }]);
  assert.deepEqual(other.unresolved, [], 'a trailing "til" is not a person');
});

test('extractGuestRequest: a cue verb with a non-person object is not a guest request', () => {
  for (const plain of ['Legg gjerne inn agenda i invitasjonen', 'Kan du legge til Teams-lenke i invitasjonen?', 'Legg til adressen i invitasjonen', 'Inkluder prisen i invitasjonen', 'Ta med dokumentene til møtet', 'Please include the agenda in the invite']) {
    const none = extractGuestRequest(plain, { from: OLA, cc: [KARI] });
    assert.equal(none.asked, false, plain);
    assert.equal(none.strippedText, plain);
  }
});

test('extractGuestRequest: "send invitasjonen til meg" and "legg meg til" are not guest requests', () => {
  for (const plain of ['Kan du sende invitasjonen til meg?', 'Legg meg til også']) {
    const none = extractGuestRequest(plain, { from: OLA, cc: [KARI] });
    assert.equal(none.asked, false, plain);
    assert.equal(none.strippedText, plain);
  }
});

test('a cancel or "no thanks" with a guest sentence is not swallowed as a guest-only mail', async () => {
  for (const text of ['Avlys møtet. Legg Kari på inviten.', 'Ikke aktuelt. Legg Kari på inviten.', 'Kan ikke. Legg Kari til.', 'Nei takk. Ta med Kari']) {
    const client = seed();
    const { result, sent, voids } = await run(mail({ text }));
    const item = lastItem(client);
    assert.notEqual(item.kind, 'guest_add', text);
    assert.ok(!(result.write?.reason === 'guest-added'), text);
    assert.ok(!sent.some((row) => /har lagt til/.test(row.text)), text);
    assert.ok(item.status === 'needs_human' || voids.length > 0 || item.intent !== 'guest', text);
  }
});
