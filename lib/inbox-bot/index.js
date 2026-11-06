import * as sales from '../../data/sales.js';
import { INBOX_BOT_MAILBOXES, listNewMailboxMessages } from './mail.js';
import { categorizeEmail } from './categorize.js';
import { matchSalesClient, parseEmailAddress } from './match-client.js';
import { extractPdfText, pdfLooksLikeAsoldiContract } from './pdf-text.js';
import { fileSignedContract } from './file-contract.js';
import { lastPageItems } from './inspect-contract.js';
import { fileClientElements } from './apply-elements.js';
import {
  appendInboxItem,
  isProcessed,
  listInboxItems,
  listRecentInboxItems,
  markProcessed,
  mailboxSource,
  pendingContractCount,
  presentInboxForClient,
  presentInboxItem,
} from './store.js';
import { confirmWorkshopAndMail, loadPrepNeedLines } from '../workshop-prep-send.js';
import { forwardedBodyText } from './thread.js';
import { classifyInboxWrite, freshReplyText, handleInboxWrite, inboxWriteBlob, isAutomatedMail } from './write.js';
import { listImapRecentMessages, listImapSentHeaders, probeImapLogin } from './mail-imap.js';
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

/**
 * The sales client the sender's address belongs to, or ''. Only for the categorize call's ledger row: the
 * full match (with the categorizer's org number and name hints) still runs after categorizing.
 */
