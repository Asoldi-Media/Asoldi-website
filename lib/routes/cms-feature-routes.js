// CMS feature tree and cms-spec routes (WS6.7, WS6.8). Registered from server.js with
// registerCmsFeatureRoutes(app, {...}); the returned siteConfigFeatures hook is passed to
// hub.getSiteConfig by the site-config routes.
//
// Ships dark: until Superadmin switches <dataDir>/cms-feature-settings.json on, site-config answers
// exactly as before and the Maker token cannot use cms-spec. Nothing here sends e-mail or calls out.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readCmsFeatureSettings,
  saveCmsFeatureSettings,
  siteConfigModeFor,
} from '../../data/cms-feature-settings.js';
import { featureEnforcementOf, normalizeFeatureEnforcement } from '../../data/feature-spec-model.js';
import { featureRegistryStatus } from '../cms-features.js';
import {
  cmsFeatureRegistry,
  featureTreeForConfig,
  legacyFlagsLost,
  pendingSettingsFor,
  resolveSiteFeatures,
  siteConfigWithTree,
} from '../cms-entitlements.js';
import { appendHistory, applyCmsSpecWrite, cmsSpecPrompt } from '../cms-spec.js';
import { salesClientForSite } from '../local-blog-brief.js';

const META_URL = new URL('../../data/cms-feature-tree.meta.json', import.meta.url);
const SHADOW_MAX = 1000;
// site-config is called often; the sales client list is read at most this often for it.
const SALES_CLIENTS_TTL_MS = 30_000;

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function readMeta() {
  try {
    return JSON.parse(readFileSync(fileURLToPath(META_URL), 'utf8'));
  } catch {
    return null;
  }
}

function hasMakerHeader(req) {
  return Boolean(String(req.headers['x-maker-callback-token'] || req.headers['x-sales-callback-token'] || '').trim());
}

/** The old and the new site-config side by side, without admin fields (preview and shadow). */
function configDiff(before, after) {
  const changed = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed[key] = { before: before[key] ?? null, after: after[key] ?? null };
  }
  return changed;
}

/**
 * @param {import('express').Express} app
 * @param {{ adminAuth: Function, hub: object, sales: object, isMakerAuthorized?: (req) => boolean,
 *           getDataDir?: () => string, log?: Console }} deps
 * @returns {{ siteConfigFeatures: Function, shadowRecords: () => object[] }}
 */
