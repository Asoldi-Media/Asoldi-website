import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardedBodyText, freshReplyText, inboxWriteBlob, stripReplyPrefixes } from '../packages/suite/core/mail/thread.js';
import { isAutomatedMail } from '../packages/suite/core/mail/automated.js';
import { ingestMessage } from '../packages/suite/core/inbox/pipeline.js';

// IMAP text arrives flattened to one line (parseRfc822 collapses all whitespace).
const flat = (text) => text.replace(/\s+/g, ' ').trim();
// No clock, date or weekday may survive: those are what the time parser would read.
const NO_TIME = /\d|mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag|i morgen/i;

const REMINDER = 'Hei Kari,\n\nVennlig påminnelse: møtet vårt starter i morgen. torsdag 5. nov kl 10:00.\nGoogle Meet: https://meet.google.com/abc-defg-hij\n\nAlexander';
const gtQuote = (body = REMINDER) => body.split('\n').map((line) => `> ${line}`).join('\n');

/** Top-posted replies: the same answer whether the text keeps its line breaks or not. */
function assertTopPosted(text, fresh) {
  assert.equal(freshReplyText(text), fresh, `multi-line: ${JSON.stringify(text)}`);
  assert.equal(freshReplyText(flat(text)), fresh, `one-line: ${JSON.stringify(flat(text))}`);
}

test('thread: probe rows E05, E06, E11 keep only the client words above the quote', () => {
  const e05 = 'Ok\n\nDen 04.11.2026 07:00, skrev Alexander:\nPåminnelse: møte torsdag 12. nov kl 10:00';
  const e06 = 'Passer fint\n\nFra: Alexander <alexander@asoldi.com>\nSendt: onsdag 4. november 2026 07:00\nTil: kari@kunde.no\nEmne: Påminnelse: Online møte med Asoldi i morgen\n\nPåminnelse: møte torsdag 31. okt kl 10:00';
  const e11 = 'Supert, det passer\n\n04.11.2026 kl. 07:00 skrev Alexander <alexander@asoldi.com>:\n\nVennlig påminnelse: møtet vårt starter i morgen. fredag 13. nov kl 10:00.';
  assertTopPosted(e05, 'Ok');
  assertTopPosted(e06, 'Passer fint');
  assertTopPosted(e11, 'Supert, det passer');
  for (const text of [e05, e06, e11]) {
    const blob = inboxWriteBlob({ subject: 'Re: Påminnelse: Online møte med Asoldi i morgen', text });
    assert.doesNotMatch(blob, NO_TIME, blob);
  }
});

test('thread: probe row E08 — a "Svar:" subject is our own subject and never reaches the blob', () => {
  const blob = inboxWriteBlob({ subject: 'Svar: Påminnelse: møte fredag kl 13', text: 'Ja' });
  assert.equal(blob.trim(), 'Ja');
  assert.doesNotMatch(blob, NO_TIME);
});

test('thread: root-cause section 1 — Outlook CRLF headers (nb + en), one-line Outlook, Thunderbird numeric', () => {
  const outlookNb = 'Passer fint\r\n\r\nFra: Alexander <alexander@asoldi.com>\r\nSendt: onsdag 4. november 2026 07:00\r\nTil: kari@kunde.no\r\nEmne: Påminnelse\r\n\r\nVennlig påminnelse: møtet vårt starter i morgen. torsdag 5. nov kl 10:00.';
  const outlookEn = 'Sounds good\r\n\r\nFrom: Alexander <alexander@asoldi.com>\r\nSent: Wednesday, November 4, 2026 7:00 AM\r\nTo: kari@kunde.no\r\nSubject: Påminnelse\r\n\r\nmøtet starter torsdag 12. nov kl 10:00.';
  const outlookOneLine = 'Passer fint Fra: Alexander <alexander@asoldi.com> Sendt: onsdag 4. november 2026 07:00';
  const thunderNb = 'Ok\n\nDen 04.11.2026 07:00, skrev Alexander:\n> torsdag 12. nov kl 10:00';
  assert.equal(freshReplyText(outlookNb), 'Passer fint');
  assert.equal(freshReplyText(outlookEn), 'Sounds good');
  assert.equal(freshReplyText(outlookOneLine), 'Passer fint');
  assert.equal(freshReplyText(thunderNb), 'Ok');
});

