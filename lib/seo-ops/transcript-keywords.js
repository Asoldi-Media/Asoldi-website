/**
 * SEO keyword proposals from meeting transcripts. When the client talks about what they want to be
 * found for ("vi vil rangere på kjøkken på mål", "folk søker etter sykkelservice"), the phrase becomes a
 * proposal in the client's SEO record: an agreedKeywords row with status 'proposed', source 'transcript'
 * and a 'meeting:<id>' reference. A proposal is never approved here; a developer approves or blocks it.
 *
 * - proposalsFromExtraction reads the delivery brief's extracted items (lib/delivery-brief: sales, demo,
 *   workshop and iteration meetings). Only an item's quote is read, which the brief has verified to be
 *   the transcript's own words. A phrase right after a cue is kept when it is searchable (1-6 words, not
 *   a link or an address), is not the business's own name and names no prescription-only substance
 *   (phrase-filters.js, plus the shared claims list once lib/seo-ops/claims/ exists). A phrase the client
 *   turned down ("ikke bli funnet på X", "heller X enn Y") is never proposed.
 * - secondPass asks a model (task seo.agreed-extract, budget scope meetingKeywords) about the transcript
 *   chunks where the client talked about search terms but no clean phrase came out, or about every chunk
 *   with such talk when the brief is not running. A phrase is kept only when its quote verifies against
 *   the chunk and the phrase's words stand in that quote.
 * - runTranscriptKeywordStep is the delivery-loop step (registered in record.js). It does nothing while
 *   intake.transcriptKeywords is off or paused. In shadow it records what it would propose and calls no
 *   model. In auto (pilot clients, with the loop in auto) it proposes; the inputs' hash is kept in the
 *   record, so the same meetings are not handled twice and a removed proposal is not made again.
 */
import { spineModeForClient } from '../spine-mode.js';
import { chunkTranscript } from '../delivery-brief/chunk.js';
import { canonicalJson, sha256, wordTokens } from '../delivery-brief/text.js';
import { createQuoteVerifier } from '../delivery-brief/verify-quotes.js';
import {
  brandTokens,
  isExactBrandPhrase,
  normalizeSeoPhrase,
  regulatedTermIn,
  SEO_PHRASE_MAX_WORDS,
  seoPhraseKey,
  seoPhraseTokens,
  seoPhraseWordCount,
} from './phrase-filters.js';
import { proposeAgreedKeywords, readSeoRecord } from './record.js';

export const TRANSCRIPT_KEYWORDS_SWITCH = 'intake.transcriptKeywords';
export const SECOND_PASS_TASK = 'seo.agreed-extract';
export const SECOND_PASS_BUDGET_SCOPE = 'meetingKeywords';
export const SECOND_PASS_MAX_CHUNKS = 6;
export const STEP_EVERY_MS = 15 * 60 * 1000;
const PURPOSES = Object.freeze(['sales', 'demo', 'workshop', 'iteration']);

