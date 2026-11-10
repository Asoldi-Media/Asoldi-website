// Pure helpers for the feature-tree editor.
//
// Tri-state mapping (one feature key):
//   inherit -> the key is in neither featureSpec.grant nor featureSpec.revoke
//   grant   -> the key is in featureSpec.grant and not in featureSpec.revoke
//   revoke  -> the key is in featureSpec.revoke and not in featureSpec.grant
// Services use the same three states on grantServices / revokeServices.
// defaults[key] is the agency "default enabled" boolean. When it matches the registry
// default the key is omitted, so the registry stays the source.
// values[key] is the chosen enum value. locks lists keys whose lock checkbox is on.
// A spec diff sends only the lists and maps that changed. A removed default or value is null.

const LIST_FIELDS = ['grantServices', 'revokeServices', 'grant', 'revoke', 'locks'];

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function list(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function cloneSpec(spec) {
  const source = isPlain(spec) ? spec : {};
  return {
    ...source,
    grantServices: list(source.grantServices),
    revokeServices: list(source.revokeServices),
    grant: list(source.grant),
    revoke: list(source.revoke),
    locks: list(source.locks),
    defaults: { ...(isPlain(source.defaults) ? source.defaults : {}) },
    values: { ...(isPlain(source.values) ? source.values : {}) },
  };
}

function stateOf(on, off) {
  if (on) return 'grant';
  if (off) return 'revoke';
  return 'inherit';
}

export function triStateOf(spec, key) {
  const name = String(key || '');
  return stateOf(list(spec?.grant).includes(name), list(spec?.revoke).includes(name));
}

export function serviceTriOf(spec, serviceId) {
  const name = String(serviceId || '');
  return stateOf(list(spec?.grantServices).includes(name), list(spec?.revokeServices).includes(name));
}

function withState(spec, key, state, onField, offField) {
  const next = cloneSpec(spec);
  const name = String(key || '');
  next[onField] = next[onField].filter((entry) => entry !== name);
  next[offField] = next[offField].filter((entry) => entry !== name);
  if (state === 'grant') next[onField].push(name);
  else if (state === 'revoke') next[offField].push(name);
  return next;
}

export function applyTriState(spec, key, state) {
  return withState(spec, key, state, 'grant', 'revoke');
}

export function applyServiceTri(spec, serviceId, state) {
  return withState(spec, serviceId, state, 'grantServices', 'revokeServices');
}

export function defaultEnabledOf(spec, node) {
  const stored = spec?.defaults?.[node?.key];
  if (typeof stored === 'boolean') return stored;
  return node?.default === true;
}

/** Sets or clears defaults[key]. Matching the registry default removes the override. */
export function applyDefaultEnabled(spec, key, enabled, registryDefault) {
  const next = cloneSpec(spec);
  if (enabled === registryDefault) delete next.defaults[key];
  else next.defaults[key] = enabled;
  return next;
}

export function applyEnumValue(spec, key, value, registryDefault) {
  const next = cloneSpec(spec);
  if (value === registryDefault || value === '' || value == null) delete next.values[key];
  else next.values[key] = value;
  return next;
}

export function applyLock(spec, key, locked) {
  const next = cloneSpec(spec);
  const name = String(key || '');
  next.locks = next.locks.filter((entry) => entry !== name);
  if (locked) next.locks.push(name);
  return next;
}

function sameList(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/** Changed featureSpec fields only. Lists replace; a cleared default or value is null. */
export function diffFeatureSpecs(before, after) {
  const from = cloneSpec(before);
  const to = cloneSpec(after);
  const patch = {};
  for (const field of LIST_FIELDS) {
    if (!sameList(from[field], to[field])) patch[field] = to[field];
  }
  for (const field of ['defaults', 'values']) {
    if (JSON.stringify(from[field]) === JSON.stringify(to[field])) continue;
    const map = { ...to[field] };
    for (const key of Object.keys(from[field])) {
      if (!(key in to[field])) map[key] = null;
    }
    patch[field] = map;
  }
  return patch;
}

function parentKey(key) {
  const at = String(key).lastIndexOf('.');
  return at === -1 ? '' : String(key).slice(0, at);
}

/** Nested registry nodes as a flat list in tree order, plus the node count. */
export function flattenFeatureNodes(registry) {
  const nodes = Array.isArray(registry?.nodes) ? registry.nodes : [];
  const byParent = new Map();
  for (const node of nodes) {
    const parent = parentKey(node.key);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(node);
  }
  const flat = [];
  const walk = (parent, depth) => {
    for (const node of byParent.get(parent) || []) {
      flat.push({ ...node, depth, childCount: (byParent.get(node.key) || []).length });
      walk(node.key, depth + 1);
    }
  };
  walk('', 0);
  return { count: nodes.length, flat };
}

function patternMatches(pattern, key) {
  const text = String(pattern || '');
  if (text.endsWith('.**')) {
    const root = text.slice(0, -3);
    return key === root || key.startsWith(`${root}.`);
  }
  if (text.endsWith('.*')) return parentKey(key) === text.slice(0, -2);
  return text === key;
}

/** Service ids whose bundle carries this key, excluding the base site bundle. */
export function viaServices(registry, key) {
  const out = [];
  for (const [id, bundle] of Object.entries(registry?.bundles || {})) {
    if (id === 'site') continue;
    const patterns = Array.isArray(bundle?.keys) ? bundle.keys : [];
    if (patterns.some((pattern) => patternMatches(pattern, key))) out.push(id);
  }
  return out;
}

function labelNb(entry, fallback) {
  return entry?.label?.nb || entry?.label?.en || fallback;
}

export function serviceRows(registry, spec, activeServices = []) {
  const active = new Set(activeServices || []);
  const catalog = [...(registry?.services || []), ...(registry?.oneTimeAddOns || [])];
  return catalog.map((service) => ({
    id: service.id,
    label: labelNb(service, service.id),
    kind: (registry?.oneTimeAddOns || []).some((row) => row.id === service.id) ? 'addon' : 'service',
    active: active.has(service.id),
    tri: serviceTriOf(spec, service.id),
  }));
}

function entitledSet(tree) {
  const raw = tree?.entitled ?? tree?.effective ?? [];
  if (raw instanceof Set) return raw;
  if (typeof raw === 'string') return new Set(raw.split(',').map((part) => part.trim()).filter(Boolean));
  return new Set(Array.isArray(raw) ? raw : []);
}

/** View model: plan, services, every registry node, enforcement and what the CMS reported. */
export function featureEditorModel(registry, view = {}) {
  const spec = isPlain(view.featureSpec) ? view.featureSpec : {};
  const { flat, count } = flattenFeatureNodes(registry);
  const entitled = entitledSet(view.tree);
  const nodes = flat.map((node) => ({
    key: node.key,
    depth: node.depth,
    childCount: node.childCount,
    label: labelNb(node, node.key),
    type: node.type === 'enum' ? 'enum' : 'bool',
    values: Array.isArray(node.values) ? node.values : [],
    registryDefault: node.default,
    entitled: entitled.has(node.key),
    via: viaServices(registry, node.key),
    tri: triStateOf(spec, node.key),
    defaultEnabled: defaultEnabledOf(spec, node),
    locked: list(spec.locks).includes(node.key),
    value: spec.values?.[node.key] ?? node.default ?? '',
  }));
  return {
    count,
    plan: view.tree?.plan || '',
    tier: view.tree?.tier ?? null,
    source: view.tree?.source || '',
    services: serviceRows(registry, spec, view.tree?.services || []),
    nodes,
    enforcement: view.featureEnforcement || 'log',
    cmsSpecRev: Number(view.cmsSpec?.rev) || 0,
    cmsReported: view.cmsReported || {},
  };
}

function hasKey(effective, key) {
  if (!effective) return false;
  if (effective instanceof Set) return effective.has(key);
  if (typeof effective === 'string') return effective.split(',').map((part) => part.trim()).includes(key);
  return Array.isArray(effective) && effective.includes(key);
}

/**
 * The seven legacy flags from an effective key set.
 * users is always on, socialSync is always off, matching legacyFromTree in lib/cms-features.js.
 */
export function legacyFlagsFromEffective(effective) {
  return {
    users: true,
    analytics: hasKey(effective, 'analytics'),
    ecommerce: hasKey(effective, 'shop'),
    blog: hasKey(effective, 'blog'),
    socialSync: false,
    emailMarketing: hasKey(effective, 'email.campaigns') || hasKey(effective, 'email.newsletter'),
    general: hasKey(effective, 'users.ranks') || hasKey(effective, 'forms'),
  };
}

function carriedEffective(site) {
  const tree = site?.featureTree;
  if (tree && (Array.isArray(tree.effective) || tree.effective instanceof Set || typeof tree.effective === 'string')) return tree.effective;
  if (tree && (Array.isArray(tree.entitled) || tree.entitled instanceof Set)) return tree.entitled;
  if (typeof site?.cms?.effective === 'string' && site.cms.effective.trim()) return site.cms.effective;
  return null;
}

/** Badge flags from a feature tree on the site, otherwise the legacy features object unchanged. */
export function badgeFlagsForSite(site) {
  const effective = carriedEffective(site);
  if (effective == null) return site?.features || {};
  return legacyFlagsFromEffective(effective);
}
