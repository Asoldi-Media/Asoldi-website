// Test seed for the signing tests: invented businesses (example.com addresses, no phone numbers), their
// offers, portal offers and one hub site, plus a local admin. Run as its own process with
// APP_DATA_DIR set to the target folder:
//   APP_DATA_DIR=<dir> node scripts/fixtures/signing-seed.mjs <dir>
// Prints { admin, clients, contractHash } as JSON.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const dataDir = resolve(process.argv[2] || '');
if (!process.argv[2] || resolve(process.env.APP_DATA_DIR || '') !== dataDir) {
  console.error('signing-seed: pass the data folder and set APP_DATA_DIR to it');
  process.exit(2);
}
mkdirSync(dataDir, { recursive: true });

const T0 = '2026-10-20T09:00:00.000Z';
const T1 = '2026-10-21T09:00:00.000Z';
const { buildOfferFromMeetingQuote } = await import('../../lib/offer-from-quote.js');
const salesOffers = await import('../../data/sales-offers.js');
const store = await import('../../data/store.js');

const SIGNING_CLIENTS = Object.freeze({
  progress: 'sg-progress',
  gotClient: 'sg-gotclient',
  preview: 'sg-preview',
  portal: 'sg-portal',
  stripe: 'sg-stripe',
  inbox: 'sg-inbox',
  ssu: 'sg-ssu',
  dual: 'sg-dual',
  stripeNone: 'sg-stripe-none',
  nonPilot: 'sg-nonpilot',
  upgrade: 'sg-upgrade',
  inboxFresh: 'sg-inbox-fresh',
  portalFresh: 'sg-portal-fresh',
  inboxDual: 'sg-inbox-dual',
});

