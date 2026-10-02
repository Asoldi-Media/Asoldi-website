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
import { normalizeDeliveryPhase, normalizeDevelopment, resolveSiteDeliveryPhase } from '../lib/development-phase.js';

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
  return {
    ...site,
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

export function getSiteConfig(siteKeyOrDomain, byDomain = false) {
  const site = byDomain ? getSiteByDomain(siteKeyOrDomain) : getSiteByKey(siteKeyOrDomain);
  if (!site) return null;
  const clientAdmin = normalizeClientAdmin(site.clientAdmin);
  return {
    id: site.id,
    name: site.name,
    domain: site.domain,
    features: site.features,
    ecommerceCatalogType: site.ecommerceCatalogType,
    websitePlan: site.websitePlan,
    desiredCmsVersion: desiredCmsVersion(site),
    analyticsLevel: site.analyticsLevel || 'none',
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
      ...(patch.cms || {}),
      ...(patch.githubRepo !== undefined ? { githubRepo: patch.githubRepo } : {}),
    });
  }
  if (patch.clientAdmin !== undefined) {
    current.clientAdmin = normalizeClientAdmin({ ...current.clientAdmin, ...patch.clientAdmin });
  }
  if (patch.deliveryPhase !== undefined) {
    current.deliveryPhase = normalizeDeliveryPhase(patch.deliveryPhase, current.deliveryPhase || 'client');
  }
  if (patch.development !== undefined) {
    current.development = normalizeDevelopment({ ...current.development, ...patch.development });
  }
  sites[i] = normalizeSite(current);
  writeSites(sites);
  return { ok: true, site: publicSite(sites[i]) };
}

export function recordHeartbeat(siteKey, { packageVersion, adminUrl, name, adminApplied } = {}) {
  const key = String(siteKey || '').trim();
  if (!key) return { ok: false, error: 'site_key required' };
  const sites = readSites();
  const i = sites.findIndex((s) => s.site_key === key);
  if (i === -1) return { ok: false, error: 'Site not found' };
  sites[i].cms = normalizeCmsMeta({
    ...sites[i].cms,
    lastSeenAt: new Date().toISOString(),
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

export async function updateClientAdmin(id, patch = {}) {
  const sites = readSites();
  const i = sites.findIndex((s) => s.id === id);
  if (i === -1) return { ok: false, error: 'Site not found' };
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
  if (patch.password) {
    next.passwordHash = await bcrypt.hash(String(patch.password), 12);
    next.pendingSync = true;
  }
  sites[i].clientAdmin = next;
  sites[i] = normalizeSite(sites[i]);
  writeSites(sites);
  return { ok: true, site: publicSite(sites[i]) };
}

export function deleteSite(id) {
  const sites = readSites();
  const filtered = sites.filter((s) => s.id !== id);
  if (filtered.length === sites.length) return { ok: false, error: 'Site not found' };
  writeSites(filtered);
  return { ok: true };
}

export { featuresFromPlan, normalizeWebsitePlan };
