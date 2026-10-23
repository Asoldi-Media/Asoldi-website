/**
 * Hub side of the CMS feature tree (WS6.7): which services a hub site has, its feature spec (with
 * the lazy migration from the 7 legacy flags), the resolved tree, and the site-config fields.
 *
 * The registry and the resolver are the CMS's own code, synced into lib/cms-features.js and
 * data/cms-feature-tree.json by scripts/sync-cms-feature-tree.mjs. This file never decides an
 * entitlement itself; it only picks the inputs.
 *
 * Services come from, in order:
 *   1. site.planSource.services (WS8.4), with site.planSource.tierId or site.websitePlan as the tier;
 *   2. the linked sales client's sitePlan.services + sitePlan.oneTimeAddOns (WS8.3), with sitePlan.tierId;
 *   3. the tier's services (tierServices(site.websitePlan)).
 * Ids that are not registry service ids are logged and dropped; aliases are not guessed (WS8's
 * normalizeServices writes canonical ids).
 */
import { DEFAULT_FEATURE_ENFORCEMENT, featureEnforcementOf, normalizeFeatureSpec } from '../data/feature-spec-model.js';
import { analyticsLevelFromFlags } from './website-tiers.js';
import { LEGACY_FLAG_SERVICES, loadFeatureRegistry } from './cms-features.js';
import { legacyFlagsForServices } from '../packages/suite/core/delivery/vocab.js';

const LEGACY_FLAGS = ['users', 'analytics', 'ecommerce', 'blog', 'socialSync', 'emailMarketing', 'general'];

/**
 * Keys that turn a legacy flag off when an admin switched the flag off on purpose (a WS8
 * featureOverrides row, or a flag that differs from planSource.derivedFeatures). They are the keys
 * legacyFromTree reads. `users` and `general` have no such key (users is always on; general reads the
 * forms and roles every site needs) and `socialSync` is always false.
 */
export const LEGACY_FLAG_REVOKE_KEYS = Object.freeze({
  analytics: Object.freeze(['analytics']),
  ecommerce: Object.freeze(['shop']),
  blog: Object.freeze(['blog']),
  emailMarketing: Object.freeze(['email.campaigns', 'email.newsletter']),
});

let warnedUnknown = new Set();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asList(value) {
  return Array.isArray(value) ? value.map((v) => String(v ?? '').trim()).filter(Boolean) : [];
}

/** The synced registry, or null when the hub copy is missing or broken (see featureRegistryStatus). */
export function cmsFeatureRegistry() {
  return loadFeatureRegistry().registry;
}

function requireRegistry(registry) {
  const reg = registry || cmsFeatureRegistry();
  if (!reg) {
    const { error } = loadFeatureRegistry();
    throw new Error(`The CMS feature registry is not loaded: ${error?.message || 'unknown error'}`);
  }
  return reg;
}

function logUnknown(siteId, unknown, log) {
  for (const id of unknown) {
    const key = `${siteId}:${id}`;
    if (warnedUnknown.has(key)) continue;
    warnedUnknown.add(key);
    log?.warn?.(`[cms-features] site ${siteId || '?'}: service id "${id}" is not in the registry; dropped`);
  }
}

/** Tests only. */
export function resetUnknownServiceWarnings() {
  warnedUnknown = new Set();
}

/**
 * The site's services, tier and where they came from: { services, tierId, source, unknown }.
 * `services` holds only registry ids; the tier's own services are added by the resolver.
 */
export function servicesForSite(site = {}, salesClient = null, { registry = null, log = console } = {}) {
  const reg = requireRegistry(registry);
  const isTier = (id) => Object.prototype.hasOwnProperty.call(reg.TIER_SERVICES, String(id ?? ''));
  const websitePlan = String(site?.websitePlan || '').trim();
  let raw;
  let tierId;
  let source;
  const planSource = isPlainObject(site?.planSource) ? site.planSource : null;
  const sitePlan = isPlainObject(salesClient?.sitePlan) ? salesClient.sitePlan : null;
  if (planSource && asList(planSource.services).length) {
    raw = asList(planSource.services);
    tierId = isTier(planSource.tierId) ? planSource.tierId : isTier(websitePlan) ? websitePlan : null;
    source = 'planSource';
  } else if (sitePlan && (isTier(sitePlan.tierId) || asList(sitePlan.services).length)) {
    raw = [...asList(sitePlan.services), ...asList(sitePlan.oneTimeAddOns)];
    tierId = isTier(sitePlan.tierId) ? sitePlan.tierId : null;
    source = 'sitePlan';
  } else {
    tierId = isTier(websitePlan) ? websitePlan : 'tier-1-standard';
    raw = [...(reg.TIER_SERVICES[tierId] || [])];
    source = 'websitePlan';
  }
  const services = [];
  const unknown = [];
  for (const id of raw) {
    if (reg.isServiceId(id)) {
      if (!services.includes(id)) services.push(id);
    } else if (!unknown.includes(id)) unknown.push(id);
  }
  if (unknown.length) logUnknown(site?.id, unknown, log);
  return { services, tierId, source, unknown };
}

