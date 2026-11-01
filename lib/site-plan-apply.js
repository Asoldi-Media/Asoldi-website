// Applies a client's plan in force (client.sitePlan) to its hub site.
//
// applySitePlanToHub(clientId) finds the client's site (by site key, then by the linked site id, then by
// domain) or creates one, and writes websitePlan, the catalog type, planSource and, while a site has no
// feature spec, the legacy feature flags. It also links the site on the client (client.hubSite and
// portalTierId). Callers hold the client's signing lease (lib/contract-signing.js), so two processes never
// create two sites for one client.
//
// planSource (on the hub site): { kind: 'offer' | 'admin' | 'backfill', salesClientId, offerId,
// alternativeIndex, tierId, services, billing, catalogType, derivedFeatures, appliedAt, appliedBy }.
// An older site may hold a bare string ('admin'); normalizePlanSource reads it as { kind }.
//
// Legacy feature flags, until a site has a feature spec: the first apply writes the flags the plan's
// services stand for; a later apply writes them only when the plan changed, and keeps every flag whose
// current value differs from the flags the previous plan stood for (a change made by hand). A site with a
// feature spec gets no feature write at all; its features come from the spec and the plan's services.
import * as hub from '../data/hub.js';
import * as sales from '../data/sales.js';
import { featuresFromPlan } from '../data/hub-model.js';
import { activeSitePlan, normalizeSitePlan } from './site-plan-model.js';
import { catalogTypeFromBank } from './site-plan.js';
import { featuresFromServices, resolveTier, servicesForTier, tierById } from './website-tiers.js';
import { appendDeliveryAudit } from './delivery-audit.js';

export const PLAN_SOURCE_KINDS = Object.freeze(['offer', 'admin', 'backfill']);
const FLAGS = ['users', 'analytics', 'ecommerce', 'blog', 'socialSync', 'emailMarketing', 'general'];

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function flagsOf(features) {
  const input = isPlainObject(features) ? features : {};
  return Object.fromEntries(FLAGS.map((flag) => [flag, flag === 'users' ? input.users !== false : input[flag] === true]));
}

function sameFlags(a, b) {
  return FLAGS.every((flag) => Boolean(a?.[flag]) === Boolean(b?.[flag]));
}

/** A stored planSource as an object with a known kind, or null. A legacy string becomes { kind }. */
export function normalizePlanSource(raw) {
  if (typeof raw === 'string') {
    const kind = text(raw, 20).toLowerCase();
    return PLAN_SOURCE_KINDS.includes(kind) ? { kind } : null;
  }
  if (!isPlainObject(raw)) return null;
  const kind = text(raw.kind, 20).toLowerCase();
  if (!PLAN_SOURCE_KINDS.includes(kind)) return null;
  return { ...raw, kind };
}

export function planSourceKind(site) {
  return normalizePlanSource(site?.planSource)?.kind || '';
}

function normalizeDomain(value) {
  return text(value, 253).toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
}

/**
 * The other sales client a hub site belongs to, or ''. A site belongs to a client when its planSource
 * names that client, or when that client's hub link holds the site's key or id.
 */
export function otherSiteOwner(site, client = {}) {
  if (!site) return '';
  const own = text(client?.id, 80);
  const claimed = text(normalizePlanSource(site.planSource)?.salesClientId, 80);
  if (claimed && claimed !== own) return claimed;
  const key = text(site.site_key);
  const id = text(site.id);
  const linked = sales.getSalesClients().find((other) => {
    if (!other?.id || other.id === own) return false;
    const link = other.hubSite || {};
    return (key && text(link.siteKey) === key) || (id && text(link.id) === id);
  });
  return linked ? text(linked.id, 80) : '';
}

/**
 * Where a client's hub site is: by site key (the client's, then `siteKey`), by the linked site id,
 * then by domain (`domain`, the client's website domain, the linked domain). Returns
 * { site, via: 'key'|'id'|'domain'|'', owner } where owner is the other client a site found by id or
 * domain belongs to ('' when it is free or the client's own). A key is the client's own link (or the
 * Maker's key for its run) and is trusted.
 */
export function locateSiteForClient(client = {}, { siteKey = '', domain = '' } = {}) {
  for (const key of [text(client?.hubSite?.siteKey), text(siteKey)]) {
    if (!key) continue;
    const site = hub.getSiteByKey(key);
    if (site) return { site, via: 'key', owner: '' };
  }
  const linkedId = text(client?.hubSite?.id);
  if (linkedId) {
    const site = hub.getSiteById(linkedId);
    if (site) return { site, via: 'id', owner: otherSiteOwner(site, client) };
  }
  for (const candidate of [domain, client?.websiteDomain, client?.hubSite?.domain]) {
    const host = normalizeDomain(candidate);
    if (!host) continue;
    const site = hub.getSiteByDomain(host);
    if (site) return { site, via: 'domain', owner: otherSiteOwner(site, client) };
  }
  return { site: null, via: '', owner: '' };
}

