/**
 * Feature tree v1: one registry for CMS (WS6), email (WS7) and SEO (WS9) features.
 *
 * Entitlement is bundle-driven. Each WS8 service id (and one-time add-on) maps to a bundle of
 * keys in feature-tree.json; a key is entitled when a service of the site bundles it (closed
 * over its ancestors) or a spec grants it. Values then flow
 *   entitled (plan, hub) -> agency spec (defaults, locks, values) -> client toggles -> effective.
 *
 * Pure: no I/O apart from reading feature-tree.json next to this file once. The hub keeps a
 * synced copy (WS6.7) that reads data/cms-feature-tree.json; when that copy is missing or broken
 * the hub's import still succeeds and featureRegistryStatus() reports the error (see
 * loadFeatureRegistry). In the CMS a broken tree fails the import.
 * Full rules: docs/feature-entitlements.md.
 */
import { existsSync, readFileSync } from 'fs';

// The CMS keeps the tree next to this file; the hub's synced copy of this module (lib/cms-features.js)
// reads the synced tree from data/cms-feature-tree.json.
const TREE_CANDIDATES = [new URL('./feature-tree.json', import.meta.url), new URL('../data/cms-feature-tree.json', import.meta.url)];
const CHILDREN_MARK = '.*';
const SUBTREE_MARK = '.**';
const PROMPT_LIMIT = 9000;
const LEGACY_FLAGS = ['users', 'analytics', 'ecommerce', 'blog', 'socialSync', 'emailMarketing', 'general'];
/** Legacy hub flag -> WS8 service whose bundle replaces it (WS6.4). */
export const LEGACY_FLAG_SERVICES = Object.freeze({
    users: 'site',
    general: 'site',
    ecommerce: 'ecom',
    blog: 'blog',
    emailMarketing: 'email',
    analytics: 'seo',
    socialSync: 'social',
});
const SPEC_FIELDS = ['rev', 'grantServices', 'revokeServices', 'grant', 'revoke', 'defaults', 'values', 'locks', 'updatedAt', 'updatedBy'];

function semverParts(value) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value || ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1 for x.y.z strings (pre-release tags ignored); null when either is not a version. */
export function compareVersions(a, b) {
    const x = semverParts(a);
    const y = semverParts(b);
    if (!x || !y)
        return null;
    for (let i = 0; i < 3; i += 1) {
        if (x[i] !== y[i])
            return x[i] < y[i] ? -1 : 1;
    }
    return 0;
}

function parentOf(key) {
    const at = key.lastIndexOf('.');
    return at === -1 ? null : key.slice(0, at);
}

function ancestorsOf(key) {
    const out = [];
    for (let parent = parentOf(key); parent; parent = parentOf(parent))
        out.push(parent);
    return out;
}

function textOf(value, lang) {
    if (!value)
        return '';
    if (typeof value === 'string')
        return value;
    return value[lang] || value.nb || value.en || '';
}

function asList(value) {
    return Array.isArray(value) ? value.map((v) => String(v ?? '').trim()).filter(Boolean) : [];
}

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Check a registry. Returns a list of problems (empty when valid): parents, owners, bundle
 * ids, the key budget, patterns that match nothing, requires (existing, no cycles), enum
 * defaults, labels and hints (nb and en, hints at most 80 characters), tier services.
 */
