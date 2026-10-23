// WS8.41: the delivery backfill on synthetic data shaped like the live stores. Dry run first (report
// only, stores untouched), apply (snapshot, plans, planSource, stages, email stamps), a second apply
// changes nothing, the hub site config is unchanged for every site, SSU clients never get a plan,
// and the boot hook does nothing while the switch is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-backfill-'));
process.env.APP_DATA_DIR = DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { buildOfferFromMeetingQuote } = await import('../lib/offer-from-quote.js');
const tier2 = buildOfferFromMeetingQuote({ tierId: 'seo', selected: [], pages: 7 });
const dual = buildOfferFromMeetingQuote({ tierId: 'starter', selected: [], pages: 5, altQuote: { tierId: 'nettbutikk', selected: [], pages: 10 } });
const legacyAlternatives = (built) => built.alternatives.map(({ plan, pricing, ...rest }) => rest);
const signedProgression = { meetingHeld: true, offerSent: true, contractSigned: true };
const tier1Flags = { users: true, analytics: false, ecommerce: false, blog: false, socialSync: false, emailMarketing: false, general: false };
const tier3Flags = { users: true, analytics: true, ecommerce: true, blog: true, socialSync: true, emailMarketing: true, general: true };

const CLIENTS = [
  { id: 'live-legacy', product: 'asoldi', businessName: 'Live Legacy AS', status: 'active', progression: { ...signedProgression, domainConnected: true, live: true }, hubSite: { id: 'site-linked', siteKey: 'key-linked', createdAt: '2026-05-01T10:00:00.000Z', liveUrl: 'https://live-legacy.example' }, details: { meetingQuote: { tierId: 'starter' } } },
  { id: 'signed-offer', product: 'asoldi', businessName: 'Signed Offer AS', status: 'active', progression: signedProgression, contractSignedAt: '2026-10-01T10:00:00.000Z', workshopAction: { name: 'Workshop', dueAt: '2026-10-30T10:00:00.000Z' } },
  { id: 'signed-dual', product: 'asoldi', businessName: 'Signed Dual AS', status: 'active', progression: signedProgression },
  { id: 'signed-ssu', product: 'ssu', businessName: 'Signed Ssu AS', status: 'active', progression: signedProgression },
  { id: 'signed-nothing', product: 'asoldi', businessName: 'Signed Nothing AS', status: 'active', progression: signedProgression, details: { meetingQuote: { tierId: 'starter' } } },
  { id: 'lead', product: 'asoldi', businessName: 'Lead AS', status: 'active', progression: { meetingHeld: true } },
  { id: 'signed-portal', product: 'asoldi', businessName: 'Signed Portal AS', status: 'active', progression: signedProgression, portalBusinessId: 'biz-portal', contractSignedAt: '2026-10-05T10:00:00.000Z' },
];
const OFFERS = [
  { id: 'offer-signed', salesClientId: 'signed-offer', status: 'sent', sentAt: '2026-09-30T10:00:00.000Z', tierId: tier2.tierId, products: tier2.products, alternatives: legacyAlternatives(tier2) },
  { id: 'offer-dual', salesClientId: 'signed-dual', status: 'sent', sentAt: '2026-09-30T10:00:00.000Z', tierId: dual.tierId, products: dual.products, alternatives: legacyAlternatives(dual) },
  { id: 'offer-portal', salesClientId: 'signed-portal', status: 'sent', sentAt: '2026-10-04T10:00:00.000Z', tierId: dual.tierId, products: dual.products, alternatives: dual.alternatives },
  { id: 'offer-lead', salesClientId: 'lead', status: 'sent', sentAt: '2026-10-04T10:00:00.000Z', tierId: tier2.tierId, products: tier2.products, alternatives: tier2.alternatives },
];
const PORTAL_OFFERS = [
  { id: 'po-1', salesClientId: 'signed-portal', salesOfferId: 'offer-portal', planId: 'tier-1-standard', acceptance: { acceptedAt: '2026-10-05T10:00:00.000Z', chosenOfferIndex: 1 } },
];
const PROFILES = [{ userId: 'u-portal', businessId: 'biz-portal', businessName: 'Signed Portal AS', payment: { planId: 'tier-1-standard' }, updatedAt: '2026-10-05T10:00:00.000Z' }];
const SITES = [
  { id: 'site-linked', site_key: 'key-linked', name: 'Linked', domain: 'live-legacy.example', websitePlan: 'tier-1-standard', features: tier1Flags, deliveryPhase: 'client', createdAt: '2026-05-01T10:00:00.000Z' },
  { id: 'site-unlinked', site_key: 'key-unlinked', name: 'Unlinked', domain: 'unlinked.example', websitePlan: 'tier-3-ecommerce', features: tier3Flags, deliveryPhase: 'client', createdAt: '2026-04-01T10:00:00.000Z' },
];
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify(CLIENTS, null, 2));
writeFileSync(join(DATA_DIR, 'sales-offers.json'), JSON.stringify(OFFERS, null, 2));
writeFileSync(join(DATA_DIR, 'client-offers.json'), JSON.stringify(PORTAL_OFFERS, null, 2));
writeFileSync(join(DATA_DIR, 'client-portal-profiles.json'), JSON.stringify(PROFILES, null, 2));
writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify(SITES, null, 2));

