// CMS feature tree switch (WS6.7, WS6.8): <dataDir>/cms-feature-settings.json, edited from Superadmin.
//
// The feature tree ships dark. With no file (or mode 'off') /api/hub/site-config answers exactly as
// before. 'shadow' computes the tree for every site-config call and records the result for the
// preview page, but returns the old answer. 'on' returns the tree, the derived legacy flags and the
// pending settings to the sites in siteIds (or every site with allSites); the other sites are shadowed.
// The Maker host token may read and write /api/hub/sites/:id/cms-spec only once cmsSpec.makerAccess is true.
// Nothing here comes from Hostinger env.
import { join } from 'node:path';
import { readJsonCached, updateJsonLocked } from './atomic-json.js';
import { getPersistentDataDir } from './storage-path.js';

export const CMS_FEATURE_SETTINGS_FILE = 'cms-feature-settings.json';
export const CMS_FEATURE_SETTINGS_VERSION = 1;
export const SITE_CONFIG_MODES = Object.freeze(['off', 'shadow', 'on']);
const HISTORY_MAX = 20;
const MAX_SITE_IDS = 500;

export function defaultCmsFeatureSettings() {
  return {
    version: CMS_FEATURE_SETTINGS_VERSION,
    siteConfig: { mode: 'off', siteIds: [], allSites: false },
    cmsSpec: { makerAccess: false },
    updatedAt: '',
    updatedBy: '',
    history: [],
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const id = String(entry ?? '').trim().slice(0, 80);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= MAX_SITE_IDS) break;
  }
  return out;
}

/** Any stored object -> the full settings shape. Unknown or broken values fall back to the defaults. */
export function normalizeCmsFeatureSettings(raw) {
  const base = defaultCmsFeatureSettings();
  if (!isPlainObject(raw)) return base;
  const siteConfig = isPlainObject(raw.siteConfig) ? raw.siteConfig : {};
  const cmsSpec = isPlainObject(raw.cmsSpec) ? raw.cmsSpec : {};
  return {
    version: CMS_FEATURE_SETTINGS_VERSION,
    siteConfig: {
      mode: SITE_CONFIG_MODES.includes(siteConfig.mode) ? siteConfig.mode : 'off',
      siteIds: idList(siteConfig.siteIds),
      allSites: siteConfig.allSites === true,
    },
    cmsSpec: { makerAccess: cmsSpec.makerAccess === true },
    updatedAt: String(raw.updatedAt || ''),
    updatedBy: String(raw.updatedBy || ''),
    history: Array.isArray(raw.history) ? raw.history.filter(isPlainObject).slice(-HISTORY_MAX) : [],
  };
}

export function cmsFeatureSettingsPath(dataDir) {
  return join(dataDir || getPersistentDataDir(), CMS_FEATURE_SETTINGS_FILE);
}

/** Cached read (mtime-checked); safe on the site-config hot path. */
export function readCmsFeatureSettings({ dataDir } = {}) {
  return normalizeCmsFeatureSettings(readJsonCached(cmsFeatureSettingsPath(dataDir)));
}

/** Errors for a settings patch ({path, message}); empty when it is valid. */
export function validateCmsFeatureSettingsPatch(patch) {
  const errors = [];
  if (!isPlainObject(patch)) return [{ path: '', message: 'Must be an object' }];
  for (const key of Object.keys(patch)) {
    if (!['siteConfig', 'cmsSpec'].includes(key)) errors.push({ path: key, message: 'Unknown field. Allowed: siteConfig, cmsSpec' });
  }
  if (patch.siteConfig !== undefined) {
    if (!isPlainObject(patch.siteConfig)) errors.push({ path: 'siteConfig', message: 'Must be an object' });
    else {
      for (const key of Object.keys(patch.siteConfig)) {
        if (!['mode', 'siteIds', 'allSites'].includes(key)) errors.push({ path: `siteConfig.${key}`, message: 'Unknown field' });
      }
      const { mode, siteIds, allSites } = patch.siteConfig;
      if (mode !== undefined && !SITE_CONFIG_MODES.includes(mode)) {
        errors.push({ path: 'siteConfig.mode', message: `Use one of: ${SITE_CONFIG_MODES.join(', ')}` });
      }
      if (siteIds !== undefined && (!Array.isArray(siteIds) || siteIds.some((id) => typeof id !== 'string' || !id.trim()))) {
        errors.push({ path: 'siteConfig.siteIds', message: 'Must be a list of site ids' });
      }
      if (allSites !== undefined && typeof allSites !== 'boolean') errors.push({ path: 'siteConfig.allSites', message: 'Must be true or false' });
    }
  }
  if (patch.cmsSpec !== undefined) {
    if (!isPlainObject(patch.cmsSpec)) errors.push({ path: 'cmsSpec', message: 'Must be an object' });
    else {
      for (const key of Object.keys(patch.cmsSpec)) {
        if (key !== 'makerAccess') errors.push({ path: `cmsSpec.${key}`, message: 'Unknown field' });
      }
      if (patch.cmsSpec.makerAccess !== undefined && typeof patch.cmsSpec.makerAccess !== 'boolean') {
        errors.push({ path: 'cmsSpec.makerAccess', message: 'Must be true or false' });
      }
    }
  }
  return errors;
}

/** Applies a validated patch under the file lock. Returns { ok, settings } or { ok:false, errors }. */
export function saveCmsFeatureSettings(patch, { dataDir, by = 'admin', reason = '', now = () => new Date().toISOString() } = {}) {
  const errors = validateCmsFeatureSettingsPatch(patch);
  if (errors.length) return { ok: false, errors };
  let saved = null;
  updateJsonLocked(cmsFeatureSettingsPath(dataDir), (current) => {
    const prev = normalizeCmsFeatureSettings(current);
    const next = normalizeCmsFeatureSettings({
      ...prev,
      siteConfig: { ...prev.siteConfig, ...(patch.siteConfig || {}) },
      cmsSpec: { ...prev.cmsSpec, ...(patch.cmsSpec || {}) },
    });
    const at = now();
    next.updatedAt = at;
    next.updatedBy = String(by || 'admin').slice(0, 120);
    next.history = [
      ...prev.history,
      { at, by: next.updatedBy, reason: String(reason || '').slice(0, 300), siteConfig: next.siteConfig, cmsSpec: next.cmsSpec },
    ].slice(-HISTORY_MAX);
    saved = next;
    return next;
  });
  return { ok: true, settings: saved };
}

/**
 * How site-config treats one site: 'off' (old answer, nothing computed), 'shadow' (computed and
 * recorded, old answer) or 'on' (the tree is returned).
 */
export function siteConfigModeFor(site, settings) {
  const config = normalizeCmsFeatureSettings(settings).siteConfig;
  if (config.mode === 'off') return 'off';
  if (config.mode === 'shadow') return 'shadow';
  const listed = config.allSites || config.siteIds.includes(String(site?.id || ''));
  return listed ? 'on' : 'shadow';
}
