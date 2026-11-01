// applySitePlanToHub (lib/site-plan-apply.js): one hub site per client, planSource, the legacy flags
// rule, the client link, the superadmin plan edit, and the go-live callback's status record
// (lib/golive-callback.js). The real data modules on a temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-site-plan-apply-'));
process.env.APP_DATA_DIR = DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const AT = '2026-11-01T10:00:00.000Z';
const vocab = await import('../packages/suite/core/delivery/vocab.js');
const plan = (tierId, extra = {}) => ({
  version: 1, status: 'active', tierId, services: vocab.servicesForTier(tierId), pages: 5, billing: 'month',
  source: 'portal-accept', offerId: `offer-${tierId}`, alternativeIndex: 0, signedAt: AT, ...extra,
});
const clients = [
  { id: 'c3', product: 'asoldi', businessName: 'Shop Example AS', status: 'active', progression: { contractSigned: true }, sitePlan: plan('tier-3-ecommerce') },
  { id: 'c1', product: 'asoldi', businessName: 'Plain Example AS', status: 'active', websiteDomain: 'plain.example.com', progression: { contractSigned: true }, sitePlan: plan('tier-1-standard') },
  { id: 'cspec', product: 'asoldi', businessName: 'Spec Example AS', status: 'active', hubSite: { id: 'site-spec', siteKey: 'key-spec' }, progression: { contractSigned: true }, sitePlan: plan('tier-2-seo') },
  { id: 'cnone', product: 'asoldi', businessName: 'No Plan AS', status: 'active', progression: { contractSigned: true } },
  { id: 'cvoid', product: 'asoldi', businessName: 'Void Example AS', status: 'active', progression: { contractSigned: true }, sitePlan: plan('tier-2-seo', { status: 'void' }) },
  { id: 'cgo', product: 'asoldi', businessName: 'Golive Example AS', status: 'active', makerRun: { runId: 'run-go' }, progression: { contractSigned: true }, sitePlan: plan('tier-2-seo') },
  // A second lead with another client's domain, and one whose link names another client's site id.
  { id: 'cdup', product: 'asoldi', businessName: 'Duplicate Lead AS', status: 'active', websiteDomain: 'plain.example.com', progression: { contractSigned: true }, sitePlan: plan('tier-3-ecommerce') },
  { id: 'cid', product: 'asoldi', businessName: 'Copied Link AS', status: 'active', hubSite: { id: 'site-spec' }, progression: { contractSigned: true }, sitePlan: plan('tier-3-ecommerce') },
];
const sites = [
  { id: 'site-plain', site_key: 'key-plain', name: 'Plain Example AS', domain: 'plain.example.com', websitePlan: 'tier-1-standard', features: { users: true, analytics: true }, planSource: 'admin' },
  { id: 'site-spec', site_key: 'key-spec', name: 'Spec Example AS', domain: 'spec.example.com', websitePlan: 'tier-1-standard', features: { users: true }, featureSpec: { rev: 2, grantServices: ['seo'] } },
];
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify(clients, null, 2));
writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify(sites, null, 2));

const sales = await import('../data/sales.js');
const hub = await import('../data/hub.js');
const apply = await import('../lib/site-plan-apply.js');
const golive = await import('../lib/golive-callback.js');
const settingsStore = await import('../data/automation-settings.js');

const allSites = () => JSON.parse(readFileSync(join(DATA_DIR, 'sites.json'), 'utf8'));

