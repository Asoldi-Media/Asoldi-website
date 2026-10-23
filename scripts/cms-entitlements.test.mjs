// WS6.7: hub feature entitlements (lib/cms-entitlements.js), the site-config feature block behind
// its switch, the heartbeat report and the site shape. Runs the real data modules on a temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-cms-entitlements-'));
process.env.APP_DATA_DIR = DATA_DIR;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 'cms-feature-matrix.json'), 'utf8'));
const vocab = await import('../packages/suite/core/delivery/vocab.js');
const ent = await import('../lib/cms-entitlements.js');
const hub = await import('../data/hub.js');
const model = await import('../data/hub-model.js');
const settingsStore = await import('../data/cms-feature-settings.js');
const { registerCmsFeatureRoutes } = await import('../lib/routes/cms-feature-routes.js');
const registry = ent.cmsFeatureRegistry();
const quiet = { warn() {}, error() {}, log() {} };

const ALL_FLAGS = ['users', 'analytics', 'ecommerce', 'blog', 'socialSync', 'emailMarketing', 'general'];

function letterFor(resolved, key) {
  if (resolved.effective.has(key)) return 'E';
  return resolved.entitled.has(key) ? 'o' : '-';
}

/** A golden profile as hub records: { site, salesClient } variants (sales-client plan, planSource). */
function hubVariants(name, profile) {
  const spec = profile.spec ? { featureSpec: { rev: 1, ...profile.spec } } : {};
  if (profile.legacy) {
    return [{
      label: `${name} (legacy site)`,
      site: model.normalizeSite({ id: name, site_key: `k-${name}`, name, ...profile.legacy, ...spec }),
      salesClient: null,
    }];
  }
  const plan = profile.sitePlan;
  const tierServices = vocab.servicesForTier(plan.tierId);
  const services = [...(plan.services || []), ...(plan.oneTimeAddOns || [])];
  const flags = vocab.legacyFlagsForServices([...tierServices, ...(plan.services || [])]);
  const base = { id: name, site_key: `k-${name}`, name, websitePlan: plan.tierId, features: flags, ...spec };
  return [
    { label: `${name} (sales client sitePlan)`, site: model.normalizeSite(base), salesClient: { sitePlan: plan } },
    {
      label: `${name} (site planSource)`,
      site: model.normalizeSite({
        ...base,
        planSource: { kind: 'offer', tierId: plan.tierId, services: [...new Set([...tierServices, ...services])], derivedFeatures: flags, catalogType: plan.catalogType },
      }),
      salesClient: null,
    },
  ];
}

test('every golden profile resolves through the hub mapping to its hand-reviewed effective set, values and shop cap', () => {
  assert.ok(golden.profileOrder.length >= 12);
  for (const [column, name] of golden.profileOrder.entries()) {
    for (const { label, site, salesClient } of hubVariants(name, golden.profiles[name])) {
      const result = ent.resolveSiteFeatures(site, salesClient, { registry, log: quiet });
      const wrong = [];
      for (const [key, row] of Object.entries(golden.matrix)) {
        if (letterFor(result.resolved, key) !== row[column]) wrong.push(`${key}: got ${letterFor(result.resolved, key)} expected ${row[column]}`);
      }
      assert.deepEqual(wrong, [], label);
      for (const [key, value] of Object.entries(golden.expectedValues[name] || {})) assert.equal(result.resolved.values[key], value, `${label} ${key}`);
      assert.equal(registry.shopModeCap(result.resolved), golden.expectedShopModeCap[name], `${label} shop cap`);
    }
  }
});

