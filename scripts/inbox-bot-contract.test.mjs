import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-inbox-contract-'));
delete process.env.DEEPSEEK_API_KEY;
delete process.env.GEMINI_API_KEY;

const sales = await import('../data/sales.js');
const offers = await import('../data/offers.js');
const salesOffers = await import('../data/sales-offers.js');
const { categorizeEmailHeuristic, mergeCategorize } = await import('../lib/inbox-bot/categorize.js');
const { findAsoldiContractPdf, isPdfAttachment, pdfLooksLikeAsoldiContract, textHasAsoldiOrgNumber } = await import('../lib/inbox-bot/pdf-text.js');
const {
  awaitingSignature,
  clientDateSignals,
  contractAlreadySigned,
  decideInboundContract,
  emailLooksSigned,
  fingerprintPdfBuffer,
  hasPreviewAcceptedContract,
  hasSignatureSignal,
  inspectInboundContract,
  lastPageItems,
  signatureAreaCues,
} = await import('../lib/inbox-bot/inspect-contract.js');
const { findSignedContractBySha, inboxContractDir, saveSignedContract } = await import('../lib/inbox-bot/apply-contract.js');
const { fileSignedContract } = await import('../lib/inbox-bot/file-contract.js');
const {
  backfillRecognizedSignedContracts,
  inboxItemShouldAutoAccept,
  markClientSoldFromSignedContract,
} = await import('../lib/sales-signed-contract.js');
const { ingestInboxMessage } = await import('../lib/inbox-bot/index.js');
const { listInboxItems, presentInboxForClient, updateInboxItem } = await import('../lib/inbox-bot/store.js');
const { inboxBotStage } = await import('../lib/inbox-bot/stage.js');
const { buildContractPdf, contractFileName, contractInputsForOffer } = await import('../lib/offer-contract-pdf.js');
const { clientWithOfferParty } = await import('../lib/offer-readiness.js');

const CONTRACT_NAME = 'Asoldi-kontrakt-Tier-1-Cafe-Nordlys.pdf';
/** The client's signature block with nothing written in it. */
const CLIENT_BLOCK = ['For kunden (Cafe Nordlys):', 'Signatur (Ola Nord):'];
const STAGES = {
  meeting: {},
  offer: { progression: { meetingHeld: true } },
  signature: { progression: { meetingHeld: true, offerSent: true } },
};

function pdfDoc(draw) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', autoFirstPage: false });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    draw(doc);
    doc.end();
  });
}

function pdfFromLines(lines) {
  return pdfDoc((doc) => {
    doc.addPage();
    for (const line of lines) doc.text(line);
  });
}

/** Same last-page layout as lib/offer-contract-pdf.js; `name`/`date` are what the client typed in their column. */
function contractPdf({ name = '', date = '', business = 'Cafe Nordlys', person = 'Ola Nord' } = {}) {
  return pdfDoc((doc) => {
    doc.addPage();
    doc.text('Tjenesteavtale mellom CHAPANA (Asoldi Marketing), org.nr. 934 327 497, og kunden.');
    doc.text('1. Omfang. 2. Pris. 3. Oppsigelse.');
    doc.addPage();
    doc.text('SIGNERING AV AVTALE OG OMFANG', 56, 60);
    doc.text('For CHAPANA (Asoldi Marketing):', 56, 140);
    doc.text('Signatur:', 56, 156);
    doc.text(`For kunden (${business}):`, 313, 140);
    doc.text(`Signatur (${person}):`, 313, 156);
    if (name) doc.text(name, 313, 185);
    doc.text('Dato: 01.10.26', 56, 226);
    doc.text(date ? `Dato: ${date}` : 'Dato: ____________', 313, 226);
  });
}

const signedPdf = () => contractPdf({ name: 'Ola Nord', date: '12.10.26' });
const unsignedPdf = () => contractPdf();

function seed(id, stage = 'meeting', extra = {}) {
  const email = `${id}@kunde.no`;
  const created = sales.createSalesClient({
    id,
    businessName: 'Cafe Nordlys',
    contactEmail: email,
    orgNumber: '123456789',
    product: 'asoldi',
  });
  return sales.updateSalesClient(created.id, {
    meetingAt: '2026-11-03T10:00:00.000Z',
    agreedTime: true,
    ...STAGES[stage],
    ...extra,
  });
}

/** A Venter signering card whose contract really went out: a sales offer, the sent PDF and its fingerprint. */
async function seedSentContract(id, { businessName = 'Bakeri Sol', contactPerson = 'Per Sol' } = {}) {
  sales.createSalesClient({ id, businessName, contactEmail: `${id}@kunde.no`, contactPerson, orgNumber: '123456789', product: 'asoldi' });
  sales.updateSalesClient(id, { progression: { meetingHeld: true, offerSent: true }, contractSentAt: '2026-10-20T10:00:00.000Z' });
  const offer = salesOffers.createSalesOffer({ salesClientId: id, tierId: 'tier-1-standard', ownerId: 'sales:rep-1' });
  salesOffers.markSalesOfferSent(offer.id, { to: `${id}@kunde.no`, sentContent: 'contract' });
  const client = sales.getSalesClientById(id);
  const sentOffer = salesOffers.getOfferForClient(id);
  const view = clientWithOfferParty(client, sentOffer, {});
  const sent = await buildContractPdf({ client: view, ...contractInputsForOffer(sentOffer, client), date: new Date('2026-10-20T10:00:00.000Z') });
  const fileName = contractFileName({ client: view, tierId: sentOffer.tierId });
  sales.recordSentContractFingerprint(id, fingerprintPdfBuffer(sent, fileName));
  return { client: sales.getSalesClientById(id), sent, fileName };
}

