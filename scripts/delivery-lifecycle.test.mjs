// Contract lifecycle (lib/delivery-lifecycle.js, lifecycle.cancellation): a Stripe cancellation, a failed
// payment and its grace days, a recovered payment, un-signing (lib/contract-signing.js
// markContractUnsigned), the job stop and the change-request answer, and every entry point with the
// switch off. Invented businesses on a temp data dir.
//
// node --test scripts/delivery-lifecycle.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-lifecycle-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
for (const key of Object.keys(process.env)) if (/^(SMTP|RESEND|EMAIL_REDIRECT|HUB_SAFE)/.test(key)) delete process.env[key];
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const T0 = '2026-10-20T09:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const vocab = await import('../packages/suite/core/delivery/vocab.js');
const plan = (tierId, extra = {}) => ({
  version: 1, status: 'active', tierId, services: vocab.servicesForTier(tierId), pages: 5, billing: 'month',
  source: 'portal-accept', offerId: `offer-${tierId}`, alternativeIndex: 0, signedAt: T0, history: [], ...extra,
});
function client(id, name, extra = {}) {
  return {
    id,
    product: 'asoldi',
    status: 'active',
    ownerId: '',
    businessName: name,
    contactEmail: `${id}@example.com`,
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
    contractSignedAt: T0,
    createdAt: T0,
    updatedAt: T0,
    sitePlan: plan('tier-2-seo'),
    ...extra,
  };
}

const PILOTS = ['lc-cancel', 'lc-active', 'lc-pay', 'lc-recover', 'lc-unsign', 'lc-live', 'lc-off', 'lc-resume'];
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([
  client('lc-cancel', 'Havblikk Frisør AS'),
  client('lc-active', 'Lindely Blomster AS'),
  client('lc-pay', 'Steinbru Regnskap AS'),
  client('lc-recover', 'Granlia Hytteutleie AS'),
  client('lc-unsign', 'Ospeli Keramikk AS', { ext: { dpa: { offerVersion: 'dpa-test-1' } } }),
  client('lc-live', 'Nordnes Sykkel AS', { hubSite: { liveUrl: 'https://nordnes-sykkel.example.com' } }),
  client('lc-off', 'Furuly Regnskap AS'),
  client('lc-resume', 'Tangen Tekstil AS'),
], null, 2));
writeFileSync(join(DATA_DIR, 'sites.json'), '[]');

const RELEASED = { passedAt: '2026-10-31T10:00:00.000Z', suite: 'lifecycle-test', evidence: '', by: 'test' };
function writeSettings(cancellation) {
  writeFileSync(join(DATA_DIR, 'automation-settings.json'), JSON.stringify({
    pilotClientIds: PILOTS,
    signing: { enabled: true, mode: 'auto', paused: null },
    delivery: { loop: { enabled: true, mode: 'auto', paused: null } },
    development: { seoJobs: true },
    lifecycle: { paymentGraceDays: 14, cancellationGraceDays: 30, planChange: { enabled: false, mode: 'shadow', paused: null }, cancellation },
    releases: { signing: RELEASED, 'lifecycle.cancellation': RELEASED },
  }, null, 2));
}
writeSettings({ enabled: true, mode: 'auto', paused: null });

const settingsStore = await import('../data/automation-settings.js');
const sales = await import('../data/sales.js');
const hub = await import('../data/hub.js');
const clientPortal = await import('../data/client-portal.js');
const lifecycle = await import('../lib/delivery-lifecycle.js');
const signing = await import('../lib/contract-signing.js');
const jobs = await import('../lib/delivery-jobs.js');
const apply = await import('../lib/site-plan-apply.js');
const { deriveStage } = await import('../lib/delivery-state.js');
settingsStore.invalidateAutomationSettingsCache();

// A client portal profile links the Stripe customer to the sales client (as connect-portal does).
function linkStripe(userId, salesClientId, customer) {
  clientPortal.upsertClientProfile(userId, { websiteBuilder: { salesClientId } }, { syncPortalState: false });
  clientPortal.setClientPayment(userId, { stripeCustomerId: customer, status: 'active' });
}
for (const [user, id] of [['u-lc-cancel', 'lc-cancel'], ['u-lc-active', 'lc-active'], ['u-lc-pay', 'lc-pay'], ['u-lc-recover', 'lc-recover'], ['u-lc-off', 'lc-off'], ['u-lc-resume', 'lc-resume']]) {
  linkStripe(user, id, `cus_test_${id}`);
}
for (const id of ['lc-cancel', 'lc-active', 'lc-unsign', 'lc-live', 'lc-off', 'lc-resume']) {
  assert.equal(apply.applySitePlanToHub(id, { by: 'test', now: T0 }).ok, true, id);
}
const ownSite = (id) => apply.findSiteForClient(sales.getSalesClientById(id));
const seoJob = (id) => jobs.requestJob({ kind: 'seo.maintenance', createdBy: 'test' }, { client: sales.getSalesClientById(id), sales });

