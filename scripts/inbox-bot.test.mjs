import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-inbox-bot-'));
delete process.env.DEEPSEEK_API_KEY;
delete process.env.GEMINI_API_KEY;

const sales = await import('../data/sales.js');
const clientPortal = await import('../data/client-portal.js');
const { categorizeEmailHeuristic, normalizeMediaBucket } = await import('../lib/inbox-bot/categorize.js');
const { matchSalesClient, parseEmailAddress } = await import('../lib/inbox-bot/match-client.js');
const { pdfLooksLikeAsoldiContract } = await import('../lib/inbox-bot/pdf-text.js');
const { fingerprintPdfBuffer, scoreContractSigning, inspectInboundContract } = await import('../lib/inbox-bot/inspect-contract.js');
const { resolveMailboxSource } = await import('../lib/inbox-bot/mail.js');
const {
  backfillInboxReplies,
  inboxAlreadyAnswered,
  ingestInboxMessage,
  markOlderSameSenderDuplicates,
  markOlderSchedulingDuplicates,
  peekInboxMailbox,
  presentInboxBotStatus,
  presentInboxForClient,
  stripSecrets,
} = await import('../lib/inbox-bot/index.js');
const { buildContractPdf } = await import('../lib/offer-contract-pdf.js');
const { appendMediaToBank } = await import('../lib/client-media-store.js');
const { persistMediaFiles } = await import('../lib/ai-assistant/service.js');
const { normalizeNote } = await import('../lib/ai-assistant/gather.js');
const { extractAttachmentNames, collectGmailAttachmentParts, presentGmailMessage } = await import('../lib/gmail-readonly.js');
const { FETCH_TIMEOUT_MS, LOGIN_TIMEOUT_MS, imapCredsPresent, indexOfImapNeedle, parseRfc822 } = await import('../lib/inbox-bot/mail-imap.js');
const inboxStore = await import('../lib/inbox-bot/store.js');

const PORTAL_USER = 'portal-inbox-1';

function seedClient(overrides = {}) {
  return sales.createSalesClient({
    id: overrides.id || 'sale-inbox-1',
    businessName: overrides.businessName || 'Cafe Nordlys',
    contactEmail: overrides.contactEmail || 'eier@nordlys.no',
    clientEmail: overrides.clientEmail || 'nordlys@asoldi-kunde.no',
    orgNumber: overrides.orgNumber || '123456789',
    portalUserId: overrides.portalUserId,
    product: 'asoldi',
  });
}

test('heuristic: Asoldi contract filename is signed_contract', () => {
  const out = categorizeEmailHeuristic({
    subject: 'Avtale',
    text: 'Her er kontrakten',
    attachmentNames: ['Asoldi-kontrakt-Tier-1-Cafe-Nordlys.pdf'],
  });
  assert.equal(out.kind, 'signed_contract');
});

test('heuristic: logo image plus body is client_elements in logos', () => {
  const out = categorizeEmailHeuristic({
    subject: 'Logo',
    text: 'Her er logoen vår',
    attachmentNames: ['logo-dark.png'],
  });
  assert.equal(out.kind, 'client_elements');
  assert.equal(out.elements[0].bucket, 'logos');
  assert.equal(out.elements[0].isLogo, true);
});

test('heuristic: newsletter without files is other', () => {
  const out = categorizeEmailHeuristic({
    subject: 'Nyhetsbrev uke 12',
    text: 'Les mer på bloggen',
    attachmentNames: [],
  });
  assert.equal(out.kind, 'other');
});

test('pdf text with Asoldi org number looks like a contract', () => {
  assert.equal(pdfLooksLikeAsoldiContract('CHAPANA (Asoldi Marketing) org 934 327 497', 'scan.pdf'), true);
  assert.equal(pdfLooksLikeAsoldiContract('random menu', 'meny.pdf'), false);
});

test('match prefers from-email then org nr', () => {
  const clients = [
    seedClient({ id: 'a', contactEmail: 'a@x.no', orgNumber: '111111111', businessName: 'Alpha' }),
    seedClient({ id: 'b', contactEmail: 'b@x.no', orgNumber: '123456789', businessName: 'Cafe Nordlys' }),
  ];
  assert.equal(matchSalesClient(clients, { from: 'Eier <b@x.no>', match: {} }).client.id, 'b');
  assert.equal(matchSalesClient(clients, { from: 'bokholder@regnskap.no', match: { orgNumber: '123 456 789' } }).client.id, 'b');
  assert.equal(parseEmailAddress('Navn <Hei@X.NO>'), 'hei@x.no');
});

test('tiny bounced PDF is stored as unsigned copy and does not set contractSigned', async () => {
  const client = seedClient({ id: 'sale-contract-1', portalUserId: PORTAL_USER });
  clientPortal.upsertClientProfile(PORTAL_USER, { businessName: 'Cafe Nordlys' });
  const pdf = Buffer.from('%PDF-1.4 fake');
  const result = await ingestInboxMessage({
    id: 'gmail-1',
    mailbox: 'damian@asoldi.com',
    from: 'eier@nordlys.no',
    subject: 'Signert avtale',
    text: 'Vedlagt',
    mailAt: '2026-10-10T12:00:00.000Z',
    attachmentNames: ['Asoldi-kontrakt-Tier-1-Cafe-Nordlys.pdf'],
    attachments: [{ filename: 'Asoldi-kontrakt-Tier-1-Cafe-Nordlys.pdf', mimeType: 'application/pdf', buffer: pdf }],
  });
  assert.equal(result.kind, 'signed_contract');
  assert.equal(result.inspection.verdict, 'unsigned');
  assert.equal(result.salesClientId, client.id);
  const stored = sales.getSalesClientById(client.id);
  assert.equal(Boolean(stored.progression?.contractSigned), false);
  const inbox = presentInboxForClient(client.id);
  assert.equal(inbox.pendingContracts, 0);
  assert.equal(inbox.contracts[0].status, 'unsigned_copy');
  assert.ok(inbox.contracts[0].fileName);
  const full = join(process.env.APP_DATA_DIR, 'inbox-contracts', client.id, inbox.contracts[0].fileName);
  assert.equal(existsSync(full), true);
  assert.equal(readFileSync(full).equals(pdf), true);
});