/** The client's hub site, or null when there is none or the one found belongs to another client. */
export function findSiteForClient(client = {}, hints = {}) {
  const found = locateSiteForClient(client, hints);
  return found.owner ? null : found.site;
}

/**
 * A site found by id or domain that belongs to another client: nothing is written to it. The audit log
 * gets a line and the client one open delivery task, for a person to sort out.
 */
export function noteSiteOwnerConflict(client, site, owner, { by = '', now = new Date().toISOString() } = {}) {
  appendDeliveryAudit({ at: now, kind: 'site-owner-conflict', clientId: text(client?.id, 80), siteId: text(site?.id, 80), owner: text(owner, 80), by: text(by, 80) });
  const current = sales.getSalesClientById(client?.id);
  if (!current) return;
  const id = `site-owner-conflict:${text(site?.id, 80)}`;
  const tasks = Array.isArray(current.delivery?.tasks) ? current.delivery.tasks.filter(isPlainObject) : [];
  if (tasks.some((task) => task.id === id && task.status === 'open')) return;
  const task = { id, kind: 'site_owner_conflict', status: 'open', at: now, siteId: text(site?.id, 80), owner: text(owner, 80), hint: 'The hub site found for this client belongs to another client.' };
  sales.setSalesDelivery(current.id, { tasks: [...tasks.filter((row) => row.id !== id), task].slice(-20) });
}

/** websitePlan for a plan's tier: the tier id, or `custom`. */
export function websitePlanForTier(tierId) {
  return tierById(tierId)?.id || 'custom';
}

function catalogTypeFor(plan, { bank = null, site = null } = {}) {
  if (!plan.services.includes('ecom') && !plan.services.includes('catalog')) return null;
  return plan.catalogType || catalogTypeFromBank(bank) || site?.ecommerceCatalogType || 'normal';
}

/**
 * The legacy flags to write, or null to leave the site's flags as they are. `previous` is what the
 * site's flags stood for before (planSource.derivedFeatures, or the old tier table for a site that
 * never had a plan applied).
 */
export function nextLegacyFlags(site, derived, { created = false } = {}) {
  if (created) return { ...derived };
  if (site?.featureSpec) return null;
  const source = normalizePlanSource(site?.planSource);
  const previous = isPlainObject(source?.derivedFeatures) ? flagsOf(source.derivedFeatures) : featuresFromPlan(site?.websitePlan);
  if (source && isPlainObject(source.derivedFeatures) && sameFlags(previous, derived)) return null;
  const current = flagsOf(site?.features);
  const next = {};
  for (const flag of FLAGS) next[flag] = current[flag] !== Boolean(previous[flag]) ? current[flag] : Boolean(derived[flag]);
  return sameFlags(next, current) ? null : next;
}

function planSourceFor(plan, client, site, { by, now, derived, created = false }) {
  const fromAdmin = plan.source === 'superadmin';
  return {
    ...(normalizePlanSource(site?.planSource) || {}),
    // Who made the site, kept on every later apply (the go-live callback reads it).
    ...(created ? { siteCreatedBy: by } : {}),
    kind: fromAdmin ? 'admin' : 'offer',
    salesClientId: text(client.id, 80),
    offerId: plan.offerId,
    alternativeIndex: plan.alternativeIndex,
    tierId: plan.tierId,
    services: [...plan.services],
    billing: plan.billing,
    catalogType: plan.catalogType,
    derivedFeatures: { ...derived },
    appliedAt: now,
    appliedBy: by,
  };
}

function samePlanSource(a, b) {
  const pick = (source) => JSON.stringify({
    kind: source?.kind,
    salesClientId: source?.salesClientId,
    offerId: source?.offerId,
    alternativeIndex: source?.alternativeIndex,
    tierId: source?.tierId,
    services: source?.services,
    billing: source?.billing,
    catalogType: source?.catalogType ?? null,
    derivedFeatures: source?.derivedFeatures ? flagsOf(source.derivedFeatures) : null,
  });
  return pick(a) === pick(b);
}

/**
 * Applies the client's plan in force to its hub site. Options: by, now (ISO), siteKey, domain, name,
 * githubRepo (hints from a go-live callback), bank (the client data bank, for the catalog type),
 * deliveryPhase (for a new site, default 'development'). Returns
 * { ok, reason?, site, created, changed, featuresWritten }. Writes nothing when nothing changed. A site
 * found by id or domain that belongs to another client is left alone: { ok:false,
 * reason:'site-owned-elsewhere', owner } with a delivery task on the client (noteSiteOwnerConflict).
 */