test('a cancelled subscription: cancelled state, service end after the paid period plus 30 days, SEO maintenance and change requests stop, the site keeps running', async () => {
  const periodEnd = Date.parse('2026-12-01T00:00:00.000Z') / 1000;
  const result = await lifecycle.onSubscriptionEnded({ customer: 'cus_test_lc-cancel', current_period_end: periodEnd }, { now: '2026-11-10T12:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'auto');
  assert.equal(result.serviceEndsAt, '2026-12-31T00:00:00.000Z');
  const cancelled = sales.getSalesClientById('lc-cancel');
  assert.equal(cancelled.delivery.events.cancelled.source, 'stripe');
  assert.ok(cancelled.delivery.events.cancelled.at);
  assert.equal(deriveStage(cancelled, { now: '2026-11-11T00:00:00.000Z' }).overlay, 'cancelled');
  assert.equal(ownSite('lc-cancel').deliveryPhase, 'cancelled', 'the hub site is marked, not removed');
  assert.equal(lifecycle.lifecycleState(cancelled, { now: '2026-11-11T00:00:00.000Z' }).state, 'cancelled');
  assert.equal(lifecycle.lifecycleState(cancelled, { now: '2027-01-01T00:00:00.000Z' }).state, 'ended');
  // SEO maintenance is no longer queued for it; an active client still gets the job.
  const stopped = seoJob('lc-cancel');
  assert.deepEqual([stopped.ok, stopped.status, stopped.code], [false, 409, 'contract-ended']);
  const running = seoJob('lc-active');
  assert.equal(running.ok, true, JSON.stringify(running));
  assert.equal(running.job.kind, 'seo.maintenance');
  // The change-request intake answer.
  assert.deepEqual(lifecycle.changeRequestIntakeAnswer(cancelled), { open: false, code: 'contract-ended', message: 'Avtalen er avsluttet' });
  assert.equal(lifecycle.changeRequestIntakeAnswer(sales.getSalesClientById('lc-active')), null);
  // A second event keeps the first cancellation.
  const first = cancelled.delivery.events.cancelled.at;
  await lifecycle.onSubscriptionEnded({ customer: 'cus_test_lc-cancel', current_period_end: periodEnd }, { now: '2026-11-20T12:00:00.000Z' });
  assert.equal(sales.getSalesClientById('lc-cancel').delivery.events.cancelled.at, first);
  // After the service end the tick step ends the plan.
  const step = await lifecycle.runLifecycleStep({ mode: 'auto', now: '2027-01-02T00:00:00.000Z' }, sales.getSalesClientById('lc-cancel'));
  assert.equal(step.ended, true);
  assert.equal(sales.getSalesClientById('lc-cancel').sitePlan.status, 'ended');
});

test('a failed payment: payment-failed for 14 days, then paused (the tick stores it); a paid invoice before that clears it', async () => {
  const failedAt = '2026-11-01T08:00:00.000Z';
  const failed = await lifecycle.onPaymentFailed({ customer: 'cus_test_lc-pay' }, { now: failedAt });
  assert.equal(failed.ok, true);
  let payer = sales.getSalesClientById('lc-pay');
  assert.equal(payer.delivery.events.paymentFailedAt, failedAt);
  assert.ok(payer.delivery.tasks.some((task) => task.kind === 'payment_failed' && task.status === 'open'));
  assert.equal(lifecycle.lifecycleState(payer, { now: Date.parse(failedAt) + 13 * DAY }).state, 'payment-failed');
  assert.equal(lifecycle.lifecycleState(payer, { now: Date.parse(failedAt) + 14 * DAY }).state, 'paused');
  // Within the grace days the tick changes nothing.
  assert.equal((await lifecycle.runLifecycleStep({ mode: 'auto', now: Date.parse(failedAt) + 13 * DAY }, payer)).wrote, false);
  // After them it stores the pause; jobs stop.
  const step = await lifecycle.runLifecycleStep({ mode: 'auto', now: Date.parse(failedAt) + 14 * DAY }, payer);
  assert.equal(step.paused, true);
  payer = sales.getSalesClientById('lc-pay');
  assert.ok(payer.delivery.events.pausedAt);
  assert.equal(payer.delivery.events.pauseReason, 'payment-failed');
  assert.equal(deriveStage(payer).overlay, 'paused');
  assert.equal(seoJob('lc-pay').code, 'paused');
  assert.equal(lifecycle.changeRequestIntakeAnswer(payer).code, 'paused');
  // A paid invoice ends the pause.
  await lifecycle.onPaymentRecovered({ customer: 'cus_test_lc-pay' }, { now: Date.parse(failedAt) + 15 * DAY });
  payer = sales.getSalesClientById('lc-pay');
  assert.equal(payer.delivery.events.pausedAt, '');
  assert.equal(payer.delivery.events.paymentFailedAt, '');
  assert.equal(lifecycle.lifecycleState(payer).state, 'active');

  await lifecycle.onPaymentFailed({ customer: 'cus_test_lc-recover' }, { now: failedAt });
  await lifecycle.onPaymentRecovered({ customer: 'cus_test_lc-recover' }, { now: Date.parse(failedAt) + 3 * DAY });
  const recovered = sales.getSalesClientById('lc-recover');
  assert.equal(recovered.delivery.events.paymentFailedAt, '');
  assert.ok(recovered.delivery.tasks.every((task) => task.kind !== 'payment_failed' || task.status === 'done'));
  assert.equal(lifecycle.lifecycleState(recovered, { now: Date.parse(failedAt) + 20 * DAY }).state, 'active');
});

test('un-signing a never-published client archives its hub site, voids the plan with history and cancels its jobs', async () => {
  const site = ownSite('lc-unsign');
  assert.ok(site?.id);
  const queued = jobs.enqueueJob({ salesClientId: 'lc-unsign', kind: 'materials_sync', createdBy: 'test' }, { client: sales.getSalesClientById('lc-unsign'), sales });
  assert.equal(queued.ok, true);
  const result = await signing.markContractUnsigned('lc-unsign', { actor: 'superadmin', reason: 'test' });
  assert.equal(result.ok, true, JSON.stringify({ ...result, client: undefined }));
  assert.deepEqual([result.published, result.archived], [false, true]);
  const unsigned = sales.getSalesClientById('lc-unsign');
  assert.equal(unsigned.progression.contractSigned, false);
  assert.equal(unsigned.sitePlan.status, 'void');
  assert.equal(unsigned.sitePlan.history.at(-1).reason, 'unsigned');
  assert.ok(unsigned.delivery.events.unsignedAt);
  assert.ok(unsigned.ext.dpa.voidedAt);
  assert.equal(unsigned.ext.dpa.offerVersion, 'dpa-test-1');
  assert.equal(hub.getSiteById(site.id).deliveryPhase, 'archived', 'archived, still there');
  assert.equal(jobs.getJob(queued.job.id).status, 'cancelled');
  assert.deepEqual(result.cancelledJobs, [queued.job.id]);
  assert.equal(deriveStage(unsigned).stage, 'offer_sent');
  assert.equal(lifecycle.lifecycleState(unsigned).state, 'unsigned');
  // Again: nothing more to do.
  const again = await signing.markContractUnsigned('lc-unsign', { actor: 'superadmin' });
  assert.deepEqual([again.ok, again.changed], [true, false]);
});

test('un-signing a published client keeps its site untouched and raises a developer task', async () => {
  const before = ownSite('lc-live');
  const result = await signing.markContractUnsigned('lc-live', { actor: 'superadmin', reason: 'test' });
  assert.equal(result.ok, true);
  assert.deepEqual([result.published, result.archived], [true, false]);
  assert.deepEqual(hub.getSiteById(before.id), before, 'the published site is unchanged');
  const tasks = sales.getSalesClientById('lc-live').delivery.tasks.filter((task) => task.kind === 'unsigned_published' && task.status === 'open');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].siteId, before.id);
});