const backfill = await import('../lib/delivery-backfill.js');
const sales = await import('../data/sales.js');
const hub = await import('../data/hub.js');
const settings = await import('../data/automation-settings.js');

const STORES = ['sales-clients.json', 'sales-offers.json', 'client-offers.json', 'client-portal-profiles.json', 'sites.json'];
const readStores = () => Object.fromEntries(STORES.map((name) => [name, readFileSync(join(DATA_DIR, name), 'utf8')]));
const NOW = '2026-11-20T12:00:00.000Z';

// The hub's own reads normalize the stores (and may rewrite them once); start from that state.
sales.getSalesClients();
hub.getAllSites();

test('boot hook: with the switch off nothing runs and nothing is written', () => {
  const before = readStores();
  assert.equal(settings.getAutomationSettings({ fresh: true }).migrations.deliveryBackfill, 'off');
  assert.deepEqual(backfill.runDeliveryBackfillAtBoot({ now: NOW }), { skipped: 'off' });
  assert.deepEqual(readStores(), before);
  assert.equal(existsSync(join(DATA_DIR, 'migrations')), false);
  assert.equal(existsSync(join(DATA_DIR, 'snapshots')), false);
});

let dryReport;
test('dry run: the report lists every case and the stores stay byte-identical', () => {
  const before = readStores();
  dryReport = backfill.runDeliveryBackfill({ mode: 'dry-run', now: NOW, by: 'test' });
  assert.deepEqual(readStores(), before, 'a dry run writes no store');
  assert.equal(existsSync(join(DATA_DIR, 'snapshots')), false, 'no snapshot on a dry run');
  const { counts } = dryReport;
  assert.equal(counts.clients, 7);
  assert.equal(counts.signedWebsiteClients, 5);
  assert.equal(counts.signedSsuClients, 1);
  assert.equal(counts.sitePlans.write, 3);
  assert.equal(counts.sitePlans.needsChoice, 1);
  assert.equal(counts.sitePlans.noEvidence, 1);
  const byClient = Object.fromEntries(dryReport.sitePlans.map((entry) => [entry.clientId, entry]));
  assert.deepEqual(Object.keys(byClient).sort(), ['live-legacy', 'signed-offer', 'signed-portal']);
  assert.equal(byClient['live-legacy'].evidence, 'hub-site');
  assert.equal(byClient['live-legacy'].tierId, 'tier-1-standard');
  assert.equal(byClient['signed-offer'].evidence, 'offer');
  assert.equal(byClient['signed-offer'].tierId, 'tier-2-seo');
  assert.equal(byClient['signed-portal'].evidence, 'portal-accept');
  assert.equal(byClient['signed-portal'].tierId, 'tier-3-ecommerce');
  assert.deepEqual(byClient['signed-portal'].conflicts, [{ source: 'payment', tierId: 'tier-1-standard' }]);
  assert.deepEqual(dryReport.needsChoice, [{ clientId: 'signed-dual', offerId: 'offer-dual', evidence: 'offer' }]);
  assert.deepEqual(dryReport.noEvidence, [{ clientId: 'signed-nothing', reason: 'no-evidence' }]);
  assert.ok(!JSON.stringify(dryReport).includes('signed-ssu'), 'SSU clients are not listed');
  assert.equal(counts.planSources.write, 1);
  assert.equal(counts.planSources.unlinkedSites, 1);
  assert.deepEqual(dryReport.planSources[0].warnings, [{ kind: 'flags', flags: ['blog'] }], 'tier 1 plan flags vs the live site: the blog (owner decision), reported only');
  const stages = Object.fromEntries(dryReport.stages.map((entry) => [entry.clientId, entry.to]));
  assert.deepEqual(stages, { 'live-legacy': 'maintenance', 'signed-offer': 'gathering', 'signed-dual': 'signed', 'signed-nothing': 'signed', 'signed-portal': 'signed' });
  const stamps = Object.fromEntries(dryReport.emailStamps.map((entry) => [entry.clientId, entry.keys]));
  assert.deepEqual(stamps, {
    'live-legacy': ['preWorkshopSentAt', 'postWorkshopSentAt', 'previewReadySentAt', 'stagingReadySentAt', 'siteLiveSentAt'],
  }, 'a client in gathering with a booked workshop still has the pre-workshop email due');
  assert.ok(dryReport.file && existsSync(join(DATA_DIR, 'migrations', dryReport.file)), 'the report is written');
  assert.doesNotMatch(readFileSync(join(DATA_DIR, 'migrations', dryReport.file), 'utf8'), /Legacy AS|Offer AS|example/, 'the report holds ids, not names or addresses');
  assert.equal(existsSync(join(DATA_DIR, 'delivery-audit')), false, 'a dry run adds nothing to the audit log');
  backfill.runDeliveryBackfill({ mode: 'dry-run', now: NOW, by: 'test', writeReport: false });
  assert.equal(existsSync(join(DATA_DIR, 'delivery-audit')), false, 'nor does a dry run without a report');
  assert.equal(backfill.lastBackfillApply(), null, 'a dry run is not an apply');
});

