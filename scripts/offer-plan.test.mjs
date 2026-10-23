// WS8.2: each offer alternative carries a machine-readable plan and a pricing snapshot. Offers
// built before this keep rendering and hashing exactly as before (golden values from b5fe3a7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-offer-plan-'));
process.env.APP_DATA_DIR = DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 'delivery-plan-golden.json'), 'utf8'));
const quote = await import('../lib/offer-from-quote.js');
const offers = await import('../data/sales-offers.js');

const QUOTES = {
  starterAddSeo: { tierId: 'starter', selected: ['meeting', 'domain', 'hosting', 'contact', 'changes', 'blog', 'seo'], pages: 6 },
  seoOnce: { tierId: 'seo', oneTime: true, selected: ['unlimited'], pages: 7, oneTimeAddOns: ['pos'] },
  shopDual: { tierId: 'nettbutikk', selected: [], pages: 12, altQuote: { tierId: 'starter', selected: ['email'], pages: 5 } },
  custom: { tierId: 'custom', customMode: true, selected: ['hosting', 'contact', 'changes', 'ecom', 'seo', 'multilingual'], pages: 8, oneTimeAddOns: ['thirdpartyhost'] },
};

function withoutPlan(pkg) {
  const { plan, pricing, ...rest } = pkg;
  return rest;
}

test('quote-built offers: products, prices and lines are exactly what they were before plans', () => {
  for (const [name, input] of Object.entries(QUOTES)) {
    const built = quote.buildOfferFromMeetingQuote(input);
    assert.deepEqual({ ...withoutPlan(built), alternatives: built.alternatives.map(withoutPlan) }, golden.quotes[name], name);
  }
});

test('quote-built offers: a custom quote gives an explicit plan with site and the ticked services', () => {
  const built = quote.buildOfferFromMeetingQuote({ tierId: 'custom', customMode: true, selected: ['ecom', 'seo'], pages: 5 });
  const { plan } = built.alternatives[0];
  for (const id of ['site', 'ecom', 'seo']) assert.ok(plan.services.includes(id), id);
  assert.equal(plan.tierId, 'custom');
  assert.equal(plan.derived, false);
  assert.equal(plan.needsConfirmation, false);
  assert.deepEqual(built.alternatives[0].pricing, { oneTimeMultiplier: 9, source: 'code-default' });
  assert.deepEqual(built.plan, plan, 'the first alternative is also the top-level plan');
});

test('quote-built offers: tier plans add ticked extras; a dual offer has two plans', () => {
  const extra = quote.buildOfferFromMeetingQuote(QUOTES.starterAddSeo).alternatives[0].plan;
  assert.equal(extra.tierId, 'tier-1-standard');
  assert.deepEqual(extra.services, ['site', 'changes', 'seo', 'blog']);
  assert.equal(extra.pages, 6);
  const once = quote.buildOfferFromMeetingQuote(QUOTES.seoOnce).alternatives[0].plan;
  assert.equal(once.billing, 'once');
  assert.deepEqual(once.oneTimeAddOns, ['pos']);
  assert.ok(once.services.includes('unlimited'));
  const dual = quote.buildOfferFromMeetingQuote(QUOTES.shopDual);
  assert.deepEqual(dual.alternatives.map((alternative) => alternative.plan.tierId), ['tier-3-ecommerce', 'tier-1-standard']);
  assert.ok(dual.alternatives[1].plan.services.includes('email'), 'the ticked extra on alternative 2');
});

test('offers without plans keep their content hash', () => {
  for (const [name, offer] of Object.entries(golden.legacyOffers)) {
    const normalized = offers.normalizeSalesOffer(offer);
    assert.equal(offers.offerContentHash(normalized), golden.offerHashes[name], name);
    assert.equal(offers.offerPlanFingerprint(normalized), null, name);
  }
});

test('a stored plan, pricing or DPA version enters the hash; a change to the plan changes it', () => {
  const built = quote.buildOfferFromMeetingQuote(QUOTES.custom);
  const base = { id: 'o', salesClientId: 'c', status: 'draft', tierId: built.tierId, products: built.products, alternatives: built.alternatives, email: { subject: 's', html: '<p>x</p>' } };
  const withPlans = offers.normalizeSalesOffer(base);
  const withoutPlans = offers.normalizeSalesOffer({ ...base, alternatives: built.alternatives.map(withoutPlan) });
  assert.notEqual(offers.offerContentHash(withPlans), offers.offerContentHash(withoutPlans));
  const changed = offers.normalizeSalesOffer({ ...base, alternatives: [{ ...built.alternatives[0], plan: { ...built.alternatives[0].plan, services: ['site'] } }] });
  assert.notEqual(offers.offerContentHash(changed), offers.offerContentHash(withPlans));
  assert.equal(offers.offerContentHash(offers.normalizeSalesOffer(withPlans)), offers.offerContentHash(withPlans), 'stable across normalizing');
});

