import { WEBSITE_TIERS } from '../../../lib/website-tiers.js';

export type PricingService = {
  id: string;
  name: string;
  price: number;
  scalesWithPages?: boolean;
  oneTimeMonths?: number;
};

export type MeetingQuotePackage = {
  tierId: string;
  customMode: boolean;
  oneTime: boolean;
  pages: number;
  selected: string[];
  oneTimeAddOns: string[];
};

export type MeetingQuoteState = MeetingQuotePackage & {
  customSections: string;
  startDate: string;
  productNotes: string;
  productGoal: string;
  identity: string;
  /** Second alternative package. Absent/null = a single offer. */
  altQuote?: MeetingQuotePackage | null;
  /** Which package the notes calculator is editing. */
  activeOfferIndex?: 0 | 1;
};

// Service ids each named package bundles in (prices and page counts come from lib/website-tiers.js).
const TIER_SERVICE_IDS: Record<string, string[]> = {
  starter: ['blog'],
  seo: ['seo', 'social', 'email', 'blog'],
  nettbutikk: ['seo', 'social', 'email', 'ecom', 'dashboard', 'blog', 'multilingual'],
};

export const PRICING = {
  oneTimeMultiplier: 9,
  minMonthly: 999,
  // includedPages is the à-la-carte baseline; named packages use their own `pages` (5 / 7 / 10).
  pageScaling: { includedPages: 5, ratePercent: 0.1 },
  packagePrices: Object.fromEntries(
    WEBSITE_TIERS.map((tier) => [tier.marketingId, tier.monthlyExMva]),
  ) as Record<string, number>,
  alwaysOn: [{ id: 'webdesign', name: 'Layout, responsivitet og generell webdesign', price: 0 }] as PricingService[],
  defaultOn: [
    { id: 'meeting', name: 'Veilednings- og gjennomgangsmøte', price: 0 },
    { id: 'domain', name: 'Koble til domene', price: 0 },
  ] as PricingService[],
  base: [
    { id: 'hosting', name: 'Hosting & vedlikehold', price: 600, scalesWithPages: true },
    { id: 'contact', name: 'Kontaktskjema & standard seksjoner', price: 200 },
    { id: 'changes', name: 'Innholdsendringer (opptil 4/mnd)', price: 199 },
  ] as PricingService[],
  tiers: [
    ...WEBSITE_TIERS.map((tier) => ({
      id: tier.marketingId,
      label: tier.shortName,
      delivery: `${tier.deliveryWeeks} uker`,
      pages: tier.pages,
      includes: TIER_SERVICE_IDS[tier.marketingId] || [],
    })),
    { id: 'custom', label: 'Skreddersydd', delivery: 'Etter avtale', pages: 5, includes: [] as string[] },
  ],
  addOns: [
    { id: 'seo', name: 'SEO optimalisering (Google, Google Maps og AI-søk)', price: 300, scalesWithPages: true },
    { id: 'social', name: 'Anmeldelser & sosiale medier synk', price: 100 },
    { id: 'email', name: 'E-postliste innsamling', price: 100 },
    { id: 'ecom', name: 'Nettbutikk-funksjonalitet', price: 900 },
    { id: 'dashboard', name: 'Analyse-dashbord', price: 150 },
    { id: 'blog', name: 'Blogg-integrasjon', price: 400 },
    { id: 'unlimited', name: 'Ubegrenset innholdsendringer (oppgradering fra 4/mnd)', price: 1000, oneTimeMonths: 6 },
  ] as PricingService[],
  multilingual: {
    id: 'multilingual',
    name: 'Flerspråklig funksjonalitet',
    price: 690,
    scalesWithPages: true,
  } as PricingService,
  oneTimeAddOns: [
    { id: 'pos', name: 'Koble opp til kassasystem', price: 6000 },
    { id: 'thirdpartyhost', name: 'Koble til tredjeparts host og domene', price: 2500 },
  ] as PricingService[],
};

export function emptyMeetingQuotePackage(): MeetingQuotePackage {
  return {
    tierId: 'starter',
    customMode: false,
    oneTime: false,
    pages: PRICING.pageScaling.includedPages,
    selected: presetIds('starter'),
    oneTimeAddOns: [],
  };
}

