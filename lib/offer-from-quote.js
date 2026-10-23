/**
 * Turns the meeting-notes calculator into the offer's package, price and variation lines.
 * Page caps match the tiers: tier 1 = 5, tier 2 = 7, tier 3 = 10. Extra pages are billed only above that.
 * "Koble til tredjeparts host" forces engangsbetaling and is included in that one-time price.
 *
 * Every package also carries a machine-readable `plan` (WS8.2): tier, services, pages, one-time
 * add-ons and billing, plus a `pricing` snapshot, so a later settings change never alters a sent
 * offer and a custom offer's services are known without reading its text.
 */

import {
  CUSTOM_TIER_ID,
  WEBSITE_TIERS,
  calculatorServiceIdsForTier,
  formatKr,
  expandServices,
  normalizeOneTimeAddOns,
  quoteServiceToPlanService,
  servicesForTier,
  workDaysFromDeliveryWeeks,
} from './website-tiers.js';

const PAGE_RATE = 0.1;
export const ONE_TIME_MULTIPLIER = 9;
const MIN_MONTHLY = WEBSITE_TIERS[0].monthlyExMva;
const CUSTOM_INCLUDED_PAGES = 5;

// Where the pricing snapshot's multiplier came from. WS8.7 moves it to automation settings.
export const PRICING_SOURCE_DEFAULT = 'code-default';

const SERVICES = [
  { id: 'meeting', name: 'Veilednings- og gjennomgangsmøte', price: 0 },
  { id: 'domain', name: 'Koble til domene', price: 0 },
  { id: 'hosting', name: 'Hosting og vedlikehold', price: 600, scalesWithPages: true },
  { id: 'contact', name: 'Kontaktskjema og standard seksjoner', price: 200 },
  { id: 'changes', name: 'Innholdsendringer (opptil 4/mnd)', price: 199 },
  { id: 'seo', name: 'SEO-optimalisering (Google, Google Maps og AI-søk)', price: 300, scalesWithPages: true },
  { id: 'social', name: 'Anmeldelser og sosiale medier', price: 100 },
  { id: 'email', name: 'E-postliste', price: 100 },
  { id: 'ecom', name: 'Nettbutikk', price: 900 },
  { id: 'dashboard', name: 'Analyse-dashbord', price: 150 },
  { id: 'blog', name: 'Blogg', price: 400 },
  { id: 'unlimited', name: 'Ubegrensede innholdsendringer i 6 måneder', price: 1000, oneTimeMonths: 6 },
  { id: 'multilingual', name: 'Flerspråklig nettside', price: 690, scalesWithPages: true },
];

const ONE_TIME_ADDONS = [
  { id: 'pos', name: 'Koble opp til kassasystem', price: 6000 },
  { id: 'thirdpartyhost', name: 'Koble til tredjeparts host og domene', price: 2500 },
];

function text(value = '') {
  return String(value ?? '').trim();
}

function list(value) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

export function normalizeMeetingQuoteInput(raw) {
  const input = raw && typeof raw === 'object' ? raw : null;
  if (!input) return null;
  const pages = Number(input.pages);
  const tierId = text(input.tierId) || 'starter';
  const oneTimeAddOns = list(input.oneTimeAddOns);
  const host = oneTimeAddOns.includes('thirdpartyhost');
  return {
    tierId,
    customMode: Boolean(input.customMode) || tierId === 'custom',
    oneTime: Boolean(input.oneTime) || host,
    hostForced: host,
    pages: Number.isFinite(pages) && pages >= 1 ? Math.round(pages) : CUSTOM_INCLUDED_PAGES,
    selected: list(input.selected),
    oneTimeAddOns,
  };
}

function tierForQuote(quote) {
  if (quote.customMode) return null;
  return WEBSITE_TIERS.find((tier) => tier.marketingId === quote.tierId) || null;
}

function includedPages(quote, tier) {
  if (!tier) return CUSTOM_INCLUDED_PAGES;
  return Number(tier.pages) || CUSTOM_INCLUDED_PAGES;
}

function packageIds(tier) {
  if (!tier) return new Set();
  const ids = new Set(['meeting', 'domain', 'hosting', 'contact', 'changes']);
  calculatorServiceIdsForTier(tier).forEach((id) => ids.add(id));
  return ids;
}

function extraPageCount(quote, tier) {
  return Math.max(0, quote.pages - includedPages(quote, tier));
}

function serviceScale(item, extraPages) {
  if (!item.scalesWithPages || extraPages <= 0) return 0;
  return item.price * PAGE_RATE * extraPages;
}