function text(value, max = 0) {
  const out = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max ? out.slice(0, max) : out;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------- keyword talk

const L = '\\p{L}\\p{N}';
const START = `(?<![${L}])`;
const END = `(?![${L}])`;
const PEOPLE = '(?:folk|kunder|kundene|noen|man|de|people|customers|someone)';

/** Words that say the client talks about search terms. */
const TALK_RE = new RegExp([
  's[øo]ke ?ord',
  `${START}rang(?:ere|erer|eres|ert|ering)${END}`,
  `${START}rank(?:e|er|et|s|ed|ing)?${END}`,
  `${START}(?:bli|blir|blitt|be|been) (?:funnet|found)${END}`,
  `${START}(?:dukke|dukker|komme|kommer) opp${END}`,
  `${START}(?:show|shows) up${END}`,
  '(?:øverst|toppen|top) (?:på|av|of|on) google',
  `${START}google[rs]?${END}`,
  `${START}(?:søker|søke|søk|search|searches|searching) (?:på|etter|for)${END}`,
  `${START}seo${END}`,
  `${START}keywords?${END}`,
].join('|'), 'iu');

/**
 * Cues right before a phrase. Each pattern ends where the phrase starts. A "when people search for"
 * part may stand between the cue and the phrase.
 */
const SEARCH_TAIL = `(?:når ${PEOPLE} (?:søker|googler) (?:på|etter)|when ${PEOPLE} search(?:es)? for)`;
const CUE_PATTERNS = [
  `rang(?:ere|erer|eres|ert)(?: (?:høyt|godt|bedre|best|øverst|først|lokalt))? (?:på|for)`,
  `rank(?:e|er|et)?(?: (?:høyt|godt|bedre))? (?:på|for)`,
  `(?:bli|blir|blitt) funnet (?:på|for|${SEARCH_TAIL})`,
  `(?:dukke|dukker|komme|kommer) opp (?:på|for|i søk (?:på|etter)|${SEARCH_TAIL})`,
  `(?:søker|søke|søk|googler|googles) (?:på|etter)`,
  `s[øo]ke ?ord(?:et|ene)?(?: (?:som|er|blir|skal være|kan være|vi vil ha|vi ønsker))?(?: (?:på|for))?(?:\\s*:)?`,
  `(?:rank|ranks|ranked|ranking)(?: (?:high|well|better))? (?:for|on)`,
  `(?:show|shows) up (?:for|on|${SEARCH_TAIL})`,
  `(?:be|been|get|gets) found (?:for|on|${SEARCH_TAIL})`,
  `search(?:es|ing)? for`,
  `keywords?(?: (?:is|are|like|such as))?(?:\\s*:)?`,
].map((source) => new RegExp(`${START}(?:${source})\\s+`, 'giu'));

/**
 * A phrase ends at clause punctuation or at one of these words: conjunctions, and the verbs and
 * pronouns that start the rest of the sentence ("kjøkken på mål er det vi tjener mest på").
 */
const STOP_WORDS = new Set([
  'og', 'eller', 'men', 'så', 'fordi', 'enn', 'når', 'hvis', 'som', 'der', 'hvor', 'slik', 'istedenfor', 'isteden',
  'mens', 'selv', 'altså', 'vel', 'liksom', 'da', 'også', 'ja', 'nei', 'heller', 'osv', 'etc',
  'er', 'var', 'blir', 'ble', 'har', 'hadde', 'kan', 'skal', 'vil', 'må', 'bør', 'det', 'vi', 'dere', 'jeg',
  'and', 'or', 'but', 'than', 'instead', 'when', 'because', 'if', 'where', 'so', 'too', 'also',
  'is', 'are', 'was', 'were', 'will', 'can', 'should', 'it', 'we', 'they',
]);
/** Small words left out at the start of a phrase. */
const LEADING_FILLERS = new Set(['en', 'et', 'ei', 'noe', 'noen', 'sånn', 'slik', 'typ', 'the', 'a', 'an', 'some', 'like']);
/** A phrase made only of these says nothing searchable. */
const EMPTY_WORDS = new Set([
  'en', 'et', 'ei', 'den', 'det', 'de', 'dem', 'noe', 'noen', 'vi', 'dere', 'oss', 'deg', 'meg', 'jeg', 'du', 'det', 'dette', 'disse',
  'the', 'a', 'an', 'it', 'this', 'that', 'we', 'us', 'you', 'them', 'og', 'eller', 'and', 'or', 'på', 'for', 'i', 'til', 'med', 'av',
  'of', 'on', 'in', 'to', 'with', 'google', 'nett', 'nettet', 'nettsiden', 'siden', 'ting', 'sånt', 'sånn', 'alt', 'mye', 'det',
]);
/** Words that turn a cue around when they stand just before it. */
const NEGATIONS = new Set(['ikke', 'ikkje', 'aldri', 'ingen', 'not', 'never', 'no', 't', 'without', 'uten']);
const CLAUSE_BREAK_RE = /[.,;:!?()[\]{}\n]|\s[-–—]\s/;
const QUOTE_OPEN_RE = /^["«“„']/;
const QUOTE_CLOSE = { '"': '"', '«': '»', '“': '”', '„': '“', "'": "'" };
const WORD_RE = new RegExp(`[${L}][${L}'’-]*`, 'gu');

/** True when the text talks about search terms or ranking. */
export function keywordTalkIn(value) {
  return TALK_RE.test(String(value ?? '').normalize('NFC'));
}

function wordsBefore(source, index, count) {
  const before = source.slice(0, index);
  // Only words of the same clause count.
  const parts = before.split(CLAUSE_BREAK_RE);
  const clause = parts[parts.length - 1] || '';
  return (clause.toLowerCase().match(WORD_RE) || []).slice(-count).map((word) => word.replace(/['’]/g, ' ').split(' ').pop());
}

/** The words after a cue, up to the end of the phrase: { phrase, end } or null. */
function phraseAt(source, start) {
  let rest = source.slice(start);
  const open = rest.match(QUOTE_OPEN_RE);
  if (open) {
    const close = rest.indexOf(QUOTE_CLOSE[open[0]], 1);
    if (close > 1) {
      const quoted = rest.slice(1, close);
      return quoted.trim() ? { phrase: quoted.trim(), end: start + close + 1 } : null;
    }
    rest = rest.slice(1);
  }
  const breakAt = rest.search(CLAUSE_BREAK_RE);
  const clause = breakAt === -1 ? rest : rest.slice(0, breakAt);
  const words = [];
  let endOffset = 0;
  for (const match of clause.matchAll(WORD_RE)) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) break;
    if (!words.length && LEADING_FILLERS.has(lower)) continue;
    words.push(word);
    endOffset = match.index + word.length;
    if (words.length > SEO_PHRASE_MAX_WORDS) break;
  }
  if (!words.length) return null;
  return { phrase: words.join(' '), end: start + (open ? 1 : 0) + endOffset };
}

/**
 * The phrases right after a cue: [{ phrase, cue, rejected }]. `rejected` is true when the client turned
 * the phrase down: a negation just before the cue ("vi vil ikke bli funnet på X"), or the "Y" of
 * "heller X enn Y".
 */
export function phrasesFromTalk(value) {
  const source = String(value ?? '').normalize('NFC');
  const out = [];
  const seen = new Set();
  for (const pattern of CUE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const at = match.index + match[0].length;
      if (seen.has(at)) continue;
      seen.add(at);
      const found = phraseAt(source, at);
      if (!found) continue;
      const negated = wordsBefore(source, match.index, 3).some((word) => NEGATIONS.has(word));
      out.push({ phrase: found.phrase, cue: match[0].trim().toLowerCase(), rejected: negated });
      // "heller X enn (på) Y": Y is what the client did not want.
      const after = source.slice(found.end);
      const instead = after.match(new RegExp(`^\\s*${START}(?:enn|than|istedenfor|instead of)${END}\\s+(?:(?:på|for|on)\\s+)?`, 'iu'));
      if (instead && /(?:heller|rather|helst)/iu.test(source.slice(Math.max(0, match.index - 40), at))) {
        const other = phraseAt(source, found.end + instead[0].length);
        if (other) out.push({ phrase: other.phrase, cue: 'enn', rejected: true });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- checks

const LINK_RE = /https?:|www\.|@|\.(?:no|com|net|org|se|dk|io)(?:\s|$)/i;
const WRAP_RE = /^[\s"'«»“”„‘’.,;:!?]+|[\s"'«»“”„‘’.,;:!?]+$/gu;

/**
 * The business's own name: exactly the name or a listed brand search (isExactBrandPhrase), or, for a name
 * of two or more identifying words, a phrase that holds all of them. A name of one word ("Testvik Te")
 * is often a town as well, so a phrase that only contains it ("teblandinger Testvik") is kept; the
 * record still flags it as a possible brand phrase for the developer.
 */
function isOwnName(phrase, brandName, brandPhrases) {
  if (isExactBrandPhrase(phrase, brandName, brandPhrases)) return true;
  const name = brandTokens(brandName);
  if (name.length < 2) return false;
  const words = new Set(seoPhraseTokens(phrase));
  return name.every((token) => words.has(token));
}

/** A candidate phrase as stored, or why it is not one: { ok, phrase, reason }. */
export function checkCandidate(value, { brandName = '', brandPhrases = [], isRegulated = (phrase) => Boolean(regulatedTermIn(phrase)) } = {}) {
  const phrase = normalizeSeoPhrase(String(value ?? '').replace(WRAP_RE, ''));
  if (!/\p{L}/u.test(phrase)) return { ok: false, phrase, reason: 'empty' };
  if (seoPhraseWordCount(phrase) > SEO_PHRASE_MAX_WORDS) return { ok: false, phrase, reason: 'too-many-words' };
  const tokens = seoPhraseTokens(phrase);
  if (LINK_RE.test(phrase) || tokens.every((token) => EMPTY_WORDS.has(token)) || (tokens.length === 1 && tokens[0].length < 3)) {
    return { ok: false, phrase, reason: 'not-searchable' };
  }
  if (isOwnName(phrase, brandName, brandPhrases)) return { ok: false, phrase, reason: 'brand' };
  if (isRegulated(phrase)) return { ok: false, phrase, reason: 'regulated' };
  return { ok: true, phrase, reason: '' };
}

/**
 * A regulated-phrase check from a claims module (the shared claims data): its regulatedTermIn(phrase) or
 * isRegulatedPhrase(phrase), and its REGULATED_SUBSTANCE_TERMS / SUBSTANCE_TERMS lists, on top of the
 * hub's own list (phrase-filters.js). Without a module, the hub's list alone.
 */
export function regulatedCheckerFrom(mod) {
  const lists = isPlainObject(mod) || typeof mod === 'object'
    ? [mod?.REGULATED_SUBSTANCE_TERMS, mod?.SUBSTANCE_TERMS].filter((list) => Array.isArray(list) && list.length)
    : [];
  const fns = mod ? [mod.regulatedTermIn, mod.isRegulatedPhrase].filter((fn) => typeof fn === 'function') : [];
  return (phrase) => {
    if (regulatedTermIn(phrase)) return true;
    for (const list of lists) if (regulatedTermIn(phrase, list.map((term) => String(term).toLowerCase()))) return true;
    for (const fn of fns) {
      try {
        if (fn(phrase)) return true;
      } catch {
        return true;
      }
    }
    return false;
  };
}

let checkerPromise = null;

/** The regulated-phrase check, with the shared claims data when the build has it (loaded once). */
export function regulatedChecker() {
  if (!checkerPromise) {
    checkerPromise = import('./claims/index.js').then((mod) => regulatedCheckerFrom(mod), () => regulatedCheckerFrom(null));
  }
  return checkerPromise;
}

// ---------------------------------------------------------------- proposals from the brief's items

function recordKeys(record) {
  const keys = new Set();
  for (const row of Array.isArray(record?.agreedKeywords) ? record.agreedKeywords : []) keys.add(seoPhraseKey(row?.phrase));
  for (const key of Array.isArray(record?.keywordProposals?.transcript?.seen) ? record.keywordProposals.transcript.seen : []) keys.add(text(key));
  keys.delete('');
  return keys;
}

/**
 * Proposals from the brief's extracted items (pure). items: [{ type, quote, speaker, meetingId, purpose,
 * chunkSha, ... }]; an item of type 'agreedKeyword' or 'keyword' with a phrase or keyword is a direct
 * candidate. Returns { proposals: [{ phrase, quoteRef, meetingId, purpose, quote }], talk: [{ meetingId,
 * purpose, chunkSha, quote }], dropped: [{ phrase, reason }] }.
 */
export function proposalsFromExtraction(items, { client = null, purpose = '', record = null, brandName = '', isRegulated } = {}) {
  const brand = text(brandName || client?.businessName);
  const brandPhrases = Array.isArray(record?.planSummary?.brand) ? record.planSummary.brand : [];
  const known = recordKeys(record);
  const candidates = [];
  const rejected = new Set();
  const talk = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isPlainObject(item)) continue;
    const itemPurpose = PURPOSES.includes(text(purpose)) ? text(purpose) : (PURPOSES.includes(text(item.purpose)) ? text(item.purpose) : 'sales');
    const base = { meetingId: text(item.meetingId, 120), purpose: itemPurpose, quote: text(item.quote, 400) };
    const direct = text(item.phrase || item.keyword);
    if ((item.type === 'agreedKeyword' || item.type === 'keyword') && direct) {
      candidates.push({ ...base, phrase: direct });
      continue;
    }
    if (!base.quote || !keywordTalkIn(base.quote)) continue;
    const found = phrasesFromTalk(base.quote);
    for (const entry of found) {
      if (entry.rejected) rejected.add(seoPhraseKey(normalizeSeoPhrase(entry.phrase)));
      else candidates.push({ ...base, phrase: entry.phrase });
    }
    if (!found.length) talk.push({ meetingId: base.meetingId, purpose: itemPurpose, chunkSha: text(item.chunkSha, 64), quote: base.quote });
  }
  const proposals = [];
  const dropped = [];
  const taken = new Set();
  for (const candidate of candidates) {
    const checked = checkCandidate(candidate.phrase, { brandName: brand, brandPhrases, ...(isRegulated ? { isRegulated } : {}) });
    if (!checked.ok) {
      dropped.push({ phrase: checked.phrase || text(candidate.phrase, 80), reason: checked.reason });
      continue;
    }
    const key = seoPhraseKey(checked.phrase);
    if (rejected.has(key)) {
      dropped.push({ phrase: checked.phrase, reason: 'turned-down' });
      continue;
    }
    if (known.has(key) || taken.has(key)) continue;
    taken.add(key);
    proposals.push({ phrase: checked.phrase, quoteRef: `meeting:${candidate.meetingId}`.slice(0, 120), meetingId: candidate.meetingId, purpose: candidate.purpose, quote: candidate.quote });
  }
  return { proposals, talk, dropped };
}

// ---------------------------------------------------------------- the focused second pass

const SECOND_PASS_SYSTEM = [
  'You read part of a recorded meeting between a web agency and its client.',
  'List the search phrases the CLIENT said they want their business to be found for on Google: what customers would type.',
  'Copy each phrase exactly as it was said. Give the sentence it is in as `quote`, copied exactly from the transcript, at most 15 words. `speaker` is the label before the colon on that line.',
  'Leave out phrases the client turned down, the business\'s own name, and anything that is not a search phrase. Answer with JSON only; an empty list when there is none.',
].join('\n');

export function secondPassSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['keywords'],
    properties: {
      keywords: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['phrase', 'quote', 'speaker'],
          properties: { phrase: { type: 'string' }, quote: { type: 'string' }, speaker: { type: 'string' } },
        },
      },
    },
  };
}

/**
 * True when a negation stands before word `at` of the quote in the same clause ("Vi vil ikke bli funnet
 * på X"): the client turned the phrase down.
 */
function negatedBefore(quote, at) {
  const source = String(quote).normalize('NFC');
  const words = [...source.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({ token: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length }));
  if (at <= 0 || at >= words.length) return false;
  for (let i = at - 1; i >= 0; i -= 1) {
    if (CLAUSE_BREAK_RE.test(source.slice(words[i].end, words[i + 1].start))) return false;
    if (NEGATIONS.has(words[i].token)) return true;
  }
  return false;
}

/** Index of `needle` as a contiguous run in `tokens`, or -1. */
function runIndex(tokens, needle) {
  if (!needle.length) return -1;
  for (let i = 0; i + needle.length <= tokens.length; i += 1) {
    if (needle.every((token, j) => tokens[i + j] === token)) return i;
  }
  return -1;
}

/**
 * Asks the model about each chunk (at most maxChunks). chunks: [{ meetingId, purpose, chunkSha, text }].
 * A phrase is kept when its quote verifies against the chunk (the transcript's own words), the phrase's
 * words stand together in that quote, and no negation stands just before them. The first failed call
 * stops the run (halted). Returns { phrases: [{ phrase, quote, meetingId, purpose }], calls, costUsd,
 * errors, halted }.
 */
export async function secondPass({ chunks = [], llm, clientId = '', maxChunks = SECOND_PASS_MAX_CHUNKS, signal = null } = {}) {
  const out = { phrases: [], calls: 0, costUsd: 0, errors: [], halted: false };
  for (const chunk of (Array.isArray(chunks) ? chunks : []).slice(0, Math.max(0, maxChunks))) {
    const body = String(chunk?.text ?? '');
    if (!body.trim()) continue;
    let result;
    try {
      out.calls += 1;
      result = await llm.json({
        task: SECOND_PASS_TASK,
        system: SECOND_PASS_SYSTEM,
        user: `Meeting purpose: ${text(chunk.purpose) || 'sales'}.\n\nTranscript part:\n${body}`,
        schema: secondPassSchema(),
        ctx: { salesClientId: text(clientId), dataClass: 'transcript', budgetScope: SECOND_PASS_BUDGET_SCOPE, jobId: `meeting-keywords:${text(clientId)}` },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      out.errors.push(text(error?.code || error?.name || 'error', 60));
      out.halted = true;
      break;
    }
    out.costUsd += Number(result?.usd) || 0;
    const verifier = createQuoteVerifier(body);
    for (const row of Array.isArray(result?.data?.keywords) ? result.data.keywords : []) {
      if (!isPlainObject(row)) continue;
      const verified = verifier.verify(String(row.quote ?? ''), { speaker: String(row.speaker ?? '') });
      if (!verified.ok || !verified.quote) continue;
      const tokens = wordTokens(verified.quote);
      const at = runIndex(tokens, wordTokens(row.phrase));
      if (at === -1) continue;
      if (negatedBefore(verified.quote, at)) continue;
      out.phrases.push({ phrase: normalizeSeoPhrase(row.phrase), quote: verified.quote, meetingId: text(chunk.meetingId, 120), purpose: text(chunk.purpose) });
    }
  }
  out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
  return out;
}

// ---------------------------------------------------------------- the delivery-loop step

async function readExtractionFor(clientId, ctx) {
  const deps = isPlainObject(ctx.deps) ? ctx.deps : {};
  if (typeof deps.readExtraction === 'function') return deps.readExtraction(clientId);
  try {
    const store = await import('../delivery-brief/store.js');
    return typeof store.readExtraction === 'function' ? store.readExtraction(clientId, { dataDir: ctx.dataDir }) : null;
  } catch {
    return null;
  }
}

async function readMeetingsFor(client, ctx) {
  const deps = isPlainObject(ctx.deps) ? ctx.deps : {};
  let list = [];
  if (typeof deps.readTranscripts === 'function') list = await deps.readTranscripts(client);
  else {
    try {
      const sources = await import('../delivery-brief/sources.js');
      list = typeof sources.readClientTranscripts === 'function' ? await sources.readClientTranscripts(client, { log: ctx.log }) : [];
    } catch {
      list = [];
    }
  }
  return (Array.isArray(list) ? list : [])
    .filter((meeting) => isPlainObject(meeting) && text(meeting.meetingId) && String(meeting.transcript ?? '').trim())
    .map((meeting) => ({ meetingId: text(meeting.meetingId, 120), purpose: PURPOSES.includes(text(meeting.purpose)) ? text(meeting.purpose) : 'sales', transcript: String(meeting.transcript) }));
}

/** The chunks the second pass reads: those the talk items came from, or (no extraction) every chunk with talk. */
function secondPassChunks(found, meetings, haveExtraction) {
  const wanted = new Set(found.talk.map((row) => `${row.meetingId}:${row.chunkSha}`));
  const out = [];
  for (const meeting of meetings) {
    for (const chunk of chunkTranscript(meeting.transcript)) {
      const take = haveExtraction ? wanted.has(`${meeting.meetingId}:${chunk.sha}`) : keywordTalkIn(chunk.text);
      if (take) out.push({ meetingId: meeting.meetingId, purpose: meeting.purpose, chunkSha: chunk.sha, text: chunk.text });
    }
  }
  return out;
}

async function defaultLlm() {
  const mod = await import('../llm/index.js');
  return mod.getHubLlm();
}

/**
 * The delivery-loop step for one client. Answers { wrote, ... }:
 *   skipped 'switch-off' while intake.transcriptKeywords is off or paused (nothing is read);
 *   skipped 'no-meetings' or 'unchanged' when there is nothing new;
 *   shadow: true with the phrases it would propose (no model call, no write besides ctx.shadow);
 *   added / skipped / secondPass in auto.
 */
export async function runTranscriptKeywordStep(ctx = {}, client = null) {
  const clientId = text(client?.id);
  let mode = 'off';
  try {
    mode = clientId ? spineModeForClient(TRANSCRIPT_KEYWORDS_SWITCH, client, { settings: ctx.settings, dataDir: ctx.dataDir }) : 'off';
  } catch {
    mode = 'off';
  }
  if (mode === 'off' || mode === 'paused') return { wrote: false, skipped: 'switch-off' };
  try {
    const deps = isPlainObject(ctx.deps) ? ctx.deps : {};
    const extraction = await readExtractionFor(clientId, ctx);
    const meetings = await readMeetingsFor(client, ctx);
    const items = Array.isArray(extraction?.items) ? extraction.items : [];
    if (!items.length && !meetings.length) return { wrote: false, skipped: 'no-meetings' };
    const sourceHash = sha256(canonicalJson({
      extraction: extraction ? text(extraction.inputHash) || sha256(canonicalJson(items)) : '',
      meetings: meetings.map((meeting) => `${meeting.meetingId}:${sha256(meeting.transcript)}`).sort(),
    }));
    const readRecord = typeof deps.readRecord === 'function' ? deps.readRecord : readSeoRecord;
    const record = readRecord(clientId);
    if (text(record?.keywordProposals?.transcript?.sourceHash) === sourceHash) return { wrote: false, skipped: 'unchanged' };
    const isRegulated = typeof deps.isRegulated === 'function' ? deps.isRegulated : await regulatedChecker();
    const brandName = text(client.businessName);
    const found = proposalsFromExtraction(items, { client, record, brandName, isRegulated });
    const chunks = secondPassChunks(found, meetings, Boolean(extraction));
    if (mode !== 'auto' || ctx.mode !== 'auto') {
      const phrases = found.proposals.map((row) => row.phrase);
      if (typeof ctx.shadow === 'function') {
        ctx.shadow(`seo-transcript-keywords:${clientId}:${sourceHash.slice(0, 16)}`, { kind: 'seo-transcript-keywords', clientId, phrases, secondPassChunks: chunks.length });
      }
      return { wrote: false, shadow: true, phrases };
    }
    let second = { phrases: [], calls: 0, halted: false, errors: [] };
    if (chunks.length) second = await secondPass({ chunks, llm: deps.llm || (await defaultLlm()), clientId });
    const rows = found.proposals.map((row) => ({ phrase: row.phrase, quoteRef: row.quoteRef }));
    const taken = new Set(rows.map((row) => seoPhraseKey(row.phrase)));
    const known = recordKeys(record);
    const brandPhrases = Array.isArray(record?.planSummary?.brand) ? record.planSummary.brand : [];
    for (const row of second.phrases) {
      const checked = checkCandidate(row.phrase, { brandName, brandPhrases, isRegulated });
      const key = seoPhraseKey(checked.phrase);
      if (!checked.ok || taken.has(key) || known.has(key)) continue;
      taken.add(key);
      rows.push({ phrase: checked.phrase, quoteRef: `meeting:${row.meetingId}`.slice(0, 120) });
    }
    const result = await proposeAgreedKeywords(clientId, rows, { source: 'transcript', by: 'transcript-keywords', brandName, sourceHash: second.halted ? '' : sourceHash });
    return {
      wrote: result.added.length > 0 || !second.halted,
      added: result.added,
      skipped: result.skipped,
      secondPass: { calls: second.calls, halted: second.halted, errors: second.errors },
    };
  } catch (error) {
    const code = text(error?.code || error?.message || 'error', 120);
    ctx.log?.warn?.(`[seo-transcript-keywords] ${clientId}: ${code}`);
    return { wrote: false, error: code };
  }
}