export function emptyMeetingQuote(): MeetingQuoteState {
  return {
    ...emptyMeetingQuotePackage(),
    customSections: '',
    startDate: '',
    productNotes: '',
    productGoal: '',
    identity: '',
    altQuote: null,
    activeOfferIndex: 0,
  };
}

export function normalizeMeetingQuotePackage(value: unknown, fallback?: MeetingQuotePackage): MeetingQuotePackage {
  const base = fallback || emptyMeetingQuotePackage();
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const selected = Array.isArray(input.selected)
    ? input.selected.map((id) => String(id || '').trim()).filter(Boolean)
    : base.selected;
  const oneTimeAddOns = Array.isArray(input.oneTimeAddOns)
    ? input.oneTimeAddOns.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const pages = Number(input.pages);
  return {
    tierId: String(input.tierId || base.tierId),
    customMode: Boolean(input.customMode),
    oneTime: Boolean(input.oneTime),
    pages: Number.isFinite(pages) && pages >= 1 ? Math.round(pages) : base.pages,
    selected,
    oneTimeAddOns,
  };
}

export function cloneMeetingQuotePackage(source: MeetingQuotePackage): MeetingQuotePackage {
  return {
    ...source,
    selected: [...source.selected],
    oneTimeAddOns: [...source.oneTimeAddOns],
  };
}

export function hasAltMeetingQuote(quote: Pick<MeetingQuoteState, 'altQuote'> | null | undefined) {
  return Boolean(quote?.altQuote);
}

export function activeMeetingQuoteIndex(quote: Pick<MeetingQuoteState, 'altQuote' | 'activeOfferIndex'> | null | undefined): 0 | 1 {
  return quote?.altQuote && quote.activeOfferIndex === 1 ? 1 : 0;
}

export function activeMeetingQuotePackage(quote: MeetingQuoteState): MeetingQuotePackage {
  if (activeMeetingQuoteIndex(quote) === 1 && quote.altQuote) return quote.altQuote;
  return {
    tierId: quote.tierId,
    customMode: quote.customMode,
    oneTime: quote.oneTime,
    pages: quote.pages,
    selected: quote.selected,
    oneTimeAddOns: quote.oneTimeAddOns,
  };
}

export function withActiveMeetingQuotePackage(quote: MeetingQuoteState, patch: Partial<MeetingQuotePackage>): MeetingQuoteState {
  if (activeMeetingQuoteIndex(quote) === 1 && quote.altQuote) {
    return { ...quote, altQuote: { ...quote.altQuote, ...patch } };
  }
  return { ...quote, ...patch };
}

export function addAltMeetingQuote(quote: MeetingQuoteState): MeetingQuoteState {
  if (quote.altQuote) return { ...quote, activeOfferIndex: 1 };
  return {
    ...quote,
    altQuote: cloneMeetingQuotePackage(activeMeetingQuotePackage({ ...quote, activeOfferIndex: 0 })),
    activeOfferIndex: 1,
  };
}

export function removeAltMeetingQuote(quote: MeetingQuoteState): MeetingQuoteState {
  return { ...quote, altQuote: null, activeOfferIndex: 0 };
}

export function normalizeMeetingQuote(value: unknown): MeetingQuoteState {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const fallback = emptyMeetingQuote();
  const pkg = normalizeMeetingQuotePackage(input, fallback);
  const altRaw = input.altQuote;
  const altQuote = altRaw && typeof altRaw === 'object'
    ? normalizeMeetingQuotePackage(altRaw, pkg)
    : null;
  const active = Number(input.activeOfferIndex);
  return {
    ...pkg,
    customSections: String(input.customSections || ''),
    startDate: String(input.startDate || ''),
    productNotes: String(input.productNotes || ''),
    productGoal: String(input.productGoal || ''),
    identity: String(input.identity || ''),
    altQuote,
    activeOfferIndex: altQuote && active === 1 ? 1 : 0,
  };
}

export function fmtKr(n: number) {
  return `${Math.round(n).toLocaleString('nb-NO')} kr`;
}

export function allPaidRecurringServices() {
  return [...PRICING.defaultOn, ...PRICING.base, ...PRICING.addOns, PRICING.multilingual];
}

export function getTier(id: string) {
  return PRICING.tiers.find((tier) => tier.id === id) || PRICING.tiers[0];
}

