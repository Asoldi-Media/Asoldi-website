// A signed contract keeps the period sentence recorded with its signature.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-contract-terms-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';

const { FIXTURE_OFFERS, FIXTURE_CLIENT } = await import('./legal/dark-surface.mjs');
const { DURATION_TERMS_VERSION, contractCopy } = await import('../lib/offer-contract-copy.js');
const { contractHtmlForOffer } = await import('../lib/offer-contract-html.js');
const { buildContractPdf, contractArticleModel, contractInputsForOffer } = await import('../lib/offer-contract-pdf.js');
const { contractSignatureForOffer, durationTermsVersionForOffer } = await import('../lib/contract-terms-version.js');
const sales = await import('../data/sales.js');
const { register } = await import('../lib/routes/legal-routes.js');

const CONTRACT_DATE = '2026-05-04T09:00:00.000Z';
const SALES_FILE = join(dataDir, 'sales-clients.json');
const CUTOVER_FILE = join(dataDir, 'contract-terms-cutover.json');
const CUTOVER_TMP = join(dataDir, 'contract-terms-cutover.json.tmp');

const OLD = {
  nb: 'Kunden kan ikke nedgradere til et lavere nivå etter at funksjonalitet fra et høyere nivå er lagt til.',
  en: 'Clients cannot downgrade to a lower tier once higher-level functionality has been added.',
};
const NEW = {
  nb: 'Kunden kan gå ned til et lavere nivå etter avtale med Asoldi. Endringen gjelder fra Asoldi registrerer den. Funksjonene som bare hører til det høyere nivået, slås da av, og en utvikler fjerner dem fra nettsiden.',
  en: 'The Client can move down to a lower tier by agreement with Asoldi. The change applies from the time Asoldi records it. The functions that belong only to the higher tier are then switched off, and a developer removes them from the website.',
};

const signedBefore = JSON.parse(readFileSync(new URL('./fixtures/legal/signed-before-baseline.json', import.meta.url), 'utf8'));
const currentBaseline = JSON.parse(readFileSync(new URL('./fixtures/legal/dark-surface-baseline.json', import.meta.url), 'utf8'));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function signedClient(at) {
  return {
    ...FIXTURE_CLIENT,
    progression: { contractSigned: true },
    ...(at ? { contractSignedAt: at } : {}),
  };
}

function withSignedStamp(client, signedAt = client.contractSignedAt ?? '') {
  return {
    ...client,
    ext: {
      ...(client.ext || {}),
      contractTerms: {
        ...(client.ext?.contractTerms || {}),
        signed: { version: DURATION_TERMS_VERSION, signedAt, at: '2026-11-21T08:00:00.000Z' },
      },
    },
  };
}

function sentenceOf(offer) {
  return offer.contractLanguage === 'en' ? 'en' : 'nb';
}

function assertSentence(offer, client, which) {
  const lang = sentenceOf(offer);
  const html = contractHtmlForOffer(offer, client);
  assert.ok(html.includes(`<li>${which === 'old' ? OLD[lang] : NEW[lang]}</li>`), lang);
  assert.equal(html.includes(which === 'old' ? NEW[lang] : OLD[lang]), false, lang);
  const inputs = contractInputsForOffer(offer, client);
  assert.equal(inputs.durationTermsVersion, which === 'old' ? 1 : DURATION_TERMS_VERSION);
  const article = contractArticleModel({ client, ...inputs });
  assert.equal(article.durationTerms[2], which === 'old' ? OLD[lang] : NEW[lang]);
}

function offerFor(client, sentAt, id = 'offer-fjord') {
  return { ...FIXTURE_OFFERS.tier1, id, salesClientId: client.id, sentAt, status: 'sent' };
}

function assertVersion(offer, client, version) {
  assertSentence(offer, client, version === 1 ? 'old' : 'new');
}

function editClient(id, change) {
  const list = JSON.parse(readFileSync(SALES_FILE, 'utf8'));
  const row = list.find((entry) => entry.id === id);
  change(row);
  writeFileSync(SALES_FILE, JSON.stringify(list, null, 2));
  return sales.getSalesClientById(id);
}

function stripTerms(id) {
  return editClient(id, (row) => {
    if (!row.ext || typeof row.ext !== 'object') return;
    delete row.ext.contractTerms;
    if (!Object.keys(row.ext).length) delete row.ext;
  });
}

