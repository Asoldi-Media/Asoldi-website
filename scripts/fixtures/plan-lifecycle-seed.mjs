// Test seed for the plan change and un-signing routes: invented businesses (example.com addresses), signed
// with a plan and a hub site each, plus a local admin. Run as its own process with APP_DATA_DIR set to the
// target folder:
//   APP_DATA_DIR=<dir> node scripts/fixtures/plan-lifecycle-seed.mjs <dir> [settings-json]
// Prints { admin, clients } as JSON.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dataDir = resolve(process.argv[2] || '');
if (!process.argv[2] || resolve(process.env.APP_DATA_DIR || '') !== dataDir) {
  console.error('plan-lifecycle-seed: pass the data folder and set APP_DATA_DIR to it');
  process.exit(2);
}
mkdirSync(dataDir, { recursive: true });

const T0 = '2026-10-20T09:00:00.000Z';
const vocab = await import('../../packages/suite/core/delivery/vocab.js');
const store = await import('../../data/store.js');

const CLIENTS = Object.freeze({
  change: 'pl-change',
  conflict: 'pl-conflict',
  unsign: 'pl-unsign',
  tick: 'pl-tick',
  offTick: 'pl-off-tick',
});

const plan = (tierId, extra = {}) => ({
  version: 1, status: 'active', tierId, services: vocab.servicesForTier(tierId), pages: 5, billing: 'month',
  source: 'portal-accept', offerId: '', alternativeIndex: null, signedAt: T0,
  history: [{ at: T0, by: 'client', from: null, to: { tierId }, reason: 'portal-accept' }], ...extra,
});

function client(id, name, siteId, extra = {}) {
  return {
    id,
    product: 'asoldi',
    status: 'active',
    ownerId: '',
    businessName: name,
    contactPerson: 'Kari Example',
    contactEmail: `${id}@example.com`,
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
    contractSignedAt: T0,
    hubSite: { id: siteId, siteKey: `key-${id}`, domain: '', createdAt: T0 },
    sitePlan: plan('tier-2-seo', { appliedSiteId: siteId }),
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function site(id, clientId, name) {
  const services = vocab.servicesForTier('tier-2-seo');
  return {
    id,
    site_key: `key-${clientId}`,
    name,
    domain: '',
    websitePlan: 'tier-2-seo',
    features: vocab.featuresFromServices(services),
    deliveryPhase: 'development',
    createdAt: T0,
    planSource: { kind: 'offer', salesClientId: clientId, tierId: 'tier-2-seo', services, billing: 'month', derivedFeatures: vocab.featuresFromServices(services), appliedAt: T0, appliedBy: 'contract-signing' },
  };
}

const clients = [
  client(CLIENTS.change, 'Lundeby Gartneri AS', 'site-pl-change'),
  client(CLIENTS.conflict, 'Rosenvik Tannhelse AS', 'site-pl-conflict', {
    sitePlan: plan('tier-2-seo', { appliedSiteId: 'site-pl-conflict', conflicts: [{ source: 'stripe', tierId: 'tier-1-standard', at: T0, status: 'open' }] }),
  }),
  client(CLIENTS.unsign, 'Kvernhuset Kafe AS', 'site-pl-unsign'),
  client(CLIENTS.tick, 'Sjøkanten Rorbu AS', 'site-pl-tick'),
  client(CLIENTS.offTick, 'Bjerkely Barnehage AS', 'site-pl-off-tick'),
];
const sites = [
  site('site-pl-change', CLIENTS.change, 'Lundeby Gartneri AS'),
  site('site-pl-conflict', CLIENTS.conflict, 'Rosenvik Tannhelse AS'),
  site('site-pl-unsign', CLIENTS.unsign, 'Kvernhuset Kafe AS'),
  site('site-pl-tick', CLIENTS.tick, 'Sjøkanten Rorbu AS'),
  site('site-pl-off-tick', CLIENTS.offTick, 'Bjerkely Barnehage AS'),
];

writeFileSync(join(dataDir, 'sales-clients.json'), `${JSON.stringify(clients, null, 2)}\n`);
writeFileSync(join(dataDir, 'sites.json'), `${JSON.stringify(sites, null, 2)}\n`);
writeFileSync(join(dataDir, 'signed-contract-backfill.json'), `${JSON.stringify({ doneAt: T0, sold: 0, files: 0, count: 0 }, null, 2)}\n`);
if (process.argv[3]) writeFileSync(join(dataDir, 'automation-settings.json'), `${process.argv[3]}\n`);

const admin = { username: 'lifecycle-admin', password: 'lifecycle-admin-local-only-4b8e' };
await store.setAdminCredentials(admin.username, admin.password);
process.stdout.write(`${JSON.stringify({ admin, clients: CLIENTS })}\n`);