test('scan-sized inbound contract notifies pending without ticking Kontrakt', async () => {
  const client = seedClient({
    id: 'sale-contract-scan',
    contactEmail: 'scan@nordlys.no',
  });
  sales.updateSalesClient(client.id, {
    sentContractFingerprint: {
      byteLength: 78000,
      pageCount: 2,
      imageCount: 1,
      sha256: 'abc',
      source: 'sent',
    },
  });
  const header = '%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count 4 >>\nendobj\n/Subtype /Image\n/Subtype /Image\n/Subtype /Image\n%%EOF\n';
  const pdf = Buffer.concat([Buffer.from(header), Buffer.alloc(400000, 1)]);
  const result = await ingestInboxMessage({
    id: 'imap-scan-1',
    mailbox: 'damian@asoldi.com',
    from: 'scan@nordlys.no',
    subject: 'Signert kontrakt',
    text: 'Vedlagt den signerte avtalen',
    mailAt: '2026-10-10T12:00:00.000Z',
    attachmentNames: ['Asoldi-kontrakt-Tier-1-Cafe-Nordlys.pdf'],
    attachments: [{ filename: 'Asoldi-kontrakt-Tier-1-Cafe-Nordlys.pdf', mimeType: 'application/pdf', buffer: pdf }],
  });
  assert.equal(result.inspection.verdict, 'likely');
  assert.equal(presentInboxForClient(client.id).pendingContracts, 1);
  assert.equal(Boolean(sales.getSalesClientById(client.id).progression?.contractSigned), false);
});

test('identical sent PDF is unsigned even if the email says signed', async () => {
  const buffer = await buildContractPdf({
    client: {
      businessName: 'Cafe Nordlys',
      orgNumber: '123456789',
      contactPerson: 'Ola Nord',
      contactEmail: 'eier@nordlys.no',
      businessAddress: 'Gate 1',
    },
    tierId: 'tier-1-standard',
    date: new Date('2026-10-01'),
  });
  const original = fingerprintPdfBuffer(buffer, 'Asoldi-kontrakt.pdf');
  const inspected = await inspectInboundContract({
    buffer,
    fileName: 'Asoldi-kontrakt-Tier-1-Cafe-Nordlys.pdf',
    pdfText: 'CHAPANA (Asoldi Marketing) 934327497 Date: ____________',
    emailText: 'Her er den signerte kontrakten',
    original,
    vision: false,
  });
  assert.equal(inspected.verdict, 'unsigned');
  assert.equal(inspected.shaMatch, true);
});

test('generated unsigned contract has a blank client line at the bottom', async () => {
  const buffer = await buildContractPdf({
    client: {
      businessName: 'Cafe Nordlys',
      orgNumber: '123456789',
      contactPerson: 'Ola Nord',
      contactEmail: 'eier@nordlys.no',
      businessAddress: 'Gate 1',
    },
    tierId: 'tier-1-standard',
    date: new Date('2026-10-01'),
  });
  const inspected = await inspectInboundContract({
    buffer,
    fileName: 'Asoldi-kontrakt-Tier-1-Cafe-Nordlys.pdf',
    pdfText: 'CHAPANA (Asoldi Marketing) 934327497 Date: ____________',
    vision: false,
  });
  assert.equal(inspected.verdict, 'unsigned');
  assert.equal(inspected.reasons.includes('right-bottom-writing'), false);
});

test('scan-sized PDF with extra pages and images scores likely signed', () => {
  const out = scoreContractSigning({
    inboundBytes: 920000,
    originalBytes: 78000,
    inboundPages: 4,
    originalPages: 2,
    eofCount: 1,
    imageCount: 4,
    originalImageCount: 1,
    blankClientDate: false,
    clientDateFilled: true,
    emailSaysSigned: true,
    vision: { clientSigned: true, confidence: 0.9 },
  });
  assert.equal(out.verdict, 'likely');
  assert.ok(out.score >= 3);
});

test('Hostinger IMAP is used before Gmail when IMAP passwords exist', async () => {
  process.env.INBOX_IMAP_ALEXANDER_PASS = 'test-pass';
  let probedGmail = false;
  try {
    const source = await resolveMailboxSource('alexander@asoldi.com', {
      listImap: async () => ({ skipped: false, messages: [{ id: '1' }] }),
      probeGmail: async () => {
        probedGmail = true;
        return { skipped: false, empty: false };
      },
      listGmail: async () => ({ skipped: true, messages: [] }),
    });
    assert.equal(source, 'imap');
    assert.equal(probedGmail, false);
  } finally {
    delete process.env.INBOX_IMAP_ALEXANDER_PASS;
  }
});