function quotedMonthly(quote, tier) {
  const extra = extraPageCount(quote, tier);
  const selected = new Set(quote.selected);
  if (!tier) {
    let monthly = 0;
    SERVICES.forEach((item) => {
      if (!selected.has(item.id)) return;
      if (quote.oneTime && item.oneTimeMonths) return;
      monthly += item.price + serviceScale(item, extra);
    });
    return Math.max(MIN_MONTHLY, monthly);
  }
  const bundled = packageIds(tier);
  let scale = 0;
  let addons = 0;
  SERVICES.forEach((item) => {
    if (bundled.has(item.id)) scale += serviceScale(item, extra);
    else if (selected.has(item.id)) {
      if (quote.oneTime && item.oneTimeMonths) return;
      addons += item.price + serviceScale(item, extra);
    }
  });
  return (Number(tier.monthlyExMva) || MIN_MONTHLY) + scale + addons;
}

function cappedCharge(quote) {
  if (!quote.oneTime) return 0;
  const selected = new Set(quote.selected);
  return SERVICES.reduce((sum, item) => (
    item.oneTimeMonths && selected.has(item.id) ? sum + item.price * item.oneTimeMonths : sum
  ), 0);
}

function setupFees(quote) {
  const picked = new Set(quote.oneTimeAddOns);
  return ONE_TIME_ADDONS.filter((item) => picked.has(item.id));
}

function variationLines(quote, tier) {
  const lines = [];
  const extra = extraPageCount(quote, tier);
  const included = includedPages(quote, tier);
  if (extra > 0) {
    lines.push(`${extra} ekstra ${extra === 1 ? 'side' : 'sider'} utover ${included} inkludert`);
  }
  const bundled = packageIds(tier);
  const baseline = new Set(['meeting', 'domain', 'hosting', 'contact', 'changes']);
  const selected = new Set(quote.selected);
  SERVICES.forEach((item) => {
    if (!selected.has(item.id) || item.price <= 0 || bundled.has(item.id)) return;
    if (!tier && baseline.has(item.id)) return;
    lines.push(item.name);
  });
  if (quote.oneTime) lines.push(`Engangsbetaling (månedspris × ${ONE_TIME_MULTIPLIER})`);
  setupFees(quote).forEach((item) => lines.push(`${item.name} (${formatKr(item.price)} engang)`));
  return lines;
}

/**
 * The plan of one calculator package (WS8.2). A named tier brings its services; add-ons the rep
 * ticked on top are added. A custom package is `site` plus every ticked service. Both are
 * explicit (`derived:false`), so neither needs a confirmation click.
 */
export function planFromQuote(quote, tier = tierForQuote(quote)) {
  const services = new Set(tier ? servicesForTier(tier.id) : ['site']);
  const bundled = packageIds(tier);
  for (const id of quote.selected) {
    if (tier && bundled.has(id)) continue;
    const service = quoteServiceToPlanService(id);
    if (service) services.add(service);
  }
  return {
    tierId: tier ? tier.id : CUSTOM_TIER_ID,
    services: expandServices([...services]),
    pages: quote.pages,
    oneTimeAddOns: normalizeOneTimeAddOns(quote.oneTimeAddOns),
    billing: quote.oneTime ? 'once' : 'month',
    catalogType: null,
    derived: false,
    needsConfirmation: false,
  };
}

export function pricingSnapshot({ oneTimeMultiplier = ONE_TIME_MULTIPLIER, source = PRICING_SOURCE_DEFAULT } = {}) {
  return { oneTimeMultiplier, source };
}

/** The calculator service whose offer line is exactly `line` ('' when none). */
export function quoteServiceIdForIncludeLine(line = '') {
  const value = text(line);
  if (!value) return '';
  return SERVICES.find((item) => item.name === value)?.id || '';
}

/**
 * Lines the calculator writes into a package's `includes` that name no service: a tier's base
 * lines, the custom header, extra pages, the one-time note and one-time fees.
 */
export function isStructuralIncludeLine(line = '') {
  const value = text(line);
  if (!value) return true;
  if (value === 'Skreddersydd utvalg av tjenester') return true;
  if (/^\d+ ekstra sider? utover \d+ inkludert$/.test(value)) return true;
  if (/^Engangsbetaling \(månedspris × \d+(?:[.,]\d+)?\)$/.test(value)) return true;
  if (ONE_TIME_ADDONS.some((item) => value.startsWith(`${item.name} (`) && value.endsWith(' engang)'))) return true;
  return WEBSITE_TIERS.some((tier) => tier.includes.includes(value));
}

/** The one-time add-on whose fee line is `line` ('' when none). */
export function oneTimeAddOnIdForIncludeLine(line = '') {
  const value = text(line);
  return ONE_TIME_ADDONS.find((item) => value.startsWith(`${item.name} (`) && value.endsWith(' engang)'))?.id || '';
}

