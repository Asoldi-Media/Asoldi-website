// Contract lines per plan from the clause catalog, the switch's effect on contracts, offer letters
// and the sales page, and the negative control: with the switch off every client-facing text is
// byte-identical to the baseline recorded before the catalog existed (a contract PDF by its
// uncompressed content, so the result does not depend on the zlib build).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'contract-copy-'));
process.env.DATA_DIR = '';

const settingsStore = await import('../data/automation-settings.js');
const render = await import('../lib/legal/render.js');
const { CATALOG, CATALOG_VERSION, DPA_VERSION } = await import('../lib/legal/catalog.js');
const { catalogContractCopy, catalogServiceTopics } = await import('../lib/legal/contract.js');
const { contractCopy } = await import('../lib/offer-contract-copy.js');
const { SERVICE_MEANINGS_EN } = await import('../lib/service-meanings.js');
const vocab = await import('../packages/suite/core/delivery/vocab.js');
const darkSurface = await import('./legal/dark-surface.mjs');
const { pdfContentSha256 } = await import('./legal/pdf-content.mjs');
const { contractHtmlForOffer } = await import('../lib/offer-contract-html.js');
const { buildContractPdf, contractArticleModel, contractInputsForOffer } = await import('../lib/offer-contract-pdf.js');
const { productsWithTier, setOfferTierIncludesResolver } = await import('../lib/offer-email.js');
const { buildOfferFromMeetingQuote, isStructuralIncludeLine } = await import('../lib/offer-from-quote.js');
const { catalogOfferIncludes } = await import('../lib/legal/sales.js');
const { catalogCheckoutBenefits, mergeCatalogPortalPlans, mergeCatalogSalesProducts } = await import('../app/data/catalogLegalTexts.js');
const { planFromOfferAlternative } = await import('../lib/site-plan.js');
const { tierSnapshot } = await import('../lib/legal/plan.js');
const archive = await import('../lib/legal/archive.js');
const { legalTextResponse } = await import('../lib/legal/texts.js');

