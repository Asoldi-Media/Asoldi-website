/**
 * cms-spec writes and the AI prompt (WS6.8). One spec per site, owned by the hub:
 *   site.featureSpec  {rev, grantServices, revokeServices, grant, revoke, defaults, values, locks, updatedAt, updatedBy}
 *   site.cmsSpec      {rev, sections: {name: settings}, force: [section], updatedAt, updatedBy}
 *   site.cmsSpecHistory  the last 20 changes (what was sent, by whom, why, and the resulting revs)
 *
 * Merge rules (mergeSpec):
 *   - featureSpec lists (grantServices, revokeServices, grant, revoke, locks) are replaced by the list
 *     sent; granting an id that was revoked removes it from the revoke list unless that list is sent
 *     too, and the other way round;
 *   - featureSpec defaults and values merge per key; a key set to null is removed;
 *   - sections deep-merge one section at a time: objects merge, lists and plain values replace, null
 *     removes a field, and a whole section set to null is removed; list-shaped sections replace;
 *   - force replaces;
 *   - each part's rev goes up by one only when that part changed.
 * Everything sent is validated (exact paths) and so is the merged result.
 */
import { createHash } from 'node:crypto';
import { CMS_SPEC_HISTORY_MAX, normalizeCmsSpec, normalizeFeatureSpec } from '../data/feature-spec-model.js';
import { SECTION_NAMES, SECTION_OWNERS, sectionPromptLines, validateCmsSpec, validateSection } from './cms-spec-schema.js';
import { featureSpecForSite, resolveSiteFeatures } from './cms-entitlements.js';

export const FEATURE_LIST_FIELDS = Object.freeze(['grantServices', 'revokeServices', 'grant', 'revoke', 'locks']);
const OPPOSITE = Object.freeze({ grantServices: 'revokeServices', revokeServices: 'grantServices', grant: 'revoke', revoke: 'grant' });
export const MAX_CMS_SPEC_BYTES = 256 * 1024;
export const MAX_FEATURE_SPEC_BYTES = 32 * 1024;
const MAX_HISTORY_PATCH_BYTES = 16 * 1024;
export const PROMPT_LIMIT = 12000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function dedupe(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((v) => String(v ?? '').trim()).filter(Boolean))];
}

function sha(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')}`;
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

/** The featureSpec part of a request with removals (null) taken out, for the registry validator. */
function featureSpecForValidation(patch) {
  if (!isPlainObject(patch)) return patch;
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'updatedAt' || key === 'updatedBy') continue;
    if ((key === 'defaults' || key === 'values') && isPlainObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
    } else out[key] = value;
  }
  return out;
}

/** Sections with nested removals (null) taken out, for the section validator. */
function withoutNulls(value) {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]));
}

export function mergeFeatureSpec(current = {}, patch = {}) {
  const next = structuredClone(isPlainObject(current) ? current : {});
  for (const field of FEATURE_LIST_FIELDS) {
    if (patch[field] !== undefined) next[field] = dedupe(patch[field]);
  }
  for (const [field, other] of Object.entries(OPPOSITE)) {
    if (patch[field] !== undefined && patch[other] === undefined && Array.isArray(next[other])) {
      next[other] = next[other].filter((id) => !next[field].includes(id));
    }
  }
  for (const field of ['defaults', 'values']) {
    if (!isPlainObject(patch[field])) continue;
    const map = { ...(isPlainObject(next[field]) ? next[field] : {}) };
    for (const [key, value] of Object.entries(patch[field])) {
      if (value === null) delete map[key];
      else map[key] = value;
    }
    next[field] = map;
  }
  return next;
}

function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return structuredClone(patch);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = structuredClone(value);
  }
  return out;
}