export function validateRegistry(tree) {
    const problems = [];
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const keys = new Set();
    const seen = new Set();
    for (const node of nodes) {
        if (!node?.key || keys.has(node.key))
            problems.push(`duplicate or empty key ${node?.key}`);
        keys.add(node.key);
    }
    for (const node of nodes) {
        const parent = parentOf(node.key);
        if (parent && !keys.has(parent))
            problems.push(`${node.key}: parent ${parent} is not a node`);
        if (parent && !seen.has(parent))
            problems.push(`${node.key}: listed before its parent ${parent}`);
        seen.add(node.key);
        if (!node.owner)
            problems.push(`${node.key}: no owner`);
        if (!['bool', 'enum'].includes(node.type))
            problems.push(`${node.key}: type ${node.type}`);
        if (!['client', 'agency'].includes(node.scope))
            problems.push(`${node.key}: scope ${node.scope}`);
        if (node.type === 'bool' && typeof node.default !== 'boolean')
            problems.push(`${node.key}: bool default must be true or false`);
        if (node.type === 'enum' && (!Array.isArray(node.values) || !node.values.includes(node.default)))
            problems.push(`${node.key}: enum default not in values`);
        if (!semverParts(node.since))
            problems.push(`${node.key}: since must be x.y.z`);
        for (const lang of ['nb', 'en']) {
            if (!node.label?.[lang])
                problems.push(`${node.key}: label.${lang} missing`);
            if (!node.hint?.[lang])
                problems.push(`${node.key}: hint.${lang} missing`);
            else if (node.hint[lang].length > 80)
                problems.push(`${node.key}: hint.${lang} longer than 80 characters`);
        }
        for (const req of asList(node.requires)) {
            if (!keys.has(req))
                problems.push(`${node.key}: requires unknown ${req}`);
        }
    }
    if (nodes.length > Number(tree?.keyBudget || 90))
        problems.push(`${nodes.length} keys is over the budget of ${tree?.keyBudget || 90}`);
    // requires must not loop (also through ancestors).
    const state = new Map();
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    const visit = (key, path) => {
        if (state.get(key) === 'done')
            return;
        if (state.get(key) === 'open') {
            problems.push(`requires cycle: ${[...path, key].join(' -> ')}`);
            return;
        }
        state.set(key, 'open');
        const node = byKey.get(key);
        const next = [...asList(node?.requires), ...(parentOf(key) ? [parentOf(key)] : [])];
        for (const dep of next)
            if (byKey.has(dep))
                visit(dep, [...path, key]);
        state.set(key, 'done');
    };
    for (const key of keys)
        visit(key, []);
    const serviceIds = new Set([...(tree?.services || []), ...(tree?.oneTimeAddOns || [])].map((s) => s.id));
    for (const [id, bundle] of Object.entries(asObject(tree?.bundles))) {
        if (!serviceIds.has(id))
            problems.push(`bundle ${id} is not a WS8 service or one-time add-on id`);
        for (const pattern of asList(bundle?.keys)) {
            if (!expandPattern(pattern, nodes).length)
                problems.push(`bundle ${id}: pattern ${pattern} matches no key`);
        }
        for (const key of [...Object.keys(asObject(bundle?.defaults)), ...Object.keys(asObject(bundle?.values))]) {
            if (!keys.has(key))
                problems.push(`bundle ${id}: default/value for unknown key ${key}`);
        }
        for (const [key, value] of Object.entries(asObject(bundle?.values))) {
            if (!byKey.get(key)?.values?.includes(value))
                problems.push(`bundle ${id}: value ${value} is not allowed for ${key}`);
        }
    }
    for (const [tierId, list] of Object.entries(asObject(tree?.tierServices))) {
        for (const id of asList(list)) {
            if (!serviceIds.has(id))
                problems.push(`tier ${tierId}: unknown service ${id}`);
        }
    }
    for (const [from, to] of Object.entries(asObject(tree?.aliases))) {
        if (keys.has(from))
            problems.push(`alias ${from} is also a key`);
        if (!keys.has(to))
            problems.push(`alias ${from} points at unknown ${to}`);
    }
    return problems;
}

function expandPattern(pattern, nodes) {
    const keys = nodes.map((n) => n.key);
    if (pattern.endsWith(SUBTREE_MARK)) {
        const root = pattern.slice(0, -SUBTREE_MARK.length);
        return keys.filter((k) => k === root || k.startsWith(`${root}.`));
    }
    if (pattern.endsWith(CHILDREN_MARK)) {
        const root = pattern.slice(0, -CHILDREN_MARK.length);
        return keys.filter((k) => parentOf(k) === root);
    }
    return keys.includes(pattern) ? [pattern] : [];
}

