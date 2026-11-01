// Brief extractor: chunking, quote verification, the map step through the real hub LLM facade with
// stubbed provider adapters (no network), the deterministic reduce, and resuming an interrupted
// extraction from cached chunks. Transcripts are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-brief-extract-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.DATA_DIR;
for (const key of Object.keys(process.env)) if (/^(AI_PROFILE|AI_TEST_MODE|AI_ROUTE_|HUB_SAFE_MODE|HUB_LLM_FACADE)/.test(key)) delete process.env[key];

const { CHUNK_MAX_CHARS, chunkTranscript, splitSpeakerTurns } = await import('../lib/delivery-brief/chunk.js');
const { createQuoteVerifier, normalizeQuote, runDistance, speakerMatches, verifyItemQuotes } = await import('../lib/delivery-brief/verify-quotes.js');
const {
  MAX_CHUNK_ATTEMPTS,
  backoffDelayMs,
  createChunkCache,
  createMemoryChunkCache,
  extractMeeting,
  mapSchema,
  normalizeMapOutput,
  promptFor,
  statHasQuotedNumber,
  taskForPurpose,
} = await import('../lib/delivery-brief/extract.js');
const { wordTokens } = await import('../lib/delivery-brief/text.js');
const { llmMergeItems, reduceItems } = await import('../lib/delivery-brief/reduce.js');
const { createHubLlm } = await import('../lib/llm/index.js');
const { validateJson } = await import('../packages/suite/core/llm/json.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

// ---------------------------------------------------------------- synthetic meetings

const SIGNALS = {
  brand: 'Kunde: Firmaet heter Eksempel Bad og vi holder til i Eksempelby.',
  years: 'Kunde: Vi har drevet med flislegging i 26 år her i byen.',
  header: 'Kunde: Telefonnummeret på siden skal stå helt øverst i menyen.',
  blog: 'Selger: Bloggen er inkludert i pakken, og vi skriver innlegg hver måned.',
  gallery: 'Kunde: Vi vil gjerne at forsiden viser bilder av ferdige bad fra kunder i hele fylket.',
  // Two adjacent turns by two speakers, a year, and a negation: material for planted fabrications.
  started: 'Kunde: Vi startet i 2020 og har nå åtte ansatte.\nSelger: Flott, da lager vi en side for flisfirmaet.',
  noShop: 'Kunde: Vi skal ikke ha nettbutikk på siden.',
};

function filler(prefix, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const who = i % 2 ? 'Kunde' : 'Selger';
    out.push(`${who}: ${prefix} punkt ${i} handler om farger, fonter og rekkefølgen på seksjonene på forsiden, linje ${i}.`);
  }
  return out;
}

/** A transcript of about `lines` lines with the signal lines spread through it. */
function transcript(prefix, lines, signals) {
  const body = filler(prefix, lines);
  signals.forEach((line, index) => body.splice(Math.floor(((index + 1) * body.length) / (signals.length + 1)), 0, line));
  return body.join('\n');
}

const SALES = transcript('Salg', 160, [SIGNALS.brand, SIGNALS.years, SIGNALS.blog, SIGNALS.started, SIGNALS.noShop]);
const WORKSHOP = transcript('Workshop', 120, [SIGNALS.header, SIGNALS.gallery]);

// Quotes no transcript contains in a form the rules accept. Every one must be rejected.
const PLANTED = [
  'Vi har vunnet tre priser for beste bad i landet',
  'Vi har drevet med flislegging i 40 år',
  'Vi har drevet med flislegging i 26 ar',
  'Vi ønsker at nummeret står øverst',
  'Firmaet heter Eksempel Kjøkken',
  'bloggen koster ekstra hver måned',
  'Telefonnummeret skal stå helt nederst i bunnteksten',
];

// Fabrications that a character-substring check over the whole transcript would let through. Each
// planted item carries the word "plantet" in its value, ask or text; none may survive.
const PLANTED_SHORT = [
  // 1-2 words that do occur in the transcript.
  { list: 'facts', item: { path: 'positioning.audience', value: 'plantet: kort', quote: 'og har', speaker: 'Kunde' } },
  { list: 'facts', item: { path: 'claims.awards', value: 'plantet: ett ord', quote: 'nettbutikk', speaker: 'Kunde' } },
  // A number inside a longer number: "20" in "2020", alone and in a stat.
  { list: 'facts', item: { path: 'claims.stats', value: 'plantet: 20 år', number: 20, unit: 'år', label: 'erfaring', quote: '20', speaker: 'Kunde' } },
  { list: 'facts', item: { path: 'claims.stats', value: 'plantet: 20 år', number: 20, unit: 'år', label: 'erfaring', quote: 'Vi startet i 2020 og har', speaker: 'Kunde' } },
  // A word fragment.
  { list: 'facts', item: { path: 'identity.brandName', value: 'plantet: fragment', quote: 'lisfirma', speaker: 'Selger' } },
  // Across two turns (two speakers).
  { list: 'directives', item: { kind: 'add', area: 'hero', ask: 'plantet: to linjer', quote: 'nå åtte ansatte. Selger: Flott, da lager vi', speaker: 'Kunde' } },
  // A real quote under the wrong speaker.
  { list: 'facts', item: { path: 'identity.brandName', value: 'plantet: feil taler', quote: 'Firmaet heter Eksempel Bad', speaker: 'Selger' } },
  // A word left out that turns the meaning around ("ikke").
  { list: 'directives', item: { kind: 'add', area: 'products', ask: 'plantet: nettbutikk', quote: 'Vi skal ha nettbutikk på siden', speaker: 'Kunde' } },
];

function emptyAnswer() {
  return { facts: [], directives: [], iterations: [], promises: [], followUps: [], approvalSignals: [], requests: [], openQuestions: [] };
}