function fileSnapshot(dir, prefix = '') {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, fileSnapshot(full, rel));
    else out[rel] = readFileSync(full);
  }
  return out;
}

function changedPaths(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const key of keys) {
    const left = before[key];
    const right = after[key];
    if (!left || !right || !left.equals(right)) changed.push(key);
  }
  return changed.sort();
}

function newClient(businessName, email) {
  return sales.createSalesClient({
    businessName,
    contactEmail: email,
    contactPerson: 'Ada Example',
    product: 'asoldi',
  });
}

test('a contract signed before the current wording, with no stamp, renders the sentence it was signed with', () => {
  const client = signedClient('2026-05-10T08:00:00.000Z');
  assertSentence(FIXTURE_OFFERS.tier1, client, 'old');
  assertSentence(FIXTURE_OFFERS.tier2En, client, 'old');
});

test('a contract signed with this build\'s stamp renders the current sentence, and the same signature without a stamp renders version 1', () => {
  const client = signedClient('2026-11-21T08:00:00.000Z');
  const sentAt = '2026-11-20T12:00:00.000Z';
  const stamped = withSignedStamp(client);
  assertSentence({ ...FIXTURE_OFFERS.tier1, sentAt }, stamped, 'new');
  assertSentence({ ...FIXTURE_OFFERS.tier2En, sentAt }, stamped, 'new');
  assertSentence({ ...FIXTURE_OFFERS.tier1, sentAt }, client, 'old');
  assertSentence({ ...FIXTURE_OFFERS.tier2En, sentAt }, client, 'old');
});

test('an unsigned or unsent offer renders the current sentence', () => {
  const stale = { ...FIXTURE_CLIENT, progression: { contractSigned: false }, contractSignedAt: '2026-05-10T08:00:00.000Z' };
  assertSentence(FIXTURE_OFFERS.tier1, FIXTURE_CLIENT, 'new');
  assertSentence(FIXTURE_OFFERS.tier1, stale, 'new');
  assertSentence(FIXTURE_OFFERS.tier1Draft, signedClient('2026-05-10T08:00:00.000Z'), 'new');
});

test('a later offer is signed only when the site plan names it', () => {
  const client = signedClient('2026-05-10T08:00:00.000Z');
  const later = { ...FIXTURE_OFFERS.tier1, sentAt: '2026-12-01T00:00:00.000Z' };
  assert.deepEqual(contractSignatureForOffer(later, client), { signed: false, at: '' });
  assert.equal(durationTermsVersionForOffer(later, client), DURATION_TERMS_VERSION);

  const named = { ...client, sitePlan: { offerId: later.id } };
  assert.deepEqual(contractSignatureForOffer(later, named), { signed: true, at: '2026-12-01T00:00:00.000Z' });
  assert.equal(durationTermsVersionForOffer(later, named), 1);
  const namedStamped = {
    ...named,
    ext: { contractTerms: { plan: { offerId: later.id, version: DURATION_TERMS_VERSION, at: '2026-12-01T00:00:00.000Z' } } },
  };
  assert.deepEqual(contractSignatureForOffer(later, namedStamped), { signed: true, at: '2026-12-01T00:00:00.000Z' });
  assert.equal(durationTermsVersionForOffer(later, namedStamped), DURATION_TERMS_VERSION);

  const earlier = { ...FIXTURE_OFFERS.tier1, sentAt: '2026-06-01T00:00:00.000Z' };
  const upgraded = {
    ...client,
    sitePlan: {
      offerId: earlier.id,
      history: [{ at: '2026-06-03T00:00:00.000Z', reason: 'offer-upgrade:portal-accept' }],
    },
  };
  assert.deepEqual(contractSignatureForOffer(earlier, upgraded), { signed: true, at: '2026-06-03T00:00:00.000Z' });
  assert.equal(durationTermsVersionForOffer(earlier, upgraded), 1);
});

test('a signature with no recorded time and no stamp renders version 1', () => {
  const client = signedClient();
  assert.deepEqual(contractSignatureForOffer(FIXTURE_OFFERS.tier1, client), { signed: true, at: '' });
  assert.equal(durationTermsVersionForOffer(FIXTURE_OFFERS.tier1, client), 1);
});

