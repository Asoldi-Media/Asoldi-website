// Delivery brief assembly, versioned store, reviews, markdown and the loop step. The LLM is a stub;
// transcripts, client data and offers are synthetic and injected through the sources' deps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-brief-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.DATA_DIR;

const brief = await import('../lib/delivery-brief/index.js');
const store = await import('../lib/delivery-brief/store.js');
const { assembleBrief, clipTranscriptRuns, transcriptRunSet, MAX_TRANSCRIPT_RUN_WORDS } = await import('../lib/delivery-brief/assemble.js');
const { findClientTranscript, gatherBriefSources } = await import('../lib/delivery-brief/sources.js');
const { sha256 } = await import('../lib/delivery-brief/text.js');
const { promptFor } = await import('../lib/delivery-brief/extract.js');
const { chunkTranscript } = await import('../lib/delivery-brief/chunk.js');
const { renderBriefMarkdown } = await import('../lib/delivery-brief/render-md.js');
const { validateDeliveryBrief } = await import('../lib/delivery-brief/facts-contract.js');
const { normalizeSitePlan } = await import('../lib/site-plan-model.js');
const { spineModeForClient } = await import('../lib/spine-mode.js');
const { defaultAutomationSettings, validateAutomationSettings } = await import('../data/automation-settings.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

// ---------------------------------------------------------------- synthetic client

const LONG_LINE = 'Kunde: Det viktigste for oss er at folk som trenger nytt bad i hele fylket finner oss raskt, ser bilder av jobbene vi har gjort og ringer oss direkte uten å fylle ut lange skjemaer først.';

function meetingText(prefix, count, extra = []) {
  const lines = [];
  for (let i = 0; i < count; i += 1) lines.push(`${i % 2 ? 'Kunde' : 'Selger'}: ${prefix} del ${i} handler om sider, bilder og tekst på nettsiden, punkt ${i}.`);
  extra.forEach((line, index) => lines.splice(Math.floor(((index + 1) * lines.length) / (extra.length + 1)), 0, line));
  return lines.join('\n');
}

const TRANSCRIPTS = {
  'syn-m-sales': meetingText('Salg', 140, [
    'Kunde: Firmaet heter Eksempel Bad og vi holder til i Eksempelby.',
    'Kunde: Vi har drevet med flislegging i 26 år her i byen.',
    'Kunde: Ring oss gjerne på 0000 0001 når siden er klar.',
    'Selger: Bloggen er inkludert i pakken, og vi skriver innlegg hver måned.',
    LONG_LINE,
  ]),
  'syn-m-workshop': meetingText('Workshop', 90, [
    'Kunde: Telefonnummeret på siden skal stå helt øverst i menyen.',
    'Kunde: Vi vil lansere siden før 15. desember, altså 2026-12-15.',
  ]),
};

function clientRecord(overrides = {}) {
  return {
    id: 'syn-brief-1',
    businessName: 'Eksempel Bad AS',
    language: 'no',
    portalBusinessId: 'biz-syn-1',
    sitePlan: normalizeSitePlan({ status: 'active', tierId: 'tier-2-seo', services: ['site', 'changes', 'blog', 'seo', 'social', 'email', 'backlinks'], pages: 7, billing: 'month', signedAt: '2026-10-02T10:00:00.000Z', offerId: 'offer-syn-1' }),
    meetings: [
      { meetingId: 'syn-m-sales', purpose: 'sales', startedAt: '2026-10-01T10:00:00.000Z', hasTranscript: true },
      { meetingId: 'syn-m-workshop', purpose: 'workshop', startedAt: '2026-10-08T10:00:00.000Z', hasTranscript: true },
    ],
    workshop: {
      projectDocument: {
        meetingId: 'syn-m-workshop',
        todos: [
          { id: 'todo-1', category: 'Sider og innhold', title: 'Skriv tjenestesiden', detail: '', done: false },
          { id: 'todo-2', category: 'Åpne beslutninger', title: 'Velg farge på knappene', detail: '', done: false },
          { id: 'todo-3', category: 'Utenfor scope', title: 'Bookingsystem', detail: '', done: false },
        ],
      },
    },
    delivery: { stage: 'gathering' },
    ...overrides,
  };
}

const BANK = {
  generalInfo: { companyName: 'Eksempel Bad', companyPhone: '+47 0000 0999', companyEmail: 'post@example.com', companyAddress: '', instagramUrl: '', facebookUrl: '', extraLinks: [] },
  brandIdentity: { orgNumber: '012345671' },
  websiteCreatorQuestions: { targetAudience: 'Huseiere i fylket', town: 'Eksempelby', businessWhat: '', toneOfVoice: '', businessStory: '', differentiator: '' },
  productCatalogs: [],
};

function depsFor({ transcripts = TRANSCRIPTS, bank = BANK, offer = null } = {}) {
  return {
    readArchivedTranscripts: () => [],
    readStoredMeeting: (meetingId) => (transcripts[meetingId] ? { meetingId, transcript: transcripts[meetingId] } : null),
    offer: () => (offer ? { offer, offerHash: `offer-${offer.id}` } : { offer: null, offerHash: '' }),
    sites: () => [],
    profiles: () => [{ businessId: 'biz-syn-1', clientDataBank: bank }],
    gate: () => null,
    mediaManifest: () => [],
    agreedKeywords: () => null,
    cmsSetup: () => null,
    featureKeys: ['blog', 'blog.posts', 'blog.autoPosts', 'seo.keywords'],
    availabilityOf: (key) => (key === 'blog.autoPosts' ? 'partial' : 'available'),
  };
}

// ---------------------------------------------------------------- stub LLM

function chunkOf(user) {
  const marker = 'Transcript part:\n';
  const at = String(user || '').indexOf(marker);
  return at >= 0 ? user.slice(at + marker.length) : '';
}

function answer(chunk) {
  const out = { facts: [], directives: [], iterations: [], promises: [], followUps: [], approvalSignals: [], requests: [], openQuestions: [] };
  const has = (text) => chunk.includes(text);
  if (has('Firmaet heter Eksempel Bad')) out.facts.push({ path: 'identity.brandName', value: 'Eksempel Bad', quote: 'Firmaet heter Eksempel Bad', speaker: 'Kunde' });
  if (has('flislegging i 26 år')) out.facts.push({ path: 'claims.stats', value: '26', number: 26, unit: 'years', label: 'i bransjen', quote: 'Vi har drevet med flislegging i 26 år', speaker: 'Kunde' });
  if (has('Ring oss gjerne på 0000 0001')) out.facts.push({ path: 'contact.phone', value: '0000 0001', quote: 'Ring oss gjerne på 0000 0001', speaker: 'Kunde' });
  if (has('Bloggen er inkludert')) out.promises.push({ featureKey: 'blog.autoPosts', text: 'Blogginnlegg hver måned', quote: 'vi skriver innlegg hver måned', speaker: 'Selger' });
  if (has('Telefonnummeret på siden')) out.directives.push({ kind: 'change', scope: 'section', area: 'chrome.header', ask: 'Telefonnummeret øverst i menyen', priority: 'must', quote: 'Telefonnummeret på siden skal stå helt øverst i menyen', speaker: 'Kunde' });
  if (has('2026-12-15')) out.facts.push({ path: 'timeline.targetLaunchAt', value: '2026-12-15', quote: 'Vi vil lansere siden før 15. desember', speaker: 'Kunde' });
  if (has(LONG_LINE)) {
    // A model that copies a long passage into a field: the brief must not keep 20 words in a row.
    const passage = LONG_LINE.replace(/^Kunde: /, '');
    out.directives.push({ kind: 'add', area: 'hero', ask: passage, priority: 'should', quote: 'finner oss raskt', speaker: 'Kunde' });
  }
  return out;
}

function stubLlm({ failAfter = Infinity } = {}) {
  const state = { calls: 0 };
  return {
    state,
    json: async (request) => {
      state.calls += 1;
      if (state.calls > failAfter) throw Object.assign(new Error('stub outage'), { code: 'provider_dead' });
      return { data: answer(chunkOf(request.user)), usd: 0.001, provider: 'claude', model: 'claude-haiku-5-5', route: { route: 'claude:claude-haiku-5-5:medium' } };
    },
  };
}

let dirCount = 0;
function freshDir() {
  dirCount += 1;
  const dir = join(dataDir, `case-${dirCount}`);
  return dir;
}

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => allStrings(item, out));
  return out;
}

function hasTranscriptRun(value, transcripts, words = MAX_TRANSCRIPT_RUN_WORDS + 1) {
  const runs = transcriptRunSet(transcripts, words);
  for (const string of allStrings(value)) {
    const tokens = string.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    for (let i = 0; i + words <= tokens.length; i += 1) if (runs.has(tokens.slice(i, i + words).join(' '))) return string;
  }
  return '';
}

// ---------------------------------------------------------------- rebuild and store

test('a rebuild assembles a valid brief; the same input gives the same hash and no new version', async () => {
  const dir = freshDir();
  const client = clientRecord();
  const llm = stubLlm();
  const first = await brief.rebuildBrief(client, { llm, dataDir: dir, deps: depsFor() });
  assert.equal(first.status, 'built');
  assert.equal(first.version, 1);
  const stored = store.readLatestBrief(client.id, { dataDir: dir });
  const valid = validateDeliveryBrief(stored);
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  assert.equal(stored.hash, store.computeBriefHash(stored));
  assert.equal(stored.sitePlan.tierId, 'tier-2-seo');
  assert.equal(stored.transcripts.length, 2);
  assert.ok(stored.transcripts.every((ref) => /^[0-9a-f]{64}$/.test(ref.sha256) && ref.chars > 0 && !('transcript' in ref)));
  assert.equal(stored.delivery.targetLaunchAt, '2026-12-15');
  assert.deepEqual(stored.todos.map((row) => row.id), ['todo-1']);
  assert.deepEqual(stored.openDecisions.map((row) => row.id), ['todo-2']);
  assert.deepEqual(stored.outOfScope.map((row) => row.id), ['todo-3']);
  assert.deepEqual(stored.unbuiltPromises, ['blog.autoPosts']);
  assert.ok(stored.directives.some((row) => row.target.area === 'chrome.header' && row.status === 'open' && row.quote));
  const callsAfterFirst = llm.state.calls;

  const second = await brief.rebuildBrief(client, { llm, dataDir: dir, deps: depsFor() });
  assert.equal(second.status, 'unchanged');
  assert.equal(second.version, 1);
  assert.equal(second.hash, first.hash);
  assert.equal(llm.state.calls, callsAfterFirst, 'cached chunks: no new LLM calls');
  assert.equal(store.listBriefVersions(client.id, { dataDir: dir }).length, 1);
});

