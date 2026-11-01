// DPA and catalog versions: stamped on offers at send, snapshot at signing, signed in the portal
// (idempotent), the legal routes, and nothing at all while the legal switch is off.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const { DPA_VERSION, dpaMissingAtSigning, dpaSignPatch, dpaStatus } = await import('../lib/legal/dpa.js');
const { CATALOG_VERSION } = await import('../lib/legal/catalog.js');
const { legalBindingForClient, legalSnapshotPatch, legalSourceForOffer, setAgreedKeywordsResolver } = await import('../lib/legal/binding.js');
const { draftTermsUpdateNotice, termsNoticePatch } = await import('../lib/legal/terms-update.js');
const { register, sessionCanSignForBusiness } = await import('../lib/routes/legal-routes.js');
const { productsWithTier } = await import('../lib/offer-email.js');
const { contractHtmlForOffer } = await import('../lib/offer-contract-html.js');
const { buildContractPdf, contractInputsForOffer } = await import('../lib/offer-contract-pdf.js');
const { clientWithOfferParty } = await import('../lib/offer-readiness.js');
const { storePreviewAcceptedContract } = await import('../lib/sales-signed-contract.js');
const darkSurface = await import('./legal/dark-surface.mjs');
const baseline = JSON.parse(readFileSync(darkSurface.BASELINE_PATH, 'utf8'));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

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
// Portal users who are members of the business without the right to sign for it.
const collaborators = new Set();

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
    resolvePortalClient: async (userId) => ({
      user: { id: userId },
      client: portalUsers.has(userId) ? sales.getSalesClientById(portalUsers.get(userId)) : null,
      canSign: !collaborators.has(userId),
    }),
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
  ['/api/legal/texts/vilkar?version=1', {}],
  ['/api/legal/texts/databehandleravtale?version=1', {}],
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
  const before = { sales: readData('sales-clients.json'), offers: readData('sales-offers.json') };
  assert.match(before.sales, /Dark Bakeri/, 'the client file is the one checked');
  assert.match(before.offers, /"status": *"sent"/, 'the offer file is the one checked');
  for (const [path, options] of ROUTES) {
    const res = await call(path, options);
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.body, { code: 'disabled' }, path);
  }
  assert.equal(readData('sales-clients.json'), before.sales, 'no client data written');
  assert.equal(readData('sales-offers.json'), before.offers, 'no offer data written');
  assert.doesNotMatch(before.offers, /dpaVersion|"legal"/);
  assert.doesNotMatch(before.sales, /"legal"|"dpa"/);
  assert.deepEqual(productsWithTier([], 'tier-1-standard')[0].includes.includes('Blogg der du publiserer egne innlegg'), false, 'static offer lines while off');
  // Unsent offers: the preview, the PDF attached at send and the contract signed are the static text.
  const draft = offers.createSalesOffer({ salesClientId: client.id, ownerId: 'rep', tierId: 'tier-2-seo', products: productsWithTier([], 'tier-2-seo') });
  assert.equal(draft.status, 'draft');
  assert.equal(legalSourceForOffer(draft).mode, 'legacy');
  assert.equal(legalSourceForOffer(offers.markOfferPreviewed(draft.id, { actor: 'rep' })).mode, 'legacy');
  // The baseline was recorded with the clock at the fixtures' date (the contract prints today's date).
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-05-04T09:00:00.000Z') });
  try {
    for (const key of ['tier2Draft', 'tier2ReviewRequested', 'tier2Verified', 'tier2EnDraft', 'customVerified', 'dualDraft']) {
      const fixture = darkSurface.FIXTURE_OFFERS[key];
      assert.notEqual(fixture.status, 'sent', key);
      assert.equal(legalSourceForOffer(fixture).mode, 'legacy', key);
      assert.equal(sha256(contractHtmlForOffer(fixture, darkSurface.FIXTURE_CLIENT)), baseline.contracts[key].htmlSha256, key);
    }
  } finally {
    mock.timers.reset();
  }
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
  assert.deepEqual(legalSourceForOffer(sent), { mode: 'catalog', catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION, tiers: sent.ext.legal.tiers });

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
  // The legacy contract incorporates the DPA as published on the signing date: in force, not missing.
  assert.equal(dpaStatus(signed).status, 'accepted-legacy');
  assert.equal(dpaStatus(signed).missing, false);
  assert.equal(dpaStatus(signed).upToDate, false, 'the portal offers the current version');
  // The delivery gate's rule at signing: the offer did not carry the DPA, so it gets its developer-only line.
  assert.equal(dpaMissingAtSigning(offers.getSalesOfferById(offer.id)), true);
});

