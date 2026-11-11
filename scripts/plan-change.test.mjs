// Plan changes after signing (lib/contract-signing.js markPlanChanged, lifecycle.planChange): an
// accepted upgrade offer, a superadmin's downgrade and override, and the switch off and in shadow.
// Invented businesses on a temp data dir; no mail leaves (no mail transport is configured).
//
// node --test scripts/plan-change.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-plan-change-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
for (const key of Object.keys(process.env)) if (/^(SMTP|RESEND|EMAIL_REDIRECT|HUB_SAFE)/.test(key)) delete process.env[key];
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const T0 = '2026-10-20T09:00:00.000Z';
const { buildOfferFromMeetingQuote } = await import('../lib/offer-from-quote.js');

const QUOTES = {
  1: { tierId: 'starter', selected: [], pages: 5 },
  2: { tierId: 'seo', selected: [], pages: 7 },
  3: { tierId: 'nettbutikk', selected: [], pages: 10 },
};

function stampedOffer(id, salesClientId, tier, sentAt, catalogVersion, dpaVersion) {
  return {
    ...sentOffer(id, salesClientId, tier, sentAt),
    dpaVersion,
    ext: { legal: { catalogVersion, stampedAt: sentAt } },
  };
}

function sentOffer(id, salesClientId, tier, sentAt) {
  const built = buildOfferFromMeetingQuote(QUOTES[tier]);
  return {
    id,
    salesClientId,
    ownerId: '',
    status: 'sent',
    tierId: built.tierId,
    billing: built.billing,
    products: built.products,
    alternatives: built.alternatives,
    plan: built.plan,
    pricing: built.pricing,
    email: { subject: 'Tilbud på nettside', preheader: '', html: '<p>Tilbud</p>' },
    sentAt,
    sentTo: `${salesClientId}@example.com`,
    createdAt: sentAt,
    updatedAt: sentAt,
  };
}

function client(id, name) {
  return {
    id,
    product: 'asoldi',
    status: 'active',
    ownerId: '',
    businessName: name,
    contactPerson: 'Kari Example',
    contactEmail: `${id}@example.com`,
    progression: { meetingHeld: true, offerSent: true },
    createdAt: T0,
    updatedAt: T0,
  };
}

const PILOTS = ['pc-up', 'pc-down', 'pc-over', 'pc-off', 'pc-shadow', 'pc-legal', 'pc-legacy'];
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([
  client('pc-up', 'Fjellstue Kafe AS'),
  client('pc-down', 'Brygga Butikk AS'),
  client('pc-over', 'Solsiden Snekker AS'),
  client('pc-off', 'Vindheim Maler AS'),
  client('pc-shadow', 'Bekkely Bakeri AS'),
  client('pc-legal', 'Havn Kiosk AS'),
  client('pc-legacy', 'Kaiskur Fisk AS'),
], null, 2));
writeFileSync(join(DATA_DIR, 'sales-offers.json'), JSON.stringify([
  sentOffer('so-pc-up-1', 'pc-up', 1, '2026-10-21T09:00:00.000Z'),
  sentOffer('so-pc-up-2', 'pc-up', 2, '2026-10-24T09:00:00.000Z'),
  sentOffer('so-pc-down-3', 'pc-down', 3, '2026-10-21T09:00:00.000Z'),
  sentOffer('so-pc-over-1', 'pc-over', 1, '2026-10-21T09:00:00.000Z'),
  sentOffer('so-pc-over-old', 'pc-over', 2, '2026-10-22T09:00:00.000Z'),
  sentOffer('so-pc-over-new', 'pc-over', 2, '2026-10-28T09:00:00.000Z'),
  sentOffer('so-pc-off-1', 'pc-off', 1, '2026-10-21T09:00:00.000Z'),
  sentOffer('so-pc-off-2', 'pc-off', 2, '2026-10-24T09:00:00.000Z'),
  sentOffer('so-pc-shadow-1', 'pc-shadow', 1, '2026-10-21T09:00:00.000Z'),
  sentOffer('so-pc-shadow-2', 'pc-shadow', 2, '2026-10-24T09:00:00.000Z'),
  stampedOffer('so-pc-legal-1', 'pc-legal', 1, '2026-10-21T09:00:00.000Z', 1, 'dpa-1'),
  stampedOffer('so-pc-legacy-1', 'pc-legacy', 1, '2026-10-21T09:00:00.000Z', 1, 'dpa-1'),
], null, 2));

