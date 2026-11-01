// Brief extractor: chunking, quote verification, the map step through the real hub LLM facade with
// stubbed provider adapters (no network), the deterministic reduce, and resuming an interrupted
// extraction from cached chunks. Transcripts are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-brief-extract-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.DATA_DIR;
for (const key of Object.keys(process.env)) if (/^(AI_PROFILE|AI_TEST_MODE|AI_ROUTE_|HUB_SAFE_MODE|HUB_LLM_FACADE)/.test(key)) delete process.env[key];

const { CHUNK_MAX_CHARS, chunkTranscript, splitSpeakerTurns } = await import('../lib/delivery-brief/chunk.js');
const { createQuoteVerifier, normalizeQuote, verifyItemQuotes } = await import('../lib/delivery-brief/verify-quotes.js');
const { createChunkCache, createMemoryChunkCache, extractMeeting, mapSchema, normalizeMapOutput, promptFor, taskForPurpose } = await import('../lib/delivery-brief/extract.js');
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

const SALES = transcript('Salg', 160, [SIGNALS.brand, SIGNALS.years, SIGNALS.blog]);
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

test('quotes: 90 % word overlap with one line passes; a changed number, a paraphrase or words from two lines do not', () => {
  const verifier = createQuoteVerifier(WORKSHOP);
  const close = verifier.verify('Vi vil gjerne at forsiden viser bilder av ferdige bad fra kunder i hele fylket!');
  assert.equal(close.ok, true);
  assert.equal(close.how, 'tokens', 'another end mark: matched on words');
  const reordered = verifier.verify('vi vil gjerne at forsiden viser bilder av ferdige bad, fra kunder i hele fylket');
  assert.equal(reordered.ok, true);
  assert.equal(reordered.how, 'tokens');
  const sales = createQuoteVerifier(SALES);
  assert.equal(sales.verify('Vi har drevet med flislegging i 40 år').ok, false, 'changed number');
  assert.equal(sales.verify('Vi har drevet med flislegging i 26 år her i byen, og 40 til').ok, false, 'a number not in the line');
  assert.equal(verifier.verify('Vi ønsker at nummeret står øverst').ok, false, 'paraphrase');
  assert.equal(verifier.verify('Telefonnummeret på siden viser bilder av ferdige bad fra kunder').ok, false, 'two lines spliced');
  assert.equal(verifier.verify('x'.repeat(401)).ok, false, 'over 400 characters');
  assert.equal(verifier.verify('').ok, false);
});

test('quotes: an item is checked only against its own meeting', () => {
  const items = [
    { quote: 'Firmaet heter Eksempel Bad', meetingId: 'sales' },
    { quote: 'Firmaet heter Eksempel Bad', meetingId: 'workshop' },
    { quote: 'Firmaet heter Eksempel Bad', meetingId: 'unknown' },
  ];
  const { kept, dropped } = verifyItemQuotes(items, { sales: SALES, workshop: WORKSHOP });
  assert.equal(kept.length, 1);
  assert.deepEqual(dropped.map((row) => row.reason), ['not-found', 'no-transcript']);
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
  // Each chunk planted 7 fabrications and one stat without its number in the quote.
  const droppedUnverified = results.reduce((sum, result) => sum + result.droppedUnverified, 0);
  assert.ok(droppedUnverified >= chunkCount * 8, `dropped ${droppedUnverified}`);
  assert.ok(results.reduce((sum, result) => sum + result.droppedInvalid, 0) >= chunkCount * 2);
  const stats = kept.filter((item) => item.type === 'fact' && item.path === 'claims.stats');
  assert.ok(stats.length >= 1);
  for (const stat of stats) {
    assert.equal(stat.quoteVerified, true);
    assert.match(stat.quote, new RegExp(String(stat.number)));
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

test('no other provider when Claude fails: the chunk is left for the next rebuild', async () => {
  const stub = stubProviders({ failAfter: 0 });
  const { llm } = facadeFor('test', stub);
  const result = await extractMeeting({ meeting: { meetingId: 'm-down', purpose: 'sales', transcript: SALES }, llm, cache: createMemoryChunkCache(), clientId: 'syn-brief' });
  assert.equal(result.complete, false);
  assert.equal(result.chunks.failed, result.chunks.total);
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
    assert.throws(() => parseArgs(['--input', input]), /--report/);
    assert.equal(scoreClient([{ id: 'x', kind: 'client_need', statement: 'nothing', quote: '' }], []).needs.recall, 0);
  } finally {
    rmSync(input, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
