// RFC 822 / MIME parsing: headers, encoded words, multipart trees, attachments.
// Raw messages are latin1 strings (one char per byte), as IMAP FETCH returns them.
import { parseIcsEvent } from './ics.js';

/** Marks a copy a bot appended to its own mailbox, so the bot never reads it back as new mail. */
export const BOT_COPY_HEADER = 'X-Bot-Copy';

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
      const bytes = kind.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : Buffer.from(decodeQuotedPrintable(data.replace(/_/g, ' ')), 'latin1');
      return decodeCharset(bytes, charset);
    });
}

/** Longest To/Cc header that is read, and most addresses taken from it: a hostile header must not stall the poll. */
const MAX_ADDRESS_HEADER = 16 * 1024;
const MAX_ADDRESSES = 100;

/**
 * Split a header at top-level commas/semicolons: quotes, angle brackets and comments hide theirs. One pass, so an
 * unclosed "(" costs no more than any other character. Each part: { text, plain (comments taken out), note (the first comment) }.
 */
function splitAddressHeader(value = '') {
  const parts = [];
  let current = '';
  let plain = '';
  let note = '';
  let noteDone = false;
  let quoted = false;
  let angle = false;
  let comment = 0;
  const raw = String(value || '').slice(0, MAX_ADDRESS_HEADER);
  const flush = () => {
    parts.push({ text: current.trim(), plain: plain.trim(), note });
    current = '';
    plain = '';
    note = '';
    noteDone = false;
  };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quoted) {
      current += ch;
      plain += ch;
      if (ch === '\\' && i + 1 < raw.length) {
        i += 1;
        current += raw[i];
        plain += raw[i];
      } else if (ch === '"') quoted = false;
      continue;
    }
    if (comment) {
      current += ch;
      if (ch === '(') comment += 1;
      else if (ch === ')') comment -= 1;
      if (comment > 0 && !noteDone) note += ch;
      else if (comment === 0) noteDone = true;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '(') {
      comment = 1;
      current += ch;
      continue;
    } else if (ch === '<') angle = true;
    else if (ch === '>') angle = false;
    else if ((ch === ',' || ch === ';') && !angle) {
      flush();
      if (parts.length >= MAX_ADDRESSES) return parts.filter((part) => part.text);
      continue;
    }
    current += ch;
    plain += ch;
  }
  flush();
  return parts.filter((part) => part.text);
}

