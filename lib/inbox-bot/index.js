import * as sales from '../../data/sales.js';
import { INBOX_BOT_MAILBOXES, listNewMailboxMessages } from './mail.js';
import { categorizeEmail } from './categorize.js';
import { matchSalesClient, parseEmailAddress } from './match-client.js';
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
import { classifyInboxWrite, freshReplyText, handleInboxWrite, inboxWriteBlob } from './write.js';
import { listImapRecentMessages, probeImapLogin } from './mail-imap.js';
import { createInboxTicker, ingestMessage } from '../../packages/suite/core/inbox/pipeline.js';

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
      text: freshReplyText(message.text),
      attachmentNames: message.attachmentNames || (message.attachments || []).map((part) => part.filename),
      pdfText,
    });
    const asoldiPdf = Boolean(pdfs.length && pdfLooksLikeAsoldiContract(pdfText, pdfs[0].filename));
    if (asoldiPdf) classified.kind = 'signed_contract';
    const matched = matchSalesClient(clients, { from: message.from, match: classified.match });
    const writeIntent = classifyInboxWrite(inboxWriteBlob(message), matched.client, { now });
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

function isSchedulingWrite(write = {}) {
  return Boolean(write?.cancel) || write?.intent === 'walk_away' || /^(sales_|workshop_)/.test(write?.intent || '');
}

/** Same sender, same “need a new time”: only the newest mail gets a reply. Older ones still file/log. */
export function markOlderSchedulingDuplicates(messages = [], { now = new Date() } = {}) {
  const skipIds = new Set();
  const seen = new Set();
  const newestFirst = [...messages].sort((left, right) => (
    Date.parse(right.mailAt || 0) - Date.parse(left.mailAt || 0)
  ));
  for (const message of newestFirst) {
    const from = parseEmailAddress(message.from);
    if (!from) continue;
    const when = Date.parse(message.mailAt);
    const write = classifyInboxWrite(inboxWriteBlob(message), {}, {
      now: Number.isFinite(when) ? new Date(when) : now,
    });
    if (!isSchedulingWrite(write)) continue;
    if (seen.has(from)) skipIds.add(String(message.id || ''));
    else seen.add(from);
  }
  return messages.map((message) => (
    skipIds.has(String(message.id || '')) ? { ...message, skipWrite: true } : message
  ));
}

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
  decideAi,
  interpretNote,
} = {}) {
  const writeOptsFor = ({ classified, matched }) => ({
    client: matched.client,
    message,
    classified,
    via: matched.via,
    confirmWorkshop,
    loadNeeds,
    queryBusy,
    sendEmail,
    upsert,
    now,
    decideAi,
  });
  return ingestMessage(message, {
    isProcessed,
    markProcessed,
    prepare: async () => {
      const pdfs = pdfAttachments(message);
      return { pdfs, pdfText: pdfs[0]?.buffer ? await extractPdfText(pdfs[0].buffer) : '' };
    },
    classify: async (_, { fresh, prepared }) => {
      const classified = await categorize({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: fresh,
        attachmentNames: message.attachmentNames || (message.attachments || []).map((part) => part.filename),
        pdfText: prepared.pdfText,
      });
      if (prepared.pdfs.length && pdfLooksLikeAsoldiContract(prepared.pdfText, prepared.pdfs[0].filename)) classified.kind = 'signed_contract';
      return classified;
    },
    match: (_, classified) => matchSalesClient(clients, { from: message.from, match: classified.match }),
    handlers: {
      signed_contract: (env) => fileSignedContract(env),
      client_elements: async (env) => {
        const { mailbox, messageId, classified, matched, fresh } = env;
        const salesClient = matched.client;
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
          text: fresh,
          files,
          elements: classified.elements,
          ...(interpretNote ? { interpret: interpretNote } : {}),
        });
        const write = message.skipWrite ? { wrote: false, reason: 'older-same-thread' } : await handleInboxWrite(writeOptsFor(env));
        return { kind: 'client_elements', item: row, write, salesClientId: salesClient?.id || '' };
      },
    },
    fallback: (env) => fileOtherMail(env, { writeOpts: writeOptsFor(env), interpretNote }),
  });
}

async function fileSignedContract({ message, mailbox, messageId, prepared, classified, matched }) {
  const salesClient = matched.client;
  const pdf = prepared.pdfs[0] || (message.attachments || [])[0];
  const inspection = await inspectInboundContract({
    buffer: pdf?.buffer,
    fileName: pdf?.filename,
    pdfText: prepared.pdfText,
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

async function fileOtherMail({ message, mailbox, messageId, classified, matched, fresh }, { writeOpts, interpretNote }) {
  const salesClient = matched.client;
  // Every client mail goes past the Kundedata filer; it files nothing when there are no facts.
  if (salesClient && matched.via === 'email' && fresh) {
    await fileClientElements({
      salesClient,
      mailbox,
      messageId: `${messageId}:facts`,
      from: message.from,
      subject: message.subject,
      summary: 'Fakta fra e-post',
      receivedAt: message.mailAt || new Date().toISOString(),
      text: fresh,
      files: [],
      elements: [],
      ...(interpretNote ? { interpret: interpretNote } : {}),
    });
  }

  if (message.skipWrite) {
    const row = appendInboxItem({
      kind: classified.kind,
      mailbox,
      messageId,
      salesClientId: salesClient?.id || '',
      from: message.from,
      subject: message.subject,
      summary: classified.summary || 'Eldre melding i samme tråd — hoppet over svar.',
      text: fresh,
      receivedAt: message.mailAt || new Date().toISOString(),
      status: 'skipped',
    });
    return { skipped: true, reason: 'older-same-thread', kind: classified.kind, item: row, salesClientId: salesClient?.id || '' };
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
    text: fresh,
    receivedAt: message.mailAt || new Date().toISOString(),
    status: classified.kind === 'other' || !salesClient ? 'unmatched' : 'logged',
  });
  return { kind: classified.kind, item: row, salesClientId: salesClient?.id || '' };
}

const tickMailboxes = createInboxTicker({ mailboxes: INBOX_BOT_MAILBOXES, logPrefix: '[inbox-bot]' });

export function tickInboxBot({ listMessages = listNewMailboxMessages, clients = sales.getSalesClients() } = {}) {
  return tickMailboxes({
    listMessages: (mailbox) => listMessages(mailbox, { isProcessed }),
    prepareBatch: (messages) => markOlderSchedulingDuplicates(messages),
    ingest: (message) => ingestInboxMessage(message, { clients }),
  });
}