export function applySitePlanToHub(clientId, options = {}) {
  const by = text(options.by, 80) || 'contract-signing';
  const now = text(options.now, 40) || new Date().toISOString();
  const client = sales.getSalesClientById(clientId);
  if (!client) return { ok: false, reason: 'not-found', site: null, created: false, changed: false, featuresWritten: false };
  const plan = activeSitePlan(client);
  if (!plan) return { ok: false, reason: 'no-plan', site: null, created: false, changed: false, featuresWritten: false };
  const derived = featuresFromServices(plan.services);
  const websitePlan = websitePlanForTier(plan.tierId);
  const found = locateSiteForClient(client, { siteKey: options.siteKey, domain: options.domain });
  if (found.owner) {
    noteSiteOwnerConflict(client, found.site, found.owner, { by, now });
    return { ok: false, reason: 'site-owned-elsewhere', owner: found.owner, site: null, created: false, changed: false, featuresWritten: false };
  }
  let site = found.site;
  let created = false;
  if (!site) {
    const domain = normalizeDomain(options.domain || client.websiteDomain || client.hubSite?.domain);
    site = hub.createSite({
      name: text(options.name) || text(client.businessName) || domain || 'New client',
      domain,
      site_key: text(options.siteKey) || hub.generateSiteKey(),
      websitePlan,
      ecommerceCatalogType: catalogTypeFor(plan, { bank: options.bank }),
      githubRepo: text(options.githubRepo, 200) || undefined,
      features: derived,
      deliveryPhase: text(options.deliveryPhase, 40) || 'development',
    });
    if (!site?.id) return { ok: false, reason: 'create-failed', site: null, created: false, changed: false, featuresWritten: false };
    created = true;
  }
  let changed = created;
  let featuresWritten = created;
  const catalogType = catalogTypeFor(plan, { bank: options.bank, site });
  const flags = nextLegacyFlags(site, derived, { created });
  const patch = {};
  if (site.websitePlan !== websitePlan) patch.websitePlan = websitePlan;
  if (flags) {
    patch.features = flags;
    featuresWritten = true;
  }
  if ((catalogType || null) !== (site.ecommerceCatalogType || null) && (flags ? flags.ecommerce : site.features?.ecommerce)) {
    patch.ecommerceCatalogType = catalogType;
  }
  if (!created && Object.keys(patch).length) {
    const updated = hub.updateSite(site.id, patch);
    if (updated.ok) site = updated.site;
    changed = true;
  }
  const nextSource = planSourceFor(plan, client, site, { by, now, derived, created });
  if (!samePlanSource(normalizePlanSource(site.planSource), nextSource)) {
    const stored = hub.setSitePlanSource(site.id, nextSource);
    if (stored.ok) site = stored.site;
    changed = true;
  }
  // Link the site on the client and record where the plan was applied.
  const link = client.hubSite || {};
  const clientPatch = {};
  if (text(link.id) !== text(site.id) || text(link.siteKey) !== text(site.site_key)) {
    clientPatch.hubSite = {
      siteKey: site.site_key,
      domain: site.domain,
      id: site.id,
      createdAt: site.createdAt,
      ...(text(options.githubRepo) ? { githubRepo: text(options.githubRepo, 200) } : {}),
    };
  }
  const tier = resolveTier(plan.tierId);
  if (tier && text(client.portalTierId) !== tier.id) clientPatch.portalTierId = tier.id;
  if (Object.keys(clientPatch).length) sales.updateSalesClient(client.id, clientPatch);
  if (changed || plan.appliedSiteId !== site.id) {
    sales.setSalesSitePlan(client.id, { ...plan, appliedAt: now, appliedSiteId: site.id }, { by, reason: 'applied' });
  }
  return { ok: true, site, created, changed, featuresWritten };
}

/**
 * planSource for a superadmin websitePlan edit on a hub site (the site's plan becomes the admin's
 * choice): kind 'admin' with the tier's services and flags. null when the websitePlan did not change.
 */
export function adminPlanSourceForEdit(before, after, { by = 'superadmin', now = new Date().toISOString(), salesClientId = '' } = {}) {
  if (!before || !after || before.websitePlan === after.websitePlan) return null;
  const tierId = text(after.websitePlan, 40);
  const services = servicesForTier(tierId);
  return {
    ...(normalizePlanSource(after.planSource) || {}),
    kind: 'admin',
    salesClientId: text(salesClientId, 80) || text(normalizePlanSource(after.planSource)?.salesClientId, 80),
    tierId,
    services,
    derivedFeatures: services.length ? featuresFromServices(services) : flagsOf(after.features),
    appliedAt: now,
    appliedBy: text(by, 80) || 'superadmin',
  };
}

/** Exposed for tests: the normalized plan a site's planSource describes. */
export function planSourceSummary(site) {
  const source = normalizePlanSource(site?.planSource);
  if (!source) return null;
  return { kind: source.kind, tierId: text(source.tierId, 40), services: Array.isArray(source.services) ? [...source.services] : [] };
}

export { normalizeSitePlan };