function buildPackageFromQuote(quote, { idPrefix = '' } = {}) {
  const tier = tierForQuote(quote);
  const monthly = quotedMonthly(quote, tier);
  const fees = setupFees(quote);
  const setup = fees.reduce((sum, item) => sum + item.price, 0);
  const once = quote.oneTime;
  const price = once ? monthly * ONE_TIME_MULTIPLIER + setup + cappedCharge(quote) : monthly;
  const baseIncludes = tier
    ? tier.includes.filter((line) => !/^Opp til \d+ hovedsider$/.test(line) && !/^Leveringstid:/.test(line))
    : ['Skreddersydd utvalg av tjenester'];
  const includes = [...baseIncludes, ...variationLines(quote, tier)];
  const product = {
    id: `${idPrefix}${tier ? `prod-${tier.id}` : 'prod-custom'}`,
    kind: tier ? 'tier' : 'custom',
    tierId: tier ? tier.id : CUSTOM_TIER_ID,
    name: tier ? tier.offerName : 'Skreddersydd nettside',
    pages: quote.pages,
    includes,
    note: once ? 'Engangsbetaling' : '',
    priceExMva: Math.round(price),
    deliveryWeeks: tier ? tier.deliveryWeeks : 0,
    deliveryWorkDays: tier ? workDaysFromDeliveryWeeks(tier.deliveryWeeks) : 0,
  };
  return {
    tierId: product.tierId,
    billing: once ? 'once' : 'month',
    oneTimeFees: once ? [] : fees.map((item) => ({ name: item.name, price: item.price })),
    products: [product],
    plan: planFromQuote(quote, tier),
    pricing: pricingSnapshot(),
  };
}

/** Package inputs on the meeting quote: Tilbud 1, plus altQuote as Tilbud 2 when present. */
export function meetingQuotePackages(raw) {
  const first = normalizeMeetingQuoteInput(raw);
  if (!first) return [];
  const list = [first];
  const altRaw = raw && typeof raw === 'object' ? raw.altQuote : null;
  if (altRaw) {
    const alt = normalizeMeetingQuoteInput(altRaw);
    if (alt) list.push(alt);
  }
  return list.slice(0, 2);
}

/**
 * @returns {null | { tierId: string, billing: 'once' | 'month', oneTimeFees: {name: string, price: number}[], products: object[], alternatives: object[] }}
 */
export function buildOfferFromMeetingQuote(raw) {
  const packages = meetingQuotePackages(raw);
  if (!packages.length) return null;
  const dual = packages.length >= 2;
  const alternatives = packages.map((quote, index) => (
    buildPackageFromQuote(quote, { idPrefix: dual ? `alt${index}-` : '' })
  ));
  const first = alternatives[0];
  return {
    tierId: first.tierId,
    billing: first.billing,
    oneTimeFees: first.oneTimeFees,
    products: first.products,
    plan: first.plan,
    pricing: first.pricing,
    alternatives,
  };
}

export function quoteBuiltIsCustom(built) {
  const alts = Array.isArray(built?.alternatives) && built.alternatives.length
    ? built.alternatives
    : (built ? [built] : []);
  return alts.some((alt) => alt?.tierId === CUSTOM_TIER_ID);
}

/** Plain-language plan + notes for admin review. Does not invent extras that are not on the quote. */
export function describeMeetingQuote(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const quote = normalizeMeetingQuoteInput(source);
  const built = quote ? buildOfferFromMeetingQuote(source) : null;
  const product = built?.products?.[0] || null;
  const selectedNames = quote
    ? SERVICES.filter((item) => quote.selected.includes(item.id) && item.price > 0).map((item) => item.name)
    : [];
  const addonNames = quote
    ? ONE_TIME_ADDONS.filter((item) => quote.oneTimeAddOns.includes(item.id)).map((item) => item.name)
    : [];
  const planParts = [];
  if (product?.name) {
    planParts.push(`${product.name}${product.pages ? ` · ${product.pages} sider` : ''}${product.priceExMva ? ` · ${formatKr(product.priceExMva)}${built?.billing === 'once' ? ' engang' : '/mnd'}` : ''}`);
  } else if (quote?.customMode) {
    planParts.push('Skreddersydd (ingen ferdig pakke valgt)');
  }
  if (quote?.oneTime) planParts.push('Engangsbetaling');
  if (selectedNames.length) planParts.push(`Tillegg: ${selectedNames.join(', ')}`);
  if (addonNames.length) planParts.push(`Engangstillegg: ${addonNames.join(', ')}`);
  return {
    plan: planParts.join('. '),
    selected: selectedNames,
    addOns: addonNames,
    notes: text(source.productNotes),
    goal: text(source.productGoal),
    identity: text(source.identity),
    customSections: text(source.customSections),
    startDate: text(source.startDate),
  };
}