function senderClientId(clients, message = {}) {
  try {
    return String(matchSalesClient(clients, { from: message.from, match: {} }).client?.id || '');
  } catch {
    return '';
  }
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
      salesClientId: senderClientId(clients, message),
    });
    const asoldiPdf = Boolean(pdfs.length && pdfLooksLikeAsoldiContract(pdfText, pdfs[0].filename));
    if (asoldiPdf) classified.kind = 'signed_contract';
    const matched = matchSalesClient(clients, { from: message.from, match: classified.match });
    const automated = isAutomatedMail(message);
    const writeIntent = automated
      ? { intent: 'none' }
      : classifyInboxWrite(inboxWriteBlob(message), matched.client, { now });
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
      destination: automated ? 'log:automated' : proposedDestination({
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

function addressesFromHeader(value = '') {
  return String(value || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
}

function classifyMessageWrite(message, { now = new Date(), clients } = {}) {
  const matched = matchSalesClient(clients || sales.getSalesClients(), { from: message.from, match: {} });
  const when = Date.parse(message.mailAt);
  return classifyInboxWrite(inboxWriteBlob(message), matched.client || {}, {
    now: Number.isFinite(when) ? new Date(when) : now,
  });
}

/** A later human mail from that sender. Calendar/reminder echoes do not count. */
function countsAsLaterInbound(message, opts) {
  if (isAutomatedMail(message)) return false;
  const classified = classifyMessageWrite(message, opts);
  if (classified.echo) return false;
  return classified.intent !== 'none' || Boolean(freshReplyText(message.text));
}

/** Same sender, later inbound in this batch: skip the older write (scheduling or not). */
export function markOlderSameSenderDuplicates(messages = [], { now = new Date(), clients } = {}) {
  const skipIds = new Set();
  const seen = new Set();
  const newestFirst = [...messages].sort((left, right) => (
    Date.parse(right.mailAt || 0) - Date.parse(left.mailAt || 0)
  ));
  for (const message of newestFirst) {
    const from = parseEmailAddress(message.from);
    if (!from || !countsAsLaterInbound(message, { now, clients })) continue;
    if (seen.has(from)) skipIds.add(String(message.id || ''));
    else seen.add(from);
  }
  return messages.map((message) => (
    skipIds.has(String(message.id || '')) || message.skipWrite
      ? { ...message, skipWrite: true }
      : message
  ));
}

export function inboxAlreadyIngested(message = {}, items = []) {
  const id = String(message.id || '');
  if (!id) return false;
  return items.some((item) => {
    const mid = String(item.messageId || '');
    return mid === id || mid.startsWith(`${id}:`);
  });
}

export function inboxAlreadyAnswered(message = {}, { items = [], sent = [], client } = {}) {
  const id = String(message.id || '');
  if (items.some((item) => (
    item.messageId === `${id}:write`
    && (item.status === 'applied' || /^(gather|write|sales_|workshop_|walk_away)/.test(item.kind || ''))
  ))) {
    return { answered: true, reason: 'already-wrote' };
  }
  const inboundAt = Date.parse(message.mailAt);
  const targets = new Set([
    parseEmailAddress(message.from),
    parseEmailAddress(client?.contactEmail),
  ].filter(Boolean));
  if (targets.size && sent.some((row) => {
    const at = Date.parse(row.mailAt);
    if (!Number.isFinite(at) || !Number.isFinite(inboundAt) || at <= inboundAt) return false;
    return addressesFromHeader(row.to).some((email) => targets.has(email));
  })) {
    return { answered: true, reason: 'outbound-after' };
  }
  return { answered: false, reason: '' };
}

/** Same sender, same “need a new time”: only the newest mail gets a reply. Older ones still file/log. */
export function markOlderSchedulingDuplicates(messages = [], { now = new Date(), clients } = {}) {
  const skipIds = new Set();
  const seen = new Set();
  const newestFirst = [...messages].sort((left, right) => (
    Date.parse(right.mailAt || 0) - Date.parse(left.mailAt || 0)
  ));
  for (const message of newestFirst) {
    const from = parseEmailAddress(message.from);
    if (!from || !countsAsLaterInbound(message, { now, clients })) continue;
    const write = classifyMessageWrite(message, { now, clients });
    if (!isSchedulingWrite(write)) continue;
    if (seen.has(from)) skipIds.add(String(message.id || ''));
    else seen.add(from);
  }
  return messages.map((message) => (
    skipIds.has(String(message.id || '')) ? { ...message, skipWrite: true } : message
  ));
}

/** Older question/info mail: skip when a newer mail from the same sender is in this batch. Keep older reschedules. */
function markOlderNonSchedulingDuplicates(messages = [], opts = {}) {
  const skipIds = new Set();
  const seen = new Set();
  const newestFirst = [...messages].sort((left, right) => (
    Date.parse(right.mailAt || 0) - Date.parse(left.mailAt || 0)
  ));
  for (const message of newestFirst) {
    const from = parseEmailAddress(message.from);
    if (!from || !countsAsLaterInbound(message, opts)) continue;
    if (seen.has(from)) {
      if (!isSchedulingWrite(classifyMessageWrite(message, opts))) skipIds.add(String(message.id || ''));
    } else seen.add(from);
  }
  return messages.map((message) => (
    skipIds.has(String(message.id || '')) || message.skipWrite
      ? { ...message, skipWrite: true }
      : message
  ));
}

/** A later "ja det passer" retracts an older cancel in the same batch, without dropping a reschedule for a side note. */
function markOlderRetractedByNewerEcho(messages = [], opts = {}) {
  const newest = new Map();
  for (const message of messages) {
    const from = parseEmailAddress(message.from);
    if (!from || isAutomatedMail(message)) continue;
    const at = Date.parse(message.mailAt) || 0;
    const cur = newest.get(from);
    if (!cur || at > cur.at) newest.set(from, { at, message });
  }
  const skipIds = new Set();
  for (const [from, row] of newest) {
    if (!classifyMessageWrite(row.message, opts).echo) continue;
    for (const message of messages) {
      if (parseEmailAddress(message.from) !== from || String(message.id || '') === String(row.message.id || '')) continue;
      if (isSchedulingWrite(classifyMessageWrite(message, opts))) skipIds.add(String(message.id || ''));
    }
  }
  return messages.map((message) => (
    skipIds.has(String(message.id || '')) || message.skipWrite
      ? { ...message, skipWrite: true }
      : message
  ));
}

function pdfAttachments(message = {}) {
  return (message.attachments || []).filter((part) => {
    const name = part.filename || part.originalName || '';
    const mime = String(part.mimeType || '').toLowerCase();
    return PDF_RE.test(name) || mime.includes('pdf');
  });
}

function salesClientsOf(clients) {
  return typeof clients === 'function' ? clients() : clients;
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
  moveMeeting,
  voidMeeting,
  realNow,
  backfill = false,
  force = false,
} = {}) {
  const list = salesClientsOf(clients);
  const mailMs = Date.parse(message.mailAt);
  const fallbackMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const origin = new Date(Number.isFinite(mailMs) ? mailMs : (Number.isFinite(fallbackMs) ? fallbackMs : Date.now()));
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
    now: origin,
    decideAi,
    backfill: Boolean(backfill),
    ...(realNow || now ? { realNow: realNow || now } : {}),
    ...(moveMeeting ? { moveMeeting } : {}),
    ...(voidMeeting ? { voidMeeting } : {}),
  });
  return ingestMessage(message, {
    isProcessed: force ? () => false : isProcessed,
    markProcessed,
    prepare: async () => {
      const pdfs = pdfAttachments(message);
      let pdfText = pdfs[0]?.buffer ? await extractPdfText(pdfs[0].buffer) : '';
      if (pdfs[0]?.buffer && !pdfLooksLikeAsoldiContract(pdfText, pdfs[0].filename)) {
        try {
          const page = await lastPageItems(pdfs[0].buffer);
          pdfText = pdfText || (page.items || []).map((row) => row.str).join(' ');
        } catch { /* extractPdfText already tried */ }
      }
      return { pdfs, pdfText };
    },
    classify: async (_, { fresh, prepared }) => {
      const classified = await categorize({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: fresh,
        attachmentNames: message.attachmentNames || (message.attachments || []).map((part) => part.filename),
        pdfText: prepared.pdfText,
        salesClientId: senderClientId(list, message),
      });
      if (prepared.pdfs.length && pdfLooksLikeAsoldiContract(prepared.pdfText, prepared.pdfs[0].filename)) classified.kind = 'signed_contract';
      return classified;
    },
    match: (_, classified) => matchSalesClient(list, { from: message.from, match: classified.match }),
    handlers: {
      signed_contract: async (env) => {
        const filed = await fileSignedContract(env);
        if (env.message.skipWrite) return { ...filed, write: { wrote: false, reason: 'older-same-thread' } };
        const write = await handleInboxWrite({ ...writeOptsFor(env), contractFiled: true });
        return { ...filed, write };
      },
      client_elements: async (env) => {
        const { mailbox, messageId, classified, matched, fresh } = env;
        const salesClient = matched.via === 'email' ? matched.client : null;
        const files = (message.attachments || []).map((part) => ({
          originalName: part.filename,
          buffer: part.buffer,
          mimeType: part.mimeType,
        }));
        const row = salesClient ? await fileClientElements({
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
        }) : null;
        const write = message.skipWrite ? { wrote: false, reason: 'older-same-thread' } : await handleInboxWrite(writeOptsFor(env));
        return { kind: 'client_elements', item: row, write, salesClientId: salesClient?.id || '' };
      },
    },
    fallback: (env) => fileOtherMail(env, { writeOpts: writeOptsFor(env), interpretNote }),
  });
}

