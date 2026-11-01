// Keyword consumers on the SEO record: phrasesFromKeywordPlan, buildMapsKeywords and
// analyticsGoalsFromBank read approved agreed keywords first, then page-map primaries, then the
// legacy bank fields, and drop blocked phrases and prescription-only substances; own-name phrases are
// dropped from the page map and the plan, never from the approved keywords, so the consumers track
// exactly what the contract line lists. Without a record that guides them their output equals the
// base release's (compared with the base commit's own modules when git and the ref are available:
// SEO_BASE_REF, default 859429c). Every business here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-consumers-'));
process.env.APP_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([{ id: 'sc-cons-1', businessName: 'Nordlys Sushi AS', product: 'asoldi' }]));

const root = fileURLToPath(new URL('..', import.meta.url));
const { phrasesFromKeywordPlan, analyticsGoalsFromBank } = await import('../lib/analytics-insights.js');
const { buildMapsKeywords, buildMapsSubject } = await import('../lib/maps-ranking.js');
const record = await import('../lib/seo-ops/record.js');
const { agreedKeywordsContractText, approvedAgreedPhrases } = await import('../lib/seo-ops/contract-text.js');

const BASE_REF = process.env.SEO_BASE_REF || '859429c';

/** The base commit's analytics-insights.js and maps-ranking.js (with their imports), or null. */
function loadBase() {
  try {
    execFileSync('git', ['cat-file', '-e', `${BASE_REF}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-seo-consumers-base-'));
  for (const file of ['lib/analytics-insights.js', 'lib/maps-ranking.js', 'lib/dataforseo-maps.js', 'data/storage-path.js', 'data/atomic-json.js']) {
    const body = execFileSync('git', ['show', `${BASE_REF}:${file}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), body);
  }
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  return { dir };
}

const base = loadBase();
const baseInsights = base ? await import(pathToFileURL(join(base.dir, 'lib', 'analytics-insights.js')).href) : null;
const baseMaps = base ? await import(pathToFileURL(join(base.dir, 'lib', 'maps-ranking.js')).href) : null;
test.after(() => {
  if (base) rmSync(base.dir, { recursive: true, force: true });
});

const PLAN = {
  primary: [{ keyword: 'sushi eksempelby' }, { keyword: 'sushi takeaway eksempelby' }, 'Sushi Eksempelby'],
  local: [{ keyword: 'restaurant sentrum eksempelby' }],
  secondary: [{ keyword: 'bestill sushi' }, { keyword: 'nordlys sushi meny' }, { keyword: 'poke bowl' }],
};

const SUBJECTS = [
  { name: 'Nordlys Sushi', industry: 'restaurant', town: 'Eksempelby', keywords: ['sushi eksempelby', 'restaurant midtbyen', 'takeaway', 'extra'] },
  { name: 'Nordlys Sushi', industry: 'restaurant', town: 'Eksempelby', keywords: 'sushi, takeaway\npoke', keywordPlan: PLAN },
  { name: 'Nordlys Sushi', industry: 'restaurant', town: 'Eksempelby', keywords: [] },
  { name: 'Nordlys Sushi', industry: 'restaurant', town: '', keywords: [] },
  { name: 'Nordlys Sushi', industry: '', town: 'Eksempelby', keywords: [] },
  { name: 'Nordlys Sushi', industry: '', town: '', keywords: '' },
  { name: '', industry: '', town: '', keywords: undefined },
  { name: 'Nordlys Sushi', keywordPlan: { primary: [], local: [], secondary: [] }, keywords: ['a', 'A', 'b'] },
  { name: 'Nordlys Sushi', keywordPlan: 'not an object', keywords: ['a'] },
];

const BANKS = [
  {},
  { seo: { keywordPlan: PLAN }, websiteCreatorQuestions: { mainCtaText: 'Bestill bord', mainCtaUrl: '/bestill' } },
  { seo: { keywordPlan: null }, websiteCreatorQuestions: { primaryAction: 'Ring oss', mainCtaUrl: 'https://example.com/kontakt/' } },
  { seo: {}, generalInfo: { companyName: 'Nordlys Sushi AS' } },
];

