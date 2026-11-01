#!/usr/bin/env node
/**
 * The client-facing texts the legal catalog switch may change, computed from synthetic offers:
 * contract articles, HTML and PDF bytes (Norwegian and English, tier, custom, dual, one-time fees
 * and prices with VAT, each as a sent offer and as an unsent one in every status before sending;
 * as SHA-256 hashes, the PDF with time frozen by the caller), the contract copy, the public
 * pricing cards, the offer-letter product blocks, the offers built from a meeting quote and the
 * plans derived from offers whose rep-typed lines equal lines the catalog gives a tier.
 *
 * The committed baseline (scripts/fixtures/legal/dark-surface-baseline.json) was written from the
 * code before the catalog existed. With the switch off, darkSurface() must equal it byte for byte.
 *
 *   node scripts/legal/dark-surface.mjs --write   rewrite the baseline (only when the legacy texts change on purpose)
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BASELINE_PATH = new URL('../fixtures/legal/dark-surface-baseline.json', import.meta.url);

const SENT_AT = '2026-05-04T09:00:00.000Z';

// The date printed on every fixture contract (a sent offer's sentAt; unsent offers have none).
const CONTRACT_DATE = SENT_AT;

export const FIXTURE_CLIENT = Object.freeze({
  id: 'legal-fixture-client',
  businessName: 'Eksempel Bakeri AS',
  orgNumber: '999999999',
  contactPerson: 'Kari Nordmann',
  contactEmail: 'kari@example.com',
  address: 'Eksempelveien 1, 0001 Oslo',
});

const CLIENT = FIXTURE_CLIENT;

function tierOffer(tierId, extra = {}) {
  return {
    id: `offer-${tierId}`,
    salesClientId: CLIENT.id,
    status: 'sent',
    tierId,
    sentAt: SENT_AT,
    dueDate: '2026-06-01',
    products: [],
    ...extra,
  };
}

const SENT_OFFERS = {
  tier1: tierOffer('tier-1-standard'),
  tier2: tierOffer('tier-2-seo'),
  tier3: tierOffer('tier-3-ecommerce'),
  tier2En: tierOffer('tier-2-seo', { contractLanguage: 'en' }),
  tier1Fees: tierOffer('tier-1-standard', { oneTimeFees: [{ name: 'Kassasystem-oppkobling', price: 4000 }] }),
  tier2Mva: tierOffer('tier-2-seo', { mvaIncluded: true }),
  custom: tierOffer('custom', {
    products: [{ kind: 'custom', name: 'Skreddersydd nettside', pages: 6, priceExMva: 2500, deliveryWeeks: 4, includes: ['Nettside med booking', 'Hosting og vedlikehold'] }],
    contract: { summary: { title: 'Skreddersydd omfang', monthlyExMva: 2500, deliveryWeeks: 4, products: [{ name: 'Skreddersydd nettside', pages: 6, priceExMva: 2500, includes: ['Nettside med booking', 'Hosting og vedlikehold'] }], extraTerms: ['Booking settes opp mot kundens kalender'], scopeSummary: '' } },
  }),
  dual: tierOffer('tier-1-standard', {
    alternatives: [
      { tierId: 'tier-1-standard', products: [{ kind: 'tier', tierId: 'tier-1-standard', name: 'Nettside – Standard', priceExMva: 499, deliveryWeeks: 2 }] },
      { tierId: 'tier-2-seo', products: [{ kind: 'tier', tierId: 'tier-2-seo', name: 'Nettside – SEO', priceExMva: 1499, deliveryWeeks: 2 }] },
    ],
  }),
};

// The statuses before sending. The contract of an unsent offer is the one the client sees in the
// preview, gets as the PDF attached at send, and signs, so the switch must not change it while off.
const UNSENT_STATUSES = Object.freeze({ Draft: 'draft', ReviewRequested: 'review-requested', Verified: 'verified' });

function unsentOffers() {
  const out = {};
  for (const [key, offer] of Object.entries(SENT_OFFERS)) {
    for (const [suffix, status] of Object.entries(UNSENT_STATUSES)) {
      out[`${key}${suffix}`] = { ...offer, id: `${offer.id}-${status}`, status, sentAt: '' };
    }
  }
  return out;
}

export const FIXTURE_OFFERS = Object.freeze({ ...SENT_OFFERS, ...unsentOffers() });

// Offers whose rep-typed lines equal offer-letter lines the legal catalog gives a tier. With the
// switch off and no legal stamp, the plan derived from them must not change.
const PLAN_OFFERS = {
  tier1RepLines: {
    id: 'offer-plan-tier1',
    salesClientId: CLIENT.id,
    status: 'sent',
    tierId: 'tier-1-standard',
    products: [{ id: 'prod-plan-tier1', kind: 'tier', tierId: 'tier-1-standard', name: 'Nettside – Standard', pages: 5, priceExMva: 499, deliveryWeeks: 2, includes: ['Grunnleggende SEO og sitemap', 'Kontaktskjema og juridiske sider', 'Opptil 4 endringer/mnd'] }],
  },
  tier2RepLines: {
    id: 'offer-plan-tier2',
    salesClientId: CLIENT.id,
    status: 'sent',
    tierId: 'tier-2-seo',
    products: [{ id: 'prod-plan-tier2', kind: 'tier', tierId: 'tier-2-seo', name: 'Nettside – SEO', pages: 7, priceExMva: 1499, deliveryWeeks: 2, includes: ['Blogg der du publiserer egne innlegg', 'Asoldi-nettverk for relevante lenker', 'Anmeldelser og lenker til sosiale medier'] }],
  },
  customRepLines: {
    id: 'offer-plan-custom',
    salesClientId: CLIENT.id,
    status: 'sent',
    tierId: 'custom',
    products: [{ id: 'prod-plan-custom', kind: 'custom', name: 'Skreddersydd nettside', pages: 6, priceExMva: 2500, deliveryWeeks: 4, includes: ['Grunnleggende SEO og sitemap', 'Blogg der du publiserer egne innlegg'] }],
  },
};

export const FIXTURE_PLAN_OFFERS = Object.freeze({
  ...PLAN_OFFERS,
  tier1RepLinesDraft: { ...PLAN_OFFERS.tier1RepLines, id: 'offer-plan-tier1-draft', status: 'draft' },
  tier2RepLinesVerified: { ...PLAN_OFFERS.tier2RepLines, id: 'offer-plan-tier2-verified', status: 'verified' },
});

export const FIXTURE_QUOTES = Object.freeze({
  starter: { tierId: 'starter', selected: [], pages: 5 },
  seo: { tierId: 'seo', selected: [], pages: 7 },
  shop: { tierId: 'nettbutikk', selected: [], pages: 10 },
  starterOnce: { tierId: 'starter', selected: [], pages: 5, oneTime: true },
  dual: { tierId: 'starter', selected: [], pages: 5, altQuote: { tierId: 'nettbutikk', selected: [], pages: 10 } },
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Everything the switch may change, as plain JSON. `pdf: true` adds the PDF hashes; the caller
 * must freeze Date first (pdfkit stamps the creation time).
 */