function client(id, name, extra = {}) {
  return {
    id,
    product: 'asoldi',
    status: 'active',
    ownerId: '',
    businessName: name,
    contactPerson: 'Kari Example',
    contactEmail: `${id}@example.com`,
    clientEmail: `${id}@example.com`,
    progression: { meetingHeld: true, offerSent: true },
    contractSentAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function sentOffer(id, salesClientId, quote, extra = {}) {
  const built = buildOfferFromMeetingQuote(quote);
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
    sentAt: T1,
    sentTo: `${salesClientId}@example.com`,
    createdAt: T0,
    updatedAt: T1,
    ...extra,
  };
}

const tier3 = { tierId: 'nettbutikk', selected: [], pages: 10 };
const tier2 = { tierId: 'seo', selected: [], pages: 7 };
const C = SIGNING_CLIENTS;

const clients = [
  client(C.progress, 'Progress Example AS'),
  client(C.gotClient, 'Gotclient Example AS'),
  client(C.preview, 'Preview Example AS'),
  client(C.portal, 'Portal Example AS'),
  client(C.stripe, 'Stripe Example AS'),
  client(C.inbox, 'Inbox Example AS'),
  client(C.ssu, 'Ssu Example AS', { product: 'ssu' }),
  client(C.dual, 'Dual Example AS'),
  client(C.stripeNone, 'Cardonly Example AS'),
  client(C.nonPilot, 'Nonpilot Example AS'),
  // No meeting or offer ticked on the card and no sent offer: the contract alone signs them.
  client(C.inboxFresh, 'Freshmail Example AS', { progression: {} }),
  client(C.portalFresh, 'Freshportal Example AS', { progression: {} }),
  client(C.inboxDual, 'Dualmail Example AS'),
  client(C.upgrade, 'Upgrade Example AS', {
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
    contractSignedAt: T0,
    portalTierId: 'tier-1-standard',
    details: { meetingQuote: { tierId: 'starter', selected: [], pages: 5 } },
    hubSite: { id: 'site-upgrade', siteKey: 'key-upgrade', domain: '', createdAt: T0 },
    sitePlan: {
      version: 1, status: 'active', tierId: 'tier-1-standard', services: ['site', 'changes', 'blog'], pages: 5, billing: 'month',
      source: 'portal-accept', offerId: 'so-upgrade-old', alternativeIndex: 0, signedAt: T0, appliedSiteId: 'site-upgrade',
      history: [{ at: T0, by: 'client', from: null, to: { tierId: 'tier-1-standard' }, reason: 'portal-accept' }],
    },
  }),
];

const upgradeOffer = sentOffer('so-upgrade-new', C.upgrade, tier2, { updatedAt: '2026-10-25T09:00:00.000Z', sentAt: '2026-10-25T09:00:00.000Z' });
// No offer-level tier and no stored plan: only the product says tier 2 (an offer built by hand).
delete upgradeOffer.tierId;
delete upgradeOffer.plan;
delete upgradeOffer.pricing;
upgradeOffer.alternatives = undefined;

const offers = [
  sentOffer('so-progress', C.progress, tier3),
  sentOffer('so-gotclient', C.gotClient, tier3),
  sentOffer('so-preview', C.preview, tier3),
  sentOffer('so-portal', C.portal, tier3),
  sentOffer('so-stripe', C.stripe, tier3),
  sentOffer('so-inbox', C.inbox, tier3),
  sentOffer('so-ssu', C.ssu, tier3),
  sentOffer('so-dual', C.dual, { tierId: 'starter', selected: [], pages: 5, altQuote: tier2 }),
  sentOffer('so-stripe-none', C.stripeNone, tier3),
  sentOffer('so-nonpilot', C.nonPilot, tier3),
  sentOffer('so-upgrade-old', C.upgrade, { tierId: 'starter', selected: [], pages: 5 }, { updatedAt: T0, sentAt: T0 }),
  upgradeOffer,
  sentOffer('so-inbox-fresh', C.inboxFresh, tier3, { status: 'draft', sentAt: '' }),
  sentOffer('so-portal-fresh', C.portalFresh, tier3, { status: 'draft', sentAt: '' }),
  sentOffer('so-inbox-dual', C.inboxDual, { tierId: 'starter', selected: [], pages: 5, altQuote: tier2 }),
];

function portalOffer(id, salesClientId, salesOfferId, extra = {}) {
  return {
    id,
    code: '',
    ownerId: '',
    salesClientId,
    salesOfferId,
    planId: 'tier-3-ecommerce',
    planName: 'Tier 3: Nettbutikk',
    price: '1 999,- /mnd',
    businessName: '',
    targetEmail: `${salesClientId}@example.com`,
    createdAt: T1,
    updatedAt: T1,
    ...extra,
  };
}

const portalOffers = [
  portalOffer('po-preview', C.preview, 'so-preview'),
  portalOffer('po-portal', C.portal, 'so-portal'),
  portalOffer('po-inbox', C.inbox, 'so-inbox', {
    acceptance: { acceptedAt: '2026-10-22T09:00:00.000Z', userId: 'u-inbox', email: `${C.inbox}@example.com`, chosenOfferIndex: null },
  }),
  portalOffer('po-inbox-fresh', C.inboxFresh, 'so-inbox-fresh', {
    acceptance: { acceptedAt: '2026-10-22T09:00:00.000Z', userId: 'u-inbox-fresh', email: `${C.inboxFresh}@example.com`, chosenOfferIndex: null },
  }),
  portalOffer('po-portal-fresh', C.portalFresh, 'so-portal-fresh'),
  portalOffer('po-inbox-dual', C.inboxDual, 'so-inbox-dual', {
    acceptance: { acceptedAt: '2026-10-22T09:00:00.000Z', userId: 'u-inbox-dual', email: `${C.inboxDual}@example.com`, chosenOfferIndex: null },
  }),
  portalOffer('po-upgrade', C.upgrade, 'so-upgrade-new', { planId: 'tier-1-standard', planName: 'Tier 1: Standard', createdAt: '2026-10-25T09:00:00.000Z', updatedAt: '2026-10-25T09:00:00.000Z' }),
];

const sites = [
  {
    id: 'site-upgrade', site_key: 'key-upgrade', name: 'Upgrade Example AS', domain: '', websitePlan: 'tier-1-standard',
    features: { users: true, blog: false }, deliveryPhase: 'development', createdAt: T0,
    planSource: { kind: 'offer', salesClientId: C.upgrade, offerId: 'so-upgrade-old', alternativeIndex: 0, tierId: 'tier-1-standard', services: ['site', 'changes', 'blog'], billing: 'month', derivedFeatures: { users: true, analytics: false, ecommerce: false, blog: true, socialSync: false, emailMarketing: false, general: false }, appliedAt: T0, appliedBy: 'contract-signing' },
  },
];

writeFileSync(join(dataDir, 'sales-clients.json'), `${JSON.stringify(clients, null, 2)}\n`);
writeFileSync(join(dataDir, 'sales-offers.json'), `${JSON.stringify(offers, null, 2)}\n`);
writeFileSync(join(dataDir, 'client-offers.json'), `${JSON.stringify(portalOffers, null, 2)}\n`);
writeFileSync(join(dataDir, 'sites.json'), `${JSON.stringify(sites, null, 2)}\n`);
// The startup signed-contract backfill has run already; the tests call its route themselves.
writeFileSync(join(dataDir, 'signed-contract-backfill.json'), `${JSON.stringify({ doneAt: T0, sold: 0, files: 0, count: 0 }, null, 2)}\n`);

const admin = { username: 'signing-admin', password: 'signing-admin-local-only-7f3a' };
await store.setAdminCredentials(admin.username, admin.password);

const stripeOffer = salesOffers.getSalesOfferById('so-stripe');
const contractHash = salesOffers.offerContentHash(stripeOffer);
process.stdout.write(`${JSON.stringify({ admin, clients: SIGNING_CLIENTS, contractHash })}\n`);
