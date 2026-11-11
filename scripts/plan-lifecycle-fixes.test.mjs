// Plan change edge cases: a same-tier offer with other pages becomes the plan, and a conflict stays
// open when its plan change cannot run. Invented businesses on a temp data dir.
//
// node --test scripts/plan-lifecycle-fixes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-plan-fixes-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
for (const key of Object.keys(process.env)) if (/^(SMTP|RESEND|EMAIL_REDIRECT|HUB_SAFE)/.test(key)) delete process.env[key];
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const T0 = '2026-10-20T09:00:00.000Z';
const { buildOfferFromMeetingQuote } = await import('../lib/offer-from-quote.js');

function sentOffer(id, salesClientId, quote, sentAt) {
  const built = buildOfferFromMeetingQuote(quote);
  return {
    id, salesClientId, ownerId: '', status: 'sent', tierId: built.tierId, billing: built.billing, products: built.products,
    alternatives: built.alternatives, plan: built.plan, pricing: built.pricing,
    email: { subject: 'Tilbud', preheader: '', html: '<p>Tilbud</p>' }, sentAt, sentTo: `${salesClientId}@example.com`, createdAt: sentAt, updatedAt: sentAt,
  };
}
const client = (id) => ({
  id, product: 'asoldi', status: 'active', ownerId: '', businessName: `Probe ${id} AS`, contactPerson: 'Kari Example',
  contactEmail: `${id}@example.com`, progression: { meetingHeld: true, offerSent: true }, createdAt: T0, updatedAt: T0,
});
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([client('pf-same'), client('pf-off'), client('pf-conf')], null, 2));
writeFileSync(join(DATA_DIR, 'sales-offers.json'), JSON.stringify([
  sentOffer('so-same-1', 'pf-same', { tierId: 'starter', selected: [], pages: 5 }, '2026-10-21T09:00:00.000Z'),
  sentOffer('so-same-2', 'pf-same', { tierId: 'starter', selected: [], pages: 9 }, '2026-10-24T09:00:00.000Z'),
  sentOffer('so-off-1', 'pf-off', { tierId: 'starter', selected: [], pages: 5 }, '2026-10-21T09:00:00.000Z'),
  sentOffer('so-off-2', 'pf-off', { tierId: 'starter', selected: [], pages: 9 }, '2026-10-24T09:00:00.000Z'),
  sentOffer('so-conf-1', 'pf-conf', { tierId: 'seo', selected: [], pages: 7 }, '2026-10-21T09:00:00.000Z'),
], null, 2));
const RELEASED = { passedAt: '2026-10-31T10:00:00.000Z', suite: 'plan-fixes-test', evidence: '', by: 'test' };
function writeSettings(planChangeMode) {
  writeFileSync(join(DATA_DIR, 'automation-settings.json'), JSON.stringify({
    pilotClientIds: ['pf-same', 'pf-off', 'pf-conf'],
    signing: { enabled: true, mode: 'auto', paused: null },
    delivery: { loop: { enabled: true, mode: 'auto', paused: null } },
    lifecycle: {
      paymentGraceDays: 14, cancellationGraceDays: 30,
      planChange: { enabled: planChangeMode !== 'off', mode: planChangeMode === 'off' ? 'shadow' : planChangeMode, paused: null },
      cancellation: { enabled: false, mode: 'shadow', paused: null },
    },
    releases: { signing: RELEASED, 'lifecycle.planChange': RELEASED },
  }, null, 2));
}
writeSettings('auto');

const settingsStore = await import('../data/automation-settings.js');
const sales = await import('../data/sales.js');
const signing = await import('../lib/contract-signing.js');
const { acquireLease } = await import('../data/email-store.js');
const express = (await import('express')).default;
const routes = await import('../lib/routes/plan-lifecycle-routes.js');
settingsStore.invalidateAutomationSettingsCache();
const HOOKS = { freezeAgreedKeywords: async () => {}, askableLines: async () => null };

async function twoOffers(id, a, b) {
  await signing.markContractSigned(id, { source: 'portal-accept', offerId: a, actor: 'test', hooks: HOOKS });
  const second = await signing.markContractSigned(id, { source: 'portal-accept', offerId: b, actor: 'test', hooks: HOOKS });
  return { second, plan: sales.getSalesClientById(id).sitePlan };
}

test('same tier, services and billing but other pages: the newly accepted offer becomes the plan', async () => {
  const { second, plan } = await twoOffers('pf-same', 'so-same-1', 'so-same-2');
  assert.equal(second.ok, true);
  assert.equal(plan.offerId, 'so-same-2');
  assert.equal(plan.pages, 9);
  assert.equal(second.upgraded, true);
  // Accepting the same offer again changes nothing.
  const again = await signing.markContractSigned('pf-same', { source: 'portal-accept', offerId: 'so-same-2', actor: 'test', hooks: HOOKS });
  assert.equal(sales.getSalesClientById('pf-same').sitePlan.offerId, 'so-same-2');
  assert.notEqual(again.upgraded, true);
});

test('control: with the switch off the old path stores the same offer', async () => {
  writeSettings('off');
  settingsStore.invalidateAutomationSettingsCache();
  try {
    const { plan } = await twoOffers('pf-off', 'so-off-1', 'so-off-2');
    assert.equal(plan.offerId, 'so-off-2');
    assert.equal(plan.pages, 9);
  } finally {
    writeSettings('auto');
    settingsStore.invalidateAutomationSettingsCache();
  }
});

test('a conflict stays open when its plan change cannot run, and a retry then accepts it', async () => {
  await signing.markContractSigned('pf-conf', { source: 'portal-accept', offerId: 'so-conf-1', actor: 'test', hooks: HOOKS });
  const c = sales.getSalesClientById('pf-conf');
  sales.setSalesSitePlan('pf-conf', { ...c.sitePlan, conflicts: [{ source: 'stripe', tierId: 'tier-1-standard', at: T0, status: 'open' }] }, { by: 'test', reason: 'test' });
  const app = express();
  app.use(express.json());
  routes.register(app, {
    salesAuth: (req, _res, next) => { req.salesUser = { isAdmin: true, accountKey: 'admin:test' }; next(); },
    sales,
    leaseWaitMs: 150,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const accept = () => fetch(`${base}/api/admin/sales/pf-conf/site-plan/conflicts/0/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const lease = await acquireLease('sign:pf-conf', 120_000);
  try {
    const busy = await accept();
    assert.equal(busy.status, 409);
    const held = sales.getSalesClientById('pf-conf').sitePlan;
    assert.equal(held.conflicts[0].status, 'open', 'the conflict is still open');
    assert.equal(held.tierId, 'tier-2-seo');
    await lease.release();
    const retry = await accept();
    assert.equal(retry.status, 200, await retry.text());
    const done = sales.getSalesClientById('pf-conf').sitePlan;
    assert.equal(done.tierId, 'tier-1-standard');
    assert.equal(done.conflicts[0].status, 'accepted');
  } finally {
    await lease.release().catch(() => {});
    server.close();
  }
});
