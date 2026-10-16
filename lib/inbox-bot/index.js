import * as sales from '../../data/sales.js';
import { INBOX_BOT_MAILBOXES, listNewMailboxMessages } from './mail.js';
import { categorizeEmail } from './categorize.js';
import { matchSalesClient } from './match-client.js';
import { extractPdfText, pdfLooksLikeAsoldiContract } from './pdf-text.js';
import { inspectInboundContract } from './inspect-contract.js';
import { saveSignedContract } from './apply-contract.js';
import { fileClientElements } from './apply-elements.js';
import {
  appendInboxItem,
  isProcessed,
  listRecentInboxItems,
  markProcessed,
  mailboxSource,
  pendingContractCount,
  presentInboxForClient,
  presentInboxItem,
} from './store.js';
import { confirmWorkshopAndMail, loadPrepNeedLines } from '../workshop-prep-send.js';
import { classifyInboxWrite, handleInboxWrite } from './write.js';
import { listImapRecentMessages, probeImapLogin } from './mail-imap.js';

export { presentInboxForClient, pendingContractCount } from './store.js';
export { resolveInboxContractPath } from './apply-contract.js';
export { replayStagedElements } from './apply-elements.js';
export { fingerprintPdfBuffer } from './inspect-contract.js';
export { INBOX_BOT_MAILBOXES };

const SECRET_KEY = /pass|password|secret|token|authorization/i;

export function stripSecrets(value, depth = 0) {
  if (value == null || depth > 8) return value;
  if (Array.isArray(value)) return value.map((row) => stripSecrets(row, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripSecrets(val, depth + 1);
  }
  return out;
}

function proposedDestination({ classified, matched, writeIntent, salesClient }) {
  if (classified?.kind === 'signed_contract') {
    return salesClient?.id ? `inbox-contracts/${salesClient.id}` : 'inbox-contracts/unmatched';
  }
  if (classified?.kind === 'client_elements') {
    const buckets = (classified.elements || []).map((row) => row.bucket).filter(Boolean);
    const reply = writeIntent?.intent && writeIntent.intent !== 'none' ? `; auto-reply:${writeIntent.intent}` : '';
    if (!salesClient) return `unmatched${reply}`;
    if (!salesClient.portalUserId) return `inbox-bot-staging${reply}`;
    return `${buckets.length ? `kundedata:${buckets.join(',')}` : 'kundedata:uncategorized'}${reply}`;
  }
  if (classified?.kind === 'edit_request') return 'log-only';
  if (writeIntent?.intent && writeIntent.intent !== 'none') return `auto-reply:${writeIntent.intent}`;
  return classified?.kind === 'other' ? 'log' : `log:${classified?.kind || 'other'}`;
}

export async function presentInboxBotStatus({
  probeLogin = probeImapLogin,
} = {}) {
  const mailboxes = await Promise.all(INBOX_BOT_MAILBOXES.map(async (mailbox) => {
    const probe = await probeLogin(mailbox);
    return {
      mailbox,
      configured: Boolean(probe.configured),
      ok: Boolean(probe.ok),
      reason: String(probe.reason || ''),
      source: mailboxSource(mailbox) || probe.source || '',
    };
  }));
  return stripSecrets({
    mailboxes,
    items: listRecentInboxItems(20).map(presentInboxItem),
  });
}

export async function peekInboxMailbox(mailbox = 'alexander@asoldi.com', {
  listImap = listImapRecentMessages,
  clients = sales.getSalesClients(),
  categorize = categorizeEmail,
  now = new Date(),
} = {}) {
  const email = String(mailbox || '').trim().toLowerCase();
  if (!INBOX_BOT_MAILBOXES.includes(email)) {
    return stripSecrets({ skipped: true, reason: 'mailbox-not-allowed', mailbox: email, messages: [] });
  }
  const listed = await listImap(email, { maxResults: 8 });
  if (listed.skipped) {
    return stripSecrets({
      skipped: true,
      reason: listed.reason || 'imap-not-configured',
      mailbox: email,
      messages: [],
    });
  }
  const messages = [];
  for (const message of listed.messages || []) {
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
    const writeIntent = classifyInboxWrite(`${message.subject || ''} ${message.text || ''}`, matched.client, { now });
    messages.push({
      id: message.id,
      mailbox: email,
      from: message.from,
      subject: message.subject,
      mailAt: message.mailAt,
      kind: classified.kind,
      summary: classified.summary,
      matchVia: matched.via || '',
      salesClientId: matched.client?.id || '',
      businessName: matched.client?.businessName || '',
      buckets: (classified.elements || []).map((row) => row.bucket).filter(Boolean),
      intent: writeIntent.intent || 'none',
      destination: proposedDestination({
        classified,
        matched,
        writeIntent,
        salesClient: matched.client,
      }),
      attachmentNames: (message.attachmentNames || []).slice(0, 12),
    });
  }
  return stripSecrets({
    skipped: false,
    reason: '',
    mailbox: email,
    messages,
  });
}

const PDF_RE = /\.pdf$/i;

function pdfAttachments(message = {}) {
  return (message.attachments || []).filter((part) => {
    const name = part.filename || part.originalName || '';
    const mime = String(part.mimeType || '').toLowerCase();
    return PDF_RE.test(name) || mime.includes('pdf');
  });
}

export async function ingestInboxMessage(message = {}, {
  clients = sales.getSalesClients(),
  categorize = categorizeEmail,
  confirmWorkshop = confirmWorkshopAndMail,
  loadNeeds = loadPrepNeedLines,
  queryBusy,
  sendEmail,
  upsert,
  now,
} = {}) {
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

  const writeOpts = {
    client: salesClient,
    message,
    classified,
    via: matched.via,
    confirmWorkshop,
    loadNeeds,
    queryBusy,
    sendEmail,
    upsert,
    now,
  };

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
    const write = await handleInboxWrite(writeOpts);
    return {
      kind: 'client_elements',
      item: row,
      write,
      salesClientId: salesClient?.id || '',
    };
  }

  const write = await handleInboxWrite(writeOpts);
  if (write?.wrote) {
    return {
      kind: write.kind || 'write',
      write,
      salesClientId: salesClient?.id || '',
    };
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