const RELEASED = { passedAt: '2026-10-31T10:00:00.000Z', suite: 'plan-change-test', evidence: '', by: 'test' };
function writeSettings(planChange) {
  writeFileSync(join(DATA_DIR, 'automation-settings.json'), JSON.stringify({
    pilotClientIds: PILOTS,
    signing: { enabled: true, mode: 'auto', paused: null },
    delivery: { loop: { enabled: true, mode: 'auto', paused: null } },
    gate: { enabled: true, mode: 'shadow', paused: null },
    lifecycle: { paymentGraceDays: 14, cancellationGraceDays: 30, planChange, cancellation: { enabled: false, mode: 'shadow', paused: null } },
    releases: { signing: RELEASED, 'lifecycle.planChange': RELEASED },
  }, null, 2));
}
writeSettings({ enabled: true, mode: 'auto', paused: null });

const settingsStore = await import('../data/automation-settings.js');
const sales = await import('../data/sales.js');
const salesOffers = await import('../data/sales-offers.js');
const hub = await import('../data/hub.js');
const signing = await import('../lib/contract-signing.js');
const gate = await import('../lib/delivery-gate.js');
const jobs = await import('../lib/delivery-jobs.js');
const { resolveSitePlan } = await import('../lib/site-plan.js');
const { readDeliveryAudit } = await import('../lib/delivery-audit.js');
const vocab = await import('../packages/suite/core/delivery/vocab.js');
settingsStore.invalidateAutomationSettingsCache();

const HOOKS = { freezeAgreedKeywords: async () => {}, askableLines: async () => null };
const audit = (kind, clientId) => readDeliveryAudit({ dataDir: DATA_DIR }).filter((row) => row.kind === kind && row.clientId === clientId);
const gateLineIds = (id) => gate.evaluateDeliveryGate(sales.getSalesClientById(id), {}).lines.map((line) => line.id);
const ownSite = (id) => hub.getSiteById(sales.getSalesClientById(id).hubSite.id);

async function signOn(id, offerId) {
  const result = await signing.markContractSigned(id, { source: 'portal-accept', offerId, actor: 'test', hooks: HOOKS });
  assert.equal(result.ok, true, JSON.stringify({ ...result, client: undefined }));
  return result;
}

test('upgrade: tier 1 signed, then a tier 2 offer accepted, changes the plan, the site, the gate and asks for one materials job', async () => {
  await signOn('pc-up', 'so-pc-up-1');
  let client = sales.getSalesClientById('pc-up');
  assert.equal(client.sitePlan.tierId, 'tier-1-standard');
  assert.equal(client.sitePlan.history.length, 1);
  assert.ok(!gateLineIds('pc-up').includes('keywords'), 'tier 1 asks for no keywords');
  const hashes = ['so-pc-up-1', 'so-pc-up-2'].map((id) => salesOffers.offerContentHash(salesOffers.getSalesOfferById(id)));
  // A person turned one flag on by hand: the plan change keeps it.
  const site = ownSite('pc-up');
  assert.equal(site.features.ecommerce, false);
  hub.updateSite(site.id, { features: { ...site.features, ecommerce: true } });

  const upgraded = await signOn('pc-up', 'so-pc-up-2');
  assert.equal(upgraded.upgraded, true);
  client = sales.getSalesClientById('pc-up');
  assert.equal(client.sitePlan.tierId, 'tier-2-seo');
  assert.equal(client.sitePlan.source, 'offer-upgrade');
  assert.equal(client.sitePlan.offerId, 'so-pc-up-2');
  assert.equal(client.sitePlan.history.length, 2);
  assert.deepEqual(client.sitePlan.history.map((row) => row.to.tierId), ['tier-1-standard', 'tier-2-seo']);
  assert.match(client.sitePlan.history[1].reason, /^plan-change:offer-upgrade/);
  assert.ok(client.delivery.events.planChangedAt, 'planChangedAt marks the gate dirty');
  assert.ok(client.delivery.dirtyAt);
  // The gate: the stored gate (re-evaluated at once) and a fresh evaluation ask for keywords now.
  assert.ok(gateLineIds('pc-up').includes('keywords'));
  assert.ok(client.delivery.gate.lines.some((line) => line.id === 'keywords'), 'the stored gate was re-evaluated');
  // The hub site: the new tier and its flags, with the hand-set flag kept.
  const after = ownSite('pc-up');
  assert.equal(after.websitePlan, 'tier-2-seo');
  const expected = { ...vocab.featuresFromServices(vocab.servicesForTier('tier-2-seo')), ecommerce: true };
  for (const [flag, value] of Object.entries(expected)) assert.equal(Boolean(after.features[flag]), value, flag);
  // One materials_sync job (the client is a pilot and the loop runs in auto); no rerun line needed.
  const queued = jobs.listJobs({ clientId: 'pc-up', fresh: true });
  assert.deepEqual(queued.map((job) => job.kind), ['materials_sync']);
  assert.deepEqual(queued[0].input.added, vocab.expandServices(vocab.servicesForTier('tier-2-seo')).filter((id) => !vocab.expandServices(vocab.servicesForTier('tier-1-standard')).includes(id)));
  assert.ok(queued[0].input.added.includes('seo'));
  assert.ok(!(client.delivery.info || []).some((row) => row.id === 'plan-changed-rerun'));
  // Signed offers keep their hashes.
  assert.deepEqual(['so-pc-up-1', 'so-pc-up-2'].map((id) => salesOffers.offerContentHash(salesOffers.getSalesOfferById(id))), hashes);
  assert.equal(audit('plan-change', 'pc-up').length, 1);
  // The same offer again changes nothing more.
  await signOn('pc-up', 'so-pc-up-2');
  assert.equal(sales.getSalesClientById('pc-up').sitePlan.history.length, 2);
  assert.equal(jobs.listJobs({ clientId: 'pc-up', fresh: true }).length, 1);
});

