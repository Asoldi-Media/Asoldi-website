// WS8.1 tier service matrix and WS8.3 client.sitePlan: resolver, offer-scoped plan, readers and the
// Maker handoff payload. Pure functions plus the data layer on a temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-site-plan-'));
process.env.APP_DATA_DIR = DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 'delivery-plan-golden.json'), 'utf8'));
const vocab = await import('../packages/suite/core/delivery/vocab.js');
const tiers = await import('../lib/website-tiers.js');
const { featuresFromPlan } = await import('../data/hub-model.js');
const { buildOfferFromMeetingQuote, isStructuralIncludeLine } = await import('../lib/offer-from-quote.js');
const sitePlan = await import('../lib/site-plan.js');
const model = await import('../lib/site-plan-model.js');
const { planIdForProfile, analyticsAccessFor } = await import('../lib/client-analytics-service.js');
const { buildDevelopmentItems } = await import('../lib/development-phase.js');

// ---------------------------------------------------------------- WS8.1 tier matrix

test('tier matrix: featuresFromPlan returns exactly what it returned before the matrix', () => {
  for (const [id, expected] of Object.entries(golden.featuresFromPlan)) {
    assert.deepEqual(featuresFromPlan(id === '(empty)' ? '' : id), expected, id);
  }
});

test('tier matrix: every tier carries its services and the monthly change allowance', () => {
  for (const tier of tiers.WEBSITE_TIERS) {
    assert.deepEqual(tier.services, vocab.servicesForTier(tier.id), tier.id);
    assert.equal(tier.changesPerMonth, 4);
    assert.equal(vocab.TIER_MATRIX[tier.id].pages, tier.pages, `${tier.id} page cap matches the tier list`);
    assert.equal(vocab.TIER_MATRIX[tier.id].tierNumber, tier.tierNumber);
  }
  assert.equal(vocab.TIER_MATRIX_VERSION, 1);
  assert.ok(Object.isFrozen(vocab.TIER_MATRIX['tier-2-seo']));
  assert.ok(vocab.VOCAB_VERSION >= 2, 'the vocabulary version went up for the tier matrix');
});

test('tier matrix: plan-based flags give tier 1 the blog (owner decision); the legacy table does not', () => {
  assert.equal(tiers.featuresFromServices(vocab.servicesForTier('tier-1-standard')).blog, true);
  assert.equal(featuresFromPlan('tier-1-standard').blog, false);
  for (const id of ['tier-2-seo', 'tier-3-ecommerce']) {
    assert.deepEqual(tiers.featuresFromServices(vocab.servicesForTier(id)), featuresFromPlan(id), id);
  }
});

test('tier matrix: the calculator lists exactly the ids it listed before, in the same order', () => {
  const before = { starter: ['blog'], seo: ['seo', 'social', 'email', 'blog'], nettbutikk: ['seo', 'social', 'email', 'ecom', 'dashboard', 'blog', 'multilingual'] };
  for (const tier of tiers.WEBSITE_TIERS) assert.deepEqual(tiers.calculatorServiceIdsForTier(tier), before[tier.marketingId], tier.id);
  const pricing = readFileSync(join(root, 'app', 'pages', 'sales', 'websitePricing.ts'), 'utf8');
  assert.match(pricing, /calculatorServiceIdsForTier\(tier\)/, 'the calculator reads the tier matrix');
  assert.doesNotMatch(pricing, /starter: \['blog'\]/, 'no second copy of the matrix');
  const offerFromQuote = readFileSync(join(root, 'lib', 'offer-from-quote.js'), 'utf8');
  assert.doesNotMatch(offerFromQuote, /TIER_SERVICE_IDS/);
});

test('tier matrix: aliases and calculator ids map to plan services', () => {
  for (const alias of ['shop', 'ecommerce', 'nettbutikk', 'Nettbutikk']) assert.deepEqual(tiers.normalizeServices([alias]), ['ecom'], alias);
  for (const id of ['hosting', 'contact', 'meeting', 'domain', 'webdesign']) assert.equal(tiers.quoteServiceToPlanService(id), 'site', id);
  assert.equal(tiers.quoteServiceToPlanService('changes'), 'changes');
  assert.equal(tiers.quoteServiceToPlanService('unlimited'), 'unlimited');
  assert.equal(tiers.quoteServiceToPlanService('nonsense'), '');
  assert.equal(vocab.changesPerMonthForTier('custom'), 4);
});