export async function darkSurface({ pdf = false } = {}) {
  const { contractHtmlForOffer } = await import('../../lib/offer-contract-html.js');
  const { buildContractPdf, contractArticleModel, contractInputsForOffer } = await import('../../lib/offer-contract-pdf.js');
  const { contractCopy, contractMeanings, localizedTierContract } = await import('../../lib/offer-contract-copy.js');
  const { WEBSITE_TIERS, tierOfferProduct, toWebsiteProduct, toClientWebsitePlan } = await import('../../lib/website-tiers.js');
  const { productsWithTier } = await import('../../lib/offer-email.js');
  const { buildOfferFromMeetingQuote } = await import('../../lib/offer-from-quote.js');
  const { planFromOfferAlternative } = await import('../../lib/site-plan.js');

  const out = { contracts: {}, copy: {}, tiers: {}, quotes: {}, plans: {} };
  for (const [key, offer] of Object.entries(FIXTURE_OFFERS)) {
    const inputs = contractInputsForOffer(offer, CLIENT);
    const article = contractArticleModel({ client: CLIENT, ...inputs, date: new Date(CONTRACT_DATE) });
    const entry = {
      htmlSha256: sha256(contractHtmlForOffer(offer, CLIENT)),
      articleSha256: sha256(JSON.stringify(plain({ ...article, copy: undefined }))),
    };
    if (pdf) {
      const buffer = await buildContractPdf({ client: CLIENT, ...inputs, date: new Date(CONTRACT_DATE) });
      entry.pdfSha256 = sha256(buffer);
    }
    out.contracts[key] = entry;
  }
  for (const language of ['nb', 'en']) {
    const t = contractCopy(language);
    out.copy[language] = sha256(JSON.stringify(plain({
      ...t,
      introOpen: t.introOpen('Asoldi', CLIENT.businessName),
      pagesBit: t.pagesBit(5),
      forProvider: t.forProvider('Asoldi'),
      forClient: t.forClient(CLIENT.businessName),
      signatureOf: t.signatureOf(CLIENT.contactPerson),
      pdfTitle: t.pdfTitle('Nivå 1'),
      pdfSubject: t.pdfSubject(CLIENT.businessName),
      meanings: contractMeanings(language),
    })));
  }
  for (const tier of WEBSITE_TIERS) {
    out.tiers[tier.id] = plain({
      pricingCard: toWebsiteProduct(tier),
      clientPlan: toClientWebsitePlan(tier),
      offerProduct: tierOfferProduct(tier),
      productsWithTier: productsWithTier([], tier.id),
      contractNb: localizedTierContract(tier, 'nb'),
      contractEn: localizedTierContract(tier, 'en'),
    });
  }
  for (const [key, quote] of Object.entries(FIXTURE_QUOTES)) {
    out.quotes[key] = plain(buildOfferFromMeetingQuote(quote));
  }
  for (const [key, offer] of Object.entries(FIXTURE_PLAN_OFFERS)) {
    out.plans[key] = plain(planFromOfferAlternative(offer));
  }
  return out;
}

export function formatSurface(surface) {
  return `${JSON.stringify(surface, null, 2)}\n`;
}

async function main() {
  if (!process.argv.includes('--write')) {
    process.stdout.write(formatSurface(await darkSurface()));
    return;
  }
  const { mock } = await import('node:test');
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-05-04T09:00:00.000Z') });
  const surface = await darkSurface({ pdf: true });
  mock.timers.reset();
  writeFileSync(BASELINE_PATH, formatSurface(surface));
  console.log(`Wrote ${BASELINE_PATH.pathname}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