test('signed contracts from before the wording change match the recorded hashes, and unsigned ones match the current baseline', async () => {
  const client = signedClient('2026-05-10T08:00:00.000Z');
  const date = new Date(CONTRACT_DATE);
  for (const [key, expected] of Object.entries(signedBefore)) {
    const offer = FIXTURE_OFFERS[key];
    assert.equal(sha256(contractHtmlForOffer(offer, client)), expected.htmlSha256, `${key} html`);
    const inputs = contractInputsForOffer(offer, client);
    const article = contractArticleModel({ client, ...inputs, date });
    const articleHash = sha256(JSON.stringify(JSON.parse(JSON.stringify({ ...article, copy: undefined }))));
    assert.equal(articleHash, expected.articleSha256, `${key} article`);
  }
  mock.timers.enable({ apis: ['Date'], now: Date.parse(CONTRACT_DATE) });
  try {
    for (const [key, expected] of Object.entries(signedBefore)) {
      const offer = FIXTURE_OFFERS[key];
      const inputs = contractInputsForOffer(offer, client);
      const pdf = await buildContractPdf({ client, ...inputs, date: new Date(CONTRACT_DATE) });
      assert.equal(sha256(pdf), expected.pdfSha256, `${key} pdf`);

      const unsignedInputs = contractInputsForOffer(offer, FIXTURE_CLIENT);
      const unsignedHtml = sha256(contractHtmlForOffer(offer, FIXTURE_CLIENT));
      const unsignedArticleModel = contractArticleModel({ client: FIXTURE_CLIENT, ...unsignedInputs, date: new Date(CONTRACT_DATE) });
      const unsignedArticle = sha256(JSON.stringify(JSON.parse(JSON.stringify({ ...unsignedArticleModel, copy: undefined }))));
      const unsignedPdf = sha256(await buildContractPdf({ client: FIXTURE_CLIENT, ...unsignedInputs, date: new Date(CONTRACT_DATE) }));
      const current = currentBaseline.contracts[key];
      assert.equal(unsignedHtml, current.htmlSha256, `${key} current html`);
      assert.equal(unsignedArticle, current.articleSha256, `${key} current article`);
      assert.equal(unsignedPdf, current.pdfSha256, `${key} current pdf`);
      assert.notEqual(unsignedHtml, expected.htmlSha256, `${key} html changed`);
      assert.notEqual(unsignedArticle, expected.articleSha256, `${key} article changed`);
      assert.notEqual(unsignedPdf, expected.pdfSha256, `${key} pdf changed`);
    }
  } finally {
    mock.timers.reset();
  }
});

test('a missing or unreadable signature time renders version 1 unless this build stamped it', () => {
  const bare = { progression: { contractSigned: true } };
  const bad = { progression: { contractSigned: true }, contractSignedAt: 'x' };
  const offers = [
    { ...FIXTURE_OFFERS.tier1, sentAt: '2026-11-21T08:00:00.000Z' },
    { ...FIXTURE_OFFERS.tier1, sentAt: '2026-11-20T10:00:00.000Z' },
    FIXTURE_OFFERS.tier1,
    { ...FIXTURE_OFFERS.tier1, sentAt: '' },
  ];
  for (const client of [bare, bad]) {
    for (const offer of offers) {
      assert.equal(durationTermsVersionForOffer(offer, client), 1);
      assert.equal(contractInputsForOffer(offer, client).durationTermsVersion, 1);
    }
    const stamped = withSignedStamp(client, client.contractSignedAt ?? '');
    for (const offer of offers) {
      assert.equal(durationTermsVersionForOffer(offer, stamped), DURATION_TERMS_VERSION);
      assert.equal(contractInputsForOffer(offer, stamped).durationTermsVersion, DURATION_TERMS_VERSION);
    }
  }
});