// ---------------------------------------------------------------- WS8.3 offer-scoped plan and resolver

const quoteTier2 = buildOfferFromMeetingQuote({ tierId: 'seo', selected: [], pages: 7 });
const quoteDual = buildOfferFromMeetingQuote({ tierId: 'starter', selected: [], pages: 5, altQuote: { tierId: 'nettbutikk', selected: [], pages: 10 } });
const offerFrom = (built, extra = {}) => ({ id: 'offer-x', salesClientId: 'c1', status: 'sent', sentAt: '2026-10-20T10:00:00.000Z', tierId: built.tierId, products: built.products, alternatives: built.alternatives, ...extra });

test('offer-scoped plan: a single offer gives its own plan; a dual offer needs a choice', () => {
  const single = sitePlan.planFromOfferAlternative(offerFrom(quoteTier2));
  assert.equal(single.ok, true);
  assert.equal(single.plan.tierId, 'tier-2-seo');
  assert.equal(single.plan.derived, false, 'a quote-built offer carries an explicit plan');
  const dual = offerFrom(quoteDual);
  assert.deepEqual(sitePlan.planFromOfferAlternative(dual), { ok: false, needsChoice: true, reason: 'needs-choice', offerId: 'offer-x' });
  assert.equal(sitePlan.planFromOfferAlternative(dual, 1).plan.tierId, 'tier-3-ecommerce');
  assert.equal(sitePlan.planFromOfferAlternative({ ...dual, chosenOfferIndex: 0 }).plan.tierId, 'tier-1-standard');
});

test('offer-scoped plan: a stored plan that no longer matches the offer (tier changed) is derived again', () => {
  const offer = offerFrom(quoteTier2, { tierId: 'tier-3-ecommerce', products: [{ ...quoteTier2.products[0], tierId: 'tier-3-ecommerce' }] });
  const result = sitePlan.planFromOfferAlternative(offer);
  assert.equal(result.stale, true);
  assert.equal(result.plan.tierId, 'tier-3-ecommerce');
  assert.equal(result.plan.derived, true);
});

test('offer-scoped plan: a client signed on tier 1 who gets a tier 2 offer is published and accepted on tier 2', () => {
  const client = { id: 'c1', product: 'asoldi', portalTierId: 'tier-1-standard', details: { meetingQuote: { tierId: 'starter' } }, sitePlan: { tierId: 'tier-1-standard', services: ['site'], source: 'portal-accept' } };
  const offer = offerFrom(quoteTier2);
  assert.equal(sitePlan.chosenWebsiteTier(client, offer).id, 'tier-2-seo', 'publish uses the offer');
  const flattened = { ...offer, chosenOfferIndex: 0, tierId: offer.alternatives[0].tierId };
  assert.equal(sitePlan.chosenWebsiteTier(client, flattened).id, 'tier-2-seo', 'accept of the alternative uses the offer');
  assert.equal(sitePlan.planFromOfferAlternative(offer).plan.tierId, 'tier-2-seo');
  // The legacy fallback order is unchanged: offer, meeting quote, portalTierId.
  assert.equal(sitePlan.chosenWebsiteTier({ details: { meetingQuote: { tierId: 'seo' } }, portalTierId: 'tier-1-standard' }, { tierId: 'custom' }).id, 'tier-2-seo');
  assert.equal(sitePlan.chosenWebsiteTier({ portalTierId: 'tier-3-ecommerce' }, null).id, 'tier-3-ecommerce');
  assert.equal(sitePlan.chosenWebsiteTier({}, {}), null);
});

test('legacy offers: a plan is derived from exact service lines; unknown lines and custom offers need confirmation', () => {
  const tier = sitePlan.derivePlanFromOfferAlternative({ products: [{ kind: 'tier', tierId: 'tier-1-standard', includes: ['Full nettsideutvikling', 'SEO-optimalisering (Google, Google Maps og AI-søk)', 'Koble opp til kassasystem (6 000 kr engang)'] }] }, { tierId: 'tier-1-standard' });
  assert.deepEqual(tier.services, ['site', 'changes', 'seo', 'blog']);
  assert.deepEqual(tier.oneTimeAddOns, ['pos']);
  assert.equal(tier.needsConfirmation, false);
  const unknown = sitePlan.derivePlanFromOfferAlternative({ products: [{ kind: 'tier', tierId: 'tier-2-seo', includes: ['Something agreed in the meeting'] }] }, { tierId: 'tier-2-seo' });
  assert.equal(unknown.needsConfirmation, true);
  assert.deepEqual(unknown.unknownLines, ['Something agreed in the meeting']);
  const custom = sitePlan.derivePlanFromOfferAlternative({ products: [{ kind: 'custom', includes: ['Skreddersydd utvalg av tjenester', 'Nettbutikk'] }] }, {});
  assert.equal(custom.tierId, 'custom');
  assert.deepEqual(custom.services, ['site', 'blog', 'ecom']);
  assert.equal(custom.derived, true);
  assert.equal(custom.needsConfirmation, true);
});