test('every combination of the 7 legacy flags on every plan keeps each flag that is on today, except socialSync', () => {
  let checked = 0;
  for (const websitePlan of ['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce', 'custom']) {
    for (let mask = 0; mask < 128; mask += 1) {
      const features = Object.fromEntries(ALL_FLAGS.map((flag, i) => [flag, Boolean(mask & (1 << i))]));
      const site = model.normalizeSite({ id: `s${mask}`, site_key: 'k', name: 'S', websitePlan, features, ecommerceCatalogType: 'tiers' });
      const result = ent.resolveSiteFeatures(site, null, { registry, log: quiet });
      assert.deepEqual(ent.legacyFlagsLost(site, result.legacy).filter((flag) => flag !== 'socialSync'), [], `${websitePlan} ${JSON.stringify(site.features)}`);
      assert.equal(result.legacy.socialSync, false);
      if (site.features.ecommerce) assert.equal(result.resolved.values['shop.catalog'], 'tiers');
      checked += 1;
    }
  }
  assert.equal(checked, 512);
});

test('sites shaped like the current fleet (tier 3 with every flag, tier 1 with the defaults) map to the reviewed profiles', () => {
  const column = (name) => golden.profileOrder.indexOf(name);
  const expectedEffective = (name) => Object.entries(golden.matrix).filter(([, row]) => row[column(name)] === 'E').map(([key]) => key).sort();
  const allOn = Object.fromEntries(ALL_FLAGS.map((flag) => [flag, true]));
  const shopMenu = model.normalizeSite({ id: 'a', site_key: 'ka', name: 'A', websitePlan: 'tier-3-ecommerce', features: allOn, ecommerceCatalogType: 'menu' });
  const shopNormal = model.normalizeSite({ id: 'b', site_key: 'kb', name: 'B', websitePlan: 'tier-3-ecommerce', features: allOn, ecommerceCatalogType: 'normal' });
  const plain = model.normalizeSite({ id: 'c', site_key: 'kc', name: 'C', websitePlan: 'tier-1-standard', features: model.featuresFromPlan('tier-1-standard') });
  for (const [site, profile] of [[shopMenu, 'legacyTier3NoSpec'], [shopNormal, 'legacyTier3NoSpec'], [plain, 'tier1']]) {
    const result = ent.resolveSiteFeatures(site, null, { registry, log: quiet });
    assert.deepEqual([...result.resolved.effective].sort(), expectedEffective(profile), `${site.websitePlan} -> ${profile}`);
    assert.equal(result.migrated, true);
  }
  assert.equal(ent.resolveSiteFeatures(shopMenu, null, { registry, log: quiet }).resolved.values['shop.catalog'], 'menu');
  // Tier 1 gains the client-written blog (owner decision Q19) and keeps everything it had.
  const tier1 = ent.resolveSiteFeatures(plain, null, { registry, log: quiet }).legacy;
  assert.deepEqual(tier1, { users: true, analytics: false, ecommerce: false, blog: true, socialSync: false, emailMarketing: false, general: true });
});

test('services come from planSource, then the sales client plan, then the tier; unknown ids are dropped and logged once', () => {
  const warnings = [];
  const log = { warn: (line) => warnings.push(line) };
  ent.resetUnknownServiceWarnings();
  const site = model.normalizeSite({ id: 'p1', site_key: 'kp', name: 'P', websitePlan: 'tier-1-standard' });
  assert.deepEqual(ent.servicesForSite(site, null, { registry, log }).source, 'websitePlan');
  const client = { sitePlan: { tierId: 'tier-2-seo', services: ['booking', 'nettbutikk'], oneTimeAddOns: ['pos'] } };
  const fromPlan = ent.servicesForSite(site, client, { registry, log });
  assert.deepEqual([fromPlan.source, fromPlan.tierId], ['sitePlan', 'tier-2-seo']);
  assert.deepEqual(fromPlan.services, ['booking', 'pos']);
  assert.deepEqual(fromPlan.unknown, ['nettbutikk']);
  ent.servicesForSite(site, client, { registry, log });
  assert.equal(warnings.length, 1, 'one warning per site and id');
  assert.match(warnings[0], /nettbutikk/);
  const withSource = { ...site, planSource: { kind: 'offer', tierId: 'tier-3-ecommerce', services: ['site', 'ecom'] } };
  const fromSource = ent.servicesForSite(withSource, client, { registry, log });
  assert.deepEqual([fromSource.source, fromSource.tierId, fromSource.services], ['planSource', 'tier-3-ecommerce', ['site', 'ecom']]);
  assert.deepEqual(ent.entitlementInput(withSource, client, { registry, log }), { services: ['site', 'ecom'], tierId: 'tier-3-ecommerce', source: 'planSource' });
});