test('email pre-stamps: only keys whose stage is strictly past the last stage the email can be due', () => {
  const keys = (stage, subState = '') => backfill.prestampKeys({ stage, subState }, {});
  assert.deepEqual(keys('signed'), []);
  assert.deepEqual(keys('gathering', 'workshop-booked'), [], 'the pre-workshop email is still due');
  assert.deepEqual(keys('workshop_held'), ['preWorkshopSentAt']);
  assert.deepEqual(keys('gate'), ['preWorkshopSentAt'], 'the post-workshop email can still be due at the gate');
  assert.deepEqual(keys('developing'), ['preWorkshopSentAt', 'postWorkshopSentAt']);
  assert.deepEqual(keys('client_preview'), ['preWorkshopSentAt', 'postWorkshopSentAt'], 'the preview email can still be due');
  assert.deepEqual(keys('iterating'), ['preWorkshopSentAt', 'postWorkshopSentAt', 'previewReadySentAt']);
  assert.deepEqual(keys('publishing', 'staging-live'), ['preWorkshopSentAt', 'postWorkshopSentAt', 'previewReadySentAt']);
  assert.deepEqual(keys('live'), ['preWorkshopSentAt', 'postWorkshopSentAt', 'previewReadySentAt', 'stagingReadySentAt'], 'a verified go-live still has the site-live email due');
  assert.deepEqual(keys('live', 'legacy'), ['preWorkshopSentAt', 'postWorkshopSentAt', 'previewReadySentAt', 'stagingReadySentAt', 'siteLiveSentAt']);
  assert.deepEqual(keys('maintenance'), ['preWorkshopSentAt', 'postWorkshopSentAt', 'previewReadySentAt', 'stagingReadySentAt', 'siteLiveSentAt']);
  assert.deepEqual(backfill.prestampKeys({ stage: 'developing' }, { preWorkshopSentAt: NOW }), ['postWorkshopSentAt'], 'sent keys are skipped');
  assert.deepEqual(backfill.prestampKeys({ stage: '' }, {}), []);
});