// Quotes whose packages carry every line kind the calculator writes: extra pages, the one-time
// note, one-time fees and ticked services on top of a tier.
const LINE_QUOTES = {
  extraPagesMonthly: { tierId: 'seo', selected: ['email'], pages: 9 },
  extraPagesOnce: { tierId: 'seo', oneTime: true, selected: [], pages: 9, oneTimeAddOns: ['pos'] },
  oneExtraPage: { tierId: 'starter', selected: ['seo'], pages: 6 },
  shopOnceDual: { tierId: 'nettbutikk', oneTime: true, selected: [], pages: 14, oneTimeAddOns: ['thirdpartyhost'], altQuote: { tierId: 'starter', oneTime: true, selected: ['blog'], pages: 8 } },
  customOnce: { tierId: 'custom', customMode: true, oneTime: true, selected: ['hosting', 'contact', 'ecom', 'seo'], pages: 12, oneTimeAddOns: ['pos'] },
};
const comparable = (plan) => ({ tierId: plan.tierId, services: plan.services, pages: plan.pages, oneTimeAddOns: plan.oneTimeAddOns, billing: plan.billing });

test('legacy offers: lines the calculator writes (extra pages, one-time note and fees) are neutral', () => {
  for (const line of ['1 ekstra side utover 5 inkludert', '2 ekstra sider utover 7 inkludert', 'Engangsbetaling (månedspris × 9)', 'Engangsbetaling (månedspris × 9,5)']) {
    assert.equal(isStructuralIncludeLine(line), true, line);
  }
  for (const line of ['d ekstra sider utover d inkludert', 'Engangsbetaling månedspris × 9', 'Something agreed in the meeting']) {
    assert.equal(isStructuralIncludeLine(line), false, line);
  }
  for (const [name, input] of Object.entries(LINE_QUOTES)) {
    const built = buildOfferFromMeetingQuote(input);
    built.alternatives.forEach((alternative, index) => {
      const { plan, pricing: _pricing, ...legacy } = alternative;
      const derived = sitePlan.derivePlanFromOfferAlternative(legacy, { tierId: legacy.tierId, billing: legacy.billing });
      assert.deepEqual(derived.unknownLines, [], `${name}[${index}]: every line is read`);
      assert.equal(derived.needsConfirmation, plan.tierId === 'custom', `${name}[${index}]: only custom offers need a confirmation click`);
      assert.deepEqual(comparable(derived), comparable(plan), `${name}[${index}]: the derived plan equals the quote's plan`);
    });
  }
});

test('legacy offers: every package built before offer plans derives without unread lines', () => {
  for (const [name, built] of Object.entries(golden.quotes)) {
    for (const [index, alternative] of built.alternatives.entries()) {
      const derived = sitePlan.derivePlanFromOfferAlternative(alternative, { tierId: alternative.tierId, billing: alternative.billing });
      assert.deepEqual(derived.unknownLines, [], `${name}[${index}]`);
      assert.equal(derived.needsConfirmation, derived.tierId === 'custom', `${name}[${index}]`);
    }
  }
});

const NOW = '2026-10-23T12:00:00.000Z';
const signed = (extra = {}) => ({ id: 'c1', product: 'asoldi', progression: { contractSigned: true }, contractSignedAt: '2026-10-21T09:00:00.000Z', ...extra });

test('resolver: an existing plan wins over every other source', () => {
  const stored = { status: 'active', tierId: 'tier-1-standard', services: ['site'], source: 'portal-accept' };
  const result = sitePlan.resolveSitePlan(signed({ sitePlan: stored }), { offers: [offerFrom(quoteTier2)], now: NOW });
  assert.equal(result.evidence, 'stored');
  assert.equal(result.plan.tierId, 'tier-1-standard');
});