test('a plan explains its own flags; flags switched on or off by hand become grants and revokes', () => {
  // A catalog-only plan sets the legacy ecommerce flag; that must not grant the full shop.
  const catalogFlags = vocab.legacyFlagsForServices(['site', 'changes', 'blog', 'catalog']);
  const catalogSite = model.normalizeSite({
    id: 'cat', site_key: 'kcat', name: 'Cat', websitePlan: 'tier-1-standard', features: catalogFlags,
    planSource: { kind: 'offer', tierId: 'tier-1-standard', services: ['site', 'changes', 'blog', 'catalog'], derivedFeatures: catalogFlags },
  });
  const catalog = ent.resolveSiteFeatures(catalogSite, null, { registry, log: quiet });
  assert.equal(catalog.spec.grantServices, undefined);
  assert.equal(catalog.resolved.effective.has('shop.checkout'), false);
  assert.equal(registry.shopModeCap(catalog.resolved), 'display');

  // Deviations from the derived flags: ecommerce switched on, blog switched off.
  const derived = vocab.legacyFlagsForServices(vocab.servicesForTier('tier-2-seo'));
  const deviated = model.normalizeSite({
    id: 'dev', site_key: 'kdev', name: 'Dev', websitePlan: 'tier-2-seo', features: { ...derived, ecommerce: true, blog: false },
    planSource: { kind: 'offer', tierId: 'tier-2-seo', services: vocab.servicesForTier('tier-2-seo'), derivedFeatures: derived },
  });
  const dev = ent.resolveSiteFeatures(deviated, null, { registry, log: quiet });
  assert.deepEqual(dev.spec.grantServices, ['ecom']);
  assert.deepEqual(dev.spec.revoke, ['blog']);
  assert.equal(dev.legacy.ecommerce, true);
  assert.equal(dev.legacy.blog, false);
  assert.ok(dev.notes.some((line) => line.includes('differs from the plan')));

  // A WS8 featureOverrides row with a reason.
  const overridden = model.normalizeSite({
    id: 'ovr', site_key: 'kovr', name: 'Ovr', websitePlan: 'tier-3-ecommerce', features: model.featuresFromPlan('tier-3-ecommerce'),
    featureOverrides: { ecommerce: { value: false, reason: 'shop paused by the client' } },
  });
  const ovr = ent.resolveSiteFeatures(overridden, null, { registry, log: quiet });
  assert.deepEqual(ovr.spec.revoke, ['shop']);
  assert.equal(ovr.legacy.ecommerce, false);
  assert.ok(ovr.notes.some((line) => line.includes('shop paused by the client')));
});

test('when the analytics flag is the only source of seo, automatic posts stay entitled but off, as in the CMS legacy rule', () => {
  const features = { users: true, analytics: true, blog: true };
  const site = model.normalizeSite({ id: 'an', site_key: 'kan', name: 'An', websitePlan: 'custom', features });
  const hubSide = ent.resolveSiteFeatures(site, null, { registry, log: quiet });
  assert.deepEqual(hubSide.spec.defaults, { 'blog.autoPosts': false });
  assert.equal(hubSide.resolved.entitled.has('blog.autoPosts'), true);
  assert.equal(hubSide.resolved.effective.has('blog.autoPosts'), false);
  const cmsSide = registry.resolveFeatures(registry.treeInputFromLegacy({ features: site.features, websitePlan: 'custom' }));
  assert.deepEqual([...hubSide.resolved.effective].sort(), [...cmsSide.effective].sort());
});