export function presetIds(tierId: string) {
  const ids = new Set([
    ...PRICING.defaultOn.map((s) => s.id),
    ...PRICING.base.map((b) => b.id),
  ]);
  (getTier(tierId).includes || []).forEach((id) => ids.add(id));
  return [...ids];
}

export function customBaselineIds() {
  return [...PRICING.defaultOn.map((s) => s.id), ...PRICING.base.map((b) => b.id)];
}

/** Pages covered before the extra-page surcharge: the named package's own count, or the à-la-carte baseline. */
export function includedPagesFor(tierId?: string, customMode = false) {
  if (customMode || !tierId || tierId === 'custom') return PRICING.pageScaling.includedPages;
  return getTier(tierId).pages || PRICING.pageScaling.includedPages;
}

export function extraPages(pages: number, tierId?: string, customMode = false) {
  return Math.max(0, pages - includedPagesFor(tierId, customMode));
}

export function adjustedPrice(item: PricingService, pages: number, tierId?: string, customMode = false) {
  const perPage = item.scalesWithPages ? item.price * PRICING.pageScaling.ratePercent : 0;
  const scale = perPage * extraPages(pages, tierId, customMode);
  return { base: item.price, perPage, scale, total: item.price + scale };
}

function packageIds(tierId: string) {
  if (!tierId || tierId === 'custom') return new Set<string>();
  return new Set(presetIds(tierId));
}

function isTimeCapped(item: PricingService, oneTime: boolean) {
  return Boolean(item.oneTimeMonths && oneTime);
}

function recurringUnit(item: PricingService, pages: number, oneTime: boolean, tierId?: string, customMode = false) {
  if (isTimeCapped(item, oneTime)) return 0;
  return adjustedPrice(item, pages, tierId, customMode).total;
}

export function quotedMonthly(quote: MeetingQuotePackage) {
  const selected = new Set(quote.selected);
  if (quote.customMode || quote.tierId === 'custom') {
    let monthly = 0;
    allPaidRecurringServices().forEach((item) => {
      if (selected.has(item.id)) monthly += recurringUnit(item, quote.pages, quote.oneTime, 'custom', true);
    });
    return Math.max(PRICING.minMonthly, monthly);
  }
  const pkg = packageIds(quote.tierId);
  let scale = 0;
  let addons = 0;
  allPaidRecurringServices().forEach((item) => {
    if (pkg.has(item.id)) scale += adjustedPrice(item, quote.pages, quote.tierId).scale;
    else if (selected.has(item.id)) addons += recurringUnit(item, quote.pages, quote.oneTime, quote.tierId);
  });
  return (PRICING.packagePrices[quote.tierId] || PRICING.minMonthly) + scale + addons;
}

export function setupCost(quote: MeetingQuotePackage) {
  const picked = new Set(quote.oneTimeAddOns);
  return PRICING.oneTimeAddOns
    .filter((item) => picked.has(item.id))
    .reduce((sum, item) => sum + item.price, 0);
}

export function cappedOneTimeCharge(quote: MeetingQuotePackage) {
  if (!quote.oneTime) return 0;
  const selected = new Set(quote.selected);
  let sum = 0;
  allPaidRecurringServices().forEach((item) => {
    if (!item.oneTimeMonths || !selected.has(item.id)) return;
    sum += item.price * item.oneTimeMonths;
  });
  return sum;
}

export function grandTotal(quote: MeetingQuotePackage) {
  const monthly = quotedMonthly(quote);
  const setup = setupCost(quote);
  const capped = cappedOneTimeCharge(quote);
  if (quote.oneTime) return monthly * PRICING.oneTimeMultiplier + setup + capped;
  return monthly;
}

export function packageService(quote: MeetingQuotePackage, itemId: string) {
  if (quote.customMode || quote.tierId === 'custom') return false;
  if (PRICING.alwaysOn.some((item) => item.id === itemId)) return true;
  return packageIds(quote.tierId).has(itemId);
}

export function namedPackageMonthly(tierId: string, pages: number) {
  const pkg = packageIds(tierId);
  let scale = 0;
  allPaidRecurringServices().forEach((item) => {
    if (pkg.has(item.id)) scale += adjustedPrice(item, pages, tierId).scale;
  });
  return (PRICING.packagePrices[tierId] || PRICING.minMonthly) + scale;
}
