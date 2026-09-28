/**
 * Single source of truth for the three Asoldi website tiers.
 *
 * Consumed by:
 *  - public /pricing cards (app/data/websiteProducts.ts)
 *  - home package deals (app/components/PackageDeals.tsx)
 *  - client portal plans + Stripe mapping (app/data/clientWebsitePlans.ts, server.js)
 *  - sales meeting calculator (app/pages/sales/websitePricing.ts)
 *  - offer email + contract PDF (lib/offer-email.js, lib/offer-contract-pdf.js)
 *
 * Prices are monthly and EXCLUDING MVA. Use withMva() for the incl. price.
 */

export const MVA_RATE = 0.25;
export const CUSTOM_TIER_ID = 'custom';

const COMMON_INCLUDES = [
  'Full nettsideutvikling',
  'Koble til eget domene',
  'Hosting og vedlikehold',
  'Kontaktskjema & standard seksjoner',
  'HTML-basert side med sitemap',
  'Opptil 4 innholdsendringer/mnd',
  'Innledende veiledningsmøte',
];

const SEO_INCLUDES = [
  'SEO optimalisering for 1–3 søkeord',
  'Rangering på Google, Google Maps og AI-søk',
  'Stedstilpassede blogginnlegg (inntil 3/uke ved ønske)',
  'Asoldi-nettverk for internlenker',
  'Anmeldelser & sosiale medier synk',
  'E-postliste innsamling',
];

const TIER2_ANALYTICS_INCLUDES = [
  'Analyse-dashbord med egne rangeringer',
  'Bi-ukentlig grunrapport',
];

const TIER3_ANALYTICS_INCLUDES = [
  'Analyse-dashbord med egne rangeringer',
  'Ukentlig avansert rapport',
];

const ANALYTICS_EXCLUDES = [
  'Analyse-dashbord med egne rangeringer',
  'SEO-rapportering',
];

const ECOM_INCLUDES = [
  'Nettbutikk-funksjonalitet',
  'Flerspråklig funksjonalitet',
  'Nettbutikk-analyse (konvertering, AOV)',
  'Gjennomgangsmøte',
];

const SEO_CONTRACT_MONTHLY = {
  lead: 'Monthly SEO work included in this tier:',
  bullets: [
    'Ongoing on-page and technical SEO: keyword-focused copy, HTML structure, sitemap and domain-specific improvements',
    'Optional location- and keyword-related blog posts, up to three (3) per week when the Client wants this (typical for local service businesses)',
    'Participation in the Asoldi client backlink network: other Asoldi client sites may link to the Client and vice versa. The number of links varies with the size of the Asoldi client base',
    'Ongoing work toward the agreed 1–3 keywords in Google Search, Google Maps and AI search assistants',
  ],
};

const TIER1_CONTRACT_KPIS = {
  lead: 'Reporting and analytics:',
  bullets: [
    'This tier does not include an analytics page in the Client CMS.',
    'This tier does not include ranking reports, performance summaries or other scheduled analytics reporting.',
  ],
};

const TIER2_CONTRACT_KPIS = {
  lead: 'Reporting and KPIs (basic report, every 14 days):',
  bullets: [
    'The Client gets the analytics page in the Asoldi CMS, with client-specific keyword rankings and core performance data (traffic, bounce rate, conversion rate and related metrics)',
    'Asoldi prepares a basic report every fourteen (14) days. The report is delivered in the CMS analytics page and includes ranking data and a summary of the period',
    'A separate PDF report is not included unless agreed in writing',
    'Asoldi does not guarantee specific ranking, traffic or revenue numbers. SEO is ongoing work without a promised commercial outcome',
  ],
};

const TIER3_CONTRACT_KPIS = {
  lead: 'Reporting and KPIs (advanced report, every 7 days):',
  bullets: [
    'The Client gets the analytics page in the Asoldi CMS, with client-specific keyword rankings and in-depth performance data (traffic, bounce rate, conversion rate, ecommerce metrics and related data)',
    'Asoldi prepares an advanced report every seven (7) days. The report is delivered in the CMS analytics page and includes ranking data and a deeper summary of the period than the Tier 2 basic report',
    'Ecommerce metrics such as purchases, conversion rate and average order value (AOV) are included in the same weekly report',
    'A separate PDF report is not included unless agreed in writing',
    'Asoldi does not guarantee specific ranking, traffic or revenue numbers. SEO is ongoing work without a promised commercial outcome',
  ],
};

const ECOM_CONTRACT_MONTHLY = {
  lead: 'Monthly ecommerce work included in this tier:',
  bullets: [
    'Store, product pages, checkout and customer registration remain available and maintained while the subscription is active',
    'Reasonable catalogue and checkout adjustments within the monthly change allowance, unless a larger rebuild is agreed separately',
  ],
};

export function pagesLabel(pages) {
  return `Opp til ${pages} hovedsider`;
}

export function deliveryLabel(weeks) {
  return `Leveringstid: ${weeks} uker`;
}