const ALL_ON = Object.fromEntries(ALL_FLAGS.map((flag) => [flag, true]));
const FLEET = [
  { id: 'f1', site_key: 'key-f1', domain: 'shop-one.test', name: 'Shop one', websitePlan: 'tier-3-ecommerce', features: ALL_ON, ecommerceCatalogType: 'menu', cms: { packageVersion: '1.7.0' } },
  { id: 'f2', site_key: 'key-f2', domain: 'plain-one.test', name: 'Plain one', websitePlan: 'tier-1-standard', features: { users: true } },
  { id: 'f3', site_key: 'key-f3', domain: 'plain-two.test', name: 'Plain two', websitePlan: 'tier-1-standard', features: { users: true }, deliveryPhase: 'development' },
  { id: 'f4', site_key: 'key-f4', domain: 'shop-two.test', name: 'Shop two', websitePlan: 'tier-3-ecommerce', features: ALL_ON, ecommerceCatalogType: 'normal', cms: { packageVersion: '2.1.3' },
    clientAdmin: { username: 'owner', passwordHash: '$2a$12$fakehashfortestsonlyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', pendingSync: true } },
];

function routesHook() {
  const app = { get() {}, put() {}, post() {} };
  return registerCmsFeatureRoutes(app, { adminAuth: () => {}, hub, sales: { getSalesClients: () => [] }, log: quiet });
}

test('site-config is unchanged while the switch is off or in shadow, and carries the tree for listed sites when on', () => {
  writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify(FLEET, null, 2));
  const hook = routesHook();
  const lookups = FLEET.flatMap((site) => [[site.site_key, false], [site.domain, true]]);
  const before = lookups.map(([key, byDomain]) => JSON.stringify(hub.getSiteConfig(key, byDomain)));

  // No settings file: off.
  assert.deepEqual(lookups.map(([key, byDomain]) => JSON.stringify(hub.getSiteConfig(key, byDomain, { withFeatures: hook.siteConfigFeatures }))), before);
  assert.equal(hook.shadowRecords().length, 0, 'off computes nothing');

  settingsStore.saveCmsFeatureSettings({ siteConfig: { mode: 'shadow' } }, { dataDir: DATA_DIR, by: 'test' });
  assert.deepEqual(lookups.map(([key, byDomain]) => JSON.stringify(hub.getSiteConfig(key, byDomain, { withFeatures: hook.siteConfigFeatures }))), before);
  const shadow = hook.shadowRecords();
  assert.equal(shadow.length, FLEET.length);
  assert.ok(shadow.every((row) => row.ok && row.mode === 'shadow' && row.lostFlags.length === 0), JSON.stringify(shadow));

  settingsStore.saveCmsFeatureSettings({ siteConfig: { mode: 'on', siteIds: ['f4'] } }, { dataDir: DATA_DIR, by: 'test' });
  const after = lookups.map(([key, byDomain]) => JSON.stringify(hub.getSiteConfig(key, byDomain, { withFeatures: hook.siteConfigFeatures })));
  lookups.forEach(([key], i) => {
    if (key === 'key-f4' || key === 'shop-two.test') assert.notEqual(after[i], before[i], key);
    else assert.equal(after[i], before[i], `${key} is not listed and stays as it was`);
  });
  const listed = hub.getSiteConfig('key-f4', false, { withFeatures: hook.siteConfigFeatures });
  assert.equal(listed.featureTree.registryVersion, registry.tree.registryVersion);
  assert.equal(listed.featureTree.source, 'websitePlan');
  assert.equal(listed.featureTree.plan, 'tier-3-ecommerce');
  assert.equal(listed.featureEnforcement, 'log');
  assert.equal(listed.features.socialSync, false);
  assert.equal(listed.features.ecommerce, true);
  assert.equal(listed.ecommerceCatalogType, 'normal');
  assert.equal(listed.analyticsLevel, 'advanced');
  assert.equal(listed.pendingAdmin.username, 'owner', 'the admin sync fields stay for the site key');
  assert.ok(listed.featureTree.entitled.includes('shop.checkout'));
});

