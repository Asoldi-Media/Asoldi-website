import { normalizeDeliveryPhase, normalizeDevelopment } from '../lib/development-phase.js';
import { analyticsLevelFromFlags } from '../lib/website-tiers.js';
import { normalizeDueDate } from '../lib/website-due.js';
import { carryFutureKeys, FUTURE_SITE_CMS_KEYS, FUTURE_SITE_KEYS } from './normalize-ext.js';
import {
  CMS_REPORTED_KEYS,
  normalizeCmsReportedFields,
  normalizeCmsSpec,
  normalizeCmsSpecHistory,
  normalizeFeatureEnforcement,
  normalizeFeatureSpec,
} from './feature-spec-model.js';

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

export function featuresFromPlan(planId) {
  switch (normalizeWebsitePlan(planId)) {
    case 'tier-2-seo':
      return {
        users: true,
        analytics: true,
        ecommerce: false,
        blog: true,
        socialSync: true,
        emailMarketing: true,
        general: false,
      };
    case 'tier-3-ecommerce':
      return {
        users: true,
        analytics: true,
        ecommerce: true,
        blog: true,
        socialSync: true,
        emailMarketing: true,
        general: true,
      };
    case 'custom':
      return { ...DEFAULT_FEATURES };
    case 'tier-1-standard':
    default:
      return { ...DEFAULT_FEATURES };
  }
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

export function normalizeCmsMeta(cms) {
  const base = emptyCmsMeta();
  if (!cms || typeof cms !== 'object') return base;
  // WS6.7: what the CMS reports in its heartbeat, each field only when it was reported.
  const reported = normalizeCmsReportedFields(cms);
  const out = carryFutureKeys({
    githubRepo: String(cms.githubRepo || ''),
    lastSeenAt: String(cms.lastSeenAt || ''),
    packageVersion: String(cms.packageVersion || ''),
    adminUrl: String(cms.adminUrl || ''),
    desiredPackageVersion: String(cms.desiredPackageVersion || ''),
    ...reported,
  }, cms, FUTURE_SITE_CMS_KEYS);
  // A reported field that did not normalize is dropped, never carried through as it was. Only the
  // keys this code owns: a key another batch appends to FUTURE_SITE_CMS_KEYS is carried as it is.
  for (const key of CMS_REPORTED_KEYS) {
    if (!(key in reported)) delete out[key];
  }
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
  // WS6.7 / WS6.8: the feature spec, the settings spec and its history, and the enforcement mode,
  // each stored only when the site has one (lib/cms-entitlements.js fills in the rest on read).
  const featureSpec = normalizeFeatureSpec(site.featureSpec);
  if (featureSpec) out.featureSpec = featureSpec;
  const cmsSpec = normalizeCmsSpec(site.cmsSpec);
  if (cmsSpec) out.cmsSpec = cmsSpec;
  if (Array.isArray(site.cmsSpecHistory)) out.cmsSpecHistory = normalizeCmsSpecHistory(site.cmsSpecHistory);
  const featureEnforcement = normalizeFeatureEnforcement(site.featureEnforcement);
  if (featureEnforcement) out.featureEnforcement = featureEnforcement;
  // WS8.44: keys a later batch writes survive this code (see data/normalize-ext.js).
  carryFutureKeys(out, site, FUTURE_SITE_KEYS);
  if (out.isTest !== true) delete out.isTest;
  // Owned now: a value that did not normalize is dropped, never carried through as it was.
  if (!featureSpec) delete out.featureSpec;
  if (!cmsSpec) delete out.cmsSpec;
  if (!Array.isArray(site.cmsSpecHistory)) delete out.cmsSpecHistory;
  if (!featureEnforcement) delete out.featureEnforcement;
  return out;
}

export function desiredCmsVersion(site) {
  const fromSite = String(site?.cms?.desiredPackageVersion || '').trim();
  if (fromSite) return fromSite;
  const fromEnv = String(process.env.CMS_DESIRED_PACKAGE_VERSION || '').trim();
  return fromEnv || null;
}