export function mergeSections(current = {}, patch = {}) {
  const next = structuredClone(isPlainObject(current) ? current : {});
  for (const [name, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
    if (value === null) delete next[name];
    else if (Array.isArray(value)) next[name] = structuredClone(value);
    else next[name] = deepMerge(isPlainObject(next[name]) ? next[name] : {}, value);
  }
  return next;
}

function sameJson(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Field order as stored, so "changed" compares content and not key order. */
function canonicalFeatureSpec(spec) {
  const n = normalizeFeatureSpec(spec) || { rev: 0 };
  const { rev: _rev, updatedAt: _at, updatedBy: _by, ...rest } = n;
  const out = {};
  for (const key of Object.keys(rest).sort()) {
    const value = rest[key];
    out[key] = isPlainObject(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
  }
  return out;
}

function historyPatch(body) {
  const patch = {};
  for (const key of ['featureSpec', 'sections', 'force']) if (body[key] !== undefined) patch[key] = body[key];
  if (bytes(patch) <= MAX_HISTORY_PATCH_BYTES) return patch;
  return { truncated: true, sha256: sha(patch), sections: isPlainObject(patch.sections) ? Object.keys(patch.sections) : [] };
}

/**
 * Applies one write to a site record (not saved). Returns
 *   { ok:true, changed, featureSpec, cmsSpec, historyRow, revs } or { ok:false, status, errors|message }.
 * `body` is { featureSpec?, sections?, force?, reason?, cmsSpecRev? }; featureSpec.rev and cmsSpecRev,
 * when given, must equal the current revs (409 otherwise).
 */
export function applyCmsSpecWrite(site, body, { registry, salesClient = null, by = 'admin', now = () => new Date().toISOString() } = {}) {
  if (!isPlainObject(body)) return { ok: false, status: 400, errors: [{ path: '', message: 'The body must be an object' }] };
  const { reason = '', cmsSpecRev, ...specPart } = body;
  const toValidate = {};
  if (specPart.featureSpec !== undefined) toValidate.featureSpec = featureSpecForValidation(specPart.featureSpec);
  if (specPart.sections !== undefined) toValidate.sections = isPlainObject(specPart.sections) ? withoutNulls(specPart.sections) : specPart.sections;
  if (specPart.force !== undefined) toValidate.force = specPart.force;
  for (const key of Object.keys(specPart)) if (!['featureSpec', 'sections', 'force'].includes(key)) toValidate[key] = specPart[key];
  if (!Object.keys(toValidate).length) return { ok: false, status: 400, errors: [{ path: '', message: 'Send featureSpec, sections or force' }] };
  const checked = validateCmsSpec(toValidate, { registry });
  if (!checked.ok) return { ok: false, status: 400, errors: checked.errors };

  const base = featureSpecForSite(site, null, { registry, salesClient });
  const currentFeature = base.spec;
  const currentCms = normalizeCmsSpec(site.cmsSpec) || { rev: 0, sections: {}, force: [] };
  if (specPart.featureSpec?.rev !== undefined && specPart.featureSpec.rev !== (currentFeature.rev ?? 0)) {
    return { ok: false, status: 409, message: `featureSpec is at rev ${currentFeature.rev ?? 0}; read it again and resend`, revs: { featureSpec: currentFeature.rev ?? 0, cmsSpec: currentCms.rev } };
  }
  if (cmsSpecRev !== undefined && cmsSpecRev !== currentCms.rev) {
    return { ok: false, status: 409, message: `cmsSpec is at rev ${currentCms.rev}; read it again and resend`, revs: { featureSpec: currentFeature.rev ?? 0, cmsSpec: currentCms.rev } };
  }

  const at = now();
  const actor = String(by || 'admin').slice(0, 120);
  let featureSpec = normalizeFeatureSpec(site.featureSpec);
  let featureChanged = false;
  if (specPart.featureSpec !== undefined) {
    const { rev: _rev, updatedAt: _a, updatedBy: _b, ...patch } = specPart.featureSpec;
    const merged = mergeFeatureSpec(currentFeature, patch);
    const mergedCheck = registry.validateFeatureSpec(featureSpecForValidation(merged), { prefix: 'featureSpec' });
    if (!mergedCheck.ok) return { ok: false, status: 400, errors: mergedCheck.errors };
    featureChanged = base.migrated || !sameJson(canonicalFeatureSpec(merged), canonicalFeatureSpec(currentFeature));
    if (featureChanged) {
      featureSpec = normalizeFeatureSpec({ ...merged, rev: (currentFeature.rev ?? 0) + 1, updatedAt: at, updatedBy: actor });
      if (bytes(featureSpec) > MAX_FEATURE_SPEC_BYTES) return { ok: false, status: 413, message: 'featureSpec is too large' };
    }
  }

  let cmsSpec = normalizeCmsSpec(site.cmsSpec);
  const changedSections = [];
  let forceChanged = false;
  if (specPart.sections !== undefined || specPart.force !== undefined) {
    const sections = specPart.sections !== undefined ? mergeSections(currentCms.sections, specPart.sections) : currentCms.sections;
    for (const name of new Set([...Object.keys(currentCms.sections), ...Object.keys(sections)])) {
      if (!sameJson(currentCms.sections[name], sections[name])) changedSections.push(name);
    }
    const errors = [];
    for (const name of changedSections) {
      if (sections[name] !== undefined) errors.push(...validateSection(name, sections[name], { registry }));
    }
    if (errors.length) return { ok: false, status: 400, errors };
    const force = specPart.force !== undefined ? dedupe(specPart.force) : currentCms.force;
    forceChanged = !sameJson(force, currentCms.force);
    if (changedSections.length || forceChanged) {
      cmsSpec = { rev: currentCms.rev + 1, sections, force, updatedAt: at, updatedBy: actor };
      if (bytes(cmsSpec) > MAX_CMS_SPEC_BYTES) return { ok: false, status: 413, message: `cmsSpec is larger than ${MAX_CMS_SPEC_BYTES} bytes` };
    }
  }

  const changed = featureChanged || changedSections.length > 0 || forceChanged;
  const revs = { featureSpec: featureSpec?.rev ?? currentFeature.rev ?? 0, cmsSpec: cmsSpec?.rev ?? 0 };
  const historyRow = changed
    ? {
        at,
        by: actor,
        reason: String(reason || '').slice(0, 300),
        featureSpecRev: revs.featureSpec,
        cmsSpecRev: revs.cmsSpec,
        changed: { featureSpec: featureChanged, sections: changedSections, force: forceChanged },
        ...(featureChanged && base.migrated ? { migratedFrom: 'legacy flags', notes: base.notes } : {}),
        patch: historyPatch(specPart),
      }
    : null;
  return { ok: true, changed, featureSpec, cmsSpec, historyRow, revs, migrated: base.migrated };
}

/** History with the new row, the last 20 kept. */
export function appendHistory(history, row) {
  if (!row) return Array.isArray(history) ? history.slice(-CMS_SPEC_HISTORY_MAX) : [];
  return [...(Array.isArray(history) ? history : []), row].slice(-CMS_SPEC_HISTORY_MAX);
}

/**
 * Prompt text for an AI writer: the resolved feature tree (the CMS's featurePromptBlock), the
 * section fields one per line, and the sections this site already has. At most 12,000 characters.
 */
export function cmsSpecPrompt(site, { registry, salesClient = null } = {}) {
  const result = resolveSiteFeatures(site, salesClient, { registry });
  const feature = registry.featurePromptBlock(result.resolved, { rev: result.spec.rev ?? 1, plan: result.input.tierId });
  const cms = normalizeCmsSpec(site?.cmsSpec);
  const present = cms ? Object.keys(cms.sections) : [];
  const lines = [
    feature,
    '',
    `cms-spec sections rev ${cms?.rev ?? 0}${present.length ? ` (set: ${present.join(', ')})` : ''}.`,
    'Send only canonical keys, service ids and values; aliases are rejected. A section or field set to null is removed.',
    'Objects merge into the stored section; lists replace. Sections the client edited are applied only when listed in "force".',
    `Owners: ${SECTION_NAMES.map((name) => `${name}=${SECTION_OWNERS[name]}`).join(' ')}`,
    ...sectionPromptLines(),
  ];
  let text = lines.join('\n');
  if (text.length > PROMPT_LIMIT) text = `${text.slice(0, PROMPT_LIMIT - 20)}\n... (truncated)`;
  return text;
}