test('pendingSettings goes only to site_key lookups, only while the CMS has not applied that rev, and never to a domain lookup', () => {
  writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify(FLEET.map((site) => (site.id === 'f4'
    ? { ...site, cmsSpec: { rev: 3, sections: { 'shop.seller': { legalName: 'Shop Two AS' } }, force: [] } }
    : site)), null, 2));
  settingsStore.saveCmsFeatureSettings({ siteConfig: { mode: 'on', allSites: true } }, { dataDir: DATA_DIR, by: 'test' });
  const hook = routesHook();
  const byKey = hub.getSiteConfig('key-f4', false, { withFeatures: hook.siteConfigFeatures });
  assert.deepEqual(byKey.pendingSettings, { rev: 3, sections: { 'shop.seller': { legalName: 'Shop Two AS' } }, force: [] });
  const byDomain = hub.getSiteConfig('shop-two.test', true, { withFeatures: hook.siteConfigFeatures });
  for (const field of ['pendingSettings', 'pendingAdmin', 'clientAdmin']) assert.equal(field in byDomain, false, field);
  assert.ok(byDomain.featureTree);
  assert.deepEqual(Object.keys(byDomain).filter((key) => !ent.PUBLIC_SITE_CONFIG_FIELDS.includes(key)), []);
  // The domain answer is an allowlist: a field the base config gains later stays out until listed.
  const site = hub.getSiteById('f4');
  const result = ent.resolveSiteFeatures(site, null, { registry, log: quiet });
  const widened = ent.siteConfigWithTree({ id: 'f4', features: {}, pendingAdmin: { passwordHash: 'x' }, extraField: 1 }, site, result, { byDomain: true });
  assert.deepEqual(Object.keys(widened).sort(), ['ecommerceCatalogType', 'analyticsLevel', 'featureEnforcement', 'featureTree', 'features', 'id'].sort());
  const keyed = ent.siteConfigWithTree({ id: 'f4', features: {}, pendingAdmin: null }, site, result, { byDomain: false });
  assert.equal('pendingAdmin' in keyed, true, 'a site_key lookup keeps the admin sync fields');
  hub.recordHeartbeat('key-f4', { packageVersion: '2.3.0', report: { settingsRevApplied: 3 } });
  assert.equal('pendingSettings' in hub.getSiteConfig('key-f4', false, { withFeatures: hook.siteConfigFeatures }), false);
  settingsStore.saveCmsFeatureSettings({ siteConfig: { mode: 'off', allSites: false, siteIds: [] } }, { dataDir: DATA_DIR, by: 'test' });
});