test('thread: multi-line Outlook headers, also with blank lines between the header lines', () => {
  assertTopPosted('OK\n\nFra: Alexander <a@asoldi.com>\n\nSendt: onsdag 4. november 2026 07:00\n\nTil: kari@kunde.no\n\nEmne: Møte\n\ntorsdag kl 10', 'OK');
  assertTopPosted('Fint\n\nFrom: Alexander <a@asoldi.com>\nSent: Wednesday, November 4, 2026 7:00 AM\nTo: kari@kunde.no\nSubject: Meeting\n\nThursday 10:00', 'Fint');
  assertTopPosted('Fint\n\n________________________________\nFra: Alexander <a@asoldi.com>\nSendt: onsdag 4. november 2026 07:00', 'Fint');
  assertTopPosted('Takk\n\n*Fra:* Alexander <a@asoldi.com>\n*Sendt:* onsdag 4. november 2026 07:00', 'Takk');
  assertTopPosted('Takk\n\nFrom: Alexander <a@asoldi.com>\nDate: Wed, 4 Nov 2026 07:00\nSubject: Møte', 'Takk');
});

test('thread: numeric and Norwegian date reply headers', () => {
  assertTopPosted('Ok\n\nDen 04.11.2026 07:00, skrev Alexander:\n> kl 10:00', 'Ok');
  assertTopPosted('Ok\n\n04.11.2026 kl. 07:00 skrev Alexander <alexander@asoldi.com>:\n> kl 10:00', 'Ok');
  assertTopPosted('Greit\n\ntir. 3. nov. 2026 kl. 10:12 skrev Alexander:\n> kl 10:00', 'Greit');
  assertTopPosted(`Ja\n\nons. 4. nov. 2026 kl. 07:00 skrev Alexander Asoldi <alexander@asoldi.com>:\n${gtQuote()}`, 'Ja');
  assertTopPosted('Ja\n\n4. nov. 2026 kl. 07:00 skrev Alexander Asoldi <alexander@asoldi.com>:\n\n> kl 10:00', 'Ja');
  assertTopPosted('Ja\n\nDen 4. nov. 2026 kl. 07.00 skrev Alexander:\n> kl 10:00', 'Ja');
  assertTopPosted('Ja\n\nAm 04.11.2026 um 07:00 schrieb Alexander:\n> kl 10:00', 'Ja');
});

test('thread: English "On … wrote:" headers, also wrapped over two lines', () => {
  assertTopPosted('Sounds good\n\nOn Wed, 4 Nov 2026 at 07:00, Alexander <alexander@asoldi.com> wrote:\n> Thursday 10:00', 'Sounds good');
  assertTopPosted('Sounds good\n\nOn Wed, 4 Nov 2026 at 07:00, Alexander Asoldi <\nalexander@asoldi.com> wrote:\n> Thursday 10:00', 'Sounds good');
  assertTopPosted('Sounds good\n\nOn Wed, 4 Nov 2026 at\n07:00, Alexander wrote:\n> Thursday 10:00', 'Sounds good');
  assertTopPosted('Sure\n\nOn Wed, Nov 4, 2026 at 7:00 AM Alexander Asoldi <alexander@asoldi.com> wrote:\n> x', 'Sure');
  assertTopPosted('Sure\n\nOn 11/4/26 7:00 AM, Alexander wrote:\n> x', 'Sure');
  assertTopPosted('Sure\n\nOn Wednesday, November 4, 2026, Alexander wrote:\n> x', 'Sure');
});