test('apply: snapshot first, then plans, planSource, stamps and stages; site config unchanged; second apply changes nothing', () => {
  const sitesBefore = hub.getAllSites();
  const report = backfill.runDeliveryBackfill({ mode: 'apply', now: NOW, by: 'test' });
  assert.ok(report.snapshotId && existsSync(join(DATA_DIR, 'snapshots', report.snapshotId)), 'snapshot taken before writing');
  assert.deepEqual(report.applied, { sitePlans: 3, planSources: 1, emailStamps: 1, stages: 5, errors: [] });
  assert.deepEqual(report.remaining, { sitePlans: 0, planSources: 0, emailStamps: 0, stages: 0 });

  const portal = sales.getSalesClientById('signed-portal');
  assert.equal(portal.sitePlan.source, 'backfill');
  assert.equal(portal.sitePlan.tierId, 'tier-3-ecommerce');
  assert.equal(portal.sitePlan.alternativeIndex, 1);
  assert.equal(portal.sitePlan.history.length, 1);
  assert.equal(sales.getSalesClientById('signed-ssu').sitePlan, undefined, '0 SSU clients get a plan');
  assert.equal(sales.getSalesClientById('signed-ssu').delivery, undefined);
  assert.equal(sales.getSalesClientById('signed-dual').sitePlan, undefined, 'a dual offer without a choice gets no plan');
  assert.equal(sales.getSalesClientById('lead').delivery, undefined, 'leads keep no stored stage');

  const live = sales.getSalesClientById('live-legacy');
  assert.equal(live.delivery.stage, 'maintenance');
  assert.equal(live.delivery.emails.siteLiveSentAt, NOW);
  assert.deepEqual(live.delivery.emails.backfilled.sort(), ['postWorkshopSentAt', 'preWorkshopSentAt', 'previewReadySentAt', 'siteLiveSentAt', 'stagingReadySentAt']);
  assert.equal(live.workshop.deskEmails.preWorkshopSentAt, NOW, 'legacy mirror stamped in the same write');
  assert.equal(live.progression.live, true, 'progression is not rewritten');
  const gathering = sales.getSalesClientById('signed-offer');
  assert.equal(gathering.delivery.stage, 'gathering');
  assert.equal(gathering.delivery.emails.preWorkshopSentAt || '', '', 'the due pre-workshop email is not marked as sent');
  assert.equal(gathering.workshop?.deskEmails?.preWorkshopSentAt, undefined, 'nor its legacy mirror');
  const audit = readdirSync(join(DATA_DIR, 'delivery-audit')).flatMap((name) => readFileSync(join(DATA_DIR, 'delivery-audit', name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  assert.equal(audit.filter((entry) => entry.kind === 'backfill').length, 1, 'one audit line for the apply');
  assert.equal(backfill.lastBackfillApply().snapshotId, report.snapshotId, 'the apply is recorded');

  const sitesAfter = hub.getAllSites();
  for (const site of sitesBefore) {
    const after = sitesAfter.find((entry) => entry.id === site.id);
    const { planSource, ...rest } = after;
    assert.deepEqual(rest, site, `${site.id}: everything the CMS reads is unchanged`);
  }
  const linked = sitesAfter.find((site) => site.id === 'site-linked');
  assert.deepEqual(linked.planSource, { kind: 'backfill', salesClientId: 'live-legacy', tierId: 'tier-1-standard', derivedFeatures: tier1Flags, appliedAt: NOW, appliedBy: 'backfill' });
  assert.equal(sitesAfter.find((site) => site.id === 'site-unlinked').planSource, undefined);

  const storesAfterFirst = readStores();
  const second = backfill.runDeliveryBackfill({ mode: 'apply', now: '2026-11-21T12:00:00.000Z', by: 'test' });
  assert.equal(second.applied, undefined, 'nothing to apply');
  assert.equal(second.snapshotId, undefined, 'no snapshot without changes');
  assert.equal(second.counts.sitePlans.write + second.counts.planSources.write + second.counts.stages.write + second.counts.emailStamps.keys, 0);
  assert.deepEqual(readStores(), storesAfterFirst, 'a second apply makes 0 changes');
});

test('boot hook: apply is one-time; clients that progress after an apply get no plan or stamp at the next boot', () => {
  settings.saveAutomationSettings({ migrations: { deliveryBackfill: 'apply' } }, { by: 'test' });
  // After the apply: a lead signs (it has a sent offer) and the gathering client holds its workshop.
  sales.updateSalesClient('lead', { progression: signedProgression });
  sales.updateSalesClient('signed-offer', { workshop: { heldAt: '2026-11-21T09:00:00.000Z' } });
  assert.equal(backfill.runDeliveryBackfill({ mode: 'dry-run', now: NOW, writeReport: false }).counts.sitePlans.write, 1, 'a fresh run would plan the new client');
  const stores = readStores();
  const reports = backfill.listBackfillReports().length;
  const result = backfill.runDeliveryBackfillAtBoot({ now: '2026-11-22T08:00:00.000Z' });
  assert.equal(result.skipped, 'applied');
  assert.deepEqual(readStores(), stores, 'the boot after an apply writes nothing');
  assert.equal(backfill.listBackfillReports().length, reports, 'and no report');
  assert.equal(sales.getSalesClientById('lead').sitePlan, undefined, 'no plan for the newly signed client');
  assert.equal(sales.getSalesClientById('signed-offer').delivery.emails.preWorkshopSentAt || '', '', 'no stamp for the client that moved on');
  assert.equal(backfill.runDeliveryBackfillAtBoot({ now: '2026-11-22T09:00:00.000Z' }).skipped, 'applied', 'every later boot skips too');

  // A later delivery schema version runs the boot apply once more.
  const stateFile = join(DATA_DIR, 'migrations', backfill.BACKFILL_STATE_FILE);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...state, lastApply: { ...state.lastApply, codeSchemaVersion: 1 } }));
  const rerun = backfill.runDeliveryBackfillAtBoot({ now: '2026-11-22T10:00:00.000Z' });
  assert.equal(rerun.mode, 'apply');
  assert.equal(rerun.applied.sitePlans, 1);
  assert.equal(backfill.runDeliveryBackfillAtBoot({ now: '2026-11-22T11:00:00.000Z' }).skipped, 'applied');
  settings.saveAutomationSettings({ migrations: { deliveryBackfill: 'off' } }, { by: 'test' });
});