test('the earliest signature time at or after the send time decides which stamp applies', () => {
  const sentAt = '2026-11-01T00:00:00.000Z';
  const beforeCutover = '2026-11-10T00:00:00.000Z';
  const afterCutover = '2026-11-21T00:00:00.000Z';
  const offer = { ...FIXTURE_OFFERS.tier1, sentAt };
  const remembered = {
    ...FIXTURE_CLIENT,
    progression: { contractSigned: true },
    contractSignedAt: afterCutover,
    ext: { contractSigning: { earlierSignedAt: beforeCutover } },
  };
  assert.equal(contractSignatureForOffer(offer, remembered).at, beforeCutover);
  assert.equal(durationTermsVersionForOffer(offer, remembered), 1);

  const olderOffer = {
    ...remembered,
    ext: {
      contractSigning: { earlierSignedAt: '2026-10-01T00:00:00.000Z' },
      contractTerms: {
        signed: { version: DURATION_TERMS_VERSION, signedAt: afterCutover, at: afterCutover },
      },
    },
  };
  assert.equal(contractSignatureForOffer(offer, olderOffer).at, afterCutover);
  assert.equal(durationTermsVersionForOffer(offer, olderOffer), DURATION_TERMS_VERSION);
  const olderUnstamped = {
    ...remembered,
    ext: { contractSigning: { earlierSignedAt: '2026-10-01T00:00:00.000Z' } },
  };
  assert.equal(contractSignatureForOffer(offer, olderUnstamped).at, afterCutover);
  assert.equal(durationTermsVersionForOffer(offer, olderUnstamped), 1);

  const tied = {
    ...FIXTURE_CLIENT,
    progression: { contractSigned: true },
    contractSignedAt: afterCutover,
    ext: {
      contractSigning: { earlierSignedAt: afterCutover },
      contractTerms: {
        signed: { version: DURATION_TERMS_VERSION, signedAt: afterCutover, at: afterCutover },
        earlierVersion: 1,
      },
    },
  };
  assert.equal(contractSignatureForOffer(offer, tied).at, afterCutover);
  assert.equal(durationTermsVersionForOffer(offer, tied), DURATION_TERMS_VERSION);

  const unsigned = {
    ...FIXTURE_CLIENT,
    progression: { contractSigned: false },
    ext: { contractSigning: { earlierSignedAt: '2026-05-01T00:00:00.000Z' } },
  };
  assert.deepEqual(contractSignatureForOffer(FIXTURE_OFFERS.tier1, unsigned), { signed: false, at: '' });
  assert.equal(durationTermsVersionForOffer(FIXTURE_OFFERS.tier1, unsigned), DURATION_TERMS_VERSION);
});

test('version 1 of the contract copy differs only in the period sentence', () => {
  for (const lang of ['nb', 'en']) {
    const oldCopy = contractCopy(lang, { durationTermsVersion: 1 });
    const current = contractCopy(lang);
    assert.notEqual(oldCopy.durationTerms[2], current.durationTerms[2]);
    const placeholder = 'SAME';
    const strip = (copy) => {
      const durationTerms = copy.durationTerms.slice();
      durationTerms[2] = placeholder;
      return JSON.stringify({ ...copy, durationTerms });
    };
    assert.equal(strip(oldCopy), strip(current), lang);
  }
});

test('rendering, starting the legal routes, and signing do not write a contract terms cut-over file', async () => {
  assert.equal(existsSync(CUTOVER_FILE), false);
  assert.equal(existsSync(CUTOVER_TMP), false);
  assertSentence(FIXTURE_OFFERS.tier1, FIXTURE_CLIENT, 'new');
  assertSentence(FIXTURE_OFFERS.tier1, signedClient('2026-05-10T08:00:00.000Z'), 'old');
  const app = { get() {}, post() {} };
  await register(app, {
    adminAuth: (_req, _res, next) => next(),
    clientAuth: (_req, _res, next) => next(),
    sales,
    salesOffers: { listSalesOffers() { return []; } },
  });
  const created = newClient('Render Glass AS', 'render@example.com');
  sales.setSalesProgress(created.id, 'contractSigned', true, { fastTrack: true });
  assert.equal(existsSync(CUTOVER_FILE), false);
  assert.equal(existsSync(CUTOVER_TMP), false);
});

