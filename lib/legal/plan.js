/**
 * The plan a contract describes, from a site plan, an offer plan or a tier id. Pure: it reads only
 * the shared vocabulary, so the data layer (data/sales-offers.js) can use it without loading the
 * renderer.
 *
 * `tiers` is the tier snapshot an offer was stamped with at send ({ [tierId]: { services, pages } },
 * see tierSnapshot()). When given, a plan without its own services or pages takes them from the
 * snapshot instead of today's vocabulary, so a sent contract keeps the scope it was sent with.
 */
import {
  TIER_IDS,
  TIER_MATRIX,
  expandServices,
  normalizeOneTimeAddOns,
  normalizeServices,
  servicesForTier,
} from '../../packages/suite/core/delivery/vocab.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** { [tierId]: { services, pages } } for every tier: what each tier contains today. */
export function tierSnapshot() {
  return Object.fromEntries(TIER_IDS.map((tierId) => [tierId, {
    services: servicesForTier(tierId),
    pages: Number(TIER_MATRIX[tierId]?.pages) || 5,
  }]));
}

/** { tierId, services, oneTimeAddOns, billing, pages } from a site plan, offer plan or tier id. */
export function planForContract(sitePlan = {}, { tiers = null } = {}) {
  const plan = typeof sitePlan === 'string' ? { tierId: sitePlan } : (sitePlan || {});
  const tierId = TIER_IDS.includes(String(plan.tierId || '')) ? String(plan.tierId) : '';
  const frozen = isPlainObject(tiers) && isPlainObject(tiers[tierId]) ? tiers[tierId] : null;
  const listed = normalizeServices(plan.services);
  const base = listed.length ? listed : (frozen ? normalizeServices(frozen.services) : servicesForTier(tierId));
  const tierPages = Number(frozen?.pages) > 0 ? Number(frozen.pages) : (TIER_MATRIX[tierId]?.pages || 5);
  return {
    tierId,
    services: expandServices(base),
    oneTimeAddOns: normalizeOneTimeAddOns(plan.oneTimeAddOns),
    billing: plan.billing === 'once' ? 'once' : 'month',
    pages: Number(plan.pages) > 0 ? Math.round(Number(plan.pages)) : tierPages,
  };
}
