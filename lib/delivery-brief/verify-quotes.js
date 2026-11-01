/**
 * Quote verification: every extracted item must quote the meeting it came from, inside one speaker
 * turn ("Speaker: text" and its continuation lines; the label itself is not part of the text).
 * Quotes and turns are compared as word tokens (letters and digits, whitespace and case normalized,
 * diacritics kept), so a quote never matches part of a word or part of a number ("20" is not in
 * "2020").
 *
 * A quote passes when
 *   - its tokens are a contiguous run of one turn's tokens, and it has at least EXACT_MIN_WORDS words
 *     or is the whole turn ("Ja."), or
 *   - it has at least TOKEN_OVERLAP_MIN_WORDS words and is at least 90 % equal to a run of one turn's
 *     tokens in order (one word changed, added or left out per ten words), and every number in it is a
 *     whole token of that turn.
 * A quote never spans two turns, so it cannot join two speakers. The speaker comes from the matched
 * turn; an item whose claimed speaker is not that turn's label is dropped. Items that fail are
 * dropped and counted.
 */
import { splitSpeakerTurns } from './chunk.js';
import { normalizeSpace, wordTokens } from './text.js';

export const QUOTE_MAX_CHARS = 400;
export const TOKEN_OVERLAP_MIN = 0.9;
export const TOKEN_OVERLAP_MIN_WORDS = 4;
export const EXACT_MIN_WORDS = 3;

const WRAP_RE = /^[\s"'«»“”„‘’‹›`*]+|[\s"'«»“”„‘’‹›`*]+$/gu;
const ELLIPSIS_RE = /^(?:\.\.\.|…)\s*|\s*(?:\.\.\.|…)$/gu;
const NUMBER_RE = /\d/;
const LABEL_RE = /^([^:\n]{1,80}?):\s+/u;

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

/** The turn's text without its "Speaker:" label. */
function turnBody(turn) {
  if (!turn.speaker) return turn.text;
  const colon = turn.text.indexOf(':');
  return colon >= 0 ? turn.text.slice(colon + 1) : turn.text;
}

/**
 * True when a claimed speaker names the turn's speaker: the same label, or one label's words are all
 * in the other ("Kari" for "Kari Nordmann"). A turn without a label cannot be checked and accepts any.
 */
export function speakerMatches(claimed, turnSpeaker) {
  const turn = wordTokens(turnSpeaker);
  if (!turn.length) return true;
  const claim = wordTokens(claimed);
  if (!claim.length) return false;
  const turnSet = new Set(turn);
  const claimSet = new Set(claim);
  return claim.every((token) => turnSet.has(token)) || turn.every((token) => claimSet.has(token));
}

/**
 * The fewest token edits (change, add or leave out one word) that turn `quote` into some contiguous
 * run of `line` (free start and end in the line). 0 means the quote is a run of the line.
 */
export function runDistance(quote, line) {
  const m = quote.length;
  const n = line.length;
  if (!m) return 0;
  let previous = new Array(n + 1).fill(0);
  let current = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    current[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const same = quote[i - 1] === line[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j - 1] + same, previous[j] + 1, current[j - 1] + 1);
    }
    [previous, current] = [current, previous];
  }
  let best = Infinity;
  for (let j = 0; j <= n; j += 1) if (previous[j] < best) best = previous[j];
  return best;
}

const MISS = Object.freeze({ ok: false, how: 'not-found', line: -1, speaker: '', overlap: 0, distance: Infinity });

/**
 * A verifier over one transcript. verify(quote, { speaker }) → { ok, how, line, speaker, overlap, distance }.
 * `how`: 'substring' (a run of one turn), 'tokens' (90 % in order), or why it failed: 'empty',
 * 'too-long', 'too-short', 'not-found', 'speaker-mismatch'. `line` is the matched turn's index.
 * Without `speaker` the claimed speaker is not checked.
 */
export function createQuoteVerifier(transcript) {
  const turns = splitSpeakerTurns(String(transcript ?? '')).map((turn) => {
    const tokens = wordTokens(turnBody(turn));
    return { speaker: turn.speaker, tokens, bag: counts(tokens), set: new Set(tokens) };
  });
  const labels = new Set(turns.map((turn) => wordTokens(turn.speaker).join(' ')).filter(Boolean));

  /** A quote copied with its line's label ("Kari: Vi startet ...") is compared without the label. */
  function withoutLabel(normalized) {
    const match = LABEL_RE.exec(normalized);
    return match && labels.has(wordTokens(match[1]).join(' ')) ? normalized.slice(match[0].length) : normalized;
  }

  function candidate(tokens, wanted, numbers, turn, index) {
    let shared = 0;
    for (const [token, count] of wanted) shared += Math.min(count, turn.bag.get(token) || 0);
    if (shared / tokens.length < TOKEN_OVERLAP_MIN) return null;
    const distance = runDistance(tokens, turn.tokens);
    const overlap = 1 - distance / tokens.length;
    if (distance === 0) {
      if (tokens.length >= EXACT_MIN_WORDS || tokens.length === turn.tokens.length) {
        return { ok: true, how: 'substring', line: index, speaker: turn.speaker, overlap: 1, distance: 0 };
      }
      return { ok: false, how: 'too-short', line: index, speaker: turn.speaker, overlap: 1, distance: 0 };
    }
    if (tokens.length < TOKEN_OVERLAP_MIN_WORDS || overlap < TOKEN_OVERLAP_MIN) return null;
    if (numbers.some((number) => !turn.set.has(number))) return null;
    return { ok: true, how: 'tokens', line: index, speaker: turn.speaker, overlap, distance };
  }

  function verify(quote, { speaker } = {}) {
    const normalized = normalizeQuote(quote);
    if (!normalized) return { ...MISS, how: 'empty' };
    if (normalized.length > QUOTE_MAX_CHARS) return { ...MISS, how: 'too-long' };
    const tokens = wordTokens(withoutLabel(normalized));
    if (!tokens.length) return { ...MISS, how: 'empty' };
    const wanted = counts(tokens);
    const numbers = [...wanted.keys()].filter((token) => NUMBER_RE.test(token));
    const checkSpeaker = speaker !== undefined;
    let best = null;
    let shortest = null;
    let mismatch = null;
    turns.forEach((turn, index) => {
      const found = candidate(tokens, wanted, numbers, turn, index);
      if (!found) return;
      if (!found.ok) {
        shortest = shortest || found;
        return;
      }
      if (checkSpeaker && !speakerMatches(speaker, turn.speaker)) {
        mismatch = mismatch || found;
        return;
      }
      if (!best || found.distance < best.distance) best = found;
    });
    if (best) return best;
    if (mismatch) return { ...mismatch, ok: false, how: 'speaker-mismatch' };
    if (shortest) return shortest;
    return { ...MISS };
  }

  return { verify, lineCount: turns.length };
}

/**
 * Keeps the items whose quote verifies against their meeting's transcript and whose speaker is the
 * matched turn's speaker.
 * items: [{ quote, speaker, meetingId, ... }]; transcripts: Map or object meetingId → text.
 * Returns { kept, dropped: [{ item, reason }] }. Kept items get quoteVerified: true and, when the
 * matched turn names a speaker, that speaker.
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
    const result = verifiers.get(item.meetingId).verify(item.quote, { speaker: String(item?.speaker ?? '') });
    if (!result.ok) {
      dropped.push({ item, reason: result.how });
      continue;
    }
    kept.push({ ...item, quoteVerified: true, ...(result.speaker ? { speaker: result.speaker } : {}) });
  }
  return { kept, dropped };
}
