// A signed contract keeps the period sentence it was signed with. The cut-over time is stored once.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-contract-terms-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';

const { FIXTURE_OFFERS, FIXTURE_CLIENT } = await import('./legal/dark-surface.mjs');
const { recordContractTermsCutover, resetContractTermsCutoverCache } = await import('../data/contract-terms-cutover.js');
const { DURATION_TERMS_VERSION, contractCopy } = await import('../lib/offer-contract-copy.js');
const { contractHtmlForOffer } = await import('../lib/offer-contract-html.js');
const { buildContractPdf, contractArticleModel, contractInputsForOffer } = await import('../lib/offer-contract-pdf.js');
const { contractSignatureForOffer, durationTermsVersionForOffer } = await import('../lib/contract-terms-version.js');

const CUTOVER_ISO = '2026-11-20T10:00:00.000Z';
const CUTOVER_MS = Date.parse(CUTOVER_ISO);
const CONTRACT_DATE = '2026-05-04T09:00:00.000Z';
const cutoverFile = join(dataDir, 'contract-terms-cutover.json');

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

const firstCutover = recordContractTermsCutover({ now: CUTOVER_MS });
assert.equal(firstCutover, CUTOVER_MS);

test('recordContractTermsCutover writes once and a later call leaves the file unchanged', () => {
  const before = readFileSync(cutoverFile);
  assert.equal(JSON.parse(before.toString('utf8')).durationTerms['2'].from, CUTOVER_ISO);
  resetContractTermsCutoverCache();
  const again = recordContractTermsCutover({ now: Date.parse('2026-12-01T00:00:00.000Z') });
  assert.equal(again, CUTOVER_MS);
  assert.deepEqual(readFileSync(cutoverFile), before);
});

test('a contract signed before the cut-over renders the sentence it was signed with', () => {
  const client = signedClient('2026-05-10T08:00:00.000Z');
  assertSentence(FIXTURE_OFFERS.tier1, client, 'old');
  assertSentence(FIXTURE_OFFERS.tier2En, client, 'old');
});

test('a contract signed after the cut-over renders the current sentence', () => {
  const client = signedClient('2026-11-21T08:00:00.000Z');
  const sentAt = '2026-11-20T12:00:00.000Z';
  assertSentence({ ...FIXTURE_OFFERS.tier1, sentAt }, client, 'new');
  assertSentence({ ...FIXTURE_OFFERS.tier2En, sentAt }, client, 'new');
});

test('an unsigned or unsent offer renders the current sentence and does not rewrite the cut-over file', () => {
  const before = readFileSync(cutoverFile);
  const mtime = statSync(cutoverFile).mtimeMs;
  const stale = { ...FIXTURE_CLIENT, progression: { contractSigned: false }, contractSignedAt: '2026-05-10T08:00:00.000Z' };
  assertSentence(FIXTURE_OFFERS.tier1, FIXTURE_CLIENT, 'new');
  assertSentence(FIXTURE_OFFERS.tier1, stale, 'new');
  assertSentence(FIXTURE_OFFERS.tier1Draft, signedClient('2026-05-10T08:00:00.000Z'), 'new');
  assert.deepEqual(readFileSync(cutoverFile), before);
  assert.equal(statSync(cutoverFile).mtimeMs, mtime);
});

test('a later offer is signed only when the site plan names it', () => {
  const client = signedClient('2026-05-10T08:00:00.000Z');
  const later = { ...FIXTURE_OFFERS.tier1, sentAt: '2026-12-01T00:00:00.000Z' };
  assert.deepEqual(contractSignatureForOffer(later, client), { signed: false, at: '' });
  assert.equal(durationTermsVersionForOffer(later, client, { cutoverMs: CUTOVER_MS }), DURATION_TERMS_VERSION);

  const named = { ...client, sitePlan: { offerId: later.id } };
  assert.deepEqual(contractSignatureForOffer(later, named), { signed: true, at: '2026-12-01T00:00:00.000Z' });
  assert.equal(durationTermsVersionForOffer(later, named, { cutoverMs: CUTOVER_MS }), DURATION_TERMS_VERSION);

  const earlier = { ...FIXTURE_OFFERS.tier1, sentAt: '2026-06-01T00:00:00.000Z' };
  const upgraded = {
    ...client,
    sitePlan: {
      offerId: earlier.id,
      history: [{ at: '2026-06-03T00:00:00.000Z', reason: 'offer-upgrade:portal-accept' }],
    },
  };
  assert.deepEqual(contractSignatureForOffer(earlier, upgraded), { signed: true, at: '2026-06-03T00:00:00.000Z' });
  assert.equal(durationTermsVersionForOffer(earlier, upgraded, { cutoverMs: CUTOVER_MS }), 1);
});

test('a signature with no recorded time counts as before the cut-over', () => {
  const client = signedClient();
  assert.deepEqual(contractSignatureForOffer(FIXTURE_OFFERS.tier1, client), { signed: true, at: '' });
  assert.equal(durationTermsVersionForOffer(FIXTURE_OFFERS.tier1, client, { cutoverMs: CUTOVER_MS }), 1);
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
