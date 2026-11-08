// SEO keyword proposals from meetings (lib/seo-ops/transcript-keywords.js): keyword talk in the brief's
// verified quotes becomes proposals, never approvals; turned-down, own-name and prescription-only phrases
// are left out; the focused second pass keeps only phrases it can find in a verified quote; and the
// delivery-loop step does nothing while its switch is off, only records in shadow, and proposes in auto.
// The meetings are synthetic (invented businesses in invented towns); every model is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-seo-transcript-keywords-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kw = await import('../lib/seo-ops/transcript-keywords.js');
const record = await import('../lib/seo-ops/record.js');
const { seoPhraseKey, isRegulatedPhrase } = await import('../lib/seo-ops/phrase-filters.js');
const { verifyItemQuotes } = await import('../lib/delivery-brief/verify-quotes.js');
const { chunkTranscript } = await import('../lib/delivery-brief/chunk.js');
const { defaultAutomationSettings } = await import('../data/automation-settings.js');
const { loadTickSteps } = await import('../lib/delivery-steps.js');

const FIXTURE_DIR = join(root, 'scripts', 'fixtures', 'seo-keyword-talk');
const fixtures = Object.fromEntries(readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).map((name) => {
  const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
  const chunkSha = chunkTranscript(fixture.text)[0].sha;
  fixture.items = fixture.items.map((item) => ({ ...item, chunkSha }));
  return [name.replace(/\.json$/, ''), fixture];
}));
const MEASURED = ['bike-workshop', 'carpentry', 'tea-shop', 'skin-clinic'];
const keys = (list) => list.map((phrase) => seoPhraseKey(phrase));

test('the fixtures are honest: every quote is the transcript\'s own words', () => {
  assert.deepEqual(Object.keys(fixtures).sort(), ['bike-workshop', 'carpentry', 'iteration-rather', 'skin-clinic', 'tea-shop']);
  for (const [name, fixture] of Object.entries(fixtures)) {
    const { dropped } = verifyItemQuotes(fixture.items, { [fixture.meetingId]: fixture.text });
    assert.deepEqual(dropped.map((row) => row.reason), [], name);
  }
});

test('four meetings: the proposals hold the agreed phrases with precision of at least 0.8 and never a regulated substance', () => {
  let proposed = 0;
  let correct = 0;
  let expected = 0;
  for (const name of MEASURED) {
    const fixture = fixtures[name];
    const { proposals } = kw.proposalsFromExtraction(fixture.items, { brandName: fixture.business.name });
    const got = keys(proposals.map((row) => row.phrase));
    const want = new Set(keys(fixture.expected));
    proposed += got.length;
    correct += got.filter((key) => want.has(key)).length;
    expected += want.size;
    for (const key of keys(fixture.mustNotPropose)) assert.equal(got.includes(key), false, `${name}: ${key}`);
    for (const row of proposals) {
      assert.equal(isRegulatedPhrase(row.phrase), false, `${name}: ${row.phrase}`);
      assert.equal(row.quoteRef, `meeting:${fixture.meetingId}`);
      assert.ok(fixture.text.includes(row.quote), `${name}: the quote is from the meeting`);
    }
  }
  const precision = correct / proposed;
  const recall = correct / expected;
  console.log(`[seo-transcript-keywords] precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)} (${correct}/${proposed}, ${expected} expected)`);
  assert.ok(precision >= 0.8, `precision ${precision}`);
});

test('an iteration meeting: "vi vil heller rangere på X enn på Y" proposes X and not Y', () => {
  const fixture = fixtures['iteration-rather'];
  const { proposals } = kw.proposalsFromExtraction(fixture.items, { brandName: fixture.business.name });
  assert.deepEqual(keys(proposals.map((row) => row.phrase)), keys(fixture.expected));
  assert.equal(proposals[0].purpose, 'iteration');
  // The rejection also holds across meetings: Y named as wanted in an earlier meeting is not proposed.
  const earlier = { type: 'fact', path: 'positioning.services', quote: 'Vi vil rangere på tekopper', speaker: 'Kunde', meetingId: 'm-old', purpose: 'sales' };
  const both = kw.proposalsFromExtraction([earlier, ...fixture.items], { brandName: fixture.business.name });
  assert.deepEqual(keys(both.proposals.map((row) => row.phrase)), keys(fixture.expected));
  assert.deepEqual(both.dropped, [{ phrase: 'tekopper', reason: 'turned-down' }]);
});