test('the heartbeat keeps the reported fields, bounded, and 14 days of block counts; an older CMS heartbeat changes nothing new', () => {
  writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify(FLEET, null, 2));
  hub.recordHeartbeat('key-f2', { packageVersion: '1.7.0', report: { site_key: 'key-f2', packageVersion: '1.7.0' } });
  const old = hub.getSiteById('f2').cms;
  assert.deepEqual(Object.keys(old).sort(), ['adminUrl', 'desiredPackageVersion', 'githubRepo', 'lastSeenAt', 'packageVersion']);

  const days = Array.from({ length: 20 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, count: i, top: [{ key: 'shop.discounts', count: i }] }));
  hub.recordHeartbeat('key-f2', {
    packageVersion: '2.3.0',
    report: {
      featuresRev: 7,
      clientFeaturesRev: 3,
      settingsRevApplied: 4,
      settingsConflicts: ['shop.shipping'],
      effective: ['users', 'site', 'blog'],
      effectiveHash: 'sha256:abc',
      featureBlocksDaily: days.slice(0, 10),
      migrations: { items: [{ id: '2.3.0-features', status: 'ok', at: '2026-11-01T00:00:00.000Z' }], failed: [], pending: [], status: 'ok', pruned: ['set-1'] },
      packageBuild: 'abc123',
      initialAdminPending: false,
      loginAddressMode: 'forwarded',
      loginForwardedFor: true,
      loginAddressFrom: 'sign-in',
      unrelated: 'ignored',
    },
  });
  let cms = hub.getSiteById('f2').cms;
  assert.equal(cms.featuresRev, 7);
  assert.equal(cms.settingsRevApplied, 4);
  assert.equal(cms.effective, 'users,site,blog');
  assert.equal(cms.blockHistory.length, 10);
  assert.deepEqual(cms.migrations.pruned, ['set-1']);
  assert.equal(cms.loginAddressMode, 'forwarded');
  assert.equal(cms.packageBuild, 'abc123');
  assert.ok(cms.lastHeartbeatAt);
  assert.equal('unrelated' in cms, false);

  hub.recordHeartbeat('key-f2', { report: { featureBlocksDaily: [...days.slice(10), { date: '2026-11-20', count: 99 }], effective: 'x'.repeat(20000) } });
  cms = hub.getSiteById('f2').cms;
  assert.equal(cms.blockHistory.length, 14);
  assert.equal(cms.blockHistory[0].date, '2026-11-07');
  assert.equal(cms.blockHistory.at(-1).count, 99, 'a day reported again replaces its row');
  assert.ok(cms.effective.length <= 8000);
  assert.equal(cms.featuresRev, 7, 'fields not reported again are kept');
  // A site update from a request cannot set what only the heartbeat reports.
  hub.updateSite('f2', { cms: { packageBuild: 'other', initialAdminPending: true, featuresRev: 99, githubRepo: 'org/repo' } });
  const updated = hub.getSiteById('f2').cms;
  assert.deepEqual([updated.packageBuild, updated.initialAdminPending, updated.featuresRev, updated.githubRepo], ['abc123', false, 7, 'org/repo']);
  // A site_key holder cannot set admin data through the heartbeat.
  hub.recordHeartbeat('key-f2', { report: { featureSpec: { grantServices: ['ecom'] }, cmsSpec: { rev: 9 }, featureEnforcement: 'off' } });
  const site = hub.getSiteById('f2');
  for (const field of ['featureSpec', 'cmsSpec', 'featureEnforcement']) assert.equal(field in site, false, field);
});

test('sites without the new fields keep their exact stored shape; invalid stored values are dropped, not carried', () => {
  writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify(FLEET, null, 2));
  const before = readFileSync(join(DATA_DIR, 'sites.json'), 'utf8');
  hub.updateSite('f1', {});
  const after = JSON.parse(readFileSync(join(DATA_DIR, 'sites.json'), 'utf8'));
  for (const site of after) {
    for (const field of ['featureSpec', 'cmsSpec', 'cmsSpecHistory', 'featureEnforcement']) assert.equal(field in site, false, `${site.id} ${field}`);
    for (const field of ['featuresRev', 'effective', 'blockHistory', 'lastHeartbeatAt']) assert.equal(field in site.cms, false, `${site.id} cms.${field}`);
  }
  assert.equal(JSON.parse(before).length, after.length);
  const odd = model.normalizeSite({ id: 'x', site_key: 'k', name: 'X', featureSpec: 'text', cmsSpec: [1], featureEnforcement: 'loud', cms: { featuresRev: 'seven', effective: { a: 1 } } });
  for (const field of ['featureSpec', 'cmsSpec', 'featureEnforcement']) assert.equal(field in odd, false, field);
  assert.equal('featuresRev' in odd.cms, false);
  assert.equal('effective' in odd.cms, false);
  const kept = model.normalizeSite({ id: 'y', site_key: 'k', name: 'Y', featureEnforcement: 'on', featureSpec: { rev: 2, grant: ['shop.subscriptions', 'shop.subscriptions'] } });
  assert.equal(kept.featureEnforcement, 'on');
  assert.deepEqual(kept.featureSpec, { rev: 2, grant: ['shop.subscriptions'] });
});

test('a new site from got-client takes its tier from the sales client plan when there is one', () => {
  assert.equal(ent.websitePlanForNewSite({ sitePlan: { tierId: 'tier-3-ecommerce' } }, 'tier-1-standard'), 'tier-3-ecommerce');
  assert.equal(ent.websitePlanForNewSite({}, 'tier-2-seo'), 'tier-2-seo');
  assert.equal(ent.websitePlanForNewSite(null, undefined), undefined);
});