test('an accepted upgrade rebinds the client to the new offer\'s catalog version and keeps the notice', async () => {
  await signOn('pc-legal', 'so-pc-legal-1');
  let client = sales.getSalesClientById('pc-legal');
  assert.equal(client.ext.legal.catalogVersion, 1);
  assert.equal(client.ext.legal.offerId, 'so-pc-legal-1');
  assert.equal(client.ext.legal.dpaVersion, 'dpa-1');
  const notice = {
    catalogVersion: 1,
    dpaVersion: 'dpa-1',
    sentAt: '2026-10-22T09:00:00.000Z',
    effectiveFrom: '2026-12-01',
  };
  sales.updateSalesClient('pc-legal', {
    ext: { ...client.ext, other: { keep: 1 }, legal: { ...client.ext.legal, notice } },
  });
  const file = join(DATA_DIR, 'sales-offers.json');
  const offers = JSON.parse(readFileSync(file, 'utf8'));
  offers.push(stampedOffer('so-pc-legal-2', 'pc-legal', 2, '2026-11-02T09:00:00.000Z', 2, 'dpa-2'));
  writeFileSync(file, JSON.stringify(offers, null, 2));
  const upgraded = await signOn('pc-legal', 'so-pc-legal-2');
  assert.equal(upgraded.upgraded, true);
  client = sales.getSalesClientById('pc-legal');
  assert.equal(client.ext.legal.catalogVersion, 2);
  assert.equal(client.ext.legal.offerId, 'so-pc-legal-2');
  assert.equal(client.ext.legal.dpaVersion, 'dpa-2');
  assert.deepEqual(client.ext.legal.notice, notice);
  assert.deepEqual(client.ext.other, { keep: 1 });
});

test('downgrade: tier 3 to tier 2 by a superadmin removes the shop lines and opens a developer task', async () => {
  await signOn('pc-down', 'so-pc-down-3');
  const before = gateLineIds('pc-down');
  for (const id of ['products', 'payment', 'shipping']) assert.ok(before.includes(id), id);
  const result = await signing.markPlanChanged('pc-down', { source: 'superadmin', tierId: 'tier-2-seo', actor: 'superadmin', reason: 'test', hooks: HOOKS });
  assert.equal(result.ok, true, JSON.stringify({ ...result, client: undefined }));
  assert.equal(result.changed, true);
  assert.ok(result.removed.includes('ecom'));
  const client = sales.getSalesClientById('pc-down');
  assert.equal(client.sitePlan.tierId, 'tier-2-seo');
  assert.equal(client.sitePlan.source, 'superadmin');
  const after = gateLineIds('pc-down');
  for (const id of ['products', 'payment', 'shipping', 'returns', 'seller']) assert.ok(!after.includes(id), `${id} is gone`);
  const tasks = client.delivery.tasks.filter((task) => task.kind === 'plan_downgrade' && task.status === 'open');
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0].removed.includes('ecom'));
  assert.equal(ownSite('pc-down').websitePlan, 'tier-2-seo');
  // Nothing was added, so no materials job.
  assert.equal(jobs.listJobs({ clientId: 'pc-down', fresh: true }).filter((job) => job.kind === 'materials_sync').length, 0);
});

test('a superadmin override beats an older offer, survives a re-resolve, and a newer offer replaces it', async () => {
  await signOn('pc-over', 'so-pc-over-1');
  const override = await signing.markPlanChanged('pc-over', { source: 'superadmin', tierId: 'tier-3-ecommerce', actor: 'superadmin', now: '2026-10-25T09:00:00.000Z', hooks: HOOKS });
  assert.equal(override.changed, true);
  // An offer sent before the override is accepted later: the override stays.
  const older = await signOn('pc-over', 'so-pc-over-old');
  assert.notEqual(older.upgraded, true);
  let client = sales.getSalesClientById('pc-over');
  assert.equal(client.sitePlan.tierId, 'tier-3-ecommerce');
  assert.equal(resolveSitePlan(client).plan.tierId, 'tier-3-ecommerce', 'a re-resolve keeps the stored override');
  assert.equal(audit('plan-change', 'pc-over').filter((row) => row.kept === 'superadmin-override').length, 1);
  // An offer sent after the override wins.
  const newer = await signOn('pc-over', 'so-pc-over-new');
  assert.equal(newer.upgraded, true);
  client = sales.getSalesClientById('pc-over');
  assert.equal(client.sitePlan.tierId, 'tier-2-seo');
  assert.equal(client.sitePlan.offerId, 'so-pc-over-new');
});

