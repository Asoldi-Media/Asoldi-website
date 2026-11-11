// The signing switch around the signer: the plan routes and the sales card, the offer-scoped portal
// tier, the settings rules, the entitlement reader, the Maker handoff of an ended plan and the
// superadmin plan edit. Real data modules on a temp data dir; the routes behind a fake salesAuth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-signing-routes-'));
process.env.APP_DATA_DIR = DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const AT = '2026-10-28T10:00:00.000Z';
const vocab = await import('../packages/suite/core/delivery/vocab.js');
const plan = (tierId, extra = {}) => ({
  version: 1, status: 'active', tierId, services: vocab.servicesForTier(tierId), pages: 5, billing: 'month', source: 'progression', signedAt: AT, ...extra,
});
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([
  { id: 'pilot', product: 'asoldi', businessName: 'Pilot Example AS', status: 'active', ownerId: 'rep-a', progression: { contractSigned: true },
    sitePlan: plan('custom', { services: ['site', 'blog', 'ecom'], derived: true, needsConfirmation: true, conflicts: [{ source: 'stripe', tierId: 'tier-1-standard', at: AT, status: 'open' }], history: [{ at: AT, by: 'rep', from: null, to: { tierId: 'custom' }, reason: 'progression' }] }) },
  { id: 'other', product: 'asoldi', businessName: 'Other Example AS', status: 'active', ownerId: 'rep-b', progression: { contractSigned: true }, sitePlan: plan('tier-2-seo', { status: 'void' }), hubSite: { id: 'site-other', siteKey: 'key-other' } },
  { id: 'voided', product: 'asoldi', businessName: 'Voided Example AS', status: 'active', progression: { contractSigned: true }, sitePlan: plan('tier-3-ecommerce', { status: 'void' }), hubSite: { id: 'site-voided', siteKey: 'key-voided' } },
], null, 2));
writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify([
  { id: 'site-other', site_key: 'key-other', name: 'Other Example AS', websitePlan: 'tier-1-standard' },
  { id: 'site-voided', site_key: 'key-voided', name: 'Voided Example AS', websitePlan: 'tier-1-standard' },
], null, 2));

const express = (await import('express')).default;
const settingsStore = await import('../data/automation-settings.js');
// Auto needs a recorded release pass (lib/spine-mode.js); settings in auto hold the passes.
const { testReleases } = await import('./fixtures/test-releases.mjs');
const sales = await import('../data/sales.js');
const hub = await import('../data/hub.js');
const signing = await import('../lib/contract-signing.js');
const routes = await import('../lib/routes/signing-routes.js');
const entitlements = await import('../lib/cms-entitlements.js');
const { chosenWebsiteTier } = await import('../lib/site-plan.js');

function setSettings(value) {
  const file = join(DATA_DIR, 'automation-settings.json');
  if (value) writeFileSync(file, JSON.stringify(value));
  else rmSync(file, { force: true });
  settingsStore.invalidateAutomationSettingsCache();
}
const AUTO = { pilotClientIds: ['pilot', 'voided'], releases: testReleases(), signing: { enabled: true, mode: 'auto', paused: null } };
const SHADOW = { pilotClientIds: ['pilot'], signing: { enabled: true, mode: 'shadow', paused: null } };

const app = express();
app.use(express.json());
const salesAuth = (req, res, next) => {
  const auth = req.get('authorization');
  if (auth === 'Bearer admin') req.salesUser = { isAdmin: true, accountKey: 'admin' };
  else if (auth === 'Bearer rep-a') req.salesUser = { isAdmin: false, accountKey: 'rep-a' };
  else return res.status(401).json({ message: 'Unauthorized' });
  next();
};
routes.register(app, { salesAuth, sales });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const call = (method, path, auth = 'Bearer admin') => fetch(`${base}${path}`, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });

test('switch off: both plan routes answer 404 {code:"disabled"} and nothing is written', async () => {
  setSettings(null);
  const before = readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8');
  for (const [method, path] of [['GET', '/api/admin/sales/pilot/site-plan'], ['POST', '/api/admin/sales/pilot/site-plan/confirm']]) {
    const res = await call(method, path);
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).code, 'disabled');
  }
  assert.equal(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8'), before);
});