/** What a PDF viewer's "save" does: an incremental update appended to the file, `padBytes` larger. */
function incrementalSave(buffer, padBytes = 0) {
  const src = buffer.toString('latin1');
  const startxref = Number(src.match(/startxref\s+(\d+)\s+%%EOF\s*$/)[1]);
  const root = src.match(/\/Root\s+(\d+\s+\d+\s+R)/)[1];
  const size = Number(src.match(/\/Size\s+(\d+)/)[1]);
  const pad = padBytes ? `\n%${'x'.repeat(padBytes)}` : '';
  const objText = `\n${size} 0 obj\n<< /Producer (Viewer) >>\nendobj${pad}\n`;
  const objOffset = buffer.length + 1;
  const xrefOffset = buffer.length + Buffer.byteLength(objText, 'latin1');
  const xref = `xref\n0 1\n0000000000 65535 f \n${size} 1\n${String(objOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size + 1} /Root ${root} /Info ${size} 0 R /Prev ${startxref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([buffer, Buffer.from(objText + xref, 'latin1')]);
}

function progressionOf(id) {
  const client = sales.getSalesClientById(id);
  const p = client.progression || {};
  return {
    meetingHeld: Boolean(p.meetingHeld),
    offerSent: Boolean(p.offerSent),
    contractSigned: Boolean(p.contractSigned),
    contractSignedAt: client.contractSignedAt || '',
  };
}

function pdfPart(buffer, filename = CONTRACT_NAME, mimeType = 'application/pdf') {
  return { filename, mimeType, buffer };
}

/** fileSignedContract env as the inbox pipeline builds it (no pdfText, so the handler extracts it). */
function envFor(client, { buffer, filename = CONTRACT_NAME, from, mailbox = 'alexander@asoldi.com', id, text = 'Vedlagt.', subject = 'Kontrakt', via = 'email', fresh } = {}) {
  const pdfs = buffer ? [pdfPart(buffer, filename)] : [];
  return {
    message: {
      id,
      mailbox,
      from: from || client?.contactEmail || 'ukjent@x.no',
      subject,
      text,
      mailAt: '2026-10-30T08:00:00.000Z',
      attachments: pdfs,
    },
    mailbox,
    messageId: id,
    prepared: { pdfs },
    classified: { kind: 'signed_contract', summary: 'Kontrakt mottatt som PDF.' },
    matched: client ? { client, via } : { client: null, via: '' },
    fresh: fresh ?? text,
  };
}

function sendSpy() {
  const sent = [];
  return { sent, sendEmail: async (mail) => { sent.push(mail); return { sent: true }; } };
}

function ingest(message, opts = {}) {
  return ingestInboxMessage({
    mailAt: '2026-10-30T08:00:00.000Z',
    subject: 'Kontrakt',
    text: 'Vedlagt.',
    ...message,
    attachmentNames: (message.attachments || []).map((part) => part.filename),
  }, {
    clients: sales.getSalesClients(),
    queryBusy: async () => ({ busy: [] }),
    upsert: async () => ({}),
    now: new Date('2026-10-30T09:00:00.000Z'),
    ...opts,
  });
}

// --- detection -------------------------------------------------------------------------------

test('detection: only a PDF named Asoldi-kontrakt, or PDF text with our org number or CHAPANA, is our contract', () => {
  assert.equal(pdfLooksLikeAsoldiContract('', CONTRACT_NAME), true);
  assert.equal(pdfLooksLikeAsoldiContract('', 'asoldi kontrakt signert.PDF'), true);
  assert.equal(pdfLooksLikeAsoldiContract('Org.nr: 934 327 497 MVA', 'scan.pdf'), true);
  assert.equal(pdfLooksLikeAsoldiContract('For CHAPANA (Asoldi Marketing)', ''), true);
  // A Word file is never a contract PDF, whatever the name says.
  assert.equal(pdfLooksLikeAsoldiContract('', 'Asoldi-kontrakt.docx'), false);
  assert.equal(pdfLooksLikeAsoldiContract('', 'Tjenesteavtale-regnskap.docx'), false);
  // Generic words and receipts are not enough.
  assert.equal(pdfLooksLikeAsoldiContract('Tjenesteavtale - Telenor Bedrift', 'avtale-telenor.pdf'), false);
  assert.equal(pdfLooksLikeAsoldiContract('Service Agreement Microsoft 365', 'agreement.pdf'), false);
  assert.equal(pdfLooksLikeAsoldiContract('Kvittering. Mottaker: Asoldi Marketing. Beløp 500 kr', 'kvittering.pdf'), false);
  assert.equal(pdfLooksLikeAsoldiContract('Meny', 'tjenesteavtale-mal.pdf'), false);
  // The org number must stand alone.
  assert.equal(textHasAsoldiOrgNumber('Tlf 1934327497'), false);
  assert.equal(textHasAsoldiOrgNumber('9343274970'), false);
  assert.equal(textHasAsoldiOrgNumber('org 934327497.'), true);
});

test('detection: a PDF is known by its .pdf name, a pdf mime type or %PDF bytes', () => {
  assert.equal(isPdfAttachment({ fileName: 'a.PDF' }), true);
  assert.equal(isPdfAttachment({ fileName: 'Asoldi-kontrakt', mimeType: 'application/pdf' }), true);
  assert.equal(isPdfAttachment({ fileName: 'Asoldi-kontrakt', buffer: Buffer.from('%PDF-1.7 x') }), true);
  assert.equal(isPdfAttachment({ fileName: 'Asoldi-kontrakt.docx', buffer: Buffer.from('PK\u0003\u0004') }), false);
  assert.equal(pdfLooksLikeAsoldiContract('', 'Asoldi-kontrakt', { mimeType: 'application/pdf' }), true);
});

test('heuristic: Telenor Tjenesteavtale PDF, Tjenesteavtale.docx and an Asoldi Marketing receipt are not contracts', () => {
  const telenor = categorizeEmailHeuristic({
    subject: 'Spørsmål',
    text: 'Kan dere se på avtalen vi har i dag?',
    attachmentNames: ['avtale-telenor.pdf'],
    pdfText: 'Tjenesteavtale - Telenor Bedrift. Mobilabonnement for bedrift.',
  });
  assert.notEqual(telenor.kind, 'signed_contract');
  const docx = categorizeEmailHeuristic({ subject: 'Avtale', text: 'Til info', attachmentNames: ['Tjenesteavtale-regnskap.docx'] });
  assert.notEqual(docx.kind, 'signed_contract');
  const receipt = categorizeEmailHeuristic({
    subject: 'Betalt',
    text: 'Betalt forskudd',
    attachmentNames: ['kvittering.pdf'],
    pdfText: 'Kvittering for betaling. Mottaker: Asoldi Marketing. Beløp: 500 kr',
  });
  assert.notEqual(receipt.kind, 'signed_contract');
  const ours = categorizeEmailHeuristic({ subject: 'Avtale', text: 'Her', attachmentNames: [CONTRACT_NAME] });
  assert.equal(ours.kind, 'signed_contract');
});

test('mergeCategorize: an AI signed_contract without a contract PDF falls back to the heuristic kind', () => {
  const textOnly = categorizeEmailHeuristic({ subject: 'Re: Tilbud', text: 'Har ikke signert ennå, hva er bindingstiden?' });
  assert.equal(mergeCategorize(textOnly, { kind: 'signed_contract', summary: 'Kontrakt' }).kind, textOnly.kind);
  const menu = categorizeEmailHeuristic({ subject: 'Meny', text: 'Her er menyen', attachmentNames: ['meny.pdf'], pdfText: 'Pizza 189' });
  assert.equal(mergeCategorize(menu, { kind: 'signed_contract' }).kind, menu.kind);
  const ours = categorizeEmailHeuristic({ subject: 'Avtale', text: 'Her', attachmentNames: [CONTRACT_NAME] });
  assert.equal(mergeCategorize(ours, { kind: 'other' }).kind, 'signed_contract');
});

test('emailLooksSigned: negations and questions do not count as signed', () => {
  for (const text of [
    'ikke signert enda',
    'Har ikke signert ennå, hva er bindingstiden?',
    'usignert kopi',
    'unsigned',
    'not signed yet',
    "I haven't signed it",
    'Har dere signert?',
    'Skal den signeres?',
    'Vedlagt',
    'I signed up for the newsletter',
  ]) assert.equal(emailLooksSigned(text), false, text);
  for (const text of [
    'Vedlagt signert kontrakt',
    'Her er den signerte avtalen.',
    'Jeg har signert. Har dere mottatt den?',
    'Kontrakten er underskrevet',
    'Hei\nJeg har skrevet under nå',
    'Signed contract attached',
  ]) assert.equal(emailLooksSigned(text), true, text);
});

// --- signature area ----------------------------------------------------------------------------

test('signature area: the generated unsigned contract has no client writing, even with long names that wrap', async () => {
  for (const client of [
    { businessName: 'Cafe Nordlys', orgNumber: '123456789', contactPerson: 'Ola Nord', contactEmail: 'a@b.no', businessAddress: 'Gate 1' },
    {
      businessName: 'Frisør Kasal AS med et veldig langt navn som går over flere linjer',
      orgNumber: '987654321',
      contactPerson: 'Kari Elisabeth Nordmann-Hansen von Trondheimsfjorden',
      contactEmail: 'k@b.no',
      businessAddress: 'Storgata 100',
    },
    // A 104-character business name wraps "For kunden (…):" over four lines, across the Signatur line.
    {
      businessName: 'Norsk Rørleggerservice Vedlikehold Og Rehabilitering Av Bad Og Kjøkken I Trøndelag Og Møre Og Romsdal AS',
      orgNumber: '987654321',
      contactPerson: 'Per',
      contactEmail: 'p@b.no',
      businessAddress: 'Storgata 1',
    },
    // An 81-character signatory wraps "Signatur (…):" over three lines.
    {
      businessName: 'Cafe Nordlys AS',
      orgNumber: '987654321',
      contactPerson: 'Kari Elisabeth Nordmann-Hansen von Trondheimsfjorden og Lars Petter Johansen-Berg',
      contactEmail: 'k@b.no',
      businessAddress: 'Storgata 1',
    },
  ]) {
    const buffer = await buildContractPdf({ client, tierId: 'tier-1-standard', date: new Date('2026-10-01') });
    const page = await lastPageItems(buffer);
    const cues = signatureAreaCues(page.items, page);
    assert.equal(cues.extraCount, 0, `${client.businessName}: ${cues.extraText}`);
    assert.equal(cues.rightDateFilled, false);
    // What the client types under their Signatur line does count.
    const label = page.items.find((item) => /^For kunden/.test(item.str));
    const typed = signatureAreaCues([...page.items, { str: 'Ola Nord', x: label.x + 10, y: label.y - 60 }], page);
    assert.equal(typed.extraCount, 1);
    const dated = signatureAreaCues([...page.items, { str: 'Dato: 12.10.26', x: label.x, y: label.y - 90 }], page);
    assert.equal(dated.extraCount, 0);
    assert.equal(dated.rightDateFilled, true);
  }
});

test('signature area: text printed at the same spot on the contract we built never counts', () => {
  const items = [
    { str: 'For kunden (Cafe Nordlys):', x: 313, y: 692 },
    { str: 'Signatur (Ola Nord):', x: 313, y: 676 },
    { str: 'Cafe Nordlys AS avd. Sentrum', x: 330, y: 640 },
  ];
  assert.equal(signatureAreaCues(items).extraCount, 1);
  const template = [...items.slice(0, 2), { str: 'Cafe Nordlys AS avd. Sentrum', x: 330.5, y: 641 }, { str: 'Dato: 01.10.26', x: 56, y: 606 }];
  assert.equal(signatureAreaCues(items, { template }).extraCount, 0);
  // The client dating their column the same day as our printed date still counts as a filled date.
  const dated = signatureAreaCues([...items, { str: 'Dato: 01.10.26', x: 313, y: 606 }], { template });
  assert.equal(dated.rightDateFilled, true);
});

test('signature area: without the client label nothing counts, so an invoice total or a page number is not a signature', () => {
  const invoice = [
    { str: 'Faktura', x: 56, y: 770 },
    { str: 'Org.nr: 934 327 497 MVA', x: 56, y: 716 },
    { str: 'Fakturadato: 30.10.2026', x: 330, y: 716 },
    { str: 'Totalt å betale: 5 000,00', x: 360, y: 190 },
    { str: 'Dato: 30.10.2026', x: 360, y: 170 },
    { str: '8/8', x: 540, y: 14 },
  ];
  const cues = signatureAreaCues(invoice);
  assert.equal(cues.extraCount, 0, cues.extraText);
  assert.equal(cues.rightDateFilled, false);
  assert.equal(cues.clientBlock, false);
  // A scan has no text at all: unknown, so vision may still look.
  assert.equal(signatureAreaCues([]).clientBlock, null);
  assert.equal(signatureAreaCues([{ str: 'For kunden (Cafe Nordlys):', x: 313, y: 692 }]).clientBlock, true);
});

test('client date: Fakturadato, Forfallsdato and Betalingsdato are not "Dato:", and two dates need the client block', () => {
  assert.equal(clientDateSignals('Fakturadato: 30.10.2026 Forfallsdato: 13.11.2026').clientDateFilled, false);
  assert.equal(clientDateSignals('Betalingsdato: 30.10.2026 Bokføringsdato: 30.10.2026').clientDateFilled, false);
  assert.equal(clientDateSignals('Fakturadato: ____________').blankClientDate, false);
  assert.equal(clientDateSignals('Dato: 30.10.2026 Dato: 13.11.2026').clientDateFilled, false);
  assert.equal(clientDateSignals('For CHAPANA: Dato: 01.10.26 For kunden (Cafe Nordlys): Dato: 12.10.26').clientDateFilled, true);
  assert.equal(clientDateSignals('For kunden (Cafe Nordlys): Dato: 01.10.26 Dato: ____________').clientDateFilled, false);
  assert.equal(clientDateSignals('For kunden (Cafe Nordlys): Dato: 01.10.26 Dato: ____________').blankClientDate, true);
});

test('inspect: a typed name and date in the client column is likely signed with real signals; the blank copy is unsigned', async () => {
  const signed = await inspectInboundContract({ buffer: await signedPdf(), fileName: CONTRACT_NAME, emailText: 'Vedlagt', vision: false });
  assert.equal(signed.isAsoldiContract, true);
  assert.equal(signed.verdict, 'likely');
  assert.ok(signed.reasons.includes('right-bottom-writing'), signed.reasons.join(','));
  assert.ok(signed.reasons.includes('client-date-filled'), signed.reasons.join(','));
  assert.equal(hasSignatureSignal(signed), true);
  const blank = await inspectInboundContract({ buffer: await unsignedPdf(), fileName: CONTRACT_NAME, emailText: 'Vedlagt', vision: false });
  assert.equal(blank.verdict, 'unsigned');
  assert.ok(blank.reasons.includes('client-date-blank'));
});

// --- decideInboundContract ---------------------------------------------------------------------

test('decide: every gate, in order', () => {
  const signature = { id: 'decide-sig', progression: { meetingHeld: true, offerSent: true } };
  const likely = { isAsoldiContract: true, inboundBytes: 90000, verdict: 'likely', reasons: ['vision-signed-bottom'] };
  const email = (client) => ({ via: 'email', client });
  assert.equal(decideInboundContract({ client: null, matched: {}, inspection: likely }).status, 'unmatched');
  assert.deepEqual(decideInboundContract({ client: signature, matched: email(signature), inspection: likely }), { status: 'accepted', markSold: true, reason: 'signed' });
  const won = { ...signature, progression: { ...signature.progression, contractSigned: true } };
  assert.equal(decideInboundContract({ client: won, matched: email(won), inspection: likely }).status, 'already_signed');
  assert.equal(decideInboundContract({ client: signature, matched: email(signature), inspection: { ...likely, inboundBytes: 0 } }).reason, 'no-pdf');
  assert.equal(decideInboundContract({ client: signature, matched: email(signature), inspection: { ...likely, shaMatch: true } }).status, 'unsigned_copy');
  assert.equal(decideInboundContract({ client: signature, matched: email(signature), inspection: { ...likely, verdict: 'unsigned' } }).status, 'unsigned_copy');
  assert.equal(decideInboundContract({ client: signature, matched: email(signature), inspection: { ...likely, isAsoldiContract: false } }).reason, 'not-asoldi-contract');
  const offerStage = { id: 'decide-offer', progression: { meetingHeld: true } };
  assert.equal(decideInboundContract({ client: offerStage, matched: email(offerStage), inspection: likely }).reason, 'not-awaiting-signature');
  const meeting = { id: 'decide-meeting', progression: {} };
  assert.equal(decideInboundContract({ client: meeting, matched: email(meeting), inspection: likely }).reason, 'not-awaiting-signature');
  assert.equal(decideInboundContract({ client: signature, matched: email(signature), inspection: { ...likely, verdict: 'possible' } }).reason, 'possible');
  // Size and image counts alone never accept.
  const sizeOnly = { ...likely, reasons: ['much-larger-than-sent', 'many-images', 'email-says-signed'] };
  assert.equal(decideInboundContract({ client: signature, matched: email(signature), inspection: sizeOnly }).reason, 'no-signature-signal');
  // Vision saw a blank client line: a stray text item does not overrule it.
  const blankVision = { ...likely, reasons: ['right-bottom-writing', 'vision-blank-bottom'] };
  assert.equal(decideInboundContract({ client: signature, matched: email(signature), inspection: blankVision }).markSold, false);
  // A last page with text but no client signature block goes to a person, whatever the score.
  assert.deepEqual(
    decideInboundContract({ client: signature, matched: email(signature), inspection: { ...likely, clientBlock: false } }),
    { status: 'pending', markSold: false, reason: 'no-signature-block' },
  );
  assert.equal(decideInboundContract({ client: signature, matched: email(signature), inspection: { ...likely, clientBlock: null } }).markSold, true);
  // A contract send stamp counts as Venter signering.
  assert.equal(awaitingSignature({ contractSentAt: '2026-10-20T10:00:00.000Z' }), true);
  assert.equal(awaitingSignature({ progression: { meetingHeld: true } }), false);
});

test('decide: a client who signed on the preview is already signed, even when the card was unticked', () => {
  const client = seed('decide-preview', 'signature');
  const offer = offers.upsertPortalOffer({ salesClientId: client.id, salesOfferId: 'offer-decide-preview', targetEmail: client.contactEmail, contractHtml: '<p>x</p>' });
  assert.equal(contractAlreadySigned(client), false);
  offers.recordOfferAcceptance(offer.id, { email: client.contactEmail });
  assert.equal(contractAlreadySigned(client), true);
  assert.equal(hasPreviewAcceptedContract(''), false);
  const inspection = { isAsoldiContract: true, inboundBytes: 90000, verdict: 'likely', reasons: ['vision-signed-bottom'] };
  assert.equal(decideInboundContract({ client, matched: { via: 'email', client }, inspection }).status, 'already_signed');
});

// --- saveSignedContract ------------------------------------------------------------------------

test('saveSignedContract: no file name without bytes, keeps already_signed, dedupes by the PDF hash', async () => {
  const client = seed('save-rules', 'signature');
  const noFile = saveSignedContract({ salesClientId: client.id, mailbox: 'alexander@asoldi.com', messageId: 'm-nofile', status: 'pending' });
  assert.equal(noFile.fileName, '');
  assert.equal(noFile.filePath, '');
  const already = saveSignedContract({ salesClientId: client.id, messageId: 'm-already', status: 'already_signed', buffer: Buffer.from('%PDF-1.4 a') });
  assert.equal(already.status, 'already_signed');
  assert.equal(already.notified, false);
  assert.ok(already.fileName);
  const again = saveSignedContract({ salesClientId: client.id, messageId: 'm-already-2', status: 'pending', buffer: Buffer.from('%PDF-1.4 a') });
  assert.equal(again.duplicate, true);
  assert.equal(again.id, already.id);
  // Items filed before the hash was kept are matched on the saved file.
  const legacyName = 'old-scan-before-sha.pdf';
  writeFileSync(join(inboxContractDir(client.id), legacyName), Buffer.from('%PDF-1.4 legacy'));
  const legacy = saveSignedContract({ salesClientId: client.id, messageId: 'legacy', buffer: Buffer.from('%PDF-1.4 other') });
  updateInboxItem(legacy.id, { sha256: '', fileName: legacyName });
  assert.equal(findSignedContractBySha(client.id, createHash('sha256').update(Buffer.from('%PDF-1.4 legacy')).digest('hex'))?.id, legacy.id);
  // Another client's identical PDF is its own item.
  const other = seed('save-rules-other', 'signature');
  assert.equal(saveSignedContract({ salesClientId: other.id, messageId: 'm-o', buffer: Buffer.from('%PDF-1.4 a') }).duplicate, undefined);
});

// --- live intake: fileSignedContract ------------------------------------------------------------

test('Venter signering + genuinely signed contract from the client address → accepted and Solgt, without fastTrack', async () => {
  const client = seed('live-accept', 'signature');
  const result = await fileSignedContract(envFor(client, { buffer: await signedPdf(), id: 'm-accept' }));
  assert.equal(result.kind, 'signed_contract');
  assert.equal(result.status, 'accepted');
  assert.equal(result.markedSold, true);
  assert.equal(result.item.status, 'accepted');
  assert.equal(result.item.notified, false);
  const after = progressionOf(client.id);
  assert.equal(after.contractSigned, true);
  assert.ok(after.contractSignedAt);
  const inbox = presentInboxForClient(client.id);
  assert.equal(inbox.pendingContracts, 0);
  assert.ok(inbox.signed?.fileName);
  assert.ok(existsSync(join(process.env.APP_DATA_DIR, 'inbox-contracts', client.id, inbox.signed.fileName)));
});

test('no fastTrack: a card with only a contract-send stamp is not jumped past Møte/Tilbud', async () => {
  const client = seed('live-no-fasttrack', 'meeting', { contractSentAt: '2026-10-20T10:00:00.000Z' });
  const result = await fileSignedContract(envFor(client, { buffer: await signedPdf(), id: 'm-nofast' }));
  assert.equal(result.markedSold, false);
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'mark-blocked');
  assert.deepEqual(progressionOf(client.id), { meetingHeld: false, offerSent: false, contractSigned: false, contractSignedAt: '' });
  assert.equal(Boolean(markClientSoldFromSignedContract(client.id).progression?.contractSigned), false);
});

test('meeting-stage and Tilbud cards: a signed contract waits for a human, an unsigned one is a silent copy', async () => {
  for (const stage of ['meeting', 'offer']) {
    const client = seed(`live-${stage}`, stage);
    const before = progressionOf(client.id);
    const signed = await fileSignedContract(envFor(client, { buffer: await signedPdf(), id: `m-${stage}-signed` }));
    assert.equal(signed.status, 'pending', stage);
    assert.equal(signed.reason, 'not-awaiting-signature', stage);
    assert.equal(signed.markedSold, false, stage);
    const unsigned = await fileSignedContract(envFor(client, { buffer: await unsignedPdf(), id: `m-${stage}-unsigned` }));
    assert.equal(unsigned.status, 'unsigned_copy', stage);
    assert.deepEqual(progressionOf(client.id), before, stage);
    assert.equal(presentInboxForClient(client.id).signed, null, stage);
  }
});

test('unsigned copies never mark Solgt: identical to the sent PDF, or rebuilt with a blank client line', async () => {
  const client = seed('live-unsigned', 'signature');
  const sent = await unsignedPdf();
  sales.updateSalesClient(client.id, {
    sentContractFingerprint: { byteLength: sent.length, sha256: createHash('sha256').update(sent).digest('hex'), source: 'sent' },
  });
  const fresh = sales.getSalesClientById(client.id);
  const identical = await fileSignedContract(envFor(fresh, { buffer: sent, id: 'm-identical', text: 'Her er den signerte kontrakten.' }));
  assert.equal(identical.inspection.shaMatch, true);
  assert.equal(identical.status, 'unsigned_copy');
  const rebuilt = await fileSignedContract(envFor(fresh, { buffer: await contractPdf({ person: 'Ola  Nord' }), id: 'm-rebuilt' }));
  assert.equal(rebuilt.inspection.verdict, 'unsigned');
  assert.equal(rebuilt.status, 'unsigned_copy');
  assert.equal(progressionOf(client.id).contractSigned, false);
  assert.equal(presentInboxForClient(client.id).pendingContracts, 0);
});

test('possible → pending: the mail says signed but the PDF shows nothing at the bottom', async () => {
  const client = seed('live-possible', 'signature');
  const pdf = await pdfFromLines(['Tjenesteavtale', 'CHAPANA (Asoldi Marketing) 934 327 497', ...CLIENT_BLOCK]);
  const result = await fileSignedContract(envFor(client, { buffer: pdf, filename: 'skann.pdf', id: 'm-possible', text: 'Vedlagt signert kontrakt.' }));
  assert.equal(result.inspection.verdict, 'possible');
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'possible');
  assert.equal(result.item.notified, true);
  assert.equal(progressionOf(client.id).contractSigned, false);
  assert.equal(presentInboxForClient(client.id).signed, null);
});

test('only the fresh reply and a subject the client wrote count as "says signed"', async () => {
  const client = seed('live-fresh', 'signature');
  const pdf = await pdfFromLines(['CHAPANA (Asoldi Marketing) 934 327 497', ...CLIENT_BLOCK]);
  const quoted = await fileSignedContract(envFor(client, {
    buffer: pdf,
    filename: 'a.pdf',
    id: 'm-quoted',
    subject: 'Re: Signert kontrakt',
    text: 'Her er den.\n\n> Vedlagt signert kontrakt, send den tilbake',
    fresh: 'Her er den.',
  }));
  assert.equal(quoted.inspection.reasons.includes('email-says-signed'), false);
  assert.equal(quoted.status, 'unsigned_copy');
  const own = await fileSignedContract(envFor(client, {
    buffer: await pdfFromLines(['CHAPANA (Asoldi Marketing) 934 327 497', 'side 2', ...CLIENT_BLOCK]),
    filename: 'b.pdf',
    id: 'm-own-subject',
    subject: 'Signert kontrakt',
    text: 'Hei',
  }));
  assert.equal(own.inspection.reasons.includes('email-says-signed'), true);
});

test('not the client address: an AI-read hint, org or name match never marks Solgt', async () => {
  for (const via of ['hint', 'org', 'name']) {
    const client = seed(`live-via-${via}`, 'signature');
    const result = await fileSignedContract(envFor(client, { buffer: await signedPdf(), id: `m-via-${via}`, from: 'regnskap@byra.no', via }));
    assert.equal(result.status, 'pending', via);
    assert.equal(result.reason, 'not-client-address', via);
    assert.equal(progressionOf(client.id).contractSigned, false, via);
  }
});

test('preview-signed card: an emailed PDF is filed as already_signed, no notification, no second Solgt', async () => {
  const client = seed('live-preview', 'signature');
  const offer = offers.upsertPortalOffer({ salesClientId: client.id, salesOfferId: 'offer-live-preview', targetEmail: client.contactEmail, contractHtml: '<p>x</p>' });
  offers.recordOfferAcceptance(offer.id, { email: client.contactEmail });
  markClientSoldFromSignedContract(client.id);
  const signedAt = progressionOf(client.id).contractSignedAt;
  const preWorkshopBefore = sales.getSalesClientById(client.id).workshop?.deskEmails?.preWorkshopSentAt || '';
  assert.ok(signedAt);
  const result = await fileSignedContract(envFor(sales.getSalesClientById(client.id), { buffer: await signedPdf(), id: 'm-preview-mail' }));
  assert.equal(result.status, 'already_signed');
  assert.equal(result.markedSold, false);
  assert.equal(result.item.notified, false);
  assert.equal(presentInboxForClient(client.id).pendingContracts, 0);
  assert.equal(progressionOf(client.id).contractSignedAt, signedAt);
  assert.equal(sales.getSalesClientById(client.id).workshop?.deskEmails?.preWorkshopSentAt || '', preWorkshopBefore);
});

test('a third-party PDF or a text-only mail tagged signed_contract is never Solgt and shows no Signert pill', async () => {
  const client = seed('live-third-party', 'signature');
  const telenor = await pdfFromLines(['Tjenesteavtale - Telenor Bedrift', 'Mobilabonnement for bedrift', 'Pris 399 kr/mnd']);
  const third = await fileSignedContract(envFor(client, { buffer: telenor, filename: 'avtale-telenor.pdf', id: 'm-telenor', text: 'Vedlagt signert avtale.' }));
  assert.equal(third.inspection.isAsoldiContract, false);
  assert.notEqual(third.status, 'accepted');
  const textOnly = await fileSignedContract(envFor(client, { id: 'm-text-only', text: 'Har ikke signert ennå, hva er bindingstiden?' }));
  assert.equal(textOnly.status, 'pending');
  assert.equal(textOnly.reason, 'no-pdf');
  assert.equal(textOnly.item.fileName, '');
  assert.equal(progressionOf(client.id).contractSigned, false);
  assert.equal(presentInboxForClient(client.id).signed, null);
});

test('the same mail in both mailboxes files once and marks once', async () => {
  const client = seed('live-dup', 'signature');
  const pdf = await signedPdf();
  const first = await fileSignedContract(envFor(client, { buffer: pdf, id: 'imap:alexander@asoldi.com:uid:7', mailbox: 'alexander@asoldi.com' }));
  assert.equal(first.markedSold, true);
  const signedAt = progressionOf(client.id).contractSignedAt;
  const second = await fileSignedContract(envFor(sales.getSalesClientById(client.id), { buffer: pdf, id: 'imap:damian@asoldi.com:uid:3', mailbox: 'damian@asoldi.com' }));
  assert.equal(second.duplicate, true);
  assert.equal(second.markedSold, false);
  assert.equal(second.item.id, first.item.id);
  assert.equal(listInboxItems({ salesClientId: client.id, kind: 'signed_contract' }).length, 1);
  assert.equal(progressionOf(client.id).contractSignedAt, signedAt);
});

// --- live intake through ingestInboxMessage -------------------------------------------------------

test('ingest: Telenor Tjenesteavtale, a Tjenesteavtale.docx and an Asoldi Marketing receipt leave a meeting-stage card alone', async () => {
  const cases = [
    ['ingest-telenor', pdfPart(await pdfFromLines(['Tjenesteavtale - Telenor Bedrift', 'Kunden: Cafe Nordlys AS']), 'avtale-telenor.pdf')],
    ['ingest-docx', { filename: 'Tjenesteavtale-regnskap.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(5000, 7)]) }],
    ['ingest-receipt', pdfPart(await pdfFromLines(['Kvittering for betaling', 'Mottaker: Asoldi Marketing', 'Beløp: 500 kr']), 'kvittering.pdf')],
  ];
  for (const [id, part] of cases) {
    const client = seed(id, 'meeting');
    const before = progressionOf(client.id);
    const { sendEmail } = sendSpy();
    const result = await ingest({ id: `m-${id}`, mailbox: 'alexander@asoldi.com', from: client.contactEmail, text: 'Til info.', attachments: [part] }, { sendEmail });
    assert.notEqual(result.kind, 'signed_contract', id);
    assert.equal(listInboxItems({ salesClientId: client.id, kind: 'signed_contract' }).length, 0, id);
    assert.deepEqual(progressionOf(client.id), before, id);
  }
});

test('ingest: a signed contract on Venter signering is Solgt and the client gets no reply from the bot', async () => {
  const client = seed('ingest-accept', 'signature');
  const { sent, sendEmail } = sendSpy();
  const result = await ingest({
    id: 'm-ingest-accept',
    mailbox: 'alexander@asoldi.com',
    from: `Ola <${client.contactEmail}>`,
    subject: 'Signert kontrakt',
    text: 'Hei, her er den signerte kontrakten.',
    attachments: [pdfPart(await signedPdf())],
  }, { sendEmail });
  assert.equal(result.kind, 'signed_contract');
  assert.equal(result.markedSold, true);
  assert.equal(progressionOf(client.id).contractSigned, true);
  assert.equal(sent.length, 0);
});

test('ingest: an AI-read client address in a bookkeeper mail is a hint, not the client writing', async () => {
  const client = seed('ingest-hint', 'signature');
  const { sendEmail } = sendSpy();
  const result = await ingest({
    id: 'm-ingest-hint',
    mailbox: 'alexander@asoldi.com',
    from: 'regnskap@byra.no',
    text: `Signert avtale for ${client.contactEmail}.`,
    attachments: [pdfPart(await signedPdf())],
  }, {
    sendEmail,
    categorize: async () => ({ kind: 'signed_contract', summary: 'Kontrakt', match: { email: client.contactEmail }, elements: [], dueAt: '' }),
  });
  assert.equal(result.kind, 'signed_contract');
  assert.notEqual(result.status, 'accepted');
  assert.equal(progressionOf(client.id).contractSigned, false);
});

// --- review regressions --------------------------------------------------------------------------

/** An Asoldi invoice: meta top right, totals bottom right (the Fiken/Tripletex layout). */
const invoicePdf = () => pdfDoc((doc) => {
  doc.addPage();
  doc.fontSize(16).text('Faktura', 56, 60);
  doc.fontSize(10).text('CHAPANA', 56, 100);
  doc.text('Org.nr: 934 327 497 MVA', 56, 114);
  doc.text('Fakturanummer: 10023', 330, 100);
  doc.text('Fakturadato: 30.10.2026', 330, 114);
  doc.text('Forfallsdato: 13.11.2026', 330, 128);
  doc.text('Nettside oppstart', 56, 260);
  doc.text('Totalt å betale: 5 000,00', 360, 640);
  doc.text('Kontonummer: 1234.56.78901', 360, 656);
});

/** A bank receipt for a payment to CHAPANA, the amount bottom right. */
const receiptPdf = () => pdfDoc((doc) => {
  doc.addPage();
  doc.fontSize(14).text('Kvittering', 56, 60);
  doc.fontSize(10).text('Mottaker: CHAPANA', 56, 100);
  doc.text('Betalingsdato: 30.10.2026', 56, 114);
  doc.text('Bokføringsdato: 30.10.2026', 56, 128);
  doc.text('Beløp: 5 000,00 kr', 330, 620);
});

/** asoldi.com/vilkar printed from a browser: 8 pages, the page number bottom right. */
const printedTermsPdf = () => pdfDoc((doc) => {
  for (let page = 1; page <= 8; page += 1) {
    doc.addPage();
    doc.fontSize(8).text('30.10.2026, 10:12', 20, 12).text('Vilkår | Asoldi', 260, 12);
    doc.fontSize(10);
    if (page === 1) doc.text('Disse vilkårene gjelder for Asoldi Markedsføring (drevet under foretaket CHAPANA, org.nr. 934 327 497).', 56, 60, { width: 480 });
    doc.text(`${page}. ${'Vilkår for nettside og markedsføring. '.repeat(40)}`, 56, 120, { width: 480 });
    doc.fontSize(8).text('https://asoldi.com/vilkar', 20, 820).text(`${page}/8`, 540, 820);
  }
});

test('ingest: an Asoldi invoice, a CHAPANA receipt or printed Vilkår never marks a Venter signering card Solgt', async () => {
  const cases = [
    ['invoice', invoicePdf, 'Faktura-10023.pdf', 'Hei, her er signert avtale, og fakturaen er betalt.'],
    ['receipt', receiptPdf, 'kvittering.pdf', 'Betalt i dag, kvittering vedlagt.'],
    ['terms', printedTermsPdf, 'Vilkår _ Asoldi.pdf', 'Hei, jeg har skrevet ut vilkårene (vedlagt). Hva betyr punkt 4 om bindingstid?'],
  ];
  for (const [label, make, filename, text] of cases) {
    const { client } = await seedSentContract(`review-${label}`);
    const { sent, sendEmail } = sendSpy();
    const result = await ingest({
      id: `m-review-${label}`,
      mailbox: 'alexander@asoldi.com',
      from: `Per <${client.contactEmail}>`,
      subject: 'Betaling',
      text,
      attachments: [pdfPart(await make(), filename)],
    }, { sendEmail });
    assert.equal(result.kind, 'signed_contract', label);
    assert.equal(result.status, 'pending', label);
    assert.equal(result.reason, 'no-signature-block', label);
    assert.ok(result.inspection.reasons.includes('no-client-block'), `${label}: ${result.inspection.reasons.join(',')}`);
    assert.equal(hasSignatureSignal(result.inspection), false, `${label}: ${result.inspection.reasons.join(',')}`);
    assert.match(result.item.summary, /ikke kundens signaturfelt/, label);
    assert.equal(progressionOf(client.id).contractSigned, false, label);
    assert.equal(sent.length, 0, label);
    // The backfill reads the stored reasons and never accepts it either.
    assert.equal(inboxItemShouldAutoAccept(result.item, sales.getSalesClientById(client.id)), false, label);
  }
});

test('a returned blank contract whose 104-character name wraps in the label is not accepted, even after a rename', async () => {
  const longName = 'Norsk Rørleggerservice Vedlikehold Og Rehabilitering Av Bad Og Kjøkken I Trøndelag Og Møre Og Romsdal AS';
  for (const rename of ['', 'Norsk Rørleggerservice AS']) {
    const id = `review-wrap-${rename ? 'renamed' : 'same'}`;
    const { client: seeded, sent, fileName } = await seedSentContract(id, { businessName: longName, contactPerson: 'Per' });
    // Renamed after the send: the rebuilt template no longer hides the wrapped label lines.
    const client = rename ? sales.updateSalesClient(id, { businessName: rename }) : seeded;
    const returned = incrementalSave(sent, Math.round(sent.length * 0.09));
    const result = await fileSignedContract(envFor(client, { buffer: returned, filename: fileName, id: `m-${id}`, text: 'Signert og klar.' }));
    assert.equal(result.inspection.reasons.includes('right-bottom-writing'), false, `${id}: ${result.inspection.reasons.join(',')}`);
    assert.notEqual(result.status, 'accepted', id);
    assert.equal(progressionOf(id).contractSigned, false, id);
  }
});

test('a signed contract that is not the first PDF in the mail is found, inspected and filed', async () => {
  const menu = await pdfFromLines(['Meny: Kaffe 35 kr, Bolle 30 kr']);
  const signed = await signedPdf();
  const named = await findAsoldiContractPdf([pdfPart(menu, 'meny.pdf'), pdfPart(signed)]);
  assert.equal(named.pdf.filename, CONTRACT_NAME);
  const byText = await findAsoldiContractPdf([pdfPart(menu, 'meny.pdf'), pdfPart(signed, 'scan.pdf')]);
  assert.equal(byText.pdf.filename, 'scan.pdf');
  assert.match(byText.text, /934 327 497/);
  const docx = { filename: 'Asoldi-kontrakt.docx', mimeType: 'application/msword', buffer: Buffer.from('PK\u0003\u0004') };
  assert.equal(await findAsoldiContractPdf([pdfPart(menu, 'meny.pdf'), docx]), null);
  // The first PDF's text from prepare is reused as it is.
  const first = pdfPart(menu, 'scan.pdf');
  assert.equal((await findAsoldiContractPdf([first], { first, firstText: 'CHAPANA 934 327 497' }))?.pdf, first);

  const client = seed('review-second-pdf', 'signature');
  const env = envFor(client, { buffer: menu, filename: 'meny.pdf', id: 'm-second-pdf', text: 'Her er signert kontrakt og menyen.' });
  env.prepared.pdfs.push(pdfPart(signed, 'scan.pdf'));
  const result = await fileSignedContract(env);
  assert.equal(result.status, 'accepted');
  assert.match(result.item.fileName, /scan\.pdf$/);
  assert.equal(progressionOf(client.id).contractSigned, true);
});

test('the contract item keeps the client\'s fresh words, in Venter signering and in Solgt', async () => {
  const { client: waiting, sent } = await seedSentContract('review-words-copy');
  const copy = await fileSignedContract(envFor(waiting, {
    buffer: sent,
    id: 'm-words-copy',
    text: 'Hei! Her er kontrakten signert. Når starter vi?\n\n> Vedlagt kontrakten',
    fresh: 'Hei! Her er kontrakten signert. Når starter vi?',
  }));
  assert.equal(copy.status, 'unsigned_copy');
  assert.equal(copy.item.text, 'Hei! Her er kontrakten signert. Når starter vi?');
  const signedClient = seed('review-words-signed', 'signature');
  const workshop = 'Her er signert kontrakt. Kan vi ta workshopen fredag kl 10 i stedet for torsdag?';
  const signed = await fileSignedContract(envFor(signedClient, { buffer: await signedPdf(), id: 'm-words-signed', text: workshop }));
  assert.equal(signed.status, 'accepted');
  assert.equal(signed.item.text, workshop);
  const won = seed('review-words-won', 'signature');
  sales.setSalesProgress(won.id, 'contractSigned', true);
  const again = 'Her er kontrakten igjen. Vi kan ikke på workshopen torsdag, kan vi ta fredag kl 10?';
  const copyWon = await fileSignedContract(envFor(sales.getSalesClientById(won.id), { buffer: await signedPdf(), id: 'm-words-won', text: again }));
  assert.equal(copyWon.status, 'already_signed');
  assert.equal(copyWon.item.text, again);
});

test('portal or preview acceptance marks Solgt with fastTrack on a card without Møte/Tilbud; an emailed PDF never jumps', async () => {
  const client = seed('review-portal-accept', 'meeting');
  // "Gi tilbud" → "Opprett tilbud" (POST /api/admin/sales/offers) ticks nothing on the card.
  const offer = offers.createOffer({
    ownerId: 'sales:rep-1',
    salesClientId: client.id,
    planId: 'tier-1-standard',
    planName: 'Tier 1',
    price: 990,
    businessName: 'Cafe Nordlys',
    targetEmail: client.contactEmail,
  });
  offers.recordOfferAcceptance(offer.id, { userId: 'u1', email: client.contactEmail });
  assert.equal(Boolean(markClientSoldFromSignedContract(client.id).progression?.contractSigned), false);
  const signed = markClientSoldFromSignedContract(client.id, { fastTrack: true });
  assert.equal(Boolean(signed.progression?.contractSigned), true);
  const after = progressionOf(client.id);
  assert.equal(after.meetingHeld, true);
  assert.equal(after.offerSent, true);
  assert.ok(after.contractSignedAt);
  assert.equal(inboxBotStage(sales.getSalesClientById(client.id)), 'won');
  // The emailed-PDF path still has no fastTrack (see 'no fastTrack: a card with only a contract-send stamp …').
  const stamped = seed('review-portal-email', 'meeting', { contractSentAt: '2026-10-20T10:00:00.000Z' });
  const emailed = await fileSignedContract(envFor(stamped, { buffer: await signedPdf(), id: 'm-review-portal-email' }));
  assert.equal(emailed.markedSold, false);
  assert.equal(progressionOf(stamped.id).meetingHeld, false);
});

test('preview acceptance with a user id stamps kundeprofil on the sales card', async () => {
  const client = seed('review-bf-portal-user', 'meeting');
  const offer = offers.upsertPortalOffer({
    salesClientId: client.id,
    salesOfferId: 'offer-review-bf-portal-user',
    targetEmail: client.contactEmail,
    contractHtml: '<p>x</p>',
  });
  offers.recordOfferAcceptance(offer.id, { userId: 'portal-user-1', email: client.contactEmail });
  const dry = await backfillRecognizedSignedContracts({ apply: false });
  const row = dry.results.find((entry) => entry.id === client.id && entry.source === 'preview');
  assert.equal(row.needsPortal, true);
  await backfillRecognizedSignedContracts({ apply: true });
  const live = sales.getSalesClientById(client.id);
  assert.equal(live.portalUserId, 'portal-user-1');
  assert.ok(live.portalConnectedAt);
});

test('backfill: a preview acceptance on a card without Møte/Tilbud ticks is marked Solgt with fastTrack', async () => {
  const client = seed('review-bf-preview', 'meeting');
  const offer = offers.upsertPortalOffer({ salesClientId: client.id, salesOfferId: 'offer-review-bf-preview', targetEmail: client.contactEmail, contractHtml: '<p>x</p>' });
  offers.recordOfferAcceptance(offer.id, { email: client.contactEmail });
  const dry = await backfillRecognizedSignedContracts({ apply: false });
  const row = dry.results.find((entry) => entry.id === client.id && entry.source === 'preview');
  assert.equal(row.needsSold, true);
  assert.equal(row.blocked, undefined);
  assert.equal(progressionOf(client.id).contractSigned, false);
  await backfillRecognizedSignedContracts({ apply: true });
  assert.equal(progressionOf(client.id).contractSigned, true);
  assert.equal(inboxBotStage(sales.getSalesClientById(client.id)), 'won');
});

// --- backfill ----------------------------------------------------------------------------------

test('backfill uses the same gates: stage, verdict, signal, address and Asoldi check', async () => {
  const meeting = seed('bf-meeting', 'meeting');
  await fileSignedContract(envFor(meeting, { buffer: await signedPdf(), id: 'bf-m-meeting' }));
  const unsigned = seed('bf-unsigned', 'signature');
  await fileSignedContract(envFor(unsigned, { buffer: await unsignedPdf(), id: 'bf-m-unsigned' }));
  const menuClient = seed('bf-menu', 'meeting');
  await fileSignedContract(envFor(menuClient, { buffer: await pdfFromLines(['Meny', 'Pizza 189', 'Burger 169']), filename: 'meny.pdf', id: 'bf-m-menu' }));
  const bookkeeper = seed('bf-bookkeeper', 'signature');
  await fileSignedContract(envFor(bookkeeper, { buffer: await signedPdf(), id: 'bf-m-bookkeeper', from: 'regnskap@byra.no', via: 'org' }));
  // A legacy item without isAsoldiContract: a Word file with a "likely" verdict stays out.
  const legacy = seed('bf-legacy', 'signature');
  const legacyItem = saveSignedContract({
    salesClientId: legacy.id,
    messageId: 'bf-m-legacy',
    from: legacy.contactEmail,
    originalName: 'Tjenesteavtale-regnskap.docx',
    buffer: Buffer.alloc(5000, 7),
    status: 'pending',
    signedVerdict: 'likely',
    signedReasons: ['right-bottom-writing'],
    inboundBytes: 5000,
  });
  assert.equal(inboxItemShouldAutoAccept(legacyItem, legacy), false);

  const dry = await backfillRecognizedSignedContracts({ apply: false });
  const ids = new Set(dry.results.filter((row) => row.source === 'inbox').map((row) => row.id));
  for (const client of [meeting, unsigned, menuClient, bookkeeper, legacy]) assert.equal(ids.has(client.id), false, client.id);
  await backfillRecognizedSignedContracts({ apply: true });
  for (const client of [meeting, unsigned, menuClient, bookkeeper, legacy]) {
    assert.equal(progressionOf(client.id).contractSigned, false, client.id);
  }
  assert.equal(progressionOf(meeting.id).meetingHeld, false);
});

test('backfill accepts a pending genuinely signed contract once the card reaches Venter signering', async () => {
  const client = seed('bf-later', 'offer');
  const filed = await fileSignedContract(envFor(client, { buffer: await signedPdf(), id: 'bf-m-later' }));
  assert.equal(filed.reason, 'not-awaiting-signature');
  assert.equal(inboxItemShouldAutoAccept(filed.item, sales.getSalesClientById(client.id)), false);
  sales.updateSalesClient(client.id, { progression: { meetingHeld: true, offerSent: true } });
  const item = listInboxItems({ salesClientId: client.id, kind: 'signed_contract' })[0];
  assert.equal(inboxItemShouldAutoAccept(item, sales.getSalesClientById(client.id)), true);
  const dry = await backfillRecognizedSignedContracts({ apply: false });
  assert.ok(dry.results.some((row) => row.id === client.id && row.source === 'inbox' && row.needsSold));
  await backfillRecognizedSignedContracts({ apply: true });
  assert.equal(progressionOf(client.id).contractSigned, true);
  assert.equal(listInboxItems({ salesClientId: client.id, kind: 'signed_contract' })[0].status, 'accepted');
  assert.ok(presentInboxForClient(client.id).signed?.fileName);
});
