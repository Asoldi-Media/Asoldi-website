import tls from 'node:tls';
import { INBOX_BOT_MAILBOXES } from '../gmail-readonly.js';

const DEFAULT_HOST = 'imap.hostinger.com';
const DEFAULT_PORT = 993;
/** LOGIN + SELECT only. Same ceiling as the Gmail fallback. */
export const LOGIN_TIMEOUT_MS = 8000;
/** Full RFC822 FETCH of a few messages. Not the Google 8s deadline. */
export const FETCH_TIMEOUT_MS = 20000;

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

function quoteImap(value = '') {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function decodeQuotedPrintable(value = '') {
  return String(value || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodePartBody(raw = '', encoding = '') {
  const enc = String(encoding || '').toLowerCase();
  const body = String(raw || '').trim();
  if (enc.includes('base64')) {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64');
    } catch {
      return Buffer.from('');
    }
  }
  // The raw message is a latin1 string (one char per byte), so map chars straight back to bytes.
  if (enc.includes('quoted-printable')) return Buffer.from(decodeQuotedPrintable(body), 'latin1');
  return Buffer.from(body, 'latin1');
}

function decodeCharset(bytes, charset = 'utf-8') {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// RFC 2047 header words: =?UTF-8?Q?P=C3=A5minnelse?= / =?utf-8?B?...?=
export function decodeMimeWords(value = '') {
  return String(value || '')
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, kind, data) => {
      const bytes = kind.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : Buffer.from(decodeQuotedPrintable(data.replace(/_/g, ' ')), 'latin1');
      return decodeCharset(bytes, charset);
    });
}

export function htmlToText(html = '') {
  return String(html || '')
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<blockquote\b/gi, ' > <blockquote')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&[lr]squo;/gi, "'")
    .replace(/&[lr]dquo;/gi, '"')
    .replace(/&[nm]dash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, '&');
}

function charsetOf(contentType = '') {
  const match = String(contentType).match(/charset="?([^";\s]+)"?/i);
  return match ? match[1] : 'utf-8';
}

