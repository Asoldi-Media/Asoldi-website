// DPA and catalog versions: stamped on offers at send, snapshot at signing, signed in the portal
// (idempotent), the legal routes, and nothing at all while the legal switch is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'dpa-signing-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';

const express = (await import('express')).default;
const sales = await import('../data/sales.js');
const offers = await import('../data/sales-offers.js');
const settingsStore = await import('../data/automation-settings.js');
const { DPA_VERSION, dpaSignPatch, dpaStatus } = await import('../lib/legal/dpa.js');
const { CATALOG_VERSION } = await import('../lib/legal/catalog.js');
const { legalBindingForClient, legalSourceForOffer } = await import('../lib/legal/binding.js');
const { register } = await import('../lib/routes/legal-routes.js');
const { productsWithTier } = await import('../lib/offer-email.js');

function setSwitch(enabled) {
  const result = settingsStore.saveAutomationSettings({ legal: { catalogTexts: { enabled } } }, { by: 'test', reason: 'test' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
}

function readData(name) {
  const file = join(dataDir, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function sentOffer(clientId, { alternatives = null } = {}) {
  const draft = offers.createSalesOffer({
    salesClientId: clientId,
    ownerId: 'rep',
    tierId: 'tier-2-seo',
    products: productsWithTier([], 'tier-2-seo'),
    ...(alternatives ? { alternatives } : {}),
  });
  offers.markOfferPreviewed(draft.id, { actor: 'rep' });
  return offers.markSalesOfferSent(draft.id, { actor: 'rep', to: 'kari@example.com', delivery: 'both' });
}

function signedClient(name, offerOptions) {
  const client = sales.createSalesClient({ businessName: name, contactEmail: `${name.toLowerCase().replace(/\s+/g, '')}@example.com`, product: 'asoldi' });
  const offer = sentOffer(client.id, offerOptions);
  const signed = sales.setSalesProgress(client.id, 'contractSigned', true, { fastTrack: true });
  return { client: signed, offer };
}

let server = null;
let base = '';
const portalUsers = new Map();

test.before(async () => {
  const app = express();
  app.use(express.json());
  const deps = {
    adminAuth: (req, res, next) => (req.get('x-test-admin') === '1' ? next() : res.status(401).json({ message: 'Unauthorized' })),
    clientAuth: (req, res, next) => {
      const userId = req.get('x-test-user');
      if (!userId) return res.status(401).json({ message: 'Unauthorized' });
      req.client = { userId };
      return next();
    },
    sales,
    salesOffers: offers,
    resolvePortalClient: async (userId) => ({ user: { id: userId }, client: portalUsers.has(userId) ? sales.getSalesClientById(portalUsers.get(userId)) : null }),
  };
  await register(app, deps);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function call(path, { method = 'GET', user = '', admin = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  if (admin) headers['x-test-admin'] = '1';
  const res = await fetch(`${base}${path}`, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) });
  return { status: res.status, body: await res.json() };
}

const ROUTES = [
  ['/api/legal/texts/vilkar', {}],
  ['/api/legal/texts/salg', {}],
  ['/api/client/legal', { user: 'u-off' }],
  ['/api/client/dpa/sign', { user: 'u-off', method: 'POST' }],
  ['/api/admin/legal/terms-update', { admin: true }],
];

test('switch off: no stamps, no snapshot, no DPA data, every legal route answers 404 disabled', async () => {
  setSwitch(false);
  const { client, offer } = signedClient('Dark Bakeri');
  assert.equal(offer.status, 'sent');
  assert.equal(offer.dpaVersion, undefined);
  assert.equal(offer.ext, undefined);
  assert.equal(client.progression.contractSigned, true);
  assert.equal(client.ext, undefined);
  assert.equal(legalSourceForOffer(offer).mode, 'legacy');
  assert.equal(dpaStatus(client).status, 'disabled');
  portalUsers.set('u-off', client.id);
  const before = { sales: readData('sales.json'), offers: readData('sales-offers.json') };
  for (const [path, options] of ROUTES) {
    const res = await call(path, options);
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.body, { code: 'disabled' }, path);
  }
  assert.equal(readData('sales.json'), before.sales, 'no client data written');
  assert.equal(readData('sales-offers.json'), before.offers, 'no offer data written');
  assert.doesNotMatch(before.offers, /dpaVersion|"legal"/);
  assert.doesNotMatch(before.sales, /"legal"|"dpa"/);
  assert.deepEqual(productsWithTier([], 'tier-1-standard')[0].includes.includes('Blogg der du publiserer egne innlegg'), false, 'static offer lines while off');
});

test('switch on: an offer is stamped at send, alternatives too, and the preview approval carries over', () => {
  setSwitch(true);
  const client = sales.createSalesClient({ businessName: 'Stamp AS', contactEmail: 'stamp@example.com', product: 'asoldi' });
  const draft = offers.createSalesOffer({ salesClientId: client.id, ownerId: 'rep', tierId: 'tier-2-seo', products: productsWithTier([], 'tier-2-seo') });
  const previewed = offers.markOfferPreviewed(draft.id, { actor: 'rep' });
  const draftHash = offers.offerContentHash(previewed);
  assert.equal(offers.stampOfferLegalVersions(draft.id), null, 'a draft is never stamped');
  const sent = offers.markSalesOfferSent(draft.id, { actor: 'rep', to: 'stamp@example.com' });
  assert.equal(sent.dpaVersion, DPA_VERSION);
  assert.equal(sent.ext.legal.catalogVersion, CATALOG_VERSION);
  assert.notEqual(offers.offerContentHash(sent), draftHash, 'adding dpaVersion changes the content hash');
  assert.equal(offers.offerPreviewIsCurrent(sent), true, 'the approval of the same contract carries over');
  const again = offers.stampOfferLegalVersions(sent.id);
  assert.deepEqual(again, offers.getSalesOfferById(sent.id), 'stamping twice changes nothing');
  assert.equal(offers.markSalesOfferResent(sent.id, { actor: 'rep' }).dpaVersion, DPA_VERSION);
  assert.deepEqual(legalSourceForOffer(sent), { mode: 'catalog', catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION });

  const dual = sentOffer(client.id, {
    alternatives: [
      { tierId: 'tier-1-standard', products: productsWithTier([], 'tier-1-standard') },
      { tierId: 'tier-2-seo', products: productsWithTier([], 'tier-2-seo') },
    ],
  });
  assert.equal(dual.alternatives.length, 2);
  for (const alternative of dual.alternatives) assert.equal(alternative.dpaVersion, DPA_VERSION);
  const flattened = offers.flattenOfferToChosen(dual, 1);
  assert.equal(flattened.dpaVersion, DPA_VERSION, 'the chosen alternative carries its DPA version');
});

test('an offer sent before the switch keeps the legacy texts and never yields a DPA stamp on signing', () => {
  setSwitch(false);
  const client = sales.createSalesClient({ businessName: 'Before AS', contactEmail: 'before@example.com', product: 'asoldi' });
  const offer = sentOffer(client.id);
  setSwitch(true);
  assert.equal(offers.getSalesOfferById(offer.id).dpaVersion, undefined, 'turning the switch on stamps nothing that was sent');
  assert.equal(legalSourceForOffer(offers.getSalesOfferById(offer.id)).mode, 'legacy');
  const signed = sales.setSalesProgress(client.id, 'contractSigned', true, { fastTrack: true });
  assert.equal(signed.ext, undefined, 'no snapshot without a stamped offer');
  assert.equal(legalBindingForClient(signed).mode, 'legacy');
  assert.equal(dpaStatus(signed).status, 'missing');
  assert.equal(dpaStatus(signed).missing, true);
});

test('signing a stamped offer records the catalog and DPA versions; the DPA counts as accepted', () => {
  setSwitch(true);
  const { client, offer } = signedClient('Snapshot AS');
  assert.deepEqual(
    { catalogVersion: client.ext.legal.catalogVersion, dpaVersion: client.ext.legal.dpaVersion, offerId: client.ext.legal.offerId, source: client.ext.legal.source },
    { catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION, offerId: offer.id, source: 'signing' },
  );
  assert.equal(legalBindingForClient(client).mode, 'catalog');
  assert.equal(dpaStatus(client).status, 'accepted-with-contract');
  assert.equal(dpaStatus(client).missing, false);
  const stored = sales.getSalesClientById(client.id);
  assert.deepEqual(stored.ext.legal, client.ext.legal, 'the snapshot survives a read');
});

test('portal DPA signing is idempotent and keeps the other ext keys', () => {
  const client = { id: 'c', progression: { contractSigned: true }, product: 'asoldi', ext: { other: { keep: true }, dpa: { offerVersion: 'dpa-0' } } };
  const now = new Date('2026-11-02T10:00:00.000Z');
  const patch = dpaSignPatch(client, { now, userId: 'u1', ip: '127.0.0.1', userAgent: 'test' });
  assert.equal(patch.ext.dpa.version, DPA_VERSION);
  assert.equal(patch.ext.dpa.signedAt, now.toISOString());
  assert.equal(patch.ext.dpa.offerVersion, 'dpa-0');
  assert.deepEqual(patch.ext.other, { keep: true });
  const after = { ...client, ext: patch.ext };
  assert.equal(dpaSignPatch(after, { now: new Date('2026-11-03T10:00:00.000Z') }), null, 'a second signature changes nothing');
  assert.equal(dpaStatus(after, { enabled: true }).status, 'signed');
  assert.equal(dpaStatus({ ...client, ext: { dpa: { version: 'dpa-0', signedAt: 'x' } } }, { enabled: true }).status, 'outdated');
  assert.equal(dpaStatus({ product: 'ssu', progression: { contractSigned: true } }, { enabled: true }).status, 'not-required');
  assert.equal(dpaStatus({ progression: { contractSigned: false } }, { enabled: true }).status, 'not-required');
});

test('switch on: the legal routes serve texts, the binding and DPA signing; terms update lists older clients and sends nothing', async () => {
  setSwitch(true);
  const terms = await call('/api/legal/texts/vilkar');
  assert.equal(terms.status, 200);
  assert.equal(terms.body.catalogVersion, CATALOG_VERSION);
  assert.ok(terms.body.sections.length > 10);
  assert.deepEqual((await call('/api/legal/texts/vilkar?version=legacy')).body, { doc: 'vilkar', legacy: true, path: '/vilkar' });
  assert.equal((await call(`/api/legal/texts/vilkar?version=${CATALOG_VERSION}`)).status, 200);
  assert.equal((await call('/api/legal/texts/vilkar?version=999')).status, 404);
  assert.equal((await call('/api/legal/texts/ukjent')).status, 404);
  const salesCopy = await call('/api/legal/texts/salg');
  assert.ok(salesCopy.body.tiers['tier-1-standard'].included.includes('Blogg der du publiserer egne innlegg'));
  const contract = await call('/api/legal/texts/kontrakt?tier=tier-1-standard');
  assert.ok(contract.body.blocks.some((block) => block.clauseId === 'service.blog'));
  assert.equal((await call('/api/legal/texts/kontrakt')).status, 400);

  const legacy = sales.createSalesClient({ businessName: 'Legacy AS', contactEmail: 'legacy@example.com', product: 'asoldi' });
  setSwitch(false);
  sentOffer(legacy.id);
  setSwitch(true);
  sales.setSalesProgress(legacy.id, 'contractSigned', true, { fastTrack: true });
  portalUsers.set('u-legacy', legacy.id);
  const { client: bound } = signedClient('Bound AS');
  portalUsers.set('u-bound', bound.id);

  const legacyView = await call('/api/client/legal', { user: 'u-legacy' });
  assert.equal(legacyView.status, 200);
  assert.equal(legacyView.body.binding.mode, 'legacy');
  assert.equal(legacyView.body.dpa.status, 'missing');
  const boundView = await call('/api/client/legal', { user: 'u-bound' });
  assert.deepEqual([boundView.body.binding.mode, boundView.body.binding.catalogVersion], ['catalog', CATALOG_VERSION]);
  assert.match(boundView.body.links.vilkar, new RegExp(`versjon=${CATALOG_VERSION}$`));

  const first = await call('/api/client/dpa/sign', { user: 'u-legacy', method: 'POST' });
  assert.equal(first.status, 200);
  assert.equal(first.body.changed, true);
  assert.equal(first.body.dpa.status, 'signed');
  const signedAt = sales.getSalesClientById(legacy.id).ext.dpa.signedAt;
  const second = await call('/api/client/dpa/sign', { user: 'u-legacy', method: 'POST' });
  assert.equal(second.body.changed, false);
  assert.equal(sales.getSalesClientById(legacy.id).ext.dpa.signedAt, signedAt, 'signing again keeps the first signature');
  assert.equal((await call('/api/client/dpa/sign', { user: 'u-nobody', method: 'POST' })).status, 404);
  assert.equal((await call('/api/client/dpa/sign', { method: 'POST' })).status, 401);

  const update = await call('/api/admin/legal/terms-update', { admin: true });
  assert.equal(update.status, 200);
  assert.equal(update.body.sends, false);
  const ids = update.body.clients.map((row) => row.clientId);
  assert.ok(ids.includes(legacy.id), 'a client on the legacy texts is listed');
  assert.equal(ids.includes(bound.id), false, 'a client on the current version is not');
  const row = update.body.clients.find((entry) => entry.clientId === legacy.id);
  assert.equal(row.bound, 'legacy');
  assert.match(row.notice.subject, /Oppdaterte vilkår fra Asoldi/);
  assert.match(row.notice.text, /gjelder for deg fra \d{4}-\d{2}-\d{2}/);
  assert.equal((await call('/api/admin/legal/terms-update')).status, 401);
  assert.deepEqual(readdirSync(dataDir).filter((name) => /outbox|email-log/i.test(name)), [], 'nothing was queued or sent');
});
