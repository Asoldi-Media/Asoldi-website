import { randomUUID } from 'crypto';
import nodemailer from 'nodemailer';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPersistentDataDir } from '../data/storage-path.js';
import { noteSalesContactEmailSend } from '../data/sales.js';

export function stripWrappingQuotes(value = '') {
  let cleaned = String(value ?? '').trim();
  while (
    (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2)
    || (cleaned.startsWith("'") && cleaned.endsWith("'") && cleaned.length >= 2)
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

export function parseMailbox(value = '') {
  const raw = stripWrappingQuotes(value);
  if (!raw) return { name: '', address: '' };
  const match = raw.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    return {
      name: stripWrappingQuotes(match[1]),
      address: stripWrappingQuotes(match[2]).toLowerCase(),
    };
  }
  return { name: '', address: raw.toLowerCase() };
}

export function formatMailbox(name = '', address = '') {
  const email = stripWrappingQuotes(address).toLowerCase();
  if (!email) return '';
  const display = stripWrappingQuotes(name);
  return display ? `${display} <${email}>` : email;
}

export function resolveSmtpFrom(fromValue = '', authUser = '') {
  const fallback = parseMailbox(authUser);
  const parsed = parseMailbox(fromValue);
  const address = parsed.address || fallback.address;
  if (!address) return '';
  // Hostinger rejects mail when the From address is not the authenticated mailbox.
  const authAddress = fallback.address;
  const finalAddress = authAddress && address !== authAddress ? authAddress : address;
  return formatMailbox(parsed.name || 'Asoldi', finalAddress);
}

function readSmtpConfig(prefix = 'SMTP') {
  const host = stripWrappingQuotes(process.env[`${prefix}_HOST`]);
  const port = Number(stripWrappingQuotes(process.env[`${prefix}_PORT`])) || 587;
  const user = stripWrappingQuotes(process.env[`${prefix}_USER`]).toLowerCase();
  const pass = stripWrappingQuotes(process.env[`${prefix}_PASS`]);
  const from = resolveSmtpFrom(process.env[`${prefix}_FROM`], user);
  return { host, port, user, pass, from };
}

function hasSmtpCredentials(config = {}) {
  return Boolean(config.host && config.user && config.pass);
}

function createTransporter(config) {
  const port = Number(config.port) || 587;
  return nodemailer.createTransport({
    host: config.host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

function resolveReplyToHeader(explicitReplyTo = '', prefix = 'SMTP') {
  const direct = stripWrappingQuotes(explicitReplyTo);
  if (direct) return direct;
  const prefixed = stripWrappingQuotes(process.env[`${prefix}_REPLY_TO`]);
  if (prefixed) return prefixed;
  return stripWrappingQuotes(process.env.SMTP_REPLY_TO);
}

export function resolveBccHeader(explicitBcc, to = '', prefix = 'SMTP') {
  if (explicitBcc === false || explicitBcc === null) return '';
  const candidate = explicitBcc === undefined
    ? (stripWrappingQuotes(process.env.SMTP_BCC) || stripWrappingQuotes(process.env[`${prefix}_USER`]))
    : stripWrappingQuotes(explicitBcc);
  if (!candidate) return '';
  const toAddress = parseMailbox(to).address;
  const bccAddress = parseMailbox(candidate).address;
  if (toAddress && bccAddress && toAddress === bccAddress) return '';
  return candidate;
}

export function splitAddressList(value = '') {
  return String(value || '')
    .split(/[,;]/)
    .map((entry) => stripWrappingQuotes(entry))
    .filter(Boolean);
}

export function readResendConfig() {
  const apiKey = stripWrappingQuotes(process.env.RESEND_API_KEY);
  const from = stripWrappingQuotes(process.env.RESEND_FROM)
    || stripWrappingQuotes(process.env.SMTP_FROM)
    || 'Asoldi <contact@asoldi.com>';
  return { apiKey, from };
}

export function isHostingerSmtpHost(host = '') {
  return /hostinger/i.test(stripWrappingQuotes(host));
}

function readAttachmentBytes(item = {}) {
  if (Buffer.isBuffer(item?.content)) return item.content;
  const filePath = stripWrappingQuotes(item?.path);
  if (filePath) return readFileSync(filePath);
  if (item?.content == null || item.content === '') {
    throw new Error(`Email attachment has no content: ${stripWrappingQuotes(item?.filename) || 'unknown'}`);
  }
  if (item?.encoding === 'base64') return Buffer.from(String(item.content), 'base64');
  return Buffer.from(String(item.content), item.encoding || 'utf8');
}

function calendarInviteAttachment(icalEvent) {
  if (!icalEvent || (icalEvent.content == null && !icalEvent.path)) return null;
  return {
    filename: stripWrappingQuotes(icalEvent.filename) || 'invite.ics',
    content: Buffer.isBuffer(icalEvent.content)
      ? icalEvent.content
      : Buffer.from(String(icalEvent.content || ''), 'utf8'),
    contentType: stripWrappingQuotes(icalEvent.contentType || icalEvent.content_type)
      || `text/calendar; charset=UTF-8; method=${stripWrappingQuotes(icalEvent.method) || 'REQUEST'}`,
    contentDisposition: 'attachment',
  };
}

export function attachmentsForResend(payload = {}) {
  const list = Array.isArray(payload.attachments) ? [...payload.attachments] : [];
  if (!list.some((item) => /\.ics$/i.test(String(item?.filename || '')))) {
    const ical = calendarInviteAttachment(payload.icalEvent);
    if (ical) list.push(ical);
  }
  return list;
}

export function toResendAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return undefined;
  return attachments.map((item) => {
    const payload = {
      filename: stripWrappingQuotes(item?.filename) || 'attachment',
      content: readAttachmentBytes(item).toString('base64'),
    };
    const contentType = stripWrappingQuotes(item?.contentType || item?.content_type);
    if (contentType) payload.content_type = contentType;
    const contentId = stripWrappingQuotes(item?.cid || item?.content_id);
    if (contentId) {
      payload.content_id = contentId;
      payload.content_disposition = stripWrappingQuotes(item?.contentDisposition || item?.content_disposition)
        || 'inline';
    } else if (/\.ics$/i.test(payload.filename) || /text\/calendar/i.test(contentType)) {
      payload.content_disposition = stripWrappingQuotes(item?.contentDisposition || item?.content_disposition)
        || 'attachment';
    }
    return payload;
  });
}

function recordLastEmailSend(entry = {}) {
  try {
    writeFileSync(
      join(getPersistentDataDir(), 'last-email-send.json'),
      JSON.stringify({ ...entry, at: new Date().toISOString() }, null, 2)
    );
  } catch (error) {
    console.error('[mail] could not write last-email-send.json', stripWrappingQuotes(error?.message || error));
  }
}

export function resolveTransactionalFrom(explicitFrom = '') {
  const envFrom = readResendConfig().from || 'Asoldi <contact@asoldi.com>';
  const explicit = stripWrappingQuotes(explicitFrom);
  const parsed = parseMailbox(explicit);
  const envParsed = parseMailbox(envFrom);
  if (parsed.address && parsed.address.endsWith('@asoldi.com')) {
    return formatMailbox(parsed.name || envParsed.name || 'Asoldi', parsed.address);
  }
  if (parsed.name && envParsed.address) {
    return formatMailbox(parsed.name, envParsed.address);
  }
  return envFrom;
}

function buildMessage(payload, prefix = 'SMTP') {
  const config = readSmtpConfig(prefix);
  const {
    to,
    subject,
    text,
    html,
    replyTo,
    bcc,
    attachments,
    headers,
    icalEvent,
    from: explicitFrom,
  } = payload || {};
  const from = resolveSmtpFrom(explicitFrom || config.from, config.user);
  const resolvedReplyTo = resolveReplyToHeader(replyTo, prefix);
  const resolvedBcc = resolveBccHeader(bcc, to, prefix);
  return {
    from,
    envelope: config.user ? { from: config.user, to } : undefined,
    to,
    subject,
    text: text || undefined,
    html: html || undefined,
    replyTo: resolvedReplyTo || undefined,
    bcc: resolvedBcc || undefined,
    attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
    headers: headers && typeof headers === 'object' ? headers : undefined,
    icalEvent: icalEvent && typeof icalEvent === 'object' ? icalEvent : undefined,
  };
}

export function canSendEmail() {
  return Boolean(readResendConfig().apiKey)
    || hasSmtpCredentials(readSmtpConfig('SMTP'))
    || hasSmtpCredentials(readSmtpConfig('SMTP_FALLBACK'));
}

export function resolveMailTransport() {
  if (readResendConfig().apiKey) return 'resend';
  if (hasSmtpCredentials(readSmtpConfig('SMTP'))) {
    return isHostingerSmtpHost(readSmtpConfig('SMTP').host) ? 'smtp-hostinger' : 'smtp';
  }
  if (hasSmtpCredentials(readSmtpConfig('SMTP_FALLBACK'))) return 'smtp-fallback';
  return 'none';
}

async function sendViaPrefix(payload, prefix) {
  const config = readSmtpConfig(prefix);
  if (!hasSmtpCredentials(config)) return false;
  if (readResendConfig().apiKey && isHostingerSmtpHost(config.host)) return false;
  const transporter = createTransporter(config);
  await transporter.sendMail(buildMessage(payload, prefix));
  return true;
}

async function sendViaResend(payload) {
  const config = readResendConfig();
  if (!config.apiKey) return false;
  const to = splitAddressList(payload.to);
  if (!to.length) throw new Error('Resend send failed: missing recipient');
  const body = {
    from: resolveTransactionalFrom(payload.from),
    to,
    subject: payload.subject || '',
  };
  if (payload.html) body.html = payload.html;
  if (payload.text) body.text = payload.text;
  const replyTo = resolveReplyToHeader(payload.replyTo);
  if (replyTo) body.reply_to = splitAddressList(replyTo);
  const bcc = resolveBccHeader(payload.bcc, payload.to);
  if (bcc) body.bcc = splitAddressList(bcc);
  if (payload.headers && typeof payload.headers === 'object') {
    const headers = {};
    for (const [key, value] of Object.entries(payload.headers)) {
      const headerName = stripWrappingQuotes(key);
      const headerValue = stripWrappingQuotes(value);
      if (headerName && headerValue) headers[headerName] = headerValue;
    }
    if (Object.keys(headers).length) body.headers = headers;
  }
  const attachments = toResendAttachments(attachmentsForResend(payload));
  if (attachments) body.attachments = attachments;
  const inlineCount = attachments?.filter((item) => item.content_id).length || 0;
  const hasIcs = Boolean(attachments?.some((item) => /\.ics$/i.test(item.filename || '') || /text\/calendar/i.test(item.content_type || '')));
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  const id = stripWrappingQuotes(data?.id);
  if (!response.ok) {
    const message = stripWrappingQuotes(data?.message) || `Resend send failed (${response.status})`;
    console.error(`[mail] resend failed status=${response.status} from=${body.from} to=${to.join(',')} error=${message}`);
    recordLastEmailSend({ ok: false, transport: 'resend', from: body.from, to, subject: body.subject, error: message });
    throw new Error(message);
  }
  console.log(`[mail] resend ok id=${id} from=${body.from} to=${to.join(',')} attachments=${attachments?.length || 0} inline=${inlineCount} ics=${hasIcs ? 'yes' : 'no'}`);
  recordLastEmailSend({
    ok: true,
    transport: 'resend',
    id,
    from: body.from,
    to,
    subject: body.subject,
    attachments: attachments?.length || 0,
    inline: inlineCount,
    ics: hasIcs,
  });
  return true;
}

export async function sendEmail({ to, subject, text, html, replyTo, bcc, attachments, headers, icalEvent, from }) {
  try {
    await sendEmailInner({ to, subject, text, html, replyTo, bcc, attachments, headers, icalEvent, from });
    noteSalesContactEmailSend({ to, ok: true });
  } catch (error) {
    noteSalesContactEmailSend({ to, ok: false, error: stripWrappingQuotes(error?.message || error) });
    throw error;
  }
}

async function sendEmailInner({ to, subject, text, html, replyTo, bcc, attachments, headers, icalEvent, from }) {
  const payload = {
    to,
    subject,
    text,
    html,
    replyTo,
    bcc,
    attachments,
    headers: {
      'X-Entity-Ref-ID': randomUUID(),
      ...(icalEvent ? { 'Content-Class': 'urn:content-classes:calendarmessage' } : {}),
      ...(headers && typeof headers === 'object' ? headers : {}),
    },
    icalEvent,
    from,
  };
  if (readResendConfig().apiKey) {
    await sendViaResend(payload);
    return;
  }
  let primaryError = null;
  try {
    if (await sendViaPrefix(payload, 'SMTP')) return;
  } catch (error) {
    primaryError = error;
  }
  try {
    if (await sendViaPrefix(payload, 'SMTP_FALLBACK')) return;
  } catch (fallbackError) {
    if (primaryError) {
      throw new Error(
        `Primary SMTP failed: ${stripWrappingQuotes(primaryError?.message || primaryError) || 'unknown error'}; fallback SMTP failed: ${stripWrappingQuotes(fallbackError?.message || fallbackError) || 'unknown error'}`
      );
    }
    throw fallbackError;
  }
  if (primaryError) throw primaryError;
  throw new Error('Email sending is not configured. Set RESEND_API_KEY (recommended) or SMTP_HOST/SMTP_USER/SMTP_PASS.');
}