/** What a careful model would answer for one chunk, plus planted fabrications in every chunk. */
function answerFor(chunkText) {
  const answer = emptyAnswer();
  if (chunkText.includes(SIGNALS.brand)) answer.facts.push({ path: 'identity.brandName', value: 'Eksempel Bad', quote: 'Firmaet heter Eksempel Bad', speaker: 'Kunde', confidence: 0.9 });
  if (chunkText.includes(SIGNALS.years)) {
    answer.facts.push({ path: 'claims.stats', value: '26 år', number: 26, unit: 'years', label: 'i bransjen', quote: '«Vi har drevet med  flislegging i 26 år»', speaker: 'Kunde', confidence: 0.9 });
  }
  if (chunkText.includes(SIGNALS.header)) {
    answer.directives.push({ kind: 'change', scope: 'section', area: 'chrome.header', ask: 'Telefonnummeret øverst i menyen', priority: 'must', quote: 'telefonnummeret på siden skal stå helt øverst', speaker: 'Kunde', confidence: 0.85 });
  }
  if (chunkText.includes(SIGNALS.gallery)) {
    // Punctuation differs from the line: passes on word overlap.
    answer.directives.push({ kind: 'add', area: 'hero', ask: 'Bilder av ferdige bad på forsiden', priority: 'should', quote: 'Vi vil gjerne at forsiden viser bilder av ferdige bad fra kunder i hele fylket!', speaker: 'Kunde' });
  }
  if (chunkText.includes(SIGNALS.blog)) answer.promises.push({ featureKey: 'blog.autoPosts', text: 'Blogginnlegg hver måned', quote: 'vi skriver innlegg hver måned', speaker: 'Selger' });
  // Planted fabrications.
  answer.facts.push({ path: 'claims.awards', value: 'Tre priser', quote: PLANTED[0], speaker: 'Kunde' });
  answer.facts.push({ path: 'claims.stats', value: '40 år', number: 40, unit: 'years', label: 'i bransjen', quote: PLANTED[1], speaker: 'Kunde' });
  answer.facts.push({ path: 'claims.stats', value: '26 år', number: 26, unit: 'years', label: 'i bransjen', quote: PLANTED[2], speaker: 'Kunde' });
  answer.directives.push({ kind: 'change', area: 'chrome.header', ask: 'Nummer øverst', quote: PLANTED[3], speaker: 'Kunde' });
  answer.facts.push({ path: 'identity.brandName', value: 'Eksempel Kjøkken', quote: PLANTED[4], speaker: 'Kunde' });
  answer.promises.push({ featureKey: 'blog.posts', text: 'Blogg mot betaling', quote: PLANTED[5], speaker: 'Selger' });
  answer.directives.push({ kind: 'change', area: 'footer', ask: 'Nummer nederst', quote: PLANTED[6], speaker: 'Kunde' });
  for (const { list, item } of PLANTED_SHORT) answer[list].push({ ...item });
  // A stat whose quote is real but does not hold its number: dropped.
  answer.facts.push({ path: 'claims.stats', value: '15', number: 15, unit: 'jobs', label: 'jobber', quote: 'Telefonnummeret på siden skal stå helt øverst', speaker: 'Kunde' });
  // Items without a quote or speaker are invalid.
  answer.openQuestions.push({ text: 'Uten sitat', quote: '', speaker: 'Kunde' });
  answer.followUps.push({ text: 'Uten taler', quote: 'Bloggen er inkludert i pakken', speaker: '' });
  return answer;
}

function chunkOf(user) {
  const marker = 'Transcript part:\n';
  const at = String(user || '').indexOf(marker);
  return at >= 0 ? user.slice(at + marker.length) : '';
}

/** Provider adapters for the facade: claude answers, deepseek must never be called. */
function stubProviders({ failAfter = Infinity, answer = answerFor } = {}) {
  const calls = { claude: 0, deepseek: 0, gemini: 0, tasks: [], dataClasses: [] };
  let served = 0;
  const reply = (call) => {
    calls.tasks.push(call.task);
    if (served >= failAfter) throw Object.assign(new Error('stub outage'), { status: 529, code: 'overloaded' });
    served += 1;
    return { servedModel: call.model, text: JSON.stringify(answer(chunkOf(call.user), call)), stopReason: 'end_turn', usage: { inputTokens: 2000, outputTokens: 300 } };
  };
  return {
    calls,
    providers: {
      claude: async (call) => {
        calls.claude += 1;
        return reply(call);
      },
      deepseek: async () => {
        calls.deepseek += 1;
        throw new Error('deepseek must not receive transcript data');
      },
      gemini: async () => {
        calls.gemini += 1;
        throw new Error('gemini must not be called');
      },
    },
  };
}

function facadeFor(profile, stub, dir = mkdtempSync(join(dataDir, `llm-${profile}-`))) {
  const env = { AI_PROFILE: profile, ANTHROPIC_API_KEY: 'test-key', DEEPSEEK_API_KEY: 'test-key', GEMINI_API_KEY: 'test-key' };
  return { dir, llm: createHubLlm({ dataDir: dir, env, providers: stub.providers, log: { warn() {}, log() {}, error() {} } }) };
}

// ---------------------------------------------------------------- chunking

test('chunks: at most 9,000 characters, cut between speaker turns, with up to 600 characters of overlap', () => {
  const text = transcript('Lang', 900, []);
  const chunks = chunkTranscript(text);
  assert.ok(chunks.length >= 5, `${chunks.length} chunks`);
  for (const chunk of chunks) {
    assert.ok(chunk.chars <= CHUNK_MAX_CHARS, `${chunk.chars} chars`);
    assert.match(chunk.text, /^(Kunde|Selger): /, 'a chunk starts on a speaker line');
    assert.equal(chunk.text.split('\n').every((line) => /^(Kunde|Selger): /.test(line)), true);
  }
  for (let i = 1; i < chunks.length; i += 1) {
    const firstLine = chunks[i].text.split('\n')[0];
    assert.ok(chunks[i - 1].text.includes(firstLine), `chunk ${i} starts with the end of chunk ${i - 1}`);
    const previousLines = new Set(chunks[i - 1].text.split('\n'));
    const shared = chunks[i].text.split('\n').filter((line) => previousLines.has(line)).join('\n');
    assert.ok(shared.length > 0 && shared.length <= 600, `overlap ${shared.length}`);
  }
  const lines = text.split('\n');
  const covered = new Set(chunks.flatMap((chunk) => chunk.text.split('\n')));
  assert.equal(lines.every((line) => covered.has(line)), true, 'every line is in some chunk');
  assert.deepEqual(chunkTranscript(text).map((chunk) => chunk.sha), chunks.map((chunk) => chunk.sha), 'deterministic');
});

test('chunks: a turn longer than a chunk is cut at words and keeps its speaker label', () => {
  const long = `Kunde: ${'ordet '.repeat(4000).trim()}`;
  const chunks = chunkTranscript(`Selger: Hei.\n${long}\nSelger: Takk.`);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(chunk.chars <= CHUNK_MAX_CHARS);
    for (const line of chunk.text.split('\n')) assert.match(line, /^(Kunde|Selger): /);
  }
  assert.deepEqual(splitSpeakerTurns('Kunde: en\nfortsetter her\nSelger: to').map((turn) => turn.speaker), ['Kunde', 'Selger']);
});