test('elements ingest files a logo into Kundedata when portal is connected', async () => {
  const userId = 'portal-inbox-logo';
  clientPortal.upsertClientProfile(userId, { businessName: 'Cafe Nordlys' });
  const client = seedClient({
    id: 'sale-logo-1',
    portalUserId: userId,
    contactEmail: 'logo@nordlys.no',
  });
  await ingestInboxMessage({
    id: 'gmail-logo-1',
    mailbox: 'damian@asoldi.com',
    from: 'logo@nordlys.no',
    subject: 'Logo',
    text: 'Her er logoen',
    mailAt: '2026-10-10T12:00:00.000Z',
    attachmentNames: ['merke.png'],
    attachments: [{
      filename: 'merke.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }],
  });
  const bank = clientPortal.getClientProfileByUserId(userId)?.clientDataBank || {};
  assert.ok((bank.media?.logos || []).length >= 1);
  assert.ok(String(bank.brandIdentity?.logos?.normal || '').includes('/client-media/'));
  assert.equal(Boolean(sales.getSalesClientById(client.id).progression?.contractSigned), false);
  const presented = presentInboxForClient(client.id);
  assert.equal(presented.elements.length, 1);
  assert.equal(presented.elements[0].status, 'filed');
  assert.ok(presented.elements[0].buckets.includes('logos'));
});

test('persistMediaFiles honors an explicit bucket map', async () => {
  const userId = 'portal-inbox-hero';
  clientPortal.upsertClientProfile(userId, { businessName: 'Hero Test' });
  const saved = await persistMediaFiles(userId, [{
    originalName: 'hero.jpg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
  }], { buckets: { 'hero.jpg': { bucket: 'mainHeroImages', isLogo: false } } });
  assert.equal(saved.urls.length, 1);
  const bank = clientPortal.getClientProfileByUserId(userId)?.clientDataBank || {};
  assert.ok((bank.media?.mainHeroImages || []).includes(saved.urls[0]));
  assert.equal((bank.media?.uncategorized || []).includes(saved.urls[0]), false);
});

test('appendMediaToBank writes logo slot once', () => {
  const first = appendMediaToBank({}, { url: '/a.png', bucket: 'logos', isLogo: true });
  const second = appendMediaToBank(first, { url: '/b.png', bucket: 'logos', isLogo: true });
  assert.equal(second.brandIdentity.logos.normal, '/a.png');
  assert.deepEqual(second.media.logos, ['/a.png', '/b.png']);
});

test('gather note keeps mediaFiles buckets', () => {
  const note = normalizeNote({
    mediaFiles: [{ fileName: 'hero.jpg', bucket: 'mainHeroImages' }, { fileName: 'x.bin', bucket: 'nope' }],
  });
  assert.equal(note.mediaFiles[0].bucket, 'mainHeroImages');
  assert.equal(note.mediaFiles[1].bucket, 'uncategorized');
  assert.equal(normalizeMediaBucket('teamImages'), 'teamImages');
});

test('gmail presenter still lists filename-only parts for T01', () => {
  const payload = {
    headers: [{ name: 'Subject', value: 'Hei' }, { name: 'From', value: 'a@b.no' }],
    parts: [{ filename: 'meny.pdf', mimeType: 'application/pdf', body: {} }],
  };
  assert.deepEqual(extractAttachmentNames(payload), ['meny.pdf']);
  assert.equal(collectGmailAttachmentParts(payload).length, 0);
  const presented = presentGmailMessage({ id: 'm1', payload, snippet: 'hei' });
  assert.deepEqual(presented.attachmentNames, ['meny.pdf']);
});

test('RFC822 parser reads a text part and a base64 attachment', () => {
  const raw = [
    'From: Eier <eier@nordlys.no>',
    'To: damian@asoldi.com',
    'Subject: Logo',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain',
    '',
    'Her er logoen',
    '--b1',
    'Content-Type: image/png; name="logo.png"',
    'Content-Disposition: attachment; filename="logo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgo=',
    '--b1--',
    '',
  ].join('\r\n');
  const parsed = parseRfc822(raw);
  assert.equal(parseEmailAddress(parsed.from), 'eier@nordlys.no');
  assert.match(parsed.text, /logoen/i);
  assert.equal(parsed.attachments[0].filename, 'logo.png');
  assert.ok(parsed.attachments[0].buffer.length > 0);
});

test('RFC822 parser decodes encoded subjects, names, and UTF-8 quoted-printable bodies', () => {
  const raw = [
    'From: =?UTF-8?Q?Bjarte_=C3=98grey?= <bjarte@example.no>',
    'Subject: =?utf-8?Q?Re:_P=C3=A5minnelse:_Online_m=C3=B8te?= =?utf-8?Q?_om_24_timer?=',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Det passer fint, vi sees p=C3=A5 m=C3=B8tet.',
    '',
  ].join('\r\n');
  const parsed = parseRfc822(raw);
  assert.equal(parsed.subject, 'Re: Påminnelse: Online møte om 24 timer');
  assert.equal(parsed.from, 'Bjarte Øgrey <bjarte@example.no>');
  assert.equal(parsed.text, 'Det passer fint, vi sees på møtet.');
});

test('replies are read without the quoted thread: cancels never book, a moved time books the new time', async () => {
  const { classifyInboxWrite, freshReplyText } = await import('../lib/inbox-bot/write.js');
  const client = { progression: {} };
  const cancelToday = 'Blir mailene mine mottatt? Jeg kan ikke idag likevel Kari Founder Tel.+47 92 80 78 81 ons. 14. okt. 2026 kl. 15:47 skrev Kari <kari@example.no>: > Hei igjen';
  assert.equal(freshReplyText(cancelToday).includes('15:47'), false);
  assert.equal(classifyInboxWrite(freshReplyText(cancelToday), client, { now: new Date('2026-10-14T14:00:00Z') }).cancel, true);

  const cancelTomorrow = 'Hei! Jeg har svart deg flere ganger at jeg må avlyse møtet i morgen. Mvh Marie 15. okt. 2026 kl. 12:00 skrev Alexander fra Asoldi <alexander@asoldi.com>: Påminnelse: Online møte';
  const cancelled = classifyInboxWrite(freshReplyText(cancelTomorrow), client, { now: new Date('2026-10-15T12:30:00Z') });
  assert.equal(cancelled.intent, 'sales_propose');
  assert.equal(cancelled.cancel, true);
  assert.equal(cancelled.day, null);

  const moved = 'Hei, Kan vi flytte møtet til onsdag neste uke istedet? Gjerne kl. 15. Med vennlig hilsen Ali ________________________________ Fra: Alexander (Google Kalender) <calendar-notification@google.com> Sendt: fredag 16. oktober 2026 13:59';
  const booked = classifyInboxWrite(freshReplyText(moved), client, { now: new Date('2026-10-16T12:00:00Z') });
  assert.equal(booked.intent, 'sales_book');
  assert.equal(booked.dueAt, '2026-10-21T13:00:00.000Z');

  const drop = classifyInboxWrite('Avlys det hele, vi er ikke interessert', client);
  assert.equal(drop.intent, 'walk_away');
});

test('HTML mail drops style blocks and decodes entities', async () => {
  const { htmlToText } = await import('../lib/inbox-bot/mail-imap.js');
  const text = htmlToText('<head><style>.x{color:red}</style></head><p>Hei&nbsp;der &lt;a@b.no&gt;</p>').replace(/\s+/g, ' ').trim();
  assert.equal(text, 'Hei der <a@b.no>');
});

test('missing IMAP pass is not configured', () => {
  assert.equal(imapCredsPresent('alexander@asoldi.com', {}), false);
});

test('only Alexander is read for now, even if a Damian pass exists', () => {
  assert.equal(imapCredsPresent('damian@asoldi.com', { INBOX_IMAP_DAMIAN_PASS: 'x' }), false);
  assert.equal(imapCredsPresent('alexander@asoldi.com', { INBOX_IMAP_ALEXANDER_PASS: 'x' }), true);
});

test('a one-line tagged LOGIN reply is found at the start of the buffer', () => {
  const find = (text) => indexOfImapNeedle(Buffer.from(text), Buffer.from('ASX1 '), true);
  assert.equal(find('ASX1 OK [CAPABILITY IMAP4rev1] Logged in\r\n'), 0);
  assert.equal(find('* FLAGS (\\Seen)\r\nASX1 OK done\r\n'), 17);
  assert.equal(find('body mentions XASX1 here\r\n'), -1);
});

test('LOGIN timeout stays short and FETCH is longer', () => {
  assert.equal(LOGIN_TIMEOUT_MS, 8000);
  assert.ok(FETCH_TIMEOUT_MS > LOGIN_TIMEOUT_MS);
});

test('status reports configured without leaking the password', async () => {
  process.env.INBOX_IMAP_ALEXANDER_PASS = 'super-secret-pass';
  try {
    const payload = await presentInboxBotStatus({
      probeLogin: async (mailbox) => ({ mailbox, configured: true, ok: true, reason: '', source: 'imap' }),
    });
    const raw = JSON.stringify(payload);
    assert.equal(raw.includes('super-secret-pass'), false);
    assert.equal(payload.mailboxes.length, 1);
    assert.equal(payload.mailboxes[0].mailbox, 'alexander@asoldi.com');
    assert.equal(payload.mailboxes[0].ok, true);
    assert.equal(Object.hasOwn(payload.mailboxes[0], 'pass'), false);
    assert.deepEqual(
      stripSecrets({ INBOX_IMAP_DAMIAN_PASS: 'super-secret-pass', mailbox: 'damian@asoldi.com' }),
      { mailbox: 'damian@asoldi.com' }
    );
  } finally {
    delete process.env.INBOX_IMAP_ALEXANDER_PASS;
  }
});

test('peek classifies Alexander mail without marking processed or sending', async () => {
  const client = seedClient({
    id: 'sale-peek-1',
    contactEmail: 'eier@nordlys.no',
    portalUserId: PORTAL_USER,
  });
  clientPortal.upsertClientProfile(PORTAL_USER, { businessName: 'Cafe Nordlys' });
  let sendCalled = false;
  const peeked = await peekInboxMailbox('alexander@asoldi.com', {
    clients: [client],
    categorize: categorizeEmailHeuristic,
    listImap: async () => ({
      skipped: false,
      messages: [{
        id: 'imap-peek-1',
        mailbox: 'alexander@asoldi.com',
        from: 'Eier <eier@nordlys.no>',
        subject: 'Logo',
        text: 'Her er logoen',
        mailAt: '2026-10-16T10:00:00.000Z',
        attachmentNames: ['logo-dark.png'],
        attachments: [{ filename: 'logo-dark.png', mimeType: 'image/png', buffer: Buffer.from('x') }],
      }],
    }),
  });
  assert.equal(peeked.skipped, false);
  assert.equal(peeked.messages[0].kind, 'client_elements');
  assert.equal(peeked.messages[0].destination, 'kundedata:logos');
  assert.equal(peeked.messages[0].salesClientId, client.id);
  assert.equal(inboxStore.isProcessed('alexander@asoldi.com', 'imap-peek-1'), false);
  assert.equal(sendCalled, false);
  assert.equal(JSON.stringify(peeked).includes('"buffer"'), false);
});

test('peek proposes a sales auto-reply for a clock time without filing', async () => {
  const client = seedClient({
    id: 'sale-peek-time',
    contactEmail: 'tid@nordlys.no',
  });
  const peeked = await peekInboxMailbox('alexander@asoldi.com', {
    clients: [client],
    categorize: categorizeEmailHeuristic,
    now: new Date('2026-10-13T08:00:00.000Z'),
    listImap: async () => ({
      skipped: false,
      messages: [{
        id: 'imap-peek-time',
        mailbox: 'alexander@asoldi.com',
        from: 'tid@nordlys.no',
        subject: 'Møte',
        text: 'Kan vi ta møtet tirsdag kl 14?',
        mailAt: '2026-10-13T10:00:00.000Z',
        attachmentNames: [],
        attachments: [],
      }],
    }),
  });
  assert.equal(peeked.messages[0].kind, 'workshop_time');
  assert.equal(peeked.messages[0].intent, 'sales_book');
  assert.equal(peeked.messages[0].destination, 'auto-reply:sales_book');
  assert.equal(inboxStore.isProcessed('alexander@asoldi.com', 'imap-peek-time'), false);
});

test('cancel proposes new times, adds Ny møtetid, and only the newest mail from that sender gets a reply', async () => {
  const client = seedClient({ id: 'sale-cancel-1', contactEmail: 'marie@example.com' });
  const now = new Date('2026-10-15T12:30:00.000Z');
  const sent = [];
  const older = {
    id: 'imap-cancel-old',
    mailbox: 'alexander@asoldi.com',
    from: 'marie@example.com',
    subject: 'Re: Påminnelse',
    text: 'Jeg må avlyse møtet i morgen.',
    mailAt: '2026-10-15T10:00:00.000Z',
  };
  const newer = {
    ...older,
    id: 'imap-cancel-new',
    text: 'Jeg har svart deg flere ganger at jeg må avlyse møtet i morgen. Mvh Marie',
    mailAt: '2026-10-15T12:00:00.000Z',
  };
  const queued = markOlderSchedulingDuplicates([older, newer], { now });
  assert.equal(queued.find((row) => row.id === 'imap-cancel-old').skipWrite, true);
  assert.equal(Boolean(queued.find((row) => row.id === 'imap-cancel-new').skipWrite), false);

  const first = await ingestInboxMessage(queued.find((row) => row.id === 'imap-cancel-new'), {
    now,
    sendEmail: async (mail) => { sent.push(mail); },
    queryBusy: async () => ({ busy: [] }),
  });
  const skip = await ingestInboxMessage(queued.find((row) => row.id === 'imap-cancel-old'), {
    now,
    sendEmail: async (mail) => { sent.push(mail); },
    queryBusy: async () => ({ busy: [] }),
  });
  assert.equal(first.kind, 'sales_propose');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /helt i orden/i);
  assert.equal(/30 minutt/i.test(sent[0].text), false);
  assert.equal(skip.reason, 'older-same-thread');
  const live = sales.getSalesClientById(client.id);
  assert.ok((live.nextActions || []).some((row) => /ny møtetid|finn møtetid/i.test(row.name || '') && !row.doneAt));
});

test('failed send stamps the card; changing the email clears it', () => {
  const client = seedClient({ id: 'sale-bounce-1', contactEmail: 'bad@example.no' });
  sales.noteSalesContactEmailSend({ to: 'bad@example.no', ok: false, error: '550 unknown recipient' });
  assert.match(sales.getSalesClientById(client.id).contactEmailError.message, /550/);
  sales.updateSalesClient(client.id, { contactEmail: 'good@example.com' });
  assert.equal(sales.getSalesClientById(client.id).contactEmailError, null);
});

test('walk-away asks why, offers a chat, and a second no closes politely', async () => {
  const { mergeWriteDecision, polishInboxReply } = await import('../lib/inbox-bot/decide.js');
  assert.equal(polishInboxReply('Helt i orden. Møtet er 30 minutter. Vi tar den av.'), 'Helt i orden. Vi tar den av.');
  const merged = mergeWriteDecision(
    { intent: 'sales_propose', cancel: true, _fresh: 'Avlys det hele' },
    { intent: 'walk_away', reply: 'Skjønner, synd det ikke passer. Hva er grunnen? Vi tar en sjekk om en uke.', checkupFormat: 'sms' },
    { client: {} },
  );
  assert.equal(merged.intent, 'walk_away');
  assert.equal(merged.checkupFormat, 'sms');

  const client = seedClient({ id: 'sale-walkaway-1', contactEmail: 'drop@example.com' });
  const sent = [];
  const result = await ingestInboxMessage({
    id: 'imap-walkaway-1',
    mailbox: 'alexander@asoldi.com',
    from: 'drop@example.com',
    subject: 'Re: møte',
    text: 'Vi dropper hele greia, ikke interessert.',
    mailAt: '2026-10-15T12:00:00.000Z',
  }, {
    now: new Date('2026-10-15T12:00:00.000Z'),
    sendEmail: async (mail) => { sent.push(mail); },
    queryBusy: async () => ({ busy: [] }),
    decideAi: async () => ({ intent: 'walk_away', checkupFormat: 'email' }),
  });
  assert.equal(result.kind, 'walk_away');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /hva som gjorde at det ikke ble aktuelt/i);
  assert.match(sent[0].text, /uforpliktende prat/i);
  assert.match(sent[0].text, /passer noe av dette: .*\d{2}:\d{2}/i);
  assert.equal(/tar vi den av kalenderen|om en uke|30 minutt/i.test(sent[0].text), false);
  const live = sales.getSalesClientById(client.id);
  const checkup = (live.nextActions || []).find((row) => /oppsjekk/i.test(row.name || ''));
  assert.ok(checkup);
  assert.equal(checkup.format, 'email');
  assert.equal(checkup.dueAt, '2026-10-22T07:00:00.000Z');

  const again = await ingestInboxMessage({
    id: 'imap-walkaway-2',
    mailbox: 'alexander@asoldi.com',
    from: 'drop@example.com',
    subject: 'Re: møte',
    text: 'Nei takk, ikke interessert.',
    mailAt: '2026-10-15T14:00:00.000Z',
  }, {
    now: new Date('2026-10-15T14:00:00.000Z'),
    sendEmail: async (mail) => { sent.push(mail); },
    queryBusy: async () => ({ busy: [] }),
    decideAi: async () => ({}),
  });
  assert.equal(again.kind, 'walk_away_final');
  assert.equal(/passer noe av dette|\d{2}:\d{2}/i.test(sent[1].text), false);
  assert.match(sent[1].text, /aktuelt senere/i);
});

