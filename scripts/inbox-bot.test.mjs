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
const { ingestInboxMessage, presentInboxForClient } = await import('../lib/inbox-bot/index.js');
const { buildContractPdf } = await import('../lib/offer-contract-pdf.js');
const { appendMediaToBank } = await import('../lib/client-media-store.js');
const { persistMediaFiles } = await import('../lib/ai-assistant/service.js');
const { normalizeNote } = await import('../lib/ai-assistant/gather.js');
const { extractAttachmentNames, collectGmailAttachmentParts, presentGmailMessage } = await import('../lib/gmail-readonly.js');
const { parseRfc822 } = await import('../lib/inbox-bot/mail-imap.js');

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
  process.env.INBOX_IMAP_DAMIAN_PASS = 'test-pass';
  let probedGmail = false;
  try {
    const source = await resolveMailboxSource('damian@asoldi.com', {
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
    delete process.env.INBOX_IMAP_DAMIAN_PASS;
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
