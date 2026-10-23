// Site plan (WS8.3): the offer-scoped plan of an offer alternative, the resolver for clients
// without a stored client.sitePlan, the tier readers and the Maker handoff payload.
//
// - planFromOfferAlternative(offer, index) is offer-scoped: publishing or accepting an offer always
//   uses that offer's plan, never an older offer's or the meeting quote's.
// - resolveSitePlan(client, ctx) returns the stored plan when there is one. Otherwise it ranks the
//   evidence (accepted portal alternative, a superadmin plan on the hub site, the newest sent offer,
//   an offer-kind planSource, the linked hub site's websitePlan, the portal payment plan, the meeting
//   quote only when the tier was picked explicitly) and lists lower sources that disagree as
//   conflicts. It never writes; the backfill (WS8.41) and the signing functions do.
// - makerSitePlanPayload(plan) is the plan the Maker receives (create-maker-run body, brief).
import { createHash } from 'node:crypto';
import {
  CUSTOM_TIER_ID,
  expandServices,
  featuresFromServices,
  quoteServiceToPlanService,
  resolveTier,
  servicesForTier,
  tierById,
} from './website-tiers.js';
import {
  SITE_PLAN_HANDOFF_SCHEMA,
  changesPerMonthForTier,
  normalizeOneTimeAddOns,
} from '../packages/suite/core/delivery/vocab.js';
import {
  isStructuralIncludeLine,
  normalizeMeetingQuoteInput,
  oneTimeAddOnIdForIncludeLine,
  planFromQuote,
  quoteServiceIdForIncludeLine,
} from './offer-from-quote.js';
import {
  normalizeOfferAlternatives,
  normalizeOfferPlan,
  normalizeOfferProducts,
  normalizeOfferTierId,
  offerContentHash,
} from '../data/sales-offers.js';
import { activeSitePlan, normalizeSitePlan, withPlanHistory } from './site-plan-model.js';

export { activeSitePlan, normalizeSitePlan, withPlanHistory };

export const DEFAULT_ONE_TIME_MONTHS = 6;