// ---------------------------------------------------------------- quote verification

test('quotes: substring after whitespace and case folding; diacritics are kept', () => {
  const verifier = createQuoteVerifier(SALES);
  assert.equal(verifier.verify('vi har drevet med FLISLEGGING i 26 år').ok, true);
  assert.equal(verifier.verify('«Vi har drevet med\n  flislegging i 26 år»').ok, true, 'wrapping quote marks and line breaks');
  assert.equal(verifier.verify('Vi har drevet med flislegging i 26 ar').ok, false, 'å is not a');
  assert.equal(verifier.verify('Firmaet heter Eksempel Bad og vi holder til i Eksempelby').speaker, 'Kunde');
  assert.equal(normalizeQuote('  «Hei   der…»  '), 'hei der');
});

test('quotes: other punctuation is the same run of words; a filler word added passes; a changed number, a paraphrase or words from two turns do not', () => {
  const verifier = createQuoteVerifier(WORKSHOP);
  const close = verifier.verify('Vi vil gjerne at forsiden viser bilder av ferdige bad fra kunder i hele fylket!');
  assert.equal(close.ok, true);
  assert.equal(close.how, 'substring', 'another end mark: the same words in the same order');
  assert.equal(close.quote, 'Vi vil gjerne at forsiden viser bilder av ferdige bad fra kunder i hele fylket', 'the transcript\'s own words');
  const comma = verifier.verify('vi vil gjerne at forsiden viser bilder av ferdige bad, fra kunder i hele fylket');
  assert.equal(comma.ok, true);
  const filler = verifier.verify('Vi vil jo gjerne at forsiden viser bilder av ferdige bad fra kunder i hele fylket');
  assert.equal(filler.ok, true, 'one added filler word in sixteen');
  assert.equal(filler.how, 'tokens');
  assert.equal(filler.quote, 'Vi vil gjerne at forsiden viser bilder av ferdige bad fra kunder i hele fylket', 'the stored quote leaves the added word out');
  assert.equal(verifier.verify('Vi vil gjerne at forsiden viser fine bilder av ferdige bad fra kunder i hele fylket').ok, false, 'an added content word');
  assert.equal(verifier.verify('Vi vil gjerne at forsiden viser bilder av bad fra kunder i fylket').ok, false, 'two words in fourteen left out: under 90 %');
  assert.equal(verifier.verify('fra kunder i hele fylket vil vi gjerne at forsiden viser bilder av ferdige bad').ok, false, 'the same words in another order');
  const sales = createQuoteVerifier(SALES);
  assert.equal(sales.verify('Vi har drevet med flislegging i 40 år').ok, false, 'changed number');
  assert.equal(sales.verify('Vi har drevet med flislegging i 26 år her i byen, og 40 til').ok, false, 'a number not in the line');
  assert.equal(sales.verify('Vi skal ha nettbutikk på siden').ok, false, 'a left-out "ikke" turns the meaning around');
  assert.equal(verifier.verify('Vi ønsker at nummeret står øverst').ok, false, 'paraphrase');
  assert.equal(verifier.verify('Telefonnummeret på siden viser bilder av ferdige bad fra kunder').ok, false, 'two lines spliced');
  assert.equal(verifier.verify('x'.repeat(401)).ok, false, 'over 400 characters');
  assert.equal(verifier.verify('').ok, false);
  assert.equal(runDistance(['a', 'b', 'c'], ['x', 'a', 'b', 'c', 'y']), 0);
  assert.equal(runDistance(['a', 'c'], ['a', 'b', 'c']), 1);
});

test('quotes: whole words inside one speaker turn only; short runs, fragments, numbers inside numbers, two turns and the wrong speaker fail', () => {
  const transcriptText = 'Kari: Vi startet i 2020 og har nå åtte ansatte.\nOla: Flott, da lager vi en side for frisørsalongen.\nKari: Ja.\nfortsatt Kari på en ny linje uten navn';
  const verifier = createQuoteVerifier(transcriptText);
  for (const [quote, reason] of [
    ['20', 'not-found'],
    ['0 og', 'not-found'],
    ['er', 'not-found'],
    ['salongen', 'not-found'],
    ['nå åtte ansatte. ola: flott', 'not-found'],
    ['og har', 'too-short'],
    ['flott', 'too-short'],
  ]) {
    const result = verifier.verify(quote, { speaker: 'Kari' });
    assert.equal(result.ok, false, quote);
    assert.equal(result.how, reason, quote);
  }
  assert.equal(verifier.verify('Ja', { speaker: 'Kari' }).ok, false, 'a whole turn of one word, but the turn continues on the next line');
  assert.equal(createQuoteVerifier('Kari: Ja.\nOla: Bra.').verify('Ja', { speaker: 'Kari' }).ok, true, 'a short quote passes when it is the whole turn');
  assert.equal(verifier.verify('Vi startet i 2020', { speaker: 'Kari' }).ok, true);
  assert.equal(verifier.verify('Kari: Vi startet i 2020', { speaker: 'Kari' }).ok, true, 'the line label copied with the quote is ignored');
  assert.equal(verifier.verify('ja fortsatt kari på en ny linje', { speaker: 'Kari' }).ok, true, 'a turn runs over continuation lines');
  const wrong = verifier.verify('Vi startet i 2020', { speaker: 'Ola' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.how, 'speaker-mismatch');
  assert.equal(verifier.verify('da lager vi en side', { speaker: 'Ola Nordmann' }).ok, true, 'a fuller name for the same speaker');
  assert.equal(speakerMatches('Kari', 'Kari Nordmann'), true);
  assert.equal(speakerMatches('Ola', 'Kari'), false);
  assert.equal(speakerMatches('', 'Kari'), false);
  assert.equal(speakerMatches('Hvem som helst', ''), true, 'a turn without a label cannot be checked');

  // The stat probe: a made-up 20 with the quote "20" or a quote holding 2020.
  const { kept } = verifyItemQuotes([
    { type: 'fact', path: 'claims.stats', number: 20, unit: 'år', quote: '20', speaker: 'Kari', meetingId: 'm1' },
    { type: 'fact', path: 'claims.stats', number: 20, unit: 'år', quote: 'Vi startet i 2020', speaker: 'Kari', meetingId: 'm1' },
    { type: 'fact', path: 'claims.stats', number: 2020, unit: 'år', quote: 'Vi startet i 2020', speaker: 'Kari', meetingId: 'm1' },
  ], new Map([['m1', transcriptText]]));
  assert.deepEqual(kept.map((item) => [item.number, statHasQuotedNumber(item)]), [[20, false], [2020, true]]);
  assert.equal(statHasQuotedNumber({ type: 'fact', path: 'claims.stats', number: 20000, quote: 'vi solgte 20 000 fliser' }), true, 'digit groups');
  assert.equal(statHasQuotedNumber({ type: 'fact', path: 'claims.stats', number: 2.5, quote: 'på 2,5 dager' }), true, 'a decimal comma');
});

test('quotes: an item is checked only against its own meeting', () => {
  const items = [
    { quote: 'Firmaet heter Eksempel Bad', speaker: 'Kunde', meetingId: 'sales' },
    { quote: 'Firmaet heter Eksempel Bad', speaker: 'Kunde', meetingId: 'workshop' },
    { quote: 'Firmaet heter Eksempel Bad', speaker: 'Kunde', meetingId: 'unknown' },
    { quote: 'Firmaet heter Eksempel Bad', speaker: 'Selger', meetingId: 'sales' },
  ];
  const { kept, dropped } = verifyItemQuotes(items, { sales: SALES, workshop: WORKSHOP });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].speaker, 'Kunde');
  assert.deepEqual(dropped.map((row) => row.reason), ['not-found', 'no-transcript', 'speaker-mismatch']);
});