export function registerCmsFeatureRoutes(app, { adminAuth, hub, sales, isMakerAuthorized = () => false, getDataDir = null, log = console }) {
  const dataDir = () => (typeof getDataDir === 'function' ? getDataDir() : undefined);
  const settings = () => readCmsFeatureSettings({ dataDir: dataDir() });
  const shadow = new Map();

  const status = featureRegistryStatus();
  if (!status.ok) log.error?.(`[cms-features] the synced feature registry did not load: ${status.error}. site-config keeps its old answer.`);

  let salesClientsCache = { at: 0, list: [] };
  function salesClients() {
    const now = Date.now();
    if (now - salesClientsCache.at > SALES_CLIENTS_TTL_MS) {
      salesClientsCache = { at: now, list: sales?.getSalesClients?.() || [] };
    }
    return salesClientsCache.list;
  }

  function salesClientFor(site) {
    try {
      return salesClientForSite(site, salesClients());
    } catch {
      return null;
    }
  }

  function remember(site, row) {
    if (!site?.id) return;
    shadow.delete(site.id);
    shadow.set(site.id, { siteId: site.id, at: new Date().toISOString(), ...row });
    while (shadow.size > SHADOW_MAX) shadow.delete(shadow.keys().next().value);
  }

  /** hub.getSiteConfig hook: the old answer unless the switch is on for this site. Never throws. */
  function siteConfigFeatures(config, site, { byDomain = false } = {}) {
    let mode;
    try {
      mode = siteConfigModeFor(site, settings());
    } catch {
      return config;
    }
    if (mode === 'off') return config;
    try {
      const registry = cmsFeatureRegistry();
      if (!registry) {
        remember(site, { mode, ok: false, error: 'feature registry not loaded' });
        return config;
      }
      const result = resolveSiteFeatures(site, salesClientFor(site), { registry, log });
      const next = siteConfigWithTree(config, site, result, { byDomain });
      remember(site, {
        mode,
        ok: true,
        source: result.input.source,
        services: result.resolved.services,
        migrated: result.migrated,
        entitledCount: result.resolved.entitled.size,
        lostFlags: legacyFlagsLost(site, result.legacy).filter((flag) => flag !== 'socialSync'),
        features: configDiff({ features: config.features }, { features: next.features }).features || null,
      });
      return mode === 'on' ? next : config;
    } catch (error) {
      remember(site, { mode, ok: false, error: String(error?.message || error).slice(0, 300) });
      log.warn?.(`[cms-features] site ${site?.id}: tree not applied (${error?.message || error})`);
      return config;
    }
  }

  function adminOrMaker(req, res, next) {
    if (hasMakerHeader(req)) {
      if (!isMakerAuthorized(req)) return res.status(401).json({ message: 'Unauthorized' });
      if (!settings().cmsSpec.makerAccess) {
        return res.status(403).json({ message: 'Maker access to cms-spec is switched off (Superadmin, CMS features).' });
      }
      req.cmsSpecActor = 'maker';
      return next();
    }
    return adminAuth(req, res, () => {
      req.cmsSpecActor = `admin:${String(req.admin?.username || 'admin').slice(0, 100)}`;
      next();
    });
  }

  function requireRegistry(res) {
    const registry = cmsFeatureRegistry();
    if (!registry) {
      res.status(503).json({ message: 'The CMS feature registry is not loaded on this hub.', status: featureRegistryStatus() });
      return null;
    }
    return registry;
  }

  // --- Superadmin: switch, registry status and the shadow results
  app.get('/api/admin/cms-features', adminAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const meta = readMeta();
    res.json({
      registry: { ...featureRegistryStatus(), registryVersion: meta?.registryVersion || null, keyCount: meta?.keyCount || 0, sourceCommit: meta?.sourceCommit || null },
      settings: settings(),
      shadow: [...shadow.values()].reverse(),
    });
  });

  app.put('/api/admin/cms-features/settings', adminAuth, (req, res) => {
    const body = bodyOf(req);
    const wrapped = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings);
    const result = saveCmsFeatureSettings(wrapped ? body.settings : body, {
      dataDir: dataDir(),
      by: `admin:${String(req.admin?.username || 'admin').slice(0, 100)}`,
      reason: wrapped ? String(body.reason || '') : '',
    });
    if (!result.ok) return res.status(400).json({ message: 'Invalid CMS feature settings.', errors: result.errors });
    res.json({ settings: result.settings });
  });

  // What site-config would answer with the tree, per site, next to today's answer (public fields only).
  app.get('/api/admin/cms-features/preview', adminAuth, (req, res) => {
    const registry = requireRegistry(res);
    if (!registry) return;
    const only = String(req.query.siteId || '').trim();
    const current = settings();
    const sites = hub.getAllSites().filter((site) => !only || site.id === only);
    const rows = [];
    for (const publicRow of sites) {
      const site = hub.getSiteById(publicRow.id);
      if (!site) continue;
      const before = hub.getSiteConfig(site.domain || site.site_key, Boolean(site.domain)) || {};
      try {
        const result = resolveSiteFeatures(site, salesClientFor(site), { registry, log });
        const after = siteConfigWithTree(before, site, result, { byDomain: true });
        rows.push({
          siteId: site.id,
          name: site.name,
          mode: siteConfigModeFor(site, current),
          source: result.input.source,
          migrated: result.migrated,
          notes: result.notes,
          unknownServices: result.unknownServices,
          lostFlags: legacyFlagsLost(site, result.legacy).filter((flag) => flag !== 'socialSync'),
          changes: configDiff(
            { features: before.features, ecommerceCatalogType: before.ecommerceCatalogType, analyticsLevel: before.analyticsLevel },
            { features: after.features, ecommerceCatalogType: after.ecommerceCatalogType, analyticsLevel: after.analyticsLevel },
          ),
          featureTree: after.featureTree,
          effective: [...result.resolved.effective],
          pendingSettings: pendingSettingsFor(site),
          warnings: result.resolved.warnings,
        });
      } catch (error) {
        rows.push({ siteId: site.id, name: site.name, error: String(error?.message || error).slice(0, 300) });
      }
    }
    res.json({ settings: current, sites: rows });
  });

  // --- cms-spec (WS6.8)
  app.get('/api/hub/sites/:id/cms-spec', adminOrMaker, (req, res) => {
    const registry = requireRegistry(res);
    if (!registry) return;
    const site = hub.getSiteById(req.params.id);
    if (!site) return res.status(404).json({ message: 'Site not found' });
    const result = resolveSiteFeatures(site, salesClientFor(site), { registry, log });
    const cms = site.cms || {};
    res.set('Cache-Control', 'no-store');
    res.json({
      siteId: site.id,
      featureSpec: result.spec,
      featureSpecMigrated: result.migrated,
      cmsSpec: site.cmsSpec || { rev: 0, sections: {}, force: [] },
      history: site.cmsSpecHistory || [],
      featureEnforcement: featureEnforcementOf(site),
      tree: {
        ...featureTreeForConfig(result),
        effective: [...result.resolved.effective],
        unknownServices: result.unknownServices,
        warnings: result.resolved.warnings,
        legacy: result.legacy,
      },
      cmsReported: {
        packageVersion: cms.packageVersion || '',
        featuresRev: cms.featuresRev ?? null,
        clientFeaturesRev: cms.clientFeaturesRev ?? null,
        settingsRevApplied: cms.settingsRevApplied ?? null,
        settingsConflicts: cms.settingsConflicts || [],
        effective: cms.effective ? String(cms.effective).split(',') : null,
        effectiveHash: cms.effectiveHash || null,
        blockHistory: cms.blockHistory || [],
        lastHeartbeatAt: cms.lastHeartbeatAt || null,
      },
      pendingSettings: pendingSettingsFor(site),
      siteConfigMode: siteConfigModeFor(site, settings()),
    });
  });

  app.get('/api/hub/sites/:id/cms-spec/prompt', adminOrMaker, (req, res) => {
    const registry = requireRegistry(res);
    if (!registry) return;
    const site = hub.getSiteById(req.params.id);
    if (!site) return res.status(404).json({ message: 'Site not found' });
    const prompt = cmsSpecPrompt(site, { registry, salesClient: salesClientFor(site) });
    res.set('Cache-Control', 'no-store');
    res.json({ prompt, length: prompt.length });
  });

  // Body: { featureSpec?, sections?, force?, reason?, cmsSpecRev?, featureEnforcement? (admin only) }.
  app.put('/api/hub/sites/:id/cms-spec', adminOrMaker, (req, res) => {
    const registry = requireRegistry(res);
    if (!registry) return;
    const { featureEnforcement, ...body } = bodyOf(req);
    let enforcement;
    if (featureEnforcement !== undefined) {
      if (req.cmsSpecActor === 'maker') return res.status(403).json({ message: 'Only Superadmin sets featureEnforcement.' });
      enforcement = normalizeFeatureEnforcement(featureEnforcement);
      if (!enforcement) return res.status(400).json({ errors: [{ path: 'featureEnforcement', message: 'Use one of: off, log, on' }] });
    }
    const specKeys = Object.keys(body).filter((key) => !['reason', 'cmsSpecRev'].includes(key));
    if (!specKeys.length && enforcement === undefined) {
      return res.status(400).json({ message: 'Invalid cms-spec.', errors: [{ path: '', message: 'Send featureSpec, sections, force or featureEnforcement' }] });
    }
    const result = hub.updateSiteSpecs(req.params.id, (site) => {
      const write = specKeys.length
        ? applyCmsSpecWrite(site, body, { registry, salesClient: salesClientFor(site), by: req.cmsSpecActor })
        : { ok: true, changed: false, historyRow: null, revs: null };
      if (!write.ok) return write;
      const out = { ok: true, changed: write.changed, revs: write.revs };
      if (write.changed) {
        if (write.featureSpec) out.featureSpec = write.featureSpec;
        if (write.cmsSpec) out.cmsSpec = write.cmsSpec;
      }
      let historyRow = write.historyRow;
      if (enforcement && enforcement !== featureEnforcementOf(site)) {
        out.featureEnforcement = enforcement;
        out.changed = true;
        historyRow = {
          ...(historyRow || { at: new Date().toISOString(), by: req.cmsSpecActor, reason: String(body.reason || '').slice(0, 300) }),
          featureEnforcement: { from: featureEnforcementOf(site), to: enforcement },
        };
      }
      if (historyRow) out.cmsSpecHistory = appendHistory(site.cmsSpecHistory, historyRow);
      return out;
    });
    if (!result.ok) {
      const status = result.status || 400;
      return res.status(status).json(result.errors ? { message: 'Invalid cms-spec.', errors: result.errors } : { message: result.message || result.error, revs: result.revs });
    }
    const record = result.record;
    res.json({
      ok: true,
      changed: result.changed,
      featureSpecRev: record.featureSpec?.rev ?? null,
      cmsSpecRev: record.cmsSpec?.rev ?? 0,
      featureEnforcement: featureEnforcementOf(record),
      historyLength: (record.cmsSpecHistory || []).length,
    });
  });

  return { siteConfigFeatures, shadowRecords: () => [...shadow.values()] };
}