test('keyword talk and phrases: cues, clause ends, negations, quoted phrases', () => {
  assert.equal(kw.keywordTalkIn('Vi vil rangere høyt på Google'), true);
  assert.equal(kw.keywordTalkIn('Hvilke søkeord tenker dere?'), true);
  assert.equal(kw.keywordTalkIn('We want to show up for bike repair'), true);
  assert.equal(kw.keywordTalkIn('Vi vil ha en kontaktside med kart'), false);
  assert.equal(kw.keywordTalkIn('Rangeringen av produktene på siden'), false, 'not a word about search');
  const phrases = (text) => kw.phrasesFromTalk(text).map(({ phrase, rejected }) => [phrase, rejected]);
  assert.deepEqual(phrases('Vi vil rangere høyt på sykkelservice Testvik, det er viktigst.'), [['sykkelservice Testvik', false]]);
  assert.deepEqual(phrases('Søkeordet kjøkken på mål er det vi tjener mest på'), [['kjøkken på mål', false]]);
  assert.deepEqual(phrases('Søkeord: «frisør Testvik»'), [['frisør Testvik', false]]);
  assert.deepEqual(phrases('Vi vil bli funnet når folk søker på snekker Eksempelby'), [['snekker Eksempelby', false]]);
  assert.deepEqual(phrases('Vi vil ikke bli funnet på sykkelutleie'), [['sykkelutleie', true]]);
  assert.deepEqual(phrases('We want to rank for bike repair, not rentals'), [['bike repair', false]]);
  assert.deepEqual(phrases('Vi vil heller rangere på teblandinger enn på tekopper'), [['teblandinger', false], ['tekopper', true]]);
});

test('candidate checks: empty, too long, not searchable, own name, regulated', () => {
  const check = (phrase, options = {}) => kw.checkCandidate(phrase, options).reason;
  assert.equal(check('  «»  '), 'empty');
  assert.equal(check('en veldig lang frase med alt for mange ord'), 'too-many-words');
  assert.equal(check('https://eksempel.test'), 'not-searchable');
  assert.equal(check('det og oss'), 'not-searchable');
  assert.equal(check('te'), 'not-searchable');
  assert.equal(check('Eksempel Snekkeri', { brandName: 'Eksempel Snekkeri AS' }), 'brand');
  assert.equal(check('Eksempel Snekkeri Eksempelby', { brandName: 'Eksempel Snekkeri AS' }), 'brand', 'every word of a two-word name');
  assert.equal(check('teblandinger Testvik', { brandName: 'Testvik Te' }), '', 'a one-word name is often the town too');
  assert.equal(check('Testvik', { brandName: 'Testvik Te' }), 'brand', 'the name itself');
  assert.equal(check('melatonin tabletter'), 'regulated');
  assert.equal(check('hudpleie Eksempelby'), '');
});

test('the shared claims data is used when its module is there: an extra listed term is regulated too', () => {
  const base = kw.regulatedCheckerFrom(null);
  assert.equal(base('botox Eksempelby'), true);
  assert.equal(base('kosttilskudd Eksempelby'), false);
  const withList = kw.regulatedCheckerFrom({ REGULATED_SUBSTANCE_TERMS: ['kosttilskuddx', 'kosttilskudd'] });
  assert.equal(withList('kosttilskudd Eksempelby'), true);
  const withFn = kw.regulatedCheckerFrom({ regulatedTermIn: (phrase) => (/injeksjon/i.test(phrase) ? 'injeksjon' : '') });
  assert.equal(withFn('injeksjon Eksempelby'), true);
  assert.equal(withFn('hudpleie Eksempelby'), false);
  const broken = kw.regulatedCheckerFrom({ isRegulatedPhrase: () => { throw new Error('bad data'); } });
  assert.equal(broken('hudpleie Eksempelby'), true, 'a check that fails counts as regulated');
});

// ---------------------------------------------------------------- the second pass

function stubLlm(answers) {
  const calls = [];
  return {
    calls,
    json: async (request) => {
      calls.push(request);
      const next = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (next instanceof Error) throw next;
      return { data: next, usd: 0.001 };
    },
  };
}

