const QUOTE_MARKERS = [
  /(?:^|\s)>\s/,
  /_{8,}/,
  /-{3,}\s*(?:original message|opprinnelig melding|videresendt melding|forwarded message)/i,
  /\b(?:fra|from):\s.{0,300}?\b(?:sendt|sent|dato|date):/i,
  /\b\d{1,2}\.?\s+[a-zæøå]+\.?\s+\d{4},?\s*(?:kl\.?|at)?\s*\d{1,2}[:.]\d{2}.{0,120}?\b(?:skrev|wrote)\b/i,
  /\bon\s.{5,120}?\bwrote:/i,
];

/** The client's own new words: drops quoted history so old times in the thread are never read. */
export function freshReplyText(text = '') {
  const raw = String(text || '');
  const cut = Math.min(...QUOTE_MARKERS.map((re) => raw.match(re)?.index ?? raw.length));
  return raw.slice(0, cut).trim() || raw.trim();
}

export function inboxWriteBlob(message = {}) {
  // A "Re:/Sv:" subject is our own subject, often with our meeting time in it.
  const subject = /^\s*(?:re|sv|aw|vs|fwd?)\s*:/i.test(message.subject || '') ? '' : message.subject || '';
  return `${subject} ${freshReplyText(message.text)}`;
}