test('client-confirmed data beats transcript data; the sales card only fills gaps', async () => {
  const dir = freshDir();
  await brief.rebuildBrief(clientRecord(), { llm: stubLlm(), dataDir: dir, deps: depsFor() });
  const stored = store.readLatestBrief('syn-brief-1', { dataDir: dir });
  assert.equal(stored.facts.contact.phone, '+47 0000 0999', 'Kundedata phone, not the one said in the meeting');
  assert.deepEqual(stored.factSources['contact.phone'], { kind: 'client', status: 'client-confirmed' });
  assert.equal(stored.facts.contact.email, 'post@example.com');
  assert.equal(stored.facts.contact.scope, 'public');
  assert.equal(stored.facts.positioning.audience, 'Huseiere i fylket');
  assert.equal(stored.facts.identity.legalName, 'Eksempel Bad AS', 'card fallback');
  assert.equal(stored.factSources['identity.legalName'].status, 'proposed');
  const stat = stored.facts.claims.stats[0];
  assert.equal(stat.value, 26);
  assert.equal(stat.quoteVerified, true);
  assert.equal(stored.factSources['claims.stats[0]'].quoteVerified, true);

  const noBank = freshDir();
  await brief.rebuildBrief(clientRecord(), { llm: stubLlm(), dataDir: noBank, deps: depsFor({ bank: {} }) });
  const plain = store.readLatestBrief('syn-brief-1', { dataDir: noBank });
  assert.equal(plain.facts.contact.phone, '0000 0001', 'without Kundedata the transcript fact stands');
  assert.equal(plain.factSources['contact.phone'].kind, 'transcript');
});

test('reviews survive a rebuild', async () => {
  const dir = freshDir();
  const client = clientRecord();
  const deps = depsFor();
  await brief.rebuildBrief(client, { llm: stubLlm(), dataDir: dir, deps });
  const v1 = store.readLatestBrief(client.id, { dataDir: dir });
  const directive = v1.directives.find((row) => row.target.area === 'chrome.header');
  store.setDirectiveStatus(client.id, directive.id, { status: 'accepted', by: 'dev', jobId: 'job-1' }, { dataDir: dir });
  const statId = v1.facts.claims.stats[0].id;
  assert.match(statId, /^f-[0-9a-f]{12}$/);
  store.reviewFact(client.id, statId, { status: 'rejected', by: 'dev' }, { dataDir: dir });
  store.reviewFact(client.id, 'positioning.toneOfVoice', { status: 'accepted', value: 'Rolig og saklig', by: 'dev' }, { dataDir: dir });
  const after = await brief.reassembleBrief(client, { dataDir: dir, deps });
  assert.equal(after.status, 'built');
  assert.equal(after.version, 2);

  // A changed input (a new iteration meeting with other wishes) rebuilds; the reviews still apply.
  const transcripts = { ...TRANSCRIPTS, 'syn-m-iteration': meetingText('Iterasjon', 30, ['Kunde: Vi vil lansere siden før 15. desember, altså 2026-12-15.']) };
  const changed = clientRecord({ meetings: [...clientRecord().meetings, { meetingId: 'syn-m-iteration', purpose: 'iteration', startedAt: '2026-10-20T10:00:00.000Z', hasTranscript: true }] });
  const rebuilt = await brief.rebuildBrief(changed, { llm: stubLlm(), dataDir: dir, deps: depsFor({ transcripts }) });
  assert.equal(rebuilt.status, 'built');
  const latest = store.readLatestBrief(client.id, { dataDir: dir });
  assert.ok(latest.version > after.version);
  assert.ok(latest.transcripts.some((ref) => ref.meetingId === 'syn-m-iteration'));
  const kept = latest.directives.find((row) => row.id === directive.id);
  assert.ok(kept, 'the reviewed directive keeps its id');
  assert.equal(kept.status, 'accepted');
  assert.equal(kept.reviewedBy, 'dev');
  assert.deepEqual(kept.appliedInJobs, ['job-1']);
  assert.equal(latest.factSources['timeline.targetLaunchAt'].purpose, 'iteration', 'the iteration repeat outranks the workshop statement');
  assert.equal(latest.facts.claims.stats[0].status, 'rejected');
  assert.equal(latest.facts.positioning.toneOfVoice, 'Rolig og saklig');
  assert.equal(latest.factSources['positioning.toneOfVoice'].status, 'accepted');
  assert.equal(latest.inputs.reviewsRevision, 3);
  assert.equal(store.readReviews(client.id, { dataDir: dir }).revision, 3);
  assert.throws(() => store.setDirectiveStatus(client.id, directive.id, { status: 'maybe' }, { dataDir: dir }), (error) => error.code === 'bad-status');
  assert.throws(() => store.reviewFact(client.id, '../etc', { status: 'accepted' }, { dataDir: dir }), (error) => error.code === 'bad-fact-path');
});

test('fact reviews: only single fact paths and transcript fact ids; a review that breaks the schema is refused and not stored', async () => {
  const dir = freshDir();
  const client = clientRecord();
  const deps = depsFor();
  await brief.rebuildBrief(client, { llm: stubLlm(), dataDir: dir, deps });
  for (const path of ['claims.stats[0]', 'positioning.services[1]', 'products.catalogs', 'schema', 'facts.schema', 'positioning.services', 'contact.scope']) {
    assert.throws(() => store.reviewFact(client.id, path, { status: 'accepted', value: 'x' }, { dataDir: dir }), (error) => error.code === 'bad-fact-path', path);
  }
  const statId = store.readLatestBrief(client.id, { dataDir: dir }).facts.claims.stats[0].id;
  assert.throws(() => store.reviewFact(client.id, statId, { status: 'accepted', value: '40' }, { dataDir: dir }), (error) => error.code === 'bad-value', 'an id takes a status only');
  const revision = store.readReviews(client.id, { dataDir: dir }).revision;
  const versions = store.listBriefVersions(client.id, { dataDir: dir }).length;
  for (const [path, value] of [['contact.onlineOnly', 'kanskje'], ['logo.wordmarkSpec.weight', 'tykk'], ['logo.wordmarkSpec.case', 'STOR'], ['timeline.targetLaunchAt', 'snart']]) {
    await assert.rejects(brief.reviewBriefFact(client, path, { status: 'accepted', value }, { dataDir: dir, deps }), (error) => error.code === 'invalid-review' && error.errors.length > 0, path);
  }
  assert.equal(store.readReviews(client.id, { dataDir: dir }).revision, revision, 'a refused review is not stored');
  assert.equal(store.listBriefVersions(client.id, { dataDir: dir }).length, versions);
  const ok = await brief.reviewBriefFact(client, 'contact.onlineOnly', { status: 'accepted', value: true }, { dataDir: dir, deps });
  assert.equal(ok.status, 'built');
  const latest = store.readLatestBrief(client.id, { dataDir: dir });
  assert.equal(latest.facts.contact.onlineOnly, true);
  assert.equal(validateDeliveryBrief(latest).valid, true);

  // A list entry's review follows its id when a rebuild changes the order of the list.
  await brief.reviewBriefFact(client, statId, { status: 'rejected' }, { dataDir: dir, deps });
  const more = { ...TRANSCRIPTS, 'syn-m-sales': TRANSCRIPTS['syn-m-sales'].replace('Kunde: Firmaet heter', 'Kunde: Vi har hatt 300 fornøyde kunder i år.\nKunde: Firmaet heter') };
  const extraAnswer = stubLlm();
  const json = extraAnswer.json;
  extraAnswer.json = async (request) => {
    const result = await json(request);
    if (request.user.includes('300 fornøyde kunder')) result.data.facts.unshift({ path: 'claims.stats', value: '300', number: 300, unit: 'kunder', label: 'fornøyde kunder', quote: 'Vi har hatt 300 fornøyde kunder', speaker: 'Kunde', confidence: 0.95 });
    return result;
  };
  await brief.rebuildBrief(client, { llm: extraAnswer, dataDir: dir, deps: depsFor({ transcripts: more }) });
  const reordered = store.readLatestBrief(client.id, { dataDir: dir });
  const byId = new Map(reordered.facts.claims.stats.map((stat) => [stat.id, stat]));
  assert.equal(reordered.facts.claims.stats.length, 2);
  assert.notEqual(reordered.facts.claims.stats[0].id, statId, 'the new stat now comes first');
  assert.equal(byId.get(statId).status, 'rejected', 'the reviewed stat keeps its review');
  assert.equal(reordered.facts.claims.stats.find((stat) => stat.id !== statId).status, 'proposed', 'the new stat is not affected');
});

test('client data: a Kundedata differentiator shifts every transcript differentiator source, also beyond ten', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `f-${String(i).padStart(12, '0')}`,
    type: 'fact',
    path: 'positioning.differentiators',
    value: `Forskjell nummer ${i} ord${i}`,
    quote: `forskjell ${i}`,
    speaker: 'Kunde',
    meetingId: 'm',
    purpose: 'sales',
    status: 'active',
    confidence: 0.8,
  }));
  const sources = { meetings: [], parts: { meetings: [] }, bank: { websiteCreatorQuestions: { differentiator: 'Fra Kundedata' } }, media: [], seo: {}, cmsSetup: null, changeRequests: [], projectDocument: null };
  const assembled = assembleBrief({ client: { id: 'syn-diff' }, sources, extraction: { items }, reviews: {} });
  const list = assembled.facts.positioning.differentiators;
  assert.equal(list.length, 13);
  assert.equal(list[0], 'Fra Kundedata');
  assert.deepEqual(assembled.factSources['positioning.differentiators[0]'], { kind: 'client', status: 'client-confirmed' });
  for (let i = 1; i < list.length; i += 1) {
    const source = assembled.factSources[`positioning.differentiators[${i}]`];
    assert.ok(source, `source ${i}`);
    assert.equal(source.factId, items[i - 1].id, `entry ${i} keeps its own source`);
  }
});

test('the brief is at most 300 KB and holds no 20-word run from any transcript', async () => {
  const dir = freshDir();
  const bigCatalogs = [{ layout: 'normal', categories: Array.from({ length: 40 }, (_, c) => ({ name: `Kategori ${c}`, products: Array.from({ length: 40 }, (_, p) => ({ name: `Produkt ${c}-${p}`, description: 'Lang beskrivelse '.repeat(20), price: '199' })) })) }];
  const client = clientRecord();
  await brief.rebuildBrief(client, { llm: stubLlm(), dataDir: dir, deps: depsFor({ bank: { ...BANK, productCatalogs: bigCatalogs } }) });
  const stored = store.readLatestBrief(client.id, { dataDir: dir });
  const file = join(store.clientBriefDir(client.id, { dataDir: dir }), `v${stored.version}.json`);
  assert.ok(statSync(file).size <= store.MAX_BRIEF_BYTES, `${statSync(file).size} bytes`);
  assert.ok(stored.stats.trimmed?.includes('catalogs'), 'the oversized catalog was left out');
  assert.equal(hasTranscriptRun(stored, Object.values(TRANSCRIPTS)), '', 'no 20-word run');
  assert.ok(stored.stats.clipped >= 1, 'the copied passage was clipped');
  const hero = stored.directives.find((row) => row.target.area === 'hero');
  assert.ok(hero.ask.endsWith('…'));
  assert.ok(hero.ask.split(/\s+/).length <= MAX_TRANSCRIPT_RUN_WORDS + 1);
  // Negative control: the same text unclipped does contain such a run.
  assert.notEqual(hasTranscriptRun({ ask: LONG_LINE }, Object.values(TRANSCRIPTS)), '');
  const { value, clipped } = clipTranscriptRuns({ a: LONG_LINE, b: 'kort tekst' }, Object.values(TRANSCRIPTS));
  assert.equal(clipped, 1);
  assert.equal(value.b, 'kort tekst');
});