function text(value = '') {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function timeOf(value) {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? ms : 0;
}

function maxPages(products = []) {
  return products.reduce((max, item) => Math.max(max, Number(item?.pages) || 0), 0);
}

function sumPrice(products = []) {
  return products.reduce((sum, item) => sum + (Number(item?.priceExMva) || 0), 0);
}

/**
 * Legacy chooser kept for the portal paths (publish, accept of a flattened alternative,
 * connect-portal): the offer's tier, then the meeting quote's, then portalTierId.
 */
export function chosenWebsiteTier(client, offer) {
  return resolveTier(offer?.tierId) || resolveTier(client?.details?.meetingQuote?.tierId) || resolveTier(client?.portalTierId) || null;
}

/**
 * A plan derived from an alternative's text, for offers built before plans were stored. Lines that
 * exactly match a calculator service name give that service; tier base lines, the custom header,
 * extra pages, the one-time note and fees are neutral. Any other line, and every custom offer,
 * needs a confirmation click.
 */
export function derivePlanFromOfferAlternative(alternative = {}, { tierId = '', billing = '' } = {}) {
  const products = normalizeOfferProducts(alternative?.products);
  const tier = tierById(tierId || alternative?.tierId || '') || null;
  const services = new Set(tier ? servicesForTier(tier.id) : ['site']);
  const addOns = new Set();
  const unknownLines = [];
  for (const product of products) {
    for (const line of product.includes || []) {
      const serviceId = quoteServiceIdForIncludeLine(line);
      if (serviceId) {
        const service = quoteServiceToPlanService(serviceId);
        if (service) services.add(service);
        continue;
      }
      const addOn = oneTimeAddOnIdForIncludeLine(line);
      if (addOn) {
        addOns.add(addOn);
        continue;
      }
      if (isStructuralIncludeLine(line)) continue;
      unknownLines.push(line);
    }
  }
  const resolvedBilling = billing || alternative?.billing;
  return {
    tierId: tier ? tier.id : CUSTOM_TIER_ID,
    services: expandServices([...services]),
    pages: maxPages(products) || tier?.pages || 0,
    oneTimeAddOns: normalizeOneTimeAddOns([...addOns]),
    billing: resolvedBilling === 'once' ? 'once' : 'month',
    catalogType: null,
    derived: true,
    needsConfirmation: !tier || unknownLines.length > 0,
    unknownLines: unknownLines.slice(0, 10),
  };
}

/**
 * The plan of one offer alternative. A dual offer needs `index` (or a stored chosenOfferIndex);
 * without one the result is { ok:false, needsChoice:true } and nothing else. A single offer uses the
 * offer's own products and tier (what the composer edits). A stored plan is used while its tier and
 * billing still match the alternative; otherwise the plan is derived from the text.
 */
export function planFromOfferAlternative(offer, index = null) {
  if (!offer || typeof offer !== 'object') return { ok: false, reason: 'no-offer' };
  const alternatives = normalizeOfferAlternatives(offer.alternatives, offer);
  if (!alternatives.length) return { ok: false, reason: 'no-products' };
  const dual = alternatives.length >= 2;
  let chosen = 0;
  if (dual) {
    const pick = index === 0 || index === 1 ? index : offer.chosenOfferIndex;
    if (pick !== 0 && pick !== 1) return { ok: false, needsChoice: true, reason: 'needs-choice', offerId: text(offer.id) };
    chosen = pick;
  }
  const alternative = alternatives[chosen];
  const ownProducts = normalizeOfferProducts(offer.products);
  const products = dual || !ownProducts.length ? alternative.products : ownProducts;
  const tierId = dual ? alternative.tierId : (normalizeOfferTierId(offer.tierId) || alternative.tierId);
  const billing = alternative.billing === 'once' ? 'once' : 'month';
  const stored = normalizeOfferPlan(alternative.plan) || (!dual ? normalizeOfferPlan(offer.plan) : null);
  const fresh = Boolean(stored && (!tierId || stored.tierId === tierId) && stored.billing === billing);
  const plan = fresh ? stored : derivePlanFromOfferAlternative({ products, tierId, billing }, { tierId, billing });
  return {
    ok: true,
    plan: { ...plan, pages: plan.pages || maxPages(products) },
    stale: Boolean(stored && !fresh),
    offerId: text(offer.id),
    alternativeIndex: chosen,
    priceExMva: Math.round(sumPrice(products)),
    offerHash: offerContentHash(offer),
    dpaVersion: text(alternative.dpaVersion || (!dual ? offer.dpaVersion : '')),
  };
}

/** `menu`, `tiers` or `normal` from the client data bank's first product catalog; null without one. */
export function catalogTypeFromBank(bank = {}) {
  const catalogs = Array.isArray(bank?.productCatalogs) ? bank.productCatalogs : [];
  if (!catalogs.length) return null;
  const layout = text(catalogs[0]?.layout).toLowerCase();
  if (layout === 'meny' || layout === 'menu') return 'menu';
  if (layout === 'tiers') return 'tiers';
  return 'normal';
}

function tierPlan(tierId, extra = {}) {
  const tier = tierById(tierId);
  if (!tier) return null;
  return {
    tierId: tier.id,
    services: servicesForTier(tier.id),
    pages: tier.pages,
    oneTimeAddOns: [],
    billing: 'month',
    catalogType: null,
    derived: true,
    needsConfirmation: false,
    ...extra,
  };
}

function acceptedPortalOffers(client, portalOffers = []) {
  const id = text(client?.id);
  return (Array.isArray(portalOffers) ? portalOffers : [])
    .filter((row) => text(row?.salesClientId) === id && text(row?.acceptance?.acceptedAt))
    .sort((a, b) => timeOf(b.acceptance.acceptedAt) - timeOf(a.acceptance.acceptedAt));
}

function sentOffers(client, offers = []) {
  const id = text(client?.id);
  return (Array.isArray(offers) ? offers : [])
    .filter((offer) => text(offer?.salesClientId) === id && offer?.status === 'sent')
    .sort((a, b) => timeOf(b.sentAt || b.updatedAt) - timeOf(a.sentAt || a.updatedAt));
}

function evidenceFromOffer(result, evidence) {
  return {
    evidence,
    plan: result.plan,
    offerId: result.offerId,
    alternativeIndex: result.alternativeIndex,
    priceExMva: result.priceExMva,
    offerHash: result.offerHash,
    dpaVersion: result.dpaVersion,
  };
}

function planSourceEvidence(hubSite) {
  const source = isPlainObject(hubSite?.planSource) ? hubSite.planSource : null;
  if (!source || !['admin', 'offer'].includes(text(source.kind))) return null;
  const tierId = text(source.tierId) || text(hubSite?.websitePlan);
  const listed = expandServices(Array.isArray(source.services) ? source.services : []);
  const plan = tierById(tierId)
    ? tierPlan(tierId, listed.length ? { services: listed } : {})
    : (listed.length ? { tierId: CUSTOM_TIER_ID, services: listed, pages: 0, oneTimeAddOns: [], billing: 'month', catalogType: null, derived: true, needsConfirmation: false } : null);
  if (!plan) return null;
  if (source.billing === 'once') plan.billing = 'once';
  return { evidence: 'hub-plan-source', plan, kind: text(source.kind) };
}

/**
 * Ranked plan evidence for a client, highest first. Each entry is {evidence, plan, ...}; an entry
 * {evidence, needsChoice:true} stands for a dual offer without a chosen alternative.
 */
export function sitePlanEvidence(client = {}, { offers = [], portalOffers = [], hubSite = null, profile = null } = {}) {
  const out = [];
  const allOffers = Array.isArray(offers) ? offers : [];
  for (const row of acceptedPortalOffers(client, portalOffers)) {
    const offer = allOffers.find((entry) => text(entry?.id) === text(row.salesOfferId));
    if (!offer) continue;
    const chosen = row.acceptance?.chosenOfferIndex;
    const result = planFromOfferAlternative(offer, chosen === 0 || chosen === 1 ? chosen : null);
    if (result.ok) out.push(evidenceFromOffer(result, 'portal-accept'));
    else if (result.needsChoice) out.push({ evidence: 'portal-accept', needsChoice: true, offerId: result.offerId });
    break;
  }
  // A superadmin's plan on the hub site (planSource kind `admin`) is a later decision than a sent
  // offer, so it ranks above it; an offer-kind planSource ranks below the offer it came from.
  const sourceEntry = planSourceEvidence(hubSite);
  if (sourceEntry?.kind === 'admin') out.push(sourceEntry);
  for (const offer of sentOffers(client, allOffers)) {
    const result = planFromOfferAlternative(offer);
    if (result.ok) out.push(evidenceFromOffer(result, 'offer'));
    else if (result.needsChoice) out.push({ evidence: 'offer', needsChoice: true, offerId: result.offerId });
    break;
  }
  if (sourceEntry && sourceEntry.kind !== 'admin') out.push(sourceEntry);
  if (hubSite && text(hubSite.websitePlan)) {
    const plan = text(hubSite.websitePlan) === CUSTOM_TIER_ID
      ? { tierId: CUSTOM_TIER_ID, services: expandServices(['site']), pages: 0, oneTimeAddOns: [], billing: 'month', catalogType: null, derived: true, needsConfirmation: true }
      : tierPlan(text(hubSite.websitePlan));
    if (plan) out.push({ evidence: 'hub-site', plan });
  }
  const paid = resolveTier(profile?.payment?.planId);
  if (paid) out.push({ evidence: 'payment', plan: tierPlan(paid.id) });
  const quote = client?.details?.meetingQuote;
  if (quote && quote.tierExplicit === true) {
    const normalized = normalizeMeetingQuoteInput(quote);
    if (normalized) out.push({ evidence: 'meeting-quote', plan: { ...planFromQuote(normalized), derived: true } });
  }
  return out;
}

function unlimitedTerms(plan, signedAt, oneTimeMonths) {
  if (plan.billing !== 'once' || !plan.services.includes('unlimited')) return { unlimited: null };
  const start = timeOf(signedAt);
  if (!start) return { unlimited: null };
  const until = new Date(start);
  until.setUTCMonth(until.getUTCMonth() + oneTimeMonths);
  return { unlimited: { until: until.toISOString() } };
}

/**
 * The client's plan: the stored one when it exists, otherwise a plan resolved from the evidence
 * (status active, source `backfill`, `evidence` naming where it came from). Never writes.
 * Returns { plan, evidence, conflicts, needsChoice, needsConfirmation, skipped }.
 */
export function resolveSitePlan(client = {}, ctx = {}) {
  if (text(client?.product).toLowerCase() === 'ssu') {
    return { plan: null, evidence: '', conflicts: [], needsChoice: false, needsConfirmation: false, skipped: 'not-a-website-product' };
  }
  const stored = normalizeSitePlan(client?.sitePlan);
  if (stored) {
    return { plan: stored, evidence: 'stored', conflicts: stored.conflicts, needsChoice: false, needsConfirmation: stored.needsConfirmation && !stored.confirmedAt, skipped: '' };
  }
  const now = text(ctx.now) || new Date().toISOString();
  const entries = sitePlanEvidence(client, ctx);
  const top = entries[0] || null;
  if (!top) return { plan: null, evidence: '', conflicts: [], needsChoice: false, needsConfirmation: false, skipped: 'no-evidence' };
  if (top.needsChoice) {
    return { plan: null, evidence: top.evidence, conflicts: [], needsChoice: true, needsConfirmation: false, skipped: 'needs-choice', offerId: top.offerId };
  }
  const conflicts = entries.slice(1)
    .filter((entry) => entry.plan && entry.plan.tierId !== top.plan.tierId)
    .map((entry) => ({ source: entry.evidence, tierId: entry.plan.tierId, at: now, status: 'open' }));
  const signedAt = text(client?.contractSignedAt);
  const oneTimeMonths = Number(ctx.oneTimeMonths) > 0 ? Number(ctx.oneTimeMonths) : DEFAULT_ONE_TIME_MONTHS;
  const services = expandServices(top.plan.services);
  const catalogType = top.plan.catalogType
    || (services.includes('ecom') || services.includes('catalog') ? catalogTypeFromBank(ctx.bank) : null);
  const plan = normalizeSitePlan({
    status: 'active',
    tierId: top.plan.tierId,
    services,
    pages: top.plan.pages,
    oneTimeAddOns: top.plan.oneTimeAddOns,
    billing: top.plan.billing,
    priceExMva: top.priceExMva || 0,
    catalogType,
    languages: ['nb'],
    changesPerMonth: changesPerMonthForTier(top.plan.tierId),
    serviceTerms: unlimitedTerms({ ...top.plan, services }, signedAt, oneTimeMonths),
    source: 'backfill',
    evidence: top.evidence,
    offerId: top.offerId || '',
    alternativeIndex: top.alternativeIndex ?? null,
    offerHash: top.offerHash || '',
    dpaVersion: top.dpaVersion || '',
    signedAt,
    appliedSiteId: text(ctx.hubSite?.id),
    derived: top.plan.derived === true,
    needsConfirmation: top.plan.needsConfirmation === true,
    conflicts,
    // setSalesSitePlan adds the history entry when the plan is stored.
    history: [],
  });
  return {
    plan,
    evidence: top.evidence,
    conflicts,
    needsChoice: false,
    needsConfirmation: plan.needsConfirmation,
    skipped: '',
    unknownLines: top.plan.unknownLines || [],
  };
}

/**
 * Tier id for the developer board and website-due views: the client's plan in force, then the
 * latest offer, portalTierId and the meeting quote (the order those views used before plans).
 */
export function websiteTierIdForClient(client = {}, offer = null) {
  return activeSitePlan(client)?.tierId
    || offer?.tierId
    || client?.portalTierId
    || client?.details?.meetingQuote?.tierId
    || '';
}

export function sitePlanHash(plan) {
  const normalized = normalizeSitePlan(plan);
  if (!normalized) return '';
  const body = JSON.stringify({
    tierId: normalized.tierId,
    services: normalized.services,
    pages: normalized.pages,
    oneTimeAddOns: normalized.oneTimeAddOns,
    billing: normalized.billing,
    catalogType: normalized.catalogType,
    languages: normalized.languages,
  });
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/**
 * The plan the Maker receives (contract `site-plan/1`; the Maker reader is WS2.6). Only a plan in
 * force goes out; the Maker treats a plan as known only with `source` and `signedAt`.
 */
export function makerSitePlanPayload(sitePlan) {
  const plan = normalizeSitePlan(sitePlan);
  if (!plan || plan.status !== 'active') return null;
  return {
    schema: SITE_PLAN_HANDOFF_SCHEMA,
    status: plan.status,
    tierId: plan.tierId,
    services: plan.services,
    pages: plan.pages,
    oneTimeAddOns: plan.oneTimeAddOns,
    billing: plan.billing,
    catalogType: plan.catalogType,
    languages: plan.languages,
    changesPerMonth: plan.changesPerMonth,
    source: plan.source,
    offerId: plan.offerId,
    alternativeIndex: plan.alternativeIndex,
    signedAt: plan.signedAt,
    needsConfirmation: plan.needsConfirmation && !plan.confirmedAt,
    features: featuresFromServices(plan.services),
    planHash: sitePlanHash(plan),
  };
}