test('quotes: a long quote that drops a negation, swaps a word or adds a word is rejected; the kept quote is the transcript\'s own words', async () => {
  const meetingText = [
    'Selger: Hva tenker dere om bilder på nettsiden?',
    'Kunde: Vi vil ikke ha bilder av de ansatte på forsiden, det er viktig for oss at det blir sånn.',
    'Kunde: Vi vil ha en kontaktside, kontaktside med kart og åpningstider for 2027.',
  ].join('\n');
  const verifier = createQuoteVerifier(meetingText);
  // Fourteen words each: one edit would be within 10 %, but none of these edits is allowed.
  const changed = [
    ['Vi vil ha bilder av de ansatte på forsiden, det er viktig for oss', 'the negation left out'],
    ['Vi vil gjerne ha bilder av de ansatte på forsiden, det er viktig for oss', 'the negation swapped for another word'],
    ['Vi vil ikke ha bilder av de ansatte på kontaktsiden, det er viktig for oss', 'another page named'],
    ['Vi vil ikke ha bilder av de tidligere ansatte på forsiden, det er viktig for oss', 'a content word added'],
    ['Vi vil aldri ikke ha bilder av de ansatte på forsiden, det er viktig for oss', 'a negation added'],
    ['Vi vil ha en kontaktside med kart og åpningstider for 2028', 'another number'],
  ];
  for (const [quote, why] of changed) {
    const result = verifier.verify(quote, { speaker: 'Kunde' });
    assert.equal(result.ok, false, why);
  }
  // Allowed: a small word left out or added, and a repeated word left out. The stored quote is the transcript's.
  const article = verifier.verify('Vi vil ikke ha bilder av ansatte på forsiden, det er viktig for oss', { speaker: 'Kunde' });
  assert.equal(article.ok, true);
  assert.equal(article.how, 'tokens');
  assert.equal(article.quote, 'Vi vil ikke ha bilder av de ansatte på forsiden, det er viktig for oss');
  const stutter = verifier.verify('Vi vil ha en kontaktside med kart og åpningstider for 2027', { speaker: 'Kunde' });
  assert.equal(stutter.ok, true);
  assert.equal(stutter.how, 'tokens');
  assert.equal(stutter.quote, 'Vi vil ha en kontaktside, kontaktside med kart og åpningstider for 2027');

  // The same through the extractor with a stubbed model: the meaning-changing items are dropped and
  // a kept item carries the transcript's words, not the model's copy.
  const llm = {
    json: async () => ({
      data: {
        ...emptyAnswer(),
        directives: [
          { kind: 'add', area: 'hero', ask: 'plantet: bilder av ansatte', quote: changed[0][0], speaker: 'Kunde' },
          { kind: 'add', area: 'hero', ask: 'plantet: gjerne bilder', quote: changed[1][0], speaker: 'Kunde' },
          { kind: 'remove', area: 'page:contact', ask: 'plantet: kontaktsiden', quote: changed[2][0], speaker: 'Kunde' },
          { kind: 'remove', area: 'hero', ask: 'Ingen bilder av ansatte på forsiden', quote: 'vi vil ikke ha bilder av ansatte på forsiden, det er viktig for oss', speaker: 'Kunde' },
        ],
      },
    }),
  };
  const result = await extractMeeting({ meeting: { meetingId: 'm-polarity', purpose: 'workshop', transcript: meetingText }, llm, cache: createMemoryChunkCache(), clientId: 'syn-brief' });
  assert.deepEqual(result.items.filter((entry) => /plantet/.test(entry.ask)), [], 'no meaning-changing quote survives');
  assert.equal(result.droppedUnverified, 3);
  const kept = result.items.find((entry) => entry.ask === 'Ingen bilder av ansatte på forsiden');
  assert.ok(kept);
  assert.equal(kept.quote, 'Vi vil ikke ha bilder av de ansatte på forsiden, det er viktig for oss');
  assert.ok(meetingText.includes(kept.quote), 'the stored quote is text from the transcript');
});

// ---------------------------------------------------------------- the map step

test('prompts: one per purpose, a closed schema, and the iteration task for iteration meetings', () => {
  const hashes = new Set();
  for (const purpose of ['sales', 'demo', 'workshop', 'iteration']) {
    const prompt = promptFor(purpose);
    hashes.add(prompt.promptHash);
    assert.equal(prompt.task, purpose === 'iteration' ? 'brief.iteration' : 'brief.map');
    assert.match(prompt.system, /quote/);
  }
  assert.equal(hashes.size, 4);
  assert.equal(taskForPurpose('unknown'), 'brief.map');
  const schema = mapSchema();
  const closed = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') closed.push(node.additionalProperties === false);
    Object.values(node).forEach(walk);
  };
  walk(schema);
  assert.ok(closed.length > 5 && closed.every(Boolean), 'every object is closed');
  for (const list of Object.values(schema.properties)) assert.ok(list.items.required.includes('quote') && list.items.required.includes('speaker'));
  assert.equal(validateJson(emptyAnswer(), schema).valid, true);
  assert.equal(validateJson({ ...emptyAnswer(), extra: [] }, schema).valid, false);
});