test('client who cannot know yet gets a follow-up action, not a meeting time', async () => {
  const client = seedClient({ id: 'sale-unsure-1', contactEmail: 'usikker@example.com' });
  const sent = [];
  const result = await ingestInboxMessage({
    id: 'imap-unsure-1',
    mailbox: 'alexander@asoldi.com',
    from: 'usikker@example.com',
    subject: 'Re: møte',
    text: 'Vet ikke helt ennå hva som passer. Kan du sende en sms om tre dager?',
    mailAt: '2026-10-15T12:00:00.000Z',
  }, {
    now: new Date('2026-10-15T12:00:00.000Z'),
    sendEmail: async (mail) => { sent.push(mail); },
    queryBusy: async () => ({ busy: [] }),
    decideAi: async () => ({ intent: 'walk_away' }),
  });
  assert.equal(result.kind, 'sales_call');
  assert.equal(sent[0].text, 'Helt greit. Da sender jeg deg en melding på mandag, så tar vi det derfra.');
  const live = sales.getSalesClientById(client.id);
  const checkup = (live.nextActions || []).find((row) => /oppsjekk/i.test(row.name || '') && !row.doneAt);
  assert.ok(checkup);
  assert.equal(checkup.format, 'sms');
  assert.equal(checkup.dueAt, '2026-10-19T07:00:00.000Z');
  assert.match(checkup.note, /^Bot: Kunden kan ikke avtale møtetid nå\. Bot lovet å ta kontakt på mandag\.\nKunden skrev: «Vet ikke helt ennå/);
  assert.equal(Boolean(live.agreedTime), false);

  const { classifyInboxWrite } = await import('../lib/inbox-bot/write.js');
  const later = classifyInboxWrite('Ikke aktuelt akkurat nå, ta kontakt om en måned', {}, { now: new Date('2026-10-15T12:00:00.000Z') });
  assert.equal(later.intent, 'sales_call');
  assert.equal(later.day.ymd, '2026-11-09');
  const withReason = classifyInboxWrite('Vi er på ferie, ta kontakt om en måned', {}, { now: new Date('2026-10-15T12:00:00.000Z') });
  assert.equal(withReason.day.ymd, '2026-11-14');
  assert.equal(classifyInboxWrite('Vi dropper hele greia, ikke interessert', {}).intent, 'walk_away');
});

