/**
 * SEO and blog feature keys with their tier mapping (WS9.46).
 *
 * Entitlement keys only: they say what a site's plan INCLUDES. They never reuse
 * CMS feeler names (the CMS reports what its version SUPPORTS under
 * cmsCapabilities().seo.feelers without a prefix).
 *
 * Owner decisions 2026-10-23:
 *  - Q19: `blog` and `blog.posts` (client-written blog) on every tier;
 *         `blog.autoPosts` (auto-written posts) Tier 2+.
 *  - Q52: the backlink network (`seo.linkNetwork`) is on for Tier 2+.
 *  - Q58: cancellation stops hub services (auto posts, tracking, reports, network ...).
 *
 * Until the WS6 feature tree lands, features come from the tier (sitePlan.tierId,
 * else websitePlan) through the service bundles below, which mirror WS6 §3.3.1
 * for the seo/blog keys. When a site carries a resolved tree, it wins.
 * WS6.4 merges SEO_FEATURE_REGISTRY into the one registry.
 */

export const SEO_FEATURE_REGISTRY = Object.freeze([
  { key: 'seo', type: 'bool', owner: 'WS9', note: 'parent' },
  { key: 'seo.keywords', type: 'bool', owner: 'WS9', note: 'keyword research and plan' },
  { key: 'seo.onPage', type: 'bool', owner: 'WS9', note: 'Step 5 on-page work' },
  { key: 'seo.contentHead', type: 'bool', owner: 'WS6/WS9', note: 'per-item SEO fields and CMS content head' },
  { key: 'seo.sitemap', type: 'bool', owner: 'WS9', note: 'dynamic sitemap and robots' },
  { key: 'seo.agreedKeywords', type: 'bool', owner: 'WS9', note: 'agreed 1-3 keywords' },
  { key: 'seo.tracking', type: 'bool', owner: 'WS9', note: 'parent' },
  { key: 'seo.tracking.organic', type: 'bool', owner: 'WS9', note: 'organic rank tracking' },
  { key: 'seo.tracking.maps', type: 'bool', owner: 'WS9', note: 'Maps rank tracking' },
  { key: 'seo.tracking.aiOverview', type: 'bool', owner: 'WS9', note: 'Google AI Overview presence/citation' },
  { key: 'seo.tracking.aiAssistants', type: 'bool', owner: 'WS9', note: 'AI assistant visibility (WS9.55)' },
  { key: 'seo.reports', type: 'bool', owner: 'WS9', note: 'parent' },
  { key: 'seo.reports.basic', type: 'bool', owner: 'WS9', note: 'basic report every 14 days' },
  { key: 'seo.reports.advanced', type: 'bool', owner: 'WS9', note: 'advanced weekly report (replaces basic)' },
  { key: 'seo.localPack', type: 'bool', owner: 'WS9', note: 'local pack, NAP, GBP drafts' },
  { key: 'seo.linkNetwork', type: 'bool', owner: 'WS9', note: 'Asoldi client backlink network (Q52: on for Tier 2+)' },
  { key: 'seo.backlinkTargets', type: 'bool', owner: 'WS9', note: 'backlink target workflow' },
  { key: 'seo.searchConsole', type: 'bool', owner: 'WS9', note: 'Search Console connection' },
  { key: 'seo.liveAudit', type: 'bool', owner: 'WS9', note: 'monthly live-site audit' },
  { key: 'seo.productFeed', type: 'bool', owner: 'WS9', note: 'Google product feed (requires shop)' },
  { key: 'seo.multilingual', type: 'bool', owner: 'WS9', note: 'per-locale research and pageMap' },
  { key: 'blog', type: 'bool', owner: 'WS6', note: 'blog module (Q19: every tier)' },
  { key: 'blog.posts', type: 'bool', owner: 'WS6', note: 'client-written posts (Q19: every tier)' },
  { key: 'blog.autoPosts', type: 'bool', owner: 'WS9', note: 'auto-written posts (Q19: Tier 2+)' },
]);

export const SEO_FEATURE_KEYS = Object.freeze(SEO_FEATURE_REGISTRY.map((row) => row.key));
const KEY_SET = new Set(SEO_FEATURE_KEYS);

/** Older names that map onto a current key (WS6 revision 1 used blog.localPosts). */
export const SEO_FEATURE_ALIASES = Object.freeze({
  'blog.localPosts': 'blog.autoPosts',
  'seo.meta': 'seo.contentHead',
});