test('the store keeps at most 10 versions and 2 MB per client, newest always kept', () => {
  const dir = freshDir();
  for (let i = 0; i < 14; i += 1) store.saveBrief('syn-cap', { schema: 'asoldi.delivery-brief/1', salesClientId: 'syn-cap', n: i }, { dataDir: dir });
  const versions = store.listBriefVersions('syn-cap', { dataDir: dir });
  assert.equal(versions.length, 10);
  assert.equal(versions[0].version, 14);
  assert.equal(versions.at(-1).version, 5);
  const big = 'x'.repeat(250 * 1024);
  for (let i = 0; i < 12; i += 1) store.saveBrief('syn-bytes', { schema: 'asoldi.delivery-brief/1', pad: big, n: i }, { dataDir: dir });
  const bytes = store.listBriefVersions('syn-bytes', { dataDir: dir }).reduce((sum, row) => sum + row.bytes, 0);
  assert.ok(bytes <= store.MAX_CLIENT_BYTES, `${bytes} bytes`);
  assert.equal(store.readLatestBrief('syn-bytes', { dataDir: dir }).version, 12);
  assert.throws(() => store.saveBrief('syn-bytes', { schema: 'asoldi.delivery-brief/1', pad: 'x'.repeat(310 * 1024) }, { dataDir: dir }), (error) => error.code === 'brief-too-large');
  assert.throws(() => store.saveBrief('../escape', { schema: 'asoldi.delivery-brief/1' }, { dataDir: dir }), (error) => error.code === 'bad-client-id');
  const unchanged = store.saveBrief('syn-cap', { schema: 'asoldi.delivery-brief/1', salesClientId: 'syn-cap', n: 13 }, { dataDir: dir });
  assert.equal(unchanged.changed, false);
});

test('the chunk cache counts toward the 2 MB per client: old versions go first, also when only the cache grew', () => {
  const dir = freshDir();
  const id = 'syn-cache-cap';
  const pad = 'x'.repeat(200 * 1024);
  for (let i = 0; i < 4; i += 1) store.saveBrief(id, { schema: 'asoldi.delivery-brief/1', pad, n: i }, { dataDir: dir });
  assert.equal(store.listBriefVersions(id, { dataDir: dir }).length, 4, 'four versions are well under the cap');
  const chunks = store.chunkCacheDir(id, { dataDir: dir });
  mkdirSync(chunks, { recursive: true });
  const addChunks = (from, count) => {
    for (let i = from; i < from + count; i += 1) writeFileSync(join(chunks, `c${i}-p.json`), JSON.stringify({ items: [], pad: 'y'.repeat(200 * 1024) }));
  };
  const onDisk = () => store.listBriefVersions(id, { dataDir: dir }).reduce((sum, row) => sum + row.bytes, 0)
    + readdirSync(chunks).reduce((sum, name) => sum + statSync(join(chunks, name)).size, 0);
  addChunks(0, 7);
  const saved = store.saveBrief(id, { schema: 'asoldi.delivery-brief/1', pad, n: 4 }, { dataDir: dir });
  assert.deepEqual(saved.pruned, [1, 2], 'with the cache counted, the two oldest versions go');
  assert.ok(onDisk() <= store.MAX_CLIENT_BYTES, `${onDisk()} bytes`);
  assert.equal(readdirSync(chunks).length, 7, 'the cache itself is never cut here');

  // Only the cache grew (a rebuild of longer meetings): the caps apply without a new version.
  addChunks(7, 3);
  assert.deepEqual(store.enforceClientCaps(id, { dataDir: dir }), [3, 4]);
  assert.deepEqual(store.listBriefVersions(id, { dataDir: dir }).map((row) => row.version), [5], 'the newest version always stays');
  assert.equal(store.readLatestBrief(id, { dataDir: dir }).version, 5);
  assert.deepEqual(store.enforceClientCaps(id, { dataDir: dir }), [], 'nothing more to drop');
  assert.deepEqual(store.enforceClientCaps('syn-no-folder', { dataDir: dir }), []);
  assert.equal(existsSync(store.clientBriefDir('syn-no-folder', { dataDir: dir })), false, 'no folder is created');
});

test('the hash ignores version, generatedAt, stats and URL signatures', () => {
  const base = { schema: 'asoldi.delivery-brief/1', facts: { media: { manifest: [{ id: 'a', url: 'https://example.com/m/a?exp=1&sig=abc' }] } } };
  const other = { ...base, version: 4, generatedAt: '2026-01-01T00:00:00.000Z', stats: { costUsd: 1 }, facts: { media: { manifest: [{ id: 'a', url: 'https://example.com/m/a?exp=2&sig=def' }] } } };
  assert.equal(store.computeBriefHash(base), store.computeBriefHash(other));
  assert.notEqual(store.computeBriefHash(base), store.computeBriefHash({ ...base, salesClientId: 'x' }));
});

