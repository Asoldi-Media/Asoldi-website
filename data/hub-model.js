import { normalizeDeliveryPhase, normalizeDevelopment } from '../lib/development-phase.js';
import { analyticsLevelFromFlags, legacyTierFlagsForServices, servicesForTier } from '../lib/website-tiers.js';
import { normalizeDueDate } from '../lib/website-due.js';
import { carryFutureKeys, FUTURE_SITE_CMS_KEYS, FUTURE_SITE_KEYS } from './normalize-ext.js';

export const WEBSITE_PLANS = [
  { id: 'tier-1-standard', name: 'Tier 1: Standard' },
  { id: 'tier-2-seo', name: 'Tier 2: SEO' },
  { id: 'tier-3-ecommerce', name: 'Tier 3: Nettbutikk' },
  { id: 'custom', name: 'Custom' },
];

export const CATALOG_TYPES = ['menu', 'tiers', 'normal'];

export const DEFAULT_FEATURES = {
  users: true,
  analytics: false,
  ecommerce: false,
  blog: false,
  socialSync: false,
  emailMarketing: false,
  general: false,
};

export function normalizeWebsitePlan(planId) {
  const id = String(planId || '').trim();
  if (WEBSITE_PLANS.some((plan) => plan.id === id)) return id;
  return 'tier-1-standard';
}

export function normalizeCatalogType(value) {
  if (value === 'menu' || value === 'tiers' || value === 'normal') return value;
  return null;
}

export function normalizeFeatures(features) {
  return {
    users: features?.users !== false,
    analytics: !!features?.analytics,
    ecommerce: !!features?.ecommerce,
    blog: !!features?.blog,
    socialSync: !!features?.socialSync,
    emailMarketing: !!features?.emailMarketing,
    general: !!features?.general,
  };
}

/**
 * The 7 legacy CMS flags for a website plan id. Delegates to the shared tier service matrix
 * (WS8.1): the flags of the tier's services, with the legacy meaning of `blog` (automatic posts,
 * part of the seo service). The output is unchanged for every plan; a custom plan has no services
 * by tier, so it keeps the defaults. Plan-based flags with blog on every tier come from
 * featuresFromServices (lib/website-tiers.js) once a site's plan carries services.
 */
export function featuresFromPlan(planId) {
  const plan = normalizeWebsitePlan(planId);
  if (plan === 'custom') return { ...DEFAULT_FEATURES };
  return legacyTierFlagsForServices(servicesForTier(plan));
}

export function emptyClientAdmin() {
  return {
    name: '',
    email: '',
    username: '',
    avatarUrl: '',
    createdAt: '',
    updatedAt: '',
    passwordHash: '',
    pendingSync: false,
  };
}

export function normalizeClientAdmin(raw) {
  const base = emptyClientAdmin();
  if (!raw || typeof raw !== 'object') return base;
  const createdAt = String(raw.createdAt || '');
  return {
    name: String(raw.name || '').trim(),
    email: String(raw.email || '').trim().toLowerCase(),
    username: String(raw.username || '').trim(),
    avatarUrl: String(raw.avatarUrl || '').trim(),
    createdAt,
    updatedAt: String(raw.updatedAt || createdAt),
    passwordHash: String(raw.passwordHash || ''),
    pendingSync: raw.pendingSync === true,
  };
}

export function publicClientAdmin(raw) {
  const row = normalizeClientAdmin(raw);
  return {
    name: row.name,
    email: row.email,
    username: row.username,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    passwordSet: Boolean(row.passwordHash),
  };
}

export function emptyLocalBlog() {
  return {
    tokenHash: '',
    issuedAt: '',
  };
}

export function normalizeLocalBlog(raw) {
  const base = emptyLocalBlog();
  if (!raw || typeof raw !== 'object') return base;
  return {
    tokenHash: String(raw.tokenHash || ''),
    issuedAt: String(raw.issuedAt || ''),
  };
}

