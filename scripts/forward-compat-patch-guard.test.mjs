// WS8.44: the forward-compatible passthrough keeps keys a later batch stored, but an incoming patch
// cannot write them. Otherwise a rep could forge makerRun.goLive / previewPush through
// POST /api/admin/sales/:id/set-maker-run (salesAuth), and later batches derive the `live` stage
// from makerRun.goLive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-forward-compat-patch-'));
process.env.APP_DATA_DIR = DATA_DIR;

const storedGoLive = { target: 'production', liveVerifiedAt: '2026-11-02T09:00:00.000Z', by: 'later-batch' };
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([
  { id: 'fresh', product: 'asoldi', businessName: 'Fresh AS', status: 'active', makerRun: { runId: 'run-fresh', steps: { 1: 'ready' } } },
  {
    id: 'stored',
    product: 'asoldi',
    businessName: 'Stored AS',
    status: 'active',
    makerRun: { runId: 'run-stored', steps: { 1: 'ready', dev: 'running' }, goLive: storedGoLive },
  },
], null, 2));

// Offers: one without later-batch keys, one with the keys WS8.2 / WS8.3 / WS8.57 will store.
const storedServices = ['site', 'changes', 'blog'];
const storedOffer = {
  id: 'offer-stored',
  salesClientId: 'stored',
  status: 'draft',
  tierId: 'tier-1-standard',
  products: [{ id: 'p-site', kind: 'tier', tierId: 'tier-1-standard', name: 'Nettside', priceExMva: 1499, services: storedServices, oneTimeAddOns: ['pos'], ext: { note: 'kept' } }],
  alternatives: [
    { products: [{ id: 'alt0-p-site', kind: 'tier', tierId: 'tier-1-standard', name: 'Nettside', priceExMva: 1499, services: storedServices }], billing: 'month', plan: { tierId: 'tier-1-standard' } },
    { products: [{ id: 'alt1-p-seo', kind: 'tier', tierId: 'tier-2-seo', name: 'Nettside + SEO', priceExMva: 2499, services: ['site', 'changes', 'blog', 'seo'] }], billing: 'month', plan: { tierId: 'tier-2-seo' } },
  ],
  plan: { tierId: 'tier-1-standard', services: storedServices },
  pricing: { monthlyExMva: 1499 },
  dpaVersion: '2026-11',
};
writeFileSync(join(DATA_DIR, 'sales-offers.json'), JSON.stringify([
  { id: 'offer-fresh', salesClientId: 'fresh', status: 'draft', tierId: 'tier-1-standard', products: [{ id: 'p-1', kind: 'tier', tierId: 'tier-1-standard', name: 'Nettside', priceExMva: 1499 }] },
  storedOffer,
], null, 2));

// Hub sites: heartbeat-derived cms keys belong to WS6.7.
const storedEffective = { features: { blog: true }, at: '2026-11-03T08:00:00.000Z' };
writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify([
  { id: 'site-fresh', site_key: 'key-fresh', name: 'Fresh', domain: 'fresh.test', cms: { githubRepo: 'org/fresh' } },
  { id: 'site-stored', site_key: 'key-stored', name: 'Stored', domain: 'stored.test', cms: { githubRepo: 'org/stored', effective: storedEffective, effectiveHash: 'stored-hash' } },
], null, 2));

const {
  FUTURE_MAKERRUN_KEYS,
  FUTURE_MAKERRUN_STEP_KEYS,
  FUTURE_OFFER_ALTERNATIVE_KEYS,
  FUTURE_OFFER_KEYS,
  FUTURE_OFFER_PRODUCT_KEYS,
  FUTURE_SITE_CMS_KEYS,
} = await import('../data/normalize-ext.js');
const { mergeMakerRunPatch, withoutFutureMakerRunKeys } = await import('../lib/developer-card.js');
const sales = await import('../data/sales.js');
const salesOffers = await import('../data/sales-offers.js');
const hub = await import('../data/hub.js');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function diskOffer(id) {
  return JSON.parse(readFileSync(join(DATA_DIR, 'sales-offers.json'), 'utf8')).find((offer) => offer.id === id);
}

function diskSite(id) {
  return JSON.parse(readFileSync(join(DATA_DIR, 'sites.json'), 'utf8')).find((site) => site.id === id);
}

const forged = {
  runId: 'run-fresh',
  latestReadyStep: '2',
  goLive: { target: 'production', liveVerifiedAt: '2026-10-23T00:00:00.000Z' },
  previewPush: { pushedAt: '2026-10-23T00:00:00.000Z', url: 'https://forged.example' },
  aiSpend: { usd: 0 },
  dev: { status: 'done' },
  ext: { anything: 'x'.repeat(1000) },
  steps: { 2: 'ready', dev: 'ready', 'dev-verify': 'ready' },
};

