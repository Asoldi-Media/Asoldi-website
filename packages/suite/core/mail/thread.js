// Quote markers in English and the Scandinavian languages mail clients write.
const QUOTE_MARKERS = [
  /(?:^|\s)>\s/,
  /_{8,}/,
  /-{3,}\s*(?:original message|opprinnelig melding|videresendt melding|forwarded message)/i,
  /\b(?:fra|from):\s.{0,300}?\b(?:sendt|sent|dato|date):/i,
  /\b\d{1,2}\.?\s+[a-zæøå]+\.?\s+\d{4},?\s*(?:kl\.?|at)?\s*\d{1,2}[:.]\d{2}.{0,120}?\b(?:skrev|wrote)\b/i,
  /\bon\s.{5,120}?\bwrote:/i,
];

/** The sender's own new words: drops quoted history so old content in the thread is never read again. */
export function freshReplyText(text = '') {
  const raw = String(text || '');
  const cut = Math.min(...QUOTE_MARKERS.map((re) => raw.match(re)?.index ?? raw.length));
  return raw.slice(0, cut).trim() || raw.trim();
}

/** Subject + fresh text. A "Re:/Sv:" subject is our own subject, so it is left out. */
export function inboxWriteBlob(message = {}) {
  const subject = /^\s*(?:re|sv|aw|vs|fwd?)\s*:/i.test(message.subject || '') ? '' : message.subject || '';
  return `${subject} ${freshReplyText(message.text)}`;
}