test('normalizing an answer: items without a quote or speaker, unknown paths and stats without a number are invalid', () => {
  const { items, invalid } = normalizeMapOutput({
    facts: [
      { path: 'identity.brandName', value: 'A', quote: 'q', speaker: 's' },
      { path: 'secret.path', value: 'A', quote: 'q', speaker: 's' },
      { path: 'claims.stats', value: 'mange', quote: 'q', speaker: 's' },
      { path: 'contact.phone', value: '1', quote: '', speaker: 's' },
    ],
    directives: [{ kind: 'rewrite', area: 'x', ask: 'y', quote: 'q', speaker: 's' }],
    promises: [{ featureKey: 'not.a.key', text: 'p', quote: 'q', speaker: 's' }],
  }, { featureKeys: ['blog.posts'] });
  assert.equal(items.length, 2);
  assert.equal(invalid, 4);
  assert.equal(items.find((item) => item.type === 'promise').featureKey, '', 'unknown feature keys are cleared');
});

test('extraction through the facade: every planted fabricated quote is rejected and every stat has a verified quote', async () => {
  const stub = stubProviders();
  const { llm } = facadeFor('prod', stub);
  const results = [];
  for (const meeting of [
    { meetingId: 'm-sales', purpose: 'sales', startedAt: '2026-10-01T10:00:00Z', transcript: SALES },
    { meetingId: 'm-workshop', purpose: 'workshop', startedAt: '2026-10-08T10:00:00Z', transcript: WORKSHOP },
  ]) {
    results.push(await extractMeeting({ meeting, llm, cache: createMemoryChunkCache(), clientId: 'syn-brief', featureKeys: ['blog.posts', 'blog.autoPosts'] }));
  }
  const kept = results.flatMap((result) => result.items);
  const chunkCount = results.reduce((sum, result) => sum + result.chunks.total, 0);
  assert.ok(chunkCount >= 3, `${chunkCount} chunks`);
  assert.ok(results.every((result) => result.complete));
  const planted = new Set(PLANTED.map(normalizeQuote));
  assert.deepEqual(kept.filter((item) => planted.has(normalizeQuote(item.quote))), [], 'no planted quote survives');
  assert.deepEqual(kept.filter((item) => /plantet/.test(item.value || item.ask || item.text || '')), [], 'no short, partial, spliced or misattributed quote survives');
  // Each chunk planted 7 fabrications and one stat without its number in the quote.
  const droppedUnverified = results.reduce((sum, result) => sum + result.droppedUnverified, 0);
  assert.ok(droppedUnverified >= chunkCount * 8, `dropped ${droppedUnverified}`);
  assert.ok(results.reduce((sum, result) => sum + result.droppedInvalid, 0) >= chunkCount * 2);
  const stats = kept.filter((item) => item.type === 'fact' && item.path === 'claims.stats');
  assert.ok(stats.length >= 1);
  for (const stat of stats) {
    assert.equal(stat.quoteVerified, true);
    assert.ok(wordTokens(stat.quote).includes(String(stat.number)), `the number ${stat.number} is a whole word of «${stat.quote}»`);
  }
  assert.ok(kept.every((item) => item.quoteVerified === true && item.quote && item.speaker));
  assert.ok(kept.some((item) => item.type === 'fact' && item.path === 'identity.brandName' && item.value === 'Eksempel Bad'));
  assert.ok(kept.some((item) => item.type === 'directive' && item.area === 'hero'), 'the word-overlap quote is kept');
  assert.ok(kept.some((item) => item.type === 'promise' && item.featureKey === 'blog.autoPosts'));
  assert.equal(stub.calls.deepseek, 0);
  assert.equal(stub.calls.claude, chunkCount);
  assert.deepEqual([...new Set(stub.calls.tasks)].sort(), ['brief.map']);
});

test('ledger: transcript calls never reach a provider the data policy disallows, also on the test profile (DeepSeek first)', async () => {
  for (const profile of ['test', 'prod', 'legacy']) {
    const stub = stubProviders();
    const { llm } = facadeFor(profile, stub);
    const iteration = await extractMeeting({
      meeting: { meetingId: `m-it-${profile}`, purpose: 'iteration', transcript: WORKSHOP },
      llm,
      cache: createMemoryChunkCache(),
      clientId: 'syn-brief',
    });
    const sales = await extractMeeting({ meeting: { meetingId: `m-s-${profile}`, purpose: 'sales', transcript: SALES }, llm, cache: createMemoryChunkCache(), clientId: 'syn-brief' });
    assert.equal(iteration.complete && sales.complete, true, profile);
    const rows = llm.ledger.rows({});
    const briefRows = rows.filter((row) => String(row.task).startsWith('brief.'));
    assert.ok(briefRows.length >= iteration.chunks.total + sales.chunks.total, `${profile}: ${briefRows.length} rows`);
    assert.deepEqual(briefRows.filter((row) => row.provider !== 'claude'), [], `${profile}: only Claude`);
    assert.ok(briefRows.some((row) => row.task === 'brief.iteration'));
    assert.ok(briefRows.every((row) => row.salesClientId === 'syn-brief'), 'rows name the client');
    assert.equal(stub.calls.deepseek, 0, profile);
    assert.equal(stub.calls.gemini, 0, profile);
  }
});

test('no other provider when Claude fails: the chunk is left for the next rebuild and the run makes no more calls', async () => {
  const stub = stubProviders({ failAfter: 0 });
  const { llm } = facadeFor('test', stub);
  const result = await extractMeeting({ meeting: { meetingId: 'm-down', purpose: 'sales', transcript: SALES }, llm, cache: createMemoryChunkCache(), clientId: 'syn-brief' });
  assert.ok(result.chunks.total >= 2);
  assert.equal(result.complete, false);
  assert.equal(result.chunks.failed, 1, 'the first failure stops new calls');
  assert.equal(result.chunks.waiting, result.chunks.total - 1);
  assert.equal(stub.calls.claude, 1);
  assert.equal(result.items.length, 0);
  assert.equal(stub.calls.deepseek, 0);
  assert.equal(stub.calls.gemini, 0);
  const rows = llm.ledger.rows({}).filter((row) => row.task === 'brief.map');
  assert.ok(rows.length >= 1 && rows.every((row) => row.provider === 'claude'));
});

