// A sent mail is filed in the sender's own Hostinger mailbox, the way a mail app would: Resend and SMTP
// never save a Sent copy, so without this a rep never sees what the hub sent as them. The bot's own
// replies also get a read copy in INBOX (marked with BOT_COPY_HEADER, so the bot skips it), so the rep
// sees the answer next to the client's mail. Best effort: a failed copy never fails or delays the send.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { appendImapMessage } from '../packages/suite/core/mail/imap.js';
import { BOT_COPY_HEADER } from '../packages/suite/core/mail/mime.js';
import { recordOpsEvent } from './ops-events.js';

/** Hostinger names the sent folder INBOX.Sent; other servers use Sent or Sent Items. */
export const SENT_FOLDERS = ['INBOX.Sent', 'Sent', 'Sent Items'];
const MISSING_FOLDER_RE = /TRYCREATE|NONEXISTENT|does not exist|doesn't exist|unknown mailbox|no such mailbox/i;

function text(value = '') {
  return String(value ?? '').trim();
}

/** IMAP login for an @asoldi.com mailbox that has INBOX_IMAP_<NAME>_PASS set; null otherwise. */
export function imapCredsForSender(address = '', env = process.env) {
  const email = text(address).toLowerCase();
  const match = /^([a-z0-9._-]+)@asoldi\.com$/.exec(email);
  if (!match) return null;
  const key = match[1].replace(/[^a-z0-9]/g, '_').toUpperCase();
  const pass = text(env[`INBOX_IMAP_${key}_PASS`]);
  if (!pass) return null;
  return {
    host: text(env.INBOX_IMAP_HOST) || 'imap.hostinger.com',
    port: Number(env.INBOX_IMAP_PORT) || 993,
    user: text(env[`INBOX_IMAP_${key}_USER`]) || email,
    pass,
    mailbox: email,
  };
}

/** The mail as raw RFC 822 (what nodemailer would put on the wire). */
export function composeRawMessage(mail = {}, { botCopy = false, date = new Date() } = {}) {
  const headers = { ...(mail.headers && typeof mail.headers === 'object' ? mail.headers : {}) };
  delete headers['X-Entity-Ref-ID'];
  if (botCopy) headers[BOT_COPY_HEADER] = '1';
  const composer = new MailComposer({
    from: mail.from,
    to: mail.to,
    cc: mail.cc || undefined,
    subject: mail.subject || '',
    text: mail.text || undefined,
    html: mail.html || undefined,
    replyTo: mail.replyTo || undefined,
    headers,
    attachments: Array.isArray(mail.attachments) ? mail.attachments : undefined,
    icalEvent: mail.icalEvent || undefined,
    date,
  });
  return new Promise((resolve, reject) => {
    composer.compile().build((error, message) => (error ? reject(error) : resolve(message)));
  });
}

/**
 * File a read copy of a sent mail in `fromAddress`'s Sent folder, and with `inbox: true` also in its INBOX.
 * Returns { mailbox, sent, inbox } (each { ok, folder?, ms, error? } or null), or { skipped }. Never throws.
 */
export async function appendMailboxCopy(mail = {}, {
  fromAddress = '',
  inbox = false,
  append = appendImapMessage,
  env = process.env,
  system = 'mail',
} = {}) {
  const creds = imapCredsForSender(fromAddress, env);
  if (!creds) return { skipped: 'no-imap-login' };
  const result = { mailbox: creds.mailbox, sent: null, inbox: null };
  try {
    const raw = await composeRawMessage(mail);
    const started = Date.now();
    for (const folder of SENT_FOLDERS) {
      try {
        await append(creds, folder, raw);
        result.sent = { ok: true, folder, ms: Date.now() - started };
        break;
      } catch (error) {
        const message = text(error?.message || error);
        result.sent = { ok: false, folder, ms: Date.now() - started, error: message.slice(0, 160) };
        if (!MISSING_FOLDER_RE.test(message)) break;
      }
    }
    if (inbox) {
      const startedInbox = Date.now();
      try {
        await append(creds, 'INBOX', await composeRawMessage(mail, { botCopy: true }));
        result.inbox = { ok: true, folder: 'INBOX', ms: Date.now() - startedInbox };
      } catch (error) {
        result.inbox = { ok: false, folder: 'INBOX', ms: Date.now() - startedInbox, error: text(error?.message || error).slice(0, 160) };
      }
    }
  } catch (error) {
    result.sent = { ok: false, ms: 0, error: `compose: ${text(error?.message || error).slice(0, 140)}` };
  }
  recordOpsEvent(system, 'copy.appended', {
    mailbox: creds.mailbox,
    subject: text(mail.subject).slice(0, 120),
    salesClientId: text(mail.salesClientId),
    sent: result.sent,
    inbox: result.inbox,
  });
  if (result.sent && !result.sent.ok) console.warn(`[mail-copy] ${creds.mailbox} sent copy failed: ${result.sent.error}`);
  if (result.inbox && !result.inbox.ok) console.warn(`[mail-copy] ${creds.mailbox} inbox copy failed: ${result.inbox.error}`);
  return result;
}
