// Go-live callback, schema 2 (lib/golive-callback.js), against the fixtures the Maker test uses too
// (scripts/fixtures/golive-callback/). The handler runs the way the maker-status-callback route runs
// it: linkSite, then record. Real data modules on a temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-golive-v2-'));
process.env.APP_DATA_DIR = DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golive-callback');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const AT = '2026-10-28T10:00:00.000Z';
const vocab = await import('../packages/suite/core/delivery/vocab.js');
const signedPlan = (tierId) => ({ version: 1, status: 'active', tierId, services: vocab.servicesForTier(tierId), pages: 5, billing: 'month', source: 'progression', signedAt: AT });
const client = (id, extra = {}) => ({ id, product: 'asoldi', businessName: `${id} Example AS`, status: 'active', progression: { meetingHeld: true, offerSent: true, contractSigned: true }, contractSignedAt: AT, ...extra });
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([
  client('plain'),
  client('withsite', { sitePlan: signedPlan('tier-2-seo'), hubSite: { id: 'site-withsite', siteKey: 'hub-key-withsite' } }),
  client('nosite', { sitePlan: signedPlan('tier-3-ecommerce') }),
  client('staging', {
    sitePlan: signedPlan('tier-3-ecommerce'),
    hubSite: { id: 'site-staging', siteKey: 'hub-key-staging' },
    nextActions: [{ id: 'na-live', goalKey: 'live', presetKey: 'custom', name: 'Publiser nettsiden', format: 'ring', dueAt: AT, createdAt: AT }],
  }),
  // Sites the signer makes below (applySitePlanToHub), with a key of the hub's own.
  client('signed', { sitePlan: signedPlan('tier-3-ecommerce') }),
  client('reached', { sitePlan: signedPlan('tier-3-ecommerce') }),
  client('enrolled', { sitePlan: signedPlan('tier-3-ecommerce') }),
  client('other', { sitePlan: signedPlan('tier-3-ecommerce') }),
], null, 2));
writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify([
  { id: 'site-withsite', site_key: 'hub-key-withsite', name: 'withsite Example AS', websitePlan: 'tier-2-seo', features: { users: true, analytics: true, blog: true } },
  { id: 'site-staging', site_key: 'hub-key-staging', name: 'staging Example AS', websitePlan: 'tier-3-ecommerce', features: { users: true, ecommerce: true } },
], null, 2));

const settingsStore = await import('../data/automation-settings.js');
// Auto needs a recorded release pass (lib/spine-mode.js); settings in auto hold the passes.
const { testReleases } = await import('./fixtures/test-releases.mjs');
const sales = await import('../data/sales.js');
const hub = await import('../data/hub.js');
const golive = await import('../lib/golive-callback.js');

function setSettings(value) {
  const file = join(DATA_DIR, 'automation-settings.json');
  if (value) writeFileSync(file, JSON.stringify(value));
  else rmSync(file, { force: true });
  settingsStore.invalidateAutomationSettingsCache();
}
const AUTO = { pilotClientIds: ['withsite', 'nosite', 'staging', 'signed', 'reached', 'enrolled', 'other'], releases: testReleases(), signing: { enabled: true, mode: 'auto', paused: null } };
const apply = await import('../lib/site-plan-apply.js');
const { siteCredentialStore } = await import('../lib/site-credentials.js');

