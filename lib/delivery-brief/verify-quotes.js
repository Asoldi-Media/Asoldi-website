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
 *   - it has at least TOKEN_OVERLAP_MIN_WORDS words and differs from a run of one turn only by small
 *     words added or left out (FILLER_WORDS: articles, pronouns, "og", "i", "eh", ...) or a repeated
 *     word left out ("vi vi vil"), at most one such edit per ten words. A changed word never passes,
 *     and neither does a negation ("ikke", "aldri", "uten", ...) or a number that was added or left
 *     out, so a quote that turns the statement around, or names another thing, is dropped.
 * A run that starts or ends right next to a negation of the same clause ("ha nettbutikk" out of "Vi skal
 * ikke ha nettbutikk", with at most two small words between) or inside a number written in groups fails
 * too (quoteCutReason): cut out like that, the words say the opposite or another amount.
 * A quote never spans two turns, so it cannot join two speakers. The speaker comes from the matched
 * turn; an item whose claimed speaker is not that turn's label is dropped. Items that fail are
 * dropped and counted.
 *
 * A kept item carries the transcript's own words for the matched run (punctuation and case as said),
 * never the model's copy, so a stored quote is always text from the transcript.
 */
import { splitSpeakerTurns } from './chunk.js';
import { normalizeSpace, wordSpans, wordTokens } from './text.js';

export const QUOTE_MAX_CHARS = 400;
export const TOKEN_OVERLAP_MIN = 0.9;
export const TOKEN_OVERLAP_MIN_WORDS = 4;
export const EXACT_MIN_WORDS = 3;

/** Words that turn a statement around. A quote may never add, leave out or change one. */
export const POLARITY_WORDS = Object.freeze([
  'ikke', 'ikkje', 'inte', 'ingen', 'inga', 'intet', 'ingenting', 'ingenlunde', 'aldri', 'uten', 'utan',
  'verken', 'hverken', 'korkje', 'nei', 'ei',
  'not', 'no', 'never', 'none', 'nothing', 'nobody', 'nor', 'neither', 'without', 'cannot', 't',
  'don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren', 'won', 'wouldn', 'shouldn', 'couldn',
]);

/**
 * Small words a quote may add or leave out without changing what was said: hesitations, articles,
 * pronouns, "og", "at", "som", a few prepositions and forms of "være" and "ha". Modal verbs ("vil",
 * "skal", "må"), "om", "for", "bare", "kun" and every content word are not in the list.
 */
export const FILLER_WORDS = Object.freeze([
  // Hesitations and particles.
  // ("ja" is not one: added to a question it would read as a yes.)
  'eh', 'ehm', 'eeh', 'øh', 'øhm', 'hm', 'hmm', 'mm', 'mhm', 'liksom', 'altså', 'jo', 'vel', 'da', 'så',
  'um', 'uh', 'erm', 'ah', 'oh', 'so', 'well',
  // Articles and determiners.
  'en', 'et', 'den', 'det', 'de', 'dei', 'denne', 'dette', 'disse', 'the', 'a', 'an', 'this', 'that',
  // Pronouns.
  'jeg', 'eg', 'vi', 'me', 'du', 'dere', 'han', 'hun', 'ho', 'meg', 'oss', 'deg', 'seg', 'man',
  'min', 'mitt', 'mine', 'vår', 'vårt', 'våre', 'i', 'we', 'you', 'it',
  // Conjunctions and prepositions.
  'og', 'at', 'som', 'på', 'av', 'til', 'med', 'fra', 'frå', 'hos', 'ved', 'and', 'of', 'in', 'on', 'with', 'from', 'by',
  // Forms of "være" and "ha".
  'er', 'var', 'har', 'hadde', 'blir', 'ble', 'vart', 'være', 'vere', 'vært', 'ha', 'is', 'are', 'was', 'were', 'be', 'been',
]);

const POLARITY = new Set(POLARITY_WORDS);
const FILLER = new Set(FILLER_WORDS.filter((word) => !POLARITY.has(word)));
/**
 * Negations that turn around the words right after them. "ei" is left out: in bokmål it is mostly the
 * article ("ei side"), so a quote that starts after it keeps its meaning.
 */
const CUT_NEGATIONS_BEFORE = new Set(POLARITY_WORDS.filter((word) => word !== 'ei'));
/**
 * Negations that turn around the words right before them: the ones that close a statement ("Det trenger
 * vi ikke"). "uten" or "without" after a quote starts a new phrase ("en ny linje uten navn"), and "no" is
 * "now" in nynorsk, so those do not count after a quote.
 */
const CUT_NEGATIONS_AFTER = new Set(['ikke', 'ikkje', 'inte', 'aldri', 'ingen', 'inga', 'intet', 'ingenting', 'not', 'never', 'nothing', 'none', 't']);
/** How many small words may stand between a quote's edge and a negation that still belongs to it. */
export const CUT_LOOKAROUND_WORDS = 2;
/**
 * Punctuation that closes a clause: a negation on the other side of it belongs to another statement.
 * A newline continues the turn unless the previous line already ended with . ! ? or a colon.
 */
function gapBreaksClause(gapText) {
  const lines = String(gapText ?? '').split('\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (/[.!?:]\s*$/.test(lines[i])) return true;
  }
  return /[.,;:!?()[\]{}–—…]|\s-\s/.test(lines.join(' '));
}
const WRAP_RE = /^[\s"'«»“”„‘’‹›`*]+|[\s"'«»“”„‘’‹›`*]+$/gu;
const ELLIPSIS_RE = /^(?:\.\.\.|…)\s*|\s*(?:\.\.\.|…)$/gu;
const NUMBER_RE = /\d/;
const LABEL_RE = /^([^:\n]{1,80}?):\s+/u;

/** True for a word whose edit would change what a quote says: a negation or a number. */
function fixedWord(token) {
  return POLARITY.has(token) || NUMBER_RE.test(token);
}

/** A word a quote may add or leave out. */
export function isFillerWord(token) {
  return FILLER.has(token) && !fixedWord(token);
}

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

/**
 * The cheapest way to read `quote` as a run of `line` when only these edits are allowed: a filler word
 * added in the quote, a filler word of the line left out, or a repeated line word left out ("vi vi").
 * A changed word, a negation or a number is never an allowed edit. Returns { edits, start, end } (the
 * run is line[start..end), from its first to its last matched word), or null when no allowed reading
 * exists.
 */
export function alignQuote(quote, line) {
  const m = quote.length;
  const n = line.length;
  if (!m || !n) return null;
  const dropCost = line.map((token, j) => (isFillerWord(token) || (j > 0 && line[j - 1] === token && !fixedWord(token)) ? 1 : Infinity));
  const addCost = quote.map((token) => (isFillerWord(token) ? 1 : Infinity));
  // Row 0: the run may start at any line word (free start); nothing is matched yet.
  let prevCost = new Array(n + 1).fill(0);
  let prevStart = Array.from({ length: n + 1 }, (_, j) => j);
  let prevMatched = new Array(n + 1).fill(false);
  for (let i = 1; i <= m; i += 1) {
    const cost = new Array(n + 1).fill(Infinity);
    const start = new Array(n + 1).fill(0);
    const matched = new Array(n + 1).fill(false);
    cost[0] = prevCost[0] + addCost[i - 1];
    for (let j = 1; j <= n; j += 1) {
      let best = Infinity;
      let from = j;
      let any = false;
      if (quote[i - 1] === line[j - 1] && prevCost[j - 1] < best) {
        best = prevCost[j - 1];
        from = prevStart[j - 1];
        any = true;
      }
      if (prevCost[j] + addCost[i - 1] < best) {
        best = prevCost[j] + addCost[i - 1];
        from = prevStart[j];
        any = prevMatched[j];
      }
      // A line word is left out only inside the run, after at least one matched word.
      if (matched[j - 1] && cost[j - 1] + dropCost[j - 1] < best) {
        best = cost[j - 1] + dropCost[j - 1];
        from = start[j - 1];
        any = true;
      }
      cost[j] = best;
      start[j] = from;
      matched[j] = any;
    }
    prevCost = cost;
    prevStart = start;
    prevMatched = matched;
  }
  let result = null;
  for (let j = 1; j <= n; j += 1) {
    if (!prevMatched[j] || !Number.isFinite(prevCost[j])) continue;
    if (!result || prevCost[j] < result.edits) result = { edits: prevCost[j], start: prevStart[j], end: j };
  }
  return result;
}

/**
 * Why a run of a turn's words [start, end) cannot stand as a quote on its own, or '':
 *   'negation-cut': a negation stands right before or right after the run, in the same clause (only
 *   small words between), so the run says the opposite of what was said: "ha nettbutikk på siden" out
 *   of "Vi skal ikke ha nettbutikk på siden", or "Det trenger vi" out of "Det trenger vi ikke".
 *   'number-cut': the run starts or ends inside a number written in groups ("000 kroner" out of
 *   "20 000 kroner", "har 20" out of "har 20 000").
 * Punctuation that closes a clause between the run and the word ends the check ("Nei, vi vil ha ...").
 */
export function quoteCutReason(turn, start, end) {
  const { body, spans, tokens } = turn;
  const gap = (left, right) => body.slice(spans[left].end, spans[right].start);
  // Walk outward from the run, over small words only, and stop at a clause break.
  const negationNear = (from, step) => {
    const negations = step < 0 ? CUT_NEGATIONS_BEFORE : CUT_NEGATIONS_AFTER;
    for (let i = from, seen = 0; i >= 0 && i < tokens.length && seen <= CUT_LOOKAROUND_WORDS; i += step, seen += 1) {
      const nearer = step < 0 ? i + 1 : i - 1;
      if (gapBreaksClause(step < 0 ? gap(i, nearer) : gap(nearer, i))) return false;
      if (negations.has(tokens[i])) return true;
      if (!isFillerWord(tokens[i])) return false;
    }
    return false;
  };
  if (start > 0 && negationNear(start - 1, -1)) return 'negation-cut';
  if (end < tokens.length && negationNear(end, 1)) return 'negation-cut';
  const thousands = (left, right) => /^\d{1,3}$/.test(tokens[left]) && /^\d{3}$/.test(tokens[right])
    && (gap(left, right) === '.' || /^\p{Z}+$/u.test(gap(left, right)));
  const decimal = (left, right) => /^\d+$/.test(tokens[left]) && /^\d+$/.test(tokens[right])
    && (gap(left, right) === ',' || (gap(left, right) === '.' && !/^\d{3}$/.test(tokens[right])));
  const splitNumber = (left, right) => thousands(left, right) || decimal(left, right);
  if (start > 0 && splitNumber(start - 1, start)) return 'number-cut';
  if (end < tokens.length && splitNumber(end - 1, end)) return 'number-cut';
  return '';
}

const MISS = Object.freeze({ ok: false, how: 'not-found', line: -1, speaker: '', overlap: 0, distance: Infinity, quote: '' });

/**
 * A verifier over one transcript. verify(quote, { speaker }) → { ok, how, line, speaker, overlap,
 * distance, quote }. `how`: 'substring' (a run of one turn), 'tokens' (a run with filler words added
 * or left out), or why it failed: 'empty', 'too-long', 'too-short', 'not-found', 'speaker-mismatch',
 * 'negation-cut', 'number-cut'.
 * `line` is the matched turn's index and `quote` the transcript's own words for the matched run.
 * Without `speaker` the claimed speaker is not checked.
 */
export function createQuoteVerifier(transcript) {
  const turns = splitSpeakerTurns(String(transcript ?? '')).map((turn) => {
    const body = turnBody(turn).normalize('NFC');
    const spans = wordSpans(body);
    const tokens = spans.map((span) => span.token);
    return { speaker: turn.speaker, body, spans, tokens, bag: counts(tokens), set: new Set(tokens) };
  });
  const labels = new Set(turns.map((turn) => wordTokens(turn.speaker).join(' ')).filter(Boolean));

  /** A quote copied with its line's label ("Kari: Vi startet ...") is compared without the label. */
  function withoutLabel(normalized) {
    const match = LABEL_RE.exec(normalized);
    return match && labels.has(wordTokens(match[1]).join(' ')) ? normalized.slice(match[0].length) : normalized;
  }

  /** The transcript's words for turn tokens [start, end), whitespace collapsed. */
  function spanText(turn, start, end) {
    const words = turn.body.slice(turn.spans[start].start, turn.spans[end - 1].end).replace(/\s+/g, ' ').trim();
    return words.length > QUOTE_MAX_CHARS ? words.slice(0, QUOTE_MAX_CHARS).trim() : words;
  }

  function candidate(tokens, wanted, numbers, turn, index) {
    let shared = 0;
    for (const [token, count] of wanted) shared += Math.min(count, turn.bag.get(token) || 0);
    if (shared / tokens.length < TOKEN_OVERLAP_MIN) return null;
    if (numbers.some((number) => !turn.set.has(number))) return null;
    const aligned = alignQuote(tokens, turn.tokens);
    if (!aligned) return null;
    const distance = aligned.edits;
    const overlap = 1 - distance / tokens.length;
    const found = { line: index, speaker: turn.speaker, overlap, distance, quote: spanText(turn, aligned.start, aligned.end) };
    const cut = quoteCutReason(turn, aligned.start, aligned.end);
    if (cut) return { ...found, ok: false, how: cut };
    if (distance === 0) {
      if (tokens.length >= EXACT_MIN_WORDS || tokens.length === turn.tokens.length) return { ...found, ok: true, how: 'substring', overlap: 1 };
      return { ...found, ok: false, how: 'too-short', overlap: 1 };
    }
    if (tokens.length < TOKEN_OVERLAP_MIN_WORDS || overlap < TOKEN_OVERLAP_MIN) return null;
    return { ...found, ok: true, how: 'tokens' };
  }

  function verify(quote, { speaker } = {}) {
    const normalized = normalizeQuote(quote);
    if (!normalized) return { ...MISS, how: 'empty' };
    if (normalized.length > QUOTE_MAX_CHARS) return { ...MISS, how: 'too-long' };
    const tokens = wordSpans(withoutLabel(normalized)).map((span) => span.token);
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
 * Returns { kept, dropped: [{ item, reason }] }. Kept items get quoteVerified: true, the transcript's
 * own words as `quote` (never the model's copy) and, when the matched turn names a speaker, that
 * speaker.
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
    if (!result.ok || !result.quote) {
      dropped.push({ item, reason: result.ok ? 'not-found' : result.how });
      continue;
    }
    kept.push({ ...item, quote: result.quote, quoteVerified: true, ...(result.speaker ? { speaker: result.speaker } : {}) });
  }
  return { kept, dropped };
}