// Every file of the data dir with its hash (the locks the stores take are left out).
function snapshot() {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (!/\.(lock|lease|fence)$/.test(name)) out[relative(DATA_DIR, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(DATA_DIR);
  return out;
}

test('with the switch off every entry point writes nothing and stops no job', async () => {
  writeSettings({ enabled: false, mode: 'shadow', paused: null });
  settingsStore.invalidateAutomationSettingsCache();
  const before = snapshot();
  const now = '2026-11-10T12:00:00.000Z';
  assert.equal((await lifecycle.onSubscriptionEnded({ customer: 'cus_test_lc-off', current_period_end: 1796083200 }, { now })).mode, 'off');
  assert.equal((await lifecycle.onPaymentFailed({ customer: 'cus_test_lc-off' }, { now })).mode, 'off');
  assert.equal((await lifecycle.onPaymentRecovered({ customer: 'cus_test_lc-off' }, { now })).mode, 'off');
  assert.equal((await signing.markContractUnsigned('lc-off', { actor: 'superadmin' })).mode, 'off');
  assert.equal((await lifecycle.runLifecycleStep({ mode: 'auto', now }, sales.getSalesClientById('lc-off'))).wrote, false);
  assert.deepEqual(snapshot(), before, 'the data dir is byte for byte the same');
  // The cancelled client from above is no longer stopped: the switch decides.
  assert.equal(lifecycle.lifecycleJobBlock(sales.getSalesClientById('lc-cancel'), 'seo.maintenance'), '');
  assert.equal(lifecycle.changeRequestIntakeAnswer(sales.getSalesClientById('lc-cancel')), null);
  // Shadow: one audit row and nothing else.
  writeSettings({ enabled: true, mode: 'shadow', paused: null });
  settingsStore.invalidateAutomationSettingsCache();
  const shadowBefore = snapshot();
  assert.equal((await lifecycle.onSubscriptionEnded({ customer: 'cus_test_lc-off', current_period_end: 1796083200 }, { now })).mode, 'shadow');
  assert.equal((await signing.markContractUnsigned('lc-off', { actor: 'superadmin' })).mode, 'shadow');
  const changed = Object.keys(snapshot()).filter((key) => snapshot()[key] !== shadowBefore[key]);
  assert.ok(changed.every((key) => /delivery-audit/.test(key)), `only the audit changed: ${changed.join(', ')}`);
  const offClient = sales.getSalesClientById('lc-off');
  assert.equal(offClient.progression.contractSigned, true);
  assert.equal(offClient.delivery?.events?.cancelled?.at || '', '');
});

test('a site delivered before the live fields existed counts as published, so un-signing keeps it', () => {
  const bare = { id: 'lc-legacy', progression: { contractSigned: true } };
  assert.equal(signing.wasPublished(bare), false, 'control: nothing says it was published');
  assert.equal(signing.wasPublished(bare, { id: 's1', deliveryPhase: 'development' }), false);
  assert.equal(signing.wasPublished(bare, { id: 's1', deliveryPhase: 'client' }), true, 'handed over to the client');
  assert.equal(signing.wasPublished({ ...bare, development: { nettsideFerdig: true } }, { id: 's1', deliveryPhase: 'development' }), true, 'ticked as finished');
});

test('a paid invoice after the cancellation lifts it while the plan has not ended; one dated before it does not', async () => {
  writeSettings({ enabled: true, mode: 'auto', paused: null });
  settingsStore.invalidateAutomationSettingsCache();
  const periodEnd = Date.parse('2026-12-01T00:00:00.000Z') / 1000;
  await lifecycle.onSubscriptionEnded({ customer: 'cus_test_lc-resume', current_period_end: periodEnd }, { now: '2026-11-10T12:00:00.000Z' });
  const cancelled = sales.getSalesClientById('lc-resume');
  assert.ok(cancelled.delivery.events.cancelled.at, 'control: the client is cancelled');
  assert.equal(ownSite('lc-resume').deliveryPhase, 'cancelled');
  const cancelledMs = Date.parse(cancelled.delivery.events.cancelled.at);
  const before = await lifecycle.onPaymentRecovered({ customer: 'cus_test_lc-resume', status_transitions: { paid_at: Math.floor((cancelledMs - 3600_000) / 1000) } }, { now: cancelledMs + 3600_000 });
  assert.equal(before.changed, false, 'the last invoice before the cancellation changes nothing');
  assert.ok(sales.getSalesClientById('lc-resume').delivery.events.cancelled.at);
  const resumed = await lifecycle.onPaymentRecovered({ customer: 'cus_test_lc-resume', status_transitions: { paid_at: Math.floor((cancelledMs + 3600_000) / 1000) } }, { now: cancelledMs + 3600_000 });
  assert.equal(resumed.changed, true);
  assert.equal(resumed.resumed, true);
  const after = sales.getSalesClientById('lc-resume');
  assert.equal(after.delivery.events.cancelled.at, '');
  assert.equal(after.delivery.events.serviceEndsAt, '');
  assert.equal(lifecycle.lifecycleState(after).state, 'active');
  assert.notEqual(ownSite('lc-resume').deliveryPhase, 'cancelled');
});