test('resolver: accepted portal alternative, then the sent offer, with lower disagreeing sources as conflicts', () => {
  const dual = offerFrom(quoteDual, { id: 'offer-dual' });
  const portal = [{ salesClientId: 'c1', salesOfferId: 'offer-dual', acceptance: { acceptedAt: '2026-10-21T09:00:00.000Z', chosenOfferIndex: 1 } }];
  const fromPortal = sitePlan.resolveSitePlan(signed(), { offers: [dual], portalOffers: portal, profile: { payment: { planId: 'tier-1-standard' } }, now: NOW });
  assert.equal(fromPortal.evidence, 'portal-accept');
  assert.equal(fromPortal.plan.tierId, 'tier-3-ecommerce');
  assert.equal(fromPortal.plan.alternativeIndex, 1);
  assert.equal(fromPortal.plan.source, 'backfill');
  assert.equal(fromPortal.plan.signedAt, '2026-10-21T09:00:00.000Z');
  assert.deepEqual(fromPortal.conflicts.map((conflict) => [conflict.source, conflict.tierId]), [['payment', 'tier-1-standard']], 'the Stripe plan disagrees');

  const fromOffer = sitePlan.resolveSitePlan(signed(), { offers: [offerFrom(quoteTier2)], now: NOW });
  assert.equal(fromOffer.evidence, 'offer');
  assert.equal(fromOffer.plan.tierId, 'tier-2-seo');
  assert.equal(fromOffer.conflicts.length, 0);
});

test('resolver: a dual offer without a chosen alternative changes nothing and is listed', () => {
  const result = sitePlan.resolveSitePlan(signed(), { offers: [offerFrom(quoteDual, { id: 'offer-dual' })], hubSite: { websitePlan: 'tier-1-standard' }, now: NOW });
  assert.equal(result.plan, null);
  assert.equal(result.needsChoice, true);
  assert.equal(result.offerId, 'offer-dual');
});

test('resolver: an admin site plan beats the sent offer, an offer-kind plan source does not; the meeting quote counts only when picked', () => {
  const adminSite = { id: 's1', websitePlan: 'tier-3-ecommerce', planSource: { kind: 'admin', tierId: 'tier-3-ecommerce' } };
  const result = sitePlan.resolveSitePlan(signed(), { offers: [offerFrom(quoteTier2)], hubSite: adminSite, profile: { payment: { planId: 'tier-2-seo' } }, now: NOW });
  assert.equal(result.evidence, 'hub-plan-source');
  assert.equal(result.plan.tierId, 'tier-3-ecommerce');
  assert.deepEqual(result.conflicts.map((conflict) => conflict.source), ['offer', 'payment']);
  const offerKind = { ...adminSite, planSource: { kind: 'offer', tierId: 'tier-3-ecommerce' } };
  const fromOffer = sitePlan.resolveSitePlan(signed(), { offers: [offerFrom(quoteTier2)], hubSite: offerKind, now: NOW });
  assert.equal(fromOffer.evidence, 'offer');
  assert.equal(fromOffer.plan.tierId, 'tier-2-seo');

  const implicit = sitePlan.resolveSitePlan(signed({ details: { meetingQuote: { tierId: 'starter' } } }), { now: NOW });
  assert.equal(implicit.plan, null, 'the implicit starter default is not evidence');
  assert.equal(implicit.skipped, 'no-evidence');
  const explicit = sitePlan.resolveSitePlan(signed({ details: { meetingQuote: { tierId: 'seo', tierExplicit: true, selected: [] } } }), { now: NOW });
  assert.equal(explicit.evidence, 'meeting-quote');
  assert.equal(explicit.plan.tierId, 'tier-2-seo');
});

test('resolver: a linked legacy hub site counts, SSU clients never get a plan', () => {
  const result = sitePlan.resolveSitePlan(signed(), { hubSite: { id: 's1', websitePlan: 'tier-1-standard' }, now: NOW });
  assert.equal(result.evidence, 'hub-site');
  assert.equal(result.plan.tierId, 'tier-1-standard');
  assert.equal(result.plan.appliedSiteId, 's1');
  const ssu = sitePlan.resolveSitePlan(signed({ product: 'ssu' }), { offers: [offerFrom(quoteTier2)], now: NOW });
  assert.equal(ssu.plan, null);
  assert.equal(ssu.skipped, 'not-a-website-product');
});

