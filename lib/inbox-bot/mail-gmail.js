import { google } from 'googleapis';
import { GOOGLE_REQUEST_DEADLINE_MS } from '../google-request-deadline.js';
import { findConnectedCalendarAccountKeysByGoogleEmail, getAuthorizedClient } from '../google-calendar.js';
import {
  decodeGmailDataBuffer,
  INBOX_BOT_MAILBOXES,
  isInsufficientGmailScope,
  presentGmailMessage,
  tokenHasGmailReadonly,
} from '../gmail-readonly.js';

const MAX_MESSAGES = 12;

function sanitize(value = '') {
  return String(value || '').trim();
}

async function gmailClientForMailbox(mailbox = '') {
  const email = sanitize(mailbox).toLowerCase();
  if (!INBOX_BOT_MAILBOXES.includes(email)) {
    return { skipped: true, reason: 'mailbox-not-allowed', messages: [] };
  }
  const accountKeys = findConnectedCalendarAccountKeysByGoogleEmail(email);
  if (!accountKeys.length) {
    return { skipped: true, reason: 'mailbox-not-connected', mailbox: email, messages: [] };
  }
  const accountKey = accountKeys[0];
  const { oauthClient } = await getAuthorizedClient(accountKey);
  const scoped = tokenHasGmailReadonly(oauthClient.credentials || {});
  if (scoped === false) {
    return { skipped: true, reason: 'gmail-scope-missing', accountKey, mailbox: email, messages: [] };
  }
  return {
    skipped: false,
    reason: '',
    mailbox: email,
    accountKey,
    gmail: google.gmail({ version: 'v1', auth: oauthClient }),
  };
}

export async function gmailMailboxLooksEmpty(mailbox = '') {
  const client = await gmailClientForMailbox(mailbox);
  if (client.skipped) return { ...client, empty: true };
  try {
    const listed = await client.gmail.users.messages.list({
      userId: 'me',
      maxResults: 1,
    });
    const empty = !Array.isArray(listed?.data?.messages) || listed.data.messages.length === 0;
    return { skipped: false, reason: '', mailbox: client.mailbox, empty, accountKey: client.accountKey };
  } catch (error) {
    if (isInsufficientGmailScope(error)) {
      return { skipped: true, reason: 'gmail-scope-missing', mailbox: client.mailbox, empty: true, accountKey: client.accountKey };
    }
    const wrapped = new Error(error?.message || 'Gmail probe failed.');
    wrapped.reason = 'gmail-error';
    throw wrapped;
  }
}

export async function listRecentMailboxMessages(mailbox = '', { maxResults = MAX_MESSAGES, query = 'newer_than:2d' } = {}) {
  const client = await gmailClientForMailbox(mailbox);
  if (client.skipped) return { ...client, messages: [] };
  let listed;
  try {
    listed = await client.gmail.users.messages.list({
      userId: 'me',
      q: sanitize(query) || 'newer_than:2d',
      maxResults: Math.min(Math.max(Number(maxResults) || MAX_MESSAGES, 1), 40),
    });
  } catch (error) {
    if (isInsufficientGmailScope(error)) {
      return { skipped: true, reason: 'gmail-scope-missing', mailbox: client.mailbox, accountKey: client.accountKey, messages: [] };
    }
    const wrapped = new Error(error?.message || 'Gmail list failed.');
    wrapped.reason = 'gmail-error';
    throw wrapped;
  }

  const rows = Array.isArray(listed?.data?.messages) ? listed.data.messages : [];
  const messages = [];
  const started = Date.now();
  for (const row of rows) {
    if (Date.now() - started >= GOOGLE_REQUEST_DEADLINE_MS) break;
    const id = sanitize(row?.id);
    if (!id) continue;
    const full = await client.gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    messages.push({
      ...presentGmailMessage(full.data || {}),
      mailbox: client.mailbox,
      source: 'gmail',
    });
  }

  return {
    skipped: false,
    reason: '',
    mailbox: client.mailbox,
    accountKey: client.accountKey,
    lastCheckedAt: new Date().toISOString(),
    messages,
  };
}

export async function downloadGmailAttachment(mailbox = '', messageId = '', part = {}) {
  const inline = decodeGmailDataBuffer(part.data);
  if (inline.length) return inline;
  const attachmentId = sanitize(part.attachmentId);
  const id = sanitize(messageId);
  if (!attachmentId || !id) return Buffer.alloc(0);
  const client = await gmailClientForMailbox(mailbox);
  if (client.skipped) return Buffer.alloc(0);
  const got = await client.gmail.users.messages.attachments.get({
    userId: 'me',
    messageId: id,
    id: attachmentId,
  });
  return decodeGmailDataBuffer(got?.data?.data);
}