test('first mailbox read only sets the baseline; older mail is never answered', async () => {
  const { listNewMailboxMessages } = await import('../lib/inbox-bot/mail.js');
  const processed = new Set();
  let baseline = '';
  const deps = (messages, now) => ({
    listImap: async () => ({ skipped: false, messages }),
    isProcessed: (_mailbox, id) => processed.has(id),
    markProcessed: (_mailbox, id) => processed.add(id),
    getBaseline: () => baseline,
    setBaseline: (_mailbox, at, ids) => { baseline = at; ids.forEach((id) => processed.add(id)); },
    now: () => new Date(now),
  });
  process.env.INBOX_IMAP_ALEXANDER_PASS = 'test-only';
  try {
    const old = [{ id: 'imap:a:uid:1', mailAt: 'Thu, 15 Oct 2026 10:00:00 +0200' }];
    const first = await listNewMailboxMessages('alexander@asoldi.com', deps(old, '2026-10-15T12:00:00.000Z'));
    assert.equal(first.reason, 'baseline');
    assert.equal(first.messages.length, 0);

    const late = { id: 'imap:a:uid:2', mailAt: 'Thu, 15 Oct 2026 11:00:00 +0200' };
    const fresh = { id: 'imap:a:uid:3', mailAt: 'Thu, 15 Oct 2026 15:00:00 +0200' };
    const second = await listNewMailboxMessages('alexander@asoldi.com', deps([...old, late, fresh], '2026-10-15T14:00:00.000Z'));
    assert.deepEqual(second.messages.map((row) => row.id), ['imap:a:uid:3']);
    assert.equal(processed.has('imap:a:uid:2'), true);
  } finally {
    delete process.env.INBOX_IMAP_ALEXANDER_PASS;
  }
});