/** Admin-facing view. The token hash never leaves the server. */
export function publicLocalBlog(raw) {
  const row = normalizeLocalBlog(raw);
  return {
    tokenSet: Boolean(row.tokenHash),
    issuedAt: row.issuedAt,
  };
}

export function emptyCmsMeta() {
  return {
    githubRepo: '',
    lastSeenAt: '',
    packageVersion: '',
    adminUrl: '',
    desiredPackageVersion: '',
  };
}

/**
 * What a heartbeat without a valid site credential reported (shown, never acted on), or null.
 * Values are capped; the hub never follows the address.
 */
export function normalizeUnverifiedCms(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const row = {
    packageVersion: String(raw.packageVersion || '').slice(0, 40),
    adminUrl: String(raw.adminUrl || '').slice(0, 300),
    name: String(raw.name || '').slice(0, 120),
    at: String(raw.at || '').slice(0, 40),
  };
  return row.packageVersion || row.adminUrl || row.name || row.at ? row : null;
}

export function normalizeCmsMeta(cms) {
  const base = emptyCmsMeta();
  if (!cms || typeof cms !== 'object') return base;
  const out = carryFutureKeys({
    githubRepo: String(cms.githubRepo || ''),
    lastSeenAt: String(cms.lastSeenAt || ''),
    packageVersion: String(cms.packageVersion || ''),
    adminUrl: String(cms.adminUrl || ''),
    desiredPackageVersion: String(cms.desiredPackageVersion || ''),
  }, cms, FUTURE_SITE_CMS_KEYS);
  // Site credential (lib/site-credentials.js): kept only when present, so other sites keep their shape.
  if (cms.lastVerifiedAt) out.lastVerifiedAt = String(cms.lastVerifiedAt).slice(0, 40);
  const unverified = normalizeUnverifiedCms(cms.unverified);
  if (unverified) out.unverified = unverified;
  return out;
}

export function resolveCatalogTypeForSite({ features, ecommerceCatalogType }) {
  const normalizedFeatures = normalizeFeatures(features);
  if (!normalizedFeatures.ecommerce) return null;
  return normalizeCatalogType(ecommerceCatalogType) || 'normal';
}

export function normalizeSite(site) {
  if (!site || typeof site !== 'object') return null;
  const websitePlan = normalizeWebsitePlan(site.websitePlan);
  const features = normalizeFeatures(site.features || featuresFromPlan(websitePlan));
  const out = {
    id: String(site.id || ''),
    site_key: String(site.site_key || ''),
    domain: String(site.domain || ''),
    name: String(site.name || 'Unnamed site'),
    websitePlan,
    features,
    ecommerceCatalogType: resolveCatalogTypeForSite({
      features,
      ecommerceCatalogType: site.ecommerceCatalogType,
    }),
    cms: normalizeCmsMeta(site.cms),
    localBlog: normalizeLocalBlog(site.localBlog),
    clientAdmin: normalizeClientAdmin(site.clientAdmin),
    deliveryPhase: normalizeDeliveryPhase(site.deliveryPhase, 'client'),
    development: normalizeDevelopment(site.development),
    websiteDueOverride: normalizeDueDate(site.websiteDueOverride),
    createdAt: site.createdAt || new Date().toISOString(),
    analyticsLevel: analyticsLevelFromFlags({ planId: websitePlan, features }),
  };
  // WS8.56: stored only when true, so existing sites keep their shape.
  if (site.isTest === true) out.isTest = true;
  // WS8.44: keys a later batch writes survive this code (see data/normalize-ext.js).
  carryFutureKeys(out, site, FUTURE_SITE_KEYS);
  if (out.isTest !== true) delete out.isTest;
  return out;
}

export function desiredCmsVersion(site) {
  const fromSite = String(site?.cms?.desiredPackageVersion || '').trim();
  if (fromSite) return fromSite;
  const fromEnv = String(process.env.CMS_DESIRED_PACKAGE_VERSION || '').trim();
  return fromEnv || null;
}