test('second pass: only a phrase whose verified quote holds it, said without a negation, is kept; the call carries the task and budget scope', async () => {
  const fixture = fixtures['tea-shop'];
  const chunk = { meetingId: fixture.meetingId, purpose: 'demo', chunkSha: 'c1', text: fixture.text };
  const llm = stubLlm([{ keywords: [
    { phrase: 'løs grønn te', quote: 'Vi vil at folk skal finne oss når de søker etter løs grønn te', speaker: 'Kunde' },
    { phrase: 'te på nett', quote: 'Vi vil at folk skal finne oss når de søker etter løs grønn te', speaker: 'Kunde' },
    { phrase: 'teservise', quote: 'Vi vil rangere på teservise og kopper', speaker: 'Kunde' },
    { phrase: 'teservise', quote: 'Nei, det selger vi for lite av', speaker: 'Kunde' },
    { phrase: 'løs grønn te', quote: 'Vi vil at folk skal finne oss når de søker etter løs grønn te', speaker: 'Rådgiver' },
  ] }]);
  const result = await kw.secondPass({ chunks: [chunk], llm, clientId: 'syn-tea' });
  assert.deepEqual(result.phrases.map((row) => row.phrase), ['løs grønn te']);
  assert.equal(result.phrases[0].quote, 'Vi vil at folk skal finne oss når de søker etter løs grønn te');
  assert.equal(result.calls, 1);
  const [request] = llm.calls;
  assert.equal(request.task, 'seo.agreed-extract');
  assert.deepEqual(request.ctx, { salesClientId: 'syn-tea', dataClass: 'transcript', budgetScope: 'meetingKeywords', jobId: 'meeting-keywords:syn-tea' });
  assert.equal(request.schema.properties.keywords.items.additionalProperties, false);

  const negated = stubLlm([{ keywords: [{ phrase: 'sykkelutleie', quote: 'Vi vil ikke bli funnet på sykkelutleie, det driver vi ikke med lenger', speaker: 'Kunde' }] }]);
  const bike = fixtures['bike-workshop'];
  const none = await kw.secondPass({ chunks: [{ meetingId: bike.meetingId, purpose: 'sales', chunkSha: 'c2', text: bike.text }], llm: negated, clientId: 'syn-bike' });
  assert.deepEqual(none.phrases, [], 'a phrase right after a negation is not kept');
});

test('second pass: a failed call stops the run, and at most six chunks are asked', async () => {
  const failing = stubLlm([Object.assign(new Error('budget'), { code: 'budget_exceeded' })]);
  const chunks = Array.from({ length: 3 }, (_, index) => ({ meetingId: 'm', purpose: 'sales', chunkSha: `c${index}`, text: 'Kunde: Vi vil rangere på noe.' }));
  const halted = await kw.secondPass({ chunks, llm: failing, clientId: 'syn' });
  assert.equal(halted.halted, true);
  assert.deepEqual(halted.errors, ['budget_exceeded']);
  assert.equal(failing.calls.length, 1);
  const many = stubLlm([{ keywords: [] }]);
  await kw.secondPass({ chunks: Array.from({ length: 9 }, (_, index) => ({ ...chunks[0], chunkSha: `m${index}` })), llm: many, clientId: 'syn' });
  assert.equal(many.calls.length, 6);
});

// ---------------------------------------------------------------- the delivery-loop step

function settingsWith(node, pilots = ['syn-kw-pilot']) {
  const settings = defaultAutomationSettings();
  settings.pilotClientIds = pilots;
  settings.intake.transcriptKeywords = { enabled: true, mode: 'auto', paused: null, ...node };
  return settings;
}

function stepCtx({ settings = defaultAutomationSettings(), mode = 'auto', deps = {}, shadow = null } = {}) {
  return { settings, mode, dataDir: DATA_DIR, log: { info() {}, warn() {}, error() {} }, ...(shadow ? { shadow } : {}), deps };
}

function inputsFor(fixture, { extraction = true } = {}) {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    readExtraction: () => {
      reads += 1;
      return extraction ? { inputHash: `in-${fixture.meetingId}`, items: fixture.items } : null;
    },
    readTranscripts: () => {
      reads += 1;
      return [{ meetingId: fixture.meetingId, purpose: fixture.purpose, transcript: fixture.text }];
    },
  };
}

const seoFile = (id) => join(DATA_DIR, 'seo-ops', 'clients', `${id}.json`);

test('step: off (the default) answers switch-off before reading anything, calling a model or writing', async () => {
  const client = { id: 'syn-kw-pilot', businessName: 'Testvik Sykkelverksted AS' };
  const inputs = inputsFor(fixtures['bike-workshop']);
  const llm = stubLlm([{ keywords: [] }]);
  for (const settings of [defaultAutomationSettings(), settingsWith({ enabled: true, paused: { reason: 'checking', at: '2026-11-05T10:00:00.000Z', by: 'admin' } })]) {
    const result = await kw.runTranscriptKeywordStep(stepCtx({ settings, deps: { ...inputs, llm } }), client);
    assert.deepEqual(result, { wrote: false, skipped: 'switch-off' });
  }
  assert.equal(inputs.reads, 0);
  assert.equal(llm.calls.length, 0);
  assert.equal(existsSync(join(DATA_DIR, 'seo-ops')), false);
});