test('real-mail fixes: "kl 1400", busy window, only offered times, a question is not a call', async () => {
  const { parseWorkshopTimeHeuristic } = await import('../lib/workshop-time-parse.js');
  const { clientBusyBlocks, replyTimesMatch } = await import('../lib/inbox-bot/write.js');
  const { mergeWriteDecision } = await import('../lib/inbox-bot/decide.js');
  const tue = parseWorkshopTimeHeuristic('Kan vi utsette til nezte tirsdag kl 1400?', { now: new Date('2026-10-13T10:00:00.000Z') });
  assert.equal(tue.dueAt, '2026-10-20T12:00:00.000Z');
  assert.deepEqual(clientBusyBlocks('Er opptatt fra ca 11-14. Ellers ledig.', { ymd: '2026-10-16' }), [
    { start: '2026-10-16T09:00:00.000Z', end: '2026-10-16T12:00:00.000Z' },
  ]);
  const slots = ['2026-10-16T07:00:00.000Z', '2026-10-16T08:00:00.000Z'];
  assert.equal(replyTimesMatch('Fredag passer — kl. 09:00 eller 10:00?', slots), true);
  assert.equal(replyTimesMatch('Vi tar det tirsdag kl. 14 – passer det?', slots), false);
  const merged = mergeWriteDecision({ intent: 'none', _fresh: 'Hei, hva gjelder dette?' }, { intent: 'sales_call', reply: 'Det gjelder et kort online møte om nettsiden.' });
  assert.equal(merged.intent, 'gather');
});

test('every client mail goes past the Kundedata filer; only mail with facts is kept until the portal is connected', async () => {
  const seen = [];
  const interpretNote = async (text) => {
    seen.push(text);
    return /åpent/.test(text) ? normalizeNote({ hoursText: 'mandag-fredag 10:00-18:00' }) : null;
  };
  const client = seedClient({ id: 'sale-facts-1', contactEmail: 'fakta@example.com' });
  const deps = {
    now: new Date('2026-10-15T12:00:00.000Z'),
    sendEmail: async () => {},
    queryBusy: async () => ({ busy: [] }),
    decideAi: async () => ({}),
    interpretNote,
  };
  await ingestInboxMessage({
    id: 'imap-facts-1',
    mailbox: 'alexander@asoldi.com',
    from: 'fakta@example.com',
    subject: 'Re: møte',
    text: 'Torsdag passer. Vi har åpent man-fre 10-18. > Hei, her er Asoldi sin invitasjon',
    mailAt: '2026-10-15T12:00:00.000Z',
  }, deps);
  await ingestInboxMessage({
    id: 'imap-facts-2',
    mailbox: 'alexander@asoldi.com',
    from: 'fakta@example.com',
    subject: 'Re: møte',
    text: 'Takk, vi snakkes på torsdag.',
    mailAt: '2026-10-15T13:00:00.000Z',
  }, deps);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].includes('Asoldi sin invitasjon'), false);
  const staged = inboxStore.listInboxItems({ salesClientId: client.id, status: 'staged' });
  assert.equal(staged.length, 1);
  assert.match(staged[0].text, /åpent man-fre 10-18/);
  assert.deepEqual(staged[0].found, ['opening-hours']);
});

