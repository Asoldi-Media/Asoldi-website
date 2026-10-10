import * as sales from '../../data/sales.js';
import { INBOX_BOT_MAILBOXES, listNewMailboxMessages } from './mail.js';
import { categorizeEmail } from './categorize.js';
import { matchSalesClient } from './match-client.js';
import { extractPdfText, pdfLooksLikeAsoldiContract } from './pdf-text.js';
import { inspectInboundContract } from './inspect-contract.js';
import { saveSignedContract } from './apply-contract.js';
import { fileClientElements } from './apply-elements.js';
import { appendInboxItem, isProcessed, markProcessed, pendingContractCount, presentInboxForClient } from './store.js';

export { presentInboxForClient, pendingContractCount } from './store.js';
export { resolveInboxContractPath } from './apply-contract.js';
export { replayStagedElements } from './apply-elements.js';
export { fingerprintPdfBuffer } from './inspect-contract.js';
export { INBOX_BOT_MAILBOXES };

const PDF_RE = /\.pdf$/i;

function pdfAttachments(message = {}) {
  return (message.attachments || []).filter((part) => {
    const name = part.filename || part.originalName || '';
    const mime = String(part.mimeType || '').toLowerCase();
    return PDF_RE.test(name) || mime.includes('pdf');
  });
}

export async function ingestInboxMessage(message = {}, { clients = sales.getSalesClients(), categorize = categorizeEmail } = {}) {
  const mailbox = String(message.mailbox || '').toLowerCase();
  const messageId = String(message.id || '');
  if (!mailbox || !messageId) return { skipped: true, reason: 'bad-message' };
  if (isProcessed(mailbox, messageId)) return { skipped: true, reason: 'already' };

  let pdfText = '';
  const pdfs = pdfAttachments(message);
  if (pdfs[0]?.buffer) pdfText = await extractPdfText(pdfs[0].buffer);

  const classified = await categorize({
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    attachmentNames: message.attachmentNames || (message.attachments || []).map((part) => part.filename),
    pdfText,
  });
  const asoldiPdf = Boolean(pdfs.length && pdfLooksLikeAsoldiContract(pdfText, pdfs[0].filename));
  if (asoldiPdf) classified.kind = 'signed_contract';

  const matched = matchSalesClient(clients, { from: message.from, match: classified.match });
  const salesClient = matched.client;
  markProcessed(mailbox, messageId);

  if (classified.kind === 'signed_contract') {
    const pdf = pdfs[0] || (message.attachments || [])[0];
    const inspection = await inspectInboundContract({
      buffer: pdf?.buffer,
      fileName: pdf?.filename,
      pdfText,
      emailText: `${message.subject || ''} ${message.text || ''}`,
      original: salesClient?.sentContractFingerprint || null,
      client: salesClient,
    });
    const row = saveSignedContract({
      salesClientId: salesClient?.id || '',
      mailbox,
      messageId,
      from: message.from,
      subject: message.subject,
      summary: inspection.summary || classified.summary,
      receivedAt: message.mailAt || new Date().toISOString(),
      originalName: pdf?.filename || 'kontrakt.pdf',
      buffer: pdf?.buffer,
      status: salesClient ? inspection.status : 'unmatched',
      signedVerdict: inspection.verdict,
      signedScore: inspection.score,
      signedReasons: inspection.reasons,
      inboundBytes: inspection.inboundBytes,
      originalBytes: inspection.originalBytes,
    });
    return { kind: 'signed_contract', item: row, salesClientId: salesClient?.id || '', inspection };
  }

  if (classified.kind === 'client_elements') {
    const files = (message.attachments || []).map((part) => ({
      originalName: part.filename,
      buffer: part.buffer,
      mimeType: part.mimeType,
    }));
    const row = await fileClientElements({
      salesClient,
      mailbox,
      messageId,
      from: message.from,
      subject: message.subject,
      summary: classified.summary,
      receivedAt: message.mailAt || new Date().toISOString(),
      text: message.text,
      files,
      elements: classified.elements,
    });
    return { kind: 'client_elements', item: row, salesClientId: salesClient?.id || '' };
  }

  const row = appendInboxItem({
    kind: classified.kind,
    mailbox,
    messageId,
    salesClientId: salesClient?.id || '',
    from: message.from,
    subject: message.subject,
    summary: classified.summary,
    receivedAt: message.mailAt || new Date().toISOString(),
    status: classified.kind === 'other' || !salesClient ? 'unmatched' : 'logged',
  });
  return { kind: classified.kind, item: row, salesClientId: salesClient?.id || '' };
}

let mailboxCursor = 0;
let inboxLoopRunning = false;

export async function tickInboxBot({ listMessages = listNewMailboxMessages, clients = sales.getSalesClients() } = {}) {
  if (inboxLoopRunning) return { skipped: true, reason: 'busy' };
  inboxLoopRunning = true;
  try {
    const mailbox = INBOX_BOT_MAILBOXES[mailboxCursor % INBOX_BOT_MAILBOXES.length];
    mailboxCursor += 1;
    const listed = await listMessages(mailbox, { isProcessed });
    if (listed.skipped) return { mailbox, skipped: true, reason: listed.reason, processed: 0 };
    let processed = 0;
    for (const message of listed.messages || []) {
      await ingestInboxMessage(message, { clients });
      processed += 1;
    }
    return { mailbox, skipped: false, reason: '', processed };
  } catch (error) {
    console.error('[inbox-bot] tick failed', error?.message || error);
    return { skipped: true, reason: error?.reason || 'tick-error', processed: 0 };
  } finally {
    inboxLoopRunning = false;
  }
}