test('resolver: one-time plans with unlimited changes get the six-month term from signing', () => {
  const once = buildOfferFromMeetingQuote({ tierId: 'seo', oneTime: true, selected: ['unlimited'], pages: 7 });
  const result = sitePlan.resolveSitePlan(signed(), { offers: [offerFrom(once)], now: NOW });
  assert.equal(result.plan.billing, 'once');
  assert.ok(result.plan.services.includes('unlimited'));
  assert.deepEqual(result.plan.serviceTerms, { unlimited: { until: '2027-04-21T09:00:00.000Z' } });
});

test('site plan model: normalizing is idempotent, keeps later keys and drops what is not a plan', () => {
  const raw = { status: 'active', tierId: 'tier-3-ecommerce', services: ['shop', 'site', 'bogus'], billing: 'month', future: { x: 1 }, history: [{ at: NOW, by: 'client', to: { tierId: 'tier-3-ecommerce' }, reason: 'preview-accept' }] };
  const once = model.normalizeSitePlan(raw);
  assert.deepEqual(model.normalizeSitePlan(once), once);
  assert.deepEqual(once.services, ['site', 'blog', 'ecom']);
  assert.deepEqual(once.future, { x: 1 }, 'a later batch key survives');
  assert.equal(model.normalizeSitePlan({ tierId: 'tier-9' , services: ['site'] }), null);
  assert.equal(model.normalizeSitePlan({ tierId: 'tier-1-standard', services: [] }), null);
  assert.equal(model.activeSitePlan({ sitePlan: { ...raw, status: 'void' } }), null);
});

// ---------------------------------------------------------------- readers and handoff

test('readers: the website-due tier follows the plan in force, else the old order', () => {
  const client = { portalTierId: 'tier-1-standard', details: { meetingQuote: { tierId: 'seo' } } };
  assert.equal(sitePlan.websiteTierIdForClient(client, { tierId: 'tier-2-seo' }), 'tier-2-seo');
  assert.equal(sitePlan.websiteTierIdForClient(client, null), 'tier-1-standard');
  assert.equal(sitePlan.websiteTierIdForClient({ ...client, sitePlan: { tierId: 'tier-3-ecommerce', services: ['site'] } }, { tierId: 'tier-2-seo' }), 'tier-3-ecommerce');
  assert.equal(sitePlan.websiteTierIdForClient({ ...client, sitePlan: { tierId: 'tier-3-ecommerce', services: ['site'], status: 'void' } }, { tierId: 'tier-2-seo' }), 'tier-2-seo');
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  assert.equal((server.match(/const tierId = websiteTierIdForClient\(client, offer\);/g) || []).length, 2, 'both website-due views use it');
});

test('readers: analytics follows the applied hub site first, then the plan in force', () => {
  const profile = { payment: { planId: 'tier-1-standard' } };
  const plan = { tierId: 'tier-3-ecommerce', services: ['site', 'ecom'], status: 'active' };
  assert.equal(planIdForProfile(profile, { websitePlan: 'tier-2-seo' }, { sitePlan: plan }), 'tier-2-seo');
  assert.equal(planIdForProfile(profile, null, { sitePlan: plan }), 'tier-3-ecommerce');
  assert.equal(planIdForProfile(profile, null), 'tier-1-standard', 'without a plan nothing changes');
  assert.equal(analyticsAccessFor(profile, null, { sitePlan: plan }).level, 'advanced');
});

test('readers: the development board shows the plan only for clients that have one', () => {
  const withPlan = { id: 'c1', product: 'asoldi', businessName: 'Plan AS', progression: { contractSigned: true }, sitePlan: { tierId: 'tier-2-seo', services: ['site', 'seo'], source: 'backfill', status: 'active' }, delivery: { stage: 'gathering' } };
  const without = { id: 'c2', product: 'asoldi', businessName: 'Plain AS', progression: { contractSigned: true } };
  const items = buildDevelopmentItems([withPlan, without], []);
  const a = items.find((item) => item.salesClientId === 'c1');
  const b = items.find((item) => item.salesClientId === 'c2');
  assert.equal(a.sitePlan.tierId, 'tier-2-seo');
  assert.equal(a.deliveryStage, 'gathering');
  assert.equal(Object.hasOwn(b, 'sitePlan'), false);
  assert.equal(Object.hasOwn(b, 'deliveryStage'), false);
});

