/**
 * Turns the meeting-notes calculator into the offer's package, price and variation lines.
 * Page caps match the tiers: tier 1 = 5, tier 2 = 7, tier 3 = 10. Extra pages are billed only above that.
 * "Koble til tredjeparts host" forces engangsbetaling and is included in that one-time price.
 */

import { CUSTOM_TIER_ID, WEBSITE_TIERS, formatKr, workDaysFromDeliveryWeeks } from './website-tiers.js';

const PAGE_RATE = 0.1;
const ONE_TIME_MULTIPLIER = 9;
const MIN_MONTHLY = 999;
const CUSTOM_INCLUDED_PAGES = 5;

const TIER_SERVICE_IDS = {
  starter: ['blog'],
  seo: ['seo', 'social', 'email', 'blog'],
  nettbutikk: ['seo', 'social', 'email', 'ecom', 'dashboard', 'blog', 'multilingual'],
};

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
  (TIER_SERVICE_IDS[tier.marketingId] || []).forEach((id) => ids.add(id));
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