test('thread: original-message and forward separators', () => {
  assertTopPosted('Ja\n\n-----Original Message-----\nFrom: Alexander\nSent: Wednesday\nmøte torsdag kl 10', 'Ja');
  assertTopPosted('Ja\n\n-----Opprinnelig melding-----\nFra: Alexander\nmøte torsdag kl 10', 'Ja');
  assertTopPosted('Se under\n\n-------- Videresendt melding --------\nEmne: Påminnelse\nmøte torsdag kl 10', 'Se under');
  assertTopPosted('Se under\n\n---------- Forwarded message ---------\nFrom: Alexander\nmøte torsdag kl 10', 'Se under');
  assertTopPosted('Se under\n\nBegin forwarded message:\n\nFrom: Alexander\nmøte torsdag kl 10', 'Se under');
});

test('thread: device signatures and the "-- " separator end the fresh text', () => {
  assertTopPosted('Passer fint\n\nSendt fra min iPhone\n\nDen 04.11.2026 07:00, skrev Alexander:\n> kl 10:00', 'Passer fint');
  assertTopPosted('Sounds good\n\nSent from my iPhone', 'Sounds good');
  assertTopPosted('Ok\n\nHentet fra Outlook for Android\n________________________________\nFra: Alexander', 'Ok');
  assertTopPosted('Ok\n\nGet Outlook for iOS', 'Ok');
  assertTopPosted('Ok\n\nSendt fra min Samsung Galaxy-smarttelefon.', 'Ok');
  assert.equal(freshReplyText('Passer fint\n-- \nKari Nordmann\ntlf 412 34 567'), 'Passer fint');
  assert.equal(freshReplyText('Passer fint\n--\nKari Nordmann'), 'Passer fint');
  // A dash pair inside a sentence is not a signature separator.
  assert.equal(freshReplyText('Vi kan 10 -- 12\nhilsen Kari'), 'Vi kan 10 -- 12\nhilsen Kari');
  // "sendt fra min regnskapsfører" is the client's own sentence, not a device footer.
  assert.equal(freshReplyText('Logoen ble sendt fra min regnskapsfører i går'), 'Logoen ble sendt fra min regnskapsfører i går');
});

test('thread: bottom-posted replies return the text written below the quote (probe row E07)', () => {
  assert.equal(freshReplyText('> Påminnelse: møte torsdag 12. nov kl 10:00\n\nKan ikke, beklager'), 'Kan ikke, beklager');
  assert.equal(freshReplyText('On Wed, 4 Nov 2026 at 07:00, Alexander <alexander@asoldi.com> wrote:\n> Møtet er torsdag kl 10:00\n>\n> Alexander\n\nKan vi ta fredag kl 13 i stedet?\n\nSendt fra min iPhone'), 'Kan vi ta fredag kl 13 i stedet?');
  assert.equal(freshReplyText(`Den 04.11.2026 07:00, skrev Alexander:\n${gtQuote()}\n\nJeg rekker ikke møtet.\n-- \nKari`), 'Jeg rekker ikke møtet.');
  assert.equal(freshReplyText('\r\n> torsdag kl 10\r\n> Alexander\r\nOk, sees!'), 'Ok, sees!');
});

test('thread: a body that is only quote or forward reads as empty, never as the raw text', () => {
  assert.equal(freshReplyText('> Påminnelse: møte torsdag 12. nov kl 10:00'), '');
  assert.equal(freshReplyText(`Den 04.11.2026 07:00, skrev Alexander:\n${gtQuote()}`), '');
  assert.equal(freshReplyText(`Den 04.11.2026 07:00, skrev Alexander:\n${REMINDER}`), '');
  assert.equal(freshReplyText('Fra: Alexander <a@asoldi.com>\nSendt: onsdag 4. november 2026 07:00\nEmne: Påminnelse\n\ntorsdag kl 10'), '');
  assert.equal(freshReplyText('-------- Videresendt melding --------\nFra: Regnskap <r@x.no>\nDato: 4. nov. 2026\nHer er logoen'), '');
  assert.equal(freshReplyText('-----Original Message-----\nFrom: A\nSent: B'), '');
  assert.equal(freshReplyText('Sendt fra min iPhone\n\n> kl 10'), '');
  assert.equal(freshReplyText(''), '');
  assert.equal(freshReplyText(undefined), '');
  // One-line (IMAP) text cannot show where a leading quote ends, so it reads as empty.
  assert.equal(freshReplyText('> Påminnelse: møte torsdag 12. nov kl 10:00 Kan ikke, beklager'), '');
  assert.equal(freshReplyText('Fra: Regnskap <r@x.no> Sendt: onsdag 4. november 2026 07:00 Her er logoen'), '');
  assert.equal(inboxWriteBlob({ subject: 'Re: Påminnelse', text: '> torsdag kl 10' }).trim(), '');
});