/** An address header ("To", "Cc") as [{ name, email }]: quoted names, encoded words and group labels handled. */
export function parseAddressList(value = '') {
  const out = [];
  for (const { text: part, plain, note } of splitAddressHeader(value)) {
    // "Team: a@x" keeps the member; the group label is not a person.
    const entry = part.replace(/^[^"<@]*:\s*/, '');
    const angled = entry.match(/^(.*?)<\s*([^<>\s]+)\s*>\s*$/s);
    let name = '';
    let email = '';
    if (angled) {
      name = angled[1];
      email = angled[2];
    } else {
      email = plain.replace(/^[^"<@]*:\s*/, '').trim();
      name = note;
    }
    name = decodeMimeWords(name.trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1')).trim();
    email = decodeMimeWords(email).trim().replace(/^mailto:/i, '').toLowerCase();
    if (!/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(email)) continue;
    out.push({ name, email });
  }
  return out;
}

export function htmlToText(html = '') {
  return String(html || '')
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<blockquote\b/gi, '\n> <blockquote')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
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
    const value = line.slice(idx + 1).trim();
    // A repeated To/Cc header lists more people, never replaces the first.
    map[current] = (current === 'to' || current === 'cc') && map[current] ? `${map[current]}, ${value}` : value;
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
  return { headers, contentType, body: decodePartBody(body, headers['content-transfer-encoding']), children: [] };
}

/**
 * RFC 3676 format=flowed: a line that ends in a space continues on the next line (a soft break), so
 * "møtes på torsdag \r\nkl 10" is one line again before the time parser reads it. Lines join only at
 * the same quote depth ('>' count, one stuffed space dropped); a blank line and the "-- " signature
 * line never join. DelSp=yes also drops the space before the break.
 */
function unflowText(text = '', { delSp = false } = {}) {
  const out = [];
  let open = -1;
  for (const line of String(text || '').split(/\r?\n/)) {
    const depth = /^>*/.exec(line)[0].length;
    const body = line.slice(depth).replace(/^ /, '');
    const flowed = body.endsWith(' ') && body !== '-- ';
    const trim = (value) => (flowed && delSp ? value.slice(0, -1) : value);
    if (open === depth && body && body !== '-- ') out[out.length - 1] += trim(body);
    else out.push(trim(line));
    open = flowed ? depth : -1;
  }
  return out.join('\n');
}

function plainPartText(text = '', contentType = '') {
  if (!/;\s*format\s*=\s*"?flowed"?/i.test(contentType)) return text;
  return unflowText(text, { delSp: /;\s*delsp\s*=\s*"?yes"?/i.test(contentType) });
}

function calendarMethodOfPart(contentType = '', body = '') {
  const fromType = String(contentType || '').match(/method=([a-z]+)/i);
  const fromBody = String(body || '').match(/^METHOD:(\w+)/im);
  return String(fromType?.[1] || fromBody?.[1] || '').toUpperCase();
}

export function walkMime(node, acc = { text: [], attachments: [], calendar: [] }) {
  if (!node) return acc;
  if (!acc.calendar) acc.calendar = [];
  const type = String(node.contentType || '').toLowerCase();
  const filename = headerFilename(node.headers || {});
  if (node.children?.length) {
    for (const child of node.children) walkMime(child, acc);
    return acc;
  }
  const isCalendar = /^(text\/calendar|application\/ics)/.test(type) || /\.ics$/i.test(filename);
  if (isCalendar && node.body) {
    const raw = node.body.toString('utf8').slice(0, 8000);
    const event = parseIcsEvent(raw);
    acc.calendar.push({
      filename: filename || 'invite.ics',
      mimeType: type.split(';')[0].trim() || 'text/calendar',
      method: calendarMethodOfPart(node.contentType, raw),
      uid: event.uid,
      dtstart: event.dtstart,
      partstat: event.partstat,
      attendee: event.attendee,
      comment: event.comment,
    });
    return acc;
  }
  // A bounce's machine-readable part: Final-Recipient / Action / Status lines.
  if (/^message\/(?:global-)?delivery-status/.test(type) && node.body) {
    acc.deliveryStatus = `${acc.deliveryStatus || ''}${node.body.toString('utf8').slice(0, 4000)}\n`;
    return acc;
  }
  if (filename && node.body) {
    const disposition = String(node.headers?.['content-disposition'] || '').toLowerCase();
    // shortcut: a small inline image with a Content-ID is a signature logo, not client media; a real photo is bigger.
    if (type.startsWith('image/') && node.headers?.['content-id'] && !disposition.startsWith('attachment') && node.body.length < 40_000) return acc;
    acc.attachments.push({ filename, mimeType: type.split(';')[0].trim(), buffer: node.body });
    return acc;
  }
  const charset = charsetOf(node.contentType);
  if (type.startsWith('text/plain') && node.body) acc.text.push(plainPartText(decodeCharset(node.body, charset), node.contentType));
  else if (type.startsWith('text/html') && node.body && !acc.text.length) acc.text.push(htmlToText(decodeCharset(node.body, charset)));
  return acc;
}

/** Keep line breaks (quote headers and '>' lines live on their own lines); squash spaces and blank runs. */
function normalizeBodyText(text = '') {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseRfc822(raw = '') {
  const tree = parseMimeTree(raw);
  const walked = walkMime(tree);
  const headers = tree.headers || headerMap(String(raw).split(/\r?\n\r?\n/)[0] || '');
  const contentType = String(headers['content-type'] || '');
  const calendar = walked.calendar || [];
  const calendarMethod = calendar.map((row) => row.method).find(Boolean)
    || calendarMethodOfPart(contentType, '');
  return {
    from: decodeMimeWords(headers.from),
    to: decodeMimeWords(headers.to),
    toList: parseAddressList(headers.to),
    cc: parseAddressList(headers.cc),
    subject: decodeMimeWords(headers.subject).trim(),
    date: headers.date || '',
    messageId: String(headers['message-id'] || '').trim(),
    references: String(headers.references || '').trim(),
    inReplyTo: String(headers['in-reply-to'] || '').trim(),
    autoSubmitted: String(headers['auto-submitted'] || '').trim(),
    // A copy the bot filed in its own mailbox (BOT_COPY_HEADER); a reader skips it.
    botCopy: Boolean(String(headers[BOT_COPY_HEADER.toLowerCase()] || '').trim()),
    contentType,
    calendar,
    calendarMethod,
    calendarReply: calendar.find((row) => row.partstat || row.dtstart) || null,
    deliveryStatus: String(walked.deliveryStatus || '').trim(),
    text: normalizeBodyText(walked.text.join('\n')),
    attachments: walked.attachments,
    attachmentNames: walked.attachments.map((part) => part.filename),
  };
}