test('step: shadow records what it would propose, calls no model and writes no SEO record', async () => {
  const fixture = fixtures['bike-workshop'];
  const client = { id: 'syn-kw-other', businessName: fixture.business.name };
  const shadows = [];
  const llm = stubLlm([{ keywords: [] }]);
  // The switch in auto, but the client is not a pilot: it runs in shadow.
  const result = await kw.runTranscriptKeywordStep(stepCtx({ settings: settingsWith({}), deps: { ...inputsFor(fixture), llm }, shadow: (key, value) => shadows.push([key, value]) }), client);
  assert.equal(result.shadow, true);
  assert.deepEqual(keys(result.phrases), keys(fixture.expected));
  assert.equal(shadows.length, 1);
  assert.match(shadows[0][0], /^seo-transcript-keywords:syn-kw-other:[0-9a-f]{16}$/);
  assert.equal(llm.calls.length, 0);
  assert.equal(existsSync(seoFile('syn-kw-other')), false);
  // A loop in shadow keeps a pilot in shadow as well.
  const pilot = await kw.runTranscriptKeywordStep(stepCtx({ settings: settingsWith({}), mode: 'shadow', deps: { ...inputsFor(fixture), llm } }), { id: 'syn-kw-pilot', businessName: fixture.business.name });
  assert.equal(pilot.shadow, true);
  assert.equal(existsSync(seoFile('syn-kw-pilot')), false);
});

test('step: auto proposes for a pilot, never approves, keeps the inputs hash, and the same meetings are not handled twice', async () => {
  const fixture = fixtures['skin-clinic'];
  const client = { id: 'syn-kw-pilot', businessName: fixture.business.name };
  const llm = stubLlm([{ keywords: [] }]);
  const ctx = stepCtx({ settings: settingsWith({}), deps: { ...inputsFor(fixture), llm } });
  const first = await kw.runTranscriptKeywordStep(ctx, client);
  assert.equal(first.wrote, true);
  assert.deepEqual(keys(first.added), keys(fixture.expected));
  const stored = record.readSeoRecord('syn-kw-pilot');
  assert.deepEqual(stored.agreedKeywords.map((row) => [row.status, row.source]), fixture.expected.map(() => ['proposed', 'transcript']));
  assert.equal(stored.agreedKeywords.some((row) => /botox/i.test(row.phrase)), false);
  assert.equal(record.agreedKeywordsFor(stored).length, 0, 'nothing is approved');
  assert.match(stored.keywordProposals.transcript.sourceHash, /^[0-9a-f]{64}$/);
  assert.equal(llm.calls.length, 0, 'every talk item had a clean phrase: no second pass');
  const again = await kw.runTranscriptKeywordStep(ctx, client);
  assert.deepEqual(again, { wrote: false, skipped: 'unchanged' });
});

test('step: without a brief extraction the second pass reads the chunks with keyword talk; a halted pass keeps no hash', async () => {
  const fixture = fixtures['tea-shop'];
  const client = { id: 'syn-kw-tea', businessName: fixture.business.name };
  const settings = settingsWith({}, ['syn-kw-tea']);
  const failing = stubLlm([Object.assign(new Error('provider down'), { code: 'provider_error' })]);
  const halted = await kw.runTranscriptKeywordStep(stepCtx({ settings, deps: { ...inputsFor(fixture, { extraction: false }), llm: failing } }), client);
  assert.equal(halted.secondPass.halted, true);
  assert.equal(failing.calls.length, 1);
  assert.equal(existsSync(seoFile('syn-kw-tea')), false, 'no proposal and no hash after a halted pass');

  const llm = stubLlm([{ keywords: [{ phrase: 'økologisk te', quote: 'Vi vil også dukke opp på økologisk te, det spør kundene mest om', speaker: 'Kunde' }] }]);
  const done = await kw.runTranscriptKeywordStep(stepCtx({ settings, deps: { ...inputsFor(fixture, { extraction: false }), llm } }), client);
  assert.deepEqual(done.added, ['økologisk te']);
  assert.equal(llm.calls[0].ctx.budgetScope, 'meetingKeywords');
  assert.ok(record.readSeoRecord('syn-kw-tea').keywordProposals.transcript.sourceHash);
});

test('the delivery loop finds the step in the SEO record module', async () => {
  const { steps, errors } = await loadTickSteps();
  assert.deepEqual(errors, []);
  const step = steps.find((entry) => entry.name === 'seo-transcript-keywords');
  assert.ok(step);
  assert.equal(step.scope, 'client');
  assert.equal(step.everyMs, 15 * 60 * 1000);
  assert.deepEqual(await step.run(stepCtx(), { id: 'syn-kw-pilot' }), { wrote: false, skipped: 'switch-off' });
});