test('markdown lists the tier, the services and the directives with their quotes', async () => {
  const dir = freshDir();
  await brief.rebuildBrief(clientRecord(), { llm: stubLlm(), dataDir: dir, deps: depsFor() });
  const stored = store.readLatestBrief('syn-brief-1', { dataDir: dir });
  const md = renderBriefMarkdown(stored);
  assert.match(md, /^# Leveransebrief: Eksempel Bad/m);
  assert.match(md, /Nivå: SEO \(nivå 2\) \(`tier-2-seo`\)/);
  for (const service of ['Nettside (`site`)', 'SEO (`seo`)', 'Lenkenettverk (`backlinks`)']) assert.ok(md.includes(service), service);
  assert.match(md, /## Direktiver/);
  const header = stored.directives.find((row) => row.target.area === 'chrome.header');
  assert.ok(md.includes(`**Endre** \`chrome.header\``));
  assert.ok(md.includes(`> «${header.quote}»`), 'the quote under the directive');
  assert.match(md, /## Åpne beslutninger/);
  assert.match(md, /## Møter \(bare referanser\)/);
  assert.equal(hasTranscriptRun(md, Object.values(TRANSCRIPTS)), '');
});

test('an interrupted rebuild saves nothing and the next one redoes only the missing chunks', async () => {
  const dir = freshDir();
  const client = clientRecord();
  const flaky = stubLlm({ failAfter: 1 });
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  const partial = await brief.rebuildBrief(client, { llm: flaky, dataDir: dir, deps: depsFor(), backoffNow: t0 });
  assert.equal(partial.status, 'partial');
  assert.equal(flaky.state.calls, 2, 'one answer, one failure, then no more calls in this run');
  assert.equal(store.readLatestBrief(client.id, { dataDir: dir }), null);
  const state = store.readBriefState(client.id, { dataDir: dir });
  assert.equal(state.partial, true);
  assert.equal(Object.keys(state.chunkFailures).length, 1);
  assert.equal(state.retryAt, new Date(t0 + 15 * 60_000).toISOString(), 'the failed chunk may be asked again in 15 minutes');
  const totalChunks = partial.meetings.reduce((sum, meeting) => sum + meeting.chunks.total, 0);

  // Before the backoff ends the failed chunk waits (the others are asked); a person's rebuild asks it at once.
  const early = stubLlm();
  const waiting = await brief.rebuildBrief(client, { llm: early, dataDir: dir, deps: depsFor(), backoffNow: t0 + 60_000 });
  assert.equal(waiting.status, 'partial');
  assert.equal(early.state.calls, totalChunks - 2);
  const healthy = stubLlm();
  const done = await brief.rebuildBrief(client, { llm: healthy, dataDir: dir, deps: depsFor(), ignoreBackoff: true });
  assert.equal(done.status, 'built');
  assert.equal(healthy.state.calls, 1);
  const after = store.readBriefState(client.id, { dataDir: dir });
  assert.equal(after.partial, false);
  assert.deepEqual(after.chunkFailures, {});
});

test('the lease: a rebuild while another runner holds it is refused, and a rebuild that lost it writes nothing', async () => {
  const dir = freshDir();
  const client = clientRecord({ id: 'syn-lease-1' });
  const { acquireLease } = await import('../data/email-store.js');
  const held = await acquireLease('brief:syn-lease-1', 60_000);
  const llm = stubLlm();
  await assert.rejects(brief.rebuildBrief(client, { llm, dataDir: dir, deps: depsFor() }), (error) => error.code === 'brief-busy');
  assert.equal(llm.state.calls, 0);
  await held.release();

  // Another runner takes the lease over while this one is in its LLM calls: nothing is saved.
  const own = await acquireLease('brief:syn-lease-1', 60_000);
  let stolen = false;
  const thief = {
    json: async (request) => {
      if (!stolen) {
        stolen = true;
        // Simulates expiry and a second runner taking the lease: its file now names another runner.
        const locks = [];
        const walk = (path) => {
          for (const entry of readdirSync(path, { withFileTypes: true })) {
            const full = join(path, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.lease') && entry.name.includes('syn-lease-1')) locks.push(full);
          }
        };
        walk(dataDir);
        assert.equal(locks.length, 1, 'one lease file');
        writeFileSync(locks[0], JSON.stringify({ name: 'brief:syn-lease-1', nonce: 'other-runner', expiresAt: Date.now() + 60_000 }));
      }
      return llm.json(request);
    },
  };
  const result = await brief.rebuildBrief(client, { llm: thief, dataDir: dir, deps: depsFor(), lease: own });
  assert.equal(result.status, 'lease-lost');
  const clientDir = store.clientBriefDir('syn-lease-1', { dataDir: dir });
  assert.deepEqual(existsSync(clientDir) ? readdirSync(clientDir).filter((name) => name !== 'chunks') : [], [], 'no brief, extraction or state file');
  await own.release();
});

test('the input hash covers what the brief shows: offer status, id and client wishes, the plan\'s offer and media rows', async () => {
  const offer = { id: 'offer-syn-1', status: 'sent', products: [{ name: 'Nettside' }], clientIntent: { headline: 'Flere kunder', wants: ['bilder'] } };
  const hashWith = async ({ offerValue = offer, client = clientRecord(), media = [] } = {}) => {
    const deps = { ...depsFor(), offer: () => ({ offer: offerValue, offerHash: 'same-content-hash' }), mediaManifest: () => media };
    return (await gatherBriefSources(client, { deps })).inputHash;
  };
  const base = await hashWith();
  assert.equal(await hashWith(), base);
  assert.notEqual(await hashWith({ offerValue: { ...offer, status: 'accepted' } }), base, 'offer status');
  assert.notEqual(await hashWith({ offerValue: { ...offer, id: 'offer-syn-2' } }), base, 'offer id');
  assert.notEqual(await hashWith({ offerValue: { ...offer, clientIntent: { headline: 'Flere kunder', wants: ['video'] } } }), base, 'client wishes');
  const plan = clientRecord();
  assert.notEqual(await hashWith({ client: { ...plan, sitePlan: { ...plan.sitePlan, offerId: 'offer-syn-2' } } }), base, 'the plan\'s offer');
  const item = { id: 'media-1', bucket: 'gallery', fileName: 'bad.jpg', mime: 'image/jpeg', bytes: 10, sha256: 'a'.repeat(64), url: 'https://example.com/m/1', credit: '' };
  const withMedia = await hashWith({ media: [item] });
  assert.notEqual(await hashWith({ media: [{ ...item, bucket: 'logo' }] }), withMedia, 'media bucket (logo status)');
  assert.notEqual(await hashWith({ media: [{ ...item, fileName: 'nytt.jpg' }] }), withMedia, 'file name');
  assert.notEqual(await hashWith({ media: [{ ...item, credit: 'Foto: Eksempel' }] }), withMedia, 'credit');
  assert.equal(await hashWith({ media: [{ ...item, url: 'https://example.com/m/1?sig=abc&exp=1' }] }), withMedia, 'a URL signature is not an input');
});

test('the loop builds briefs only for clients who bought something or are pilots', () => {
  const lead = { id: 'syn-lead', meetings: [{ meetingId: 'syn-m-sales', purpose: 'sales', hasTranscript: true }], delivery: { stage: 'sales_meeting' } };
  assert.equal(brief.clientNeedsBrief(lead, { settings: defaultAutomationSettings() }), false, 'a sales lead with a recorded meeting');
  assert.equal(brief.clientNeedsBrief({ ...lead, delivery: { stage: 'offer_sent' } }, { settings: defaultAutomationSettings() }), false);
  assert.equal(brief.clientNeedsBrief({ ...lead, delivery: { stage: 'signed' } }, { settings: defaultAutomationSettings() }), true);
  assert.equal(brief.clientNeedsBrief({ ...lead, delivery: { stage: 'iterating' } }, { settings: defaultAutomationSettings() }), true);
  assert.equal(brief.clientNeedsBrief(lead, { settings: { ...defaultAutomationSettings(), pilotClientIds: ['syn-lead'] } }), true, 'a pilot');
  assert.equal(brief.clientNeedsBrief({ id: 'syn-lead', meetings: [] }, { settings: { ...defaultAutomationSettings(), pilotClientIds: ['syn-lead'] } }), false, 'a pilot without a meeting');
  assert.equal(brief.clientNeedsBrief(clientRecord(), { settings: defaultAutomationSettings() }), true, 'a plan in force');
});

// ---------------------------------------------------------------- switch and loop step

function settingsWith(briefNode, extra = {}) {
  const settings = defaultAutomationSettings();
  settings.brief = { ...settings.brief, ...briefNode };
  return { ...settings, ...extra };
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(`${full}|${statSync(full).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

test('the switch: off by default; a non-pilot client in auto gets shadow; auto needs pilots and a release pass', () => {
  const defaults = defaultAutomationSettings();
  assert.deepEqual(defaults.brief, { enabled: false, mode: 'shadow' });
  const client = clientRecord();
  assert.equal(spineModeForClient('brief', client, { settings: defaults }), 'off');
  assert.equal(spineModeForClient('brief', client, { settings: settingsWith({ enabled: true }) }), 'shadow');
  assert.equal(spineModeForClient('brief', client, { settings: settingsWith({ enabled: true, mode: 'auto' }) }), 'shadow', 'no pilots: shadow');
  assert.equal(spineModeForClient('brief', client, { settings: settingsWith({ enabled: true, mode: 'auto' }, { pilotClientIds: ['someone-else'] }) }), 'shadow', 'not a pilot: shadow');
  assert.equal(spineModeForClient('brief', client, { settings: settingsWith({ enabled: true, mode: 'auto' }, { pilotClientIds: [client.id] }) }), 'auto');
  assert.equal(brief.briefModeForClient(client, { settings: settingsWith({ enabled: true, mode: 'auto' }, { pilotClientIds: [client.id] }) }), 'auto');

  const noPilots = validateAutomationSettings({ brief: { enabled: true, mode: 'auto' } });
  assert.equal(noPilots.ok, false);
  assert.ok(noPilots.errors.some((error) => error.path === 'brief.mode'));
  const noRelease = validateAutomationSettings({ pilotClientIds: [client.id], brief: { enabled: true, mode: 'auto' } });
  assert.equal(noRelease.ok, false);
  assert.ok(noRelease.errors.some((error) => error.path === 'brief'), 'auto needs a recorded release pass');
  const released = validateAutomationSettings({ pilotClientIds: [client.id], brief: { enabled: true, mode: 'auto' } }, { current: { releases: { brief: { passedAt: '2026-11-01T00:00:00.000Z', suite: 'release-suite' } } } });
  assert.equal(released.ok, true, JSON.stringify(released.errors));
  assert.equal(validateAutomationSettings({ brief: { enabled: true, mode: 'shadow' } }).ok, true);
  assert.equal(validateAutomationSettings({ brief: { enabled: 'yes' } }).ok, false);
  assert.equal(validateAutomationSettings({ brief: { mode: 'approve-later' } }).ok, false);
});

test('loop step: nothing runs or is written while the switch or the loop is off', async () => {
  const dir = freshDir();
  const client = clientRecord();
  const llm = stubLlm();
  brief.resetBriefTickForTests();
  const before = filesUnder(dir);
  for (const [mode, settings] of [['shadow', defaultAutomationSettings()], ['off', settingsWith({ enabled: true })], [undefined, settingsWith({ enabled: true })]]) {
    const result = await brief.runBriefRebuildStep({ now: Date.now(), mode, settings, dataDir: dir, llm, briefDeps: depsFor() }, client);
    assert.equal(result.wrote, false);
  }
  assert.deepEqual(filesUnder(dir), before);
  assert.equal(llm.state.calls, 0);
});

test('loop step: debounce of 10 minutes, rebuild once, an unchanged tick touches nothing, a new input waits again', async () => {
  const dir = freshDir();
  const client = clientRecord();
  const llm = stubLlm();
  const settings = settingsWith({ enabled: true });
  const ctx = (now, extra = {}) => ({ now, mode: 'shadow', settings, dataDir: dir, llm, briefDeps: depsFor(), tickId: `t-${now}`, ...extra });
  brief.resetBriefTickForTests();
  const t0 = Date.parse('2026-11-01T10:00:00.000Z');
  assert.equal((await brief.runBriefRebuildStep(ctx(t0), client)).status, 'debounce');
  assert.equal((await brief.runBriefRebuildStep(ctx(t0 + 9 * 60_000), client)).status, 'debounce');
  assert.equal(llm.state.calls, 0);
  const built = await brief.runBriefRebuildStep(ctx(t0 + 10 * 60_000), client);
  assert.equal(built.status, 'built');
  assert.ok(llm.state.calls > 0);
  const snapshot = filesUnder(dir);
  const calls = llm.state.calls;
  assert.equal((await brief.runBriefRebuildStep(ctx(t0 + 11 * 60_000), client)).status, 'unchanged');
  assert.deepEqual(filesUnder(dir), snapshot, 'an unchanged tick writes nothing');
  assert.equal(llm.state.calls, calls);
  const changed = clientRecord({ delivery: { stage: 'development' } });
  assert.equal((await brief.runBriefRebuildStep(ctx(t0 + 12 * 60_000), changed)).status, 'debounce');
  assert.equal((await brief.runBriefRebuildStep(ctx(t0 + 23 * 60_000), changed)).status, 'built');
  assert.equal(store.readLatestBrief(client.id, { dataDir: dir }).delivery.stage, 'development');
});

test('loop step: at most two starts per tick, the lease keeps a second runner out, a partial rebuild resumes at once', async () => {
  const dir = freshDir();
  const settings = settingsWith({ enabled: true });
  const t0 = Date.parse('2026-11-02T10:00:00.000Z');
  const clients = ['syn-tick-a', 'syn-tick-b', 'syn-tick-c'].map((id) => clientRecord({ id }));
  brief.resetBriefTickForTests();
  for (const client of clients) await brief.runBriefRebuildStep({ now: t0, mode: 'shadow', settings, dataDir: dir, llm: stubLlm(), briefDeps: depsFor(), tickId: 'tick-0' }, client);
  const tick = { now: t0 + 11 * 60_000, mode: 'shadow', settings, dataDir: dir, llm: stubLlm(), briefDeps: depsFor(), tickId: 'tick-1' };
  const results = [];
  for (const client of clients) results.push((await brief.runBriefRebuildStep(tick, client)).status);
  assert.deepEqual(results, ['built', 'built', 'deferred']);
  const next = await brief.runBriefRebuildStep({ ...tick, tickId: 'tick-2' }, clients[2]);
  assert.equal(next.status, 'built');

  // A lease held elsewhere (another hub process) skips the client.
  const { acquireLease } = await import('../data/email-store.js');
  const held = await acquireLease('brief:syn-tick-d', 60_000);
  const leased = clientRecord({ id: 'syn-tick-d' });
  await brief.runBriefRebuildStep({ ...tick, now: t0, tickId: 'tick-3' }, leased);
  assert.equal((await brief.runBriefRebuildStep({ ...tick, tickId: 'tick-4' }, leased)).status, 'leased');
  await held.release();
  assert.equal((await brief.runBriefRebuildStep({ ...tick, tickId: 'tick-5' }, leased)).status, 'built');

  // A rebuild that ran out of time resumes on the next tick without a new debounce wait.
  const cutClient = clientRecord({ id: 'syn-tick-f' });
  const cut = await brief.rebuildBrief(cutClient, { llm: stubLlm(), dataDir: dir, deps: depsFor(), deadline: 0 });
  assert.equal(cut.status, 'partial');
  assert.equal(cut.retryAt, '', 'out of time: resume at once');
  const resumedCut = await brief.runBriefRebuildStep({ ...tick, now: tick.now + 1000, tickId: 'tick-9' }, cutClient);
  assert.equal(resumedCut.status, 'built');

  // A rebuild whose provider call failed waits out the chunk's backoff, then resumes without a new debounce.
  const flakyClient = clientRecord({ id: 'syn-tick-e' });
  await brief.runBriefRebuildStep({ ...tick, now: t0, tickId: 'tick-6' }, flakyClient);
  const partial = await brief.runBriefRebuildStep({ ...tick, llm: stubLlm({ failAfter: 1 }), tickId: 'tick-7' }, flakyClient);
  assert.equal(partial.status, 'partial');
  const snapshot = filesUnder(dir);
  const early = stubLlm();
  assert.equal((await brief.runBriefRebuildStep({ ...tick, llm: early, now: tick.now + 5 * 60_000, tickId: 'tick-8' }, flakyClient)).status, 'backoff');
  assert.equal(early.state.calls, 0);
  assert.deepEqual(filesUnder(dir), snapshot, 'a tick in backoff writes nothing');
  const resumed = await brief.runBriefRebuildStep({ ...tick, now: tick.now + 15 * 60_000, tickId: 'tick-10' }, flakyClient);
  assert.equal(resumed.status, 'built');
});

/** One transcript chunk that the model can never answer, every other chunk answered; ticks every five minutes for two days. */
async function stuckChunkTicks({ code, clientId }) {
  const dir = freshDir();
  const settings = settingsWith({ enabled: true });
  const client = clientRecord({ id: clientId, meetings: [...clientRecord().meetings, { meetingId: 'syn-m-stuck', purpose: 'demo', startedAt: '2026-10-15T10:00:00.000Z', hasTranscript: true }] });
  const transcripts = { ...TRANSCRIPTS, 'syn-m-stuck': meetingText('Demo', 12, ['Kunde: STUCK denne delen får aldri et svar.']) };
  const healthy = stubLlm();
  let stuckCalls = 0;
  let otherCalls = 0;
  const llm = {
    json: async (request) => {
      if (request.user.includes('STUCK')) {
        stuckCalls += 1;
        throw Object.assign(new Error(`stub ${code}`), { code, allRows: [{ usd: 0.002 }] });
      }
      otherCalls += 1;
      return healthy.json(request);
    },
  };
  brief.resetBriefTickForTests();
  const t0 = Date.parse('2026-11-03T00:00:00.000Z');
  const statuses = [];
  const callsByTick = [];
  for (let i = 0; i < 2 * 24 * 12; i += 1) {
    const result = await brief.runBriefRebuildStep({ now: t0 + i * 5 * 60_000, mode: 'shadow', settings, dataDir: dir, llm, briefDeps: depsFor({ transcripts }), tickId: `${clientId}-${i}` }, client);
    statuses.push(result.status);
    callsByTick.push(stuckCalls);
  }
  return { dir, client, statuses, stuckCalls, otherCalls, callsByTick };
}

test('loop step: a chunk the model always fails on costs a bounded number of calls and the brief is built with a gap', async () => {
  // A final answer (output limit after the core's retry): asked once, cached as a gap.
  const final = await stuckChunkTicks({ code: 'max_tokens', clientId: 'syn-stuck-final' });
  assert.equal(final.stuckCalls, 1, 'one paid call for the stuck chunk in two days');
  assert.ok(final.statuses.includes('built'));
  assert.equal(final.statuses.at(-1), 'unchanged');
  const built = store.readLatestBrief('syn-stuck-final', { dataDir: final.dir });
  assert.equal(built.stats.chunks.gaps, 1, 'the brief shows the gap');
  assert.match(renderBriefMarkdown(built), /\*\*Hull:\*\* 1 del av møtene/, 'and so does the markdown');
  assert.ok(built.directives.some((row) => row.target.area === 'chrome.header'), 'the rest of the meeting is in the brief');

  // Provider errors: backoff, at most six calls, then a gap; the call count stops growing.
  const transient = await stuckChunkTicks({ code: 'provider_error', clientId: 'syn-stuck-transient' });
  assert.equal(transient.stuckCalls, 6, `${transient.stuckCalls} calls`);
  assert.equal(transient.callsByTick.at(-1), transient.callsByTick[transient.callsByTick.length - 200], 'no new call in the last 16 hours');
  assert.ok(transient.statuses.filter((status) => status === 'backoff').length > 50, 'most ticks wait');
  assert.equal(transient.statuses.at(-1), 'unchanged');
  assert.equal(store.readLatestBrief('syn-stuck-transient', { dataDir: transient.dir }).stats.chunks.gaps, 1);
  assert.deepEqual(store.readBriefState('syn-stuck-transient', { dataDir: transient.dir }).chunkFailures, {});
});

test('tickSteps has the loop contract', () => {
  assert.equal(brief.tickSteps.length, 1);
  const [step] = brief.tickSteps;
  assert.equal(step.name, 'brief-rebuild');
  assert.equal(step.scope, 'client');
  assert.equal(typeof step.run, 'function');
  assert.equal(brief.REBUILD_DEBOUNCE_MS, 600_000);
  assert.equal(brief.MAX_STARTS_PER_TICK, 2);
  assert.equal(brief.TICK_WALL_MS, 300_000);
});

test('sources: transcripts come from linked meetings, live placeholders are skipped, the input hash is stable', async () => {
  const client = clientRecord({ meetings: [...clientRecord().meetings, { meetingId: 'live:abc', purpose: 'sales' }, { meetingId: 'syn-m-empty', purpose: 'workshop' }] });
  const first = await gatherBriefSources(client, { deps: depsFor() });
  const second = await gatherBriefSources(client, { deps: depsFor() });
  assert.deepEqual(first.meetings.map((row) => row.meetingId), ['syn-m-sales', 'syn-m-workshop']);
  assert.equal(first.inputHash, second.inputHash);
  const other = await gatherBriefSources(client, { deps: depsFor({ bank: { ...BANK, generalInfo: { ...BANK.generalInfo, companyPhone: '+47 0000 0888' } } }) });
  assert.notEqual(other.inputHash, first.inputHash, 'Kundedata is an input');
  assert.equal(first.cmsSetup, null);
  const withSite = await gatherBriefSources(clientRecord({ hubSite: { id: 'site-1' } }), { deps: { ...depsFor(), sites: () => [{ id: 'site-1', domain: 'Example.com', site_key: 'secret-site-key' }] } });
  assert.equal(withSite.cmsSetup.siteId, 'site-1');
  assert.equal(JSON.stringify(withSite.cmsSetup).includes('secret-site-key'), false, 'no site key in the brief');
  const archive = () => [{ meetingId: 'syn-m-sales', purpose: 'sales', transcript: 'Kunde: Arkivert tekst.' }];
  const withoutStoredSales = { ...TRANSCRIPTS, 'syn-m-sales': undefined };
  const archived = await gatherBriefSources(client, { deps: { ...depsFor({ transcripts: withoutStoredSales }), readArchivedTranscripts: archive } });
  assert.equal(archived.meetings.find((row) => row.meetingId === 'syn-m-sales').transcript, 'Kunde: Arkivert tekst.', 'the archive keeps a meeting whose stored copy is gone');
  const sameText = await gatherBriefSources(client, { deps: { ...depsFor({ transcripts: { ...TRANSCRIPTS, 'syn-m-sales': 'Kunde: Arkivert tekst.' } }), readArchivedTranscripts: archive } });
  assert.equal(sameText.meetings.find((row) => row.meetingId === 'syn-m-sales').transcript, 'Kunde: Arkivert tekst.');
});

test('sources: an archived copy taken while the meeting was still live captions gives way to the final stored copy', async () => {
  // The archive copied the captions at link time; its record keeps neither isLive nor partial.
  const captions = 'Kunde: Dette er direkteteksting fra møtet mens det pågikk.';
  const archivedCaptions = { meetingId: 'syn-m-sales', purpose: 'sales', startedAt: '2026-10-01T10:00:00.000Z', transcript: captions, sha256: sha256(captions) };
  const finalCopy = { meetingId: 'syn-m-sales', transcript: TRANSCRIPTS['syn-m-sales'], isLive: false, partial: false, summaryStatus: 'processed' };
  const deps = {
    ...depsFor(),
    readArchivedTranscripts: () => [archivedCaptions],
    readStoredMeeting: (meetingId) => (meetingId === 'syn-m-sales' ? { ...finalCopy } : TRANSCRIPTS[meetingId] ? { meetingId, transcript: TRANSCRIPTS[meetingId] } : null),
    readTranscriptBySha: (_clientId, sha) => (sha === sha256(captions) ? { ...archivedCaptions, source: 'archive' } : null),
  };
  const sources = await gatherBriefSources(clientRecord(), { deps });
  const sales = sources.meetings.find((row) => row.meetingId === 'syn-m-sales');
  assert.equal(sales.transcript, TRANSCRIPTS['syn-m-sales'], 'the final stored copy, not the archived captions');
  assert.equal(sales.sha256, sha256(TRANSCRIPTS['syn-m-sales']));
  assert.equal(sources.parts.meetings.some((row) => row.sha256 === sha256(captions)), false, 'the captions are not an input');
  assert.equal(await findClientTranscript(clientRecord(), sha256(captions), { deps }), null, 'the archived captions are not served');
  const served = await findClientTranscript(clientRecord(), sha256(TRANSCRIPTS['syn-m-sales']), { deps });
  assert.equal(served?.transcript, TRANSCRIPTS['syn-m-sales']);

  // A rebuild pays only for the final transcript's chunks, never for the captions.
  const llm = stubLlm();
  const prompts = [];
  const watching = { json: async (request) => { prompts.push(String(request.user)); return llm.json(request); } };
  await brief.rebuildBrief(clientRecord({ id: 'syn-captions-1' }), { llm: watching, dataDir: freshDir(), deps });
  assert.ok(prompts.length > 0);
  assert.equal(prompts.some((user) => user.includes('direkteteksting')), false);

  // Once the stored copy is gone, the archived copy is the meeting's transcript again.
  const noStored = { ...deps, readStoredMeeting: (meetingId) => (meetingId === 'syn-m-sales' ? null : deps.readStoredMeeting(meetingId)) };
  const fromArchive = await gatherBriefSources(clientRecord(), { deps: noStored });
  assert.equal(fromArchive.meetings.find((row) => row.meetingId === 'syn-m-sales').transcript, captions);
  assert.equal((await findClientTranscript(clientRecord(), sha256(captions), { deps: noStored }))?.transcript, captions);
});

/** Every file under `dir`, as paths inside it ('/'-separated). */
function relativeFiles(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...relativeFiles(join(dir, entry.name), name));
    else out.push(name);
  }
  return out.sort();
}

test('erase and export cover every file of a client, the chunk cache and the rebuild state included', async () => {
  const dir = freshDir();
  await brief.rebuildBrief(clientRecord(), { llm: stubLlm(), dataDir: dir, deps: depsFor() });
  const folder = store.clientBriefDir('syn-brief-1', { dataDir: dir });
  const onDisk = relativeFiles(folder);
  assert.ok(onDisk.includes('state.json') && onDisk.some((name) => name.startsWith('chunks/')));
  const exported = store.exportClientBriefs('syn-brief-1', { dataDir: dir });
  assert.equal(exported.versions.length, 1);
  assert.ok(exported.extraction);
  assert.ok(exported.state && exported.state.builtInputHash);
  assert.deepEqual(exported.files.map((file) => file.name).sort(), onDisk, 'the export lists every file');
  const dry = store.eraseClientBriefs('syn-brief-1', { dataDir: dir });
  assert.deepEqual([...dry.files].sort(), onDisk);
  assert.ok(existsSync(folder), 'a dry run deletes nothing');
  store.eraseClientBriefs('syn-brief-1', { dataDir: dir, dryRun: false });
  assert.equal(existsSync(folder), false);
  writeFileSync(join(dir, 'marker'), 'x');
});

// ---------------------------------------------------------------- live captions and optional modules

test('sources: live captions are never a transcript, also from the archive; the meeting joins once the final copy arrives', async () => {
  const captions = 'Kunde: Dette er direkteteksting mens møtet fortsatt pågår.';
  const stored = {
    'syn-m-sales': { meetingId: 'syn-m-sales', transcript: captions, isLive: true },
    'syn-m-workshop': { meetingId: 'syn-m-workshop', transcript: 'Kunde: Delvis tekst uten ferdig sammendrag.', partial: true, summaryStatus: '' },
  };
  // The hub's own storedMeetingIsPartial decides (no stand-in for it).
  const deps = { ...depsFor(), readStoredMeeting: (meetingId) => (stored[meetingId] ? { ...stored[meetingId] } : null) };
  const live = await gatherBriefSources(clientRecord(), { deps });
  assert.deepEqual(live.meetings, [], 'live and partial copies are left out');
  const archive = () => [
    { meetingId: 'syn-m-sales', purpose: 'sales', transcript: 'Kunde: Arkivert kopi av direkteteksting.' },
    { meetingId: 'syn-m-flagged', purpose: 'sales', transcript: 'Kunde: En kopi som selv sier at den er delvis.', partial: true },
  ];
  const withArchive = await gatherBriefSources(clientRecord(), { deps: { ...deps, readArchivedTranscripts: archive } });
  assert.deepEqual(withArchive.meetings, [], 'an archived copy of a meeting that is still live, or a copy flagged partial, is left out');
  assert.equal(await findClientTranscript(clientRecord(), sha256(captions), { deps }), null, 'captions are never served');
  assert.equal(await findClientTranscript(clientRecord(), sha256(captions), { deps: { ...deps, readTranscriptBySha: () => ({ meetingId: 'syn-m-sales', transcript: captions }) } }), null, 'not from the archive reader either');

  // A pilot whose only meeting row is captions is not built by the loop.
  const pilots = { ...defaultAutomationSettings(), pilotClientIds: ['syn-pilot-captions'] };
  assert.equal(brief.clientNeedsBrief({ id: 'syn-pilot-captions', meetings: [{ meetingId: 'm-1', hasTranscript: true, partial: true }] }, { settings: pilots }), false);
  assert.equal(brief.clientNeedsBrief({ id: 'syn-pilot-captions', meetings: [{ meetingId: 'm-1', hasTranscript: true, isLive: true }] }, { settings: pilots }), false);
  assert.equal(brief.clientNeedsBrief({ id: 'syn-pilot-captions', meetings: [{ meetingId: 'm-1', hasTranscript: true }] }, { settings: pilots }), true);

  // The final copies arrive: both meetings join and the input hash changes.
  stored['syn-m-sales'] = { meetingId: 'syn-m-sales', transcript: TRANSCRIPTS['syn-m-sales'], isLive: false, summaryStatus: 'processed' };
  stored['syn-m-workshop'] = { meetingId: 'syn-m-workshop', transcript: TRANSCRIPTS['syn-m-workshop'], partial: true, summaryStatus: 'processed' };
  const settled = await gatherBriefSources(clientRecord(), { deps });
  assert.deepEqual(settled.meetings.map((row) => row.meetingId), ['syn-m-sales', 'syn-m-workshop']);
  assert.notEqual(settled.inputHash, live.inputHash);
  const served = await findClientTranscript(clientRecord(), sha256(TRANSCRIPTS['syn-m-sales']), { deps });
  assert.equal(served?.transcript, TRANSCRIPTS['syn-m-sales']);
});

/**
 * Stand-ins with the exact signatures and shapes of optional modules other parts of the hub provide:
 * buildMediaManifest(clientId, { client, dataDir }) → { items: [{ id, source, bucket, name, mime, bytes,
 * sha256, rightsConfirmed, url }] }, signMediaUrl({ assetId, clientId, expiresAt }), and the SEO record's
 * readSeoRecord(clientId) / agreedKeywordsFor(clientIdOrRecord) (approved phrases as strings).
 */
function mediaManifestModule({ items, calls }) {
  return {
    MEDIA_ROUTE_PREFIX: '/api/maker/media/',
    MEDIA_URL_TTL_MS: 24 * 60 * 60 * 1000,
    buildMediaManifest(clientId, { client, dataDir } = {}) {
      calls.push({ clientId, hasClient: Boolean(client), dataDir });
      if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(clientId)) throw Object.assign(new Error('Invalid client id.'), { status: 400 });
      return {
        kind: 'asoldi.media-manifest/1',
        clientId,
        generatedAt: '2026-11-01T00:00:00.000Z',
        expiresAt: '2026-11-02T00:00:00.000Z',
        items: items.map((item) => ({ ...item, url: `/api/maker/media/${item.id}?c=${clientId}&exp=1&sig=${'0'.repeat(64)}` })),
        external: [],
      };
    },
    signMediaUrl({ assetId, clientId, expiresAt }) {
      return `/api/maker/media/${encodeURIComponent(assetId)}?c=${encodeURIComponent(clientId)}&exp=${Math.floor(Number(expiresAt))}&sig=${'1'.repeat(64)}`;
    },
  };
}

function seoRecordModule(records) {
  const readSeoRecord = (salesClientId) => {
    if (typeof salesClientId !== 'string') throw new TypeError('a sales client id');
    return records[salesClientId] ? structuredClone(records[salesClientId]) : null;
  };
  return {
    readSeoRecord,
    agreedKeywordsFor(salesClientIdOrRecord, { status = 'approved' } = {}) {
      const record = salesClientIdOrRecord && typeof salesClientIdOrRecord === 'object' ? salesClientIdOrRecord : readSeoRecord(salesClientIdOrRecord);
      return (record?.agreedKeywords || []).filter((row) => row.status === status).map((row) => row.phrase);
    },
  };
}

const MEDIA_ITEMS = [
  { id: `ma_${'a'.repeat(32)}`, source: 'bank', bucket: 'gallery', name: 'bad.jpg', mime: 'image/jpeg', bytes: 10, sha256: 'b'.repeat(64), rightsConfirmed: true },
  { id: `ma_${'c'.repeat(32)}`, source: 'logo', bucket: 'logo:primary', name: 'logo.png', mime: 'image/png', bytes: 20, sha256: 'd'.repeat(64), rightsConfirmed: null },
  { id: `ma_${'e'.repeat(32)}`, source: 'bank', bucket: 'gallery', name: 'lant.jpg', mime: 'image/jpeg', bytes: 30, sha256: 'f'.repeat(64), rightsConfirmed: false },
];

const SEO_RECORDS = {
  'syn-brief-1': {
    agreedKeywords: [
      { phrase: 'flislegger eksempelby', status: 'approved', source: 'meeting', quoteRef: 'syn-m-sales#1', at: '2026-10-02T10:00:00.000Z', by: 'dev' },
      { phrase: 'nytt bad', status: 'proposed', source: 'maker', at: '2026-10-02T10:00:00.000Z', by: 'maker' },
      { phrase: 'billig bad', status: 'blocked', source: 'developer', at: '2026-10-02T10:00:00.000Z', by: 'dev' },
    ],
  },
};

test('sources: the media manifest and the SEO record are read through their own signatures; media only while the media switch is on', async () => {
  const calls = [];
  let mediaOn = false;
  const modules = {
    '../media-manifest.js': mediaManifestModule({ items: MEDIA_ITEMS, calls }),
    '../privacy-settings.js': { signedMediaEnabled: () => mediaOn },
    '../seo-ops/record.js': seoRecordModule(SEO_RECORDS),
  };
  const { mediaManifest: _media, agreedKeywords: _keywords, ...base } = depsFor();
  const deps = { ...base, modules };

  const off = await gatherBriefSources(clientRecord(), { deps });
  assert.deepEqual(off.media, []);
  assert.equal(calls.length, 0, 'with the media switch off the manifest (which writes its id index) is not built');
  assert.deepEqual(off.seo.agreedKeywords, [
    { keyword: 'flislegger eksempelby', status: 'approved', source: 'meeting' },
    { keyword: 'billig bad', status: 'blocked', source: 'developer' },
  ], 'the approved and blocked rows of the record (as the record\'s Maker view has them), phrase as keyword; no proposals');

  mediaOn = true;
  const on = await gatherBriefSources(clientRecord(), { deps });
  assert.deepEqual(calls.map((call) => [call.clientId, call.hasClient]), [['syn-brief-1', true]], 'called with the client id and the client');
  assert.deepEqual(on.media.map((row) => [row.id, row.fileName, row.bucket, row.url, row.rightsConfirmed]), [
    [MEDIA_ITEMS[0].id, 'bad.jpg', 'gallery', `/api/maker/media/${MEDIA_ITEMS[0].id}`, true],
    [MEDIA_ITEMS[1].id, 'logo.png', 'logo:primary', `/api/maker/media/${MEDIA_ITEMS[1].id}`, undefined],
    [MEDIA_ITEMS[2].id, 'lant.jpg', 'gallery', `/api/maker/media/${MEDIA_ITEMS[2].id}`, false],
  ], 'the manifest name is the file name and URL signatures are left out');
  assert.equal(Object.hasOwn(on.media[1], 'rightsConfirmed'), false, 'an unanswered rights question stays unanswered, not "declined"');
  assert.notEqual(on.inputHash, off.inputHash);

  // A build whose SEO module has only agreedKeywordsFor: the approved phrases.
  const phrasesOnly = { ...modules, '../seo-ops/record.js': { agreedKeywordsFor: seoRecordModule(SEO_RECORDS).agreedKeywordsFor } };
  const approved = await gatherBriefSources(clientRecord(), { deps: { ...deps, modules: phrasesOnly } });
  assert.deepEqual(approved.seo.agreedKeywords, [{ keyword: 'flislegger eksempelby', status: 'approved', source: 'seo-record' }]);
  // A client without a record keeps the sales card's keywords, approved and blocked ones only.
  const card = await gatherBriefSources(clientRecord({ id: 'syn-no-record', seoRecord: { agreedKeywords: [{ phrase: 'baderom', status: 'approved', source: 'card' }, { phrase: 'dusj', status: 'proposed', source: 'card' }] } }), { deps });
  assert.deepEqual(card.seo.agreedKeywords, [{ keyword: 'baderom', status: 'approved', source: 'card' }]);

  // The loop keeps one manifest build per client for a while instead of hashing every file each tick.
  calls.length = 0;
  await gatherBriefSources(clientRecord(), { deps: { ...deps, mediaCacheMs: 60_000 } });
  await gatherBriefSources(clientRecord(), { deps: { ...deps, mediaCacheMs: 60_000 } });
  assert.equal(calls.length, 1);

  // The brief shows them.
  const dir = freshDir();
  await brief.rebuildBrief(clientRecord(), { llm: stubLlm(), dataDir: dir, deps });
  const stored = store.readLatestBrief('syn-brief-1', { dataDir: dir });
  assert.deepEqual(stored.facts.media.manifest.map((row) => [row.fileName, row.rightsConfirmed]), [['bad.jpg', true], ['logo.png', undefined], ['lant.jpg', false]]);
  assert.equal(stored.facts.logo.status, 'present');
  assert.deepEqual(stored.seo.agreedKeywords.map((row) => row.keyword), ['flislegger eksempelby', 'billig bad']);
  assert.equal(validateDeliveryBrief(stored).valid, true);
});

test('sources: credentials are left out of the CMS setup at every depth, inside lists too', async () => {
  const setup = {
    siteId: 'site-1',
    users: [{ email: 'post@example.com', password: 'pw-value', role: 'owner' }],
    integrations: [{ name: 'shop', apiToken: 'token-value', options: [{ secretKey: 'key-value', label: 'synlig' }] }],
    siteKey: 'site-key-value',
  };
  const sources = await gatherBriefSources(clientRecord(), { deps: { ...depsFor(), cmsSetup: () => setup } });
  const text = JSON.stringify(sources.cmsSetup);
  for (const value of ['pw-value', 'token-value', 'key-value', 'site-key-value']) assert.equal(text.includes(value), false, value);
  assert.equal(sources.cmsSetup.users[0].email, 'post@example.com');
  assert.equal(sources.cmsSetup.integrations[0].options[0].label, 'synlig');
});

test('sources: only credential names are left out of the CMS setup; keywords, a feature\'s key and other ids stay', async () => {
  const setup = {
    siteId: 'site-1',
    keywords: ['flislegger', 'bad'],
    primaryKey: 'row-1',
    features: [{ key: 'shop', enabled: true }, { key: 'blog', enabled: false, settings: { key: 'blog.posts', apiKey: 'api-key-value' } }],
    apiKey: 'api-key-value',
    'x-api-key': 'header-key-value',
    stripe_secret_key: 'stripe-value',
    privateKey: 'private-value',
    token: 'token-value',
    smtp: { host: 'smtp.example.com', user: 'post@example.com', pass: 'smtp-pass-value' },
    credentials: { anything: 'credential-value' },
  };
  const sources = await gatherBriefSources(clientRecord(), { deps: { ...depsFor(), cmsSetup: () => setup } });
  const kept = sources.cmsSetup;
  const text = JSON.stringify(kept);
  for (const value of ['api-key-value', 'header-key-value', 'stripe-value', 'private-value', 'token-value', 'smtp-pass-value', 'credential-value']) assert.equal(text.includes(value), false, value);
  assert.deepEqual(kept.keywords, ['flislegger', 'bad']);
  assert.equal(kept.primaryKey, 'row-1');
  assert.deepEqual(kept.features, [{ key: 'shop', enabled: true }, { key: 'blog', enabled: false, settings: { key: 'blog.posts' } }]);
  assert.deepEqual(kept.smtp, { host: 'smtp.example.com', user: 'post@example.com' });
});

// ---------------------------------------------------------------- privacy registry, erase and concurrent writes

/**
 * A personal-data registry that behaves like the hub's: registerStore adds or silently replaces a row,
 * its own rows are there from the start (or, with ownRowsAtLoad false, added later and only for ids
 * not registered yet), and an erase sums each store's { action, records, files } (an unknown action
 * counts as 'none').
 */
function registryContract({ dataDir, ownRowsAtLoad = true }) {
  const stores = new Map();
  let ownRowsLoaded = false;
  const ownRow = {
    id: 'delivery-briefs',
    label: 'Leveransebrief',
    dir: 'delivery-briefs',
    clientKey: 'path',
    retention: { rule: 'brief' },
    personalData: 'Registry text for the brief',
    purpose: 'Registry purpose for the brief',
    legalBasis: 'Contract',
    processors: ['Anthropic'],
    order: 30,
    ownRow: true,
    writers: ['lib/delivery-brief/store.js:path', 'lib/registry-only.js:path'],
    export: () => ({ files: [] }),
    erase: () => ({ action: 'none', records: 0, files: [] }),
  };
  const loadOwnRows = () => {
    if (ownRowsLoaded) return;
    ownRowsLoaded = true;
    if (!stores.has(ownRow.id)) stores.set(ownRow.id, ownRow);
  };
  if (ownRowsAtLoad) loadOwnRows();
  const registry = {
    ownRow,
    registerStore(input) {
      stores.set(input.id, { ...input });
      return input;
    },
    getStore: (id) => stores.get(id) || null,
    async loadStoreModules() {
      loadOwnRows();
      return [...stores.values()];
    },
    async eraseClient(clientId, { dryRun = true } = {}) {
      await registry.loadStoreModules();
      const results = [];
      for (const entry of stores.values()) {
        let result;
        try {
          result = (await entry.erase(clientId, { dataDir, dryRun })) || { action: 'none' };
        } catch (error) {
          result = { action: 'none', error: error.message };
        }
        results.push({
          id: entry.id,
          action: ['delete', 'redact', 'hold', 'retain', 'none'].includes(result.action) ? result.action : 'none',
          records: Number(result.records) || 0,
          files: Array.isArray(result.files) ? result.files : [],
          ...(result.error ? { error: result.error } : {}),
        });
      }
      return { stores: results, audited: results.filter((row) => row.action === 'delete' || row.action === 'redact').map((row) => row.id) };
    },
  };
  return registry;
}

test('privacy registry: the registry\'s own row keeps its description and gets the brief\'s export and erase; every file is exported and an erase reports what it deleted', async () => {
  // A registry without a row of its own for the brief gets the brief's whole row, with the same description.
  store.resetBriefStoreRegistrationForTests();
  const bare = registryContract({ dataDir: freshDir(), ownRowsAtLoad: false });
  assert.equal(await store.registerBriefStore({ registry: bare }), true);
  await bare.loadStoreModules();
  const full = bare.getStore('delivery-briefs');
  assert.equal(full.ownRow, undefined, 'the registry adds its row later only for ids not registered yet');
  assert.deepEqual(
    [full.label, full.retention, full.clientKey, full.legalBasis, full.processors],
    ['Leveransebrief', { rule: 'brief' }, 'path', 'Contract', ['Anthropic']],
    'the same description and retention rule as the registry\'s own row',
  );
  assert.deepEqual(full.writers, [...store.BRIEF_STORE_WRITERS], 'the brief\'s writers are declared');

  // The hub's registry lists its own row from the start: the description stays, the handlers are the brief's.
  store.resetBriefStoreRegistrationForTests();
  const dir = freshDir();
  const registry = registryContract({ dataDir: dir });
  assert.equal(await store.registerBriefStore({ registry }), true);
  const row = registry.getStore('delivery-briefs');
  assert.equal(row.ownRow, true);
  assert.deepEqual([row.label, row.purpose, row.personalData, row.retention, row.order], ['Leveransebrief', registry.ownRow.purpose, registry.ownRow.personalData, { rule: 'brief' }, 30], 'the registry\'s description is kept');
  assert.notEqual(row.erase, registry.ownRow.erase, 'the brief\'s erase (under the brief lease) is used');
  assert.deepEqual(
    [...row.writers].sort(),
    [...new Set([...registry.ownRow.writers, ...store.BRIEF_STORE_WRITERS])].sort(),
    'the registry row\'s writers are kept together with the brief\'s own',
  );

  await brief.rebuildBrief(clientRecord(), { llm: stubLlm(), dataDir: dir, deps: depsFor() });
  const folder = store.clientBriefDir('syn-brief-1', { dataDir: dir });
  const onDisk = relativeFiles(folder).map((name) => `delivery-briefs/syn-brief-1/${name}`);
  const exported = await row.export('syn-brief-1', { dataDir: dir });
  assert.deepEqual(exported.files.map((file) => file.path).sort(), onDisk, 'every file, paths inside the data dir');
  assert.ok(exported.files.find((file) => file.path.endsWith('/latest.json')).content.hash, 'JSON files inline');
  assert.ok(exported.files.some((file) => file.path.includes('/chunks/')) && exported.files.some((file) => file.path.endsWith('/state.json')));

  const plan = await registry.eraseClient('syn-brief-1', { dryRun: true });
  assert.deepEqual(plan.stores.map((entry) => [entry.id, entry.action, entry.files.length]), [['delivery-briefs', 'delete', onDisk.length]]);
  assert.ok(existsSync(folder), 'a plan deletes nothing');
  const done = await registry.eraseClient('syn-brief-1', { dryRun: false });
  assert.deepEqual(done.audited, ['delivery-briefs'], 'the erase reports the store as deleted');
  assert.equal(existsSync(folder), false);
  assert.equal((await registry.eraseClient('syn-brief-1', { dryRun: false })).stores[0].action, 'none');
  store.resetBriefStoreRegistrationForTests();
});

// The personal-data writer scan's naming: '<file>:<first argument>' of each JSON write helper call,
// comments blanked, whitespace in the argument collapsed. Every such target of the brief must be among
// the store's declared writers, so a privacy registry that checks its writers knows them all.
const WRITER_CALL = /\b(writeDataJson|writeHotJson|updateJsonLocked|writeJsonAtomic|writeTextAtomic|createJsonOnce)\s*\(/g;
const BACKSLASH = String.fromCharCode(92);

function firstArgument(source, open) {
  let depth = 0;
  let quote = '';
  for (let i = open + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === BACKSLASH) i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return source.slice(open + 1, i).trim();
      depth -= 1;
    } else if (ch === ',' && depth === 0) return source.slice(open + 1, i).trim();
  }
  return '';
}

function withoutComments(source) {
  const out = source.split('');
  let state = '';
  for (let i = 0; i < out.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'line') {
      if (ch === '\n') state = '';
      else out[i] = ' ';
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        state = '';
      } else if (ch !== '\n') out[i] = ' ';
    } else if (state) {
      if (ch === BACKSLASH) i += 1;
      else if (ch === state) state = '';
    } else if (ch === '/' && next === '/') {
      state = 'line';
      out[i] = ' ';
    } else if (ch === '/' && next === '*') {
      state = 'block';
      out[i] = ' ';
    } else if (ch === '"' || ch === "'" || ch === '`') state = ch;
  }
  return out.join('');
}

function briefWriterTargets() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    ...readdirSync(join(root, 'lib', 'delivery-brief')).filter((name) => name.endsWith('.js')).map((name) => join(root, 'lib', 'delivery-brief', name)),
    join(root, 'lib', 'routes', 'brief-routes.js'),
  ];
  const keys = new Set();
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    const source = withoutComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(WRITER_CALL)) {
      if (/function\s+$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
      const arg = firstArgument(source, match.index + match[0].length - 1).replace(/\s+/g, ' ');
      if (arg) keys.add(`${rel}:${arg}`);
    }
  }
  return keys;
}

test('privacy registry: every file the brief writes through the JSON write helpers is a declared writer of its store', () => {
  const found = [...briefWriterTargets()].sort();
  assert.ok(found.length >= 5, `expected the brief's writers, found ${found.length}`);
  assert.deepEqual([...store.BRIEF_STORE_WRITERS].sort(), found, 'declare new writers in BRIEF_STORE_WRITERS (and in the registry\'s delivery-briefs row)');
  assert.deepEqual([...store.briefStoreDescriptor().writers].sort(), found);
});

/** A promise and the function that resolves it. */
function signal() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('privacy erase during a running rebuild: the brief is deleted, and the rebuild stops without writing it again', async () => {
  const dir = freshDir();
  const client = clientRecord({ id: 'syn-erase-1' });
  await brief.rebuildBrief(client, { llm: stubLlm(), dataDir: dir, deps: depsFor() });
  const folder = store.clientBriefDir('syn-erase-1', { dataDir: dir });
  const descriptor = store.briefStoreDescriptor({ waitMs: 300 });
  // A changed transcript makes the rebuild ask the model; the call waits until the erase has answered.
  const changed = depsFor({ transcripts: { ...TRANSCRIPTS, 'syn-m-workshop': `${TRANSCRIPTS['syn-m-workshop']}\nKunde: En ny linje helt til slutt.` } });
  const inCall = signal();
  const gate = signal();
  const inner = stubLlm();
  const slow = { json: async (request) => { inCall.resolve(); await gate.promise; return inner.json(request); } };
  const running = brief.rebuildBrief(client, { llm: slow, dataDir: dir, deps: changed });
  await inCall.promise;
  const erased = await descriptor.erase('syn-erase-1', { dataDir: dir, dryRun: false });
  assert.equal(erased.action, 'delete', 'the erase does not wait for the rebuild to finish');
  assert.equal(erased.error, undefined);
  assert.ok(erased.files.some((path) => path.endsWith('/latest.json')));
  assert.equal(existsSync(folder), false);
  assert.equal(store.briefErased('syn-erase-1', { dataDir: dir }), true);
  gate.resolve();
  await assert.rejects(running, (error) => error.code === 'brief-erased');
  assert.equal(inner.state.calls, 1, 'the rebuild asks nothing more after the erase');
  assert.equal(existsSync(folder), false, 'the rebuild wrote nothing after the erase');
  const { acquireLease } = await import('../data/email-store.js');
  const lease = await acquireLease('brief:syn-erase-1', 1000);
  assert.ok(lease, 'the rebuild released its lease');
  await lease.release();
});

test('after a privacy erase no review, re-assembly, rebuild or loop step writes the client\'s brief again', async () => {
  const dir = freshDir();
  const client = clientRecord({ id: 'syn-erase-2' });
  await brief.rebuildBrief(client, { llm: stubLlm(), dataDir: dir, deps: depsFor() });
  const directiveId = store.readLatestBrief('syn-erase-2', { dataDir: dir }).directives[0].id;
  const folder = store.clientBriefDir('syn-erase-2', { dataDir: dir });

  // A review that is still assembling when the erase runs: its write is refused afterwards.
  const inSources = signal();
  const gate = signal();
  const slowDeps = { ...depsFor(), sites: async () => { inSources.resolve(); await gate.promise; return []; } };
  const review = brief.reviewBriefFact(client, 'positioning.toneOfVoice', { status: 'accepted', value: 'Rolig', by: 'dev' }, { dataDir: dir, deps: slowDeps });
  await inSources.promise;
  assert.equal((await store.briefStoreDescriptor({ waitMs: 0 }).erase('syn-erase-2', { dataDir: dir, dryRun: false })).action, 'delete');
  gate.resolve();
  await assert.rejects(review, (error) => error.code === 'brief-erased');
  assert.equal(existsSync(folder), false, 'the review did not create the folder again');

  const llm = stubLlm();
  const refused = (error) => error.code === 'brief-erased';
  assert.throws(() => store.reviewFact('syn-erase-2', 'contact.phone', { status: 'accepted' }, { dataDir: dir }), refused);
  assert.throws(() => store.setDirectiveStatus('syn-erase-2', directiveId, { status: 'accepted' }, { dataDir: dir }), refused);
  assert.throws(() => store.updateBriefState('syn-erase-2', { pendingHash: 'x' }, { dataDir: dir }), refused);
  assert.throws(() => store.writeExtraction('syn-erase-2', { items: [] }, { dataDir: dir }), refused);
  assert.throws(() => store.saveBrief('syn-erase-2', { facts: {} }, { dataDir: dir }), refused);
  await assert.rejects(brief.reviewBriefFact(client, 'contact.phone', { status: 'accepted' }, { dataDir: dir, deps: depsFor() }), refused);
  await assert.rejects(brief.reassembleBrief(client, { dataDir: dir, deps: depsFor() }), refused);
  await assert.rejects(brief.rebuildBrief(client, { llm, dataDir: dir, deps: depsFor() }), refused);
  brief.resetBriefTickForTests();
  const ctx = { now: Date.parse('2026-11-01T10:00:00.000Z'), mode: 'shadow', settings: settingsWith({ enabled: true }), dataDir: dir, llm, briefDeps: depsFor(), tickId: 't-erased' };
  assert.deepEqual(await brief.runBriefRebuildStep(ctx, client), { wrote: false, status: 'erased' });
  assert.equal(llm.state.calls, 0);
  assert.equal(existsSync(folder), false, 'nothing wrote the folder again');
});

test('a real erase of a client without a brief still marks it, so a loop tick before the client record is gone builds nothing', async () => {
  const dir = freshDir();
  const client = clientRecord({ id: 'syn-erase-3' });
  const descriptor = store.briefStoreDescriptor({ waitMs: 0 });
  assert.deepEqual(await descriptor.erase('syn-erase-3', { dataDir: dir, dryRun: true }), { action: 'none', records: 0, files: [] });
  assert.equal(store.briefErased('syn-erase-3', { dataDir: dir }), false, 'a plan marks nothing');
  assert.deepEqual(await descriptor.erase('syn-erase-3', { dataDir: dir, dryRun: false }), { action: 'none', records: 0, files: [] });
  assert.equal(store.briefErased('syn-erase-3', { dataDir: dir }), true);
  brief.resetBriefTickForTests();
  const llm = stubLlm();
  const ctx = (now) => ({ now, mode: 'shadow', settings: settingsWith({ enabled: true }), dataDir: dir, llm, briefDeps: depsFor(), tickId: `t-${now}` });
  const t0 = Date.parse('2026-11-01T10:00:00.000Z');
  assert.equal((await brief.runBriefRebuildStep(ctx(t0), client)).status, 'erased');
  assert.equal((await brief.runBriefRebuildStep(ctx(t0 + 20 * 60_000), client)).status, 'erased');
  assert.equal(existsSync(store.clientBriefDir('syn-erase-3', { dataDir: dir })), false);
  assert.equal(llm.state.calls, 0);
  // The marker is not a client folder and holds the client id and the time only.
  const markers = readdirSync(join(dir, 'delivery-briefs', store.ERASED_DIR));
  assert.deepEqual(markers, ['syn-erase-3.json']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'delivery-briefs', store.ERASED_DIR, markers[0]), 'utf8'))).sort(), ['clientId', 'erasedAt', 'kind']);
});