function tierIncludes(pages, weeks, extra = []) {
  return [COMMON_INCLUDES[0], pagesLabel(pages), ...COMMON_INCLUDES.slice(1), ...extra, deliveryLabel(weeks)];
}

export const WEBSITE_TIERS = [
  {
    id: 'tier-1-standard',
    marketingId: 'starter',
    tierNumber: 1,
    name: 'Tier 1: Standard',
    shortName: 'Starter',
    offerName: 'Nettside – Standard',
    description: 'Simpel og funksjonell nettside.',
    monthlyExMva: 999,
    pages: 5,
    deliveryWeeks: 2,
    popular: false,
    includes: tierIncludes(5, 2),
    excludes: [...SEO_INCLUDES, ...ANALYTICS_EXCLUDES, ...ECOM_INCLUDES],
    planFeatures: ['Full nettsideutvikling', pagesLabel(5), 'Koble til eget domene', 'Hosting og vedlikehold', 'Kontaktskjema & standard seksjoner', 'HTML-basert side med sitemap'],
    dealFeatures: ['Full nettsideutvikling', pagesLabel(5), 'Hosting og vedlikehold', 'Kontaktskjema & standard seksjoner'],
    contract: {
      title: 'Tier 1 – Website Package',
      lead: 'Includes:',
      includes: [
        'Full website design and development (responsive layout, development and page layout) for a simple, non-ecommerce website, up to five (5) main pages',
        'HTML-based website with sitemap',
        'Domain connection: the Client owns their domain; Asoldi connects it to the included hosting. The Client buys a domain if they do not already have one',
        'Hosting and maintenance on the Asoldi / Hostinger network while the subscription is active',
        'Contact form and standard business sections (excluding ecommerce and reviews display)',
        'Up to four (4) smaller content changes per month (for example prices, images or text). No adding or removing sections',
        'One guidance meeting: how to use the Client CMS. The meeting is held once',
        'No advanced functionality, SEO programme, blog writing or ecommerce',
        'No analytics page in the Client CMS and no ranking or performance reporting',
      ],
      kpis: TIER1_CONTRACT_KPIS,
    },
  },
  {
    id: 'tier-2-seo',
    marketingId: 'seo',
    tierNumber: 2,
    name: 'Tier 2: SEO',
    shortName: 'SEO',
    offerName: 'Nettside – SEO',
    description: 'Optimalisert nettside for økt synlighet og konvertering.',
    monthlyExMva: 1499,
    pages: 7,
    deliveryWeeks: 2,
    popular: true,
    includes: tierIncludes(7, 2, [...SEO_INCLUDES, ...TIER2_ANALYTICS_INCLUDES]),
    excludes: [...ECOM_INCLUDES],
    planFeatures: ['Alt i Tier 1', pagesLabel(7), 'SEO optimalisering', 'Rangering på Google, Google Maps og AI-søk', 'Bi-ukentlig grunrapport', 'E-postliste innsamling'],
    dealFeatures: ['Full nettsideutvikling', pagesLabel(7), 'Hosting og vedlikehold', 'Rank høyere på Google, Google Maps og AI', 'Bi-ukentlig grunrapport'],
    contract: {
      title: 'Tier 2 – Website + SEO + Email + Analytics',
      lead: 'Includes everything in Tier 1 plus:',
      includes: [
        'Up to seven (7) main pages',
        'Keyword-optimized on-site copy',
        'SEO optimization for 1–3 keywords, including ranking work for Google Search, Google Maps and AI search assistants',
        'Reviews showcase and social-media sync (the Client logs in to connect the accounts; Asoldi does not store those passwords on the Client asoldi.com profile)',
        'Email list gathering and storage for marketing purposes',
        'The one-time guidance meeting also covers where to find and use email lists',
        'Analytics page in the Asoldi CMS, with client-specific ranking data',
        'Basic analytics report every fourteen (14) days in the CMS analytics page (ranking data and a summary of the period)',
      ],
      monthlyWork: SEO_CONTRACT_MONTHLY,
      kpis: TIER2_CONTRACT_KPIS,
    },
  },
  {
    id: 'tier-3-ecommerce',
    marketingId: 'nettbutikk',
    tierNumber: 3,
    name: 'Tier 3: Nettbutikk',
    shortName: 'Nettbutikk',
    offerName: 'Nettside – Nettbutikk',
    description: 'Full nettbutikk-funksjonalitet og analyse.',
    monthlyExMva: 1999,
    pages: 10,
    deliveryWeeks: 3,
    popular: false,
    includes: tierIncludes(10, 3, [...SEO_INCLUDES, ...TIER3_ANALYTICS_INCLUDES, ...ECOM_INCLUDES]),
    excludes: [],
    planFeatures: ['Alt i Tier 2', pagesLabel(10), 'Nettbutikk-funksjonalitet', 'Flerspråklig funksjonalitet', 'Ukentlig avansert rapport'],
    dealFeatures: ['Full nettsideutvikling', pagesLabel(10), 'Hosting og vedlikehold', 'Selg i nettbutikk – flerspråklig e-commerce', 'Ukentlig avansert rapport'],
    contract: {
      title: 'Tier 3 – Website + Ecommerce',
      lead: 'Includes everything in Tier 2 plus:',
      includes: [
        'Up to ten (10) main pages',
        'Ecommerce functionality (store setup, product pages, checkout, customer registration)',
        'Multilingual functionality (the website and store can be presented in several languages)',
        'Analytics page in the Asoldi CMS, with client-specific ranking data and in-depth ecommerce metrics',
        'Advanced analytics report every seven (7) days in the CMS analytics page (ranking data and a deeper summary than Tier 2)',
        'The one-time guidance meeting also covers ecommerce: adding products, adding customers, and connecting a payment processor, plus the analytics page',
      ],
      monthlyWork: SEO_CONTRACT_MONTHLY,
      kpis: TIER3_CONTRACT_KPIS,
      extraBlocks: [ECOM_CONTRACT_MONTHLY],
    },
  },
];

