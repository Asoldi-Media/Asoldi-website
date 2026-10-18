import tls from 'node:tls';
import { parseRfc822 } from './mime.js';

// Minimal IMAP over TLS: LOGIN, SELECT, UID SEARCH, UID FETCH RFC822. Read-only.
// Credentials are passed in ({host, port, user, pass, mailbox}); this file reads no env.

/** LOGIN + SELECT only. */
export const LOGIN_TIMEOUT_MS = 8000;
/** Full RFC822 FETCH of a few messages. */
export const FETCH_TIMEOUT_MS = 20000;

function quoteImap(value = '') {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Tagged replies can be the very first bytes (no "\n" before them), e.g. "ASX1 OK ... Logged in".
export function indexOfImapNeedle(buf, needle, lineStart = false) {
  let idx = buf.indexOf(needle);
  while (lineStart && idx > 0 && buf[idx - 1] !== 0x0a) idx = buf.indexOf(needle, idx + 1);
  return idx;
}

async function imapSession(creds, fn, { timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : LOGIN_TIMEOUT_MS;
  const socket = tls.connect({ host: creds.host, port: creds.port, servername: creds.host, timeout: waitMs });
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
    if (!/^OK\b/i.test(extra.toString('utf8'))) throw new Error(`IMAP failed: ${command.split(' ')[0]}`);
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

export function parseFetchBodies(block) {
  const buf = Buffer.isBuffer(block) ? block : Buffer.from(String(block));
  const out = [];
  const headerRe = /\* \d+ FETCH([^\r\n]*)\{(\d+)\}\r?\n/gi;
  const text = buf.toString('latin1');
  let match = headerRe.exec(text);
  while (match) {
    const size = Number(match[2]);
    const start = match.index + match[0].length;
    out.push({ uid: match[1].match(/\bUID (\d+)/i)?.[1] || '', raw: buf.subarray(start, start + size).toString('latin1') });
    match = headerRe.exec(text);
  }
  return out;
}

/** { ok, reason } for a login + SELECT INBOX. reason: login-rejected | timeout | imap-error. */
export async function probeImap(creds) {
  try {
    await imapSession(creds, async ({ tagged }) => {
      await tagged('SELECT INBOX');
    }, { timeoutMs: LOGIN_TIMEOUT_MS });
    return { ok: true, reason: '' };
  } catch (error) {
    const message = String(error?.message || '');
    const reason = /failed: LOGIN/.test(message) ? 'login-rejected' : /timeout/i.test(message) ? 'timeout' : 'imap-error';
    return { ok: false, reason };
  }
}

/** The newest messages of the last `days` days, parsed. Ids use UIDs, which stay stable when mail moves. */
export async function listImapMessages(creds, {
  maxResults = 8,
  days = 2,
  folder = 'INBOX',
  headersOnly = false,
  timeoutMs,
} = {}) {
  const messages = [];
  const box = String(folder || 'INBOX').replace(/[\r\n"\\]/g, '') || 'INBOX';
  const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : FETCH_TIMEOUT_MS;
  await imapSession(creds, async ({ tagged }) => {
    await tagged(`SELECT ${/^[A-Za-z0-9._-]+$/.test(box) ? box : quoteImap(box)}`);
    const search = await tagged(`UID SEARCH SINCE ${imapSinceDate(days)}`);
    const ids = parseSearchIds(search).slice(-Math.max(1, Number(maxResults) || 8));
    if (!ids.length) return;
    const spec = headersOnly ? '(UID RFC822.HEADER)' : '(UID RFC822)';
    const fetched = await tagged(`UID FETCH ${ids.join(',')} ${spec}`);
    parseFetchBodies(fetched).forEach(({ uid, raw }, index) => {
      const parsed = parseRfc822(raw);
      const id = uid || ids[index] || `imap-${index}`;
      messages.push({
        id: `imap:${creds.mailbox}:uid:${id}`,
        mailbox: creds.mailbox,
        source: 'imap',
        mailAt: parsed.date,
        from: parsed.from,
        to: parsed.to,
        subject: parsed.subject,
        text: headersOnly ? '' : parsed.text,
        attachmentNames: headersOnly ? [] : parsed.attachmentNames,
        attachments: headersOnly ? [] : parsed.attachments.map((part) => ({
          filename: part.filename,
          mimeType: part.mimeType,
          buffer: part.buffer,
        })),
      });
    });
  }, { timeoutMs: waitMs });
  return messages;
}