test('shadow: the card view is served, confirm is refused (no plan write in shadow)', async () => {
  setSettings(SHADOW);
  const got = await (await call('GET', '/api/admin/sales/pilot/site-plan')).json();
  assert.equal(got.mode, 'shadow', 'a pilot of a shadow switch runs in shadow');
  assert.equal(got.canConfirm, false);
  assert.equal((await call('POST', '/api/admin/sales/pilot/site-plan/confirm')).status, 409);
  assert.equal(sales.getSalesClientById('pilot').sitePlan.confirmedAt, '');
});

test('auto: summary, history and open conflicts; a rep sees only own clients; only Superadmin confirms', async () => {
  setSettings(AUTO);
  const view = await (await call('GET', '/api/admin/sales/pilot/site-plan')).json();
  assert.equal(view.mode, 'auto');
  assert.equal(view.plan.tierId, 'custom');
  assert.equal(view.plan.needsConfirmation, true);
  assert.equal(view.history.length, 1);
  assert.equal(view.conflicts.length, 1);
  assert.equal(view.canConfirm, true);
  assert.equal((await call('GET', '/api/admin/sales/pilot/site-plan', 'Bearer rep-a')).status, 200, 'own client');
  assert.equal((await call('GET', '/api/admin/sales/other/site-plan', 'Bearer rep-a')).status, 403, 'another rep\'s client');
  assert.equal((await call('POST', '/api/admin/sales/pilot/site-plan/confirm', 'Bearer rep-a')).status, 403);
  const confirmed = await (await call('POST', '/api/admin/sales/pilot/site-plan/confirm')).json();
  assert.equal(confirmed.plan.needsConfirmation, false);
  assert.ok(confirmed.plan.confirmedAt);
  assert.equal(confirmed.canConfirm, false);
  const stored = sales.getSalesClientById('pilot').sitePlan;
  assert.equal(stored.tierId, 'custom', 'confirming changes no tier');
  assert.deepEqual(stored.services, vocab.expandServices(['site', 'blog', 'ecom']), 'and no services');
  assert.equal(stored.needsConfirmation, false);
  assert.equal((await call('POST', '/api/admin/sales/pilot/site-plan/confirm')).status, 409, 'nothing left to confirm');
});