function headerMap(block = '') {
  const map = {};
  let current = '';
  for (const line of String(block || '').split(/\r?\n/)) {
    if (/^\s/.test(line) && current) {
      map[current] += ` ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    current = line.slice(0, idx).toLowerCase();
    map[current] = line.slice(idx + 1).trim();
  }
  return map;
}

function headerFilename(headers = {}) {
  const disposition = headers['content-disposition'] || '';
  const type = headers['content-type'] || '';
  const fromDisp = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)"?/i);
  const fromType = type.match(/name="?([^";]+)"?/i);
  const raw = decodeMimeWords((fromDisp && fromDisp[1]) || (fromType && fromType[1]) || '');
  try {
    return decodeURIComponent(raw.replace(/['"]/g, '').trim());
  } catch {
    return raw.replace(/['"]/g, '').trim();
  }
}

function parseMimeTree(raw = '') {
  const text = String(raw || '').replace(/^\r?\n/, '');
  const splitAt = text.search(/\r?\n\r?\n/);
  const head = splitAt >= 0 ? text.slice(0, splitAt) : text;
  const body = splitAt >= 0 ? text.slice(splitAt).replace(/^\r?\n\r?\n/, '') : '';
  const headers = headerMap(head);
  const contentType = String(headers['content-type'] || 'text/plain');
  const boundary = contentType.match(/boundary="?([^";]+)"?/i);
  if (boundary) {
    const token = `--${boundary[1].trim()}`;
    const chunks = body.split(token).slice(1, -1);
    const children = chunks.map((chunk) => parseMimeTree(chunk.replace(/^\r?\n/, '')));
    return { headers, contentType, children };
  }
  return {
    headers,
    contentType,
    body: decodePartBody(body, headers['content-transfer-encoding']),
    children: [],
  };
}

function walkMime(node, acc = { text: [], attachments: [] }) {
  if (!node) return acc;
  const type = String(node.contentType || '').toLowerCase();
  const filename = headerFilename(node.headers || {});
  if (node.children?.length) {
    for (const child of node.children) walkMime(child, acc);
    return acc;
  }
  if (filename && node.body) {
    acc.attachments.push({
      filename,
      mimeType: type.split(';')[0].trim(),
      buffer: node.body,
    });
    return acc;
  }
  const charset = charsetOf(node.contentType);
  if (type.startsWith('text/plain') && node.body) acc.text.push(decodeCharset(node.body, charset));
  else if (type.startsWith('text/html') && node.body && !acc.text.length) {
    acc.text.push(htmlToText(decodeCharset(node.body, charset)));
  }
  return acc;
}

export function parseRfc822(raw = '') {
  const tree = parseMimeTree(raw);
  const walked = walkMime(tree);
  const headers = tree.headers || headerMap(String(raw).split(/\r?\n\r?\n/)[0] || '');
  return {
    from: decodeMimeWords(headers.from),
    to: decodeMimeWords(headers.to),
    subject: decodeMimeWords(headers.subject).trim(),
    date: headers.date || '',
    text: walked.text.join('\n').replace(/\s+/g, ' ').trim(),
    attachments: walked.attachments,
    attachmentNames: walked.attachments.map((part) => part.filename),
  };
}

// Tagged replies can be the very first bytes (no "\n" before them), e.g. "ASX1 OK ... Logged in".
export function indexOfImapNeedle(buf, needle, lineStart = false) {
  let idx = buf.indexOf(needle);
  while (lineStart && idx > 0 && buf[idx - 1] !== 0x0a) idx = buf.indexOf(needle, idx + 1);
  return idx;
}

async function imapSession(creds, fn, { timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : LOGIN_TIMEOUT_MS;
  const socket = tls.connect({
    host: creds.host,
    port: creds.port,
    servername: creds.host,
    timeout: waitMs,
  });
  let buf = Buffer.alloc(0);
  let tagN = 0;
  const waiters = [];

  function feed(chunk) {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (waiters.length) {
      const waiter = waiters[0];
      const needle = Buffer.from(waiter.needle);
      const idx = indexOfImapNeedle(buf, needle, waiter.lineStart);
      if (idx < 0) break;
      const payload = buf.subarray(0, idx + needle.length);
      buf = buf.subarray(idx + needle.length);
      waiters.shift();
      waiter.resolve(payload);
    }
  }

  function waitFor(needle, { lineStart = false } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IMAP timeout')), waitMs);
      waiters.push({
        needle,
        lineStart,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      feed(Buffer.alloc(0));
    });
  }

  function send(line) {
    socket.write(`${line}\r\n`);
  }

  async function tagged(command) {
    tagN += 1;
    const tag = `ASX${tagN}`;
    send(`${tag} ${command}`);
    const raw = await waitFor(`${tag} `, { lineStart: true });
    const extra = await waitFor('\n');
    if (!/^OK\b/i.test(extra.toString('utf8'))) {
      throw new Error(`IMAP failed: ${command.split(' ')[0]}`);
    }
    return Buffer.concat([raw, extra]);
  }

  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('timeout', () => reject(new Error('IMAP socket timeout')));
      }),
      (async () => {
        socket.on('data', feed);
        await waitFor('\n');
        await tagged(`LOGIN ${quoteImap(creds.user)} ${quoteImap(creds.pass)}`);
        return fn({ tagged, send, waitFor });
      })(),
    ]);
  } finally {
    try {
      send('A99 LOGOUT');
    } catch {
      // closing
    }
    socket.destroy();
  }
}

function imapSinceDate(days = 2) {
  const date = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function parseSearchIds(block) {
  const text = Buffer.isBuffer(block) ? block.toString('utf8') : String(block);
  const line = text.split(/\r?\n/).find((row) => /\* SEARCH/i.test(row)) || '';
  return [...line.matchAll(/\d+/g)].map((row) => row[0]).filter((id) => id !== '');
}

function parseFetchBodies(block) {
  const buf = Buffer.isBuffer(block) ? block : Buffer.from(String(block));
  const out = [];
  const headerRe = /\* \d+ FETCH[^\r\n]*\{(\d+)\}\r?\n/gi;
  const text = buf.toString('latin1');
  let match = headerRe.exec(text);
  while (match) {
    const size = Number(match[1]);
    const start = match.index + match[0].length;
    out.push(buf.subarray(start, start + size).toString('latin1'));
    match = headerRe.exec(text);
  }
  return out;
}

export async function probeImapLogin(mailbox = '', env = process.env) {
  const email = sanitize(mailbox).toLowerCase();
  if (!INBOX_BOT_MAILBOXES.includes(email)) {
    return { mailbox: email, configured: false, ok: false, reason: 'mailbox-not-allowed', source: '' };
  }
  const creds = imapCredsForMailbox(email, env);
  if (!creds) {
    return { mailbox: email, configured: false, ok: false, reason: 'imap-not-configured', source: 'imap' };
  }
  try {
    await imapSession(creds, async ({ tagged }) => {
      await tagged('SELECT INBOX');
    }, { timeoutMs: LOGIN_TIMEOUT_MS });
    return { mailbox: email, configured: true, ok: true, reason: '', source: 'imap' };
  } catch (error) {
    const message = String(error?.message || '');
    const reason = /failed: LOGIN/.test(message) ? 'login-rejected' : /timeout/i.test(message) ? 'timeout' : 'imap-error';
    return { mailbox: email, configured: true, ok: false, reason, source: 'imap' };
  }
}

export async function listImapRecentMessages(mailbox = '', { maxResults = 8, days = 2 } = {}) {
  const creds = imapCredsForMailbox(mailbox);
  if (!creds) {
    return { skipped: true, reason: 'imap-not-configured', mailbox: sanitize(mailbox).toLowerCase(), messages: [] };
  }
  try {
    const messages = [];
    await imapSession(creds, async ({ tagged }) => {
      await tagged('SELECT INBOX');
      const search = await tagged(`SEARCH SINCE ${imapSinceDate(days)}`);
      const ids = parseSearchIds(search).slice(-Math.max(1, Number(maxResults) || 8));
      if (!ids.length) return;
      const fetched = await tagged(`FETCH ${ids.join(',')} (RFC822)`);
      const bodies = parseFetchBodies(fetched);
      bodies.forEach((raw, index) => {
        const parsed = parseRfc822(raw);
        const id = ids[index] || `imap-${index}`;
        messages.push({
          id: `imap:${creds.mailbox}:${id}`,
          mailbox: creds.mailbox,
          source: 'imap',
          mailAt: parsed.date,
          from: parsed.from,
          to: parsed.to,
          subject: parsed.subject,
          text: parsed.text,
          attachmentNames: parsed.attachmentNames,
          attachments: parsed.attachments.map((part) => ({
            filename: part.filename,
            mimeType: part.mimeType,
            buffer: part.buffer,
          })),
        });
      });
    }, { timeoutMs: FETCH_TIMEOUT_MS });
    return {
      skipped: false,
      reason: '',
      mailbox: creds.mailbox,
      lastCheckedAt: new Date().toISOString(),
      messages,
    };
  } catch (error) {
    const wrapped = new Error(error?.message || 'IMAP list failed.');
    wrapped.reason = 'imap-error';
    throw wrapped;
  }
}