test('a client signed before the switch is not told the DPA is missing once the switch is on', () => {
  setSwitch(false);
  const { client } = signedClient('Fleet AS');
  setSwitch(true);
  const status = dpaStatus(sales.getSalesClientById(client.id));
  assert.deepEqual([status.status, status.missing, status.required, status.upToDate], ['accepted-legacy', false, true, false]);
  const older = dpaStatus({ ...client, ext: { dpa: { version: 'dpa-0', signedAt: '2026-01-01T00:00:00.000Z' } } });
  assert.deepEqual([older.status, older.missing, older.upToDate], ['outdated', false, false], 'an older signed version stays in force');
  const bound = dpaStatus({ ...client, ext: { legal: { catalogVersion: CATALOG_VERSION } } });
  assert.deepEqual([bound.status, bound.missing], ['missing', true], 'only a catalog-bound client with no DPA version recorded is missing one');
});

test('the got-client route path (a plain progression patch) records the snapshot too', () => {
  setSwitch(true);
  const client = sales.createSalesClient({ businessName: 'Route AS', contactEmail: 'route@example.com', product: 'asoldi' });
  const offer = sentOffer(client.id);
  assert.equal(offer.ext.legal.catalogVersion, CATALOG_VERSION);
  // POST /api/admin/sales/:id/got-client writes progression.contractSigned directly.
  const signed = sales.updateSalesClient(client.id, { progression: { contractSigned: true }, hubSite: { siteKey: 'route-site' } });
  assert.equal(signed.ext.legal.catalogVersion, CATALOG_VERSION);
  assert.equal(signed.ext.legal.offerId, offer.id);
  assert.equal(legalBindingForClient(signed).mode, 'catalog');
  assert.equal(dpaStatus(signed).status, 'accepted-with-contract');
  assert.equal(dpaStatus(signed).missing, false);
  const again = sales.updateSalesClient(client.id, { progression: { contractSigned: true } });
  assert.equal(again.ext.legal.boundAt, signed.ext.legal.boundAt, 'a signed client is not snapshotted again');
  const batch = sales.createSalesClient({ businessName: 'Batch AS', contactEmail: 'batch@example.com', product: 'asoldi' });
  sentOffer(batch.id);
  sales.patchSalesClientsById([{ id: batch.id, patch: { progression: { ...batch.progression, contractSigned: true } } }]);
  assert.equal(sales.getSalesClientById(batch.id).ext.legal.catalogVersion, CATALOG_VERSION, 'the batch writer records it as well');
});

test('a stamped offer signed while the switch is off binds and shows the version it was sent with (kill switch)', async () => {
  setSwitch(true);
  const client = sales.createSalesClient({ businessName: 'Kill AS', contactEmail: 'kill@example.com', product: 'asoldi' });
  const offer = sentOffer(client.id);
  const sentHtml = contractHtmlForOffer(offer, client);
  setSwitch(false);
  const signed = sales.setSalesProgress(client.id, 'contractSigned', true, { fastTrack: true });
  assert.equal(signed.ext.legal.catalogVersion, CATALOG_VERSION, 'the stamp decides the binding, not the switch');
  const stored = offers.getSalesOfferById(offer.id);
  assert.deepEqual(legalSourceForOffer(stored), { mode: 'catalog', catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION, tiers: stored.ext.legal.tiers }, 'and the contract');
  assert.equal(legalBindingForClient(signed).mode, 'catalog', 'binding and contract agree while off');
  assert.equal(contractHtmlForOffer(stored, signed), sentHtml, 'the portal shows the contract that was sent');
  // Kill switch for new contracts: an unsent offer shows the static text while off.
  const draft = offers.createSalesOffer({ salesClientId: 'other-client', ownerId: 'rep', tierId: 'tier-2-seo', products: productsWithTier([], 'tier-2-seo') });
  assert.equal(legalSourceForOffer(draft).mode, 'legacy');

  // The PDF stored when the client accepts on the preview is the stamped contract.
  const signedAt = signed.contractSignedAt || signed.contractSentAt || stored.sentAt;
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T10:00:00.000Z') });
  try {
    const item = await storePreviewAcceptedContract(signed, { email: 'kill@example.com', acceptedAt: '2026-11-02T10:00:00.000Z' });
    assert.ok(item?.filePath && existsSync(item.filePath), 'the signed contract PDF is stored');
    const inputs = contractInputsForOffer(stored, signed);
    assert.equal(inputs.legal.mode, 'catalog');
    const view = clientWithOfferParty(signed, stored, {});
    const date = new Date(signedAt);
    const expected = await buildContractPdf({ client: view, ...inputs, date });
    const legacy = await buildContractPdf({ client: view, ...inputs, legal: { mode: 'legacy' }, date });
    const saved = readFileSync(item.filePath);
    assert.equal(sha256(saved), sha256(expected), 'the stored PDF is the stamped version');
    assert.notEqual(sha256(saved), sha256(legacy), 'not the static text');
  } finally {
    mock.timers.reset();
  }

  // The versioned links in that contract keep answering while the switch is off.
  const linked = await call(`/api/legal/texts/vilkar?version=${CATALOG_VERSION}`);
  assert.equal(linked.status, 200);
  assert.equal(linked.body.catalogVersion, CATALOG_VERSION);
  assert.equal((await call(`/api/legal/texts/databehandleravtale?version=${CATALOG_VERSION}`)).status, 200);
  for (const path of ['/api/legal/texts/vilkar', '/api/legal/texts/vilkar?version=legacy', `/api/legal/texts/salg?version=${CATALOG_VERSION}`, `/api/legal/texts/kontrakt?tier=tier-1-standard&version=${CATALOG_VERSION}`, '/api/admin/legal/terms-update']) {
    assert.deepEqual((await call(path, { admin: true })).body, { code: 'disabled' }, path);
  }
  setSwitch(true);
  assert.equal(dpaStatus(signed).status, 'accepted-with-contract');
});