test('an interrupted extraction redoes only the chunks it had not finished (disk cache)', async () => {
  const long = transcript('Avbrutt', 600, [SIGNALS.brand, SIGNALS.years]);
  const total = chunkTranscript(long).length;
  assert.ok(total >= 4, `${total} chunks`);
  const cache = createChunkCache(join(dataDir, 'resume-cache'));
  const meeting = { meetingId: 'm-resume', purpose: 'sales', transcript: long };

  // Run 1: the provider stops answering after two chunks.
  const first = stubProviders({ failAfter: 2 });
  const run1 = await extractMeeting({ meeting, llm: facadeFor('prod', first).llm, cache, clientId: 'syn-brief' });
  assert.equal(run1.complete, false);
  assert.equal(run1.chunks.extracted, 2);
  assert.equal(readdirSync(cache.dir).length, 2, 'two cached chunks');

  // Run 2: a fresh process (new facade) redoes only the missing chunks.
  const second = stubProviders();
  const run2 = await extractMeeting({ meeting, llm: facadeFor('prod', second).llm, cache, clientId: 'syn-brief' });
  assert.equal(run2.complete, true);
  assert.equal(run2.chunks.cached, 2);
  assert.equal(second.calls.claude, total - 2);

  // Run 3: everything cached, no call at all; same items.
  const third = stubProviders();
  const run3 = await extractMeeting({ meeting, llm: facadeFor('prod', third).llm, cache, clientId: 'syn-brief' });
  assert.equal(third.calls.claude, 0);
  assert.deepEqual(run3.items, run2.items);

  // A deadline stops new calls and leaves the rest for later, too.
  const timed = stubProviders();
  const deadlineRun = await extractMeeting({ meeting: { ...meeting, meetingId: 'm-deadline', transcript: `${long}\nKunde: En ny linje gjør siste del ny.` }, llm: facadeFor('prod', timed).llm, cache, clientId: 'syn-brief', deadline: 0 });
  assert.equal(deadlineRun.complete, false);
  assert.equal(timed.calls.claude, 0);
  assert.ok(deadlineRun.chunks.skipped >= 1);
});

// ---------------------------------------------------------------- failures: gaps and backoff

function codedFailure(code, usd = 0) {
  return Object.assign(new Error(`stub ${code}`), { code, allRows: usd ? [{ usd }] : [] });
}

test('a final answer (refusal, output limit, broken schema) is cached as a gap: the meeting completes and the chunk is not paid for again', async () => {
  const long = transcript('Gap', 400, [SIGNALS.brand, 'Kunde: MARKØR denne delen svarer modellen aldri ordentlig på.']);
  const total = chunkTranscript(long).length;
  assert.ok(total >= 3, `${total} chunks`);
  for (const code of ['max_tokens', 'refusal', 'schema_invalid']) {
    let calls = 0;
    const llm = {
      json: async (request) => {
        calls += 1;
        const chunk = chunkOf(request.user);
        if (chunk.includes('MARKØR')) throw codedFailure(code, 0.01);
        return { data: answerFor(chunk), usd: 0.001 };
      },
    };
    const cache = createMemoryChunkCache();
    const meeting = { meetingId: `m-gap-${code}`, purpose: 'sales', transcript: long };
    const first = await extractMeeting({ meeting, llm, cache, clientId: 'syn-brief' });
    assert.equal(first.complete, true, `${code}: a gap does not hold the meeting back`);
    assert.ok(first.chunks.gaps >= 1, code);
    assert.equal(calls, total, `${code}: every chunk asked once, the rest of the run went on`);
    assert.ok(first.items.some((item) => item.path === 'identity.brandName'));
    assert.ok(first.costUsd >= 0.01, 'the failed call is counted in the cost');
    const again = await extractMeeting({ meeting, llm, cache, clientId: 'syn-brief' });
    assert.equal(calls, total, `${code}: the gap is cached, nothing is paid again`);
    assert.equal(again.chunks.gaps, first.chunks.gaps);
    await extractMeeting({ meeting, llm, cache, clientId: 'syn-brief', retryGaps: true });
    assert.equal(calls, total + first.chunks.gaps, `${code}: retryGaps asks the gaps again`);
  }
});

test('a failing provider: one failed call stops the run, each chunk backs off (15 min doubling to 24 h) and becomes a gap after six failures', async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => backoffDelayMs(n) / 60_000), [15, 30, 60, 120, 240, 480, 960, 1440, 1440, 1440]);
  assert.equal(MAX_CHUNK_ATTEMPTS, 6);
  const retry = { failures: {}, nowMs: Date.parse('2026-11-01T00:00:00.000Z'), ignoreBackoff: false };
  const callTimes = new Map();
  let calls = 0;
  const llm = {
    json: async (request) => {
      calls += 1;
      const chunk = chunkOf(request.user);
      if (!callTimes.has(chunk)) callTimes.set(chunk, []);
      callTimes.get(chunk).push(retry.nowMs);
      throw codedFailure('provider_error');
    },
  };
  const cache = createMemoryChunkCache();
  const meeting = { meetingId: 'm-outage', purpose: 'sales', transcript: SALES };
  const total = chunkTranscript(SALES).length;
  assert.ok(total >= 2, `${total} chunks`);
  const callsAt = [];
  let last = null;
  // Two days of five-minute ticks.
  for (let tickIndex = 0; tickIndex < 2 * 24 * 12; tickIndex += 1) {
    const before = calls;
    last = await extractMeeting({ meeting, llm, cache, clientId: 'syn-brief', retry });
    assert.ok(calls - before <= 1, 'at most one failed call per run');
    callsAt.push(calls);
    retry.nowMs += 5 * 60_000;
  }
  assert.equal(calls, total * MAX_CHUNK_ATTEMPTS, `${calls} calls for ${total} chunks: at most six per chunk`);
  assert.equal(callsAt.at(-1), callsAt[callsAt.length - 100], 'the call count stopped growing');
  assert.equal(last.complete, true, 'every chunk ended as a gap');
  assert.equal(last.chunks.gaps, total);
  assert.deepEqual(retry.failures, {}, 'no failure records left');
  for (const times of callTimes.values()) {
    assert.deepEqual(times.slice(1).map((at, i) => (at - times[i]) / 60_000), [15, 30, 60, 120, 240], 'each chunk backs off 15, 30, 60, 120, 240 minutes');
  }

  // A person's rebuild (ignoreBackoff) retries a waiting chunk at once.
  let healthyCalls = 0;
  const healthy = { json: async (request) => { healthyCalls += 1; return { data: answerFor(chunkOf(request.user)) }; } };
  const waiting = { failures: { }, nowMs: Date.parse('2026-11-01T00:00:00.000Z'), ignoreBackoff: false };
  const freshCache = createMemoryChunkCache();
  await extractMeeting({ meeting, llm: { json: async () => { throw codedFailure('provider_error'); } }, cache: freshCache, clientId: 'syn-brief', retry: waiting });
  assert.equal(Object.keys(waiting.failures).length, 1);
  const blocked = await extractMeeting({ meeting, llm: healthy, cache: freshCache, clientId: 'syn-brief', retry: waiting });
  assert.equal(healthyCalls, total - 1, 'the failed chunk waits; the others are asked');
  assert.equal(blocked.complete, false);
  const forced = await extractMeeting({ meeting, llm: healthy, cache: freshCache, clientId: 'syn-brief', retry: { ...waiting, ignoreBackoff: true } });
  assert.equal(forced.complete, true);
  assert.equal(healthyCalls, total);
});