/** { services, tierId, source } for resolveFeatures. */
export function entitlementInput(site = {}, salesClient = null, options = {}) {
  const { services, tierId, source } = servicesForSite(site, salesClient, options);
  return { services, tierId, source };
}

function legacyFlagsOf(site) {
  const features = isPlainObject(site?.features) ? site.features : {};
  return Object.fromEntries(LEGACY_FLAGS.map((flag) => [flag, flag === 'users' ? features.users !== false : features[flag] === true]));
}

/**
 * The legacy flags the site's plan explains: planSource.derivedFeatures when WS8.4 applied a plan,
 * else the flags the plan's services stand for (a sitePlan or planSource without derived flags),
 * else null (a site from before plans: every true flag is the admin's choice).
 */
function planDerivedFlags(site, input, reg) {
  const derived = site?.planSource?.derivedFeatures;
  if (isPlainObject(derived)) {
    return Object.fromEntries(LEGACY_FLAGS.map((flag) => [flag, derived[flag] === true]));
  }
  if (input.source === 'planSource' || input.source === 'sitePlan') {
    return legacyFlagsForServices([...(reg.TIER_SERVICES[input.tierId] || []), ...input.services]);
  }
  return null;
}

/** Flags an admin switched on or off on purpose: deviations from the plan's flags, then featureOverrides rows. */
function deliberateFlags(site, derived) {
  const out = {};
  if (derived) {
    const flags = legacyFlagsOf(site);
    for (const flag of LEGACY_FLAGS) {
      if (derived[flag] !== flags[flag]) out[flag] = { value: flags[flag], reason: 'differs from the plan' };
    }
  }
  const overrides = isPlainObject(site?.featureOverrides) ? site.featureOverrides : {};
  for (const [flag, row] of Object.entries(overrides)) {
    if (!LEGACY_FLAGS.includes(flag)) continue;
    const value = typeof row === 'boolean' ? row : isPlainObject(row) && typeof row.value === 'boolean' ? row.value : null;
    if (value === null) continue;
    out[flag] = { value, reason: String(isPlainObject(row) && row.reason ? row.reason : 'featureOverrides').slice(0, 200) };
  }
  return out;
}

/**
 * The spec a site has, or for a site without one the lazily migrated spec (WS6.7):
 *   { rev: 1, grantServices: services of true legacy flags that the plan neither covers nor explains,
 *     revoke: keys of flags switched off on purpose, values: {'shop.catalog': ecommerceCatalogType} }
 * When `seo` is granted only because of the legacy analytics flag, automatic posts default off,
 * as the CMS's treeInputFromLegacy does. The catalog type goes into the spec only for sites without a
 * plan; a plan's own catalogType is passed to the resolver instead. Returns { spec, migrated, notes }.
 */
export function featureSpecForSite(site = {}, input = null, { registry = null, salesClient = null } = {}) {
  const stored = normalizeFeatureSpec(site?.featureSpec);
  if (stored) return { spec: stored, migrated: false, notes: [] };
  const reg = requireRegistry(registry);
  const plan = input || entitlementInput(site, salesClient, { registry: reg });
  const covered = new Set(['site', ...(reg.TIER_SERVICES[plan.tierId] || []), ...plan.services]);
  const flags = legacyFlagsOf(site);
  const derived = planDerivedFlags(site, plan, reg);
  const deliberate = deliberateFlags(site, derived);
  const grantServices = [];
  const revoke = [];
  const notes = [];
  for (const flag of LEGACY_FLAGS) {
    const service = LEGACY_FLAG_SERVICES[flag];
    const wanted = (flags[flag] && (!derived || derived[flag] !== true)) || deliberate[flag]?.value === true;
    if (wanted && service && !covered.has(service) && !grantServices.includes(service)) {
      grantServices.push(service);
      notes.push(`legacy flag ${flag} -> service ${service}`);
    }
  }
  for (const [flag, row] of Object.entries(deliberate)) {
    if (row.value !== false || !LEGACY_FLAG_REVOKE_KEYS[flag]) continue;
    for (const key of LEGACY_FLAG_REVOKE_KEYS[flag]) {
      if (!revoke.includes(key)) revoke.push(key);
    }
    notes.push(`legacy flag ${flag} off (${row.reason}) -> revoke ${LEGACY_FLAG_REVOKE_KEYS[flag].join(',')}`);
  }
  const spec = { rev: 1 };
  if (grantServices.length) spec.grantServices = grantServices;
  if (revoke.length) spec.revoke = revoke;
  if (grantServices.includes('seo')) spec.defaults = { 'blog.autoPosts': false };
  const catalog = String(site?.ecommerceCatalogType || '').trim();
  if (catalog && plan.source === 'websitePlan') spec.values = { 'shop.catalog': catalog };
  return { spec, migrated: true, notes };
}