test('a signed client stays on its snapshot until a terms notice or the signing step records a newer offer', () => {
  setSwitch(true);
  const { client, offer: first } = signedClient('Upgrade AS');
  assert.equal(client.ext.legal.offerId, first.id);
  const upgrade = sentOffer(client.id);
  assert.notEqual(upgrade.id, first.id);
  const again = sales.updateSalesClient(client.id, { progression: { ...client.progression, contractSigned: true } });
  assert.equal(again.ext.legal.offerId, first.id, 'a progression write on a signed client records nothing');
  const patch = legalSnapshotPatch(again, upgrade);
  assert.ok(patch, 'the signing step can record the accepted offer');
  const moved = sales.updateSalesClient(client.id, patch);
  assert.equal(moved.ext.legal.offerId, upgrade.id);
  assert.equal(legalBindingForClient(moved).offerId, upgrade.id);
  assert.equal(legalSnapshotPatch(moved, upgrade), null, 'recording it twice changes nothing');
});

test('a stamped offer freezes the tier contents and agreed keywords it was sent with', () => {
  setSwitch(true);
  setAgreedKeywordsResolver(() => 'Avtalte søkeord: frisør Bergen.');
  try {
    const client = sales.createSalesClient({ businessName: 'Frozen AS', contactEmail: 'frozen@example.com', product: 'asoldi' });
    const offer = sentOffer(client.id);
    assert.equal(offer.ext.legal.agreedKeywordsText, 'Avtalte søkeord: frisør Bergen.');
    assert.ok(Array.isArray(offer.ext.legal.tiers['tier-2-seo'].services) && offer.ext.legal.tiers['tier-2-seo'].services.length > 0);
    assert.ok(legalSourceForOffer(offer).tiers, 'the contract renders from the snapshot');
  } finally {
    setAgreedKeywordsResolver(null);
  }
});