export function tierById(id = '') {
  const key = String(id || '').trim();
  return WEBSITE_TIERS.find((tier) => tier.id === key) || null;
}

export function tierByMarketingId(id = '') {
  const key = String(id || '').trim();
  return WEBSITE_TIERS.find((tier) => tier.marketingId === key) || null;
}

export function resolveTier(id = '') {
  return tierById(id) || tierByMarketingId(id);
}

export function isCustomTierId(id = '') {
  return String(id || '').trim() === CUSTOM_TIER_ID;
}

export const ANALYTICS_LEVEL_NONE = 'none';
export const ANALYTICS_LEVEL_BASIC = 'basic';
export const ANALYTICS_LEVEL_ADVANCED = 'advanced';

/** Tier 1 has no analytics. Tier 2 gets a basic report every 14 days. Tier 3 gets an advanced report every 7 days. */
export function analyticsLevelForPlan(planId = '') {
  const tier = resolveTier(planId);
  if (!tier) return ANALYTICS_LEVEL_NONE;
  if (tier.tierNumber >= 3) return ANALYTICS_LEVEL_ADVANCED;
  if (tier.tierNumber >= 2) return ANALYTICS_LEVEL_BASIC;
  return ANALYTICS_LEVEL_NONE;
}

export function reportingIntervalDaysForLevel(level = ANALYTICS_LEVEL_NONE) {
  if (level === ANALYTICS_LEVEL_ADVANCED) return 7;
  if (level === ANALYTICS_LEVEL_BASIC) return 14;
  return 0;
}

export function analyticsLevelFromFlags({ planId = '', features = {} } = {}) {
  if (features?.ecommerce) return ANALYTICS_LEVEL_ADVANCED;
  if (features?.analytics) {
    const fromPlan = analyticsLevelForPlan(planId);
    return fromPlan === ANALYTICS_LEVEL_ADVANCED ? ANALYTICS_LEVEL_ADVANCED : ANALYTICS_LEVEL_BASIC;
  }
  return analyticsLevelForPlan(planId);
}

export function withMva(amountExMva) {
  const value = Number(amountExMva);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * (1 + MVA_RATE));
}

/** Deterministic "1 499 kr" (regular spaces) so emails/PDFs look the same in Node and browsers. */
export function formatKr(amount) {
  const value = Math.round(Number(amount) || 0);
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${digits} kr`;
}

/** "1 499,-/mnd" — the format used on /pricing and in the client portal. */
export function formatMonthlyPrice(amountExMva) {
  return `${formatKr(amountExMva).replace(/ kr$/, '')},-/mnd`;
}

/** Shape used by the client portal + Stripe plan selection (was duplicated in server.js and clientWebsitePlans.ts). */
export function toClientWebsitePlan(tier) {
  return {
    id: tier.id,
    name: tier.name,
    price: formatMonthlyPrice(tier.monthlyExMva),
    setupFee: '999,- /engang',
    domainPrice: '79,-/mnd',
    emailPrice: '49,-/mnd',
    description: tier.description,
    features: [...tier.planFeatures],
    includedFeatures: [...tier.includes],
    notIncludedFeatures: [...tier.excludes],
    popular: Boolean(tier.popular),
    category: 'website',
  };
}

export function clientWebsitePlans() {
  return WEBSITE_TIERS.map(toClientWebsitePlan);
}

/** Shape used by the public /pricing cards. */
export function toWebsiteProduct(tier) {
  return {
    id: tier.marketingId,
    name: tier.shortName,
    price: formatMonthlyPrice(tier.monthlyExMva),
    description: tier.description,
    includedFeatures: [...tier.includes],
    notIncludedFeatures: [...tier.excludes],
    popular: Boolean(tier.popular),
  };
}

/** Product block used by the offer email ("Hva er inkludert") and the contract summary. */
export function tierOfferProduct(tier) {
  return {
    kind: 'tier',
    tierId: tier.id,
    name: tier.offerName,
    pages: tier.pages,
    includes: tier.includes.filter((line) => !/^Opp til \d+ hovedsider$/.test(line) && !/^Leveringstid:/.test(line)),
    note: '',
    priceExMva: tier.monthlyExMva,
    deliveryWeeks: tier.deliveryWeeks,
  };
}
