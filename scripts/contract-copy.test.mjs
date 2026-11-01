// Contract lines per plan from the clause catalog, the switch's effect on contracts, offer letters
// and the sales page, and the negative control: with the switch off every client-facing text is
// byte-identical to the baseline recorded before the catalog existed.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'contract-copy-'));
process.env.DATA_DIR = '';

const settingsStore = await import('../data/automation-settings.js');
const render = await import('../lib/legal/render.js');
const { CATALOG_VERSION, DPA_VERSION } = await import('../lib/legal/catalog.js');
const darkSurface = await import('./legal/dark-surface.mjs');
const { contractHtmlForOffer } = await import('../lib/offer-contract-html.js');
const { contractArticleModel, contractInputsForOffer } = await import('../lib/offer-contract-pdf.js');
const { productsWithTier, setOfferTierIncludesResolver } = await import('../lib/offer-email.js');
const { buildOfferFromMeetingQuote, isStructuralIncludeLine } = await import('../lib/offer-from-quote.js');
const { catalogOfferIncludes } = await import('../lib/legal/sales.js');
const { catalogCheckoutBenefits, mergeCatalogPortalPlans, mergeCatalogSalesProducts } = await import('../app/data/catalogLegalTexts.js');
const { planFromOfferAlternative } = await import('../lib/site-plan.js');
const { tierSnapshot } = await import('../lib/legal/plan.js');

function setSwitch(enabled) {
  assert.equal(settingsStore.saveAutomationSettings({ legal: { catalogTexts: { enabled } } }, { by: 'test' }).ok, true);
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
  assert.equal(blob('../app/pages/legal/Vilkar.tsx'), '562bce444a4d07f0f3313b8b2284bae10da054d1');
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