test('thread: unquoted text is returned whole; dates and "wrote" in the client text are not quote headers', () => {
  assert.equal(freshReplyText('Kan vi ta fredag kl 13?'), 'Kan vi ta fredag kl 13?');
  assert.equal(freshReplyText('Kan vi ta 12.11.2026 kl 14:00 i stedet?'), 'Kan vi ta 12.11.2026 kl 14:00 i stedet?');
  assert.equal(freshReplyText('Based on what you wrote: Friday works'), 'Based on what you wrote: Friday works');
  assert.equal(freshReplyText('Jeg kan fra 10 til 12. Dato passer.'), 'Jeg kan fra 10 til 12. Dato passer.');
  assert.equal(freshReplyText('Vi har > 10 ansatte\nog trenger nettside'), 'Vi har > 10 ansatte\nog trenger nettside');
  assert.equal(freshReplyText('Torsdag passer. Vi har åpent man-fre 10-18. > Hei, her er Asoldi sin invitasjon'), 'Torsdag passer. Vi har åpent man-fre 10-18.');
  assert.equal(freshReplyText('Hei\r\nKan vi ta fredag?\r\n'), 'Hei\nKan vi ta fredag?');
});

test('thread: production one-line fixtures still cut before the quoted history', () => {
  const cancelToday = 'Blir mailene mine mottatt? Jeg kan ikke idag likevel Kari Founder Tel.+47 92 80 78 81 ons. 14. okt. 2026 kl. 15:47 skrev Kari <kari@example.no>: > Hei igjen';
  assert.equal(freshReplyText(cancelToday), 'Blir mailene mine mottatt? Jeg kan ikke idag likevel Kari Founder Tel.+47 92 80 78 81');
  const cancelTomorrow = 'Hei! Jeg har svart deg flere ganger at jeg må avlyse møtet i morgen. Mvh Marie 15. okt. 2026 kl. 12:00 skrev Alexander fra Asoldi <alexander@asoldi.com>: Påminnelse: Online møte';
  assert.equal(freshReplyText(cancelTomorrow), 'Hei! Jeg har svart deg flere ganger at jeg må avlyse møtet i morgen. Mvh Marie');
  const moved = 'Hei, Kan vi flytte møtet til onsdag neste uke istedet? Gjerne kl. 15. Med vennlig hilsen Ali ________________________________ Fra: Alexander (Google Kalender) <calendar-notification@google.com> Sendt: fredag 16. oktober 2026 13:59';
  assert.equal(freshReplyText(moved), 'Hei, Kan vi flytte møtet til onsdag neste uke istedet? Gjerne kl. 15. Med vennlig hilsen Ali');
});

