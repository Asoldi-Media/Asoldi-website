import { INBOX_BOT_MAILBOXES } from '../gmail-readonly.js';
import {
  downloadGmailAttachment,
  gmailMailboxLooksEmpty,
  listRecentMailboxMessages,
} from './mail-gmail.js';
import { imapCredsForMailbox, listImapRecentMessages } from './mail-imap.js';
import { mailboxSource, setMailboxSource } from './store.js';

const MAX_PER_TICK = 3;

export { INBOX_BOT_MAILBOXES };

/**
 * damian@ / alexander@ live on Hostinger. IMAP is the real mailbox.
 * Gmail API is only used when IMAP passwords are missing (Calendar OAuth leftover).
 */
export async function resolveMailboxSource(mailbox = '', { listGmail = listRecentMailboxMessages, probeGmail = gmailMailboxLooksEmpty, listImap = listImapRecentMessages } = {}) {
  const email = String(mailbox || '').trim().toLowerCase();

  if (imapCredsForMailbox(email)) {
    const imapListed = await listImap(email, { maxResults: 1 }).catch((error) => ({
      skipped: true,
      reason: error?.reason || 'imap-error',
      messages: [],
    }));
    if (!imapListed.skipped) {
      setMailboxSource(email, 'imap');
      return 'imap';
    }
  }

  const cached = mailboxSource(email);
  if (cached === 'gmail') return 'gmail';

  const gmailProbe = await probeGmail(email).catch((error) => ({ skipped: true, reason: error?.reason || 'gmail-error', empty: true }));
  if (!gmailProbe.skipped) {
    setMailboxSource(email, 'gmail');
    return 'gmail';
  }
  return gmailProbe.reason || 'none';
}

export async function listNewMailboxMessages(mailbox = '', {
  listGmail = listRecentMailboxMessages,
  probeGmail = gmailMailboxLooksEmpty,
  listImap = listImapRecentMessages,
  downloadGmail = downloadGmailAttachment,
  isProcessed = () => false,
} = {}) {
  const email = String(mailbox || '').trim().toLowerCase();
  const source = await resolveMailboxSource(email, { listGmail, probeGmail, listImap });
  let listed;
  if (source === 'imap') listed = await listImap(email, { maxResults: 8 });
  else if (source === 'gmail') listed = await listGmail(email, { maxResults: 8 });
  else {
    return { skipped: true, reason: source || 'mailbox-unavailable', mailbox: email, messages: [] };
  }
  if (listed.skipped) return listed;

  const fresh = (listed.messages || []).filter((message) => !isProcessed(email, message.id)).slice(0, MAX_PER_TICK);
  const messages = [];
  for (const message of fresh) {
    const attachments = [];
    if (source === 'gmail') {
      for (const part of message.attachments || []) {
        const buffer = part.buffer || await downloadGmail(email, message.id, part);
        if (!buffer?.length) continue;
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          buffer,
        });
      }
    } else {
      for (const part of message.attachments || []) {
        if (!part.buffer?.length) continue;
        attachments.push(part);
      }
    }
    messages.push({ ...message, mailbox: email, source, attachments });
  }
  return {
    skipped: false,
    reason: '',
    mailbox: email,
    source,
    lastCheckedAt: listed.lastCheckedAt || new Date().toISOString(),
    messages,
  };
}