test('a failure before any provider answers (safe mode, spend guard, switched-off facade) never becomes a gap: it backs off to once a day and recovers', async () => {
  for (const code of ['safe_mode', 'budget_exceeded', 'facade_off', 'route_config']) {
    const retry = { failures: {}, nowMs: Date.parse('2026-11-01T00:00:00.000Z'), ignoreBackoff: false };
    let calls = 0;
    let down = true;
    const llm = {
      json: async (request) => {
        calls += 1;
        if (down) throw codedFailure(code);
        return { data: answerFor(chunkOf(request.user)) };
      },
    };
    const cache = createMemoryChunkCache();
    const meeting = { meetingId: `m-unpaid-${code}`, purpose: 'sales', transcript: SALES };
    const total = chunkTranscript(SALES).length;
    let last = null;
    // Three days of five-minute ticks while the cause lasts.
    for (let i = 0; i < 3 * 24 * 12; i += 1) {
      last = await extractMeeting({ meeting, llm, cache, clientId: 'syn-brief', retry });
      retry.nowMs += 5 * 60_000;
    }
    assert.equal(last.chunks.gaps, 0, `${code}: no gap`);
    assert.equal(last.complete, false);
    assert.ok(calls <= total * 10, `${code}: ${calls} attempts in three days, none of them paid`);
    assert.ok(Object.values(retry.failures).every((record) => record.count > MAX_CHUNK_ATTEMPTS), `${code}: still waiting, past the paid-failure limit`);
    // The cause is gone: each chunk is asked again when its wait ends (at most a day), and the meeting completes.
    down = false;
    for (let i = 0; i < 24 * 12 && !last.complete; i += 1) {
      last = await extractMeeting({ meeting, llm, cache, clientId: 'syn-brief', retry });
      retry.nowMs += 5 * 60_000;
    }
    assert.equal(last.complete, true, `${code}: recovered within a day`);
    assert.equal(last.chunks.gaps, 0);
    assert.ok(last.items.some((item) => item.path === 'identity.brandName'));
  }
});

test('a lost lease stops the run before the next call', async () => {
  let calls = 0;
  const llm = { json: async (request) => { calls += 1; return { data: answerFor(chunkOf(request.user)) }; } };
  let allowed = 1;
  const result = await extractMeeting({
    meeting: { meetingId: 'm-lease', purpose: 'sales', transcript: SALES },
    llm,
    cache: createMemoryChunkCache(),
    clientId: 'syn-brief',
    beforeCall: async () => (allowed-- > 0),
  });
  assert.equal(calls, 1);
  assert.equal(result.complete, false);
});

// ---------------------------------------------------------------- reduce

function item(fields) {
  return { quoteVerified: true, speaker: 'Kunde', confidence: 0.8, quote: fields.quote || `sitat ${fields.value || fields.ask || fields.text}`, startedAt: '', ...fields };
}

test('reduce: iteration > workshop > demo > sales; duplicates by Jaccard; supersededBy; stable ids', () => {
  const items = [
    item({ type: 'fact', path: 'contact.phone', value: '+47 0000 0001', purpose: 'sales', meetingId: 's' }),
    item({ type: 'fact', path: 'contact.phone', value: '+47 0000 0002', purpose: 'workshop', meetingId: 'w' }),
    item({ type: 'fact', path: 'contact.phone', value: '+47 0000 0003', purpose: 'demo', meetingId: 'd' }),
    item({ type: 'fact', path: 'positioning.services', value: 'Flislegging av bad', purpose: 'sales', meetingId: 's' }),
    item({ type: 'fact', path: 'positioning.services', value: 'flislegging av bad', purpose: 'workshop', meetingId: 'w' }),
    item({ type: 'fact', path: 'positioning.services', value: 'Membran', purpose: 'sales', meetingId: 's' }),
    item({ type: 'directive', kind: 'change', area: 'chrome.header', ask: 'Samme farge over hele menylinjen', purpose: 'sales', meetingId: 's' }),
    item({ type: 'directive', kind: 'keep', area: 'chrome.header', ask: 'Behold menyen slik den er', purpose: 'iteration', meetingId: 'i' }),
    item({ type: 'directive', kind: 'add', area: 'hero', ask: 'Vis bilder av ferdige bad fra kunder', purpose: 'sales', meetingId: 's' }),
    item({ type: 'directive', kind: 'add', area: 'hero', ask: 'Vis bilder av ferdige bad fra kundene', purpose: 'workshop', meetingId: 'w' }),
    item({ type: 'directive', kind: 'add', area: 'hero', ask: 'Legg inn en video', purpose: 'sales', meetingId: 's' }),
  ];
  const first = reduceItems(items);
  const again = reduceItems([...items].reverse());
  assert.deepEqual(first.items.map((row) => [row.id, row.status, row.supersededBy || '']), again.items.map((row) => [row.id, row.status, row.supersededBy || '']), 'order-independent');
  const phone = first.items.filter((row) => row.path === 'contact.phone');
  const winner = phone.find((row) => row.status === 'active');
  assert.equal(winner.value, '+47 0000 0002', 'workshop beats demo and sales');
  assert.equal(phone.filter((row) => row.status === 'superseded').every((row) => row.supersededBy === winner.id), true);
  const services = first.active.filter((row) => row.path === 'positioning.services').map((row) => row.value).sort();
  assert.deepEqual(services, ['Membran', 'flislegging av bad']);
  const header = first.items.filter((row) => row.area === 'chrome.header');
  assert.equal(header.find((row) => row.status === 'active').kind, 'keep', 'the iteration keep wins over the sales change');
  const hero = first.active.filter((row) => row.area === 'hero').map((row) => row.ask).sort();
  assert.deepEqual(hero, ['Legg inn en video', 'Vis bilder av ferdige bad fra kundene']);
  assert.ok(first.items.every((row) => /^(f|dir|it|pr|fu|ap|rq|oq)-[0-9a-f]{12}$/.test(row.id)));
  const twice = reduceItems([...items, ...items]);
  assert.equal(twice.items.length, first.items.length, 'the same statement seen twice (chunk overlap) is one item');
});