// Records that do not guide consumers yet: no keyword approved or blocked.
const QUIET_RECORDS = [
  null,
  undefined,
  { agreedKeywords: [] },
  { agreedKeywords: [{ phrase: 'poke bowl', status: 'proposed' }], planSummary: { primaries: [{ phrase: 'maki eksempelby' }] } },
  { agreedKeywords: [], pageMap: [{ route: '/', primary: 'maki eksempelby' }] },
];

test('without a guiding record every consumer gives the same output as before', () => {
  for (const seoRecord of QUIET_RECORDS) {
    for (const subject of SUBJECTS) {
      const withRecord = seoRecord === undefined ? subject : { ...subject, seoRecord };
      assert.deepEqual(buildMapsKeywords(withRecord), buildMapsKeywords(subject));
      if (baseMaps) assert.deepEqual(buildMapsKeywords(withRecord), baseMaps.buildMapsKeywords(subject), JSON.stringify(subject));
    }
    for (const bank of BANKS) {
      const goals = analyticsGoalsFromBank(bank, { seoRecord });
      assert.deepEqual(goals, analyticsGoalsFromBank(bank));
      if (baseInsights) assert.deepEqual(goals, baseInsights.analyticsGoalsFromBank(bank));
    }
    for (const limit of [1, 3, 5, 20]) {
      const phrases = phrasesFromKeywordPlan(PLAN, limit, { record: seoRecord, brandName: 'Nordlys Sushi' });
      if (baseInsights) assert.deepEqual(phrases, baseInsights.phrasesFromKeywordPlan(PLAN, limit));
    }
  }
  assert.deepEqual(analyticsGoalsFromBank(undefined), baseInsights ? baseInsights.analyticsGoalsFromBank(undefined) : analyticsGoalsFromBank({}));
  if (!base) console.log(`# ${BASE_REF} not available: compared against this tree's no-record output only`);
});

test('the base comparison really ran when the ref exists', () => {
  if (!base) return;
  assert.ok(typeof baseMaps.buildMapsKeywords === 'function');
  assert.equal(baseInsights.phrasesFromKeywordPlan.length, 0, 'the base function takes defaulted parameters only');
});

const GUIDING = {
  agreedKeywords: [
    { phrase: 'sushi catering eksempelby', status: 'approved' },
    { phrase: 'sushi eksempelby', status: 'blocked' },
    { phrase: 'Nordlys Sushi', status: 'approved' },
    { phrase: 'poke bowl', status: 'proposed' },
  ],
  planSummary: { brand: ['nordlys sushi meny'] },
  pageMap: [
    { route: '/', primary: 'japansk restaurant eksempelby', indexable: true },
    { route: '/handlekurv', primary: 'handlekurv', indexable: false },
    { route: '/meny', primary: 'sushi takeaway eksempelby' },
  ],
};

test('a guiding record: approved first, then page-map primaries, then the plan; blocked, brand and regulated phrases dropped', () => {
  const phrases = phrasesFromKeywordPlan(PLAN, 10, { record: GUIDING, brandName: 'Nordlys Sushi AS' });
  assert.deepEqual(phrases, [
    'sushi catering eksempelby',
    'Nordlys Sushi',
    'japansk restaurant eksempelby',
    'sushi takeaway eksempelby',
    'restaurant sentrum eksempelby',
    'bestill sushi',
    'poke bowl',
  ]);
  assert.ok(!phrases.includes('sushi eksempelby'), 'blocked');
  assert.ok(!phrases.includes('nordlys sushi meny'), 'a brand search from the plan is dropped');
  assert.deepEqual(phrases.filter((phrase) => /nordlys/i.test(phrase)), ['Nordlys Sushi'], 'only the approved own name, as the contract lists it');
  assert.ok(!phrases.includes('handlekurv'), 'a non-indexable page has no keyword');
  assert.deepEqual(phrasesFromKeywordPlan(PLAN, 2, { record: GUIDING, brandName: 'Nordlys Sushi AS' }), ['sushi catering eksempelby', 'Nordlys Sushi']);
});