test('signing a tier-3 client creates exactly one site with all 7 flags, planSource kind offer and the client link', () => {
  const result = apply.applySitePlanToHub('c3', { by: 'test', now: AT });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  const mine = allSites().filter((site) => site.planSource?.salesClientId === 'c3');
  assert.equal(mine.length, 1);
  const site = mine[0];
  for (const flag of ['users', 'analytics', 'ecommerce', 'blog', 'socialSync', 'emailMarketing', 'general']) assert.equal(site.features[flag], true, flag);
  assert.equal(site.websitePlan, 'tier-3-ecommerce');
  assert.equal(site.ecommerceCatalogType, 'normal');
  assert.equal(site.deliveryPhase, 'development');
  assert.equal(site.planSource.kind, 'offer');
  assert.equal(site.planSource.offerId, 'offer-tier-3-ecommerce');
  assert.deepEqual(site.planSource.services, vocab.expandServices(vocab.servicesForTier('tier-3-ecommerce')));
  assert.match(site.site_key, /^[0-9a-f]{32}$/, 'a generated site key');
  const client = sales.getSalesClientById('c3');
  assert.equal(client.hubSite.id, site.id);
  assert.equal(client.hubSite.siteKey, site.site_key);
  assert.equal(client.portalTierId, 'tier-3-ecommerce');
  assert.equal(client.sitePlan.appliedSiteId, site.id);
  assert.equal(client.sitePlan.appliedAt, AT);
});