test('every attachment format reaches the Kundedata filer as text', async () => {
  const AdmZip = (await import('adm-zip')).default;
  const xlsx = await import('xlsx');
  const PDFDocument = (await import('pdfkit')).default;
  const { fileClientElements } = await import('../lib/inbox-bot/apply-elements.js');
  const zip = (entries) => {
    const archive = new AdmZip();
    for (const [name, body] of Object.entries(entries)) archive.addFile(name, Buffer.from(body));
    return archive.toBuffer();
  };
  const pdf = await new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.text('Markpdf: vi holder til i Storgata 12, og har en lang tekst her slik at den leses.');
    doc.end();
  });
  const sheet = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(sheet, xlsx.utils.aoa_to_sheet([['Markxlsx', 'Pizza', '149 kr']]), 'Meny');
  const wordBinary = Buffer.concat([Buffer.alloc(512, 0), Buffer.from('Markdoc vi selger sykler i Oslo', 'utf16le'), Buffer.alloc(256, 0)]);
  const files = [
    { originalName: 'info.txt', buffer: Buffer.from('Marktxt åpent man-fre') },
    { originalName: 'meny.csv', buffer: Buffer.from('Markcsv,Pizza,149 kr') },
    { originalName: 'om-oss.docx', buffer: zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:p><w:t>Markdocx historien vår</w:t></w:p>' }) },
    { originalName: 'om-oss.odt', buffer: zip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<text:p>Markodt teksten</text:p>' }) },
    { originalName: 'pitch.pptx', buffer: zip({ '[Content_Types].xml': '<Types/>', 'ppt/slides/slide1.xml': '<a:t>Markpptx lysbilde</a:t>' }) },
    { originalName: 'gammel.doc', buffer: wordBinary },
    { originalName: 'notat.rtf', buffer: Buffer.from('{\\rtf1\\ansi Markrtf notat}') },
    { originalName: 'side.html', buffer: Buffer.from('<html><body><p>Markhtml side</p></body></html>') },
    { originalName: 'priser.xlsx', buffer: xlsx.write(sheet, { type: 'buffer', bookType: 'xlsx' }) },
    { originalName: 'brosjyre.pdf', buffer: pdf },
  ];
  let read = '';
  const row = await fileClientElements({
    salesClient: { id: 'sale-formats-1' },
    mailbox: 'alexander@asoldi.com',
    messageId: 'imap-formats-1',
    text: 'Her er alt vi har.',
    files,
    elements: [],
    interpret: async (text) => {
      read = text;
      return normalizeNote({ fields: { companyAddress: 'Storgata 12, Oslo' } });
    },
  });
  for (const mark of ['Marktxt', 'Markcsv', 'Markdocx', 'Markodt', 'Markpptx', 'Markdoc ', 'Markrtf', 'Markhtml', 'Markxlsx', 'Markpdf']) {
    assert.ok(read.includes(mark), `${mark} missing from what the filer read`);
  }
  assert.equal(row.status, 'staged');
  assert.equal(row.stagedFiles.length, files.length);
  assert.deepEqual(row.found, ['address']);
});

test('signature images and calendar invites are not client files; real attachments and photos are', () => {
  const categorize = categorizeEmailHeuristic;
  const part = (headers, body) => [...headers, '', body];
  const raw = [
    'From: Kari <kari@example.no>',
    'Subject: Re: møte',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1', ...part(['Content-Type: text/plain'], 'Takk!'),
    '--b1', ...part(['Content-Type: image/png; name="image001.png"', 'Content-Disposition: inline; filename="image001.png"', 'Content-ID: <image001@x>', 'Content-Transfer-Encoding: base64'], Buffer.alloc(2000, 1).toString('base64')),
    '--b1', ...part(['Content-Type: image/jpeg; name="IMG_1234.jpg"', 'Content-Disposition: inline; filename="IMG_1234.jpg"', 'Content-ID: <photo@x>', 'Content-Transfer-Encoding: base64'], Buffer.alloc(60_000, 1).toString('base64')),
    '--b1', ...part(['Content-Type: text/calendar; method=REPLY; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"'], 'BEGIN:VCALENDAR'),
    '--b1', ...part(['Content-Type: application/msword; name="meny.doc"', 'Content-Disposition: attachment; filename="meny.doc"', 'Content-Transfer-Encoding: base64'], Buffer.from('x').toString('base64')),
    '--b1--',
    '',
  ].join('\r\n');
  assert.deepEqual(parseRfc822(raw).attachmentNames, ['IMG_1234.jpg', 'meny.doc']);
  for (const name of ['meny.doc', 'pitch.pptx', 'om-oss.odt', 'notat.rtf', 'video.mov']) {
    assert.equal(categorize({ subject: 'Fil', text: 'Her', attachmentNames: [name] }).kind, 'client_elements', name);
  }
  assert.equal(categorize({ subject: 'Re', text: 'Takk', attachmentNames: ['invite.ics'] }).kind, 'other');
});