test('Maps keywords with a guiding record', () => {
  const subject = { ...SUBJECTS[1], seoRecord: GUIDING };
  assert.deepEqual(buildMapsKeywords(subject), ['sushi catering eksempelby', 'Nordlys Sushi', 'japansk restaurant eksempelby']);
  const goals = analyticsGoalsFromBank({ ...BANKS[1], generalInfo: { companyName: 'Nordlys Sushi AS' } }, { seoRecord: GUIDING });
  assert.deepEqual(goals.mapsKeywords, ['sushi catering eksempelby', 'Nordlys Sushi', 'japansk restaurant eksempelby', 'sushi takeaway eksempelby', 'restaurant sentrum eksempelby']);
  assert.equal(goals.ctaPath, '/bestill');
});

test('a trade-plus-town business name: the approved trade keyword reaches Maps, the goals and the contract alike', () => {
  // "<Town> <Trade> AS": its main trade keyword shares every identifying word with the name.
  const name = 'Eksempelby Rørlegger AS';
  const seoRecord = {
    agreedKeywords: [
      { phrase: 'rørlegger eksempelby', status: 'approved', flags: ['brand'] },
      { phrase: 'baderom eksempelby', status: 'approved' },
    ],
    pageMap: [{ route: '/', primary: 'eksempelby rørlegger' }, { route: '/bad', primary: 'baderomsrenovering' }],
  };
  const plan = { primary: [{ keyword: 'rørlegger eksempelby døgnvakt' }, { keyword: 'varmepumpe' }] };
  const contract = approvedAgreedPhrases(seoRecord);
  assert.deepEqual(contract, ['rørlegger eksempelby', 'baderom eksempelby']);
  assert.equal(agreedKeywordsContractText(seoRecord), 'Avtalte søkeord: rørlegger eksempelby, baderom eksempelby');
  const maps = buildMapsKeywords({ name: 'Eksempelby Rørlegger', industry: 'rørlegger', town: 'Eksempelby', keywordPlan: plan, seoRecord });
  const goals = analyticsGoalsFromBank({ seo: { keywordPlan: plan }, generalInfo: { companyName: name } }, { seoRecord });
  const phrases = phrasesFromKeywordPlan(plan, 5, { record: seoRecord, brandName: name });
  for (const [label, list] of [['maps', maps], ['goals', goals.mapsKeywords], ['phrases', phrases]]) {
    assert.deepEqual(list.slice(0, contract.length), contract, `${label}: every contract keyword, first and in order`);
    // The name heuristic still keeps own-name phrases out of what the consumers pick by themselves.
    assert.ok(!list.includes('eksempelby rørlegger'), `${label}: the own name from the page map`);
    assert.ok(!list.includes('rørlegger eksempelby døgnvakt'), `${label}: an own-name phrase from the plan`);
  }
  assert.deepEqual(maps, ['rørlegger eksempelby', 'baderom eksempelby', 'baderomsrenovering']);
  assert.deepEqual(goals.mapsKeywords, ['rørlegger eksempelby', 'baderom eksempelby', 'baderomsrenovering', 'varmepumpe']);
});

test('a phrase is never dropped for a short listed term that only appears inside another word', () => {
  const seoRecord = { agreedKeywords: [{ phrase: 'dental specialist eksempelby', status: 'approved' }] };
  const plan = { primary: [{ keyword: 'specialized clinic' }, { keyword: 'cialis eksempelby' }, { keyword: 'melatonintabletter' }] };
  assert.deepEqual(phrasesFromKeywordPlan(plan, 5, { record: seoRecord }), ['dental specialist eksempelby', 'specialized clinic']);
  assert.equal(agreedKeywordsContractText(seoRecord), 'Avtalte søkeord: dental specialist eksempelby');
});