test('review: "sendt fra min mobil" and "<date> skrev du" inside a client sentence never cut the reply', () => {
  const whole = [
    'Hei! Jeg kan ikke komme på torsdag. Bildene er sendt fra min mobil i en egen mail, og fredag kl 13 passer fint.',
    'Jeg svarer sent fra min telefon, beklager. Kan vi ta fredag kl 13?',
    'Hei, vi har møte 12.11.2026 kl. 14:00, skrev du i forrige mail: kan vi flytte til fredag kl 13?',
    'Hei, vi har møte 12.11.2026 kl. 14:00, skrev Alexander i forrige mail: kan vi flytte til fredag kl 13?',
    'Bildene er sendt fra min mobil i går.',
  ];
  for (const text of whole) {
    assert.equal(freshReplyText(text), text, text);
    const lined = text.replace(/\. /g, '.\n');
    assert.equal(freshReplyText(lined), lined, lined);
  }
  assert.equal(
    freshReplyText('Hei\nJeg kan ikke komme på torsdag. Bildene er sendt fra min mobil i en egen mail, og fredag kl 13 passer fint.\nMvh Kari'),
    'Hei\nJeg kan ikke komme på torsdag. Bildene er sendt fra min mobil i en egen mail, og fredag kl 13 passer fint.\nMvh Kari',
  );
  // A wrapped line that starts with the words is still the client's sentence.
  assert.equal(freshReplyText('Hei, bildene er\nsendt fra min mobil i en egen mail.\nFredag kl 13 passer.'), 'Hei, bildene er\nsendt fra min mobil i en egen mail.\nFredag kl 13 passer.');
});

test('review: real footers and attributions still cut (own line, end of text, or right before the quote)', () => {
  assertTopPosted('Kan vi ta fredag kl 13?\n\nSendt fra min iPhone', 'Kan vi ta fredag kl 13?');
  assertTopPosted('Ok\n\nGet Outlook for iOS<https://aka.ms/o0ukef>\n________________________________\nFra: Alexander', 'Ok');
  assertTopPosted('Ok\n\nSendt fra min Huawei-telefon', 'Ok');
  assertTopPosted('Ok\n\nSent from my iPhone 15 Pro Max', 'Ok');
  assert.equal(freshReplyText('Kan vi ta fredag kl 13? Sendt fra min iPhone'), 'Kan vi ta fredag kl 13?');
  // An HTML reply can leave the attribution on the client's line; it still cuts because the quote follows.
  assert.equal(freshReplyText('Torsdag passer fint  On Wed, 4 Nov 2026 at 07:00, Alexander <a@asoldi.com> wrote:\n> Påminnelse'), 'Torsdag passer fint');
  // A date in the client's own words is not swallowed into the attribution below it.
  for (const gap of ['\n', '\n\n', ' ']) {
    const text = `Vi kan ta 12.11.2026 kl 14:00 i stedet${gap}On Wed, 4 Nov 2026 at 07:00, Alexander wrote:\n> x`;
    assert.equal(freshReplyText(text), 'Vi kan ta 12.11.2026 kl 14:00 i stedet', JSON.stringify(text));
  }
});