test('a time that has passed is never booked and bot actions never land in the past', async () => {
  const { futureDue, botNote } = await import('../lib/inbox-bot/write.js');
  assert.equal(futureDue('2026-10-01T07:00:00.000Z', new Date('2026-10-15T12:00:00.000Z')), '2026-10-16T07:00:00.000Z');
  assert.equal(botNote('Kunden avlyste.', { summary: 'Kunden lurte på hva møtet gjaldt, og ba oss ringe.', clientText: 'Ring meg' }),
    'Bot: Kunden lurte på hva møtet gjaldt, og ba oss ringe.\nKunden skrev: «Ring meg»');
  const client = seedClient({ id: 'sale-past-1', contactEmail: 'gammel@example.com' });
  const sent = [];
  const result = await ingestInboxMessage({
    id: 'imap-past-1',
    mailbox: 'alexander@asoldi.com',
    from: 'gammel@example.com',
    subject: 'Re: møte',
    text: 'Kan vi ta det 2.10 kl 14?',
    mailAt: '2026-10-15T12:00:00.000Z',
  }, {
    now: new Date('2026-10-15T12:00:00.000Z'),
    sendEmail: async (mail) => { sent.push(mail); },
    queryBusy: async () => ({ busy: [] }),
    upsert: async () => { throw new Error('must not book'); },
    decideAi: async () => ({}),
  });
  assert.equal(result.write?.kind || result.kind, 'sales_propose');
  assert.equal(Boolean(sales.getSalesClientById(client.id).agreedTime), false);
  assert.match(sent[0].text, /passer noe av dette/i);
});

test('UID FETCH bodies keep their stable UID', async () => {
  const { parseFetchBodies } = await import('../lib/inbox-bot/mail-imap.js');
  const block = Buffer.from('* 4 FETCH (UID 812 RFC822 {5}\r\nhello)\r\n* 5 FETCH (UID 813 RFC822 {2}\r\nhi)\r\nA1 OK\r\n', 'latin1');
  assert.deepEqual(parseFetchBodies(block), [{ uid: '812', raw: 'hello' }, { uid: '813', raw: 'hi' }]);
});

test('weekday slot picker skips the weekend', async () => {
  const { pickFreeSlotsAhead } = await import('../lib/inbox-bot/slots.js');
  const slots = pickFreeSlotsAhead({
    now: new Date('2026-10-16T16:00:00.000Z'),
    durationMin: 60,
    busy: [],
    count: 2,
    days: 5,
  });
  assert.ok(slots.length >= 2);
  assert.ok(slots.every((iso) => {
    const day = new Date(iso).getUTCDay();
    return day !== 0 && day !== 6;
  }));
  const soon = pickFreeSlotsAhead({
    now: new Date('2026-10-19T08:00:00.000Z'),
    durationMin: 60,
    busy: [{ start: '2026-10-21T07:00:00.000Z', end: '2026-10-21T09:00:00.000Z' }],
  });
  assert.deepEqual(soon, ['2026-10-21T09:00:00.000Z', '2026-10-22T07:00:00.000Z', '2026-10-23T07:00:00.000Z']);
});

test('backfill skips older same-sender, already-wrote, and outbound-after, then force-replies the rest', async () => {
  const client = seedClient({ id: 'sale-backfill-1', contactEmail: 'marie-backfill@example.com' });
  const now = new Date('2026-10-16T12:00:00.000Z');
  const older = {
    id: 'imap-backfill-old',
    mailbox: 'alexander@asoldi.com',
    from: 'marie-backfill@example.com',
    subject: 'Avlys',
    text: 'Jeg må avlyse møtet i morgen.',
    mailAt: '2026-10-15T10:00:00.000Z',
  };
  const newer = {
    ...older,
    id: 'imap-backfill-new',
    text: 'Jeg må avlyse møtet i morgen. Mvh Marie',
    mailAt: '2026-10-16T09:00:00.000Z',
  };
  const other = {
    id: 'imap-backfill-other',
    mailbox: 'alexander@asoldi.com',
    from: 'marie-backfill@example.com',
    subject: 'Logo',
    text: 'Her er logoen',
    mailAt: '2026-10-14T09:00:00.000Z',
  };
  const queued = markOlderSameSenderDuplicates(markOlderSchedulingDuplicates([older, newer, other], { now }));
  assert.equal(queued.find((row) => row.id === 'imap-backfill-old').skipWrite, true);
  assert.equal(queued.find((row) => row.id === 'imap-backfill-other').skipWrite, true);
  assert.equal(Boolean(queued.find((row) => row.id === 'imap-backfill-new').skipWrite), false);

  inboxStore.appendInboxItem({
    kind: 'sales_propose',
    mailbox: 'alexander@asoldi.com',
    messageId: 'imap-already-wrote:write',
    salesClientId: client.id,
    from: 'marie-backfill@example.com',
    status: 'applied',
  });
  assert.equal(inboxAlreadyAnswered({
    id: 'imap-already-wrote',
    from: 'marie-backfill@example.com',
    mailAt: '2026-10-14T08:00:00.000Z',
  }, { items: inboxStore.listInboxItems(), sent: [], client }).reason, 'already-wrote');
  assert.equal(inboxAlreadyAnswered({
    id: 'imap-sent-after',
    from: 'marie-backfill@example.com',
    mailAt: '2026-10-14T08:00:00.000Z',
  }, {
    items: [],
    sent: [{ to: 'marie-backfill@example.com', mailAt: '2026-10-15T08:00:00.000Z' }],
    client,
  }).reason, 'outbound-after');

  inboxStore.markProcessed('alexander@asoldi.com', newer.id);
  const sent = [];
  const out = await backfillInboxReplies({
    apply: true,
    now,
    clients: [client],
    items: inboxStore.listInboxItems(),
    listImap: async () => ({ skipped: false, messages: [older, newer, other] }),
    listSent: async () => [],
    categorize: categorizeEmailHeuristic,
    sendEmail: async (mail) => { sent.push(mail); },
    queryBusy: async () => ({ busy: [] }),
  });
  assert.equal(out.results.find((row) => row.id === 'imap-backfill-old').reason, 'older-same-thread');
  assert.equal(out.results.find((row) => row.id === 'imap-backfill-other').reason, 'older-same-thread');
  assert.equal(sent.length, 1);
  assert.equal(out.results.find((row) => row.id === 'imap-backfill-new').wrote, true);
  assert.ok((sales.getSalesClientById(client.id).nextActions || []).some((row) => /Bot:/.test(row.note || '')));
});