/** Registry functions bound to one feature-tree.json object (the CMS copy, or the hub's synced copy). */
export function createFeatureRegistry(tree) {
    const problems = validateRegistry(tree);
    if (problems.length)
        throw new Error(`Invalid feature tree: ${problems.slice(0, 5).join('; ')}`);
    const nodes = tree.nodes.map((node) => Object.freeze({ ...node, requires: Object.freeze(asList(node.requires)) }));
    const byKey = new Map(nodes.map((node) => [node.key, node]));
    const childrenOf = new Map(nodes.map((node) => [node.key, []]));
    for (const node of nodes) {
        const parent = parentOf(node.key);
        if (parent)
            childrenOf.get(parent).push(node.key);
    }
    const serviceList = tree.services.map((s) => Object.freeze({ ...s, kind: 'service' }));
    const addOnList = (tree.oneTimeAddOns || []).map((s) => Object.freeze({ ...s, kind: 'oneTimeAddOn' }));
    const catalog = [...serviceList, ...addOnList];
    const catalogIds = catalog.map((s) => s.id);
    const tierOf = new Map((tree.tiers || []).map((t) => [t.id, t.tier]));
    const tierServices = Object.fromEntries(Object.entries(tree.tierServices).map(([id, list]) => [id, Object.freeze([...list])]));
    const aliases = Object.freeze({ ...asObject(tree.aliases) });
    /** Bundle closed over ancestors: { keys:Set, defaults, values }. */
    const bundles = new Map();
    for (const [id, bundle] of Object.entries(tree.bundles)) {
        const keys = new Set();
        for (const pattern of asList(bundle.keys)) {
            for (const key of expandPattern(pattern, nodes)) {
                keys.add(key);
                for (const parent of ancestorsOf(key))
                    keys.add(parent);
            }
        }
        bundles.set(id, Object.freeze({ keys, defaults: { ...asObject(bundle.defaults) }, values: { ...asObject(bundle.values) } }));
    }

    function normalizeFeatureKey(key) {
        const raw = String(key ?? '').trim();
        return aliases[raw] || raw;
    }

    /** {key: value} with alias keys mapped to their real key; a real key given as well wins. */
    function normalizeKeyMap(map) {
        const out = {};
        for (const [key, value] of Object.entries(asObject(map))) {
            const real = normalizeFeatureKey(key);
            if (real === key || !Object.prototype.hasOwnProperty.call(map, real))
                out[real] = value;
        }
        return out;
    }

    /**
     * One spec from two: `base` (for example the defaults treeInputFromLegacy returns) under
     * `over` (the agency spec). defaults and values merge per key, alias keys mapped first, and
     * `over` wins; the lists (grantServices, revokeServices, grant, revoke, locks) are joined, so
     * a revoke in either still beats a grant as in resolveFeatures; other fields come from `over`.
     * Callers that add an agency spec to a legacy input use this instead of replacing input.spec.
     * Returns undefined when neither is an object.
     */
    function mergeFeatureSpecs(base, over) {
        const a = base && typeof base === 'object' && !Array.isArray(base) ? base : null;
        const b = over && typeof over === 'object' && !Array.isArray(over) ? over : null;
        if (!a && !b)
            return undefined;
        if (!a || !b)
            return { ...(a || b) };
        const out = { ...a, ...b };
        for (const field of ['defaults', 'values']) {
            if (a[field] !== undefined || b[field] !== undefined)
                out[field] = { ...normalizeKeyMap(a[field]), ...normalizeKeyMap(b[field]) };
        }
        for (const field of ['grantServices', 'revokeServices', 'grant', 'revoke', 'locks']) {
            if (a[field] !== undefined || b[field] !== undefined)
                out[field] = [...new Set([...asList(a[field]), ...asList(b[field])])];
        }
        return out;
    }

    function isServiceId(id) {
        return catalogIds.includes(String(id ?? ''));
    }

    /** Known ids in catalog order, plus the unknown ones (never guessed). */
    function splitServices(list) {
        const wanted = new Set();
        const unknown = [];
        for (const raw of Array.isArray(list) ? list : []) {
            const id = String(raw ?? '').trim();
            if (!id)
                continue;
            if (isServiceId(id))
                wanted.add(id);
            else if (!unknown.includes(id))
                unknown.push(id);
        }
        return { services: catalogIds.filter((id) => wanted.has(id)), unknown };
    }

    function tierServicesFor(tierId) {
        return tierServices[String(tierId ?? '')] ? [...tierServices[String(tierId ?? '')]] : [];
    }

    function isTierId(tierId) {
        return Object.prototype.hasOwnProperty.call(tierServices, String(tierId ?? ''));
    }

    /**
     * The WS8 service ids of a site: 'site' + its tier's services + sitePlan services and
     * one-time add-ons + (when given) the services that replace true legacy flags.
     * Returns { services, tierId, source, unknown }.
     */
    function servicesFor({ sitePlan, websitePlan, legacyFeatures } = {}) {
        const plan = asObject(sitePlan);
        const tierId = isTierId(plan.tierId) ? plan.tierId : isTierId(websitePlan) ? websitePlan : null;
        const raw = ['site', ...tierServicesFor(tierId), ...asList(plan.services), ...asList(plan.oneTimeAddOns)];
        let source = isTierId(plan.tierId) || asList(plan.services).length ? 'sitePlan' : tierId ? 'websitePlan' : 'none';
        const legacy = asObject(legacyFeatures);
        for (const flag of LEGACY_FLAGS) {
            if (legacy[flag] === true && LEGACY_FLAG_SERVICES[flag]) {
                raw.push(LEGACY_FLAG_SERVICES[flag]);
                if (source === 'none')
                    source = 'legacy';
            }
        }
        const { services, unknown } = splitServices(raw);
        return { services, tierId, source, unknown };
    }

    /**
     * Input for resolveFeatures from a pre-tree hub config: legacy flags + websitePlan (+ catalog type).
     * The legacy analytics flag maps to the seo service (statistics and basic reports). When that
     * flag is the only source of seo (the tier does not include it), automatic posts default off:
     * they belong to the paid SEO package (owner decision Q19), and a statistics flag never asked
     * for AI-written posts. The spec it returns carries that default.
     */
    function treeInputFromLegacy({ features, websitePlan, ecommerceCatalogType } = {}) {
        const result = servicesFor({ websitePlan, legacyFeatures: features });
        const seoFromFlagOnly = asObject(features).analytics === true && !tierServicesFor(result.tierId).includes('seo');
        return {
            services: result.services,
            tierId: result.tierId,
            catalogType: ecommerceCatalogType || null,
            source: 'legacy',
            unknown: result.unknown,
            ...(seoFromFlagOnly ? { spec: { defaults: { 'blog.autoPosts': false } } } : {}),
        };
    }

    /** Lowest tier whose services entitle the key, and the services whose bundle carries it. */
    function includedFromFor(key) {
        let tier = null;
        for (const t of tree.tiers || []) {
            if (t.tier == null)
                continue;
            const list = ['site', ...tierServicesFor(t.id)];
            if (list.some((id) => bundles.get(id)?.keys.has(key)) && (tier === null || t.tier < tier))
                tier = t.tier;
        }
        const services = catalogIds.filter((id) => id !== 'site' && bundles.get(id)?.keys.has(key));
        return { tier, services };
    }
    const includedFrom = Object.freeze(Object.fromEntries(nodes.map((node) => [node.key, Object.freeze(includedFromFor(node.key))])));

    function serviceLabel(id, lang = 'nb') {
        return textOf(catalog.find((s) => s.id === id)?.label, lang) || id;
    }

    /** Lock text for a key that is not entitled: "Inkludert i Tier 3" or "Krever tillegget Nettbutikk". */
    function planLockText(key, lang = 'nb') {
        const from = includedFrom[key] || { tier: null, services: [] };
        const addOn = from.services.find((id) => !['changes', 'unlimited'].includes(id));
        if (from.tier) {
            return lang === 'en' ? `Included in Tier ${from.tier}` : `Inkludert i Tier ${from.tier}`;
        }
        if (addOn) {
            return lang === 'en' ? `Needs the ${serviceLabel(addOn, 'en')} add-on` : `Krever tillegget ${serviceLabel(addOn, 'nb')}`;
        }
        return lang === 'en' ? 'Not available' : 'Ikke tilgjengelig';
    }

    /**
     * Resolve the tree for one site.
     * @param {object} input
     * @param {string[]} [input.services]  WS8 service ids (servicesFor output); 'site' is always added
     * @param {string} [input.tierId]      tier id; its services are added
     * @param {object} [input.spec]        featureSpec {grantServices, revokeServices, grant, revoke, defaults, values, locks}
     * @param {object} [input.client]      client toggles: {enabled:{key:boolean}} or {key:boolean}
     * @param {string} [input.catalogType] sitePlan.catalogType, feeds shop.catalog
     * @param {string[]} [input.hubEntitled]       entitled keys as computed by the hub ...
     * @param {string} [input.hubRegistryVersion]  ... with this registry version (x.y.z); newer keys come from services. An unparseable version ignores hubEntitled.
     * @param {string} [input.lang]        'nb' (default) or 'en' for labels
     * @returns {{v:number, registryVersion:string, tierId:string|null, services:string[], unknownServices:string[], nodes:object[], entitled:Set<string>, effective:Set<string>, values:object, includedFrom:object, warnings:string[], has:(key:string)=>boolean}}
     */
    function resolveFeatures(input = {}) {
        const spec = asObject(input.spec);
        const lang = input.lang === 'en' ? 'en' : 'nb';
        const tierId = isTierId(input.tierId) ? input.tierId : null;
        const grantServices = splitServices(asList(spec.grantServices)).services;
        const revokeServices = new Set(splitServices(asList(spec.revokeServices)).services.filter((id) => id !== 'site'));
        const split = splitServices(['site', ...tierServicesFor(tierId), ...asList(input.services), ...grantServices]);
        const services = split.services.filter((id) => !revokeServices.has(id));
        const grant = new Set();
        for (const key of asList(spec.grant).map(normalizeFeatureKey)) {
            if (!byKey.has(key))
                continue;
            grant.add(key);
            for (const parent of ancestorsOf(key))
                grant.add(parent);
        }
        const revoke = new Set(asList(spec.revoke).map(normalizeFeatureKey));
        const locks = new Set(asList(spec.locks).map(normalizeFeatureKey));
        const specDefaults = normalizeKeyMap(spec.defaults);
        const specValues = normalizeKeyMap(spec.values);
        const clientRaw = asObject(input.client);
        const clientEnabled = normalizeKeyMap(clientRaw.enabled && typeof clientRaw.enabled === 'object' ? clientRaw.enabled : clientRaw);
        const serviceBundles = services.map((id) => bundles.get(id)).filter(Boolean);
        const bundled = (key) => serviceBundles.some((bundle) => bundle.keys.has(key));
        const warnings = [];
        let hubEntitled = null;
        if (Array.isArray(input.hubEntitled) && input.hubRegistryVersion) {
            if (semverParts(input.hubRegistryVersion))
                hubEntitled = new Set(input.hubEntitled.map(normalizeFeatureKey));
            else
                warnings.push(`hubRegistryVersion "${String(input.hubRegistryVersion).slice(0, 40)}" is not a version; the hub's entitled list was ignored and the CMS bundles decide`);
        }
        const hubKnows = (key) => Boolean(hubEntitled) && compareVersions(byKey.get(key).since, input.hubRegistryVersion) !== 1;
        // A hub that collapsed a parent's children into the parent (for example 'blog' without
        // 'blog.posts') would switch the children off everywhere. When the hub entitles a parent
        // but none of the children it knows, while the CMS bundles entitle some, the bundles decide.
        const hubCollapsed = new Set();
        if (hubEntitled) {
            for (const [parent, kids] of childrenOf) {
                const known = kids.filter(hubKnows);
                if (!known.length || !hubEntitled.has(parent) || known.some((kid) => hubEntitled.has(kid)) || !known.some(bundled))
                    continue;
                for (const kid of known)
                    hubCollapsed.add(kid);
                warnings.push(`the hub entitles ${parent} but none of ${known.join(', ')}; the CMS bundles decide those keys`);
            }
        }

        const planEnt = (key) => {
            if (hubKnows(key) && !hubCollapsed.has(key))
                return hubEntitled.has(key);
            return bundled(key);
        };
        const entitled = new Set();
        for (const node of nodes) {
            const parent = parentOf(node.key);
            const ok = (planEnt(node.key) || grant.has(node.key)) && !revoke.has(node.key) && (!parent || entitled.has(parent));
            if (ok)
                entitled.add(node.key);
        }
        const defaultFor = (node) => {
            if (node.type !== 'bool')
                return true;
            if (serviceBundles.some((bundle) => bundle.keys.has(node.key) && bundle.defaults[node.key] === true))
                return true;
            return node.default === true;
        };
        const enabledMap = new Map();
        for (const node of nodes) {
            let enabled;
            if (node.type !== 'bool') {
                enabled = true;
            }
            else {
                const clientMay = node.scope === 'client' && entitled.has(node.key) && !locks.has(node.key);
                if (clientMay && typeof clientEnabled[node.key] === 'boolean')
                    enabled = clientEnabled[node.key];
                else if (typeof specDefaults[node.key] === 'boolean')
                    enabled = specDefaults[node.key];
                else
                    enabled = defaultFor(node);
            }
            enabledMap.set(node.key, enabled);
        }
        const effectiveMemo = new Map();
        const isEffective = (key, stack = new Set()) => {
            if (effectiveMemo.has(key))
                return effectiveMemo.get(key);
            if (stack.has(key))
                return false;
            stack.add(key);
            const node = byKey.get(key);
            const parent = parentOf(key);
            const value = Boolean(node)
                && entitled.has(key)
                && enabledMap.get(key) === true
                && (!parent || isEffective(parent, stack))
                && node.requires.every((req) => isEffective(req, stack));
            stack.delete(key);
            effectiveMemo.set(key, value);
            return value;
        };
        const effective = new Set(nodes.filter((node) => isEffective(node.key)).map((node) => node.key));
        const values = {};
        for (const node of nodes) {
            if (node.type !== 'enum' || !entitled.has(node.key))
                continue;
            let value = node.values.includes(specValues[node.key]) ? specValues[node.key] : null;
            if (!value) {
                let rank = -1;
                for (const bundle of serviceBundles) {
                    const candidate = bundle.values[node.key];
                    const at = node.values.indexOf(candidate);
                    if (bundle.keys.has(node.key) && at > rank) {
                        rank = at;
                        value = candidate;
                    }
                }
            }
            if (!value && node.key === 'shop.catalog' && node.values.includes(input.catalogType))
                value = input.catalogType;
            values[node.key] = value || node.default;
        }
        const resolvedNodes = nodes.map((node) => {
            const isEntitled = entitled.has(node.key);
            const lock = !isEntitled ? 'plan' : locks.has(node.key) || node.scope === 'agency' ? 'agency' : null;
            return {
                key: node.key,
                parent: parentOf(node.key),
                type: node.type,
                ...(node.values ? { values: [...node.values] } : {}),
                label: textOf(node.label, lang),
                hint: textOf(node.hint, lang),
                scope: node.scope,
                owner: node.owner,
                since: node.since,
                entitled: isEntitled,
                enabled: enabledMap.get(node.key),
                effective: effective.has(node.key),
                ...(node.type === 'enum' && isEntitled ? { value: values[node.key] } : {}),
                lock,
                lockText: lock === 'plan' ? planLockText(node.key, lang) : lock === 'agency' ? (lang === 'en' ? 'Managed by Asoldi' : 'Styres av Asoldi') : '',
                canToggle: node.type === 'bool' && lock === null,
                requires: [...node.requires],
                includedFrom: includedFrom[node.key],
            };
        });
        return {
            v: tree.v,
            registryVersion: tree.registryVersion,
            tierId,
            tier: tierId ? tierOf.get(tierId) ?? null : null,
            services,
            unknownServices: split.unknown,
            nodes: resolvedNodes,
            entitled,
            effective,
            values,
            includedFrom,
            warnings,
            has: (key) => effective.has(normalizeFeatureKey(key)),
        };
    }

    /** The 7 legacy hub flags, derived from a resolved tree (for CMS versions before the tree). */
    function legacyFromTree(resolved) {
        const eff = (key) => resolved.effective.has(key);
        return {
            users: true,
            analytics: eff('analytics'),
            ecommerce: eff('shop'),
            blog: eff('blog'),
            socialSync: false,
            emailMarketing: eff('email.campaigns') || eff('email.newsletter'),
            general: eff('users.ranks') || eff('forms'),
        };
    }

    /** Highest shop mode the tree allows: 'sell' with checkout, 'display' without, else null. */
    function shopModeCap(resolved) {
        if (resolved.effective.has('shop.checkout'))
            return 'sell';
        if (resolved.effective.has('shop'))
            return 'display';
        return null;
    }

    /**
     * Compact text for an AI prompt: one line per effective key and per entitled key that is
     * off; a subtree whose root is not effective collapses to one line. At most 9,000 chars.
     */
    function featurePromptBlock(resolved, { rev = null, plan = null } = {}) {
        const byResolved = new Map(resolved.nodes.map((n) => [n.key, n]));
        const lines = [
            `CMS features v${resolved.v} rev ${rev ?? '-'} plan ${plan || resolved.tierId || 'custom'} services ${resolved.services.join(',')}`,
            'key [type] ent/en -> EFF | scope | hint',
        ];
        const walk = (key) => {
            const n = byResolved.get(key);
            const kids = childrenOf.get(key) || [];
            const req = n.requires.length ? ` | requires ${n.requires.join(',')}` : '';
            if (!n.entitled) {
                lines.push(`${key} [${n.type}] not entitled (${planLockText(key, 'nb')})${kids.length ? ' | (children hidden)' : ''}`);
                return;
            }
            if (n.type === 'enum') {
                lines.push(`${key} [enum ${n.values.join('|')}] = ${n.value} | ${n.scope}`);
                return;
            }
            if (!n.effective) {
                const why = n.enabled ? 'E/on -> off' : 'E/off -> off';
                lines.push(`${key} [bool] ${why} | ${n.scope}${req}${kids.length ? ' | (children hidden)' : ''}`);
                return;
            }
            lines.push(`${key} [bool] E/on -> ON | ${n.scope} | ${n.hint}${req}`);
            for (const child of kids)
                walk(child);
        };
        for (const node of nodes) {
            if (!parentOf(node.key))
                walk(node.key);
        }
        lines.push('Change via PUT /api/hub/sites/:id/cms-spec {"featureSpec":{"grantServices":[],"revokeServices":[],"grant":[],"revoke":[],"defaults":{},"values":{},"locks":[]},"sections":{}}');
        let text = lines.join('\n');
        if (text.length > PROMPT_LIMIT)
            text = `${text.slice(0, PROMPT_LIMIT - 20)}\n... (truncated)`;
        return text;
    }

    /**
     * Validate a featureSpec. Only canonical keys, service ids and enum values pass (writers
     * normalize aliases first). Returns { ok, errors: [{ path, message }] }; paths start with
     * `prefix` (default 'featureSpec').
     */
    function validateFeatureSpec(spec, { prefix = 'featureSpec' } = {}) {
        const errors = [];
        const at = (rest) => (prefix ? `${prefix}${rest.startsWith('[') ? '' : '.'}${rest}` : rest.replace(/^\./, ''));
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
            return { ok: false, errors: [{ path: prefix || '', message: 'featureSpec must be an object' }] };
        }
        for (const field of Object.keys(spec)) {
            if (!SPEC_FIELDS.includes(field))
                errors.push({ path: at(field), message: `Unknown field. Allowed: ${SPEC_FIELDS.join(', ')}` });
        }
        const keyHint = (key) => (aliases[key] ? ` Use ${aliases[key]}.` : '');
        for (const field of ['grantServices', 'revokeServices']) {
            if (spec[field] === undefined)
                continue;
            if (!Array.isArray(spec[field])) {
                errors.push({ path: at(field), message: 'Must be a list of service ids' });
                continue;
            }
            spec[field].forEach((id, i) => {
                if (!isServiceId(id))
                    errors.push({ path: at(`${field}[${i}]`), message: `Unknown service "${id}". Use one of: ${catalogIds.join(', ')}` });
                else if (field === 'revokeServices' && id === 'site')
                    errors.push({ path: at(`${field}[${i}]`), message: 'The site service cannot be revoked' });
            });
        }
        for (const field of ['grant', 'revoke', 'locks']) {
            if (spec[field] === undefined)
                continue;
            if (!Array.isArray(spec[field])) {
                errors.push({ path: at(field), message: 'Must be a list of feature keys' });
                continue;
            }
            spec[field].forEach((key, i) => {
                if (!byKey.has(key))
                    errors.push({ path: at(`${field}[${i}]`), message: `Unknown feature key "${key}".${keyHint(key)}` });
            });
        }
        if (Array.isArray(spec.grant) && Array.isArray(spec.revoke)) {
            for (const key of spec.grant) {
                if (spec.revoke.includes(key))
                    errors.push({ path: at('grant'), message: `${key} is both granted and revoked` });
            }
        }
        if (spec.defaults !== undefined) {
            if (!spec.defaults || typeof spec.defaults !== 'object' || Array.isArray(spec.defaults)) {
                errors.push({ path: at('defaults'), message: 'Must be an object of key: true|false' });
            }
            else {
                for (const [key, value] of Object.entries(spec.defaults)) {
                    const node = byKey.get(key);
                    if (!node)
                        errors.push({ path: at(`defaults.${key}`), message: `Unknown feature key "${key}".${keyHint(key)}` });
                    else if (node.type !== 'bool')
                        errors.push({ path: at(`defaults.${key}`), message: `${key} is an enum; set it in values` });
                    else if (typeof value !== 'boolean')
                        errors.push({ path: at(`defaults.${key}`), message: 'Must be true or false' });
                }
            }
        }
        if (spec.values !== undefined) {
            if (!spec.values || typeof spec.values !== 'object' || Array.isArray(spec.values)) {
                errors.push({ path: at('values'), message: 'Must be an object of key: value' });
            }
            else {
                for (const [key, value] of Object.entries(spec.values)) {
                    const node = byKey.get(key);
                    if (!node)
                        errors.push({ path: at(`values.${key}`), message: `Unknown feature key "${key}".${keyHint(key)}` });
                    else if (node.type !== 'enum')
                        errors.push({ path: at(`values.${key}`), message: `${key} is not an enum; set it in defaults` });
                    else if (!node.values.includes(value))
                        errors.push({ path: at(`values.${key}`), message: `"${value}" is not allowed. Use one of: ${node.values.join(', ')}` });
                }
            }
        }
        if (spec.rev !== undefined && !(Number.isInteger(spec.rev) && spec.rev >= 0))
            errors.push({ path: at('rev'), message: 'Must be a whole number' });
        return { ok: errors.length === 0, errors };
    }

    return Object.freeze({
        tree,
        FEATURE_NODES: Object.freeze(nodes),
        BUNDLES: bundles,
        SERVICE_CATALOG: Object.freeze(catalog),
        TIER_SERVICES: Object.freeze(tierServices),
        FEATURE_ALIASES: aliases,
        normalizeFeatureKey,
        mergeFeatureSpecs,
        isServiceId,
        servicesFor,
        treeInputFromLegacy,
        resolveFeatures,
        legacyFromTree,
        shopModeCap,
        featurePromptBlock,
        validateFeatureSpec,
        planLockText,
        childrenOf: (key) => [...(childrenOf.get(key) || [])],
    });
}