/** SEO/blog part of the WS6 §3.3.1 service bundles (WS8 service ids). */
export const SEO_SERVICE_BUNDLES = Object.freeze({
  site: ['seo', 'seo.keywords', 'seo.onPage', 'seo.contentHead', 'seo.sitemap', 'blog', 'blog.posts'],
  seo: [
    'seo.agreedKeywords',
    'seo.tracking',
    'seo.tracking.organic',
    'seo.tracking.maps',
    'seo.tracking.aiOverview',
    'seo.tracking.aiAssistants',
    'seo.reports',
    'seo.reports.basic',
    'seo.localPack',
    'seo.linkNetwork',
    'seo.backlinkTargets',
    'seo.searchConsole',
    'seo.liveAudit',
  ],
  blog: ['blog', 'blog.autoPosts'],
  ecom: ['seo.productFeed'],
  dashboard: ['seo.reports.advanced'],
  multilingual: ['seo.multilingual'],
});

/** Tier → services (fallback until WS8.1 publishes WEBSITE_TIERS[].services). */
export const SEO_TIER_SERVICES = Object.freeze({
  'tier-1-standard': ['site'],
  'tier-2-seo': ['site', 'seo', 'blog'],
  'tier-3-ecommerce': ['site', 'seo', 'blog', 'ecom', 'dashboard', 'multilingual'],
});

/** Reduced package for self-hosted sites (K79, Q9). */
export const SELF_HOSTED_SEO_KEYS = Object.freeze(['seo', 'seo.keywords', 'seo.onPage', 'seo.linkNetwork', 'seo.backlinkTargets']);

/**
 * Keys that are hub services and stop when the client cancels (Q58). The site's own
 * head, sitemap, product feed and client-written blog keep working until hosting ends.
 */
export const HUB_SERVICE_SEO_KEYS = Object.freeze([
  'seo.keywords',
  'seo.agreedKeywords',
  'seo.tracking',
  'seo.tracking.organic',
  'seo.tracking.maps',
  'seo.tracking.aiOverview',
  'seo.tracking.aiAssistants',
  'seo.reports',
  'seo.reports.basic',
  'seo.reports.advanced',
  'seo.localPack',
  'seo.linkNetwork',
  'seo.backlinkTargets',
  'seo.searchConsole',
  'seo.liveAudit',
  'seo.multilingual',
  'blog.autoPosts',
]);

/** Which key each WS9 job checks before it runs. */
export const SEO_JOB_FEATURES = Object.freeze({
  research: 'seo.keywords',
  'agreed-keywords': 'seo.agreedKeywords',
  'blog-scheduler': 'blog.autoPosts',
  'rank-tracker.organic': 'seo.tracking.organic',
  'rank-tracker.maps': 'seo.tracking.maps',
  'rank-tracker.aiOverview': 'seo.tracking.aiOverview',
  'ai-visibility': 'seo.tracking.aiAssistants',
  report: 'seo.reports',
  'local-pack': 'seo.localPack',
  'link-network': 'seo.linkNetwork',
  'backlink-targets': 'seo.backlinkTargets',
  'search-console': 'seo.searchConsole',
  'live-audit': 'seo.liveAudit',
  'product-feed': 'seo.productFeed',
  'multilingual-research': 'seo.multilingual',
});

export function normalizeSeoFeatureKey(key) {
  const raw = String(key || '').trim();
  return SEO_FEATURE_ALIASES[raw] || raw;
}

function parentsOf(key) {
  const parts = key.split('.');
  const out = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('.'));
  return out;
}

/** Drop any key whose ancestor is not effective (tree semantics). */
function closeOverParents(keys) {
  const out = new Set();
  for (const key of keys) {
    if (!KEY_SET.has(key)) continue;
    if (parentsOf(key).every((parent) => !KEY_SET.has(parent) || keys.has(parent))) out.add(key);
  }
  return out;
}

/** Entitled SEO/blog keys for a list of WS8 service ids. */
export function seoKeysForServices(services = []) {
  const keys = new Set();
  for (const service of services || []) {
    for (const key of SEO_SERVICE_BUNDLES[String(service)] || []) keys.add(key);
  }
  // `dashboard` upgrades the report only where reports are entitled; advanced replaces basic.
  if (keys.has('seo.reports.advanced')) {
    if (keys.has('seo.reports')) keys.delete('seo.reports.basic');
    else keys.delete('seo.reports.advanced');
  }
  return closeOverParents(keys);
}

export function normalizeTierId(tierId) {
  const id = String(tierId || '').trim();
  return Object.prototype.hasOwnProperty.call(SEO_TIER_SERVICES, id) || id === 'custom' ? id : '';
}

