// Agreed-keyword contract text (lib/seo-ops/contract-text.js) and the admin UI that shows it: the
// text is pure and Norwegian, lists approved keywords only, and the developer page and the offer
// composer read the record through the staff routes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agreedKeywordsContractText, approvedAgreedPhrases, AGREED_KEYWORDS_CONTRACT_LABEL } from '../lib/seo-ops/contract-text.js';

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the contract line lists approved keywords in approval order, at most three', () => {
  const record = {
    agreedKeywords: [
      { phrase: 'rørlegger eksempelby', status: 'approved' },
      { phrase: 'baderom', status: 'proposed' },
      { phrase: 'varmepumpe eksempelby', status: 'approved' },
      { phrase: 'akutt rørlegger', status: 'blocked' },
      { phrase: 'Rørlegger  Eksempelby', status: 'approved' },
      { phrase: 'servicebil', status: 'approved' },
      { phrase: 'fjerde godkjente', status: 'approved' },
    ],
  };
  assert.equal(AGREED_KEYWORDS_CONTRACT_LABEL, 'Avtalte søkeord');
  assert.deepEqual(approvedAgreedPhrases(record), ['rørlegger eksempelby', 'varmepumpe eksempelby', 'servicebil']);
  assert.equal(agreedKeywordsContractText(record), 'Avtalte søkeord: rørlegger eksempelby, varmepumpe eksempelby, servicebil');
});

test('no approved keyword gives no contract line', () => {
  for (const record of [null, undefined, {}, { agreedKeywords: [] }, { agreedKeywords: [{ phrase: 'x', status: 'proposed' }, { phrase: 'y', status: 'blocked' }] }]) {
    assert.equal(agreedKeywordsContractText(record), null);
  }
});

test('a prescription-only substance never reaches the contract, even if stored as approved', () => {
  assert.equal(agreedKeywordsContractText({ agreedKeywords: [{ phrase: 'melatonin', status: 'approved' }, { phrase: 'søvnråd', status: 'approved' }] }), 'Avtalte søkeord: søvnråd');
});

test('the contract text and the limits are pure modules the admin UI can import', () => {
  for (const file of ['lib/seo-ops/contract-text.js', 'lib/seo-ops/phrase-filters.js', 'lib/seo-ops/agreed-limits.js', 'lib/seo-ops/record-consumers.js']) {
    assert.doesNotMatch(source(file), /from 'node:|from 'fs'|from 'path'|process\.env/, file);
  }
});

test('the developer page mounts the SEO panel and the offer composer a read-only list', () => {
  const card = source('app/pages/developer/DeveloperClientCard.tsx');
  assert.match(card, /<DeveloperSeoPanel salesClientId=\{salesClientId\} authHeaders=\{developmentAuthHeaders\(\)\} canEdit=\{canWork \|\| isAdmin\} \/>/);
  const composer = source('app/pages/sales/SalesOfferComposer.tsx');
  assert.match(composer, /<AgreedKeywordsList salesClientId=\{clientId\} authHeaders=\{salesAuthHeaders\(\)\} \/>/);
  const list = source('app/pages/sales/AgreedKeywordsList.tsx');
  assert.doesNotMatch(list, /approveSeoKeyword|blockSeoKeyword|putAgreedKeywords|<button/, 'the composer list is read-only');
  const api = source('app/pages/developer/seoRecordApi.ts');
  for (const path of ['/admin/sales-clients/', '/seo/approve', '/seo/block']) assert.ok(api.includes(path), path);
  assert.doesNotMatch(api, /internal\/maker/);
  const picker = source('app/pages/developer/AgreedKeywordsPicker.tsx');
  assert.match(picker, /MAX_APPROVED_AGREED_KEYWORDS/);
  assert.match(picker, /forhåndsanalyse/);
  assert.match(picker, /ikke målt/);
  assert.doesNotMatch(`${picker}${source('app/pages/developer/DeveloperSeoPanel.tsx')}`, /dangerouslySetInnerHTML|innerHTML/);
});