test('a recorded terms notice moves the binding on its effectiveFrom date, as the notice says', () => {
  const client = { id: 'n1', businessName: 'Notice AS', progression: { contractSigned: true }, product: 'asoldi', ext: { other: { keep: 1 } } };
  const sentAt = new Date('2027-01-01T10:00:00.000Z');
  const notice = draftTermsUpdateNotice(client, { now: sentAt });
  assert.match(notice.text, new RegExp(`Versjon ${CATALOG_VERSION} gjelder for deg fra ${notice.effectiveFrom}`));
  assert.equal(legalBindingForClient(client, { now: new Date('2027-03-01T00:00:00.000Z') }).mode, 'legacy', 'a draft alone moves nothing');
  const patch = termsNoticePatch(client, notice, { now: sentAt });
  const noticed = { ...client, ext: patch.ext };
  assert.deepEqual(noticed.ext.other, { keep: 1 });
  assert.equal(termsNoticePatch(noticed, notice), null, 'recording the same notice twice changes nothing');
  const before = legalBindingForClient(noticed, { now: new Date(Date.parse(notice.effectiveFrom) - 1) });
  assert.equal(before.mode, 'legacy');
  assert.deepEqual(before.pendingNotice, { catalogVersion: CATALOG_VERSION, effectiveFrom: notice.effectiveFrom });
  const after = legalBindingForClient(noticed, { now: new Date(Date.parse(notice.effectiveFrom)) });
  assert.deepEqual([after.mode, after.catalogVersion, after.source, after.boundAt], ['catalog', CATALOG_VERSION, 'notice', notice.effectiveFrom]);
  assert.equal(dpaStatus(noticed, { enabled: true }).status, 'accepted-legacy', 'a notice records no DPA signature');
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

test('only the business owner or an admin may sign for it', () => {
  const session = (role, status = 'active') => ({ businesses: [{ id: 'b1' }], activeBusinessId: 'b1', membership: { businessId: 'b1', role, status } });
  assert.equal(sessionCanSignForBusiness(session('owner')), true);
  assert.equal(sessionCanSignForBusiness(session('admin')), true);
  assert.equal(sessionCanSignForBusiness(session('collaborator')), false);
  assert.equal(sessionCanSignForBusiness(session('admin', 'pending')), false);
  assert.equal(sessionCanSignForBusiness({ businesses: [], membership: null }), true, 'an account without businesses is its own holder');
  assert.equal(sessionCanSignForBusiness({ businesses: [{ id: 'b1' }], membership: null }), false, 'no membership in the active business');
  assert.equal(sessionCanSignForBusiness(null), true);
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
  assert.equal(patch.ext.dpa.catalogVersion, CATALOG_VERSION, 'the signature names the catalog version of the text signed');
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
  assert.equal(legacyView.body.dpa.status, 'accepted-legacy');
  assert.equal(legacyView.body.dpa.missing, false);
  assert.match(legacyView.body.links.vilkar, /versjon=legacy$/);
  assert.match(legacyView.body.links.databehandleravtale, /versjon=legacy$/, 'the DPA in force for a legacy client is the static text');
  const boundView = await call('/api/client/legal', { user: 'u-bound' });
  assert.deepEqual([boundView.body.binding.mode, boundView.body.binding.catalogVersion], ['catalog', CATALOG_VERSION]);
  assert.match(boundView.body.links.vilkar, new RegExp(`versjon=${CATALOG_VERSION}$`));
  assert.match(boundView.body.links.databehandleravtale, new RegExp(`/databehandleravtale\\?versjon=${CATALOG_VERSION}$`), 'the bound DPA version, not always the latest');

  const first = await call('/api/client/dpa/sign', { user: 'u-legacy', method: 'POST' });
  assert.equal(first.status, 200);
  assert.equal(first.body.changed, true);
  assert.equal(first.body.dpa.status, 'signed');
  assert.match(first.body.links.databehandleravtale, new RegExp(`versjon=${CATALOG_VERSION}$`), 'the signed text');
  const signedAt = sales.getSalesClientById(legacy.id).ext.dpa.signedAt;
  const second = await call('/api/client/dpa/sign', { user: 'u-legacy', method: 'POST' });
  assert.equal(second.body.changed, false);
  assert.equal(sales.getSalesClientById(legacy.id).ext.dpa.signedAt, signedAt, 'signing again keeps the first signature');
  assert.equal((await call('/api/client/dpa/sign', { user: 'u-nobody', method: 'POST' })).status, 404);
  assert.equal((await call('/api/client/dpa/sign', { method: 'POST' })).status, 401);

  // A member who may not sign for the business (a collaborator) is refused, and the card says so.
  const { client: shared } = signedClient('Shared AS');
  portalUsers.set('u-collab', shared.id);
  collaborators.add('u-collab');
  const before = readData('sales-clients.json');
  const refused = await call('/api/client/dpa/sign', { user: 'u-collab', method: 'POST' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'not-authorized');
  assert.equal(readData('sales-clients.json'), before, 'nothing written');
  assert.equal((await call('/api/client/legal', { user: 'u-collab' })).body.canSign, false);
  assert.equal((await call('/api/client/legal', { user: 'u-legacy' })).body.canSign, true);

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
  assert.deepEqual(update.body.settingsDrift, [], 'the stored settings match the published texts');
  assert.equal(settingsStore.saveAutomationSettings({ lifecycle: { cancellationGraceDays: 45 } }, { by: 'test', reason: 'test' }).ok, true);
  const drifted = await call('/api/admin/legal/terms-update', { admin: true });
  assert.deepEqual(drifted.body.settingsDrift.find((entry) => entry.key === 'graceDays'), { key: 'graceDays', published: 30, current: 45 });
  const served = await call('/api/legal/texts/vilkar');
  assert.match(JSON.stringify(served.body), /oppe i 30 dager/, 'the published text keeps its version value until a new version');
  assert.doesNotMatch(JSON.stringify(served.body), /oppe i 45 dager/);
  assert.equal(settingsStore.saveAutomationSettings({ lifecycle: { cancellationGraceDays: 30 } }, { by: 'test', reason: 'test' }).ok, true);
  assert.equal((await call('/api/admin/legal/terms-update')).status, 401);
  assert.deepEqual(readdirSync(dataDir).filter((name) => /outbox|email-log/i.test(name)), [], 'nothing was queued or sent');
});