test('re-applying an unchanged plan writes nothing and keeps the single site', async () => {
  const before = statSync(join(DATA_DIR, 'sites.json')).mtimeMs;
  const salesBefore = readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = apply.applySitePlanToHub('c3', { by: 'test', now: '2026-11-02T10:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.changed, false);
  assert.equal(statSync(join(DATA_DIR, 'sites.json')).mtimeMs, before, 'sites.json untouched');
  assert.equal(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8'), salesBefore, 'the client untouched');
  assert.equal(allSites().filter((site) => site.planSource?.salesClientId === 'c3').length, 1);
});

test('an existing site is found by domain; a flag changed by hand survives; a legacy string planSource reads as {kind}', () => {
  assert.deepEqual(apply.normalizePlanSource('admin'), { kind: 'admin' });
  assert.equal(apply.normalizePlanSource('nonsense'), null);
  assert.equal(apply.planSourceKind({ planSource: 'backfill' }), 'backfill');
  const result = apply.applySitePlanToHub('c1', { by: 'test', now: AT });
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  const site = hub.getSiteById('site-plain');
  // The old tier-1 table had analytics off; the site has it on, so it was set by hand and stays.
  assert.equal(site.features.analytics, true, 'a deviation from the previous plan flags is kept');
  assert.equal(site.features.blog, true, 'the plan flags apply where nothing was changed by hand (blog on every tier)');
  assert.equal(site.planSource.kind, 'offer');
  assert.equal(sales.getSalesClientById('c1').hubSite.id, 'site-plain');
  assert.equal(allSites().length, 3);
});

test('a plan change rewrites the flags but keeps the ones changed by hand', () => {
  hub.updateSite('site-plain', { features: { socialSync: true } });
  const current = sales.getSalesClientById('c1').sitePlan;
  sales.setSalesSitePlan('c1', { ...current, tierId: 'tier-2-seo', services: vocab.servicesForTier('tier-2-seo') }, { by: 'test', reason: 'test' });
  apply.applySitePlanToHub('c1', { by: 'test', now: AT });
  const site = hub.getSiteById('site-plain');
  assert.equal(site.websitePlan, 'tier-2-seo');
  assert.equal(site.features.emailMarketing, true, 'tier 2 flag added');
  assert.equal(site.features.socialSync, true, 'hand-set flag kept (and tier 2 has it)');
  assert.equal(site.planSource.tierId, 'tier-2-seo');
  assert.deepEqual(site.planSource.derivedFeatures, vocab.featuresFromServices(vocab.servicesForTier('tier-2-seo')));
});

test('a site with a feature spec gets no feature write; a void plan and no plan apply nothing', () => {
  const before = hub.getSiteById('site-spec').features;
  const result = apply.applySitePlanToHub('cspec', { by: 'test', now: AT });
  assert.equal(result.ok, true);
  assert.equal(result.featuresWritten, false);
  assert.deepEqual(hub.getSiteById('site-spec').features, before);
  assert.equal(hub.getSiteById('site-spec').planSource.tierId, 'tier-2-seo');
  assert.equal(apply.applySitePlanToHub('cnone').reason, 'no-plan');
  assert.equal(apply.applySitePlanToHub('cvoid').reason, 'no-plan');
  assert.equal(apply.applySitePlanToHub('missing').reason, 'not-found');
});

test('site-config of an applied site returns the plan flags', () => {
  const site = allSites().find((entry) => entry.planSource?.salesClientId === 'c3');
  const config = hub.getSiteConfig(site.site_key);
  assert.equal(config.features.ecommerce, true);
  assert.equal(config.websitePlan, 'tier-3-ecommerce');
});

test('superadmin plan edit: planSource becomes kind admin with the new tier, only when the plan changed', () => {
  const before = hub.getSiteById('site-plain');
  const after = { ...before, websitePlan: 'tier-3-ecommerce' };
  const source = apply.adminPlanSourceForEdit(before, after, { by: 'superadmin', salesClientId: 'c1', now: AT });
  assert.equal(source.kind, 'admin');
  assert.equal(source.tierId, 'tier-3-ecommerce');
  assert.deepEqual(source.services, vocab.servicesForTier('tier-3-ecommerce'));
  assert.equal(apply.adminPlanSourceForEdit(before, { ...before }), null);
});

// ---------------------------------------------------------------- go-live callback record

test('go-live callback v2: payloads without schema 2 are not read; status only, plan fields never', () => {
  assert.equal(golive.normalizeGoLiveCallback({ event: 'run.golive.updated', status: 'ready', domain: 'x.example.com' }), null);
  const record = golive.normalizeGoLiveCallback({ schema: 2, status: 'ready', domain: 'https://X.example.com/', websitePlan: 'tier-3-ecommerce', features: { ecommerce: true } });
  assert.equal(record.status, 'pushed', 'the old ready status means pushed');
  assert.equal(record.target, 'production');
  assert.equal(record.domain, 'x.example.com');
  assert.equal(record.liveVerifiedAt, '');
  assert.equal(Object.hasOwn(record, 'websitePlan'), false);
  assert.equal(Object.hasOwn(record, 'features'), false);
  const live = golive.normalizeGoLiveCallback({ schema: 2, target: 'production', status: 'live', liveVerifiedAt: AT });
  assert.equal(live.liveVerifiedAt, AT);
  assert.equal(golive.normalizeGoLiveCallback({ schema: 2, target: 'production', status: 'pushed', liveVerifiedAt: AT }).liveVerifiedAt, '', 'only a live status carries the verification');
});

test('go-live record: a staging record never hides production; a later production push keeps liveVerifiedAt', () => {
  const live = { ...golive.normalizeGoLiveCallback({ schema: 2, target: 'production', status: 'live', liveVerifiedAt: AT }) };
  const staging = golive.normalizeGoLiveCallback({ schema: 2, target: 'staging', status: 'live', liveVerifiedAt: AT, stagingDomain: 's.example.com' });
  const pushed = golive.normalizeGoLiveCallback({ schema: 2, target: 'production', status: 'ready' });
  const first = golive.nextGoLiveRecord(null, live, AT);
  const second = golive.nextGoLiveRecord(first, staging, AT);
  assert.equal(second.target, 'production');
  assert.equal(second.liveVerifiedAt, AT);
  assert.equal(second.staging.stagingDomain, 's.example.com');
  const third = golive.nextGoLiveRecord(second, pushed, AT);
  assert.equal(third.status, 'pushed');
  assert.equal(third.liveVerifiedAt, AT, 'a re-publish of a live site stays live');
  assert.equal(third.staging.target, 'staging');
  const stagingFirst = golive.nextGoLiveRecord(null, staging, AT);
  assert.equal(stagingFirst.target, 'staging');
  const thenProduction = golive.nextGoLiveRecord(stagingFirst, pushed, AT);
  assert.equal(thenProduction.target, 'production');
  assert.equal(thenProduction.staging.target, 'staging');
});

test('go-live handler: off without the switch; with it a needs_import task opens and closes, and production live is recorded', () => {
  const client = sales.getSalesClientById('cgo');
  assert.equal(golive.goLiveCallbackV2({ schema: 2, status: 'ready' }, client), null, 'switch off: the old handler runs');
  settingsStore.invalidateAutomationSettingsCache();
  writeFileSync(join(DATA_DIR, 'automation-settings.json'), JSON.stringify({ signing: { enabled: true, mode: 'shadow', paused: null } }));
  settingsStore.invalidateAutomationSettingsCache();
  try {
    const needs = golive.goLiveCallbackV2({ schema: 2, target: 'production', status: 'needs_import', needsImport: { hint: 'import the repo in the host panel' }, runId: 'run-go' }, client);
    assert.equal(needs.mode, 'shadow');
    let updated = needs.record(client);
    assert.equal(updated.makerRun.goLive.status, 'needs_import');
    assert.equal(updated.delivery.tasks.length, 1);
    assert.equal(updated.delivery.tasks[0].kind, 'needs_import');
    assert.equal(updated.delivery.tasks[0].status, 'open');
    const live = golive.goLiveCallbackV2({ schema: 2, target: 'production', status: 'live', liveVerifiedAt: AT, runId: 'run-go' }, updated);
    updated = live.record(updated);
    assert.equal(updated.makerRun.goLive.liveVerifiedAt, AT);
    assert.equal(updated.delivery.tasks[0].status, 'done', 'a live status closes the import task');
    assert.notEqual(updated.progression.live, true, 'shadow never sets progression.live');
  } finally {
    rmSync(join(DATA_DIR, 'automation-settings.json'), { force: true });
    settingsStore.invalidateAutomationSettingsCache();
  }
});

test('a site found by domain or linked id that belongs to another client is left alone, with a task for a person', () => {
  const plainBefore = hub.getSiteById('site-plain');
  const specBefore = hub.getSiteById('site-spec');
  assert.equal(plainBefore.planSource.salesClientId, 'c1', 'site-plain is c1\'s');
  const byDomain = apply.applySitePlanToHub('cdup', { by: 'test', now: AT });
  assert.equal(byDomain.ok, false);
  assert.equal(byDomain.reason, 'site-owned-elsewhere');
  assert.equal(byDomain.owner, 'c1');
  const byId = apply.applySitePlanToHub('cid', { by: 'test', now: AT });
  assert.equal(byId.reason, 'site-owned-elsewhere');
  assert.equal(byId.owner, 'cspec', 'linked to cspec by its key');
  assert.deepEqual(hub.getSiteById('site-plain'), plainBefore, 'the other client\'s site is unchanged');
  assert.deepEqual(hub.getSiteById('site-spec'), specBefore);
  assert.equal(allSites().filter((site) => ['cdup', 'cid'].includes(site.planSource?.salesClientId)).length, 0, 'no site made');
  for (const id of ['cdup', 'cid']) {
    const client = sales.getSalesClientById(id);
    assert.ok(client.delivery.tasks.some((task) => task.kind === 'site_owner_conflict' && task.status === 'open'), id);
    assert.equal(client.sitePlan.appliedSiteId, '', `${id}: not applied`);
    assert.equal(apply.findSiteForClient(client), null, `${id}: readers do not see the other client's site`);
  }
  // A second try adds no second task.
  apply.applySitePlanToHub('cdup', { by: 'test', now: AT });
  assert.equal(sales.getSalesClientById('cdup').delivery.tasks.filter((task) => task.kind === 'site_owner_conflict').length, 1);
  // Control: the owner itself still finds and applies to its site.
  assert.equal(apply.applySitePlanToHub('c1', { by: 'test', now: AT }).site.id, 'site-plain');
});