test('reduce: the optional LLM merge runs only above 40 items, is cached, and keeps precedence', async () => {
  const many = [];
  for (let i = 0; i < 45; i += 1) many.push(item({ type: 'openQuestion', text: `Spørsmål nummer ${i} kode q${i}a q${i}b q${i}c`, purpose: i === 1 ? 'workshop' : 'sales', meetingId: 'm' }));
  const reduced = reduceItems(many);
  assert.equal(reduced.active.length, 45);
  const ids = reduced.active.map((row) => row.id);
  let calls = 0;
  const llm = {
    json: async (request) => {
      calls += 1;
      assert.equal(request.task, 'brief.reduce');
      assert.equal(request.ctx.dataClass, 'transcript');
      const first = reduced.active.find((row) => row.text.includes('nummer 0 '));
      const second = reduced.active.find((row) => row.text.includes('nummer 1 '));
      return { data: { groups: [{ keep: first.id, drop: [second.id, 'unknown-id'] }] }, usd: 0.001 };
    },
  };
  const cache = createMemoryChunkCache();
  const merged = await llmMergeItems(reduced, { llm, cache, clientId: 'syn-brief' });
  assert.equal(merged.merged, 1);
  const workshop = merged.reduced.items.find((row) => row.text.includes('nummer 1 '));
  const sales = merged.reduced.items.find((row) => row.text.includes('nummer 0 '));
  assert.equal(workshop.status, 'active', 'the workshop item outranks the sales one');
  assert.equal(sales.supersededBy, workshop.id);
  await llmMergeItems(reduced, { llm, cache, clientId: 'syn-brief' });
  assert.equal(calls, 1, 'cached by its input');
  const small = reduceItems(many.slice(0, 40));
  const skipped = await llmMergeItems(small, { llm, cache, clientId: 'syn-brief' });
  assert.equal(skipped.ran, false);
  assert.equal(calls, 1);
  const failing = await llmMergeItems(reduced, { llm: { json: async () => { throw Object.assign(new Error('down'), { code: 'provider_dead' }); } }, clientId: 'syn-brief' });
  assert.equal(failing.error, 'provider_dead');
  assert.deepEqual(failing.reduced.active.map((row) => row.id), ids, 'a failed merge changes nothing');
});

// ---------------------------------------------------------------- recall check script

test('recall script: records cassettes, replays them without a provider, scores expectations and refuses a report inside the repo', async () => {
  const { assertOutsideRepo, parseArgs, runRecall, scoreClient } = await import('./eval/brief-recall.mjs');
  const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
  const input = mkdtempSync(join(tmpdir(), 'brief-recall-input-'));
  const work = mkdtempSync(join(tmpdir(), 'brief-recall-work-'));
  try {
    const client = join(input, 'syn-eval');
    mkdirSync(client);
    writeFileSync(join(client, 'sales.txt'), SALES);
    writeFileSync(join(client, 'workshop.txt'), WORKSHOP);
    writeFileSync(join(client, 'transcripts.json'), JSON.stringify({ meetings: { sales: { file: 'sales.txt', meetingId: 'eval-sales' }, workshop: { file: 'workshop.txt', meetingId: 'eval-workshop' } } }));
    writeFileSync(join(client, 'expectations.json'), JSON.stringify({ items: [
      { id: 'N1', kind: 'client_need', statement: 'Phone number at the top of the menu', quote: 'Telefonnummeret på siden skal stå helt øverst i menyen' },
      { id: 'N2', kind: 'both', statement: 'Photos of finished bathrooms on the front page', quote: 'forsiden viser bilder av ferdige bad' },
      { id: 'N3', kind: 'client_need', statement: 'A booking calendar', quote: 'Vi trenger en bookingkalender på nettsiden' },
      { id: 'P1', kind: 'asoldi_promise', statement: 'Monthly blog posts', quote: 'vi skriver innlegg hver måned', featureKey: 'blog.autoPosts' },
    ] }));
    const report = join(work, 'report.json');
    const dataDir = join(work, 'llm');
    const recorder = stubProviders();
    const recorded = await runRecall(parseArgs(['--input', input, '--report', report, '--profile', 'record', '--data-dir', dataDir]), { providers: recorder.providers, log: {} });
    assert.ok(recorder.calls.claude > 0);
    assert.equal(recorder.calls.deepseek, 0);
    const row = recorded.clients[0];
    assert.equal(row.complete, true);
    assert.deepEqual([row.needs.recalled, row.needs.total], [2, 3]);
    assert.deepEqual([row.promises.recalled, row.promises.total], [1, 1]);
    assert.equal(row.pass, false, '2 of 3 is below 0.8');
    assert.deepEqual(row.rows.filter((entry) => !entry.matched).map((entry) => entry.id), ['N3']);
    const saved = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(JSON.stringify(saved).includes('Eksempelby'), false, 'the report holds ids and scores, not transcript text');

    // Replay: the same answers from the cassettes; a provider call would throw.
    const silent = stubProviders({ failAfter: 0 });
    const replayed = await runRecall(parseArgs(['--input', input, '--report', join(work, 'replay.json'), '--profile', 'replay', '--data-dir', join(work, 'llm')]), { providers: silent.providers, log: {} });
    assert.equal(silent.calls.claude + silent.calls.deepseek + silent.calls.gemini, 0, 'no provider call on replay');
    assert.deepEqual(replayed.clients[0].rows, row.rows);

    assert.throws(() => assertOutsideRepo(join(process.cwd(), 'scripts', 'report.json')), /outside the repository/);
    // The chunk cache and cassettes hold transcript text: a data dir inside the repository is refused before anything runs.
    const insideDataDir = join(process.cwd(), 'scripts', 'brief-recall-data');
    const refused = stubProviders();
    await assert.rejects(
      runRecall(parseArgs(['--input', input, '--report', join(work, 'inside.json'), '--profile', 'record', '--data-dir', insideDataDir]), { providers: refused.providers, log: {} }),
      /data dir .* must be outside the repository/,
    );
    assert.equal(refused.calls.claude, 0, 'nothing was asked');
    assert.equal(existsSync(insideDataDir), false, 'nothing was written inside the repository');
    assert.throws(() => parseArgs(['--input', input]), /--report/);
    assert.equal(scoreClient([{ id: 'x', kind: 'client_need', statement: 'nothing', quote: '' }], []).needs.recall, 0);
  } finally {
    rmSync(input, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