function planCatalogType(site, salesClient) {
  if (isPlainObject(salesClient?.sitePlan) && salesClient.sitePlan.catalogType) return salesClient.sitePlan.catalogType;
  if (isPlainObject(site?.planSource) && site.planSource.catalogType) return site.planSource.catalogType;
  return site?.ecommerceCatalogType || null;
}

/**
 * Everything the hub knows about one site's features:
 * { input, unknownServices, spec, migrated, notes, resolved, legacy, enforcement }.
 */
export function resolveSiteFeatures(site = {}, salesClient = null, { registry = null, log = console } = {}) {
  const reg = requireRegistry(registry);
  const full = servicesForSite(site, salesClient, { registry: reg, log });
  const input = { services: full.services, tierId: full.tierId, source: full.source };
  const { spec, migrated, notes } = featureSpecForSite(site, input, { registry: reg });
  const resolved = reg.resolveFeatures({ services: input.services, tierId: input.tierId, spec, catalogType: planCatalogType(site, salesClient) });
  return {
    input,
    unknownServices: full.unknown,
    spec,
    migrated,
    notes,
    resolved,
    legacy: reg.legacyFromTree(resolved),
    enforcement: featureEnforcementOf(site),
  };
}

/** The featureTree block of site-config (WS6 §3.3.3). */
export function featureTreeForConfig(result) {
  const { resolved, spec, input } = result;
  return {
    v: resolved.v,
    registryVersion: resolved.registryVersion,
    rev: spec.rev ?? 1,
    plan: input.tierId || 'custom',
    tier: resolved.tier ?? null,
    services: [...resolved.services],
    source: input.source,
    entitled: [...resolved.entitled],
    defaults: { ...(spec.defaults || {}) },
    values: { ...resolved.values },
    locks: [...(spec.locks || [])],
  };
}

/** pendingSettings for a site_key lookup: the cms spec while its rev is newer than the CMS applied. */
export function pendingSettingsFor(site = {}) {
  const spec = isPlainObject(site?.cmsSpec) ? site.cmsSpec : null;
  const rev = Number(spec?.rev) || 0;
  const applied = Number(site?.cms?.settingsRevApplied) || 0;
  if (!spec || rev <= 0 || rev <= applied) return null;
  return { rev, sections: isPlainObject(spec.sections) ? spec.sections : {}, force: asList(spec.force) };
}

/**
 * The only fields a domain (or Host) lookup of site-config may return once the tree is on. A domain
 * is public, so admin sync fields, pendingSettings and anything added later stay out unless listed.
 */
export const PUBLIC_SITE_CONFIG_FIELDS = Object.freeze([
  'id', 'name', 'domain', 'features', 'ecommerceCatalogType', 'websitePlan', 'desiredCmsVersion', 'analyticsLevel',
  'analyticsGoals', 'featureTree', 'featureEnforcement',
]);

/**
 * site-config with the tree: the legacy `features` come from legacyFromTree, the catalog type and
 * analytics level follow them, and featureTree, featureEnforcement and (site_key lookups only)
 * pendingSettings are added. A domain lookup keeps only PUBLIC_SITE_CONFIG_FIELDS. `config` is the
 * old answer; it is not changed.
 */
export function siteConfigWithTree(config, site, result, { byDomain = false } = {}) {
  const features = { ...result.legacy };
  const catalog = result.resolved.values['shop.catalog'] || null;
  const out = {
    ...config,
    features,
    ecommerceCatalogType: features.ecommerce ? catalog || 'normal' : null,
    analyticsLevel: analyticsLevelFromFlags({ planId: site?.websitePlan, features }),
    featureTree: featureTreeForConfig(result),
    featureEnforcement: result.enforcement || DEFAULT_FEATURE_ENFORCEMENT,
  };
  if (byDomain) return Object.fromEntries(Object.entries(out).filter(([key]) => PUBLIC_SITE_CONFIG_FIELDS.includes(key)));
  const pending = pendingSettingsFor(site);
  if (pending) out.pendingSettings = pending;
  return out;
}

/** Legacy flags that are on today but off in the tree (socialSync is expected; anything else is a loss). */
export function legacyFlagsLost(site, legacy) {
  const today = legacyFlagsOf(site);
  return LEGACY_FLAGS.filter((flag) => today[flag] && !legacy[flag]);
}

/**
 * got-client (WS6.8): when the sales client has a sitePlan, the new hub site takes its tier from it
 * and the request body's websitePlan is ignored.
 */
export function websitePlanForNewSite(salesClient, bodyWebsitePlan) {
  const tierId = String(salesClient?.sitePlan?.tierId || '').trim();
  return tierId || bodyWebsitePlan;
}