test('forwardedBodyText: the forwarded body below the header block, never a plain reply quote', () => {
  const nb = '-------- Videresendt melding --------\nFra: Regnskap AS <post@regnskap.no>\nDato: 1. mars 2031\nEmne: Info til nettsiden\n\nHei Kari, her er info: Org.nr 987 654 321, adresse Storgata 1, 0155 Oslo.';
  assert.equal(freshReplyText(nb), '');
  assert.equal(forwardedBodyText(nb), 'Hei Kari, her er info: Org.nr 987 654 321, adresse Storgata 1, 0155 Oslo.');
  assert.match(forwardedBodyText(flat(nb)), /Hei Kari, her er info: Org\.nr 987 654 321/);
  assert.doesNotMatch(forwardedBodyText(flat(nb)), /post@regnskap|Dato/);
  const iphone = 'Sendt fra min iPhone\n\nStart på videresendt melding:\n\nFra: Regnskap <r@x.no>\nDato: 1. mars 2031 kl. 10:00:00 CET\nTil: Kari <k@x.no>\nEmne: Info\n\nHer er logoen og åpningstidene.';
  assert.equal(forwardedBodyText(iphone), 'Her er logoen og åpningstidene.');
  const outlook = '________________________________\nFra: Regnskap <r@x.no>\nSendt: fredag 1. mars 2031 10:00\nTil: Kari\nEmne: Info\n\nÅpent man-fre 9-17';
  assert.equal(forwardedBodyText(outlook), 'Åpent man-fre 9-17');
  const gmail = '---------- Forwarded message ---------\nFrom: Alexander <alexander@asoldi.com>\nDate: Wed, 4 Nov 2026 at 07:00\nSubject: Påminnelse\nTo: <k@x.no>\n\n\nPåminnelse: møte torsdag kl 10';
  assert.equal(forwardedBodyText(gmail), 'Påminnelse: møte torsdag kl 10');
  // Our own mail forwarded back is skipped when the caller names its sender.
  assert.equal(forwardedBodyText(gmail, { ignoreFrom: /@asoldi\.com/i }), '');
  assert.equal(forwardedBodyText(nb, { ignoreFrom: /@asoldi\.com/i }), 'Hei Kari, her er info: Org.nr 987 654 321, adresse Storgata 1, 0155 Oslo.');
  // Plain reply quotes and plain text are not forwards.
  assert.equal(forwardedBodyText('Ok\n\nDen 04.11.2026 07:00, skrev Alexander:\n> -------- Videresendt melding --------\n> Fra: X'), '');
  assert.equal(forwardedBodyText(`Den 04.11.2026 07:00, skrev Alexander:\n${gtQuote()}`), '');
  assert.equal(forwardedBodyText('> Påminnelse: møte torsdag 12. nov kl 10:00'), '');
  assert.equal(forwardedBodyText('Bare tekst uten forward'), '');
  assert.equal(forwardedBodyText(''), '');
  assert.equal(forwardedBodyText(undefined), '');
});

test('subject: reply/forward prefixes are stripped, and a reply subject stays out of the blob', () => {
  for (const subject of ['Re: Møte', 'SV: Møte', 'Svar: Møte', 'VS: Møte', 'Fwd: Møte', 'FW: Møte', 'Ang: Møte', 'AW: Møte', 'RE[2]: Møte', 'Re: SV: Re: Møte', '[EKSTERN] SV: Møte', 'Antw: Møte', 'WG: Møte']) {
    assert.equal(stripReplyPrefixes(subject), 'Møte', subject);
    assert.equal(inboxWriteBlob({ subject, text: 'Ja' }), ' Ja', subject);
  }
  assert.equal(stripReplyPrefixes('Regnskap og logo'), 'Regnskap og logo');
  assert.equal(stripReplyPrefixes('Angående nettsiden'), 'Angående nettsiden');
  assert.equal(stripReplyPrefixes('Svarte på tilbudet'), 'Svarte på tilbudet');
  assert.equal(inboxWriteBlob({ subject: 'Logo til nettsiden', text: 'Her er den' }), 'Logo til nettsiden Her er den');
  assert.equal(inboxWriteBlob({ subject: '[Viktig] Ny tid', text: 'Fredag?' }), 'Ny tid Fredag?');
  assert.equal(inboxWriteBlob({ text: 'Ja' }), ' Ja');
  assert.equal(inboxWriteBlob(), ' ');
});

test('callers: quote-only REQUEST is machine mail; the pipeline hands an empty fresh text to classify', async () => {
  assert.equal(isAutomatedMail({ from: 'kari@kunde.no', calendarMethod: 'REQUEST', text: '-------- Videresendt melding --------\nFra: Google Kalender' }), true);
  assert.equal(isAutomatedMail({ from: 'kari@kunde.no', calendarMethod: 'REQUEST', text: 'Passer dette?\n\n> invitasjon' }), false);
  const seen = [];
  const adapters = {
    isProcessed: () => false,
    markProcessed: () => {},
    classify: async (message, env) => { seen.push([env.fresh, message.text.length > 0]); return { kind: 'other' }; },
    fallback: async () => ({ kind: 'fallback' }),
  };
  await ingestMessage({ id: '1', mailbox: 'a@x.test', text: '> torsdag kl 10' }, adapters);
  await ingestMessage({ id: '2', mailbox: 'a@x.test', text: 'Fredag kl 13?\n> torsdag kl 10' }, adapters);
  assert.deepEqual(seen, [['', true], ['Fredag kl 13?', true]]);
});