test('negative control: a blocked phrase never reaches the Maps keywords, by any path', () => {
  const blocked = (phrase) => ({ agreedKeywords: [{ phrase, status: 'blocked' }] });
  const cases = [
    // [subject, blocked phrase]: the phrase would be picked without the record.
    [{ name: 'Nordlys Sushi', town: 'Eksempelby', keywordPlan: { primary: [{ keyword: 'sushi eksempelby' }] } }, 'Sushi Eksempelby'],
    [{ name: 'Nordlys Sushi', town: 'Eksempelby', keywords: ['takeaway eksempelby', 'sushi'] }, 'takeaway eksempelby'],
    [{ name: 'Nordlys Sushi', town: 'Eksempelby', keywords: 'takeaway eksempelby, sushi' }, 'TAKEAWAY EKSEMPELBY'],
    [{ name: 'Nordlys Sushi', industry: 'restaurant', town: 'Eksempelby' }, 'restaurant eksempelby'],
    [{ name: 'Nordlys Sushi', industry: 'restaurant' }, 'restaurant'],
    [{ name: 'Nordlys Sushi', town: 'Eksempelby' }, 'nordlys sushi eksempelby'],
    [{ name: 'Nordlys Sushi' }, 'nordlys sushi'],
  ];
  for (const [subject, phrase] of cases) {
    const before = buildMapsKeywords(subject);
    assert.ok(before.some((row) => row.toLowerCase() === phrase.toLowerCase()), `${phrase} is picked without the record`);
    const after = buildMapsKeywords({ ...subject, seoRecord: blocked(phrase) });
    assert.ok(!after.some((row) => row.toLowerCase() === phrase.toLowerCase()), `${phrase} is not picked with it blocked: ${JSON.stringify(after)}`);
  }
  // Approving a phrase and blocking it again: the block wins.
  const flip = { agreedKeywords: [{ phrase: 'sushi catering', status: 'blocked' }, { phrase: 'maki', status: 'approved' }] };
  assert.deepEqual(buildMapsKeywords({ name: 'X', keywords: ['sushi catering'], seoRecord: flip }), ['maki']);
});

test('prescription-only substances never become tracked keywords', () => {
  const guiding = { agreedKeywords: [{ phrase: 'søvn eksempelby', status: 'approved' }] };
  const plan = { primary: [{ keyword: 'melatonin eksempelby' }, { keyword: 'kjøp melatonintabletter' }, { keyword: 'søvnråd' }] };
  assert.deepEqual(phrasesFromKeywordPlan(plan, 5, { record: guiding }), ['søvn eksempelby', 'søvnråd']);
  assert.deepEqual(buildMapsKeywords({ name: 'Helsekost', keywordPlan: plan, seoRecord: guiding }), ['søvn eksempelby', 'søvnråd']);
});

test('the analytics service and the site config pass the record read from the data dir', async () => {
  await record.approveAgreedKeyword('sc-cons-1', 'sushi catering eksempelby', { by: 'dev' });
  await record.blockAgreedKeyword('sc-cons-1', 'sushi eksempelby', { by: 'dev' });
  const bank = { makerLink: { salesClientId: 'sc-cons-1' }, seo: { keywordPlan: PLAN }, generalInfo: { companyName: 'Nordlys Sushi AS', companyAddress: 'Eksempelgata 1' }, websiteCreatorQuestions: { town: 'Eksempelby' } };
  const seoRecord = record.seoRecordForBank(bank);
  assert.ok(seoRecord);
  const subject = buildMapsSubject({ businessId: 'biz-1', clientDataBank: bank }, {}, { seoRecord });
  assert.deepEqual(buildMapsKeywords(subject), ['sushi catering eksempelby', 'sushi takeaway eksempelby', 'restaurant sentrum eksempelby']);
  assert.equal('seoRecord' in buildMapsSubject({ clientDataBank: bank }, {}), false, 'no record: the subject has exactly the old fields');
  const { buildAnalyticsDashboard } = await import('../lib/client-analytics-service.js');
  const dashboard = await buildAnalyticsDashboard({ profile: { businessId: 'biz-1', clientDataBank: bank, payment: { planId: 'tier-2-seo' } }, hubSite: null });
  assert.equal(dashboard.access.allowed, true);
  assert.deepEqual(dashboard.subject.keywords, ['sushi catering eksempelby', 'sushi takeaway eksempelby', 'restaurant sentrum eksempelby']);
  assert.ok(!dashboard.goals.mapsKeywords.includes('sushi eksempelby'));
});