let defaultRegistry = null;
/** The registry built from server/feature-tree.json (loaded once). Throws when the tree is missing or invalid. */
export function featureRegistry() {
    if (!defaultRegistry) {
        const file = TREE_CANDIDATES.find((url) => existsSync(url));
        if (!file)
            throw new Error('feature-tree.json not found next to features.js or in ../data/cms-feature-tree.json');
        defaultRegistry = createFeatureRegistry(JSON.parse(readFileSync(file, 'utf8')));
    }
    return defaultRegistry;
}

/**
 * { registry, error } without throwing. The CMS ships its tree next to this file, so a broken
 * tree there is a build error and importing this module throws (tests catch it). The hub's synced
 * copy (lib/cms-features.js + data/cms-feature-tree.json) must not take the hub down: there the
 * import succeeds, the error is logged, the constants below are empty, and each function call
 * throws the load error. The hub checks featureRegistryStatus() at boot.
 */
export function loadFeatureRegistry() {
    try {
        return { registry: featureRegistry(), error: null };
    }
    catch (error) {
        return { registry: null, error };
    }
}

const loaded = loadFeatureRegistry();
if (loaded.error) {
    if (existsSync(TREE_CANDIDATES[0]))
        throw loaded.error;
    console.error(`[features] The feature registry did not load: ${loaded.error.message}. Feature calls fail until the synced copy is fixed.`);
}
const registry = loaded.registry;