test('IMAP bodies keep their line breaks, so top- and bottom-posted replies trim to the client words', async () => {
  const { parseRfc822, htmlToText } = await import('../packages/suite/core/mail/mime.js');
  const mail = (body, type = 'text/plain') => [
    'From: Kari <kari@example.no>',
    'To: alexander@asoldi.com',
    'Subject: Re: Påminnelse',
    `Content-Type: ${type}; charset=utf-8`,
    '',
    body,
  ].join('\r\n');
  const top = parseRfc822(mail(`Jeg kan dessverre ikke i morgen.\r\n\r\nMvh Kari\r\n\r\nons. 4. nov. 2026 kl. 10:12 skrev Alexander <alexander@asoldi.com>:\r\n${gtQuote().replace(/\n/g, '\r\n')}`));
  assert.match(top.text, /\n/);
  assert.equal(freshReplyText(top.text).startsWith('Jeg kan dessverre ikke i morgen.'), true);
  assert.doesNotMatch(freshReplyText(top.text), /10:00|torsdag/);
  const bottom = parseRfc822(mail(`${gtQuote().replace(/\n/g, '\r\n')}\r\n\r\nKan ikke, beklager.`));
  assert.equal(freshReplyText(bottom.text), 'Kan ikke, beklager.');
  const html = htmlToText('<div>Torsdag passer fint</div><div><br></div><blockquote><p>Påminnelse: torsdag kl 10</p></blockquote>');
  assert.equal(freshReplyText(html), 'Torsdag passer fint');
});

test('format=flowed: a soft line break (space before CRLF) is unwrapped, so "torsdag / kl 10" stays one sentence', async () => {
  const { parseRfc822 } = await import('../packages/suite/core/mail/mime.js');
  const mail = (body, type = 'text/plain; charset=utf-8; format=flowed', encoding = '8bit') => Buffer.from([
    'From: Kari <kari@example.no>',
    'To: alexander@asoldi.com',
    'Subject: Re: Online møte',
    `Content-Type: ${type}`,
    `Content-Transfer-Encoding: ${encoding}`,
    '',
    body,
  ].join('\r\n'), 'utf8').toString('latin1');
  // Recheck W1: the wrapped "kl 10" was paired with the later "fredag" and booked Friday 10:00.
  const wrapped = 'Hei! Beklager, men det passer ikke for meg å møtes på torsdag \r\nkl 10 likevel. Kan vi ta fredag kl 13?\r\n\r\nMvh Kari';
  const flowed = parseRfc822(mail(wrapped));
  assert.equal(flowed.text, 'Hei! Beklager, men det passer ikke for meg å møtes på torsdag kl 10 likevel. Kan vi ta fredag kl 13?\n\nMvh Kari');
  assert.equal(freshReplyText(flowed.text), flowed.text);
  // Without format=flowed the break is a hard one and stays.
  assert.match(parseRfc822(mail(wrapped, 'text/plain; charset=utf-8')).text, /torsdag\nkl 10/);
  // DelSp=yes drops the space before the break; quoted-printable "=20" before the break is the same soft break.
  assert.equal(parseRfc822(mail('Kan vi ta fre \r\ndag kl 13?', 'text/plain; charset="utf-8"; format="flowed"; delsp="yes"')).text, 'Kan vi ta fredag kl 13?');
  assert.equal(parseRfc822(mail('Kan vi ta torsdag=20\r\nkl 14 i stedet?', 'text/plain; charset=utf-8; format=flowed', 'quoted-printable')).text, 'Kan vi ta torsdag kl 14 i stedet?');
  // Quoted lines join only at the same depth and keep their '>', so the quote is still cut; blank lines and "-- " never join.
  const thread = parseRfc822(mail('Passer fint \r\n\r\nDen 04.11.2026 07:00, skrev Alexander:\r\n> Møtet er \r\n> torsdag kl 10\r\n>> eldre \r\n> nyere\r\n-- \r\nKari'));
  assert.equal(thread.text, 'Passer fint\n\nDen 04.11.2026 07:00, skrev Alexander:\n> Møtet er torsdag kl 10\n>> eldre\n> nyere\n--\nKari');
  assert.equal(freshReplyText(thread.text), 'Passer fint');
  assert.equal(freshReplyText(parseRfc822(mail('Passer fint \r\n-- \r\nKari')).text), 'Passer fint');
});

