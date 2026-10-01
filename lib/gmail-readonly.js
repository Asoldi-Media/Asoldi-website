import { google } from 'googleapis';
import {
  findConnectedCalendarAccountKeysByGoogleEmail,
  getAuthorizedClient,
} from './google-calendar.js';

export const DAMIAN_GMAIL = 'damian@asoldi.com';
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const MAX_MESSAGES = 40;

function sanitize(value = '') {
  return String(value ?? '').trim();
}

export function gmailQueryForClient(clientEmail = '') {
  const email = sanitize(clientEmail).toLowerCase();
  if (!email) return '';
  return `from:${email}`;
}

function decodeB64Url(data = '') {
  const raw = sanitize(data).replace(/-/g, '+').replace(/_/g, '/');
  if (!raw) return '';
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtml(html = '') {
  return sanitize(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractAttachmentNames(payload = {}) {
  const names = [];
  const seen = new Set();
  const walk = (part) => {
    if (!part || typeof part !== 'object') return;
    const filename = sanitize(part.filename);
    if (filename && !seen.has(filename)) {
      seen.add(filename);
      names.push(filename);
    }
    for (const child of Array.isArray(part.parts) ? part.parts : []) walk(child);
  };
  walk(payload);
  return names;
}

function collectBodies(payload = {}, buckets = { plain: [], html: [] }) {
  if (!payload || typeof payload !== 'object') return buckets;
  const mime = sanitize(payload.mimeType).toLowerCase();
  const data = payload.body && typeof payload.body === 'object' ? payload.body.data : '';
  if (data && mime === 'text/plain') buckets.plain.push(decodeB64Url(data));
  if (data && mime === 'text/html') buckets.html.push(decodeB64Url(data));
  for (const child of Array.isArray(payload.parts) ? payload.parts : []) {
    collectBodies(child, buckets);
  }
  return buckets;
}

export function extractMessageText(payload = {}, snippet = '') {
  const buckets = collectBodies(payload);
  const plain = buckets.plain.map(sanitize).filter(Boolean).join('\n');
  if (plain) return plain;
  const html = buckets.html.map(stripHtml).filter(Boolean).join('\n');
  if (html) return html;
  return sanitize(snippet);
}

function headerValue(payload = {}, name = '') {
  const needle = sanitize(name).toLowerCase();
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const hit = headers.find((row) => sanitize(row?.name).toLowerCase() === needle);
  return sanitize(hit?.value);
}

export function presentGmailMessage(message = {}) {
  const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
  const internalMs = Number(message.internalDate);
  const headerDate = headerValue(payload, 'Date');
  const mailAt = Number.isFinite(internalMs) && internalMs > 0
    ? new Date(internalMs).toISOString()
    : headerDate;
  return {
    id: sanitize(message.id),
    threadId: sanitize(message.threadId),
    mailAt,
    subject: headerValue(payload, 'Subject'),
    from: headerValue(payload, 'From'),
    text: extractMessageText(payload, message.snippet),
    attachmentNames: extractAttachmentNames(payload),
  };
}

function tokenHasGmailReadonly(credentials = {}) {
  const scope = sanitize(credentials.scope);
  if (!scope) return null;
  return scope.split(/\s+/).includes(GMAIL_READONLY_SCOPE);
}

function isInsufficientGmailScope(error) {
  const status = Number(error?.code || error?.response?.status);
  const reason = sanitize(error?.errors?.[0]?.reason || error?.response?.data?.error?.errors?.[0]?.reason).toLowerCase();
  const message = sanitize(error?.message || error?.response?.data?.error?.message).toLowerCase();
  return status === 403
    || reason === 'insufficientpermissions'
    || message.includes('insufficient permission')
    || message.includes('insufficientauthentication')
    || message.includes('access not configured')
    || message.includes('gmail api has not been used');
}

export function damianGmailAccountKeys() {
  return findConnectedCalendarAccountKeysByGoogleEmail(DAMIAN_GMAIL);
}

export async function listDamianMailFromClient(clientEmail = '', { maxResults = MAX_MESSAGES } = {}) {
  const email = sanitize(clientEmail).toLowerCase();
  if (!email) {
    return { skipped: true, reason: 'no-client-email', messages: [] };
  }

  const accountKeys = damianGmailAccountKeys();
  if (!accountKeys.length) {
    return { skipped: true, reason: 'damian-not-connected', messages: [] };
  }

  const accountKey = accountKeys[0];
  const { oauthClient } = await getAuthorizedClient(accountKey);
  const scoped = tokenHasGmailReadonly(oauthClient.credentials || {});
  if (scoped === false) {
    return { skipped: true, reason: 'gmail-scope-missing', accountKey, messages: [] };
  }

  const gmail = google.gmail({ version: 'v1', auth: oauthClient });
  const q = gmailQueryForClient(email);
  let listed;
  try {
    listed = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: Math.min(Math.max(Number(maxResults) || MAX_MESSAGES, 1), MAX_MESSAGES),
    });
  } catch (error) {
    if (isInsufficientGmailScope(error)) {
      return { skipped: true, reason: 'gmail-scope-missing', accountKey, messages: [] };
    }
    const wrapped = new Error(error?.message || 'Gmail list failed.');
    wrapped.reason = 'gmail-error';
    throw wrapped;
  }

  const rows = Array.isArray(listed?.data?.messages) ? listed.data.messages : [];
  const messages = [];
  for (const row of rows) {
    const id = sanitize(row?.id);
    if (!id) continue;
    const full = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    messages.push(presentGmailMessage(full.data || {}));
  }

  return {
    skipped: false,
    reason: '',
    accountKey,
    lastMessageId: messages[0]?.id || '',
    lastCheckedAt: new Date().toISOString(),
    messages,
  };
}
