// IMAP + MIME live in the shared suite core (packages/suite/core/mail). This file only maps
// Asoldi's allowed mailboxes to INBOX_IMAP_* env credentials.
import { INBOX_BOT_MAILBOXES } from '../gmail-readonly.js';
import { listImapMessages, probeImap } from '../../packages/suite/core/mail/imap.js';

export { LOGIN_TIMEOUT_MS, FETCH_TIMEOUT_MS, indexOfImapNeedle, parseFetchBodies } from '../../packages/suite/core/mail/imap.js';
export { decodeMimeWords, htmlToText, parseRfc822 } from '../../packages/suite/core/mail/mime.js';

const DEFAULT_HOST = 'imap.hostinger.com';
const DEFAULT_PORT = 993;

function sanitize(value = '') {
  return String(value || '').trim();
}

export function imapCredsForMailbox(mailbox = '', env = process.env) {
  const email = sanitize(mailbox).toLowerCase();
  if (!INBOX_BOT_MAILBOXES.includes(email)) return null;
  const key = email.split('@')[0].toUpperCase();
  const user = sanitize(env[`INBOX_IMAP_${key}_USER`]) || email;
  const pass = sanitize(env[`INBOX_IMAP_${key}_PASS`]);
  if (!pass) return null;
  return {
    host: sanitize(env.INBOX_IMAP_HOST) || DEFAULT_HOST,
    port: Number(env.INBOX_IMAP_PORT) || DEFAULT_PORT,
    user,
    pass,
    mailbox: email,
  };
}

export function imapCredsPresent(mailbox = '', env = process.env) {
  return Boolean(imapCredsForMailbox(mailbox, env));
}

export async function probeImapLogin(mailbox = '', env = process.env) {
  const email = sanitize(mailbox).toLowerCase();
  if (!INBOX_BOT_MAILBOXES.includes(email)) {
    return { mailbox: email, configured: false, ok: false, reason: 'mailbox-not-allowed', source: '' };
  }
  const creds = imapCredsForMailbox(email, env);
  if (!creds) return { mailbox: email, configured: false, ok: false, reason: 'imap-not-configured', source: 'imap' };
  const probe = await probeImap(creds);
  return { mailbox: email, configured: true, ok: probe.ok, reason: probe.reason, source: 'imap' };
}

export async function listImapRecentMessages(mailbox = '', { maxResults = 8, days = 2 } = {}) {
  const creds = imapCredsForMailbox(mailbox);
  if (!creds) return { skipped: true, reason: 'imap-not-configured', mailbox: sanitize(mailbox).toLowerCase(), messages: [] };
  try {
    const messages = await listImapMessages(creds, { maxResults, days });
    return { skipped: false, reason: '', mailbox: creds.mailbox, lastCheckedAt: new Date().toISOString(), messages };
  } catch (error) {
    const wrapped = new Error(error?.message || 'IMAP list failed.');
    wrapped.reason = 'imap-error';
    throw wrapped;
  }
}
