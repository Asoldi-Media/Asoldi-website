import { decideInboundContract, fingerprintPdfBuffer, inspectInboundContract } from './inspect-contract.js';
import { findSignedContractBySha, saveSignedContract } from './apply-contract.js';
import { extractPdfText, findAsoldiContractPdf, isPdfAttachment } from './pdf-text.js';
import { freshReplyText } from './thread.js';
import { markClientSoldFromSignedContract } from '../sales-signed-contract.js';

/** Re:/SV:/Fwd: subjects are our own words coming back, so they never count as "the client says signed". */
const REPLY_SUBJECT_RE = /^\s*(?:re|sv|svar|vs|fw|fwd|aw|ang)(?:\[\d+\])?\s*:/i;

const SUMMARIES = {
  accepted: 'Signert kontrakt mottatt på e-post — markert Solgt.',
  already_signed: 'Kontrakt mottatt på e-post — kunden har allerede signert.',
  unsigned_other: 'PDF mottatt, men den ser ikke ut som en signert Asoldi-kontrakt.',
  'no-pdf': 'Kontrakt nevnt i e-posten, men ingen PDF er vedlagt — sjekk e-posten.',
  'not-asoldi-contract': 'PDF mottatt som kontrakt, men den ser ikke ut som en Asoldi-kontrakt — sjekk den.',
  'no-signature-block': 'PDF fra Asoldi mottatt, men siste side har ikke kundens signaturfelt (faktura, kvittering, vilkår eller signeringsbevis?) — sjekk den.',
  'not-client-address': 'Kontrakt mottatt fra en annen adresse enn kundens — sjekk før du markerer Solgt.',
  'not-awaiting-signature': 'Kontrakt mottatt før kortet er i Venter signering — sjekk før du markerer Solgt.',
  'mark-blocked': 'Signert kontrakt mottatt, men kortet kunne ikke markeres Solgt — sjekk Møte og Tilbud.',
};

function attachmentName(part = {}) {
  return String(part.filename || part.originalName || '');
}

/** The mail's contract PDF and its text: our contract wherever it sits in the mail, else the first PDF. */
async function pickContractPdf(prepared = {}, message = {}) {
  const candidates = Array.isArray(prepared.pdfs) ? prepared.pdfs : (message.attachments || []);
  const first = Array.isArray(prepared.pdfs) ? prepared.pdfs[0] : null;
  const found = await findAsoldiContractPdf(candidates, { first, firstText: prepared.pdfText });
  if (found) return found;
  const pdf = candidates.find((part) => part?.buffer?.length && isPdfAttachment({
    fileName: attachmentName(part),
    mimeType: part.mimeType,
    buffer: part.buffer,
  }));
  if (!pdf) return { pdf: null, text: '' };
  return { pdf, text: pdf === first && typeof prepared.pdfText === 'string' ? prepared.pdfText : await extractPdfText(pdf.buffer) };
}

/** The client's fresh reply, without the quoted thread. */
function freshBody(message = {}, fresh) {
  return typeof fresh === 'string' ? fresh : freshReplyText(message.text || '');
}

/** The client's own words only: the fresh reply plus a subject they wrote themselves. */
function clientWords(message = {}, fresh) {
  const subject = String(message.subject || '');
  return [REPLY_SUBJECT_RE.test(subject) ? '' : subject, freshBody(message, fresh)].filter(Boolean).join('\n');
}

function summaryFor({ status, reason }, inspection = {}, classified = {}) {
  if (status === 'unmatched') return inspection.summary || classified.summary || '';
  if (status === 'unsigned_copy') return inspection.isAsoldiContract ? inspection.summary : SUMMARIES.unsigned_other;
  return SUMMARIES[status] || SUMMARIES[reason] || inspection.summary || classified.summary || '';
}

function duplicateResult(item, salesClientId) {
  return {
    kind: 'signed_contract',
    item,
    salesClientId,
    inspection: {
      duplicate: true,
      verdict: item.signedVerdict || '',
      score: item.signedScore || 0,
      reasons: item.signedReasons || [],
      inboundBytes: item.inboundBytes || 0,
    },
    markedSold: false,
    status: item.status,
    reason: 'duplicate',
    duplicate: true,
  };
}

/**
 * Signed-contract handler for live intake: file the PDF on the card, and mark Solgt only when
 * decideInboundContract says every gate passed and the card really ticked. Never replies to the client.
 * The same PDF for the same client (e.g. the mail in both mailboxes) files once.
 */
export async function fileSignedContract({ message = {}, mailbox, messageId, prepared = {}, classified = {}, matched = {}, fresh } = {}) {
  const salesClient = matched?.client || null;
  const salesClientId = salesClient?.id || '';
  const { pdf, text: pdfText } = await pickContractPdf(prepared, message);
  const sha = pdf ? fingerprintPdfBuffer(pdf.buffer).sha256 : '';
  const earlier = findSignedContractBySha(salesClientId, sha);
  if (earlier) return duplicateResult(earlier, salesClientId);

  const inspection = await inspectInboundContract({
    buffer: pdf?.buffer,
    fileName: attachmentName(pdf || {}),
    pdfText,
    emailText: clientWords(message, fresh),
    original: salesClient?.sentContractFingerprint || null,
    client: salesClient,
  });
  const decision = decideInboundContract({ client: salesClient, matched, inspection });
  let { status, reason } = decision;
  let markedSold = false;
  if (decision.markSold) {
    const signed = markClientSoldFromSignedContract(salesClientId);
    markedSold = Boolean(signed?.progression?.contractSigned);
    if (!markedSold) {
      status = 'pending';
      reason = 'mark-blocked';
    }
  }
  const row = saveSignedContract({
    salesClientId,
    mailbox,
    messageId,
    from: message.from,
    subject: message.subject,
    text: freshBody(message, fresh),
    summary: summaryFor({ status, reason }, inspection, classified),
    receivedAt: message.mailAt || new Date().toISOString(),
    originalName: attachmentName(pdf || {}) || 'kontrakt.pdf',
    buffer: pdf?.buffer,
    status,
    reason,
    signedVerdict: inspection.verdict,
    signedScore: inspection.score,
    signedReasons: inspection.reasons,
    inboundBytes: inspection.inboundBytes,
    originalBytes: inspection.originalBytes,
    isAsoldiContract: Boolean(inspection.isAsoldiContract),
  });
  return { kind: 'signed_contract', item: row, salesClientId, inspection, markedSold, status: row.status, reason };
}