test('no email is queued or sent and no external call is made by the backfill', () => {
  const source = readFileSync(join(root, 'lib', 'delivery-backfill.js'), 'utf8');
  assert.doesNotMatch(source, /from '\.\/email|from '\.\.\/lib\/email|sendEmail|fetch\(|https?:\/\//);
  for (const name of readdirSync(DATA_DIR)) assert.doesNotMatch(name, /outbox|last-email-send/, name);
});

test('boot hook: dry-run writes one report and skips an identical one; the mode is validated', () => {
  settings.saveAutomationSettings({ migrations: { deliveryBackfill: 'dry-run' } }, { by: 'test' });
  const before = backfill.listBackfillReports().length;
  const first = backfill.runDeliveryBackfillAtBoot({ now: '2026-11-22T12:00:00.000Z' });
  const second = backfill.runDeliveryBackfillAtBoot({ now: '2026-11-22T12:05:00.000Z' });
  assert.equal(first.mode, 'dry-run');
  assert.equal(second.unchanged, true, 'identical report is not written again');
  assert.equal(backfill.listBackfillReports().length, before + 1);
  assert.equal(settings.saveAutomationSettings({ migrations: { deliveryBackfill: 'sometimes' } }).ok, false, 'validated');
  settings.saveAutomationSettings({ migrations: { deliveryBackfill: 'off' } }, { by: 'test' });
  assert.deepEqual(backfill.runDeliveryBackfillAtBoot(), { skipped: 'off' });
});