test('Maker handoff: a plan in force goes out as site-plan/1 with its flags and hash; nothing else does', () => {
  const plan = model.normalizeSitePlan({ status: 'active', tierId: 'tier-3-ecommerce', services: vocab.servicesForTier('tier-3-ecommerce'), source: 'preview-accept', signedAt: '2026-10-28T10:02:11.000Z', offerId: 'o1', alternativeIndex: 0, pages: 10 });
  const payload = sitePlan.makerSitePlanPayload(plan);
  assert.deepEqual(Object.keys(payload), [...vocab.SITE_PLAN_HANDOFF_FIELDS]);
  assert.equal(payload.schema, 'site-plan/1');
  assert.equal(payload.signedAt, '2026-10-28T10:02:11.000Z');
  assert.equal(payload.features.ecommerce, true);
  assert.match(payload.planHash, /^[a-f0-9]{16}$/);
  assert.equal(sitePlan.makerSitePlanPayload({ ...plan, status: 'void' }), null);
  assert.equal(sitePlan.makerSitePlanPayload(null), null);
  const server = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = server.indexOf("app.post('/api/admin/sales/:id/create-maker-run'");
  const body = server.slice(start, server.indexOf('const browserCreated', start));
  assert.match(body, /const sitePlanPayload = makerSitePlanPayload\(client\.sitePlan\);\n    if \(sitePlanPayload\) requestBody\.sitePlan = sitePlanPayload;/);
});

test('data layer: a signed client stored with a plan keeps it; generic writes cannot set or change it', async () => {
  writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([signed({ businessName: 'Signed AS', status: 'active' })], null, 2));
  const sales = await import('../data/sales.js');
  sales.noteSalesStoreReplaced();
  const updatedByBody = sales.updateSalesClient('c1', { sitePlan: { tierId: 'tier-3-ecommerce', services: ['site', 'ecom'] }, notes: 'n' });
  assert.equal(updatedByBody.sitePlan, undefined, 'updateSalesClient never writes a plan');
  assert.equal(updatedByBody.notes, 'n');
  const created = sales.createSalesClient({ businessName: 'New AS', sitePlan: { tierId: 'tier-3-ecommerce', services: ['site'] }, delivery: { stage: 'live' } });
  assert.equal(created.sitePlan, undefined);
  assert.equal(created.delivery, undefined);
  const stored = sales.setSalesSitePlan('c1', { status: 'active', tierId: 'tier-2-seo', services: ['site', 'seo'], source: 'backfill' }, { by: 'test', reason: 'backfill:offer', now: NOW });
  assert.equal(stored.sitePlan.tierId, 'tier-2-seo');
  assert.equal(stored.sitePlan.history.length, 1);
  assert.equal(sales.setSalesSitePlan('c1', stored.sitePlan, { by: 'test' }).sitePlan.history.length, 1, 'an unchanged plan adds no history');
  const kept = sales.updateSalesClient('c1', { notes: 'again' });
  assert.deepEqual(kept.sitePlan, stored.sitePlan);
  const quote = sales.updateSalesClient('c1', { details: { meetingQuote: { tierId: 'seo', tierExplicit: true } } });
  assert.equal(quote.details.meetingQuote.tierExplicit, true);
  const plain = sales.updateSalesClient('c1', { details: { meetingQuote: { tierId: 'seo' } } });
  assert.equal(Object.hasOwn(plain.details.meetingQuote, 'tierExplicit'), false, 'stored only when true');
});

test('meeting-notes calculator: picking a package or custom marks the tier as picked; the quote keeps the mark', () => {
  const modal = readFileSync(join(root, 'app', 'pages', 'sales', 'MeetingNotesModal.tsx'), 'utf8').replace(/\r\n/g, '\n');
  for (const name of ['applyNamed', 'applyCustom']) {
    const start = modal.indexOf(`function ${name}(`);
    assert.ok(start > 0, name);
    assert.match(modal.slice(start, modal.indexOf('\n  }\n', start)), /tierExplicit: true/, name);
  }
  const pricing = readFileSync(join(root, 'app', 'pages', 'sales', 'websitePricing.ts'), 'utf8');
  assert.ok(pricing.includes('...(input.tierExplicit === true ? { tierExplicit: true } : {})'), 'the browser normalizer keeps the mark');
  assert.ok(pricing.includes('...(quote.tierExplicit === true ? { tierExplicit: true } : {})'), 'the active package keeps the mark');
});