test('withoutFutureMakerRunKeys drops every future key and future step token from a patch', () => {
  const clean = withoutFutureMakerRunKeys(forged);
  for (const key of FUTURE_MAKERRUN_KEYS) assert.equal(Object.hasOwn(clean, key), false, key);
  for (const key of FUTURE_MAKERRUN_STEP_KEYS) assert.equal(Object.hasOwn(clean.steps, key), false, `steps.${key}`);
  assert.equal(clean.latestReadyStep, '2');
  assert.equal(clean.steps[2], 'ready');
  assert.ok(forged.goLive, 'the input object is not mutated');
});

test('a set-maker-run style patch carrying goLive, previewPush or dev steps does not persist them', () => {
  const updated = sales.setSalesMakerRun('fresh', forged);
  for (const key of FUTURE_MAKERRUN_KEYS) assert.equal(Object.hasOwn(updated.makerRun, key), false, key);
  assert.equal(updated.makerRun.steps.dev, undefined);
  assert.equal(updated.makerRun.steps['dev-verify'], undefined);
  assert.equal(updated.makerRun.steps[2], 'ready', 'ordinary keys still apply');
  assert.equal(updated.makerRun.latestReadyStep, '2');
  const disk = JSON.parse(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8')).find((client) => client.id === 'fresh');
  assert.equal(disk.makerRun.goLive, undefined);
  assert.equal(disk.makerRun.previewPush, undefined);
});

test('keys a later batch stored survive the merge and a patch cannot overwrite them', () => {
  const updated = sales.setSalesMakerRun('stored', { ...forged, runId: 'run-stored' });
  assert.deepEqual(updated.makerRun.goLive, storedGoLive);
  assert.equal(updated.makerRun.steps.dev, 'running', 'the stored step token is kept, not the forged one');
  assert.equal(updated.makerRun.previewPush, undefined);
  const merged = mergeMakerRunPatch({ goLive: storedGoLive, steps: { dev: 'ready' } }, { goLive: null, steps: { dev: 'idle' } });
  assert.deepEqual(merged.goLive, storedGoLive);
  assert.equal(merged.steps.dev, 'ready');
});

test('the set-maker-run route writes through setSalesMakerRun (and so through the guard)', () => {
  const server = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = server.indexOf("app.post('/api/admin/sales/:id/set-maker-run'");
  const end = server.indexOf('\n});\n', start);
  assert.ok(start > 0 && end > start);
  const body = server.slice(start, end);
  assert.match(body, /sales\.setSalesMakerRun\(client\.id, makerPatch\)/);
  assert.doesNotMatch(body, /updateSalesClient\(/, 'no direct client write that would skip mergeMakerRunPatch');
});

// ---------------------------------------------------------------- offers (review round 2)

// What a rep's composer body looks like after offerPatchFromBody, normalized without strict mode
// (the guard in updateSalesOffer must hold even if a caller forgets strict).
const forgedProducts = [{ id: 'p-1', kind: 'tier', tierId: 'tier-1-standard', name: 'Nettside', priceExMva: 1499, services: ['ecom', 'unlimited', 'backlinks'], oneTimeAddOns: ['thirdpartyhost'], ext: { x: 1 } }];

test('offers: a rep body carrying products[].services, oneTimeAddOns or ext is not stored', () => {
  const patch = { products: salesOffers.normalizeOfferProducts(forgedProducts), plan: { tierId: 'tier-3-ecommerce' }, pricing: { monthlyExMva: 0 }, dpaVersion: 'forged', ext: { y: 2 } };
  assert.deepEqual(patch.products[0].services, ['ecom', 'unlimited', 'backlinks'], 'the non-strict normalizer still passes them through');
  const updated = salesOffers.updateSalesOffer('offer-fresh', patch, { actor: 'rep', action: '' });
  for (const key of FUTURE_OFFER_PRODUCT_KEYS) assert.equal(Object.hasOwn(updated.products[0], key), false, `products[0].${key}`);
  for (const key of FUTURE_OFFER_KEYS) assert.equal(Object.hasOwn(updated, key), false, key);
  for (const alternative of updated.alternatives) {
    for (const item of alternative.products) assert.equal(Object.hasOwn(item, 'services'), false);
  }
  const disk = diskOffer('offer-fresh');
  assert.equal(disk.products[0].services, undefined);
  assert.equal(disk.plan, undefined);
  assert.equal(disk.products[0].priceExMva, 1499, 'ordinary fields still apply');

  // The rep draft autosave (upsertClientOfferDraft) goes through the same guard.
  const draft = salesOffers.upsertClientOfferDraft('fresh', { products: forgedProducts, alternatives: [{ products: forgedProducts, plan: { tierId: 'tier-3-ecommerce' } }] }, { actor: 'rep' });
  assert.equal(draft.id, 'offer-fresh');
  assert.equal(draft.products[0].services, undefined);
  assert.equal(draft.alternatives[0].plan, undefined);
  assert.equal(draft.alternatives[0].products[0].services, undefined);
});

test('offers: stored later-batch keys survive a rep product edit and cannot be overwritten', () => {
  const edit = [
    { ...storedOffer.products[0], priceExMva: 1799, services: ['ecom', 'unlimited'], ext: { forged: true } },
    { id: 'p-new', kind: 'custom', name: 'Logo', priceExMva: 500, services: ['ecom'] },
  ];
  const updated = salesOffers.updateSalesOffer('offer-stored', { products: salesOffers.normalizeOfferProducts(edit), plan: null, dpaVersion: '' }, { actor: 'rep', action: '' });
  const [site, added] = updated.products;
  assert.equal(site.priceExMva, 1799, 'the edit applies');
  assert.deepEqual(site.services, storedServices, 'stored services kept, the forged list ignored');
  assert.deepEqual(site.oneTimeAddOns, ['pos']);
  assert.deepEqual(site.ext, { note: 'kept' });
  assert.equal(Object.hasOwn(added, 'services'), false, 'a new product gets no later-batch keys');
  assert.deepEqual(updated.plan, storedOffer.plan);
  assert.equal(updated.dpaVersion, '2026-11');
  for (const key of FUTURE_OFFER_ALTERNATIVE_KEYS.filter((entry) => Object.hasOwn(storedOffer.alternatives[1], entry))) {
    assert.deepEqual(updated.alternatives[1][key], storedOffer.alternatives[1][key], `alternatives[1].${key}`);
  }
  assert.deepEqual(diskOffer('offer-stored').products[0].services, storedServices);
});

test('offers: choosing an alternative keeps the services stored on it', () => {
  const offer = salesOffers.getSalesOfferById('offer-stored');
  const flattened = salesOffers.flattenOfferToChosen(offer, 1);
  const chosen = salesOffers.updateSalesOffer('offer-stored', flattened, { actor: 'client', action: 'chosen-offer' });
  assert.equal(chosen.chosenOfferIndex, 1);
  assert.deepEqual(chosen.products[0].services, ['site', 'changes', 'blog', 'seo']);
  assert.deepEqual(chosen.alternatives[1].plan, { tierId: 'tier-2-seo' });
});

test('offers: an admin contract summary cannot add services to its products', () => {
  const summary = salesOffers.normalizeContractSummary({ title: 'Avtale', products: [{ id: 'p-unknown', kind: 'custom', name: 'Alt', priceExMva: 1, services: ['unlimited'] }] });
  const updated = salesOffers.updateSalesOffer('offer-fresh', { contract: { summary, generatedAt: '2026-10-23T10:00:00.000Z' } }, { actor: 'admin', action: '' });
  assert.equal(updated.contract.summary.products[0].services, undefined);
});

test('offers: offerPatchFromBody normalizes body products in strict mode', () => {
  const server = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = server.indexOf('function offerPatchFromBody(');
  const body = server.slice(start, server.indexOf('\n}\n', start));
  assert.match(body, /salesOffers\.normalizeOfferProducts\(body\.products, \{ strict: true \}\)/);
  assert.doesNotMatch(body, /body\.alternatives/, 'no body alternatives reach the store');
});

// ---------------------------------------------------------------- site.cms (review round 2)

test('sites: a superadmin cms patch cannot pre-seed heartbeat-derived keys', () => {
  const forgedCms = Object.fromEntries(FUTURE_SITE_CMS_KEYS.map((key) => [key, key === 'ext' ? { forged: true } : { forged: key }]));
  const fresh = hub.updateSite('site-fresh', { cms: { ...forgedCms, githubRepo: 'org/fresh-2' } });
  assert.equal(fresh.ok, true);
  const freshCms = diskSite('site-fresh').cms;
  assert.equal(freshCms.githubRepo, 'org/fresh-2', 'ordinary cms keys still apply');
  for (const key of FUTURE_SITE_CMS_KEYS) assert.equal(Object.hasOwn(freshCms, key), false, `cms.${key}`);

  const stored = hub.updateSite('site-stored', { cms: { effective: { features: { ecommerce: true } }, effectiveHash: 'forged' } });
  assert.equal(stored.ok, true);
  const storedCms = diskSite('site-stored').cms;
  assert.deepEqual(storedCms.effective, storedEffective, 'the stored value is kept');
  assert.equal(storedCms.effectiveHash, 'stored-hash');
});