test('the sales card renders nothing unless the route answered; it is mounted once and offers no plan change or undo', () => {
  const card = readFileSync(new URL('../app/pages/Admin/sections/SalesPlanCard.tsx', import.meta.url), 'utf8');
  const section = readFileSync(new URL('../app/pages/Admin/sections/SalesClientsSection.tsx', import.meta.url), 'utf8');
  assert.match(card, /res\.ok \? \(\(await res\.json\(\)\) as SitePlanView\) : null/);
  assert.match(card, /if \(\(!view \|\| view\.mode === 'off'\) && !planChangeOn && !cancellationOn\) return null;/);
  assert.match(card, /\/site-plan\/confirm/);
  assert.match(card, /Bekreft tjenester/);
  assert.match(card, /lifecycle\?\.canChangePlan \? \(/);
  assert.match(card, /lifecycle\?\.canUnsign \? \(/);
  assert.match(card, /Endre plan/);
  assert.match(card, /Angre signering/);
  assert.match(card, /method: 'PATCH'[\s\S]{0,200}tierId: nextTier/);
  assert.doesNotMatch(card, /markPlanChanged|markContractUnsigned/);
  assert.equal(section.match(/<SalesPlanCard /g)?.length, 1);
  assert.match(section, /import \{ SalesPlanCard \} from '\.\/SalesPlanCard';/);
});

// ---------------------------------------------------------------- the switch around the paths

const handOffer = {
  id: 'offer-hand', salesClientId: 'x', status: 'sent',
  products: [{ id: 'p', kind: 'tier', tierId: 'tier-2-seo', name: 'Nettside + SEO', priceExMva: 1499 }],
};
const tierOneClient = { id: 'pilot', details: { meetingQuote: { tierId: 'starter' } }, portalTierId: 'tier-1-standard' };

test('portal tier: in auto the offer\'s own tier; off it is exactly the old chooser (control: the stale tier)', () => {
  setSettings(null);
  assert.equal(chosenWebsiteTier(tierOneClient, handOffer).id, 'tier-1-standard', 'control: the old chooser falls back to the meeting quote');
  assert.equal(signing.signingTierForOffer(tierOneClient, handOffer).id, 'tier-1-standard', 'off: unchanged');
  setSettings(AUTO);
  assert.equal(signing.signingTierForOffer(tierOneClient, handOffer).id, 'tier-2-seo', 'auto: the offer decides');
  assert.equal(signing.signingTierForOffer({ ...tierOneClient, id: 'not-a-pilot' }, handOffer).id, 'tier-1-standard', 'a client that is not a pilot keeps the old chooser');
  const custom = { ...handOffer, tierId: 'custom', products: [{ id: 'c', kind: 'custom', name: 'Egen pakke', priceExMva: 999, includes: [] }], plan: { tierId: 'custom', services: ['site', 'ecom'], pages: 5, billing: 'month' } };
  assert.equal(signing.offerScopedTier(custom).id, 'tier-3-ecommerce', 'a custom plan with a shop maps to the shop tier');
});

test('settings: auto needs pilots and a release pass; the default is off', () => {
  setSettings(null);
  assert.deepEqual(settingsStore.defaultAutomationSettings().signing, { enabled: false, mode: 'shadow', paused: null });
  assert.equal(signing.signingSwitchMode(), 'off');
  const noPilots = settingsStore.validateAutomationSettings({ signing: { enabled: true, mode: 'auto' } });
  assert.equal(noPilots.ok, false);
  assert.ok(noPilots.errors.some((error) => error.path === 'signing.mode' && /pilot/.test(error.message)));
  const noPass = settingsStore.validateAutomationSettings({ pilotClientIds: ['pilot'], signing: { enabled: true, mode: 'auto' } });
  assert.equal(noPass.ok, false);
  assert.ok(noPass.errors.some((error) => error.path === 'signing'), 'release-gated');
  const shadow = settingsStore.validateAutomationSettings({ signing: { enabled: true, mode: 'shadow' } });
  assert.equal(shadow.ok, true, JSON.stringify(shadow.errors));
  assert.equal(settingsStore.validateAutomationSettings({ signing: { enabled: true, mode: 'shadow', paused: 'x' } }).ok, false);
  const passed = { pilotClientIds: ['pilot'], signing: { enabled: true, mode: 'auto' }, releases: { signing: { passedAt: AT, suite: 'test' } } };
  const current = { ...settingsStore.defaultAutomationSettings(), releases: passed.releases };
  const { releases, ...patch } = passed;
  assert.equal(settingsStore.validateAutomationSettings(patch, { current }).ok, true);
  assert.equal(signing.signingModeForClient({ id: 'pilot' }, { settings: { ...current, ...patch } }), 'auto');
  assert.equal(signing.signingModeForClient({ id: 'other' }, { settings: { ...current, ...patch } }), 'shadow');
  assert.equal(signing.signingModeForClient({ id: 'pilot' }, { settings: { ...current, ...patch, signing: { enabled: true, mode: 'auto', paused: { reason: 'guard' } } } }), 'shadow', 'paused runs in shadow');
  assert.equal(signing.signingModeForClient({ id: 'pilot', isTest: true }, { settings: { ...current, ...patch, pilotClientIds: [] } }), 'off', 'a test client that is not a pilot is left out');
});

test('entitlements: a void plan counts for no auto client; for any other client the stored plan counts as before', () => {
  const voided = sales.getSalesClientById('voided');
  setSettings(null);
  assert.equal(entitlements.entitlementSitePlan(voided).tierId, 'tier-3-ecommerce', 'control: off reads the stored plan as before');
  const site = hub.getSiteById('site-voided');
  assert.equal(entitlements.servicesForSite(site, voided, { log: null }).source, 'sitePlan');
  setSettings(AUTO);
  assert.equal(entitlements.entitlementSitePlan(voided), null);
  assert.equal(entitlements.servicesForSite(site, voided, { log: null }).source, 'websitePlan');
  assert.equal(entitlements.entitlementSitePlan(sales.getSalesClientById('other')).status, 'void', 'not a pilot: as before');
  assert.equal(entitlements.entitlementSitePlan(sales.getSalesClientById('pilot')).status, 'active');
});

test('Maker handoff: an auto client\'s void plan goes out with its status; otherwise nothing changes', () => {
  setSettings(AUTO);
  const payload = signing.endedSitePlanForMaker(sales.getSalesClientById('voided'));
  assert.equal(payload.status, 'void');
  assert.equal(payload.tierId, 'tier-3-ecommerce');
  assert.equal(signing.endedSitePlanForMaker(sales.getSalesClientById('other')), null, 'not a pilot');
  setSettings(null);
  assert.equal(signing.endedSitePlanForMaker(sales.getSalesClientById('voided')), null, 'switch off');
});

test('superadmin plan edit: kind admin for an auto client\'s site; nothing for anyone else', () => {
  setSettings(null);
  const before = hub.getSiteById('site-voided');
  const after = hub.updateSite('site-voided', { websitePlan: 'tier-2-seo' }).site;
  assert.equal(signing.markAdminPlanEdit(before, after, { by: 'superadmin' }), null, 'off: nothing written');
  assert.equal(hub.getSiteById('site-voided').planSource, undefined);
  setSettings(AUTO);
  const edited = signing.markAdminPlanEdit(before, after, { by: 'superadmin' });
  assert.equal(edited.planSource.kind, 'admin');
  assert.equal(edited.planSource.tierId, 'tier-2-seo');
  assert.equal(edited.planSource.salesClientId, 'voided');
  const otherBefore = hub.getSiteById('site-other');
  const otherAfter = hub.updateSite('site-other', { websitePlan: 'tier-3-ecommerce' }).site;
  assert.equal(signing.markAdminPlanEdit(otherBefore, otherAfter), null, 'not a pilot');
  setSettings(null);
});

test('entitlements: in auto a client\'s plan counts for a site only where it was applied (a copied link gives the other site nothing)', () => {
  const pilot = sales.getSalesClientById('pilot');
  const otherSite = hub.getSiteById('site-other');
  setSettings(null);
  assert.equal(entitlements.entitlementSitePlan(pilot, { site: otherSite }).status, 'active', 'control: off reads the plan for any linked site');
  assert.equal(entitlements.servicesForSite(otherSite, pilot, { log: null }).source, 'sitePlan', 'control: off');
  setSettings(AUTO);
  assert.equal(entitlements.entitlementSitePlan(pilot, { site: otherSite }), null, 'auto: not applied to this site');
  assert.equal(entitlements.servicesForSite(otherSite, pilot, { log: null }).source, 'websitePlan', 'the site keeps its own plan');
  const applied = { ...pilot, sitePlan: { ...pilot.sitePlan, appliedSiteId: 'site-other' } };
  assert.equal(entitlements.entitlementSitePlan(applied, { site: otherSite }).status, 'active', 'auto: the site it was applied to');
  assert.equal(entitlements.servicesForSite(otherSite, applied, { log: null }).source, 'sitePlan');
  assert.equal(entitlements.entitlementSitePlan(pilot).status, 'active', 'without a site: as before');
  setSettings(null);
});

test('superadmin plan edit: a site two clients link, with no planSource, gets no planSource (a person decides)', () => {
  sales.createSalesClient({ id: 'copy-other', product: 'asoldi', status: 'active', businessName: 'Copy Example AS', progression: { contractSigned: true }, hubSite: { id: 'site-other', siteKey: 'key-other' } });
  setSettings({ ...AUTO, pilotClientIds: ['other', 'copy-other'] });
  const before = hub.getSiteById('site-other');
  assert.equal(before.planSource, undefined);
  const after = hub.updateSite('site-other', { websitePlan: 'tier-2-seo' }).site;
  assert.equal(signing.markAdminPlanEdit(before, after, { by: 'superadmin' }), null);
  assert.equal(hub.getSiteById('site-other').planSource, undefined, 'no client is named on the site');
  setSettings(null);
});