test('a signature written without a stamp during a rollback renders version 1, and the next deploy still stamps new signatures', () => {
  const first = sales.setSalesProgress(
    newClient('Fjord Glass AS', 'fjord@example.com').id,
    'contractSigned',
    true,
    { fastTrack: true },
  );
  const t1 = first.contractSignedAt;
  assert.equal(first.ext.contractTerms.signed.version, DURATION_TERMS_VERSION);
  assert.equal(first.ext.contractTerms.signed.signedAt, t1);

  const secondId = newClient('Nordlys Kafe AS', 'nordlys@example.com').id;
  const secondSigned = sales.setSalesProgress(secondId, 'contractSigned', true, { fastTrack: true });
  const t2 = secondSigned.contractSignedAt;
  assert.ok(Date.parse(t2) >= Date.parse(t1));
  const second = stripTerms(secondId);
  assert.equal(second.contractSignedAt, t2);
  assert.equal(second.progression.contractSigned, true);
  assert.equal(second.ext?.contractTerms, undefined);

  const offer1 = offerFor(first, new Date(Date.parse(t1) - 60_000).toISOString(), 'offer-fjord');
  const offer2 = offerFor(second, new Date(Date.parse(t2) - 60_000).toISOString(), 'offer-nordlys');
  assertVersion(offer1, sales.getSalesClientById(first.id), DURATION_TERMS_VERSION);
  assertVersion(offer2, second, 1);

  const before = fileSnapshot(dataDir);
  const third = sales.setSalesProgress(
    newClient('Havbris AS', 'havbris@example.com').id,
    'contractSigned',
    true,
    { fastTrack: true },
  );
  const after = fileSnapshot(dataDir);
  const offer3 = offerFor(third, new Date(Date.parse(third.contractSignedAt) - 60_000).toISOString(), 'offer-havbris');
  assertVersion(offer3, third, DURATION_TERMS_VERSION);
  assertVersion(offer2, sales.getSalesClientById(second.id), 1);
  const changed = changedPaths(before, after);
  assert.ok(changed.length > 0);
  for (const path of changed) {
    assert.match(path, /^sales-clients\.json$|^backups\/sales-clients\.json/, path);
  }
  assert.equal(existsSync(CUTOVER_FILE), false);
  assert.equal(existsSync(CUTOVER_TMP), false);
});

test('the staff tick writes a stamp whose signedAt is the stored signature time', () => {
  const client = sales.setSalesProgress(
    newClient('Staff Tick AS', 'staff@example.com').id,
    'contractSigned',
    true,
    { fastTrack: true },
  );
  assert.equal(client.ext.contractTerms.signed.signedAt, client.contractSignedAt);
  assert.equal(client.ext.contractTerms.signed.version, DURATION_TERMS_VERSION);
  assert.ok(Date.parse(client.ext.contractTerms.signed.at));
  const offer = offerFor(client, new Date(Date.parse(client.contractSignedAt) - 60_000).toISOString(), 'offer-staff');
  assertVersion(offer, client, DURATION_TERMS_VERSION);
});

test('a plain progression patch with no time stamps signedAt as an empty string', () => {
  const created = newClient('Tom Tid AS', 'tom@example.com');
  const signed = sales.updateSalesClient(created.id, { progression: { contractSigned: true } });
  assert.equal(signed.contractSignedAt, '');
  assert.deepEqual(signed.ext.contractTerms.signed.signedAt, '');
  assert.equal(signed.ext.contractTerms.signed.version, DURATION_TERMS_VERSION);
  const offer = offerFor(signed, '2026-05-04T09:00:00.000Z', 'offer-tom');
  assertVersion(offer, signed, DURATION_TERMS_VERSION);
  const stripped = stripTerms(created.id);
  assertVersion(offer, stripped, 1);

  const unreadable = editClient(created.id, (row) => {
    row.contractSignedAt = 'x';
    row.progression.contractSigned = true;
    row.ext = {
      ...(row.ext || {}),
      contractTerms: {
        signed: { version: DURATION_TERMS_VERSION, signedAt: 'x', at: '2026-11-21T08:00:00.000Z' },
      },
    };
  });
  assert.equal(unreadable.contractSignedAt, 'x');
  assertVersion(offerFor(unreadable, '2026-05-04T09:00:00.000Z', 'offer-tom-x'), unreadable, DURATION_TERMS_VERSION);
  const without = stripTerms(created.id);
  assertVersion(offerFor(without, '2026-05-04T09:00:00.000Z', 'offer-tom-x'), without, 1);
});