test('erase markers older than the keep period are removed when the next erase writes one', async () => {
  const dir = freshDir();
  const now = new Date('2026-11-01T10:00:00.000Z');
  store.markBriefErased('syn-old-1', { dataDir: dir, now });
  store.markBriefErased('syn-new-1', { dataDir: dir, now });
  const markerDir = join(dir, 'delivery-briefs', store.ERASED_DIR);
  const old = new Date(Date.now() - store.ERASED_MARKER_KEEP_MS - 60_000);
  utimesSync(join(markerDir, 'syn-old-1.json'), old, old);
  store.markBriefErased('syn-next-1', { dataDir: dir, now: new Date() });
  assert.deepEqual(readdirSync(markerDir).sort(), ['syn-new-1.json', 'syn-next-1.json']);
});

test('a privacy erase that waits for a held brief lease finishes in a process with nothing else running', async () => {
  // A child process holds the lease brief:<id> itself (as a rebuild elsewhere would) and erases with a
  // short wait. The wait timer must keep the process alive, or it exits mid-erase.
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-brief-erase-child-'));
  try {
    const folder = join(dir, 'delivery-briefs', 'syn-held-1');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'latest.json'), '{"version":1}\n');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const script = [
      `const { acquireLease } = await import(${JSON.stringify(pathToFileURL(join(root, 'data', 'email-store.js')).href)});`,
      `const store = await import(${JSON.stringify(pathToFileURL(join(root, 'lib', 'delivery-brief', 'store.js')).href)});`,
      "const held = await acquireLease('brief:syn-held-1', 60000);",
      "if (!held) throw new Error('no lease');",
      `const result = await store.briefStoreDescriptor({ waitMs: 600 }).erase('syn-held-1', { dataDir: ${JSON.stringify(dir)}, dryRun: false });`,
      "process.stdout.write(JSON.stringify({ action: result.action, files: result.files.length }));",
    ].join('\n');
    const env = { ...process.env, APP_DATA_DIR: dir };
    delete env.DATA_DIR;
    const outcome = await new Promise((done) => {
      execFile(process.execPath, ['--input-type=module', '-e', script], { env, cwd: dir, timeout: 60_000 }, (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr }));
    });
    assert.equal(outcome.code, 0, `the erase finished (stderr: ${String(outcome.stderr).slice(0, 300)})`);
    assert.deepEqual(JSON.parse(outcome.stdout), { action: 'delete', files: 1 });
    assert.equal(existsSync(folder), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a review saved while a rebuild runs is in the saved brief: the save assembles with the newest reviews', async () => {
  const dir = freshDir();
  const client = clientRecord({ id: 'syn-race-1' });
  const deps = depsFor();
  await brief.rebuildBrief(client, { llm: stubLlm(), dataDir: dir, deps });
  // A changed stage: the next rebuild uses only cached chunks, so its lease renewals are the one before
  // the merge and the one between assembling and saving. The review lands in the second.
  const moved = clientRecord({ id: 'syn-race-1', delivery: { stage: 'development' } });
  let renewals = 0;
  const lease = {
    async renew() {
      renewals += 1;
      if (renewals === 2) {
        await brief.reviewBriefFact(client, 'positioning.toneOfVoice', { status: 'accepted', value: 'Rolig og saklig', by: 'dev' }, { dataDir: dir, deps });
      }
      return true;
    },
    async release() {
      return true;
    },
  };
  const llm = stubLlm();
  const result = await brief.rebuildBrief(moved, { llm, dataDir: dir, deps, lease });
  assert.equal(result.status, 'built');
  assert.equal(llm.state.calls, 0);
  assert.equal(renewals, 2);
  const latest = store.readLatestBrief('syn-race-1', { dataDir: dir });
  assert.equal(latest.delivery.stage, 'development', 'the rebuild\'s input');
  assert.equal(latest.facts.positioning.toneOfVoice, 'Rolig og saklig', 'and the review saved during it');
  assert.equal(latest.inputs.reviewsRevision, 1);
});