test('thread: a client line that starts with "Fra:" or "Dato:" is not a header block unless its fields read like one', () => {
  const own = [
    'Hei\nFra: mandag til fredag har vi åpent 10-18.\nDato: vi kan møtes fredag kl 13',
    'Hei!\nHer er info: Fra: 1. desember holder vi stengt. Emne: juleferie\nMvh',
    'Hei, vi har åpent fra: 10 til 18. Sendt: mandag. Kan vi ta fredag kl 13?',
    'Logo vedlagt. Fra: regnskapsfører, sendt: i går',
    'Foto: Kari Nordmann. Dato: 4. mars 2031 passer',
  ];
  for (const text of own) {
    assert.equal(freshReplyText(text), text, text);
    assert.equal(freshReplyText(flat(text)), flat(text), flat(text));
    assert.equal(forwardedBodyText(text), '', text);
  }
  // A real block below the client's own "Fra:" line still cuts at the real block.
  assert.equal(
    freshReplyText('Hei\nFra: mandag til fredag har vi åpent 10-18.\n\nFra: Alexander <alexander@asoldi.com>\nSendt: onsdag 4. november 2026 07:00\n\ntorsdag kl 10'),
    'Hei\nFra: mandag til fredag har vi åpent 10-18.',
  );
  // Real blocks: an address or name, a date with a year, a recipient, a subject (any two of them).
  assertTopPosted('Ok\n\nFrån: Alexander <a@asoldi.com>\nSkickat: den 4 november 2026 07:00\nTill: kari@kunde.no\nÄmne: Möte\n\ntorsdag kl 10', 'Ok');
  assertTopPosted('Ok\n\nVon: Alexander <a@asoldi.com>\nGesendet: Mittwoch, 4. November 2026 07:00\nAn: kari@kunde.no\nBetreff: Termin\n\ntorsdag kl 10', 'Ok');
  assertTopPosted('Ok\n\nFrom: noreply\nSent: Wednesday, November 4, 2026 7:00 AM\nTo: kari@kunde.no\nSubject: Møte\n\ntorsdag kl 10', 'Ok');
  assertTopPosted('Ok\n\nFra: Alexander\nTil: Kari Nordmann; Ola\nEmne: Påminnelse\n\ntorsdag kl 10', 'Ok');
});

test('thread: a one-line Outlook quote glued to the reply ("…beklager!Fra: …") is cut at "Fra:" (recheck x21)', () => {
  const quote = 'Fra: Alexander Asoldi <alexander@asoldi.com> Sendt: mandag 3. mars 2031 07:00 Til: kari@kunde.no Emne: Påminnelse: Online møte med Asoldi om 3 dager Hei Kari, Vennlig påminnelse: møtet vårt starter torsdag 6. mars kl 10:00.';
  assert.equal(freshReplyText(`Det passer ikke likevel, beklager!${quote}`), 'Det passer ikke likevel, beklager!');
  assert.equal(freshReplyText(`Det passer ikke likevel, beklager!\n${quote}`), 'Det passer ikke likevel, beklager!');
  // HTML that lost the break can glue "Fra:" straight onto the sign-off.
  assert.equal(freshReplyText(`Kan vi ta onsdag kl 13 i stedet? Mvh Per${quote}`), 'Kan vi ta onsdag kl 13 i stedet? Mvh Per');
  const blob = inboxWriteBlob({ subject: 'Re: Påminnelse', text: `Det passer ikke likevel, beklager!${quote}` });
  assert.doesNotMatch(blob, NO_TIME, blob);
});