test('flattening a dual offer keeps the chosen plan', () => {
  const built = quote.buildOfferFromMeetingQuote(QUOTES.shopDual);
  const offer = offers.normalizeSalesOffer({ id: 'o', salesClientId: 'c', tierId: built.tierId, products: built.products, alternatives: built.alternatives });
  assert.equal(offer.alternatives.length, 2);
  const flattened = offers.flattenOfferToChosen(offer, 1);
  assert.equal(flattened.plan.tierId, 'tier-1-standard');
  assert.deepEqual(flattened.pricing, { oneTimeMultiplier: 9, source: 'code-default' });
  assert.equal(flattened.alternatives[1].plan.tierId, 'tier-1-standard');
});

test('plans normalize; one this code cannot read is kept as stored but never used or hashed; pricing needs a multiplier', () => {
  assert.equal(offers.normalizeOfferPlan({ tierId: 'tier-1-standard' }), null, 'no services');
  assert.equal(offers.normalizeOfferPlan({ tierId: 'bogus', services: ['site'] }), null, 'unknown tier');
  assert.deepEqual(offers.normalizeOfferPlan({ tierId: 'custom', services: ['shop', 'site'], billing: 'once', oneTimeAddOns: ['POS', 'x'], catalogType: 'menu' }), {
    tierId: 'custom', services: ['site', 'blog', 'ecom'], pages: 0, oneTimeAddOns: ['pos'], billing: 'once', catalogType: 'menu', derived: false, needsConfirmation: false,
  });
  assert.equal(offers.normalizeOfferPricing({ monthlyExMva: 1499 }), null);
  assert.deepEqual(offers.normalizeOfferPricing({ oneTimeMultiplier: '9', source: 'settings' }), { oneTimeMultiplier: 9, source: 'settings' });
  const offer = offers.normalizeSalesOffer({ id: 'o', products: [{ name: 'x', priceExMva: 1 }], alternatives: [{ products: [{ name: 'x', priceExMva: 1 }], plan: { tierId: 'tier-1-standard', laterShape: true } }] });
  assert.deepEqual(offer.alternatives[0].plan, { tierId: 'tier-1-standard', laterShape: true }, 'kept for the batch that wrote it');
  assert.equal(offers.offerPlanFingerprint(offer), null, 'not part of the hash');
  const cleared = offers.normalizeSalesOffer({ ...offer, alternatives: [{ ...offer.alternatives[0], plan: null }] });
  assert.equal(Object.hasOwn(cleared.alternatives[0], 'plan'), false, 'null clears it');
});

test('store: only the meeting-quote rebuild writes plans; a rep body cannot', async () => {
  writeFileSync(join(DATA_DIR, 'sales-offers.json'), '[]');
  const created = offers.createSalesOffer({ salesClientId: 'c1', tierId: 'tier-1-standard', ...(() => {
    const built = quote.buildOfferFromMeetingQuote({ tierId: 'starter', selected: [], pages: 5 });
    return { products: built.products, alternatives: built.alternatives };
  })() }, { actor: 'rep' });
  assert.equal(created.alternatives[0].plan.tierId, 'tier-1-standard', 'createSalesOffer keeps the built plan');

  const repBody = offers.updateSalesOffer(created.id, {
    alternatives: [{ ...created.alternatives[0], plan: { tierId: 'tier-3-ecommerce', services: ['site', 'ecom', 'unlimited'] } }],
    plan: { tierId: 'tier-3-ecommerce', services: ['site', 'ecom'] },
  }, { actor: 'rep', action: '' });
  assert.equal(repBody.alternatives[0].plan.tierId, 'tier-1-standard', 'a patch cannot change the plan');
  assert.equal(Object.hasOwn(repBody, 'plan'), false);

  const rebuilt = quote.buildOfferFromMeetingQuote({ tierId: 'seo', selected: [], pages: 7 });
  const fromQuote = offers.updateSalesOffer(created.id, { tierId: rebuilt.tierId, products: rebuilt.products, alternatives: rebuilt.alternatives }, { actor: 'meeting-quote', action: '', quotePlans: rebuilt });
  assert.equal(fromQuote.alternatives[0].plan.tierId, 'tier-2-seo', 'the server rebuild replaces the plan');
  assert.equal(fromQuote.plan.tierId, 'tier-2-seo');
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  assert.equal((server.match(/quotePlans: built/g) || []).length, 1, 'only applyMeetingQuoteToOffer passes quotePlans');
  assert.match(server, /\{ actor: 'meeting-quote', action: '', quotePlans: built \}/);
});