test('a complete rebuild removes cached answers no current transcript uses', async () => {
  const dir = freshDir();
  const client = clientRecord({ id: 'syn-prune-1' });
  await brief.rebuildBrief(client, { llm: stubLlm(), dataDir: dir, deps: depsFor() });
  const chunkDir = store.chunkCacheDir('syn-prune-1', { dataDir: dir });
  const before = readdirSync(chunkDir).sort();
  const edited = depsFor({ transcripts: { ...TRANSCRIPTS, 'syn-m-workshop': meetingText('Endret', 60, ['Kunde: Telefonnummeret på siden skal stå helt øverst i menyen.']) } });
  const result = await brief.rebuildBrief(client, { llm: stubLlm(), dataDir: dir, deps: edited });
  assert.equal(result.status, 'built');
  const sources = await gatherBriefSources(client, { deps: edited });
  const expected = sources.meetings.flatMap((meeting) => {
    const prompt = promptFor(meeting.purpose, { featureKeys: sources.featureKeys });
    return chunkTranscript(meeting.transcript).map((chunk) => `${chunk.sha}-${prompt.promptHash.slice(0, 16)}.json`);
  }).sort();
  assert.deepEqual(readdirSync(chunkDir).sort(), expected, 'only the chunks of the current transcripts');
  assert.ok(before.some((name) => !expected.includes(name)), 'the old workshop chunks are gone');
});
