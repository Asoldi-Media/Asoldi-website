// RFC 822 / MIME parsing: headers, encoded words, multipart trees, attachments.
// Raw messages are latin1 strings (one char per byte), as IMAP FETCH returns them.

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
  return { headers, contentType, body: decodePartBody(body, headers['content-transfer-encoding']), children: [] };
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
    acc.calendar.push({
      filename: filename || 'invite.ics',
      mimeType: type.split(';')[0].trim() || 'text/calendar',
      method: calendarMethodOfPart(node.contentType, raw),
    });
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
  if (type.startsWith('text/plain') && node.body) acc.text.push(decodeCharset(node.body, charset));
  else if (type.startsWith('text/html') && node.body && !acc.text.length) acc.text.push(htmlToText(decodeCharset(node.body, charset)));
  return acc;
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
    subject: decodeMimeWords(headers.subject).trim(),
    date: headers.date || '',
    messageId: String(headers['message-id'] || '').trim(),
    autoSubmitted: String(headers['auto-submitted'] || '').trim(),
    contentType,
    calendar,
    calendarMethod,
    text: walked.text.join('\n').replace(/\s+/g, ' ').trim(),
    attachments: walked.attachments,
    attachmentNames: walked.attachments.map((part) => part.filename),
  };
}