function setSwitch(enabled) {
  const patch = { legal: { catalogTexts: { enabled } } };
  if (enabled) patch.retention = { analyticsTraffic: { enabled: true, mode: 'auto' } };
  assert.equal(settingsStore.saveAutomationSettings(patch, { by: 'test' }).ok, true);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const baseline = JSON.parse(readFileSync(darkSurface.BASELINE_PATH, 'utf8'));
const contractSnapshot = JSON.parse(readFileSync(new URL('./fixtures/legal/contract-lines.json', import.meta.url), 'utf8'));
const CLIENT = { id: 'legal-fixture-client', businessName: 'Eksempel Bakeri AS', orgNumber: '999999999', contactPerson: 'Kari Nordmann', contactEmail: 'kari@example.com' };

function lines(tierId, options) {
  return render.contractLinesForPlan(tierId, options).flatMap((block) => block.lines).join('\n');
}

test('the contract lines of tiers 1-3 match the snapshot, and tier 1 has the blog', () => {
  for (const [key, plan] of Object.entries({ 'tier-1-standard': { tierId: 'tier-1-standard' }, 'tier-2-seo': { tierId: 'tier-2-seo' }, 'tier-3-ecommerce': { tierId: 'tier-3-ecommerce' }, 'tier-1-standard:once': { tierId: 'tier-1-standard', billing: 'once' } })) {
    assert.deepEqual(render.contractLinesForPlan(plan, { settings: settingsStore.defaultAutomationSettings() }), contractSnapshot.plans[key].nb, key);
    assert.deepEqual(render.contractLinesForPlan(plan, { language: 'en', settings: settingsStore.defaultAutomationSettings() }), contractSnapshot.plans[key].en, `${key} en`);
  }
  const tier1 = lines('tier-1-standard');
  assert.match(tier1, /Blogg på nettsiden: kunden skriver og publiserer egne innlegg/);
  const tier1Scope = render.contractLinesForPlan('tier-1-standard').filter((block) => block.group === 'scope').flatMap((block) => block.lines).join('\n');
  assert.doesNotMatch(tier1Scope, /Automatiske blogginnlegg|Lenkenettverk|SEO-arbeid/i, 'tier 1 sells no SEO, automatic posts or link network');
  assert.match(tier1, /Minste bindingstid/);
  const tier2 = lines('tier-2-seo');
  assert.match(tier2, /Automatiske blogginnlegg/);
  assert.match(tier2, /aldri i bunnteksten på alle sider/);
  assert.match(tier2, /fjernes når abonnementet avsluttes/);
  const tier3 = lines('tier-3-ecommerce');
  assert.match(tier3, /forlatt handlekurv \(bare med kjøperens samtykke i kassen\)/);
  assert.match(tier3, /Forbrukertilsynets standard salgsbetingelser/);
  const once = lines({ tierId: 'tier-1-standard', billing: 'once' });
  assert.match(once, /Engangskjøp: 9 ganger månedsprisen, uten bindingstid/);
  assert.doesNotMatch(once, /bindingstid er seks/i, 'a one-time contract has no binding period');
});

test('the agreed keywords text is added to the SEO lines when the SEO record provides it', () => {
  const blocks = render.contractLinesForPlan('tier-2-seo', { agreedKeywordsText: 'Avtalte søkeord: frisør Trondheim, hårklipp Trondheim.' });
  const seo = blocks.find((block) => block.clauseId === 'service.seo');
  assert.equal(seo.lines.at(-1), 'Avtalte søkeord: frisør Trondheim, hårklipp Trondheim.');
  assert.equal(render.contractLinesForPlan('tier-1-standard', { agreedKeywordsText: 'x' }).some((block) => block.lines.includes('x')), false);
});

test('switch off: a downgrade is by agreement, in both languages, on an unsent contract and on the terms page', () => {
  setSwitch(false);
  const nb = 'Kunden kan gå ned til et lavere nivå etter avtale med Asoldi. Endringen gjelder fra Asoldi registrerer den. Funksjonene som bare hører til det høyere nivået, slås da av, og en utvikler fjerner dem fra nettsiden.';
  const en = 'The Client can move down to a lower tier by agreement with Asoldi. The change applies from the time Asoldi records it. The functions that belong only to the higher tier are then switched off, and a developer removes them from the website.';
  assert.ok(contractCopy('nb').durationTerms.includes(nb));
  assert.ok(contractCopy('en').durationTerms.includes(en));
  assert.doesNotMatch(contractCopy('nb').durationTerms.join('\n'), /kan ikke nedgradere|cannot downgrade/i);
  assert.doesNotMatch(contractCopy('en').durationTerms.join('\n'), /kan ikke nedgradere|cannot downgrade/i);
  const unsent = Object.entries(darkSurface.FIXTURE_OFFERS).find(([, offer]) => offer.status !== 'sent' && offer.contractLanguage !== 'en');
  assert.ok(unsent);
  assert.match(contractHtmlForOffer(unsent[1], CLIENT), new RegExp(nb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const vilkar = readFileSync(new URL('../app/pages/legal/Vilkar.tsx', import.meta.url), 'utf8');
  assert.match(vilkar, new RegExp(nb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(vilkar, /kan ikke nedgradere/);
});

test('negative control: with the switch off the contracts, copy, pricing cards, offer letters and quote offers equal the baseline', async () => {
  setSwitch(false);
  setOfferTierIncludesResolver((tierId) => catalogOfferIncludes(tierId));
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-05-04T09:00:00.000Z') });
  let surface;
  try {
    surface = await darkSurface.darkSurface({ pdf: true });
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(surface, baseline);
});

test('a contract PDF hashes the same whatever deflate wrote it, and one changed word changes the hash', async () => {
  setSwitch(false);
  setOfferTierIncludesResolver((tierId) => catalogOfferIncludes(tierId));
  const client = darkSurface.FIXTURE_CLIENT;
  const at = new Date('2026-05-04T09:00:00.000Z');
  const build = (client) => buildContractPdf({ client, ...contractInputsForOffer(darkSurface.FIXTURE_OFFERS.custom, client), date: at });
  mock.timers.enable({ apis: ['Date'], now: at.getTime() });
  const deflate = zlib.deflateSync;
  try {
    const pdf = await build(client);
    zlib.deflateSync = (data, options) => deflate(data, { ...options, level: 1 });
    let other;
    try {
      other = await build(client);
    } finally {
      zlib.deflateSync = deflate;
    }
    assert.notEqual(sha256(other), sha256(pdf), 'another deflate output writes other bytes');
    assert.equal(pdfContentSha256(other), pdfContentSha256(pdf));
    assert.equal(pdfContentSha256(pdf), baseline.contracts.custom.pdfContentSha256);
    const renamed = await build({ ...client, businessName: 'Eksempel Baker AS' });
    assert.notEqual(pdfContentSha256(renamed), pdfContentSha256(pdf), 'one changed word');
  } finally {
    zlib.deflateSync = deflate;
    mock.timers.reset();
  }
});

test('switch off: unsent offers match the baseline, and a change to their static text fails that comparison', () => {
  setSwitch(false);
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-05-04T09:00:00.000Z') });
  try {
    const unsent = Object.entries(darkSurface.FIXTURE_OFFERS).filter(([, offer]) => offer.status !== 'sent');
    assert.ok(unsent.length >= 24);
    for (const [key, offer] of unsent) {
      assert.notEqual(offer.status, 'sent', key);
      assert.equal(sha256(contractHtmlForOffer(offer, CLIENT)), baseline.contracts[key].htmlSha256, key);
    }
    const html = contractHtmlForOffer(darkSurface.FIXTURE_OFFERS.tier2Draft, CLIENT);
    const sentence = 'Disse sidene, slik de lyder på signeringsdatoen, utgjør en del av Avtalen.';
    assert.match(html, /Disse sidene, slik de lyder på signeringsdatoen, utgjør en del av Avtalen\./);
    const mutated = html.replace(sentence, `${sentence} Endret setning.`);
    assert.notEqual(sha256(mutated), baseline.contracts.tier2Draft.htmlSha256);
  } finally {
    mock.timers.reset();
  }
});

test('switch on: every unsent fixture renders the catalog contract, so the negative control covers the path the switch changes', () => {
  setSwitch(true);
  const unsent = Object.entries(darkSurface.FIXTURE_OFFERS).filter(([, offer]) => offer.status !== 'sent');
  assert.ok(unsent.length >= 24, 'draft, review-requested and verified copies of every sent fixture');
  for (const [key, offer] of unsent) {
    assert.equal(contractInputsForOffer(offer, CLIENT).legal.mode, 'catalog', key);
    assert.notEqual(sha256(contractHtmlForOffer(offer, CLIENT)), baseline.contracts[key].htmlSha256, `${key}: the switch changes it, and the baseline holds it unchanged while off`);
  }
  setSwitch(false);
  for (const [key, offer] of unsent) assert.equal(contractInputsForOffer(offer, CLIENT).legal.mode, 'legacy', key);
});

test('a contract bound to a version renders the values that version was published with, not today\'s', () => {
  setSwitch(true);
  const stored = archive.loadArchivedCatalog(CATALOG_VERSION);
  assert.ok(stored?.published?.params, 'the archive records the values it was published with');
  assert.equal(stored.published.params.changesPerMonth, 4, 'the change allowance is one of them');
  // An archived version published with other values than the code has today.
  const older = { ...stored, published: { ...stored.published, params: { changesPerMonth: 7, slaWorkDays: 12, oneTimeMultiplier: 11, oneTimeMonths: 8, graceDays: 45 } } };
  const offer = { ...darkSurface.FIXTURE_OFFERS.tier2, dpaVersion: DPA_VERSION, ext: { legal: { catalogVersion: CATALOG_VERSION, tiers: tierSnapshot() } } };
  const today = contractHtmlForOffer(offer, CLIENT);
  assert.match(today, /Inntil 4 endringer per måned/);
  assert.match(today, /oppe i 30 dager/);
  archive.useArchivedCatalogForTests(CATALOG_VERSION, older);
  try {
    const html = contractHtmlForOffer(offer, CLIENT);
    assert.match(html, /Inntil 7 endringer per måned/, 'Section 1');
    assert.match(html, /innen 12 arbeidsdager/);
    assert.match(html, /oppe i 45 dager/, 'Section 3');
    assert.doesNotMatch(html, /Inntil 4 endringer per måned|oppe i 30 dager/);
    const once = contractHtmlForOffer({ ...offer, plan: { tierId: 'tier-2-seo', billing: 'once' } }, CLIENT);
    assert.match(once, /11 ganger månedsprisen/);
    assert.match(once, /i 8 måneder etter levering/);
    const english = contractHtmlForOffer({ ...offer, contractLanguage: 'en' }, CLIENT);
    assert.match(english, /Up to 7 changes per month/);
    assert.match(english, /online for 45 days/);
    const lines = legalTextResponse('kontrakt', { version: String(CATALOG_VERSION), tier: 'tier-2-seo' }).body.blocks.flatMap((block) => block.lines).join('\n');
    assert.match(lines, /Inntil 7 endringer per måned/, 'the contract lines API too');
  } finally {
    archive.clearArchiveCache();
  }
  assert.equal(sha256(contractHtmlForOffer(offer, CLIENT)), sha256(today), 'back to the archive on disk');
});

test('a contract bound to an older catalog version keeps that version\'s introduction and Section 4', () => {
  const stored = archive.loadArchivedCatalog(CATALOG_VERSION);
  const legal = { mode: 'catalog', catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION };
  const plan = { tierId: 'tier-2-seo' };
  const code = catalogContractCopy(contractCopy('nb'), { legal, plan, language: 'nb' });
  assert.equal(code.introLegal, stored.contract.nb.introLegal);
  const archivedIntro = 'ARKIVERT INNLEDNING for versjon 1, som ikke er dagens tekst.';
  const archivedSection4 = ['Arkivert punkt 4 for versjon 1.'];
  archive.useArchivedCatalogForTests(CATALOG_VERSION, {
    ...stored,
    contract: {
      ...stored.contract,
      nb: { introLegal: archivedIntro, section4: archivedSection4 },
      en: { introLegal: 'ARCHIVED INTRO for version 1.', section4: ['Archived section 4 for version 1.'] },
    },
  });
  try {
    const bound = catalogContractCopy(contractCopy('nb'), { legal, plan, language: 'nb', catalogCurrent: CATALOG_VERSION + 1 });
    assert.equal(bound.introLegal, archivedIntro);
    assert.deepEqual(bound.s4.bullets, archivedSection4);
    const current = catalogContractCopy(contractCopy('nb'), { legal, plan, language: 'nb' });
    assert.equal(current.introLegal, code.introLegal);
    assert.notEqual(current.introLegal, archivedIntro);
    const english = catalogContractCopy(contractCopy('en'), { legal, plan, language: 'en', catalogCurrent: CATALOG_VERSION + 1 });
    assert.equal(english.introLegal, 'ARCHIVED INTRO for version 1.');
    assert.deepEqual(english.s4.bullets, ['Archived section 4 for version 1.']);
  } finally {
    archive.clearArchiveCache();
  }
});

test('switch on: an English catalog contract explains its services with the catalog, not the static English text', () => {
  setSwitch(true);
  const offer = { ...darkSurface.FIXTURE_OFFERS.tier2, status: 'draft', contractLanguage: 'en' };
  const inputs = contractInputsForOffer(offer, CLIENT);
  const article = contractArticleModel({ client: CLIENT, ...inputs, date: new Date('2026-05-04T09:00:00.000Z') });
  const topics = article.sections.find((section) => Array.isArray(section.topics)).topics;
  const text = topics.map((topic) => `${topic.title}: ${topic.text}`).join('\n');
  assert.match(text, /changes to sections are allowed/, 'the section-change rule of the catalog');
  assert.match(text, /Asoldi does not post on social media/);
  const html = contractHtmlForOffer(offer, CLIENT);
  assert.doesNotMatch(html, /outside this allowance/, 'no static rule that contradicts the catalog');
  assert.doesNotMatch(html, /social-media sync/);
  assert.doesNotMatch(text, /[æøå]/i, 'English only');
  setSwitch(false);
  assert.match(contractHtmlForOffer(offer, CLIENT), /outside this allowance/, 'negative control: the static English contract while off');
});

test('switch on: every tier\'s English Section 5 comes from the clause texts, including a custom plan with no services', () => {
  setSwitch(true);
  const staticTitles = new Set(SERVICE_MEANINGS_EN.map((row) => row.title));
  const staticTexts = new Set(SERVICE_MEANINGS_EN.map((row) => row.text));
  for (const tierId of vocab.TIER_IDS) {
    const addOns = tierId === 'custom' ? [] : ['pos', 'thirdpartyhost'];
    const services = vocab.expandServices(vocab.servicesForTier(tierId));
    const clauses = CATALOG.filter((clause) => (
      (clause.kind === 'service' && clause.covers.services.some((id) => services.includes(id)))
      || (clause.kind === 'addon' && clause.covers.addOns.some((id) => addOns.includes(id)))
    ));
    for (const clause of clauses) {
      const en = clause.en || {};
      assert.ok(en.title, `${clause.id} has an English title`);
      assert.ok((en.terms && en.terms.length) || (en.contract && en.contract.length), `${clause.id} has English text`);
    }
    const topics = catalogServiceTopics({
      legal: { mode: 'catalog', catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION },
      plan: { tierId, oneTimeAddOns: addOns },
      language: 'en',
      fallback: SERVICE_MEANINGS_EN,
    });
    if (tierId === 'custom') {
      assert.deepEqual(topics, [], 'a custom plan with no services does not fall back to the static English text');
      continue;
    }
    assert.ok(topics.length >= 1, tierId);
    for (const topic of topics) {
      const clause = clauses.find((entry) => entry.en?.title === topic.title);
      assert.ok(clause, `${tierId}: ${topic.title} is a clause English title`);
      assert.equal(staticTitles.has(topic.title), false, topic.title);
      assert.equal(staticTexts.has(topic.text), false, topic.title);
      assert.doesNotMatch(`${topic.title}\n${topic.text}`, /outside this allowance|social-media sync/);
      assert.doesNotMatch(`${topic.title}\n${topic.text}`, /[æøå]/i);
      const line = (clause.en.terms && clause.en.terms[0]) || clause.en.contract[0];
      const pieces = line.split(/\{[a-zA-Z]+\}/).map((part) => part.trim()).filter((part) => part.length >= 12);
      assert.ok(pieces.length > 0, `${clause.id} has a stable English fragment`);
      for (const piece of pieces) assert.ok(topic.text.includes(piece), `${clause.id}: ${piece}`);
    }
  }
});

test('switch on: an unsent offer renders the catalog contract with its versions', () => {
  setSwitch(true);
  const offer = { ...darkSurface.FIXTURE_OFFERS.tier2, status: 'draft', sentAt: '2026-05-04T09:00:00.000Z' };
  const inputs = contractInputsForOffer(offer, CLIENT);
  assert.deepEqual(inputs.legal, { mode: 'catalog', catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION });
  const article = contractArticleModel({ client: CLIENT, ...inputs, date: new Date(offer.sentAt) });
  assert.deepEqual(article.legal, { catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION });
  const html = contractHtmlForOffer(offer, CLIENT);
  assert.match(html, /Lenkenettverk:/);
  assert.match(html, /Automatiske blogginnlegg/);
  assert.match(html, new RegExp(`versjon ${CATALOG_VERSION}`));
  assert.match(html, new RegExp(`versjon ${DPA_VERSION}`));
  assert.match(html, /Nettsiden er oppe i 30 dager etter den betalte perioden/);
  assert.notEqual(sha256(html), baseline.contracts.tier2.htmlSha256);
  const english = contractHtmlForOffer({ ...offer, contractLanguage: 'en' }, CLIENT);
  assert.match(english, /Link network:/);
  assert.match(english, /The website stays online for 30 days after the paid period/);
});

test('switch on: a client who signed before the switch still gets the legacy contract text', () => {
  setSwitch(true);
  for (const key of ['tier1', 'tier2', 'tier3', 'tier2En', 'custom', 'dual']) {
    const offer = darkSurface.FIXTURE_OFFERS[key];
    assert.equal(offer.status, 'sent');
    assert.equal(contractInputsForOffer(offer, CLIENT).legal.mode, 'legacy', key);
    assert.equal(sha256(contractHtmlForOffer(offer, CLIENT)), baseline.contracts[key].htmlSha256, key);
  }
});

test('switch on: a stamped sent offer keeps the version it was sent with', () => {
  setSwitch(true);
  const offer = { ...darkSurface.FIXTURE_OFFERS.tier1, dpaVersion: DPA_VERSION, ext: { legal: { catalogVersion: CATALOG_VERSION } } };
  assert.deepEqual(contractInputsForOffer(offer, CLIENT).legal, { mode: 'catalog', catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION });
  assert.match(contractHtmlForOffer(offer, CLIENT), /Blogg på nettsiden/);
  const unknown = { ...offer, ext: { legal: { catalogVersion: 999 } } };
  assert.equal(contractInputsForOffer(unknown, CLIENT).legal.mode, 'legacy', 'an unknown stamped version falls back to the legacy text');
});

test('switch on: the contract links the versions it incorporates, not the latest pages', () => {
  setSwitch(true);
  const offer = { ...darkSurface.FIXTURE_OFFERS.tier2, dpaVersion: DPA_VERSION, ext: { legal: { catalogVersion: CATALOG_VERSION } } };
  const html = contractHtmlForOffer(offer, CLIENT);
  assert.match(html, new RegExp(`/vilkar\\?versjon=${CATALOG_VERSION}`));
  assert.match(html, new RegExp(`/databehandleravtale\\?versjon=${CATALOG_VERSION}`));
  assert.match(html, /etter skriftlig varsel minst 30 dager i forveien/, 'the contract says how a newer version starts to apply');
});

test('switch on: a stamped offer renders the tier contents and agreed keywords it was sent with', () => {
  setSwitch(true);
  const stamped = { ...darkSurface.FIXTURE_OFFERS.tier2, dpaVersion: DPA_VERSION, ext: { legal: { catalogVersion: CATALOG_VERSION, tiers: tierSnapshot(), agreedKeywordsText: 'Avtalte søkeord: frisør Bergen.' } } };
  const inputs = contractInputsForOffer(stamped, CLIENT);
  assert.equal(inputs.agreedKeywordsText, 'Avtalte søkeord: frisør Bergen.', 'the keywords sent, not the record today');
  const html = contractHtmlForOffer(stamped, CLIENT);
  assert.match(html, /Avtalte søkeord: frisør Bergen\./);
  assert.match(html, /Lenkenettverk:/);
  // The tier vocabulary changes after send: the stamped contract keeps the scope it was sent with.
  const shrunk = { ...stamped, ext: { legal: { ...stamped.ext.legal, tiers: { ...tierSnapshot(), 'tier-2-seo': { services: ['site', 'changes'], pages: 7 } } } } };
  assert.doesNotMatch(contractHtmlForOffer(shrunk, CLIENT), /Lenkenettverk:/, 'rendered from the snapshot');
  const unsnapshotted = { ...stamped, ext: { legal: { catalogVersion: CATALOG_VERSION } } };
  assert.equal(sha256(contractHtmlForOffer({ ...unsnapshotted, ext: { legal: { catalogVersion: CATALOG_VERSION, tiers: tierSnapshot(), agreedKeywordsText: '' } } }, CLIENT)), sha256(contractHtmlForOffer(unsnapshotted, CLIENT)), 'a snapshot of today\'s tiers renders the same text');
});

test('catalog lines count as tier lines only with the switch on or a legal stamp (negative control: derived plans as before)', () => {
  setSwitch(false);
  for (const [key, offer] of Object.entries(darkSurface.FIXTURE_PLAN_OFFERS)) {
    assert.deepEqual(JSON.parse(JSON.stringify(planFromOfferAlternative(offer))), baseline.plans[key], key);
  }
  assert.equal(isStructuralIncludeLine('Grunnleggende SEO og sitemap', { tierId: 'tier-1-standard' }), false, 'switch off: a rep line equal to a catalog line is not neutral');
  const tier1 = darkSurface.FIXTURE_PLAN_OFFERS.tier1RepLines;
  const stamped = { ...tier1, dpaVersion: DPA_VERSION, ext: { legal: { catalogVersion: CATALOG_VERSION } } };
  assert.equal(planFromOfferAlternative(stamped).plan.needsConfirmation, false, 'a stamped offer keeps its catalog lines neutral after a switch-off');
  setSwitch(true);
  assert.equal(planFromOfferAlternative(tier1).plan.needsConfirmation, false);
  assert.deepEqual(planFromOfferAlternative(tier1).plan.unknownLines, []);
  setSwitch(false);
});

test('switch on: offer letters and quote offers use the catalog lines, and those lines count as tier lines', () => {
  setSwitch(true);
  setOfferTierIncludesResolver((tierId) => catalogOfferIncludes(tierId));
  const product = productsWithTier([], 'tier-1-standard')[0];
  assert.ok(product.includes.includes('Blogg der du publiserer egne innlegg'));
  assert.ok(!product.includes.some((line) => /^Opp til \d+ hovedsider$|^Leveringstid:/.test(line)));
  const built = buildOfferFromMeetingQuote({ tierId: 'seo', selected: [], pages: 7 });
  assert.ok(built.products[0].includes.includes('Asoldi-nettverk for relevante lenker'));
  for (const line of built.products[0].includes) assert.equal(isStructuralIncludeLine(line, { tierId: 'tier-2-seo' }), true, line);
  assert.equal(isStructuralIncludeLine('Asoldi-nettverk for relevante lenker', { tierId: 'tier-1-standard' }), false, 'a tier 2 line is not neutral in a tier 1 offer');
  setSwitch(false);
  assert.deepEqual(productsWithTier([], 'tier-1-standard'), baseline.tiers['tier-1-standard'].productsWithTier);
});

test('the portal plans and checkout keep their static data until the catalog answers, then drop promises the terms do not back', () => {
  const plans = [{ id: 'tier-1-standard', features: ['f'], includedFeatures: ['a'], notIncludedFeatures: ['x'] }, { id: 'other', features: [], includedFeatures: ['b'], notIncludedFeatures: [] }];
  assert.equal(mergeCatalogPortalPlans(plans, null), plans, 'same array while the API answers 404');
  const benefits = [{ key: 'money-back' }, { key: 'no-setup-fee' }, { key: 'support' }];
  assert.equal(catalogCheckoutBenefits(benefits, null), benefits, 'same array while the API answers 404');
  const payload = { tiers: { 'tier-1-standard': render.salesCopyForTier('tier-1-standard') }, checkoutPromises: [] };
  const merged = mergeCatalogPortalPlans(plans, payload);
  assert.ok(merged[0].includedFeatures.includes('Blogg der du publiserer egne innlegg'));
  assert.deepEqual(merged[0].features, merged[0].includedFeatures);
  assert.equal(merged[1], plans[1]);
  assert.deepEqual(catalogCheckoutBenefits(benefits, payload), [], 'no clause backs the static checkout promises');
  assert.deepEqual(catalogCheckoutBenefits(benefits, { checkoutPromises: ['support'] }), [{ key: 'support' }]);
  for (const page of ['../app/pages/client/ClientWebsitePlans.tsx', '../app/pages/client/ClientWebsiteCheckout.tsx']) {
    const source = readFileSync(new URL(page, import.meta.url), 'utf8');
    assert.match(source, /useCatalogSalesCopy\(\)/, page);
    assert.doesNotMatch(source, /\{CHECKOUT_BENEFITS\.map/, `${page} renders the filtered promises`);
  }
});

test('the sales page keeps its static cards until the catalog answers', () => {
  const cards = [{ id: 'starter', includedFeatures: ['a'], notIncludedFeatures: [] }, { id: 'skreddersydd', includedFeatures: ['b'], notIncludedFeatures: [] }];
  assert.equal(mergeCatalogSalesProducts(cards, null), cards, 'same array while the API answers 404');
  assert.equal(mergeCatalogSalesProducts(cards, { tiers: {} }), cards);
  const payload = { tiers: { 'tier-1-standard': render.salesCopyForTier('tier-1-standard') } };
  const merged = mergeCatalogSalesProducts(cards, payload);
  assert.ok(merged[0].includedFeatures.includes('Blogg der du publiserer egne innlegg'));
  assert.equal(merged[1], cards[1], 'the custom card is untouched');
});

test('the legacy legal pages and pricing data are unchanged; the catalog pages fall back to them', () => {
  const blob = (path) => {
    const content = readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const bytes = Buffer.from(content, 'utf8');
    return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  };
  // The terms page includes the agreed downgrade sentence, so this hash moves with that sentence.
  assert.equal(blob('../app/pages/legal/Vilkar.tsx'), '8838c07245f9a3b834a8b16aa5e1a09c10d1e121');
  assert.equal(blob('../app/pages/legal/Personvern.tsx'), '76efae513dd2ee7b0cf52b2d002918bdb94c0547');
  assert.equal(blob('../app/pages/legal/Databehandleravtale.tsx'), '4cf302bb71167b6e06b1a24f577df75b7b280b10');
  assert.equal(blob('../app/data/websiteProducts.ts'), 'b3c263cb5488ef47e683d6f7a09404d65e554ad9');
  const page = readFileSync(new URL('../app/pages/legal/CatalogLegalPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /if \(!catalog\) return <Static \/>;/);
  const hook = readFileSync(new URL('../app/data/catalogLegalTexts.js', import.meta.url), 'utf8');
  assert.match(hook, /response\.status !== 200\) return null/);
  const card = readFileSync(new URL('../app/components/client/ClientLegalCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /if \(!state \|\| !state\.client\) return null;/);
});

test('the browser bundle never imports the server-side legal modules', () => {
  const root = new URL('../', import.meta.url);
  const seen = new Set();
  const stack = [new URL('app/index.tsx', root).href];
  while (stack.length) {
    const href = stack.pop();
    if (seen.has(href) || !/\.(js|mjs|ts|tsx)$/.test(href)) continue;
    seen.add(href);
    let source = '';
    try {
      source = readFileSync(new URL(href), 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      let target = new URL(match[1] || match[2], href).href;
      if (!/\.(js|mjs|ts|tsx)$/.test(target)) {
        const found = ['.tsx', '.ts', '.js'].map((ext) => target + ext).find((candidate) => existsSync(new URL(candidate)));
        if (found) target = found;
      }
      stack.push(target);
    }
  }
  const relative = [...seen].map((href) => href.slice(root.href.length));
  assert.ok(relative.includes('app/data/catalogLegalTexts.js'));
  assert.deepEqual(relative.filter((path) => path.startsWith('lib/legal/') || path === 'data/automation-settings.js'), []);
});