test('off: an accepted upgrade runs today\'s path (plan and site), with no plan-change marks, jobs or tasks', async () => {
  writeSettings({ enabled: false, mode: 'shadow', paused: null });
  settingsStore.invalidateAutomationSettingsCache();
  await signOn('pc-off', 'so-pc-off-1');
  const result = await signOn('pc-off', 'so-pc-off-2');
  assert.equal(result.upgraded, true, 'today\'s upgrade path still replaces the plan');
  const client = sales.getSalesClientById('pc-off');
  assert.equal(client.sitePlan.tierId, 'tier-2-seo');
  assert.equal(client.sitePlan.source, 'offer-upgrade');
  assert.equal(client.delivery?.events?.planChangedAt || '', '');
  assert.equal(client.delivery?.dirtyAt || '', '');
  assert.equal(jobs.listJobs({ clientId: 'pc-off', fresh: true }).length, 0);
  assert.equal((client.delivery?.tasks || []).length, 0);
  assert.equal(audit('plan-change', 'pc-off').length + audit('plan-change-shadow', 'pc-off').length, 0);
  const direct = await signing.markPlanChanged('pc-off', { source: 'superadmin', tierId: 'tier-3-ecommerce' });
  assert.deepEqual([direct.ok, direct.mode], [false, 'off']);
  assert.equal(sales.getSalesClientById('pc-off').sitePlan.tierId, 'tier-2-seo');
});

test('shadow: today\'s path plus one shadow record of what the plan change would do', async () => {
  writeSettings({ enabled: true, mode: 'shadow', paused: null });
  settingsStore.invalidateAutomationSettingsCache();
  await signOn('pc-shadow', 'so-pc-shadow-1');
  await signOn('pc-shadow', 'so-pc-shadow-2');
  const client = sales.getSalesClientById('pc-shadow');
  assert.equal(client.sitePlan.tierId, 'tier-2-seo');
  assert.equal(client.delivery?.events?.planChangedAt || '', '');
  assert.equal(jobs.listJobs({ clientId: 'pc-shadow', fresh: true }).length, 0);
  const rows = audit('plan-change-shadow', 'pc-shadow');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].from, rows[0].to], ['tier-1-standard', 'tier-2-seo']);
  assert.ok(rows[0].added.includes('seo'));
  const direct = await signing.markPlanChanged('pc-shadow', { source: 'superadmin', tierId: 'tier-3-ecommerce', actor: 'superadmin' });
  assert.deepEqual([direct.ok, direct.mode], [true, 'shadow']);
  assert.equal(sales.getSalesClientById('pc-shadow').sitePlan.tierId, 'tier-2-seo', 'shadow changes no plan');
  assert.ok(existsSync(join(DATA_DIR, 'sales-clients.json')));
  assert.ok(JSON.parse(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8')).length >= 5);
});

test('off: an accepted upgrade through the existing path also rebinds the client to the new offer catalog version', async () => {
  writeSettings({ enabled: false, mode: 'shadow', paused: null });
  settingsStore.invalidateAutomationSettingsCache();
  await signOn('pc-legacy', 'so-pc-legacy-1');
  let client = sales.getSalesClientById('pc-legacy');
  assert.equal(client.ext.legal.catalogVersion, 1);
  const file = join(DATA_DIR, 'sales-offers.json');
  const offers = JSON.parse(readFileSync(file, 'utf8'));
  offers.push(stampedOffer('so-pc-legacy-2', 'pc-legacy', 2, '2026-11-02T09:00:00.000Z', 2, 'dpa-2'));
  writeFileSync(file, JSON.stringify(offers, null, 2));
  const upgraded = await signOn('pc-legacy', 'so-pc-legacy-2');
  assert.equal(upgraded.upgraded, true);
  client = sales.getSalesClientById('pc-legacy');
  assert.equal(client.sitePlan.tierId, 'tier-2-seo');
  assert.equal(client.ext.legal.catalogVersion, 2);
  assert.equal(client.ext.legal.offerId, 'so-pc-legacy-2');
  assert.equal(client.ext.legal.dpaVersion, 'dpa-2');
});
