/**
 * Quote verification: every extracted item must quote the meeting it came from. A quote passes when,
 * after whitespace and case are normalized (diacritics kept), it is a substring of the transcript, or
 * when at least 90 % of its words appear in one transcript line. The word-overlap path needs at
 * least four words, and every number in the quote must appear in that line, so a quote with a
 * changed figure never passes. Items that fail are dropped and counted.
 */
import { speakerOf } from './chunk.js';
import { normalizeSpace, wordTokens } from './text.js';

export const QUOTE_MAX_CHARS = 400;
export const TOKEN_OVERLAP_MIN = 0.9;
export const TOKEN_OVERLAP_MIN_WORDS = 4;

const WRAP_RE = /^[\s"'«»“”„‘’‹›`*]+|[\s"'«»“”„‘’‹›`*]+$/gu;
const ELLIPSIS_RE = /^(?:\.\.\.|…)\s*|\s*(?:\.\.\.|…)$/gu;

/** The quote as compared: wrapping quote marks and edge ellipses removed, then normalized. */
export function normalizeQuote(quote) {
  let value = String(quote ?? '').normalize('NFC');
  for (let i = 0; i < 3; i += 1) value = value.replace(WRAP_RE, '').replace(ELLIPSIS_RE, '');
  return normalizeSpace(value);
}

function counts(tokens) {
  const map = new Map();
  for (const token of tokens) map.set(token, (map.get(token) || 0) + 1);
  return map;
}

/** A verifier over one transcript. verify(quote) → { ok, how, line, speaker, overlap }. */
export function createQuoteVerifier(transcript) {
  const raw = String(transcript ?? '').replace(/\r\n?/g, '\n');
  const full = normalizeSpace(raw);
  const lines = raw.split('\n').filter((line) => line.trim()).map((line) => ({
    speaker: speakerOf(line),
    normalized: normalizeSpace(line),
    tokens: counts(wordTokens(line)),
  }));

  function lineFor(normalizedQuote) {
    return lines.find((line) => line.normalized.includes(normalizedQuote)) || null;
  }

  function verify(quote) {
    const normalized = normalizeQuote(quote);
    if (!normalized || normalized.length > QUOTE_MAX_CHARS) return { ok: false, how: normalized ? 'too-long' : 'empty', line: -1, speaker: '', overlap: 0 };
    if (full.includes(normalized)) {
      const line = lineFor(normalized);
      return { ok: true, how: 'substring', line: line ? lines.indexOf(line) : -1, speaker: line?.speaker || '', overlap: 1 };
    }
    const tokens = wordTokens(normalized);
    if (tokens.length < TOKEN_OVERLAP_MIN_WORDS) return { ok: false, how: 'not-found', line: -1, speaker: '', overlap: 0 };
    const wanted = counts(tokens);
    const numbers = [...wanted.keys()].filter((token) => /\d/.test(token));
    let best = { ok: false, how: 'not-found', line: -1, speaker: '', overlap: 0 };
    lines.forEach((line, index) => {
      if (numbers.some((number) => !line.tokens.has(number))) return;
      let shared = 0;
      for (const [token, count] of wanted) shared += Math.min(count, line.tokens.get(token) || 0);
      const overlap = shared / tokens.length;
      if (overlap > best.overlap) best = { ok: overlap >= TOKEN_OVERLAP_MIN, how: overlap >= TOKEN_OVERLAP_MIN ? 'tokens' : 'not-found', line: index, speaker: line.speaker, overlap };
    });
    return best;
  }

  return { verify, lineCount: lines.length };
}

/**
 * Keeps the items whose quote verifies against their meeting's transcript.
 * items: [{ quote, speaker, meetingId, ... }]; transcripts: Map or object meetingId → text.
 * Returns { kept, dropped: [{ item, reason }] }. Kept items get quoteVerified: true and, when the
 * matched line names a speaker, that speaker.
 */
export function verifyItemQuotes(items, transcripts) {
  const source = transcripts instanceof Map ? transcripts : new Map(Object.entries(transcripts || {}));
  const verifiers = new Map();
  const kept = [];
  const dropped = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = source.get(item?.meetingId);
    if (typeof text !== 'string' || !text) {
      dropped.push({ item, reason: 'no-transcript' });
      continue;
    }
    if (!verifiers.has(item.meetingId)) verifiers.set(item.meetingId, createQuoteVerifier(text));
    const result = verifiers.get(item.meetingId).verify(item.quote);
    if (!result.ok) {
      dropped.push({ item, reason: result.how });
      continue;
    }
    kept.push({ ...item, quoteVerified: true, ...(result.speaker ? { speaker: result.speaker } : {}) });
  }
  return { kept, dropped };
}
