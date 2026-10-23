import { readFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { getDataFilePath, ensurePersistentDataDir, writeDataJson } from './storage-path.js';
import {
  desiredCmsVersion,
  featuresFromPlan,
  normalizeCatalogType,
  normalizeCmsMeta,
  normalizeClientAdmin,
  normalizeFeatures,
  normalizeSite,
  normalizeWebsitePlan,
  publicClientAdmin,
  publicLocalBlog,
  resolveCatalogTypeForSite,
} from './hub-model.js';
import { hashLocalBlogToken, localBlogTokensMatch } from '../lib/local-blog-token.js';
import { clientAdminPasswordProblem } from '../lib/client-admin-password.js';
import { normalizeDeliveryPhase, normalizeDevelopment, resolveSiteDeliveryPhase } from '../lib/development-phase.js';
import { FUTURE_SITE_CMS_KEYS, withoutKeys } from './normalize-ext.js';
import { CMS_REPORTED_KEYS, cmsPatchFromHeartbeat } from './feature-spec-model.js';

// The one client admin password rule (lib/client-admin-password.js), also under the names that
// other hub code and tests import from here. Never define a second copy of it in this file.
export {
  clientAdminPasswordProblem,
  CLIENT_ADMIN_MIN_PASSWORD_LENGTH as MIN_CLIENT_ADMIN_PASSWORD_LENGTH,
  CLIENT_ADMIN_KNOWN_DEFAULT_PASSWORDS as WEAK_CLIENT_ADMIN_PASSWORDS,
} from '../lib/client-admin-password.js';

const SITES_PATH = getDataFilePath('sites.json');

function ensureDataDir() {
  ensurePersistentDataDir();
}

function readSites() {
  ensureDataDir();
  if (!existsSync(SITES_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(SITES_PATH, 'utf8'));
    return (Array.isArray(raw) ? raw : []).map(normalizeSite).filter((site) => site && site.id);
  } catch {
    return [];
  }
}

function writeSites(sites) {
  ensureDataDir();
  writeDataJson(SITES_PATH, sites.map(normalizeSite).filter(Boolean));
}

function publicSite(site) {
  if (!site) return null;
  // blogQueue (WS9.49) holds a token hash; it is kept on disk but never returned.
  const { blogQueue, ...rest } = site;
  return {
    ...rest,
    clientAdmin: publicClientAdmin(site.clientAdmin),
    localBlog: publicLocalBlog(site.localBlog),
  };
}

export function generateSiteKey() {
  return randomBytes(16).toString('hex');
}

export function getSiteByKey(siteKey) {
  const sites = readSites();
  return sites.find((s) => s.site_key === siteKey) || null;
}

export function getSiteByDomain(domain) {
  const sites = readSites();
  const normalized = (domain || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  return sites.find((s) => (s.domain || '').toLowerCase() === normalized) || null;
}

/**
 * Site config for a client CMS. `withFeatures(config, site, { byDomain })` (WS6.7) may return a
 * config with the feature tree; without it, or when it returns nothing, the answer is unchanged.
 */
export function getSiteConfig(siteKeyOrDomain, byDomain = false, { withFeatures = null } = {}) {
  const site = byDomain ? getSiteByDomain(siteKeyOrDomain) : getSiteByKey(siteKeyOrDomain);
  if (!site) return null;
  const config = baseSiteConfig(site, byDomain);
  if (typeof withFeatures !== 'function') return config;
  return withFeatures(config, site, { byDomain }) || config;
}

function baseSiteConfig(site, byDomain) {
  const config = {
    id: site.id,
    name: site.name,
    domain: site.domain,
    features: site.features,
    ecommerceCatalogType: site.ecommerceCatalogType,
    websitePlan: site.websitePlan,
    desiredCmsVersion: desiredCmsVersion(site),
    analyticsLevel: site.analyticsLevel || 'none',
  };
  // A domain (or Host header) is public, so domain lookups never carry admin data.
  // Only a caller holding the site key (the client CMS) gets the admin sync fields.
  if (byDomain) return config;
  const clientAdmin = normalizeClientAdmin(site.clientAdmin);
  return {
    ...config,
    clientAdmin: publicClientAdmin(clientAdmin),
    pendingAdmin:
      clientAdmin.pendingSync && clientAdmin.passwordHash
        ? {
            username: clientAdmin.username || clientAdmin.email || 'admin',
            passwordHash: clientAdmin.passwordHash,
          }
        : null,
  };
}

export function getAllSites() {
  return readSites().map(publicSite);
}

export function getSiteById(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  return readSites().find((site) => site.id === key) || null;
}

export function findSiteByLocalBlogToken(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  return readSites().find((site) => localBlogTokensMatch(site.localBlog?.tokenHash, value)) || null;
}

export function issueLocalBlogToken(id) {
  const sites = readSites();
  const i = sites.findIndex((site) => site.id === id);
  if (i === -1) return { ok: false, error: 'Site not found' };
  const token = randomBytes(24).toString('hex');
  sites[i].localBlog = {
    tokenHash: hashLocalBlogToken(token),
    issuedAt: new Date().toISOString(),
  };
  sites[i] = normalizeSite(sites[i]);
  writeSites(sites);
  return { ok: true, token, site: publicSite(sites[i]) };
}

export function reconcileDeliveryPhases(salesClients = []) {
  const sites = readSites();
  let changed = 0;
  const next = sites.map((site) => {
    const deliveryPhase = resolveSiteDeliveryPhase(site, salesClients);
    if (site.deliveryPhase === deliveryPhase) return site;
    changed += 1;
    return { ...site, deliveryPhase };
  });
  if (changed) writeSites(next);
  return {
    changed,
    development: next.filter((site) => site.deliveryPhase === 'development').length,
  };
}

export function createSite({
  name,
  domain,
  site_key,
  websitePlan,
  ecommerceCatalogType,
  githubRepo,
  features,
  deliveryPhase,
  development,
} = {}) {
  const requestedKey = String(site_key || '').trim();
  if (requestedKey) {
    const existingByKey = getSiteByKey(requestedKey);
    if (existingByKey) {
      const shouldPatch =
        (domain && existingByKey.domain !== domain) ||
        githubRepo ||
        (name && name !== existingByKey.name);
      if (shouldPatch) {
        const updated = updateSite(existingByKey.id, {
          domain: domain || existingByKey.domain,
          name: name || existingByKey.name,
          websitePlan,
          ecommerceCatalogType,
          githubRepo,
          features,
          deliveryPhase,
          development,
        });
        return updated.ok ? updated.site : publicSite(existingByKey);
      }
      return publicSite(existingByKey);
    }
  }
  if (domain) {
    const existingByDomain = getSiteByDomain(domain);
    if (existingByDomain) return publicSite(existingByDomain);
  }
  const sites = readSites();
  const siteKey = requestedKey || generateSiteKey();
  const id = String(Date.now());
  const plan = normalizeWebsitePlan(websitePlan);
  const nextFeatures = features ? normalizeFeatures(features) : featuresFromPlan(plan);
  const site = normalizeSite({
    id,
    site_key: siteKey,
    domain: domain || '',
    name: name || 'Unnamed site',
    websitePlan: plan,
    features: nextFeatures,
    ecommerceCatalogType: resolveCatalogTypeForSite({
      features: nextFeatures,
      ecommerceCatalogType,
    }),
    cms: {
      githubRepo: githubRepo || '',
    },
    deliveryPhase: normalizeDeliveryPhase(deliveryPhase, 'client'),
    development: normalizeDevelopment(development),
    createdAt: new Date().toISOString(),
  });
  sites.push(site);
  writeSites(sites);
  return publicSite(site);
}

export function updateSite(id, patch = {}) {
  const sites = readSites();
  const i = sites.findIndex((s) => s.id === id);
  if (i === -1) return { ok: false, error: 'Site not found' };
  const current = sites[i];
  if (patch.domain !== undefined) current.domain = patch.domain;
  if (patch.name !== undefined) current.name = patch.name;
  if (patch.websitePlan !== undefined) current.websitePlan = normalizeWebsitePlan(patch.websitePlan);
  if (patch.features !== undefined) current.features = normalizeFeatures({ ...current.features, ...patch.features });
  if (patch.ecommerceCatalogType !== undefined) {
    current.ecommerceCatalogType = current.features.ecommerce
      ? normalizeCatalogType(patch.ecommerceCatalogType) || 'normal'
      : null;
  } else {
    current.ecommerceCatalogType = resolveCatalogTypeForSite(current);
  }
  if (patch.githubRepo !== undefined || patch.cms !== undefined) {
    current.cms = normalizeCmsMeta({
      ...current.cms,
      // WS8.44: heartbeat-derived keys a later batch owns (effective, featuresRev, ...) come only
      // from the stored site, never from a request body.
      ...(withoutKeys(patch.cms, [...FUTURE_SITE_CMS_KEYS, ...CMS_REPORTED_KEYS]) || {}),
      ...(patch.githubRepo !== undefined ? { githubRepo: patch.githubRepo } : {}),
    });
  }
  if (patch.clientAdmin !== undefined) {
    // The CMS admin password changes only through updateClientAdmin (password rules, then bcrypt):
    // a hash or a pending flag in a site patch is ignored.
    const { passwordHash: _hash, pendingSync: _pending, ...adminPatch } =
      patch.clientAdmin && typeof patch.clientAdmin === 'object' ? patch.clientAdmin : {};
    current.clientAdmin = normalizeClientAdmin({ ...current.clientAdmin, ...adminPatch });
  }
  if (patch.deliveryPhase !== undefined) {
    current.deliveryPhase = normalizeDeliveryPhase(patch.deliveryPhase, current.deliveryPhase || 'client');
  }
  if (patch.development !== undefined) {
    current.development = normalizeDevelopment({ ...current.development, ...patch.development });
  }
  if (patch.websiteDueOverride !== undefined) {
    current.websiteDueOverride = patch.websiteDueOverride;
  }
  if (patch.isTest !== undefined) {
    current.isTest = patch.isTest === true;
  }
  sites[i] = normalizeSite(current);
  writeSites(sites);
  return { ok: true, site: publicSite(sites[i]) };
}

/**
 * `report` is the heartbeat body (WS6.7): the feature and settings revs, the effective keys, the
 * daily block counts, the migration summary and the sign-in report fields are kept in site.cms
 * (data/feature-spec-model.js cmsPatchFromHeartbeat picks and bounds them).
 */
export function recordHeartbeat(siteKey, { packageVersion, adminUrl, name, adminApplied, report = null } = {}) {
  const key = String(siteKey || '').trim();
  if (!key) return { ok: false, error: 'site_key required' };
  const sites = readSites();
  const i = sites.findIndex((s) => s.site_key === key);
  if (i === -1) return { ok: false, error: 'Site not found' };
  const nowIso = new Date().toISOString();
  sites[i].cms = normalizeCmsMeta({
    ...sites[i].cms,
    ...cmsPatchFromHeartbeat(sites[i].cms, report, nowIso),
    lastSeenAt: nowIso,
    packageVersion: packageVersion || sites[i].cms.packageVersion,
    adminUrl: adminUrl || sites[i].cms.adminUrl,
  });
  if (name && !sites[i].name) sites[i].name = name;
  if (adminApplied) {
    sites[i].clientAdmin = normalizeClientAdmin({
      ...sites[i].clientAdmin,
      pendingSync: false,
    });
  }
  writeSites(sites);
  return { ok: true, site: publicSite(sites[i]) };
}

/**
 * Sets the client CMS admin. A new password (anything but undefined, null or '') must pass
 * clientAdminPasswordProblem; otherwise nothing is stored and { ok: false, status: 400 } comes
 * back with the Norwegian reason. The hub keeps only the bcrypt hash.
 */
export async function updateClientAdmin(id, patch = {}) {
  const passwordGiven = patch.password !== undefined && patch.password !== null && patch.password !== '';
  if (passwordGiven) {
    const problem = clientAdminPasswordProblem(patch.password);
    if (problem) return { ok: false, status: 400, error: problem };
  }
  const sites = readSites();
  const i = sites.findIndex((s) => s.id === id);
  if (i === -1) return { ok: false, status: 404, error: 'Site not found' };
  const current = normalizeClientAdmin(sites[i].clientAdmin);
  const now = new Date().toISOString();
  const next = normalizeClientAdmin({
    ...current,
    name: patch.name !== undefined ? patch.name : current.name,
    email: patch.email !== undefined ? patch.email : current.email,
    username: patch.username !== undefined ? patch.username : current.username,
    avatarUrl: patch.avatarUrl !== undefined ? patch.avatarUrl : current.avatarUrl,
    createdAt: current.createdAt || now,
    updatedAt: now,
  });
  if (passwordGiven) {
    next.passwordHash = await bcrypt.hash(patch.password, 12);
    next.pendingSync = true;
  }
  sites[i].clientAdmin = next;
  sites[i] = normalizeSite(sites[i]);
  writeSites(sites);
  return { ok: true, site: publicSite(sites[i]) };
}

/**
 * Changes a site's feature spec fields (WS6.8) in one read-modify-write. `mutate(site)` returns
 * { ok:false, ... } to stop, or { ok:true, featureSpec?, cmsSpec?, cmsSpecHistory?, featureEnforcement?, ... };
 * only those four fields are taken from it. Returns mutate's result with the saved public site.
 */
export function updateSiteSpecs(id, mutate) {
  const sites = readSites();
  const i = sites.findIndex((s) => s.id === id);
  if (i === -1) return { ok: false, status: 404, error: 'Site not found' };
  const result = mutate(structuredClone(sites[i])) || { ok: false, status: 500, error: 'No result' };
  if (!result.ok) return result;
  const next = { ...sites[i] };
  for (const field of ['featureSpec', 'cmsSpec', 'cmsSpecHistory', 'featureEnforcement']) {
    if (result[field] !== undefined) next[field] = result[field];
  }
  sites[i] = normalizeSite(next);
  writeSites(sites);
  return { ...result, site: publicSite(sites[i]), record: sites[i] };
}

export function deleteSite(id) {
  const sites = readSites();
  const filtered = sites.filter((s) => s.id !== id);
  if (filtered.length === sites.length) return { ok: false, error: 'Site not found' };
  writeSites(filtered);
  return { ok: true };
}

export { featuresFromPlan, normalizeWebsitePlan };