async function fileOtherMail({ message, mailbox, messageId, classified, matched, fresh }, { writeOpts, interpretNote }) {
  const salesClient = matched.client;
  const factsText = fresh || forwardedBodyText(message.text || '', { ignoreFrom: /@asoldi\.com\b/i });
  // Every client mail goes past the Kundedata filer; it files nothing when there are no facts.
  if (salesClient && matched.via === 'email' && factsText) {
    await fileClientElements({
      salesClient,
      mailbox,
      messageId: `${messageId}:facts`,
      from: message.from,
      subject: message.subject,
      summary: 'Fakta fra e-post',
      receivedAt: message.mailAt || new Date().toISOString(),
      text: factsText,
      files: [],
      elements: [],
      ...(interpretNote ? { interpret: interpretNote } : {}),
    });
  }

  if (message.skipWrite) {
    const sched = isSchedulingWrite(classifyInboxWrite(fresh || message.text, salesClient || {}, { now: writeOpts.now }));
    const row = appendInboxItem({
      kind: 'silent',
      mailbox,
      messageId,
      salesClientId: salesClient?.id || '',
      from: message.from,
      subject: message.subject,
      summary: classified.summary || 'Eldre melding i samme tråd — hoppet over svar.',
      text: fresh,
      receivedAt: message.mailAt || new Date().toISOString(),
      status: sched ? 'needs_human' : 'skipped',
      reason: 'older-same-thread',
    });
    return { skipped: true, reason: 'older-same-thread', kind: classified.kind, item: row, write: { wrote: false, reason: 'older-same-thread', logged: true, needsHuman: sched }, salesClientId: salesClient?.id || '' };
  }

  const write = await handleInboxWrite(writeOpts);
  if (write?.wrote || write?.logged || write?.needsHuman) {
    return {
      kind: write.kind || classified.kind || 'write',
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

function summarizeBackfillRow(message, extra = {}) {
  return {
    id: message.id,
    from: message.from,
    subject: message.subject,
    mailAt: message.mailAt,
    skipWrite: Boolean(message.skipWrite),
    fresh: freshReplyText(message.text).replace(/\s+/g, ' ').slice(0, 280),
    ...extra,
  };
}

/**
 * One-shot: answer inbound that the first-start baseline stamped processed without a reply.
 * Live ticks stay new-mail-only. skipWrite / already-wrote / Sent-after are checked before send.
 */
export async function backfillInboxReplies({
  mailbox = 'alexander@asoldi.com',
  days = 14,
  maxResults = 24,
  apply = false,
  listImap = listImapRecentMessages,
  listSent = listImapSentHeaders,
  clients = sales.getSalesClients(),
  items = listInboxItems(),
  now = new Date(),
  sendEmail,
  queryBusy,
  decideAi,
  categorize = categorizeEmail,
} = {}) {
  const email = String(mailbox || '').trim().toLowerCase();
  if (!INBOX_BOT_MAILBOXES.includes(email)) {
    return stripSecrets({ skipped: true, reason: 'mailbox-not-allowed', mailbox: email, results: [] });
  }
  const listed = await listImap(email, { maxResults, days, timeoutMs: 45000 });
  if (listed.skipped) {
    return stripSecrets({
      skipped: true,
      reason: listed.reason || 'imap-not-configured',
      mailbox: email,
      apply: Boolean(apply),
      results: [],
    });
  }
  const queued = markOlderSameSenderDuplicates(
    markOlderSchedulingDuplicates(listed.messages || [], { now, clients }),
    { now, clients },
  );
  const sent = await listSent(email, { maxResults, days }).catch(() => []);
  const results = [];
  for (const message of queued) {
    const matched = matchSalesClient(clients, { from: message.from, match: {} });
    const client = matched.client;
    if (message.skipWrite) {
      results.push(summarizeBackfillRow(message, {
        skip: true,
        reason: 'older-same-thread',
        salesClientId: client?.id || '',
        businessName: client?.businessName || '',
      }));
      continue;
    }
    if (inboxAlreadyIngested(message, items) || inboxAlreadyIngested(message, listInboxItems())) {
      results.push(summarizeBackfillRow(message, {
        skip: true,
        reason: 'already-ingested',
        salesClientId: client?.id || '',
        businessName: client?.businessName || '',
      }));
      continue;
    }
    const answered = inboxAlreadyAnswered(message, { items, sent, client });
    if (answered.answered) {
      results.push(summarizeBackfillRow(message, {
        skip: true,
        reason: answered.reason,
        salesClientId: client?.id || '',
        businessName: client?.businessName || '',
      }));
      continue;
    }
    if (client?.contactEmailError) {
      results.push(summarizeBackfillRow(message, {
        skip: true,
        reason: 'bounce',
        salesClientId: client.id,
        businessName: client.businessName || '',
      }));
      continue;
    }
    if (!client || matched.via !== 'email') {
      results.push(summarizeBackfillRow(message, {
        skip: true,
        reason: matched.via ? `match-${matched.via}` : 'unmatched',
        via: matched.via || '',
        salesClientId: client?.id || '',
        businessName: client?.businessName || '',
      }));
      continue;
    }
    if (sales.isSsuSalesProduct(client.product)) {
      results.push(summarizeBackfillRow(message, {
        skip: true,
        reason: 'ssu',
        salesClientId: client.id,
        businessName: client.businessName || '',
      }));
      continue;
    }
    if (isAutomatedMail(message)) {
      results.push(summarizeBackfillRow(message, {
        skip: true,
        reason: 'automated',
        salesClientId: client.id,
        businessName: client.businessName || '',
      }));
      continue;
    }
    const heuristic = classifyInboxWrite(inboxWriteBlob(message), client || {}, {
      now: Number.isFinite(Date.parse(message.mailAt)) ? new Date(message.mailAt) : now,
    });
    if (heuristic.echo) {
      results.push(summarizeBackfillRow(message, {
        skip: true,
        reason: 'meeting-echo',
        intent: heuristic.intent || 'none',
        dueAt: heuristic.dueAt || '',
        salesClientId: client.id,
        businessName: client.businessName || '',
      }));
      continue;
    }
    if (!apply) {
      results.push(summarizeBackfillRow(message, {
        skip: false,
        reason: matched.via === 'email' ? 'candidate' : (matched.via ? `match-${matched.via}` : 'unmatched'),
        via: matched.via || '',
        intent: heuristic.intent || 'none',
        dueAt: heuristic.dueAt || '',
        salesClientId: client?.id || '',
        businessName: client?.businessName || '',
      }));
      continue;
    }
    try {
      const result = await ingestInboxMessage(message, {
        clients,
        categorize,
        sendEmail,
        queryBusy,
        decideAi,
        now: Number.isFinite(Date.parse(message.mailAt)) ? new Date(message.mailAt) : now,
        realNow: now,
        backfill: true,
        force: true,
      });
      results.push(summarizeBackfillRow(message, {
        skip: Boolean(result.skipped),
        reason: result.reason || (result.write?.wrote ? 'sent' : result.write?.reason || result.kind || ''),
        kind: result.kind || '',
        wrote: Boolean(result.write?.wrote),
        mailedTo: result.write?.mailed?.sent ? (client?.contactEmail || '') : '',
        salesClientId: result.salesClientId || client?.id || '',
        businessName: client?.businessName || '',
      }));
    } catch (error) {
      results.push(summarizeBackfillRow(message, {
        skip: true,
        reason: 'error',
        error: String(error?.message || error).slice(0, 240),
        salesClientId: client?.id || '',
        businessName: client?.businessName || '',
      }));
    }
  }
  return stripSecrets({
    skipped: false,
    reason: '',
    mailbox: email,
    apply: Boolean(apply),
    listed: queued.length,
    wouldSend: results.filter((row) => !row.skip && row.reason === 'candidate').length,
    sent: results.filter((row) => row.wrote).length,
    results,
  });
}

const tickMailboxes = createInboxTicker({ mailboxes: INBOX_BOT_MAILBOXES, logPrefix: '[inbox-bot]' });

export function tickInboxBot({
  listMessages = listNewMailboxMessages,
  clients = sales.getSalesClients(),
  ...ingestOpts
} = {}) {
  const resolveClients = () => salesClientsOf(clients);
  return tickMailboxes({
    listMessages: (mailbox) => listMessages(mailbox, { isProcessed }),
    prepareBatch: (messages) => {
      const opts = { clients: resolveClients() };
      return markOlderRetractedByNewerEcho(
        markOlderNonSchedulingDuplicates(markOlderSchedulingDuplicates(messages, opts), opts),
        opts,
      );
    },
    ingest: (message) => ingestInboxMessage(message, { clients: resolveClients(), ...ingestOpts }),
  });
}