test('clearing an unstamped signature and ticking it again keeps version 1 for the first time', async () => {
  const id = newClient('Gammel Signatur AS', 'gammel@example.com').id;
  const first = sales.setSalesProgress(id, 'contractSigned', true, { fastTrack: true });
  const t1 = first.contractSignedAt;
  stripTerms(id);
  const off = sales.setSalesProgress(id, 'contractSigned', false);
  assert.equal(off.ext.contractSigning.earlierSignedAt, t1);
  assert.equal(off.ext.contractTerms?.earlierVersion, undefined);
  assert.equal(off.ext.contractTerms?.signed, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const again = sales.setSalesProgress(id, 'contractSigned', true, { fastTrack: true });
  const t2 = again.contractSignedAt;
  assert.ok(Date.parse(t2) > Date.parse(t1));
  assert.equal(again.ext.contractSigning.earlierSignedAt, t1);
  assert.equal(again.ext.contractTerms.signed.signedAt, t2);
  assert.equal(again.ext.contractTerms.earlierVersion, undefined);
  const before = offerFor(again, new Date(Date.parse(t1) - 60_000).toISOString(), 'offer-gammel-before');
  const betweenAt = new Date(Date.parse(t1) + Math.floor((Date.parse(t2) - Date.parse(t1)) / 2)).toISOString();
  const between = offerFor(again, betweenAt, 'offer-gammel-between');
  assert.ok(Date.parse(between.sentAt) > Date.parse(t1));
  assert.ok(Date.parse(between.sentAt) < Date.parse(t2));
  assertVersion(before, again, 1);
  assertVersion(between, again, DURATION_TERMS_VERSION);
});

test('clearing a stamped signature keeps that version, and a later clear does not move it', () => {
  const id = newClient('Ny Signatur AS', 'ny@example.com').id;
  const first = sales.setSalesProgress(id, 'contractSigned', true, { fastTrack: true });
  const t1 = first.contractSignedAt;
  const off = sales.setSalesProgress(id, 'contractSigned', false);
  assert.equal(off.ext.contractSigning.earlierSignedAt, t1);
  assert.equal(off.ext.contractTerms.earlierVersion, DURATION_TERMS_VERSION);
  assert.equal(off.ext.contractTerms.signed, undefined);
  const again = sales.setSalesProgress(id, 'contractSigned', true, { fastTrack: true });
  assert.equal(again.ext.contractSigning.earlierSignedAt, t1);
  assert.equal(again.ext.contractTerms.earlierVersion, DURATION_TERMS_VERSION);
  const before = offerFor(again, new Date(Date.parse(t1) - 60_000).toISOString(), 'offer-ny-before');
  assertVersion(before, again, DURATION_TERMS_VERSION);

  const offAgain = sales.setSalesProgress(id, 'contractSigned', false);
  const restored = sales.setSalesProgress(id, 'contractSigned', true, { fastTrack: true });
  assert.equal(offAgain.ext.contractSigning.earlierSignedAt, t1);
  assert.equal(offAgain.ext.contractTerms.earlierVersion, DURATION_TERMS_VERSION);
  assert.equal(restored.ext.contractSigning.earlierSignedAt, t1);
  assert.equal(restored.ext.contractTerms.earlierVersion, DURATION_TERMS_VERSION);
});

test('a stamp whose signedAt is not the stored signature time renders version 1', () => {
  const id = newClient('Stale Stempel AS', 'stale@example.com').id;
  const signed = sales.setSalesProgress(id, 'contractSigned', true, { fastTrack: true });
  const stored = editClient(id, (row) => {
    row.ext.contractTerms.signed.signedAt = '2020-01-01T00:00:00.000Z';
  });
  assert.notEqual(stored.ext.contractTerms.signed.signedAt, stored.contractSignedAt);
  assert.equal(stored.contractSignedAt, signed.contractSignedAt);
  const offer = offerFor(stored, new Date(Date.parse(stored.contractSignedAt) - 60_000).toISOString(), 'offer-stale');
  assertVersion(offer, stored, 1);
});

test('an offer taken into the site plan renders version 2 only for that offer', () => {
  const id = newClient('Plan Tilbud AS', 'plan@example.com').id;
  const signed = sales.setSalesProgress(id, 'contractSigned', true, { fastTrack: true });
  const laterId = 'offer-plan-later';
  const planned = sales.setSalesSitePlan(id, {
    status: 'active',
    tierId: 'tier-1-standard',
    services: ['site'],
    offerId: laterId,
    source: 'offer-upgrade',
  }, { by: 'test', reason: 'offer-upgrade:test' });
  assert.equal(planned.ext.contractTerms.plan.offerId, laterId);
  assert.equal(planned.ext.contractTerms.plan.version, DURATION_TERMS_VERSION);
  assert.ok(Date.parse(planned.ext.contractTerms.plan.at));
  const sentAt = new Date(Date.parse(signed.contractSignedAt) + 60_000).toISOString();
  const later = offerFor(planned, sentAt, laterId);
  assert.equal(contractSignatureForOffer(later, planned).signed, true);
  assertVersion(later, planned, DURATION_TERMS_VERSION);

  const stripped = {
    ...planned,
    ext: { ...planned.ext, contractTerms: { ...planned.ext.contractTerms } },
  };
  delete stripped.ext.contractTerms.plan;
  assertVersion(later, stripped, 1);
  const other = {
    ...planned,
    ext: {
      ...planned.ext,
      contractTerms: {
        ...planned.ext.contractTerms,
        plan: { ...planned.ext.contractTerms.plan, offerId: 'offer-plan-other' },
      },
    },
  };
  assertVersion(later, other, 1);
});

test('one write that signs several clients stamps each of them', () => {
  const a = newClient('Batch En AS', 'batch-en@example.com');
  const b = newClient('Batch To AS', 'batch-to@example.com');
  const result = sales.patchSalesClientsById([
    { id: a.id, patch: { progression: { contractSigned: true } } },
    { id: b.id, patch: { progression: { contractSigned: true } } },
  ]);
  assert.equal(result.updated, 2);
  for (const id of [a.id, b.id]) {
    const client = sales.getSalesClientById(id);
    assert.equal(client.progression.contractSigned, true);
    assert.equal(client.ext.contractTerms.signed.version, DURATION_TERMS_VERSION);
    assert.equal(client.ext.contractTerms.signed.signedAt, client.contractSignedAt);
    assert.equal(client.ext.contractSigning, undefined);
  }
  sales.patchSalesClientsById([
    { id: a.id, patch: { progression: { contractSigned: false } } },
    { id: b.id, patch: { progression: { contractSigned: false } } },
  ]);
  for (const id of [a.id, b.id]) {
    const client = sales.getSalesClientById(id);
    assert.equal(client.progression.contractSigned, false);
    assert.equal(client.ext?.contractTerms?.signed, undefined);
    assert.equal(client.ext?.contractSigning, undefined);
  }
});

test('a write that does not sign leaves ext untouched, and a client without ext still has none', () => {
  const plain = newClient('Uten Ekstra AS', 'uten@example.com');
  assert.equal(plain.ext, undefined);
  const noted = sales.updateSalesClient(plain.id, { notes: 'Ring tilbake i morgen' });
  assert.equal(noted.ext, undefined);
  assert.deepEqual(noted.ext, plain.ext);

  const seeded = newClient('Med Ekstra AS', 'med@example.com');
  const ext = { kept: { token: 'stay' } };
  const current = editClient(seeded.id, (row) => { row.ext = ext; });
  assert.deepEqual(current.ext, ext);
  const updated = sales.updateSalesClient(seeded.id, { industry: 'Glass' });
  assert.equal(updated.industry, 'Glass');
  assert.deepEqual(updated.ext, ext);
});

test('a newer stamp renders the current version, and a version that is not a whole number of at least 1 does not count', () => {
  const id = newClient('Nyere Bygg AS', 'nyere@example.com').id;
  sales.setSalesProgress(id, 'contractSigned', true, { fastTrack: true });
  const newer = editClient(id, (row) => { row.ext.contractTerms.signed.version = 3; });
  const offer = offerFor(newer, new Date(Date.parse(newer.contractSignedAt) - 60_000).toISOString(), 'offer-nyere');
  assert.equal(newer.ext.contractTerms.signed.version, 3);
  assertVersion(offer, newer, DURATION_TERMS_VERSION);
  for (const version of [0, '2', 2.5, null]) {
    const client = {
      ...newer,
      ext: {
        ...newer.ext,
        contractTerms: {
          ...newer.ext.contractTerms,
          signed: { ...newer.ext.contractTerms.signed, version },
        },
      },
    };
    assert.equal(durationTermsVersionForOffer(offer, client), 1, String(version));
    assert.equal(contractInputsForOffer(offer, client).durationTermsVersion, 1, String(version));
  }
});