function auditRows() {
  const folder = join(DATA_DIR, 'delivery-audit');
  try {
    return readdirSync(folder).flatMap((name) => readFileSync(join(folder, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  } catch {
    return [];
  }
}

async function deliver(clientId, body) {
  const current = sales.getSalesClientById(clientId);
  const handler = golive.goLiveCallbackV2(body, current);
  if (!handler) return { handled: false };
  const site = await handler.linkSite({ siteKey: body.siteKey || body.hubSite?.site_key || '', domain: body.domain || '', githubRepo: body.githubRepo || '', name: body.hubSite?.name || '' });
  const updated = handler.record(sales.getSalesClientById(clientId));
  return { handled: true, mode: handler.mode, site, client: updated };
}

test('the fixtures: every v2 file is the matching v1 file plus schema, target and liveVerifiedAt', () => {
  const names = readdirSync(FIXTURES).filter((name) => name.endsWith('.json'));
  assert.ok(names.length >= 8);
  for (const name of ['ready', 'failed']) {
    const v1 = fixture(`v1-${name}.json`);
    const v2 = fixture(`v2-${name}.json`);
    assert.deepEqual(v2, { ...v1, schema: 2, target: 'production', liveVerifiedAt: '' }, name);
  }
  for (const name of names.filter((entry) => entry.startsWith('v2-'))) {
    const body = fixture(name);
    assert.equal(body.schema, 2, name);
    assert.ok(golive.GOLIVE_TARGETS.includes(body.target), name);
    assert.ok(golive.normalizeGoLiveCallback(body), `${name} is read as schema 2`);
  }
});

test('an old payload (no schema) keeps today\'s behaviour: the handler steps aside', async () => {
  setSettings(AUTO);
  assert.equal(golive.normalizeGoLiveCallback(fixture('v1-ready.json')), null);
  assert.equal((await deliver('withsite', fixture('v1-ready.json'))).handled, false);
});

test('switch off: schema 2 is handled as before too', async () => {
  setSettings(null);
  assert.equal((await deliver('withsite', fixture('v2-ready.json'))).handled, false);
  assert.equal(sales.getSalesClientById('withsite').makerRun?.goLive, undefined);
});

test('a pushed callback is not live', async () => {
  setSettings(AUTO);
  const result = await deliver('withsite', fixture('v2-ready.json'));
  assert.equal(result.mode, 'auto');
  assert.equal(result.client.makerRun.goLive.status, 'pushed');
  assert.equal(result.client.makerRun.goLive.liveVerifiedAt, '');
  assert.notEqual(result.client.progression.live, true);
  assert.equal(result.site.id, 'site-withsite', 'the client\'s own site');
});

test('plan and feature fields in a callback change no plan or feature field on the hub site', async () => {
  setSettings(AUTO);
  const before = hub.getSiteById('site-withsite');
  await deliver('withsite', fixture('v2-plan-fields.json'));
  const after = hub.getSiteById('site-withsite');
  assert.equal(after.websitePlan, before.websitePlan);
  assert.deepEqual(after.features, before.features);
  assert.deepEqual(after.planSource, before.planSource);
  assert.equal(sales.getSalesClientById('withsite').sitePlan.tierId, 'tier-2-seo');
});

test('a staging live stores goLive but sets neither progression.live nor the live stage', async () => {
  setSettings(AUTO);
  const result = await deliver('staging', fixture('v2-staging-live.json'));
  const goLive = result.client.makerRun.goLive;
  assert.equal(goLive.target, 'staging');
  assert.equal(goLive.stagingDomain, 'bakery-staging.example.net');
  assert.notEqual(result.client.progression.live, true);
  assert.notEqual(result.client.progression.domainConnected, true);
  assert.notEqual(result.client.delivery?.stage, 'live');
});

test('a verified production live sets live, domainConnected and liveVerifiedAt (auto)', async () => {
  setSettings(AUTO);
  const result = await deliver('staging', fixture('v2-production-live.json'));
  assert.equal(result.client.progression.live, true);
  assert.equal(result.client.progression.domainConnected, true);
  assert.equal(result.client.makerRun.goLive.target, 'production');
  assert.equal(result.client.makerRun.goLive.liveVerifiedAt, '2026-11-02T10:20:00.000Z');
  assert.equal(result.client.makerRun.goLive.staging.target, 'staging', 'the staging record is kept beside it');
  assert.equal(result.client.delivery.stage, 'live');
  const action = result.client.nextActions.find((entry) => entry.id === 'na-live');
  assert.ok(action?.doneAt, 'the next action tied to the live goal closes, as on the card');
});

test('needs_import keeps the hint and opens one developer task', async () => {
  setSettings(AUTO);
  const first = await deliver('withsite', fixture('v2-needs-import.json'));
  const again = await deliver('withsite', fixture('v2-needs-import.json'));
  assert.equal(first.client.makerRun.goLive.status, 'needs_import');
  assert.match(first.client.makerRun.goLive.needsImport.hint, /Import the repository/);
  const tasks = again.client.delivery.tasks.filter((task) => task.kind === 'needs_import');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'open');
  assert.match(tasks[0].hint, /Import the repository/);
});

test('auto: a client without a hub site gets it from its plan, with the Maker\'s key; shadow creates the old bare site', async () => {
  setSettings(AUTO);
  const result = await deliver('nosite', { ...fixture('v2-ready.json'), domain: 'nosite.example.com' });
  assert.equal(result.site.site_key, 'site-key-from-the-maker-0001');
  assert.equal(result.site.domain, 'nosite.example.com');
  assert.equal(result.site.websitePlan, 'tier-3-ecommerce');
  assert.equal(result.site.planSource.kind, 'offer');
  assert.equal(result.site.features.ecommerce, true);
  assert.equal(sales.getSalesClientById('nosite').hubSite.id, result.site.id);
  setSettings({ ...AUTO, signing: { enabled: true, mode: 'shadow', paused: null } });
  const shadow = await deliver('plain', { ...fixture('v2-ready.json'), siteKey: 'plain-key', domain: 'plain.example.com' });
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.site.site_key, 'plain-key');
  assert.equal(shadow.site.planSource, undefined, 'shadow never writes a planSource');
  assert.equal(shadow.site.websitePlan, 'tier-1-standard', 'the old bare site');
  setSettings(null);
});

// A site the signer made (planSource.siteCreatedBy) with a key of the hub's own, before the Maker
// published the site with its key.
function signerSite(clientId) {
  const made = apply.applySitePlanToHub(clientId, { by: 'contract-signing', now: AT });
  assert.equal(made.created, true, clientId);
  assert.match(made.site.site_key, /^[0-9a-f]{32}$/);
  return made.site;
}

test('auto: a site the signer made that no CMS has reached takes the Maker\'s key; site-config answers for it', async () => {
  setSettings(AUTO);
  const site = signerSite('signed');
  const result = await deliver('signed', { ...fixture('v2-ready.json'), siteKey: 'maker-key-signed-0001', domain: 'signed.example.com' });
  assert.equal(result.site.id, site.id, 'the same site');
  assert.equal(result.site.site_key, 'maker-key-signed-0001');
  assert.equal(result.site.domain, 'signed.example.com');
  assert.equal(hub.getSiteByKey(site.site_key), null, 'the old key is gone');
  assert.equal(hub.getAllSites().filter((entry) => entry.planSource?.salesClientId === 'signed').length, 1);
  assert.equal(sales.getSalesClientById('signed').hubSite.siteKey, 'maker-key-signed-0001');
  assert.notEqual(result.client.makerRun.goLive.siteKeyMismatch, true);
  assert.equal((result.client.delivery?.tasks || []).some((task) => task.kind === 'site_key_mismatch'), false);
  const config = hub.getSiteConfig('maker-key-signed-0001');
  assert.equal(config.id, site.id);
  assert.equal(config.websitePlan, 'tier-3-ecommerce');
  assert.equal(config.features.ecommerce, true);
  assert.ok(auditRows().some((row) => row.kind === 'site-key-adopted' && row.clientId === 'signed'));
});

test('auto: a site a CMS has reached keeps its key and the Maker\'s key is flagged', async () => {
  setSettings(AUTO);
  const site = signerSite('reached');
  hub.recordHeartbeat(site.site_key, { packageVersion: '2.2.2' });
  const result = await deliver('reached', { ...fixture('v2-ready.json'), siteKey: 'maker-key-reached-0001', domain: 'reached.example.com' });
  assert.equal(result.site.id, site.id);
  assert.equal(result.site.site_key, site.site_key, 'the key the CMS uses stays');
  assert.equal(result.client.makerRun.goLive.siteKeyMismatch, true);
  assert.ok(result.client.delivery.tasks.some((task) => task.kind === 'site_key_mismatch' && task.status === 'open'));
  assert.equal(hub.getSiteByKey('maker-key-reached-0001'), null, 'no second site');
});

test('auto: a site with a site credential keeps its key', async () => {
  setSettings(AUTO);
  const site = signerSite('enrolled');
  siteCredentialStore().enroll(site.id, 'A'.repeat(43), { proofDomain: 'enrolled.example.com' });
  const result = await deliver('enrolled', { ...fixture('v2-ready.json'), siteKey: 'maker-key-enrolled-0001', domain: 'enrolled.example.com' });
  assert.equal(result.site.site_key, site.site_key);
  assert.equal(result.client.makerRun.goLive.siteKeyMismatch, true);
});

test('auto: a site found by domain that belongs to another client is left alone', async () => {
  setSettings(AUTO);
  const before = hub.getSiteById('site-withsite');
  assert.equal(before.domain, 'bakery.example.com', 'filled in by the first callback');
  const result = await deliver('other', { ...fixture('v2-ready.json'), siteKey: '', hubSite: undefined });
  assert.equal(result.site, null, 'no site linked');
  assert.deepEqual(hub.getSiteById('site-withsite'), before, 'the other client\'s site is unchanged');
  const other = sales.getSalesClientById('other');
  assert.equal(other.hubSite?.id || '', '', 'no site linked on the client');
  assert.ok(other.delivery.tasks.some((task) => task.kind === 'site_owner_conflict' && task.siteId === 'site-withsite' && task.status === 'open'));
  assert.ok(auditRows().some((row) => row.kind === 'site-owner-conflict' && row.clientId === 'other' && row.owner === 'withsite'));
});

test('shadow: only a pushed status links a site, as the old handler did', async () => {
  setSettings({ ...AUTO, signing: { enabled: true, mode: 'shadow', paused: null } });
  const sitesBefore = readFileSync(join(DATA_DIR, 'sites.json'), 'utf8');
  for (const status of ['deploying', 'needs_import', 'live', 'failed']) {
    const result = await deliver('plain', { ...fixture('v2-ready.json'), status, siteKey: `plain-${status}-key`, domain: `plain-${status}.example.com` });
    assert.equal(result.mode, 'shadow');
    assert.equal(result.site, null, status);
  }
  assert.equal(readFileSync(join(DATA_DIR, 'sites.json'), 'utf8'), sitesBefore, 'no site written');
  setSettings(null);
});