export function seoKeysForTier(tierId) {
  return seoKeysForServices(SEO_TIER_SERVICES[normalizeTierId(tierId)] || SEO_TIER_SERVICES['tier-1-standard']);
}

/** WS6 treeInputFromLegacy mapping, SEO part: analytics → seo, blog → blog, ecommerce → ecom. */
export function servicesFromLegacyFeatures(features = {}) {
  const services = ['site'];
  if (features?.analytics) services.push('seo');
  if (features?.blog) services.push('blog');
  if (features?.ecommerce) services.push('ecom');
  return services;
}

/**
 * Read a resolved WS6 tree in any of its likely shapes: { effective: [...] | Set },
 * an array of keys, or { key: boolean }.
 */
function keysFromTree(tree) {
  if (!tree) return null;
  const source = tree.effective ?? tree.keys ?? tree;
  const keys = new Set();
  if (source instanceof Set || Array.isArray(source)) {
    for (const key of source) keys.add(normalizeSeoFeatureKey(key));
  } else if (source && typeof source === 'object') {
    const off = new Set();
    for (const [key, value] of Object.entries(source)) {
      const k = normalizeSeoFeatureKey(key);
      if (value === true || value?.effective === true) keys.add(k);
      else if (value === false || value?.effective === false) off.add(k);
    }
    // An explicit "off" for an alias (blog.localPosts=false) wins over its target.
    for (const k of off) keys.delete(k);
  } else {
    return null;
  }
  return keys;
}

function siteTierId(site) {
  return normalizeTierId(site?.sitePlan?.tierId) || normalizeTierId(site?.websitePlan) || 'tier-1-standard';
}

/**
 * Effective SEO/blog features for a hub site record.
 * @param {object} site  hub site (sites.json shape; normalizeSite output works)
 * @param {{featureTree?: object, hubServicesActive?: boolean}} [opts]
 * @returns {{source: string, tierId: string, keys: Set<string>, list: string[], reports: 'basic'|'advanced'|null, has: (key: string) => boolean}}
 */
export function seoFeaturesForSite(site = {}, opts = {}) {
  const tierId = siteTierId(site);
  const tree = opts.featureTree || site?.featureTree || site?.effectiveFeatures || null;
  let keys = keysFromTree(tree);
  let source = 'tree';
  if (!keys) {
    if (site?.seoPackage === 'self-hosted' || site?.selfHosted === true) {
      keys = new Set(SELF_HOSTED_SEO_KEYS);
      source = 'self-hosted';
    } else if (tierId === 'custom') {
      keys = seoKeysForServices(servicesFromLegacyFeatures(site?.features || {}));
      source = 'legacy-fallback';
    } else {
      keys = seoKeysForTier(tierId);
      source = 'tier-fallback';
    }
  }
  // Agency overrides stored on the site (no env): { 'blog.autoPosts': false, ... }.
  const overrides = site?.seoFeatureOverrides && typeof site.seoFeatureOverrides === 'object' ? site.seoFeatureOverrides : {};
  for (const [rawKey, value] of Object.entries(overrides)) {
    const key = normalizeSeoFeatureKey(rawKey);
    if (!KEY_SET.has(key)) continue;
    if (value === false) keys.delete(key);
    else if (value === true) keys.add(key);
  }
  // Cancellation (Q58): hub services stop; the site's own head, sitemap and blog keep working.
  const hubActive = opts.hubServicesActive ?? site?.hubServicesActive;
  if (hubActive === false) for (const key of HUB_SERVICE_SEO_KEYS) keys.delete(key);

  const effective = closeOverParents(keys);
  const reports = effective.has('seo.reports.advanced') ? 'advanced' : effective.has('seo.reports.basic') ? 'basic' : null;
  return {
    source,
    tierId,
    keys: effective,
    list: [...effective].sort(),
    reports,
    has: (key) => effective.has(normalizeSeoFeatureKey(key)),
  };
}

export function hasSeoFeature(siteOrFeatures, key) {
  const features = siteOrFeatures && typeof siteOrFeatures.has === 'function' && siteOrFeatures.keys instanceof Set
    ? siteOrFeatures
    : seoFeaturesForSite(siteOrFeatures);
  return features.has(key);
}

/** Gate for every WS9 job: { allowed, key, reason }. */
export function seoJobAllowed(site, job, opts = {}) {
  const key = SEO_JOB_FEATURES[job];
  if (!key) return { allowed: false, key: null, reason: `unknown SEO job "${job}"` };
  const features = seoFeaturesForSite(site, opts);
  const allowed = features.has(key);
  return { allowed, key, reason: allowed ? 'entitled' : `${key} is not effective (${features.source}, ${features.tierId})` };
}