/** { ok, error }: whether the registry loaded at import (the hub copy logs and reports instead of throwing). */
export function featureRegistryStatus() {
    return { ok: Boolean(registry), error: loaded.error ? String(loaded.error.message || loaded.error) : null };
}

function bound(name) {
    return registry ? registry[name] : (...args) => featureRegistry()[name](...args);
}

export const FEATURE_TREE = registry ? registry.tree : null;
export const FEATURE_NODES = registry ? registry.FEATURE_NODES : Object.freeze([]);
export const BUNDLES = registry ? registry.BUNDLES : new Map();
export const SERVICE_CATALOG = registry ? registry.SERVICE_CATALOG : Object.freeze([]);
export const TIER_SERVICES = registry ? registry.TIER_SERVICES : Object.freeze({});
export const FEATURE_ALIASES = registry ? registry.FEATURE_ALIASES : Object.freeze({});
export const normalizeFeatureKey = bound('normalizeFeatureKey');
export const mergeFeatureSpecs = bound('mergeFeatureSpecs');
export const servicesFor = bound('servicesFor');
export const treeInputFromLegacy = bound('treeInputFromLegacy');
export const resolveFeatures = bound('resolveFeatures');
export const legacyFromTree = bound('legacyFromTree');
export const shopModeCap = bound('shopModeCap');
export const featurePromptBlock = bound('featurePromptBlock');
export const validateFeatureSpec = bound('validateFeatureSpec');
