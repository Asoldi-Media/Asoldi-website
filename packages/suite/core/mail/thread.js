/**
 * Reply trimming: the sender's own new words, never the quoted thread or a phone signature.
 * Works on multi-line text (IMAP, Gmail API, tests) and on old one-line text (bodies flattened
 * before they were stored). On one-line text there is no line start to anchor on, so a reply
 * written below the quote (bottom-posting) cannot be told apart from the quote and reads as ''.
 * Markers that can also sit inside a client's own sentence (reply attributions, device footers)
 * only count at a line start, or where they run to the end of the text or into the quote.
 */

// A date with a year: "04.11.2026", "11/4/26", "2026-11-04", "4. nov. 2026", "4 Nov 2026", "November 4, 2026".
const DATE = String.raw`(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\.?\s+[a-zæøå]{3,9}\.?,?\s+\d{4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})`;
// "Den 04.11.2026", "ons. 4. nov. 2026", "On Wed, 4 Nov 2026", "On 11/4/26", "Wednesday, November 4, 2026".
const DATE_HEAD = String.raw`(?:(?:den|on|am)\s+)?(?:(?:man|tir|ons|tor|fre|lør|søn|mon|tue|wed|thu|fri|sat|sun)[a-zæøå]*\.?,?\s+)?` + DATE;
// " 07:00", " kl. 07:00", " at 7:00 AM", " um 07:00", " 07.00 +0100".
const CLOCK = String.raw`,?\s*(?:kl\.?|klokka|klockan|at|um)?\s*\d{1,2}[:.]\d{2}(?::\d{2})?(?:\s*[ap]\.?\s?m\.?)?(?:\s*[+-]\d{4})?`;
// Reply attribution: "<date> <time>, skrev X:" (group 1 = X) or "On <date> [<time>], X <x@y> wrote:" (group 2 = X, may wrap once).
const REPLY_HEADER = new RegExp(
  String.raw`\b${DATE_HEAD}(?:${CLOCK},?\s*(?:skrev|schrieb)\b([^:]{0,160})|(?:${CLOCK})?((?:[^?!\n]|\n(?![ \t]*\n)){0,160}?)\bwrote\b[^:]{0,160}):`,
  'gi',
);
// Who wrote the quoted mail: an address, or a short capitalized name ("Kari", "Kari Nordmann", "Kari fra Firma AS").
const SENDER_EMAIL = /[^\s<>@"']+@[^\s<>@"']+\.[a-z]{2,}/i;
const SENDER_NAME = /^["'(]?\p{Lu}[\p{L}.'’-]*(?:\s+(?:\p{Lu}[\p{L}.'’-]*|fra|from|von|via|de|van|der|og|and|&))*["')]?$/u;
// Outlook / Apple Mail header block, one line or several: Fra:/Sendt:/Til:/Emne: and From:/Sent:/Date:/To:/Subject:.
// Its field labels, by what they say: who sent it, when, to whom, about what.
const BLOCK_FIELDS = {
  from: 'fra|from|från|von',
  date: 'sendt|sent|skickat|gesendet|dato|date|datum',
  to: 'til|to|till|an',
  subject: 'emne|subject|ämne|betreff',
};
const BLOCK_LABEL = new RegExp(String.raw`\*?(${Object.values(BLOCK_FIELDS).join('|')})\*?[ \t]*:`, 'gi');
const BLOCK_GROUP = Object.fromEntries(Object.entries(BLOCK_FIELDS).flatMap(([group, words]) => words.split('|').map((word) => [word, group])));
const YEAR_DATE = new RegExp(DATE, 'i');
const FORWARD = /-{2,}\s*(?:original message|original appointment|opprinnelig melding|opprinnelig avtale|videresendt melding|videresendt e-post|forwarded message|ursprüngliche nachricht|ursprungligt meddelande|vidarebefordrat meddelande|oprindelig meddelelse|videresendt meddelelse)|\b(?:begin forwarded message|start på videresendt melding|videresendt melding|videresendt e-post|forwarded message)\s*:/i;
const DEVICE_NAMES = [
  String.raw`(?:sendt|sent|skickat)\s+(?:fra|from|från)\s+(?:min|my|mi)\s+(?:iphone|ipad|android|samsung|galaxy|huawei|pixel|xiaomi|oneplus|mobil|mobiltelefon|telefon|smarttelefon|smartphone|mobile)`,
  String.raw`(?:hentet|hent|get|få|sendt|sent|skickat)\s+(?:(?:fra|from|från)\s+)?outlook\s+(?:for|til|på|för)\s+(?:android|ios|iphone|ipad)`,
  String.raw`(?:sendt|sent)\s+(?:fra|from)\s+(?:(?:e-post|mail)\s+(?:for|til)\s+windows|yahoo\s+mail)`,
  String.raw`von\s+meinem\s+\S+\s+gesendet`,
].join('|');
// What may follow the device on the footer line: model words, "for Android", a full stop, a link.
const DEVICE_TAIL = String.raw`(?:[ \t-]+(?:galaxy|note|pro|max|plus|mini|ultra|lite|se|fold|flip|[a-z]?\d{1,3}[a-z]?|\p{L}*telefon|smartphone|(?:on|for|til|på|för)[ \t]+(?:android|ios|iphone|ipad|windows)))*[.!]?`
  + String.raw`(?:[ \t]*(?:<[^<>\s]{1,200}>|\(\s*https?:\/\/[^()\s]{1,200}\s*\)|\[[^[\]\s]{1,200}\]))?`;
const DEVICE_SIGNATURE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${DEVICE_NAMES})${DEVICE_TAIL}`, 'giu');

/** First hit of a non-global regex as { index, end }, or null. */
function hit(re, text) {
  const m = re.exec(text);
  return m ? { index: m.index, end: m.index + m[0].length } : null;
}

/** The text on the same line before `index`. */
function lineBefore(text, index) {
  return text.slice(text.lastIndexOf('\n', index - 1) + 1, index);
}

function namesSender(who = '') {
  const name = String(who).replace(/^[\s,]+|[\s,]+$/g, '');
  return SENDER_EMAIL.test(name) || SENDER_NAME.test(name);
}

/** Header field labels that stand on their own: never glued to a word ("Foto:"), except "…KariFra:" where HTML lost the break. */
function blockLabels(text) {
  const out = [];
  for (const m of text.matchAll(BLOCK_LABEL)) {
    const before = text[m.index - 1] || '';
    const group = BLOCK_GROUP[m[1].toLowerCase()];
    const camelGlued = group === 'from' && /\p{Ll}/u.test(before) && /^\p{Lu}/u.test(m[1]);
    if (/[\p{L}\p{N}]/u.test(before) && !camelGlued) continue;
    out.push({ index: m.index, end: m.index + m[0].length, group });
  }
  return out;
}

/** A field value that reads like a header: an address or short name (from/to), a date with a year, any subject. */
function blockFieldOk(group, value = '') {
  const text = String(value).replace(/^[\s*]+|[\s*]+$/g, '');
  if (!text) return false;
  if (group === 'date') return YEAR_DATE.test(text);
  if (group === 'subject') return true;
  return SENDER_EMAIL.test(text) || namesSender(text.split(/[;,]/)[0]);
}

/**
 * Outlook / Apple Mail header block: a "Fra:"/"From:" label with at least two fields that read like a
 * header (see blockFieldOk) within a few lines. A client's own "Fra: mandag til fredag har vi åpent"
 * or "Dato: vi kan møtes fredag kl 13" line is not a block. { index, end } of the block, or null.
 */
function findOutlookBlock(text) {
  const labels = blockLabels(text);
  for (const [i, anchor] of labels.entries()) {
    if (anchor.group !== 'from') continue;
    const fields = new Set();
    for (let j = i; j < labels.length; j += 1) {
      const label = labels[j];
      if (j > i && (label.group === 'from' || label.index - anchor.index > 400
        || (text.slice(anchor.index, label.index).match(/\n/g) || []).length > 6)) break;
      const lineEnd = text.indexOf('\n', label.end);
      const valueEnd = Math.min(lineEnd < 0 ? text.length : lineEnd, labels[j + 1]?.index ?? text.length);
      if (blockFieldOk(label.group, text.slice(label.end, valueEnd))) fields.add(label.group);
      if (fields.size >= 2) return { index: anchor.index, end: label.end };
    }
  }
  return null;
}

/** A real attribution names a sender or runs into the quote; on multi-line text it also opens a line. */
function headerOk(text, m, multiLine) {
  const intoQuote = /^\s*(?:>|$)/.test(text.slice(m.index + m[0].length));
  if (!intoQuote && !namesSender(m[1] ?? m[2] ?? '')) return false;
  return !multiLine || intoQuote || /^[ \t>*_]*$/.test(lineBefore(text, m.index));
}

/** Earliest real reply attribution: { index, end } or null. A match that swallowed client words is cut to the real header. */
function findHeader(text, multiLine) {
  const re = new RegExp(REPLY_HEADER.source, 'gi');
  const at = (from) => {
    re.lastIndex = from;
    return re.exec(text);
  };
  const named = (m) => namesSender(m[1] ?? m[2] ?? '');
  for (let m = at(0); m; m = at(m.index + 1)) {
    const end = m.index + m[0].length;
    for (let next = at(m.index + 1); next && next.index + next[0].length === end; next = at(next.index + 1)) {
      if (text.slice(m.index, next.index).includes('\n') || (!named(m) && named(next))) m = next;
    }
    if (headerOk(text, m, multiLine)) return { index: m.index, end };
  }
  return null;
}

/** True when only whitespace, or a quote/attribution/forward block, follows `end` (looks 1500 chars ahead). */
function runsIntoQuote(text, end, multiLine) {
  const rest = text.slice(end, end + 1500);
  if (!rest.trim()) return end + 1500 >= text.length || !text.slice(end).trim();
  const next = firstMarker(rest, multiLine, ['quote', 'header', 'block']);
  return Boolean(next) && !rest.slice(0, next.index).trim();
}

/** Device footer ("Sendt fra min iPhone"): alone on its line, or running to the end of the text or into a quote. */
function findSignature(text, multiLine) {
  for (const m of text.matchAll(DEVICE_SIGNATURE)) {
    const end = m.index + m[0].length;
    const ownLine = multiLine && /^[ \t]*$/.test(lineBefore(text, m.index)) && /^[ \t]*(?:\n|$)/.test(text.slice(end));
    if (ownLine || runsIntoQuote(text, end, multiLine)) return { index: m.index, end };
  }
  return null;
}

// kind 'quote' = "> " lines, 'header' = attribution line above "> " lines, 'block' = everything below is
// the old mail, 'signature' = the sender's footer. find(text, multiLine) → { index, end } | null.
const MARKERS = [
  { kind: 'quote', find: (text, multiLine) => hit(multiLine ? /^[ \t]*>/m : /(?:^|\s)>\s/, text) },
  { kind: 'header', find: findHeader },
  { kind: 'block', name: 'outlook', find: findOutlookBlock },
  { kind: 'block', name: 'forward', find: (text) => hit(FORWARD, text) },
  { kind: 'block', name: 'rule', find: (text) => hit(/_{8,}/, text) },
  { kind: 'signature', find: findSignature },
  { kind: 'signature', find: (text, multiLine) => (multiLine ? hit(/^--[ \t]?$/m, text) : null) },
];

/** Earliest quote/signature marker in the text (only `kinds` when given): { kind, name, index, end } or null. */
function firstMarker(text, multiLine, kinds = null) {
  let best = null;
  for (const marker of MARKERS) {
    if (kinds && !kinds.includes(marker.kind)) continue;
    const found = marker.find(text, multiLine);
    if (found && (!best || found.index < best.index)) best = { kind: marker.kind, name: marker.name || '', ...found };
  }
  return best;
}

/** Text that opens with a quote: what the sender wrote below it, or '' when the rest is all quote. */
function textBelowLeadingQuote(text, lead, multiLine) {
  if (!multiLine) return '';
  let rest = text;
  if (lead.kind === 'header') {
    rest = text.slice(lead.end);
    if (!/^\s*>/.test(rest)) return '';
  } else if (lead.kind !== 'quote') {
    return '';
  }
  const lines = rest.split('\n');
  let i = 0;
  while (i < lines.length && (/^[ \t]*>/.test(lines[i]) || !lines[i].trim())) i += 1;
  return lines.slice(i).join('\n').trim();
}

/**
 * The sender's own new words: drops quoted history, forwarded mail and device signatures so old
 * content in the thread is never read again. A body that is only quote or forward returns ''
 * (a caller that needs the raw body must read message.text itself, or forwardedBodyText).
 */
export function freshReplyText(text = '') {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  const multiLine = raw.includes('\n');
  const lead = firstMarker(raw, multiLine);
  const body = lead?.index === 0 ? textBelowLeadingQuote(raw, lead, multiLine) : raw;
  const cut = firstMarker(body, multiLine);
  return (cut ? body.slice(0, cut.index) : body).trim();
}

// Header fields of a forwarded mail ("Fra:", "Sendt:", "Til:", "Emne:", "*From:*" …).
const FORWARD_FIELD = String.raw`(?:fra|from|från|von|sendt|sent|skickat|gesendet|dato|date|datum|til|to|till|an|kopi|cc|bcc|emne|subject|ämne|betreff|reply-to|svar til)`;
const FIELD_LINE = new RegExp(String.raw`^[ \t>*]*${FORWARD_FIELD}[ \t*]*:`, 'i');
const FROM_LINE = /^[ \t>*]*(?:fra|from|från|von)[ \t*]*:/i;
const FIELD_LABEL = new RegExp(String.raw`(?:^|\s)\*?(${FORWARD_FIELD})\*?\s*:`, 'gi');

/** Multi-line forward: drop the header lines (and blank lines between them); the rest is the body. */
function dropFieldLines(rest) {
  const lines = rest.split('\n');
  let from = '';
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || FIELD_LINE.test(lines[i]))) {
    if (!from && FROM_LINE.test(lines[i])) from = lines[i];
    i += 1;
  }
  return { body: lines.slice(i).join('\n').trim(), from };
}

/** One-line forward: skip a chain of distinct "Felt:" labels; the last field's value runs into the body. */
function dropFieldLabels(rest) {
  const seen = new Set();
  let cut = 0;
  let fromAt = -1;
  for (const m of rest.matchAll(FIELD_LABEL)) {
    const name = m[1].toLowerCase();
    if (m.index > cut + (seen.size ? 200 : 3) || seen.has(name)) break;
    seen.add(name);
    cut = m.index + m[0].length;
    if (fromAt < 0 && /^(?:fra|from|från|von)$/.test(name)) fromAt = cut;
  }
  return { body: rest.slice(cut).trim(), from: fromAt < 0 ? '' : rest.slice(fromAt, fromAt + 160) };
}

/**
 * Body of a forwarded mail: the text below a forward separator or an Outlook "Fra:/Sendt:/Emne:"
 * block, header lines dropped. '' when there is no forward, or a plain reply quote ("> " lines,
 * "… skrev X:") comes first. Meant for a "VS:/Fwd:" mail whose fresh text is ''. An Outlook block
 * also quotes replies, so the caller checks the subject's forward prefix first.
 * ignoreFrom (RegExp): '' when the forwarded mail's From matches (e.g. our own mail sent back).
 */
export function forwardedBodyText(text = '', { ignoreFrom = null } = {}) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  const multiLine = raw.includes('\n');
  const first = firstMarker(raw, multiLine, ['quote', 'header', 'block']);
  if (first?.kind !== 'block') return '';
  const rest = first.name === 'outlook'
    ? raw.slice(first.index).replace(/^\s+/, '')
    : raw.slice(first.end).replace(/^[ \t:*-]+/, '');
  const { body, from } = multiLine ? dropFieldLines(rest) : dropFieldLabels(rest);
  if (ignoreFrom instanceof RegExp && from && ignoreFrom.test(from)) return '';
  return body;
}

const SUBJECT_TAGS = /^(?:\s*\[[^\]]{0,40}\])+\s*/;
const REPLY_PREFIX = /^\s*(?:re|sv|svar|aw|antw|vs|vb|fw|fwd|wg|ang|tr)\s*(?:\[\d+\]|\(\d+\)|\^\d+)?\s*:\s*/i;

/** Subject without leading "[tag]"s and reply/forward prefixes (Re:, SV:, Svar:, VS:, Fwd:, Ang:, AW:, RE[2]: …). */
export function stripReplyPrefixes(subject = '') {
  let out = String(subject || '').trim();
  for (let prev = ''; prev !== out;) {
    prev = out;
    out = out.replace(SUBJECT_TAGS, '').replace(REPLY_PREFIX, '').trim();
  }
  return out;
}

/**
 * Subject + fresh text for intent classification. A reply or forward subject is our own (or the
 * forwarded mail's) subject, so it is left out. The subject is context only: never parse a
 * meeting time from it — our own reminder subjects carry slot times.
 */
export function inboxWriteBlob(message = {}) {
  const subject = String(message.subject || '').replace(SUBJECT_TAGS, '');
  const own = REPLY_PREFIX.test(subject) ? '' : subject.trim();
  return `${own} ${freshReplyText(message.text)}`;
}
